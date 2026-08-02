#!/usr/bin/env node
/**
 * Kart model inspector.
 *
 * Parks the camera on one stationary kart and orbits it so the model can be
 * judged as a model, rather than only from behind at racing speed. Also prints
 * an exact per-kart draw-call / triangle budget by walking the kart's subtree.
 *
 * Usage:
 *   node tools/kartinspect.mjs --outdir shots/inspect --angles 0,45,120,215,300
 *   node tools/kartinspect.mjs --character boulder --dist 3.2 --elev 0.9
 *   node tools/kartinspect.mjs --grid           # one frame per character
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const CFG = {
  url: arg('url', 'http://localhost:5178/'),
  track: arg('track', 'sunsetCoast'),
  character: arg('character', 'nova'),
  quality: arg('quality', 'high'),
  w: parseInt(arg('w', '1280'), 10),
  h: parseInt(arg('h', '900'), 10),
  t: parseFloat(arg('t', '6')),
  dist: parseFloat(arg('dist', '3.6')),
  elev: parseFloat(arg('elev', '1.15')),
  angles: (arg('angles', '25,110,200,325')).split(',').map(Number),
  outdir: arg('outdir', 'shots/inspect'),
  grid: flag('grid'),
  far: flag('far'),
};

const LAUNCH_ARGS = [
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization', '--enable-zero-copy',
  '--disable-frame-rate-limit', '--force-color-profile=srgb', '--hide-scrollbars',
];

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: LAUNCH_ARGS });
  const page = await browser.newPage({ viewport: { width: CFG.w, height: CFG.h }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e.message || e)));

  const url = new URL(CFG.url);
  url.searchParams.set('track', CFG.track);
  url.searchParams.set('quality', CFG.quality);
  url.searchParams.set('field', '12');
  url.searchParams.set('character', CFG.character);
  url.searchParams.set('seed', '20250802');
  url.searchParams.set('auto', '1');
  url.searchParams.set('shot', '1');
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__hk && window.__hk.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__hk.setHud(false));
  await page.evaluate((t) => window.__hk.seek(t), CFG.t);
  // Park the main loop: otherwise its next rAF render overwrites our framing.
  await page.evaluate(() => window.__hk.loop.stop());

  // --- Budget report -------------------------------------------------------
  const budget = await page.evaluate(() => {
    const out = [];
    for (const k of window.__hk.race.karts) {
      let draws = 0, tris = 0, meshes = 0;
      const parts = [];
      k.model.group.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        let vis = true;
        for (let p = o.parent; p; p = p.parent) if (!p.visible) { vis = false; break; }
        if (!vis) return;
        meshes++;
        const g = o.geometry;
        const n = Array.isArray(o.material) ? Math.max(1, g.groups.length) : 1;
        draws += n;
        const idx = g.index ? g.index.count : g.attributes.position.count;
        tris += idx / 3;
        parts.push(`${o.name || o.type}:${Math.round(idx / 3)}`);
      });
      out.push({ id: k.stats.id, draws, tris: Math.round(tris), meshes, parts });
    }
    return out;
  });
  const tot = budget.reduce((a, b) => ({ draws: a.draws + b.draws, tris: a.tris + b.tris }), { draws: 0, tris: 0 });
  process.stdout.write(`\nPER-KART BUDGET (${budget.length} karts)\n`);
  for (const b of budget) process.stdout.write(`  ${b.id.padEnd(9)} draws=${String(b.draws).padStart(3)} tris=${String(b.tris).padStart(6)} meshes=${b.meshes}\n`);
  process.stdout.write(`  TOTAL      draws=${tot.draws} tris=${tot.tris}   avg/kart draws=${(tot.draws / budget.length).toFixed(1)} tris=${Math.round(tot.tris / budget.length)}\n`);
  process.stdout.write(`  parts[0]: ${budget[0].parts.slice(0, 40).join(' ')}\n\n`);

  // --- Orbit capture -------------------------------------------------------
  await page.evaluate(() => {
    const hk = window.__hk;
    hk.__inspect = (opt) => {
      const THREE = window.THREE;
      const kart = hk.race.karts.find((k) => k.stats.id === opt.id) || hk.race.player;
      hk.race.render(1, 1 / 60, hk.camera.position);
      const c = kart.model.group.position.clone();
      c.y += 0.42;
      const a = opt.angle * Math.PI / 180 + kart.yaw;
      hk.camera.position.set(
        c.x + Math.sin(a) * opt.dist,
        c.y + opt.elev,
        c.z + Math.cos(a) * opt.dist,
      );
      hk.camera.lookAt(c);
      hk.camera.fov = opt.fov || 42;
      hk.camera.updateProjectionMatrix();
      hk.camera.updateMatrixWorld(true);
      if (opt.clean) {
        // Bypass post/fog so the model itself can be judged while other agents
        // are mid-edit on exposure, haze and bloom.
        const fog = hk.scene.fog;
        if (opt.nofog) hk.scene.fog = null;
        // `renderer.info.autoReset` is off (the composer issues several passes
        // per frame), so without an explicit reset these counts accumulate
        // across every frame this tool draws. That is where the "~1000 draw
        // calls" figure quoted around this project came from: four orbit
        // frames of one scene reported 309, 421, 675, 1035.
        hk.rs.beginFrame();
        hk.rs.renderer.setRenderTarget(null);
        hk.rs.renderer.render(hk.scene, hk.camera);
        hk.scene.fog = fog;
      } else {
        hk.post.update(1 / 60, { speed01: 0, boosting: false, hit: 0, time: hk.loop.simTime });
        hk.rs.beginFrame();
        hk.post.render(1 / 60);
      }
      return { draws: hk.rs.renderer.info.render.calls, tris: hk.rs.renderer.info.render.triangles };
    };
  });

  const shots = CFG.grid
    ? (await page.evaluate(() => window.__hk.race.karts.map((k) => k.stats.id)))
        .map((id, i) => ({ id, angle: 35 + i * 12, name: `char_${String(i).padStart(2, '0')}_${id}` }))
    : CFG.angles.map((angle) => ({ id: CFG.character, angle, name: `orbit_${String(angle).padStart(3, '0')}` }));

  for (const s of shots) {
    const dist = CFG.far ? 62 : CFG.dist;
    const info = await page.evaluate((o) => {
      const r = window.__hk.__inspect(o);
      return new Promise((res) => requestAnimationFrame(() => res(r)));
    }, {
      id: s.id, angle: s.angle, dist, elev: CFG.far ? 14 : CFG.elev,
      fov: CFG.far ? 8 : 42, clean: !flag('post'), nofog: !flag('fog'),
    });
    const p = resolve(CFG.outdir, `${s.name}.png`);
    await mkdir(dirname(p), { recursive: true });
    await page.screenshot({ path: p, type: 'png' });
    process.stdout.write(`  ${p}  scene draws=${info.draws} tris=${info.tris}\n`);
  }

  const all = [...new Set(errs)];
  if (all.length) { process.stdout.write(`\nERRORS (${all.length}):\n`); for (const e of all.slice(0, 15)) process.stdout.write(`  ! ${e}\n`); }
  await browser.close();
  if (all.length) process.exitCode = 2;
}

main().catch((e) => { console.error('kartinspect failed:', e); process.exit(1); });
