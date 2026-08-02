import * as THREE from 'three';
import { clamp } from '../core/MathX.js';

/**
 * WebGL renderer setup and the adaptive-resolution controller.
 *
 * Rather than shipping a fixed pixel ratio, the renderer watches frame time
 * and scales resolution between a floor and the display ratio. A kart game
 * has to hold its frame rate through the busiest moment on the track — twelve
 * karts, particles, and a full post chain — and dropping a few percent of
 * resolution is far less visible than a dropped frame.
 */

export const QUALITY_PRESETS = {
  low:    { pixelRatioCap: 1.0, msaa: 0, shadow: 'low',   bloom: true,  maxParticles: 900 },
  medium: { pixelRatioCap: 1.5, msaa: 2, shadow: 'high',  bloom: true,  maxParticles: 2000 },
  high:   { pixelRatioCap: 2.0, msaa: 4, shadow: 'high',  bloom: true,  maxParticles: 4000 },
  ultra:  { pixelRatioCap: 2.0, msaa: 4, shadow: 'ultra', bloom: true,  maxParticles: 7000 },
};

export class RenderSystem {
  constructor(container, opts = {}) {
    this.container = container;
    this.quality = opts.quality || 'high';
    const preset = QUALITY_PRESETS[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,           // MSAA happens on the composer target
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES over AgX: this is a bright, saturated arcade racer, and AgX's
    // filmic desaturation pulls the colour out of exactly the palette the
    // genre depends on.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // PCF, and deliberately so.
    //
    // PCFSoftShadowMap is deprecated and three substitutes this one for it, so
    // asking for it directly is the same picture without the warning. VSM was
    // tried — it is the only type that honours `shadow.radius`/`blurSamples` —
    // and rejected: the road is a large, gently curved surface lit at a
    // grazing angle, which is close to the worst case for variance shadows.
    // It came back covered in corduroy acne that no bias setting cleaned up
    // without also detaching every shadow from its caster. Compared side by
    // side at one simulation instant, PCF is plainly the better image.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The composer issues several passes per frame; auto-reset would leave
    // `info` describing only the final fullscreen quad.
    this.renderer.info.autoReset = false;

    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.35, 12000);

    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap);
    this.minPixelRatio = 0.72;
    this.currentPixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.currentPixelRatio);

    this._adaptAccum = 0;
    this._resizeObserver = null;
    this.onResize = null;

    this._bindResize();
    this.resize();
  }

  _bindResize() {
    const handler = () => this.resize();
    window.addEventListener('resize', handler);
    this._resizeHandler = handler;
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(handler);
      this._resizeObserver.observe(this.container);
    }
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.onResize?.(w, h);
  }

  /**
   * Nudge resolution toward the target frame budget. Deliberately slow to
   * react and slower to give resolution back, so it never oscillates
   * visibly during a race.
   */
  adaptResolution(dt, smoothedFrameMs, budgetMs = 16.0) {
    this._adaptAccum += dt;
    if (this._adaptAccum < 0.5) return;
    this._adaptAccum = 0;

    let next = this.currentPixelRatio;
    if (smoothedFrameMs > budgetMs * 1.22) next -= 0.10;
    else if (smoothedFrameMs < budgetMs * 0.78) next += 0.05;
    next = clamp(next, this.minPixelRatio, this.maxPixelRatio);

    if (Math.abs(next - this.currentPixelRatio) > 0.004) {
      this.currentPixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.onPixelRatioChange?.(next);
      this.resize();
    }
  }

  /**
   * Exposure lives in the post chain (applied before bloom so thresholds are
   * meaningful), so the tone mapper must not apply it a second time.
   */
  applyTheme() {
    this.renderer.toneMappingExposure = 1.0;
  }

  /** Call once per frame, immediately before rendering. */
  beginFrame() { this.renderer.info.reset(); }

  setQuality(q) {
    this.quality = q;
    const preset = QUALITY_PRESETS[q];
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap);
    this.currentPixelRatio = Math.min(this.currentPixelRatio, this.maxPixelRatio);
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.resize();
  }

  dispose() {
    window.removeEventListener('resize', this._resizeHandler);
    this._resizeObserver?.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
