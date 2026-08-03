import * as THREE from 'three';
import { PHYS, DRIVE, DRIFT, BOOST, DRAFT, COLLISION, RESPAWN, statsFor } from './KartTuning.js';
import { SURFACE } from '../track/Tracks.js';
import { clamp, clamp01, damp, dampAngle, lerp, mod, ringDelta, sign, smoothstep, wrapAngle } from '../core/MathX.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/**
 * A single kart: state, arcade physics, drift/mini-turbo, and the hooks that
 * items and the race director drive it through.
 *
 * The model treats `yaw` as the direction of travel and `bodyYaw` as the
 * visual orientation of the chassis. During a drift those diverge, which is
 * what produces the signature sideways pose without the physics ever having
 * to solve real tyre slip.
 */
export class Kart {
  constructor(track, opts = {}) {
    this.track = track;
    this.isPlayer = !!opts.isPlayer;
    this.characterId = opts.characterId || 'nova';
    this.stats = statsFor(this.characterId);
    this.name = this.stats.name;
    this.index = opts.index ?? 0;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.bodyYaw = 0;
    this.speed = 0;
    this.vy = 0;
    this.lateralVel = 0;
    this.grounded = true;
    this.airTime = 0;
    this.up = new THREE.Vector3(0, 1, 0);
    this.quaternion = new THREE.Quaternion();
    this.visualPos = new THREE.Vector3();

    // Interpolation snapshots so rendering stays smooth between fixed steps.
    this.prevPos = new THREE.Vector3();
    this.prevBodyYaw = 0;
    this.prevQuat = new THREE.Quaternion();

    this.drift = { active: false, dir: 0, charge: 0, stage: -1, hopping: false, straightTime: 0, bodyAngle: 0 };
    this.boosts = [];
    this.boostStrength = 0;
    this.boostActive = false;
    this.boostKind = null;
    // Rising-edge latch for boost-pad contact — see the surface block in `update`.
    this._onPad = false;

    this.trick = { armed: false, playing: false, t: 0, kind: 0 };
    this.draft = { t: 0, active: false };

    this.stun = { time: 0, kind: null, spin: 0 };
    this.squash = 0;
    this.star = 0;
    this.shield = null;

    this.respawn = { active: false, phase: 0, t: 0, s: 0, lateral: 0 };
    this.invuln = 0;

    this.ground = {};
    this.hint = -1;
    this.surface = SURFACE.ROAD;
    this.s = 0;
    this.lateral = 0;
    this.prevS = 0;

    this.raceDistance = 0;
    this.startOffset = 0;
    this.lap = 0;
    this.finished = false;
    this.finishTime = 0;
    this.rank = this.index + 1;
    this.lapTimes = [];
    this._lapStart = 0;

    this.coins = 0;
    this.item = null;
    this.itemRoulette = null;

    // Wheel visual state, consumed by the kart model.
    this.wheelSpin = 0;
    this.wheelSteer = 0;
    this.suspension = [0, 0, 0, 0];

    this.rumble = 0;
    this.engineLoad = 0;
    this.lastImpact = 0;
  }

  // -- Lifecycle ------------------------------------------------------------

  placeAt(slot) {
    this.pos.copy(slot.pos);
    this.pos.y += PHYS.rideHeight;
    this.yaw = slot.yaw;
    this.bodyYaw = slot.yaw;
    this.speed = 0;
    this.vy = 0;
    this.lateralVel = 0;
    this.grounded = true;
    this.s = slot.s;
    this.prevS = slot.s;
    this.lateral = slot.lateral;
    this.hint = this.track.spline.indexAt(slot.s);
    this.startOffset = mod(this.track.startS - slot.s, this.track.length);
    this.raceDistance = 0;
    this.lap = 0;
    this.finished = false;
    this.boosts.length = 0;
    this._onPad = false;
    this.drift.active = false;
    this.drift.charge = 0;
    this.drift.stage = -1;
    this.lapTimes = [];
    this._lapStart = 0;
    this.prevPos.copy(this.pos);
    this.prevBodyYaw = this.bodyYaw;
    this._syncTransform(0.016);
    this.prevQuat.copy(this.quaternion);
  }

  // -- External effects -----------------------------------------------------

  applyBoost(kind) {
    const cfg = BOOST[kind];
    if (!cfg) return;
    this.boosts.push({ time: cfg.time, strength: cfg.strength, kind });
    this.onBoostStart?.(kind);
  }

  applyDriftBoost(stage) {
    const st = DRIFT.stages[stage];
    if (!st) return;
    this.boosts.push({ time: st.boost, strength: st.strength, kind: 'drift' });
    this.onBoostStart?.('drift', stage);
  }

  spinout(duration = 1.15, kind = 'shell') {
    if (this.invuln > 0 || this.star > 0 || this.stun.time > 0.4) return false;
    this.stun.time = duration;
    this.stun.kind = kind;
    this.stun.spin = 0;
    this.speed *= 0.24;
    this.boosts.length = 0;
    this.drift.active = false;
    this.drift.charge = 0;
    this.onHit?.(kind);
    return true;
  }

  flatten(duration = 2.2) {
    if (this.invuln > 0 || this.star > 0) return false;
    this.stun.time = duration;
    this.stun.kind = 'squash';
    this.squash = 1;
    this.speed *= 0.35;
    this.boosts.length = 0;
    this.drift.active = false;
    this.onHit?.('squash');
    return true;
  }

  bump(dirX, dirZ, force) {
    this.pos.x += dirX * force * 0.35;
    this.pos.z += dirZ * force * 0.35;
    this.speed *= COLLISION.speedLoss;
    this.lastImpact = 1;
  }

  triggerRespawn() {
    if (this.respawn.active) return;
    this.respawn.active = true;
    this.respawn.phase = 0;
    this.respawn.t = 0;
    // Rewind to the last point that was safely on the road.
    this.respawn.s = mod(this.s - 6, this.track.length);
    this.respawn.lateral = clamp(this.lateral, -this.track.halfWidthAt(this.respawn.s) * 0.5,
      this.track.halfWidthAt(this.respawn.s) * 0.5);
    this.speed = 0;
    this.vy = 0;
    this.boosts.length = 0;
    // `update` early-returns while respawning, so the pad latch would otherwise
    // stay stuck at whatever it was when the kart left the road and swallow the
    // first pad it is dropped onto.
    this._onPad = false;
    this.drift.active = false;
    this.drift.charge = 0;
    this.onRespawn?.();
  }

  // -- Main step ------------------------------------------------------------

  /**
   * @param {number} dt fixed timestep
   * @param {{steer:number,accel:number,brake:number,drift:boolean,driftPressed:boolean}} ctrl
   * @param {{time:number, raceStarted:boolean, karts:Kart[]}} ctx
   */
  update(dt, ctrl, ctx) {
    this.prevPos.copy(this.pos);
    this.prevBodyYaw = this.bodyYaw;
    this.prevQuat.copy(this.quaternion);
    this.prevS = this.s;

    if (this.respawn.active) {
      this._updateRespawn(dt);
      this._syncTransform(dt);
      return;
    }

    // Timers -------------------------------------------------------------
    if (this.invuln > 0) this.invuln -= dt;
    if (this.star > 0) this.star -= dt;
    if (this.squash > 0) this.squash = Math.max(0, this.squash - dt * 0.5);
    if (this.lastImpact > 0) this.lastImpact = Math.max(0, this.lastImpact - dt * 3);

    const stunned = this.stun.time > 0;
    if (stunned) {
      this.stun.time -= dt;
      this.stun.spin += dt * (this.stun.kind === 'squash' ? 3.0 : 13.0);
      ctrl = { steer: 0, accel: this.stun.kind === 'squash' ? ctrl.accel * 0.4 : 0, brake: 0, drift: false, driftPressed: false };
    }
    // Cached for `_land()`, which decides whether a hop becomes a drift.
    this._lastSteer = ctrl.steer;

    // Ground query --------------------------------------------------------
    const g = this.track.sampleGround(this.pos, this.hint, this.ground);
    this.hint = g.index;
    this.s = g.s;
    this.lateral = g.lateral;

    const roadY = g.height + PHYS.rideHeight;

    // Fell off a void track, or fell below the world.
    if (!g.hasGround && this.grounded) {
      this.grounded = false;
      this.vy = Math.min(this.vy, -1);
    }
    if (this.pos.y < RESPAWN.fallY || (this.track.isVoid && this.pos.y < g.height - 25)) {
      this.triggerRespawn();
      this._syncTransform(dt);
      return;
    }

    // Surface -------------------------------------------------------------
    this.surface = this.grounded ? g.surface : SURFACE.ROAD;
    // A pad grants on contact, not once per frame of contact. The guard here
    // used to ask whether the *strongest* live boost was the pad, which is a
    // different question: `boostKind` reports the winner of `_updateSpeed`'s
    // resolve, so any stronger boost — a purple mini-turbo at 0.52, a mushroom,
    // a bullet — hid the pad and let it re-fire every step. One crossing then
    // produced ~55 stacked entries, ~55 `onBoostStart` callbacks at 120 Hz, and
    // an O(n) resolve over an array that only grew. Edge-detecting the contact
    // itself cannot be fooled by what else is running.
    const onPad = this.grounded && g.surface === SURFACE.BOOST;
    if (onPad && !this._onPad) this.applyBoost('pad');
    this._onPad = onPad;

    // Drift ---------------------------------------------------------------
    this._updateDrift(dt, ctrl, g);

    // Steering ------------------------------------------------------------
    this._updateSteering(dt, ctrl, g);

    // Longitudinal --------------------------------------------------------
    this._updateSpeed(dt, ctrl, ctx, g);

    // Integrate -----------------------------------------------------------
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _right.set(_fwd.z, 0, -_fwd.x);

    this.pos.addScaledVector(_fwd, this.speed * dt);
    this.pos.addScaledVector(_right, this.lateralVel * dt);
    this.lateralVel = damp(this.lateralVel, 0, DRIVE.slipDecay, dt);

    // Vertical ------------------------------------------------------------
    this._updateVertical(dt, ctrl, roadY, g);

    // Barriers ------------------------------------------------------------
    this._resolveWalls(g, dt);

    // Progress ------------------------------------------------------------
    this._updateProgress(dt, ctx);

    // Presentation state --------------------------------------------------
    this.wheelSpin += (this.speed / 0.36) * dt;
    this.wheelSteer = damp(this.wheelSteer,
      clamp(ctrl.steer + (this.drift.active ? this.drift.dir * 0.55 : 0), -1, 1), 12, dt);
    this.rumble = damp(this.rumble, this.grounded ? this.surface.rumble * clamp01(this.speed / 12) : 0, 8, dt);
    this.engineLoad = clamp01(Math.abs(this.speed) / Math.max(this.effectiveTopSpeed(), 1));

    this._syncTransform(dt);
  }

  // -- Sub-systems ----------------------------------------------------------

  _updateDrift(dt, ctrl, g) {
    const d = this.drift;

    // Initiate: hop first, drift engages on landing.
    if (ctrl.driftPressed && this.grounded && !d.active && !d.hopping && this.speed > DRIFT.minSpeed) {
      d.hopping = true;
      this.vy = DRIFT.hopVelocity;
      this.grounded = false;
      this.onHop?.();
    }

    // Airborne with drift held = trick.
    if (!this.grounded && !d.hopping && this.airTime > 0.16 && ctrl.driftPressed && !this.trick.playing) {
      this.trick.playing = true;
      this.trick.t = 0;
      this.trick.kind = (this.trick.kind + 1) % 4;
      this.trick.armed = true;
      this.onTrick?.(this.trick.kind);
    }
    if (this.trick.playing) {
      this.trick.t += dt;
      if (this.grounded) this.trick.playing = false;
    }

    if (d.active) {
      if (!ctrl.drift || this.speed < DRIFT.minSpeed * 0.55) {
        this._releaseDrift();
      } else {
        // Charge accrues faster the harder you steer into the drift.
        const into = clamp01(ctrl.steer * d.dir);
        const speedFactor = clamp01(this.speed / (this.stats.topSpeed * 0.5));
        d.charge += dt * (DRIFT.chargeBase + DRIFT.chargeSteerBonus * into) * speedFactor;

        let stage = -1;
        for (let i = DRIFT.stages.length - 1; i >= 0; i--) {
          if (d.charge >= DRIFT.stages[i].charge) { stage = i; break; }
        }
        if (stage !== d.stage) {
          d.stage = stage;
          if (stage >= 0) this.onDriftStage?.(stage);
        }

        // Steering fully against the drift for a moment cancels it.
        const against = ctrl.steer * d.dir < -0.55;
        d.straightTime = against ? d.straightTime + dt : 0;
        if (d.straightTime > DRIFT.cancelTime) this._cancelDrift();
      }
    }

    // Target body angle: leaning further out the deeper into the drift.
    const targetAngle = d.active
      ? d.dir * lerp(DRIFT.bodyAngleMin, DRIFT.bodyAngleMax, clamp01(0.45 + ctrl.steer * d.dir * 0.55))
      : 0;
    d.bodyAngle = damp(d.bodyAngle, targetAngle, DRIFT.bodyAngleRate, dt);
  }

  _releaseDrift() {
    const d = this.drift;
    if (d.stage >= 0) this.applyDriftBoost(d.stage);
    d.active = false;
    d.dir = 0;
    d.charge = 0;
    d.stage = -1;
    d.straightTime = 0;
  }

  _cancelDrift() {
    const d = this.drift;
    d.active = false;
    d.dir = 0;
    d.charge = 0;
    d.stage = -1;
    d.straightTime = 0;
  }

  _updateSteering(dt, ctrl, g) {
    const d = this.drift;
    // Authority ramps in with speed then bleeds off near the top end.
    const ramp = clamp01(Math.abs(this.speed) / DRIVE.steerRampSpeed);
    const highSpeed = lerp(1, DRIVE.steerHighSpeedFalloff,
      clamp01(Math.abs(this.speed) / Math.max(this.stats.topSpeed, 1)));
    let authority = ramp * highSpeed * this.surface.grip;
    if (!this.grounded) authority *= DRIVE.airSteerFactor;

    let yawRate;
    if (d.active && this.grounded) {
      // Drifting: the kart always rotates toward the drift direction, and the
      // stick modulates how tight the arc is.
      const mod2 = clamp(ctrl.steer * d.dir, -1, 1);
      yawRate = d.dir * (DRIFT.baseRate + DRIFT.steerRange * mod2) * authority;
    } else {
      yawRate = ctrl.steer * this.stats.steerRate * authority;
      if (this.speed < -0.2) yawRate = -yawRate; // reverse steering
    }

    this.yaw = wrapAngle(this.yaw + yawRate * dt);

    // A touch of lateral slide gives the chassis weight in hard corners, which
    // means throwing the body to the *outside* of the turn. Subtraction, not
    // addition: `lateralVel` shares its frame with `lateral` and `g.right`, and
    // that frame's positive direction is the kart's left, so a right-hand turn
    // (negative yawRate) has to drive it positive to slide out of the corner.
    this.lateralVel -= yawRate * this.speed * DRIVE.slipGain * dt;

    if (this.stun.time > 0 && this.stun.kind !== 'squash') {
      // Spinout rotates the body independently of the travel direction.
      this.drift.bodyAngle = 0;
    }
  }

  effectiveTopSpeed() {
    const surf = this.grounded ? this.surface.speed : 1;
    return this.stats.topSpeed * surf * (1 + this.boostStrength + (this.draft.active ? DRAFT.strength : 0));
  }

  _updateSpeed(dt, ctrl, ctx, g) {
    // Resolve active boosts — strongest wins rather than stacking.
    let strongest = 0, kind = null;
    for (let i = this.boosts.length - 1; i >= 0; i--) {
      const b = this.boosts[i];
      b.time -= dt;
      if (b.time <= 0) { this.boosts.splice(i, 1); continue; }
      if (b.strength > strongest) { strongest = b.strength; kind = b.kind; }
    }
    this.boostStrength = strongest;
    this.boostActive = strongest > 0;
    this.boostKind = kind;

    this._updateDraft(dt, ctx);

    const top = this.effectiveTopSpeed();

    if (!ctx.raceStarted) {
      // Pre-race: allow the rolling-start charge but never actual motion.
      this.speed = damp(this.speed, 0, 10, dt);
      return;
    }

    const throttle = ctrl.accel;
    const brake = ctrl.brake;

    if (this.speed > top) {
      this.speed -= DRIVE.overspeedDecel * dt;
      if (this.speed < top) this.speed = top;
    } else if (throttle > 0.02) {
      const ratio = clamp01(this.speed / Math.max(top, 1));
      const curve = 1 - ratio * ratio * 0.92;
      let a = this.stats.accel * curve * throttle;
      if (this.boostActive) a *= BOOST.accelMultiplier;
      a *= lerp(0.55, 1, this.surface.grip);
      this.speed += a * dt;
    } else if (brake > 0.02) {
      this.speed -= DRIVE.brakeDecel * brake * dt;
      const minSpeed = -DRIVE.reverseSpeed;
      if (this.speed < minSpeed) this.speed = minSpeed;
    } else {
      this.speed = damp(this.speed, 0, DRIVE.coastDecel / 3, dt);
    }

    // Off-road drag and drift cost.
    if (this.grounded) {
      if (this.surface.drag > 0) this.speed -= this.speed * this.surface.drag * dt;
      if (this.drift.active) this.speed *= Math.pow(DRIFT.speedPenalty, dt * 60 / 60);
      if (this.surface.speed < 1 && this.speed > top) this.speed = damp(this.speed, top, 6, dt);
    }

    if (this.finished) {
      // Coast to a stop after the flag.
      this.speed = damp(this.speed, 0, 1.2, dt);
    }
  }

  _updateDraft(dt, ctx) {
    if (!ctx.karts || ctx.karts.length < 2) { this.draft.active = false; return; }
    let inCone = false;
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    for (const other of ctx.karts) {
      if (other === this) continue;
      _v1.subVectors(other.pos, this.pos);
      const dist = _v1.length();
      if (dist > DRAFT.maxDistance || dist < DRAFT.minDistance) continue;
      _v1.divideScalar(dist);
      const dot = _v1.dot(_fwd);
      if (dot > Math.cos(DRAFT.halfAngle)) { inCone = true; break; }
    }
    if (inCone && this.speed > this.stats.topSpeed * 0.6) {
      this.draft.t += dt;
      this.draft.active = true;
      if (this.draft.t > DRAFT.buildTime) {
        this.boosts.push({ ...DRAFT.releaseBoost, kind: 'draft' });
        this.draft.t = 0;
        this.onBoostStart?.('draft');
      }
    } else {
      this.draft.t = Math.max(0, this.draft.t - dt * 2);
      this.draft.active = false;
    }
  }

  _updateVertical(dt, ctrl, roadY, g) {
    if (this.grounded) {
      const drop = this.pos.y - roadY;
      if (drop > 0.06 && !g.hasGround) {
        this.grounded = false;
      } else if (roadY < this.pos.y - 0.04) {
        // The road fell away beneath us — crest of a hill or a ramp lip.
        this.vy -= PHYS.gravity * dt;
        this.pos.y += this.vy * dt;
        if (this.pos.y <= roadY) { this.pos.y = roadY; this.vy = 0; }
        else if (this.pos.y - roadY > PHYS.airborneThreshold) { this.grounded = false; this.airTime = 0; }
      } else {
        // Rising road: follow it, hard, so ramps launch instead of clipping.
        this.pos.y = roadY;
        this.vy = 0;
      }
    } else {
      this.airTime += dt;
      this.vy -= PHYS.gravity * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= roadY && this.vy <= 0 && g.hasGround) {
        this.pos.y = roadY;
        this.vy = 0;
        this._land();
      }
    }
  }

  _land() {
    const wasAir = this.airTime;
    this.grounded = true;
    this.airTime = 0;
    const d = this.drift;
    if (d.hopping) {
      d.hopping = false;
      // Engage the drift only if the player is actually turning.
      const steer = this._lastSteer || 0;
      if (Math.abs(steer) > 0.15 && this.speed > DRIFT.minSpeed) {
        d.active = true;
        d.dir = sign(steer);
        d.charge = 0;
        d.stage = -1;
        d.straightTime = 0;
      }
    }
    if (this.trick.armed) {
      this.trick.armed = false;
      this.trick.playing = false;
      this.applyBoost('trick');
    }
    // Landing compresses the suspension proportionally to airtime.
    const impact = clamp01(wasAir / 0.9);
    for (let i = 0; i < 4; i++) this.suspension[i] = impact;
    if (wasAir > 0.25) this.onLand?.(impact);
  }

  _resolveWalls(g, dt) {
    if (this.track.isVoid) return; // rainbow road has no barriers, only gravity
    // Stopped by where the *bodywork* reaches, not by the collision radius.
    // See PHYS.bodyReach: the radius is a metre short of the car, which parked
    // it inside the embankment behind the barrier on canyonRush.
    const limit = g.wallLateral - PHYS.bodyReach;
    if (Math.abs(this.lateral) <= limit) return;

    const s = sign(this.lateral);
    const correction = limit * s - this.lateral;
    _right.copy(g.right);
    this.pos.addScaledVector(_right, correction);
    this.lateral = limit * s;

    // How head-on was it? Glancing hits should barely cost speed.
    const wallDir = Math.atan2(g.tangent.x, g.tangent.z);
    const inc = Math.abs(wrapAngle(this.yaw - wallDir));
    const headOn = clamp01((inc - COLLISION.wallGlanceAngle) / (Math.PI * 0.5 - COLLISION.wallGlanceAngle));

    if (headOn > 0.01) {
      this.speed *= lerp(1, COLLISION.wallSpeedLoss, headOn);
      this.lateralVel = -this.lateralVel * COLLISION.wallBounce;
      this._cancelDrift();
      this.lastImpact = Math.max(this.lastImpact, headOn);
      // Report every head-on engagement and let the listener decide what is
      // loud enough to react to. Gating at 0.4 here meant the barrier bled
      // speed, cancelled drifts and steered karts straight 2,940 times across
      // three races while reporting 9 — so the telemetry column read 0(0) on
      // every track and every seed, and no one could tell a working barrier
      // from an absent one.
      this.onWallHit?.(headOn);
    } else {
      // Scrape: bleed a little speed and steer parallel to the barrier.
      this.speed *= 0.995;
      this.yaw = dampAngle(this.yaw, wallDir + (s > 0 ? -0.06 : 0.06), 6, dt);
      this.lateralVel = 0;
    }
  }

  _updateProgress(dt, ctx) {
    const d = ringDelta(this.prevS, this.s, this.track.length);
    // Ignore teleport-sized deltas (respawns, projection jumps).
    if (Math.abs(d) < this.track.length * 0.25) this.raceDistance += d;

    const totalLaps = this.track.laps;
    const newLap = this.raceDistance >= this.startOffset
      ? Math.floor((this.raceDistance - this.startOffset) / this.track.length) + 1
      : 0;
    if (newLap > this.lap) {
      if (this.lap > 0) {
        this.lapTimes.push(ctx.time - this._lapStart);
      }
      this._lapStart = ctx.time;
      this.lap = newLap;
      if (this.lap > totalLaps && !this.finished) {
        this.finished = true;
        this.finishTime = ctx.time;
        this.onFinish?.();
      } else {
        this.onLap?.(this.lap);
      }
    }
  }

  _updateRespawn(dt) {
    const r = this.respawn;
    r.t += dt;
    const target = this.track.placeOnRoad(r.s, r.lateral, _v1);
    const f = this.track.frameAt(r.s, {});

    if (r.phase === 0) {
      // Lifted out of trouble.
      const k = clamp01(r.t / RESPAWN.liftTime);
      this.pos.lerp(_v2.copy(target).setY(target.y + RESPAWN.height), 1 - Math.pow(0.001, dt));
      this.yaw = dampAngle(this.yaw, f.heading, 5, dt);
      this.bodyYaw = this.yaw;
      if (k >= 1) { r.phase = 1; r.t = 0; }
    } else {
      const k = clamp01(r.t / RESPAWN.dropTime);
      this.pos.copy(target);
      this.pos.y += PHYS.rideHeight + RESPAWN.height * (1 - smoothstep(k));
      this.yaw = f.heading;
      this.bodyYaw = this.yaw;
      if (k >= 1) {
        r.active = false;
        this.grounded = true;
        this.vy = 0;
        this.speed = 0;
        this.invuln = RESPAWN.invulnTime;
        this.stun.time = 0;
        this.hint = this.track.spline.indexAt(r.s);
        this.s = r.s;
        this.prevS = r.s;
      }
    }
  }

  _syncTransform(dt) {
    // Chassis up-vector eases toward the road normal so banking reads on the
    // model without snapping when the kart clips a curb.
    const targetUp = this.grounded && this.ground.normal ? this.ground.normal : _up.set(0, 1, 0);
    this.up.lerp(targetUp, 1 - Math.exp(-8 * dt)).normalize();

    let visualYaw = this.yaw + this.drift.bodyAngle;
    if (this.stun.time > 0 && this.stun.kind !== 'squash') visualYaw += this.stun.spin;
    this.bodyYaw = visualYaw;

    _fwd.set(Math.sin(visualYaw), 0, Math.cos(visualYaw));
    // Re-orthogonalise the forward axis against the (banked) up vector.
    _fwd.addScaledVector(this.up, -_fwd.dot(this.up)).normalize();
    _right.crossVectors(this.up, _fwd).normalize();
    _m.makeBasis(_right, this.up, _fwd);
    this.quaternion.setFromRotationMatrix(_m);

    this.visualPos.copy(this.pos);

    // Suspension relaxes back out after compression.
    for (let i = 0; i < 4; i++) this.suspension[i] = damp(this.suspension[i], 0, 7, dt);
  }

  /** Snapshot used by the renderer, interpolated between fixed steps. */
  interpolate(alpha, outPos, outQuat) {
    outPos.lerpVectors(this.prevPos, this.pos, alpha);
    outQuat.slerpQuaternions(this.prevQuat, this.quaternion, alpha);
  }

  get speedKmh() { return Math.abs(this.speed) * 3.6; }
  get driftStageName() { return this.drift.stage >= 0 ? DRIFT.stages[this.drift.stage].name : null; }
}
