// Shared math helpers. Kept dependency-free so every subsystem can import it.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Frame-rate independent exponential smoothing. `rate` = higher is snappier. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Wrap an angle into [-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed delta from angle `a` to angle `b`. */
export const angleDelta = (a, b) => wrapAngle(b - a);

/** Angular equivalent of `damp`, taking the short way around. */
export function dampAngle(a, b, rate, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function moveToward(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

/** Wrap `v` into [0, m). Correct for negative inputs. */
export const mod = (v, m) => ((v % m) + m) % m;

/** Shortest signed delta on a ring of circumference `m`. */
export function ringDelta(a, b, m) {
  let d = mod(b - a, m);
  if (d > m * 0.5) d -= m;
  return d;
}

// ---------------------------------------------------------------------------
// Deterministic RNG — every system seeds its own stream so visuals are stable
// across reloads, which is what makes the screenshot critic loop meaningful.
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, good enough for art/scatter. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const fn = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.int = (lo, hi) => Math.floor(lo + fn() * (hi - lo + 1));
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length) % arr.length];
  fn.sign = () => (fn() < 0.5 ? -1 : 1);
  return fn;
}

/** Classic 2D value noise with smooth interpolation. Tileable on `period`. */
export function makeValueNoise2D(seed = 1, period = 256) {
  const rng = makeRng(seed);
  const size = period;
  const table = new Float32Array(size * size);
  for (let i = 0; i < table.length; i++) table[i] = rng();
  const at = (x, y) => table[mod(y, size) * size + mod(x, size)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smootherstep(xf), v = smootherstep(yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
}

/** Fractal brownian motion over a 2D noise basis. */
export function fbm2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
