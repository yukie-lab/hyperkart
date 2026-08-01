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
