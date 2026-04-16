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

  async function getLinkedInProfile(csrfFromBackground) {
    // Strategy 0: Voyager /me API — most reliable, not affected by LinkedIn DOM changes.
    // Background supplies the CSRF token (reads httpOnly JSESSIONID via chrome.cookies).
    try {
      const csrf = csrfFromBackground || getLinkedInCsrf();
      if (csrf) {
        const res = await fetch('/voyager/api/me', {
          credentials: 'include',
          headers: {
            'csrf-token':                csrf,
            'x-restli-protocol-version': '2.0.0',
            'accept':                    'application/vnd.linkedin.normalized+json+2.1',
          },
        });
        if (res.ok) {
          const data = await res.json();
          const included = data?.included || [];
          const mini = included.find(i =>
            (i.$type || '').toLowerCase().includes('miniprofile')
          );
          if (mini) {
            const name     = `${mini.firstName || ''} ${mini.lastName || ''}`.trim() || null;
            const headline = mini.occupation || null;

            // LinkedIn's normalized+json stores the photo two ways:
            //   A) Embedded: mini.picture = { $type: VectorImage, rootUrl, artifacts }
            //   B) URN ref:  mini["*picture"] = "urn:li:digitalmediaAsset:…"
            //      with the VectorImage as a separate entry in included[]
            let avatar = null;
            const photoVm = mini.picture;
            if (photoVm?.rootUrl && photoVm?.artifacts?.length) {
              // Format A — embedded VectorImage
              const art = photoVm.artifacts[photoVm.artifacts.length - 1];
              avatar = photoVm.rootUrl + art.fileIdentifyingUrlPathSegment;
            } else {
              // Format B — find the VectorImage in included[] by matching the URN.
              // LinkedIn stores the reference as *picture or *profilePicture (varies by API version).
              const pictureUrn = mini['*picture'] || mini['*profilePicture'];
              if (pictureUrn) {
                // Try exact entityUrn match first, then fall back to any VectorImage with rootUrl
                const vi = included.find(i => i.entityUrn === pictureUrn)
                        || included.find(i => (i.$type || '').toLowerCase().includes('vectorimage') && i.rootUrl);
                if (vi?.rootUrl && vi?.artifacts?.length) {
                  const art = vi.artifacts[vi.artifacts.length - 1];
                  avatar = vi.rootUrl + art.fileIdentifyingUrlPathSegment;
                } else if (vi?.rootUrl) {
                  avatar = vi.rootUrl;
                }
              }
              // Format C — rootUrl directly on mini (some API versions)
              if (!avatar && mini.rootUrl) avatar = mini.rootUrl;
            }

            if (name) return { name, headline, avatar };
          }
        }
      }
    } catch (_) {}

    // Strategy 1: Find profile photo in the global nav bar.
    let ownImg = null;

    // Try nav-specific selectors first (shadow DOM aware)
    const navImgSelectors = [
      'img.global-nav__me-photo',
      'img[class*="global-nav__me"]',
      'img[class*="nav__menu-item__icon"]',
      'header img[alt]:not([alt=""])',
      'nav img[alt]:not([alt=""])',
    ];

    for (const sel of navImgSelectors) {
      const candidates = shadowQueryAll(sel).filter(i =>
        i.alt && i.alt.length > 0 && i.width <= 64
      );
      if (candidates.length) { ownImg = candidates[0]; break; }
    }

    // Strategy 2: Any img whose src contains profile photo CDN patterns
    if (!ownImg) {
      const cdnPatterns = ['profile-displayphoto', 'profile-framedphoto', '/dms/image/'];
      ownImg = shadowQueryAll('img').find((i) => {
        if (!i.alt || i.alt.length === 0) return false;
        if (i.alt.startsWith('View ') || i.alt.toLowerCase().includes('company')) return false;
        if (i.width > 80 || i.height > 80) return false; // nav photos are small
        return cdnPatterns.some(p => i.src?.includes(p));
      });
    }

    // Strategy 3: Broader - find any small nav image with a reasonable name alt text
    if (!ownImg) {
      ownImg = shadowQueryAll('img').find((i) => {
        if (!i.alt || i.alt.length < 2 || i.alt.length > 60) return false;
        if (i.alt.startsWith('View ') || /^\d/.test(i.alt)) return false;
        const src = i.src || '';
        return src.includes('licdn.com') || src.includes('linkedin.com');
      });
    }

    const name   = ownImg?.alt?.replace(/\s*Photo$/, '').trim() || null;
    const avatar = ownImg?.src || null;

    let headline = null;

    // Try to get headline from the profile page sidebar or nav hover card
    if (name) {
      const profileLinks = shadowQueryAll('a[href*="/in/"]');
      for (const link of profileLinks) {
        const text = link.innerText?.trim();
        if (!text || !text.includes(name)) continue;
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const idx = lines.findIndex(l => l === name || l.includes(name));
        if (idx !== -1 && lines[idx + 1] && lines[idx + 1].length > 8) {
          headline = lines[idx + 1];
          break;
        }
      }
    }

    // Fallback: traverse up from the image to find a text container
    if (!headline && ownImg && name) {
      let container = ownImg.parentElement;
      for (let k = 0; k < 8; k++) {
        if (!container) break;
        const t = container.innerText?.trim();
        if (t && t.includes(name) && t.length > name.length + 5) break;
        container = container.parentElement;
      }
      if (container) {
        const lines = container.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
        const idx = lines.findIndex((l) => l === name || l.includes(name));
        if (idx !== -1 && lines[idx + 1]) {
          const candidate = lines[idx + 1];
          headline = candidate.length > 8 ? candidate : (lines[idx + 2] || null);
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

  async function getMyMemberUrn(csrfOverride) {
    const csrf = csrfOverride || getLinkedInCsrf();
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

  async function publishViaApi(text, csrfFromBackground) {
    // Prefer CSRF supplied by background (reads httpOnly cookie) over document.cookie
    const csrf = csrfFromBackground || getLinkedInCsrf();
    if (!csrf) return null;

    const authorUrn = await getMyMemberUrn(csrf);
    if (!authorUrn) return null;

    // Attempt 1: normShares endpoint (with author field required by current API)
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
          author: authorUrn,
          visibleToGuest: true,
          shareAudience: { 'com.linkedin.voyager.feed.MemberAudience': { values: [] } },
          shareMediaCategory: 'NONE',
          subject: '',
          text: { text },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const urn = data?.value?.id ?? data?.data?.id ?? data?.id;
        if (urn) return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
      }
    } catch (_) {}

    // Attempt 2: ugcPosts endpoint (newer LinkedIn API format)
    try {
      const res = await fetch('/voyager/api/ugcPosts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'csrf-token':                csrf,
          'content-type':              'application/json',
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify({
          author: authorUrn,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const urn = data?.id ?? data?.value?.id;
        if (urn) return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
      }
    } catch (_) {}

    return null;
  }

  // ─── Publish flow ─────────────────────────────────────────────────────────────

  async function handlePublish(text, attachments = [], csrfFromBackground) {
    // ── Fast path: post directly via API, navigate to the new post ─────────────
    showStatusToast('SpreadUp: Posting…');
    const postUrl = await publishViaApi(text, csrfFromBackground);

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

  // ─── CSRF helper (used by publishViaApi and Voyager search) ─────────────────
  // For publish: reads JSESSIONID from document.cookie (works if not httpOnly).
  // For search: background supplies the csrf via message payload (reads httpOnly
  // cookie via chrome.cookies.get, then forwards it here).

  function getLinkedInCsrf() {
    return document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('JSESSIONID='))
      ?.split('=').slice(1).join('=')
      ?.replace(/^"|"$/g, '') || null;
  }

  // ─── Voyager people search (called by background with csrf token) ─────────────
  // Pure API call — zero DOM interaction. The content script runs on linkedin.com
  // so credentials: 'include' sends session cookies automatically.

  async function searchVoyagerApi(query, csrf) {
    if (!csrf || !query) return [];

    // ── Avatar extractor — handles 4 different LinkedIn image nested shapes ──────
    function extractAvatar(hit) {
      try {
        const attrs = (hit?.image?.attributes) || [];
        for (const attr of attrs) {
          // Shape A: detailData keyed by a type URI containing "ImageViewModel"
          const dd = attr?.detailData || {};
          const vmKey = Object.keys(dd).find(k => k.includes('ImageViewModel'));
          if (vmKey) {
            const vm = dd[vmKey];
            const art = (vm?.artifacts || [])[0];
            if (art?.fileIdentifyingUrlPathSegment) {
              const root = vm.rootUrl || 'https://media.licdn.com/dms/image/';
              return root + art.fileIdentifyingUrlPathSegment;
            }
          }
          // Shape B: com.linkedin.common.VectorImage at attribute root
          const vi = attr?.['com.linkedin.common.VectorImage'];
          if (vi?.rootUrl) {
            const art = (vi.artifacts || [])[0];
            return art ? vi.rootUrl + art.fileIdentifyingUrlPathSegment : vi.rootUrl;
          }
        }
        // Shape C: rootUrl directly on image
        if (hit?.image?.rootUrl) return hit.image.rootUrl;
      } catch (_) {}
      return '';
    }

    // ── Person extractor — called on each raw element or included item ───────────
    function extractPerson(raw) {
      // raw may have hitInfo nested 1 or 2 levels deep (TypeaheadHit → SearchProfile)
      let hit = raw;
      for (let depth = 0; depth < 2 && hit?.hitInfo; depth++) {
        const inner = Object.values(hit.hitInfo)[0];
        hit = (inner && typeof inner === 'object' && (inner.member || inner.entity || inner)) || hit;
      }
      if (!hit) return null;

      // Some responses wrap person fields inside a miniProfile sub-object
      if (!hit.firstName && !hit.lastName && !hit.text && !hit.name && hit.miniProfile) {
        hit = hit.miniProfile;
      }

      // Name — stored in different fields across API versions
      // IMPORTANT: avoid operator-precedence pitfalls, use explicit || chains
      const nameParts = [
        hit.text && hit.text.text,
        hit.title && hit.title.text,
        hit.name,
        (hit.firstName || hit.lastName)
          ? `${hit.firstName || ''} ${hit.lastName || ''}`.trim()
          : null,
      ];
      const name = (nameParts.find(v => v && v.trim()) || '').trim();
      if (!name || name.length < 2 || name.length > 80) return null;

      const titleParts = [
        hit.subtext && hit.subtext.text,
        hit.subtitle && hit.subtitle.text,
        hit.primarySubtitle && hit.primarySubtitle.text,
        hit.secondarySubtitle && hit.secondarySubtitle.text,
        hit.headline,
        hit.occupation,
      ];
      const title = (titleParts.find(v => v && v.trim()) || '').trim();
      const avatar = extractAvatar(hit);

      return { name, title, avatar };
    }

    // ── Response parser — handles plain JSON and normalized+json formats ──────────
    function parseResponse(json) {
      const people = [];

      // Build a URN → included-item index for normalized+json lookups
      const includedByUrn = {};
      if (Array.isArray(json?.included)) {
        for (const item of json.included) {
          if (item && typeof item === 'object' && item.entityUrn) {
            includedByUrn[item.entityUrn] = item;
          }
        }
      }

      // Format 1 (plain JSON / application/json):
      //   { data: { elements: [...] } } or { elements: [...] }
      //   or Dash GraphQL: { data: { data: { "com.linkedin.voyager.dash.*": { elements: [...] } } } }
      //   LinkedIn Dash GraphQL also uses "*elements" (asterisk-prefixed URN list) instead of "elements"
      const dashNested = json?.data?.data ? Object.values(json.data.data)[0] : null;
      const rawElements = json?.data?.elements || json?.elements
        || dashNested?.elements || dashNested?.['*elements'] || [];
      for (const el of rawElements) {
        // In normalized format, elements are URN strings — resolve via included index
        if (typeof el === 'string') {
          const resolved = includedByUrn[el];
          if (resolved) {
            const p = extractPerson(resolved);
            if (p) people.push(p);
          }
          continue;
        }
        const p = extractPerson(el);
        if (p) people.push(p);
      }

      // Format 2 (normalized+json):
      //   { included: [ { $type: '...TypeaheadHit', ... } ], data: { elements: ['urn:...'] } }
      // When elements were all URN strings (or absent), scan included[] directly.
      if (!people.length && Array.isArray(json?.included)) {
        for (const item of json.included) {
          if (!item || typeof item !== 'object') continue;
          // Skip well-known non-person metadata types; let extractPerson gate the rest
          const type = (item.$type || item['$type'] || '').toLowerCase();
          if (type && (type.includes('paging') || type.includes('metadata')
              || type.includes('config') || type.includes('footer')
              || type.includes('vectorimage') || type.includes('imageviewmodel')
              || type.includes('collectionresponse'))) continue;
          const p = extractPerson(item);
          if (p) people.push(p);
        }
      }

      return people.slice(0, 7);
    }

    // ── HTTP helper — logs failures, never throws ────────────────────────────────
    async function fetchTypeahead(url, headers) {
      try {
        const res = await fetch(url, { credentials: 'include', headers });
        if (!res.ok) {
          console.warn('[SpreadUp] typeahead HTTP', res.status, url.split('?')[0]);
          return [];
        }
        const json = await res.json();
        // Diagnostic: log raw response shape so we can verify parseResponse handles it
        console.log('[SpreadUp] typeahead RAW shape:', {
          topKeys:      Object.keys(json),
          dataKeys:     json.data     ? Object.keys(json.data)      : [],
          dataDataKeys: json.data?.data ? Object.keys(json.data.data) : [],
          elemLen:      json.data?.elements?.length,
          inclLen:      json.included?.length,
          firstIncl:    JSON.stringify(json.included?.[0])?.slice(0, 200),
          firstEl:      JSON.stringify(json.data?.elements?.[0] ?? json.elements?.[0])?.slice(0, 200),
        });
        const people = parseResponse(json);
        console.log('[SpreadUp] typeahead →', people.length, 'results', url.split('queryId=')[1] || url.slice(-40));
        return people;
      } catch (err) {
        console.warn('[SpreadUp] typeahead fetch error:', err.message, url.split('?')[0]);
        return [];
      }
    }

    const baseHeaders = {
      'csrf-token':                csrf,
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang':                 'en_US',
      'accept-language':           'en-US,en;q=0.9',
    };
    const headersJson       = { ...baseHeaders, accept: 'application/json' };
    const headersNormalized = { ...baseHeaders, accept: 'application/vnd.linkedin.normalized+json+2.1' };

    const kw = encodeURIComponent(query);

    // Attempt 1 — voyagerSearchDashSharing with origin (LinkedIn's current mention endpoint, confirmed 2026)
    // Uses the same variables structure LinkedIn's own composer sends for @mention autocomplete.
    let results = await fetchTypeahead(
      `/voyager/api/graphql?variables=(keywords:${kw},origin:OTHER,count:7,filters:List())&queryId=voyagerSearchDashSharing.4e26d0f2284baec4fa3fe92c090494cd`,
      headersNormalized,
    );
    if (results.length) return results;

    // Attempt 2 — same endpoint, minimal variables (no origin), normalized accept header
    results = await fetchTypeahead(
      `/voyager/api/graphql?includeWebMetadata=true&variables=(keywords:${kw})&queryId=voyagerSearchDashSharing.4e26d0f2284baec4fa3fe92c090494cd`,
      headersNormalized,
    );
    if (results.length) return results;

    // Attempt 3 — same endpoint, plain JSON accept header
    results = await fetchTypeahead(
      `/voyager/api/graphql?includeWebMetadata=true&variables=(keywords:${kw})&queryId=voyagerSearchDashSharing.4e26d0f2284baec4fa3fe92c090494cd`,
      headersJson,
    );
    if (results.length) return results;

    // Attempt 4 — hitsV2 type=PEOPLE (older endpoint, kept as fallback)
    results = await fetchTypeahead(
      `/voyager/api/typeahead/hitsV2?keywords=${kw}&origin=OTHER&q=type&type=PEOPLE`,
      headersNormalized,
    );
    if (results.length) return results;

    // Attempt 5 — hitsV2 blended
    results = await fetchTypeahead(
      `/voyager/api/typeahead/hitsV2?keywords=${kw}&q=blended`,
      headersJson,
    );
    if (results.length) return results;

    // Attempt 6 — legacy hits endpoint
    results = await fetchTypeahead(
      `/voyager/api/typeahead/hits?keywords=${kw}&q=type&type=PEOPLE&count=7`,
      headersJson,
    );
    if (results.length) return results;

    // Attempt 7 — search/blended with PEOPLE filter
    results = await fetchTypeahead(
      `/voyager/api/search/blended?keywords=${kw}&origin=TYPEAHEAD_ESCAPE_HATCH&q=blended&filters=List(resultType-%3EPEOPLE)&count=7`,
      headersJson,
    );
    return results;
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
        getLinkedInProfile(payload?.csrf).then(profile => {
          chrome.runtime.sendMessage({ type: 'PROFILE_INFO', ...profile });
        });
        break;
      }
      case 'PUBLISH_POST':
        handlePublish(payload?.text, payload?.attachments || [], payload?.csrf);
        break;
      // SEARCH_LINKEDIN is handled entirely in background.js — no content script involved
      default:
        break;
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    injectTriggerButton();

    // Direct close via postMessage from the panel iframe (bypasses background relay).
    // This fires immediately when the X is clicked, even if the background is busy.
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'SPREADUP_CLOSE') hidePanel();
    });

    // Listen for messages from panel (relayed via background service worker)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg._fromBackground) return;

      // _SEARCH_VOYAGER: async API call — must return true to keep sendResponse alive
      if (msg.type === '_SEARCH_VOYAGER') {
        const { query, csrf } = msg.payload || {};
        searchVoyagerApi(query, csrf)
          .then((results) => sendResponse({ results }))
          .catch(() => sendResponse({ results: [] }));
        return true; // keep channel open for async sendResponse
      }

      handleMessage(msg);
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
