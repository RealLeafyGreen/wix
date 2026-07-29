import { auth, db } from "./firebase-config.js";
import { state } from "./state.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, updateDoc, collection, query, where, or,
  onSnapshot, serverTimestamp, getDocs, addDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { openChat } from "./chat.js";
import { listenForIncomingCalls } from "./call.js";
import { requestNotificationPermission, notify, startNotificationCenter, stopNotificationCenter } from "./notifications.js";
import { showToast } from "./toast.js";

const screenAuth = document.getElementById("screen-auth");
const screenApp = document.getElementById("screen-app");

export function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join("");
}

// Renders role + custom tag as small badges. Used in the sidebar,
// chat header, and mod menu so they all stay visually consistent.
export function renderBadge(profile) {
  if (!profile) return "";
  let html = "";
  if (profile.role === "owner") html += `<span class="badge badge-owner">owner</span>`;
  else if (profile.role === "co-owner") html += `<span class="badge badge-coowner">co-owner</span>`;
  else if (profile.role === "admin") html += `<span class="badge badge-admin">admin</span>`;
  if (profile.tag) html += `<span class="badge badge-tag">${escapeHtml(profile.tag)}</span>`;
  return html;
}

// ---- auth state — this MUST register early and MUST NOT depend on any
// later code succeeding, since it's what actually logs you in/out ----
onAuthStateChanged(auth, async (user) => {
  if (user) {
    state.user = user;

    // Load (or self-heal) the profile doc. A Firestore hiccup here should
    // never trap the user on the login screen — fall back to what we
    // already know from the auth account itself.
    // Reload first: right after signup, Auth's own user.displayName can
    // still be empty for a moment because updateProfile() is a separate
    // async call — reload() picks it up if it just finished.
    try { await user.reload(); } catch (_) {}
    const safeName = user.displayName || (user.email ? user.email.split("@")[0] : "member");
    state.profile = { uid: user.uid, displayName: safeName, email: (user.email || "").toLowerCase() };
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        state.profile = snap.data();
        if (!state.profile.displayNameLower && state.profile.displayName) {
          const lower = state.profile.displayName.toLowerCase();
          updateDoc(doc(db, "users", user.uid), { displayNameLower: lower }).catch(() => {});
          state.profile.displayNameLower = lower;
        }
      } else {
        // Profile doc never got created (e.g. signup's write failed) — recreate it now.
        await setDoc(doc(db, "users", user.uid), {
          uid: user.uid,
          displayName: state.profile.displayName,
          displayNameLower: state.profile.displayName.toLowerCase(),
          email: state.profile.email,
          createdAt: serverTimestamp(),
          status: "online",
          role: "member",
          tag: "",
          banned: false
        });
      }
    } catch (err) {
      console.error("Could not load/create profile doc — check that Firestore rules are published:", err);
    }

    const meName = document.getElementById("me-name");
    if (meName) meName.textContent = state.profile.displayName || "you";
    const meBadge = document.getElementById("me-badge");
    if (meBadge) meBadge.innerHTML = renderBadge(state.profile);

    if (state.profile.banned === true) {
      screenAuth.classList.remove("active");
      screenApp.classList.remove("active");
      document.getElementById("screen-banned")?.classList.add("active");
      return;
    }
    document.getElementById("screen-banned")?.classList.remove("active");

    const modBtn = document.getElementById("btn-mod-menu");
    if (modBtn) {
      const canModerate = ["owner", "co-owner", "admin"].includes(state.profile.role);
      if (!canModerate) modBtn.remove();
      else modBtn.hidden = false;
    }

    state.schoolMode = state.profile.schoolMode === true;
    const schoolBtn = document.getElementById("btn-school-mode");
    if (schoolBtn) {
      schoolBtn.classList.toggle("is-on", state.schoolMode);
      schoolBtn.title = state.schoolMode ? "School mode: on (calls silent)" : "School mode: off";
    }

    updateDoc(doc(db, "users", user.uid), { status: "online" }).catch((err) => console.error("status update failed:", err));

    screenAuth.classList.remove("active");
    screenApp.classList.add("active");
    listenToChats();
    listenForIncomingCalls();
    requestNotificationPermission();
    startNotificationCenter();
    startUserCache();
  } else {
    state.user = null;
    state.profile = null;
    screenApp.classList.remove("active");
    screenAuth.classList.add("active");
    stopNotificationCenter();
    if (unsubUserCache) { unsubUserCache(); unsubUserCache = null; }
    state.userCache = {};
  }
});

document.getElementById("btn-school-mode")?.addEventListener("click", async (e) => {
  state.schoolMode = !state.schoolMode;
  e.currentTarget.classList.toggle("is-on", state.schoolMode);
  e.currentTarget.title = state.schoolMode ? "School mode: on (calls silent)" : "School mode: off";
  try {
    await updateDoc(doc(db, "users", state.user.uid), { schoolMode: state.schoolMode });
  } catch (err) {
    console.error("School mode toggle failed to save:", err);
    showToast("School mode setting didn't save — try again.");
  }
});

// ---- sidebar drawer (single-page feel: hidden until opened) ----
// Every lookup below is null-safe (?.) on purpose: a missing button here
// should never be able to take down the rest of the app.
const appShell = document.querySelector(".app-shell");
export function openDrawer() { appShell?.classList.add("sidebar-open"); }
export function closeDrawer() { appShell?.classList.remove("sidebar-open"); }
document.getElementById("btn-menu")?.addEventListener("click", openDrawer);
document.getElementById("sidebar-backdrop")?.addEventListener("click", closeDrawer);

// ---- live name cache (fixes names getting stuck on old chat snapshots) ----
let unsubUserCache = null;
function startUserCache() {
  unsubUserCache = onSnapshot(collection(db, "users"), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "removed") { delete state.userCache[change.doc.id]; return; }
      state.userCache[change.doc.id] = change.doc.data();
    });
  }, (err) => console.error("User cache listener failed:", err));
}

// Prefer the live users collection over a name baked into an old chat
// document — that snapshot goes stale the moment someone renames themself.
export function liveName(uid, fallbackName) {
  return state.userCache[uid]?.displayName || fallbackName;
}

// ---- chat list ----
let hasAutoOpenedAChat = false;
function listenToChats() {
  const q = query(collection(db, "chats"), where("participants", "array-contains", state.user.uid));
  onSnapshot(q, (snap) => {
    // Firestore reports every doc as "added" on first attach, and "modified"
    // on real later changes — so filtering on "modified" here naturally
    // means we only ever notify for genuinely new incoming messages,
    // never for the chat history loading in.
    snap.docChanges().forEach((change) => {
      if (change.type !== "modified") return;
      const chat = change.doc.data();
      if (!chat.lastMessageSenderId || chat.lastMessageSenderId === state.user.uid) return;
      const isOpenAndFocused = state.activeChatId === change.doc.id && document.hasFocus();
      if (isOpenAndFocused) return;
      const peer = chat.participantInfo?.[chat.lastMessageSenderId];
      notify(liveName(chat.lastMessageSenderId, peer?.displayName) || "New message", chat.lastMessage || "");
    });

    const list = document.getElementById("chat-list");
    list.innerHTML = "";
    let firstChat = null;
    snap.forEach((docSnap) => {
      const chat = docSnap.data();
      let peer;
      if (chat.isGroup) {
        peer = { displayName: chat.groupName || "Group", isGroup: true, participantInfo: chat.participantInfo || {} };
      } else {
        const peerUid = state.user.uid === chat.participants[0] ? chat.participants[1] : chat.participants[0];
        const peerInfo = chat.participantInfo?.[peerUid];
        if (!peerInfo) return;
        peer = { ...peerInfo, uid: peerUid, displayName: liveName(peerUid, peerInfo.displayName) };
      }
      if (!firstChat) firstChat = { id: docSnap.id, peer };
      const item = document.createElement("div");
      item.className = "chat-item" + (state.activeChatId === docSnap.id ? " active" : "");
      item.innerHTML = `
        <div class="chat-avatar">${initials(peer.displayName)}</div>
        <div class="chat-item-meta">
          <div class="chat-item-name">${escapeHtml(peer.displayName)}</div>
          <div class="chat-item-preview">${escapeHtml(chat.lastMessage || "Say hello")}</div>
        </div>`;
      item.addEventListener("click", () => { openChat(docSnap.id, peer); closeDrawer(); });
      list.appendChild(item);
    });

    // Land straight in the conversation instead of the empty/add-friends
    // screen, so opening the app feels like "one page" — only once per
    // session, so it doesn't yank you away from whatever you're doing later.
    if (!hasAutoOpenedAChat && !state.activeChatId && firstChat) {
      hasAutoOpenedAChat = true;
      openChat(firstChat.id, firstChat.peer);
    }
  }, (err) => {
    console.error("Chat list listener failed:", err);
    showToast(`Can't load conversations: ${err.code || err.message || "unknown error"}`);
  });
}

export function escapeHtml(str = "") {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---- new conversation (inline panel, revealed on demand — no popup) ----
const nameInput = document.getElementById("new-chat-name");
const errEl = document.getElementById("new-chat-error");
const startBtn = document.getElementById("btn-confirm-new-chat");
const newChatPanel = document.getElementById("new-chat-panel");
const matchesEl = document.getElementById("new-chat-matches");

function goToEmptyScreen() {
  if (state.unsubMessages) { state.unsubMessages(); state.unsubMessages = null; }
  if (state.unsubPeerDoc) { state.unsubPeerDoc(); state.unsubPeerDoc = null; }
  if (state.unsubChatDoc) { state.unsubChatDoc(); state.unsubChatDoc = null; }
  state.activeChatId = null;
  state.activePeer = null;
  document.getElementById("chat-active").hidden = true;
  document.getElementById("chat-empty").hidden = false;
  document.querySelector(".app-shell")?.classList.remove("chat-open");
  document.querySelectorAll(".chat-item").forEach(el => el.classList.remove("active"));
  document.getElementById("new-group-panel")?.setAttribute("hidden", "");
  showPlaceholder();
}

function showPlaceholder() {
  if (newChatPanel) newChatPanel.hidden = true;
}

function showNewChatPanel() {
  if (!newChatPanel) return;
  newChatPanel.hidden = false;
  errEl.textContent = "";
  matchesEl.innerHTML = "";
  nameInput.value = "";
  nameInput.focus();
  renderSuggestions(document.getElementById("new-chat-suggestions"), (peer) => beginChatWith(peer));
}

function renderSuggestions(container, onPick, excludeUids = []) {
  if (!container) return;
  const all = Object.entries(state.userCache)
    .filter(([uid, u]) => uid !== state.user.uid && u.banned !== true && !excludeUids.includes(uid))
    .map(([uid, u]) => ({ ...u, uid }))
    .slice(0, 12);
  if (all.length === 0) { container.innerHTML = ""; return; }
  container.innerHTML = `<p class="panel-sub" style="margin:10px 0 4px;">Suggested</p>` +
    all.map(u => `<div class="match-row" data-uid="${u.uid}">
      <div class="chat-avatar">${initials(u.displayName)}</div>
      <div><div class="n">${escapeHtml(u.displayName || "—")}</div><div class="e">${escapeHtml(u.email || "")}</div></div>
    </div>`).join("");
  container.querySelectorAll("[data-uid]").forEach((row) => {
    row.addEventListener("click", () => onPick(all.find(u => u.uid === row.dataset.uid)));
  });
}

// Sidebar's "+ New conversation" — return to the empty screen, panel open.
document.getElementById("btn-new-chat")?.addEventListener("click", () => {
  goToEmptyScreen();
  showNewChatPanel();
  closeDrawer();
});

// "+ New conversation" in the drawer is now the only way to open this panel —
// the old always-visible "Add friend" CTA on the empty screen was removed.

// Cancel — back to the placeholder.
document.getElementById("btn-cancel-new-chat")?.addEventListener("click", showPlaceholder);

async function beginChatWith(peer) {
  const chatId = [state.user.uid, peer.uid].sort().join("_");
  const chatRef = doc(db, "chats", chatId);
  const existing = await getDoc(chatRef);
  if (!existing.exists()) {
    await setDoc(chatRef, {
      participants: [state.user.uid, peer.uid],
      participantInfo: {
        [state.user.uid]: { displayName: state.profile.displayName, email: state.profile.email },
        [peer.uid]: { displayName: peer.displayName, email: peer.email }
      },
      createdAt: serverTimestamp(),
      lastMessage: ""
    });
  }
  nameInput.value = "";
  matchesEl.innerHTML = "";
  openChat(chatId, peer);
}

async function startConversation() {
  const name = nameInput.value.trim();
  errEl.textContent = "";
  matchesEl.innerHTML = "";
  if (!name) { errEl.textContent = "Enter a display name or email first."; return; }
  const isEmail = name.includes("@");
  const lower = name.toLowerCase();
  if (lower === (isEmail ? state.profile.email : (state.profile.displayNameLower || state.profile.displayName?.toLowerCase()))) {
    errEl.textContent = "That's you."; return;
  }

  startBtn.disabled = true;
  const originalLabel = startBtn.textContent;
  startBtn.textContent = "Searching…";

  try {
    const usersQ = query(collection(db, "users"), or(where("email", "==", lower), where("displayNameLower", "==", lower)));
    const usersSnap = await getDocs(usersQ);
    const matches = usersSnap.docs.map(d => d.data()).filter(u => u.uid !== state.user.uid);

    if (matches.length === 0) { errEl.textContent = `No vox account with that ${isEmail ? "email" : "display name"}.`; return; }

    if (matches.length === 1) {
      await beginChatWith(matches[0]);
      return;
    }

    // More than one account shares this name — let the user pick the right one.
    errEl.textContent = "";
    matches.forEach((peer) => {
      const row = document.createElement("div");
      row.className = "match-row";
      row.innerHTML = `
        <div class="chat-avatar">${initials(peer.displayName)}</div>
        <div>
          <div class="n">${escapeHtml(peer.displayName)}</div>
          <div class="e">${escapeHtml(peer.email || "")}</div>
        </div>`;
      row.addEventListener("click", () => beginChatWith(peer));
      matchesEl.appendChild(row);
    });
  } catch (err) {
    console.error("startConversation failed:", err);
    errEl.textContent = "Something went wrong — check the console for details.";
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = originalLabel;
  }
}

startBtn?.addEventListener("click", startConversation);
nameInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") startConversation(); });

// ---- new group ----
const groupNameInput = document.getElementById("new-group-name");
const groupMemberInput = document.getElementById("new-group-member-name");
const groupErrEl = document.getElementById("new-group-error");
const groupMatchesEl = document.getElementById("new-group-matches");
const groupMembersEl = document.getElementById("new-group-members");
const newGroupPanel = document.getElementById("new-group-panel");
let pendingGroupMembers = []; // [{uid, displayName, email}]

document.getElementById("btn-new-group")?.addEventListener("click", () => {
  goToEmptyScreen();
  if (newChatPanel) newChatPanel.hidden = true;
  if (newGroupPanel) newGroupPanel.hidden = false;
  pendingGroupMembers = [];
  groupNameInput.value = "";
  groupMemberInput.value = "";
  groupErrEl.textContent = "";
  groupMatchesEl.innerHTML = "";
  renderGroupMemberChips();
  closeDrawer();
});

document.getElementById("btn-cancel-new-group")?.addEventListener("click", () => {
  if (newGroupPanel) newGroupPanel.hidden = true;
});

function renderGroupMemberChips() {
  groupMembersEl.innerHTML = pendingGroupMembers.map((m, i) => `
    <div class="match-row">
      <div class="chat-avatar">${initials(m.displayName)}</div>
      <div style="flex:1"><div class="n">${escapeHtml(m.displayName)}</div><div class="e">${escapeHtml(m.email || "")}</div></div>
      <button type="button" class="btn-ghost" data-remove-idx="${i}" style="padding:4px 10px;">Remove</button>
    </div>`).join("");
  groupMembersEl.querySelectorAll("[data-remove-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      pendingGroupMembers.splice(Number(btn.dataset.removeIdx), 1);
      renderGroupMemberChips();
      renderGroupSuggestions();
    });
  });
  renderGroupSuggestions();
}

function renderGroupSuggestions() {
  renderSuggestions(
    document.getElementById("new-group-suggestions"),
    (u) => { pendingGroupMembers.push(u); renderGroupMemberChips(); },
    pendingGroupMembers.map(m => m.uid)
  );
}

document.getElementById("btn-add-group-member")?.addEventListener("click", async () => {
  const name = groupMemberInput.value.trim();
  groupErrEl.textContent = "";
  groupMatchesEl.innerHTML = "";
  if (!name) { groupErrEl.textContent = "Enter a display name or email first."; return; }
  const isEmail = name.includes("@");
  const lower = name.toLowerCase();

  try {
    const usersQ = query(collection(db, "users"), or(where("email", "==", lower), where("displayNameLower", "==", lower)));
    const usersSnap = await getDocs(usersQ);
    const matches = usersSnap.docs.map(d => d.data())
      .filter(u => u.uid !== state.user.uid && !pendingGroupMembers.some(m => m.uid === u.uid));

    if (matches.length === 0) { groupErrEl.textContent = "No new match with that name/email."; return; }

    if (matches.length === 1) {
      pendingGroupMembers.push(matches[0]);
      groupMemberInput.value = "";
      renderGroupMemberChips();
      return;
    }
    // Multiple accounts share this name — let the user pick which to add.
    matches.forEach((u) => {
      const row = document.createElement("div");
      row.className = "match-row";
      row.innerHTML = `<div class="chat-avatar">${initials(u.displayName)}</div>
        <div><div class="n">${escapeHtml(u.displayName)}</div><div class="e">${escapeHtml(u.email || "")}</div></div>`;
      row.addEventListener("click", () => {
        pendingGroupMembers.push(u);
        groupMemberInput.value = "";
        groupMatchesEl.innerHTML = "";
        renderGroupMemberChips();
      });
      groupMatchesEl.appendChild(row);
    });
  } catch (err) {
    console.error("Group member search failed:", err);
    groupErrEl.textContent = "Something went wrong — check the console.";
  }
});

document.getElementById("btn-create-group")?.addEventListener("click", async () => {
  groupErrEl.textContent = "";
  if (pendingGroupMembers.length < 2) {
    groupErrEl.textContent = "Add at least 2 friends for a group.";
    return;
  }
  const groupName = groupNameInput.value.trim() ||
    pendingGroupMembers.map(m => m.displayName).slice(0, 3).join(", ");

  try {
    const participantInfo = {
      [state.user.uid]: { displayName: state.profile.displayName, email: state.profile.email }
    };
    pendingGroupMembers.forEach(m => { participantInfo[m.uid] = { displayName: m.displayName, email: m.email }; });

    const chatRef = await addDoc(collection(db, "chats"), {
      participants: [state.user.uid, ...pendingGroupMembers.map(m => m.uid)],
      participantInfo,
      isGroup: true,
      groupName,
      createdAt: serverTimestamp(),
      lastMessage: ""
    });

    if (newGroupPanel) newGroupPanel.hidden = true;
    openChat(chatRef.id, { displayName: groupName, isGroup: true, participantInfo });
  } catch (err) {
    console.error("Group creation failed:", err);
    groupErrEl.textContent = "Something went wrong — check the console.";
  }
});
