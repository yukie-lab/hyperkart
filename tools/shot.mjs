#!/usr/bin/env node
/**
 * Deterministic screenshot harness.
 *
 * Drives the game in real Chromium with GPU-backed ANGLE/Metal (not
 * SwiftShader), fast-forwards the fixed-timestep simulation to an exact moment,
 * and captures. The same arguments always produce the same frame, which is
 * what makes automated visual review meaningful.
 *
 * Usage:
 *   node tools/shot.mjs --t 18 --out shots/a.png
 *   node tools/shot.mjs --series 6,14,24,40 --track canyonRush --outdir shots/canyon
 *   node tools/shot.mjs --t 20 --cam near --hud 0 --w 2560 --h 1440
 *   node tools/shot.mjs --t 52 --hide rail   # confirm what a feature contributes
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const CFG = {
  url: arg('url', 'http://localhost:5178/'),
  track: arg('track', 'sunsetCoast'),
  quality: arg('quality', 'high'),
  field: arg('field', '12'),
  character: arg('character', 'nova'),
  seed: arg('seed', '20250802'),
  cam: arg('cam', 'chase'),
  hud: arg('hud', '1') === '1',
  w: parseInt(arg('w', '1920'), 10),
  h: parseInt(arg('h', '1080'), 10),
  t: parseFloat(arg('t', '18')),
  series: arg('series', null),
  out: arg('out', 'shots/frame.png'),
  outdir: arg('outdir', 'shots'),
  timeout: parseInt(arg('timeout', '90000'), 10),
  // Comma-separated substrings matched against object names. Hiding a feature
  // and re-shooting is the only reliable way to attribute something on screen
  // to the code that draws it.
  hide: arg('hide', null),
};

const LAUNCH_ARGS = [
  '--use-angle=metal',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  '--disable-frame-rate-limit',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
];

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: LAUNCH_ARGS,
  });

  const page = await browser.newPage({
    viewport: { width: CFG.w, height: CFG.h },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));

  const url = new URL(CFG.url);
  url.searchParams.set('track', CFG.track);
  url.searchParams.set('quality', CFG.quality);
  url.searchParams.set('field', CFG.field);
  url.searchParams.set('character', CFG.character);
  url.searchParams.set('seed', CFG.seed);
  url.searchParams.set('cam', CFG.cam);
  url.searchParams.set('auto', '1');
  url.searchParams.set('shot', '1');

  await page.goto(url.toString(), { waitUntil: 'load', timeout: CFG.timeout });

  // Wait for the first presented frame.
  await page.waitForFunction(() => window.__hk && window.__hk.ready, null, { timeout: CFG.timeout });

  // Report the actual GPU in use — SwiftShader would invalidate any visual
  // judgement made from these captures.
  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  // Take the frame clock before anything is measured. Until this call the live
  // loop keeps stepping the simulation between harness frames, so a requested
  // time came back roughly 0.1 s late and the pixel ratio could move mid-series.
  const pinned = await page.evaluate(() => window.__hk.stopForCapture());
  process.stdout.write(`clock pinned at t=${pinned.simTime.toFixed(3)}s, pixelRatio ${pinned.pixelRatio.toFixed(2)}\n`);

  if (!CFG.hud) await page.evaluate(() => window.__hk.setHud(false));

  if (CFG.hide) {
    const hidden = await page.evaluate((pats) => {
      const names = [];
      window.__hk.scene.traverse((o) => {
        if (o.name && pats.some((p) => o.name.includes(p))) { o.visible = false; names.push(o.name); }
      });
      return names;
    }, CFG.hide.split(',').map((s) => s.trim()).filter(Boolean));
    process.stdout.write(`hidden (${hidden.length}): ${hidden.join(', ') || 'nothing matched'}\n`);
  }

  const times = CFG.series
    ? CFG.series.split(',').map((s) => parseFloat(s.trim())).filter((n) => isFinite(n))
    : [CFG.t];

  const results = [];
  let simTime = 0;

  for (let i = 0; i < times.length; i++) {
    const target = times[i];
    const delta = Math.max(0, target - simTime);
    await page.evaluate((d) => window.__hk.seek(d), delta);
    simTime = target;

    // Let post-processing and particle state settle for a few real frames so
    // the capture matches what a player would actually see in motion.
    await page.evaluate(async () => {
      for (let k = 0; k < 8; k++) await window.__hk.frame(1 / 60);
    });

    const stats = await page.evaluate(() => window.__hk.stats());
    const errs = await page.evaluate(() => window.__hkErrors.slice());

    const outPath = CFG.series
      ? resolve(CFG.outdir, `${CFG.track}_t${String(target).padStart(3, '0')}.png`)
      : resolve(CFG.out);
    await mkdir(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: 'png' });

    results.push({ t: target, path: outPath, stats, errors: errs });
    process.stdout.write(
      `shot t=${target}s -> ${outPath}\n` +
      `   rank=${stats.player.rank} lap=${stats.player.lap} ${stats.player.speedKmh}km/h ` +
      `drift=${stats.player.drift}${stats.player.driftStage >= 0 ? `(${stats.player.driftStage})` : ''} ` +
      `boost=${stats.player.boosting} onRoad=${stats.player.onRoad}\n` +
      // No fps here. In capture mode the live loop never starts, so
      // `Loop.smoothedFrameMs` sits at its constructor value forever and this
      // field printed a constant 60 on every capture ever taken. A fabricated
      // number is worse than no number; measure frame rate with the loop
      // running (shot=0) instead.
      `   draws=${stats.drawCalls} tris=${stats.triangles}\n`,
    );
  }

  const allErrors = [...new Set([...consoleErrors, ...results.flatMap((r) => r.errors)])];
  if (allErrors.length) {
    process.stdout.write(`\nERRORS (${allErrors.length}):\n`);
    for (const e of allErrors.slice(0, 20)) process.stdout.write(`  ! ${e}\n`);
  }
  process.stdout.write(`\nGPU: ${gpu}\n`);

  await browser.close();
  if (allErrors.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error('shot.mjs failed:', e);
  process.exit(1);
});
