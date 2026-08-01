import * as THREE from 'three';
import { ParticlePool } from './Particles.js';
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
 */

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();

export class KartFX {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const budget = opts.maxParticles ?? 4000;

    this.additive = new ParticlePool(scene, {
      max: Math.round(budget * 0.55), shape: 1,
      blending: THREE.AdditiveBlending, renderOrder: 6,
    });
    this.smoke = new ParticlePool(scene, {
      max: Math.round(budget * 0.45), shape: 2,
      blending: THREE.NormalBlending, renderOrder: 5,
    });

    this.rng = makeRng(9001);
    this._accum = new WeakMap();
    this.quality = opts.quality || 'high';

    this._buildShadowBlob();
  }

  _buildShadowBlob() {
    // A radial-gradient quad under each kart. Cheap, and it anchors the kart
    // to the road far more convincingly than the shadow map alone at speed.
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2;
        // Slightly elongated along the kart's length.
        const r = Math.hypot(dx * 1.15, dy * 0.86);
        const a = Math.pow(clamp01(1 - r), 1.7);
        const i = (y * size + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        img.data[i + 3] = a * 190;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.blobTex = new THREE.CanvasTexture(c);
    this.blobGeo = new THREE.PlaneGeometry(3.0, 3.6);
    this.blobGeo.rotateX(-Math.PI / 2);
    this.blobMat = new THREE.MeshBasicMaterial({
      map: this.blobTex, transparent: true, depthWrite: false,
      opacity: 0.62, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
  }

  createShadowBlob() {
    const m = new THREE.Mesh(this.blobGeo, this.blobMat.clone());
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

  /**
   * @param {number} dt
   * @param {Array} karts
   * @param {THREE.Vector3} cameraPos
   */
  update(dt, karts, cameraPos) {
    for (const kart of karts) {
      const rate = this._rate(kart, cameraPos);
      if (rate > 0.01) {
        this._driftSparks(dt, kart, rate);
        this._surfaceDust(dt, kart, rate);
        this._boostFlame(dt, kart, rate);
        this._exhaust(dt, kart, rate);
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

  _driftSparks(dt, kart, rate) {
    const d = kart.drift;
    if (!d.active || !kart.grounded) return;

    const model = kart.model;
    if (!model) return;

    // White tyre smoke from the moment the drift starts...
    const smokeN = this._emitAccum(kart, 'driftSmoke', dt, 46 * rate);
    for (let i = 0; i < smokeN; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _v.set((this.rng() - 0.5) * 2.4, this.rng() * 1.5 + 0.4, (this.rng() - 0.5) * 2.4);
      _v.addScaledVector(_w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw)), -kart.speed * 0.14);
      _c.setHSL(0.08, 0.05, 0.86);
      this.smoke.spawn(_p, _v, _c, {
        size: 1.5 + this.rng() * 1.2, life: 0.55 + this.rng() * 0.35,
        alpha: 0.24, gravity: -1.2, drag: 2.4,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 3, sizeGrow: 3.4,
      });
    }

    // ...then coloured sparks once a mini-turbo tier is charged.
    if (d.stage < 0) return;
    const stage = DRIFT.stages[d.stage];
    const sparkN = this._emitAccum(kart, 'driftSpark', dt, (70 + d.stage * 45) * rate);
    for (let i = 0; i < sparkN; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      const spread = 3.4;
      _v.set((this.rng() - 0.5) * spread, this.rng() * 3.4 + 0.8, (this.rng() - 0.5) * spread);
      _v.addScaledVector(_w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw)), -kart.speed * 0.30);
      _c.setHex(stage.color);
      // A few sparks are pushed toward white to give the plume a hot core.
      if (this.rng() < 0.25) _c.lerp(_WHITE, 0.6);
      this.additive.spawn(_p, _v, _c, {
        size: 0.55 + this.rng() * 0.7, life: 0.30 + this.rng() * 0.28,
        alpha: 1.5, gravity: 7.5, drag: 1.4,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 12,
      });
    }
  }

  _surfaceDust(dt, kart, rate) {
    if (!kart.grounded) return;
    const surf = kart.surface;
    if (!surf.dust || Math.abs(kart.speed) < 3) return;
    const model = kart.model;
    if (!model) return;

    const intensity = surf.dust * clamp01(Math.abs(kart.speed) / 18);
    const n = this._emitAccum(kart, 'dust', dt, 55 * intensity * rate);
    const isSand = surf.dust > 1.0;
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 'driftL' : 'driftR';
      model.anchors[side].getWorldPosition(_p);
      _p.y -= 0.08;
      _v.set((this.rng() - 0.5) * 2.0, this.rng() * 2.0 + 0.5, (this.rng() - 0.5) * 2.0);
      _v.addScaledVector(_w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw)), -kart.speed * 0.22);
      _c.setHex(isSand ? 0xd9c294 : 0xa57b52).offsetHSL(0, 0, (this.rng() - 0.5) * 0.1);
      this.smoke.spawn(_p, _v, _c, {
        size: 1.8 + this.rng() * 1.8, life: 0.7 + this.rng() * 0.6,
        alpha: 0.34, gravity: -0.8, drag: 1.9,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2.4, sizeGrow: 4.2,
      });
    }
  }

  _boostFlame(dt, kart, rate) {
    if (!kart.boostActive) return;
    const model = kart.model;
    if (!model) return;
    const strong = kart.boostStrength > 0.45;
    const n = this._emitAccum(kart, 'boost', dt, 150 * rate);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 'exhaustL' : 'exhaustR';
      model.anchors[side].getWorldPosition(_p);
      _w.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw));
      _v.copy(_w).multiplyScalar(-(9 + this.rng() * 9));
      _v.x += (this.rng() - 0.5) * 2.2;
      _v.y += (this.rng() - 0.5) * 1.6 + 0.6;
      _v.z += (this.rng() - 0.5) * 2.2;
      // Hot core to cool tail across the particle's life.
      const t = this.rng();
      if (strong) _c.setHSL(lerp(0.58, 0.75, t), 0.95, lerp(0.75, 0.5, t));
      else _c.setHSL(lerp(0.10, 0.02, t), 0.95, lerp(0.72, 0.48, t));
      this.additive.spawn(_p, _v, _c, {
        size: 0.9 + this.rng() * 1.0, life: 0.16 + this.rng() * 0.18,
        alpha: 1.6, gravity: -2.5, drag: 4.5, sizeGrow: -1.4,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 8,
      });
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
        size: 0.5 + this.rng() * 0.4, life: 0.5 + this.rng() * 0.4,
        alpha: 0.10, gravity: -0.5, drag: 2.5, sizeGrow: 2.0,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 2,
      });
    }
  }

  /** One-shot burst when something hits a kart. */
  impact(pos, color = 0xffcc44, count = 34) {
    for (let i = 0; i < count; i++) {
      _v.set(this.rng() - 0.5, this.rng() * 0.9, this.rng() - 0.5).normalize()
        .multiplyScalar(4 + this.rng() * 11);
      _c.setHex(color).offsetHSL((this.rng() - 0.5) * 0.06, 0, (this.rng() - 0.5) * 0.2);
      this.additive.spawn(pos, _v, _c, {
        size: 0.7 + this.rng() * 1.1, life: 0.35 + this.rng() * 0.4,
        alpha: 1.8, gravity: 11, drag: 1.6,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 16,
      });
    }
  }

  /** Landing puff after a jump. */
  landing(pos, strength) {
    const n = Math.round(10 + strength * 22);
    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      _v.set(Math.cos(a) * (2 + this.rng() * 5), this.rng() * 1.2, Math.sin(a) * (2 + this.rng() * 5));
      _c.setHSL(0.09, 0.10, 0.78);
      this.smoke.spawn(pos, _v, _c, {
        size: 1.4 + this.rng() * 1.6, life: 0.45 + this.rng() * 0.4,
        alpha: 0.26 * (0.4 + strength), gravity: -0.6, drag: 2.6, sizeGrow: 4.5,
        rot: this.rng() * TAU, rotVel: (this.rng() - 0.5) * 3,
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
    // Fades and grows as the kart gets further off the ground.
    const h = Math.max(0, kart.visualPos.y - g.height - 0.42);
    const k = clamp01(h / 4.5);
    b.material.opacity = 0.62 * (1 - k * 0.85);
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
  }
}

const _WHITE = new THREE.Color(0xffffff);
const _UP = new THREE.Vector3(0, 1.2, 0);
