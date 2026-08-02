import { TAU, clamp, lerp, mod } from '../core/MathX.js';

/**
 * Track centerlines are authored as closed polar curves rather than hand-placed
 * points. A harmonic base gives flowing, believable circuit rhythm, and
 * localized Gaussian "features" carve individual corners (hairpins, bulges,
 * chicanes) into it. Because the curve is periodic by construction there is
 * never a tangent discontinuity at the start/finish line — the classic failure
 * mode of hand-authored loops.
 */

/**
 * @param {object} cfg
 * @param {number} cfg.base           mean radius (m)
 * @param {Array<[number,number,number]>} cfg.harmonics  [order, amplitude, phase]
 * @param {Array<[number,number,number]>} cfg.elevation  [order, amplitude, phase]
 * @param {Array<{theta:number, sigma:number, amp:number, rise?:number}>} cfg.features
 * @param {Array<[number,number]>} cfg.widthProfile      [theta, width] keyframes
 * @param {number} cfg.count          number of control points emitted
 */
export function makeLoopNodes(cfg) {
  const {
    base, harmonics = [], elevation = [], features = [],
    widthProfile = [[0, 16]], count = 96, squash = 1,
  } = cfg;

  const radiusAt = (th) => {
    let r = base;
    for (const [k, amp, ph] of harmonics) r += amp * Math.sin(k * th + ph);
    for (const f of features) r += f.amp * gaussianRing(th, f.theta, f.sigma);
    return r;
  };
  const heightAt = (th) => {
    let y = 0;
    for (const [k, amp, ph] of elevation) y += amp * Math.sin(k * th + ph);
    for (const f of features) if (f.rise) y += f.rise * gaussianRing(th, f.theta, f.sigma);
    return y;
  };
  const widthAt = (th) => sampleProfile(widthProfile, th);

  const nodes = [];
  for (let i = 0; i < count; i++) {
    const th = (i / count) * TAU;
    const r = radiusAt(th);
    nodes.push({
      p: [Math.sin(th) * r, heightAt(th), Math.cos(th) * r * squash],
      width: widthAt(th),
    });
  }
  return nodes;
}

/** Periodic Gaussian bump, so features wrap correctly across theta = 0. */
function gaussianRing(th, center, sigma) {
  let d = mod(th - center, TAU);
  if (d > Math.PI) d -= TAU;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

function sampleProfile(profile, th) {
  if (profile.length === 1) return profile[0][1];
  const t = mod(th, TAU);
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    const ta = a[0];
    let tb = b[0];
    if (tb <= ta) tb += TAU;
    let tt = t;
    if (tt < ta) tt += TAU;
    if (tt >= ta && tt <= tb) {
      const u = (tt - ta) / (tb - ta);
      const e = u * u * (3 - 2 * u);
      return lerp(a[1], b[1], e);
    }
  }
  return profile[0][1];
}

// ---------------------------------------------------------------------------
// Track definitions
// ---------------------------------------------------------------------------

/**
 * `theme` drives every art system (sky, lighting, palette, prop sets, water).
 * Subsystem agents read it rather than hardcoding per-track constants.
 */

export const TRACKS = {
  sunsetCoast: {
    id: 'sunsetCoast',
    name: 'Sunset Coast',
    subtitle: 'Seaside Circuit',
    laps: 3,
    difficulty: 1,
    nodes: makeLoopNodes({
      base: 210,
      squash: 0.92,
      harmonics: [
        [1, 46, 0.55],
        [2, 30, 1.85],
        [3, 19, -0.42],
        [5, 7, 2.4],
      ],
      elevation: [
        [1, 8.5, 2.25],
        [2, 5.0, 0.35],
        [3, -2.6, 1.15],
      ],
      features: [
        // Tight hairpin on the back section.
        { theta: 3.05, sigma: 0.20, amp: -74, rise: -3 },
        // Wide, banked cliffside sweeper.
        { theta: 4.85, sigma: 0.34, amp: 52, rise: 5 },
        // Compression into the beach chicane.
        { theta: 1.35, sigma: 0.16, amp: -34 },
        { theta: 1.72, sigma: 0.16, amp: 30 },
      ],
      widthProfile: [
        [0.0, 19],        // start/finish straight — widest
        [1.35, 14.5],     // chicane pinch
        [3.05, 12.5],     // hairpin
        [4.30, 17],
        [4.85, 20.5],     // banked sweeper opens up
        [5.60, 17],
      ],
      count: 108,
    }),
    theme: {
      key: 'coast',
      timeOfDay: 'goldenHour',
      sunAzimuth: -0.62,
      sunElevation: 0.175,
      sunColor: 0xffd9a0,
      // `sunStrength` is absolute irradiance; the atmosphere's own `sunScale`
      // multiplies it, and `exposureTarget` divides through. Their product is
      // what reaches the tone mapper — see tools/skyprobe.mjs.
      sunStrength: 4.25,
      exposureTarget: 0.46,
      // Multiplied by the preset's envScale (1.35) this lands on 1.0, which is
      // simply "believe the probe". The probe is the actual metered sky, so
      // anything below 1.0 is claiming the sky is dimmer than it was measured
      // to be. It had been 0.20, and under a 16-degree sun — which puts almost
      // no direct light on a flat road — that starved ambient was the whole
      // reason the tarmac read as a void.
      envIntensity: 0.74,
      ambientColor: 0x6a86b8,
      ambientIntensity: 0.16,
      water: { enabled: true, level: -9.5, color: 0x18506b, sunColor: 0xffd9a0 },
      groundColor: 0xc9b183,
      roadSurface: 'asphalt',
      // Pale, sun-bleached seaside tarmac. Measured: with the stock 0x4d4d54
      // the driving surface sat at 26/255 for the half of the lap that faces
      // away from a 16-degree sun, which is not a surface a player can read a
      // racing line on.
      roadTint: 0x7a7a83,
      shoulder: 'sand',
      offroad: 'sand',
      props: ['palm', 'rock', 'parasol', 'crowdStand', 'buoy', 'lighthouse'],
      grandstands: true,
    },
    // Positions are (arc fraction, lateral offset in road half-widths).
    itemBoxes: [
      { t: 0.07, lanes: [-0.55, -0.18, 0.18, 0.55] },
      { t: 0.29, lanes: [-0.45, 0, 0.45] },
      { t: 0.52, lanes: [-0.6, -0.2, 0.2, 0.6] },
      { t: 0.74, lanes: [-0.4, 0, 0.4] },
      { t: 0.90, lanes: [-0.5, -0.17, 0.17, 0.5] },
    ],
    boostPads: [
      { t: 0.185, lane: 0.0, length: 12 },
      { t: 0.425, lane: -0.35, length: 12 },
      { t: 0.615, lane: 0.35, length: 12 },
      { t: 0.845, lane: 0.0, length: 14 },
    ],
    // Jump ramps: (arc fraction, lateral, height, length)
    ramps: [
      { t: 0.335, lane: 0, height: 2.6, length: 20 },
      { t: 0.705, lane: 0, height: 3.2, length: 24 },
    ],
    startLineT: 0.0,
  },

  canyonRush: {
    id: 'canyonRush',
    name: 'Canyon Rush',
    subtitle: 'Desert Mesa Run',
    laps: 3,
    difficulty: 2,
    nodes: makeLoopNodes({
      base: 235,
      squash: 1.06,
      harmonics: [
        [1, 38, 2.1],
        [2, 44, 0.4],
        [3, 16, 1.7],
        [4, 12, -0.9],
      ],
      elevation: [
        [1, 16, 0.4],
        [2, 9, 2.6],
        [4, 3.4, 1.1],
      ],
      features: [
        { theta: 0.85, sigma: 0.18, amp: -68, rise: 6 },
        { theta: 2.40, sigma: 0.30, amp: 46, rise: -8 },
        { theta: 4.10, sigma: 0.17, amp: -58, rise: 4 },
        { theta: 5.35, sigma: 0.26, amp: 38, rise: -5 },
      ],
      widthProfile: [
        [0.0, 20],
        [0.85, 13],
        [2.40, 18],
        [4.10, 12.5],
        [5.35, 19],
      ],
      count: 112,
    }),
    theme: {
      key: 'canyon',
      timeOfDay: 'noon',
      sunAzimuth: 1.15,
      sunElevation: 0.62,
      sunColor: 0xfff0d8,
      // Noon in a desert genuinely is brighter than golden hour on a coast —
      // this lands ~30% hotter than sunsetCoast on purpose.
      sunStrength: 10.1,
      exposureTarget: 0.44,
      // As with the coast: envScale is 1.15 here, so this lands on 1.0 too.
      // The two daylight tracks now trust the probe by the same amount, and
      // only sun elevation and strength separate them.
      envIntensity: 0.87,
      ambientColor: 0x9ab4d8,
      ambientIntensity: 0.20,
      water: { enabled: false },
      groundColor: 0xb5714a,
      roadSurface: 'asphalt',
      shoulder: 'dirt',
      offroad: 'dirt',
      props: ['cactus', 'mesa', 'rock', 'crowdStand', 'archway'],
      grandstands: true,
    },
    itemBoxes: [
      { t: 0.10, lanes: [-0.55, -0.18, 0.18, 0.55] },
      { t: 0.33, lanes: [-0.45, 0, 0.45] },
      { t: 0.58, lanes: [-0.6, -0.2, 0.2, 0.6] },
      { t: 0.80, lanes: [-0.45, 0, 0.45] },
    ],
    boostPads: [
      { t: 0.22, lane: 0, length: 12 },
      { t: 0.47, lane: 0.3, length: 12 },
      { t: 0.69, lane: -0.3, length: 12 },
      { t: 0.92, lane: 0, length: 14 },
    ],
    ramps: [
      { t: 0.155, lane: 0, height: 3.6, length: 26 },
      { t: 0.615, lane: 0, height: 2.8, length: 22 },
    ],
    startLineT: 0.0,
  },

  rainbowSkyway: {
    id: 'rainbowSkyway',
    name: 'Rainbow Skyway',
    subtitle: 'Celestial Grand Prix',
    laps: 3,
    difficulty: 3,
    nodes: makeLoopNodes({
      base: 245,
      squash: 0.97,
      harmonics: [
        [1, 52, 1.2],
        [2, 26, 2.7],
        [3, 30, 0.15],
        [5, 11, 1.4],
      ],
      elevation: [
        [1, 30, 1.5],
        [2, 20, 0.2],
        [3, 11, 2.2],
        [5, 4, 0.8],
      ],
      features: [
        { theta: 1.90, sigma: 0.19, amp: -62, rise: 14 },
        { theta: 3.70, sigma: 0.28, amp: 44, rise: -18 },
        { theta: 5.50, sigma: 0.21, amp: -50, rise: 10 },
      ],
      widthProfile: [
        [0.0, 17],
        [1.90, 12],
        [3.70, 16],
        [5.50, 12.5],
      ],
      count: 116,
    }),
    theme: {
      key: 'rainbow',
      timeOfDay: 'space',
      sunAzimuth: -2.0,
      sunElevation: 0.30,
      sunColor: 0xc8d8ff,
      sunStrength: 3.00,
      exposureTarget: 0.90,
      envIntensity: 0.50,
      // A dark sky must not be metered: auto-exposure would open right up and
      // there would be no point setting a race in space.
      meterSky: false,
      ambientColor: 0x4a4a9a,
      ambientIntensity: 0.30,
      water: { enabled: false },
      groundColor: 0x0a0620,
      roadSurface: 'rainbow',
      shoulder: 'none',
      offroad: 'void',
      props: ['starfield', 'planet', 'neonPylon', 'ring'],
      grandstands: false,
      voidFall: true,
    },
    itemBoxes: [
      { t: 0.12, lanes: [-0.5, -0.17, 0.17, 0.5] },
      { t: 0.38, lanes: [-0.45, 0, 0.45] },
      { t: 0.63, lanes: [-0.55, -0.18, 0.18, 0.55] },
      { t: 0.86, lanes: [-0.45, 0, 0.45] },
    ],
    boostPads: [
      { t: 0.25, lane: 0, length: 14 },
      { t: 0.50, lane: 0, length: 14 },
      { t: 0.76, lane: 0, length: 14 },
    ],
    ramps: [
      { t: 0.30, lane: 0, height: 4.0, length: 28 },
      { t: 0.68, lane: 0, height: 4.5, length: 30 },
    ],
    startLineT: 0.0,
  },
};

export const TRACK_ORDER = ['sunsetCoast', 'canyonRush', 'rainbowSkyway'];

/** Surface constants shared by physics and audio. */
export const SURFACE = {
  ROAD:   { id: 0, grip: 1.00, speed: 1.00, drag: 0.0,  rumble: 0.00, dust: 0.0 },
  BOOST:  { id: 1, grip: 1.00, speed: 1.00, drag: 0.0,  rumble: 0.00, dust: 0.0 },
  CURB:   { id: 2, grip: 0.94, speed: 0.99, drag: 0.02, rumble: 1.00, dust: 0.1 },
  DIRT:   { id: 3, grip: 0.66, speed: 0.62, drag: 0.42, rumble: 0.55, dust: 1.0 },
  SAND:   { id: 4, grip: 0.58, speed: 0.55, drag: 0.55, rumble: 0.42, dust: 1.2 },
  GRASS:  { id: 5, grip: 0.72, speed: 0.68, drag: 0.36, rumble: 0.48, dust: 0.7 },
  VOID:   { id: 6, grip: 0.00, speed: 1.00, drag: 0.0,  rumble: 0.00, dust: 0.0 },
};

export function offroadSurfaceFor(themeKey) {
  switch (themeKey) {
    case 'coast': return SURFACE.SAND;
    case 'canyon': return SURFACE.DIRT;
    case 'rainbow': return SURFACE.VOID;
    default: return SURFACE.GRASS;
  }
}
