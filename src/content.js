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

    window.addEventListener('message', handlePanelMessage);
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

  async function handlePublish(text) {
    // Hide SpreadUp panel so user can see the LinkedIn composer
    hidePanel();

    // Step 1: Check if editor is already open
    let editor = getLinkedInEditor();

    if (!editor) {
      // Step 2: Click "Start a post" — search by text content (classes are obfuscated)
      const trigger = shadowFindByText('[role="button"], button', 'Start a post');

      if (trigger) {
        // Full event sequence for React compat
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
          trigger.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true }));
        });

        // Step 3: Wait for Quill editor to appear inside Shadow DOM
        editor = await pollFor(() => getLinkedInEditor(), 6000);
      }
    }

    if (!editor) {
      // Fallback: copy to clipboard
      try { await navigator.clipboard.writeText(text); } catch (_) {}
      panelFrame?.contentWindow?.postMessage({ type: 'PUBLISH_COPY_FALLBACK' }, '*');
      return;
    }

    // Step 4: Insert text into the Quill editor
    insertTextIntoEditor(editor, text);

    // Step 5: Wait for LinkedIn to process the text and enable the Post button
    await delay(800);

    // Step 6: Find and click LinkedIn's own "Post" button (inside shadow DOM)
    const postBtn = await pollFor(() => {
      const btn = shadowFindByText('button', 'Post');
      return (btn && !btn.disabled) ? btn : null;
    }, 3000);

    if (!postBtn) {
      panelFrame?.contentWindow?.postMessage({ type: 'PUBLISH_NEED_MANUAL', reason: 'Post button not found — click Post manually.' }, '*');
      return;
    }

    postBtn.click();

    // Step 7: Wait for the modal/editor to close (= post published)
    const published = await pollFor(() => !getLinkedInEditor(), 15000);

    if (published) {
      // Step 8: Wait for feed to update, then navigate to the published post
      await delay(2500);
      const postLink = shadowQueryAll('a[href*="/feed/update/"]')[0];
      if (postLink?.href) {
        window.location.href = postLink.href;
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    panelFrame?.contentWindow?.postMessage({ type: 'PUBLISH_SUCCESS' }, '*');
  }

  // ─── Message handler (from panel iframe) ─────────────────────────────────────

  function handlePanelMessage(event) {
    if (event.source !== panelFrame?.contentWindow) return;
    const { type, payload } = event.data || {};

    switch (type) {
      case 'CLOSE_PANEL':
        hidePanel();
        break;
      case 'INSERT_TEXT':
        insertTextIntoEditor(getLinkedInEditor(), payload.text);
        break;
      case 'GET_EDITOR_TEXT': {
        const editor = getLinkedInEditor();
        panelFrame.contentWindow?.postMessage(
          { type: 'EDITOR_TEXT', text: editor?.innerText || '' },
          '*'
        );
        break;
      }
      case 'GET_PROFILE': {
        const profile = getLinkedInProfile();
        panelFrame.contentWindow?.postMessage({ type: 'PROFILE_INFO', ...profile }, '*');
        break;
      }
      case 'PUBLISH_POST':
        handlePublish(payload.text);
        break;
      default:
        break;
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    injectTriggerButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
