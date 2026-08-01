import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, channel:'chromium', args:['--use-angle=metal','--enable-gpu'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
p.on('pageerror', e=>console.log('PAGEERR', String(e).slice(0,300)));
await p.goto('http://localhost:5178/?auto=1&shot=1', {waitUntil:'load'});
await p.waitForFunction(()=>window.__hk&&window.__hk.ready,null,{timeout:60000});
await p.evaluate(()=>window.__hk.seek(14));
console.log(JSON.stringify(await p.evaluate(()=>{
  const h=window.__hk, t=h.race.track, pl=h.race.player;
  const ocean=h.scene.getObjectByName('ocean');
  // sample road centre height around the lap
  const samples=[];
  for(let i=0;i<12;i++){ const s=(i/12)*t.length; samples.push(+t.groundHeight(s,0).toFixed(2)); }
  return {
    trackMinY:+t.minY.toFixed(2), trackMaxY:+t.maxY.toFixed(2), waterLevel:+t.waterLevel.toFixed(2),
    oceanY: ocean? ocean.position.y : null,
    playerY:+pl.pos.y.toFixed(2), playerGroundY:+pl.ground.height.toFixed(2), onRoad:pl.ground.onRoad,
    lateral:+pl.lateral.toFixed(2), halfWidth:+pl.ground.halfWidth.toFixed(2),
    roadHeightsAroundLap: samples,
    roadMeshName: h.scene.getObjectByName('road')?.name,
  };
}),null,2));
await b.close();
