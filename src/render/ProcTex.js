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

function makeTexture(canvasEl, { srgb = false, repeat = 1, aniso = 8 } = {}) {
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

// ---------------------------------------------------------------------------
// Material generators. Each returns { map, normalMap, roughnessMap, ... }.
// ---------------------------------------------------------------------------

/**
 * Asphalt: aggregate stones embedded in binder, with wear polish in the
 * wheel lines and a subtle large-scale patchiness from resurfacing.
 */
export function asphalt({ size = 1024, seed = 7, tint = 0x3a3d44 } = {}) {
  const key = `asphalt_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  const n1 = makeValueNoise2D(seed, size / 4);
  const n2 = makeValueNoise2D(seed + 91, size / 16);
  const n3 = makeValueNoise2D(seed + 311, size / 64);
  const rng = makeRng(seed + 5);

  // Aggregate: scattered stones via a jittered-grid distance field.
  const cells = 96;
  const cellSize = size / cells;
  const sites = new Float32Array(cells * cells * 3);
  for (let i = 0; i < cells * cells; i++) {
    sites[i * 3] = rng();
    sites[i * 3 + 1] = rng();
    sites[i * 3 + 2] = 0.30 + rng() * 0.52; // stone radius, in cell units
  }
  const stoneAt = (px, py) => {
    const cx = Math.floor(px / cellSize), cy = Math.floor(py / cellSize);
    let best = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = mod(cx + ox, cells), gy = mod(cy + oy, cells);
        const k = (gy * cells + gx) * 3;
        const sx = (cx + ox + sites[k]) * cellSize;
        const sy = (cy + oy + sites[k + 1]) * cellSize;
        const r = sites[k + 2] * cellSize;
        const d = Math.hypot(px - sx, py - sy);
        if (d < r) best = Math.max(best, 1 - smoothstep(d / r));
      }
    }
    return best;
  };

  const height = new Float32Array(size * size);
  const macro = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const grain = fbm2D(n1, x / 4, y / 4, 4) * 0.42;
      const stone = stoneAt(x, y);
      const patch = fbm2D(n3, x / 64, y / 64, 3);
      macro[i] = patch;
      height[i] = grain * 0.55 + stone * 0.55 + patch * 0.12;
    }
  }

  const base = new THREE.Color(tint);
  const mapC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const h = height[i];
    const patch = macro[i];
    // Stones read slightly lighter and cooler than the binder around them.
    const l = lerp(0.62, 1.22, h) * lerp(0.88, 1.10, patch);
    const speck = fbm2D(n2, x / 2, y / 2, 2);
    const r = base.r * l + (speck - 0.5) * 0.045;
    const g = base.g * l + (speck - 0.5) * 0.045;
    const b = base.b * l + (speck - 0.5) * 0.05 + h * 0.012;
    o[0] = r * 255; o[1] = g * 255; o[2] = b * 255;
  });

  const roughC = paint(size, (x, y, o) => {
    const i = y * size + x;
    const h = height[i];
    // Exposed aggregate is rougher; binder between stones is slicker.
    let rgh = lerp(0.94, 0.66, clamp01(h * 1.4));
    rgh *= lerp(0.94, 1.04, macro[i]);
    o[0] = o[1] = o[2] = rgh * 255;
  });

  const result = {
    map: makeTexture(mapC, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 2.4)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.85,
  };
  _textureCache.set(key, result);
  return result;
}

/** Painted road markings drawn as a separate decal-ready alpha texture. */
export function laneMarkings({ size = 512 } = {}) {
  const key = `lane_${size}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const n = makeValueNoise2D(41, size / 8);
  const c = paint(size, (x, y, o) => {
    const u = x / size;
    // Two edge lines and a dashed centre line, with worn edges.
    const edge = Math.min(Math.abs(u - 0.045), Math.abs(u - 0.955));
    const edgeLine = 1 - smoothstep(edge / 0.016);
    const centre = 1 - smoothstep(Math.abs(u - 0.5) / 0.012);
    const dash = mod(y / size, 0.25) < 0.145 ? 1 : 0;
    let a = clamp01(edgeLine + centre * dash);
    const wear = fbm2D(n, x / 6, y / 6, 3);
    a *= lerp(0.55, 1, wear);
    o[0] = o[1] = o[2] = 255;
    o[3] = a * 255;
  });
  const result = { map: makeTexture(c, { srgb: true }) };
  _textureCache.set(key, result);
  return result;
}

/** Red/white rumble strip. `stripeLength` is in texture V units. */
export function curb({ size = 512, colorA = 0xd8352a, colorB = 0xf2f2f2 } = {}) {
  const key = `curb_${size}_${colorA}_${colorB}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const n = makeValueNoise2D(17, size / 8);
  const A = new THREE.Color(colorA), B = new THREE.Color(colorB);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Ridged profile across the strip plus paint grain.
      const u = x / size;
      const ridge = 0.5 + 0.5 * Math.cos(u * TAU * 3);
      height[y * size + x] = ridge * 0.7 + fbm2D(n, x / 5, y / 5, 3) * 0.3;
    }
  }
  const c = paint(size, (x, y, o) => {
    const stripe = Math.floor((y / size) * 8) % 2 === 0;
    const col = stripe ? A : B;
    const grime = lerp(0.78, 1.0, fbm2D(n, x / 12, y / 12, 4));
    const h = height[y * size + x];
    const l = grime * lerp(0.86, 1.10, h);
    o[0] = col.r * 255 * l; o[1] = col.g * 255 * l; o[2] = col.b * 255 * l;
  });
  const roughC = paint(size, (x, y, o) => {
    const v = lerp(0.52, 0.80, fbm2D(n, x / 10, y / 10, 3));
    o[0] = o[1] = o[2] = v * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 3.0)),
    roughnessMap: makeTexture(roughC),
    normalScale: 1.1,
  };
  _textureCache.set(key, result);
  return result;
}

/** Beach sand with wind ripples and shell speckle. */
export function sand({ size = 1024, seed = 23, tint = 0xd8c08a } = {}) {
  const key = `sand_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const fine = makeValueNoise2D(seed, size / 2);
  const rip = makeValueNoise2D(seed + 3, size / 16);
  const macro = makeValueNoise2D(seed + 77, size / 64);
  const base = new THREE.Color(tint);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Wind ripples: a warped sine, so they meander instead of marching.
      const warp = fbm2D(rip, x / 40, y / 40, 3) * 26;
      const ripple = 0.5 + 0.5 * Math.sin((y + warp) * 0.19);
      const grain = fbm2D(fine, x / 1.6, y / 1.6, 3);
      height[y * size + x] = ripple * 0.55 + grain * 0.30 + fbm2D(macro, x / 90, y / 90, 3) * 0.15;
    }
  }
  const c = paint(size, (x, y, o) => {
    const h = height[y * size + x];
    const l = lerp(0.80, 1.14, h);
    const shell = fbm2D(fine, x / 1.1, y / 1.1, 2);
    const bright = shell > 0.86 ? 0.20 : 0;
    o[0] = (base.r * l + bright) * 255;
    o[1] = (base.g * l + bright) * 255;
    o[2] = (base.b * l * 0.98 + bright) * 255;
  });
  const roughC = grayCanvas(size, height.map ? Float32Array.from(height, (h) => lerp(0.98, 0.86, h)) : height);
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 1.5)),
    roughnessMap: makeTexture(roughC),
    normalScale: 0.7,
  };
  _textureCache.set(key, result);
  return result;
}

/** Dry cracked desert dirt with pebbles. */
export function dirt({ size = 1024, seed = 51, tint = 0xa8703f } = {}) {
  const key = `dirt_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const fine = makeValueNoise2D(seed, size / 2);
  const mid = makeValueNoise2D(seed + 9, size / 12);
  const macro = makeValueNoise2D(seed + 88, size / 48);
  const base = new THREE.Color(tint);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain = fbm2D(fine, x / 2, y / 2, 4);
      const clods = fbm2D(mid, x / 14, y / 14, 4);
      // Ridged noise carves shallow cracks into the surface.
      const crack = 1 - Math.abs(fbm2D(macro, x / 30, y / 30, 4) * 2 - 1);
      height[y * size + x] = grain * 0.30 + clods * 0.50 + Math.pow(crack, 6) * -0.35 + 0.35;
    }
  }
  const c = paint(size, (x, y, o) => {
    const h = height[y * size + x];
    const l = lerp(0.66, 1.20, clamp01(h));
    const red = fbm2D(mid, x / 20, y / 20, 3);
    o[0] = base.r * l * lerp(0.94, 1.08, red) * 255;
    o[1] = base.g * l * lerp(0.98, 1.02, red) * 255;
    o[2] = base.b * l * lerp(1.06, 0.92, red) * 255;
  });
  const roughC = paint(size, (x, y, o) => {
    const v = lerp(0.99, 0.82, clamp01(height[y * size + x]));
    o[0] = o[1] = o[2] = v * 255;
  });
  const result = {
    map: makeTexture(c, { srgb: true }),
    normalMap: makeTexture(heightToNormal(height, size, 2.2)),
    roughnessMap: makeTexture(roughC),
    normalScale: 1.0,
  };
  _textureCache.set(key, result);
  return result;
}

/** Grass, viewed from a distance — clumped blades rather than a green blur. */
export function grass({ size = 1024, seed = 61, tint = 0x4e8a3c } = {}) {
  const key = `grass_${size}_${seed}_${tint}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const blade = makeValueNoise2D(seed, size / 2);
  const clump = makeValueNoise2D(seed + 13, size / 20);
  const base = new THREE.Color(tint);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const b = fbm2D(blade, x / 1.5, y / 3.5, 3);
      const c2 = fbm2D(clump, x / 18, y / 18, 4);
      height[y * size + x] = b * 0.55 + c2 * 0.45;
    }
  }
  const c = paint(size, (x, y, o) => {
    const h = height[y * size + x];
    const l = lerp(0.58, 1.28, h);
    const yellow = clamp01(fbm2D(clump, x / 26, y / 26, 3) * 1.3 - 0.35);
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
  };
  _textureCache.set(key, result);
  return result;
}

/** Checkered start/finish. Kept high-contrast and crisp. */
export function checker({ size = 512, squares = 8 } = {}) {
  const key = `checker_${size}_${squares}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const n = makeValueNoise2D(5, size / 8);
  const c = paint(size, (x, y, o) => {
    const cx = Math.floor((x / size) * squares);
    const cy = Math.floor((y / size) * squares);
    const on = (cx + cy) % 2 === 0;
    const grime = lerp(0.82, 1.0, fbm2D(n, x / 9, y / 9, 3));
    const v = (on ? 236 : 22) * grime;
    o[0] = o[1] = o[2] = v;
  });
  const result = { map: makeTexture(c, { srgb: true }), roughnessMap: null };
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
    col.setHSL(lerp(hue, nextHue < hue ? nextHue + 1 : nextHue, f) % 1, 0.92, 0.56);
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
  const base = new THREE.Color(tint);
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

export const SURFACE_TEXTURES = { asphalt, sand, dirt, grass, curb, checker, rainbow, paintedMetal, laneMarkings, waterNormal };
