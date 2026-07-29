// Small on-screen toast so failures are visible without opening dev tools.
let toastEl = null;
let hideTimer = null;

function ensureToastEl() {
  if (toastEl) return toastEl;
  toastEl = document.createElement("div");
  toastEl.id = "vox-toast";
  toastEl.className = "vox-toast";
  document.body.appendChild(toastEl);
  return toastEl;
}

export function showToast(message, isError = true) {
  const el = ensureToastEl();
  el.textContent = message;
  el.classList.toggle("vox-toast-error", isError);
  el.classList.add("vox-toast-visible");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove("vox-toast-visible"), 6000);
}
