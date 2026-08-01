import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, mod, ringDelta, sign, smoothstep, wrapAngle } from '../core/MathX.js';
import { makeRng } from '../core/MathX.js';

/**
 * Computes an approximate racing line for a track: out-in-out through corners,
 * smoothed so entry and exit are gradual rather than snapping at the apex.
 *
 * Cached on the track, since every AI driver shares it.
 */
export function buildRacingLine(track) {
  if (track._racingLine) return track._racingLine;
  const sp = track.spline;
  const n = sp.count;
  const raw = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const k = sp.curvature[i];
    const half = sp.width[i] * 0.5;
    const usable = half - 2.4;
    // Sit on the outside of the corner on entry, cut to the inside at the
    // apex. `k` is signed, so this naturally flips for left/right.
    const strength = clamp01(Math.abs(k) * 165);
    raw[i] = -sign(k) * usable * strength;
  }

  // Heavy smoothing turns the per-sample apex targets into a flowing line.
  let line = raw;
  for (let pass = 0; pass < 4; pass++) {
    const out = new Float32Array(n);
    const r = 26;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += line[mod(i + j, n)];
      out[i] = sum / (r * 2 + 1);
    }
    line = out;
  }

  // Clamp back inside the road after smoothing widened the excursions.
  for (let i = 0; i < n; i++) {
    const usable = sp.width[i] * 0.5 - 2.2;
    line[i] = clamp(line[i], -usable, usable);
  }

  // Maximum cornering speed per sample, from lateral acceleration limits.
  const maxSpeed = new Float32Array(n);
  const LATERAL_G = 17.5;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(sp.curvature[i]);
    maxSpeed[i] = k < 1e-5 ? 999 : Math.sqrt(LATERAL_G / k);
  }
  // Backward pass: propagate braking requirements upstream so the AI slows
  // *before* the corner rather than in it.
  const BRAKE_DECEL = 16.0;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = maxSpeed[mod(i + 1, n)];
      const reach = Math.sqrt(next * next + 2 * BRAKE_DECEL * sp.ds);
      if (reach < maxSpeed[i]) maxSpeed[i] = reach;
    }
  }

  track._racingLine = { lateral: line, maxSpeed };
  return track._racingLine;
}

/**
 * A CPU opponent.
 *
 * Difficulty scales three things independently: how closely it tracks the
 * racing line, how much cornering speed it is willing to carry, and how
 * aggressively it uses items. Rubber-banding is applied as a small top-speed
 * modifier — enough to keep a field together, not enough to feel scripted.
 */
export class AIDriver {
  constructor(kart, track, opts = {}) {
    this.kart = kart;
    this.track = track;
    this.line = buildRacingLine(track);
    this.skill = clamp01(opts.skill ?? 0.8);
    this.rng = makeRng(opts.seed ?? (kart.index * 7919 + 13));

    // Each driver gets a slightly different line and rhythm so the pack
    // doesn't move as one organism.
    this.lineBias = (this.rng() * 2 - 1) * lerp(3.4, 1.0, this.skill);
    this.speedNoise = 0;
    this.noisePhase = this.rng() * 100;

    this.ctrl = { steer: 0, accel: 1, brake: 0, drift: false, driftPressed: false };
    this._prevDrift = false;
    this.driftHold = 0;
    this.stuckTime = 0;
    this.itemCooldown = this.rng() * 2;

    this._target = new THREE.Vector3();
    this._toTarget = new THREE.Vector3();
    this.avoidance = 0;
  }

  /** @param {{karts:any[], time:number, raceStarted:boolean, playerProgress:number}} ctx */
  update(dt, ctx) {
    const k = this.kart;
    if (k.finished) {
      this.ctrl.accel = 0.4;
      this.ctrl.steer = this._steerToLine(dt, 0);
      this.ctrl.drift = false;
      this.ctrl.driftPressed = false;
      return this.ctrl;
    }

    this.noisePhase += dt;
    this.speedNoise = Math.sin(this.noisePhase * 0.7) * 0.5 + Math.sin(this.noisePhase * 1.9) * 0.5;

    const steer = this._steerToLine(dt, this._avoid(dt, ctx));
    this.ctrl.steer = steer;

    // --- Throttle / braking ---------------------------------------------
    const lookIdx = this.track.spline.indexAt(k.s + 6 + k.speed * 0.55);
    let cornerLimit = this.line.maxSpeed[lookIdx];
    // Lower skill carries less speed and is more cautious.
    cornerLimit *= lerp(0.80, 1.03, this.skill) + this.speedNoise * 0.012;

    const rubber = this._rubberBand(ctx);
    const desired = Math.min(k.stats.topSpeed * rubber, cornerLimit);

    if (k.speed > desired * 1.06) {
      this.ctrl.brake = clamp01((k.speed - desired) / 6);
      this.ctrl.accel = 0;
    } else {
      this.ctrl.brake = 0;
      this.ctrl.accel = k.speed > desired ? 0.35 : 1;
    }

    // Off-road recovery: get back on the tarmac before worrying about pace.
    if (!k.ground.onRoad && k.grounded) {
      this.ctrl.accel = 1;
      this.ctrl.brake = 0;
    }

    // --- Drifting --------------------------------------------------------
    this._updateDrift(dt, steer, cornerLimit);

    // --- Unstick ---------------------------------------------------------
    if (Math.abs(k.speed) < 1.6 && ctx.raceStarted && !k.respawn.active && k.stun.time <= 0) {
      this.stuckTime += dt;
      if (this.stuckTime > 2.2) { k.triggerRespawn(); this.stuckTime = 0; }
    } else {
      this.stuckTime = 0;
    }

    // --- Items -----------------------------------------------------------
    this.itemCooldown -= dt;
    this.ctrl.useItem = false;
    if (k.item && this.itemCooldown <= 0) {
      if (this._shouldUseItem(ctx)) {
        this.ctrl.useItem = true;
        this.itemCooldown = lerp(1.4, 0.35, this.skill) + this.rng() * 0.5;
      }
    }

    return this.ctrl;
  }

  _steerToLine(dt, avoidOffset) {
    const k = this.kart;
    // Look further ahead the faster we're going — the classic pure-pursuit
    // trick that keeps the line smooth instead of oscillating.
    const lookahead = 7.5 + k.speed * 0.62;
    const targetS = k.s + lookahead;
    const idx = this.track.spline.indexAt(targetS);
    const half = this.track.halfWidthAt(targetS);
    let targetLat = this.line.lateral[idx] + this.lineBias + avoidOffset;
    targetLat = clamp(targetLat, -half + 1.6, half - 1.6);

    this.track.placeOnRoad(targetS, targetLat, this._target);
    this._toTarget.subVectors(this._target, k.pos);
    const desiredYaw = Math.atan2(this._toTarget.x, this._toTarget.z);
    const err = wrapAngle(desiredYaw - k.yaw);

    // Convert heading error into stick input, with a gain that falls off at
    // speed so the AI doesn't saw at the wheel on straights.
    const gain = lerp(2.6, 1.5, clamp01(k.speed / k.stats.topSpeed));
    return clamp(err * gain, -1, 1);
  }

  _avoid(dt, ctx) {
    // Nudge sideways to avoid the kart directly ahead, and to dodge hazards.
    const k = this.kart;
    let offset = 0;
    for (const other of ctx.karts) {
      if (other === k) continue;
      const ds = ringDelta(k.s, other.s, this.track.length);
      if (ds < 0.5 || ds > 14) continue;
      const dl = other.lateral - k.lateral;
      if (Math.abs(dl) > 4.0) continue;
      const urgency = (1 - ds / 14) * (1 - Math.abs(dl) / 4.0);
      offset += (dl >= 0 ? -1 : 1) * urgency * 4.2;
    }
    if (ctx.hazards) {
      for (const h of ctx.hazards) {
        const ds = ringDelta(k.s, h.s, this.track.length);
        if (ds < 0 || ds > 22) continue;
        const dl = h.lateral - k.lateral;
        if (Math.abs(dl) > 4.5) continue;
        const urgency = (1 - ds / 22);
        offset += (dl >= 0 ? -1 : 1) * urgency * 5.5;
      }
    }
    // Steer toward an item box when one is close and we're empty-handed.
    if (!k.item && ctx.itemBoxes) {
      let best = null, bestDs = 999;
      for (const b of ctx.itemBoxes) {
        if (!b.active) continue;
        const ds = ringDelta(k.s, b.s, this.track.length);
        if (ds < 2 || ds > 40) continue;
        if (ds < bestDs) { bestDs = ds; best = b; }
      }
      if (best) {
        const pull = (1 - bestDs / 40) * 3.2 * this.skill;
        offset += clamp(best.lateral - k.lateral, -1, 1) * pull;
      }
    }
    this.avoidance = damp(this.avoidance, clamp(offset, -6, 6), 6, dt);
    return this.avoidance;
  }

  _updateDrift(dt, steer, cornerLimit) {
    const k = this.kart;
    const wantDrift = Math.abs(steer) > lerp(0.42, 0.30, this.skill)
      && k.speed > 12
      && cornerLimit < k.stats.topSpeed * 0.94;

    if (wantDrift) this.driftHold += dt; else this.driftHold = 0;

    // Skilled drivers hold the drift long enough for a higher mini-turbo tier.
    const minHold = lerp(0.35, 0.12, this.skill);
    const active = this.driftHold > minHold;

    // Release once charged: better drivers wait for orange/purple.
    let release = false;
    if (k.drift.active) {
      const targetStage = this.skill > 0.85 ? 2 : this.skill > 0.6 ? 1 : 0;
      if (k.drift.stage >= targetStage && Math.abs(steer) < 0.55) release = true;
      if (!wantDrift && k.drift.stage >= 0) release = true;
      if (k.drift.stage >= 2) release = release || Math.abs(steer) < 0.75;
    }

    const drift = active && !release;
    this.ctrl.driftPressed = drift && !this._prevDrift;
    this.ctrl.drift = drift;
    this._prevDrift = drift;
  }

  _rubberBand(ctx) {
    // Keep the field near the player without ever making an AI faster than a
    // clean player lap. Ahead of the player: slightly slower. Behind: a small
    // catch-up allowance that scales with the gap.
    if (ctx.playerProgress === undefined) return 1;
    const gap = ctx.playerProgress - this.kart.raceDistance; // >0 = AI behind
    const base = lerp(0.905, 1.0, this.skill);
    const catchUp = clamp(gap / 220, -0.06, 0.085);
    return base + catchUp;
  }

  _shouldUseItem(ctx) {
    const k = this.kart;
    const item = k.item;
    if (!item) return false;
    switch (item) {
      case 'mushroom':
      case 'tripleMushroom':
        // Save the boost for somewhere it pays: a straight, or an escape from
        // the grass.
        return !k.ground.onRoad || Math.abs(k.ground.curvature) < 0.004;
      case 'banana':
        // Drop it when someone is close behind.
        return ctx.karts.some((o) => o !== k && ringDelta(o.s, k.s, this.track.length) > 0
          && ringDelta(o.s, k.s, this.track.length) < 22);
      case 'greenShell':
        return ctx.karts.some((o) => {
          if (o === k) return false;
          const ds = ringDelta(k.s, o.s, this.track.length);
          return ds > 2 && ds < 34 && Math.abs(o.lateral - k.lateral) < 4.5;
        });
      case 'redShell':
        return ctx.karts.some((o) => {
          const ds = ringDelta(k.s, o.s, this.track.length);
          return o !== k && ds > 2 && ds < 90;
        });
      case 'star':
      case 'thunder':
      case 'bulletBill':
        return true;
      default:
        return this.rng() < 0.5;
    }
  }
}
