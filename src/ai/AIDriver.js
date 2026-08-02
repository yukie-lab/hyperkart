import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, mod, ringDelta, sign, smoothstep, wrapAngle } from '../core/MathX.js';
import { makeRng } from '../core/MathX.js';
import { DRIFT, DRIVE, PHYS } from '../kart/KartTuning.js';

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

// -- Drift planning ---------------------------------------------------------
//
// A drift is not a steering mode, it is a *fixed rate of rotation*: the kart
// yaws at `baseRate + steerRange * stick` regardless of what the corner wants,
// and the stick only trims it. So the question "can this corner be drifted?"
// is not about grip — there is no lateral grip limit in this physics at all —
// it is about whether the arc a drift draws can be made to overlap the arc the
// racing line draws, for long enough to charge a mini-turbo.
//
// Two facts fall out of that and drive everything below:
//
//  1. Steering authority *falls* with speed (steerHighSpeedFalloff) while the
//     yaw a corner demands *rises* with speed. So the faster the kart goes, the
//     wider the arc a drift can hold. Slowing for a corner you intend to drift
//     is exactly backwards — it tightens the drift into the apex.
//  2. The arcs never match exactly, so every drift spends road: the mismatch
//     integrates into lateral offset from the line. That offset is the real
//     budget, and it is what decides how long a drift can be held.
//
// The old AI drifted off an instantaneous "is the corner tight" test, which is
// the one question that does *not* predict any of this.

/** Yaw authority the steering model grants at speed `v`. Mirrors Kart._updateSteering. */
function steerAuthority(v, top = DRIVE.topSpeed) {
  const a = Math.abs(v);
  return clamp01(a / DRIVE.steerRampSpeed) * lerp(1, DRIVE.steerHighSpeedFalloff, clamp01(a / top));
}

/**
 * Deepest counter-steer the trim controller will hold. Sitting below -0.55 for
 * `DRIFT.cancelTime` *cancels* the drift and throws the charge away, so a
 * deeper hold has to be feathered — tapped back over the line before the timer
 * expires. -0.95 is what that duty cycle averages out to.
 */
const DRIFT_MOD_FLOOR = -0.95;
const DRIFT_MOD_CEIL = 0.98;
/** Metres of lateral offset from the racing line a drift is allowed to spend. */
const DRIFT_LINE_BUDGET = 4.6;
/** Hop-to-landing time; a drift only engages when the kart comes back down. */
const DRIFT_HOP_TIME = 2 * DRIFT.hopVelocity / PHYS.gravity;

function stageForCharge(c) {
  for (let i = DRIFT.stages.length - 1; i >= 0; i--) if (c >= DRIFT.stages[i].charge) return i;
  return -1;
}

/**
 * Roll a hypothetical drift forward from sample `i0` and report how long it
 * survives and how much charge it banks. This is the same control law the live
 * driver runs, so the plan and the execution agree about what is possible.
 */
function rollDrift(sp, vref, i0, dir, maxT) {
  const n = sp.count;
  let psi = 0;     // heading divergence between the drift arc and the line
  let err = 0;     // lateral offset that divergence has integrated into
  let t = 0, charge = 0, i1 = i0;
  for (let step = 1; step < n; step++) {
    const i = mod(i0 + step, n);
    const v = vref[i];
    const dt = sp.ds / v;
    if (t + dt > maxT) break;
    const a = steerAuthority(v);
    const lo = (DRIFT.baseRate + DRIFT.steerRange * DRIFT_MOD_FLOOR) * a;
    const hi = (DRIFT.baseRate + DRIFT.steerRange * DRIFT_MOD_CEIL) * a;
    const need = dir * sp.curvature[i] * v;
    // Null the banked offset when there is authority to spare; when there is
    // not, take the closest arc available and let the offset grow.
    const w = clamp(need - 2.4 * psi - 1.5 * err / v, lo, hi);
    psi += (w - need) * dt;
    err += psi * v * dt;
    if (Math.abs(err) > DRIFT_LINE_BUDGET) break;
    charge += dt * (DRIFT.chargeBase + DRIFT.chargeSteerBonus
      * clamp01((w / a - DRIFT.baseRate) / DRIFT.steerRange));
    t += dt;
    i1 = i;
  }
  return { t, charge, i1 };
}

/**
 * Every place on the track where a drift is worth taking, richest first, then
 * laid back out in track order. Cached on the track — it is a property of the
 * geometry, so all twelve drivers share one copy and it stays deterministic.
 */
export function buildDriftPlan(track) {
  if (track._driftPlan) return track._driftPlan;
  const line = buildRacingLine(track);
  const sp = track.spline;
  const n = sp.count;

  // Pace a committed driver actually carries here. The plan is built once, so
  // it uses a strong-driver reference; weaker drivers cut their own list down
  // by appetite rather than getting a different map.
  const vref = new Float32Array(n);
  for (let i = 0; i < n; i++) vref[i] = clamp(line.maxSpeed[i] * 1.02, DRIFT.minSpeed, DRIVE.topSpeed);

  const cands = [];
  for (let i = 0; i < n; i += 4) {
    const dir = sign(sp.curvature[i]);
    if (!dir) continue;
    const r = rollDrift(sp, vref, i, dir, 7.0);
    if (r.t < 0.9) continue;
    const span = mod(r.i1 - i, n);
    // The speed the arc was proved at, so a driver arriving slower than that
    // can tell the drift will no longer fit and leave the corner alone.
    let vs = 0;
    for (let j = 0; j <= span; j++) vs += vref[mod(i + j, n)];
    cands.push({
      i0: i, span, dir, dur: r.t, charge: r.charge,
      stage: stageForCharge(r.charge), vRef: vs / (span + 1),
    });
  }

  // Greedy by charge: the best drift through a corner wins, and neighbouring
  // starts that would clip it are dropped. The pad is the straightening-up and
  // re-hop time between two drifts.
  cands.sort((a, b) => (b.charge - a.charge) || (a.i0 - b.i0));
  const pad = Math.max(1, Math.round(14 / sp.ds));
  const used = new Uint8Array(n);
  const taken = [];
  for (const c of cands) {
    let clash = false;
    for (let s = -pad; s <= c.span + pad && !clash; s++) if (used[mod(c.i0 + s, n)]) clash = true;
    if (clash) continue;
    for (let s = -pad; s <= c.span + pad; s++) used[mod(c.i0 + s, n)] = 1;
    taken.push(c);
  }
  taken.sort((a, b) => a.i0 - b.i0);

  // `dur` and `charge` are the planner showing its working rather than driver
  // inputs — reading `track._driftPlan` should explain why a corner was picked.
  track._driftPlan = taken.map((c, idx) => ({
    idx,
    s0: c.i0 * sp.ds,
    s1: mod((c.i0 + c.span) * sp.ds, track.length),
    dir: c.dir,
    dur: c.dur,
    charge: c.charge,
    stage: c.stage,
    vRef: c.vRef,
  }));
  return track._driftPlan;
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
    this.stuckTime = 0;
    this.itemCooldown = this.rng() * 2;

    // --- Drifting ---------------------------------------------------------
    this.plan = buildDriftPlan(track);
    this.seg = null;          // the planned drift we are committed to
    this.driftTime = 0;
    this.driftOff0 = 0;       // line offset the slide inherited, so the budget
                              // measures what the slide itself spends
    this.hopWait = 0;         // re-press timer for a hop that failed to take
    this.driftCooldown = 0;
    this.driftSteer = null;   // overrides the pure-pursuit stick while sliding
    // Better drivers chase a higher tier before cashing in, and take more of
    // the corners on offer. Appetite is what keeps twelve karts from drifting
    // in perfect unison through the same apex.
    this.targetStage = this.skill > 0.74 ? 2 : this.skill > 0.58 ? 1 : 0;
    this.minStage = this.skill > 0.80 ? 0 : 1;
    this.driftAppetite = lerp(0.45, 1.0, this.skill);
    this.driftSalt = (this.rng() * 4096) | 0;
    // Turn-in is the one moment a drift can be started at all, so spread the
    // reaction time rather than having the field hop on the same metre.
    this.hopLead = lerp(0.02, 0.10, 1 - this.skill) + this.rng() * 0.04;

    this._target = new THREE.Vector3();
    this._toTarget = new THREE.Vector3();
    this.avoidance = 0;
    this.aim = { err: 0, gain: 0, dist: 20 };
    this._traffic = { left: false, right: false };
  }

  /** @param {{karts:any[], time:number, raceStarted:boolean, playerProgress:number}} ctx */
  update(dt, ctx) {
    const k = this.kart;
    if (k.finished) {
      this._aim(0);
      this.ctrl.steer = clamp(this.aim.err * this.aim.gain, -1, 1);
      this.ctrl.accel = 0.4;
      this.ctrl.drift = false;
      this.ctrl.driftPressed = false;
      return this.ctrl;
    }

    this.noisePhase += dt;
    this.speedNoise = Math.sin(this.noisePhase * 0.7) * 0.5 + Math.sin(this.noisePhase * 1.9) * 0.5;

    this._aim(this._avoid(dt, ctx));

    // Drift resolves before steering and throttle, because it owns both: a
    // sliding kart rotates at the drift's rate whatever the stick says, and
    // lifting off mid-drift tightens the arc into the apex.
    this._updateDrift(dt, ctx);

    // --- Throttle / braking ---------------------------------------------
    const lookIdx = this.track.spline.indexAt(k.s + 6 + k.speed * 0.55);
    let cornerLimit = this.line.maxSpeed[lookIdx];
    // Lower skill carries less speed and is more cautious.
    cornerLimit *= lerp(0.80, 1.03, this.skill) + this.speedNoise * 0.012;
    // A committed drift was planned at the reference pace; drop below it and
    // the arc no longer fits the corner. Cautious drivers get the same pace
    // here as anyone else, only for the length of the slide.
    if (k.drift.active || this.seg) cornerLimit = Math.max(cornerLimit, this.line.maxSpeed[lookIdx] * 1.02);

    const rubber = this._rubberBand(ctx);
    const desired = Math.min(k.stats.topSpeed * rubber, cornerLimit);

    if (k.speed > desired * 1.06 && !k.drift.active) {
      this.ctrl.brake = clamp01((k.speed - desired) / 6);
      this.ctrl.accel = 0;
    } else {
      this.ctrl.brake = 0;
      this.ctrl.accel = k.speed > desired && !k.drift.active ? 0.35 : 1;
    }

    // Off-road recovery: get back on the tarmac before worrying about pace.
    if (!k.ground.onRoad && k.grounded) {
      this.ctrl.accel = 1;
      this.ctrl.brake = 0;
    }

    // --- Steering --------------------------------------------------------
    this.ctrl.steer = this.driftSteer !== null
      ? this.driftSteer : clamp(this.aim.err * this.aim.gain, -1, 1);

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

  /**
   * Pure pursuit: heading error toward a point down the racing line. Kept as
   * raw geometry rather than a stick position, because the drift controller
   * needs the *yaw rate* the line is asking for, not a grip-steering command.
   */
  _aim(avoidOffset) {
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

    this.aim.err = wrapAngle(desiredYaw - k.yaw);
    this.aim.dist = Math.max(this._toTarget.length(), 4);
    // Gain falls off at speed so the AI doesn't saw at the wheel on straights.
    this.aim.gain = lerp(2.6, 1.5, clamp01(k.speed / k.stats.topSpeed));
    return this.aim;
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

  /**
   * The drift state machine: pick a corner from the plan, hop into it at
   * turn-in, hold and trim the slide, and let go where the mini-turbo does
   * some good. Sets `driftSteer` (which overrides pure pursuit) plus the
   * drift button.
   */
  _updateDrift(dt, ctx) {
    const k = this.kart;
    const d = k.drift;
    this.driftSteer = null;
    this.ctrl.driftPressed = false;
    if (this.driftCooldown > 0) this.driftCooldown -= dt;
    // Refreshed every frame, not just on approach: the release guard reads it
    // too, and a slide has to know about contact as it happens.
    this._scanTraffic(ctx);

    // Anything that takes the kart out of the driver's hands abandons the plan.
    const drivable = ctx.raceStarted && !k.respawn.active && k.stun.time <= 0
      && k.speed > DRIFT.minSpeed * 1.35;
    if (!drivable) {
      this.seg = null;
      this.driftTime = 0;
      this.ctrl.drift = false;
      return;
    }

    // --- Holding a slide --------------------------------------------------
    if (d.active) {
      if (this.driftTime === 0) this.driftOff0 = this._lineOffset() * d.dir;
      this.driftTime += dt;
      if (this._shouldRelease()) {
        // Letting go is what pays out the mini-turbo — `_cancelDrift` is the
        // failure mode and it keeps nothing, so we always exit this way.
        this.ctrl.drift = false;
        this.seg = null;
        this.driftTime = 0;
        // A slide that banked nothing was a misread of the corner, and the hop
        // that starts the next one is not free: wait out the rest of it rather
        // than bouncing straight back into the same mistake.
        this.driftCooldown = d.stage >= 0 ? 0.3 : 0.9;
        return;
      }
      this.ctrl.drift = true;
      this.driftSteer = this._trimDrift();
      return;
    }

    // --- Mid-hop ----------------------------------------------------------
    // The hop is dead time the drift has to be paid for up front, and it only
    // becomes a drift if the stick is turned on the frame the kart lands.
    if (d.hopping || (this.seg && !k.grounded)) {
      this.ctrl.drift = true;
      if (this.seg) this.driftSteer = this._turnIn(this.seg.dir);
      return;
    }

    // --- Approach ---------------------------------------------------------
    if (!this.seg) this.seg = this._pickSegment();
    if (!this.seg) { this.ctrl.drift = false; this.hopWait = 0; return; }

    const len = this.track.length;
    const ds = ringDelta(k.s, this.seg.s0, len);
    // Missed it — the corner is already behind us, so wait for the next one.
    if (ds < -k.speed * 0.5) { this.seg = null; this.ctrl.drift = false; return; }

    if (ds > k.speed * (DRIFT_HOP_TIME + this.hopLead)) {
      this.ctrl.drift = false;
      this.hopWait = 0;
      return;
    }

    // At turn-in. Press, and keep re-pressing: a hop that lands with the wheel
    // straight silently fails to engage, and there is no other signal for it.
    this.ctrl.drift = true;
    this.driftSteer = this._turnIn(this.seg.dir);
    this.hopWait -= dt;
    if (this.hopWait <= 0 && k.grounded) {
      this.ctrl.driftPressed = true;
      this.hopWait = 0.2;
    }
  }

  /** Next planned drift worth taking, or null. */
  _pickSegment() {
    if (this.driftCooldown > 0) return null;
    const k = this.kart;
    const len = this.track.length;
    // Each segment was proved holdable at a particular speed, and the arc only
    // fits at that speed: authority *falls* with speed while the yaw a corner
    // demands *rises*, so the corner a leader holds wide open is a ten-metre
    // spin circle for a kart still winding up out of the grid. Judged on
    // arrival speed rather than current speed, or a kart accelerating out of
    // the previous corner talks itself out of the next one and hops too late.
    const v = Math.min(k.speed + 10, k.stats.topSpeed);
    let best = null, bestDs = Infinity;
    for (const seg of this.plan) {
      if (seg.stage < this.minStage || v < seg.vRef * 0.8) continue;
      // A drift sweeps toward its own inside, so only that side blocks it.
      if (seg.dir > 0 ? this._traffic.right : this._traffic.left) continue;
      // Deterministic per-driver thinning, so the field doesn't drift as one
      // organism through every apex.
      const h = ((seg.idx * 2654435761) ^ this.driftSalt) >>> 0;
      if ((h % 1000) / 1000 > this.driftAppetite) continue;
      const ds = ringDelta(k.s, seg.s0, len);
      // Needs enough road left to hop *and* land before the corner: entering
      // late is worse than not entering, because the arc no longer lines up.
      if (ds < k.speed * DRIFT_HOP_TIME * 0.7 || ds > v * 1.2 + 8) continue;
      if (ds < bestDs) { bestDs = ds; best = seg; }
    }
    return best;
  }

  /**
   * Who the slide's arc would sweep into. A drift cannot dodge — it commits to
   * an arc that turns toward its own inside — so what blocks it is a kart
   * alongside on that side. Only that: pitched wider (anyone ahead, anyone
   * within a few car lengths) this fires seven frames in ten in a twelve-kart
   * field and the AI never drifts at all in the opening lap.
   */
  _scanTraffic(ctx) {
    const k = this.kart;
    const len = this.track.length;
    let left = false, right = false;
    for (const o of ctx.karts) {
      if (o === k) continue;
      const ds = ringDelta(k.s, o.s, len);
      if (Math.abs(ds) > 4) continue;
      const dl = o.lateral - k.lateral;
      if (dl > 0 && dl < 2.9) right = true;
      else if (dl < 0 && dl > -2.9) left = true;
    }
    this._traffic.left = left;
    this._traffic.right = right;
  }

  /**
   * Stick during the hop. A hop that lands with the wheel straight does not
   * become a drift at all, so the sign is forced — but only just, because this
   * is still the approach and the line has not asked for the corner yet.
   */
  _turnIn(dir) {
    const raw = clamp(this.aim.err * this.aim.gain, -1, 1) * dir;
    return dir * clamp(Math.max(raw, 0.22), -1, 1);
  }

  /**
   * Trim inside the slide. The drift sets the rotation; the stick only picks
   * where in the `baseRate ± steerRange` band that rotation sits. So invert
   * the steering model: work out the yaw rate the racing line is asking for,
   * then solve for the stick that delivers it.
   */
  _trimDrift() {
    const k = this.kart;
    const dir = k.drift.dir;
    // Pure-pursuit curvature 2·sin(err)/L, turned into a yaw rate.
    const want = 2 * k.speed * Math.sin(this.aim.err) / this.aim.dist;
    const a = steerAuthority(k.speed, k.stats.topSpeed) * (k.surface ? k.surface.grip : 1);
    let m = a > 1e-3 ? ((want * dir) / a - DRIFT.baseRate) / DRIFT.steerRange : 0;
    m = clamp(m, -1, 1);
    // Corners wider than the drift's tightest arc sit permanently below the
    // cancel threshold, so hold the deep counter-steer in bursts and tap back
    // over the line before `cancelTime` expires. Without this the AI throws
    // away the charge on exactly the long sweepers that charge best.
    if (m < -0.55 && k.drift.straightTime > DRIFT.cancelTime * 0.5) m = -0.5;
    return dir * m;
  }

  /** Signed metres between the kart and the racing line it is meant to be on. */
  _lineOffset() {
    const k = this.kart;
    return k.lateral - (this.line.lateral[this.track.spline.indexAt(k.s)] + this.lineBias);
  }

  /** Whether to cash the slide in this frame. */
  _shouldRelease() {
    const k = this.kart;
    const d = k.drift;
    const sp = this.track.spline;
    const len = this.track.length;
    const v = Math.max(k.speed, 1);

    // Where the slide is taking us, four tenths of a second out. A drift draws
    // a fixed arc, so projecting it is the only way to know it still fits.
    const half = this.track.halfWidthAt(k.s);
    const latRate = k.speed * Math.sin(wrapAngle(k.yaw - k.ground.heading)) + k.lateralVel;
    const latAhead = k.lateral + latRate * 0.4;
    // Leaving the road is a barrier on two tracks and a sixty-metre drop on the
    // third, so this guard is absolute — bank the tier rather than test it.
    // It is measured against the road edge and not against the racing line:
    // turn-in *is* the point where the line runs widest and is still going
    // wider, and a guard pitched any tighter than this kills every drift on
    // the frame it starts.
    const edge = this.track.isVoid ? half - 1.0 : half + 0.7;
    // Turn-in is the worst frame for every one of these tests — the hop has
    // just landed, lateral velocity is still the hop's, and the line is at its
    // widest — so give the slide a moment to settle before judging it.
    const settled = this.driftTime > 0.25;
    if ((settled || this.track.isVoid)
      && Math.abs(latAhead) > edge && Math.abs(latAhead) > Math.abs(k.lateral)) return true;
    if (k.grounded && !k.ground.onRoad) return true;

    // The line-error account `rollDrift` budgets for, now measured for real —
    // relative to where the slide started, because inheriting an offset from
    // an avoidance nudge is not the same as spending one.
    if (settled && this._lineOffset() * d.dir - this.driftOff0 > DRIFT_LINE_BUDGET + 1.6) return true;
    // Someone needs dodging and a drift cannot dodge: it is committed to its
    // arc. Two karts that wedge together bleed speed every frame they stay
    // wedged, which costs far more than the tier being given up.
    if (settled && Math.abs(this.avoidance) > 3.2) return true;

    // The road ahead stops going our way — past this point the slide is just
    // rotation into the next straight or, worse, into the opposite corner.
    const ahead = sp.curvature[sp.indexAt(k.s + v * 0.55)] * d.dir;
    if (ahead < -0.0015) return true;

    const want = Math.min(this.targetStage, this.seg ? this.seg.stage : 0);
    const past = this.seg ? -ringDelta(k.s, this.seg.s1, len) : 1e3;

    // A tier is a step change in payout, not a gradient, so a slide that is a
    // few tenths short of the next one is worth overrunning the plan for. The
    // plan is a prediction; the guards above are the measurement, and they have
    // all passed. This is what turns the long sweepers from orange into purple.
    const next = DRIFT.stages[d.stage + 1];
    const chasing = !!next && ahead > -0.0005 && d.stage + 1 <= this.targetStage
      && next.charge - d.charge < DRIFT.chargeBase * 1.15
      && this.driftTime < 7;

    if (d.stage >= want && !chasing) {
      // Release just before the exit so the mini-turbo lands on the straight
      // instead of being spent fighting the same corner.
      if (past > -v * 0.35 || ahead < 0.0015) return true;
    }
    // Past the plan: take blue rather than gamble, but give an uncharged slide
    // a moment more — the geometry model is a prediction, not a measurement.
    if (past > 0) {
      if (chasing && past < v * 1.5) return false;
      return d.stage >= 0 || past > v * 0.7;
    }
    return this.driftTime > 8;
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
