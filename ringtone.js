// Classic dual-tone ring cadence, synthesized with the Web Audio API.
// No audio file to fetch — works offline/on GitHub Pages with zero assets.
let audioCtx = null;
let activeNodes = [];
let cadenceTimer = null;

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function playTone(durationMs, freqs) {
  const c = ctx();
  const gain = c.createGain();
  gain.gain.value = 0.05; // gentle, not jarring
  gain.connect(c.destination);
  const oscs = freqs.map((f) => {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    o.connect(gain);
    o.start();
    o.stop(c.currentTime + durationMs / 1000);
    return o;
  });
  activeNodes.push(gain, ...oscs);
}

function startCadence(onMs, offMs, freqs) {
  stop(); // clear anything already running
  const cycle = () => {
    playTone(onMs, freqs);
    cadenceTimer = setTimeout(cycle, onMs + offMs);
  };
  cycle();
}

// Callee side: phone is ringing, waiting for you to accept/decline.
export function startRingtone() { startCadence(1800, 3200, [440, 480]); }

// Caller side: ringback — "it's ringing on their end."
export function startRingback() { startCadence(1000, 3000, [440, 480]); }

export function stop() {
  clearTimeout(cadenceTimer);
  cadenceTimer = null;
  activeNodes.forEach((n) => { try { n.disconnect(); } catch (_) {} });
  activeNodes = [];
}
