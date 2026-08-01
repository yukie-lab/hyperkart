import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, channel:'chromium', args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
p.on('pageerror', e=>console.log('PAGEERR', String(e).slice(0,200)));
await p.goto('http://localhost:5178/?auto=1&shot=1&track=sunsetCoast', {waitUntil:'load'});
await p.waitForFunction(()=>window.__hk&&window.__hk.ready, null, {timeout:60000});
const r = await p.evaluate(()=>{
  const h=window.__hk;
  const THREE=window.THREE;
  // Read the linear HDR scene value at screen centre, before any post.
  const rt = new THREE.WebGLRenderTarget(64,64,{type:THREE.HalfFloatType, colorSpace:THREE.LinearSRGBColorSpace});
  h.rs.renderer.setRenderTarget(rt);
  h.rs.renderer.clear();
  h.rs.renderer.render(h.scene, h.camera);
  const buf=new Uint16Array(64*64*4);
  h.rs.renderer.readRenderTargetPixels(rt,0,0,64,64,buf);
  h.rs.renderer.setRenderTarget(null);
  const lum=[];
  for(let i=0;i<64*64;i++){
    const R=THREE.DataUtils.fromHalfFloat(buf[i*4]), G=THREE.DataUtils.fromHalfFloat(buf[i*4+1]), B=THREE.DataUtils.fromHalfFloat(buf[i*4+2]);
    lum.push(0.2126*R+0.7152*G+0.0722*B);
  }
  lum.sort((a,b)=>a-b);
  rt.dispose();
  return {
    skyRadiance: h.sky.skyRadiance,
    exposureUniform: h.post.exposurePass.uniforms.uExposure.value,
    rendererExposure: h.rs.renderer.toneMappingExposure,
    envIntensity: h.scene.environmentIntensity,
    sunIntensity: h.lighting.sun.intensity,
    hemiIntensity: h.lighting.hemi.intensity,
    fillIntensity: h.lighting.fill.intensity,
    sceneLumP10: lum[Math.floor(lum.length*0.10)],
    sceneLumMedian: lum[Math.floor(lum.length*0.5)],
    sceneLumP90: lum[Math.floor(lum.length*0.90)],
    sceneLumMax: lum[lum.length-1],
    fog: h.scene.fog ? {color:h.scene.fog.color.getHexString(), density:h.scene.fog.density} : null,
  };
});
console.log(JSON.stringify(r,null,2));
await b.close();
