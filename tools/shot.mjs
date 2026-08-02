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

  const times = CFG.series
    ? CFG.series.split(',').map((s) => parseFloat(s.trim())).filter((n) => isFinite(n))
    : [CFG.t];

  const results = [];
  let blackFrames = 0;
  let gpu = 'unknown';

  // One page load per requested time.
  //
  // A capture's identity depends on the route taken to reach it: `--t 20` and
  // `--series 20` are bit-identical, but `--series 10,20` differs from both on
  // 89% of its pixels, because the eight settle frames at each intermediate
  // stop advance particles, post-process damping and HUD state that no seek
  // rewinds. Reaching every frame the same way is the only thing that makes
  // two captures comparable, and this project's whole verification method
  // rests on that.
  let hiddenNames = [];
  for (const target of times) {
    await page.goto(url.toString(), { waitUntil: 'load', timeout: CFG.timeout });
    await page.waitForFunction(() => window.__hk && window.__hk.ready, null, { timeout: CFG.timeout });

    if (gpu === 'unknown') {
      // Report the actual GPU in use — SwiftShader would invalidate any visual
      // judgement made from these captures.
      gpu = await page.evaluate(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
      });
    }

    await page.evaluate(() => window.__hk.stopForCapture());
    if (!CFG.hud) await page.evaluate(() => window.__hk.setHud(false));

    if (CFG.hide) {
      const pats = CFG.hide.split(',').map((x) => x.trim()).filter(Boolean);
      // Hidden by layer, not by `.visible`: the presentation update paths write
      // `.visible` straight back, so this flag used to report objects hidden
      // and produce a bit-identical frame. Groups are descended into, because
      // three's projectObject recurses into children outside the layer test —
      // hiding a Group alone hides nothing.
      const hidden = await page.evaluate((ps) => {
        const names = [];
        window.__hk.scene.traverse((o) => {
          if (o.name && ps.some((x) => o.name.includes(x))) {
            o.traverse((c) => c.layers.set(31));
            names.push(o.name);
          }
        });
        return names;
      }, pats);
      hiddenNames = hidden;
      if (target === times[0]) {
        process.stdout.write(`hidden (${hidden.length}): ${hidden.join(', ') || 'nothing matched'}\n`);
      }
    await page.evaluate((d) => window.__hk.seek(d), target);

    // Let post-processing and particle state settle for a few real frames so
    // the capture matches what a player would actually see in motion.
    await page.evaluate(async () => {
      for (let k = 0; k < 8; k++) await window.__hk.frame(1 / 60);
    });

    if (CFG.hide && hiddenNames.length) {
      // Measured *after* the seek, at the frame actually being captured. Counting
      // at load time reported a false "did nothing" for anything correctly culled
      // on the start grid -- the lighthouse beam, for one, which is out of frustum
      // for most of a lap and contributes 0.7% of the frame when it is not.
      // A self-check that cries wolf is worth as little as one that stays silent.
      // A hide that matched objects but does not change the draw count did
        // nothing, and a silent no-op here produces a confident false
        // conclusion downstream. Counted by drawing straight to the canvas, not
        // through `frame()`, which would advance particle and animation state.
      const drop = await page.evaluate(() => {
          const { rs, scene, camera } = window.__hk;
          const count = () => {
            rs.beginFrame();
            rs.renderer.setRenderTarget(null);
            rs.renderer.render(scene, camera);
            return rs.renderer.info.render.calls;
          };
          const withHide = count();
          const restored = [];
          scene.traverse((o) => { if (!o.layers.test(camera.layers)) { restored.push(o); o.layers.enable(0); } });
          const without = count();
          for (const o of restored) o.layers.set(31);
          return { withHide, without };
        });
      {
        process.stdout.write(drop.withHide >= drop.without
          ? `  ! WARNING: hiding those objects did not reduce draw calls (${drop.without} -> ${drop.withHide}). Treat this A/B as invalid.\n`
          : `  hide removes ${drop.without - drop.withHide} draw calls\n`);
      }
    }
    }


    const stats = await page.evaluate(() => window.__hk.stats());
    const errs = await page.evaluate(() => window.__hkErrors.slice());

    const lit = await page.evaluate(() => {
      const c = window.__hk.rs.renderer.domElement;
      const s = document.createElement('canvas');
      s.width = 64; s.height = 36;
      const ctx = s.getContext('2d');
      ctx.drawImage(c, 0, 0, s.width, s.height);
      const d = ctx.getImageData(0, 0, s.width, s.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 4 * 3);
    });
    if (lit < 2) {
      process.stdout.write(`  ! BLACK FRAME at t=${target} (mean channel ${lit.toFixed(2)}) — capture discarded\n`);
      blackFrames++;
    }

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
  if (blackFrames) process.exitCode = 3;
}

main().catch((e) => {
  console.error('shot.mjs failed:', e);
  process.exit(1);
});
