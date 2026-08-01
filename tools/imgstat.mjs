#!/usr/bin/env node
/**
 * Image statistics for captured frames.
 *
 * Visual review by eye is unreliable for exposure: a frame reads "bright" long
 * before it is actually clipping, and by the time clipping is obvious a third
 * of the image is already unrecoverable. These numbers make the judgement
 * repeatable — and make a before/after comparison mean something.
 *
 * Reported per image:
 *   luma      mean/median/p05/p95 in display sRGB (0..1)
 *   clipped   fraction of pixels at or above 0.996 on all three channels
 *   sat       mean HSV saturation, weighted away from near-black pixels
 *   sky/road  the same, for the top and bottom thirds separately, because a
 *             blown sky and a blown road want different fixes
 *
 * Usage:
 *   node tools/imgstat.mjs shots/a.png shots/b.png
 *   node tools/imgstat.mjs --dir shots/now
 *   node tools/imgstat.mjs --dir shots/after --vs shots/before
 */
import { chromium } from 'playwright';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

async function pngsIn(dir) {
  const names = (await readdir(dir)).filter((n) => extname(n).toLowerCase() === '.png').sort();
  return names.map((n) => join(dir, n));
}

/** Runs in the page: decode a data URL and reduce it to a stats record. */
const MEASURE = async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);

  const region = (y0, y1) => {
    const lums = [];
    let clipped = 0, satSum = 0, satW = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < c.width; x += 2) {          // every 2nd column: plenty
        const i = (y * c.width + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lums.push(l);
        if (r >= 0.996 && g >= 0.996 && b >= 0.996) clipped++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const s = mx <= 1e-5 ? 0 : (mx - mn) / mx;
        // Weight saturation by brightness so noise in the shadows doesn't
        // dominate the average.
        satSum += s * mx; satW += mx;
        n++;
      }
    }
    lums.sort((a, b) => a - b);
    const q = (p) => lums[Math.min(lums.length - 1, Math.floor(p * lums.length))];
    return {
      mean: lums.reduce((a, b) => a + b, 0) / lums.length,
      p05: q(0.05), median: q(0.5), p95: q(0.95),
      clipped: clipped / n,
      sat: satW > 0 ? satSum / satW : 0,
    };
  };

  const h = c.height;
  return {
    w: c.width, h,
    all: region(0, h),
    sky: region(0, Math.floor(h / 3)),
    ground: region(Math.floor(h * 2 / 3), h),
  };
};

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const f2 = (v) => v.toFixed(3);

function line(label, s) {
  return `  ${label.padEnd(7)} luma ${f2(s.mean)} (p05 ${f2(s.p05)} med ${f2(s.median)} p95 ${f2(s.p95)})` +
    `  clip ${pct(s.clipped).padStart(6)}  sat ${f2(s.sat)}`;
}

/** Flags the failure modes these captures kept hitting. */
function verdict(r) {
  const notes = [];
  if (r.all.clipped > 0.06) notes.push(`CLIPPING ${pct(r.all.clipped)} of frame is pure white`);
  if (r.sky.clipped > 0.25) notes.push(`SKY BLOWN ${pct(r.sky.clipped)}`);
  if (r.all.mean > 0.72) notes.push(`OVEREXPOSED mean luma ${f2(r.all.mean)}`);
  if (r.all.mean < 0.10) notes.push(`UNDEREXPOSED mean luma ${f2(r.all.mean)}`);
  if (r.all.sat < 0.13) notes.push(`WASHED OUT sat ${f2(r.all.sat)}`);
  if (r.all.p05 > 0.32) notes.push(`NO BLACKS p05 ${f2(r.all.p05)} — nothing anchors the image`);
  return notes;
}

async function main() {
  let targets = files.map((f) => resolve(f));
  const dir = arg('dir');
  if (dir) targets = (await pngsIn(resolve(dir))).map((p) => resolve(p));
  if (!targets.length) {
    console.error('usage: node tools/imgstat.mjs <png...> | --dir <dir> [--vs <dir>]');
    process.exit(1);
  }

  const vsDir = arg('vs');
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();

  const measure = async (path) => {
    const buf = await readFile(path);
    return page.evaluate(MEASURE, `data:image/png;base64,${buf.toString('base64')}`);
  };

  for (const path of targets) {
    const r = await measure(path);
    console.log(`\n${basename(path)}  ${r.w}x${r.h}`);
    console.log(line('frame', r.all));
    console.log(line('sky', r.sky));
    console.log(line('ground', r.ground));

    if (vsDir) {
      try {
        const b = await measure(resolve(vsDir, basename(path)));
        const d = (a, c) => { const x = a - c; return `${x >= 0 ? '+' : ''}${x.toFixed(3)}`; };
        console.log(`  vs base  luma ${d(r.all.mean, b.all.mean)}  ` +
          `clip ${d(r.all.clipped, b.all.clipped)}  sat ${d(r.all.sat, b.all.sat)}`);
      } catch {
        console.log('  vs base  (no matching baseline)');
      }
    }

    for (const n of verdict(r)) console.log(`  ! ${n}`);
  }

  await browser.close();
}

main().catch((e) => { console.error('imgstat failed:', e); process.exit(1); });
