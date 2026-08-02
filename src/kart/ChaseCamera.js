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
    this.lookBack = false;

    this._initialised = false;
    this._desired = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();

    // Shake is driven off accumulated dt rather than the wall clock: the
    // screenshot harness steps the world deterministically, and a camera that
    // reads performance.now() makes every capture differ from the last for no
    // reason anyone can see.
    this._t = 0;
    this._shakePhase = 0;
    this._shakeDir = new THREE.Vector3(1, 0, 0);
    this._perp = new THREE.Vector3();
    this._dip = 0;
    this._fovKick = 0;
    this._wasBoosting = false;
    this._frame = {};
  }

  setMode(mode) { if (MODES[mode]) this.mode = mode; }

  snapTo(kart) {
    this.yaw = kart.yaw;
    // Snap the rig parameters to the *current* mode, not just its position.
    // They were seeded from `chase` in the constructor and only ever damped
    // toward the selected mode at rate 4.5, so a snap into `bumper` — whose
    // distance is 0.4 m — still sat 4-5 m back after settling. The screenshot
    // harness snaps and captures within a few frames, which is why nobody had
    // ever actually seen the bumper camera.
    const cfg = MODES[this.mode] || MODES.chase;
    this.dist = cfg.dist;
    this.height = cfg.height;
    this.fov = cfg.fov;
    this._initialised = false;
    this.update(0.016, kart, { intro: false });
    this._initialised = true;
  }

  /**
   * @param {number} dt
   * @param {import('./Kart.js').Kart} kart
   * @param {{lookBack?:boolean, shakeImpulse?:number, dipImpulse?:number, intro?:boolean}} opts
   */
  update(dt, kart, opts = {}) {
    const cfg = MODES[this.mode] || MODES.chase;
    const speed01 = clamp01(Math.abs(kart.speed) / Math.max(kart.stats.topSpeed, 1));
    const boosting = kart.boostActive;
    this._t += dt;

    // Where the road goes next, not where the wheels are pointed now.
    const ahead = this._lookAhead(kart);

    // --- Yaw ------------------------------------------------------------
    // Follow travel direction; lead into the corner so the player sees where
    // they're going rather than where they've been.
    //
    // Steering is a *reaction*: by the time the wheels are turned the corner is
    // already on top of the player, and a camera that follows the wheels always
    // arrives late. Sampling the spline about a second ahead lets the rig start
    // turning in before the kart does, which is what makes a fast line
    // readable at speed.
    let targetYaw = kart.yaw;
    const lead = kart.drift.active
      ? kart.drift.dir * 0.30
      : kart.wheelSteer * 0.16 * speed01;
    targetYaw += lead + ahead.yawLead * speed01;
    if (opts.lookBack) targetYaw += Math.PI;

    // A drifting kart needs a faster camera or the kart leaves frame; a
    // straight-line kart wants a slow, stable one.
    const yawRate = kart.drift.active ? 5.4 : lerp(3.0, 4.4, speed01);
    this.yaw = this._initialised ? dampAngle(this.yaw, targetYaw, yawRate, dt) : targetYaw;

    // --- Distance / height / FOV ----------------------------------------
    // The rig pulls back and drops as speed rises, and pushes in on boost.
    //
    // Airborne, the rig hangs back and rises *less* than the kart. Tracking a
    // jump one-for-one cancels it out: the kart stays pinned in frame and it is
    // the world that appears to drop, which reads as nothing happening.
    const air = clamp01(kart.airTime / 0.55);
    const speedPull = speed01 * 0.9 + (boosting ? 0.85 : 0);
    const targetDist = cfg.dist + speedPull * 0.55 - (kart.drift.active ? 0.25 : 0) + air * 1.15;
    const targetHeight = cfg.height + speed01 * 0.32 - air * 0.38 - this._dip;

    // A boost's sustained FOV widening says "you are going fast". The kick on
    // top of it — a transient that eases straight back out — is what says "you
    // just got faster", and that punch is the whole point of a boost.
    if (boosting && !this._wasBoosting) this._fovKick = 6.5;
    this._wasBoosting = boosting;
    this._fovKick = damp(this._fovKick, 0, 3.2, dt);
    const targetFov = cfg.fov + speed01 * 8.0 + (boosting ? 7.5 : 0) + this._fovKick;

    this._dip = damp(this._dip, 0, 7, dt);
    if (opts.dipImpulse) this._dip = Math.min(0.85, this._dip + opts.dipImpulse);

    this.dist = damp(this.dist, targetDist, 4.5, dt);
    this.height = damp(this.height, targetHeight, kart.grounded ? 4.5 : 3.0, dt);
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
    // Bank into drifts, and take a share of the road's own camber so the
    // authored banked corners actually feel banked. Only a share: matching the
    // camber one-for-one holds the horizon level, which throws away the very
    // cue that says the road is tilted.
    const targetRoll = -kart.drift.bodyAngle * 0.16
      - kart.wheelSteer * speed01 * 0.035
      + ahead.bank * 0.38;
    this.roll = damp(this.roll, targetRoll, 6, dt);

    // --- Shake -----------------------------------------------------------
    // An impact shoves the rig in a direction and it rings down; three
    // fixed-frequency sines read as a mechanical wobble instead. Frequency
    // falls with amplitude, so a hit starts sharp and ends as a slow settle.
    if (opts.shakeImpulse) {
      this.shake = Math.min(1, this.shake + opts.shakeImpulse);
      // No contact normal is carried on the events, so the direction is
      // decorrelated per impulse — enough that two hits never look identical.
      const a = this._t * 12.9898;
      this._shakeDir.set(Math.sin(a * 78.233), Math.sin(a * 43.7) * 0.55, Math.cos(a * 96.31)).normalize();
      this._shakePhase = 0;
    }
    const ambientShake = kart.rumble * 0.14 + (boosting ? 0.10 : 0);
    this.shake = damp(this.shake, ambientShake, 5, dt);
    this._shakePhase += dt * (26 + 34 * this.shake);

    this.camera.position.copy(this.pos);
    let rollShake = 0;
    if (this.shake > 0.001) {
      const s = Math.sin(this._shakePhase) * this.shake * 0.30;
      this._perp.set(-this._shakeDir.z, 0, this._shakeDir.x);
      this.camera.position.addScaledVector(this._shakeDir, s);
      this.camera.position.addScaledVector(this._perp, Math.sin(this._shakePhase * 1.7) * this.shake * 0.12);
      // A little roll in the shake: the rig is on a mount, not a rail.
      rollShake = Math.sin(this._shakePhase * 0.83) * this.shake * 0.030;
    }

    this.camera.up.set(Math.sin(this.roll + rollShake), Math.cos(this.roll + rollShake), 0)
      .applyAxisAngle(_Y, this.yaw).normalize();
    this.camera.lookAt(this.target);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Sample the track roughly a second of travel ahead.
   *
   * Returns the yaw the rig should lead by and the camber it should share, both
   * already clamped to sane camera amounts. Curvature is in rad/m, so the
   * tightest corner on any of the circuits (~60 m radius) lands near the cap
   * rather than swinging the frame around.
   */
  _lookAhead(kart) {
    const out = this._ahead || (this._ahead = { yawLead: 0, bank: 0 });
    const track = kart.track;
    if (!track?.frameAt) { out.yawLead = 0; out.bank = 0; return out; }
    const f = track.frameAt(kart.s + clamp(Math.abs(kart.speed), 6, 40) * 1.15, this._frame);
    out.yawLead = clamp(f.curvature * 13, -0.22, 0.22);
    out.bank = f.bank ?? 0;
    return out;
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
