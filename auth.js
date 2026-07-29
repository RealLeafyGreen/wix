import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- tab switching ----
document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`form-${tab.dataset.tab}`).classList.add("active");
  });
});

// ---- login ----
document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errEl.textContent = friendlyAuthError(err);
  }
});

// ---- signup ----
document.getElementById("form-signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const errEl = document.getElementById("signup-error");
  errEl.textContent = "";
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: name });
    try {
      await setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid,
        displayName: name,
        displayNameLower: name.toLowerCase(),
        email: email.toLowerCase(),
        createdAt: serverTimestamp(),
        status: "online",
        role: "member",
        tag: "",
        banned: false
      });
    } catch (profileErr) {
      // The account itself was created fine — this is just the Firestore
      // profile doc, which app.js will self-heal on next load if it's missing.
      console.error("Profile doc write failed (check Firestore rules are published):", profileErr);
    }
  } catch (err) {
    errEl.textContent = friendlyAuthError(err);
  }
});

// ---- logout ----
document.getElementById("btn-logout").addEventListener("click", () => signOut(auth));
document.getElementById("btn-banned-logout").addEventListener("click", () => signOut(auth));

function friendlyAuthError(err) {
  const code = err.code || "";
  if (code.includes("email-already-in-use")) return "That email already has an account.";
  if (code.includes("invalid-credential") || code.includes("wrong-password")) return "Incorrect email or password.";
  if (code.includes("user-not-found")) return "No account with that email.";
  if (code.includes("weak-password")) return "Password needs at least 6 characters.";
  if (code.includes("invalid-email")) return "That email doesn't look right.";
  return "Something went wrong. Try again.";
}
