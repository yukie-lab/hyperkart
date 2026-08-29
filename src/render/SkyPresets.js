import * as THREE from 'three';

/**
 * Art-directed atmosphere presets.
 *
 * The Preetham model this replaces is physically motivated but almost
 * impossible to art-direct: at a low sun its Mie lobe is an enormous, nearly
 * white blob that eats half the frame, and its zenith never gets dark enough
 * to read as "evening". A kart racer wants the *look* of golden hour, not its
 * radiometry — a deep blue zenith, a warm band, a hot horizon, and clouds with
 * a visible lit side. So the sky is authored directly.
 *
 * All colours are scene-linear radiance and may exceed 1. Only the *ratios*
 * matter: `SkySystem` meters the dome and derives exposure from it, so the
 * whole table can be scaled freely without changing the image.
 *
 * The tonal ladder each preset aims for, in post-exposure units
 * (1.0 == screen white before ACES):
 *
 *   zenith      ~0.08   deep, saturated, clearly blue
 *   upper sky   ~0.25
 *   horizon     ~0.70   bright but still holding colour
 *   sun horizon ~1.20   hot, on the shoulder of the tone curve
 *   sun glow    ~1.80   blooms
 *   sun disc    clipped
 *
 * Shared by SkySystem (dome + IBL), Lighting (fog + light colour) and PostFX
 * (aerial perspective + god rays) so all three agree on one atmosphere.
 */

const DEFAULTS = {
  // -- dome gradient --------------------------------------------------------
  zenith: [0.030, 0.075, 0.235],
  upper: [0.105, 0.205, 0.455],
  horizon: [0.62, 0.56, 0.60],
  sunHorizon: [1.75, 0.80, 0.30],
  sunWash: [1.30, 0.55, 0.22],
  sunGlow: [2.60, 1.10, 0.38],
  sunDisc: [24.0, 14.0, 6.0],
  groundHaze: [0.24, 0.20, 0.22],

  gradLow: 0.30,        // horizon -> upper crossover
  gradHighA: 0.16,      // upper -> zenith ramp start
  gradHighB: 0.80,
  washPower: 3.0,       // azimuthal tightness of the warm band
  washFalloff: 6.5,     // vertical falloff of the warm band
  washStrength: 1.0,
  glowTight: 1.8,       // radiance of the tight halo ring
  glowBroad: 0.55,
  sunSize: 0.030,       // angular radius, radians (real sun is 0.0046)
  hazeFalloff: 16.0,    // how fast the horizon haze band decays with height
  hazeStrength: 0.55,

  // -- clouds ---------------------------------------------------------------
  cloudLit: [2.30, 1.80, 1.45],
  cloudShadow: [0.30, 0.27, 0.42],
  cloudRim: [4.00, 2.10, 0.85],
  cloudCoverage: 0.46,
  cloudSharp: 0.22,
  cloudScale: 0.00042,
  cloudHeight: 1400,
  cloudOpacity: 0.92,
  cloudSpeed: 0.0035,
  cloudLightGain: 5.0,
  cirrusStrength: 0.35,
  cirrusCoverage: 0.56,
  cirrusScale: 0.00016,
  cirrusHeight: 4200,

  // -- how the dome drives the rest of the frame ----------------------------
  sunScale: 1.0,        // multiplies theme.sunStrength
  envScale: 1.0,        // multiplies theme.envIntensity
  fogColor: [0.60, 0.55, 0.60],
  fogDensity: 0.00120,
  fogSunColor: [1.90, 1.00, 0.45],

  // -- post atmosphere ------------------------------------------------------
  inscatter: 0.55,      // strength of sun-tinted aerial perspective
  inscatterDensity: 0.0016,
  inscatterPower: 7.0,
  godray: 0.42,
  godrayLength: 0.85,
  aoStrength: 0.55,
};

export const SKY_PRESETS = {
  /**
   * Sunset Coast — golden hour over water. The sun sits ~16 deg up, so the
   * warm band is low and wide and the zenith is allowed to go properly deep.
   */
  coast: {
    zenith: [0.026, 0.068, 0.245],
    upper: [0.100, 0.195, 0.470],
    // Dusty rose rather than pale grey: the horizon is the largest single
    // area of sky in a chase-camera frame, so whatever colour it holds is the
    // colour the whole image reads as.
    horizon: [0.66, 0.44, 0.46],
    sunHorizon: [1.85, 0.78, 0.28],
    sunWash: [1.45, 0.56, 0.20],
    sunGlow: [2.90, 1.15, 0.36],
    sunDisc: [26.0, 14.0, 5.5],
    groundHaze: [0.26, 0.20, 0.24],
    gradLow: 0.26,
    gradHighA: 0.14,
    gradHighB: 0.85,
    washPower: 2.2,
    washFalloff: 5.0,
    washStrength: 1.0,
    glowTight: 2.0,
    // The broad halo is the one term that touches most of the frame, so it is
    // kept low: it is what turns a sunset into a white veil if it drifts up.
    glowBroad: 0.30,
    sunSize: 0.034,
    hazeFalloff: 20.0,
    hazeStrength: 0.40,

    cloudLit: [2.60, 1.95, 1.55],
    cloudShadow: [0.30, 0.26, 0.44],
    cloudRim: [4.60, 2.30, 0.90],
    cloudCoverage: 0.34,
    cloudSharp: 0.20,
    cloudScale: 0.00040,
    cloudHeight: 1500,
    cloudOpacity: 0.95,
    cloudSpeed: 0.0030,
    cirrusStrength: 0.28,
    cirrusCoverage: 0.52,

    sunScale: 2.35,
    envScale: 1.35,
    fogColor: [0.60, 0.52, 0.58],
    fogSunColor: [2.00, 0.95, 0.38],
    fogDensity: 0.00135,
    inscatter: 0.62,
    inscatterDensity: 0.0019,
    inscatterPower: 6.0,
    godray: 0.50,
    aoStrength: 0.60,
  },

  /**
   * Canyon Rush — high desert, sun at ~56 deg. Cobalt zenith, dusty warm
   * horizon, big scattered cumulus that give the mesas something to sit under.
   */
  canyon: {
    zenith: [0.048, 0.135, 0.500],
    upper: [0.130, 0.265, 0.610],
    horizon: [0.78, 0.66, 0.52],
    sunHorizon: [0.92, 0.80, 0.66],
    sunWash: [0.72, 0.60, 0.44],
    sunGlow: [1.70, 1.45, 1.10],
    sunDisc: [40.0, 36.0, 28.0],
    groundHaze: [0.34, 0.26, 0.20],
    gradLow: 0.20,
    gradHighA: 0.10,
    gradHighB: 0.72,
    washPower: 3.4,
    washFalloff: 7.0,
    washStrength: 0.75,
    glowTight: 1.5,
    glowBroad: 0.32,
    sunSize: 0.020,
    hazeFalloff: 20.0,
    hazeStrength: 0.55,

    cloudLit: [2.20, 2.10, 2.00],
    cloudShadow: [0.34, 0.38, 0.56],
    cloudRim: [2.60, 2.45, 2.20],
    cloudCoverage: 0.52,
    cloudSharp: 0.15,
    cloudScale: 0.00030,
    cloudHeight: 2200,
    cloudOpacity: 1.0,
    cloudSpeed: 0.0022,
    cirrusStrength: 0.22,
    cirrusCoverage: 0.60,

    sunScale: 1.35,
    envScale: 1.15,
    fogColor: [0.74, 0.62, 0.50],
    fogSunColor: [1.10, 0.95, 0.75],
    fogDensity: 0.00105,
    inscatter: 0.38,
    inscatterDensity: 0.0013,
    inscatterPower: 9.0,
    godray: 0.30,
    aoStrength: 0.70,
  },

  /**
   * Frostline Basin — winter daylight, sun at ~20 deg through high thin cloud.
   *
   * Two things make this preset different in kind from the other daylight
   * circuits, and both follow from one fact: the ground is brighter than the
   * sky for the first time in this game.
   *
   * A snowfield is about 0.8 linear albedo. Sand is 0.5 and tarmac is 0.07, so
   * every tuning instinct the other two tracks were built on is inverted here.
   * The sky is therefore metered *lower* (`exposureTarget` 0.40 against the
   * coast's 0.46) to leave the snow headroom, and the bloom threshold sits
   * above everything on the ground rather than below it — the same failure the
   * Rainbow Skyway's comment describes, arrived at from the other direction. A
   * threshold under the snow blooms the entire basin into a white paste and
   * takes the circuit with it.
   *
   * Colour is nearly all in the *sky*, because nothing on the ground has any.
   * A saturated grade on a white world reads as a colourised photograph, so
   * the separation this track lives on is value, not hue — which is also why
   * the road is the darkest driving surface in the game (see ProcTex.ice).
   */
  frost: {
    // Winter zenith is paler and less saturated than summer's: a low sun means
    // a long path, and the deep blue overhead never arrives.
    zenith: [0.052, 0.115, 0.330],
    upper: [0.135, 0.235, 0.465],
    // Milky rather than coloured. Cold air over a frozen basin holds ice fog,
    // and the horizon is the one part of the sky that shows it.
    horizon: [0.72, 0.74, 0.80],
    sunHorizon: [1.35, 1.20, 1.02],
    sunWash: [1.00, 0.90, 0.80],
    sunGlow: [1.95, 1.80, 1.62],
    sunDisc: [30.0, 28.0, 24.0],
    groundHaze: [0.40, 0.43, 0.50],
    gradLow: 0.30,
    gradHighA: 0.15,
    gradHighB: 0.78,
    // Wide and weak. Winter sun through cloud has no tight warm band — it has
    // a large pale area that is merely brighter than the rest of the sky.
    washPower: 1.8,
    washFalloff: 4.2,
    washStrength: 0.55,
    glowTight: 1.3,
    glowBroad: 0.42,
    sunSize: 0.038,
    hazeFalloff: 12.0,
    hazeStrength: 0.72,

    // Heavy, flat-bottomed and low-contrast: the cloud deck is the diffuser
    // that makes this light soft, so it has to actually cover the sky.
    cloudLit: [1.95, 1.98, 2.06],
    cloudShadow: [0.44, 0.48, 0.60],
    cloudRim: [2.30, 2.30, 2.40],
    cloudCoverage: 0.66,
    cloudSharp: 0.11,
    cloudScale: 0.00034,
    cloudHeight: 1150,
    cloudOpacity: 0.98,
    cloudSpeed: 0.0042,
    cirrusStrength: 0.40,
    cirrusCoverage: 0.70,
    cirrusScale: 0.00013,
    cirrusHeight: 3600,

    // A soft key: the sun-to-sky ratio is the lowest of the three daylight
    // circuits on purpose. Hard shadows on snow are a clear-day phenomenon and
    // this is not a clear day.
    sunScale: 1.60,
    // Lands theme.envIntensity 0.80 on 1.0, the same "believe the probe" the
    // other two daylight circuits arrive at. Snow's enormous bounce is *not*
    // bought here — the probe is generated from the dome alone and contains no
    // light coming back off the ground, so inflating it would be claiming the
    // sky is brighter than it was metered to be. It is bought in the hemisphere
    // light, whose ground colour is the snow itself. See the theme.
    envScale: 1.25,
    fogColor: [0.70, 0.73, 0.80],
    fogSunColor: [1.15, 1.10, 1.02],
    // Second only to the coast's, not first. A basin does trap cold air, and
    // this is the layer that separates a white foreground from a white
    // background — with no hue difference between them, aerial perspective is
    // the only cue left. But it was 0.00165, which is 82% opacity at 800 m: it
    // erased the bottom of the peak range and left the lit tops hanging in the
    // sky as detached slabs. Fog that removes the base of a landform does not
    // create distance, it creates floating objects.
    fogDensity: 0.00128,
    inscatter: 0.45,
    inscatterDensity: 0.0021,
    inscatterPower: 5.0,
    godray: 0.34,
    godrayLength: 0.95,
    aoStrength: 0.75,
  },

  /**
   * Neon Harbor — a city at night, which is not the same thing as darkness.
   *
   * The one fact this preset is built on: an urban night sky is not black. A
   * city throws enough light back at its own haze to raise a sodium dome over
   * the horizon that is an order of magnitude brighter than the zenith, and
   * that gradient is not decoration — it is the only thing a skyline can be
   * silhouetted *against*. Author a black sky and the towers vanish into it,
   * the frame loses its horizon, and the circuit is left floating in a void
   * with no sense of place. The Rainbow Skyway can afford a black sky because
   * its road emits; a street circuit cannot.
   *
   * That is also why the sky is not metered here. A dark dome sent through
   * auto-exposure opens all the way up and the night is gone, so the values
   * below are absolute — the same rule the Skyway plays by, for the same
   * reason, at a different hour.
   *
   * The key is a moon: cool, weak, and doing far less work than the city does.
   * Most of the light in frame is ambient, warm, and comes from below — see
   * `ambientIntensity` in the theme, which is the highest in the game.
   */
  neon: {
    // Deep and only just blue. Any more saturation and it reads as evening
    // rather than night; any less and it is a grey card.
    zenith: [0.007, 0.009, 0.030],
    upper: [0.019, 0.021, 0.055],
    // The light dome. Twenty times the zenith, and warm — this is sodium and
    // mercury vapour scattered back off haze, not sky.
    horizon: [0.068, 0.043, 0.034],
    sunHorizon: [0.145, 0.100, 0.080],
    sunWash: [0.105, 0.070, 0.058],
    // The moon's halo, and the one cool thing above the horizon.
    sunGlow: [0.52, 0.58, 0.86],
    sunDisc: [9.0, 9.6, 12.0],
    groundHaze: [0.052, 0.033, 0.027],
    // The dome's *shape* is the fix, not just its values. A light dome is a
    // band a few degrees deep sitting on the horizon; the first pass ran the
    // horizon colour more than half way to the zenith with a haze band seven
    // times too tall, and the result measured a sky brighter than the ground
    // under it — which is the one thing a night frame cannot be. The crossover
    // is now low and the dark zenith owns most of the sky.
    gradLow: 0.085,
    gradHighA: 0.035,
    gradHighB: 0.34,
    // Wide and weak: a light dome has no direction to speak of, it is simply
    // brighter towards the city. A tight warm band would read as a sunset.
    washPower: 1.4,
    washFalloff: 3.4,
    washStrength: 0.85,
    glowTight: 1.1,
    glowBroad: 0.22,
    // A moon is a quarter of a degree across and reads as a disc, not a blob.
    sunSize: 0.012,
    hazeFalloff: 18.0,
    hazeStrength: 0.38,

    // Cloud lit from *underneath* by the city. The dome shader keys its
    // lighting off the sun, so this is bought in the palette instead: a lit
    // side that is warm sodium rather than white, and a shadow side that
    // never goes properly dark because there is a city under it.
    // Measured: at 0.58 coverage these warm clouds owned most of the sky and
    // the frame read as dusk rather than night — the sky metered *brighter*
    // than the ground under it. A night sky needs the gaps: the dark blue
    // between the clouds is what says the light in them came from below.
    cloudLit: [0.185, 0.125, 0.092],
    cloudShadow: [0.030, 0.028, 0.046],
    cloudRim: [0.26, 0.175, 0.115],
    cloudCoverage: 0.34,
    cloudSharp: 0.13,
    cloudScale: 0.00036,
    cloudHeight: 900,
    cloudOpacity: 0.94,
    cloudSpeed: 0.0028,
    cirrusStrength: 0.16,
    cirrusCoverage: 0.44,

    sunScale: 1.0,
    envScale: 1.0,
    // A dark sky must not be metered: auto-exposure would open right up and
    // there would be no point setting a race at night.
    fogColor: [0.042, 0.034, 0.044],
    fogSunColor: [0.22, 0.20, 0.30],
    // Harbour air, and the reason every light in the scene has a halo rather
    // than a hard edge. It was 0.00140, which is 86% opacity at a kilometre —
    // enough to erase the lit skyline this circuit is built around, and, being
    // warm, to turn the whole distance into brown haze. Fog that removes the
    // subject is not atmosphere.
    fogDensity: 0.00072,
    inscatter: 0.30,
    inscatterDensity: 0.0015,
    inscatterPower: 4.0,
    godray: 0.16,
    aoStrength: 0.50,
  },

  /**
   * Rainbow Skyway — deep space. Not a gradient dome: a nebula field, a
   * galactic band and a cool key light. Metering is off for this theme (the
   * point of a dark sky is that it stays dark), so these values are absolute.
   */
  rainbow: {
    zenith: [0.006, 0.006, 0.030],
    upper: [0.014, 0.010, 0.052],
    horizon: [0.055, 0.020, 0.090],
    sunHorizon: [0.10, 0.06, 0.20],
    sunWash: [0.09, 0.05, 0.18],
    sunGlow: [0.55, 0.62, 1.10],
    sunDisc: [3.2, 3.6, 6.0],
    groundHaze: [0.010, 0.006, 0.026],
    sunSize: 0.018,

    nebula: {
      warm: [0.62, 0.14, 0.42],
      cool: [0.10, 0.26, 0.78],
      accent: [0.55, 0.18, 0.85],
      band: [0.34, 0.30, 0.62],
      // Sparse and dim on purpose. A nebula that covers the sky stops being a
      // nebula and becomes a background colour — the track has to be the
      // brightest thing in frame, not the second brightest.
      coverage: 0.34,
      scale: 0.55,
      strength: 0.55,
    },

    sunScale: 1.0,
    envScale: 1.0,
    fogColor: [0.030, 0.018, 0.075],
    fogSunColor: [0.30, 0.34, 0.75],
    fogDensity: 0.00042,
    inscatter: 0.25,
    inscatterDensity: 0.0009,
    inscatterPower: 5.0,
    godray: 0.20,
    aoStrength: 0.40,
  },
};

/** Merge a theme's preset over the defaults. */
export function skyPresetFor(theme) {
  return { ...DEFAULTS, ...(SKY_PRESETS[theme?.key] || {}) };
}

/** Scene-linear THREE.Color from a preset triplet (values may exceed 1). */
export function linColor(rgb) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
}

/** Effective sun/env multipliers, folded so callers never re-derive them. */
export function sunScaleFor(theme) { return skyPresetFor(theme).sunScale; }
export function envScaleFor(theme) { return skyPresetFor(theme).envScale; }
