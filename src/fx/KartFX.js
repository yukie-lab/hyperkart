import * as THREE from 'three';
import { ParticlePool, SHAPE } from './Particles.js';
import { DRIFT } from '../kart/KartTuning.js';
import { clamp01, lerp, makeRng, TAU } from '../core/MathX.js';

/**
 * All per-kart visual effects: drift sparks, tyre smoke, surface dust, exhaust,
 * boost flames, impact bursts and the ground shadow blob.
 *
 * Effects are budgeted: emission rates scale with the quality preset, and the
 * player's kart always gets the full rate while distant AI karts get a
 * fraction — the difference is invisible in motion and roughly halves the
 * particle count in a twelve-kart pack.
 *
 * Brightness is budgeted too, and that budget is the reason nothing here is
 * authored in "just make it bright" units. Exposure (~0.5) is applied *before*
 * bloom, so an additive stack summing past ~4 in scene-linear units lands past
 * 2.0 post-exposure — which ACES maps to 0.91 and bloom then smears over the
 * whole frame. Every plume below is therefore built as a small hot core, a
 * saturated coloured mid and a wide low-alpha outer, each with its own budget,
 * instead of one layer turned up until it reads.
 */

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _side = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Per-tier drift presentation. Rate, size, pulse frequency and streak fraction
 * all climb together: any one of them alone is a difference you have to look
 * for, and all four at once is a difference you see in peripheral vision.
 */
/**
 * Sizes here are the single most important numbers in the file. A spark is a
 * burning fleck a centimetre or two across; at chase-camera distance that is
 * ten to twenty pixels. Authoring them at "looks bright in isolation" sizes —
 * near a metre — makes fifty of them merge into one coloured cloud, which is
 * exactly how a stage reads as "some glow" instead of "purple sparks".
 */
const DRIFT_TIERS = [
  { rate: 110, size: 0.20, alpha: 1.60, glow: 0.40, glowA: 0.34, hz: 6.5, ring: 1.0, ringA: 0.28, streak: 0.16, strSize: 1.2, spread: 3.4, lift: 3.2 },
  { rate: 175, size: 0.27, alpha: 1.80, glow: 0.56, glowA: 0.40, hz: 9.5, ring: 1.5, ringA: 0.36, streak: 0.30, strSize: 1.7, spread: 4.4, lift: 4.0 },
  { rate: 245, size: 0.35, alpha: 2.00, glow: 0.74, glowA: 0.46, hz: 14.0, ring: 2.0, ringA: 0.44, streak: 0.44, strSize: 2.3, spread: 5.4, lift: 4.8 },
];

/**
 * Half-size of the sun's fitted shadow box, mirroring SHADOW_EXTENT in
 * render/Lighting.js. Karts outside it get no cast shadow at all, so the
 * contact patch has to carry the anchor on its own out there.
 */
const SHADOW_BOX = 78;

/** Dust colour per off-road surface id (see SURFACE in track/Tracks.js). */
const DUST_COLOR = { 2: 0xbdb6ad, 3: 0xa87c50, 4: 0xdcc79a, 5: 0x8f9a5e };

export class KartFX {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const budget = opts.maxParticles ?? 4000;

    // Two pools, two draw calls, whatever the effect. Shape is per-particle.
    this.additive = new ParticlePool(scene, {
      max: Math.round(budget * 0.62),
      blending: THREE.AdditiveBlending, renderOrder: 6, name: 'fx_additive',
      // Sparks may come close to the lens: they are small and additive, so a
      // short fade is enough and cutting them early would cost the boost trail.
      nearFade: [0.4, 1.8], maxPx: 640,
    });
    this.smoke = new ParticlePool(scene, {
      max: Math.round(budget * 0.38),
      blending: THREE.NormalBlending, renderOrder: 5, name: 'fx_smoke',
      // Opaque layers need a long runway. Everything the kart sheds sweeps
      // through the chase camera about a fifth of a second later, and a single
      // near puff of tyre smoke at full size is the white blob that has been
      // eating this frame since the beginning.
      nearFade: [1.2, 6.0], maxPx: 300,
    });
    // House rule for everything that goes in the smoke pool: no puff may end
    // its life much wider than about two metres. Normal-blended layers compound
    // toward opaque, so a handful of six-metre puffs — which is what a generous
    // `sizeGrow` quietly produces — is a solid white disc sitting on the road
    // whatever each one's alpha says.
    // The pools need the camera basis for the soft ground fade, and the only
    // place the camera is guaranteed current is the draw itself.
    for (const pool of [this.additive, this.smoke]) {
      pool.points.onBeforeRender = (renderer, sc, camera) => pool.setCamera(camera, this._time);
    }

    this.rng = makeRng(9001);
    this._accum = new WeakMap();
    this._fx = new WeakMap();
    this._karts = null;
    this._time = 0;
    this._playerPos = null;
    this.quality = opts.quality || 'high';

    this._buildShadowBlob();
    // Items and anything else that needs to emit can find the FX layer here
    // rather than the race director having to thread it through by hand.
    scene.userData.kartFX = this;
  }

  _buildShadowBlob() {
    // A contact-darkening patch under the tyres — *not* a second copy of the
    // kart's shadow.
    //
    // The shadow map already draws the silhouette. When this quad also drew one
    // the two multiplied, and shaded road landed near 0.03 display luminance
    // while lit road beside it sat at 0.4: a hole with the road's aggregate
    // speckle crawling inside it. So this is now small, soft, and tinted the
    // colour ground actually takes in daylight shade rather than black —
    // nothing outdoors is lit by nothing, and a black multiply is what reads as
    // a hole instead of a shadow.
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2;
        // Slightly elongated along the kart's length.
        const r = Math.hypot(dx * 1.12, dy * 0.88);
        // Steeper than a linear falloff so the dark part stays under the
        // chassis and the edge is gone well before the silhouette would be.
        const a = Math.pow(clamp01(1 - r), 2.6);
        const i = (y * size + x) * 4;
        // White texel, tint from material.color: a black texel would make the
        // colour below meaningless.
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.blobTex = new THREE.CanvasTexture(c);
    this.blobGeo = new THREE.PlaneGeometry(2.3, 2.9);
    this.blobGeo.rotateX(-Math.PI / 2);
    this.blobMat = new THREE.MeshBasicMaterial({
      map: this.blobTex, transparent: true, depthWrite: false,
      // Linear scene units, roughly what sky fill alone puts on tarmac. Alpha
      // blending toward this instead of toward zero means the patch has a
      // floor: even at full strength over already-shadowed road it lands near
      // 0.19 display, not 0.03.
      color: new THREE.Color().setRGB(0.045, 0.055, 0.078),
      opacity: 0.30, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
  }

  createShadowBlob() {
    const m = new THREE.Mesh(this.blobGeo, this.blobMat.clone());
    m.name = 'shadowBlob';   // nameable so `shot.mjs --hide` can isolate it
    m.renderOrder = 3;
    this.scene.add(m);
    return m;
  }

  _rate(kart, cameraPos) {
    if (kart.isPlayer) return 1;
    const d = kart.pos.distanceTo(cameraPos);
    // Emission falls off with distance; beyond 70 m nothing is legible anyway.
    return clamp01(1 - (d - 18) / 52) * 0.7;
  }

  /** Mutable presentation state that must persist between frames per kart. */
  _state(kart) {
    let s = this._fx.get(kart);
    if (!s) {
      s = { lastStage: -1, ringPhase: 0, boostPhase: 0, sparkPhase: 0 };
      this._fx.set(kart, s);
    }
    return s;
  }

  /**
   * @param {number} dt
   * @param {Array} karts
   * @param {THREE.Vector3} cameraPos
   */
  update(dt, karts, cameraPos) {
    this._time += dt;
    this._karts = karts;
    this._playerPos = karts.find((k) => k.isPlayer)?.pos ?? null;
    for (const kart of karts) {
      const rate = this._rate(kart, cameraPos);
      // Stage transitions are one-shots and must fire even for a kart that is
      // too far away to be worth a continuous emitter.
      this._driftTransitions(kart);
      if (rate > 0.01) {
        this._driftFX(dt, kart, rate);
        this._surfaceDust(dt, kart, rate);
        this._seaSpray(dt, kart, rate);
        this._boostFlame(dt, kart, rate, cameraPos);
        this._exhaust(dt, kart, rate);
        this._starSparkle(dt, kart, rate);
      }
      this._shadowBlob(kart);
    }
    this.additive.update(dt);
    this.smoke.update(dt);
  }

  _emitAccum(kart, key, dt, perSecond) {
    let m = this._accum.get(kart);
    if (!m) { m = {}; this._accum.set(kart, m); }
    m[key] = (m[key] || 0) + perSecond * dt;
    const n = Math.floor(m[key]);
    m[key] -= n;
    return n;
  }

  _groundY(kart) {
    const g = kart.ground;
    return g && g.height !== undefined ? g.height : null;
  }

  /** Ground height near an arbitrary world point, borrowed from the nearest kart. */
  _groundNear(pos) {
    if (!this._karts) return null;
    let best = null, bestD = 36;
    for (const k of this._karts) {
      const d = k.pos.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best ? this._groundY(best) : null;
  }

  // -- drift ----------------------------------------------------------------

  /** Stage-up flashes and the release burst; both are single-frame events. */
  _driftTransitions(kart) {
    const st = this._state(kart);
    const d = kart.drift;
    const stage = d.active ? d.stage : -1;
    if (d.active && stage > st.lastStage && stage >= 0) this._stageUp(kart, stage);
    else if (!d.active && st.lastStage >= 0) this._driftRelease(kart, st.lastStage);
    st.lastStage = stage;
  }

  /** The tier just landed: a colour-coded shock that cannot be missed. */
  _stageUp(kart, stage) {
    const model = kart.model;
    if (!model) return;
    const tier = DRIFT_TIERS[stage];
    const col = DRIFT.stages[stage].color;
    const gy = this._groundY(kart);
    for (const side of ['driftL', 'driftR']) {
      model.anchors[side].getWorldPosition(_p);
      // Two rings at different rates so the shock has depth rather than being
      // one expanding circle.
      for (let r = 0; r < 2; r++) {
        _v.set(0, 0.3, 0);
        _c.setHex(col);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.RING, size: tier.ring * (0.8 + r * 0.5), sizeGrow: 9 + r * 6,
          life: 0.22 + r * 0.10, alpha: tier.ringA * 1.4, drag: 3, colorB: 0x101018,
        });
      }
      const n = 10 + stage * 7;
      for (let i = 0; i < n; i++) {
        const a = this.rng() * TAU;
        const sp = 3 + this.rng() * (5 + stage * 3);
        _v.set(Math.cos(a) * sp, this.rng() * 4.5 + 1.5, Math.sin(a) * sp);
        _c.setHex(col);
        if (this.rng() < 0.4) _c.lerp(_WHITE, 0.55);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.SPARK, size: tier.size * 1.3, life: 0.26 + this.rng() * 0.3,
          alpha: tier.alpha, gravity: 9, drag: 1.5, ground: gy, bounce: 0.34,
          rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 18, colorB: 0x2a0a12,
        });
      }
    }
  }

  /** Letting go pays out: a wide directional flare in the banked tier colour. */
  _driftRelease(kart, stage) {
    const model = kart.model;
    if (!model) return;
    const tier = DRIFT_TIERS[stage];
    const col = DRIFT.stages[stage].color;
    const gy = this._groundY(kart);
    _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
    model.anchors.center.getWorldPosition(_p);
    _p.addScaledVector(_w, -1.1);

    for (let i = 0; i < 30 + stage * 14; i++) {
      const a = this.rng() * TAU;
      const spread = 1.4 + this.rng() * 3.2;
      _v.copy(_w).multiplyScalar(-(10 + this.rng() * 16 + stage * 5));
      _v.x += Math.cos(a) * spread;
      _v.y += Math.sin(a) * spread * 0.7 + 1.0;
      _v.z += Math.sin(a) * spread;
      _c.setHex(col);
      const streak = this.rng() < 0.55;
      this.additive.spawn(_p, _v, _c, {
        shape: streak ? SHAPE.STREAK : SHAPE.SPARK,
        size: streak ? 1.6 + this.rng() * 1.6 : tier.size * 1.2,
        life: 0.18 + this.rng() * 0.26, alpha: streak ? 0.42 : 0.85,
        gravity: streak ? 0 : 7, drag: streak ? 2.6 : 1.5,
        ground: gy, bounce: streak ? 0 : 0.3,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16, colorB: 0x180a20,
      });
    }
    // A single wide ring reads as the "pop" that the sparks are the debris of.
    _v.set(0, 0.5, 0);
    _c.setHex(col);
    this.additive.spawn(_p, _v, _c, {
      shape: SHAPE.RING, size: 2.4 + stage * 0.9, sizeGrow: 18 + stage * 6,
      life: 0.32, alpha: 0.45, drag: 4, colorB: 0x0c0c14,
    });
  }

  _driftFX(dt, kart, rate) {
    const d = kart.drift;
    if (!d.active || !kart.grounded) return;
    const model = kart.model;
    if (!model) return;

    const st = this._state(kart);
    const gy = this._groundY(kart);
    _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
    _side.set(_w.z, 0, -_w.x);
    const stage = d.stage;
    const tier = stage >= 0 ? DRIFT_TIERS[stage] : null;

    // --- tyre smoke: low, wide, and dragged along by the kart -------------
    // It sits under the sparks as the dark backing that keeps them legible on
    // pale sand and bright water; that is why its alpha is so low and its
    // ground fade so aggressive.
    // 42/s, not the 70 that "looks right" per particle: a chase camera views
    // the trail end-on, so a second of emission piles into a few hundred pixels
    // and normal-blended layers compound to opaque white however low each one's
    // alpha is. Count, not per-particle alpha, is what has to stay small.
    const smokeN = this._emitAccum(kart, 'driftSmoke', dt, 55 * rate);
    for (let i = 0; i < smokeN; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _p.addScaledVector(_side, (i % 2 === 0 ? -1 : 1) * this.rng() * 0.35);
      _v.set((this.rng() - 0.5) * 1.4, this.rng() * 0.25, (this.rng() - 0.5) * 1.4);
      // Inherit a quarter of the kart's velocity. Smoke is air: it is left
      // behind, but emitting it *backwards* in world space (which is what
      // subtracting the speed does) throws it at 40 m/s and smears it into a
      // wedge instead of leaving a plume sitting on the racing line.
      _v.addScaledVector(_w, kart.speed * 0.26);
      _v.addScaledVector(_side, -d.dir * (1.6 + this.rng() * 1.8));
      _c.setHSL(0.08, 0.05, 0.50);
      if (tier) { _c2.setHex(DRIFT.stages[stage].color); _c.lerp(_c2, 0.24); }
      // Positive gravity, not buoyancy: tyre smoke that climbs leaves the soft
      // ground fade behind and turns back into a floating billboard.
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.55 + this.rng() * 0.45,
        life: 0.38 + this.rng() * 0.28, alpha: 0.085, gravity: 0.5, drag: 2.8,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2.6, sizeGrow: 2.0,
        ground: gy, colorB: 0x4e5158,
      });
    }

    if (!tier) {
      // Pre-tier friction: a thin trickle of white specks so the first tier
      // landing is a step up from *something* rather than from nothing.
      const n = this._emitAccum(kart, 'driftPre', dt, 26 * rate);
      for (let i = 0; i < n; i++) {
        const side = i % 2 === 0 ? 'driftL' : 'driftR';
        model.anchors[side].getWorldPosition(_p);
        _v.set((this.rng() - 0.5) * 2.2, this.rng() * 1.6 + 0.4, (this.rng() - 0.5) * 2.2);
        _v.addScaledVector(_w, kart.speed * 0.45);
        _c.setRGB(0.55, 0.44, 0.30);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.SPARK, size: 0.22 + this.rng() * 0.16,
          life: 0.16 + this.rng() * 0.16, alpha: 0.55, gravity: 8, drag: 1.8,
          rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 14, colorB: 0x2a1206,
        });
      }
      return;
    }

    // --- charged tell -----------------------------------------------------
    // How close the next tier is, and at the top tier how long it has been
    // held. Either way it drives a white-hot component that says "ready".
    const next = DRIFT.stages[stage + 1];
    const hot = next
      ? clamp01((d.charge - DRIFT.stages[stage].charge) / (next.charge - DRIFT.stages[stage].charge))
      : 1;
    // A rising throb: slow at tier one, urgent at tier three.
    st.sparkPhase += dt * tier.hz;
    const pulse = 0.72 + 0.28 * Math.sin(st.sparkPhase * TAU);

    const col = DRIFT.stages[stage].color;
    const sparkN = this._emitAccum(kart, 'driftSpark', dt, tier.rate * (0.75 + 0.5 * pulse) * rate);
    for (let i = 0; i < sparkN; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _v.set((this.rng() - 0.5) * tier.spread, this.rng() * tier.lift + 0.8, (this.rng() - 0.5) * tier.spread);
      // Sparks keep half the kart's momentum, so the plume stays attached to
      // the tyre and streams a couple of metres back rather than being flung
      // behind at forty metres a second.
      _v.addScaledVector(_w, kart.speed * 0.50);
      _c.setHex(col);
      // A hot white fraction gives the plume a core; it grows as the next tier
      // approaches, so "about to upgrade" is visible before the HUD says so.
      if (this.rng() < 0.18 + hot * 0.34) _c.lerp(_WHITE, 0.45 + hot * 0.4);
      const streak = this.rng() < tier.streak;
      this.additive.spawn(_p, _v, _c, {
        shape: streak ? SHAPE.STREAK : SHAPE.SPARK,
        size: streak ? tier.strSize * (0.7 + this.rng() * 0.6) : tier.size * (0.6 + this.rng() * 0.9),
        life: 0.26 + this.rng() * 0.30, alpha: tier.alpha * (streak ? 0.28 : 1),
        gravity: streak ? 1.5 : 7.5, drag: streak ? 2.2 : 1.4,
        ground: gy, bounce: streak ? 0 : 0.30,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 14, colorB: 0x220a18,
      });
    }

    // --- wheel glow: the peripheral-vision read ---------------------------
    // Small and bright, not big and dim: a wide soft glow at this density is
    // a coloured fog bank that hides the sparks it is supposed to anchor.
    const glowN = this._emitAccum(kart, 'driftGlow', dt, 55 * rate);
    for (let i = 0; i < glowN; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _v.set(0, 0.5, 0).addScaledVector(_w, kart.speed * 0.7);
      _c.setHex(col).lerp(_WHITE, 0.25 + hot * 0.30);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.GLOW, size: tier.glow * (0.85 + 0.3 * pulse),
        life: 0.09, alpha: tier.glowA * pulse, drag: 5, colorB: col,
      });
    }

    // --- ring pulse: frequency *is* the tier ------------------------------
    st.ringPhase += dt * tier.hz;
    if (st.ringPhase >= 1) {
      st.ringPhase -= Math.floor(st.ringPhase);
      for (const side of ['driftL', 'driftR']) {
        model.anchors[side].getWorldPosition(_p);
        _v.set(0, 0.8, 0);
        _c.setHex(col).lerp(_WHITE, hot * 0.35);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.RING, size: tier.ring * 0.5, sizeGrow: 5.5 + stage * 2,
          life: 0.17, alpha: tier.ringA * (0.7 + hot * 0.5), drag: 4, colorB: 0x0a0a12,
        });
      }
    }
  }

  // -- ground interaction ---------------------------------------------------

  _surfaceDust(dt, kart, rate) {
    if (!kart.grounded) return;
    const surf = kart.surface;
    if (!surf.dust || Math.abs(kart.speed) < 3) return;
    const model = kart.model;
    if (!model) return;

    const gy = this._groundY(kart);
    const intensity = surf.dust * clamp01(Math.abs(kart.speed) / 18);
    const base = DUST_COLOR[surf.id] ?? 0xa57b52;
    _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));

    const n = this._emitAccum(kart, 'dust', dt, 76 * intensity * rate);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _p.y -= 0.08;
      _v.set((this.rng() - 0.5) * 2.2, this.rng() * 1.6 + 0.4, (this.rng() - 0.5) * 2.2);
      _v.addScaledVector(_w, -kart.speed * 0.26);
      _c.setHex(base).offsetHSL(0, 0, (this.rng() - 0.5) * 0.12);
      // Darker at the end of life: real dust settles and loses its lit edge.
      _c2.setHex(base).offsetHSL(0, 0.05, -0.22);
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.75 + this.rng() * 0.75,
        life: 0.55 + this.rng() * 0.45, alpha: 0.26, gravity: 0.3, drag: 1.8,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2.4, sizeGrow: 1.7,
        ground: gy, colorB: _c2,
      });
    }

    // Clods: a handful of opaque specks with real gravity that bounce once or
    // twice. Dust alone always looks like fog; the clods give it mass.
    const clods = this._emitAccum(kart, 'clod', dt, 22 * intensity * rate);
    for (let i = 0; i < clods; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _v.set((this.rng() - 0.5) * 3.5, this.rng() * 4.5 + 1.5, (this.rng() - 0.5) * 3.5);
      _v.addScaledVector(_w, -kart.speed * 0.34);
      _c.setHex(base).offsetHSL(0, 0.06, -0.26);
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.GLOW, size: 0.16 + this.rng() * 0.22,
        life: 0.7 + this.rng() * 0.5, alpha: 0.85, gravity: 22, drag: 0.35,
        ground: gy, bounce: 0.32, rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 10,
      });
    }
  }

  /** Fine mist thrown up where the road runs close to the sea. */
  _seaSpray(dt, kart, rate) {
    const track = kart.track;
    if (!track || !track.def?.theme?.water?.enabled || !kart.grounded) return;
    const gy = this._groundY(kart);
    if (gy == null) return;
    // Only the low, seaward stretches: high up the cliff there is no spray.
    const near = clamp01(1 - (gy - track.waterLevel) / 15);
    if (near <= 0.02 || Math.abs(kart.speed) < 12) return;
    const model = kart.model;
    if (!model) return;

    const n = this._emitAccum(kart, 'spray', dt, 16 * near * clamp01(kart.speed / 22) * rate);
    _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
    _side.set(_w.z, 0, -_w.x);
    for (let i = 0; i < n; i++) {
      model.anchors.center.getWorldPosition(_p);
      _p.addScaledVector(_side, (this.rng() - 0.5) * 4.5);
      _p.y += this.rng() * 1.4;
      _v.copy(_w).multiplyScalar(-kart.speed * 0.35);
      _v.y += this.rng() * 1.2;
      _c.setRGB(0.62, 0.74, 0.80);
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.8 + this.rng() * 1.0,
        life: 0.45 + this.rng() * 0.4, alpha: 0.045 * near, gravity: -0.3, drag: 1.4,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 1.8, sizeGrow: 2.4,
        colorB: 0x6d8894,
      });
    }
  }

  // -- boost ----------------------------------------------------------------

  /**
   * The boost plume, built as four separate layers.
   *
   * A single additive emitter is exactly how you get a white blob: every
   * particle carries the same colour and the same alpha, they pile up at the
   * exhaust, and the sum saturates. Splitting it into a tiny hot core, a
   * saturated coloured mid, a wide dim halo and velocity-aligned streaks keeps
   * each layer's contribution inside its own budget, and it is the layering —
   * not the brightness — that reads as a flame.
   */
  _boostFlame(dt, kart, rate) {
    const model = kart.model;
    if (!model || !kart.boostActive) return;

    const st = this._state(kart);
    const strong = kart.boostStrength > 0.45;
    // Every layer inherits a different fraction of the kart's velocity, and
    // that spread is what gives the plume depth: the core rides with the pipe,
    // the mid lags into a cone, and the halo is left standing on the racing
    // line as the trail.
    const sp = kart.speed;
    _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
    _side.set(_w.z, 0, -_w.x);

    // Two palettes, both authored in linear so the numbers below are the
    // numbers the exposure pass sees.
    const mid = strong ? _MID_BLUE : _MID_ORANGE;
    const tail = strong ? _TAIL_BLUE : _TAIL_ORANGE;
    const halo = strong ? _HALO_BLUE : _HALO_ORANGE;

    const emit = (key, perSecond) => this._emitAccum(kart, key, dt, perSecond * rate);

    // 1. Core — small, short, near-white, riding with the pipe.
    // Outboard offset: the anchors sit 26 cm either side of the centreline, so
    // a plume emitted exactly on them is behind the chassis and invisible from
    // the only camera that matters. Pushing the jets out past the rear wheels
    // is what turns "a glow somewhere behind the kart" into two visible pipes.
    const OUT = 0.48;
    const coreN = emit('boostCore', 150);
    for (let i = 0; i < coreN; i++) {
      const sgn = i % 2 === 0 ? -1 : 1;
      model.anchors[i % 2 === 0 ? 'exhaustL' : 'exhaustR'].getWorldPosition(_p);
      _p.addScaledVector(_side, sgn * OUT);
      _v.copy(_w).multiplyScalar(sp * 0.80 - (3 + this.rng() * 4));
      _v.y += 0.4;
      _c.copy(_CORE);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.GLOW, size: 0.34 + this.rng() * 0.20,
        life: 0.08 + this.rng() * 0.05, alpha: 0.58, drag: 4, sizeGrow: 0.6,
        colorB: mid,
      });
    }

    // 2. Mid — the flame's actual colour, cooling into the tail colour, and
    //    falling behind the core into a cone.
    const midN = emit('boostMid', 200);
    for (let i = 0; i < midN; i++) {
      const sgn = i % 2 === 0 ? -1 : 1;
      model.anchors[i % 2 === 0 ? 'exhaustL' : 'exhaustR'].getWorldPosition(_p);
      _p.addScaledVector(_side, sgn * OUT);
      _v.copy(_w).multiplyScalar(sp * 0.48 - (5 + this.rng() * 6));
      _v.addScaledVector(_side, sgn * (0.5 + this.rng() * 1.2));
      _v.x += (this.rng() - 0.5) * 1.6;
      _v.y += (this.rng() - 0.5) * 1.1 + 0.45;
      _v.z += (this.rng() - 0.5) * 1.6;
      _c.copy(mid);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.GLOW, size: 0.52 + this.rng() * 0.50,
        life: 0.18 + this.rng() * 0.16, alpha: 0.30, drag: 3.2, sizeGrow: 1.4,
        colorB: tail,
      });
    }

    // 3. Halo — wide, dim, almost no inherited speed, so it stays where it was
    //    emitted and lays a trail that bends with the racing line.
    const haloN = emit('boostHalo', 85);
    for (let i = 0; i < haloN; i++) {
      const sgn = i % 2 === 0 ? -1 : 1;
      model.anchors[i % 2 === 0 ? 'exhaustL' : 'exhaustR'].getWorldPosition(_p);
      _p.addScaledVector(_side, sgn * OUT);
      _v.copy(_w).multiplyScalar(sp * 0.12);
      _v.y += 0.4 + this.rng() * 0.6;
      _v.addScaledVector(_side, sgn * (0.8 + this.rng() * 1.6));
      _c.copy(halo);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.GLOW, size: 0.95 + this.rng() * 0.7,
        life: 0.50 + this.rng() * 0.40, alpha: 0.090, drag: 1.0, sizeGrow: 2.4,
        colorB: tail,
      });
      // A normal-blended twin gives the trail body against a bright sky, where
      // an additive-only plume disappears.
      _c2.copy(halo).lerp(_WHITE, 0.45);
      this.smoke.spawn(_p, _v, _c2, {
        shape: SHAPE.SMOKE, size: 0.75 + this.rng() * 0.55,
        life: 0.60 + this.rng() * 0.45, alpha: 0.050, drag: 0.9, sizeGrow: 1.5,
        gravity: -0.5, rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2,
        colorB: tail,
      });
    }

    // 4. Streaks — the direction cue. Fast, thin, short-lived, and thrown
    //    backwards hard so they stretch into visible lines.
    const strN = emit('boostStreak', 110);
    for (let i = 0; i < strN; i++) {
      const sgn = i % 2 === 0 ? -1 : 1;
      model.anchors[i % 2 === 0 ? 'exhaustL' : 'exhaustR'].getWorldPosition(_p);
      _p.addScaledVector(_side, sgn * (OUT + this.rng() * 0.5));
      _v.copy(_w).multiplyScalar(-(12 + this.rng() * 14));
      _v.y += (this.rng() - 0.5) * 1.6 + 0.3;
      _c.copy(mid).lerp(_WHITE, 0.35);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.STREAK, size: 2.2 + this.rng() * 2.4,
        life: 0.12 + this.rng() * 0.09, alpha: 0.42, drag: 1.8, colorB: tail,
      });
    }

    // 5. Heat shimmer directly over the pipes.
    const shimN = emit('boostHeat', 26);
    for (let i = 0; i < shimN; i++) {
      const sgn = i % 2 === 0 ? -1 : 1;
      model.anchors[i % 2 === 0 ? 'exhaustL' : 'exhaustR'].getWorldPosition(_p);
      _p.addScaledVector(_side, sgn * OUT);
      _p.addScaledVector(_w, -0.5 - this.rng() * 1.4);
      _v.copy(_w).multiplyScalar(sp * 0.55);
      _v.y += 1.2 + this.rng() * 0.9;
      _c.setRGB(0.55, 0.50, 0.46);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.RIPPLE, size: 1.1 + this.rng() * 0.9,
        life: 0.30 + this.rng() * 0.20, alpha: 0.085, drag: 1.6, sizeGrow: 2.2,
        rot: this.rng() * TAU, colorB: 0x30281f,
      });
    }

    // Thrust pulses: a ring leaving each pipe at a fixed rate reads as an
    // engine doing work rather than a light that has been switched on.
    st.boostPhase += dt * 18;
    if (st.boostPhase >= 1) {
      st.boostPhase -= Math.floor(st.boostPhase);
      for (const side of ['exhaustL', 'exhaustR']) {
        model.anchors[side].getWorldPosition(_p);
        _p.addScaledVector(_side, side === 'exhaustL' ? -OUT : OUT);
        _v.copy(_w).multiplyScalar(sp * 0.35);
        _c.copy(mid);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.RING, size: 0.35, sizeGrow: 7.0,
          life: 0.16, alpha: 0.34, drag: 3, colorB: tail,
        });
      }
    }

    // Speed lines: only for the kart the camera is glued to, and placed out in
    // the periphery where they add velocity without covering the road.
    if (kart.isPlayer) {
      const lines = emit('speedLine', 52);
      for (let i = 0; i < lines; i++) {
        const a = this.rng() * TAU;
        const r = 2.6 + this.rng() * 3.4;
        model.anchors.center.getWorldPosition(_p);
        _p.addScaledVector(_side, Math.cos(a) * r);
        _p.y += Math.sin(a) * r * 0.55 + 0.4;
        _p.addScaledVector(_w, 3 + this.rng() * 7);
        _v.copy(_w).multiplyScalar(-(20 + this.rng() * 18));
        _c.copy(mid).lerp(_WHITE, 0.55);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.STREAK, size: 2.6 + this.rng() * 2.6,
          life: 0.12 + this.rng() * 0.08, alpha: 0.11, drag: 0.6, colorB: mid,
        });
      }
    }
  }

  _exhaust(dt, kart, rate) {
    if (kart.boostActive || !kart.grounded) return;
    const load = kart.engineLoad;
    if (load < 0.12) return;
    const model = kart.model;
    if (!model) return;
    const n = this._emitAccum(kart, 'exhaust', dt, 9 * load * rate);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 'exhaustL' : 'exhaustR';
      model.anchors[side].getWorldPosition(_p);
      _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
      _v.copy(_w).multiplyScalar(-(1.5 + this.rng() * 2)).add(_UP);
      _c.setHSL(0, 0, 0.55);
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.34 + this.rng() * 0.3, life: 0.45 + this.rng() * 0.35,
        alpha: 0.075, gravity: -0.4, drag: 2.5, sizeGrow: 1.1,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2, colorB: 0x606060,
      });
    }
  }

  /** Invincibility: a rainbow of sparks shedding off the whole chassis. */
  _starSparkle(dt, kart, rate) {
    if (kart.star <= 0) return;
    const model = kart.model;
    if (!model) return;
    const n = this._emitAccum(kart, 'star', dt, 90 * rate);
    const gy = this._groundY(kart);
    for (let i = 0; i < n; i++) {
      model.anchors.center.getWorldPosition(_p);
      _p.x += (this.rng() - 0.5) * 2.0;
      _p.y += (this.rng() - 0.5) * 1.2;
      _p.z += (this.rng() - 0.5) * 2.6;
      _v.set((this.rng() - 0.5) * 2, this.rng() * 2 + 0.5, (this.rng() - 0.5) * 2);
      _c.setHSL((this._time * 0.6 + this.rng() * 0.35) % 1, 0.95, 0.62);
      _c2.setHSL((this._time * 0.6 + 0.4) % 1, 1.0, 0.22);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.SPARK, size: 0.30 + this.rng() * 0.30,
        life: 0.3 + this.rng() * 0.3, alpha: 0.65, gravity: 4.5, drag: 1.6,
        ground: gy, bounce: 0.3, rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 14,
        colorB: _c2,
      });
    }
  }

  // -- one-shots ------------------------------------------------------------

  /**
   * One-shot burst when something hits a kart.
   *
   * Weight comes from three separate things arriving on different timescales:
   * a shock ring in the first two frames, hot debris that actually falls and
   * bounces over the next second, and a dust puff that outlives both.
   */
  impact(pos, color = 0xffcc44, count = 34) {
    const gy = this._groundNear(pos);

    _v.set(0, 0.4, 0);
    _c.setHex(color);
    this.additive.spawn(pos, _v, _c, {
      shape: SHAPE.RING, size: 1.0, sizeGrow: 26, life: 0.26, alpha: 0.55,
      drag: 4, colorB: 0x120608,
    });
    // A short flash core, deliberately brief — a long one is a white frame.
    this.additive.spawn(pos, _ZERO, _c, {
      shape: SHAPE.GLOW, size: 1.5, sizeGrow: 3, life: 0.10, alpha: 0.60,
      drag: 6, colorB: color,
    });

    for (let i = 0; i < count; i++) {
      _v.set(this.rng() - 0.5, this.rng() * 0.9, this.rng() - 0.5).normalize()
        .multiplyScalar(4 + this.rng() * 11);
      _c.setHex(color).offsetHSL((this.rng() - 0.5) * 0.06, 0, (this.rng() - 0.5) * 0.2);
      const streak = this.rng() < 0.3;
      this.additive.spawn(pos, _v, _c, {
        shape: streak ? SHAPE.STREAK : SHAPE.SPARK,
        size: streak ? 1.4 + this.rng() * 1.4 : 0.45 + this.rng() * 0.6,
        life: 0.35 + this.rng() * 0.45, alpha: streak ? 0.5 : 0.95,
        gravity: streak ? 2 : 13, drag: streak ? 2.4 : 1.3,
        ground: gy, bounce: streak ? 0 : 0.42,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16, colorB: 0x20080c,
      });
    }

    // Scorch + dust: the part that lingers after the flash is gone.
    for (let i = 0; i < 14; i++) {
      const a = this.rng() * TAU;
      const sp = 1.5 + this.rng() * 4.5;
      _v.set(Math.cos(a) * sp, this.rng() * 1.4 + 0.2, Math.sin(a) * sp);
      _c.setRGB(0.14, 0.12, 0.11);
      this.smoke.spawn(pos, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.55 + this.rng() * 0.7,
        life: 0.8 + this.rng() * 0.7, alpha: 0.24, gravity: -0.4, drag: 2.2,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2.5, sizeGrow: 1.1,
        ground: gy, colorB: 0x2b2622,
      });
    }
  }

  /** Landing puff after a jump. */
  landing(pos, strength) {
    const gy = this._groundNear(pos);
    const n = Math.round(10 + strength * 22);
    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      _v.set(Math.cos(a) * (2 + this.rng() * 5), this.rng() * 1.0, Math.sin(a) * (2 + this.rng() * 5));
      _c.setHSL(0.09, 0.10, 0.62);
      this.smoke.spawn(pos, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.55 + this.rng() * 0.55,
        life: 0.40 + this.rng() * 0.35, alpha: 0.075 * (0.4 + strength),
        gravity: 0.4, drag: 2.6, sizeGrow: 1.6,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 3,
        ground: gy, colorB: 0x9b968e,
      });
    }
    if (strength > 0.35) {
      _v.set(0, 0.2, 0);
      _c.setRGB(0.55, 0.50, 0.42);
      this.smoke.spawn(pos, _v, _c, {
        shape: SHAPE.RING, size: 1.4, sizeGrow: 16, life: 0.30,
        alpha: 0.28 * strength, drag: 5, colorB: 0x6a6259,
      });
    }
  }

  /** Generic coloured pop, used by the item layer for pickups and hits. */
  burst(pos, color, {
    count = 18, speed = 7, size = 0.5, life = 0.4, alpha = 0.8, ring = 0, gravity = 6,
  } = {}) {
    const gy = this._groundNear(pos);
    if (ring > 0) {
      _c.setHex(color);
      this.additive.spawn(pos, _ZERO, _c, {
        shape: SHAPE.RING, size: ring, sizeGrow: ring * 12, life: 0.28,
        alpha: 0.40, drag: 4, colorB: 0x0c0c12,
      });
    }
    for (let i = 0; i < count; i++) {
      _v.set(this.rng() - 0.5, this.rng() * 0.8 + 0.1, this.rng() - 0.5).normalize()
        .multiplyScalar(speed * (0.4 + this.rng() * 0.8));
      _c.setHex(color).offsetHSL((this.rng() - 0.5) * 0.05, 0, (this.rng() - 0.5) * 0.18);
      this.additive.spawn(pos, _v, _c, {
        shape: SHAPE.SPARK, size: size * (0.6 + this.rng() * 0.8),
        life: life * (0.6 + this.rng() * 0.8), alpha, gravity, drag: 1.6,
        ground: gy, bounce: 0.35,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16, colorB: 0x1a0a14,
      });
    }
  }

  /** Continuous coloured wake behind a moving projectile. */
  trail(pos, color, { size = 0.4, alpha = 0.35, life = 0.3, glow = 0.8 } = {}) {
    _c.setHex(color);
    this.additive.spawn(pos, _ZERO, _c, {
      shape: SHAPE.GLOW, size: glow, life, alpha, drag: 2.5, sizeGrow: 1.2,
      colorB: 0x0a0a12,
    });
    if (this.rng() < 0.5) {
      _v.set((this.rng() - 0.5) * 2, this.rng() * 1.2, (this.rng() - 0.5) * 2);
      this.additive.spawn(pos, _v, _c, {
        shape: SHAPE.SPARK, size, life: life * 0.8, alpha: alpha * 1.6,
        gravity: 5, drag: 1.8, rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 12,
        colorB: 0x140812,
      });
    }
  }

  _shadowBlob(kart) {
    if (!kart.shadowBlob) return;
    const b = kart.shadowBlob;
    const g = kart.ground;
    if (!g || g.height === undefined) { b.visible = false; return; }
    b.visible = true;
    b.position.set(kart.visualPos.x, g.height + 0.03, kart.visualPos.z);
    b.rotation.y = kart.bodyYaw;

    // Complementary, not additive. The fitted shadow box follows the player
    // (SHADOW_EXTENT in render/Lighting.js), so inside it the shadow map owns
    // the silhouette and this only has to seat the tyres; outside it there is
    // no cast shadow at all and the patch is the whole anchor.
    const far = this._playerPos ? this._playerPos.distanceTo(kart.pos) > SHADOW_BOX : false;
    let opacity = far ? 0.52 : 0.30;

    // Off the ground the cast shadow slides away along the sun direction, so
    // the patch stops being a duplicate and starts being the only altitude cue.
    // It still shrinks and softens with height — that *is* the cue.
    const h = Math.max(0, kart.visualPos.y - g.height - 0.42);
    const k = clamp01(h / 4.5);
    b.material.opacity = opacity * (1 - k * 0.55);
    const sc = 1 + k * 0.7;
    b.scale.set(sc, 1, sc);
  }

  setPixelScale(heightPx, fovDeg) {
    this.additive.setPixelScale(heightPx, fovDeg);
    this.smoke.setPixelScale(heightPx, fovDeg);
  }

  clear() { this.additive.clear(); this.smoke.clear(); }

  dispose() {
    this.additive.dispose();
    this.smoke.dispose();
    this.blobGeo.dispose();
    this.blobMat.dispose();
    this.blobTex.dispose();
    if (this.scene.userData.kartFX === this) delete this.scene.userData.kartFX;
  }
}

const _WHITE = new THREE.Color(1, 1, 1);
const _UP = new THREE.Vector3(0, 1.2, 0);
const _ZERO = new THREE.Vector3(0, 0, 0);

// Boost palette, authored directly in linear working space (setRGB, unlike
// setHex, does not go through sRGB) so these read as the exposure pass sees
// them. Nothing here exceeds 1.0: brightness comes from stacking, and the
// stack is what the per-layer alphas above are sized against.
const _CORE = new THREE.Color().setRGB(1.00, 0.94, 0.86);
const _MID_BLUE = new THREE.Color().setRGB(0.30, 0.66, 1.00);
const _TAIL_BLUE = new THREE.Color().setRGB(0.06, 0.10, 0.42);
const _HALO_BLUE = new THREE.Color().setRGB(0.16, 0.36, 0.85);
const _MID_ORANGE = new THREE.Color().setRGB(1.00, 0.46, 0.10);
const _TAIL_ORANGE = new THREE.Color().setRGB(0.35, 0.05, 0.02);
const _HALO_ORANGE = new THREE.Color().setRGB(0.85, 0.30, 0.06);
