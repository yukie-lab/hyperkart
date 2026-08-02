#!/usr/bin/env node
/**
 * Render-list audit: what each object costs, against what it contributes.
 *
 * This project has now produced eleven pieces of code that were written, look
 * correct in source, and draw nothing — an orphaned preset table, camera terms
 * multiplied by zero, ignored shadow settings, a shader injection anchored on a
 * chunk that does not exist in the target program, spokes sealed inside a rim,
 * a lighthouse beam the tone mapper eats. Every one was found by a person
 * looking. A draw call that contributes no pixels is not a rendering opinion,
 * it is a fact, and facts should be measured on a schedule rather than
 * discovered by whoever happens to squint at the right crop.
 *
 * For each named group in the scene this hides it (by layer, descending into
 * Groups) and re-renders the same frame, then reports the draw calls it costs
 * against the pixels it moves. Anything costing draws and moving nothing is a
 * candidate for deletion or for being made visible on purpose.
 *
 * Limitation worth knowing: only top-level named objects are audited, so
 * something dead *inside* a named group is folded into its parent's total. The
 * lighthouse beam was found that way, by name, with `shot.mjs --hide`. Use that
 * when you suspect a specific child.
 *
 * Both renders come from one page state with no `frame()` between them, so
 * particles and animation cannot drift underneath the comparison.
 *
 * Usage:
 *   node tools/renderaudit.mjs
 *   node tools/renderaudit.mjs --track canyonRush --t 34
 *   node tools/renderaudit.mjs --track sunsetCoast --t 20 --min 0.02
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const track = arg('track', 'sunsetCoast');
// Several moments, and a group is judged on its *best* one. A kart behind the
// camera contributes nothing at t=20 and that is frustum culling working; a
// lighthouse beam contributes nothing at any time and that is a defect. One
// frame cannot tell those apart, which is why the first version of this tool
// flagged eight healthy karts.
const times = (arg('series', arg('t', '12,20,34,52'))).split(',').map(Number).filter(isFinite);
// Groups contributing less than this fraction of the frame are called out.
const minPct = parseFloat(arg('min', '0.05'));
const url = process.env.HK_URL || 'http://localhost:5178/';

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`  ! ${e.message || e}`));

await page.goto(`${url}?track=${track}&auto=1&shot=1&quality=high`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__hk?.ready, null, { timeout: 90000 });
await page.evaluate(() => { window.__hk.stopForCapture(); window.__hk.setHud(false); });
const best = new Map();
let totalCalls = 0;

for (const t of times) {
  await page.evaluate((s) => window.__hk.seek(s), t - (await page.evaluate(() => window.__hk.loop.simTime)));
  await page.evaluate(async () => { for (let k = 0; k < 8; k++) await window.__hk.frame(1 / 60); });

  const frame = await page.evaluate(() => {
  const { rs, scene, camera } = window.__hk;
  const gl = rs.renderer;

  // Render to an offscreen target so the audit never disturbs the canvas, and
  // read back once per variant. Half float would be more faithful but byte
  // precision is what a reviewer's eye works in anyway.
  const w = 480, h = 270;
  const rt = new window.THREE.WebGLRenderTarget(w, h, { colorSpace: window.THREE.SRGBColorSpace });
  const buf = new Uint8Array(w * h * 4);

  const shoot = () => {
    rs.beginFrame();
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, camera);
    gl.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    return { calls: gl.info.render.calls, px: buf.slice() };
  };

  const base = shoot();

  // One entry per distinct top-level name, so `kart_nova` and `kart_iris` are
  // separate but a group's children are folded into it.
  const named = new Map();
  scene.traverse((o) => {
    if (!o.name) return;
    for (let p = o.parent; p; p = p.parent) if (p.name) return;   // child of a named group
    named.set(o.name, o);
  });

  const out = [];
  for (const [name, obj] of named) {
    const saved = [];
    obj.traverse((c) => { saved.push([c, c.layers.mask]); c.layers.set(31); });
    const hidden = shoot();
    for (const [c, mask] of saved) c.layers.mask = mask;

    let moved = 0, strong = 0, maxd = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const d = Math.max(
        Math.abs(base.px[i] - hidden.px[i]),
        Math.abs(base.px[i + 1] - hidden.px[i + 1]),
        Math.abs(base.px[i + 2] - hidden.px[i + 2]),
      );
      if (d > 2) moved++;
      if (d > 16) strong++;
      if (d > maxd) maxd = d;
    }
    out.push({
      name,
      draws: base.calls - hidden.calls,
      pct: (100 * moved) / (w * h),
      strongPct: (100 * strong) / (w * h),
      maxd,
    });
  }
    rt.dispose();
    return { total: base.calls, rows: out };
  });

  totalCalls = Math.max(totalCalls, frame.total);
  for (const r of frame.rows) {
    const prev = best.get(r.name);
    if (!prev || r.strongPct > prev.strongPct) best.set(r.name, r);
    else if (r.draws > prev.draws) prev.draws = r.draws;
  }
}

const rows = { total: totalCalls, rows: [...best.values()] };

console.log(`\n=== ${track} over t=${times.join(', ')} — peak ${rows.total} draw calls ===`);
console.log('Each group is scored on its best frame of the set.\n');
console.log(`  ${'group'.padEnd(22)} ${'draws'.padStart(6)} ${'% moved'.padStart(9)} ${'% >16'.padStart(8)} ${'max'.padStart(5)}`);

const sorted = rows.rows.slice().sort((a, b) => b.draws - a.draws);
for (const r of sorted) {
  if (r.draws === 0 && r.pct < 0.001) continue;
  console.log(`  ${r.name.slice(0, 22).padEnd(22)} ${String(r.draws).padStart(6)} ` +
    `${r.pct.toFixed(3).padStart(9)} ${r.strongPct.toFixed(3).padStart(8)} ${String(r.maxd).padStart(5)}`);
}

// The point of the tool.
//
// Coverage alone is the wrong discriminator: a rival kart 80 m away moves
// 0.02% of the frame with a max delta of 146, which is frustum-correct and
// exactly what a distant kart should do. What marks something dead is that its
// *strongest* pixel barely moves — shadowBlob peaks at 0, the lighthouse beam
// at 1/255 across a lap and a half. Both conditions must hold.
const dead = sorted.filter((r) => r.draws > 0 && r.strongPct < minPct && r.maxd <= 8);
console.log('');
if (dead.length) {
  console.log(`Costing draw calls, contributing under ${minPct}% of the frame above 16/255:`);
  for (const r of dead) {
    console.log(`  ! ${r.name.padEnd(22)} ${r.draws} draw${r.draws === 1 ? '' : 's'} ` +
      `for ${r.strongPct.toFixed(3)}% (max delta ${r.maxd})`);
  }
  console.log('\nEach is either invisible and should go, or should be made visible on purpose.');
  process.exitCode = 1;
} else {
  console.log(`Every group costing a draw call contributes at least ${minPct}% of the frame.`);
}

await browser.close();
