import * as THREE from 'three';
import { skyPresetFor, linColor } from './SkyPresets.js';

/**
 * The authored sky dome.
 *
 * One inside-out sphere carrying every part of the atmosphere the player ever
 * sees: the vertical gradient, the warm band around the sun's azimuth, the
 * halo and disc, the horizon haze, and two cloud layers. Doing it in a single
 * shader rather than a dome plus sprite cards means the clouds are actually
 * *in* the sky — they take the sun's azimuth into account, they have a lit
 * flank and a shadowed one, and they never show a quad edge.
 *
 * Every constant comes from `SkyPresets`, so the look is art-directed in one
 * table rather than spread across shader literals.
 *
 * The dome writes scene-linear radiance and is never tone-mapped here; the
 * output pass at the end of the post chain does that once, for the whole
 * frame.
 */

const DOME_RADIUS = 9000;

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    // Object space: the sphere is centred on the camera, so the vertex
    // position is the view direction.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = /* glsl */`
  precision highp float;

  varying vec3 vDir;

  uniform float uTime;
  uniform float uMode;          // 0 = atmosphere, 1 = space
  uniform vec3  uSunDir;

  uniform vec3  uZenith, uUpper, uHorizon, uSunHorizon, uSunWash, uSunGlow, uSunDisc, uGroundHaze;
  uniform float uGradLow, uGradHighA, uGradHighB;
  uniform float uWashPower, uWashFalloff, uWashStrength;
  uniform float uGlowTight, uGlowBroad, uSunSize;
  uniform float uHazeFalloff, uHazeStrength;

  uniform vec3  uCloudLit, uCloudShadow, uCloudRim;
  uniform float uCloudCoverage, uCloudSharp, uCloudScale, uCloudHeight;
  uniform float uCloudOpacity, uCloudSpeed, uCloudLightGain;
  uniform float uCirrusStrength, uCirrusCoverage, uCirrusScale, uCirrusHeight;

  uniform vec3  uNebWarm, uNebCool, uNebAccent, uNebBand;
  uniform float uNebCoverage, uNebScale, uNebStrength;

  // --- value noise ---------------------------------------------------------
  float hash1(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash1(i),               hash1(i + vec2(1.0, 0.0)), u.x),
               mix(hash1(i + vec2(0.0, 1.0)), hash1(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  // Rotating each octave stops the lattice of the value noise from showing up
  // as visible grid streaks across a large, slow-moving cloud deck.
  const mat2 ROT = mat2(1.62, 1.18, -1.18, 1.62);

  float fbm(vec2 p, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      sum += amp * vnoise(p);
      norm += amp;
      p = ROT * p;
      amp *= 0.5;
    }
    return sum / max(norm, 1e-4);
  }

  /**
   * One flat cloud layer, sampled where the view ray crosses its altitude.
   *
   * A plane intersection rather than a raymarch: at these altitudes and this
   * field of view the parallax a march would buy is invisible, and this costs
   * one noise stack instead of thirty.
   */
  vec4 cloudLayer(vec3 dir, vec2 sunAz, float az,
                  float height, float scale, float coverage, float sharp,
                  float opacity, float stretch, int octaves) {
    if (dir.y <= 0.012) return vec4(0.0);

    float t = height / dir.y;
    vec2 p = dir.xz * t * scale;
    p.x *= stretch;                                   // cirrus streak along the wind
    p += sunAz * uTime * uCloudSpeed;

    float n = fbm(p, octaves);
    // An fBm of value noise clusters tightly around 0.5, so thresholding it
    // directly gives a uniform veil over the whole dome rather than clouds.
    // Expanding around the mean first is what puts gaps between them.
    n = clamp((n - 0.5) * 2.6 + 0.5, 0.0, 1.0);
    float lo = 1.0 - coverage;
    float cov = smoothstep(lo - sharp, lo + sharp, n);
    if (cov <= 0.002) return vec4(0.0);

    // Shade by differencing the density field toward the sun: thinner that way
    // means we are looking at the lit flank, thicker means self-shadow.
    float ns = fbm(p + sunAz * 0.30, octaves - 1);
    float lit = clamp((ns - n) * uCloudLightGain * 0.5 + 0.5, 0.0, 1.0);
    // Seen from underneath, a deck is mostly in its own shadow — only the part
    // of the sky turned toward the sun actually catches the warm light. Without
    // this the whole dome lights up and the sunset reads as overcast noon.
    lit *= mix(0.30, 1.0, pow(az, 1.5));
    vec3 c = mix(uCloudShadow, uCloudLit, lit);

    // Thin edges facing the sun's azimuth burn out — the silver lining that
    // sells a backlit cloud.
    float edge = 4.0 * cov * (1.0 - cov);
    c += uCloudRim * edge * pow(az, 4.0);

    // Dissolve into the haze near the horizon rather than ending on a line.
    float fade = smoothstep(0.012, 0.15, dir.y);
    return vec4(c, cov * opacity * fade);
  }

  vec3 atmosphere(vec3 dir, vec2 sunAz, float az) {
    float h = dir.y;
    float hs = clamp(h, 0.0, 1.0);

    vec3 col = mix(uHorizon, uUpper, smoothstep(0.0, uGradLow, hs));
    col = mix(col, uZenith, smoothstep(uGradHighA, uGradHighB, hs));
    col = mix(col, uGroundHaze, smoothstep(0.0, -0.10, h));

    // Haze band hugging the horizon, warmer where it faces the sun.
    float haze = exp(-abs(h) * uHazeFalloff) * uHazeStrength;
    col = mix(col, mix(uHorizon, uSunHorizon, az * az), clamp(haze, 0.0, 1.0));

    // The warm band: wide in azimuth, decaying with height.
    float wash = pow(az, uWashPower) * exp(-hs * uWashFalloff) * uWashStrength;
    col = mix(col, uSunHorizon, clamp(wash, 0.0, 1.0));
    col += uSunWash * wash * 0.45;

    // Halo, then disc.
    float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
    col += uSunGlow * (exp(-ang * 22.0) * uGlowTight + exp(-ang * 2.8) * uGlowBroad);
    col = mix(col, uSunDisc, 1.0 - smoothstep(uSunSize * 0.80, uSunSize * 1.20, ang));

    // Clouds last: they are in front of the sun, and occluding it is the whole
    // reason the deck reads as having depth.
    vec4 cirrus = cloudLayer(dir, sunAz, az, uCirrusHeight, uCirrusScale,
                             uCirrusCoverage, 0.30, uCirrusStrength, 0.35, 4);
    col = mix(col, cirrus.rgb, cirrus.a);

    vec4 deck = cloudLayer(dir, sunAz, az, uCloudHeight, uCloudScale,
                           uCloudCoverage, uCloudSharp, uCloudOpacity, 1.0, 5);
    col = mix(col, deck.rgb, deck.a);

    return col;
  }

  /**
   * Seam-free noise over a view direction.
   *
   * Equirectangular coordinates put a hard discontinuity down the sky wherever
   * atan2 wraps from +pi to -pi, and an fBm sampled across that wrap draws it
   * as a straight vertical line from zenith to horizon — which is exactly what
   * the nebula was doing. Triplanar blending of three planar projections has
   * no wrap and no pole to pinch, at the cost of two extra noise stacks on a
   * dome that only the void track ever renders.
   */
  float domeFbm(vec3 d, float k, float off, int oct) {
    vec3 w = abs(d);
    w /= max(w.x + w.y + w.z, 1e-4);
    return fbm(d.yz * k + off, oct) * w.x
         + fbm(d.zx * k + off + 17.1, oct) * w.y
         + fbm(d.xy * k + off + 41.3, oct) * w.z;
  }

  vec3 space(vec3 dir, vec2 sunAz, float az) {
    float h = dir.y;
    float hs = clamp(h, 0.0, 1.0);

    vec3 col = mix(uHorizon, uUpper, smoothstep(0.0, uGradLow, hs));
    col = mix(col, uZenith, smoothstep(uGradHighA, uGradHighB, hs));
    col = mix(col, uGroundHaze, smoothstep(0.0, -0.15, h));

    float k = 7.2 / max(uNebScale, 1e-3);

    // Same expansion as the cloud layers: without it the nebula is a uniform
    // curtain over the whole dome and the sky stops reading as space at all.
    float n = clamp((domeFbm(dir, k, 0.0, 5) - 0.5) * 2.4 + 0.5, 0.0, 1.0);
    float m = domeFbm(dir, k * 1.7, 11.3, 4);
    float cloud = smoothstep(1.0 - uNebCoverage - 0.10, 1.0 - uNebCoverage + 0.18, n);

    vec3 neb = mix(uNebCool, uNebWarm, smoothstep(0.35, 0.75, m));
    neb = mix(neb, uNebAccent, smoothstep(0.62, 0.95, n) * 0.7);
    col += neb * cloud * uNebStrength;

    // Galactic band: a bright lane across one great circle of the sphere.
    float band = 1.0 - smoothstep(0.0, 0.26, abs(dot(dir, normalize(vec3(0.36, 0.56, -0.75)))));
    col += uNebBand * band * (0.25 + 0.75 * domeFbm(dir, k * 0.8, 4.0, 3)) * uNebStrength;

    float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
    col += uSunGlow * (exp(-ang * 20.0) * uGlowTight + exp(-ang * 3.2) * uGlowBroad);
    col = mix(col, uSunDisc, 1.0 - smoothstep(uSunSize * 0.80, uSunSize * 1.20, ang));

    return col;
  }

  void main() {
    vec3 dir = normalize(vDir);
    vec2 sunAz = normalize(vec2(uSunDir.x, uSunDir.z) + vec2(1e-5));
    float az = max(0.0, dot(normalize(vec2(dir.x, dir.z) + vec2(1e-5)), sunAz));

    vec3 col = uMode < 0.5 ? atmosphere(dir, sunAz, az) : space(dir, sunAz, az);
    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }`;

/**
 * Builds the dome mesh for a theme.
 * @param {object} theme  track theme (needs `key`)
 * @param {THREE.Vector3} sunDir  unit vector toward the sun
 */
export function createSkyDome(theme, sunDir) {
  const p = skyPresetFor(theme);
  const neb = p.nebula || {};

  const uniforms = {
    uTime: { value: 0 },
    uMode: { value: theme.key === 'rainbow' ? 1 : 0 },
    uSunDir: { value: sunDir.clone() },

    uZenith: { value: linColor(p.zenith) },
    uUpper: { value: linColor(p.upper) },
    uHorizon: { value: linColor(p.horizon) },
    uSunHorizon: { value: linColor(p.sunHorizon) },
    uSunWash: { value: linColor(p.sunWash) },
    uSunGlow: { value: linColor(p.sunGlow) },
    uSunDisc: { value: linColor(p.sunDisc) },
    uGroundHaze: { value: linColor(p.groundHaze) },

    uGradLow: { value: p.gradLow },
    uGradHighA: { value: p.gradHighA },
    uGradHighB: { value: p.gradHighB },
    uWashPower: { value: p.washPower },
    uWashFalloff: { value: p.washFalloff },
    uWashStrength: { value: p.washStrength },
    uGlowTight: { value: p.glowTight },
    uGlowBroad: { value: p.glowBroad },
    uSunSize: { value: p.sunSize },
    uHazeFalloff: { value: p.hazeFalloff },
    uHazeStrength: { value: p.hazeStrength },

    uCloudLit: { value: linColor(p.cloudLit) },
    uCloudShadow: { value: linColor(p.cloudShadow) },
    uCloudRim: { value: linColor(p.cloudRim) },
    uCloudCoverage: { value: p.cloudCoverage },
    uCloudSharp: { value: p.cloudSharp },
    uCloudScale: { value: p.cloudScale },
    uCloudHeight: { value: p.cloudHeight },
    uCloudOpacity: { value: p.cloudOpacity },
    uCloudSpeed: { value: p.cloudSpeed },
    uCloudLightGain: { value: p.cloudLightGain },
    uCirrusStrength: { value: p.cirrusStrength },
    uCirrusCoverage: { value: p.cirrusCoverage },
    uCirrusScale: { value: p.cirrusScale },
    uCirrusHeight: { value: p.cirrusHeight },

    uNebWarm: { value: linColor(neb.warm || [0, 0, 0]) },
    uNebCool: { value: linColor(neb.cool || [0, 0, 0]) },
    uNebAccent: { value: linColor(neb.accent || [0, 0, 0]) },
    uNebBand: { value: linColor(neb.band || [0, 0, 0]) },
    uNebCoverage: { value: neb.coverage ?? 0.5 },
    uNebScale: { value: neb.scale ?? 0.55 },
    uNebStrength: { value: neb.strength ?? 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    // Drawn first with no depth interaction at all, so the dome never fights
    // the far plane and never needs to be larger than the camera can see.
    depthTest: false,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 64, 40), material);
  mesh.name = 'skyDome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}
