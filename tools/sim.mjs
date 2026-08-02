#!/usr/bin/env node
/**
 * Headless race simulator.
 *
 * Runs the real physics/AI/item code in Node with no renderer, so a full
 * 12-kart 3-lap race takes well under a second. That makes tuning a
 * measurement exercise instead of a screenshot-guessing exercise.
 *
 * Usage:
 *   node tools/sim.mjs                              # default: sunsetCoast, 12 karts
 *   node tools/sim.mjs --track canyonRush --field 12
 *   node tools/sim.mjs --seeds 5 --json out.json
 *   node tools/sim.mjs --noitems                    # isolate driving from item chaos
 */
import * as THREE from 'three';
import { Track } from '../src/track/Track.js';
import { Kart } from '../src/kart/Kart.js';
import { AIDriver } from '../src/ai/AIDriver.js';
import { ItemSystem } from '../src/items/ItemSystem.js';
import { CHARACTERS, COLLISION, PHYS, DRIFT } from '../src/kart/KartTuning.js';
import { TRACKS } from '../src/track/Tracks.js';
import { clamp01, makeRng } from '../src/core/MathX.js';

// `userData` is not decoration: ItemSystem reads `scene.userData.kartFX` through
// a lazy getter to reach the effects system, because Race builds items before
// FX exists. Without it this harness throws the moment items are enabled.
const StubScene = { add() {}, remove() {}, userData: {} };

/**
 * A renderer-free mirror of `Race.step()`. Kept deliberately in the same order
 * as `src/game/Race.js` so measurements here transfer to the real game.
 */
export class HeadlessRace {
  constructor(trackDef, opts = {}) {
    this.fieldSize = opts.fieldSize ?? 12;
    this.difficulty = opts.difficulty ?? 0.82;
    this.rng = makeRng(opts.seed ?? 1234);
    this.useItems = opts.useItems !== false;

    this.track = new Track(trackDef);
    this.items = new ItemSystem(this.track, StubScene, { seed: opts.seed });
    this.karts = [];
    this.drivers = [];
    this.player = null;
    this.time = 0;
    this.countdownTime = 3.6;
    this.raceStarted = false;
    this.finishOrder = [];
    this.events = [];

    const grid = this.track.startGrid(this.fieldSize);
    const playerSlot = opts.playerGridSlot ?? Math.floor(this.fieldSize / 2);
    const chosen = opts.playerCharacter || 'nova';
    const pool = CHARACTERS.filter((c) => c.id !== chosen);

    for (let i = 0; i < this.fieldSize; i++) {
      const isPlayer = i === playerSlot;
      const character = isPlayer ? chosen : pool[(i * 5 + 3) % pool.length].id;
      const kart = new Kart(this.track, { isPlayer, characterId: character, index: i });
      kart.placeAt(grid[i]);
      kart.model = null;
      this._instrument(kart);
      this.karts.push(kart);
      if (isPlayer) this.player = kart;
      else {
        const t = 1 - i / Math.max(this.fieldSize - 1, 1);
        const skill = clamp01(this.difficulty * (0.72 + t * 0.34) + (this.rng() - 0.5) * 0.08);
        this.drivers.push(new AIDriver(kart, this.track, { skill, seed: i * 977 + 5 }));
      }
    }
    // The player is driven by an AI of a fixed, high skill — the same driver
    // the screenshot harness uses, so "can a good lap win?" is testable.
    this.playerDriver = new AIDriver(this.player, this.track,
      { skill: opts.playerSkill ?? 0.92, seed: 31337 });
    this.playerSkill = opts.playerSkill ?? 0.92;

    this._updateStandings();
    this._ctx = {
      karts: this.karts, time: 0, raceStarted: false,
      hazards: this.items.hazards, itemBoxes: this.items.boxes, playerProgress: 0,
    };
  }

  /** Per-kart telemetry accumulators. */
  _instrument(kart) {
    kart.m = {
      driftTime: 0, airTime: 0, offRoadTime: 0, wallHits: 0, hardWallHits: 0,
      respawns: 0, hits: 0, topSpeed: 0, stages: [0, 0, 0], drifts: 0,
      driftBoostTime: 0, boostTime: 0, sumSpeed: 0, samples: 0, stunTime: 0,
      lapStages: [],
    };
    kart.onWallHit = (f) => { kart.m.wallHits++; if (f > 0.5) kart.m.hardWallHits++; };
    kart.onRespawn = () => { kart.m.respawns++; };
    kart.onHit = () => { kart.m.hits++; };
    kart.onDriftStage = (stage) => { kart.m.stages[stage]++; };
    kart.onFinish = () => {
      this.finishOrder.push(kart);
      kart.finishPlace = this.finishOrder.length;
    };
  }

  step(dt) {
    this.time += dt;
    if (!this.raceStarted) {
      this.countdownTime -= dt;
      if (this.countdownTime <= 0) this.raceStarted = true;
    }
    const ctx = this._ctx;
    ctx.time = this.time;
    ctx.raceStarted = this.raceStarted;
    ctx.playerProgress = this.player.raceDistance;

    // Player (autopilot).
    const pc = this.playerDriver.update(dt, ctx);
    if (this.useItems && pc.useItem && this.player.item && !this.player.finished) {
      this.items.use(this.player, ctx);
    }
    this.player.update(dt, this.player.finished
      ? { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false } : pc, ctx);

    for (const d of this.drivers) {
      const c = d.update(dt, ctx);
      if (this.useItems && c.useItem && d.kart.item) this.items.use(d.kart, ctx);
      d.kart.update(dt, c, ctx);
    }

    this._resolveKartCollisions();
    if (this.useItems) this.items.update(dt, ctx);
    else { this.items.events.length = 0; }
    this._updateStandings();
    this.items.events.length = 0;

    for (const k of this.karts) this._sample(k, dt);
  }

  _sample(k, dt) {
    if (!this.raceStarted || k.finished) return;
    const m = k.m;
    if (k.drift.active) m.driftTime += dt;
    if (!k.grounded) m.airTime += dt;
    if (k.grounded && !k.ground.onRoad) m.offRoadTime += dt;
    if (k.stun.time > 0) m.stunTime += dt;
    if (k.boostActive) m.boostTime += dt;
    if (k.boostActive && k.boostKind === 'drift') m.driftBoostTime += dt;
    if (k.speed > m.topSpeed) m.topSpeed = k.speed;
    m.sumSpeed += k.speed; m.samples++;
  }

  _resolveKartCollisions() {
    const R = PHYS.kartRadius * 1.6, R2 = R * R, n = this.karts.length;
    for (let i = 0; i < n; i++) {
      const a = this.karts[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.karts[j];
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
        if (Math.abs(dy) > 1.6) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, overlap = R - d;
        let wa = b.stats.mass, wb = a.stats.mass;
        if (a.star > 0 && b.star <= 0) { wa = 0; wb = 1; }
        if (b.star > 0 && a.star <= 0) { wa = 1; wb = 0; }
        const total = wa + wb || 1;
        a.pos.x -= nx * overlap * (wa / total); a.pos.z -= nz * overlap * (wa / total);
        b.pos.x += nx * overlap * (wb / total); b.pos.z += nz * overlap * (wb / total);
        const impulse = overlap * COLLISION.restitution;
        a.lateralVel -= nx * impulse * 6 * (wa / total);
        b.lateralVel += nx * impulse * 6 * (wb / total);
        if (a.star > 0 && b.star <= 0) b.spinout(1.1, 'star');
        else if (b.star > 0 && a.star <= 0) a.spinout(1.1, 'star');
        else { a.speed *= 1 - 0.05 * (wa / total); b.speed *= 1 - 0.05 * (wb / total); }
      }
    }
  }

  _updateStandings() {
    const sorted = this.karts.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishPlace - b.finishPlace;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.raceDistance - a.raceDistance;
    });
    for (let i = 0; i < sorted.length; i++) sorted[i].rank = i + 1;
    this.standings = sorted;
  }

  /** Run until everyone finishes or `maxTime` elapses. */
  run(maxTime = 300, dt = 1 / 120) {
    while (this.time < maxTime && this.finishOrder.length < this.karts.length) this.step(dt);
    return this.report();
  }

  report() {
    const rows = this.standings.map((k) => {
      const m = k.m;
      const laps = k.lapTimes;
      return {
        place: k.finished ? k.finishPlace : k.rank,
        name: k.stats.name,
        cls: k.stats.cls,
        isPlayer: k.isPlayer,
        skill: k.isPlayer ? this.playerSkill
          : (this.drivers.find((d) => d.kart === k)?.skill ?? 0),
        total: k.finished ? k.finishTime : null,
        laps: laps.map((t) => +t.toFixed(2)),
        best: laps.length ? +Math.min(...laps).toFixed(2) : null,
        driftPct: +(100 * m.driftTime / Math.max(k.finishTime || this.time, 1)).toFixed(1),
        offPct: +(100 * m.offRoadTime / Math.max(k.finishTime || this.time, 1)).toFixed(1),
        boostPct: +(100 * m.boostTime / Math.max(k.finishTime || this.time, 1)).toFixed(1),
        mtBoostPct: +(100 * m.driftBoostTime / Math.max(k.finishTime || this.time, 1)).toFixed(1),
        stages: m.stages.slice(),
        walls: m.wallHits,
        hardWalls: m.hardWallHits,
        respawns: m.respawns,
        hits: m.hits,
        stunPct: +(100 * m.stunTime / Math.max(k.finishTime || this.time, 1)).toFixed(1),
        top: +(m.topSpeed * 3.6).toFixed(1),
        avg: +(m.sumSpeed / Math.max(m.samples, 1) * 3.6).toFixed(1),
      };
    });
    return { track: this.track.name, time: this.time, rows };
  }
}

// ---------------------------------------------------------------------------

function fmt(report, opts = {}) {
  const L = [];
  const finishers = report.rows.filter((r) => r.total != null);
  L.push(`\n=== ${report.track}${opts.tag ? ` [${opts.tag}]` : ''} ===`);
  L.push(
    'P  ' + 'name'.padEnd(8) + 'cls'.padEnd(7) + 'skl'.padEnd(6) +
    'total'.padStart(7) + 'best'.padStart(7) + '  laps'.padEnd(26) +
    'drift%'.padStart(7) + 'mt%'.padStart(6) + 'off%'.padStart(6) +
    'B/O/P'.padStart(9) + 'wall'.padStart(6) + 'rsp'.padStart(5) +
    'hit'.padStart(5) + 'top'.padStart(7) + 'avg'.padStart(7),
  );
  for (const r of report.rows) {
    L.push(
      String(r.place).padEnd(3) +
      (r.isPlayer ? `*${r.name}` : r.name).padEnd(8) +
      r.cls.padEnd(7) + r.skill.toFixed(2).padEnd(6) +
      (r.total ? r.total.toFixed(2) : '  DNF').padStart(7) +
      (r.best ? r.best.toFixed(2) : '  -').padStart(7) + '  ' +
      `[${r.laps.map((x) => x.toFixed(2)).join(' ')}]`.padEnd(24) +
      String(r.driftPct).padStart(7) + String(r.mtBoostPct).padStart(6) +
      String(r.offPct).padStart(6) +
      `${r.stages[0]}/${r.stages[1]}/${r.stages[2]}`.padStart(9) +
      `${r.walls}(${r.hardWalls})`.padStart(6) +
      String(r.respawns).padStart(5) + String(r.hits).padStart(5) +
      String(r.top).padStart(7) + String(r.avg).padStart(7),
    );
  }
  if (finishers.length > 1) {
    const spread = finishers[finishers.length - 1].total - finishers[0].total;
    const bests = report.rows.filter((r) => r.best).map((r) => r.best);
    L.push(
      `spread(1st..last)=${spread.toFixed(2)}s  ` +
      `bestLap min/med/max=${Math.min(...bests).toFixed(2)}/` +
      `${bests.sort((a, b) => a - b)[bests.length >> 1].toFixed(2)}/${Math.max(...bests).toFixed(2)}  ` +
      `player=P${report.rows.find((r) => r.isPlayer).place}`,
    );
  }
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(`--${n}`);

  const tracks = (arg('track', 'sunsetCoast')).split(',');
  const seeds = parseInt(arg('seeds', '1'), 10);
  const field = parseInt(arg('field', '12'), 10);
  const playerSkill = parseFloat(arg('skill', '0.92'));
  const difficulty = parseFloat(arg('difficulty', '0.82'));
  const useItems = !flag('noitems');
  const places = [];

  for (const t of tracks) {
    const def = TRACKS[t];
    if (!def) { console.error(`unknown track ${t}`); continue; }
    for (let s = 0; s < seeds; s++) {
      const seed = 20250802 + s * 7717;
      const race = new HeadlessRace(def, {
        fieldSize: field, seed, useItems, playerSkill, difficulty,
      });
      const rep = race.run();
      places.push(rep.rows.find((r) => r.isPlayer).place);
      console.log(fmt(rep, { tag: `seed ${seed}${useItems ? '' : ' noitems'}` }));
    }
  }
  if (places.length > 1) {
    console.log(`\nplayer places over ${places.length} races: [${places.join(', ')}]  ` +
      `mean=${(places.reduce((a, b) => a + b, 0) / places.length).toFixed(2)}`);
  }
}
