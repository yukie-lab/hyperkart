import * as THREE from 'three';
import { clamp, clamp01, lerp, makeRng, makeValueNoise2D, fbm2D, mod, smoothstep, TAU } from '../core/MathX.js';

/**
 * Procedural PBR texture generation.
 *
 * Every surface in the game is authored here as code: a height field is
 * generated first, then albedo/roughness are derived from it and the normal
 * map is produced by Sobel-differentiating the height. Deriving the normal
 * from the same height that drove the albedo is what keeps the lighting
 * response consistent — the single biggest tell between "programmer texture"
 * and something that reads as a real material.
 *
 * All textures are tileable: noise bases wrap on their period and every
 * pattern is authored modulo the texture size.
 */

const _textureCache = new Map();

function canvas(size, height = size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  return c;
}

// Ground planes are always seen at a grazing angle, which is the worst case for
// mip selection: without a wide anisotropic tap count the GPU picks a mip from
// the *short* axis of the footprint and the surface crawls as the camera moves.
// 16 is the ceiling on every GPU we care about and three clamps it down safely.
function makeTexture(canvasEl, { srgb = false, repeat = 1, aniso = 16 } = {}) {
  const tex = new THREE.CanvasTexture(canvasEl);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.repeat.set(repeat, repeat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel-differentiate a height buffer into a tangent-space normal map.
 *
 * `rows` exists for atlases, which are the one thing here that is not square:
 * a strip of twelve grid boxes is 12:1, and squaring it would either quantise
 * every cell to a twelfth of the resolution or waste eleven twelfths of the
 * memory. Wrapping still happens on both axes, which is correct for an atlas
 * laid out in one row — the cell to the left of the first is the last.
 */
export function heightToNormal(height, size, strength = 2.0, rows = size) {
  const c = canvas(size, rows);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, rows);
  const at = (x, y) => height[mod(y, rows) * size + mod(x, size)];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Write an RGB(A) buffer produced by `fn(x,y)` into a canvas. */
function paint(size, fn, rows = size) {
  const c = canvas(size, rows);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, rows);
  const out = [0, 0, 0, 255];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < size; x++) {
      fn(x, y, out);
      const i = (y * size + x) * 4;
      img.data[i] = clamp(out[0], 0, 255);
      img.data[i + 1] = clamp(out[1], 0, 255);
      img.data[i + 2] = clamp(out[2], 0, 255);
      img.data[i + 3] = out[3] === undefined ? 255 : clamp(out[3], 0, 255);
      out[3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function grayCanvas(size, buf, scale = 255, rows = size) {
  return paint(size, (x, y, o) => {
    const v = buf[y * size + x] * scale;
    o[0] = o[1] = o[2] = v;
  }, rows);
}

/**
 * A tint, kept in the space the canvas is actually stored in.
 *
 * Every `map` here is written as 8-bit sRGB and tagged SRGBColorSpace, so the
 * bytes must be sRGB-encoded. `new THREE.Color(hex)` does the opposite: with
 * colour management on it *decodes* the hex to linear-sRGB, and painting that
 * back out as sRGB bytes darkens the surface by the transfer function twice.
 * The error is worst on dark tints — asphalt was landing at 0.011 linear
 * albedo instead of 0.10, roughly a ninth of real tarmac, which is why the
 * road only ever looked lit when its normal map was over-driven into the sun.
 */
function paintTint(hex) {
  return new THREE.Color().setHex(hex, THREE.NoColorSpace);
}

/**
 * A noise basis paired with the sampling scale that makes it tile.
 *
 * `makeValueNoise2D(seed, P)` only repeats after P *noise cells*, so sampling
 * it at `x / k` wraps at `P * k` texels — the two numbers have to agree or the
 * texture seams. Worse, they fail silently in the other direction: a
 * non-integer P indexes the lookup table between slots, every sample comes
 * back NaN, and the whole map paints black with no error anywhere. Deriving
 * both from one "texels per noise cell" figure makes both faults impossible.
 */
function tiling(seed, size, texelsPerCell) {
  const period = Math.max(2, Math.round(size / texelsPerCell));
  return { n: makeValueNoise2D(seed, period), k: size / period };
}

/** sRGB -> linear, matching what the GPU does when it samples an sRGB texture. */
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Mean *linear* luminance of a painted canvas.
 *
 * Shaders that re-sample a tile at a second, much larger scale need a pivot to
 * modulate around; using the tile's own mean is the only way to add macro
 * variation without also shifting the surface's overall brightness (and with it
 * the frame exposure, which is not ours to move).
 */
function meanLinearLuma(canvasEl) {
  const size = canvasEl.width;
  const d = canvasEl.getContext('2d').getImageData(0, 0, size, size).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += 0.2126 * srgbToLinear(d[i] / 255)
      + 0.7152 * srgbToLinear(d[i + 1] / 255)
      + 0.0722 * srgbToLinear(d[i + 2] / 255);
  }
  return sum / (size * size);
}

/**
 * Mean *linear* colour of a painted canvas.
 *
 * What a texture converges to under infinite minification, and therefore the
 * only honest colour to fade a pattern towards once its features drop below a
 * pixel. Averaged in linear light because that is the space the shader will be
 * mixing in — averaging the sRGB bytes instead lands a red/white kerb about
 * 20% too dark, which reads as a distant kerb going grey.
 */
function meanLinearColor(canvasEl) {
  const size = canvasEl.width;
  const d = canvasEl.getContext('2d').getImageData(0, 0, size, size).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += srgbToLinear(d[i] / 255);
    g += srgbToLinear(d[i + 1] / 255);
    b += srgbToLinear(d[i + 2] / 255);
  }
  const n = size * size;
  return new THREE.Color(r / n, g / n, b / n);
}

// ---------------------------------------------------------------------------
// Material generators. Each returns { map, normalMap, roughnessMap, ... }.
// ---------------------------------------------------------------------------

/**
 * Asphalt: graded aggregate chippings set in bitumen binder.
 *
 * The previous version put most of its energy into a 4-texel-period grain,
 * which is below the Nyquist limit of every mip the road is actually drawn at.
 * That is what made the surface hiss and crawl: the eye tracks a pattern the
 * sampler cannot hold still. Here the *stones* carry the height and the
 * fine grain survives only in albedo, where mipmapping averages it away
 * gracefully instead of turning into moving specular noise.
 *
 * Macro-scale storytelling — racing line, patch repairs, kerb grime — is not
 * baked here on purpose: it belongs in road space, not in a 6 m tile that
 * repeats five times a second at racing speed. TrackBuilder layers it on.
 *
 * What this pass changed, and why, measured rather than guessed. Two captures
 * one 8.3 ms simulation step apart, karts and particles hidden, on a band of
 * tarmac 30-45 m out where 25 cm of travel is well under a pixel: 76% of those
 * pixels moved by more than 4/255 and 21% by more than 16/255, against 30% and
 * 2.4% for the sky. Nulling the roughness map changed nothing. Nulling the
 * *normal* map took it to 37% and 0.9% — sky level. All of it was here, and
 * nearly all of that was the crack field: ridged noise raised to the ninth
 * power leaves crests one or two texels wide, and a one-texel ridge in a height
 * map is a normal spike that no mip chain and no anisotropic tap count can
 * average away. It also read, at 2x, as a crazed reptile-skin net over the
 * whole surface — the "crumb noise with irregular dark blotches" in the review.
 * So the fissures are now broad and sparse, they carry a fifth of the relief
 * they did, and the aggregate is graded so the read at distance comes from the
 * binder rather than from the chippings.
 */
export function asphalt({ size = 1024, seed = 7, tint = 0x3a3d44 } = {}) {
  const key = `asphalt_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  // Four scales, in texels of the 6 m road tile: ~2 cm grain, ~40 cm binder
  // mottling, ~75 cm crack cells that fbm grows into long single fissures
  // rather than a net, and the paver's screed streak along the direction of
  // travel. That last one matters out of proportion to its amplitude: it is the
  // only thing in the tile with a *direction*, and a road surface whose grain
  // runs across it reads as concrete slab, not as laid asphalt.
  const grainN = tiling(seed, size, 4);
  const binderN = tiling(seed + 91, size, 64);
  const crackN = tiling(seed + 311, size, 128);
  const screedN = tiling(seed + 419, size, 48);
  const rng = makeRng(seed + 5);

  // Jittered-grid aggregate at ~3.5 cm on the 6 m road tile. Real chippings are
  // 6-14 mm, which is under two texels here — draw them at true scale and they
  // alias, draw them big enough to resolve and the road turns into pebbledash.
  // The way out is to carry them almost entirely in *relief*: the height field
  // gets the stones, the albedo barely acknowledges them, and what the eye
  // reads as texture at a distance is the 40 cm binder mottling instead.
  const cells = 168;
  const cellSize = size / cells;
  const sites = new Float32Array(cells * cells * 4);
  for (let i = 0; i < cells * cells; i++) {
    sites[i * 4] = rng();
    sites[i * 4 + 1] = rng();
    // A wide radius spread is what separates "graded aggregate" from "gravel":
    // real tarmac mixes fines and coarse stone in the same square metre.
    sites[i * 4 + 2] = 0.26 + Math.pow(rng(), 1.6) * 0.62;
    sites[i * 4 + 3] = rng();
  }

  // Coverage of the winning stone at each texel, plus which stone won — the
  // per-stone lottery is what stops the aggregate reading as one grey mush.
  const cov = new Float32Array(size * size);
  const who = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
      let best = 0, bestId = 0.5;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = mod(cx + ox, cells), gy = mod(cy + oy, cells);
          const k = (gy * cells + gx) * 4;
          const sx = (cx + ox + sites[k]) * cellSize;
          const sy = (cy + oy + sites[k + 1]) * cellSize;
          const r = sites[k + 2] * cellSize;
          const d = Math.hypot(x - sx, y - sy);
          if (d < r) {
            // Domed, not spherical: chippings are rolled flat by the paver.
            const c = Math.pow(1 - smoothstep(d / r), 0.65);
            if (c > best) { best = c; bestId = sites[k + 3]; }
          }
        }
      }
      cov[y * size + x] = best;
      who[y * size + x] = bestId;
    }
  }

  const height = new Float32Array(size * size);
  const crackBuf = new Float32Array(size * size);
  const binderBuf = new Float32Array(size * size);
  const grainBuf = new Float32Array(size * size);
  const screedBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Two octaves on a 75 cm cell, and a fifth power rather than a ninth.
      // That widens each crest from one or two texels to eight or ten — above
      // the Nyquist limit of the mips this surface is actually drawn at — and
      // leaves a handful of long fissures instead of a net over every square
      // metre. The net was the single loudest thing on the road.
      const ridge = 1 - Math.abs(fbm2D(crackN.n, x / crackN.k, y / crackN.k, 2) * 2 - 1);
      const crack = Math.pow(clamp01(ridge), 5);
      const binder = fbm2D(binderN.n, x / binderN.k, y / binderN.k, 3);
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 2);
      // Stretched four to one along V, which is the direction of travel: the
      // screed drags the mix as the paver moves, and that is why a real road
      // has a grain running down it.
      const screed = fbm2D(screedN.n, x / screedN.k, y / (screedN.k * 4), 3);
      crackBuf[i] = crack;
      binderBuf[i] = binder;
      grainBuf[i] = grain;
      screedBuf[i] = screed;
      // Stones dominate the relief; the grain contributes barely enough to
      // break the stone silhouettes without becoming a normal-map carpet, and
      // the cracks now barely dent it at all.
      height[i] = cov[i] * 0.58 + grain * 0.12 + binder * 0.12 + screed * 0.08 - crack * 0.10 + 0.12;
    }
  }

  const base = paintTint(tint);
  const mapC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const c = cov[i];
    // Bitumen mottling is the *visible* texture of tarmac at any distance you
    // actually drive it from: 40 cm patches where the binder pooled richer or
    // leaner during laying. It has to carry the read, because it is the only
    // scale here that survives two mip levels intact — so it is now given the
    // range the cracks used to take.
    const binderL = lerp(0.90, 1.07, binderBuf[i]) * lerp(0.97, 1.03, grainBuf[i])
      * lerp(0.965, 1.035, screedBuf[i]);
    // Per-stone albedo lottery. This used to be held to a whisper on the theory
    // that a wide spread turns the road into pebbledash — true when the stones
    // also carried most of the relief, but the relief has since been cut by a
    // third and the tile now fades to its own mean before the stones can alias.
    // Which leaves albedo as the only place graded aggregate can show at all,
    // and a road with no visible chippings at two metres is the other half of
    // "one crumb noise".
    const stoneL = binderL * lerp(0.90, 1.22, Math.pow(who[i], 1.25));
    let l = lerp(binderL, stoneL, smoothstep(c));
    l *= 1 - crackBuf[i] * 0.20;
    // Stones scatter more short-wavelength light than the binder they sit in,
    // so the aggregate reads a touch cooler as it gets lighter. Kept small:
    // enough of this and tarmac turns navy the moment the sun drops.
    const cool = c * 0.008;
    o[0] = (base.r * l) * 255;
    o[1] = (base.g * l + cool * 0.4) * 255;
    o[2] = (base.b * l + cool) * 255;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Bitumen is the *smoother* phase — it is what makes a wet road shine, and
    // what gives dry tarmac its long sheen under a low sun — while the exposed
    // stone faces are near-Lambertian.
    let rgh = lerp(0.76, 0.93, smoothstep(cov[i] * 1.3));
    rgh = lerp(rgh, 0.99, crackBuf[i]);
    rgh *= lerp(0.97, 1.02, binderBuf[i]);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });

  const result = {
    map: makeTexture(mapC, { srgb: true }),
    // Deliberately gentle, and gentler than it was. Tarmac relief is
    // millimetres; drive it harder and a low sun rakes the chippings into a
    // sandpaper glare that reads as gravel — and, measurably, into per-pixel
    // specular that is 100% of this surface's temporal instability.
    normalMap: makeTexture(heightToNormal(height, size, 1.35)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.34,
    // Pivot for the second-scale sample TrackBuilder layers on; see meanLinearLuma.
    meanLuma: meanLinearLuma(mapC),
    // What the tile converges to under minification, and therefore what it has
    // to be faded towards before its features drop under a pixel. Same fix, and
    // the same reasoning, as the kerb's.
    meanColor: meanLinearColor(mapC),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Painted road markings, as an alpha decal over the tarmac.
 *
 * Track paint is a thin thermoplastic film, not vinyl: it is laid by a machine
 * that wanders, it is thinnest wherever traffic crosses it, and it fails by
 * flaking off in patches rather than fading evenly. The dashed centre line is
 * therefore markedly more eaten than the edge lines, which nothing drives on.
 * The film also stands a couple of millimetres proud of the road, so it gets a
 * normal map — at a low sun that raised lip is most of what says "painted".
 */
export function laneMarkings({ size = 512, tint = 0xeae5d6 } = {}) {
  const key = `lane_${size}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  // V tiles every 12 m of road, U spans the full width exactly once, so only
  // the V scales have to divide the tile — see `tiling`.
  const driftN = tiling(41, size, 64);   // where the machine wandered, over metres
  const widthN = tiling(97, size, 32);   // how thick it laid the film, over metres
  const wearN = tiling(77, size, 4);     // flaking, over centimetres
  const gritN = tiling(131, size, 2);
  const filmN = tiling(151, size, 4);
  const base = paintTint(tint);

  const alpha = new Float32Array(size * size);
  const film = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      // The whole set of lines drifts together — they were laid in one pass.
      const wob = fbm2D(driftN.n, 2.0, y / driftN.k, 3) - 0.5;
      const eW = 0.016 * lerp(0.74, 1.12, fbm2D(widthN.n, 5.0, y / widthN.k, 2));
      const dE = Math.min(Math.abs(u - 0.045 - wob * 0.005), Math.abs(u - 0.955 - wob * 0.005));
      let a = 1 - smoothstep(dE / eW);

      // Centre line: dashed, and eaten back hard because every kart on the
      // circuit crosses it. Its width alone tells you the racing traffic.
      const ph = mod(v, 0.25);
      const dash = smoothstep((0.145 - ph) / 0.022) * smoothstep(ph / 0.016);
      const cW = 0.012 * lerp(0.42, 1.0, fbm2D(widthN.n, 9.0, y / widthN.k, 2));
      const dC = Math.abs(u - 0.5 - wob * 0.004);
      const centre = (1 - smoothstep(dC / cW)) * dash;
      a = Math.max(a, centre * lerp(0.55, 1.0, fbm2D(wearN.n, 13.0, y / wearN.k, 3)));

      // Flaking, not fading: the film lifts in patches with hard borders and
      // leaves most of the line intact, which is what an old marking does.
      const flake = smoothstep((fbm2D(wearN.n, x / wearN.k, y / wearN.k, 4) - 0.30) * 3.0);
      a *= lerp(0.14, 1.0, flake);
      a *= lerp(0.80, 1.0, fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2));

      alpha[i] = clamp01(a);
      // Thickness drives the colour and is deliberately not the coverage: the
      // RGB has to stay bright even where nothing is painted, because a canvas
      // stores premultiplied alpha and would otherwise hand the sampler black
      // to bleed down every line edge.
      film[i] = lerp(0.72, 1.0, clamp01(a));
      height[i] = clamp01(a) * 0.72 + fbm2D(filmN.n, x / filmN.k, y / filmN.k, 2) * 0.28 * clamp01(a);
    }
  }

  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Sun-bleached and slightly dusty; brand-new white would out-read the sky.
    const l = film[i] * lerp(0.90, 1.05, fbm2D(filmN.n, x / filmN.k, y / filmN.k, 3));
    o[0] = base.r * 255 * l;
    o[1] = base.g * 255 * l;
    o[2] = base.b * 255 * l;
  });
  // Coverage rides in its own opaque texture rather than in the map's alpha,
  // for the premultiplication reason above.
  const alphaC = grayCanvas(size, alpha);
  const roughC = paint(size, (x, y, o) => {
    // Fresh film keeps a sheen; where it has worn to a stain it is as matt as
    // the road under it, which is what stops thin paint reading as new paint.
    o[0] = o[1] = o[2] = lerp(0.90, 0.44, alpha[y * size + x]) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    alphaMap: makeTexture(alphaC),
    normalMap: makeTexture(heightToNormal(height, size, 1.6)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.55,
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Rumble strip: painted concrete with a history, not a decal.
 *
 * The crown and the outer lip are geometry (see TrackBuilder), so nothing here
 * fakes the kerb's shape — the old cosine corrugation across the strip fought
 * the mesh and read as a flat plate with stripes on it. What this adds is
 * wear: paint chips off at the stripe joints first, grit packs into the shaded
 * outer roll and into the joint with the tarmac, and the crown carries rubber
 * where karts cut across it. `dirtTint` is the surrounding ground colour, so
 * the grime belongs to the place the circuit is in.
 *
 * `stripes` is deliberately small, and that is the fix for the reported crawl.
 * A square texture on a strip 1.35 m wide and eight metres long carried 379
 * texels per metre across and 64 along it, so the *across* axis was always the
 * long side of the sampling footprint. Anisotropic filtering therefore lowered
 * the mip level to suit an axis with nothing on it and spent all sixteen taps
 * there, leaving the stripes — which live entirely on the other axis —
 * undersampled at every distance past about forty metres. Measured: forcing
 * anisotropy to 1 took the far kerb's peak flicker from 89/255 to 1/255, which
 * is the whole defect. Two stripes to a tile puts the density at 256 texels
 * per metre along and 379 across, near enough square that the footprint's long
 * axis is the one the stripes are on and anisotropy starts helping instead.
 * Per-kerb variety moves to road space in TrackBuilder, which is where it
 * belonged anyway — an eight metre tile repeated too.
 */
export function curb({ size = 512, colorA = 0xd8352a, colorB = 0xf2f2f2, dirtTint = 0x8a7a5c, stripes = 2 } = {}) {
  const key = `curb_${size}_${colorA}_${colorB}_${dirtTint}_${stripes}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  // Only V has to tile here — U runs across the strip exactly once. Scales are
  // quoted in texels, and one texel is now ~3 mm across the kerb and ~4 mm
  // along it, so these are real millimetre figures rather than tile fractions.
  const paintN = tiling(17, size, 96);   // ~30 cm: how thick each pass was laid
  const chipN = tiling(53, size, 24);    // ~7 cm: patches where the film lifted
  const rubN = tiling(71, size, 128);    // ~40 cm: rubber smeared along the crown
  const gritN = tiling(89, size, 6);     // ~2 cm: the coarse face of the concrete
  const A = paintTint(colorA), B = paintTint(colorB);
  const D = paintTint(dirtTint), CONCRETE = paintTint(0xc2bcb1);

  // Paint coverage and the concrete beneath it, resolved once so the albedo,
  // roughness and height passes all agree on where the paint actually is.
  const paintBuf = new Float32Array(size * size);
  const gritBuf = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = y / size;
      // Two octaves, not three: a third puts energy at 1.5 texels, and relief
      // at the Nyquist limit is the other half of why this surface crawled.
      const grit = fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2);
      // Distance to the nearest stripe joint, in stripe units. Kerb paint is
      // laid one stripe at a time and always lifts at those seams first.
      const f = mod(v * stripes, 1);
      const joint = Math.min(f, 1 - f);
      let p = smoothstep(joint / 0.055);
      p *= 1 - clamp01((fbm2D(chipN.n, x / chipN.k, y / chipN.k, 3) - 0.70) * 5.0);
      p = clamp01(p);
      paintBuf[i] = p;
      gritBuf[i] = grit;
      // Two coats of paint stand a fraction of a millimetre proud of the
      // concrete; at grazing light that lip is the whole read of "chipped".
      height[i] = grit * 0.26 + p * 0.34 + 0.2;
    }
  }

  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    const u = x / size, v = y / size;
    const p = paintBuf[i], grit = gritBuf[i];
    const col = Math.floor(v * stripes) % 2 === 0 ? A : B;
    // How evenly the machine laid this pass, across the stripe rather than
    // along it. Which *lengths* of kerb are faded is decided in road space now
    // — a kerb where every red is the same red is the giveaway that it came out
    // of a texture generator, and with two stripes to a tile no in-tile
    // variation could have told them apart.
    const fade = lerp(0.80, 1.04, fbm2D(paintN.n, x / paintN.k, y / paintN.k, 2));
    const cl = lerp(0.80, 1.06, grit);
    let r = lerp(CONCRETE.r * cl, col.r * fade, p);
    let g = lerp(CONCRETE.g * cl, col.g * fade, p);
    let b = lerp(CONCRETE.b * cl, col.b * fade, p);
    // Grit collects where water and wind drop it: the shaded outer roll, and
    // the crevice where the kerb meets the tarmac.
    const dirt = clamp01(smoothstep((u - 0.60) / 0.40) * 0.9 + (1 - smoothstep(u / 0.11)) * 0.55)
      * lerp(0.55, 1.0, fbm2D(paintN.n, x / paintN.k, y / paintN.k, 3));
    r = lerp(r, D.r * 0.88, dirt * 0.68);
    g = lerp(g, D.g * 0.88, dirt * 0.68);
    b = lerp(b, D.b * 0.88, dirt * 0.68);
    // Rubber laid down on the crown, where the karts actually ride the kerb.
    const rubber = smoothstep((0.62 - Math.abs(u - 0.42)) / 0.22)
      * clamp01(fbm2D(rubN.n, x / rubN.k, y / rubN.k, 3) * 1.8 - 0.85);
    const shade = lerp(1.0, 0.58, smoothstep((u - 0.78) / 0.22));
    const k = shade * lerp(1.0, 0.42, rubber * 0.75);
    o[0] = r * 255 * k; o[1] = g * 255 * k; o[2] = b * 255 * k;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const u = x / size;
    const p = paintBuf[i];
    // Road paint keeps a little gloss for years; bare concrete never had any.
    let rgh = lerp(lerp(0.86, 0.96, gritBuf[i]), 0.58, p);
    rgh = lerp(rgh, 0.97, smoothstep((u - 0.62) / 0.38) * 0.7);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });

  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 2.2)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.75,
    // What the stripes average to. TrackBuilder fades the kerb towards this
    // once a stripe is worth less than a couple of pixels, which is the only
    // way to stop a 1 m pattern strobing on a 1 px line at the horizon.
    meanColor: meanLinearColor(c),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Beach sand, and deliberately the quietest surface on the circuit.
 *
 * This tile lands either side of the racing line and covers 30-40% of a typical
 * frame, and the previous version made it the loudest thing in every one of
 * them: measured, the run-off carried 1.5-1.7x the high-frequency energy of the
 * tarmac it borders, and 41-49% of its pixels moved by more than 16/255 in a
 * single 8.3 ms step against 21-22% for the road and 1.5% for the sky. It
 * photographed as marbled walnut burl with interference fringes running to the
 * horizon. Three separate causes, all of them here:
 *
 *  - The ripples were phase-warped by ±8 whole periods. A phase warp larger
 *    than a period does not meander a wave train, it folds it back through
 *    itself, and what that draws is closed contour loops. That is burl figure,
 *    and it is the single most recognisable thing in the review captures.
 *  - Their wavelength was 39 cm on a 14 m tile. Ground is seen at the most
 *    grazing angle of any surface here, so 39 cm drops under a pixel *along*
 *    the view axis by about thirty metres while it is still several pixels
 *    across it — the exact condition that produces moire rather than blur, and
 *    one no mip level or anisotropic tap count can undo, because it is the
 *    geometry doing the undersampling and not the sampler. Ripples are now 2 m
 *    and the finest grain 16 cm, both of which the mip chain averages honestly.
 *  - The wave train did not tile. `phase` advanced by `ripples * cos(0.42)`
 *    across a tile edge — 32.87 periods, not 33 — so every 14 m seam carried a
 *    0.13-period jump. A whole number of periods per axis is the only way to
 *    say "diagonal ripples on a tiling texture" that is actually true, so the
 *    direction now *follows* from two integers rather than being asserted
 *    alongside them.
 *
 * What is left is what sand looks like at the distance you drive past it: tonal
 * drift over metres, a faint directional grain, and nothing with enough
 * contrast to compete with the circuit. The run-off is the surface you must not
 * be on; it has no business being the sharpest object in the frame.
 */
export function sand({ size = 1024, seed = 23, tint = 0xd8c08a } = {}) {
  const key = `sand_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grainN = tiling(seed, size, 12);     // ~16 cm on the 14 m tile
  const sheetN = tiling(seed + 41, size, 128);  // ~1.8 m: where the sand lies deep
  const warpN = tiling(seed + 3, size, 128);
  const duneN = tiling(seed + 77, size, 256);   // ~3.5 m
  const base = paintTint(tint);

  // The ripple wave train, as whole periods per tile axis. hypot(6, 3) = 6.71
  // periods across 14 m is a 2.09 m wavelength running 27 degrees off the tile
  // grid — off-axis enough never to look drawn to it, and tiling exactly
  // because both components are integers.
  const RX = 6, RY = 3;

  const height = new Float32Array(size * size);
  const crest = new Float32Array(size * size);
  const toneBuf = new Float32Array(size * size);
  const grainBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // A fifth of a period of wander, so the train meanders and never folds.
      const warp = (fbm2D(warpN.n, x / warpN.k, y / warpN.k, 3) - 0.5) * 0.40;
      const phase = ((x * RX + y * RY) / size + warp) * TAU;
      // Asymmetric crests: the lee face of a ripple is steeper than the stoss.
      const s = Math.sin(phase);
      const ripple = 0.5 + 0.5 * Math.sign(s) * Math.pow(Math.abs(s), 0.7);
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 2);
      const sheet = fbm2D(sheetN.n, x / sheetN.k, y / sheetN.k, 3);
      const dune = fbm2D(duneN.n, x / duneN.k, y / duneN.k, 3);
      crest[i] = ripple;
      grainBuf[i] = grain;
      // Albedo tone tracks only the metres-wide part of the field. Everything
      // the eye reads as "lighter here, darker there" is therefore a feature
      // three metres across, which survives four mip levels intact; the two
      // fine terms below are held to a few percent so that when they *do* fall
      // off the end of the chain there is nothing left to shimmer.
      toneBuf[i] = dune * 0.58 + sheet * 0.42;
      // The ripple carries most of the relief, which it can afford to now that
      // it is 2 m rather than 39 cm: at that size it is still several pixels
      // across at forty metres, so the shading it produces resolves instead of
      // sparkling. Under a 16-degree sun a run-off with no relief at all is a
      // flat ramp of colour, which is the failure on the other side of this.
      height[i] = ripple * 0.34 + grain * 0.08 + sheet * 0.26 + dune * 0.40;
    }
  }
  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Dry, wind-sorted crests are paler than the damper packed troughs.
    const l = lerp(0.90, 1.10, toneBuf[i])
      * lerp(0.962, 1.048, crest[i])
      * lerp(0.975, 1.025, grainBuf[i]);
    o[0] = base.r * l * 255;
    o[1] = base.g * l * 255;
    o[2] = base.b * l * 0.985 * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    o[0] = o[1] = o[2] = lerp(0.92, 0.99, crest[i]) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    // Cut hard from 1.5/0.7, then given a little back once the relief had moved
    // from a 39 cm ripple to a 2 m one. The old figures put a specular response
    // on every crest of a pattern the sampler could not hold, and per-pixel
    // specular on a grazing plane is where a ground surface's temporal
    // instability actually lives.
    normalMap: makeTexture(heightToNormal(height, size, 1.35)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.55,
    meanLuma: meanLinearLuma(c),
    // What this tile converges to under minification, and therefore the only
    // honest colour to fade it towards. Same fix as the kerb's and the road's.
    meanColor: meanLinearColor(c),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Dry desert dirt: wind-drifted fines over cracked, pebbled hardpan.
 *
 * Same grading idea as the sand — the wind sorts this too — but here the coarse
 * fraction is pebbles that the fines drift *around* rather than sit on, so the
 * pebbles stand proud and the cracks run between them.
 *
 * Retuned for the same reason and by the same rule as the sand above, plus one
 * fault this tile had that the sand did not: the shrinkage cracks were ridged
 * noise raised to the eighth power over a basis whose finest octave was eight
 * texels. That is a crest one or two texels wide, in a height field driven into
 * a normal map at the largest strength in this file — the identical defect
 * diagnosed on the asphalt, where nulling the normal map alone took the far
 * road from 21% of pixels swinging past 16/255 to 0.9%. Every scale here is now
 * quoted in centimetres of the 14 m tile it is drawn on, and nothing that
 * carries relief lives below about six texels.
 */
export function dirt({ size = 1024, seed = 51, tint = 0xa8703f } = {}) {
  const key = `dirt_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grainN = tiling(seed, size, 12);       // ~16 cm
  const pebbleN = tiling(seed + 9, size, 20);  // ~27 cm
  const clodN = tiling(seed + 23, size, 96);   // ~1.3 m
  const crackN = tiling(seed + 88, size, 96);
  const driftN = tiling(seed + 131, size, 224); // ~3.1 m
  const base = paintTint(tint);

  const height = new Float32Array(size * size);
  const toneBuf = new Float32Array(size * size);
  const pebbleBuf = new Float32Array(size * size);
  const crackBuf = new Float32Array(size * size);
  const driftBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 2);
      const clods = fbm2D(clodN.n, x / clodN.k, y / clodN.k, 3);
      // Pebbles: the top of the noise only, so they read as discrete stones
      // rather than as one more octave of the same lumpy field. The threshold
      // is softer than it was — a hard `*4` step on a 4-texel basis is a
      // stencil, and a stencil in a height map is a normal-map cliff.
      const pebble = clamp01((fbm2D(pebbleN.n, x / pebbleN.k, y / pebbleN.k, 2) - 0.60) * 2.2);
      // Ridged noise carves shallow shrinkage cracks between them. Two octaves
      // and a fourth power, so a crest is forty texels across instead of two.
      const ridge = 1 - Math.abs(fbm2D(crackN.n, x / crackN.k, y / crackN.k, 2) * 2 - 1);
      const crack = Math.pow(clamp01(ridge), 4) * (1 - pebble);
      // Drifted fines, banked against whatever the wind found in its way.
      const drift = fbm2D(driftN.n, x / driftN.k, y / driftN.k, 3);
      pebbleBuf[i] = pebble;
      crackBuf[i] = crack;
      driftBuf[i] = drift;
      // Tone is carried entirely by the metre-and-up scales, so the read at any
      // distance comes from features a mip chain can still hold.
      toneBuf[i] = drift * 0.56 + clods * 0.44;
      height[i] = grain * 0.06 + clods * 0.30 + pebble * 0.16 - crack * 0.10 + drift * 0.38 + 0.25;
    }
  }
  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    const l = lerp(0.90, 1.10, toneBuf[i]) * lerp(0.975, 1.025, pebbleBuf[i]);
    // Iron-rich fines are redder than the pale stone they drift over.
    const red = clamp01(driftBuf[i] * 1.2 - 0.1) * (1 - pebbleBuf[i] * 0.7);
    const stone = pebbleBuf[i] * 0.06;
    o[0] = (base.r * l * lerp(0.94, 1.07, red) + stone * 0.9) * 255;
    o[1] = (base.g * l * lerp(0.99, 1.01, red) + stone) * 255;
    o[2] = (base.b * l * lerp(1.07, 0.94, red) + stone * 1.15) * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Loose dust is the roughest thing in the scene; polished pebbles are not.
    let rgh = lerp(0.99, 0.90, pebbleBuf[i]);
    rgh = lerp(rgh, 1.0, crackBuf[i]);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 1.2)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.45,
    meanLuma: meanLinearLuma(c),
    meanColor: meanLinearColor(c),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * The last two centimetres of the ground: grit, and the stones in it.
 *
 * `sand` and `dirt` cover fourteen metres in a thousand texels, so the finest
 * thing they can hold is about 14 cm — and the previous pass proved, at length,
 * that anything finer than that in a 14 m tile is not detail but moire. Which
 * left the run-off with nothing at all between the tile's 16 cm grain and the
 * pixel, and that gap is exactly the band a 4K frame resolves and a 1080p one
 * does not. A 700x500 crop of run-off at 3840x2160 came back holding one
 * gradient and a shadow.
 *
 * So the centimetre scales get their own tile, ~1.2 m of world to 512 texels —
 * 2.3 mm each, three orders of magnitude finer than the sand's — and their own
 * retirement schedule in the shader, which is by *screen footprint* rather than
 * by distance. That distinction is the whole point: a distance threshold is a
 * statement about 1080p, and it is why every surface here previously looked
 * identical at 4K. A footprint threshold retires a feature when it stops being
 * resolvable, so the same code puts twice as much of this on a 4K screen as on
 * a 1080p one, and no more aliasing on either.
 *
 * One tile serves both the general grain and the gravel band beside the kerb,
 * sampled at two world scales, because gravel *is* the coarse fraction of the
 * same material — grading it separately would be authoring two lies where one
 * truth tiles.
 *
 * Everything is returned as a *modulation*, not as a colour: this layer has to
 * ride on whatever ground it lands on, and it has to leave that ground's mean
 * brightness — and therefore the frame's exposure, which is not ours to move —
 * exactly where it found it. The albedo channel is normalised to a mean of
 * precisely 1.0 for that reason, rather than being authored near it and hoped
 * about.
 */
export function groundDetail({ size = 512, seed = 137 } = {}) {
  const key = `grounddetail_${size}_${seed}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const gritN = tiling(seed, size, 5);        // ~1.2 cm on the 1.2 m tile
  const packN = tiling(seed + 61, size, 56);  // ~13 cm: where the surface is crusted
  const rng = makeRng(seed + 17);

  // Jittered-grid stones at ~2.7 cm centres, diameters 1.6-5.2 cm. That band is
  // chosen against the pixel, not against geology: at 4K a 3 cm stone five
  // metres away is several pixels across, which is the smallest thing on this
  // surface it is honest to draw at all.
  const cells = 44;
  const cellSize = size / cells;
  const sites = new Float32Array(cells * cells * 4);
  for (let i = 0; i < cells * cells; i++) {
    sites[i * 4] = rng();
    sites[i * 4 + 1] = rng();
    // Wide spread, and biased small: a run-off is mostly fines with stones in
    // it. An even spread reads as gravel laid by hand, which is a different and
    // much less convincing surface.
    sites[i * 4 + 2] = 0.30 + Math.pow(rng(), 1.9) * 0.65;
    sites[i * 4 + 3] = rng();
  }

  const cov = new Float32Array(size * size);
  const who = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
      let best = 0, bestId = 0.5;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = mod(cx + ox, cells), gy = mod(cy + oy, cells);
          const k = (gy * cells + gx) * 4;
          const sx = (cx + ox + sites[k]) * cellSize;
          const sy = (cy + oy + sites[k + 1]) * cellSize;
          const r = sites[k + 2] * cellSize;
          const d = Math.hypot(x - sx, y - sy);
          if (d < r) {
            // Half-buried, not resting on top: a stone in a run-off has fines
            // drifted up around it, so the profile flattens at the rim.
            const c = Math.pow(1 - smoothstep(d / r), 0.55);
            if (c > best) { best = c; bestId = sites[k + 3]; }
          }
        }
      }
      cov[y * size + x] = best;
      who[y * size + x] = bestId;
    }
  }

  const height = new Float32Array(size * size);
  const albedo = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const stoneM = new Float32Array(size * size);
  let albedoSum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const grit = fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2);
      const pack = fbm2D(packN.n, x / packN.k, y / packN.k, 3);
      const c = cov[i];
      const s = smoothstep(c);
      height[i] = c * 0.52 + grit * 0.13 + pack * 0.35;
      // Stones are a different mineral from the fines around them, so they
      // differ in colour and not only in shading — a purely shaded stone
      // disappears the moment the sun goes behind anything, which on a circuit
      // lit at 16 degrees is most of the outside of every corner.
      const stone = lerp(0.88, 1.26, Math.pow(who[i], 1.3));
      // The contact shadow packed grains cast into each other is folded in here
      // rather than kept as its own channel, so the normalisation below covers
      // it too — a separate multiply with a mean under 1.0 would have quietly
      // darkened 40% of every frame.
      const cavity = 1 - (1 - smoothstep(c * 1.7)) * 0.30 * (1 - grit * 0.5);
      const a = lerp(lerp(0.955, 1.045, grit) * lerp(0.94, 1.06, pack), stone, s) * cavity;
      albedo[i] = a;
      albedoSum += a;
      // Exposed stone is polished by weather; the fines packed between them are
      // the roughest thing on the circuit.
      rough[i] = lerp(lerp(1.0, 0.94, pack), 0.86, smoothstep(c * 1.2));
      stoneM[i] = s;
    }
  }
  // Normalised rather than centred by eye: this multiplies every off-track
  // surface in the game, and a mean of 1.02 would be a 2% exposure change on
  // 40% of the frame.
  const albedoMean = albedoSum / (size * size);

  // One texture, three jobs. Three samplers for three scalars would cost more
  // than the layer is worth, and the ground already spends four texture units
  // before this one arrives.
  const grainC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // R and G are stored as half the multiplier, so 128 is exactly 1.0 and the
    // shader's decode is one multiply with no bias to get wrong. B is the stone
    // mask, which the gravel band uses to tint only the stones.
    o[0] = clamp01(albedo[i] / albedoMean * 0.5) * 255;
    o[1] = clamp01(rough[i] * 0.5) * 255;
    o[2] = stoneM[i] * 255;
  });

  const result = {
    grainMap: makeTexture(grainC),
    // Gentle, and gentler than the tile it rides on. This is the only relief in
    // the game evaluated within a couple of metres of the camera, where a
    // normal map is at its most convincing and also at its most able to turn a
    // flat plane into a field of crawling specular. The strength that reads
    // correctly here is well under half of what looks right in a texture viewer.
    normalMap: makeTexture(heightToNormal(height, size, 1.15)),
    normalScale: 0.42,
  };
  _textureCache.set(key, result);
  return result;
}

/** Grass, viewed from a distance — clumped blades rather than a green blur. */
export function grass({ size = 1024, seed = 61, tint = 0x4e8a3c } = {}) {
  const key = `grass_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const bladeN = tiling(seed, size, 2);
  const clumpN = tiling(seed + 13, size, 16);
  const dryN = tiling(seed + 29, size, 64);
  const base = paintTint(tint);
  const height = new Float32Array(size * size);
  const clumpBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Blades are stretched along V so the mown direction reads at distance.
      const b = fbm2D(bladeN.n, x / bladeN.k, y / (bladeN.k * 2), 3);
      const c2 = fbm2D(clumpN.n, x / clumpN.k, y / clumpN.k, 4);
      clumpBuf[i] = c2;
      height[i] = b * 0.55 + c2 * 0.45;
    }
  }
  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    const l = lerp(0.58, 1.28, height[i]);
    const yellow = clamp01(fbm2D(dryN.n, x / dryN.k, y / dryN.k, 3) * 1.3 - 0.35);
    o[0] = base.r * l * lerp(1, 1.55, yellow) * 255;
    o[1] = base.g * l * lerp(1, 1.15, yellow) * 255;
    o[2] = base.b * l * lerp(1, 0.55, yellow) * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    o[0] = o[1] = o[2] = lerp(0.98, 0.78, height[y * size + x]) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 1.8)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.8,
    meanLuma: meanLinearLuma(c),
    // Unused by the three shipping tracks, but `_groundWear` fades every ground
    // surface towards this and a missing one silently falls back to a constant.
    meanColor: meanLinearColor(c),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Wind-packed snow: sastrugi over drifted powder.
 *
 * Snow is the one ground surface in this file whose form is almost entirely
 * *relief*. Fresh snow is around 0.8 linear albedo and flat to within a few
 * percent across a whole field, so the tonal tricks the sand and dirt lean on —
 * wind sorting, damp troughs, bleached crests — have almost nothing to work
 * with here. Drive albedo variation as hard as those tiles do and the result is
 * not snow, it is grey cloth. So the albedo stays inside +-5% and the height
 * field carries the read, which is also why the sastrugi are the largest
 * feature in the tile rather than a detail laid over one.
 *
 * The one colour move that is real: a trough sees less sky and more of its own
 * blue-scattered walls, so it goes *bluer* as it goes darker rather than just
 * darker. That hue shift is most of what separates snow from white sand at a
 * glance, and it costs one lerp.
 *
 * Sparkle lives in the roughness map and nowhere else. A specular glitter field
 * written into the *normal* map is exactly the one-texel-ridge defect that made
 * the asphalt and the dirt boil, and snow — bright, and viewed at a grazing
 * angle for an entire lap — is the worst possible surface to repeat it on.
 */
export function snow({ size = 1024, seed = 137, tint = 0xe6edf6 } = {}) {
  const key = `snow_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grainN = tiling(seed, size, 12);        // ~16 cm: the crystal crust
  const crustN = tiling(seed + 47, size, 64);   // ~87 cm: where the wind packed it
  const warpN = tiling(seed + 5, size, 128);
  const driftN = tiling(seed + 211, size, 224); // ~3.1 m: the drifts themselves

  const base = paintTint(tint);

  // Sastrugi, as whole periods per tile axis so the train tiles exactly — the
  // same construction as the sand's ripples and for the same reason. hypot(4,7)
  // = 8.06 periods across 14 m is a 1.74 m wavelength running 30 degrees off
  // the tile grid: coarse enough to survive four mip levels, and off-axis
  // enough never to read as drawn to the texture.
  const RX = 4, RY = 7;

  const height = new Float32Array(size * size);
  const crestBuf = new Float32Array(size * size);
  const driftBuf = new Float32Array(size * size);
  const crustBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const warp = (fbm2D(warpN.n, x / warpN.k, y / warpN.k, 3) - 0.5) * 0.45;
      const phase = ((x * RX + y * RY) / size + warp) * TAU;
      // Sastrugi are cut by erosion, not deposited: the windward face is
      // scoured to a long shallow ramp and the lee face is a short scarp. That
      // asymmetry is the difference between snow and a sine wave, so the
      // exponent runs the other way from the sand's ripples.
      const c = Math.cos(phase);
      const ridge = 0.5 + 0.5 * Math.sign(c) * Math.pow(Math.abs(c), 1.6);
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 2);
      const crust = fbm2D(crustN.n, x / crustN.k, y / crustN.k, 3);
      const drift = fbm2D(driftN.n, x / driftN.k, y / driftN.k, 4);
      crestBuf[i] = ridge;
      crustBuf[i] = crust;
      driftBuf[i] = drift;
      // Weighted towards the two coarse terms. The 16 cm grain is worth well
      // under a pixel by thirty metres and carries a twelfth of the relief, so
      // when it falls off the end of the mip chain there is nothing there to
      // shimmer.
      height[i] = ridge * 0.40 + drift * 0.38 + crust * 0.14 + grain * 0.08;
    }
  }

  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Depth in the surface, 0 at a scoured trough and 1 on a crest.
    const d = clamp01(crestBuf[i] * 0.62 + driftBuf[i] * 0.38);
    const l = lerp(0.955, 1.030, d) * lerp(0.985, 1.012, crustBuf[i]);
    // Troughs bluer, crests very slightly warm: a crest is lit by the sun and
    // a trough only by the sky, and the tile can pre-empt a little of that.
    o[0] = base.r * l * lerp(0.965, 1.005, d) * 255;
    o[1] = base.g * l * lerp(0.985, 1.002, d) * 255;
    o[2] = base.b * l * lerp(1.030, 0.998, d) * 255;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Wind-packed crust is glossy; the powder the wind has not reached is not.
    // The crystal grain rides here and only here — this is the sparkle, and in
    // the roughness map it survives minification as a smooth average instead of
    // turning into moving specular noise.
    let rgh = lerp(0.93, 0.62, smoothstep(crustBuf[i] * 1.15));
    rgh *= lerp(1.02, 0.94, crestBuf[i]);
    rgh *= lerp(1.01, 0.97, grainNoiseAt(grainN, x, y));
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });

  const result = {
    map: makeTexture(c, { srgb: true }),
    // Snow genuinely has more relief per metre than sand does, but it is also
    // the brightest ground in the game and sits under a low sun for the whole
    // lap — the two conditions that turn an honest normal map into glare. This
    // is a little under the sand's, deliberately.
    normalMap: makeTexture(heightToNormal(height, size, 1.20)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.50,
    meanLuma: meanLinearLuma(c),
    meanColor: meanLinearColor(c),
  };
  _textureCache.set(key, result);
  return result;
}

/** One fbm sample of a `tiling` basis, for callers that need it a second time. */
function grainNoiseAt(t, x, y) {
  return fbm2D(t.n, x / t.k, y / t.k, 2);
}

/**
 * Race ice: refrozen plates over swept, gritted hardpack.
 *
 * This is a *road* surface and returns the same shape the asphalt does, so it
 * runs through the identical road-space wear pass — patches, screed joints, the
 * racing line, the bleached last metre before the kerb. All of that reads
 * correctly on ice and one part of it reads better: the polished core of the
 * racing line is literally true here, because that is the strip the field has
 * swept clean and burnished for three laps.
 *
 * Ice separates from the snow beside it by *value*, not by hue. The run-off is
 * near 0.8 linear albedo; this tile sits around 0.20, which is the whole reason
 * a driver can see where the circuit goes. A pale ice road on a white basin is
 * the same mistake as a dark road under a 16-degree sun, in the other
 * direction, and it is not recoverable by exposure because exposure moves both.
 *
 * Relief is nearly nothing, and that is not laziness: ice is flat, and every
 * bump written here would be resolved by the specular lobe of the glossiest
 * surface in the game. The roughness map does the work instead — polished
 * plates against frosted rime is what says "ice" long before any normal does.
 */
export function ice({ size = 1024, seed = 19, tint = 0x8fa3b5 } = {}) {
  const key = `ice_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  // Scales in texels of the 6 m road tile: ~3.5 cm grit, ~23 cm sweep streak,
  // ~56 cm fracture cells, ~75 cm refrozen plates, ~1.5 m rime bloom.
  const gritN = tiling(seed, size, 6);
  const sweepN = tiling(seed + 73, size, 40);
  const fracN = tiling(seed + 157, size, 96);
  const plateN = tiling(seed + 229, size, 128);
  const rimeN = tiling(seed + 331, size, 256);

  const base = paintTint(tint);

  const height = new Float32Array(size * size);
  const plateBuf = new Float32Array(size * size);
  const rimeBuf = new Float32Array(size * size);
  const fracBuf = new Float32Array(size * size);
  const gritBuf = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const plate = fbm2D(plateN.n, x / plateN.k, y / plateN.k, 3);
      const rime = fbm2D(rimeN.n, x / rimeN.k, y / rimeN.k, 3);
      const grit = fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2);
      // Fractures: a ridged basis, but broad and taken to a low power. The
      // asphalt's crack field was ridged noise to the ninth, which leaves
      // crests one or two texels wide — a normal spike no mip chain and no
      // anisotropy can average away, and measurably the whole of that
      // surface's temporal instability. A fissure in ice is a millimetre of
      // relief and centimetres of white; it belongs in albedo, not in height.
      const fr = fbm2D(fracN.n, x / fracN.k, y / fracN.k, 4);
      const frac = Math.pow(1 - Math.abs(fr * 2 - 1), 3.0);
      // The sweep: the one thing on this tile with a direction. Stretched
      // eight to one along the direction of travel, because a road surface
      // whose grain runs across it reads as a slab rather than as something
      // that has been driven on.
      const sweep = fbm2D(sweepN.n, x / sweepN.k, y / (sweepN.k * 8), 3);
      plateBuf[i] = plate;
      rimeBuf[i] = rime;
      fracBuf[i] = frac;
      gritBuf[i] = grit;
      // A fifth of the relief the asphalt carries, and all of it at 20 cm and
      // above.
      height[i] = plate * 0.52 + sweep * 0.30 + rime * 0.18;
    }
  }

  const mapC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Clear ice is dark because you are looking *through* it at the packed
    // ground below; rime is opaque and near-white. That is the tile's contrast,
    // and it is a depth cue rather than a paint job.
    const clear = clamp01(plateBuf[i] * 1.15 - 0.10);
    const bloom = clamp01(rimeBuf[i] * 1.35 - 0.30);
    let l = lerp(0.70, 0.98, clear);
    l = lerp(l, 1.34, bloom * 0.50);
    l *= lerp(0.97, 1.03, gritBuf[i]);
    // Fractures are shattered ice: white, and the brightest thing in the tile.
    // Held down from 2.05 — measured, the highlights were pulling the tile's
    // mean up far enough that the far road, which fades towards that mean,
    // converged on the snow beside it.
    l = lerp(l, 1.55, fracBuf[i] * 0.38);
    // Traction grit, in albedo only. Dark specks are what stops a 20% surface
    // reading as wet tarmac, and at 3.5 cm they must never touch the height.
    const grit = clamp01(gritBuf[i] * 1.9 - 1.05);
    l *= lerp(1.0, 0.58, grit);
    // Clear ice is blue for the same reason deep water is; frosted ice is not.
    const blue = clear * (1 - bloom * 0.7);
    o[0] = base.r * l * lerp(1.00, 0.92, blue) * 255;
    o[1] = base.g * l * lerp(1.00, 0.98, blue) * 255;
    o[2] = base.b * l * lerp(1.00, 1.10, blue) * 255;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // The whole signature of the surface: a polished plate against chalky
    // rime, with a steep ramp between them because nothing in the middle reads
    // as ice.
    //
    // The polished floor was 0.11 — skating-rink glass — and that is what
    // broke the circuit's readability. On the half of the lap that faces the
    // sun, a near-mirror road returns the sky *and* the disc on top of a
    // mid-grey albedo, and the driving surface measured 0.021 *brighter* than
    // the snow beside it against -0.09 to -0.21 on the other three circuits.
    // Race ice is swept, gritted and scored by blades; it is not a mirror. At
    // 0.24 this is still by some way the glossiest driving surface in the game
    // — the asphalt tile runs 0.76 to 0.99 — and it no longer blows out.
    const clear = clamp01(plateBuf[i] * 1.15 - 0.10);
    let rgh = lerp(0.55, 0.24, smoothstep(clear));
    rgh = lerp(rgh, 0.88, clamp01(rimeBuf[i] * 1.35 - 0.30));
    rgh = lerp(rgh, 0.93, fracBuf[i] * 0.7);
    rgh = lerp(rgh, 0.84, clamp01(gritBuf[i] * 1.9 - 1.05));
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });

  const result = {
    map: makeTexture(mapC, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 0.85)),
    roughnessMap: makeTexture(roughC),
    // A third of the asphalt's. On the glossiest driving surface in the game,
    // normal detail is not read as texture — it is read as a moving highlight.
    normalScale: 0.22,
    meanLuma: meanLinearLuma(mapC),
    meanColor: meanLinearColor(mapC),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * A tower block's facade at night: a grid of windows, most of them dark.
 *
 * Returns a second map for the lit ones. Emissive is the only way a building
 * a kilometre away can be *seen* at night — the key is a moon and the
 * environment probe is a night sky, so nothing out there receives enough light
 * to register, and a skyline lit conventionally is a black rectangle against a
 * dark sky. The windows have to be the light source.
 *
 * The lit fraction is low on purpose. A tower with every window burning reads
 * as a lightbox with a grid drawn on it; what says "building" is the *pattern*
 * of which windows are on — clusters where a floor is still working, columns
 * of dark where the stairwells and lift cores are, and whole dead floors.
 * Those three features are the entire design here.
 */
export function cityWindows({ size = 512, seed = 61, cols = 10, rows = 20, tint = 0x0d1017 } = {}) {
  const key = `citywin_${size}_${seed}_${cols}_${rows}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const rng = makeRng(seed);
  const base = paintTint(tint);

  // Which windows are lit, decided once so the albedo and the emissive map
  // cannot disagree about it.
  const lit = new Float32Array(cols * rows);
  const hue = new Float32Array(cols * rows);
  // Service cores: two or three columns that are dark all the way up, because
  // a lift shaft has no windows. This is the single most building-like thing
  // in the tile and it costs one array.
  const core = new Set();
  for (let k = 0, n = 2 + Math.floor(rng() * 2); k < n; k++) core.add(Math.floor(rng() * cols));
  // Floors that have gone home.
  const dark = new Set();
  for (let k = 0, n = Math.floor(rows * 0.30); k < n; k++) dark.add(Math.floor(rng() * rows));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (core.has(c) || dark.has(r)) { lit[i] = 0; continue; }
      // Clustered along a floor rather than sprinkled: offices are lit by the
      // room, and a room is several windows wide.
      const runBias = 0.5 + 0.5 * Math.sin(r * 2.7 + c * 0.9 + seed);
      lit[i] = rng() < 0.16 + 0.26 * runBias ? 1 : 0;
      // Mostly cool fluorescent, some warm. Two populations, not a gradient —
      // a building lit in a continuum of colour temperatures looks like a
      // gradient map, which is exactly what it would be.
      hue[i] = rng() < 0.30 ? 1 : 0;
    }
  }

  const cellW = size / cols, cellH = size / rows;
  // The mullion, in texels. Kept at least two wide: a one-texel dark line
  // between windows is the same sub-pixel defect the road tiles were rebuilt
  // to remove, and a facade is viewed at a grazing angle from a kilometre.
  const mull = Math.max(2, Math.round(Math.min(cellW, cellH) * 0.18));

  const inWindow = (x, y) => {
    const c = Math.floor(x / cellW), r = Math.floor(y / cellH);
    const fx = x - c * cellW, fy = y - r * cellH;
    if (fx < mull || fy < mull || fx > cellW - mull || fy > cellH - mull) return -1;
    return r * cols + c;
  };

  const mapC = paint(size, (x, y, o) => {
    const i = inWindow(x, y);
    if (i < 0) {
      // Concrete between the glazing, a shade above the glass so the grid
      // still reads on the unlit faces the moon does catch.
      o[0] = base.r * 1.55 * 255; o[1] = base.g * 1.5 * 255; o[2] = base.b * 1.45 * 255;
      return;
    }
    if (lit[i]) {
      const warm = hue[i] === 1;
      o[0] = (warm ? 1.00 : 0.86) * 255;
      o[1] = (warm ? 0.86 : 0.94) * 255;
      o[2] = (warm ? 0.66 : 1.00) * 255;
      return;
    }
    o[0] = base.r * 255; o[1] = base.g * 255; o[2] = base.b * 255;
  });

  const emC = paint(size, (x, y, o) => {
    const i = inWindow(x, y);
    if (i < 0 || !lit[i]) { o[0] = o[1] = o[2] = 0; return; }
    const warm = hue[i] === 1;
    // Not uniform: a window is brightest where the fitting is and falls off
    // towards the frame, and that variation is what stops a lit facade
    // reading as a punched card.
    const c = Math.floor(x / cellW), r = Math.floor(y / cellH);
    const fy = (y - r * cellH) / cellH;
    const k = lerp(0.72, 1.0, 1 - Math.abs(fy - 0.38) * 1.6) * lerp(0.75, 1.0, ((c * 7 + r * 13) % 11) / 10);
    o[0] = clamp01((warm ? 1.00 : 0.80) * k) * 255;
    o[1] = clamp01((warm ? 0.82 : 0.90) * k) * 255;
    o[2] = clamp01((warm ? 0.58 : 1.00) * k) * 255;
  });

  const result = {
    map: makeTexture(mapC, { srgb: true }),
    emissiveMap: makeTexture(emC, { srgb: true }),
    meanLuma: meanLinearLuma(mapC),
    meanColor: meanLinearColor(mapC),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Boost strip: forward-pointing chevrons painted onto the tarmac.
 *
 * The shape is the whole point. A pad has to answer two questions in the
 * fraction of a second it is in peripheral vision at 110 km/h — "will this make
 * me faster" and "which way does it want me to go" — and a chevron is the only
 * mark that answers the second one on its own. A uniform slab answers neither,
 * which is why it read as a missing texture.
 *
 * The tile is one chevron *pitch* deep and `aspect` pitches wide, so the arms
 * can be reasoned about in metres of road: at aspect 2 the phase shift from the
 * centreline to either edge is exactly one full period, which both puts the
 * arms at 45 degrees and makes each arm meet the next chevron's arm at the pad
 * edge — the continuous zig-zag that reads as a strip rather than as stickers.
 *
 * Brightness is deliberately *not* uniform: only the arms carry emissive, and
 * the plate they sit on is dark paint. Lighting the whole pad is what made it
 * the brightest object in the frame, brighter than the sky and brighter than
 * the player's own kart. Confining the glow to 40% of the area buys back all of
 * that mean brightness and spends it on local contrast, where it does the
 * reading work.
 *
 * The arms *taper*, and that is what turns a zig-zag into an arrow. With bands
 * of constant thickness the apex is no wider than the tips, so from a chase
 * camera — where perspective flattens the arms towards the horizontal anyway —
 * the pad reads as a set of slightly bent stripes and the direction has to be
 * inferred. Widening the band at the centreline and thinning it towards the
 * pad edge puts the visual weight on the point, which is the one part of a
 * chevron that carries the meaning.
 *
 * `plateAlpha` keeps the bed and the arms on separate coverage budgets. The
 * arms are always solid; the bed is thin paint that has been driven over, and
 * on Rainbow Skyway it has to be thin enough for the road to glow through —
 * an opaque bed there is a black hole punched in the ribbon, which is a worse
 * failure than the flat cyan slab this rework replaced.
 */
export function boostPad({ size = 512, aspect = 2.0, plate = 0x2a5c78, glow = 0x2ecdff, wear = 1, plateAlpha = 0.85 } = {}) {
  const key = `boost_${size}_${aspect}_${plate}_${glow}_${wear}_${plateAlpha}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  const wearN = tiling(211, size, 6);    // tyre scuffing, over centimetres
  const gritN = tiling(233, size, 5);    // road grit trodden into the film
  const filmN = tiling(251, size, 16);   // how thick the machine laid it, over metres
  const P = paintTint(plate), G = paintTint(glow);

  // Arm thickness at the apex, as a fraction of the pitch. Much above 0.45 and
  // the gaps close up into a solid slab again — the gap is what makes it an
  // arrow — and the taper below only ever takes thickness away.
  const ARM = 0.44;
  // How much of that thickness survives at the pad edge. Below about a half the
  // arms break up before they reach the feathered border and the chevron stops
  // reading as one continuous mark.
  const TIP = 0.56;
  // Softening the band edges by a couple of texels is not cosmetic: this
  // surface is viewed at the most grazing angle of anything on the circuit, and
  // a hard step is exactly the high-frequency energy the mip chain cannot hold.
  const SOFT = 2.5 / size;

  const arm = new Float32Array(size * size);
  const lead = new Float32Array(size * size);
  const halo = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const scuff = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) / size;
      // CanvasTexture flips Y, so canvas row 0 is sampled at v = 1. Undoing it
      // here is what keeps the arrows pointing down the road instead of back
      // up it — the one sign error in this function that a still cannot show.
      const v = 1 - (y + 0.5) / size;
      const wx = (u - 0.5) * aspect;    // half-widths, in pitches
      // `+|wx|` puts the apex at the centre and the arms trailing behind it.
      // `-|wx|` draws the same chevron pointing backwards.
      const phase = mod(v + Math.abs(wx), 1);
      // Thickness falls off towards the tips. The band's *centre* stays put so
      // the arms still meet the next chevron's cleanly at the pad edge; only
      // the weight moves, onto the apex.
      const taper = lerp(1.0, TIP, clamp01(Math.abs(wx) / (aspect * 0.5)));
      const armHalf = ARM * 0.5 * taper;
      // Wrapped signed distance to the arm's centre, so both edges of the band
      // soften and the band crossing the tile seam does not tear.
      let dp = phase - ARM * 0.5;
      dp -= Math.round(dp);
      const a = 1 - smoothstep((Math.abs(dp) - armHalf) / SOFT);
      // A narrow bloom rim just outside each arm — real light on wet-look paint
      // does not stop dead at the edge of the paint. It has to die out well
      // before the midpoint between two arms: a wide falloff here does not read
      // as a rim at all, it silently relights the entire plate, which is the
      // uniform glow this whole rework exists to remove.
      const h = 1 - smoothstep((Math.abs(dp) - armHalf * 1.2) / 0.075);

      // Karts cross a boost pad at full throttle and nothing else on the
      // circuit gets scrubbed as hard, so the film is thin down the middle.
      // `wear` is how much of a *road* this pad is painted on. Tarmac gets the
      // full weathering story; Rainbow Skyway's strip is an energy plate on a
      // neon ribbon with no traffic film to lose, and — more practically — a
      // part-transparent plate simply disappears over an emissive road.
      const line = 1 - smoothstep(Math.abs(wx) / 0.55);
      const sc = wear * clamp01(line * lerp(0.35, 1.0, fbm2D(wearN.n, x / wearN.k, y / wearN.k, 4)) * 1.15 - 0.18);

      arm[i] = a * lerp(1.0, 0.55, sc);
      // Leading half of each arm brighter than the trailing half. It is a small
      // thing, but it is the only cue that survives a single frozen frame.
      lead[i] = clamp01(dp / armHalf) * a;
      halo[i] = h;
      scuff[i] = sc;

      // The plate stops short of the pad edge and feathers out over the last
      // ~7% of the half-width, so the strip is a decal painted on the road
      // rather than a quad hovering above it with a polygon silhouette.
      const edge = 1 - smoothstep((Math.abs(wx) / (aspect * 0.5) - 0.86) / 0.14);
      // Feathering with a clean ramp reads as an airbrush; overspray and
      // flaking at the border is what a real painted edge looks like.
      // Flaking belongs at the border, where the paint has an edge to lift
      // from. Spread evenly over the whole pad — as it was — it just punches
      // 15% of the bed out at random and the plate stops existing: over dark
      // tarmac what was left read as glowing stripes floating on the road,
      // with nothing painted underneath them.
      const flake = smoothstep((fbm2D(wearN.n, x / wearN.k + 31, y / wearN.k, 3) - 0.26) * 3.2);
      const border = smoothstep((Math.abs(wx) / (aspect * 0.5) - 0.45) / 0.45);
      const patchy = lerp(1, lerp(1.0, lerp(0.42, 1.0, flake), border)
        * lerp(0.93, 1.0, fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2)), wear);
      // Arms are solid paint; the bed under them is thin enough to be a tint on
      // whatever it is painted on rather than a lid over it.
      alpha[i] = clamp01(edge * patchy * lerp(plateAlpha, 1.0, a));

      // Two coats of thermoplastic, so the arms stand proudest and the scuffed
      // centreline has been worn back down towards the tarmac.
      height[i] = (0.30 + a * 0.55) * (1 - sc * 0.6)
        + fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2) * 0.15;
    }
  }

  const mapC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const film = lerp(0.88, 1.06, fbm2D(filmN.n, x / filmN.k, y / filmN.k, 3));
    // Where the arms have been scrubbed thin the tarmac beneath starts to show
    // through as grey, not as a paler blue.
    const grey = scuff[i] * 0.5;
    const a = arm[i];
    let r = lerp(P.r, G.r, a) * film;
    let g = lerp(P.g, G.g, a) * film;
    let b = lerp(P.b, G.b, a) * film;
    r = lerp(r, 0.34, grey); g = lerp(g, 0.33, grey); b = lerp(b, 0.34, grey);
    o[0] = r * 255; o[1] = g * 255; o[2] = b * 255;
  });

  // Emissive rides only on the arms. Kept well under 1.0 here so the material's
  // emissiveIntensity is the single place the pad's brightness is set.
  const emisC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const e = clamp01(arm[i] * (0.60 + 0.40 * lead[i]) + halo[i] * 0.22) * (1 - scuff[i] * 0.45);
    o[0] = G.r * e * 255; o[1] = G.g * e * 255; o[2] = G.b * e * 255;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Fresh thermoplastic holds a sheen; scuffed film is as matt as the road.
    let rgh = lerp(0.62, 0.38, arm[y * size + x]);
    rgh = lerp(rgh, 0.92, scuff[i]);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });

  const result = {
    map: makeTexture(mapC, { srgb: true }),
    emissiveMap: makeTexture(emisC, { srgb: true }),
    alphaMap: makeTexture(grayCanvas(size, alpha)),
    normalMap: makeTexture(heightToNormal(height, size, 1.5)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.5,
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * The pool of light a boost strip throws onto the tarmac around it.
 *
 * Nothing in this renderer will do this for us — the pad's emissive lights
 * only the pad's own pixels — and its absence is most of why the strip read as
 * a decal *floating* rather than one lying on the road. An additive quad a
 * little larger than the pad, with no hard boundary anywhere in it, is the
 * cheapest honest stand-in for the bounce.
 */
export function boostSpill({ size = 256, core = 0.65, hollow = 0.30 } = {}) {
  const key = `boostspill_${size}_${core}_${hollow}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const n = tiling(307, size, 8);
  const c = paint(size, (x, y, o) => {
    const u = (x + 0.5) / size * 2 - 1;
    const v = (y + 0.5) / size * 2 - 1;
    // A radial blob puts its peak in the middle of the pad, where the pad
    // itself covers it, and leaves nothing at the flanks where the whole point
    // of the effect is. So: a plateau over the pad's own footprint — `core` is
    // where the pad's edge lands in this quad — falling to nothing by the
    // border. Chebyshev rather than Euclidean distance, because a boost strip
    // is a rectangle and its glow has to be one too.
    const d = Math.max(Math.abs(u), Math.abs(v));
    let g = Math.pow(1 - smoothstep((d - core) / (1 - core)), 1.7);
    // Hollowed out over the pad's own footprint. The pad is part-transparent by
    // design, so a full-strength plateau underneath it added blue to the gaps
    // between the chevrons as well as to the road around them — it was washing
    // out the very contrast it exists to support, and at a distance the whole
    // thing read as a patch of haze rather than as light on tarmac. Light does
    // land between the arms, so this is a floor rather than a hole.
    g *= lerp(hollow, 1.0, smoothstep(d / core));
    // Rounded corners, so the pool never shows a rectangle's vertex.
    g *= 1 - smoothstep((Math.hypot(Math.max(0, Math.abs(u) - core), Math.max(0, Math.abs(v) - core)) - (1 - core) * 0.55) / ((1 - core) * 0.6));
    // A perfectly smooth airbrush is the tell. Break it on the same scale the
    // tarmac's binder mottles at, so the pool sits in the road's own texture.
    g *= lerp(0.78, 1.0, fbm2D(n.n, x / n.k, y / n.k, 3));
    o[0] = o[1] = o[2] = clamp01(g) * 255;
  });
  // The falloff is returned as an *alpha* map, not a colour map, and the tint
  // comes from the material. That is not a stylistic choice: the scene runs
  // exponential fog, and three fogs an additive pass by mixing its RGB towards
  // the fog colour. With a colour falloff the quad's alpha is 1 everywhere, so
  // a distant pad would add a full fog-coloured *rectangle* to the frame — the
  // hard edge this effect exists to remove, reappearing at range and getting
  // worse as fog density goes up. Alpha scales the fog contribution too, so the
  // artifact cannot form. It also has to live in its own opaque texture rather
  // than in the map's alpha channel, because canvases store premultiplied
  // alpha (the same trap the lane markings hit).
  const alphaMap = makeTexture(c, { srgb: false });
  // The quad maps this once, so repeat wrapping would only ever let the
  // opposite edge bleed in under bilinear filtering.
  alphaMap.wrapS = alphaMap.wrapT = THREE.ClampToEdgeWrapping;
  alphaMap.needsUpdate = true;
  const result = { alphaMap };
  _textureCache.set(key, result);
  return result;
}

/**
 * Checkered start/finish, as paint with a history rather than a chequerboard.
 *
 * The old version was two constants and a faint grime multiply, which is why it
 * read as a texture laid on a quad instead of as the most abused three metres
 * of paint on the circuit. Everything about a real start line is a consequence
 * of what happens there: a full grid launches off it every race, so the film is
 * scrubbed thin and rubbered black in the wheel tracks, it chips at the square
 * joints first because that is where two paint passes meet, and the white has
 * long since gone to bone rather than staying at 236.
 *
 * The square edges are softened by a texel or two on purpose. A hard step is
 * free aliasing energy, and this surface is seen at exactly the grazing angle
 * where the mip chain cannot hold one still.
 */
export function checker({ size = 512, squares = 8, edgeLine = 0 } = {}) {
  const key = `checker_${size}_${squares}_${edgeLine}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grimeN = tiling(5, size, 8);
  const chipN = tiling(63, size, 4);
  const rubN = tiling(87, size, 16);
  const gritN = tiling(109, size, 2);
  const WHITE = paintTint(0xd9d5c8), DARK = paintTint(0x24242a);
  const ROAD = paintTint(0x4a4a52);

  const paintBuf = new Float32Array(size * size);
  const rubBuf = new Float32Array(size * size);
  const leadBuf = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const SOFT = 1.6 / size * squares;   // in square units

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) / size * squares, v = (y + 0.5) / size * squares;
      // A chequered band with nothing bounding it reads as a patch of pattern.
      // What makes it read as a *line* is the solid timing stripe down each
      // edge — what every circuit actually paints, and what the eye still finds
      // from two hundred metres back when the squares themselves are two
      // pixels. Both edges, not one: `CanvasTexture` flips V, so "the leading
      // edge" is a coin toss from inside this function, and a symmetric band
      // cannot lose that toss.
      const vEdge = Math.min(y + 0.5, size - 0.5 - y) / size;
      const lead = edgeLine > 0
        ? 1 - smoothstep((vEdge - edgeLine * 0.72) / Math.max(edgeLine * 0.28, 1e-4)) : 0;
      leadBuf[i] = lead;
      // Distance to the nearest square joint, in square units. Paint lifts at
      // those seams first — they are where one pass butted against the next.
      const ju = Math.abs(mod(u, 1) - 0.5), jv = Math.abs(mod(v, 1) - 0.5);
      const joint = Math.min(0.5 - ju, 0.5 - jv);
      // The stripe is the same film laid in the same pass, so it chips and
      // rubbers exactly like the squares — it simply has no joints in it.
      let p = Math.max(smoothstep(joint / 0.09), lead);
      p *= 1 - clamp01((fbm2D(chipN.n, x / chipN.k, y / chipN.k, 3) - 0.66) * 4.5);
      // Wheel tracks: a whole grid spins up from a standstill across this
      // strip, which scrubs the film and lays rubber into what is left.
      const rub = clamp01(fbm2D(rubN.n, x / rubN.k, y / (rubN.k * 3), 3) * 1.7 - 0.72);
      p = clamp01(p * lerp(1.0, 0.62, rub));
      paintBuf[i] = p;
      rubBuf[i] = rub;
      height[i] = p * 0.62 + fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2) * 0.2 + 0.18;
      // Coverage, so worn paint exposes the tarmac underneath rather than
      // turning into a paler shade of paint.
      alpha[i] = clamp01(lerp(0.30, 1.0, p) * lerp(0.88, 1.0, fbm2D(gritN.n, x / gritN.k + 7, y / gritN.k, 2)));
    }
  }

  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    const cx = Math.floor((x / size) * squares), cy = Math.floor((y / size) * squares);
    // Antialias the square boundary itself, not just its wear.
    const u = (x + 0.5) / size * squares, v = (y + 0.5) / size * squares;
    const fu = smoothstep((0.5 - Math.abs(mod(u, 1) - 0.5)) / SOFT);
    const fv = smoothstep((0.5 - Math.abs(mod(v, 1) - 0.5)) / SOFT);
    const lead = leadBuf[i];
    const col = ((cx + cy) % 2 === 0 || lead > 0.5) ? WHITE : DARK;
    const grime = lerp(0.74, 1.02, fbm2D(grimeN.n, x / grimeN.k, y / grimeN.k, 3));
    const k = grime * lerp(lerp(0.82, 1.0, Math.min(fu, fv)), 1.0, lead) * lerp(1.0, 0.55, rubBuf[i]);
    // Under the paint is road, not black: the RGB has to stay plausible where
    // coverage is low, because a canvas hands the sampler premultiplied bytes.
    o[0] = lerp(ROAD.r, col.r * k, paintBuf[i]) * 255;
    o[1] = lerp(ROAD.g, col.g * k, paintBuf[i]) * 255;
    o[2] = lerp(ROAD.b, col.b * k, paintBuf[i]) * 255;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Fresh film keeps a sheen, rubber is dead matt, bare road is between.
    let rgh = lerp(0.88, 0.46, paintBuf[i]);
    rgh = lerp(rgh, 0.97, rubBuf[i]);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });

  const result = {
    map: makeTexture(c, { srgb: true }),
    alphaMap: makeTexture(grayCanvas(size, alpha)),
    normalMap: makeTexture(heightToNormal(height, size, 1.5)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.5,
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * A numbered starting box: a heavy painted outline round a sealed panel, a
 * staging bar across the front, the grid position painted large behind it, and
 * the rubber a standing start lays down over the lot.
 *
 * The opening frame of a kart racer is the one the whole game is judged by, and
 * a start grid is normally the most graphic thing on the circuit. The previous
 * version was numerically present and visually absent: 1.41% of the t=0 frame,
 * 29,283 pixels, a maximum channel delta of 111 and only 5,058 pixels past
 * 64/255. A reviewer could not find it by eye and had to hide it and re-shoot
 * to prove it was there. The reason is in the shape of those numbers rather
 * than in their size — it was thin white strokes, in the same white, at the
 * same weight and in the same material as the lane markings running through it,
 * so there was nothing for the eye to separate. Three things fix that, and all
 * three are needed:
 *
 *  - *Value.* Every white stroke is backed on its inner side by a dark keyline.
 *    A 12 cm line on tarmac is a 60-luma step; the same line with rubber packed
 *    against it is a 200-luma one, and local contrast is what the eye finds, not
 *    absolute brightness.
 *  - *Weight.* The strokes are twice what they were and the bar is nearly two
 *    thirds of a metre. A grid is painted heavier than a lane marking on every
 *    circuit on earth, for the same reason it is painted at all.
 *  - *Material.* A box is a filled, sealed panel with a number on it, not four
 *    strokes. The interior carries its own coverage, so the mark reads as an
 *    object at any distance where the strokes themselves have gone.
 *
 * The number is what makes it unmistakable rather than merely visible, and it
 * is the reason this returns an *atlas* — one row of `slots` cells, one per grid
 * position, so twelve boxes are still one texture, one material and one draw
 * call. A row rather than a grid because every cell's left and right edges are
 * the same white side line: the one layout in which mip bleeding between
 * neighbours is guaranteed to be invisible.
 *
 * `barW` and `lineW` are fractions of a cell and the caller sets them from real
 * metres; `aspect` is the box's length over its width, and it is what keeps a
 * numeral square in the world on a cell that is not.
 */
export function gridBox({
  size = 256, slots = 12, lineW = 0.05, barW = 0.10, keyW = 0.030, aspect = 1.586, numH = 0.34,
} = {}) {
  const key = `gridbox_${size}_${slots}_${lineW}_${barW}_${keyW}_${aspect}_${numH}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const W = size * slots, H = size;
  const chipN = tiling(29, size, 6);
  const rubN = tiling(47, size, 24);
  const gritN = tiling(83, size, 3);
  const WHITE = paintTint(0xe8e3d2), ROAD = paintTint(0x4a4a52);
  const KEY = paintTint(0x1a1a1e);
  const SOFT = 2.0 / size;

  // The numerals, rendered once into their own canvas and read back as two
  // coverage fields: the glyph, and the glyph dilated by the keyline width.
  // Stroking and filling in separate channels is the cheapest exact dilation
  // there is, and an exact one matters — a halo computed from a blur would
  // thin at the corners of a 1 and pool inside an 8.
  const numC = canvas(W, H);
  const g = numC.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineCap = 'round';
  // Usable width between the two side lines, less a margin, in cell fractions.
  const inner = (1 - 2 * (lineW + keyW)) * 0.90;
  for (let i = 0; i < slots; i++) {
    const txt = String(i + 1);
    let px = numH * size;
    g.font = `bold ${Math.round(px)}px Helvetica, Arial, sans-serif`;
    // A two-digit number is nearly twice as wide as a one-digit number and the
    // box does not get wider, so the size follows from what fits rather than
    // from a constant that is right for "1" and wrong for "12".
    const wide = g.measureText(txt).width * aspect;
    if (wide > inner * size) {
      px *= (inner * size) / wide;
      g.font = `bold ${Math.round(px)}px Helvetica, Arial, sans-serif`;
    }
    // Centred a fifth of the way up the box: behind where a kart's rear axle
    // stands, which is the only part of a grid box that is not under a kart
    // when the grid is full — and the part a camera behind the grid sees most
    // of. `CanvasTexture` flips V, so the number is drawn upright here and
    // arrives upright to a driver looking down the road.
    const cx = i * size + size * 0.5;
    const cy = (1 - 0.205) * size;
    g.save();
    g.translate(cx, cy);
    // Two transforms in one, and the second is the only asymmetric mark this
    // file has ever drawn, so it is the first time either has mattered.
    //
    // The stretch: a cell is square in texels and a grid box is not in metres,
    // so a glyph drawn round comes out elongated down the road by exactly the
    // box's aspect ratio unless it is pre-squashed by it.
    //
    // The mirror: the circuit's own lateral axis runs to the *left* of a
    // forward-facing camera. Measured, by projecting one box's corners at t=0 —
    // u = 0 lands at NDC x = +0.012 and u = 1 at -0.086, while v = 0 is 26.07 m
    // from the camera and v = 1 is 30.77 m. So V is exactly what `flipY` and the
    // comment above claim, and U is reversed, and every previous surface here
    // was symmetric across it and could not have told anyone.
    g.scale(-aspect, 1);
    g.strokeStyle = '#ff0000';
    g.fillStyle = '#ff0000';
    g.lineWidth = (keyW * size * 2) / aspect;
    g.strokeText(txt, 0, 0);
    g.fillText(txt, 0, 0);
    // Additive, so the fill in green does not erase the dilation in red.
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = '#00ff00';
    g.fillText(txt, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.restore();
  }
  const numData = g.getImageData(0, 0, W, H).data;

  const alpha = new Float32Array(W * H);
  const paintBuf = new Float32Array(W * H);
  const keyBuf = new Float32Array(W * H);
  const rubBuf = new Float32Array(W * H);
  const height = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const cx = x % size;
      const u = (cx + 0.5) / size;
      // `CanvasTexture` flips V, so undoing it here is what puts the staging
      // bar at the end of the box the kart's nose is pointing at rather than
      // behind its gearbox — the one sign error in this function that a still
      // frame cannot show. Same trap, same fix, as `boostPad`.
      const v = 1 - (y + 0.5) / H;

      // Side lines, running the full length into the bar: with a filled panel
      // between them the corner reads as one mark, and stopping them short only
      // ever left a notch.
      const uEdge = Math.min(u, 1 - u);
      let p = 1 - smoothstep((uEdge - lineW) / SOFT);
      // The staging bar across the front: thicker than the sides, because it is
      // the mark a driver actually lines the front axle up against.
      p = Math.max(p, smoothstep((v - (1 - barW)) / SOFT));
      // The number, at its own coverage.
      const numFill = numData[i * 4 + 1] / 255;
      const numOuter = numData[i * 4] / 255;
      p = Math.max(p, numFill);

      // The keyline: rubber and grime packed against the *inside* of every
      // stroke, which is where it collects and — unlike an outline drawn
      // outside the box — is somewhere this texture actually reaches.
      let kk = Math.max(
        (1 - smoothstep((uEdge - lineW - keyW) / SOFT)),
        smoothstep((v - (1 - barW - keyW)) / SOFT),
        numOuter,
      );
      kk = clamp01(kk - p);

      // Paint chips at the ends of a stroke and wherever the roller lifted.
      // Sparingly: a 16 cm line broken every 7 cm is not a worn line, it is a
      // dashed one, and a dashed grid box says something else entirely.
      p *= 1 - clamp01((fbm2D(chipN.n, cx / chipN.k, y / chipN.k, 3) - 0.70) * 2.4);
      // Two black tyre tracks running *forward* out of the box. A standing
      // start is the most violent thing that happens to this four metres of
      // road all year, and it is the only reason a grid box ever looks used —
      // the marks begin under the driven axle and leave over the bar.
      const track = Math.max(
        1 - smoothstep((Math.abs(u - 0.30) - 0.055) / 0.05),
        1 - smoothstep((Math.abs(u - 0.70) - 0.055) / 0.05),
      );
      const rub = clamp01(track * smoothstep((v - 0.42) / 0.28)
        * lerp(0.45, 1.0, fbm2D(rubN.n, cx / rubN.k, y / (rubN.k * 3), 3)));
      rubBuf[i] = rub;
      p = clamp01(p * lerp(1.0, 0.66, rub));
      paintBuf[i] = p;
      keyBuf[i] = kk;
      const grit = fbm2D(gritN.n, cx / gritN.k, y / gritN.k, 2);
      // Coverage is paint, keyline, rubber *or* the sealed panel between them.
      // The panel is the part that survives: by the time a 30 cm stroke is
      // under a pixel the box is still a rectangle of a different material, and
      // a mark that dissolves into its background at forty metres is the defect
      // this rework exists to remove.
      const panel = 0.46 * lerp(0.84, 1.0, grit);
      alpha[i] = clamp01(Math.max(Math.max(p, kk * 0.92), Math.max(rub * 0.62, panel))
        * lerp(0.88, 1.0, grit));
      height[i] = p * 0.7 + grit * 0.2 + 0.15;
    }
  }

  const c = paint(W, (x, y, o) => {
    const i = y * W + x;
    const cx = x % size;
    const p = paintBuf[i], kk = keyBuf[i];
    const grime = lerp(0.78, 1.03, fbm2D(gritN.n, cx / gritN.k + 5, y / gritN.k, 3));
    // Rubber over paint, not instead of it. At 0.30 the two tracks took the
    // staging bar — the one mark a driver actually uses — down to a third of
    // its value in two black stripes, which is a heavier start than any grid
    // has ever had and cost the bar most of its weight.
    const k = grime * lerp(1.0, 0.48, rubBuf[i]);
    // The sealed panel is darker than the road it is painted on and matt where
    // the road is not. Under the paint is road, not black: a canvas stores
    // premultiplied alpha and would otherwise bleed black down every edge.
    let r = lerp(ROAD.r * 0.62, KEY.r, kk);
    let gg = lerp(ROAD.g * 0.62, KEY.g, kk);
    let b = lerp(ROAD.b * 0.64, KEY.b, kk);
    o[0] = lerp(r, WHITE.r * k, p) * 255;
    o[1] = lerp(gg, WHITE.g * k, p) * 255;
    o[2] = lerp(b, WHITE.b * k, p) * 255;
  }, H);

  const roughC = paint(W, (x, y, o) => {
    const i = y * W + x;
    let rgh = lerp(0.90, 0.48, paintBuf[i]);
    rgh = lerp(rgh, 0.98, rubBuf[i]);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  }, H);

  const result = {
    map: makeTexture(c, { srgb: true }),
    alphaMap: makeTexture(grayCanvas(W, alpha, 255, H)),
    normalMap: makeTexture(heightToNormal(height, W, 1.4, H)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.5,
    slots,
  };
  // Each box maps one cell exactly once, so repeat wrapping would only ever let
  // the far end of the atlas bleed in under bilinear filtering. Between cells
  // the neighbour is another box's side line, which is the same white, so the
  // one seam that does exist has nothing to show.
  for (const t of [result.map, result.alphaMap, result.normalMap, result.roughnessMap]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
  }
  _textureCache.set(key, result);
  return result;
}

/** Rainbow Road surface: chromatic bands with a starfield shimmer. */
export function rainbow({ size = 1024 } = {}) {
  const key = `rainbow_${size}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const spark = makeValueNoise2D(99, size / 4);
  const col = new THREE.Color();
  const c = paint(size, (x, y, o) => {
    const u = x / size;
    // Seven bands across the road, softly blended at their boundaries.
    const band = u * 7;
    const hue = mod(Math.floor(band) / 7 + 0.02, 1);
    const nextHue = mod((Math.floor(band) + 1) / 7 + 0.02, 1);
    const f = smoothstep(clamp01((band - Math.floor(band) - 0.72) / 0.28));
    col.setHSL(lerp(hue, nextHue < hue ? nextHue + 1 : nextHue, f) % 1, 0.92, 0.56, THREE.NoColorSpace);
    const sp = fbm2D(spark, x / 3, y / 3, 2);
    const glint = sp > 0.88 ? (sp - 0.88) * 7 : 0;
    o[0] = (col.r + glint) * 255;
    o[1] = (col.g + glint) * 255;
    o[2] = (col.b + glint) * 255;
  });
  const emissive = paint(size, (x, y, o) => {
    const u = x / size;
    const edge = Math.min(u, 1 - u);
    const glow = 1 - smoothstep(edge / 0.06);
    const sp = fbm2D(spark, x / 3, y / 3, 2);
    const v = clamp01(glow * 0.9 + (sp > 0.9 ? 1 : 0) * 0.6);
    o[0] = o[1] = o[2] = v * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    emissiveMap: makeTexture(emissive, { srgb: true }),
    roughnessMap: null,
  };
  _textureCache.set(key, result);
  return result;
}

/** Painted metal for barriers and props. */
export function paintedMetal({ size = 512, seed = 3, tint = 0xdddddd } = {}) {
  const key = `metal_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const n = makeValueNoise2D(seed, size / 8);
  const scratch = makeValueNoise2D(seed + 40, size / 2);
  const base = paintTint(tint);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      height[y * size + x] = fbm2D(n, x / 20, y / 20, 3) * 0.6 + fbm2D(scratch, x / 1.2, y / 8, 2) * 0.4;
    }
  }
  const c = paint(size, (x, y, o) => {
    const h = height[y * size + x];
    const wear = clamp01(fbm2D(scratch, x / 1.2, y / 9, 2) * 1.4 - 0.55);
    const l = lerp(0.88, 1.08, h);
    o[0] = lerp(base.r * l, 0.42, wear) * 255;
    o[1] = lerp(base.g * l, 0.42, wear) * 255;
    o[2] = lerp(base.b * l, 0.44, wear) * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    const wear = clamp01(fbm2D(scratch, x / 1.2, y / 9, 2) * 1.4 - 0.55);
    o[0] = o[1] = o[2] = lerp(0.38, 0.72, wear) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 1.2)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.5,
  };
  _textureCache.set(key, result);
  return result;
}

/** Animated-looking water normal map (two scrolling layers at render time). */
export function waterNormal({ size = 512, seed = 31 } = {}) {
  const key = `waternrm_${size}_${seed}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const n = makeValueNoise2D(seed, size / 8);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Overlapping directional swells make a believable open-water surface.
      let h = 0;
      h += Math.sin((x * 0.055 + fbm2D(n, x / 34, y / 34, 3) * 7)) * 0.5;
      h += Math.sin((y * 0.041 + fbm2D(n, x / 26, y / 26, 3) * 6)) * 0.35;
      h += fbm2D(n, x / 9, y / 9, 4) * 0.5;
      height[y * size + x] = h * 0.25 + 0.5;
    }
  }
  const result = { normalMap: makeTexture(heightToNormal(height, size, 2.0)) };
  _textureCache.set(key, result);
  return result;
}

/** Clear the cache — used when the art agents hot-reload texture code. */
/**
 * The texture set for a circuit's off-track ground.
 *
 * There used to be three copies of this decision — the shoulder's, the
 * terrain's and the scenery's landforms' — keyed on two different theme fields,
 * and they were only in step because all three happened to agree for the two
 * tracks that existed. They must produce the *identical* object: the kerb has
 * to know the colour of the ground that spills onto it, and a mesa has to be
 * made of the same rock as the floor it stands on, or each reads as separately
 * authored. Everything here is cached, so asking three times is free.
 */
export function groundTexturesFor(theme) {
  const fn = GROUND_TEXTURES[theme?.shoulder] ?? GROUND_TEXTURES[theme?.offroad] ?? grass;
  return fn({ size: 1024, tint: theme?.groundColor });
}

const GROUND_TEXTURES = { sand, dirt, grass, snow };

export function clearTextureCache() {
  for (const v of _textureCache.values()) {
    for (const k in v) if (v[k]?.isTexture) v[k].dispose();
  }
  _textureCache.clear();
}

export const SURFACE_TEXTURES = { asphalt, ice, sand, dirt, snow, cityWindows, groundDetail, grass, curb, checker, gridBox, rainbow, paintedMetal, laneMarkings, waterNormal, boostPad, boostSpill };
