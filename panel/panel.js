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
    chrome.runtime.sendMessage({ type, payload }, resolve);
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
    window.parent.postMessage({ type: 'PUBLISH_POST', payload: { text: state.editorText } }, '*');
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

// ─── Smart Format ─────────────────────────────────────────────────────────────
// Pure heuristic — no AI API needed.
// Pipeline: parse → detect structure → reformat → bold key phrases → assemble

function smartFormat() {
  const raw = editorArea.value.trim();
  if (!raw) return;

  const bullet     = $('#bullet-style').value || '•';
  const BULLET_RE  = /^(->|=>|–|—|[-*•]|\d+[.):])\s*/;
  const isBullet   = (s) => /^[•▸✦◆✅]/.test(s);
  const isURL      = (s) => /^https?:\/\//i.test(s.trim());

  // ── 1. Split raw text into sentences, preserving blank lines as separators ──
  const rawLines = raw.split('\n');

  // ── 2. Group into logical blocks (runs of non-blank lines) ──────────────────
  const blocks = []; // each block = array of trimmed non-empty strings
  let current  = [];
  for (const l of rawLines) {
    const t = l.trim();
    if (!t) {
      if (current.length) { blocks.push(current); current = []; }
    } else {
      current.push(t);
    }
  }
  if (current.length) blocks.push(current);

  if (!blocks.length) return;

  // ── 3. Classify each block ───────────────────────────────────────────────────
  // Returns 'hook' | 'list' | 'url' | 'cta' | 'body'
  function classifyBlock(lines, idx) {
    const joined = lines.join(' ');
    if (idx === 0 && joined.length <= 120 && lines.length <= 2) return 'hook';
    if (lines.every((l) => BULLET_RE.test(l)))                  return 'list';
    if (lines.length >= 3 && lines.every((l) => !BULLET_RE.test(l) && l.length < 100)) {
      // Cluster of short lines — treat as implicit list
      const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
      if (avgLen < 80) return 'list';
    }
    if (lines.length === 1 && isURL(lines[0]))                   return 'url';
    if (idx === blocks.length - 1 && /\?$/.test(joined.trim()))  return 'cta';
    return 'body';
  }

  // ── 4. Bold heuristics ───────────────────────────────────────────────────────
  function applyBold(text) {
    if (isURL(text)) return text;
    return text
      // Numbers + unit: "3x", "50%", "$1M", "10 years"
      .replace(/\b(\$?\d[\d,]*(?:\.\d+)?(?:[kKmMbBxX%]|\s?(?:years?|hours?|days?|weeks?|months?|times?|people|users?|%)))\b/g,
        (m) => convertText(m, 'bold'))
      // ALL-CAPS acronyms (2–5 letters)
      .replace(/\b([A-Z]{2,5})\b/g, (m) => convertText(m, 'bold'))
      // Text inside "quotes" or 'quotes'
      .replace(/"([^"]{3,40})"/g, (_, w) => '"' + convertText(w, 'bold') + '"')
      // First meaningful word after a colon
      .replace(/:\s+([A-Z][a-z]{2,})/g, (_, w) => ': ' + convertText(w, 'bold'));
  }

  // ── 5. Split long body paragraph into shorter ones (≤3 sentences each) ──────
  function splitBodyBlock(lines) {
    const joined  = lines.join(' ');
    // Simple sentence split on . ! ? followed by space + capital
    const sentences = joined.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [joined];
    const chunks = [];
    let chunk = [];
    for (const s of sentences) {
      chunk.push(s.trim());
      if (chunk.length === 3) { chunks.push(chunk.join(' ')); chunk = []; }
    }
    if (chunk.length) chunks.push(chunk.join(' '));
    return chunks;
  }

  // ── 6. Assemble formatted output ─────────────────────────────────────────────
  const sections = [];

  blocks.forEach((lines, idx) => {
    const type = classifyBlock(lines, idx);

    if (type === 'hook') {
      // Hook: bold the whole line if short, else just key phrases
      const text = lines.join(' ');
      sections.push([text.length <= 60 ? convertText(text, 'bold') : applyBold(text)]);
      return;
    }

    if (type === 'list') {
      const items = lines.map((l) => {
        const content = l.replace(BULLET_RE, '').trim();
        // Bold first phrase before dash/colon in each item
        const bolded  = content.replace(/^([^—:–,]{4,40})([—:–,])/, (_, phrase, sep) =>
          convertText(phrase, 'bold') + sep
        );
        return bullet + ' ' + bolded;
      });
      sections.push(items);
      return;
    }

    if (type === 'url') {
      sections.push(lines); // URLs untouched
      return;
    }

    if (type === 'cta') {
      // CTA: keep as-is, optionally bold the action verb
      const text = lines.join(' ');
      sections.push([text.replace(/^(\w+)/, (m) => convertText(m, 'bold'))]);
      return;
    }

    // type === 'body': split long blocks, bold key phrases
    const chunks = splitBodyBlock(lines);
    sections.push(chunks.map(applyBold));
  });

  // Join sections with blank lines; bullets within a list stay tight
  const output = [];
  sections.forEach((section, i) => {
    section.forEach((line, j) => {
      output.push(line);
      // Blank line between bullets only when next section starts
      const nextLine = section[j + 1];
      if (!nextLine && i < sections.length - 1) output.push('');
    });
  });

  editorArea.value = output.join('\n');
  state.editorText = editorArea.value;
  updateStats();
  updatePreview();
}

// ─── Format button: AI if key set, heuristic fallback ─────────────────────────

$('#btn-smart-format').addEventListener('click', async () => {
  const raw = editorArea.value;
  if (!raw.trim()) return;

  const { anthropicKey } = await chrome.storage.local.get('anthropicKey');
  const btn = $('#btn-smart-format');

  if (!anthropicKey) {
    // No key — run local heuristic and nudge user to settings
    smartFormat();
    const keyStatus = $('#anthropic-key-status');
    switchTab('settings');
    if (keyStatus) {
      keyStatus.textContent = '← Add your Anthropic API key here to enable AI formatting.';
      keyStatus.style.color = '#D97706';
    }
    return;
  }

  btn.textContent = '⏳…';
  btn.disabled = true;

  try {
    const result = await bg('SMART_FORMAT', { text: raw });
    if (result?.text) {
      editorArea.value = result.text;
      state.editorText = result.text;
      updateStats();
      updatePreview();
    } else {
      // API error — fall back to heuristic
      smartFormat();
      console.warn('[SpreadUp] AI format error:', result?.error);
    }
  } finally {
    btn.textContent = '✨ Format';
    btn.disabled = false;
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

// ─── @ Mention system ────────────────────────────────────────────────────────

let mentionStartPos = -1; // caret position where '@' was typed

const mentionDropdown  = $('#mention-dropdown');
const mentionQuery     = $('#mention-query');
const mentionList      = $('#mention-list');
const mentionCloseBtn  = $('#mention-close');

// Seed a small local contact list (user can add to this over time)
// In future this could query LinkedIn's typeahead API
const LOCAL_CONTACTS = [];

function openMention(atPos) {
  mentionStartPos = atPos;
  mentionQuery.value = '';
  renderMentionResults('');
  mentionDropdown.classList.remove('hidden');
  mentionQuery.focus();
}

function closeMention() {
  mentionDropdown.classList.add('hidden');
  mentionStartPos = -1;
  editorArea.focus();
}

function insertMention(name) {
  if (mentionStartPos < 0) return;
  const before = editorArea.value.slice(0, mentionStartPos); // includes the '@'
  const after  = editorArea.value.slice(editorArea.selectionStart);
  const tag    = `@${name} `;
  editorArea.value = before + tag + after;
  // Move caret after inserted mention
  const newPos = mentionStartPos + tag.length;
  editorArea.setSelectionRange(newPos, newPos);
  state.editorText = editorArea.value;
  updateStats(); updatePreview();
  closeMention();
}

function renderMentionResults(query) {
  const q = query.toLowerCase().trim();
  const matches = q
    ? LOCAL_CONTACTS.filter((c) =>
        c.name.toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q)
      )
    : LOCAL_CONTACTS.slice(0, 8);

  if (!matches.length) {
    mentionList.innerHTML = q
      ? `<div class="mention-item" id="mention-insert-new">
           <div class="mention-item-avatar">${q[0]?.toUpperCase() || '@'}</div>
           <div><div class="mention-item-name">@${query}</div>
           <div class="mention-item-sub">Press Enter to insert</div></div>
         </div>`
      : `<div class="mention-tip">Type a name and press <kbd>Enter</kbd> to insert the @mention.</div>`;

    if (q) {
      $('#mention-insert-new')?.addEventListener('click', () => insertMention(query));
    }
    return;
  }

  mentionList.innerHTML = matches.map((c, idx) => `
    <div class="mention-item" data-idx="${idx}">
      <div class="mention-item-avatar">${c.name[0].toUpperCase()}</div>
      <div>
        <div class="mention-item-name">${c.name}</div>
        ${c.title ? `<div class="mention-item-sub">${c.title}</div>` : ''}
      </div>
    </div>
  `).join('');

  $$('.mention-item', mentionList).forEach((el) => {
    el.addEventListener('click', () => insertMention(matches[el.dataset.idx].name));
  });
}

// Detect '@' typed in editor
editorArea.addEventListener('keydown', (e) => {
  if (e.key === '@') {
    // Let the char land first, then open
    setTimeout(() => openMention(editorArea.selectionStart - 1), 0);
  }
  if (e.key === 'Escape' && !mentionDropdown.classList.contains('hidden')) {
    closeMention();
  }
});

// Typing in mention search input
mentionQuery.addEventListener('input', () => renderMentionResults(mentionQuery.value));

mentionQuery.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = mentionQuery.value.trim();
    if (q) insertMention(q);
  }
  if (e.key === 'Escape') closeMention();
});

mentionCloseBtn.addEventListener('click', closeMention);

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
