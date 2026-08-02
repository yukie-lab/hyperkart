import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp01, damp } from '../core/MathX.js';

/**
 * Post-processing chain.
 *
 * Scene (HDR, 4x MSAA) -> Bloom -> Cinematic -> Output(tonemap + sRGB)
 *
 * Everything that would normally be four or five separate fullscreen passes —
 * radial speed blur, chromatic aberration, vignette, grain, colour grading —
 * is folded into one shader. At 4K that's the difference between one
 * bandwidth-bound pass and five.
 */

const CinematicShader = {
  name: 'CinematicShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },          // 0..1, drives radial blur + aberration
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uAberration: { value: 0.0009 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.028 },
    uSaturation: { value: 1.10 },
    uContrast: { value: 1.05 },
    uLift: { value: new THREE.Color(0.006, 0.008, 0.016) },
    uGain: { value: new THREE.Color(1.02, 1.00, 0.97) },
    uBoostFlash: { value: 0 },     // white/blue rim pulse when boosting
    uHitFlash: { value: 0 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uAberration, uVignette, uGrain;
    uniform float uSaturation, uContrast, uBoostFlash, uHitFlash;
    uniform vec2 uCenter, uResolution;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    #define TAPS 6

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 dir = vUv - uCenter;
      float dist = length(dir);

      // Radial motion blur: strength ramps from the centre outward so the
      // focal point stays readable while the periphery smears.
      float amt = uSpeed * smoothstep(0.10, 0.72, dist) * 0.085;
      // Chromatic aberration scales with the same radial term. Kept low: at the
      // previous strength a high-contrast edge near the frame border — a
      // barrier, a kerb — split into visibly separate red and cyan bands, which
      // reads as a broken image rather than as a lens.
      float ca = (uAberration + uSpeed * 0.0022) * smoothstep(0.05, 0.9, dist);

      vec3 acc = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < TAPS; i++) {
        float t = float(i) / float(TAPS - 1);
        float w = 1.0 - t * 0.55;
        vec2 base = vUv - dir * t * amt;
        // Per-channel radial offset gives the aberration for free inside the
        // same loop rather than costing a second pass.
        acc.r += texture2D(tDiffuse, base + dir * ca).r * w;
        acc.g += texture2D(tDiffuse, base).g * w;
        acc.b += texture2D(tDiffuse, base - dir * ca).b * w;
        wsum += w;
      }
      vec3 col = acc / wsum;

      // --- Grade (linear HDR) ------------------------------------------
      col = col * uGain + uLift;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.18) * uContrast + 0.18;
      col = max(col, vec3(0.0));

      // Boost rush: a cool rim brightening that reads as speed, not as a
      // flat white flash over the whole frame.
      col += uBoostFlash * smoothstep(0.18, 0.85, dist) * vec3(0.28, 0.55, 1.0);
      // The hit flash gets the same treatment the boost flash already had. Added
      // flat across every pixel it washed out the middle of the screen — which
      // is exactly where the player has to keep reading the road at the moment
      // they have just been hit and most need to recover.
      col += uHitFlash * smoothstep(0.06, 0.72, dist) * vec3(1.0, 0.55, 0.35);

      // --- Vignette ----------------------------------------------------
      float vig = smoothstep(0.92, 0.26, dist);
      col *= mix(1.0, vig, uVignette);

      // --- Grain -------------------------------------------------------
      // Weighted toward the shadows, like real film — but capped as a
      // *fraction* of local luminance, not as an absolute amount. Unbounded,
      // a fixed +-0.014 is a few percent on a mid-tone and a 28% modulation on
      // a surface sitting at 0.05, so the darkest thing in frame visibly boils
      // while everything else looks fine. The floor term keeps a trace of
      // grain in true black rather than a hard edge where it switches off.
      float g = hash(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5;
      float grainAmp = min(uGrain * (1.0 - smoothstep(0.0, 0.7, luma)), luma * 0.10 + 0.0015);
      col += g * grainAmp;

      gl_FragColor = vec4(col, 1.0);
    }`,
};

/**
 * Applies exposure *before* bloom.
 *
 * If exposure is left to the final tone-mapping pass, bloom thresholds are
 * expressed in raw scene radiance — so a threshold of 0.85 means "0.85 before
 * a 0.5x exposure", i.e. everything moderately lit blooms and the whole image
 * glows. Scaling first makes the threshold mean what it says: 1.0 is
 * screen-white.
 */
const ExposureShader = {
  name: 'ExposureShader',
  uniforms: { tDiffuse: { value: null }, uExposure: { value: 1 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
      // Clamp before bloom. The sun disc is orders of magnitude brighter than
      // anything else on screen, and letting it through unbounded makes the
      // bloom pass smear a white veil across the whole frame.
      c = min(c, vec3(4.0));
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled !== false;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: opts.msaa ?? 4,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.exposurePass = new ShaderPass(ExposureShader);
    this.composer.addPass(this.exposurePass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      opts.bloomStrength ?? 0.28,
      opts.bloomRadius ?? 0.55,
      opts.bloomThreshold ?? 1.0,
    );
    this.composer.addPass(this.bloom);

    this.cinematic = new ShaderPass(CinematicShader);
    this.composer.addPass(this.cinematic);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.u = this.cinematic.uniforms;
    this._speed = 0;
    this._boost = 0;
    this._hit = 0;
  }

  applyTheme(theme) {
    this.exposurePass.uniforms.uExposure.value = theme.exposure ?? 0.52;
    // Each locale gets its own grade rather than one global look. Bloom
    // thresholds are post-exposure, so 1.0 == screen white.
    switch (theme.key) {
      case 'coast':
        this.u.uSaturation.value = 1.16;
        this.u.uContrast.value = 1.08;
        this.u.uGain.value.setRGB(1.05, 0.995, 0.94);
        this.u.uLift.value.setRGB(0.008, 0.010, 0.020);
        this.bloom.strength = 0.16;
        this.bloom.threshold = 1.05;
        this.bloom.radius = 0.60;
        break;
      case 'canyon':
        this.u.uSaturation.value = 1.10;
        this.u.uContrast.value = 1.12;
        this.u.uGain.value.setRGB(1.03, 1.00, 0.95);
        this.u.uLift.value.setRGB(0.010, 0.008, 0.008);
        this.bloom.strength = 0.14;
        this.bloom.threshold = 1.10;
        this.bloom.radius = 0.52;
        break;
      case 'rainbow':
        // Was strength 0.42 / threshold 0.80 — roughly three times the other
        // tracks — which bleached the road's own emissive into a white haze
        // that erased the left quarter of the frame including the player kart.
        // On the one track where the road is the brightest thing in the world,
        // the bloom threshold has to sit *above* it, not below.
        this.u.uSaturation.value = 1.18;
        this.u.uContrast.value = 1.08;
        this.u.uGain.value.setRGB(1.00, 1.00, 1.06);
        this.u.uLift.value.setRGB(0.004, 0.004, 0.018);
        this.bloom.strength = 0.26;
        this.bloom.threshold = 1.02;
        this.bloom.radius = 0.70;
        break;
    }
  }

  setExposure(v) { this.exposurePass.uniforms.uExposure.value = v; }

  /**
   * @param {number} dt
   * @param {{speed01:number, boosting:boolean, hit:number, time:number}} state
   */
  update(dt, state) {
    // Speed effect is deliberately non-linear: nothing below ~55% of top
    // speed, then it ramps hard, so boosts feel like a step change.
    const target = Math.pow(clamp01((state.speed01 - 0.55) / 0.45), 1.6);
    this._speed = damp(this._speed, target, 6, dt);

    this._boost = damp(this._boost, state.boosting ? 0.10 : 0, state.boosting ? 12 : 4, dt);
    // Both flashes are added straight onto every pixel, so they are clamped to
    // their authored ceiling rather than trusted to decay — an out-of-range
    // value here whites out the whole frame.
    this._hit = clamp01(this._hit - dt * 2.2);
    if (state.hit) this._hit = Math.max(this._hit, clamp01(state.hit) * 0.35);

    this.u.uSpeed.value = this._speed;
    this.u.uBoostFlash.value = this._boost;
    this.u.uHitFlash.value = this._hit;
    this.u.uTime.value = state.time;
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.u.uResolution.value.set(w, h);
  }

  setPixelRatio(r) { this.composer.setPixelRatio(r); }

  render(dt) {
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.composer.dispose?.();
    this.bloom.dispose?.();
  }
}
