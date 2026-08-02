import * as THREE from 'three';
import { Track } from '../track/Track.js';
import { TrackMesh } from '../track/TrackBuilder.js';
import { Kart } from '../kart/Kart.js';
import { KartModel } from '../kart/KartModel.js';
import { AIDriver } from '../ai/AIDriver.js';
import { ItemSystem } from '../items/ItemSystem.js';
import { Scenery } from '../track/Scenery.js';
import { KartFX } from '../fx/KartFX.js';
import { CHARACTERS, COLLISION, PHYS } from '../kart/KartTuning.js';
import { clamp, clamp01, makeRng, ringDelta } from '../core/MathX.js';

/**
 * The race director.
 *
 * Owns the track, the field, the item system and the effects layer, and drives
 * them from a fixed-timestep `step()`. Presentation (`render()`) is separate
 * and interpolated, so the simulation rate and the display rate stay decoupled.
 */

export const RACE_STATE = {
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

export class Race {
  constructor(scene, trackDef, opts = {}) {
    this.scene = scene;
    this.fieldSize = opts.fieldSize ?? 12;
    this.difficulty = opts.difficulty ?? 0.82;
    this.rng = makeRng(opts.seed ?? 1234);

    this.track = new Track(trackDef);
    this.trackMesh = new TrackMesh(this.track, { envMap: opts.envMap });
    scene.add(this.trackMesh.group);

    this.scenery = new Scenery(this.track, scene, {
      envMap: opts.envMap, quality: opts.quality, seed: opts.seed,
    });

    this.items = new ItemSystem(this.track, scene, { seed: opts.seed });
    this.fx = new KartFX(scene, { maxParticles: opts.maxParticles ?? 4000, quality: opts.quality });

    this.karts = [];
    this.drivers = [];
    this.player = null;

    this._buildField(opts);

    this.state = RACE_STATE.COUNTDOWN;
    this.time = 0;
    this.countdownTime = 3.6;
    this._lastCountdownTick = 4;
    this.raceStarted = false;
    this.events = [];
    this.finishOrder = [];

    this._ctx = {
      karts: this.karts, time: 0, raceStarted: false,
      hazards: this.items.hazards, itemBoxes: this.items.boxes,
      playerProgress: 0,
    };
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
  }

  _buildField(opts) {
    const grid = this.track.startGrid(this.fieldSize);
    // Player takes a mid-grid slot so there's something to overtake and
    // something chasing — starting on pole makes the first lap inert.
    const playerSlot = opts.playerGridSlot ?? Math.floor(this.fieldSize / 2);
    const chosen = opts.playerCharacter || 'nova';

    const pool = CHARACTERS.filter((c) => c.id !== chosen);
    for (let i = 0; i < this.fieldSize; i++) {
      const isPlayer = i === playerSlot;
      const character = isPlayer ? chosen : pool[(i * 5 + 3) % pool.length].id;
      const kart = new Kart(this.track, { isPlayer, characterId: character, index: i });
      kart.placeAt(grid[i]);

      const model = new KartModel(kart.stats, { envMap: opts.envMap });
      model.group.position.copy(kart.pos);
      model.group.quaternion.copy(kart.quaternion);
      this.scene.add(model.group);
      kart.model = model;
      kart.shadowBlob = this.fx.createShadowBlob();

      this._wireEvents(kart);

      this.karts.push(kart);
      if (isPlayer) this.player = kart;
      else {
        // Skill spread across the field, tightest at the sharp end.
        const t = 1 - i / Math.max(this.fieldSize - 1, 1);
        const skill = clamp01(this.difficulty * (0.72 + t * 0.34) + (this.rng() - 0.5) * 0.08);
        this.drivers.push(new AIDriver(kart, this.track, { skill, seed: i * 977 + 5 }));
      }
    }
    // Rank by grid slot before the first standings pass.
    this._updateStandings();
  }

  _wireEvents(kart) {
    // The kart is the sole producer of hit events. Every cause funnels through
    // `spinout`/`flatten` — shells and bananas from the item system, star rams
    // from `_resolveKartCollisions`, thunder from `flatten` — so anything that
    // pushes its own alongside this one double-reports the same collision, and
    // the two payloads then disagree about which key names the cause.
    kart.onHit = (cause) => this.events.push({ type: 'hit', kart, cause });
    kart.onBoostStart = (kind, stage) => this.events.push({ type: 'boost', kart, kind, stage });
    kart.onDriftStage = (stage) => this.events.push({ type: 'driftStage', kart, stage });
    kart.onHop = () => this.events.push({ type: 'hop', kart });
    kart.onLand = (impact) => {
      this.events.push({ type: 'land', kart, impact });
      this.fx.landing(kart.pos, impact);
    };
    kart.onTrick = (kind) => this.events.push({ type: 'trick', kart, kind });
    kart.onWallHit = (force) => this.events.push({ type: 'wallHit', kart, force });
    kart.onLap = (lap) => this.events.push({ type: 'lap', kart, lap });
    kart.onRespawn = () => this.events.push({ type: 'respawn', kart });
    kart.onFinish = () => {
      this.finishOrder.push(kart);
      kart.finishPlace = this.finishOrder.length;
      this.events.push({ type: 'finish', kart, place: kart.finishPlace });
      if (kart.isPlayer) this.state = RACE_STATE.FINISHED;
    };
  }

  // -- simulation -----------------------------------------------------------

  /** @param {{steer,accel,brake,drift,driftPressed,item,itemPressed}} playerInput */
  step(dt, playerInput) {
    this.time += dt;

    if (this.state === RACE_STATE.COUNTDOWN) {
      this.countdownTime -= dt;
      const tick = Math.ceil(this.countdownTime);
      if (tick !== this._lastCountdownTick && tick >= 0) {
        this._lastCountdownTick = tick;
        this.events.push({ type: 'countdown', n: tick });
      }
      if (this.countdownTime <= 0) {
        this.state = RACE_STATE.RACING;
        this.raceStarted = true;
        this.events.push({ type: 'go' });
      }
    }

    const ctx = this._ctx;
    ctx.time = this.time;
    ctx.raceStarted = this.raceStarted;
    ctx.playerProgress = this.player ? this.player.raceDistance : 0;

    // Player -------------------------------------------------------------
    if (this.player) {
      const ctrl = this.player.finished
        ? { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false }
        : playerInput;
      if (playerInput?.itemPressed && this.player.item && !this.player.finished) {
        this.items.use(this.player, ctx);
      }
      this.player.update(dt, ctrl, ctx);
    }

    // AI -------------------------------------------------------------------
    for (const d of this.drivers) {
      const ctrl = d.update(dt, ctx);
      if (ctrl.useItem && d.kart.item) this.items.use(d.kart, ctx);
      d.kart.update(dt, ctrl, ctx);
    }

    this._resolveKartCollisions();
    this.items.update(dt, ctx);
    this._updateStandings();

    for (const e of this.items.drainEvents()) this.events.push(e);

    if (this.state !== RACE_STATE.FINISHED && this.finishOrder.length >= this.karts.length) {
      this.state = RACE_STATE.FINISHED;
    }
  }

  _resolveKartCollisions() {
    const R = PHYS.kartRadius * 1.6;
    const R2 = R * R;
    const n = this.karts.length;
    for (let i = 0; i < n; i++) {
      const a = this.karts[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.karts[j];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dz = b.pos.z - a.pos.z;
        // Ignore karts stacked vertically (one is mid-jump over the other).
        if (Math.abs(dy) > 1.6) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2 || d2 < 1e-6) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const overlap = R - d;

        // Heavier karts get pushed less. Star/bullet users shove everyone.
        let wa = b.stats.mass, wb = a.stats.mass;
        if (a.star > 0 && b.star <= 0) { wa = 0; wb = 1; }
        if (b.star > 0 && a.star <= 0) { wa = 1; wb = 0; }
        const total = wa + wb || 1;

        a.pos.x -= nx * overlap * (wa / total);
        a.pos.z -= nz * overlap * (wa / total);
        b.pos.x += nx * overlap * (wb / total);
        b.pos.z += nz * overlap * (wb / total);

        // Side-swipe bleeds a little speed from whoever was pushed more.
        const impulse = overlap * COLLISION.restitution;
        a.lateralVel -= nx * impulse * 6 * (wa / total);
        b.lateralVel += nx * impulse * 6 * (wb / total);

        if (a.star > 0 && b.star <= 0) b.spinout(1.1, 'star');
        else if (b.star > 0 && a.star <= 0) a.spinout(1.1, 'star');
        else {
          a.speed *= 1 - 0.05 * (wa / total);
          b.speed *= 1 - 0.05 * (wb / total);
        }
        a.lastImpact = Math.max(a.lastImpact, 0.3);
        b.lastImpact = Math.max(b.lastImpact, 0.3);
      }
    }
  }

  _updateStandings() {
    // Finished karts hold their finishing order; the rest sort by distance.
    const sorted = this.karts.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishPlace - b.finishPlace;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.raceDistance - a.raceDistance;
    });
    for (let i = 0; i < sorted.length; i++) sorted[i].rank = i + 1;
    this.standings = sorted;
  }

  // -- presentation ---------------------------------------------------------

  render(alpha, dt, cameraPos) {
    for (const k of this.karts) {
      k.interpolate(alpha, k.model.group.position, k.model.group.quaternion);
      k.visualPos.copy(k.model.group.position);
      k.model.update(k, dt);
    }
    this.trackMesh.update(dt, this.time);
    this.scenery.update(dt, this.time, cameraPos || this._camPos);
    this.fx.update(dt, this.karts, cameraPos || this._camPos);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  get results() {
    return this.standings.map((k, i) => ({
      place: i + 1,
      name: k.stats.name,
      isPlayer: k.isPlayer,
      color: k.stats.color,
      time: k.finished ? k.finishTime : null,
      bestLap: k.lapTimes.length ? Math.min(...k.lapTimes) : null,
    }));
  }

  dispose() {
    for (const k of this.karts) {
      this.scene.remove(k.model.group);
      k.model.dispose();
      if (k.shadowBlob) this.scene.remove(k.shadowBlob);
    }
    this.scene.remove(this.trackMesh.group);
    this.trackMesh.dispose();
    this.scenery.dispose();
    this.items.dispose();
    this.fx.dispose();
  }
}
