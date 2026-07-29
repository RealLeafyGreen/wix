// ============================================================
// PASTE YOUR OWN FIREBASE PROJECT CONFIG BELOW.
// Get this from: Firebase Console → Project settings → General
// → "Your apps" → Web app → SDK setup and configuration.
//
// This is safe to commit/publish on GitHub Pages — these are
// public client identifiers, not secrets. Lock the project down
// with Firestore Security Rules (see README) instead.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCDftJk-PrtrBJl2w1E8St_Ln9-pbU8Hk8",
  authDomain: "vox-chat-e0987.firebaseapp.com",
  projectId: "vox-chat-e0987",
  storageBucket: "vox-chat-e0987.firebasestorage.app",
  messagingSenderId: "846881864369",
  appId: "1:846881864369:web:39da9987d0a7227d898090"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// ignoreUndefinedProperties: WebRTC call data sometimes includes a field
// that's `undefined` (varies by browser) — without this, Firestore rejects
// the ENTIRE write with "invalid-argument" instead of just skipping that field.
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export const storage = getStorage(app);
