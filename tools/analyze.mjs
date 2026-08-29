#!/usr/bin/env node
/**
 * Track geometry report: corner radii, the corner-speed profile the AI derives
 * from them, and how much of a lap is actually corner-limited. Answers "are
 * these corners even driftable?" with numbers.
 */
import { Track } from '../src/track/Track.js';
import { buildRacingLine } from '../src/ai/AIDriver.js';
import { TRACKS } from '../src/track/Tracks.js';
import { DRIVE, DRIFT } from '../src/kart/KartTuning.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

for (const id of (arg('track', 'sunsetCoast,canyonRush,frostlineBasin,rainbowSkyway')).split(',')) {
  const def = TRACKS[id];
  if (!def) continue;
  const track = new Track(def);
  const sp = track.spline;
  const line = buildRacingLine(track);
  const n = sp.count;

  const curv = [], radii = [], vmax = [];
  for (let i = 0; i < n; i++) {
    const k = Math.abs(sp.curvature[i]);
    curv.push(k);
    radii.push(k < 1e-6 ? Infinity : 1 / k);
    vmax.push(line.maxSpeed[i]);
  }
  const sorted = curv.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (n - 1))];

  const top = DRIVE.topSpeed;
  const belowFrac = (f) => vmax.filter((v) => v < top * f).length / n;

  // Contiguous corner runs where an AI would want to drift.
  const runs = [];
  let cur = 0;
  for (let i = 0; i < n * 2; i++) {
    const j = i % n;
    if (vmax[j] < top * 0.94) cur++;
    else { if (cur > 0 && i >= n) runs.push(cur * sp.ds); cur = 0; }
  }

  console.log(`\n=== ${track.name} (${id}) ===`);
  console.log(`  length ${track.length.toFixed(1)}m  samples ${n}  ds ${sp.ds.toFixed(3)}m  laps ${track.laps}`);
  console.log(`  width  min/med/max ${Math.min(...sp.width).toFixed(1)}/` +
    `${sp.width.slice().sort((a, b) => a - b)[n >> 1].toFixed(1)}/${Math.max(...sp.width).toFixed(1)}m`);
  console.log(`  |curvature| p50=${q(0.5).toExponential(2)} p90=${q(0.9).toExponential(2)} ` +
    `p99=${q(0.99).toExponential(2)} max=${q(1).toExponential(2)}`);
  console.log(`  radius     p50=${(1 / q(0.5)).toFixed(0)}m p90=${(1 / q(0.9)).toFixed(0)}m ` +
    `p99=${(1 / q(0.99)).toFixed(0)}m min=${(1 / q(1)).toFixed(0)}m`);
  console.log(`  cornerSpeed min=${Math.min(...vmax).toFixed(1)}m/s ` +
    `(= ${(Math.min(...vmax) / top * 100).toFixed(0)}% of ${top} top)`);
  console.log(`  lap fraction with vmax < 94%/85%/70% of top: ` +
    `${(belowFrac(0.94) * 100).toFixed(0)}% / ${(belowFrac(0.85) * 100).toFixed(0)}% / ` +
    `${(belowFrac(0.70) * 100).toFixed(0)}%`);
  console.log(`  drift-worthy runs (vmax<94%): ${runs.length}, ` +
    `lengths(m) [${runs.map((r) => r.toFixed(0)).join(' ')}]`);
  console.log(`  -> at ~${(top * 0.8).toFixed(0)}m/s those runs last ` +
    `[${runs.map((r) => (r / (top * 0.8)).toFixed(1)).join(' ')}]s`);
  console.log(`  drift charge needed: blue ${DRIFT.stages[0].charge}s-ish, ` +
    `orange ${DRIFT.stages[1].charge}, purple ${DRIFT.stages[2].charge} ` +
    `(rate ${DRIFT.chargeBase}..${(DRIFT.chargeBase + DRIFT.chargeSteerBonus).toFixed(2)}/s)`);

  // Yaw rate a kart actually needs to hold each corner at its limit speed,
  // versus the fixed rate a drift imposes.
  const need = [];
  for (let i = 0; i < n; i++) if (vmax[i] < top * 0.94) need.push(curv[i] * Math.min(vmax[i], top));
  need.sort((a, b) => a - b);
  if (need.length) {
    console.log(`  required yaw rate in corners (rad/s): p10=${need[Math.floor(need.length * 0.1)].toFixed(2)} ` +
      `p50=${need[need.length >> 1].toFixed(2)} p90=${need[Math.floor(need.length * 0.9)].toFixed(2)} ` +
      `max=${need[need.length - 1].toFixed(2)}`);
    console.log(`  drift yaw rate available: ${(DRIFT.baseRate - DRIFT.steerRange).toFixed(2)}..` +
      `${(DRIFT.baseRate + DRIFT.steerRange).toFixed(2)} rad/s (x authority)`);
    console.log(`  grip steer rate available:  0..${DRIVE.maxSteerRate.toFixed(2)} rad/s (x authority)`);
  }
}
