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
const _q = new THREE.Vector3();
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
/**
 * The alphas below are the second most important numbers, and they went *down*
 * in this pass. These are additive sprites feeding an ACES curve: past roughly
 * 1.2 of accumulated linear radiance the dominant channel saturates first and
 * the hue slides toward magenta-white, which is why forced stage 0 (a blue
 * tier) and forced stage 2 (a purple one) both rendered as the same mauve
 * smudge. Tier identity survives on the *shape and count* of the shower, not on
 * turning one sprite up until it glows.
 *
 * `lift` shrank for a related reason: the chase camera looks straight down the
 * kart's forward axis, so forward velocity projects to almost nothing on screen
 * and the vertical component decides the streak angle. Sparks thrown mostly
 * upward became tall pale columns either side of the kart. Throwing them
 * *sideways*, along the drift direction, is what puts the shower across the
 * screen where it can be read.
 */
/**
 * Third correction, from captures of a real stage 1 rather than a forced one:
 * the shower was aimed where the camera cannot see it. Drift anchors sit at the
 * rear contact patches, and the chase camera looks straight down the kart's
 * spine — so anything emitted there is behind the chassis and between the rear
 * wheels until something throws it clear. `out` (sideways, along the slide) and
 * `lift` are therefore not decoration, they are the whole visibility budget,
 * and both climb hard with the tier. `alpha` climbed back up too: the tier
 * colours are heavily saturated primaries and a *small* sprite can carry a lot
 * of radiance before its dominant channel saturates — that failure mode was
 * about fifty-pixel sparks overlapping, not about the number itself.
 */
/**
 * Fourth correction: `size` went up by about half. These are EMBER sprites
 * now, and a comet occupies well under a tenth of the quad it is drawn in
 * where the old four-point star's core filled a fifth of it — so the same
 * number is a visibly smaller spark and a much smaller total footprint. The
 * numbers below are chosen so the spark *length* is 25-60 px at chase
 * distance, which is the range where you can see which way it is travelling
 * and still count them.
 */
const DRIFT_TIERS = [
  { rate: 175, size: 0.26, alpha: 1.15, glow: 0.30, glowA: 0.28, hz: 6.5, ring: 0.40, ringA: 0.26, streak: 0.14, strSize: 1.0, spread: 3.0, lift: 2.4, out: 2.8 },
  { rate: 280, size: 0.36, alpha: 1.50, glow: 0.42, glowA: 0.35, hz: 10.0, ring: 0.58, ringA: 0.34, streak: 0.26, strSize: 1.4, spread: 3.9, lift: 3.1, out: 4.1 },
  { rate: 420, size: 0.48, alpha: 1.85, glow: 0.56, glowA: 0.42, hz: 15.0, ring: 0.80, ringA: 0.42, streak: 0.40, strSize: 1.9, spread: 4.8, lift: 3.8, out: 5.6 },
];

/**
 * Half-size of the sun's fitted shadow box, mirroring SHADOW_EXTENT in
 * render/Lighting.js. Karts outside it get no cast shadow at all, so the
 * contact patch has to carry the anchor on its own out there.
 */
const SHADOW_BOX = 78;

/**
 * Every `sizeGrow` on a RING in this file came down in this pass, and none of
 * them because the ring was too big *before*.
 *
 * The RING primitive used to be a band soft on both edges, so an eight-metre
 * one was a faint smear you had to look for. It now has a hard outer front,
 * which is what makes an impact locatable in one frame — and the same eight
 * metres of a hard-edged circle is a drawn shape sitting on the road. The
 * numbers here are sized against the new primitive, not the old one.
 *
 * Every shockwave then moved to SHAPE.GROUND, which is the same front lying in
 * the road plane instead of facing the lens, and nothing in the game emits a
 * RING any more. The exhaust pulse was kept longest, on the argument that its
 * plane genuinely is perpendicular to the chase camera — and at exhaust scale
 * it was still a thin hoop drawn round the flame, which is the exact thing
 * being fixed everywhere else. The surface a blast expands across is the road;
 * a screen-facing circle drawn at a wheel is a hoop threaded round the wheel.
 * RING stays in the primitive set unused, because the next effect that wants a
 * ring in a plane that is not the ground will want it back.
 *
 * The rings also grew. A front is a *reward*, and a reward that is 45 cm wide
 * two frames after it fires is a detail; the numbers below are sized so the
 * front leaves the kart's own silhouette inside the first sixth of a second.
 */

/** Seats a ground front on the surface: the plane it expands across is the road. */
function onRoad(p, gy) { if (gy != null) p.y = gy + 0.06; return p; }

/** Dust colour per off-road surface id (see SURFACE in track/Tracks.js). */
const DUST_COLOR = { 2: 0xbdb6ad, 3: 0xa87c50, 4: 0xdcc79a, 5: 0x8f9a5e };

/**
 * Golden ratio conjugate — the step that spreads a sequence of hues as evenly
 * as possible for *any* number of samples, which is what a rainbow emitted a
 * few particles at a time needs. See `_starSparkle`.
 */
const PHI = 0.6180339887498949;

/**
 * Rescale `c` to a target scene-linear luminance, keeping its hue, and never
 * letting a channel past 1.0.
 *
 * A hue swept round the wheel at fixed HSL lightness swings about 2.6x in
 * actual luminance — yellow is a headlight and blue is a bruise — so a cycling
 * palette authored that way blooms for a third of every cycle and disappears
 * for another third. Every fixed palette in this file is authored against a
 * brightness budget; this is how the cycling one joins them.
 */
function setLuma(c, target) {
  const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.multiplyScalar(target / Math.max(y, 1e-4));
  const m = Math.max(c.r, c.g, c.b);
  if (m > 1) c.multiplyScalar(1 / m);
  return c;
}

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
    //
    // This was briefly tightened to 46 m on a measurement that turned out to be
    // an artefact of the capture harness rather than a property of the game.
    // `shot.mjs` fast-forwards through `loop.fastForward`, which steps the
    // simulation without ever rendering — so every one-shot burst `drainEvents`
    // fires during the skipped minute is spawned and then never aged, and a
    // captured frame carries ~2000 frozen particles scattered round the whole
    // circuit. Sampled from the live loop instead, the additive pool peaks at
    // 579 of 2480 and smoke at 257 of 1520. There is no contention to fix, and
    // 46 m visibly thinned the pack. Two things follow for anyone tuning here:
    // captures under-represent every continuous effect in this file, and pool
    // occupancy must be measured from a running race, never from a capture.
    return clamp01(1 - (d - 18) / 52) * 0.7;
  }

  /** Mutable presentation state that must persist between frames per kart. */
  _state(kart) {
    let s = this._fx.get(kart);
    if (!s) {
      s = { lastStage: -1, ringPhase: 0, boostPhase: 0, sparkPhase: 0, starSeq: 0 };
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
      onRoad(_p, gy);
      // Two fronts at different rates so the shock has depth rather than being
      // one expanding circle.
      for (let r = 0; r < 2; r++) {
        _c.setHex(col);
        // Sized independently of the tier's continuous ring, which is now a
        // small contact pop: a stage-up is a one-frame event and is allowed to
        // be the biggest thing on screen for two frames.
        this.additive.spawn(_p, _ZERO, _c, {
          shape: SHAPE.GROUND, size: (1.5 + stage * 0.6) * (0.8 + r * 0.5), sizeGrow: 11 + r * 6,
          life: 0.22 + r * 0.10, alpha: tier.ringA * 1.5, drag: 3, colorB: 0x101018,
          rot: 0.30 - r * 0.16,
        });
      }
      model.anchors[side].getWorldPosition(_p);
      const n = 10 + stage * 7;
      for (let i = 0; i < n; i++) {
        const a = this.rng() * TAU;
        const sp = 3 + this.rng() * (5 + stage * 3);
        _v.set(Math.cos(a) * sp, this.rng() * 4.5 + 1.5, Math.sin(a) * sp);
        _c.setHex(col);
        if (this.rng() < 0.4) _c.lerp(_WHITE, 0.55);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.EMBER, size: tier.size * 1.3, life: 0.26 + this.rng() * 0.3,
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
        shape: streak ? SHAPE.STREAK : SHAPE.EMBER,
        size: streak ? 1.4 + this.rng() * 1.3 : tier.size * 1.2,
        life: 0.18 + this.rng() * 0.26, alpha: streak ? 0.42 : 0.85,
        gravity: streak ? 0 : 7, drag: streak ? 2.6 : 1.5,
        ground: gy, bounce: streak ? 0 : 0.3,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16, colorB: 0x180a20,
      });
    }
    // The payout front. Two of them: a fast thin one that is already past the
    // kart by the time the eye arrives, and a slower filled one that is still
    // there when it does. Both lie on the road, which is what makes a release
    // read as the kart having *shoved* the surface rather than as a circle
    // drawn over the scene.
    onRoad(_p, gy);
    _c.setHex(col);
    this.additive.spawn(_p, _ZERO, _c, {
      shape: SHAPE.GROUND, size: 2.2 + stage * 0.8, sizeGrow: 18 + stage * 7,
      life: 0.26, alpha: 0.62, drag: 4, colorB: 0x0c0c14, rot: 0.14,
    });
    _c2.setHex(col).lerp(_WHITE, 0.30);
    this.additive.spawn(_p, _ZERO, _c2, {
      shape: SHAPE.GROUND, size: 1.5 + stage * 0.5, sizeGrow: 9 + stage * 3,
      life: 0.36, alpha: 0.40, drag: 4, colorB: col, rot: 0.42,
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
    //
    // The code said 55 and the comment said 42, and 55 with sizeGrow 2.0 was
    // measurably worse than either: thirty puffs alive, each ending 1.9 m
    // across, stacking to about 93% coverage of a mid-grey over a dark road —
    // a pale wash over the kart and over the sparks it exists to back. It is
    // also darker now. "Dark backing" was the stated intent and lightness 0.50
    // is brighter than any road surface in the game.
    const smokeN = this._emitAccum(kart, 'driftSmoke', dt, 42 * rate);
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
      // Tier tint at 24% meant the largest-footprint thing the drift emits was
      // 76% neutral grey, so a blue-tier drift and a purple-tier drift painted
      // the same grey-violet mush over the same silhouette and the sparks had
      // to carry the whole tier read on their own. At 62% the smoke *is* the
      // tier in peripheral vision; the base is darkened to pay for it, because
      // what this layer owes the sparks is contrast, not brightness.
      _c.setHSL(0.08, 0.05, 0.26);
      if (tier) { _c2.setHex(DRIFT.stages[stage].color); _c.lerp(_c2, 0.62); }
      // Positive gravity, not buoyancy: tyre smoke that climbs leaves the soft
      // ground fade behind and turns back into a floating billboard.
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.50 + this.rng() * 0.40,
        life: 0.34 + this.rng() * 0.24, alpha: 0.062, gravity: 0.5, drag: 2.8,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2.6, sizeGrow: 1.2,
        ground: gy, colorB: 0x3a3d43,
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
          shape: SHAPE.EMBER, size: 0.30 + this.rng() * 0.20,
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
    // Cooling colour is a dark version of *this tier's* hue. A single shared
    // dark magenta made every tier's mid-life sparks the same mauve, which is
    // exactly the smudge the tiers were failing to distinguish themselves by.
    _c2.setHex(col).multiplyScalar(0.16);
    const sparkN = this._emitAccum(kart, 'driftSpark', dt, tier.rate * (0.75 + 0.5 * pulse) * rate);
    for (let i = 0; i < sparkN; i++) {
      const left = i % 2 === 0;
      model.anchors[left ? 'driftL' : 'driftR'].getWorldPosition(_p);
      _v.set((this.rng() - 0.5) * tier.spread, this.rng() * tier.lift + 0.8, (this.rng() - 0.5) * tier.spread);
      // Sparks keep most of the kart's momentum, and are thrown hard toward the
      // *outside* of the slide — the direction a scrubbing tyre actually flings
      // debris, and the one direction still visible from directly behind.
      //
      // The inherited fraction was a quarter, which sounds like "left behind"
      // and is: at racing speed that is twenty-three metres a second of closing
      // rate on a lens six metres back, so the shower stopped being a shower
      // and became a thin file of sparks strung out between the kart and the
      // camera, most of them past the near-fade by the time you looked. Two
      // thirds keeps the cloud within a couple of metres of the tyre for its
      // whole life, which is where a drift shower lives.
      _v.addScaledVector(_w, kart.speed * 0.66);
      _v.addScaledVector(_side, -d.dir * tier.out * (0.5 + this.rng()));
      _c.setHex(col);
      // A hot white fraction gives the plume a core; it grows as the next tier
      // approaches, so "about to upgrade" is visible before the HUD says so.
      //
      // Both numbers came down, because the EMBER sprite now carries a
      // white-hot head of its own: whitening the *particle colour* on top of
      // that washed the tier hue out of the one layer that was still carrying
      // it. The tell survives as a change in how many sparks have a hot head,
      // which is what it was always meant to be.
      if (this.rng() < 0.12 + hot * 0.26) _c.lerp(_WHITE, 0.25 + hot * 0.30);
      const streak = this.rng() < tier.streak;
      this.additive.spawn(_p, _v, _c, {
        // A comet, not a four-point star. At the ten to fifteen pixels a drift
        // spark actually occupies, the star's arms are a pixel wide and vanish
        // in the minification filter, leaving the soft round core — which is
        // why these have been reading as axis-aligned confetti squares
        // scattered near the kart rather than as debris coming off a tyre.
        shape: streak ? SHAPE.STREAK : SHAPE.EMBER,
        size: streak ? tier.strSize * (0.7 + this.rng() * 0.6) : tier.size * (0.6 + this.rng() * 0.9),
        life: 0.22 + this.rng() * 0.24, alpha: tier.alpha * (streak ? 0.30 : 1),
        gravity: streak ? 1.5 : 9.5, drag: streak ? 2.2 : 1.3,
        ground: gy, bounce: streak ? 0 : 0.34,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 14, colorB: _c2,
      });
    }

    // --- wheel glow: the peripheral-vision read ---------------------------
    // Small and bright, not big and dim: a wide soft glow at this density is
    // a coloured fog bank that hides the sparks it is supposed to anchor.
    const glowN = this._emitAccum(kart, 'driftGlow', dt, 46 * rate);
    for (let i = 0; i < glowN; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _v.set(0, 0.5, 0).addScaledVector(_w, kart.speed * 0.7);
      // Less white than it had. This is the only layer with no shape at all,
      // so every point of white here is spent making the tier hue harder to
      // name at the exact place the eye goes looking for it.
      _c.setHex(col).lerp(_WHITE, 0.14 + hot * 0.24);
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
        onRoad(_p, gy);
        _c.setHex(col).lerp(_WHITE, hot * 0.35);
        this.additive.spawn(_p, _ZERO, _c, {
          shape: SHAPE.GROUND, size: tier.ring, sizeGrow: 7 + stage * 3,
          life: 0.17, alpha: tier.ringA * (0.7 + hot * 0.5), drag: 4, colorB: 0x0a0a12,
          rot: 0.34,
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

    // Was 76/s at alpha 0.26 with sizeGrow 1.7: about seventy puffs alive, each
    // ending 2.5 m across, normal-blended — which composites to a solid tan
    // disc roughly 200 px wide with the kart inside it. Going off-road is
    // allowed to be dramatic, but not to be the moment you can no longer see
    // your own kart; the same rule the boost plume is held to.
    const n = this._emitAccum(kart, 'dust', dt, 58 * intensity * rate);
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
        shape: SHAPE.SMOKE, size: 0.70 + this.rng() * 0.70,
        life: 0.50 + this.rng() * 0.40, alpha: 0.165, gravity: 0.3, drag: 1.8,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2.4, sizeGrow: 1.15,
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
        // A hard-edged chip, not a soft round dot. "Dust alone looks like fog;
        // the clods give it mass" was the intent, and mass comes from an
        // outline — a blurred circle in the opaque pool is just more fog.
        shape: SHAPE.SHARD, size: 0.16 + this.rng() * 0.22,
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
    // numbers the exposure pass sees — plus a third that only exists while the
    // star does. A star boost used to fire the ordinary blue jet, so the kart
    // wore a rainbow of sparks and a cold blue plume that shared no colour
    // logic with them and read as two unrelated effects on one vehicle. One
    // hue clock now drives both, and the plume cycles with the sparkle.
    let mid, tail, halo;
    if (kart.star > 0) {
      const h = (this._time * 0.5) % 1;
      mid = setLuma(_STAR_MID.setHSL(h, 0.88, 0.60), 0.55);
      halo = setLuma(_STAR_HALO.setHSL((h + 0.10) % 1, 0.85, 0.45), 0.30);
      tail = setLuma(_STAR_TAIL.setHSL((h + 0.30) % 1, 1.0, 0.20), 0.10);
    } else {
      mid = strong ? _MID_BLUE : _MID_ORANGE;
      tail = strong ? _TAIL_BLUE : _TAIL_ORANGE;
      halo = strong ? _HALO_BLUE : _HALO_ORANGE;
    }

    const emit = (key, perSecond) => this._emitAccum(kart, key, dt, perSecond * rate);

    // Where a jet's mouth is.
    //
    // Outboard offset: the anchors sit 26 cm either side of the centreline, so
    // a plume emitted exactly on them is behind the chassis and invisible from
    // the only camera that matters. Pushing the jets out past the rear wheels
    // is what turns "a glow somewhere behind the kart" into two visible pipes.
    //
    // BACK is the second half of the same problem, found once the plume was
    // thin enough to see what it was doing: outboard put the jets *level with
    // the rear tyres*, and a tyre is the tallest opaque thing on this kart. The
    // whole plume was rendering behind two black cylinders and reading as
    // nothing more than a warm rim light on them. Half a metre further back
    // clears them, and the chase camera looks down, so it also drops the plume
    // onto the road where its colour has something to sit against.
    const OUT = 0.48;
    const BACK = 0.78;
    /** Seats `_p` at jet `i`'s mouth and returns which side it is. */
    const jet = (i) => {
      const sgn = i % 2 === 0 ? -1 : 1;
      model.anchors[i % 2 === 0 ? 'exhaustL' : 'exhaustR'].getWorldPosition(_p);
      _p.addScaledVector(_side, sgn * OUT);
      _p.addScaledVector(_w, -BACK);
      return sgn;
    };

    // 0. Spill light on the road under the pipes.
    //
    // The one thing missing from a boost that a still frame could never fake
    // with more sprites. A jet is a light source, and a light source that
    // leaves the surface beneath it unchanged is a decal. This is a flat pool
    // of the plume's own colour laid on the tarmac and left behind, so the
    // road under an accelerating kart runs blue (or orange, or whatever the
    // star is doing) for the metre and a half behind it.
    //
    // It is also the cheapest footprint in the file per unit of read: a wide
    // low-alpha coloured wash over dark asphalt moves a lot of pixels a little
    // way, which is what "the reward moment barely exists" was measuring, and
    // it cannot clip because it never touches more than one channel hard.
    const gy = this._groundY(kart);
    if (gy != null) {
      const poolN = emit('boostPool', 30);
      for (let i = 0; i < poolN; i++) {
        const sgn = jet(i);
        onRoad(_p, gy);
        _p.addScaledVector(_side, sgn * 0.1);
        _v.copy(_w).multiplyScalar(sp * 0.10);
        _c.copy(mid);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.GROUND, size: 2.7 + this.rng() * 1.1, sizeGrow: 2.6,
          life: 0.24 + this.rng() * 0.14, alpha: 0.26, drag: 0.6,
          rot: 1.0, colorB: tail,   // GROUND reads aRot as how filled it is
        });
      }
    }

    // 1. Core — a short hard flame sitting on the pipe mouth.
    //
    // This layer used to be eighteen soft round glows at alpha 0.72 stacked on
    // one point: about six units of linear radiance, i.e. a blown white blob
    // with no edge, which is the "two white dots at the origin" the plume was
    // being read as. Fewer, dimmer, and crisp: a FLAME sprite has a silhouette
    // and a white-hot axis of its own, so one of them already says "jet" and
    // five of them do not have to sum past white to do it.
    //
    // Then it went too far the other way. At 0.46 alpha and a quarter metre
    // across, the hottest part of a 143 km/h boost was a pale wedge you had to
    // be told about — the previous pass measured its own restraint as a win
    // and it was the wrong direction for a *reward*. Doubled and enlarged. The
    // budget it has to respect is clipping, and clipping counts pixels that
    // are saturated on all three channels: a small white-hot core costs
    // hundredths of a percent of the frame, and it is the single thing that
    // makes the effect read as thrust rather than as vapour.
    const coreN = emit('boostCore', 130);
    for (let i = 0; i < coreN; i++) {
      jet(i);
      _v.copy(_w).multiplyScalar(sp * 0.86 - (2 + this.rng() * 3));
      _v.y += 0.25;
      // The core is near-white everywhere else, which is right for a flame —
      // but a star jet whose hottest part never takes the hue reads as an
      // ordinary boost with something coloured happening around it.
      _c.copy(_CORE);
      if (kart.star > 0) _c.lerp(mid, 0.45);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.FLAME, size: 0.44 + this.rng() * 0.20,
        life: 0.095 + this.rng() * 0.06, alpha: 1.10, drag: 4, sizeGrow: 0.7,
        rot: 0.90, colorB: mid,   // FLAME reads aRot as its white-hot fraction
      });
    }

    // 2. Mid — the flame's actual colour, cooling into the tail colour.
    //
    // The sideways push here was 0.5-1.7 m/s per particle away from the
    // centreline on top of an already outboard jet, which is what opened the
    // plume into the two thirty-five-degree cones that read as spray. A jet
    // exhaust does not fan: it streams back along the axis and the cone comes
    // from the *spread in speed*, not from throwing the gas sideways.
    // Rate, not alpha, is what was blowing the hue out. Ten licks per jet
    // overlapping three deep at alpha 0.50 sums to about 1.5 of linear
    // radiance, which ACES still renders as orange; thirty-five overlapping
    // five deep sums past 2.5, the red channel saturates first, and what comes
    // out the far end is cream. A flame you can see the *edges* of does not
    // need the count — that was only ever compensating for having no shape.
    const midN = emit('boostMid', 185);
    for (let i = 0; i < midN; i++) {
      const sgn = jet(i);
      _v.copy(_w).multiplyScalar(sp * 0.58 - (4 + this.rng() * 6));
      _v.addScaledVector(_side, sgn * (0.10 + this.rng() * 0.35));
      _v.x += (this.rng() - 0.5) * 0.5;
      _v.y += (this.rng() - 0.5) * 0.5 + 0.30;
      _v.z += (this.rng() - 0.5) * 0.5;
      _c.copy(mid);
      // Bigger and stronger than the restraint pass left it, and the hue
      // survives it because the numbers that blow a hue out are *count* and
      // *overlap depth*, not one sprite's alpha: the rate is unchanged, so the
      // stack is the same three deep it was tuned to. What changed is that
      // each lick in the stack now has an edge you can find.
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.FLAME, size: 0.48 + this.rng() * 0.38,
        life: 0.16 + this.rng() * 0.13, alpha: 0.62, drag: 3.2, sizeGrow: 1.0,
        rot: 0.14, colorB: tail,   // barely any white: this layer *is* the hue
      });
    }

    // 3. Halo — dim, almost no inherited speed, so it stays where it was
    //    emitted and lays a trail that bends with the racing line.
    //
    // Every number here came down, because this layer was the one eating the
    // kart. A halo particle used to end life 3.8 m across; at the ~6.5 m the
    // chase camera sits back that is a 264-pixel disc, sixty of them alive at
    // once, all in the same colour, and the silhouette they are supposed to
    // frame is inside them. A halo is a rim around a jet, not weather: it may
    // reach a metre and a half, and the trail's *length* — not its radius —
    // is what says "going fast".
    // The two things that made this layer read as rust-coloured dust rather
    // than as a wake were both here. It inherited a *ninth* of the kart's
    // speed, so every halo particle was dropped 28 m/s slower than the lens
    // six metres behind it and spent the back half of its life sweeping across
    // the frame at arm's length — the diverging cone. And its normal-blended
    // twin was mixed 40% to white, which over a dozen stacked layers is
    // exactly how a saturated orange becomes muddy peach. It now keeps a third
    // of the speed and its whole hue.
    const haloN = emit('boostHalo', 55);
    for (let i = 0; i < haloN; i++) {
      const sgn = jet(i);
      _v.copy(_w).multiplyScalar(sp * 0.35);
      _v.y += 0.22 + this.rng() * 0.34;
      _v.addScaledVector(_side, sgn * (0.15 + this.rng() * 0.40));
      _c.copy(halo);
      // Discrete elements, not a soft column. A wide GLOW laid down twice a
      // frame and left behind composites into one continuous pale wedge from
      // the jet to the bottom of the frame — geometrically a correct trail,
      // and visually indistinguishable from spray coming off a wheel. The same
      // particles as crisp licks read as *things* being shed, which is the
      // only version of a trail that says the kart is under thrust.
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.FLAME, size: 0.56 + this.rng() * 0.36,
        life: 0.22 + this.rng() * 0.18, alpha: 0.21, drag: 1.2, sizeGrow: 0.9,
        rot: 0.0, colorB: tail,
      });
      // A normal-blended twin gives the trail body against a bright sky, where
      // an additive-only plume disappears. One in four, not one each: normal
      // blending compounds toward opaque, and at the old rate the column
      // between the camera and the kart stacked seventy layers deep — roughly
      // total coverage, whatever each one's alpha said. This layer is the only
      // thing here that can hide the kart outright rather than wash it out, so
      // it is the one that has to stay thin.
      //
      // It is also the only layer that can give the plume *contrast*. An
      // additive jet on a sunlit tan road is two brightish shapes on a bright
      // background: there is nothing for the hot core to be hot against, and
      // that — not the size of the plume — is why a boost over lit tarmac
      // reads as pale. A dark saturated version of the tail colour sitting
      // behind the flame is the backing every hand-painted fire has, and at
      // this rate it is five puffs deep, not seventy.
      if (i % 4 !== 0) continue;
      _c2.copy(tail);
      this.smoke.spawn(_p, _v, _c2, {
        shape: SHAPE.SMOKE, size: 0.42 + this.rng() * 0.30,
        life: 0.26 + this.rng() * 0.20, alpha: 0.085, drag: 1.0, sizeGrow: 0.5,
        gravity: -0.5, rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2,
        colorB: tail,
      });
    }

    // 4. Streaks — the direction cue. Fast, thin, short-lived, and thrown
    //    backwards hard so they stretch into visible lines.
    const strN = emit('boostStreak', 90);
    for (let i = 0; i < strN; i++) {
      const sgn = jet(i);
      _p.addScaledVector(_side, sgn * this.rng() * 0.22);
      _v.copy(_w).multiplyScalar(-(12 + this.rng() * 14));
      // Nearly no vertical jitter. The screen angle of a streak flying at the
      // lens is set by the perspective term, and any lateral component large
      // enough to compete with it tilts the line off the exhaust axis — which
      // is a streak that no longer says which way the kart is going.
      _v.y += (this.rng() - 0.5) * 0.5 + 0.2;
      _c.copy(mid).lerp(_WHITE, 0.35);
      // Thrown backwards at 12-26 m/s while the kart pulls away at 31, a
      // streak closes on the chase lens at up to 57 m/s. The old life let it
      // arrive — a 4-metre sprite two metres from the camera is a 450-pixel
      // bar across the kart, and seventeen of them were the "wide pale haze".
      // It now expires around five metres back, short of the lens, which is
      // also where a real jet streak has already burned out.
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.STREAK, size: 1.0 + this.rng() * 0.8,
        life: 0.085 + this.rng() * 0.055, alpha: 0.34, drag: 1.8, colorB: tail,
      });
    }

    // 5. Heat shimmer directly over the pipes.
    const shimN = emit('boostHeat', 26);
    for (let i = 0; i < shimN; i++) {
      jet(i);
      _p.addScaledVector(_w, -this.rng() * 1.4);
      _v.copy(_w).multiplyScalar(sp * 0.55);
      _v.y += 1.2 + this.rng() * 0.9;
      _c.setRGB(0.55, 0.50, 0.46);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.RIPPLE, size: 0.75 + this.rng() * 0.60,
        life: 0.26 + this.rng() * 0.18, alpha: 0.075, drag: 1.6, sizeGrow: 1.4,
        rot: this.rng() * TAU, colorB: 0x30281f,
      });
    }

    // Thrust pulses: a beat at a fixed rate reads as an engine doing work
    // rather than as a light that has been switched on.
    //
    // The beat used to be a screen-facing ring leaving each pipe, and at
    // exhaust scale a screen-facing ring is a thin hoop drawn round the flame
    // — the same hoop the impacts and the drift releases were just taken off.
    // The beat now lands on the road instead, as a hard bright flare inside
    // the spill: a pulse of light under the kart, which is what an engine
    // pulsing actually does to a surface, and which nothing has to be drawn
    // in front of the plume to say.
    st.boostPhase += dt * 18;
    if (st.boostPhase >= 1) {
      st.boostPhase -= Math.floor(st.boostPhase);
      for (let s = 0; gy != null && s < 2; s++) {
        jet(s);
        onRoad(_p, gy);
        _v.copy(_w).multiplyScalar(sp * 0.30);
        _c.copy(mid).lerp(_WHITE, 0.30);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.GROUND, size: 1.5, sizeGrow: 5.5,
          life: 0.14, alpha: 0.30, drag: 3, colorB: tail, rot: 0.85,
        });
      }
    }

    // Speed lines: only for the kart the camera is glued to, and placed out in
    // the periphery where they add velocity without covering the road.
    //
    // "Periphery" was a claim, not a fact: a 2.6 m radius at chase distance is
    // 180 screen pixels off centre, i.e. still on the kart, and they were
    // seeded up to ten metres *ahead* so they swept the whole length of it on
    // their way past. The ring now starts outside the kart's own silhouette
    // and they are seeded close enough that they leave frame before growing.
    if (kart.isPlayer) {
      const lines = emit('speedLine', 34);
      for (let i = 0; i < lines; i++) {
        const a = this.rng() * TAU;
        const r = 5.6 + this.rng() * 4.4;
        model.anchors.center.getWorldPosition(_p);
        _p.addScaledVector(_side, Math.cos(a) * r);
        _p.y += Math.sin(a) * r * 0.55 + 0.4;
        _p.addScaledVector(_w, 1.5 + this.rng() * 4.5);
        _v.copy(_w).multiplyScalar(-(20 + this.rng() * 18));
        // Mostly the boost's own hue. At 55% white on a sunlit tan road these
        // were pale scratches lying across the tarmac that read as scuffs in
        // the surface rather than as air going past — a speed line has to
        // belong to the effect that spawned it or it is dirt on the lens.
        _c.copy(mid).lerp(_WHITE, 0.22);
        this.additive.spawn(_p, _v, _c, {
          shape: SHAPE.STREAK, size: 2.0 + this.rng() * 1.8,
          life: 0.10 + this.rng() * 0.07, alpha: 0.10, drag: 0.6, colorB: mid,
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
    const st = this._state(kart);
    const n = this._emitAccum(kart, 'star', dt, 200 * rate);
    const gy = this._groundY(kart);
    _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
    for (let i = 0; i < n; i++) {
      model.anchors.center.getWorldPosition(_p);
      _p.x += (this.rng() - 0.5) * 2.3;
      _p.y += (this.rng() - 0.5) * 1.4;
      _p.z += (this.rng() - 0.5) * 2.8;
      // Symmetric in Y. A strictly positive lift made every spark climb, so
      // instead of a kart wrapped in glitter you got a plume of it hanging
      // above the roll bar and nothing at all along the sills.
      _v.set((this.rng() - 0.5) * 2.4, (this.rng() - 0.38) * 2.4, (this.rng() - 0.5) * 2.4);
      // Sparks keep almost all of the kart's momentum. With none of it they
      // were instantly thirty metres per second slower than the thing shedding
      // them, which is not a sparkle on a kart — it is a trail of litter down
      // the middle of the road, which is exactly how it read.
      _v.addScaledVector(_w, kart.speed * 0.86);
      // Hue steps off a per-spark counter, not off the clock. A clock gives
      // every spark alive in one frame the *same* hue: the frame is monochrome
      // and merely animates through the spectrum over a second, which is the
      // one thing a rainbow must never do. Stepping by the golden ratio puts
      // consecutive sparks 222 degrees apart, so the fifty-odd alive at any
      // instant cover the whole wheel and no two neighbours match. The slow
      // clock term only exists so a stationary kart still shimmers.
      const h = (st.starSeq++ * PHI + this._time * 0.11) % 1;
      _c.setHSL(h, 0.95, 0.62);
      // Cooling stays inside its own hue: a shared dark end colour would drag
      // every spark through the same mauve on the way out and undo the spread.
      _c2.setHSL(h, 1.0, 0.15);
      this.additive.spawn(_p, _v, _c, {
        // Half the old size and half the old life. Big and long-lived is what
        // let them pile up on the tarmac as static lozenges; a spark is a
        // fleck that is gone before it lands.
        shape: SHAPE.SPARK, size: 0.13 + this.rng() * 0.13,
        life: 0.15 + this.rng() * 0.19, alpha: 0.95, gravity: 3.0, drag: 1.4,
        ground: gy, rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 18,
        colorB: _c2,
      });
    }
  }

  // -- one-shots ------------------------------------------------------------

  /**
   * One-shot burst when something hits a kart.
   *
   * A hit has to be readable in peripheral vision from a single frame, and it
   * gets there the way every shipped kart racer does: three events on three
   * timescales that each answer a different question. A near-white flash says
   * *now*. A hard ring front says *here, and this big*. Tumbling debris with
   * real silhouettes says *something came apart* — and it is the only one of
   * the three still on screen a second later.
   *
   * What was here before was thirty-four soft round sprites in one colour and
   * a glow, which composites to a salmon smudge over the kart: three copies of
   * "something happened somewhere" and no answer to any of the questions.
   */
  impact(pos, color = 0xffcc44, count = 34) {
    const gy = this._groundNear(pos);
    // Off the road surface, or the flash and the ring spend half their area
    // clipped into the tarmac by the soft ground fade.
    _p.copy(pos); _p.y += 0.45;

    // 1. Flash: three frames at 60 Hz. Long enough to be seen, short enough
    //    that it cannot be photographed as a white frame — and small, because
    //    the thing that has to read is the *onset*, not the coverage.
    _c.copy(_FLASH);
    this.additive.spawn(_p, _ZERO, _c, {
      shape: SHAPE.GLOW, size: 0.82, sizeGrow: 8, life: 0.055, alpha: 2.45,
      drag: 8, colorB: color,
    });

    // 2. Two shock fronts at different rates, lying on the road. One ring is a
    //    circle; two moving apart is a blast, and the gap between them is what
    //    carries the speed.
    //
    //    Both used to be screen-facing annuli centred on the kart, so an
    //    impact rendered as two concentric hairline hoops threaded round the
    //    vehicle — aligned to nothing, occluding the tyres, and impossible to
    //    place in the world. On the ground they say *where* as well as *what*,
    //    and the kart in the middle of them stays in front.
    const fg = gy == null ? null : gy;
    _q.copy(pos); onRoad(_q, fg); if (fg == null) _q.y = pos.y;
    _c.setHex(color);
    this.additive.spawn(_q, _ZERO, _c, {
      shape: SHAPE.GROUND, size: 1.1, sizeGrow: 23, life: 0.24, alpha: 0.72,
      drag: 4, colorB: 0x1a0a0c, rot: 0.26,
    });
    _c2.copy(_FLASH).lerp(_c, 0.35);
    this.additive.spawn(_q, _ZERO, _c2, {
      shape: SHAPE.GROUND, size: 0.7, sizeGrow: 15, life: 0.15, alpha: 0.95,
      drag: 4, colorB: color, rot: 0.62,
    });
    // A pool of the hit's own colour left burning on the tarmac under it. The
    // fronts are gone in a quarter second; this is what is still saying "you
    // were hit here" when the eye arrives, and it is the only part of the
    // effect that puts light on the road instead of over it.
    this.additive.spawn(_q, _ZERO, _c, {
      shape: SHAPE.GROUND, size: 4.4, sizeGrow: 3.5, life: 0.44, alpha: 0.48,
      drag: 4, colorB: 0x120608, rot: 1.0,
    });

    // 3. Debris. Eight pieces, not thirty: you have to be able to *track* a
    //    piece for it to have come off anything, and they go in the opaque
    //    pool because a silhouette is the whole point and additive sprites
    //    have none. Real gravity, a bounce, and a tumble on aRot.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8 + this.rng() * 0.1) * TAU;
      const sp = 4.5 + this.rng() * 5.5;
      _v.set(Math.cos(a) * sp, 4.5 + this.rng() * 4.5, Math.sin(a) * sp);
      _c.setHex(color).offsetHSL(0, -0.20, -0.46);
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SHARD, size: 0.20 + this.rng() * 0.16,
        life: 0.85 + this.rng() * 0.55, alpha: 0.95, gravity: 20, drag: 0.35,
        ground: gy, bounce: 0.36,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 22, colorB: 0x241c18,
      });
    }

    // 4. Sparks: fewer and tapered. Thirty round ones at half a metre each is
    //    the "twenty-five soft circles scattered over the kart"; twenty combs
    //    that you can follow outward from a centre is a burst.
    const sparks = Math.round(count * 0.62);
    for (let i = 0; i < sparks; i++) {
      _v.set(this.rng() - 0.5, this.rng() * 0.9, this.rng() - 0.5).normalize()
        .multiplyScalar(6 + this.rng() * 13);
      _c.setHex(color).offsetHSL((this.rng() - 0.5) * 0.06, 0, (this.rng() - 0.5) * 0.18);
      const streak = this.rng() < 0.25;
      this.additive.spawn(_p, _v, _c, {
        shape: streak ? SHAPE.STREAK : SHAPE.EMBER,
        size: streak ? 1.3 + this.rng() * 1.2 : 0.40 + this.rng() * 0.45,
        life: 0.30 + this.rng() * 0.35, alpha: streak ? 0.45 : 1.0,
        gravity: streak ? 2 : 14, drag: streak ? 2.4 : 1.1,
        ground: gy, bounce: streak ? 0 : 0.42,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16, colorB: 0x20080c,
      });
    }

    // 5. Scorch: the part that lingers after everything else is gone. Thinner
    //    than it was — the debris now carries the aftermath, and a dark puff
    //    over the kart was hiding the pieces it was supposed to sell.
    for (let i = 0; i < 10; i++) {
      const a = this.rng() * TAU;
      const sp = 1.5 + this.rng() * 4.5;
      _v.set(Math.cos(a) * sp, this.rng() * 1.4 + 0.2, Math.sin(a) * sp);
      _c.setRGB(0.14, 0.12, 0.11);
      this.smoke.spawn(pos, _v, _c, {
        shape: SHAPE.SMOKE, size: 0.50 + this.rng() * 0.6,
        life: 0.7 + this.rng() * 0.6, alpha: 0.17, gravity: -0.4, drag: 2.2,
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
      _c.setRGB(0.55, 0.50, 0.42);
      _q.copy(pos); onRoad(_q, gy);
      this.smoke.spawn(_q, _ZERO, _c, {
        shape: SHAPE.GROUND, size: 2.0, sizeGrow: 13, life: 0.30,
        alpha: 0.34 * strength, drag: 5, colorB: 0x6a6259, rot: 0.10,
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
      _q.copy(pos); onRoad(_q, gy);
      this.additive.spawn(_q, _ZERO, _c, {
        shape: SHAPE.GROUND, size: ring * 1.2, sizeGrow: ring * 14, life: 0.26,
        alpha: 0.60, drag: 4, colorB: 0x0c0c12, rot: 0.22,
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

  /**
   * An item box being collected — the moment the box stops existing.
   *
   * This used to be `burst()`: roughly eight four-pixel star sprites and
   * nothing else. No shatter, no flash, no front. Taking a box was therefore
   * the one event in the game with a *worse* presentation than driving in a
   * straight line, and a pickup a player will not change line for is a pickup
   * that is not doing its job on the track layout either.
   *
   * A container coming apart reads from three things, in this order: the thing
   * is suddenly gone (flash), pieces of it are in the air (shards with real
   * silhouettes, tumbling, falling, bouncing on the road), and the space it
   * occupied is briefly lit (front and spill). The shards are the expensive
   * part and the only part still on screen half a second later, so they carry
   * the hue: a box is a rainbow prism, and its pieces are pieces of a rainbow.
   */
  itemBreak(pos) {
    const gy = this._groundNear(pos);
    _p.copy(pos);

    // 1. Flash. Three frames, small, near-white — the onset, nothing else.
    _c.copy(_FLASH);
    this.additive.spawn(_p, _ZERO, _c, {
      shape: SHAPE.GLOW, size: 1.45, sizeGrow: 12, life: 0.07, alpha: 2.6,
      drag: 8, colorB: 0xffd070,
    });

    // 2. Fronts on the road under it, so the pickup has a footprint the eye
    //    can find even when the box itself was behind another kart.
    _q.copy(pos); onRoad(_q, gy);
    _c.setRGB(1.00, 0.82, 0.34);
    this.additive.spawn(_q, _ZERO, _c, {
      shape: SHAPE.GROUND, size: 1.6, sizeGrow: 25, life: 0.26, alpha: 0.85,
      drag: 4, colorB: 0x2a1804, rot: 0.16,
    });
    this.additive.spawn(_q, _ZERO, _c, {
      shape: SHAPE.GROUND, size: 3.8, sizeGrow: 3.0, life: 0.38, alpha: 0.44,
      drag: 4, colorB: 0x1a1004, rot: 1.0,
    });

    // 3. Shards. Eighteen pieces of prism, each keeping its own hue right
    //    through its life so the shower is a spectrum rather than a colour.
    //    Opaque pool: a silhouette is the entire point and additive sprites
    //    have none.
    for (let i = 0; i < 18; i++) {
      const a = (i / 18 + this.rng() * 0.12) * TAU;
      const sp = 3.5 + this.rng() * 5.0;
      _v.set(Math.cos(a) * sp, 3.0 + this.rng() * 5.0, Math.sin(a) * sp);
      const h = (i * PHI + 0.1) % 1;
      setLuma(_c.setHSL(h, 0.85, 0.62), 0.68);
      setLuma(_c2.setHSL(h, 0.95, 0.30), 0.14);
      this.smoke.spawn(_p, _v, _c, {
        shape: SHAPE.SHARD, size: 0.26 + this.rng() * 0.24,
        life: 0.70 + this.rng() * 0.50, alpha: 0.95, gravity: 19, drag: 0.4,
        ground: gy, bounce: 0.38,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 24, colorB: _c2,
      });
    }

    // 4. Sparkle. Tapered, so it reads as thrown outward from a centre rather
    //    than as confetti that happened to land near the kart.
    for (let i = 0; i < 30; i++) {
      _v.set(this.rng() - 0.5, this.rng() * 0.85 + 0.15, this.rng() - 0.5).normalize()
        .multiplyScalar(5 + this.rng() * 11);
      const h = (this.rng() * 0.18 + 0.08) % 1;
      setLuma(_c.setHSL(h, 0.90, 0.66), 0.95);
      this.additive.spawn(_p, _v, _c, {
        shape: SHAPE.EMBER, size: 0.30 + this.rng() * 0.30,
        life: 0.26 + this.rng() * 0.30, alpha: 1.0, gravity: 13, drag: 1.2,
        ground: gy, bounce: 0.40,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16, colorB: 0x2a1000,
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
// Impact flash. Slightly warm rather than pure white so the first frame still
// belongs to the same palette as the sparks that follow it.
const _FLASH = new THREE.Color().setRGB(1.00, 0.96, 0.90);
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
// Rewritten every frame a star is up, hence separate instances: the plume
// loops hold references to these while `_c`/`_c2` are being reused inside them.
const _STAR_MID = new THREE.Color();
const _STAR_TAIL = new THREE.Color();
const _STAR_HALO = new THREE.Color();
