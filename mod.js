import { db } from "./firebase-config.js";
import { state } from "./state.js";
import { initials, escapeHtml, closeDrawer } from "./app.js";
import {
  collection, doc, onSnapshot, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const screenMod = document.getElementById("screen-mod");
const listEl = document.getElementById("mod-user-list");
let unsubUsers = null;

document.getElementById("btn-mod-menu").addEventListener("click", () => {
  closeDrawer();
  screenMod.hidden = false;
  screenMod.classList.add("active");
  if (!unsubUsers) {
    unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
      renderUserList(snap.docs.map(d => d.data()));
    });
  }
});

document.getElementById("btn-close-mod").addEventListener("click", () => {
  screenMod.hidden = true;
  screenMod.classList.remove("active");
});

function renderUserList(users) {
  const iAmOwner = state.profile.role === "owner";
  listEl.innerHTML = "";

  users
    .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""))
    .forEach((u) => {
      const isSelf = u.uid === state.user.uid;
      const targetIsOwner = u.role === "owner";
      // Admins (non-owners) can't touch an owner's row, and can't grant owner.
      const locked = targetIsOwner && !iAmOwner;

      const row = document.createElement("div");
      row.className = "mod-row";
      row.innerHTML = `
        <div class="chat-avatar">${initials(u.displayName)}</div>
        <div class="mod-row-name">
          <div class="n">${escapeHtml(u.displayName || "—")}${isSelf ? " (you)" : ""}</div>
          <div class="e">${escapeHtml(u.email || "")}</div>
        </div>
        <input class="mod-tag-input" type="text" maxlength="12" placeholder="tag" value="${escapeHtml(u.tag || "")}" ${locked ? "disabled" : ""} />
        <select class="mod-role-select" ${locked || isSelf ? "disabled" : ""}>
          <option value="member" ${u.role === "member" || !u.role ? "selected" : ""}>member</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
          ${iAmOwner ? `<option value="co-owner" ${u.role === "co-owner" ? "selected" : ""}>co-owner</option>` : ""}
          ${iAmOwner ? `<option value="owner" ${u.role === "owner" ? "selected" : ""}>owner</option>` : ""}
        </select>
        <button class="mod-ban-btn ${u.banned === true ? "is-banned" : ""}" ${locked || isSelf ? "disabled" : ""}>
          ${u.banned === true ? "Unban" : "Ban"}
        </button>
      `;

      const tagInput = row.querySelector(".mod-tag-input");
      tagInput.addEventListener("change", () => {
        updateDoc(doc(db, "users", u.uid), { tag: tagInput.value.trim() })
          .catch(err => console.error("tag update failed:", err));
      });

      const roleSelect = row.querySelector(".mod-role-select");
      roleSelect.addEventListener("change", () => {
        updateDoc(doc(db, "users", u.uid), { role: roleSelect.value })
          .catch(err => console.error("role update failed:", err));
      });

      const banBtn = row.querySelector(".mod-ban-btn");
      banBtn.addEventListener("click", () => {
        updateDoc(doc(db, "users", u.uid), { banned: !(u.banned === true) })
          .catch(err => console.error("ban update failed:", err));
      });

      listEl.appendChild(row);
    });
}
