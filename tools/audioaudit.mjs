#!/usr/bin/env node
/**
 * Renders the audio engine offline and measures it.
 *
 * A soundscape nobody can listen to is exactly as easy to ship broken as a
 * shader nobody renders — this project shipped an `AudioEngine` whose two
 * sound-producing methods were empty bodies for five rounds of review, and no
 * tool would have noticed. `AudioUtil` was written context-agnostic so the same
 * synthesis runs in an `OfflineAudioContext`; this drives that.
 *
 * Every event type gets its own render, because one shared timeline would let a
 * loud event mask a silent one. The silence control proves the meter can read
 * zero, so "it made sound" is a measurement and not an assumption.
 *
 * Usage:
 *   node tools/audioaudit.mjs
 *   node tools/audioaudit.mjs --seconds 2
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const seconds = parseFloat(arg('seconds', '1.5'));
const url = process.env.HK_URL || 'http://localhost:5178/';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  ! ${e.message || e}`));
await page.goto(`${url}?track=sunsetCoast&auto=1&shot=1`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__hk?.ready, null, { timeout: 90000 });

const EVENTS = [
  'countdown', 'go', 'boost', 'driftStage', 'hit', 'wallHit', 'land', 'hop',
  'trick', 'itemBox', 'itemGet', 'useMushroom', 'useStar', 'useThunder',
  'useBullet', 'useBanana', 'banana', 'shellBounce', 'lap', 'respawn', 'finish',
];

const result = await page.evaluate(async ({ EVENTS, seconds }) => {
  const { AudioEngine } = await import('/src/audio/AudioEngine.js');
  const SR = 48000;

  // A kart the engine can steer without pulling in the whole simulation.
  const fakeKart = (o = {}) => ({
    pos: { x: o.x ?? 0, y: 0, z: o.z ?? -6 },
    speed: o.speed ?? 24,
    lateralVel: o.lateralVel ?? 0,
    rumble: o.rumble ?? 0,
    engineLoad: o.engineLoad ?? 0.8,
    grounded: o.grounded ?? true,
    boostActive: o.boostActive ?? false,
    finished: false,
    drift: { active: o.drift ?? false, stage: 0 },
    stats: { topSpeed: 55 },
  });

  const measure = (buf) => {
    let peak = 0, sum = 0, n = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
    }
    return { peak, rms: Math.sqrt(sum / Math.max(n, 1)) };
  };

  // Dominant frequency of the first channel, by naive DFT over a coarse bin
  // set — enough to tell a revving engine from an idling one.
  const dominant = (buf) => {
    const d = buf.getChannelData(0);
    const N = Math.min(8192, d.length);
    let best = 0, bestMag = 0;
    for (let f = 30; f < 900; f += 2) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * f / SR;
      for (let i = 0; i < N; i++) { re += d[i] * Math.cos(w * i); im += d[i] * Math.sin(w * i); }
      const m = re * re + im * im;
      if (m > bestMag) { bestMag = m; best = f; }
    }
    return best;
  };

  const render = async (setup) => {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
    const eng = new AudioEngine({ context: ctx, volume: 0.8 });
    await eng.start();
    await setup(eng, ctx);
    return ctx.startRendering();
  };

  const out = { events: {}, continuous: {}, control: null, errors: [] };

  // 1. Silence control: an engine that was never started must render zero.
  {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * 0.3), SR);
    const eng = new AudioEngine({ context: ctx });
    eng.attachKart(fakeKart(), true);
    eng.update(1 / 60, { state: 'racing' }, null);
    eng.handleEvent({ type: 'hit', kart: null });
    out.control = measure(await ctx.startRendering());
  }

  // 2. Continuous voices at a range of speeds.
  //
  // Measured twice: once as mixed (what a player hears) and once with the
  // ambience, music and wind beds silenced. The beds are pink-noise and drone
  // heavy, so they own the low end and a naive "dominant frequency" over the
  // full mix reports 32 Hz however hard the engine is revving — the first
  // version of this tool did exactly that and made a working engine look
  // broken. Pitch has to be read from the engine alone.
  const hush = (eng) => {
    eng._nodes.ambience.g.gain.value = 0;
    eng._nodes.music.g.gain.value = 0;
    eng._nodes.wind.g.gain.value = 0;
  };
  for (const [name, opts] of [['idle', { speed: 0, engineLoad: 0 }],
    ['cruise', { speed: 24, engineLoad: 0.7 }],
    ['flat-out', { speed: 52, engineLoad: 1 }],
    ['drifting', { speed: 38, engineLoad: 0.9, drift: true, lateralVel: 4 }]]) {
    const buf = await render(async (eng) => {
      const k = fakeKart(opts);
      eng.attachKart(k, true);
      eng.update(1 / 60, { state: 'racing' }, { pos: { x: 0, y: 1, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    });
    const solo = await render(async (eng) => {
      const k = fakeKart(opts);
      eng.attachKart(k, true);
      eng.update(1 / 60, { state: 'racing' }, { pos: { x: 0, y: 1, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
      hush(eng);
    });
    out.continuous[name] = { ...measure(buf), hz: dominant(solo) };
  }

  // 3. Twelve karts, to check the pack does not clip.
  {
    const buf = await render(async (eng) => {
      for (let i = 0; i < 12; i++) {
        eng.attachKart(fakeKart({ x: (i - 6) * 3, z: -6 - i * 4, speed: 40 + i }), i === 0);
      }
      eng.update(1 / 60, { state: 'racing' }, { pos: { x: 0, y: 1, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    });
    out.continuous['full grid (12)'] = { ...measure(buf), hz: dominant(buf) };
  }

  // 4. Every event, one render each, with continuous voices muted so the
  //    measurement is of the sting alone.
  for (const type of EVENTS) {
    try {
      const buf = await render(async (eng) => {
        const k = fakeKart({ engineLoad: 0 });
        eng.attachKart(k, true);
        eng.handleEvent({ type, kart: k, force: 1, impact: 1, stage: 2, n: 3, lap: 2, place: 1 });
      });
      out.events[type] = measure(buf);
    } catch (e) { out.errors.push(`${type}: ${e.message}`); }
  }
  return out;
}, { EVENTS, seconds });

const f = (v) => v.toFixed(5);
console.log(`\nsilence control (engine never started): peak ${f(result.control.peak)} rms ${f(result.control.rms)}`);
console.log(result.control.peak < 1e-6 ? '  the meter reads zero when there is nothing to hear\n'
  : '  ! CONTROL IS NOT SILENT — every figure below is suspect\n');

console.log('continuous voices');
for (const [k, v] of Object.entries(result.continuous)) {
  console.log(`  ${k.padEnd(18)} peak ${f(v.peak)}  rms ${f(v.rms)}  dominant ${String(v.hz).padStart(3)} Hz`
    + (v.peak > 1.0 ? '   ! CLIPPING' : ''));
}

console.log('\none-shot events');
let silent = 0;
for (const [k, v] of Object.entries(result.events)) {
  const bad = v.peak < 1e-4;
  if (bad) silent++;
  console.log(`  ${k.padEnd(14)} peak ${f(v.peak)}  rms ${f(v.rms)}${bad ? '   ! SILENT' : ''}`);
}
if (result.errors.length) {
  console.log('\nerrors:');
  for (const e of result.errors) console.log(`  ! ${e}`);
}
console.log(`\n${Object.keys(result.events).length - silent}/${Object.keys(result.events).length} event types produce sound`);

await browser.close();
if (silent || result.errors.length || result.control.peak > 1e-6) process.exitCode = 1;
