#!/usr/bin/env node
/**
 * Offline movie renderer.
 *
 * Records the autopilot driving a full race, one frame at a time, and encodes
 * the result. Nothing here runs in real time: the simulation is fixed-timestep
 * and deterministic, so a frame is advanced by exactly 1/fps of *simulated*
 * time and then photographed at whatever pace the machine can manage. The
 * output is therefore a perfect 60 fps regardless of how fast this renders,
 * and 4K costs render minutes rather than dropped frames.
 *
 * That is the whole reason this exists instead of a screen recording. A screen
 * recording is capped by what the machine can draw live, stutters wherever it
 * cannot keep up, and comes out different every run. This does not.
 *
 * There is no audio — Web Audio has no offline path through the live engine
 * here. For a clip with sound, open `?auto=1` in a browser and screen-record.
 *
 * Usage:
 *   node tools/movie.mjs --track canyonRush --laps 1
 *   node tools/movie.mjs --track sunsetCoast --w 3840 --h 2160 --fps 60
 *   node tools/movie.mjs --seconds 20 --cam bumper --hud 0 --out movie/onboard.mp4
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';

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
  laps: arg('laps', null),
  w: parseInt(arg('w', '1920'), 10),
  h: parseInt(arg('h', '1080'), 10),
  fps: parseInt(arg('fps', '60'), 10),
  // Stop after this many seconds instead of at the chequered flag.
  seconds: arg('seconds', null) ? parseFloat(arg('seconds')) : null,
  // Frames to keep rolling after the race ends, so the finish has room to land.
  tail: parseFloat(arg('tail', '4')),
  out: arg('out', null),
  png: flag('png'),
  jpegQuality: parseInt(arg('jpeg-quality', '95'), 10),
  crf: arg('crf', '20'),
  preset: arg('preset', 'medium'),
  keepFrames: flag('keep-frames'),
  timeout: parseInt(arg('timeout', '120000'), 10),
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

const OUT = resolve(CFG.out || `movie/${CFG.track}.mp4`);
const FRAMES = join(dirname(OUT), `.frames_${CFG.track}`);
const EXT = CFG.png ? 'png' : 'jpg';

/** Is ffmpeg on PATH? Encoding is optional; the frames are the real output. */
function haveFfmpeg() {
  return new Promise((r) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => r(false));
    p.on('close', (c) => r(c === 0));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(err.slice(-800)))));
  });
}

const hhmmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: LAUNCH_ARGS });
  const page = await browser.newPage({
    viewport: { width: CFG.w, height: CFG.h },
    deviceScaleFactor: 1,
  });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e.message || e)));

  const url = new URL(CFG.url);
  url.searchParams.set('track', CFG.track);
  url.searchParams.set('quality', CFG.quality);
  url.searchParams.set('field', CFG.field);
  url.searchParams.set('character', CFG.character);
  url.searchParams.set('seed', CFG.seed);
  url.searchParams.set('cam', CFG.cam);
  url.searchParams.set('auto', '1');
  url.searchParams.set('shot', '1');
  if (CFG.laps) url.searchParams.set('laps', CFG.laps);

  await page.goto(url.toString(), { waitUntil: 'load', timeout: CFG.timeout });
  await page.waitForFunction(() => window.__hk && window.__hk.ready, null, { timeout: CFG.timeout });

  // SwiftShader would make this take hours and look wrong; say which GPU ran it.
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  if (/swiftshader|software/i.test(gpu)) {
    console.log(`\n  GPU: ${gpu}\n  ソフトウェア描画です。中止します。\n`);
    await browser.close();
    process.exit(1);
  }

  await page.evaluate(() => window.__hk.stopForCapture());
  if (!CFG.hud) await page.evaluate(() => window.__hk.setHud(false));

  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  const dt = 1 / CFG.fps;
  const hardCap = CFG.seconds ?? 600;          // never spin forever
  const t0 = Date.now();
  let n = 0, finishedAt = null, last = null;

  console.log(`\n  ${CFG.track}  ${CFG.w}x${CFG.h} @${CFG.fps}fps  cam=${CFG.cam}  GPU: ${gpu}`);
  console.log(`  ${CFG.seconds ? `${CFG.seconds} 秒` : 'ゴールまで'}記録します\n`);

  for (;;) {
    last = await page.evaluate((d) => window.__hk.record(d), dt);
    const buf = await page.screenshot(
      CFG.png ? { type: 'png' } : { type: 'jpeg', quality: CFG.jpegQuality },
    );
    await writeFile(join(FRAMES, `f${String(n).padStart(6, '0')}.${EXT}`), buf);
    n++;

    if (CFG.seconds !== null) {
      if (n >= Math.round(CFG.seconds * CFG.fps)) break;
    } else {
      if (last.state === 'finished' && finishedAt === null) finishedAt = n;
      if (finishedAt !== null && n - finishedAt >= Math.round(CFG.tail * CFG.fps)) break;
    }
    if (last.time > hardCap) break;

    if (n % (CFG.fps * 5) === 0) {
      const per = (Date.now() - t0) / n;
      const done = hhmmss(n / CFG.fps);
      console.log(`  ${String(n).padStart(6)} frames  映像 ${done}  `
        + `lap ${last.lap}/${last.laps}  ${(per).toFixed(0)} ms/frame  経過 ${hhmmss((Date.now() - t0) / 1000)}`);
    }
  }
  await browser.close();

  const secs = n / CFG.fps;
  console.log(`\n  ${n} フレーム = ${secs.toFixed(1)} 秒の映像`
    + `  (書き出し ${hhmmss((Date.now() - t0) / 1000)})`);
  if (errors.length) console.log(`  ページのエラー ${errors.length} 件: ${errors[0].slice(0, 120)}`);

  await mkdir(dirname(OUT), { recursive: true });
  if (await haveFfmpeg()) {
    // yuv420p and even dimensions, or QuickTime and most browsers refuse it.
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-framerate', String(CFG.fps),
      '-i', join(FRAMES, `f%06d.${EXT}`),
      '-c:v', 'libx264', '-preset', CFG.preset, '-crf', CFG.crf,
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      OUT,
    ]);
    console.log(`  → ${OUT}`);
    if (!CFG.keepFrames) await rm(FRAMES, { recursive: true, force: true });
    else console.log(`  連番も保持: ${FRAMES}`);
  } else {
    const files = (await readdir(FRAMES)).length;
    console.log(`\n  ffmpeg が見つからないので連番画像のまま残しました (${files} 枚)`);
    console.log(`    ${FRAMES}`);
    console.log(`\n  mp4 にするには:`);
    console.log(`    brew install ffmpeg`);
    console.log(`    ffmpeg -framerate ${CFG.fps} -i ${join(FRAMES, `f%06d.${EXT}`)} \\`);
    console.log(`      -c:v libx264 -preset ${CFG.preset} -crf ${CFG.crf} -pix_fmt yuv420p ${OUT}`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
