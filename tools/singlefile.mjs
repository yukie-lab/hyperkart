#!/usr/bin/env node
/**
 * Folds the build into one double-clickable HTML file.
 *
 * `dist/index.html` works from any static server but not from `file://`: a
 * `<script type="module">` is subject to CORS, and a page loaded from a file
 * has a null origin, so the browser refuses to fetch its own sibling script.
 * That is a rule about module scripts, not about this project — and the way
 * round it is to stop being a module script.
 *
 * The bundle is built as an IIFE (see vite.config.js), which has no imports or
 * exports and is therefore legal as a classic inline script. Inlined, the page
 * fetches nothing at all and opens by double-click, from a USB stick, or from
 * anywhere else with no server involved.
 *
 * Run `vite build` first; this only rewrites what is already in `dist/`.
 *
 * Usage:
 *   npm run build:single      # vite build && this
 *   node tools/singlefile.mjs [--out dist/hyperkart.html]
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = resolve(ROOT, outArg >= 0 ? argv[outArg + 1] : 'dist/hyperkart.html');

const html = await readFile(join(DIST, 'index.html'), 'utf8');

// Every local <script src> and <link rel=stylesheet href>, in order.
const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/g;
const styleRe = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g;

const local = (p) => !/^https?:|^\/\//.test(p);
const asset = async (p) => readFile(join(DIST, p.replace(/^\.?\//, '')), 'utf8');

let out = html;
let inlined = 0;

// Every replacement goes through a function, never a string. A string
// replacement expands `$&`, `` $` ``, `$'` and `$1` — and a minified bundle is
// full of `$`. That silently corrupted the first build this tool produced into
// something the browser reported only as "missing ) after argument list".
const swap = (hay, find, put) => hay.replace(find, () => put);

for (const m of [...html.matchAll(styleRe)]) {
  if (!local(m[1])) continue;
  out = swap(out, m[0], `<style>\n${await asset(m[1])}\n</style>`);
  inlined++;
}

for (const m of [...html.matchAll(scriptRe)]) {
  if (!local(m[1])) continue;
  const code = await asset(m[1]);
  if (/\bimport\s*[({*'"]/.test(code) || /\bexport\s[{*]/.test(code)) {
    console.error(`\n${m[1]} still contains import/export — it was not built as an IIFE.`);
    console.error('Check `build.rollupOptions.output.format` in vite.config.js.\n');
    process.exit(1);
  }
  // A closing tag inside a string literal would end the script element early.
  const safe = code.replace(/<\/script/gi, () => '<\\/script');
  // Moved to the end of <body> rather than inlined where it stood. Vite emits
  // the tag in <head>, which is harmless for a module script because those are
  // deferred — a classic one is not, and it ran before #app existed, failing on
  // `clientWidth` of null.
  out = swap(out, m[0], '');
  out = swap(out, '</body>', `<script>\n${safe}\n</script>\n</body>`);
  inlined++;
}

if (!inlined) {
  console.error('Nothing was inlined. Did `vite build` run?');
  process.exit(1);
}

await writeFile(OUT, out, 'utf8');
const { size } = await stat(OUT);
console.log(`${OUT.replace(ROOT + '/', '')}  ${(size / 1048576).toFixed(2)} MB  `
  + `(${inlined} asset${inlined === 1 ? '' : 's'} inlined, 0 external requests)`);
console.log('Open it by double-clicking. No server needed.');
