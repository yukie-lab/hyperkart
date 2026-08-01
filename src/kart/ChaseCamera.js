import * as THREE from 'three';
import { clamp, clamp01, damp, dampAngle, lerp, smoothstep, wrapAngle } from '../core/MathX.js';

/**
 * The chase camera.
 *
 * In a kart racer the camera is a gameplay system, not a passive observer: it
 * communicates speed (FOV), corner direction (yaw lead), and impact (shake).
 * The rig follows the kart's *travel* direction rather than its body yaw, so a
 * drifting kart slides visibly sideways within frame instead of the world
 * swinging around it — the detail that makes drifts read as drifts.
 */

const MODES = {
  chase:   { dist: 7.4, height: 2.95, look: 5.2, fov: 62 },
  near:    { dist: 5.4, height: 2.35, look: 4.6, fov: 66 },
  far:     { dist: 9.6, height: 3.9,  look: 6.4, fov: 58 },
  bumper:  { dist: 0.4, height: 1.15, look: 9.0, fov: 74 },
};

export class ChaseCamera {
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.mode = opts.mode || 'chase';
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    this.yaw = 0;
    this.height = MODES.chase.height;
    this.dist = MODES.chase.dist;
    this.fov = MODES.chase.fov;
    this.roll = 0;
    this.shake = 0;
    this.shakeSeed = Math.random() * 1000;
    this.lookBack = false;

    this._initialised = false;
    this._tmp = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  setMode(mode) { if (MODES[mode]) this.mode = mode; }

  snapTo(kart) {
    this.yaw = kart.yaw;
    this._initialised = false;
    this.update(0.016, kart, { intro: false });
    this._initialised = true;
  }

  /**
   * @param {number} dt
   * @param {import('./Kart.js').Kart} kart
   * @param {{lookBack?:boolean, shakeImpulse?:number, intro?:boolean}} opts
   */
  update(dt, kart, opts = {}) {
    const cfg = MODES[this.mode] || MODES.chase;
    const speed01 = clamp01(Math.abs(kart.speed) / Math.max(kart.stats.topSpeed, 1));
    const boosting = kart.boostActive;

    // --- Yaw ------------------------------------------------------------
    // Follow travel direction; lead slightly into the corner so the player
    // sees where they're going rather than where they've been.
    let targetYaw = kart.yaw;
    const lead = kart.drift.active
      ? kart.drift.dir * 0.30
      : kart.wheelSteer * 0.16 * speed01;
    targetYaw += lead;
    if (opts.lookBack) targetYaw += Math.PI;

    // A drifting kart needs a faster camera or the kart leaves frame; a
    // straight-line kart wants a slow, stable one.
    const yawRate = kart.drift.active ? 5.4 : lerp(3.0, 4.4, speed01);
    this.yaw = this._initialised ? dampAngle(this.yaw, targetYaw, yawRate, dt) : targetYaw;

    // --- Distance / height / FOV ----------------------------------------
    // The rig pulls back and drops as speed rises, and pushes in on boost.
    const speedPull = speed01 * 0.9 + (boosting ? 0.85 : 0);
    const targetDist = cfg.dist + speedPull * 0.55 - (kart.drift.active ? 0.25 : 0);
    const targetHeight = cfg.height + speed01 * 0.32 + (kart.grounded ? 0 : clamp(kart.pos.y * 0.0, 0, 1));
    const targetFov = cfg.fov + speed01 * 8.0 + (boosting ? 7.5 : 0);

    this.dist = damp(this.dist, targetDist, 4.5, dt);
    this.height = damp(this.height, targetHeight, 4.5, dt);
    this.fov = damp(this.fov, targetFov, boosting ? 9 : 5, dt);

    // --- Placement -------------------------------------------------------
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this._desired.set(
      kart.visualPos.x - sy * this.dist,
      kart.visualPos.y + this.height,
      kart.visualPos.z - cy * this.dist,
    );

    if (!this._initialised) {
      this.pos.copy(this._desired);
    } else {
      // Critically-damped follow, with the vertical axis softer so crests and
      // landings don't jolt the frame.
      this.pos.x = damp(this.pos.x, this._desired.x, 11, dt);
      this.pos.z = damp(this.pos.z, this._desired.z, 11, dt);
      this.pos.y = damp(this.pos.y, this._desired.y, kart.grounded ? 7 : 4.2, dt);
    }

    // Never let the camera drop below the road it is following.
    if (kart.ground?.height !== undefined) {
      const floor = kart.ground.height + 0.9;
      if (this.pos.y < floor) this.pos.y = damp(this.pos.y, floor, 20, dt);
    }

    // --- Look target -----------------------------------------------------
    const lookDist = cfg.look + speed01 * 2.2;
    const ly = opts.lookBack ? -1 : 1;
    this._lookAt.set(
      kart.visualPos.x + Math.sin(this.yaw) * lookDist * ly,
      kart.visualPos.y + 1.05 + speed01 * 0.25,
      kart.visualPos.z + Math.cos(this.yaw) * lookDist * ly,
    );
    this.target.lerp(this._lookAt, this._initialised ? 1 - Math.exp(-14 * dt) : 1);

    // --- Roll ------------------------------------------------------------
    // Bank into drifts and follow the road's camber a little.
    const bankRoll = (kart.ground?.normal ? Math.asin(clamp(-kart.ground.normal.x * 0, -1, 1)) : 0);
    const targetRoll = -kart.drift.bodyAngle * 0.16 - kart.wheelSteer * speed01 * 0.035 + bankRoll;
    this.roll = damp(this.roll, targetRoll, 6, dt);

    // --- Shake -----------------------------------------------------------
    if (opts.shakeImpulse) this.shake = Math.min(1, this.shake + opts.shakeImpulse);
    // Rough surfaces and boosts add a constant low-level tremor.
    const ambientShake = kart.rumble * 0.14 + (boosting ? 0.10 : 0);
    this.shake = damp(this.shake, ambientShake, 5, dt);

    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      const t = performance.now() * 0.001 + this.shakeSeed;
      const s = this.shake * 0.30;
      this.camera.position.x += Math.sin(t * 47.3) * s;
      this.camera.position.y += Math.sin(t * 61.7) * s * 0.8;
      this.camera.position.z += Math.sin(t * 53.1) * s;
    }

    this.camera.up.set(Math.sin(this.roll), Math.cos(this.roll), 0)
      .applyAxisAngle(_Y, this.yaw).normalize();
    this.camera.lookAt(this.target);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Slow orbit used on menus and the results screen. */
  updateOrbit(dt, center, time, radius = 14, height = 5.5) {
    const a = time * 0.22;
    this.camera.position.set(
      center.x + Math.sin(a) * radius,
      center.y + height,
      center.z + Math.cos(a) * radius,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center.x, center.y + 0.9, center.z);
    if (this.camera.fov !== 46) { this.camera.fov = 46; this.camera.updateProjectionMatrix(); }
  }
}

const _Y = new THREE.Vector3(0, 1, 0);
