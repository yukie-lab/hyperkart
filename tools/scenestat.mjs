#!/usr/bin/env node
/**
 * Scene draw-call budget.
 *
 * `renderer.info` gives one number for the whole frame, which is not enough to
 * act on: it folds the shadow pass and the post chain in with the scene, and
 * says nothing about which part of the world is expensive. This walks the
 * graph and attributes every visible, in-frustum mesh to a group, then reports
 * what each group costs in draws and triangles — and how much of it is drawn a
 * second time into the shadow map.
 *
 * Usage:
 *   node tools/scenestat.mjs
 *   node tools/scenestat.mjs --track canyonRush --t 30
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const track = arg('track', 'sunsetCoast');
const t = parseFloat(arg('t', '20'));
const url = process.env.HK_URL || 'http://localhost:5178/';

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log(`  ! ${e.message || e}`));

await page.goto(`${url}?track=${track}&auto=1&shot=1&quality=high&field=12`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__hk?.ready, null, { timeout: 60000 });
await page.evaluate((s) => window.__hk.seek(s), t);
await page.evaluate(async () => { for (let k = 0; k < 4; k++) await window.__hk.frame(1 / 60); });

const report = await page.evaluate(() => {
  const THREE = window.THREE;
  const { scene, camera, rs } = window.__hk;

  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );

  /** Which bucket an object belongs to — nearest named ancestor wins. */
  const bucketOf = (o) => {
    for (let p = o; p; p = p.parent) {
      if (p.name) return p.name.replace(/[_-]?\d+$/, '');
    }
    return '(unnamed)';
  };

  const groups = new Map();
  let totalDraws = 0, totalTris = 0, shadowDraws = 0, culled = 0;

  scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;

    const geo = o.geometry;
    const instances = o.isInstancedMesh ? o.count : 1;
    const idxCount = geo?.index ? geo.index.count : (geo?.attributes?.position?.count ?? 0);
    const tris = Math.round((idxCount / 3) * instances);

    // An InstancedMesh is one draw call no matter how many copies it holds —
    // which is exactly the distinction this report exists to surface.
    const draws = Array.isArray(o.material) ? o.material.length : 1;

    if (o.frustumCulled && geo?.boundingSphere && !frustum.intersectsObject(o)) { culled++; return; }

    const key = bucketOf(o);
    const g = groups.get(key) || { draws: 0, tris: 0, objects: 0, instanced: 0, shadow: 0 };
    g.draws += draws;
    g.tris += tris;
    g.objects++;
    if (o.isInstancedMesh) g.instanced += instances;
    if (o.castShadow) { g.shadow += draws; shadowDraws += draws; }
    groups.set(key, g);
    totalDraws += draws;
    totalTris += tris;
  });

  return {
    info: { ...rs.renderer.info.render, programs: rs.renderer.info.programs?.length ?? 0 },
    pixelRatio: rs.currentPixelRatio,
    totalDraws, totalTris, shadowDraws, culled,
    groups: [...groups.entries()]
      .map(([name, g]) => ({ name, ...g }))
      .sort((a, b) => b.draws - a.draws),
  };
});

console.log(`\n=== ${track} @ t=${t}s  (1920x1080, pixelRatio ${report.pixelRatio.toFixed(2)}) ===`);
console.log(`renderer.info: ${report.info.calls} calls, ${report.info.triangles} tris, ${report.info.programs} programs`);
console.log(`in-frustum scene geometry: ${report.totalDraws} draws, ${report.totalTris} tris ` +
  `(${report.shadowDraws} of those also drawn into the shadow map, ${report.culled} objects culled)\n`);
console.log(`  ${'group'.padEnd(22)} ${'draws'.padStart(6)} ${'tris'.padStart(9)} ${'objs'.padStart(5)} ${'inst'.padStart(6)} ${'shadow'.padStart(6)}`);
for (const g of report.groups) {
  if (g.draws < 2 && g.tris < 500) continue;
  console.log(`  ${g.name.slice(0, 22).padEnd(22)} ${String(g.draws).padStart(6)} ${String(g.tris).padStart(9)} ` +
    `${String(g.objects).padStart(5)} ${String(g.instanced || '').padStart(6)} ${String(g.shadow).padStart(6)}`);
}

await browser.close();
