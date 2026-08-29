import * as THREE from 'three';
import { makeRng, lerp, TAU } from '../core/MathX.js';
import { createSkyDome } from './SkyDome.js';
import { skyPresetFor } from './SkyPresets.js';

/** Times of day whose sky is dark enough to carry a star field. */
const DARK_HOURS = new Set(['space', 'night']);

/** Percentile of sky luminance that `exposureTarget` is placed at. */
const METER_PERCENTILE = 0.80;

/**
 * Sky, atmosphere and image-based lighting.
 *
 * The dome itself is authored (see `SkyPresets`) rather than simulated. A
 * Preetham sky is physically motivated but its Mie lobe at a low sun is a huge
 * near-white blob that eats the frame and leaves no colour to grade — the
 * opposite of what golden hour is supposed to look like.
 *
 * The environment map is generated from that dome via PMREM, so metal and
 * clearcoat surfaces reflect the actual sky of the track rather than a generic
 * studio probe. That single detail does more for perceived material quality
 * than any amount of texture work.
 */
export class SkySystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.sky = null;
    this.stars = null;
    this.envRT = null;
    this.skyRadiance = 1;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
  }

  /** Unit vector to the sun from azimuth (rad) and elevation (0..1 of 90°). */
  static sunVector(azimuth, elevation, out = new THREE.Vector3()) {
    const e = elevation * Math.PI * 0.5;
    return out.set(
      Math.cos(e) * Math.sin(azimuth),
      Math.sin(e),
      Math.cos(e) * Math.cos(azimuth),
    ).normalize();
  }

  build(theme) {
    this.dispose(false);
    this.theme = theme;
    this.preset = skyPresetFor(theme);
    SkySystem.sunVector(theme.sunAzimuth, theme.sunElevation, this.sunDirection);

    this.sky = createSkyDome(theme, this.sunDirection);
    this.scene.add(this.sky);
    // Stars belong to the hour, not to one circuit. Any theme that declares a
    // dark sky gets them.
    if (DARK_HOURS.has(theme.timeOfDay)) this._buildStars();

    // A deliberately dark sky must not be metered — auto-exposure would open
    // right up and destroy the point of setting a race in space. The theme
    // says so itself; it used to also be inferred from the track id, which is
    // two ways of stating one fact and only one of them portable.
    this.skyRadiance = theme.meterSky === false ? 1 : this._measureSkyRadiance();

    this._generateEnvironment();
    return this.sunDirection;
  }

  /** Exposure that places the metered sky at `theme.exposureTarget`. */
  get exposure() {
    return (this.theme?.exposureTarget ?? 0.5) / this.skyRadiance;
  }

  /**
   * Sun intensity expressed as a multiple of measured sky radiance, so the
   * sun-to-sky ratio an author picks survives any rescaling of the preset
   * table.
   */
  get sunIntensity() {
    return (this.theme?.sunStrength ?? 3.0) * (this.preset?.sunScale ?? 1) * this.skyRadiance;
  }

  /** Ambient IBL strength, in the same exposed units. */
  get envIntensity() {
    return (this.theme?.envIntensity ?? 0.5) * (this.preset?.envScale ?? 1);
  }

  _buildStars() {
    const rng = makeRng(4242);
    const count = 4200;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      // Uniform on a sphere.
      const u = rng() * 2 - 1, th = rng() * TAU;
      const r = Math.sqrt(1 - u * u);
      const R = 8000;
      pos[i * 3] = Math.cos(th) * r * R;
      pos[i * 3 + 1] = u * R;
      pos[i * 3 + 2] = Math.sin(th) * r * R;
      // Stellar colour: mostly white, some blue and amber.
      const t = rng();
      c.setHSL(t < 0.72 ? 0.58 : t < 0.88 ? 0.08 : 0.55, t < 0.72 ? 0.18 : 0.5, lerp(0.6, 1.0, rng()));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      // 1.5-13 px. This was 6-52, which at 1080p is not a star, it is a
      // snowflake — and at that size the field covered 6.4% of every frame.
      size[i] = Math.pow(rng(), 3) * 11.5 + 1.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Depth-tested, unlike the dome. `transparent: true` puts these in the
      // transparent pass, which runs *after* all opaque geometry — so
      // `renderOrder` only sorts them against other transparents and does
      // nothing to hold them behind the world. With the test off they were
      // drawn on top of the road and the karts, which is why the track read as
      // having dirt on the lens. The dome writes no depth, so a star at
      // r = 8000 still passes against empty sky and fails against anything
      // real in front of it.
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSize;
        varying vec3 vColor;
        varying float vTwinkle;
        uniform float uTime;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize;
          vTwinkle = 0.75 + 0.25 * sin(uTime * 2.0 + position.x * 0.01 + position.z * 0.013);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vTwinkle;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          float a = smoothstep(1.0, 0.0, r);
          a *= a;
          // Cross-shaped diffraction spike for the brighter stars.
          float spike = max(0.0, 1.0 - abs(d.x) * 22.0) + max(0.0, 1.0 - abs(d.y) * 22.0);
          a += spike * 0.12 * smoothstep(0.6, 0.0, r);
          gl_FragColor = vec4(vColor * vTwinkle, a * vTwinkle);
        }`,
    });
    mat.vertexColors = true;
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;      // after the dome, before the world
    this.stars.name = 'stars';
    this.scene.add(this.stars);
    this.starMaterial = mat;
  }

  /**
   * Measure the dome's actual radiance so every other light in the scene can
   * be expressed relative to it.
   *
   * Metering the sky the way a camera does makes exposure, sun intensity and
   * IBL strength scale-free: the whole preset table can be multiplied by any
   * constant and the image on screen does not move. Hand-tuning those three
   * against absolute radiance values is guesswork that breaks the moment a
   * colour changes.
   *
   * A percentile rather than the mean, because the sun disc is orders of
   * magnitude brighter than the sky around it and would dominate an average.
   * And a *high* percentile rather than the median: a sunset dome has enormous
   * dynamic range, so the median sits far below the warm band that actually
   * fills the frame, and metering off it opens exposure up until the band
   * clips. At p80 the reading tracks the bright sky the player is looking at,
   * which is what has to stay off the clipping point.
   *
   * Because exposure and sun intensity are both derived from this number, it
   * cancels out of the sunlit ground entirely — moving it changes only how
   * bright the sky sits relative to the world.
   */
  _measureSkyRadiance() {
    if (!this.sky) return 1;
    const size = 32;
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
    });
    // Meter with the game camera's framing, not the whole dome. A chase
    // camera sits just above the road looking at the horizon, so the sky that
    // fills the frame is the bright near-horizon band — metering a hemisphere
    // instead weights the dark zenith heavily and opens exposure up by a stop,
    // which is exactly how a sunset ends up as a white wash.
    const cam = new THREE.PerspectiveCamera(58, 16 / 9, 1, 60000);
    const tmp = new THREE.Scene();
    const clone = this.sky.clone();
    clone.material = this.sky.material;
    clone.position.set(0, 0, 0);
    tmp.add(clone);

    const buf = new Uint16Array(size * size * 4);
    const lums = [];
    const prevTarget = this.renderer.getRenderTarget();

    // Eight azimuths, so a frame facing the sun and one facing away are both
    // in the average and neither alone sets exposure.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      cam.position.set(0, 0, 0);
      cam.lookAt(Math.sin(a) * 100, 11, Math.cos(a) * 100);
      this.renderer.setRenderTarget(rt);
      this.renderer.clear();
      this.renderer.render(tmp, cam);
      this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      for (let p = 0; p < size * size; p++) {
        const r = THREE.DataUtils.fromHalfFloat(buf[p * 4]);
        const g = THREE.DataUtils.fromHalfFloat(buf[p * 4 + 1]);
        const b = THREE.DataUtils.fromHalfFloat(buf[p * 4 + 2]);
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (isFinite(l) && l > 0) lums.push(l);
      }
    }

    this.renderer.setRenderTarget(prevTarget);
    rt.dispose();

    if (!lums.length) return 1;
    lums.sort((a, b) => a - b);
    return Math.max(lums[Math.floor(lums.length * METER_PERCENTILE)], 1e-4);
  }

  _generateEnvironment() {
    // Render the dome into a PMREM probe for IBL.
    if (this.envRT) this.envRT.dispose();
    const tmp = new THREE.Scene();
    if (this.sky) {
      const clone = this.sky.clone();
      clone.material = this.sky.material;
      clone.position.set(0, 0, 0);
      tmp.add(clone);
    }
    this.envRT = this.pmrem.fromScene(tmp, 0.02, 1, 30000);
    this.scene.environment = this.envRT.texture;
    // `envIntensity` is authored in exposed units: because exposure is derived
    // from the same measured radiance, the ambient contribution here works out
    // to `exposureTarget * envIntensity * albedo` on screen regardless of how
    // bright the preset table happens to be.
    this.scene.environmentIntensity = this.envIntensity;
    // The dome mesh stays in the scene and draws the background itself, so the
    // sun disc and gradient render at full resolution rather than through the
    // low-res probe.
    this.scene.background = null;
    this.envMap = this.envRT.texture;
    return this.envMap;
  }

  update(dt, time) {
    if (this.starMaterial) this.starMaterial.uniforms.uTime.value = time;
    if (this.sky) this.sky.material.uniforms.uTime.value = time;
  }

  /** Keep the dome and stars centred on the camera. */
  follow(cameraPos) {
    if (this.sky) this.sky.position.copy(cameraPos);
    if (this.stars) this.stars.position.copy(cameraPos);
  }

  dispose(full = true) {
    for (const o of [this.sky, this.stars]) {
      if (!o) continue;
      this.scene.remove(o);
      o.traverse?.((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
      });
    }
    this.sky = this.stars = null;
    this.starMaterial = null;
    if (full) {
      if (this.envRT) this.envRT.dispose();
      this.pmrem.dispose();
    }
  }
}
