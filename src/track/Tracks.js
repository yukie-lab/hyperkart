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
      fill: 0.045,
      // `drop` is metres below the circuit's lowest point, not an absolute
      // height: the layout is free to move without stranding the sea.
      water: { enabled: true, drop: 11.5, color: 0x18506b, sunColor: 0xffd9a0 },
      // Land beyond the barrier falls away to the water rather than climbing
      // into walls. Read by TrackBuilder's terrain profile.
      terrain: 'shore',
      groundColor: 0xc9b183,
      roadSurface: 'asphalt',
      // Pale, sun-bleached seaside tarmac. Measured: with the stock 0x4d4d54
      // the driving surface sat at 26/255 for the half of the lap that faces
      // away from a 16-degree sun, which is not a surface a player can read a
      // racing line on.
      roadTint: 0x7a7a83,
      shoulder: 'sand',
      offroad: 'sand',
      // Named builders, in build order. See `PROP_BUILDERS` in Scenery.js —
      // the scatter shares one RNG stream, so this order places the props.
      props: ['coastBackdrop', 'coastCover', 'palms', 'coastRocks',
              'parasols', 'driftwood', 'buoysAndBoats', 'lighthouse'],
      grandstands: {
        at: [0.0, 0.235, 0.50, 0.735],
        crowd: 40,
        flags: [0xe2483c, 0xffcf3d, 0x7fd4ff, 0xffffff, 0x2b8a63],
      },
      signage: { sponsors: 'coast', gantries: [0.0, 0.42] },
      verge: 0xd23c33,
      barrierAccent: 0xe2483c,
      birds: { count: 30, color: 0xf2e6d8, radius: 330, height: 60 },
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
      fill: 0.045,
      water: { enabled: false },
      // Land beyond the barrier climbs into mesa walls that box the circuit in.
      terrain: 'walled',
      groundColor: 0xb5714a,
      roadSurface: 'asphalt',
      shoulder: 'dirt',
      offroad: 'dirt',
      props: ['canyonBackdrop', 'mesas', 'canyonCover', 'cacti',
              'canyonRocks', 'telegraphLine', 'rockArch'],
      rockArches: [0.30, 0.72],
      grandstands: {
        at: [0.0, 0.26, 0.545, 0.80],
        crowd: 40,
        flags: [0xc9541f, 0xf0a63c, 0xffffff, 0x2f3d52, 0xffe3a8],
      },
      signage: { sponsors: 'canyon', gantries: [0.0, 0.47] },
      verge: 0xdb8a2a,
      barrierAccent: 0xdb8a2a,
      birds: { count: 20, color: 0x3a2e26, radius: 300, height: 78 },
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

  frostlineBasin: {
    id: 'frostlineBasin',
    name: 'Frostline Basin',
    subtitle: 'Alpine Ice Circuit',
    laps: 3,
    difficulty: 3,
    /**
     * The layout is built around one number: the road's grip is 0.80, not 1.0.
     *
     * Steering authority and acceleration both scale with it, so this circuit
     * turns roughly a fifth less than the others for the same input. The
     * answer is width, not gentler corners — a slippery road that is also
     * narrow is a road you hit walls on, which is punishment rather than
     * character. So the minimum width here is 15 m against 12-12.5 m on the
     * other three, the corners are long and open, and there is exactly one
     * genuinely tight turn in the lap for the width to be worth having.
     */
    nodes: makeLoopNodes({
      base: 222,
      squash: 1.00,
      harmonics: [
        [1, 40, 1.9],
        [2, 34, 0.9],
        [3, 14, 2.6],
      ],
      // Half the canyon's relief. A basin floor is not a mesa range, and on a
      // low-grip surface a crest that unloads the kart mid-corner is the one
      // combination a player cannot read in advance.
      elevation: [
        [1, 11, 1.0],
        [2, 6, 2.2],
        [3, -3, 0.5],
      ],
      features: [
        // The long outer sweeper, taken flat. This is the corner the whole
        // layout exists to set up: wide, banked away from the lake, and long
        // enough that a drift held through it is worth a full charge.
        { theta: 1.15, sigma: 0.30, amp: 48, rise: 4 },
        // Compound descent to the lake shore, and the tightest point of the
        // lap — the geometry report puts its apex at t=0.412. Opened from a
        // 17 m radius: with steering authority scaled by the road's 0.80 grip
        // that corner asked for 1.01 rad/s against 1.72 available, and 10% of
        // the lap sat within a whisker of it. The other three circuits run a
        // 2.3x margin at their worst corner.
        { theta: 2.65, sigma: 0.265, amp: -43, rise: -6 },
        // The second-tightest, and the one the lap's long drift is taken
        // through. Left alone: at 43 m it is well inside what 0.80 grip can
        // point, and it is the only place on the circuit that asks a driver
        // to actually slow down.
        { theta: 4.40, sigma: 0.19, amp: -60, rise: 3 },
        { theta: 5.40, sigma: 0.28, amp: 40, rise: -4 },
      ],
      widthProfile: [
        [0.0, 21],
        [1.15, 23],       // the sweeper is the widest road in the game
        [2.65, 17],       // the descent: narrowest, because it is the apex
        [4.40, 18],
        [5.40, 20],
      ],
      count: 110,
    }),
    theme: {
      key: 'frost',
      timeOfDay: 'overcast',
      sunAzimuth: 2.35,
      sunElevation: 0.22,
      sunColor: 0xfff2e4,
      // x the preset's sunScale 1.60 = 8.96, just under the coast's 9.99. A
      // soft key on purpose: hard shadows on snow are a clear-day phenomenon
      // and this is a cloud deck.
      sunStrength: 5.60,
      // The lowest in the game, and the one number this whole track hangs on.
      // Snow is ~0.8 linear albedo against sand's 0.5 and tarmac's 0.07, so
      // metering the sky where the coast does would put the *ground* on the
      // shoulder of the tone curve and leave the karts nowhere to go.
      exposureTarget: 0.40,
      // x envScale 1.25 = 1.0: believe the probe, exactly as the other two
      // daylight circuits do.
      envIntensity: 0.80,
      ambientColor: 0xa8c2e0,
      // Twice the coast's. This is where snow's bounce is bought — the
      // hemisphere light's ground colour is the snow itself, so it is the one
      // term in the lighting rig that actually represents light coming back
      // *up* off the world. The environment probe is generated from the sky
      // dome alone and contains none of it.
      ambientIntensity: 0.34,
      fill: 0.055,
      water: { enabled: false },
      // A bowl, which is what a basin is: the ground rises on every side, so
      // the pines and the lodges have real slopes to stand on and the peaks on
      // the horizon are the top of ground the player can see all the way up.
      //
      // `shore` was tried first, for a frozen lake. It falls away on *both*
      // sides of the road — the terrain profile is a function of distance from
      // the barrier and knows nothing about inside and outside — so it puts
      // water in the middle of the loop as well as around it, and drowns the
      // entire mid layer this circuit's depth depends on.
      terrain: 'walled',
      terrainSeed: 7717,
      groundColor: 0xe6edf6,
      roadSurface: 'ice',
      // Mid-tone, and deliberately the darkest driving surface in the game
      // after tarmac. The run-off beside it is near-white; if the road is pale
      // too there is no value separation anywhere in the frame and no exposure
      // recovers it, because exposure moves both. See ProcTex.ice.
      roadTint: 0x76889a,
      shoulder: 'snow',
      offroad: 'snow',
      props: ['frostBackdrop', 'frostCover', 'pines', 'frostRocks', 'chalets', 'snowBanks'],
      grandstands: {
        at: [0.0, 0.28, 0.56, 0.81],
        crowd: 40,
        flags: [0x2f6f9e, 0xe8eef5, 0xc23b46, 0x1d3145, 0xf0c05a],
      },
      signage: { sponsors: 'frost', gantries: [0.0, 0.45] },
      verge: 0x2f6f9e,
      barrierAccent: 0x2f6f9e,
      // Few, high and dark: the only things in the sky, and the only dark
      // shapes above the horizon line.
      birds: { count: 14, color: 0x2a2f38, radius: 300, height: 92 },
    },
    itemBoxes: [
      { t: 0.09, lanes: [-0.6, -0.2, 0.2, 0.6] },
      { t: 0.31, lanes: [-0.5, 0, 0.5] },
      { t: 0.55, lanes: [-0.62, -0.21, 0.21, 0.62] },
      { t: 0.78, lanes: [-0.5, 0, 0.5] },
      { t: 0.93, lanes: [-0.45, 0, 0.45] },
    ],
    // One more than the other circuits, and two of them in the corners rather
    // than on the straights. A boost on ice is the only way to make up the
    // exit speed the surface takes away, so this is where the lap time is.
    boostPads: [
      { t: 0.135, lane: 0.0, length: 13 },
      { t: 0.335, lane: 0.32, length: 12 },
      { t: 0.505, lane: -0.30, length: 12 },
      { t: 0.715, lane: 0.0, length: 14 },
      { t: 0.885, lane: 0.0, length: 14 },
    ],
    // Low and long. A big launch onto a surface that cannot be steered on
    // landing is a corner taken blind, so these lift the kart rather than
    // throwing it.
    ramps: [
      { t: 0.225, lane: 0, height: 2.4, length: 24 },
      { t: 0.635, lane: 0, height: 2.8, length: 26 },
    ],
    startLineT: 0.0,
  },

  neonHarbor: {
    id: 'neonHarbor',
    name: 'Neon Harbor',
    subtitle: 'Waterfront Night Race',
    laps: 3,
    difficulty: 4,
    /**
     * A street circuit, and the difference is the *number* of corners rather
     * than their severity. Seven features against the four or five the other
     * circuits carry, at amplitudes inside the range they already use — the
     * geometry report puts the worst corner at 0.93 rad/s, the same figure as
     * Sunset Coast and Rainbow Skyway, so nothing here is harder to point than
     * what the game already asks for. What is new is that they keep coming.
     *
     * The road is the narrowest in the game at 11.5 m, and the elevation is
     * the flattest: a harbour is built on reclaimed flat ground, and a street
     * circuit's walls are close because they are the actual walls of a street.
     */
    nodes: makeLoopNodes({
      base: 222,
      squash: 0.90,
      harmonics: [
        [1, 36, 0.7],
        [2, 30, 2.2],
        [3, 15, 0.3],
      ],
      // A tenth of the canyon's relief. There is a dock under this circuit.
      elevation: [
        [1, 5.0, 1.1],
        [2, 2.8, 0.2],
      ],
      features: [
        { theta: 0.42, sigma: 0.240, amp: -50 },   // turn 1, hard right off the quay
        { theta: 1.22, sigma: 0.300, amp:  36 },   // the long left round the basin
        { theta: 1.98, sigma: 0.221, amp: -52 },   // the tightest of the lap
        { theta: 2.72, sigma: 0.240, amp: -40 },
        { theta: 3.58, sigma: 0.324, amp:  42 },   // back straight, such as it is
        { theta: 4.46, sigma: 0.228, amp: -50 },
        { theta: 5.42, sigma: 0.276, amp:  30 },   // sweeper onto the start line
      ],
      widthProfile: [
        [0.0, 17],
        [0.42, 12],
        [1.98, 11.5],     // narrowest road in the game
        [3.58, 15.5],
        [4.46, 12],
        [5.42, 13.5],
      ],
      count: 116,
    }),
    theme: {
      key: 'neon',
      // Drives the star field and, with `meterSky`, the decision not to expose
      // for the dome. See SkySystem.
      timeOfDay: 'night',
      // The moon, and it is not the主 light source on this circuit — the city
      // is. Low and cool so it rakes the towers rather than lighting the road.
      sunAzimuth: 1.62,
      sunElevation: 0.30,
      sunColor: 0xc2cff2,
      // A moon, and it has to actually be one. At 3.20 — the figure the other
      // circuits' suns use — the key measured nine times the hemisphere light
      // and lit the terrain evenly to the horizon, which is a dusk scene with
      // a dark grade on it, not a night one. Everything about this circuit's
      // light comes from the city; the moon only puts a cool rim on what faces
      // it.
      sunStrength: 0.85,
      // Absolute, because the sky is not metered. Matched to the Skyway's
      // logic at a different hour: a dark dome sent through auto-exposure
      // opens all the way up and the night is gone.
      meterSky: false,
      exposureTarget: 0.86,
      // The probe is a night sky. There is little in it, but what there is —
      // the cool zenith and the warm dome on the horizon — is exactly the rim
      // that separates an unlit face from the sky behind it.
      envIntensity: 0.90,
      // The sky half of the hemisphere light: dark, cool, and almost nothing.
      ambientColor: 0x24345f,
      // The highest in the game, and the whole lighting design in one number.
      // A city at night is lit from *below* — every surface in frame is
      // catching sodium off wet ground and off its own signage — and the
      // hemisphere light's ground colour is where that lives. Rainbow Skyway
      // solved the same problem by making the road emit; a street circuit
      // cannot, so it buys the separation here instead.
      // `Lighting` scales the hemisphere light by the key, so an ambient this
      // far above the key's own strength is how a circuit says "the light here
      // does not come from the sky". It lands the hemisphere at ~0.57 against
      // the moon's 0.85 — the only track in the game where those two numbers
      // are close, and the reason it reads as a city rather than a field.
      ambientIntensity: 1.75,
      fill: 0.35,
      // A harbour basin. `drop` is small on purpose: the quay is barely above
      // the water, so the ground stays near track level out to ~70 m and gives
      // the dockside props somewhere flat to stand before it falls away.
      water: {
        enabled: true, drop: 4.0, color: 0x08131f, sunColor: 0xffb469,
        roughness: 0.07, clearcoatRoughness: 0.05, relief: 0.45, flow: 0.35,
      },
      terrain: 'shore',
      terrainSeed: 9137,
      // Wet dock concrete under sodium light. Warm, because it is also the
      // ground half of the hemisphere light and therefore the colour of every
      // bounce in the scene.
      // Wet dock concrete: grey, and cool. The *bounce* off it is not, because
      // what is falling on it is sodium — see `bounceColor`.
      groundColor: 0x33302e,
      bounceColor: 0xa8642c,
      // Named `wet` so the physics table is asked for it too — `surfaceNamed`
      // finds SURFACE.WET, while the mesh builder has no `wet` texture branch
      // and falls through to asphalt, which is exactly right: it is tarmac,
      // with water on it.
      roadSurface: 'wet',
      // Darker than any other circuit's tarmac. Water fills the voids between
      // the chippings, and a wet road is genuinely darker than a dry one —
      // which it can afford to be here, because what makes it readable is the
      // neon lying on it rather than the amount of light coming back off it.
      roadTint: 0x2e3138,
      // Drives the neon spill and the gloss in the road shader. See
      // TrackBuilder._asphaltWear — this is the only circuit with it above 0.
      roadWet: 1.0,
      shoulder: 'dirt',
      offroad: 'dirt',
      props: ['harbourBackdrop', 'cranes', 'harbourCover', 'containers', 'lightTowers'],
      grandstands: {
        at: [0.0, 0.30, 0.60, 0.84],
        crowd: 44,
        flags: [0xff2f8e, 0x24d6ff, 0xffc23c, 0xffffff, 0x8a4dff],
      },
      signage: { sponsors: 'neon', gantries: [0.0, 0.48] },
      verge: 0xff2f8e,
      barrierAccent: 0x24d6ff,
      birds: { count: 10, color: 0x14161c, radius: 260, height: 70 },
    },
    itemBoxes: [
      { t: 0.08, lanes: [-0.55, -0.18, 0.18, 0.55] },
      { t: 0.27, lanes: [-0.45, 0, 0.45] },
      { t: 0.46, lanes: [-0.58, -0.20, 0.20, 0.58] },
      { t: 0.66, lanes: [-0.45, 0, 0.45] },
      { t: 0.87, lanes: [-0.5, -0.17, 0.17, 0.5] },
    ],
    boostPads: [
      { t: 0.175, lane: 0.0, length: 12 },
      { t: 0.395, lane: -0.30, length: 12 },
      { t: 0.605, lane: 0.30, length: 12 },
      { t: 0.815, lane: 0.0, length: 13 },
    ],
    // One ramp, low. A street circuit's jump is a bridge expansion joint, not
    // a stunt, and this road is too narrow to land a big one on.
    ramps: [
      { t: 0.315, lane: 0, height: 2.0, length: 22 },
    ],
    startLineT: 0.0,
  },

  rainbowSkyway: {
    id: 'rainbowSkyway',
    name: 'Rainbow Skyway',
    subtitle: 'Celestial Grand Prix',
    laps: 3,
    difficulty: 5,
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
      // A dark *sky* is the point of setting a race in space. Dark *objects*
      // are not, and this track had both: the key ran at a third of the other
      // circuits and the ambient at half, so on-track frames measured a frame
      // luma of 0.19-0.24 with saturation at 0.69-0.89. That combination gives
      // hue-only separation and no value separation at all — a pink kart sat
      // at nearly the same luminance as the magenta stripe under it, and no
      // amount of exposure recovers that, because exposure moves both.
      //
      // A lit object against a black sky is exactly what space looks like, so
      // the key now lands where the daylight circuits do while the dome stays
      // unmetered and dark.
      sunStrength: 5.20,
      exposureTarget: 0.90,
      envIntensity: 0.85,
      // A dark sky must not be metered: auto-exposure would open right up and
      // there would be no point setting a race in space.
      meterSky: false,
      ambientColor: 0x4a4a9a,
      ambientIntensity: 0.30,
      // Twice the daylight circuits'. With no metered sky the probe delivers
      // almost no ambient, so the opposite-side fill is what keeps an unlit
      // face from going to black.
      fill: 0.10,
      water: { enabled: false },
      groundColor: 0x0a0620,
      roadSurface: 'rainbow',
      shoulder: 'none',
      offroad: 'void',
      props: ['planets', 'skyDust', 'shards', 'pylons',
              'skyRings', 'skyPlatforms', 'skyBanners'],
      skyRings: [0.10, 0.44, 0.79],
      // No hoardings, no grandstands, no verge, no gantries, no birds: there is
      // nothing out there for any of them to stand on.
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

// Ordered by difficulty, which is also the order the circuit picker and
// NEXT CIRCUIT walk in.
export const TRACK_ORDER = ['sunsetCoast', 'canyonRush', 'frostlineBasin', 'neonHarbor', 'rainbowSkyway'];

/**
 * Surface constants shared by physics and audio.
 *
 * `grip` is steering authority and acceleration, not a lateral friction limit —
 * this physics has none (see AIDriver). So a low-grip surface understeers; it
 * does not break away. That is what makes ICE safe to put under the *driving*
 * surface rather than only off it: the kart runs wide, which a player can read
 * and correct, instead of snapping around.
 */
export const SURFACE = {
  ROAD:   { id: 0, grip: 1.00, speed: 1.00, drag: 0.0,  rumble: 0.00, dust: 0.0 },
  BOOST:  { id: 1, grip: 1.00, speed: 1.00, drag: 0.0,  rumble: 0.00, dust: 0.0 },
  CURB:   { id: 2, grip: 0.94, speed: 0.99, drag: 0.02, rumble: 1.00, dust: 0.1 },
  DIRT:   { id: 3, grip: 0.66, speed: 0.62, drag: 0.42, rumble: 0.55, dust: 1.0 },
  SAND:   { id: 4, grip: 0.58, speed: 0.55, drag: 0.55, rumble: 0.42, dust: 1.2 },
  GRASS:  { id: 5, grip: 0.72, speed: 0.68, drag: 0.36, rumble: 0.48, dust: 0.7 },
  VOID:   { id: 6, grip: 0.00, speed: 1.00, drag: 0.0,  rumble: 0.00, dust: 0.0 },
  // Polished ice, as a *road* surface. Slightly faster than tarmac because
  // there is nothing to roll against, and appreciably harder to point.
  ICE:    { id: 7, grip: 0.80, speed: 1.02, drag: 0.0,  rumble: 0.04, dust: 0.0 },
  // Loose snow off the circuit: the most forgiving run-off in the game on
  // purpose, because the road it borders is already the least forgiving.
  SNOW:   { id: 8, grip: 0.74, speed: 0.66, drag: 0.34, rumble: 0.50, dust: 0.9 },
  // Standing water on tarmac. A light touch, deliberately: the low-grip
  // *circuit* is Frostline Basin's whole identity and 0.80 is its number, so
  // this is only enough that a road drawn as wet is not driven as dry.
  WET:    { id: 9, grip: 0.92, speed: 0.98, drag: 0.02, rumble: 0.02, dust: 0.0 },
};

/** Physics for a surface named by a theme (`offroad`, `shoulder`, `roadSurface`). */
export function surfaceNamed(name, fallback = SURFACE.GRASS) {
  return SURFACE[String(name || '').toUpperCase()] ?? fallback;
}

/**
 * What a kart drives on beyond the kerb.
 *
 * Keyed on `theme.offroad`, which is the field that already names the surface,
 * rather than on `theme.key`. Two fields that have to agree about one fact is
 * how `offroad: 'sand'` sat next to a switch that ignored it.
 */
export function offroadSurfaceFor(theme) {
  return surfaceNamed(theme?.offroad, SURFACE.GRASS);
}
