// SpreadUp — Background Service Worker
// Handles: Google Auth, Firebase session, license status, update checks

import { firebaseConfig, FREE_POST_LIMIT } from '../firebase/config.js';

// ─── Firebase REST helpers (no SDK needed in service worker) ──────────────────

const FB_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

async function firestoreGet(path, idToken) {
  const res = await fetch(`${FB_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function firestoreSet(path, fields, idToken) {
  const body = { fields };
  const res = await fetch(`${FB_BASE}/${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Google → Firebase sign-in ───────────────────────────────────────────────

async function exchangeGoogleTokenForFirebase(googleToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${firebaseConfig.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${googleToken}&providerId=google.com`,
      requestUri: chrome.identity.getRedirectURL(),
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  });
  if (!res.ok) throw new Error('Firebase sign-in failed');
  return res.json(); // { idToken, localId (uid), email, displayName, expiresIn }
}

// ─── Auth flow ────────────────────────────────────────────────────────────────

async function signIn() {
  // 1. Get Google OAuth token via Chrome Identity API (no popup, no redirect)
  const googleToken = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });

  // 2. Exchange for Firebase ID token
  const firebaseUser = await exchangeGoogleTokenForFirebase(googleToken);
  const { idToken, localId: uid, email, displayName, expiresIn } = firebaseUser;

  // 3. Persist session locally
  const expiresAt = Date.now() + parseInt(expiresIn) * 1000;
  await chrome.storage.local.set({ session: { idToken, uid, email, displayName, expiresAt } });

  // 4. Ensure user doc exists in Firestore
  await ensureUserDoc(uid, email, displayName, idToken);

  return { uid, email, displayName };
}

async function signOut() {
  const { session } = await chrome.storage.local.get('session');
  if (session?.idToken) {
    // Revoke Google token
    chrome.identity.removeCachedAuthToken({ token: session.idToken }, () => {});
  }
  await chrome.storage.local.remove('session');
}

async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return null;
  if (Date.now() > session.expiresAt - 60_000) {
    // Token near expiry — refresh silently
    try {
      const googleToken = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(token);
        });
      });
      const firebaseUser = await exchangeGoogleTokenForFirebase(googleToken);
      const updated = {
        ...session,
        idToken: firebaseUser.idToken,
        expiresAt: Date.now() + parseInt(firebaseUser.expiresIn) * 1000,
      };
      await chrome.storage.local.set({ session: updated });
      return updated;
    } catch {
      await chrome.storage.local.remove('session');
      return null;
    }
  }
  return session;
}

// ─── User document ────────────────────────────────────────────────────────────

async function ensureUserDoc(uid, email, displayName, idToken) {
  const existing = await firestoreGet(`users/${uid}`, idToken);
  if (existing?.fields) return; // already exists

  await firestoreSet(`users/${uid}`, {
    email: { stringValue: email },
    displayName: { stringValue: displayName || '' },
    plan: { stringValue: 'free' },
    postCount: { integerValue: '0' },
    createdAt: { timestampValue: new Date().toISOString() },
  }, idToken);
}

// ─── Post counter ─────────────────────────────────────────────────────────────

async function getUserData() {
  const session = await getSession();
  if (!session) return null;

  const doc = await firestoreGet(`users/${session.uid}`, session.idToken);
  if (!doc?.fields) return null;

  const f = doc.fields;
  return {
    uid: session.uid,
    email: session.email,
    displayName: session.displayName,
    plan: f.plan?.stringValue || 'free',
    postCount: parseInt(f.postCount?.integerValue || '0'),
  };
}

async function incrementPostCount() {
  const session = await getSession();
  if (!session) return { allowed: false, reason: 'not_signed_in' };

  const data = await getUserData();
  if (!data) return { allowed: false, reason: 'no_user_doc' };

  if (data.plan === 'paid') {
    // Paid — always allowed, just track
    const newCount = data.postCount + 1;
    await firestoreSet(`users/${session.uid}`, {
      postCount: { integerValue: String(newCount) },
    }, session.idToken);
    return { allowed: true, postCount: newCount, plan: 'paid' };
  }

  // Free plan — check limit
  if (data.postCount >= FREE_POST_LIMIT) {
    return { allowed: false, reason: 'limit_reached', postCount: data.postCount, plan: 'free' };
  }

  const newCount = data.postCount + 1;
  await firestoreSet(`users/${session.uid}`, {
    postCount: { integerValue: String(newCount) },
  }, session.idToken);

  return {
    allowed: true,
    postCount: newCount,
    postsRemaining: FREE_POST_LIMIT - newCount,
    plan: 'free',
  };
}

// ─── AI Smart Format ──────────────────────────────────────────────────────────

async function smartFormatWithAI(text) {
  const { anthropicKey } = await chrome.storage.local.get('anthropicKey');
  if (!anthropicKey) return { error: 'no_key' };

  const systemPrompt = `You are an expert LinkedIn ghostwriter. Reformat the given text into a high-performing LinkedIn post.

FORMATTING RULES:
- First line = the hook. Make it short (≤12 words), punchy, and impossible to scroll past. Bold key words using Unicode bold (e.g. 𝗯𝗼𝗹𝗱).
- Leave a blank line after the hook.
- Body: short paragraphs (1–3 lines). Never more than 3 lines in a row without a blank line.
- Convert any list-like content into bullet points using •
- Bold (Unicode 𝗯𝗼𝗹𝗱) the most important 2–4 key phrases in the body.
- End with a single clear call-to-action or open question on its own line.
- Keep URLs exactly as-is on their own line at the end.
- Preserve the author's voice and all factual claims.
- Do NOT add hashtags, emojis, or filler phrases ("Great post!", "In conclusion", etc.).
- Return ONLY the reformatted post text — no commentary, no preamble.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error?.message || `HTTP ${res.status}` };
  }

  const data = await res.json();
  return { text: data.content[0]?.text || '' };
}

// ─── Open Graph metadata fetch ───────────────────────────────────────────────

async function fetchOgMeta(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpreadUp/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const html = await res.text();
    const get = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:${prop}["']`, 'i'));
      return m?.[1] || '';
    };

    const title = get('title')
      || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim();
    const description = get('description')
      || (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || '');
    const image = get('image');
    const domain = new URL(url).hostname.replace(/^www\./, '');

    return { url, title, description, image, domain };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Forward messages to the active LinkedIn tab's content script ────────────

async function forwardToContentScript(msg) {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  const tab = tabs[0];
  if (!tab) return { error: 'No LinkedIn tab found' };
  // Forward with a source marker so content script knows it came via background
  chrome.tabs.sendMessage(tab.id, { ...msg, _fromBackground: true });
  return { forwarded: true };
}

// ─── Message router (panel / content script ↔ background) ───────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'SIGN_IN':       return signIn();
      case 'SIGN_OUT':      return signOut();
      case 'GET_SESSION':   return getSession();
      case 'GET_USER_DATA': return getUserData();
      case 'INCREMENT_POST_COUNT': return incrementPostCount();
      case 'SMART_FORMAT':  return smartFormatWithAI(msg.payload?.text || '');
      case 'FETCH_OG':         return fetchOgMeta(msg.payload?.url || '');

      // Panel → Background → Content Script (forwarded)
      case 'SEARCH_LINKEDIN':
      case 'PUBLISH_POST':
      case 'GET_PROFILE':
      case 'CLOSE_PANEL':
        return forwardToContentScript(msg);

      // Content Script → Background → Panel (broadcast to all extension pages)
      // These are no-ops here; the panel receives them via chrome.runtime.onMessage
      case 'LINKEDIN_SEARCH_RESULTS':
      case 'PUBLISH_SUCCESS':
      case 'PUBLISH_NEED_MANUAL':
      case 'PUBLISH_COPY_FALLBACK':
      case 'PROFILE_INFO':
      case 'EDITOR_TEXT':
        return { ok: true };

      default: return { error: 'Unknown message type' };
    }
  };

  handle().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
});

console.log('[SpreadUp] Background service worker started.');
