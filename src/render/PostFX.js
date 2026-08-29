import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp, clamp01, damp } from '../core/MathX.js';

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
    uniform vec2 uCenter;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    // Twelve taps, not six. The tap count and the amplitude are one setting:
    // six taps across a 63 px smear leaves 13 px between ghosts, which reads as
    // a stack of copies rather than as motion. See the amplitude note below.
    #define TAPS 12

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
      //
      // 0.085 was destroying the frame. At 99 km/h it put up to 63 px of smear
      // in the corners; measured, 82% of the frame's pixels changed and 190k of
      // them by more than 16/255. It erased the entire trackside world at
      // racing speed -- two rounds of scenery work present in the scene graph
      // and absent from the screen -- and it merged two karts 3.05 m apart into
      // one mass convincingly enough that a reviewer logged it as a physics bug
      // until a blur-off render disproved it. A post effect that manufactures
      // false collisions is not a post effect.
      float amt = uSpeed * smoothstep(0.10, 0.72, dist) * 0.026;
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
      col += uBoostFlash * smoothstep(0.15, 0.82, dist) * vec3(0.28, 0.55, 1.0);
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
    this._boostBase = 0;
    this._boostKick = 0;
    this._wasBoosting = false;
    this._cx = 0.5;
    this._cy = 0.5;
    this._hit = 0;
  }

  applyTheme(theme) {
    this.exposurePass.uniforms.uExposure.value = theme.exposure ?? 0.52;
    // Each locale gets its own grade rather than one global look. Bloom
    // thresholds are post-exposure, so 1.0 == screen white.
    switch (theme.key) {
      case 'coast':
        this.u.uGrain.value = 0.024;
        this.u.uSaturation.value = 1.16;
        this.u.uContrast.value = 1.08;
        this.u.uGain.value.setRGB(1.05, 0.995, 0.94);
        this.u.uLift.value.setRGB(0.008, 0.010, 0.020);
        this.bloom.strength = 0.16;
        this.bloom.threshold = 1.05;
        this.bloom.radius = 0.60;
        break;
      case 'canyon':
        this.u.uGrain.value = 0.022;
        this.u.uSaturation.value = 1.10;
        this.u.uContrast.value = 1.12;
        this.u.uGain.value.setRGB(1.03, 1.00, 0.95);
        this.u.uLift.value.setRGB(0.010, 0.008, 0.008);
        this.bloom.strength = 0.14;
        this.bloom.threshold = 1.10;
        this.bloom.radius = 0.52;
        break;
      case 'frost':
        this.u.uGrain.value = 0.020;
        // The lowest saturation and the highest contrast in the game, and both
        // for the same reason: a snowfield has no hue to push, so a punchy
        // grade only tints it. What separates a kart from the basin it is
        // driving across is *value*, so that is the axis that gets spent.
        this.u.uSaturation.value = 1.06;
        this.u.uContrast.value = 1.16;
        this.u.uGain.value.setRGB(0.985, 1.00, 1.05);
        this.u.uLift.value.setRGB(0.006, 0.010, 0.022);
        // Threshold above the snow, not below it.
        //
        // This is the Rainbow Skyway's bloom bug arrived at from the opposite
        // side. There the road was the brightest thing in the world and a
        // threshold under it bleached the circuit away; here the *ground* is,
        // at roughly 0.8 linear albedo against tarmac's 0.07. A coast-like
        // 1.05 puts the entire basin over the line and the frame turns to
        // paste. On the one track where the run-off is the brightest surface,
        // the threshold has to clear it.
        this.bloom.strength = 0.13;
        this.bloom.threshold = 1.24;
        this.bloom.radius = 0.55;
        break;
      case 'neon':
        // Grain is capped as a fraction of local luminance, and this frame is
        // mostly *dark* — the band where that cap is loosest. Held near the
        // Skyway's figure for the same reason.
        this.u.uGrain.value = 0.010;
        this.u.uSaturation.value = 1.22;
        // Lower than the daylight circuits. A night frame already has its
        // contrast: it is nearly all shadow with a few small bright sources,
        // and pushing it crushes everything that is not a light into black.
        this.u.uContrast.value = 1.04;
        this.u.uGain.value.setRGB(1.02, 0.99, 1.04);
        // The one lifted black point in the game. Night in a city is not
        // black — it is a very dark warm grey, and clamping it to zero is what
        // makes a night scene read as a switched-off one.
        this.u.uLift.value.setRGB(0.020, 0.016, 0.026);
        // Bloom is not a finishing touch here, it is the subject. Neon in
        // harbour haze *is* a halo, and the threshold sits low because the
        // things meant to bloom are small, bright and deliberate — signs,
        // lamps, lit windows — rather than a whole sunlit ground plane.
        this.bloom.strength = 0.42;
        this.bloom.threshold = 0.72;
        this.bloom.radius = 0.72;
        break;
      case 'rainbow':
        // A quarter of the others'. Grain is capped as a fraction of local
        // luminance, and this road sits squarely in the mid band where that cap
        // is loosest -- measured, 4.0% of a *stationary* frame was moving more
        // than 16/255 every 8.3 ms, twenty-six times sunsetCoast.
        this.u.uGrain.value = 0.007;
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

    // The radial blur's origin. `uCenter` was set to (0.5, 0.5) at construction
    // and never written again, so the frame always smeared away from the
    // crosshair no matter where the road went — most obviously on a fast
    // sweeper, where the world streaks symmetrically while the kart is clearly
    // travelling to one side. Damped, and clamped well inside the frame so a
    // corner exit cannot throw the origin off-screen and invert the streaks.
    if (state.center) {
      this._cx = damp(this._cx, clamp(state.center[0], 0.22, 0.78), 5, dt);
      this._cy = damp(this._cy, clamp(state.center[1], 0.25, 0.75), 5, dt);
      this.u.uCenter.value.set(this._cx, this._cy);
    }

    // A boost has two phases and this only ever had one. The sustained level
    // says "you are going fast"; the transient at the moment it engages says
    // "you just got faster", and that punch is the entire reward. Measured on a
    // 108-to-143 km/h boost, the old flat 0.10 contributed +22/255 at the frame
    // corner and exactly zero in the centre 200 px — for the biggest payoff in
    // the game. The kick decays in about half a second, like the FOV kick it
    // is paired with.
    if (state.boosting && !this._wasBoosting) this._boostKick = 1;
    this._wasBoosting = !!state.boosting;
    this._boostKick = damp(this._boostKick, 0, 4.5, dt);
    // Weighted hard toward the transient. The drift fix made mini-turbos
    // frequent, so `boosting` is now a common state rather than an occasional
    // one — and a strong sustained tint on a common state stops reading as a
    // reward and starts reading as a filter over the whole game. Measured:
    // holding the sustained level at 0.13 took canyonRush frames from luma
    // 0.50 to 0.64 and dropped saturation from 0.30 to 0.18.
    // The sustained level and the transient are kept in separate accumulators.
    // Folding the kick into `_boost` and then damping `_boost` toward the
    // target next frame feeds the kick back into itself: traced across one
    // onset that compounded a 0.335 ceiling into a measured peak of 0.764.
    this._boostBase = damp(this._boostBase, state.boosting ? 0.075 : 0, state.boosting ? 14 : 5, dt);
    this._boost = this._boostBase + this._boostKick * 0.26;
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
