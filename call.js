import { db } from "./firebase-config.js";
import { state } from "./state.js";
import { initials } from "./app.js";
import { notify } from "./notifications.js";
import { showToast } from "./toast.js";
import * as ringtone from "./ringtone.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, onSnapshot, query,
  where, serverTimestamp, deleteDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ICE_SERVERS = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
};

let pc = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let currentCallId = null;
let isCaller = false;
let unsubCallDoc = null;
let unsubRemoteCandidates = null;
let timerInterval = null;
let isMuted = false;
let isOnHold = false;
let isCameraOff = false;
let isBlackedOut = false;
let blackTrack = null;
let renegotiationCounter = 0;
let lastHandledOfferId = null;
let lastAppliedAnswerForId = null;

const screenIncoming = document.getElementById("screen-incoming");
const screenCall = document.getElementById("screen-call");
const callBody = document.querySelector("#screen-call .call-body");
const remoteVideo = document.getElementById("remote-video");
const localVideo = document.getElementById("local-video");

function showScreen(el) { el.hidden = false; el.classList.add("active"); }
function hideScreen(el) { el.hidden = true; el.classList.remove("active"); }

// Try camera + mic (if video requested); fall back to mic-only if no camera
// / permission denied, so a call can still happen even without video.
async function getLocalStream(wantVideo) {
  if (!wantVideo) return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 480, height: 640 } });
  } catch (err) {
    console.error("Camera unavailable, falling back to audio-only:", err);
    showToast("Camera unavailable — continuing with audio only. (The other person may still see their own video.)");
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
}

function setupLocalVideo() {
  const hasVideo = localStream.getVideoTracks().length > 0;
  localVideo.srcObject = localStream;
  localVideo.classList.toggle("no-video", !hasVideo || isCameraOff);
}

// ---------------- outgoing ----------------
document.getElementById("btn-call").addEventListener("click", () => startCall(false));
document.getElementById("btn-video-call").addEventListener("click", () => startCall(true));

async function startCall(wantVideo) {
  if (!state.activePeer) return;
  if (state.activePeer.isGroup || !state.activePeer.uid) {
    showToast("Group calling isn't supported yet — this only works in 1:1 conversations for now.");
    return;
  }
  isCaller = true;

  try {
    localStream = await getLocalStream(wantVideo);
    pc = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    attachRemoteTrack();

    const callRef = doc(collection(db, "calls"));
    currentCallId = callRef.id;

    const callerCandidates = collection(callRef, "callerCandidates");
    pc.onicecandidate = (e) => { if (e.candidate) addDoc(callerCandidates, e.candidate.toJSON()).catch(err => console.error("candidate write failed:", err)); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await setDoc(callRef, {
      callerId: state.user.uid,
      callerName: state.profile.displayName,
      calleeId: state.activePeer.uid,
      calleeName: state.activePeer.displayName,
      callType: wantVideo ? "video" : "audio",
      offer: { type: offer.type, sdp: offer.sdp },
      status: "ringing",
      createdAt: serverTimestamp()
    });

    showCallScreen(screenCall, state.activePeer.displayName, "calling…");
    setupLocalVideo();
    ringtone.startRingback();

    unsubCallDoc = onSnapshot(callRef, async (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.status === "accepted" && data.answer && !pc.currentRemoteDescription) {
        ringtone.stop();
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        document.getElementById("call-status").textContent = "connected";
        startTimer();
        listenForCandidates(callRef, "calleeCandidates");
      }
      updatePrivacyNotice(data);
      handleRenegotiation(data);
      if (data.status === "declined") { ringtone.stop(); endCall("declined"); }
      if (data.status === "ended") { ringtone.stop(); endCall(); }
    });
  } catch (err) {
    console.error("Call failed to start:", err);
    showToast(`Call didn't start: ${err.code || err.message || "unknown error"}`);
    ringtone.stop();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (pc) { pc.close(); pc = null; }
  }
}

// ---------------- incoming ----------------
export function listenForIncomingCalls() {
  const q = query(collection(db, "calls"), where("calleeId", "==", state.user.uid), where("status", "==", "ringing"));
  onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") handleIncomingCall(change.doc.id, change.doc.data());
    });
  });
}

function handleIncomingCall(callId, data) {
  currentCallId = callId;
  isCaller = false;
  document.getElementById("incoming-name").textContent = data.callerName || "Unknown";
  document.getElementById("incoming-initial").textContent = initials(data.callerName);
  showScreen(screenIncoming);
  notify(`Incoming call — ${data.callerName || "Unknown"}`, "tap to open vox");
  if (!state.schoolMode) ringtone.startRingtone();

  const callRef = doc(db, "calls", callId);

  document.getElementById("btn-decline").onclick = async () => {
    ringtone.stop();
    hideScreen(screenIncoming);
    await updateDoc(callRef, { status: "declined" });
  };

  document.getElementById("btn-accept").onclick = async () => {
    ringtone.stop();
    hideScreen(screenIncoming);
    try {
      localStream = await getLocalStream(data.callType === "video");
      pc = new RTCPeerConnection(ICE_SERVERS);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      attachRemoteTrack();

      const calleeCandidates = collection(callRef, "calleeCandidates");
      pc.onicecandidate = (e) => { if (e.candidate) addDoc(calleeCandidates, e.candidate.toJSON()).catch(err => console.error("candidate write failed:", err)); };

      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await updateDoc(callRef, {
        status: "accepted",
        answer: { type: answer.type, sdp: answer.sdp }
      });

      showCallScreen(screenCall, data.callerName, "connected");
      setupLocalVideo();
      startTimer();
      listenForCandidates(callRef, "callerCandidates");

      unsubCallDoc = onSnapshot(callRef, (snap) => {
        const d = snap.data();
        if (d) { updatePrivacyNotice(d); handleRenegotiation(d); }
        if (d?.status === "ended") endCall();
      });
    } catch (err) {
      console.error("Call failed to connect:", err);
      showToast(`Call didn't connect: ${err.code || err.message || "unknown error"}`);
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      if (pc) { pc.close(); pc = null; }
    }
  };
}

// ---------------- renegotiation (adding a track mid-call) ----------------
// The initial offer/answer only covers whatever tracks existed at call
// start. Turning on video (or screen share) during an audio-only call adds
// a NEW track, which needs its own offer/answer round-trip — this is that.
async function pushRenegotiation() {
  if (!pc || !currentCallId) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    renegotiationCounter += 1;
    const myId = renegotiationCounter;
    await updateDoc(doc(db, "calls", currentCallId), {
      renegotiateOffer: { type: offer.type, sdp: offer.sdp },
      renegotiateFrom: state.user.uid,
      renegotiationId: myId
    });
  } catch (err) {
    console.error("Renegotiation failed to start:", err);
    showToast("Couldn't turn that on — try again.");
  }
}

async function handleRenegotiation(data) {
  if (!data.renegotiationId || !pc || !currentCallId) return;

  if (data.renegotiateFrom === state.user.uid) {
    // We initiated this — apply the matching answer once, when it arrives.
    if (data.renegotiateAnswer && data.renegotiateAnswerFor === data.renegotiationId &&
        lastAppliedAnswerForId !== data.renegotiationId) {
      lastAppliedAnswerForId = data.renegotiationId;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.renegotiateAnswer));
      } catch (err) {
        console.error("Failed to apply renegotiation answer:", err);
      }
    }
  } else if (lastHandledOfferId !== data.renegotiationId && data.renegotiateOffer) {
    // Someone else added a track — answer it.
    lastHandledOfferId = data.renegotiationId;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.renegotiateOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await updateDoc(doc(db, "calls", currentCallId), {
        renegotiateAnswer: { type: answer.type, sdp: answer.sdp },
        renegotiateAnswerFor: data.renegotiationId
      });
    } catch (err) {
      console.error("Failed to answer renegotiation:", err);
    }
  }
}

function listenForCandidates(callRef, subcol) {
  unsubRemoteCandidates = onSnapshot(collection(callRef, subcol), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added" && pc) {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
      }
    });
  });
}

function attachRemoteTrack() {
  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;
  remoteVideo.classList.add("no-video");
  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    if (e.track.kind === "video") {
      remoteVideo.classList.remove("no-video");
      callBody.classList.add("video-active");
    }
  };
}

// ---------------- UI ----------------
function showCallScreen(screenEl, name, status) {
  document.getElementById("call-peer-name").textContent = name;
  document.getElementById("call-initial").textContent = initials(name);
  document.getElementById("call-status").textContent = status;
  document.getElementById("call-timer").hidden = true;
  document.getElementById("call-timer").textContent = "00:00";
  callBody.classList.remove("video-active");
  remoteVideo.classList.add("no-video");
  showScreen(screenEl);
}

function updatePrivacyNotice(data) {
  const notice = document.getElementById("call-privacy-notice");
  if (notice) notice.hidden = !data.sharePrivacy;
}

function startTimer() {
  let seconds = 0;
  const timerEl = document.getElementById("call-timer");
  timerEl.hidden = false;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

// ---------------- controls ----------------
document.getElementById("btn-mute").addEventListener("click", (e) => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  e.currentTarget.classList.toggle("is-on", isMuted);
});

document.getElementById("btn-camera").addEventListener("click", async (e) => {
  if (!localStream || !pc) return;
  const videoTracks = localStream.getVideoTracks();

  if (videoTracks.length === 0) {
    // Audio-only call — turn the camera on for the first time.
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 640 } });
      const camTrack = camStream.getVideoTracks()[0];
      localStream.addTrack(camTrack);
      pc.addTrack(camTrack, localStream);
      setupLocalVideo();
      e.currentTarget.title = "Turn camera off";
      await pushRenegotiation();
    } catch (err) {
      console.error("Couldn't turn camera on:", err);
      showToast("Couldn't access your camera.");
    }
    return;
  }

  isCameraOff = !isCameraOff;
  videoTracks.forEach(t => t.enabled = !isCameraOff);
  localVideo.classList.toggle("no-video", isCameraOff);
  e.currentTarget.classList.toggle("is-on", isCameraOff);
  e.currentTarget.title = isCameraOff ? "Turn camera on" : "Turn camera off";
});

document.getElementById("btn-screenshare").addEventListener("click", toggleScreenShare);

async function toggleScreenShare() {
  if (!pc) return;
  const btn = document.getElementById("btn-screenshare");

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      // User cancelled the share picker, or it's unsupported — not a real error.
      if (err.name !== "NotAllowedError") console.error("Screen share failed:", err);
      return;
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) {
      await sender.replaceTrack(screenTrack);
    } else {
      // Audio-only call so far — this is the first video track, needs renegotiation.
      pc.addTrack(screenTrack, screenStream);
      await pushRenegotiation();
    }

    localVideo.srcObject = screenStream;
    localVideo.classList.remove("no-video");
    isScreenSharing = true;
    btn.classList.add("is-on");
    btn.title = "Stop sharing screen";

    // Covers both the in-app button AND the browser's own native "Stop sharing" bar.
    screenTrack.onended = () => { if (isScreenSharing) stopScreenShare(); };

    // Edge case found on review: if the message box already had focus the
    // instant sharing started, no focus/input event would fire to trigger
    // the blackout — engage it immediately in that case.
    if (document.activeElement?.id === "message-input") pauseScreenShareForPrivacy();
  } else {
    stopScreenShare();
  }
}

async function stopScreenShare() {
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  const cameraTrack = localStream?.getVideoTracks()[0];
  const sender = pc?.getSenders().find(s => s.track && s.track.kind === "video");
  if (sender && cameraTrack) await sender.replaceTrack(cameraTrack).catch(() => {});

  if (localStream) {
    localVideo.srcObject = localStream;
    localVideo.classList.toggle("no-video", !cameraTrack || isCameraOff);
  }
  isScreenSharing = false;
  const btn = document.getElementById("btn-screenshare");
  btn.classList.remove("is-on");
  btn.title = "Share screen";
}

document.getElementById("btn-hold").addEventListener("click", (e) => {
  if (!localStream) return;
  isOnHold = !isOnHold;
  // Simple local hold: pause outgoing audio/video and remote playback.
  // (Signaling "on hold" status to the peer's UI is a good next step.)
  localStream.getTracks().forEach(t => t.enabled = !isOnHold);
  if (remoteVideo) isOnHold ? remoteVideo.pause() : remoteVideo.play().catch(() => {});
  document.getElementById("call-status").textContent = isOnHold ? "on hold" : "connected";
  e.currentTarget.classList.toggle("is-on", isOnHold);
});

document.getElementById("btn-hangup").addEventListener("click", async () => {
  if (currentCallId) await updateDoc(doc(db, "calls", currentCallId), { status: "ended" }).catch(() => {});
  endCall();
});

async function endCall(reason) {
  ringtone.stop();
  clearInterval(timerInterval);
  if (unsubCallDoc) { unsubCallDoc(); unsubCallDoc = null; }
  if (unsubRemoteCandidates) { unsubRemoteCandidates(); unsubRemoteCandidates = null; }
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  isMuted = false; isOnHold = false; isCameraOff = false; isScreenSharing = false; isBlackedOut = false;
  renegotiationCounter = 0; lastHandledOfferId = null; lastAppliedAnswerForId = null;
  document.getElementById("btn-mute").classList.remove("is-on");
  document.getElementById("btn-hold").classList.remove("is-on");
  document.getElementById("btn-camera").classList.remove("is-on");
  document.getElementById("btn-screenshare").classList.remove("is-on");
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  callBody.classList.remove("video-active");
  document.getElementById("call-privacy-notice")?.setAttribute("hidden", "");
  hideScreen(screenCall);
  hideScreen(screenIncoming);

  // Light cleanup of the signaling doc's candidate subcollections.
  if (currentCallId) {
    for (const sub of ["callerCandidates", "calleeCandidates"]) {
      const snap = await getDocs(collection(db, "calls", currentCallId, sub)).catch(() => null);
      snap?.forEach(d => deleteDoc(d.ref).catch(() => {}));
    }
  }
  currentCallId = null;
}

// ---------------- secret blackout (privacy while texting) ----------------
// Swaps ONLY the outgoing video track (what the other person receives) to a
// solid black frame — your own local screen preview is untouched, so you
// keep working normally while whoever's watching just sees black + a notice.
function getBlackTrack() {
  if (blackTrack) return blackTrack;
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 480;
  const ctx2d = canvas.getContext("2d");
  ctx2d.fillStyle = "#000"; ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  blackTrack = canvas.captureStream(1).getVideoTracks()[0];
  return blackTrack;
}

export async function pauseScreenShareForPrivacy() {
  if (!isScreenSharing || isBlackedOut || !pc) return;
  isBlackedOut = true;
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (sender) await sender.replaceTrack(getBlackTrack()).catch(err => console.error("Blackout failed:", err));
  if (currentCallId) updateDoc(doc(db, "calls", currentCallId), { sharePrivacy: true }).catch(() => {});
}

export async function resumeScreenShareIfPaused() {
  if (!isBlackedOut || !pc) return;
  isBlackedOut = false;
  const realTrack = screenStream?.getVideoTracks()[0];
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (sender && realTrack) await sender.replaceTrack(realTrack).catch(err => console.error("Resume share failed:", err));
  if (currentCallId) updateDoc(doc(db, "calls", currentCallId), { sharePrivacy: false }).catch(() => {});
}
