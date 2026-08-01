import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const b = await chromium.launch({ headless:true, channel:'chromium', args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
p.on('pageerror', e=>console.log('PAGEERR', String(e).slice(0,300)));
await p.goto('http://localhost:5178/?auto=1&shot=1&track=sunsetCoast', {waitUntil:'load'});
await p.waitForFunction(()=>window.__hk&&window.__hk.ready,null,{timeout:60000});
await p.evaluate(()=>window.__hk.seek(14));
await p.evaluate(()=>window.__hk.setHud(false));
await mkdir('shots/diag',{recursive:true});

const variants = {
  a_normal:      () => {},
  b_nopost:      () => { window.__hk.post.enabled = false; },
  c_noenv:       () => { window.__hk.post.enabled = true; window.__hk.scene.environmentIntensity = 0; },
  d_envonly:     () => { window.__hk.scene.environmentIntensity = 0.55; window.__hk.lighting.sun.intensity = 0; },
  e_strongsun:   () => { window.__hk.lighting.sun.intensity = 6.0; window.__hk.scene.environmentIntensity = 0.20;
                         window.__hk.lighting.hemi.intensity = 0.02; window.__hk.lighting.fill.intensity = 0.03; },
  f_nofog:       () => { window.__hk.scene.fog = null; },
  g_nosky:       () => { window.__hk.sky.sky.visible = false; window.__hk.sky.clouds.visible = false; },
};
for (const [name, fn] of Object.entries(variants)) {
  await p.evaluate(fn);
  await p.evaluate(async()=>{ for(let i=0;i<4;i++) await window.__hk.frame(1/60); });
  await p.screenshot({ path:`shots/diag/${name}.png` });
  console.log('captured', name);
}
await b.close();
