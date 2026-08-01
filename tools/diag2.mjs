import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const b = await chromium.launch({ headless:true, channel:'chromium', args:['--use-angle=metal','--enable-gpu'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
p.on('pageerror', e=>console.log('PAGEERR', String(e).slice(0,300)));
await p.goto('http://localhost:5178/?auto=1&shot=1', {waitUntil:'load'});
await p.waitForFunction(()=>window.__hk&&window.__hk.ready,null,{timeout:60000});
await p.evaluate(()=>window.__hk.seek(14));
await p.evaluate(()=>window.__hk.setHud(false));
await mkdir('shots/diag2',{recursive:true});

// 1) Is the surface under the karts the road, or the ocean?
console.log(JSON.stringify(await p.evaluate(()=>{
  const h=window.__hk, THREE=window.THREE;
  const road=h.scene.getObjectByName('road'), ocean=h.scene.getObjectByName('ocean');
  // Raycast straight down from the player.
  const rc=new THREE.Raycaster(h.race.player.pos.clone().setY(h.race.player.pos.y+2), new THREE.Vector3(0,-1,0), 0, 200);
  const hits=rc.intersectObjects([road, ocean].filter(Boolean), false);
  return { hits: hits.map(x=>({name:x.object.name, dist:+x.distance.toFixed(2), y:+x.point.y.toFixed(2)})) };
}),null,2));

// 2) Paint the road magenta to see exactly where it is.
await p.evaluate(()=>{ window.__hk.scene.getObjectByName('road').material.color.setHex(0xff00ff); window.__hk.post.enabled=false; });
await p.evaluate(async()=>{ for(let i=0;i<4;i++) await window.__hk.frame(1/60); });
await p.screenshot({path:'shots/diag2/road_magenta.png'});

// 3) Bloom sweep with post back on.
await p.evaluate(()=>{ window.__hk.scene.getObjectByName('road').material.color.setHex(0xffffff); window.__hk.post.enabled=true; });
for (const [name, s, th] of [['bloom_off',0.0,1.0],['bloom_light',0.12,1.15],['bloom_mid',0.22,1.05]]) {
  await p.evaluate(([s,th])=>{ window.__hk.post.bloom.strength=s; window.__hk.post.bloom.threshold=th; }, [s,th]);
  await p.evaluate(async()=>{ for(let i=0;i<4;i++) await window.__hk.frame(1/60); });
  await p.screenshot({path:`shots/diag2/${name}.png`});
  console.log('captured',name);
}
await b.close();
