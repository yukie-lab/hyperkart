#!/usr/bin/env node
/**
 * Measures what an effect actually costs the frame, and what it hides.
 *
 * Three renders of one simulation state:
 *
 *   A  effect on,  kart on
 *   B  effect off, kart on      A-B is the effect, and nothing else
 *   C  effect off, kart off     B-C is the kart's true silhouette
 *
 * The third render is the point. "The plume covers the player's kart" measured
 * against a screen-space *bounding box* reported 30%; measured against the
 * silhouette it is 6%, because a kart's box is mostly the gaps between its
 * wheels. A box overstates occlusion by five times and would have justified
 * shrinking an effect that was never in the way.
 *
 * B and C are recomposed with `post.render` and never with `frame()`: `frame()`
 * runs `post.update`, which moves `uTime`, which the grain hashes — do that
 * between the shots and the difference comes back as 27% of the frame and the
 * whole measurement is worthless. This tool made that mistake first.
 *
 * A caution on comparing effects. A sustained effect (a boost plume) is at full
 * strength in any frame that catches it; a transient (an impact, 0.35 s) is at
 * full strength in about four. Comparing one still of each measures the phase
 * you happened to sample, not the design. Force the transient and settle two
 * frames, as this does, or the numbers mean nothing.
 *
 * Usage:
 *   node tools/fxaudit.mjs
 *   node tools/fxaudit.mjs --track rainbowSkyway --t 34 --effects boost,impact
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const track = arg('track', 'sunsetCoast');
const t = parseFloat(arg('t', '20'));
const effects = arg('effects', 'boost,impact').split(',').map((s) => s.trim()).filter(Boolean);
const W = parseInt(arg('w', '1920'), 10), H = parseInt(arg('h', '1080'), 10);
const url = process.env.HK_URL || 'http://localhost:5178/';
const SETTLE = 8, SETTLE_DT = 1 / 60;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

/** Difference stats between two raw RGBA buffers, plus silhouette coverage. */
function analyse(a, b, c, w, h) {
  let fx = 0, sil = 0, cov = 0, mx = 0;
  let minx = w, miny = h, maxx = 0, maxy = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const df = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
    const dk = Math.max(Math.abs(b[p] - c[p]), Math.abs(b[p + 1] - c[p + 1]), Math.abs(b[p + 2] - c[p + 2]));
    if (df > mx) mx = df;
    if (df > 16) {
      fx++;
      const x = i % w, y = (i / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (dk > 16) { sil++; if (df > 16) cov++; }
  }
  return { fx, sil, cov, mx, w: maxx - minx, h: maxy - miny };
}

const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log(`  ! ${e.message || e}`));

console.log(`\n${track} @ t=${t}, ${W}x${H}\n`);
for (const effect of effects) {
  await page.goto(`${url}?track=${track}&auto=1&shot=1&quality=high&field=12&seed=20250802`,
    { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__hk?.ready, null, { timeout: 120000 });
  await page.evaluate(() => { window.__hk.stopForCapture(); window.__hk.setHud(false); });

  const frames = Math.max(0, Math.min(SETTLE, Math.floor(t / SETTLE_DT + 1e-9)));
  await page.evaluate((s) => window.__hk.seek(s), Math.max(0, t - frames * SETTLE_DT));
  await page.evaluate(([n, d]) => window.__hk.settle(n, d), [frames, SETTLE_DT]);

  await page.evaluate((e) => {
    const p = window.__hk.race.player;
    if (e === 'boost') { p.boostActive = true; p.boostKind = 'drift'; p.boostStrength = 0.8; }
    else if (e === 'impact') window.__hk.race.fx.impact(p.pos, 0xff7744, 30, 'shell');
  }, effect);
  if (effect === 'boost') {
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => {
        const p = window.__hk.race.player;
        p.boostActive = true; p.boostKind = 'drift'; p.boostStrength = 0.8;
      });
      await page.evaluate(() => window.__hk.settle(1, 1 / 60));
    }
  } else await page.evaluate(() => window.__hk.settle(2, 1 / 60));
  await page.evaluate(() => window.__hk.frame(1 / 60));

  const grab = () => page.evaluate(() => {
    const c = window.__hk.rs.renderer.domElement;
    const cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    cv.getContext('2d').drawImage(c, 0, 0);
    return { w: c.width, h: c.height, d: Array.from(cv.getContext('2d').getImageData(0, 0, c.width, c.height).data) };
  });
  const A = await grab();
  await page.evaluate(() => {
    window.__hk.scene.traverse((o) => { if (o.name && /^fx_/.test(o.name)) o.traverse((c) => c.layers.set(31)); });
    window.__hk.rs.beginFrame(); window.__hk.post.render(1 / 60);
  });
  const B = await grab();
  await page.evaluate(() => {
    window.__hk.race.player.model.group.traverse((c) => c.layers.set(31));
    window.__hk.rs.beginFrame(); window.__hk.post.render(1 / 60);
  });
  const C = await grab();

  const r = analyse(A.d, B.d, C.d, A.w, A.h);
  const px = A.w * A.h;
  console.log(`${effect}`);
  console.log(`  footprint        ${r.fx} px >16/255  (${(100 * r.fx / px).toFixed(2)}% of frame), max delta ${r.mx}`);
  console.log(`  spread           ${r.w}x${r.h} px = ${(100 * r.w / A.w).toFixed(0)}% of frame width`);
  console.log(`  kart silhouette  ${r.sil} px`);
  console.log(`  ...of which hidden by the effect: ${r.cov} = ${(100 * r.cov / Math.max(r.sil, 1)).toFixed(1)}%\n`);
}
await browser.close();
