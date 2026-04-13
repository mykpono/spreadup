# SpreadUp — Setup Guide

Everything you need to go from repo clone → Chrome extension running on LinkedIn.

---

## 1. Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**.
2. Name it `spreadup` (or anything you like).
3. Disable Google Analytics (not needed) → **Create project**.

### 1a. Enable Authentication

- Sidebar → **Authentication** → **Get started**
- **Sign-in method** tab → **Google** → Enable → add your support email → **Save**

### 1b. Create Firestore database

- Sidebar → **Firestore Database** → **Create database**
- Choose **Start in production mode** → pick your nearest region → **Done**

Paste these rules under **Rules** tab:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

### 1c. Copy your config

- Sidebar → **Project settings** (gear icon) → **General** tab → scroll to **Your apps**
- Click **</>** (Web) → register app name `spreadup-extension` → **Register app**
- Copy the `firebaseConfig` object values

Open `firebase/config.js` and replace every placeholder:

```js
export const firebaseConfig = {
  apiKey:            'AIza...',          // ← from Firebase console
  authDomain:        'your-project.firebaseapp.com',
  projectId:         'your-project',
  storageBucket:     'your-project.appspot.com',
  messagingSenderId: '123456789',
  appId:             '1:123456789:web:abc...',
};

export const FREE_POST_LIMIT = 50;
export const PAYMENT_URL = 'https://your-gumroad-or-lemonsqueezy-link';
```

---

## 2. Google OAuth client ID (for Chrome Identity API)

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) — this is automatically the same project as Firebase.
2. Click **Create credentials** → **OAuth client ID**
3. Application type: **Chrome App**
4. In Chrome Web Store listing, you'll get an **Extension ID** — paste it into the **Application ID** field.
   - For local testing, find your temporary extension ID after loading unpacked (step 4 below).
5. Copy the generated **Client ID** (looks like `123456789-abc.apps.googleusercontent.com`).

Open `manifest.json` and replace:
```json
"oauth2": {
  "client_id": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
```

---

## 3. Payment link (Gumroad — free to set up)

1. Create a free account at [gumroad.com](https://gumroad.com).
2. **New product** → **Digital product** → name it "SpreadUp Lifetime" → price **$20** → publish.
3. Copy the product URL (e.g. `https://yourname.gumroad.com/l/spreadup`).
4. Paste it into `firebase/config.js` as `PAYMENT_URL`.

> **Note:** Gumroad does not verify purchases on your backend automatically.  
> For MVP, you can manually flip `plan: 'paid'` in Firestore for each user after checking Gumroad sales.  
> Long-term: use Gumroad webhooks → a Cloud Function → update Firestore.

---

## 4. Load the extension in Chrome

1. Open Chrome → navigate to `chrome://extensions`
2. Toggle **Developer mode** on (top-right switch)
3. Click **Load unpacked** → select the `spreadup/` folder
4. You'll see SpreadUp appear with the yellow star icon
5. Copy your **Extension ID** from this page (you'll need it for the OAuth credential in step 2)

---

## 5. First run

1. Go to [linkedin.com](https://linkedin.com) and open the post composer.
2. Click the yellow ⭐ star button that appears in the toolbar (or in the fixed corner if the toolbar isn't detected).
3. The panel slides in from the right. Click **Continue with Google**.
4. Chrome will prompt you to select your Google account — approve it.
5. You're in. Start writing.

---

## File structure

```
spreadup/
├── manifest.json          — Extension manifest (MV3)
├── firebase/
│   └── config.js          — ← PUT YOUR KEYS HERE
├── src/
│   ├── background.js      — Service worker: auth, Firestore, post counter
│   └── content.js         — LinkedIn injector: panel iframe + editor sync
├── panel/
│   ├── panel.html         — UI shell
│   ├── panel.css          — Styles (yellow brand, AuthoredUp-inspired layout)
│   └── panel.js           — All panel logic: editor, hooks, CTAs, drafts, snippets
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Common issues

| Problem | Fix |
|---|---|
| "Sign in" does nothing | Check OAuth client ID matches your Extension ID |
| Post counter not updating | Firestore rules — make sure `allow write` is set correctly |
| Star button doesn't appear | LinkedIn updated their DOM — edit `SELECTORS` in `src/content.js` |
| Panel doesn't open on click | Check the Console on linkedin.com for errors; try reloading the extension |
| Unicode bold/italic not pasting | LinkedIn's QL editor sometimes strips special chars — paste works, direct insert may not |

---

## Going to production (Chrome Web Store)

1. Zip the entire `spreadup/` folder.
2. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard) → Upload new item.
3. Fill in store listing: screenshots, description, privacy policy (required if you collect data).
4. Submit for review — typically 1–3 business days.
5. After approval, your permanent Extension ID is stable — update your OAuth client in Google Cloud Console.
