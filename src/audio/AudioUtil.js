/**
 * Small, dependency-free helpers shared by every audio module.
 *
 * Everything here is deliberately context-agnostic: each function takes a
 * `BaseAudioContext`, so the exact same synthesis code runs in the live
 * `AudioContext` and in an `OfflineAudioContext` during verification. That is
 * the only way to make a soundscape you cannot hear actually testable.
 */

export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

/** Deterministic PRNG — noise tables must be identical every run so that
 *  measurements taken by the probe are reproducible. */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Equal-tempered pitch. 69 = A4 = 440 Hz. */
export function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

// --- Buffers ---------------------------------------------------------------

/**
 * A seamlessly loopable noise table.
 *
 * A raw noise buffer clicks at the loop point because the last and first
 * samples are uncorrelated; the tail is cross-faded into the head so a looping
 * source can run for a whole race without a periodic tick.
 */
export function makeNoiseBuffer(ctx, seconds = 2.0, opts = {}) {
  const { type = 'white', seed = 12345 } = opts;
  const n = Math.max(64, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = makeRng(seed);

  if (type === 'pink') {
    // Paul Kellet's economical pink filter — 1/f slope without an FFT.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
      b6 = w * 0.115926;
    }
  } else if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * (rng() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  }

  // Normalise, then cross-fade the last 2048 samples into the first 2048.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) { const k = 0.92 / peak; for (let i = 0; i < n; i++) d[i] *= k; }

  const x = Math.min(2048, n >> 2);
  for (let i = 0; i < x; i++) {
    const t = i / x;
    const head = d[i];
    const tail = d[n - x + i];
    d[n - x + i] = tail * (1 - t) + head * t;
  }
  return buf;
}

/**
 * Synthetic reverb impulse: a couple of discrete early reflections followed by
 * an exponentially decaying, progressively darkened noise tail. Rendering a
 * real space is out of scope; what matters is that a canyon sounds larger and
 * later than a beach.
 */
export function makeImpulse(ctx, opts = {}) {
  const {
    seconds = 2.0, decay = 2.6, predelay = 0.012, damp = 0.35,
    reflections = [[0.021, 0.42], [0.037, 0.31], [0.058, 0.24], [0.089, 0.17]],
    seed = 777,
  } = opts;
  const n = Math.max(64, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const rng = makeRng(seed);
  const pre = Math.floor(predelay * ctx.sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // One-pole lowpass state; the coefficient creeps up so the tail darkens.
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      const a = lerp(0.55, 0.94, t * damp * 2 > 1 ? 1 : t * damp * 2);
      lp = lp * a + (rng() * 2 - 1) * (1 - a);
      d[i] = lp * Math.pow(1 - t, decay);
    }
    for (const [tSec, amp] of reflections) {
      const i = Math.floor((tSec + predelay) * ctx.sampleRate) + (ch ? 37 : 0);
      if (i < n) d[i] += amp * (ch ? -1 : 1) * (0.7 + rng() * 0.3);
    }
  }
  return buf;
}

/**
 * `tanh` transfer curve for a WaveShaper. The output is mathematically bounded
 * to ±1, which is what lets the mix guarantee it never exceeds 0 dBFS no matter
 * how many voices fire at once — the compressor shapes, this backstops.
 */
export function softClipCurve(k = 1.7, n = 4096) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

// --- AudioParam helpers ----------------------------------------------------

const EPS = 1e-4;

/**
 * Smoothed parameter write with a redundancy check.
 *
 * Continuous voices push ~20 parameters per frame; most of them do not change
 * between frames. Skipping unchanged writes keeps the automation event lists
 * (and the main-thread cost of maintaining them) small.
 */
export function setTarget(param, value, now, tc = 0.03) {
  if (!Number.isFinite(value)) return;
  const last = param._hkLast;
  if (last !== undefined && Math.abs(last - value) < EPS) return;
  param._hkLast = value;
  param.setTargetAtTime(value, now, tc);
}

/** Immediate, un-smoothed write (used for one-shot envelope anchors). */
export function setNow(param, value, now) {
  if (!Number.isFinite(value)) return;
  param._hkLast = value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
}

/** `exponentialRampToValueAtTime` cannot reach zero; this keeps it legal. */
export function expRamp(param, value, when) {
  param.exponentialRampToValueAtTime(Math.max(1e-4, value), when);
}

/**
 * Percussive amplitude envelope: linear attack, exponential-ish decay to
 * silence. Returns the time at which the envelope has finished.
 */
export function ampEnv(gain, t0, { peak = 0.5, attack = 0.004, hold = 0, decay = 0.25 }) {
  const g = gain.gain;
  g.cancelScheduledValues(t0);
  g.setValueAtTime(0.0001, t0);
  g.linearRampToValueAtTime(peak, t0 + attack);
  if (hold > 0) g.setValueAtTime(peak, t0 + attack + hold);
  g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
  g.setValueAtTime(0, t0 + attack + hold + decay);
  return t0 + attack + hold + decay;
}

/** Position an `AudioListener` or `PannerNode`, preferring the AudioParam API. */
export function place(target, x, y, z, now, tc = 0.02) {
  if (target.positionX) {
    setTarget(target.positionX, x, now, tc);
    setTarget(target.positionY, y, now, tc);
    setTarget(target.positionZ, z, now, tc);
  } else if (target.setPosition) {
    target.setPosition(x, y, z);
  }
}

export function orient(listener, fx, fy, fz, ux, uy, uz, now, tc = 0.02) {
  if (listener.forwardX) {
    setTarget(listener.forwardX, fx, now, tc);
    setTarget(listener.forwardY, fy, now, tc);
    setTarget(listener.forwardZ, fz, now, tc);
    setTarget(listener.upX, ux, now, tc);
    setTarget(listener.upY, uy, now, tc);
    setTarget(listener.upZ, uz, now, tc);
  } else if (listener.setOrientation) {
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}
