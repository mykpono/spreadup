// SpreadUp — Panel JS
// Runs inside the panel iframe. Communicates with background via chrome.runtime,
// and with the content script via window.postMessage.

'use strict';

const FREE_POST_LIMIT = 50;
const PAYMENT_URL = 'https://YOUR_PAYMENT_LINK'; // update in firebase/config.js

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  user: null,         // { uid, email, displayName, plan, postCount }
  activeTab: 'editor',
  editorText: '',
  drafts: [],
  snippets: [],
  attachments: [],    // { id, type: 'image'|'doc', name, dataUrl, file }
  activeHookCat: 'all',
  activeCtaCat: 'all',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const authScreen    = $('#auth-screen');
const appScreen     = $('#app-screen');
const btnSignIn     = $('#btn-signin');
const btnSignOut    = $('#btn-signout');
const btnClose      = $('#btn-close');
const editorArea    = $('#editor-area');
const charCount     = $('#char-count');
const wordCount     = $('#word-count');
const readTime      = $('#read-time');
const fkScore       = $('#fk-score');
const previewBody   = $('#preview-body');
const previewPane   = $('#preview-pane');
const seeMoreHint   = $('#see-more-hint');
const btnPublish    = $('#btn-publish');
const btnSaveDraft  = $('#btn-save-draft');
const paywallOverlay = $('#paywall-overlay');
const btnPaywallUpgrade = $('#btn-paywall-upgrade');
const btnPaywallClose   = $('#btn-paywall-close');
const btnUpgrade    = $('#btn-upgrade');
const postsRemainingLabel = $('#posts-remaining-label');
const progressBar   = $('#progress-bar');
const licenseSubEl  = $('#license-sub');
const licenseBadge  = $('#license-badge');
const settingsName  = $('#settings-name');
const settingsEmail = $('#settings-email');

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadLocalData();
  renderHooks();
  renderCtas();
  renderDrafts();
  renderSnippets();
  setupEditorEvents();
  setupNavigation();
  setupToolbar();
  setupEmojiPicker();
  setupHooksSearch();
  setupCtasSearch();
  setupSnippetForm();
  setupActions();

  // Skip auth for now — go straight to app
  showApp();
  setupAnthropicKey();
}

// ─── Background messaging ─────────────────────────────────────────────────────
function bg(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, resolve);
    } catch (err) {
      // "Extension context invalidated" — extension was reloaded, page needs refresh
      if (err.message?.includes('invalidated')) {
        showToast('Extension updated — please refresh the LinkedIn page');
      }
      resolve({ error: err.message });
    }
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function showAuth() {
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
}

function showApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  updateUserUI();
  // Ask content script for LinkedIn profile info
  window.parent.postMessage({ type: 'GET_PROFILE' }, '*');
}

btnSignIn.addEventListener('click', async () => {
  btnSignIn.disabled = true;
  btnSignIn.textContent = 'Signing in…';
  try {
    const result = await bg('SIGN_IN');
    if (result?.uid) {
      state.user = await bg('GET_USER_DATA');
      showApp();
    } else {
      btnSignIn.disabled = false;
      btnSignIn.innerHTML = `<svg>…</svg> Continue with Google`;
    }
  } catch {
    btnSignIn.disabled = false;
    btnSignIn.textContent = 'Try again';
  }
});

btnSignOut.addEventListener('click', async () => {
  await bg('SIGN_OUT');
  state.user = null;
  showAuth();
});

function updateUserUI() {
  if (!state.user) return;
  settingsName.textContent  = state.user.displayName || 'User';
  settingsEmail.textContent = state.user.email || '';

  const isPaid = state.user.plan === 'paid';
  licenseBadge.textContent = isPaid ? 'Pro — unlimited' : 'Free plan';
  licenseBadge.className = `badge ${isPaid ? 'badge-paid' : 'badge-free'}`;
  btnUpgrade.style.display = isPaid ? 'none' : 'inline-flex';

  const used = state.user.postCount || 0;
  const pct  = isPaid ? 100 : Math.min((used / FREE_POST_LIMIT) * 100, 100);
  progressBar.style.width = `${pct}%`;
  licenseSubEl.textContent = isPaid
    ? `${used} posts published`
    : `${used} of ${FREE_POST_LIMIT} free posts used`;

  const remaining = Math.max(FREE_POST_LIMIT - used, 0);
  postsRemainingLabel.textContent = isPaid
    ? 'Pro — unlimited'
    : `${remaining} free post${remaining !== 1 ? 's' : ''} left`;
  postsRemainingLabel.className = `badge ${isPaid ? 'badge-paid' : 'badge-free'}`;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNavigation() {
  $$('.nav-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  $$('.nav-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
  $(`#tab-${tab}`)?.classList.remove('hidden');
}

btnClose.addEventListener('click', () => {
  window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*');
});

// ─── Editor ───────────────────────────────────────────────────────────────────
function setupEditorEvents() {
  editorArea.addEventListener('input', () => {
    state.editorText = editorArea.value;
    updateStats();
    updatePreview();
    autosaveDraft();
  });

  // Auto-format on paste
  editorArea.addEventListener('paste', () => {
    const before = editorArea.value;
    setTimeout(() => {
      if (editorArea.value !== before) {
        state.editorText = editorArea.value;
        formatPostText();
      }
    }, 100);
  });
}

function updateStats() {
  const text  = state.editorText;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const mins  = Math.max(1, Math.ceil(words / 200));

  charCount.textContent = `${chars} / 3000`;
  charCount.style.color = chars > 2800 ? '#EF4444' : '';
  wordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  readTime.textContent  = `~${mins} min read`;

  // Flesch-Kincaid grade level (simple approximation)
  const sentences = (text.match(/[.!?]+/g) || []).length || 1;
  const syllables = countSyllables(text);
  const fk = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
  const grade = isNaN(fk) ? 0 : Math.round(fk);

  fkScore.textContent = `Grade ${grade}`;
  fkScore.className = 'fk-badge ' + (grade <= 8 ? 'fk-green' : grade <= 11 ? 'fk-amber' : 'fk-red');
}

function countSyllables(text) {
  return (text.toLowerCase().match(/[aeiouy]+/g) || []).length;
}

function updatePreview() {
  const text = state.editorText;
  const FOLD = 210;
  if (text.length > FOLD) {
    previewBody.textContent = text.slice(0, FOLD);
    seeMoreHint.classList.remove('hidden');
  } else {
    previewBody.textContent = text || 'Your post preview will appear here as you type…';
    seeMoreHint.classList.add('hidden');
  }
}

// Desktop/mobile toggle
$('#view-desktop').addEventListener('click', () => {
  $('#view-desktop').classList.add('active');
  $('#view-mobile').classList.remove('active');
  previewPane.classList.remove('mobile');
});

$('#view-mobile').addEventListener('click', () => {
  $('#view-mobile').classList.add('active');
  $('#view-desktop').classList.remove('active');
  previewPane.classList.add('mobile');
});

// ─── Formatting toolbar ───────────────────────────────────────────────────────

// Unicode mapping tables
const UNICODE = {
  bold: {
    A:'𝗔',B:'𝗕',C:'𝗖',D:'𝗗',E:'𝗘',F:'𝗙',G:'𝗚',H:'𝗛',I:'𝗜',J:'𝗝',K:'𝗞',L:'𝗟',M:'𝗠',
    N:'𝗡',O:'𝗢',P:'𝗣',Q:'𝗤',R:'𝗥',S:'𝗦',T:'𝗧',U:'𝗨',V:'𝗩',W:'𝗪',X:'𝗫',Y:'𝗬',Z:'𝗭',
    a:'𝗮',b:'𝗯',c:'𝗰',d:'𝗱',e:'𝗲',f:'𝗳',g:'𝗴',h:'𝗵',i:'𝗶',j:'𝗷',k:'𝗸',l:'𝗹',m:'𝗺',
    n:'𝗻',o:'𝗼',p:'𝗽',q:'𝗾',r:'𝗿',s:'𝘀',t:'𝘁',u:'𝘂',v:'𝘃',w:'𝘄',x:'𝘅',y:'𝘆',z:'𝘇',
    '0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟳','8':'𝟴','9':'𝟵',
  },
  italic: {
    A:'𝘈',B:'𝘉',C:'𝘊',D:'𝘋',E:'𝘌',F:'𝘍',G:'𝘎',H:'𝘏',I:'𝘐',J:'𝘑',K:'𝘒',L:'𝘓',M:'𝘔',
    N:'𝘕',O:'𝘖',P:'𝘗',Q:'𝘘',R:'𝘙',S:'𝘚',T:'𝘛',U:'𝘜',V:'𝘝',W:'𝘞',X:'𝘟',Y:'𝘠',Z:'𝘡',
    a:'𝘢',b:'𝘣',c:'𝘤',d:'𝘥',e:'𝘦',f:'𝘧',g:'𝘨',h:'𝘩',i:'𝘪',j:'𝘫',k:'𝘬',l:'𝘭',m:'𝘮',
    n:'𝘯',o:'𝘰',p:'𝘱',q:'𝘲',r:'𝘳',s:'𝘴',t:'𝘵',u:'𝘶',v:'𝘷',w:'𝘸',x:'𝘹',y:'𝘺',z:'𝘻',
  },
};

function convertText(text, style) {
  return [...text].map((ch) => UNICODE[style]?.[ch] || ch).join('');
}

function applyFormatToSelection(fmt) {
  const start = editorArea.selectionStart;
  const end   = editorArea.selectionEnd;
  const selected = editorArea.value.slice(start, end);
  if (!selected && fmt !== 'bullet' && fmt !== 'numbered' && fmt !== 'divider') return;

  let replacement = '';
  const bulletChar = $('#bullet-style').value;

  switch (fmt) {
    case 'bold':     replacement = convertText(selected, 'bold'); break;
    case 'italic':   replacement = convertText(selected, 'italic'); break;
    case 'strike':   replacement = [...selected].map((c) => c + '\u0336').join(''); break;
    case 'bullet': {
      const lines = editorArea.value.split('\n');
      const lineIdx = editorArea.value.slice(0, start).split('\n').length - 1;
      lines[lineIdx] = bulletChar + ' ' + lines[lineIdx];
      editorArea.value = lines.join('\n');
      updateStats(); updatePreview();
      return;
    }
    case 'numbered': {
      const lines = editorArea.value.split('\n');
      const lineIdx = editorArea.value.slice(0, start).split('\n').length - 1;
      lines[lineIdx] = '1. ' + lines[lineIdx];
      editorArea.value = lines.join('\n');
      updateStats(); updatePreview();
      return;
    }
    case 'divider':
      replacement = '\n───────────────\n';
      break;
    default: return;
  }

  editorArea.setRangeText(replacement, start, end, 'end');
  state.editorText = editorArea.value;
  updateStats(); updatePreview();
}

function setupToolbar() {
  $$('.tool-btn[data-fmt]').forEach((btn) => {
    btn.addEventListener('click', () => applyFormatToSelection(btn.dataset.fmt));
  });

  editorArea.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); applyFormatToSelection('bold'); }
      if (e.key === 'i') { e.preventDefault(); applyFormatToSelection('italic'); }
    }
  });
}

// ─── Emoji picker ─────────────────────────────────────────────────────────────
const EMOJI_SET = ['😀','😂','🤔','🔥','💡','✅','❌','🚀','🎯','💪','👀','⭐','🌟','📈','📊',
  '🤝','💼','🧠','📝','🎉','🙌','💬','📢','🔑','⚡','🌍','💰','🏆','🎁','📱'];

function setupEmojiPicker() {
  const toggle  = $('#emoji-toggle');
  const picker  = $('#emoji-picker');
  const search  = $('#emoji-search');
  const grid    = $('#emoji-grid');

  renderEmojiGrid(EMOJI_SET);

  toggle.addEventListener('click', () => picker.classList.toggle('hidden'));

  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    renderEmojiGrid(q ? EMOJI_SET.filter((e) => e.includes(q)) : EMOJI_SET);
  });

  function renderEmojiGrid(emojis) {
    grid.innerHTML = emojis.map((e) =>
      `<span class="emoji-item" data-emoji="${e}">${e}</span>`
    ).join('');
    $$('.emoji-item', grid).forEach((el) => {
      el.addEventListener('click', () => {
        const pos = editorArea.selectionStart;
        editorArea.setRangeText(el.dataset.emoji, pos, pos, 'end');
        state.editorText = editorArea.value;
        updateStats(); updatePreview();
        picker.classList.add('hidden');
      });
    });
  }
}

// ─── Hooks library ────────────────────────────────────────────────────────────
const HOOKS = [
  { cat: 'curiosity', text: 'Nobody talks about this, but…' },
  { cat: 'curiosity', text: 'I spent [X] years believing a lie. Here\'s what changed:' },
  { cat: 'curiosity', text: 'The thing holding most [professionals] back isn\'t what you think.' },
  { cat: 'contrarian', text: 'Hot take: [popular belief] is actually wrong.' },
  { cat: 'contrarian', text: 'Everyone says [X]. I disagree. Here\'s why:' },
  { cat: 'number', text: '[N] lessons I learned after [milestone]:' },
  { cat: 'number', text: '[N] things I wish someone told me before [event]:' },
  { cat: 'number', text: '[N] questions to ask before [decision]:' },
  { cat: 'story', text: 'Six months ago I was ready to quit. Then this happened:' },
  { cat: 'story', text: 'The day I realised I was doing it all wrong:' },
  { cat: 'question', text: 'What\'s the one skill that changed your career?' },
  { cat: 'question', text: 'Is [common advice] actually good advice?' },
  { cat: 'bold', text: 'Unpopular opinion: most [advice] is wrong.' },
  { cat: 'bold', text: '[Outcome] is possible in [timeframe]. I\'ll show you how.' },
];

const HOOK_CATS = ['all', 'curiosity', 'contrarian', 'number', 'story', 'question', 'bold'];

function setupHooksSearch() {
  const cats = $('#hook-categories');
  cats.innerHTML = HOOK_CATS.map((c) =>
    `<button class="cat-chip${c === 'all' ? ' active' : ''}" data-cat="${c}">${c}</button>`
  ).join('');
  $$('.cat-chip', cats).forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.cat-chip', cats).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeHookCat = btn.dataset.cat;
      renderHooks();
    });
  });
  $('#hook-search').addEventListener('input', renderHooks);
}

function renderHooks() {
  const q   = ($('#hook-search')?.value || '').toLowerCase();
  const cat = state.activeHookCat;
  const filtered = HOOKS.filter((h) =>
    (cat === 'all' || h.cat === cat) && (!q || h.text.toLowerCase().includes(q))
  );
  const list = $('#hooks-list');
  if (!list) return;
  list.innerHTML = filtered.map((h, i) => `
    <div class="library-item" data-hook="${i}">
      <div class="library-item-label">${h.cat}</div>
      ${h.text}
    </div>
  `).join('');
  $$('.library-item', list).forEach((el) => {
    el.addEventListener('click', () => {
      const hook = filtered[el.dataset.hook];
      editorArea.value = hook.text + '\n\n' + (editorArea.value || '');
      state.editorText = editorArea.value;
      updateStats(); updatePreview();
      switchTab('editor');
    });
  });
}

// ─── CTAs library ─────────────────────────────────────────────────────────────
const CTAS = [
  { cat: 'comments', text: 'What\'s your take? Drop it in the comments 👇' },
  { cat: 'comments', text: 'Agree or disagree? Tell me below.' },
  { cat: 'comments', text: 'What would you add? I\'d love to hear your experience.' },
  { cat: 'follow', text: 'Follow me for more on [topic]. New post every [day].' },
  { cat: 'follow', text: 'If this was useful, hit follow — I write about [topic] weekly.' },
  { cat: 'repost', text: 'Know someone who needs to read this? Repost ♻️' },
  { cat: 'dm', text: 'DM me "[keyword]" and I\'ll send you [resource].' },
  { cat: 'dm', text: 'Working on [challenge]? DM me — happy to help.' },
  { cat: 'value', text: 'Save this post for when you need a reminder.' },
  { cat: 'value', text: 'TL;DR: [one-line summary]. Now go do it.' },
];

const CTA_CATS = ['all', 'comments', 'follow', 'repost', 'dm', 'value'];

function setupCtasSearch() {
  const cats = $('#cta-categories');
  cats.innerHTML = CTA_CATS.map((c) =>
    `<button class="cat-chip${c === 'all' ? ' active' : ''}" data-cat="${c}">${c}</button>`
  ).join('');
  $$('.cat-chip', cats).forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.cat-chip', cats).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeCtaCat = btn.dataset.cat;
      renderCtas();
    });
  });
  $('#cta-search').addEventListener('input', renderCtas);
}

function renderCtas() {
  const q   = ($('#cta-search')?.value || '').toLowerCase();
  const cat = state.activeCtaCat;
  const filtered = CTAS.filter((c) =>
    (cat === 'all' || c.cat === cat) && (!q || c.text.toLowerCase().includes(q))
  );
  const list = $('#ctas-list');
  if (!list) return;
  list.innerHTML = filtered.map((c, i) => `
    <div class="library-item" data-idx="${i}">
      <div class="library-item-label">${c.cat}</div>
      ${c.text}
    </div>
  `).join('');
  $$('.library-item', list).forEach((el) => {
    el.addEventListener('click', () => {
      const cta = filtered[el.dataset.idx];
      editorArea.value += (editorArea.value ? '\n\n' : '') + cta.text;
      state.editorText = editorArea.value;
      updateStats(); updatePreview();
      switchTab('editor');
    });
  });
}

// ─── Drafts ───────────────────────────────────────────────────────────────────
function autosaveDraft() {
  // Autosave to local storage every 30s (debounced to input)
  clearTimeout(autosaveDraft._timer);
  autosaveDraft._timer = setTimeout(() => {
    if (!state.editorText.trim()) return;
    const autoDraft = { id: 'autosave', title: 'Autosave', text: state.editorText, ts: Date.now() };
    const idx = state.drafts.findIndex((d) => d.id === 'autosave');
    if (idx >= 0) state.drafts[idx] = autoDraft; else state.drafts.unshift(autoDraft);
    saveLocalData();
  }, 30_000);
}

function saveDraft(named = false) {
  if (!state.editorText.trim()) return;
  const title = named ? (prompt('Draft name:') || 'Untitled') : 'Autosave';
  const draft = { id: named ? Date.now().toString() : 'autosave', title, text: state.editorText, ts: Date.now() };
  const idx = state.drafts.findIndex((d) => d.id === draft.id);
  if (idx >= 0) state.drafts[idx] = draft; else state.drafts.unshift(draft);
  if (state.drafts.length > 100) state.drafts = state.drafts.filter((d) => d.id !== 'autosave').slice(0, 99);
  saveLocalData();
  renderDrafts();
}

function renderDrafts() {
  const list  = $('#drafts-list');
  const empty = $('#drafts-empty');
  if (!list) return;
  if (!state.drafts.length) {
    list.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  list.innerHTML = state.drafts.map((d, i) => `
    <div class="library-item" data-draft="${i}">
      <div class="library-item-label">${new Date(d.ts).toLocaleDateString()} · ${d.text.length} chars</div>
      <strong>${d.title}</strong><br/>
      <span style="font-size:12px;color:#6B7280">${d.text.slice(0, 80)}…</span>
    </div>
  `).join('');
  $$('.library-item', list).forEach((el) => {
    el.addEventListener('click', () => {
      editorArea.value = state.drafts[el.dataset.draft].text;
      state.editorText = editorArea.value;
      updateStats(); updatePreview();
      switchTab('editor');
    });
  });
}

// ─── Snippets ─────────────────────────────────────────────────────────────────
function setupSnippetForm() {
  const form   = $('#snippet-form');
  const btnNew = $('#btn-new-snippet');
  const btnCx  = $('#btn-cancel-snippet');

  btnNew.addEventListener('click', () => form.classList.toggle('hidden'));
  btnCx.addEventListener('click', () => form.classList.add('hidden'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#snippet-name').value.trim();
    const body = $('#snippet-body').value.trim();
    if (!name || !body) return;
    if (state.snippets.length >= 50) {
      alert('50 snippet limit reached. Delete one first.');
      return;
    }
    state.snippets.push({ id: Date.now().toString(), name, body });
    saveLocalData();
    renderSnippets();
    form.reset();
    form.classList.add('hidden');
  });
}

function renderSnippets() {
  const list = $('#snippets-list');
  if (!list) return;
  list.innerHTML = state.snippets.map((s, i) => `
    <div class="library-item" data-snip="${i}">
      <div class="library-item-label">${s.name}</div>
      ${s.body.slice(0, 100)}${s.body.length > 100 ? '…' : ''}
    </div>
  `).join('');
  $$('.library-item', list).forEach((el) => {
    el.addEventListener('click', () => {
      const snippet = state.snippets[el.dataset.snip];
      const pos = editorArea.selectionStart;
      editorArea.setRangeText(snippet.body, pos, pos, 'end');
      state.editorText = editorArea.value;
      updateStats(); updatePreview();
      switchTab('editor');
    });
  });
}

// ─── Publish & paywall ────────────────────────────────────────────────────────
function setupActions() {
  btnSaveDraft.addEventListener('click', () => saveDraft(true));

  // Publish → open LinkedIn-style preview overlay
  btnPublish.addEventListener('click', () => {
    if (!state.editorText.trim()) return;
    openPublishPreview();
  });

  // Preview overlay wiring
  $('#pp-close').addEventListener('click', closePublishPreview);
  $('#pp-edit').addEventListener('click', closePublishPreview);

  $('#pp-confirm').addEventListener('click', async () => {
    const btn = $('#pp-confirm');
    btn.textContent = 'Publishing…';
    btn.disabled = true;
    // Send attachments as data URLs (File objects can't cross postMessage to parent)
    const attachments = state.attachments.map((a) => ({
      type: a.type,
      name: a.name,
      dataUrl: a.dataUrl,
    }));
    window.parent.postMessage({ type: 'PUBLISH_POST', payload: { text: state.editorText, attachments } }, '*');
  });

  btnPaywallUpgrade.addEventListener('click', () => window.open(PAYMENT_URL, '_blank'));
  btnPaywallClose.addEventListener('click', () => paywallOverlay.classList.add('hidden'));
  btnUpgrade.addEventListener('click', () => window.open(PAYMENT_URL, '_blank'));

  // Listen for messages from content script
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const { type, result, text } = e.data || {};
    switch (type) {
      case 'SYNC_EDITOR':
        if (text && !state.editorText) {
          editorArea.value = text;
          state.editorText = text;
          updateStats(); updatePreview();
        }
        break;
      case 'PUBLISH_SUCCESS':
        closePublishPreview();
        resetConfirmBtn();
        showToast('Published on LinkedIn ✓');
        break;
      case 'PUBLISH_NEED_MANUAL':
        closePublishPreview();
        resetConfirmBtn();
        showToast('Text is in the composer — click Post in LinkedIn to publish');
        break;
      case 'PUBLISH_COPY_FALLBACK':
        closePublishPreview();
        resetConfirmBtn();
        showToast('Copied to clipboard — paste (Cmd+V) into LinkedIn composer');
        break;
      case 'SHOW_PAYWALL':
        paywallOverlay.classList.remove('hidden');
        break;
      case 'PROFILE_INFO':
        updatePreviewProfile(e.data);
        break;
    }
  });
}

// ─── Publish preview overlay ──────────────────────────────────────────────────

function openPublishPreview() {
  const overlay = $('#publish-preview');

  // Populate name / avatar from whatever the preview already has
  const name     = $('#preview-name')?.textContent;
  const headline = $('#preview-headline')?.textContent?.replace(/^•\s*/, '');
  const avatarSrc = $('#preview-avatar-img')?.src;

  $('#pp-name').textContent    = name     || 'Your Name';
  $('#pp-headline').textContent = headline || 'Your headline';

  const ppImg      = $('#pp-avatar-img');
  const ppFallback = $('#pp-avatar-fallback');
  if (avatarSrc && !avatarSrc.startsWith('chrome')) {
    ppImg.src = avatarSrc;
    ppImg.style.display = 'block';
    if (ppFallback) ppFallback.style.display = 'none';
  } else {
    if (ppImg) ppImg.style.display = 'none';
    if (ppFallback) ppFallback.style.display = 'block';
  }

  // Render post body — preserve line breaks, show full text
  const body = $('#pp-body');
  body.textContent = state.editorText;

  // Reset confirm button
  const btn = $('#pp-confirm');
  btn.textContent = 'Confirm & Publish on LinkedIn';
  btn.disabled = false;

  overlay.classList.remove('hidden');
}

function closePublishPreview() {
  $('#publish-preview').classList.add('hidden');
  resetConfirmBtn();
}

function resetConfirmBtn() {
  const btn = $('#pp-confirm');
  if (btn) { btn.textContent = 'Publish'; btn.disabled = false; }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── Preview profile ──────────────────────────────────────────────────────────
function updatePreviewProfile({ name, headline, avatar } = {}) {
  if (name) $('#preview-name').textContent = name;
  if (headline) $('#preview-headline').textContent = '• ' + headline;
  if (avatar) {
    const img = $('#preview-avatar-img');
    const fallback = $('#preview-avatar-fallback');
    img.src = avatar;
    img.style.display = 'block';
    if (fallback) fallback.style.display = 'none';
  }
}

// ─── Export drafts ────────────────────────────────────────────────────────────
$('#btn-export-drafts').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.drafts, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'spreadup-drafts.json'; a.click();
  URL.revokeObjectURL(url);
});

// ─── Local persistence ────────────────────────────────────────────────────────
function saveLocalData() {
  chrome.storage.local.set({ drafts: state.drafts, snippets: state.snippets });
}

async function loadLocalData() {
  const data = await chrome.storage.local.get(['drafts', 'snippets']);
  state.drafts   = data.drafts   || [];
  state.snippets = data.snippets || [];
}

// ─── Post Formatter ──────────────────────────────────────────────────────────
// Analyzes text and formats it for LinkedIn: paragraphs, bullets, bolding.
// Runs automatically on paste and on Format button click.

const BULLET_RE = /^(\s*)(->|=>|–|—|[-*•▸✦→]|\d+[.):])\s+/;
const URL_LINE  = /^https?:\/\/\S+$/i;

function formatPostText() {
  let text = editorArea.value;
  if (!text.trim()) return;

  // Step 1: Convert markdown syntax to LinkedIn Unicode
  text = text
    .replace(/\*\*(.+?)\*\*/g, (_, s) => convertText(s, 'bold'))
    .replace(/__(.+?)__/g, (_, s) => convertText(s, 'bold'))
    .replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, (_, s) => convertText(s, 'italic'))
    .replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, (_, s) => convertText(s, 'italic'))
    .replace(/^#{1,3}\s+(.+)$/gm, (_, s) => convertText(s, 'bold'))
    .replace(/~~(.+?)~~/g, (_, s) => [...s].map(c => c + '\u0336').join(''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, m => m.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''));

  // Step 2: Normalize line breaks — collapse 3+ blank lines into 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Step 3: Convert bullet markers to clean bullets
  const bullet = $('#bullet-style')?.value || '•';
  text = text.replace(/^(\s*)(->|=>|–|—|[-*])\s+/gm, `$1${bullet} `);

  // Step 4: Detect lines that should be bullets (short lines in a cluster)
  const lines = text.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line — keep it
    if (!trimmed) { output.push(''); i++; continue; }

    // URL — keep as-is
    if (URL_LINE.test(trimmed)) { output.push(trimmed); i++; continue; }

    // Already a bullet — keep it
    if (/^[•▸✦→◆✅]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      output.push(trimmed); i++; continue;
    }

    // Check if this starts a cluster of short lines (implicit list)
    let clusterEnd = i;
    while (clusterEnd < lines.length) {
      const cl = lines[clusterEnd].trim();
      if (!cl) break;
      if (cl.length > 100) break;
      if (URL_LINE.test(cl)) break;
      clusterEnd++;
    }
    const clusterLen = clusterEnd - i;

    // 3+ short lines in a row without blank lines = implicit bullet list
    if (clusterLen >= 3) {
      const avgLen = lines.slice(i, clusterEnd).reduce((s, l) => s + l.trim().length, 0) / clusterLen;
      if (avgLen < 80) {
        for (let j = i; j < clusterEnd; j++) {
          const cl = lines[j].trim();
          if (!/^[•▸✦→◆✅]\s/.test(cl) && !/^\d+[.)]\s/.test(cl)) {
            output.push(bullet + ' ' + cl);
          } else {
            output.push(cl);
          }
        }
        i = clusterEnd;
        continue;
      }
    }

    // Long paragraph — split into sentences, max 2-3 per paragraph
    if (trimmed.length > 200) {
      const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
      let para = [];
      for (const s of sentences) {
        para.push(s.trim());
        if (para.length >= 2) {
          output.push(para.join(' '));
          output.push('');
          para = [];
        }
      }
      if (para.length) output.push(para.join(' '));
      i++; continue;
    }

    // Regular line
    output.push(trimmed);
    i++;
  }

  // Step 5: Ensure blank line after first line (hook) if not already
  if (output.length > 1 && output[0].trim() && output[1]?.trim()) {
    output.splice(1, 0, '');
  }

  // Step 6: Trim trailing blank lines
  while (output.length && !output[output.length - 1].trim()) output.pop();

  editorArea.value = output.join('\n');
  state.editorText = editorArea.value;
  updateStats();
  updatePreview();
}

// Bold key phrases in the post (separate from structural formatting)
function boldKeyPhrases() {
  let text = editorArea.value;
  if (!text.trim()) return;

  const isUrl = (s) => /^https?:\/\//i.test(s.trim());

  text = text.split('\n').map((line) => {
    if (isUrl(line) || !line.trim()) return line;

    return line
      // Numbers with units: 3x, 50%, $1M, 10 years
      .replace(/\b(\$?\d[\d,]*(?:\.\d+)?(?:[kKmMbBxX%]|\s?(?:years?|hours?|days?|weeks?|months?|times?|people|users?|%)))\b/g,
        m => convertText(m, 'bold'))
      // ALL-CAPS words (2-5 chars): API, DOM, UX
      .replace(/\b([A-Z]{2,5})\b/g, m => convertText(m, 'bold'))
      // Quoted text: "important phrase"
      .replace(/"([^"]{3,40})"/g, (_, w) => '"' + convertText(w, 'bold') + '"')
      // Text after colon: Key: Value
      .replace(/:\s+([A-Z][a-z]{2,})/g, (_, w) => ': ' + convertText(w, 'bold'));
  }).join('\n');

  editorArea.value = text;
  state.editorText = text;
  updateStats();
  updatePreview();
}

let formatClickCount = 0;

// ─── Format button ───────────────────────────────────────────────────────────

$('#btn-smart-format').addEventListener('click', async () => {
  const raw = editorArea.value;
  if (!raw.trim()) return;

  const btn = $('#btn-smart-format');
  const { anthropicKey } = await chrome.storage.local.get('anthropicKey');

  formatClickCount++;

  if (anthropicKey) {
    btn.textContent = '⏳…';
    btn.disabled = true;
    try {
      const result = await bg('SMART_FORMAT', { text: raw });
      if (result?.text) {
        editorArea.value = result.text;
        state.editorText = result.text;
        updateStats();
        updatePreview();
        return;
      }
    } finally {
      btn.textContent = '✨ Format';
      btn.disabled = false;
    }
  }

  // Local formatting: alternate between structure + bold on each click
  if (formatClickCount % 2 === 1) {
    // First click: fix structure (paragraphs, bullets, spacing)
    formatPostText();
  } else {
    // Second click: bold key phrases
    boldKeyPhrases();
  }
});

// ─── Anthropic key management ─────────────────────────────────────────────────

async function setupAnthropicKey() {
  const { anthropicKey } = await chrome.storage.local.get('anthropicKey');
  const input  = $('#anthropic-key-input');
  const status = $('#anthropic-key-status');
  if (anthropicKey) {
    input.value = anthropicKey;
    status.textContent = '✓ Key saved — AI formatting enabled.';
    status.style.color = '#065F46';
  }

  $('#btn-save-anthropic-key').addEventListener('click', async () => {
    const val = input.value.trim();
    if (!val) {
      await chrome.storage.local.remove('anthropicKey');
      status.textContent = 'Key removed.';
      status.style.color = '#6B7280';
      return;
    }
    await chrome.storage.local.set({ anthropicKey: val });
    status.textContent = '✓ Key saved — AI formatting enabled.';
    status.style.color = '#065F46';
  });
}

// ─── @ Mention with LinkedIn search ──────────────────────────────────────────
// Type @ → dropdown appears → type name → LinkedIn results show in real time
// → click or Enter/ArrowDown to select → inserts @Name

let mentionActive   = false;
let mentionAtPos    = -1;
let mentionResults  = [];
let mentionSelected = -1; // -1 = manual insert row, 0+ = search results
let mentionTimer    = null;

const mentionDropdown = $('#mention-dropdown');
const mentionList     = $('#mention-list');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getMentionQuery() {
  if (mentionAtPos < 0) return '';
  return editorArea.value.slice(mentionAtPos + 1, editorArea.selectionStart);
}

function openMention() {
  mentionActive = true;
  mentionAtPos = editorArea.selectionStart - 1;
  mentionResults = [];
  mentionSelected = -1;
  positionDropdown();
  renderMentionDropdown('');
  mentionDropdown.classList.remove('hidden');
}

function closeMention() {
  mentionActive = false;
  mentionAtPos = -1;
  mentionResults = [];
  mentionSelected = -1;
  mentionDropdown.classList.add('hidden');
  clearTimeout(mentionTimer);
}

function positionDropdown() {
  const rect = editorArea.getBoundingClientRect();
  const textBefore = editorArea.value.slice(0, editorArea.selectionStart);
  const lineCount = textBefore.split('\n').length;
  const cursorY = Math.min(lineCount * 20, rect.height - 40);
  mentionDropdown.style.position = 'absolute';
  mentionDropdown.style.left = `${rect.left + 12}px`;
  mentionDropdown.style.top = `${rect.top + cursorY + 24}px`;
  mentionDropdown.style.width = `${Math.min(rect.width - 24, 320)}px`;
}

function insertMention(name) {
  const before = editorArea.value.slice(0, mentionAtPos);
  const after  = editorArea.value.slice(editorArea.selectionStart);
  // Bold the name using Unicode so it stands out as a mention
  const boldName = convertText(name, 'bold');
  const tag = `@${boldName} `;
  editorArea.value = before + tag + after;
  editorArea.setSelectionRange(before.length + tag.length, before.length + tag.length);
  state.editorText = editorArea.value;
  updateStats(); updatePreview();
  closeMention();
  editorArea.focus();
}

function renderMentionDropdown(q) {
  let html = '';

  // Search results (from LinkedIn)
  if (mentionResults.length) {
    html += mentionResults.map((r, i) => `
      <div class="mention-item${i === mentionSelected ? ' mention-selected' : ''}" data-idx="${i}">
        <div class="mention-item-avatar">${escapeHtml((r.name || '?')[0]).toUpperCase()}</div>
        <div>
          <div class="mention-item-name">${escapeHtml(r.name)}</div>
          ${r.title ? `<div class="mention-item-sub">${escapeHtml(r.title)}</div>` : ''}
        </div>
      </div>`).join('');
  }

  // Always show manual insert option at bottom when there's a query
  if (q) {
    const isManualSelected = mentionSelected === -1 && !mentionResults.length
                          || mentionSelected === mentionResults.length;
    html += `
      <div class="mention-item${isManualSelected ? ' mention-selected' : ''}" data-idx="-1">
        <div class="mention-item-avatar" style="background:#1a1a2e;color:#F59E0B;font-weight:700;font-size:13px">@</div>
        <div>
          <div class="mention-item-name">@${escapeHtml(q)}</div>
          <div class="mention-item-sub">Enter to insert as text</div>
        </div>
      </div>`;
  }

  if (!html) {
    html = '<div class="mention-tip">Type a name…</div>';
  }

  mentionList.innerHTML = html;

  // Bind clicks
  $$('.mention-item[data-idx]', mentionList).forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      if (idx >= 0 && mentionResults[idx]) {
        insertMention(mentionResults[idx].name);
      } else {
        insertMention(q);
      }
    });
  });
}

function triggerSearch(query) {
  clearTimeout(mentionTimer);
  if (!query || query.length < 1) return;

  // Debounce 300ms — content script types into LinkedIn's search bar and scrapes results
  mentionTimer = setTimeout(() => {
    window.parent.postMessage({ type: 'SEARCH_LINKEDIN', payload: { query } }, '*');
  }, 300);
}

// Track @ typing in editor
editorArea.addEventListener('input', () => {
  if (!mentionActive) return;
  const q = getMentionQuery();
  if (editorArea.selectionStart <= mentionAtPos || q.includes(' ') || q.includes('\n')) {
    closeMention(); return;
  }
  // Reset selection when query changes
  mentionSelected = mentionResults.length ? 0 : -1;
  renderMentionDropdown(q);
  triggerSearch(q);
});

editorArea.addEventListener('keydown', (e) => {
  // Open mention on @
  if (e.key === '@' && !mentionActive) {
    setTimeout(() => openMention(), 0);
    return;
  }
  if (!mentionActive) return;

  const totalItems = mentionResults.length + 1; // results + manual insert

  if (e.key === 'Escape') {
    e.preventDefault(); closeMention(); return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    mentionSelected = Math.min(mentionSelected + 1, totalItems - 1);
    renderMentionDropdown(getMentionQuery());
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    mentionSelected = Math.max(mentionSelected - 1, 0);
    renderMentionDropdown(getMentionQuery());
    return;
  }

  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    if (mentionSelected >= 0 && mentionSelected < mentionResults.length) {
      insertMention(mentionResults[mentionSelected].name);
    } else {
      const q = getMentionQuery().trim();
      if (q) insertMention(q);
      else closeMention();
    }
    return;
  }
});

// Receive LinkedIn search results from content script
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  if (e.data?.type === 'LINKEDIN_SEARCH_RESULTS' && mentionActive) {
    mentionResults = (e.data.results || []).slice(0, 7);
    if (mentionResults.length) mentionSelected = 0;
    renderMentionDropdown(getMentionQuery());
  }
});

// ─── File / image attachments ────────────────────────────────────────────────

const fileInputImage = $('#file-input-image');
const fileInputDoc   = $('#file-input-doc');
const attachStrip    = $('#attachments-strip');

$('#btn-attach-image').addEventListener('click', () => fileInputImage.click());
$('#btn-attach-doc').addEventListener('click', () => fileInputDoc.click());

fileInputImage.addEventListener('change', () => handleFiles(fileInputImage.files, 'image'));
fileInputDoc.addEventListener('change', () => handleFiles(fileInputDoc.files, 'doc'));

function handleFiles(fileList, type) {
  if (!fileList?.length) return;

  // LinkedIn limits: up to 9 images, or 1 document
  if (type === 'doc') {
    // Replace any existing doc; images stay
    state.attachments = state.attachments.filter((a) => a.type !== 'doc');
  }

  const maxImages = 9;
  const currentImages = state.attachments.filter((a) => a.type === 'image').length;

  for (const file of fileList) {
    if (type === 'image' && currentImages + state.attachments.filter((a) => a.type === 'image').length >= maxImages) break;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File too large (max 10 MB)');
      continue;
    }

    const reader = new FileReader();
    reader.onload = () => {
      state.attachments.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type,
        name: file.name,
        dataUrl: reader.result,
        file,
      });
      renderAttachments();
      updatePreview();
    };
    reader.readAsDataURL(file);
  }

  // Reset so the same file can be re-selected
  fileInputImage.value = '';
  fileInputDoc.value = '';
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
  updatePreview();
}

function renderAttachments() {
  if (!state.attachments.length) {
    attachStrip.classList.add('hidden');
    attachStrip.innerHTML = '';
    return;
  }
  attachStrip.classList.remove('hidden');
  attachStrip.innerHTML = state.attachments.map((a) => {
    if (a.type === 'image') {
      return `<div class="attach-thumb" data-id="${a.id}">
        <img src="${a.dataUrl}" alt="${a.name}" />
        <button class="attach-remove" data-id="${a.id}">✕</button>
      </div>`;
    }
    return `<div class="attach-thumb" data-id="${a.id}">
      <div class="attach-thumb-doc">PDF</div>
      <button class="attach-remove" data-id="${a.id}">✕</button>
    </div>`;
  }).join('');

  $$('.attach-remove', attachStrip).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeAttachment(btn.dataset.id);
    });
  });
}

// ─── URL link preview ──────────────────────────────────────────────────────��─

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
let lastPreviewedUrl = '';
let linkPreviewCache = {}; // url → { title, description, image, domain }

function detectUrls(text) {
  return (text.match(URL_RE) || []);
}

function renderLinkPreview(container, meta) {
  if (!meta) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = `
    ${meta.image ? `<img class="link-card-image" src="${meta.image}" alt="" />` : ''}
    <div class="link-card-body">
      <div class="link-card-title">${meta.title || meta.url}</div>
      ${meta.description ? `<div class="link-card-desc">${meta.description}</div>` : ''}
      <div class="link-card-domain">${meta.domain || ''}</div>
    </div>`;
}

function renderPreviewAttachments(container) {
  if (!state.attachments.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = state.attachments.map((a) => {
    if (a.type === 'image') {
      return `<img src="${a.dataUrl}" alt="${a.name}" />`;
    }
    return `<div class="preview-attach-doc">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      ${a.name}
    </div>`;
  }).join('');
}

// Override updatePreview to include attachments + URL cards
const _origUpdatePreview = updatePreview;
updatePreview = function () {
  const text = state.editorText;
  const FOLD = 210;
  if (text.length > FOLD) {
    previewBody.textContent = text.slice(0, FOLD);
    seeMoreHint.classList.remove('hidden');
  } else {
    previewBody.textContent = text || 'Your post preview will appear here as you type…';
    seeMoreHint.classList.add('hidden');
  }

  // Attachments in preview
  const previewAttach = $('#preview-attachments');
  if (previewAttach) renderPreviewAttachments(previewAttach);

  // URL link card in preview
  const urls = detectUrls(text);
  const previewLinkCard = $('#preview-link-card');
  if (urls.length && urls[0] !== lastPreviewedUrl) {
    lastPreviewedUrl = urls[0];
    if (linkPreviewCache[urls[0]]) {
      renderLinkPreview(previewLinkCard, linkPreviewCache[urls[0]]);
    } else {
      // Fetch OG metadata via background script
      bg('FETCH_OG', { url: urls[0] }).then((meta) => {
        if (meta && !meta.error) {
          linkPreviewCache[urls[0]] = meta;
          renderLinkPreview(previewLinkCard, meta);
        }
      });
    }
  } else if (!urls.length) {
    lastPreviewedUrl = '';
    if (previewLinkCard) renderLinkPreview(previewLinkCard, null);
  }
};

// Update openPublishPreview to include attachments + URL card
const _origOpenPublishPreview = openPublishPreview;
openPublishPreview = function () {
  _origOpenPublishPreview();

  // Copy attachments into publish preview
  const ppAttach = $('#pp-attachments');
  if (ppAttach) renderPreviewAttachments(ppAttach);

  // Copy URL card into publish preview
  const urls = detectUrls(state.editorText);
  const ppLinkCard = $('#pp-link-card');
  if (urls.length && linkPreviewCache[urls[0]]) {
    renderLinkPreview(ppLinkCard, linkPreviewCache[urls[0]]);
  } else if (ppLinkCard) {
    renderLinkPreview(ppLinkCard, null);
  }
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
