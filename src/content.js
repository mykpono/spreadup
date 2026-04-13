// SpreadUp — Content Script
// Runs on linkedin.com. Detects the post composer and injects the panel.
// IMPORTANT: LinkedIn renders its entire UI inside a Shadow DOM.
// All queries for LinkedIn elements must go through getShadowRoot().

(function () {
  'use strict';

  let panelFrame = null;
  let panelVisible = false;
  let observer = null;

  // ─── Shadow DOM access ──────────────────────────────────────────────────────
  // LinkedIn wraps its app in an open Shadow DOM. Standard document.querySelector
  // can't see inside it — we need shadowRoot.querySelector.

  function getShadowRoot() {
    const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
    return host?.shadowRoot || null;
  }

  function shadowQuery(selector) {
    return getShadowRoot()?.querySelector(selector) || document.querySelector(selector);
  }

  function shadowQueryAll(selector) {
    const root = getShadowRoot();
    const fromShadow = root ? [...root.querySelectorAll(selector)] : [];
    const fromDoc = [...document.querySelectorAll(selector)];
    return [...fromShadow, ...fromDoc];
  }

  function shadowFindByText(selector, text) {
    return shadowQueryAll(selector).find((el) => el.textContent?.trim() === text) || null;
  }

  // ─── Panel iframe ─────────────────────────────────────────────────────────────

  function createPanel() {
    if (panelFrame) return;

    // Check if panel iframe already exists (e.g. after extension reload)
    const existing = document.getElementById('spreadup-panel');
    if (existing) {
      // Remove stale iframe — its extension context is invalidated
      existing.remove();
    }

    panelFrame = document.createElement('iframe');
    panelFrame.id = 'spreadup-panel';
    panelFrame.src = chrome.runtime.getURL('panel/panel.html');
    panelFrame.style.cssText = `
      position: fixed;
      top: 56px;
      right: 0;
      width: 50vw;
      height: calc(100vh - 60px);
      border: none;
      border-radius: 12px 0 0 12px;
      box-shadow: -4px 0 24px rgba(0,0,0,0.18);
      z-index: 99999;
      transition: transform 0.25s ease;
    `;
    panelFrame.setAttribute('allow', 'clipboard-write');
    document.body.appendChild(panelFrame);
    // Message listener is already added in init()
  }

  function showPanel() {
    if (!panelFrame) createPanel();
    panelFrame.style.display = 'block';
    panelVisible = true;
  }

  function hidePanel() {
    if (!panelFrame) return;
    panelFrame.style.display = 'none';
    panelVisible = false;
  }

  function togglePanel() {
    panelVisible ? hidePanel() : showPanel();
  }

  // ─── Trigger button ───────────────────────────────────────────────────────────

  function injectTriggerButton() {
    if (document.getElementById('pm-trigger-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'pm-trigger-btn';
    btn.title = 'Open SpreadUp';
    btn.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              fill="#F59E0B" stroke="#F59E0B" stroke-width="1.5"/>
      </svg>
    `;
    btn.style.cssText = `
      position: fixed;
      top: 60px;
      right: 0;
      z-index: 99998;
      width: 36px;
      height: 52px;
      border: none;
      border-radius: 8px 0 0 8px;
      background: #1a1a2e;
      box-shadow: -2px 0 12px rgba(0,0,0,0.25);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, width 0.15s;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#2d2d4e';
      btn.style.width = '42px';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#1a1a2e';
      btn.style.width = '36px';
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    document.body.appendChild(btn);
  }

  // ─── LinkedIn editor helpers ──────────────────────────────────────────────────

  function getLinkedInEditor() {
    return shadowQuery('.ql-editor[aria-placeholder]')
      || shadowQuery('.ql-editor')
      || shadowQuery('[contenteditable="true"][role="textbox"]');
  }

  function insertTextIntoEditor(editor, text) {
    editor.focus();

    // LinkedIn's editor lives inside a Shadow DOM — window.getSelection() won't
    // see it. Use the shadow root's getSelection() when available (Chrome 53+).
    const root = editor.getRootNode();
    const sel = (root instanceof ShadowRoot && typeof root.getSelection === 'function')
      ? root.getSelection()
      : window.getSelection();

    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);

    const ok = document.execCommand('insertText', false, text);

    if (!ok) {
      // Fallback: set the first <p> content and fire input so Quill picks it up
      const p = editor.querySelector('p') || editor;
      p.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    } else {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
    }
  }

  // ─── LinkedIn profile scraping ────────────────────────────────────────────────

  function getLinkedInProfile() {
    // LinkedIn's UI is inside a Shadow DOM — document.querySelectorAll won't find it
    const ownImg = shadowQueryAll('img').find((i) =>
      i.src?.includes('profile-displayphoto') &&
      i.alt && i.alt.length > 0 &&
      !i.alt.startsWith('View ')
    );

    const name   = ownImg?.alt || null;
    const avatar = ownImg?.src || null;

    let headline = null;
    if (ownImg && name) {
      let container = ownImg.parentElement;
      for (let k = 0; k < 8; k++) {
        if (!container) break;
        const t = container.innerText?.trim();
        if (t && t.includes(name) && t.length > name.length + 5) break;
        container = container.parentElement;
      }
      if (container) {
        const lines = container.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
        const idx = lines.findIndex((l) => l === name);
        if (idx !== -1 && lines[idx + 1]) {
          const candidate = lines[idx + 1];
          headline = candidate.length > 10 ? candidate : (lines[idx + 2] || null);
        }
      }
    }

    return { name, headline, avatar };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function pollFor(fn, timeout = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const result = fn();
        if (result) return resolve(result);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  // ─── Publish flow ───────────────────────────────────────────────────────────

  // ─── Helpers: data URL → File ─────────────────────────────────────────────

  function dataUrlToFile(dataUrl, filename) {
    const [header, base64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }

  // ─── Visual status toast (shown on LinkedIn page, not in panel) ──────────────

  function showStatusToast(msg) {
    let toast = document.getElementById('spreadup-status-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'spreadup-status-toast';
      toast.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: #1a1a2e; color: #fff; padding: 12px 24px; border-radius: 8px;
        font-size: 14px; z-index: 999999; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        transition: opacity 0.3s;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
  }

  function hideStatusToast() {
    const toast = document.getElementById('spreadup-status-toast');
    if (toast) { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }
  }

  // ─── Pending publish (survives page navigation) ─────────────────────────────

  async function savePendingPublish(text, attachments) {
    await chrome.storage.local.set({ pendingPublish: { text, attachments, ts: Date.now() } });
  }

  async function getPendingPublish() {
    const { pendingPublish } = await chrome.storage.local.get('pendingPublish');
    if (!pendingPublish) return null;
    // Expire after 30 seconds
    if (Date.now() - pendingPublish.ts > 30000) {
      await chrome.storage.local.remove('pendingPublish');
      return null;
    }
    return pendingPublish;
  }

  async function clearPendingPublish() {
    await chrome.storage.local.remove('pendingPublish');
  }

  // ─── Resume publish after navigation ────────────────────────────────────────

  async function resumePendingPublish() {
    const pending = await getPendingPublish();
    if (!pending) return;
    await clearPendingPublish();

    showStatusToast('SpreadUp: Opening composer…');

    // Wait for the LinkedIn editor/composer to appear (shareActive=true may auto-open it)
    let editor = await pollFor(() => getLinkedInEditor(), 5000);

    // If editor didn't auto-open, try clicking "Start a post"
    if (!editor) {
      const trigger = shadowFindByText('[role="button"], button', 'Start a post')
        || shadowQueryAll('[role="button"], button').find((el) => el.textContent?.trim().toLowerCase().includes('start a post'));
      if (trigger) {
        trigger.click();
        editor = await pollFor(() => getLinkedInEditor(), 5000);
      }
    }

    if (!editor) {
      showStatusToast('SpreadUp: Could not open composer — text copied to clipboard. Paste with Cmd+V.');
      try { await navigator.clipboard.writeText(pending.text); } catch (_) {}
      await delay(4000);
      hideStatusToast();
      return;
    }

    showStatusToast('SpreadUp: Inserting your post…');
    insertTextIntoEditor(editor, pending.text);

    // Upload attachments if any
    if (pending.attachments && pending.attachments.length > 0) {
      await delay(400);
      try { await uploadAttachments(pending.attachments); } catch (_) {}
    }

    showStatusToast('SpreadUp: Post ready — click Post to publish!');
    await delay(3000);
    hideStatusToast();
  }

  // ─── Get current user's member URN via Voyager /me ──────────────────────────

  async function getMyMemberUrn() {
    const csrf = getLinkedInCsrf();
    if (!csrf) return null;
    try {
      const res = await fetch('/voyager/api/me', {
        credentials: 'include',
        headers: {
          'csrf-token':                csrf,
          'x-restli-protocol-version': '2.0.0',
          'accept':                    'application/vnd.linkedin.normalized+json+2.1',
        },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data?.entityUrn ?? null;   // "urn:li:member:123456789"
    } catch (_) { return null; }
  }

  // ─── Post directly via LinkedIn Voyager API — no composer, no confirmation ───

  async function publishViaApi(text) {
    const csrf = getLinkedInCsrf();
    if (!csrf) return null;

    const authorUrn = await getMyMemberUrn();
    if (!authorUrn) return null;

    try {
      const res = await fetch('/voyager/api/contentcreation/normShares', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'csrf-token':                csrf,
          'content-type':              'application/json',
          'x-restli-protocol-version': '2.0.0',
          'accept':                    'application/vnd.linkedin.normalized+json+2.1',
        },
        body: JSON.stringify({
          visibleToGuest: true,
          shareAudience: { 'com.linkedin.voyager.feed.MemberAudience': { values: [] } },
          shareMediaCategory: 'NONE',
          subject: '',
          text: { text },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const urn = data?.value?.id ?? data?.id;
      if (!urn) return null;
      return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
    } catch (_) { return null; }
  }

  // ─── Publish flow ─────────────────────────────────────────────────────────────

  async function handlePublish(text, attachments = []) {
    // ── Fast path: post directly via API, navigate to the new post ─────────────
    showStatusToast('SpreadUp: Posting…');
    const postUrl = await publishViaApi(text);

    if (postUrl) {
      chrome.runtime.sendMessage({ type: 'PUBLISH_SUCCESS', postUrl });
      await delay(600); // Let the success message reach the panel before nav
      window.location.href = postUrl;
      return;
    }

    // ── Fallback: open LinkedIn's composer (API unavailable) ───────────────────
    showStatusToast('SpreadUp: Opening composer…');
    hidePanel();

    let editor = getLinkedInEditor();

    if (!editor) {
      const trigger = shadowFindByText('[role="button"], button', 'Start a post')
        || shadowQueryAll('[role="button"], button').find(
             (el) => el.textContent?.trim().toLowerCase().includes('start a post'));

      if (trigger) {
        trigger.click();
        editor = await pollFor(() => getLinkedInEditor(), 3000);

        if (!editor) {
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((evtType) =>
            trigger.dispatchEvent(new PointerEvent(evtType, { bubbles: true, cancelable: true, composed: true }))
          );
          editor = await pollFor(() => getLinkedInEditor(), 4000);
        }
      }
    }

    if (!editor) {
      await savePendingPublish(text, attachments);
      window.location.href = 'https://www.linkedin.com/feed/?shareActive=true';
      return;
    }

    insertTextIntoEditor(editor, text);

    if (attachments?.length) {
      await delay(400);
      try { await uploadAttachments(attachments); } catch (_) {}
    }

    chrome.runtime.sendMessage({ type: 'PUBLISH_NEED_MANUAL' });
    showStatusToast('SpreadUp: Ready — click Post to publish!');
    await delay(3000);
    hideStatusToast();
  }

  // ─── Upload attachments into LinkedIn composer ────────────────────────────────

  async function uploadAttachments(attachments) {
    const hasImages = attachments.some((a) => a.type === 'image');
    const hasDoc    = attachments.some((a) => a.type === 'doc');

    // Click the appropriate media button in LinkedIn's composer toolbar
    // LinkedIn has toolbar buttons for photos and documents
    if (hasImages) {
      // Find the photo/image upload button (usually has an aria-label or icon)
      const imgBtn = shadowFindByText('button', 'Add a photo')
        || shadowQueryAll('button[aria-label*="photo"], button[aria-label*="image"], button[aria-label*="media"]')[0];
      if (imgBtn) {
        imgBtn.click();
        await delay(500);
      }
    } else if (hasDoc) {
      const docBtn = shadowFindByText('button', 'Add a document')
        || shadowQueryAll('button[aria-label*="document"]')[0];
      if (docBtn) {
        docBtn.click();
        await delay(500);
      }
    }

    // Find the file input that LinkedIn creates
    const fileInput = await pollFor(() => {
      return shadowQuery('input[type="file"]')
        || document.querySelector('input[type="file"]');
    }, 3000);

    if (!fileInput) {
      console.warn('[SpreadUp] Could not find file input for attachment upload');
      return;
    }

    // Convert data URLs to File objects and inject into the file input
    const files = attachments.map((a) => dataUrlToFile(a.dataUrl, a.name));

    // Use DataTransfer to create a FileList
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;

    // Dispatch change event to trigger LinkedIn's upload handler
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait for upload to process
    await delay(2000);
  }

  // ─── LinkedIn people search via Voyager API (fully background, no DOM touching) ─
  // Calls LinkedIn's own typeahead endpoint — the same one powering its search bar.
  // Because the content script runs on linkedin.com, fetch() automatically includes
  // the session cookies, so no login handling is needed. The CSRF token lives in
  // the JSESSIONID cookie (quotes stripped). Falls back to DOM scraping only if
  // the API returns a non-2xx or the response is unparseable.

  let searchInProgress = false;

  // ── Parse CSRF token LinkedIn stores in the JSESSIONID cookie ────────────────
  function getLinkedInCsrf() {
    return document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('JSESSIONID='))
      ?.split('=').slice(1).join('=')
      ?.replace(/^"|"$/g, '') || null;
  }

  // ── Call the Voyager typeahead endpoint (returns null on any failure) ─────────
  async function searchViaApi(query) {
    const csrf = getLinkedInCsrf();
    if (!csrf) return null;

    const params = new URLSearchParams({
      keywords: query,
      origin:   'OTHER',
      q:        'type',
      type:     'PEOPLE',
    });

    let res;
    try {
      res = await fetch(`/voyager/api/typeahead/hitsV2?${params}`, {
        credentials: 'include',
        headers: {
          'csrf-token':                  csrf,
          'x-restli-protocol-version':   '2.0.0',
          'x-li-lang':                   'en_US',
          'accept':                      'application/vnd.linkedin.normalized+json+2.1',
        },
      });
    } catch (_) {
      return null;
    }

    if (!res.ok) return null;

    let json;
    try { json = await res.json(); } catch (_) { return null; }

    // Response shape differs across LinkedIn versions — handle both
    const elements = json?.data?.elements ?? json?.elements ?? [];

    return elements
      .map((el) => {
        // The hit object is nested under a type-keyed property
        const hit = el.hitInfo
          ? Object.values(el.hitInfo)[0]
          : el;

        const name   = hit?.text?.text   ?? hit?.name     ?? '';
        const title  = hit?.subtext?.text ?? hit?.headline ?? '';

        // Avatar: LinkedIn stores images as relative path segments
        const artifact =
          hit?.image?.attributes?.[0]?.detailData
            ?.['com.linkedin.voyager.dash.common.image.ImageViewModel']
            ?.artifacts?.[0]
          ?? hit?.image?.attributes?.[0]?.detailData
            ?.['com.linkedin.voyager.common.image.ImageViewModel']
            ?.artifacts?.[0];

        const avatar = artifact?.fileIdentifyingUrlPathSegment
          ? `https://media.licdn.com/dms/image/${artifact.fileIdentifyingUrlPathSegment}`
          : (hit?.image?.rootUrl
              ? hit.image.rootUrl + (artifact?.fileIdentifyingUrlPathSegment ?? '')
              : '');

        return { name, title, avatar };
      })
      .filter((r) => r.name && r.name.length > 1 && r.name.length < 60);
  }

  // ── Fallback: scrape LinkedIn's own search-bar dropdown (last resort) ─────────
  async function searchViaDom(query) {
    const input =
      document.querySelector('input[placeholder*="looking for"]') ||
      document.querySelector('input.search-global-typeahead__input') ||
      shadowQuery('input[placeholder*="looking for"]') ||
      shadowQuery('input[placeholder*="Search"]') ||
      shadowQuery('input[role="combobox"]') ||
      document.querySelector('input[role="combobox"]');

    if (!input) return [];

    // Hide the dropdown so it doesn't flash on screen
    const hideStyle = document.createElement('style');
    hideStyle.textContent = `
      [role="listbox"], [role="combobox"] + *,
      .search-global-typeahead__overlay { opacity:0!important; pointer-events:none!important; }
    `;
    document.head.appendChild(hideStyle);

    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await delay(80);

      input.focus();
      setter.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));

      let results = [];
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        await delay(250);
        const options = [
          ...document.querySelectorAll('[role="option"]'),
          ...shadowQueryAll('[role="option"]'),
        ];
        const real = options.filter((o) => {
          const t = o.textContent?.trim() || '';
          return t.includes('•') && !t.includes('recent entity history');
        });
        if (real.length) {
          results = real
            .map((o) => {
              const parts = (o.textContent?.trim() || '').split('•').map((s) => s.trim());
              return {
                name:   parts[0] || '',
                title:  parts.slice(2).join(' · ').substring(0, 80) || parts[1] || '',
                avatar: o.querySelector('img')?.src || '',
              };
            })
            .filter((r) => r.name.length > 1 && r.name.length < 50 &&
              !['see all results', 'show all'].includes(r.name.toLowerCase()));
          break;
        }
      }

      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      return results;
    } finally {
      hideStyle.remove();
    }
  }

  // ── Public entry point ────────────────────────────────────────────────────────
  async function searchLinkedInPeople(query) {
    if (searchInProgress || !query) return;
    searchInProgress = true;
    try {
      // Try the invisible API route first; fall back to DOM scraping if it fails
      const apiResults = await searchViaApi(query);
      const results = (apiResults && apiResults.length > 0)
        ? apiResults
        : await searchViaDom(query);

      chrome.runtime.sendMessage({
        type: 'LINKEDIN_SEARCH_RESULTS',
        results: results.slice(0, 7),
        query,
      });
    } catch (err) {
      console.warn('[SpreadUp] search error:', err);
      chrome.runtime.sendMessage({ type: 'LINKEDIN_SEARCH_RESULTS', results: [], query });
    } finally {
      searchInProgress = false;
    }
  }

  // ─── Message handler (from panel via chrome.runtime relay) ───────────────────

  function handleMessage(msg) {
    const { type, payload } = msg || {};
    if (!type) return;

    switch (type) {
      case 'CLOSE_PANEL':
        hidePanel();
        break;
      case 'INSERT_TEXT':
        insertTextIntoEditor(getLinkedInEditor(), payload?.text);
        break;
      case 'GET_EDITOR_TEXT': {
        const editor = getLinkedInEditor();
        chrome.runtime.sendMessage({ type: 'EDITOR_TEXT', text: editor?.innerText || '' });
        break;
      }
      case 'GET_PROFILE': {
        const profile = getLinkedInProfile();
        chrome.runtime.sendMessage({ type: 'PROFILE_INFO', ...profile });
        break;
      }
      case 'PUBLISH_POST':
        handlePublish(payload?.text, payload?.attachments || []);
        break;
      case 'SEARCH_LINKEDIN':
        searchLinkedInPeople(payload?.query);
        break;
      default:
        break;
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    injectTriggerButton();

    // Listen for messages from panel (relayed via background service worker)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // Only handle messages forwarded by the background script
      if (msg._fromBackground) {
        handleMessage(msg);
      }
    });

    // Reconnect to existing panel iframe (e.g. after extension reload)
    const existing = document.getElementById('spreadup-panel');
    if (existing) {
      panelFrame = existing;
      panelVisible = existing.style.display !== 'none';
    }

    // Check for pending publish (e.g. after navigate-to-share fallback)
    resumePendingPublish();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
