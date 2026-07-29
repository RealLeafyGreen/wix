// Browser popup notifications, PLUS a persistent in-app history so old
// notifications don't just vanish or keep re-surfacing — you can see them
// in one place and clear them out on demand.
import { db } from "./firebase-config.js";
import { state } from "./state.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, limit, deleteDoc, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch (_) {}
  }
}

// Fires the OS-level popup AND logs it to the persistent history.
export function notify(title, body) {
  logNotification(title, body);
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: "assets/favicon.png" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {
    // Some browsers throw if called from a background/service-worker-less
    // context — safe to ignore, it's a nice-to-have, not core functionality.
  }
}

function logNotification(title, body) {
  if (!state.user) return;
  addDoc(collection(db, "users", state.user.uid, "notifications"), {
    title, body, clientTime: Date.now(), createdAt: serverTimestamp()
  }).catch(err => console.error("Failed to log notification:", err));
}

// ---------------- notification center UI ----------------
const btnBell = document.getElementById("btn-notifications");
const panel = document.getElementById("notif-panel");
const listEl = document.getElementById("notif-list");
const dot = document.getElementById("notif-dot");
let unsubNotifs = null;

export function startNotificationCenter() {
  if (!state.user) return;
  const q = query(collection(db, "users", state.user.uid, "notifications"), orderBy("clientTime", "desc"), limit(50));
  unsubNotifs = onSnapshot(q, (snap) => {
    if (dot) dot.hidden = snap.empty;
    if (!listEl) return;
    if (snap.empty) {
      listEl.innerHTML = `<p class="panel-sub" style="padding:12px 4px;">No notifications.</p>`;
      return;
    }
    listEl.innerHTML = snap.docs.map((d) => {
      const n = d.data();
      const time = n.clientTime ? new Date(n.clientTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="notif-row">
        <div class="notif-title">${escapeHtmlLocal(n.title || "")}</div>
        <div class="notif-body">${escapeHtmlLocal(n.body || "")}</div>
        <div class="notif-time">${time}</div>
      </div>`;
    }).join("");
  }, (err) => console.error("Notification center listener failed:", err));
}

export function stopNotificationCenter() {
  if (unsubNotifs) { unsubNotifs(); unsubNotifs = null; }
}

function escapeHtmlLocal(str = "") {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

btnBell?.addEventListener("click", (e) => {
  e.stopPropagation();
  panel.hidden = !panel.hidden;
});
document.addEventListener("click", (e) => {
  if (panel && !panel.hidden && !panel.contains(e.target) && e.target.id !== "btn-notifications") {
    panel.hidden = true;
  }
});

document.getElementById("btn-notif-clear-all")?.addEventListener("click", async () => {
  if (!state.user) return;
  try {
    const snap = await getDocs(collection(db, "users", state.user.uid, "notifications"));
    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  } catch (err) {
    console.error("Failed to clear notifications:", err);
  }
});
