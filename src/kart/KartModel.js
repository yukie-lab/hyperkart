import * as THREE from 'three';
import { roundedBox, lathe, tyreGeometry, capsule, mergeGeometries, xform } from '../render/GeoUtils.js';
import { heightToNormal } from '../render/ProcTex.js';
import { PHYS } from './KartTuning.js';
import { clamp, clamp01, damp, fbm2D, lerp, makeValueNoise2D, smoothstep, TAU } from '../core/MathX.js';

/**
 * Procedural kart + driver.
 *
 * Three things carry the look, in order of how far away they still read:
 *
 *  1. Silhouette. Characters pick a chassis `build`, a `wing` and a `helmet`
 *     from small shared sets, so a rival is identifiable from behind at speed
 *     before its colour is even resolvable. Geometry is cached by shape, so
 *     twelve karts still build only a handful of buffers.
 *  2. Livery. The bodywork is unwrapped with a cylindrical projection around
 *     the kart's long axis and painted per character: base coat, racing
 *     number, panel lines, and a clearcoat mask so matte graphics sit against
 *     gloss paint. One flat clearcoat colour reads as a toy; this does not.
 *  3. The rear. The player stares at the back of their own kart for the whole
 *     race, so that is where the detail budget goes — diffuser, heat-tinted
 *     exhausts, brake light, engine top end, wing endplates.
 *
 * Parts that share a material *and* a moving parent are merged into a single
 * buffer at build time. Nothing about the model changes on screen; what
 * changes is that a kart is ~29 draw calls instead of 61, and with a full grid
 * on track the karts were 93% of everything the renderer submitted.
 *
 * Cost is then held down three more ways, none of which touches how a kart
 * looks in the chase camera:
 *
 *  - Distance. Past LOD_DISTANCE every animated transform on a kart is
 *    sub-pixel, so the whole model — chassis, wheels, steering rack, driver —
 *    is baked once into a handful of merged buffers and swapped in. Body lean,
 *    pitch, squash and tricks still apply, because the swap happens *below*
 *    the group those ride on.
 *  - The shadow map. It is a second full pass over the same meshes, so only
 *    the slots that actually widen a kart's silhouette are asked to cast.
 *  - Transmission. See the `glass` material.
 */

const WHEEL_R = 0.36;
const WHEEL_W = 0.30;
const FRONT_WHEEL_R = 0.30;

/**
 * How far the presentation hangs below the simulation's reference point.
 *
 * `kart.pos` is not on the road — `PHYS.rideHeight` puts it at axle height, and
 * its own comment says so. Every piece of geometry in this file is authored
 * against a contact plane at y = 0, and nothing was ever reconciling the two,
 * so every kart in the game was hovering 42 cm over the surface: measured at
 * the near camera, an eighty-pixel gap between the bottom of a rear tyre and
 * the road directly beneath it. That is what the "shadow detached from the
 * tyre" report was actually looking at. The shadow was in the right place.
 *
 * Applied to `body` rather than to `group`, because `group` is the transform
 * the race director writes the interpolated physics pose into every frame. It
 * also moves the pivot for lean, pitch and squash down onto the contact plane,
 * which is where a kart's roll centre belongs: rolling about axle height swung
 * the tyres sideways out of their own contact patches.
 */
// Measured per wheel, and it lands almost exactly on `PHYS.rideHeight`.
//
// The measurement that matters is: wheel world Y, minus that wheel's radius,
// minus the ground sampled *directly beneath that wheel*. Sampling the ground
// at the chassis origin instead gives a completely different number on any
// crowned or banked road, and reading a bounding box over the tyre meshes
// gives a third — both were tried here and both are misleading. With this
// value the four wheels sit within a few millimetres of the surface on the
// flat grid, on both tracks, and they agree with each other to 3 mm.
const RIDE_DROP = 0.411;

// Rim radius of the steering wheel, and where on it the hands grip. The driver
// rig solves to these every frame, so the hands are never "near" the wheel.
const STEER_R = 0.155;
const GRIP_ANGLE = 0.62;
const ARM_LEN = 0.46;

/**
 * Chassis proportions per build.
 *
 * `stance` lifts the bodywork relative to the wheels — the wheels themselves
 * always keep their contact plane at body y=0, because that is the convention
 * the ground query and the shadow blob are written against.
 */
const BUILDS = {
  dart: {
    width: 1.04, deck: 0.30, len: 1.74, stance: -0.015,
    podW: 0.24, podH: 0.26, podZ: 0.08, podLen: 0.92,
    track: 0.70, rearTrack: 0.76, wbF: 0.90, wbR: -0.74,
    tyre: 0.88, engine: [0.70, 0.34, 0.54], noseTaper: 0.58, seatH: 0.58,
  },
  gt: {
    width: 1.22, deck: 0.34, len: 1.82, stance: 0.0,
    podW: 0.30, podH: 0.30, podZ: 0.06, podLen: 0.98,
    track: 0.76, rearTrack: 0.80, wbF: 0.86, wbR: -0.78,
    tyre: 1.0, engine: [0.86, 0.44, 0.62], noseTaper: 0.66, seatH: 0.62,
  },
  bruiser: {
    width: 1.42, deck: 0.40, len: 1.90, stance: 0.045,
    podW: 0.38, podH: 0.36, podZ: 0.04, podLen: 1.00,
    track: 0.86, rearTrack: 0.94, wbF: 0.88, wbR: -0.80,
    tyre: 1.14, engine: [1.02, 0.54, 0.70], noseTaper: 0.80, seatH: 0.70,
  },
};

// ---------------------------------------------------------------------------
// Texture generation
// ---------------------------------------------------------------------------

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function textureOf(cv, srgb = false) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const _mixA = new THREE.Color();
const _mixB = new THREE.Color();
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const mixHex = (a, b, t) => `#${_mixA.setHex(a).lerp(_mixB.setHex(b), t).getHexString()}`;

/**
 * Cylindrical unwrap around the kart's long axis.
 *
 * u runs nose-to-tail, v runs around the hull with the seam tucked under the
 * floor: 0.5 is the top centreline, 0.25 and 0.75 the left and right flanks.
 * x and y are normalised by the section half-extents first, which stops the
 * flat top deck from eating most of the texture the way a plain atan2 would.
 */
function wrapUV(geo, a = 0.82, b = 0.34, yc = 0.05, z0 = -1.25, zLen = 2.85) {
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ang = Math.atan2(p.getX(i) / a, (p.getY(i) - yc) / b);
    uv[i * 2] = (p.getZ(i) - z0) / zLen;
    uv[i * 2 + 1] = 0.5 + ang / TAU;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

const LIV_W = 512, LIV_H = 256;
const _liveryCache = new Map();

/**
 * Livery + surface-mask pair for one character.
 *
 * The mask packs clearcoat strength in red and roughness in green, which is
 * exactly what MeshPhysicalMaterial samples from `clearcoatMap.r` and
 * `roughnessMap.g` — one canvas, two channels, no extra texture fetch.
 */
function liveryTextures(ch) {
  const key = `${ch.livery}_${ch.color}_${ch.accent}_${ch.num}`;
  const hit = _liveryCache.get(key);
  if (hit) return hit;

  const cv = canvasOf(LIV_W, LIV_H);
  const c = cv.getContext('2d');
  const mv = canvasOf(LIV_W, LIV_H);
  const m = mv.getContext('2d');

  const U = (u) => u * LIV_W;
  const V = (v) => (1 - v) * LIV_H;
  const base = hex(ch.color);
  const acc = hex(ch.accent);
  const dark = mixHex(ch.color, 0x080a0f, 0.72);

  // Gloss paint everywhere to start: full clearcoat (r), tight roughness (g).
  m.fillStyle = 'rgb(255,62,0)';
  m.fillRect(0, 0, LIV_W, LIV_H);
  c.fillStyle = base;
  c.fillRect(0, 0, LIV_W, LIV_H);

  // Vertical shading in the unwrap: the underside of the hull never sees sky,
  // so darkening it there beats relying on a shadow term that is not there.
  const grad = c.createLinearGradient(0, 0, 0, LIV_H);
  grad.addColorStop(0.00, 'rgba(0,0,0,0.34)');
  grad.addColorStop(0.14, 'rgba(0,0,0,0.13)');
  grad.addColorStop(0.34, 'rgba(0,0,0,0.02)');
  grad.addColorStop(0.50, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.66, 'rgba(0,0,0,0.02)');
  grad.addColorStop(0.86, 'rgba(0,0,0,0.13)');
  grad.addColorStop(1.00, 'rgba(0,0,0,0.34)');
  c.fillStyle = grad;
  c.fillRect(0, 0, LIV_W, LIV_H);

  drawLivery(c, m, ch, U, V, base, acc, dark);

  // Panel shut lines wrap right around the hull, which is what sells the
  // bodywork as separate mouldings rather than one extruded lump.
  for (const u of [0.255, 0.545, 0.775]) {
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(U(u), 0, 2, LIV_H);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(U(u) + 2, 0, 1, LIV_H);
    m.fillStyle = 'rgb(120,150,0)';
    m.fillRect(U(u) - 1, 0, 4, LIV_H);
  }

  // Exhaust soot and heat staining across the tail.
  const soot = c.createLinearGradient(0, 0, U(0.16), 0);
  soot.addColorStop(0, 'rgba(12,10,10,0.75)');
  soot.addColorStop(1, 'rgba(12,10,10,0)');
  c.fillStyle = soot;
  c.fillRect(0, 0, U(0.16), LIV_H);
  m.fillStyle = 'rgb(60,190,0)';
  m.fillRect(0, 0, U(0.07), LIV_H);

  // Racing number, one per flank. Reading direction runs with +u on the left
  // flank and against it on the right, so the right roundel is drawn rotated.
  // The unwrap stretches v about 1.4x on the pods; the disc is pre-squashed to
  // land round on the model.
  for (const side of [-1, 1]) {
    const v = side < 0 ? 0.25 : 0.75;
    c.save(); m.save();
    c.translate(U(0.435), V(v)); m.translate(U(0.435), V(v));
    if (side > 0) { c.scale(-1, -1); m.scale(-1, -1); }
    c.scale(1.4, 1); m.scale(1.4, 1);
    c.fillStyle = 'rgba(250,250,252,0.95)';
    c.beginPath(); c.arc(0, 0, 21, 0, TAU); c.fill();
    c.beginPath(); c.arc(0, 0, 21, 0, TAU); c.lineWidth = 3; c.strokeStyle = dark; c.stroke();
    c.fillStyle = '#14161c';
    c.font = 'bold 30px "Arial Black", Impact, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(ch.num), 0, 2);
    // Decals are matte vinyl, not paint: kill the clearcoat under them.
    m.fillStyle = 'rgb(30,110,0)';
    m.beginPath(); m.arc(0, 0, 22, 0, TAU); m.fill();
    c.restore(); m.restore();
  }

  // A second number across the nose deck: the only one legible from in front,
  // and the one that survives being fifty metres up the road.
  c.save(); m.save();
  c.translate(U(0.885), V(0.5)); m.translate(U(0.885), V(0.5));
  c.rotate(-Math.PI / 2); m.rotate(-Math.PI / 2);
  c.fillStyle = 'rgba(248,248,250,0.92)';
  c.fillRect(-28, -34, 56, 68);
  c.fillStyle = '#14161c';
  c.font = 'bold 46px "Arial Black", Impact, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(String(ch.num), 0, 2);
  m.fillStyle = 'rgb(30,110,0)';
  m.fillRect(-28, -34, 56, 68);
  c.restore(); m.restore();

  const out = {
    map: textureOf(cv, true),
    mask: textureOf(mv, false),
  };
  _liveryCache.set(key, out);
  return out;
}

/** Per-character paint schemes. `U`/`V` map livery space to canvas pixels. */
function drawLivery(c, m, ch, U, V, base, acc, dark) {
  const poly = (ctx, pts, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(U(pts[0][0]), V(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(U(pts[i][0]), V(pts[i][1]));
    ctx.closePath();
    ctx.fill();
  };
  // Everything below is drawn once and mirrored across the top centreline, so
  // both flanks always agree the way a real vinyl wrap does.
  const band = (v0, v1, fill, ctx = c) => {
    ctx.fillStyle = fill;
    ctx.fillRect(0, V(v1), LIV_W, V(v0) - V(v1));
    ctx.fillRect(0, V(1 - v0), LIV_W, V(1 - v1) - V(1 - v0));
  };

  switch (ch.livery) {
    case 'stripe':
      band(0.46, 0.50, acc);
      band(0.535, 0.555, dark);
      c.fillStyle = acc;
      c.fillRect(U(0.86), V(0.62), U(0.14), V(0.38) - V(0.62));
      break;

    case 'chevron':
      for (let i = 0; i < 5; i++) {
        const u = 0.18 + i * 0.15;
        poly(c, [[u, 0.5], [u + 0.075, 0.30], [u + 0.115, 0.30], [u + 0.04, 0.5],
          [u + 0.115, 0.70], [u + 0.075, 0.70]], i % 2 ? dark : acc);
      }
      break;

    case 'blocks':
      for (let i = 0; i < 6; i++) {
        const u = 0.10 + i * 0.14;
        c.fillStyle = i % 2 ? acc : dark;
        c.fillRect(U(u), V(0.80), U(0.085), V(0.62) - V(0.80));
        c.fillStyle = i % 2 ? dark : acc;
        c.fillRect(U(u), V(0.38), U(0.085), V(0.20) - V(0.38));
      }
      band(0.485, 0.515, dark);
      break;

    case 'flame':
      for (let i = 0; i < 4; i++) {
        const v = 0.62 + i * 0.045;
        poly(c, [[1.0, v], [0.40 - i * 0.06, v - 0.018], [0.30 - i * 0.05, v + 0.012], [1.0, v + 0.030]], acc);
        poly(c, [[1.0, 1 - v], [0.40 - i * 0.06, 1 - v + 0.018], [0.30 - i * 0.05, 1 - v - 0.012], [1.0, 1 - v - 0.030]], acc);
      }
      band(0.47, 0.53, dark);
      break;

    case 'wave':
      c.strokeStyle = acc; c.lineWidth = 13; c.lineCap = 'round';
      for (const s of [1, -1]) {
        c.beginPath();
        for (let i = 0; i <= 40; i++) {
          const u = i / 40;
          const v = 0.5 + s * (0.19 + Math.sin(u * 7.4) * 0.055);
          if (i === 0) c.moveTo(U(u), V(v)); else c.lineTo(U(u), V(v));
        }
        c.stroke();
      }
      band(0.495, 0.505, dark);
      break;

    case 'leaf':
      c.strokeStyle = dark; c.lineWidth = 5;
      for (const s of [1, -1]) {
        for (let k = 0; k < 3; k++) {
          c.beginPath();
          for (let i = 0; i <= 30; i++) {
            const u = 0.08 + (i / 30) * 0.86;
            const v = 0.5 + s * (0.10 + k * 0.055 + Math.sin(u * 3.1 + k) * 0.035);
            if (i === 0) c.moveTo(U(u), V(v)); else c.lineTo(U(u), V(v));
          }
          c.stroke();
        }
      }
      band(0.44, 0.485, acc);
      break;

    case 'shard':
      for (let i = 0; i < 7; i++) {
        const u = 0.06 + i * 0.13;
        poly(c, [[u, 0.5], [u + 0.10, 0.5], [u + 0.045, 0.24]], i % 2 ? acc : dark);
        poly(c, [[u, 0.5], [u + 0.10, 0.5], [u + 0.045, 0.76]], i % 2 ? acc : dark);
      }
      break;

    case 'hazard':
      c.save();
      c.beginPath(); c.rect(0, 0, U(0.34), LIV_H); c.clip();
      for (let i = -6; i < 14; i++) {
        poly(c, [[i * 0.05, 0], [i * 0.05 + 0.025, 0], [i * 0.05 + 0.065, 1], [i * 0.05 + 0.04, 1]],
          i % 2 ? acc : '#14161c');
      }
      c.restore();
      band(0.47, 0.52, acc);
      break;

    case 'pixel':
      for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 9; j++) {
          // Dither density falls off toward the nose, so the blocks read as a
          // dissolve rather than as a grid. Hashed, not random: the capture
          // harness has to produce the same livery every run.
          const u = i / 26;
          const hash = ((i * 73856093) ^ (j * 19349663)) % 997 / 997;
          if (hash > 0.85 - u * 0.55) continue;
          c.fillStyle = (i + j) % 3 ? acc : dark;
          const v = 0.5 + (j + 1) * 0.028;
          c.fillRect(U(u), V(v), U(0.033), V(v - 0.028) - V(v));
          c.fillRect(U(u), V(1 - v + 0.028), U(0.033), V(1 - v) - V(1 - v + 0.028));
        }
      }
      break;

    case 'carbon':
      // Weave, not paint: matte, and it kills the clearcoat under it.
      band(0.50, 0.86, '#101218');
      band(0.50, 0.86, 'rgba(255,255,255,0.05)');
      for (let i = 0; i < 64; i++) {
        c.fillStyle = 'rgba(255,255,255,0.045)';
        c.fillRect(U(i / 64), V(0.86), 4, V(0.50) - V(0.86));
        c.fillRect(U(i / 64), V(0.50), 4, V(0.14) - V(0.50));
      }
      m.fillStyle = 'rgb(10,215,0)';
      m.fillRect(0, V(0.86), LIV_W, V(0.14) - V(0.86));
      band(0.455, 0.475, acc);
      break;

    default: // 'bolt'
      c.fillStyle = acc;
      for (const s of [1, -1]) {
        c.beginPath();
        const pts = [[0.02, 0.20], [0.44, 0.20], [0.34, 0.30], [0.72, 0.28], [0.98, 0.36],
          [0.60, 0.355], [0.70, 0.255], [0.30, 0.275], [0.02, 0.27]];
        for (let i = 0; i < pts.length; i++) {
          const v = s > 0 ? pts[i][1] : 1 - pts[i][1];
          if (i === 0) c.moveTo(U(pts[i][0]), V(v)); else c.lineTo(U(pts[i][0]), V(v));
        }
        c.closePath(); c.fill();
      }
      band(0.48, 0.52, dark);
      break;
  }
}

let _tyreTex = null;

/**
 * Tyre surface.
 *
 * The lathe's own UVs run around the circumference in u and across the section
 * in v, which is exactly the space a tread pattern wants: circumferential
 * grooves are constant-v lines and stay crisp no matter how hard the tread
 * band is stretched. Sidewall lettering is moulded into the same height field
 * that produces the normal map, so it lights instead of reading as a decal.
 */
function tyreTextures() {
  if (_tyreTex) return _tyreTex;
  const S = 512;

  const lc = canvasOf(S, S);
  const lx = lc.getContext('2d');
  lx.fillStyle = '#000'; lx.fillRect(0, 0, S, S);
  lx.fillStyle = '#fff';
  lx.textAlign = 'center'; lx.textBaseline = 'middle';
  lx.font = 'bold 23px "Arial Black", Impact, sans-serif';
  for (let side = 0; side < 2; side++) {
    const y = (1 - (side === 0 ? 0.185 : 0.815)) * S;
    for (let k = 0; k < 3; k++) {
      lx.save();
      lx.translate(((k + 0.5) / 3) * S, y);
      if (side === 1) lx.scale(-1, -1);
      lx.fillText(k % 2 ? 'HYPERGRIP' : 'SOFT · 11', 0, 0);
      lx.restore();
    }
  }
  const letters = lx.getImageData(0, 0, S, S).data;

  const n = makeValueNoise2D(1337, S / 4);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const v = 1 - y / S;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = x / S;
      let hh = fbm2D(n, x / 2.5, y / 2.5, 3) * 0.14;
      if (v > 0.40 && v < 0.60) {
        const t = (v - 0.40) / 0.20;
        hh += 0.60;
        const groove = Math.min(Math.abs(t - 0.22), Math.abs(t - 0.50), Math.abs(t - 0.78));
        if (groove < 0.058) hh -= 0.66;
        // Lateral sipes, skewed so the blocks are not a marching grid.
        const sipe = Math.abs((((u * 44 + t * 2.6) % 1) + 1) % 1 - 0.5);
        if (sipe > 0.415) hh -= 0.30;
      } else if ((v > 0.33 && v <= 0.40) || (v >= 0.60 && v < 0.67)) {
        hh += 0.44;
        const gap = Math.abs((((u * 22) % 1) + 1) % 1 - 0.5);
        if (gap > 0.40) hh -= 0.42;
      } else {
        const ridgeV = v > 0.5 ? 0.695 : 0.305;
        const ridge = 1 - Math.min(1, Math.abs(v - ridgeV) / 0.026);
        hh += 0.18 + ridge * 0.34 + (letters[i * 4] / 255) * 0.62;
      }
      h[i] = hh;
    }
  }

  const paint = (fn) => {
    const cv = canvasOf(S, S);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const o = fn(h[i], i);
      img.data[i * 4] = o[0]; img.data[i * 4 + 1] = o[1];
      img.data[i * 4 + 2] = o[2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  };

  const albedo = paint((hv) => {
    const l = clamp(lerp(0.40, 1.95, hv), 0.25, 2.1);
    return [22 * l, 24 * l, 29 * l];
  });
  const rough = paint((hv) => {
    // Groove floors stay dusty-matte; the moulded crown polishes with use.
    const r = lerp(0.99, 0.74, clamp01(hv));
    return [255, r * 255, 0];
  });

  _tyreTex = {
    map: textureOf(albedo, true),
    normalMap: textureOf(heightToNormal(h, S, 2.8)),
    roughnessMap: textureOf(rough),
  };
  return _tyreTex;
}

let _exhaustTex = null;

/** Heat tint down an exhaust: straw and blue at the header, soot at the tip. */
function exhaustTexture() {
  if (_exhaustTex) return _exhaustTex;
  const cv = canvasOf(16, 128);
  const ctx = cv.getContext('2d');
  // v runs along the lathe profile: header (0–0.29), megaphone body
  // (0.29–0.57), tip lip (0.57–0.71), then back down the bore to 1.
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0.00, '#c0b8a6');
  g.addColorStop(0.12, '#b08a4a');
  g.addColorStop(0.22, '#6d5f86');
  g.addColorStop(0.30, '#7d8390');
  g.addColorStop(0.44, '#9b9a94');
  g.addColorStop(0.57, '#7a7168');
  g.addColorStop(0.71, '#3b3532');
  g.addColorStop(0.82, '#191616');
  g.addColorStop(1.00, '#0d0b0b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 128);
  _exhaustTex = textureOf(cv, true);
  return _exhaustTex;
}

let _blurTex = null;

/** Radial smear used in place of spokes once the wheel is turning fast. */
function wheelBlurTexture() {
  if (_blurTex) return _blurTex;
  const S = 128;
  const cv = canvasOf(S, S);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  // Averaged spoke-and-gap, not a bright plate: a spinning wheel's interior
  // reads considerably darker than the spokes it is standing in for.
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.00, '#0d0f13');
  g.addColorStop(0.34, '#191c22');
  g.addColorStop(0.52, '#4c515b');
  g.addColorStop(0.60, '#22252b');
  g.addColorStop(0.80, '#585d67');
  g.addColorStop(0.94, '#2c2f36');
  g.addColorStop(1.00, '#14161a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, TAU); ctx.fill();
  _blurTex = textureOf(cv, true);
  return _blurTex;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const _chassisCache = new Map();
const _headCache = new Map();
const _wheelCache = new Map();
let _driverGeo = null;

/**
 * Group parts by material slot and merge each group into one geometry.
 *
 * Returns a Map of slot name to geometry, in insertion order, so the caller
 * can turn it straight into meshes without knowing which slots a given
 * assembly happens to use.
 */
function mergeBySlot(parts) {
  const bySlot = new Map();
  for (const p of parts) {
    if (!bySlot.has(p.slot)) bySlot.set(p.slot, []);
    bySlot.get(p.slot).push({ geo: p.geo, matrix: p.matrix });
  }
  const out = new Map();
  for (const [slot, list] of bySlot) {
    // A lone untransformed part needs no copy — it can be shared as-is.
    out.set(slot, list.length === 1 && !list[0].matrix ? list[0].geo : mergeGeometries(list));
  }
  return out;
}

/** Rear wing variants. The tallest thing on the kart, so the loudest tell. */
function wingParts(B, kind) {
  const p = [];
  const tail = -B.len * 0.5 - 0.20;
  // Endplates share the plane's incidence so the two meet flush; a plate left
  // upright against a tilted wing shows a wedge of daylight at the leading edge.
  const plate = (x, y, z, h, d) => {
    const g = roundedBox(0.035, h, d, 0.016, 2);
    p.push({ slot: 'accent', geo: g, matrix: xform([x, y, z], [0.14, 0, 0]) });
  };
  // Wing planes get a real section: thick at the leading edge, thin at the
  // trailing edge. A constant-thickness slab reads as a shelf.
  const plane = (w, y, z, d) => {
    const g = roundedBox(w, 0.06, d, 0.026, 3);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = clamp01((pos.getZ(i) / d) * -1 + 0.5);
      pos.setY(i, pos.getY(i) * lerp(1, 0.32, k));
    }
    g.computeVertexNormals();
    p.push({ slot: 'accent', geo: g, matrix: xform([0, y, z], [0.14, 0, 0]) });
  };

  switch (kind) {
    case 'ducktail': {
      // A lip straight off the tail — the low, hunkered look.
      plane(B.width * 0.98, 0.46, tail + 0.06, 0.32);
      const stay = roundedBox(0.065, 0.16, 0.075, 0.026, 2);
      for (const s of [-1, 1]) p.push({ slot: 'darkMetal', geo: stay, matrix: xform([s * B.width * 0.32, 0.36, tail + 0.10]) });
      for (const s of [-1, 1]) plate(s * B.width * 0.49, 0.49, tail + 0.06, 0.15, 0.26);
      break;
    }
    case 'slab': {
      // Two decks and full-height endplates: unmistakable heavyweight.
      plane(B.width * 1.02, 0.74, tail + 0.02, 0.30);
      plane(B.width * 0.90, 0.92, tail - 0.02, 0.24);
      const strut = roundedBox(0.07, 0.42, 0.10, 0.028, 2);
      for (const s of [-1, 1]) p.push({ slot: 'darkMetal', geo: strut, matrix: xform([s * B.width * 0.34, 0.56, tail + 0.04]) });
      for (const s of [-1, 1]) plate(s * B.width * 0.51, 0.83, tail, 0.32, 0.30);
      break;
    }
    case 'swan': {
      // Single plane on a centre pylon, plus a gurney on the trailing edge.
      plane(B.width * 0.92, 0.94, tail - 0.02, 0.28);
      const gurney = roundedBox(B.width * 0.92, 0.06, 0.028, 0.011, 1);
      p.push({ slot: 'accent', geo: gurney, matrix: xform([0, 0.945, tail - 0.145]) });
      const neck = roundedBox(0.075, 0.52, 0.13, 0.035, 3);
      p.push({ slot: 'darkMetal', geo: neck, matrix: xform([0, 0.68, tail + 0.09], [0.34, 0, 0]) });
      for (const s of [-1, 1]) plate(s * B.width * 0.46, 0.955, tail - 0.02, 0.24, 0.28);
      break;
    }
    default: { // 'gt'
      plane(B.width * 0.98, 0.82, tail + 0.01, 0.30);
      const strut = roundedBox(0.055, 0.34, 0.09, 0.022, 2);
      for (const s of [-1, 1]) p.push({ slot: 'darkMetal', geo: strut, matrix: xform([s * B.width * 0.34, 0.65, tail + 0.03]) });
      for (const s of [-1, 1]) plate(s * B.width * 0.49, 0.845, tail + 0.01, 0.22, 0.28);
      break;
    }
  }
  return p;
}

function buildChassis(buildKey, wingKind) {
  const key = `${buildKey}|${wingKind}`;
  const hit = _chassisCache.get(key);
  if (hit) return hit;
  const B = BUILDS[buildKey] || BUILDS.gt;
  const parts = [];
  const half = B.len * 0.5;
  const tail = -half - 0.20;

  // --- Tub, nose, pods -------------------------------------------------
  const tub = roundedBox(B.width, B.deck, B.len, 0.14, 5);
  tub.translate(0, 0.05, -0.05);
  parts.push({ slot: 'body', geo: tub });

  const nose = roundedBox(B.width * 0.76, 0.26, 0.86, 0.12, 4);
  nose.translate(0, 0.02, half + 0.08);
  {
    // Taper the nose to a wedge for a bit of aggression.
    const p = nose.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      const k = clamp01((z - half * 0.7) / 0.85);
      p.setX(i, p.getX(i) * lerp(1, B.noseTaper, k));
      p.setY(i, p.getY(i) * lerp(1, 0.72, k) - k * 0.03);
    }
    nose.computeVertexNormals();
  }
  parts.push({ slot: 'body', geo: nose });

  const pod = roundedBox(B.podW, B.podH, B.podLen, Math.min(B.podW, B.podH) * 0.42, 4);
  for (const s of [-1, 1]) parts.push({ slot: 'body', geo: pod, matrix: xform([s * (B.width * 0.5 + B.podW * 0.5 - 0.02), 0.10, B.podZ]) });

  // Pod intakes. A dark mouth ahead of the pod face is what stops the pods
  // reading as two solid bars glued to the sides.
  const intake = roundedBox(B.podW * 0.88, B.podH * 0.74, 0.12, 0.035, 2);
  for (const s of [-1, 1]) parts.push({ slot: 'darkMetal', geo: intake, matrix: xform([s * (B.width * 0.5 + B.podW * 0.5 - 0.02), 0.11, B.podZ + B.podLen * 0.5 + 0.03]) });

  // Floor tray, visible from behind under the tail and from the side at speed.
  const floor = roundedBox(B.width * 1.02, 0.05, B.len * 0.86, 0.02, 2);
  parts.push({ slot: 'darkMetal', geo: floor, matrix: xform([0, -B.deck * 0.42, -0.04]) });

  const bumperFront = roundedBox(B.width * 1.06, 0.20, 0.20, 0.09, 4);
  parts.push({ slot: 'accent', geo: bumperFront, matrix: xform([0, 0.02, half + 0.50]) });
  const splitter = roundedBox(B.width * 0.98, 0.045, 0.34, 0.02, 2);
  parts.push({ slot: 'darkMetal', geo: splitter, matrix: xform([0, -0.09, half + 0.34], [0.10, 0, 0]) });
  const bumperRear = roundedBox(B.width * 1.10, 0.24, 0.22, 0.10, 4);
  parts.push({ slot: 'accent', geo: bumperRear, matrix: xform([0, 0.08, tail - 0.02]) });

  // --- Engine top end --------------------------------------------------
  const [ew, eh, ed] = B.engine;
  const block = roundedBox(ew, eh, ed, 0.13, 4);
  parts.push({ slot: 'darkMetal', geo: block, matrix: xform([0, B.deck * 0.5 + eh * 0.5 - 0.02, -half + 0.16]) });
  const headY = B.deck * 0.5 + eh - 0.04;
  // Cooling fins: four thin plates reading as a finned head from directly
  // behind, which is the angle the player has for the whole race. Dark, with a
  // single machined cam cover on top — a stack of bright plates reads as a
  // radiator and steals the eye from the brake light below it.
  const fin = roundedBox(ew * 0.78, 0.024, ed * 0.62, 0.009, 1);
  for (let i = 0; i < 4; i++) {
    parts.push({ slot: 'darkMetal', geo: fin, matrix: xform([0, headY + i * 0.042, -half + 0.16]) });
  }
  const cover = roundedBox(ew * 0.60, 0.06, ed * 0.52, 0.025, 2);
  parts.push({ slot: 'chrome', geo: cover, matrix: xform([0, headY + 0.16, -half + 0.16]) });
  const airbox = lathe([[0.018, 0], [0.062, 0.025], [0.066, 0.09], [0.095, 0.13], [0.095, 0.145], [0, 0.145]], 12);
  parts.push({ slot: 'chrome', geo: airbox, matrix: xform([ew * 0.30, headY + 0.17, -half + 0.32], [-0.28, 0, 0]) });
  const chainCase = lathe([[0.0, 0], [0.16, 0], [0.17, 0.05], [0.10, 0.06], [0, 0.06]], 14);
  chainCase.rotateZ(Math.PI / 2);
  parts.push({ slot: 'darkMetal', geo: chainCase, matrix: xform([-ew * 0.5 - 0.02, B.deck * 0.32, -half + 0.16]) });

  // --- Exhausts --------------------------------------------------------
  // Header at the block, megaphone swept back. The profile turns back inside
  // itself at the tip so the mouth is a real bore with a lip, not a domed cap
  // that reads as a black egg from directly behind.
  const pipe = lathe([
    [0.032, 0], [0.034, 0.10], [0.060, 0.18], [0.072, 0.40],
    [0.076, 0.50], [0.062, 0.52], [0.058, 0.44], [0.056, 0.36],
  ], 12);
  pipe.rotateX(-(Math.PI / 2 - 0.30));
  for (const s of [-1, 1]) {
    parts.push({ slot: 'exhaust', geo: pipe, matrix: xform([s * ew * 0.34, B.deck * 0.5 + eh * 0.30, -half + 0.14]) });
  }

  // Roll hoop. A real kart part, and the one bright arc that stops the engine
  // bay from reading as a single black hole from directly behind.
  const hoopSide = new THREE.CylinderGeometry(0.026, 0.030, 0.34, 8);
  const hoopTop = new THREE.CylinderGeometry(0.026, 0.026, B.width * 0.52, 8);
  hoopTop.rotateZ(Math.PI / 2);
  const hoopY = 0.26 + B.seatH * 0.86;
  for (const s of [-1, 1]) parts.push({ slot: 'chrome', geo: hoopSide, matrix: xform([s * B.width * 0.26, hoopY - 0.17, -0.44], [0.13, 0, s * 0.12]) });
  parts.push({ slot: 'chrome', geo: hoopTop, matrix: xform([0, hoopY, -0.42]) });

  // --- Diffuser + lights -----------------------------------------------
  // Everything below the rear bumper. Vertical fins catch the low sun and give
  // the tail a shape instead of a flat wall.
  const kick = roundedBox(B.width * 1.06, 0.05, 0.34, 0.02, 2);
  parts.push({ slot: 'darkMetal', geo: kick, matrix: xform([0, -0.11, tail + 0.14], [-0.34, 0, 0]) });
  const vane = roundedBox(0.028, 0.16, 0.32, 0.012, 2);
  for (let i = -2; i <= 2; i++) {
    parts.push({ slot: 'darkMetal', geo: vane, matrix: xform([i * B.width * 0.22, -0.06, tail + 0.14], [-0.20, 0, 0]) });
  }
  const lampBar = roundedBox(B.width * 0.34, 0.075, 0.05, 0.028, 2);
  parts.push({ slot: 'lamp', geo: lampBar, matrix: xform([0, 0.10, tail - 0.14]) });
  const marker = roundedBox(0.08, 0.06, 0.045, 0.022, 1);
  for (const s of [-1, 1]) parts.push({ slot: 'lamp', geo: marker, matrix: xform([s * B.width * 0.47, 0.10, tail - 0.14]) });

  // --- Seat ------------------------------------------------------------
  const seatBase = roundedBox(0.60, 0.14, 0.56, 0.07, 3);
  parts.push({ slot: 'suit', geo: seatBase, matrix: xform([0, 0.26, -0.10]) });
  const seatBack = roundedBox(0.58, B.seatH, 0.16, 0.07, 3);
  parts.push({ slot: 'suit', geo: seatBack, matrix: xform([0, 0.26 + B.seatH * 0.5, -0.38], [0.13, 0, 0]) });
  const bolster = roundedBox(0.10, B.seatH * 0.72, 0.30, 0.05, 2);
  for (const s of [-1, 1]) parts.push({ slot: 'suit', geo: bolster, matrix: xform([s * 0.30, 0.30 + B.seatH * 0.42, -0.30], [0.13, 0, 0]) });

  // Steering column.
  const column = new THREE.CylinderGeometry(0.026, 0.032, 0.34, 8);
  column.rotateX(Math.PI / 2 - 0.65);
  parts.push({ slot: 'darkMetal', geo: column, matrix: xform([0, 0.48, 0.30]) });

  // --- Suspension, chassis end -----------------------------------------
  // The damper body and its top mount. The rod that runs up from the upright
  // slides inside this tube, so the pair telescopes as the body settles onto
  // the wheel instead of separating: that sliding *is* the suspension working,
  // and it is the only reason the travel now reads as travel. Merged into the
  // chassis' existing dark-metal buffer, so the whole mechanism — both ends,
  // all four corners — costs this model nothing at all.
  //
  // A wishbone would be the other obvious part to draw and is deliberately
  // absent: its inboard end pivots on the tub while its outboard end is on a
  // hub that steers thirty degrees, and nothing that spans that gap can be
  // parented to either one.
  const tube = new THREE.CylinderGeometry(0.043, 0.038, 0.24, 8);
  const topMount = roundedBox(0.10, 0.05, 0.10, 0.02, 1);
  for (const [tx, tz, r, ww] of [
    [B.track, B.wbF, FRONT_WHEEL_R * B.tyre, WHEEL_W * 0.86 * B.tyre],
    [B.rearTrack, B.wbR, WHEEL_R * B.tyre, WHEEL_W * B.tyre],
  ]) {
    for (const s of [-1, 1]) {
      // Coaxial with the rod: same inboard offset off the wheel centre, same
      // eight-degree lean. Wheel-space heights are relative to the axle, so the
      // conversion into chassis space is the axle height less the build's own
      // stance. The tube's lower half swallows the rod's upper half at rest and
      // takes the whole of the travel before they part.
      const cx = s * tx - s * ww * 0.44;
      const y0 = r - B.stance;
      parts.push({ slot: 'darkMetal', geo: tube, matrix: xform([cx + s * 0.020, y0 + 0.145, tz], [0, 0, s * 0.14]) });
      parts.push({ slot: 'darkMetal', geo: topMount, matrix: xform([cx + s * 0.036, y0 + 0.275, tz], [0, 0, s * 0.14]) });
    }
  }

  for (const w of wingParts(B, wingKind)) parts.push(w);

  const merged = mergeBySlot(parts);
  wrapUV(merged.get('body'));
  const out = { parts: merged, B };
  _chassisCache.set(key, out);
  return out;
}

/**
 * The wheel end of the suspension: upright, brake disc, and the lower half of a
 * coilover.
 *
 * There was nothing at all connecting a wheel to the chassis, which is why the
 * travel read as the wheel sliding — a wheel that moves relative to a body it
 * is not visibly attached to is a wheel that has come off. The other half of
 * the damper lives on the chassis and does not move; this rod slides up inside
 * it. That telescoping is the point, and it is why the damper is the one
 * element worth spending on: a wishbone would have to pivot about a point on
 * the tub, and anything mounted here inherits the steering yaw instead.
 *
 * Kept near the steering axis for the same reason. A strut that stands almost
 * plumb through the pivot's own origin barely moves when the front wheel turns
 * thirty degrees, so one part serves both axles.
 *
 * @param {number} inboard  -1 or +1: which way the chassis is from this wheel.
 */
function uprightParts(r, w, inboard) {
  const x = (v) => v * inboard;
  // Leaning inboard eight degrees off plumb, so the strut clears the tyre's
  // inner shoulder. A positive z rotation tips the top toward -x, so the sign
  // is the opposite of the inboard direction.
  const lean = [0, 0, -x(0.14)];
  const out = [];
  // Hub carrier: a plate on the inboard face of the wheel, reaching up to the
  // damper's lower eye. Inside the tyre's silhouette from directly behind, and
  // the whole point of the exercise from three-quarters on.
  const carrier = roundedBox(w * 0.26, r * 1.00, w * 0.58, 0.026, 1);
  out.push({ slot: 'hub', geo: carrier, matrix: xform([x(w * 0.42), 0, 0]) });
  // A brake disc and caliper were drawn here and then deleted: they sit inside
  // the rim bore behind five spokes, and they cost more triangles than the
  // whole coilover for something no frame of this game ever shows.

  // The coilover's moving half. Metres, not multiples of the tyre radius: this
  // is a chassis-scale part and it has to meet a fixed pickup on the tub
  // whatever size wheel the build runs.
  const rod = new THREE.CylinderGeometry(0.026, 0.026, 0.23, 8);
  out.push({ slot: 'hub', geo: rod, matrix: xform([x(w * 0.44), 0.085, 0], lean) });
  const seat = new THREE.CylinderGeometry(0.056, 0.056, 0.022, 10);
  out.push({ slot: 'hub', geo: seat, matrix: xform([x(w * 0.44), -0.020, 0], lean) });
  // A real helix, six sides over five turns. It is the icon that reads as
  // "suspension" at a glance; a plain sleeve reads as an exhaust.
  out.push({
    slot: 'hub', geo: coilGeometry(0.048, 0.175, 4, 5, 0.012),
    matrix: xform([x(w * 0.44), -0.012, 0], lean),
  });
  return out;
}

/**
 * Tone the merged hub buffer: rim down to a machined near-black, damper up to
 * bright steel, spring warmer still so the one part that says "suspension"
 * separates from the strut it is wound around.
 */
function paintHub(geo, rimVerts, upright) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  // Everything before `rimVerts` is the rim; after it, one span per part in the
  // order `uprightParts` built them — the last of which is the coil.
  const coilStart = n - upright[upright.length - 1].geo.attributes.position.count;
  for (let i = 0; i < n; i++) {
    let r, g, b;
    if (i < rimVerts) { r = 0.19; g = 0.20; b = 0.23; }
    else if (i >= coilStart) { r = 1.00; g = 0.78; b = 0.52; }
    else { r = 0.86; g = 0.88; b = 0.92; }
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** A helical spring: a hexagonal tube swept along a helix. */
function coilGeometry(radius, height, turns, sides, wire) {
  const steps = Math.round(turns * 5);
  const pos = [], idx = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const th = t * turns * TAU;
    const c = Math.cos(th), s = Math.sin(th);
    // Ring plane spanned by the outward radial and the world up: near enough
    // to a proper tube frame at this pitch, and a fraction of the cost.
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a) * wire, sa = Math.sin(a) * wire;
      pos.push(c * (radius + ca), t * height + sa, s * (radius + ca));
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < sides; j++) {
      const jn = (j + 1) % sides;
      const a = i * sides + j, b = i * sides + jn;
      idx.push(a, a + sides, b + sides, a, b + sides, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildWheels(scale) {
  const key = scale.toFixed(3);
  const hit = _wheelCache.get(key);
  if (hit) return hit;

  const make = (r, w, seg, inboard) => {
    const tyre = tyreGeometry(r, r * 0.56, w, seg);
    // Rim and hub in one lathe: the hub was its own draw call for a part that
    // lives entirely inside the rim's silhouette.
    const rim = lathe([
      [0.0, -w * 0.30], [r * 0.15, -w * 0.32], [r * 0.19, -w * 0.44],
      [r * 0.48, -w * 0.46], [r * 0.51, -w * 0.30], [r * 0.51, w * 0.30],
      [r * 0.48, w * 0.46], [r * 0.19, w * 0.44], [r * 0.15, w * 0.32], [0.0, w * 0.30],
    ], 20);
    rim.rotateZ(Math.PI / 2);

    // Spokes are offset before they are rotated, so each one actually spans
    // hub to rim instead of being a bar through the centre.
    const spoke = roundedBox(0.055, 0.038, r * 0.38, 0.016, 2);
    spoke.translate(0, 0, r * 0.32);
    const spokes = [];
    for (let i = 0; i < 5; i++) {
      spokes.push({ slot: 'accent', geo: spoke, matrix: xform([0, 0, 0], [(i / 5) * TAU, 0, 0]) });
    }
    // A chrome dish this size reads as a white donut from any distance; a dark
    // machined rim lets the accent spokes and the tyre carry the wheel.
    //
    // The rim rides in the `hub` slot, which the model hangs off the steering
    // pivot rather than off the spinning group. It is a surface of revolution
    // about the axle, so rotating it was never doing anything anybody could
    // see — and taking it out of the spin buys somewhere to put the upright and
    // the damper for free, in a material they already share. That is the whole
    // reason this kart can have visible suspension without a thirty-sixth draw
    // call: the parts that must not spin now have a mesh to live in.
    const upright = uprightParts(r, w, inboard);
    const parts = mergeBySlot([
      { slot: 'rubber', geo: tyre },
      { slot: 'hub', geo: rim },
      ...upright,
      ...spokes,
    ]);
    // Two very different tones out of one mesh, because the draw-call budget
    // says the rim and the suspension have to share one. The rim must stay
    // dark — a chrome dish this size reads as a white donut from any distance —
    // but a dark damper against a black tyre is a damper nobody can see, which
    // is the whole reason it is being drawn. So the material carries the bright
    // steel and the rim's own vertices multiply themselves back down.
    //
    // Index ranges rather than a position predicate: the parts overlap in every
    // axis, and `mergeBySlot` appends in the order handed to it, which is the
    // order below.
    paintHub(parts.get('hub'), rim.attributes.position.count, upright);
    // What the *distant* kart uses for the same slot. At thirty metres a 2.6 cm
    // damper rod is a third of a pixel, but the shell bakes whatever the live
    // model is carrying — so without this the LOD that exists to make far karts
    // cheap would have inherited every triangle of the suspension eleven times
    // over. The rim stays, because it is what closes the wheel's bore: drop it
    // and a distant wheel is a ring you can see the far kerb through.
    const hubShell = rim;

    // Two thin discs, one per wheel face, stand in for the spokes above the
    // speed at which five spokes strobe against a 60 Hz frame. Same mesh, same
    // draw call — only the geometry and material are swapped.
    const ring = new THREE.RingGeometry(r * 0.19, r * 0.60, 22, 2);
    const blur = mergeGeometries([
      { geo: ring, matrix: xform([-w * 0.22, 0, 0], [0, Math.PI / 2, 0]) },
      { geo: ring, matrix: xform([w * 0.22, 0, 0], [0, Math.PI / 2, 0]) },
    ]);
    return { parts, blur, hubShell };
  };

  // Four buffers, not two: the upright hangs off the inboard face, so a left
  // wheel and a right wheel are no longer the same object. Still cached per
  // tyre scale, so a twelve-kart field across three chassis sizes builds
  // twelve wheel assemblies in total.
  const out = {
    front: [make(FRONT_WHEEL_R * scale, WHEEL_W * 0.86 * scale, 26, 1),
      make(FRONT_WHEEL_R * scale, WHEEL_W * 0.86 * scale, 26, -1)],
    rear: [make(WHEEL_R * scale, WHEEL_W * scale, 30, 1),
      make(WHEEL_R * scale, WHEEL_W * scale, 30, -1)],
    rF: FRONT_WHEEL_R * scale,
    rR: WHEEL_R * scale,
  };
  _wheelCache.set(key, out);
  return out;
}

/** Helmet shells. Read from directly behind, which is the whole point. */
const HELMET_SCALE = {
  dome: [1, 1, 1],
  crest: [0.98, 1.02, 1],
  aero: [0.93, 0.97, 1.20],
  horn: [1.02, 0.98, 1],
  bucket: [1.12, 0.93, 1.04],
};

function buildHead(kind) {
  const hit = _headCache.get(kind);
  if (hit) return hit;

  // The shell is scaled before anything is added to it, so the per-kind
  // extras can be authored against the shape they actually attach to — a tail
  // fairing sized against an unscaled sphere reads as a detached cone.
  const S = HELMET_SCALE[kind] || HELMET_SCALE.dome;
  const parts = [];
  // 30 x 20, not 18 x 12. The helmet is the one part of this model that is ever
  // seen at 400 px across — the bumper camera puts the back of the player's own
  // lid in the bottom third of the frame — and at 18 segments a 0.185 m sphere
  // filling that much screen has quads over a hundred pixels wide, so it read
  // as a faceted ball with visible polygon edges rather than as a gloss shell.
  // The cost is paid once: heads are cached by kind and shared by every kart
  // wearing one, and past LOD_DISTANCE the whole model is a baked shell anyway.
  const shell = new THREE.SphereGeometry(0.185, 26, 16, 0, TAU, 0, Math.PI * 0.86);
  shell.scale(S[0], S[1], S[2]);
  parts.push({ slot: 'helmet', geo: shell });
  // Chin bar: without it the "helmet" is a bowl balanced on a face.
  const chin = roundedBox(0.24 * S[0], 0.10, 0.16, 0.045, 3);
  parts.push({ slot: 'helmet', geo: chin, matrix: xform([0, -0.10, 0.115 * S[2]], [0.30, 0, 0]) });

  switch (kind) {
    case 'crest': {
      const fin = roundedBox(0.045, 0.11, 0.30, 0.02, 2);
      parts.push({ slot: 'helmet', geo: fin, matrix: xform([0, 0.155, -0.02], [0.10, 0, 0]) });
      break;
    }
    case 'aero': {
      // The shell is already a teardrop; this is only the trailing fairing,
      // and it starts well inside the shell so the two read as one moulding.
      const tailG = lathe([[0.0, 0], [0.125, 0.01], [0.115, 0.06], [0.07, 0.14], [0, 0.17]], 20);
      tailG.rotateX(-Math.PI / 2 + 0.20);
      parts.push({ slot: 'helmet', geo: tailG, matrix: xform([0, 0.045, -0.13]) });
      break;
    }
    case 'horn': {
      const horn = lathe([[0.0, 0], [0.055, 0.01], [0.038, 0.09], [0, 0.15]], 8);
      for (const s of [-1, 1]) parts.push({ slot: 'helmet', geo: horn, matrix: xform([s * 0.15, 0.10, -0.02], [0, 0, -s * 1.05]) });
      break;
    }
    case 'bucket': {
      // Wide and flat-topped, with a peak. Reads heavy even in silhouette.
      const peak = roundedBox(0.32, 0.035, 0.15, 0.016, 2);
      parts.push({ slot: 'helmet', geo: peak, matrix: xform([0, 0.045, 0.16], [-0.30, 0, 0]) });
      const collar = lathe([[0.18, 0], [0.215, 0.015], [0.215, 0.05], [0.18, 0.06]], 14);
      parts.push({ slot: 'helmet', geo: collar, matrix: xform([0, -0.155, 0]) });
      break;
    }
    default: break; // 'dome'
  }

  const helmet = mergeBySlot(parts).get('helmet');
  const face = new THREE.SphereGeometry(0.145, 16, 10);
  // SphereGeometry's phi=0 is -X, so the visor aperture has to start a quarter
  // turn round or the driver ends up looking out of the side of the lid. The
  // radius also has to clear the shell — inside it, the visor is invisible,
  // which is what left every driver in this game faceless.
  const visor = new THREE.SphereGeometry(0.194, 26, 10, Math.PI / 2 - 0.98, 1.96, Math.PI * 0.29, Math.PI * 0.24);
  visor.scale(S[0], S[1], S[2]);
  const out = { helmet, face, visor };
  _headCache.set(kind, out);
  return out;
}

function buildDriver() {
  if (_driverGeo) return _driverGeo;

  const torso = capsule(0.205, 0.28, 12, 6);
  const chest = roundedBox(0.40, 0.20, 0.26, 0.10, 3);
  const legG = capsule(0.078, 0.20, 8, 4);
  const boot = roundedBox(0.12, 0.10, 0.20, 0.045, 2);

  const body = mergeBySlot([
    { slot: 'suit', geo: torso, matrix: xform([0, 0.30, 0], [-0.20, 0, 0]) },
    { slot: 'suit', geo: chest, matrix: xform([0, 0.46, 0.03], [-0.16, 0, 0]) },
    { slot: 'suit', geo: legG, matrix: xform([-0.13, 0.13, 0.30], [1.35, 0, 0]) },
    { slot: 'suit', geo: legG, matrix: xform([0.13, 0.13, 0.30], [1.35, 0, 0]) },
    { slot: 'suit', geo: boot, matrix: xform([-0.14, 0.05, 0.50], [0.35, 0, 0]) },
    { slot: 'suit', geo: boot, matrix: xform([0.14, 0.05, 0.50], [0.35, 0, 0]) },
  ]);

  // Arm hangs from the shoulder along -Y so the rig can aim it at the wheel by
  // rotating the socket and stretching it to reach.
  const arm = mergeGeometries([
    { geo: new THREE.SphereGeometry(0.066, 8, 6), matrix: xform([0, 0, 0]) },
    { geo: capsule(0.058, 0.16, 8, 4), matrix: xform([0, -0.13, 0.015], [-0.05, 0, 0]) },
    { geo: capsule(0.047, 0.15, 8, 4), matrix: xform([0, -0.33, -0.005], [0.04, 0, 0]) },
  ]);
  // Glove wraps the rim: long on the tangent axis, thin across the wheel, with
  // a knuckle ridge on the outboard face. Symmetric, so one buffer serves both
  // hands without a mirrored (and therefore inside-out) copy.
  const glove = mergeGeometries([
    { geo: roundedBox(0.085, 0.125, 0.10, 0.038, 2), matrix: xform([0, 0, 0]) },
    { geo: roundedBox(0.045, 0.105, 0.028, 0.014, 1), matrix: xform([0.048, 0.012, 0]) },
  ]);

  _driverGeo = { body, arm, glove };
  return _driverGeo;
}

function buildSteering() {
  const rim = new THREE.TorusGeometry(STEER_R, 0.026, 7, 16);
  const spokeG = roundedBox(0.24, 0.024, 0.034, 0.011, 2);
  const boss = new THREE.CylinderGeometry(0.045, 0.038, 0.05, 8);
  boss.rotateX(Math.PI / 2);
  return mergeBySlot([
    { slot: 'darkMetal', geo: rim },
    { slot: 'chrome', geo: spokeG, matrix: xform([0, 0, 0], [0, 0, 0.35]) },
    { slot: 'chrome', geo: spokeG, matrix: xform([0, 0, 0], [0, 0, TAU / 3 + 0.35]) },
    { slot: 'chrome', geo: spokeG, matrix: xform([0, 0, 0], [0, 0, (TAU * 2) / 3 + 0.35]) },
    { slot: 'chrome', geo: boss },
  ]);
}

let _steeringGeo = null;

// ---------------------------------------------------------------------------
// Contact occlusion
// ---------------------------------------------------------------------------

/**
 * Four elliptical AO patches, one per tyre, in one buffer.
 *
 * A cast shadow says where the sun is. Contact occlusion says the tyre is
 * *touching*, and the two are not interchangeable: the shadow map only covers a
 * box around the player, it slides away from the tyre entirely at a low sun,
 * and on the void track there is no ground to receive one at all — so without
 * this a kart is a sticker on the road no matter how good its shadow is.
 *
 * The falloff lives in a per-vertex weight rather than in a texture, which is
 * what lets all four patches share one draw call and still respond
 * independently to load: the update loop rewrites 168 colours, not a transform.
 *
 * Ring radii matter more than they look. A patch the size of the contact patch
 * is perfectly hidden by the tyre that casts it — that is exactly the geometry
 * of the problem — so the opaque core sits inside the footprint and the soft
 * half spills onto road the tyre does not cover.
 */
const CONTACT_SEGS = 14;
// Flat-topped rather than a smooth bell. The dark core has to reach past the
// tyre's own footprint before it starts falling off, or the only part of the
// patch anybody ever sees is its faintest quarter — measured on tarmac, a
// bell profile put 16% of darkening on the visible ring and 55% under the
// rubber.
const CONTACT_RINGS = [[0.55, 1.0], [0.80, 0.62], [1.0, 0.0]];

function contactGeometry(defs) {
  const pos = [], shade = [], wheel = [], idx = [];
  for (let d = 0; d < defs.length; d++) {
    const { x, z, halfX, halfZ } = defs[d];
    const base = pos.length / 3;
    pos.push(x, 0, z); shade.push(1); wheel.push(d);
    for (const [r, sh] of CONTACT_RINGS) {
      for (let j = 0; j < CONTACT_SEGS; j++) {
        const th = (j / CONTACT_SEGS) * TAU;
        pos.push(x + Math.cos(th) * halfX * r, 0, z + Math.sin(th) * halfZ * r);
        shade.push(sh);
        wheel.push(d);
      }
    }
    // Fan from the centre to the inner ring, then a strip between each pair.
    for (let j = 0; j < CONTACT_SEGS; j++) {
      const a = base + 1 + j, b = base + 1 + ((j + 1) % CONTACT_SEGS);
      idx.push(base, b, a);
    }
    for (let r = 0; r < CONTACT_RINGS.length - 1; r++) {
      const i0 = base + 1 + r * CONTACT_SEGS, i1 = i0 + CONTACT_SEGS;
      for (let j = 0; j < CONTACT_SEGS; j++) {
        const jn = (j + 1) % CONTACT_SEGS;
        idx.push(i0 + j, i1 + jn, i1 + j, i0 + j, i0 + jn, i1 + jn);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(shade.length * 3).fill(1), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return { geo, shade: Float32Array.from(shade), wheel: Uint8Array.from(wheel) };
}

/**
 * Multiply-blended, because the thing under it is asphalt on one track, sand on
 * another and a saturated rainbow on the third. An alpha blend toward any fixed
 * dark colour desaturates whatever it lands on, which on Rainbow Skyway reads as
 * haze rather than as occlusion; a multiply darkens green road to dark green.
 *
 * Fog is undone by hand for the same reason `blobMaterial` in SceneryKit does:
 * three's fog mixes toward the fog colour, and a multiplier faded toward grey is
 * still a multiplier, so a rival forty metres up the road would stamp a hard
 * dark ellipse onto a wall of haze. The density arrives as a uniform because
 * nothing hands this model the scene it will be added to.
 */
function contactMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true,
    blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    depthWrite: false, toneMapped: false, fog: false,
    // Coplanar with a road the kart is also standing on: without this the patch
    // stipples in and out along the tyre's own contact line.
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  mat.userData.uFog = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFogDensity = mat.userData.uFog;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFogDensity;\nvarying float vClear;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { float fd = uFogDensity * max(-mvPosition.z, 0.0); vClear = 1.0 - exp(-fd * fd); }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vClear;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), vClear);');
  };
  mat.customProgramCacheKey = () => 'kartContact';
  return mat;
}

// ---------------------------------------------------------------------------
// Level of detail
// ---------------------------------------------------------------------------

/**
 * Where a kart stops being a machine and becomes a shape.
 *
 * Measured, not guessed: at 30 m a metre is ~34 px, so the largest thing the
 * detailed model animates that the shell does not — the driver's head, which
 * swings about 5 cm into a corner — is under two pixels, and suspension travel
 * is one. Everything else (wheel spin, the steering rack, the arms) is smaller
 * still. The hysteresis band means a rival trading places at the boundary
 * cannot flicker: it has to come 3.6 m closer to earn the detailed model back.
 */
const LOD_DISTANCE = 30;
const LOD_HYSTERESIS = 0.12;

/**
 * Material slot -> shell slot.
 *
 * The shell is one draw per entry in the *range* of this map, so every merge
 * here has to be paid for in fidelity somewhere. These five survived that
 * trade. Paint carries the livery and is the kart's identity. Accent is the
 * second identity channel, and the helmet is already the accent colour — so is
 * chrome, near enough, once a 4 cm roll hoop is thirty metres away. The brake
 * bar stays separate because it is emissive and animated by braking. The
 * driver's suit stays separate because it is a saturated character colour over
 * a large area, and folding it into the dark mass was the one merge that
 * showed: measured, the driver's back was the single biggest delta across the
 * switch. Everything genuinely dark — tyres, floor, diffuser, engine,
 * exhausts, the visor — reads as one mass and is drawn as one.
 */
const LOD_SLOT = {
  body: 'body',
  accent: 'accent',
  helmet: 'accent',
  chrome: 'lodDark',
  suit: 'suit',
  lamp: 'lamp',
  darkMetal: 'lodDark',
  hub: 'lodDark',
  exhaust: 'lodDark',
  rubber: 'lodDark',
  skin: 'lodDark',
  glass: 'lodDark',
};

/**
 * Which slots cast into the shadow map, up close and at distance.
 *
 * The shadow pass re-draws every caster, so it was costing as much as the
 * scene itself. A slot only earns a place here if it widens the silhouette the
 * others already project: the roll hoop, the exhausts, the brake bar, the
 * steering rack, the arms and the wheel internals all fall inside the hull,
 * the tyres and the driver's back, and their shadows were never visible.
 */
const NEAR_CASTERS = new Set(['body', 'accent', 'darkMetal', 'suit', 'helmet', 'rubber']);
const SHELL_CASTERS = new Set(['body', 'accent', 'lodDark']);
const _NO_CAST = new Set();

const _shellCache = new Map();

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function makeMaterials(character, envMap) {
  const liv = liveryTextures(character);
  const tyre = tyreTextures();

  // The livery map carries the actual paint colour, so the base colour stays
  // white; the mask drives clearcoat in red and roughness in green.
  const body = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: liv.map,
    roughnessMap: liv.mask,
    clearcoatMap: liv.mask,
    metalness: 0.22,
    roughness: 1.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.07,
    envMapIntensity: 1.25,
    sheen: 0.25,
    sheenColor: new THREE.Color(character.accent).multiplyScalar(0.4),
  });
  const accent = new THREE.MeshPhysicalMaterial({
    color: character.accent,
    metalness: 0.35,
    roughness: 0.30,
    clearcoat: 0.85,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.2,
  });
  const helmet = new THREE.MeshPhysicalMaterial({
    color: character.accent,
    metalness: 0.3,
    roughness: 0.20,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.3,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tyre.map,
    normalMap: tyre.normalMap,
    roughnessMap: tyre.roughnessMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    metalness: 0.0, roughness: 1.0, envMapIntensity: 0.5,
  });
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xd8dde4, metalness: 1.0, roughness: 0.16, envMapIntensity: 1.6,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x30343c, metalness: 0.85, roughness: 0.42, envMapIntensity: 1.0,
  });
  // Suspension, upright and rim. Its own slot only so that the mesh carrying
  // it can hang off the steering pivot rather than the spinning group;
  // slightly darker and rougher than the bodywork's dark metal because it is
  // the part of the kart that lives in the wheel well and never sees sky.
  const hub = new THREE.MeshStandardMaterial({
    color: 0x8b939c, metalness: 0.78, roughness: 0.40, envMapIntensity: 0.9,
    vertexColors: true,
  });
  const exhaust = new THREE.MeshStandardMaterial({
    map: exhaustTexture(), color: 0xffffff, metalness: 0.95, roughness: 0.30, envMapIntensity: 1.5,
  });
  const lamp = new THREE.MeshStandardMaterial({
    color: 0x2a0508, emissive: 0xff2a14, emissiveIntensity: 0.5,
    metalness: 0.2, roughness: 0.35,
  });
  const blur = new THREE.MeshStandardMaterial({
    map: wheelBlurTexture(), color: character.accent,
    metalness: 0.5, roughness: 0.55, envMapIntensity: 0.9, side: THREE.DoubleSide,
  });
  // A tinted visor, deliberately NOT a transmissive one. Three renders an
  // entire extra opaque pass over the whole scene the moment any material in
  // it has transmission > 0 — measured at 328 draw calls a frame, a third of
  // everything submitted, so twelve sub-pixel visors could refract a beach
  // they were already too dark to show. Alpha over the face plus a hard
  // clearcoat reflection lands in the same place for free.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0d141c, metalness: 0.25, roughness: 0.05,
    clearcoat: 1.0, clearcoatRoughness: 0.03,
    envMapIntensity: 2.0, transparent: true, opacity: 0.86,
  });
  const suit = new THREE.MeshStandardMaterial({
    color: new THREE.Color(character.color).lerp(new THREE.Color(0x101018), 0.45),
    metalness: 0.05, roughness: 0.62, envMapIntensity: 0.8,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: 0xe8b48c, metalness: 0.0, roughness: 0.55, envMapIntensity: 0.7,
  });
  const glow = new THREE.MeshBasicMaterial({ color: character.accent });

  // The distant kart's one dark mass. Tuned toward rubber rather than toward
  // dark metal, because four tyres and the floor are most of the area it stands
  // in for and a metallic tyre catches the sun in a way nothing on a kart
  // should. The colour is the tread's own mid-tone, not dark metal's.
  const lodDark = new THREE.MeshStandardMaterial({
    color: 0x2e3239, metalness: 0.28, roughness: 0.64, envMapIntensity: 0.58,
  });

  const all = [body, accent, helmet, rubber, chrome, darkMetal, hub, exhaust, lamp, blur, glass, suit, skin, lodDark];
  if (envMap) for (const m of all) { m.envMap = envMap; m.needsUpdate = true; }
  return { body, accent, helmet, rubber, chrome, darkMetal, hub, exhaust, lamp, blur, glass, suit, skin, lodDark, glow, all };
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _m1 = new THREE.Matrix4();
const _DOWN = new THREE.Vector3(0, -1, 0);
const _ONE = new THREE.Vector3(1, 1, 1);
const _WHITE = new THREE.Color(0xffffff);
// Dust lifts the tyre above its own albedo, which multiplication alone cannot
// do — so the dirty target deliberately sits above 1.
const _DUST = new THREE.Color(3.4, 2.7, 1.9);

/**
 * A stable 0..TAU phase from a character id.
 *
 * Anything that wants per-instance variation has to get it from something the
 * simulation already knows, not from Math.random() — otherwise two runs of the
 * same seed differ, and every visual comparison inherits that noise.
 */
function hashPhase(id = '') {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967296) * TAU;
}

export class KartModel {
  constructor(character, opts = {}) {
    this.character = character;
    const buildKey = character.build || 'gt';
    const { parts: chassis, B } = buildChassis(buildKey, character.wing || 'gt');
    this.B = B;
    const wheels = buildWheels(B.tyre);
    const head = buildHead(character.helmet || 'dome');
    const driverGeo = buildDriver();
    if (!_steeringGeo) _steeringGeo = buildSteering();

    this.mats = makeMaterials(character, opts.envMap);
    this.group = new THREE.Group();
    this.group.name = `kart_${character.id}`;

    // `body` carries all lean/squash animation; `root` carries world placement
    // so physics never fights the presentation transforms.
    this.body = new THREE.Group();
    this.body.position.y = -RIDE_DROP;
    this.group.add(this.body);

    // The LOD sits *under* `body`, so swapping detail levels never costs the
    // kart its lean, pitch, squash or trick spin. Three's renderer calls
    // LOD.update() itself while it walks the graph, which is the only reason a
    // model that is never handed a camera can switch on camera distance.
    this.lod = new THREE.LOD();
    this.body.add(this.lod);
    this.detail = new THREE.Group();
    this.lod.addLevel(this.detail, 0, LOD_HYSTERESIS);

    // Bodywork rides on `chassis` so a build can sit high or low over wheels
    // that always keep their contact plane at body y = 0.
    this.chassis = new THREE.Group();
    this.chassis.position.y = B.stance;
    this.detail.add(this.chassis);

    const M = this.mats;
    // Every mesh is recorded against its material slot, because the shell is
    // baked by reading this model's own rest pose back out rather than by
    // authoring the whole kart a second time.
    this._parts = [];
    const add = (geo, slot, parent, cast) => {
      const mesh = new THREE.Mesh(geo, M[slot]);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      parent.add(mesh);
      this._parts.push({ mesh, slot });
      return mesh;
    };

    /** Instantiate a pre-merged assembly: one mesh per material slot. */
    const addMerged = (assembly, parent, casters) => {
      for (const [slot, geo] of assembly) add(geo, slot, parent, casters.has(slot));
    };

    addMerged(chassis, this.chassis, NEAR_CASTERS);

    // Steering wheel assembly.
    this.steering = new THREE.Group();
    this.steering.position.set(0, 0.60, 0.42);
    this.steering.rotation.x = -0.65;
    this.chassis.add(this.steering);
    // Nothing in the cockpit casts: the rack, the rim and the driver's arms all
    // sit inside the shadow the hull and the driver's back already throw.
    addMerged(_steeringGeo, this.steering, _NO_CAST);

    // --- Wheels ---------------------------------------------------------
    // Order: FL, FR, RL, RR — matches `kart.suspension`.
    this.wheels = [];
    const wheelDefs = [
      { pos: [-B.track, wheels.rF, B.wbF], front: true },
      { pos: [B.track, wheels.rF, B.wbF], front: true },
      { pos: [-B.rearTrack, wheels.rR, B.wbR], front: false },
      { pos: [B.rearTrack, wheels.rR, B.wbR], front: false },
    ];
    for (const def of wheelDefs) {
      const pivot = new THREE.Group();          // steering + upright
      pivot.position.set(...def.pos);
      const spin = new THREE.Group();           // rolling
      pivot.add(spin);
      this.detail.add(pivot);

      const src = (def.front ? wheels.front : wheels.rear)[def.pos[0] < 0 ? 0 : 1];
      let spokeMesh = null;
      for (const [slot, geo] of src.parts) {
        // Only the tyre casts: the rim, spokes and upright sit inside its
        // silhouette, so shadowing them again buys nothing but shadow-pass
        // draw calls. `hub` is everything that steers but does not roll.
        const mesh = add(geo, slot, slot === 'hub' ? pivot : spin, slot === 'rubber');
        if (slot === 'hub') mesh.userData.shellGeo = src.hubShell;
        if (slot === 'accent') spokeMesh = mesh;
      }
      this.wheels.push({
        pivot, spin, front: def.front, base: pivot.position.clone(),
        radius: def.front ? wheels.rF : wheels.rR,
        halfW: (def.front ? WHEEL_W * 0.86 : WHEEL_W) * B.tyre * 0.5,
        spokeMesh, spokeGeo: spokeMesh.geometry, blurGeo: src.blur, blurred: false,
      });
    }

    // --- Contact occlusion ------------------------------------------------
    // Parented to `group`, not to `body`: the patches belong to the road, so
    // they must not inherit lean, pitch, squash or a trick spin. Outside the
    // LOD as well — a kart at 200 m still has to be standing on something, and
    // this is one draw call whichever level is showing.
    // Elongated along the kart, and sized off the tyre's *radius* fore and aft
    // rather than off its width. Seen from a chase camera the tyre's own
    // silhouette covers the ground from the contact point back roughly one
    // radius, so a patch that stops at the radius is a patch nobody ever sees;
    // the visible half is the part that clears the tyre.
    const contact = contactGeometry(this.wheels.map((w) => ({
      x: w.base.x, z: w.base.z,
      halfX: w.halfW + 0.28, halfZ: w.radius + 0.26,
    })));
    this._contactShade = contact.shade;
    this._contactWheel = contact.wheel;
    this._contactStr = new Float32Array(4);
    // Deliberately not in `mats.all`: that list exists to receive the
    // environment map, and an env map on an unlit multiply quad tints the
    // occlusion with the sky.
    this._contactMat = contactMaterial();
    this.contact = new THREE.Mesh(contact.geo, this._contactMat);
    this.contact.name = 'contactAO';   // nameable so `shot.mjs --hide` isolates it
    this.contact.renderOrder = 2;      // before the FX blob; multiply commutes
    this.group.add(this.contact);

    // --- Driver ---------------------------------------------------------
    this.driver = new THREE.Group();
    this.driver.position.set(0, 0.44, -0.06);
    const bulk = character.cls === 'heavy' ? 1.12 : character.cls === 'light' ? 0.92 : 1.0;
    this.driver.scale.set(bulk, character.cls === 'light' ? 1.04 : 1.0, bulk);
    this.chassis.add(this.driver);
    this._driverBase = this.driver.position.clone();

    addMerged(driverGeo.body, this.driver, NEAR_CASTERS);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.60, 0.02);
    this.driver.add(this.headGroup);
    // The helmet is the whole head as far as the shadow map is concerned; the
    // face and the visor live inside it.
    add(head.face, 'skin', this.headGroup, false).position.set(0, -0.015, 0.012);
    add(head.helmet, 'helmet', this.headGroup, true).position.y = 0.015;
    add(head.visor, 'glass', this.headGroup, false).position.set(0, 0.015, 0);

    // Shoulder sockets aim the arms; the gloves are solved onto the rim
    // separately so a hand is never merely *near* the wheel.
    this.arms = [];
    this.hands = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.205, 0.44, 0.035);
      this.driver.add(shoulder);
      const a = add(driverGeo.arm, 'suit', shoulder, false);
      this.arms.push(shoulder);
      shoulder.userData.mesh = a;
      this.hands.push(add(driverGeo.glove, 'accent', this.driver, false));
    }

    // --- Effect anchors --------------------------------------------------
    // Other systems (sparks, exhaust, boost flame, item mounts) attach here
    // instead of guessing at local offsets.
    this.anchors = {
      exhaustL: new THREE.Object3D(),
      exhaustR: new THREE.Object3D(),
      driftL: new THREE.Object3D(),
      driftR: new THREE.Object3D(),
      item: new THREE.Object3D(),
      nose: new THREE.Object3D(),
      center: new THREE.Object3D(),
    };
    const halfLen = B.len * 0.5;
    const eOff = B.engine[0] * 0.30;
    this.anchors.exhaustL.position.set(-eOff, B.deck * 0.5 + B.engine[1] * 0.55 + 0.10, -halfLen - 0.48);
    this.anchors.exhaustR.position.set(eOff, B.deck * 0.5 + B.engine[1] * 0.55 + 0.10, -halfLen - 0.48);
    this.anchors.item.position.set(0, 0.30, -halfLen - 0.45);
    this.anchors.nose.position.set(0, 0.20, halfLen + 0.62);
    this.anchors.center.position.set(0, 0.45, 0);
    for (const k of ['exhaustL', 'exhaustR', 'item', 'nose', 'center']) this.chassis.add(this.anchors[k]);
    // Drift sparks come off the rear contact patches, which do not move with
    // the bodywork.
    this.anchors.driftL.position.set(-B.rearTrack, 0.10, B.wbR);
    this.anchors.driftR.position.set(B.rearTrack, 0.10, B.wbR);
    this.body.add(this.anchors.driftL);
    this.body.add(this.anchors.driftR);

    this.group.matrixAutoUpdate = true;

    this._leanZ = 0;
    this._pitch = 0;
    // Seeded off the character, not Math.random(). The idle bob only shows on
    // a stationary kart, which is exactly the start grid — so a random phase
    // meant every capture of the grid differed from the last for a reason no
    // reviewer could see or attribute.
    this._bob = hashPhase(character.id);
    this._t = 0;
    this._gLat = 0;
    this._gLong = 0;
    this._jolt = 0;
    this._joltPhase = 0;
    this._prevSpeed = 0;
    this._impactPrev = 0;
    this._dirt = 0;
    this._brake = 0;

    // The gloves are solved onto the rim rather than authored on it, so the rig
    // has to be posed once before anything reads the model's rest state — an
    // unposed bake puts both hands inside the driver's chest.
    this._solveHands();
    this._buildShell(`${buildKey}|${character.wing || 'gt'}|${character.helmet || 'dome'}|${character.cls}`);
  }

  /**
   * Bake the whole kart, at rest, into one merged buffer per shell slot.
   *
   * Read back out of the live model rather than authored a second time: that
   * way a build, a wing, a helmet or a livery added upstream lands in the shell
   * automatically, and the shell can never drift out of agreement with the
   * thing it stands in for. Cached by silhouette, so a twelve-kart field with
   * repeated characters still only merges each distinct kart once.
   */
  _buildShell(key) {
    let slots = _shellCache.get(key);
    if (!slots) {
      this.group.updateMatrixWorld(true);
      const toBody = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
      const lists = new Map();
      for (const { mesh, slot } of this._parts) {
        const dst = LOD_SLOT[slot] || 'lodDark';
        if (!lists.has(dst)) lists.set(dst, []);
        lists.get(dst).push({
          // `shellGeo` lets a slot hand the distant model a cheaper stand-in
          // than the one it is drawing up close, without a second authoring
          // pass and without the two ever disagreeing about where it sits.
          geo: mesh.userData.shellGeo || mesh.geometry,
          matrix: new THREE.Matrix4().multiplyMatrices(toBody, mesh.matrixWorld),
        });
      }
      slots = new Map();
      for (const [slot, list] of lists) slots.set(slot, mergeGeometries(list));
      _shellCache.set(key, slots);
    }

    this.shell = new THREE.Group();
    for (const [slot, geo] of slots) {
      const mesh = new THREE.Mesh(geo, this.mats[slot]);
      mesh.castShadow = SHELL_CASTERS.has(slot);
      mesh.receiveShadow = true;
      this.shell.add(mesh);
    }
    this.lod.addLevel(this.shell, LOD_DISTANCE, LOD_HYSTERESIS);
  }

  setEnvMap(envMap) {
    for (const m of this.mats.all) { m.envMap = envMap; m.needsUpdate = true; }
  }

  /**
   * @param {import('./Kart.js').Kart} kart
   * @param {number} dt   frame delta (presentation, not fixed)
   */
  update(kart, dt) {
    const g = this.group;

    // Wheels ------------------------------------------------------------
    //
    // Suspension is expressed on the *chassis*, not on the wheels. The old sign
    // was inside out: it moved each wheel down by the compression, so a landing
    // drove all four tyres up to 13 cm through the road and the travel read as
    // the wheel sliding rather than as anything supporting the kart. A wheel in
    // contact does not move — the body settles onto it. Kart space has its
    // origin on the contact plane, so "planted" here is literally y = 0.
    const speed = Math.abs(kart.speed);
    const air = kart.grounded ? 0 : 1;
    let sagSum = 0, sagPitch = 0, sagRoll = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.spin.rotation.x = -kart.wheelSpin * (WHEEL_R / w.radius);
      if (w.front) w.pivot.rotation.y = kart.wheelSteer * 0.52;

      // The simulation compresses all four corners equally on a landing and
      // never differentiates them, so the per-corner half is derived here from
      // weight transfer — presentation only, and nothing is written back. The
      // loaded corners are the ones the driver's mass is thrown toward, which
      // is the same quantity the rig already solves for.
      const xfer = clamp(
        -Math.sign(w.base.x) * this._gLat * 0.60
        - Math.sign(w.base.z) * this._gLong * 0.55, -1, 1);
      // Airborne, every corner extends: the body floats up off the wheels
      // rather than the wheels dangling, which is the same picture and costs
      // no per-wheel transform.
      const sag = kart.suspension[i] * 0.075 + xfer * 0.026 - air * 0.045;
      sagSum += sag * 0.25;
      sagPitch += (w.front ? sag : -sag) * 0.5;
      sagRoll += (w.base.x < 0 ? sag : -sag) * 0.5;

      // The tyre still flattens under load — real squash is a couple of
      // centimetres, more than that reads as a bug — but about the contact
      // patch, so the footprint stays exactly where the road is.
      const load = clamp01(kart.suspension[i] * 0.9 + Math.abs(this._gLat) * 0.25);
      const sq = 1 - load * 0.055;
      w.pivot.scale.y = sq;
      w.pivot.position.y = w.radius * sq;

      // Contact occlusion tracks the same load: a corner carrying weight has a
      // wider, darker patch than one going light. That is the only per-wheel
      // compression cue that survives being seen from a chase camera.
      this._contactStr[i] = clamp(0.86 + sag * 3.2, 0.42, 1.0);

      // Five spokes at racing speed alias into a standing wave. Past the
      // threshold the same mesh draws a smear disc instead — no extra call.
      // Measured in rad/s, so a small wheel switches over at a lower speed.
      const spinRate = speed / w.radius;
      const wantBlur = spinRate > (w.blurred ? 24 : 31);
      if (wantBlur !== w.blurred) {
        w.blurred = wantBlur;
        w.spokeMesh.geometry = wantBlur ? w.blurGeo : w.spokeGeo;
        w.spokeMesh.material = wantBlur ? this.mats.blur : this.mats.accent;
      }
    }
    // In three's convention a positive x rotation drops +z, which is the nose,
    // and a positive z rotation drops -x, which is the left. Both are divided
    // by the span they act over, so the angles are the ones the travel actually
    // implies rather than a hand-picked gain.
    this.chassis.position.y = this.B.stance - sagSum;
    this.chassis.rotation.x = sagPitch / (this.B.wbF - this.B.wbR);
    this.chassis.rotation.z = sagRoll / (this.B.track + this.B.rearTrack);

    this._updateContact(kart);

    // Body attitude -----------------------------------------------------
    // Roll into the corner, pitch under acceleration/braking, plus a small
    // idle bob so a stationary kart is never dead-still.
    const targetLean = -kart.drift.bodyAngle * 0.42
      - kart.wheelSteer * clamp01(kart.speed / 20) * 0.10;
    this._leanZ = damp(this._leanZ, targetLean, 9, dt);

    const accelPitch = clamp((kart.boostActive ? -0.06 : 0) + kart.lastImpact * 0.09, -0.12, 0.12);
    const airPitch = kart.grounded ? 0 : clamp(-kart.vy * 0.018, -0.16, 0.16);
    this._pitch = damp(this._pitch, accelPitch + airPitch, 8, dt);

    this._bob += dt * 2.2;
    const idleBob = kart.grounded && Math.abs(kart.speed) < 0.5 ? Math.sin(this._bob) * 0.006 : 0;

    this.body.rotation.z = this._leanZ;
    this.body.rotation.x = this._pitch;
    this.body.position.y = idleBob - RIDE_DROP;

    // Tricks ------------------------------------------------------------
    if (kart.trick.playing) {
      const t = clamp01(kart.trick.t / 0.55);
      const e = smoothstep(t);
      switch (kart.trick.kind) {
        case 0: this.body.rotation.x = this._pitch - e * TAU; break;
        case 1: this.body.rotation.z = this._leanZ + e * TAU; break;
        case 2: this.body.rotation.z = this._leanZ - e * TAU; break;
        default: this.body.rotation.y = e * TAU; break;
      }
    } else {
      this.body.rotation.y = damp(this.body.rotation.y, 0, 12, dt);
    }

    // Squash (from a Thunder hit) ---------------------------------------
    const sq = kart.squash;
    if (sq > 0) {
      const k = smoothstep(clamp01(sq));
      this.body.scale.set(lerp(1, 1.55, k), lerp(1, 0.24, k), lerp(1, 1.55, k));
    } else {
      this.body.scale.lerp(_ONE, 1 - Math.exp(-10 * dt));
    }

    this._updateDriver(kart, dt);
    this._updateSurfaces(kart, dt);

    // Star power: the whole kart flashes through the rainbow.
    //
    // Driven off accumulated dt rather than performance.now(). The wall clock
    // put the body colour of every starred kart somewhere different on every
    // run, which is the same defect already removed from ChaseCamera and the
    // HUD countdown — and it is the last one that survived to make long seeks
    // non-reproducible.
    this._t += dt;
    if (kart.star > 0) {
      const hue = (this._t * 1.2) % 1;
      this.mats.body.emissive.setHSL(hue, 0.9, 0.35);
      this.mats.body.emissiveIntensity = 1.4;
      this.mats.accent.emissive.setHSL((hue + 0.4) % 1, 0.9, 0.35);
    } else if (this.mats.body.emissiveIntensity !== 0) {
      this.mats.body.emissive.setRGB(0, 0, 0);
      this.mats.body.emissiveIntensity = 0;
      this.mats.accent.emissive.setRGB(0, 0, 0);
    }

    // Invulnerability blink after a respawn.
    const blink = kart.invuln > 0 ? (Math.sin(kart.invuln * 40) > 0 ? 0.25 : 1) : 1;
    if (this._blink !== blink) {
      this._blink = blink;
      // The contact patches are exempt. This sweep asserts `transparent` for
      // every mesh under the kart, and it was silently turning the multiply
      // blend off on the first frame of every race — the patches were built,
      // updated and submitted, and rendered zero pixels.
      g.traverse((o) => { if (o.isMesh && o !== this.contact && o.material.opacity !== undefined) {
        o.material.transparent = blink < 1 || o.material === this.mats.glass;
        if (o.material !== this.mats.glass) o.material.opacity = blink;
      } });
    }
  }

  /**
   * Re-shade the four contact patches.
   *
   * One buffer upload of 168 colours per kart per frame, against one draw call
   * — the alternative, a mesh per corner, is four draws on a model with one to
   * spare. Nothing here writes to the simulation.
   */
  _updateContact(kart) {
    // The patches belong to the road surface, so they follow the ground rather
    // than the kart: over a crest or on a hop the kart's origin lifts and they
    // stay put, and past a wheel radius of altitude there is no contact left to
    // draw and the FX blob is the only honest cue.
    const gh = kart.ground ? kart.ground.height : undefined;
    const alt = gh === undefined ? 0 : this.group.position.y - gh - RIDE_DROP;
    const fade = 1 - clamp01((alt - 0.02) / 0.30);
    // Written on the edge, not every frame: an unconditional assignment here
    // would quietly undo `shot.mjs --hide contactAO` and make the one
    // measurement that can prove this feature draws anything report a
    // pixel-identical pair for the wrong reason.
    const want = fade > 0.001;
    if (this._contactOn !== want) { this._contactOn = want; this.contact.visible = want; }
    if (!want) return;
    this.contact.position.y = 0.014 - RIDE_DROP - clamp(alt, 0, 0.32);

    // Fog density is read from whatever scene the kart was added to, once: the
    // model is handed an env map at construction and nothing else.
    if (this._fogSeen === undefined) {
      const scene = this.group.parent;
      this._fogSeen = scene && scene.fog && scene.fog.isFogExp2 ? scene.fog.density : 0;
      this._contactMat.userData.uFog.value = this._fogSeen;
    }

    const col = this.contact.geometry.attributes.color;
    const arr = col.array;
    const sh = this._contactShade;
    const wh = this._contactWheel;
    for (let i = 0; i < sh.length; i++) {
      // Never all the way to black: a multiply that reaches zero is a hole, and
      // the road under a tyre is still lit by everything except the tyre.
      const v = 1 - sh[i] * this._contactStr[wh[i]] * fade * 0.80;
      arr[i * 3] = v; arr[i * 3 + 1] = v; arr[i * 3 + 2] = v;
    }
    col.needsUpdate = true;
  }

  /**
   * Driver rig.
   *
   * The chain is: lateral load throws the torso outward and tips the head into
   * the corner (what onboard footage actually shows), the shoulders stay
   * squarer to the wheel than the chassis is, and the hands are solved onto
   * the rim so they turn with it. An impact snaps the whole thing and rings
   * out over about a third of a second.
   */
  _updateDriver(kart, dt) {
    const speed01 = clamp01(Math.abs(kart.speed) / 20);
    const latTarget = clamp(-kart.drift.bodyAngle * 1.15 - kart.wheelSteer * speed01 * 0.75, -1, 1);
    this._gLat = damp(this._gLat, latTarget, 7, dt);

    const accel = (Math.abs(kart.speed) - this._prevSpeed) / Math.max(dt, 1e-4);
    this._prevSpeed = Math.abs(kart.speed);
    this._gLong = damp(this._gLong, clamp(accel / 22, -1, 1), 6, dt);
    this._brake = damp(this._brake, this._gLong < -0.12 ? 1 : 0, 12, dt);

    if (kart.lastImpact > this._impactPrev + 0.15) { this._jolt = 1; this._joltPhase = 0; }
    this._impactPrev = kart.lastImpact;
    this._joltPhase += dt * 27;
    this._jolt = damp(this._jolt, 0, 7, dt);
    const jolt = this._jolt * Math.sin(this._joltPhase);

    // Gains roughly doubled across the rig. The numbers below used to top out
    // at 7 degrees of torso roll and 4.5 cm of lateral throw at a full drift —
    // real, but under the amplitude at which a 40 cm figure seen from six
    // metres reads as anything at all, which is why the driver sat bolt upright
    // through a slide that has the kart itself at 38 degrees of yaw. A drift is
    // the most violent thing that happens to this character and it is the pose
    // the player looks at for most of a lap.
    const d = this.driver;
    d.position.x = this._driverBase.x - this._gLat * 0.082;
    d.position.z = this._driverBase.z + this._gLong * 0.030 + jolt * 0.02
      - this._brake * 0.030;                     // brace forward on the brakes
    d.position.y = this._driverBase.y - Math.abs(jolt) * 0.012
      - Math.abs(this._gLat) * 0.026;            // and hunker down under load
    d.rotation.z = -this._gLat * 0.30;
    d.rotation.x = -this._gLong * 0.16 + jolt * 0.10 + Math.abs(this._gLat) * 0.10;
    // Shoulders stay pointed where the kart is going, not where it is facing.
    d.rotation.y = -kart.wheelSteer * 0.20 - kart.drift.bodyAngle * 0.42;

    // The head counter-rotates the torso and then some: through a slide the
    // driver is looking down the road, not out of the side window, so the yaw
    // has to cover the drift's whole body angle and the roll has to keep the
    // helmet nearer level than the shoulders under it.
    const h = this.headGroup;
    h.rotation.y = damp(h.rotation.y, kart.wheelSteer * 0.46 + kart.drift.bodyAngle * 0.92, 9, dt);
    h.rotation.z = this._gLat * 0.46 - this._leanZ * 0.55;
    h.rotation.x = -this._gLong * 0.10 + jolt * 0.42 - Math.abs(this._gLat) * 0.07;

    this.steering.rotation.z = -kart.wheelSteer * 1.25;
    this._solveHands();
  }

  /**
   * Put both gloves on the rim wherever the rim currently is, and stretch each
   * arm to reach. Split out of the rig because the shell bake needs the same
   * solve run once, at rest, before it reads the model's pose.
   */
  _solveHands() {
    const d = this.driver;
    this.steering.updateMatrix();
    d.updateMatrix();
    _m1.copy(d.matrix).invert();
    _q2.copy(d.quaternion).invert();
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const th = (s < 0 ? Math.PI - GRIP_ANGLE : GRIP_ANGLE) + this.steering.rotation.z;
      _v1.set(Math.cos(th) * STEER_R, Math.sin(th) * STEER_R, 0.022);
      _v1.applyMatrix4(this.steering.matrix).applyMatrix4(_m1);

      const hand = this.hands[i];
      hand.position.copy(_v1);
      _q1.setFromEuler(_e1.set(0, 0, th));
      hand.quaternion.copy(_q2).multiply(this.steering.quaternion).multiply(_q1);

      const shoulder = this.arms[i];
      _v2.copy(_v1).sub(shoulder.position);
      const len = _v2.length();
      shoulder.quaternion.setFromUnitVectors(_DOWN, _v2.divideScalar(len));
      shoulder.userData.mesh.scale.y = clamp(len / ARM_LEN, 0.82, 1.18);
    }
  }

  /** Rear lamp response and the dirt the tyres pick up off the road. */
  _updateSurfaces(kart, dt) {
    const lampTarget = 0.30 + this._brake * 1.9 + (kart.speed < -0.1 ? 0.4 : 0);
    this.mats.lamp.emissiveIntensity = damp(this.mats.lamp.emissiveIntensity, lampTarget, 14, dt);

    const dust = kart.grounded ? kart.surface.dust : 0;
    // Picks up fast in the dirt, scrubs off slowly back on tarmac.
    this._dirt = damp(this._dirt, clamp01(dust), dust > 0 ? 1.6 : 0.35, dt);
    this.mats.rubber.color.copy(_WHITE).lerp(_DUST, this._dirt * 0.55);
    this.mats.rubber.envMapIntensity = lerp(0.5, 0.18, this._dirt);
  }

  dispose() {
    for (const m of this.mats.all) m.dispose();
    this._contactMat.dispose();
    this.contact.geometry.dispose();
  }
}
