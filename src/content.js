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

    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const ok = document.execCommand('insertText', false, text);

    if (!ok) {
      editor.innerText = text;
    }

    editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
  }

  // ─── LinkedIn profile scraping ────────────────────────────────────────────────

  function getLinkedInProfile() {
    const ownImg = [...document.querySelectorAll('img')].find((i) =>
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

  async function handlePublish(text, attachments = []) {
    hidePanel();

    // Step 1: Check if editor is already open
    let editor = getLinkedInEditor();

    if (!editor) {
      // Step 2: Try to click "Start a post"
      const trigger = shadowFindByText('[role="button"], button', 'Start a post')
        || shadowQueryAll('[role="button"], button').find((el) => el.textContent?.trim().toLowerCase().includes('start a post'));

      if (trigger) {
        // Try native .click() first (works better than synthetic events in some cases)
        trigger.click();
        editor = await pollFor(() => getLinkedInEditor(), 3000);

        // If native click failed, try full event sequence
        if (!editor) {
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((evtType) => {
            trigger.dispatchEvent(new PointerEvent(evtType, { bubbles: true, cancelable: true, composed: true }));
          });
          editor = await pollFor(() => getLinkedInEditor(), 4000);
        }

        // If synthetic events also failed, try keyboard activation
        if (!editor) {
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
          editor = await pollFor(() => getLinkedInEditor(), 3000);
        }
      }
    }

    if (!editor) {
      // All click approaches failed — navigate to feed with shareActive=true
      // This causes LinkedIn to open the composer on page load
      showStatusToast('SpreadUp: Opening composer…');
      await savePendingPublish(text, attachments);
      window.location.href = 'https://www.linkedin.com/feed/?shareActive=true';
      return;
    }

    // Editor is open — insert text
    showStatusToast('SpreadUp: Inserting your post…');
    insertTextIntoEditor(editor, text);

    // Upload attachments if any
    if (attachments && attachments.length > 0) {
      await delay(400);
      try { await uploadAttachments(attachments); } catch (err) {
        console.warn('[SpreadUp] Attachment upload failed:', err);
      }
    }

    showStatusToast('SpreadUp: Post ready — click Post to publish!');
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

  // ─── LinkedIn people search via DOM scraping ─────────────────────────────────
  // LinkedIn's old Voyager REST APIs are gone (404). The new RSC/SDUI endpoints
  // are session-coupled and can't be called programmatically. Instead, we type
  // into LinkedIn's own search bar, scrape the dropdown results, then clear it.
  // A CSS overlay hides the entire search UI so the user sees nothing.

  let searchInProgress = false;
  let searchHideStyle = null;

  function hideLinkedInSearch() {
    if (searchHideStyle) return;
    searchHideStyle = document.createElement('style');
    searchHideStyle.textContent = `
      [role="listbox"], [role="combobox"] + *, .search-global-typeahead__overlay {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(searchHideStyle);
  }

  function showLinkedInSearch() {
    if (searchHideStyle) {
      searchHideStyle.remove();
      searchHideStyle = null;
    }
  }

  async function searchLinkedInPeople(query) {
    if (searchInProgress || !query || query.length < 1) return;
    searchInProgress = true;

    try {
      // LinkedIn's search bar — try multiple selectors for different UI versions
      const input = document.querySelector('input[placeholder*="looking for"]')
        || document.querySelector('input.search-global-typeahead__input')
        || shadowQuery('input[placeholder*="looking for"]')
        || shadowQuery('input[placeholder*="Search"]')
        || shadowQuery('input[role="combobox"]')
        || document.querySelector('input[role="combobox"]');
      if (!input) {
        // Send empty results back so panel doesn't hang on "Searching…"
        chrome.runtime.sendMessage({ type: 'LINKEDIN_SEARCH_RESULTS', results: [], query });
        searchInProgress = false;
        return;
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

      // Hide LinkedIn's search dropdown BEFORE we start typing
      hideLinkedInSearch();

      // Clear any existing search
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await delay(100);

      // Type the query
      input.focus();
      setter.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Wait for REAL search results (not history items) to appear (poll up to 2.5s)
      let results = [];
      const start = Date.now();
      while (Date.now() - start < 2500) {
        await delay(250);
        const options = [...document.querySelectorAll('[role="option"]'),
                         ...shadowQueryAll('[role="option"]')];
        const realResults = options.filter((o) => {
          const text = o.textContent?.trim() || '';
          return text.includes('•') && !text.includes('recent entity history');
        });

        if (realResults.length > 0) {
          results = realResults
            .map((o) => {
              const text = o.textContent?.trim() || '';
              const parts = text.split('•').map((s) => s.trim());
              const name = parts[0] || '';
              const title = parts.slice(2).join(' · ').substring(0, 80)
                || parts[1] || '';
              // Grab profile image
              const img = o.querySelector('img');
              const avatar = img?.src || '';
              return { name, title, avatar };
            })
            .filter((r) => r.name && r.name.length > 1 && r.name.length < 50
              && r.name.toLowerCase() !== 'see all results'
              && r.name.toLowerCase() !== 'show all');
          break;
        }
      }

      // Clear search and restore visibility
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      showLinkedInSearch();

      // Send results back to panel via chrome.runtime (panel listens on onMessage)
      chrome.runtime.sendMessage({
        type: 'LINKEDIN_SEARCH_RESULTS',
        results: results.slice(0, 7),
        query,
      });
    } catch (err) {
      console.warn('[SpreadUp] search error:', err);
      showLinkedInSearch();
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
