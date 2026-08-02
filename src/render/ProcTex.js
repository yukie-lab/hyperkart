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

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
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

/** Sobel-differentiate a height buffer into a tangent-space normal map. */
export function heightToNormal(height, size, strength = 2.0) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[mod(y, size) * size + mod(x, size)];
  for (let y = 0; y < size; y++) {
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
function paint(size, fn) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const out = [0, 0, 0, 255];
  for (let y = 0; y < size; y++) {
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

function grayCanvas(size, buf, scale = 255) {
  return paint(size, (x, y, o) => {
    const v = buf[y * size + x] * scale;
    o[0] = o[1] = o[2] = v;
  });
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
 */
export function asphalt({ size = 1024, seed = 7, tint = 0x3a3d44 } = {}) {
  const key = `asphalt_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  // Three scales, in texels of the 6 m road tile: ~2 cm grain, ~40 cm binder
  // mottling, ~20 cm crack cells that fbm grows into metre-long fissures.
  const grainN = tiling(seed, size, 4);
  const binderN = tiling(seed + 91, size, 64);
  const crackN = tiling(seed + 311, size, 32);
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
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Ridged noise raised to a high power leaves only the thin crests, which
      // read as the hairline shrinkage cracks tarmac develops as it ages.
      const ridge = 1 - Math.abs(fbm2D(crackN.n, x / crackN.k, y / crackN.k, 3) * 2 - 1);
      const crack = Math.pow(clamp01(ridge), 9);
      const binder = fbm2D(binderN.n, x / binderN.k, y / binderN.k, 3);
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 2);
      crackBuf[i] = crack;
      binderBuf[i] = binder;
      grainBuf[i] = grain;
      // Stones dominate the relief; the grain contributes barely enough to
      // break the stone silhouettes without becoming a normal-map carpet.
      height[i] = cov[i] * 0.70 + grain * 0.14 + binder * 0.10 - crack * 0.32 + 0.10;
    }
  }

  const base = paintTint(tint);
  const mapC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const c = cov[i];
    // Bitumen mottling is the *visible* texture of tarmac at any distance you
    // actually drive it from: 40 cm patches where the binder pooled richer or
    // leaner during laying. It has to carry the read, because it is the only
    // scale here that survives two mip levels intact.
    const binderL = lerp(0.89, 1.06, binderBuf[i]) * lerp(0.97, 1.03, grainBuf[i]);
    // Per-stone albedo lottery, held to a whisper — the stones are relief, not
    // spots. A wide spread here is what turned the road into pebbledash.
    const stoneL = binderL * lerp(0.95, 1.14, Math.pow(who[i], 1.25));
    let l = lerp(binderL, stoneL, smoothstep(c));
    l *= 1 - crackBuf[i] * 0.34;
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
    // Deliberately gentle. Tarmac relief is millimetres; drive it harder and a
    // low sun rakes the chippings into a sandpaper glare that reads as gravel.
    normalMap: makeTexture(heightToNormal(height, size, 1.8)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.44,
    // Pivot for the second-scale sample TrackBuilder layers on; see meanLinearLuma.
    meanLuma: meanLinearLuma(mapC),
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
 */
export function curb({ size = 512, colorA = 0xd8352a, colorB = 0xf2f2f2, dirtTint = 0x8a7a5c } = {}) {
  const key = `curb_${size}_${colorA}_${colorB}_${dirtTint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  // Only V has to tile here — U runs across the strip exactly once — but the
  // strip repeats every 8 m, so a V seam would strobe past twice a second.
  const paintN = tiling(17, size, 16);
  const chipN = tiling(53, size, 8);
  const rubN = tiling(71, size, 4);
  const gritN = tiling(89, size, 2);
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
      const grit = fbm2D(gritN.n, x / gritN.k, y / gritN.k, 3);
      // Distance to the nearest stripe joint, in stripe units. Kerb paint is
      // laid one stripe at a time and always lifts at those seams first.
      const f = mod(v * 8, 1);
      const joint = Math.min(f, 1 - f);
      let p = smoothstep(joint / 0.055);
      p *= 1 - clamp01((fbm2D(chipN.n, x / chipN.k, y / chipN.k, 3) - 0.70) * 5.0);
      p = clamp01(p);
      paintBuf[i] = p;
      gritBuf[i] = grit;
      // Two coats of paint stand a fraction of a millimetre proud of the
      // concrete; at grazing light that lip is the whole read of "chipped".
      height[i] = grit * 0.34 + p * 0.30 + 0.2;
    }
  }

  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    const u = x / size, v = y / size;
    const p = paintBuf[i], grit = gritBuf[i];
    const col = Math.floor(v * 8) % 2 === 0 ? A : B;
    // Each stripe weathers on its own schedule — a kerb where every red is the
    // same red is the giveaway that it came out of a texture generator.
    const fade = lerp(0.66, 1.02, fbm2D(paintN.n, 3.7, y / paintN.k, 2));
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
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Beach sand: wind-blown ripples over size-graded grain.
 *
 * Two things separate real sand from noise-with-a-yellow-tint. First the
 * ripples have a *direction* — the prevailing wind — and a consistent
 * wavelength, and they only ever meander around it; a warped sine gives that,
 * pure fbm never will. Second the grain is graded: the fines are blown off the
 * ripple crests and collect in the troughs, so the crests are coarser, paler
 * and rougher than the hollows between them. That sorting is what the eye
 * reads as "sand" rather than "sandpaper".
 */
export function sand({ size = 1024, seed = 23, tint = 0xd8c08a } = {}) {
  const key = `sand_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grainN = tiling(seed, size, 2);
  const coarseN = tiling(seed + 41, size, 4);
  const warpN = tiling(seed + 3, size, 32);
  const duneN = tiling(seed + 77, size, 128);
  const base = paintTint(tint);

  // The tile spans 5 m of shoulder / 14 m of terrain, so ripples every ~28
  // texels land at roughly a hand's width — the wavelength dry sand actually
  // holds. The count must be a whole number or the ripples seam on the tile.
  const ripples = 36;
  // Prevailing wind, held a little off the tile axes so the ripples never look
  // like they were drawn to the texture's grid.
  const wx = Math.cos(0.42), wy = Math.sin(0.42);

  const height = new Float32Array(size * size);
  const crest = new Float32Array(size * size);
  const grainBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const warp = (fbm2D(warpN.n, x / warpN.k, y / warpN.k, 3) - 0.5) * 0.22;
      const phase = ((x * wx + y * wy) / size + warp) * ripples * TAU;
      // Asymmetric crests: the lee face of a ripple is steeper than the stoss.
      const s = Math.sin(phase);
      const ripple = 0.5 + 0.5 * Math.sign(s) * Math.pow(Math.abs(s), 0.7);
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 3);
      const coarse = fbm2D(coarseN.n, x / coarseN.k, y / coarseN.k, 2);
      crest[i] = ripple;
      // Coarse grains sit on the crests, fines settle in the troughs.
      grainBuf[i] = lerp(grain, coarse, ripple * 0.8);
      height[i] = ripple * 0.46 + grainBuf[i] * 0.22
        + fbm2D(duneN.n, x / duneN.k, y / duneN.k, 3) * 0.32;
    }
  }
  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Dry, wind-sorted crests are paler than the damper packed troughs.
    const l = lerp(0.84, 1.10, height[i]) * lerp(0.97, 1.05, crest[i]);
    const shell = grainBuf[i] > 0.88 ? (grainBuf[i] - 0.88) * 1.4 : 0;
    o[0] = (base.r * l + shell) * 255;
    o[1] = (base.g * l + shell * 0.96) * 255;
    o[2] = (base.b * l * 0.985 + shell * 0.9) * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    o[0] = o[1] = o[2] = lerp(0.90, 0.99, crest[i]) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 1.5)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.7,
    meanLuma: meanLinearLuma(c),
  };
  _textureCache.set(key, result);
  return result;
}

/**
 * Dry desert dirt: wind-drifted fines over cracked, pebbled hardpan.
 *
 * Same grading idea as the sand — the wind sorts this too — but here the
 * coarse fraction is pebbles that the fines drift *around* rather than sit on,
 * so the pebbles stand proud and the cracks run between them.
 */
export function dirt({ size = 1024, seed = 51, tint = 0xa8703f } = {}) {
  const key = `dirt_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grainN = tiling(seed, size, 2);
  const pebbleN = tiling(seed + 9, size, 8);
  const clodN = tiling(seed + 23, size, 32);
  const crackN = tiling(seed + 88, size, 64);
  const driftN = tiling(seed + 131, size, 16);
  const base = paintTint(tint);

  const height = new Float32Array(size * size);
  const pebbleBuf = new Float32Array(size * size);
  const crackBuf = new Float32Array(size * size);
  const driftBuf = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const grain = fbm2D(grainN.n, x / grainN.k, y / grainN.k, 3);
      const clods = fbm2D(clodN.n, x / clodN.k, y / clodN.k, 4);
      // Pebbles: the top of the noise only, so they read as discrete stones
      // rather than as one more octave of the same lumpy field.
      const pebble = clamp01((fbm2D(pebbleN.n, x / pebbleN.k, y / pebbleN.k, 2) - 0.62) * 4.0);
      // Ridged noise carves shallow shrinkage cracks between them.
      const ridge = 1 - Math.abs(fbm2D(crackN.n, x / crackN.k, y / crackN.k, 4) * 2 - 1);
      const crack = Math.pow(clamp01(ridge), 8) * (1 - pebble);
      // Drifted fines, banked against whatever the wind found in its way.
      const drift = fbm2D(driftN.n, x / driftN.k, y / driftN.k, 3);
      pebbleBuf[i] = pebble;
      crackBuf[i] = crack;
      driftBuf[i] = drift;
      height[i] = grain * 0.14 + clods * 0.34 + pebble * 0.34 - crack * 0.34 + drift * 0.18 + 0.25;
    }
  }
  const c = paint(size, (x, y, o) => {
    const i = y * size + x;
    const l = lerp(0.70, 1.16, clamp01(height[i]));
    // Iron-rich fines are redder than the pale stone they drift over.
    const red = clamp01(driftBuf[i] * 1.2 - 0.1) * (1 - pebbleBuf[i] * 0.7);
    const stone = pebbleBuf[i] * 0.22;
    o[0] = (base.r * l * lerp(0.92, 1.10, red) + stone * 0.9) * 255;
    o[1] = (base.g * l * lerp(0.98, 1.02, red) + stone) * 255;
    o[2] = (base.b * l * lerp(1.10, 0.90, red) + stone * 1.15) * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    // Loose dust is the roughest thing in the scene; polished pebbles are not.
    let rgh = lerp(0.99, 0.86, pebbleBuf[i]);
    rgh = lerp(rgh, 1.0, crackBuf[i]);
    o[0] = o[1] = o[2] = clamp01(rgh) * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 2.2)),
    roughnessMap: makeTexture(roughC),
    normalScale: 1.0,
    meanLuma: meanLinearLuma(c),
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
 */
export function boostPad({ size = 512, aspect = 2.0, plate = 0x123c56, glow = 0x2ecdff, wear = 1 } = {}) {
  const key = `boost_${size}_${aspect}_${plate}_${glow}_${wear}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  const wearN = tiling(211, size, 4);    // tyre scuffing, over centimetres
  const gritN = tiling(233, size, 2);    // road grit trodden into the film
  const filmN = tiling(251, size, 16);   // how thick the machine laid it, over metres
  const P = paintTint(plate), G = paintTint(glow);

  // Arm thickness as a fraction of the pitch. Much above 0.45 and the gaps
  // close up into a solid slab again — the gap is what makes it an arrow.
  const ARM = 0.40;
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
      // Wrapped signed distance to the arm's centre, so both edges of the band
      // soften and the band crossing the tile seam does not tear.
      let dp = phase - ARM * 0.5;
      dp -= Math.round(dp);
      const a = 1 - smoothstep((Math.abs(dp) - ARM * 0.5) / SOFT);
      // A narrow bloom rim just outside each arm — real light on wet-look paint
      // does not stop dead at the edge of the paint. It has to die out well
      // before the midpoint between two arms: a wide falloff here does not read
      // as a rim at all, it silently relights the entire plate, which is the
      // uniform glow this whole rework exists to remove.
      const h = 1 - smoothstep((Math.abs(dp) - ARM * 0.6) / 0.075);

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
      lead[i] = clamp01(dp / (ARM * 0.5)) * a;
      halo[i] = h;
      scuff[i] = sc;

      // The plate stops short of the pad edge and feathers out over the last
      // ~7% of the half-width, so the strip is a decal painted on the road
      // rather than a quad hovering above it with a polygon silhouette.
      const edge = 1 - smoothstep((Math.abs(wx) / (aspect * 0.5) - 0.86) / 0.14);
      // Feathering with a clean ramp reads as an airbrush; overspray and
      // flaking at the border is what a real painted edge looks like.
      const flake = smoothstep((fbm2D(wearN.n, x / wearN.k + 31, y / wearN.k, 4) - 0.26) * 3.2);
      const patchy = lerp(1, lerp(0.42, 1.0, flake) * lerp(0.86, 1.0, fbm2D(gritN.n, x / gritN.k, y / gritN.k, 2)), wear);
      alpha[i] = clamp01(edge * patchy);

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
export function boostSpill({ size = 256, core = 0.65 } = {}) {
  const key = `boostspill_${size}_${core}`;
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
export function checker({ size = 512, squares = 8 } = {}) {
  const key = `checker_${size}_${squares}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const grimeN = tiling(5, size, 8);
  const chipN = tiling(63, size, 4);
  const rubN = tiling(87, size, 16);
  const gritN = tiling(109, size, 2);
  const WHITE = paintTint(0xd9d5c8), DARK = paintTint(0x24242a);
  const ROAD = paintTint(0x4a4a52);

  const paintBuf = new Float32Array(size * size);
  const rubBuf = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const SOFT = 1.6 / size * squares;   // in square units

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) / size * squares, v = (y + 0.5) / size * squares;
      // Distance to the nearest square joint, in square units. Paint lifts at
      // those seams first — they are where one pass butted against the next.
      const ju = Math.abs(mod(u, 1) - 0.5), jv = Math.abs(mod(v, 1) - 0.5);
      const joint = Math.min(0.5 - ju, 0.5 - jv);
      let p = smoothstep(joint / 0.09);
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
    const on = (cx + cy) % 2 === 0;
    const col = on ? WHITE : DARK;
    const grime = lerp(0.74, 1.02, fbm2D(grimeN.n, x / grimeN.k, y / grimeN.k, 3));
    const k = grime * lerp(0.82, 1.0, Math.min(fu, fv)) * lerp(1.0, 0.55, rubBuf[i]);
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
export function clearTextureCache() {
  for (const v of _textureCache.values()) {
    for (const k in v) if (v[k]?.isTexture) v[k].dispose();
  }
  _textureCache.clear();
}

export const SURFACE_TEXTURES = { asphalt, sand, dirt, grass, curb, checker, rainbow, paintedMetal, laneMarkings, waterNormal, boostPad, boostSpill };
