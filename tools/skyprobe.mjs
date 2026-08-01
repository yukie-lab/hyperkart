#!/usr/bin/env node
/**
 * Atmosphere balance report.
 *
 * Prints the numbers `SkySystem` derives from each track's preset — metered
 * sky radiance, the exposure that falls out of it, and the sun and IBL
 * intensities expressed in those same exposed units. Tuning a sky by taking
 * screenshots is slow and confounded by wherever the camera happened to be
 * pointing; these four numbers say directly whether a preset is balanced.
 *
 * `exposedSun` is the one to watch: it is the sun's irradiance as the tone
 * mapper sees it, so a Lambertian surface of albedo a facing the sun lands at
 * roughly `exposedSun * a / pi` before ACES. Values around 3-5 give a sunlit
 * white that sits on the shoulder rather than clipping through it.
 *
 * Usage:
 *   node tools/skyprobe.mjs
 *   node tools/skyprobe.mjs sunsetCoast
 */
import { chromium } from 'playwright';

const tracks = (process.argv[2] || 'sunsetCoast,canyonRush,rainbowSkyway').split(',');
const url = process.env.HK_URL || 'http://localhost:5178/';

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log(`  ! pageerror ${e.message || e}`));

for (const t of tracks) {
  await page.goto(`${url}?track=${t}&auto=1&shot=1&quality=high`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__hk && window.__hk.ready, null, { timeout: 60000 });

  const r = await page.evaluate(() => {
    const s = window.__hk.sky;
    const fog = window.__hk.scene.fog;
    return {
      radiance: s.skyRadiance,
      exposure: s.exposure,
      sunIntensity: s.sunIntensity,
      envIntensity: s.envIntensity,
      fog: fog ? { d: fog.density, c: fog.color.toArray() } : null,
      errs: window.__hkErrors.slice(0, 3),
    };
  });

  const n = (v, w = 6, p = 3) => v.toFixed(p).padStart(w);
  console.log(`${t.padEnd(15)} radiance ${n(r.radiance, 7, 4)}  exposure ${n(r.exposure)}  ` +
    `sunI ${n(r.sunIntensity, 7, 2)}  envI ${n(r.envIntensity)}  ` +
    `exposedSun ${n(r.exposure * r.sunIntensity, 6, 2)}`);
  if (r.fog) {
    console.log(`${''.padEnd(15)} fog density ${r.fog.d.toExponential(2)}  ` +
      `colour exposed [${r.fog.c.map((v) => (v * r.exposure).toFixed(2)).join(' ')}]`);
  }
  for (const e of r.errs) console.log(`  ! ${e}`);
}

await browser.close();
