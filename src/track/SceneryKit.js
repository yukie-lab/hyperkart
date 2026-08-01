import * as THREE from 'three';
import { clamp, clamp01, lerp, mod, smoothstep, makeValueNoise2D, fbm2D, TAU } from '../core/MathX.js';

/**
 * Shared toolkit for the scenery layer.
 *
 * Three ideas carry most of the weight here:
 *
 *  1. **Vertex colours instead of material splits.** A palm tree is a trunk and
 *     nine fronds and three coconuts; drawn as separate materials that is four
 *     draw calls per tree. Baked into one geometry with a colour attribute it is
 *     one, and it still instances. Almost every prop in this folder is built as
 *     a list of coloured parts and merged.
 *
 *  2. **Chunked instancing.** One `InstancedMesh` holding 140 palms is a single
 *     draw call but is never frustum-culled, so all 140 are submitted even when
 *     they are behind the camera. Splitting the scatter into arc-length chunks
 *     costs a couple of draw calls and removes two thirds of the triangles.
 *
 *  3. **Animation in the vertex shader.** Wind, crowd bob, buoy roll and wing
 *     flap are all per-instance phase functions injected into the standard
 *     material, so nothing has to touch an instance matrix at runtime.
 *
 * Placement queries `TerrainSampler`, which reproduces `TrackBuilder`'s terrain
 * exactly — including its grid, so props sit on the triangles that are actually
 * rendered rather than on the ideal surface those triangles approximate.
 */

// Must match TrackBuilder / TRACK_LAYOUT.
export const WALL_OFFSET = 6.5;
export const TERRAIN_REACH = 260;
const TERRAIN_STEP = 6.4;
const TERRAIN_COLS = 22;
// The terrain mesh drops the two columns straddling the road, so there is no
// land at all until this far beyond the barrier. Nothing may be placed inside it.
export const TERRAIN_INNER = Math.pow(1 / (TERRAIN_COLS / 2), 1.7) * TERRAIN_REACH;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export class TerrainSampler {
  constructor(track) {
    this.track = track;
    this.isCoast = track.theme.key === 'coast';
    this.isVoid = !!track.isVoid;
    this.noise = makeValueNoise2D(this.isCoast ? 1201 : 3307, 256);
    this.waterLevel = track.waterLevel;
    this.n = Math.max(48, Math.round(track.length / TERRAIN_STEP));
    this.cols = TERRAIN_COLS;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._cache = new Map();

    // Which lateral sign points away from the middle of the circuit. Used for
    // anything that belongs outside the loop (far apron, horizon buttes).
    let cx = 0, cz = 0;
    const sp = track.spline;
    for (let i = 0; i < sp.count; i++) { cx += sp.pos[i * 3]; cz += sp.pos[i * 3 + 2]; }
    this.centre = new THREE.Vector3(cx / sp.count, 0, cz / sp.count);
  }

  /** Identical to TrackBuilder._buildTerrain's `profile`. */
  profile(d, worldX, worldZ, edgeY) {
    const nz = fbm2D(this.noise, worldX * 0.006, worldZ * 0.006, 5);
    const detail = fbm2D(this.noise, worldX * 0.05, worldZ * 0.05, 3);
    if (this.isCoast) {
      const toWater = edgeY - this.waterLevel;
      const shore = Math.pow(clamp01(d / 78), 1.45) * (toWater + 3.0);
      const dune = Math.pow(clamp01(1 - d / 44), 2) * nz * 3.4;
      const seabed = Math.pow(clamp01((d - 84) / 150), 1.3) * 22;
      return edgeY - 0.9 - shore + dune - seabed + detail * 0.6 * clamp01(1 - d / 95);
    }
    const rise = Math.pow(clamp01((d - 18) / 90), 1.5) * (26 + nz * 34);
    const dip = -1.2 - clamp01(d / 20) * 2.0;
    return edgeY + dip + rise + detail * 1.4;
  }

  /** Distance beyond the barrier for terrain grid column `j`. */
  colDistance(j) {
    const u = j / this.cols;
    const k01 = Math.abs(u - 0.5) * 2;
    return { side: u < 0.5 ? -1 : 1, d: Math.pow(k01, 1.7) * TERRAIN_REACH };
  }

  /** Height of the rendered terrain at grid node (ring i, column j). */
  node(i, j) {
    const key = mod(i, this.n) * (this.cols + 1) + j;
    const hit = this._cache.get(key);
    if (hit !== undefined) return hit;
    const s = (mod(i, this.n) / this.n) * this.track.length;
    const { side, d } = this.colDistance(j);
    const half = this.track.halfWidthAt(s);
    const p = this.track.placeOnRoad(s, side * (half + WALL_OFFSET + d), this._tmp);
    const y = d > 0.5 ? this.profile(d, p.x, p.z, p.y) : p.y - 0.42;
    this._cache.set(key, y);
    return y;
  }

  /**
   * Height of the rendered terrain at (arc position, lateral offset).
   * Bilinear across the same grid the mesh is built from, so a prop dropped
   * here lands on a triangle rather than near one.
   */
  heightAt(s, lateral) {
    const half = this.track.halfWidthAt(s);
    const side = lateral < 0 ? -1 : 1;
    const d = Math.abs(lateral) - (half + WALL_OFFSET);
    if (this.isVoid) return this.track.placeOnRoad(s, lateral, this._tmp).y;
    if (d <= 0.5) return this.track.placeOnRoad(s, lateral, this._tmp).y - 0.42;

    const k01 = Math.pow(clamp01(d / TERRAIN_REACH), 1 / 1.7);
    const fj = clamp(this.cols * (0.5 + side * k01 * 0.5), 0, this.cols - 1e-4);
    const j0 = Math.floor(fj), tj = fj - j0;
    const fi = mod(s / this.track.length, 1) * this.n;
    const i0 = Math.floor(fi), ti = fi - i0;

    const a = this.node(i0, j0), b = this.node(i0, j0 + 1);
    const c = this.node(i0 + 1, j0), e = this.node(i0 + 1, j0 + 1);
    return lerp(lerp(a, b, tj), lerp(c, e, tj), ti);
  }

  /** World point sitting on the terrain at (s, lateral). */
  place(s, lateral, out = new THREE.Vector3()) {
    this.track.placeOnRoad(s, lateral, out);
    out.y = this.heightAt(s, lateral);
    return out;
  }

  /** +1 if positive lateral points away from the centre of the circuit. */
  outwardSign(s) {
    const half = this.track.halfWidthAt(s);
    const a = this.track.placeOnRoad(s, half + 60, this._tmp);
    const b = this.track.placeOnRoad(s, -(half + 60), this._tmp2);
    const da = (a.x - this.centre.x) ** 2 + (a.z - this.centre.z) ** 2;
    const db = (b.x - this.centre.x) ** 2 + (b.z - this.centre.z) ** 2;
    return da >= db ? 1 : -1;
  }

  /**
   * Lateral offset at which the terrain crosses a given height, searched
   * outward from the barrier. Returns null if it never does.
   */
  findHeight(s, targetY, side, dLo = TERRAIN_INNER, dHi = TERRAIN_REACH) {
    const half = this.track.halfWidthAt(s);
    const at = (d) => this.heightAt(s, side * (half + WALL_OFFSET + d));
    let lo = dLo, hi = dHi;
    const yLo = at(lo), yHi = at(hi);
    if ((yLo - targetY) * (yHi - targetY) > 0) return null;
    for (let k = 0; k < 22; k++) {
      const mid = (lo + hi) * 0.5;
      if ((at(lo) - targetY) * (at(mid) - targetY) <= 0) hi = mid; else lo = mid;
    }
    return side * (half + WALL_OFFSET + (lo + hi) * 0.5);
  }
}

// ---------------------------------------------------------------------------
// Geometry assembly
// ---------------------------------------------------------------------------

/** Compose a transform for a merge part. */
export function T(pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
  const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
}

/**
 * Merge `[{ geo, color, m }]` into a single vertex-coloured geometry.
 * Source geometries are disposed unless `keep` is set — they are throwaway
 * primitives in every call site here.
 */
export function mergeParts(parts, { keep = false } = {}) {
  let vTotal = 0, iTotal = 0;
  for (const p of parts) {
    vTotal += p.geo.attributes.position.count;
    iTotal += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count;
  }
  const position = new Float32Array(vTotal * 3);
  const normal = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const color = new Float32Array(vTotal * 3);
  const index = new Uint32Array(iTotal);

  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const col = new THREE.Color();
  let vOff = 0, iOff = 0;

  for (const p of parts) {
    const g = p.geo;
    const src = g.attributes.position;
    const srcN = g.attributes.normal;
    const srcUV = g.attributes.uv;
    if (p.m) nm.getNormalMatrix(p.m);
    col.set(p.color === undefined ? 0xffffff : p.color);
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i);
      if (p.m) v.applyMatrix4(p.m);
      const k = (vOff + i) * 3;
      position[k] = v.x; position[k + 1] = v.y; position[k + 2] = v.z;
      if (srcN) {
        v.fromBufferAttribute(srcN, i);
        if (p.m) v.applyMatrix3(nm).normalize();
        normal[k] = v.x; normal[k + 1] = v.y; normal[k + 2] = v.z;
      }
      if (srcUV) { uv[(vOff + i) * 2] = srcUV.getX(i); uv[(vOff + i) * 2 + 1] = srcUV.getY(i); }
      color[k] = col.r; color[k + 1] = col.g; color[k + 2] = col.b;
    }
    const idx = g.index;
    if (idx) for (let i = 0; i < idx.count; i++) index[iOff++] = idx.getX(i) + vOff;
    else for (let i = 0; i < src.count; i++) index[iOff++] = i + vOff;
    vOff += src.count;
    if (!keep) g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/** Faceted boulder: an icosahedron pushed around by a direction-hashed field. */
export function rockGeometry(rng, { detail = 1, rough = 0.34, squash = 0.68 } = {}) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const a = rng() * 9, b = rng() * 9, c = rng() * 9;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = Math.sin(v.x * 2.9 + a) * Math.cos(v.y * 2.3 + b) * Math.sin(v.z * 3.3 + c);
    const n2 = Math.sin(v.x * 6.7 + b) * Math.sin(v.z * 5.9 + c) * Math.cos(v.y * 6.1 + a);
    v.multiplyScalar(1 + n1 * rough + n2 * rough * 0.4);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Sweep a circular section along a polyline with parallel-transported frames.
 * `points` is `[{ p: Vector3, r: number }]`. Used for trunks, cactus arms,
 * rock arches and pylon spars.
 */
export function sweepStack(points, sides = 8, { capStart = true, capEnd = true, vScale = 0.25 } = {}) {
  const n = points.length;
  const positions = [], uvs = [], idx = [];
  const tan = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  let ref = new THREE.Vector3(0, 0, 1);
  let vAcc = 0;

  for (let i = 0; i < n; i++) {
    const cur = points[i].p;
    const prev = points[Math.max(i - 1, 0)].p;
    const next = points[Math.min(i + 1, n - 1)].p;
    tan.subVectors(next, prev);
    if (tan.lengthSq() < 1e-10) tan.set(0, 1, 0);
    tan.normalize();
    if (Math.abs(tan.dot(ref)) > 0.95) ref.set(1, 0, 0);
    right.crossVectors(tan, ref).normalize();
    up.crossVectors(right, tan).normalize();
    ref.copy(up);
    if (i > 0) vAcc += cur.distanceTo(prev) * vScale;
    const r = points[i].r;
    for (let j = 0; j <= sides; j++) {
      const th = (j / sides) * TAU;
      const cx = Math.cos(th), sy = Math.sin(th);
      positions.push(
        cur.x + (right.x * cx + up.x * sy) * r,
        cur.y + (right.y * cx + up.y * sy) * r,
        cur.z + (right.z * cx + up.z * sy) * r,
      );
      uvs.push(j / sides, vAcc);
    }
  }
  const m = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const i0 = i * m + j, i1 = (i + 1) * m + j;
      idx.push(i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
    }
  }
  if (capStart) {
    const base = positions.length / 3;
    positions.push(points[0].p.x, points[0].p.y, points[0].p.z); uvs.push(0.5, 0.5);
    for (let j = 0; j < sides; j++) idx.push(base, j + 1, j);
  }
  if (capEnd) {
    const last = (n - 1) * m;
    const base = positions.length / 3;
    const e = points[n - 1].p;
    positions.push(e.x, e.y, e.z); uvs.push(0.5, 0.5);
    for (let j = 0; j < sides; j++) idx.push(base, last + j, last + j + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Convenience: a tapered, optionally curved column from (0,0,0) upward. */
export function columnGeometry(height, r0, r1, { segs = 6, sides = 7, bendX = 0, bendZ = 0, curve = 2 } = {}) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const k = Math.pow(t, curve);
    pts.push({ p: new THREE.Vector3(bendX * k, height * t, bendZ * k), r: lerp(r0, r1, t) });
  }
  return sweepStack(pts, sides, { capStart: false, capEnd: true });
}

/**
 * A palm frond: a V-folded strip that rises then droops, tapering to a point.
 * Built along +X so a palm can just rotate copies of it around Y.
 */
export function frondGeometry(len, width, { segs = 5, droop = 1.0, fold = 0.32 } = {}) {
  const positions = [], uvs = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = len * t;
    const y = len * (0.30 * t - droop * 0.95 * t * t);
    const w = width * Math.sin(Math.PI * Math.pow(t, 0.55)) * (1 - t * 0.25);
    positions.push(x, y, 0); uvs.push(t, 0.5);
    positions.push(x, y - w * fold, -w); uvs.push(t, 0);
    positions.push(x, y - w * fold, w); uvs.push(t, 1);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, a + 1, b + 1, a, b + 1, b);
    idx.push(a, b, b + 2, a, b + 2, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A flat-topped mesa: stacked rings with per-ring irregular radius, wider at
 * the base where scree has piled up. Colour banding is applied by the caller
 * from the returned `bandY` helper.
 */
export function mesaGeometry(rng, { rings = 7, sides = 11, wobble = 0.16 } = {}) {
  const positions = [], uvs = [], idx = [];
  const phase = [];
  for (let j = 0; j < sides; j++) phase.push(rng() * TAU);
  const profileR = (t) => {
    // Talus apron, a near-vertical cliff, then a slight cap overhang.
    if (t < 0.22) return lerp(1.34, 1.02, t / 0.22);
    if (t < 0.86) return lerp(1.02, 0.93, (t - 0.22) / 0.64);
    return lerp(0.93, 0.72, (t - 0.86) / 0.14);
  };
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const rBase = profileR(t);
    for (let j = 0; j <= sides; j++) {
      const jj = j % sides;
      const th = (j / sides) * TAU;
      const r = rBase * (1 + Math.sin(phase[jj] + t * 1.7) * wobble + Math.sin(phase[jj] * 2.3) * wobble * 0.5);
      positions.push(Math.cos(th) * r, t, Math.sin(th) * r);
      uvs.push(j / sides, t);
    }
  }
  const m = sides + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sides; j++) {
      const i0 = i * m + j, i1 = (i + 1) * m + j;
      idx.push(i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
    }
  }
  // Cap.
  const top = rings * m;
  const c = positions.length / 3;
  positions.push(0, 1, 0); uvs.push(0.5, 1);
  for (let j = 0; j < sides; j++) idx.push(c, top + j, top + j + 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Paint a geometry's vertex colours from a function of local position. */
export function paintGeometry(geo, fn) {
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v, c, i);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Materials & shader animation
// ---------------------------------------------------------------------------

export function propMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.0,
    roughness: 0.86,
    envMapIntensity: 0.45,
    ...opts,
  });
}

export function neonMaterial(opts = {}) {
  return new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, ...opts });
}

/** Shared per-material clock, driven from Scenery.update. */
function clockOf(mat) {
  if (!mat.userData.uTime) mat.userData.uTime = { value: 0 };
  return mat.userData.uTime;
}

function inject(mat, key, common, body) {
  const uTime = clockOf(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\n${common}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n{\n${body}\n}`);
  };
  const base = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => base + key;
  return mat;
}

const INSTANCE_ORIGIN = `
  #ifdef USE_INSTANCING
    vec3 iOrg = instanceMatrix[3].xyz;
  #else
    vec3 iOrg = vec3(0.0);
  #endif
  float iPhase = iOrg.x * 0.21 + iOrg.z * 0.37;
`;

/** Height-weighted bend, for palms, cacti-adjacent foliage and fronds. */
export function applyWind(mat, { amp = 0.06, freq = 1.1, height = 9, pow = 1.8, dirX = 1, dirZ = 0.45 } = {}) {
  return inject(mat, `|wind${amp}${freq}${height}${pow}`, '', `
    ${INSTANCE_ORIGIN}
    float h = clamp(transformed.y / ${height.toFixed(2)}, 0.0, 1.0);
    float bend = pow(h, ${pow.toFixed(2)});
    float w = sin(uTime * ${freq.toFixed(3)} + iPhase) * 0.62
            + sin(uTime * ${(freq * 2.31).toFixed(3)} + iPhase * 1.7) * 0.38;
    float g = w * ${amp.toFixed(4)} * bend * ${height.toFixed(2)};
    transformed.x += g * ${dirX.toFixed(2)};
    transformed.z += g * ${dirZ.toFixed(2)};
  `);
}

/** Crowd: a short vertical bounce plus a lean, phased per instance. */
export function applyCrowd(mat, { amp = 0.16, freq = 5.0 } = {}) {
  return inject(mat, `|crowd${amp}${freq}`, '', `
    ${INSTANCE_ORIGIN}
    float b = sin(uTime * ${freq.toFixed(2)} + iPhase * 7.3);
    float hop = max(b, 0.0);
    transformed.y += hop * ${amp.toFixed(3)};
    transformed.x += sin(uTime * ${(freq * 0.43).toFixed(2)} + iPhase * 3.1) * 0.05 * transformed.y;
  `);
}

/** Buoys and floating platforms: heave plus roll about the instance origin. */
export function applyBob(mat, { amp = 0.4, freq = 0.9, roll = 0.10 } = {}) {
  return inject(mat, `|bob${amp}${freq}${roll}`, '', `
    ${INSTANCE_ORIGIN}
    float t = uTime * ${freq.toFixed(3)} + iPhase;
    transformed.y += sin(t) * ${amp.toFixed(3)};
    float a = sin(t * 0.83) * ${roll.toFixed(3)};
    float ca = cos(a), sa = sin(a);
    transformed.xy = vec2(transformed.x * ca - transformed.y * sa, transformed.x * sa + transformed.y * ca);
  `);
}

/** Seagull wings: fold about the body axis, faster the further out the vertex. */
export function applyFlap(mat, { amp = 0.55, freq = 7.0 } = {}) {
  return inject(mat, `|flap${amp}${freq}`, '', `
    ${INSTANCE_ORIGIN}
    float f = sin(uTime * ${freq.toFixed(2)} + iPhase * 5.0);
    transformed.y += abs(transformed.x) * f * ${amp.toFixed(3)};
  `);
}

/** Slow drift + spin, used for nebulae and floating debris. */
export function applyDrift(mat, { amp = 2.5, freq = 0.13 } = {}) {
  return inject(mat, `|drift${amp}${freq}`, '', `
    ${INSTANCE_ORIGIN}
    transformed.y += sin(uTime * ${freq.toFixed(3)} + iPhase) * ${amp.toFixed(2)};
    transformed.x += cos(uTime * ${(freq * 0.71).toFixed(3)} + iPhase * 1.3) * ${(amp * 0.6).toFixed(2)};
  `);
}

/** Emissive throb for neon. Multiplies the unlit colour. */
export function applyPulse(mat, { freq = 2.2, depth = 0.35 } = {}) {
  const uTime = clockOf(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vPulse;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${INSTANCE_ORIGIN}
        vPulse = 1.0 + sin(uTime * ${freq.toFixed(2)} + iPhase) * ${depth.toFixed(3)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPulse;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= vPulse;');
  };
  const base = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => base + `|pulse${freq}${depth}`;
  return mat;
}

// ---------------------------------------------------------------------------
// Instancing
// ---------------------------------------------------------------------------

/**
 * Build `chunks` instanced meshes from a list of `{ m, color }`. Items should
 * already be ordered along the track so each chunk is spatially compact and
 * frustum culling can throw most of them away.
 */
export function chunkedInstances(parent, geo, mat, items, chunks = 6, opts = {}) {
  const out = [];
  if (!items.length) return out;
  const n = Math.max(1, Math.min(chunks, items.length));
  const per = Math.ceil(items.length / n);
  for (let c = 0; c < n; c++) {
    const slice = items.slice(c * per, (c + 1) * per);
    if (!slice.length) continue;
    const im = new THREE.InstancedMesh(geo, mat, slice.length);
    for (let i = 0; i < slice.length; i++) {
      im.setMatrixAt(i, slice[i].m);
      if (slice[i].color !== undefined) im.setColorAt(i, _c.set(slice[i].color));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = !!opts.cast;
    im.receiveShadow = !!opts.receive;
    im.renderOrder = opts.renderOrder ?? 0;
    im.name = `${opts.name || 'prop'}_${c}`;
    im.computeBoundingSphere();
    if (opts.inflate && im.boundingSphere) im.boundingSphere.radius += opts.inflate;
    parent.add(im);
    out.push(im);
  }
  return out;
}

const _c = new THREE.Color();

/** Single static mesh from a merged geometry. */
export function addMesh(parent, geo, mat, opts = {}) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = !!opts.cast;
  mesh.receiveShadow = !!opts.receive;
  mesh.renderOrder = opts.renderOrder ?? 0;
  mesh.name = opts.name || 'scenery';
  if (opts.pos) mesh.position.copy(opts.pos);
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Procedural textures used only by scenery
// ---------------------------------------------------------------------------

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function texFrom(c, { srgb = true, repeatX = 1, repeatY = 1, transparent = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * A strip of four trackside hoardings. The band geometry tiles this along the
 * barrier, so one texture supplies all the signage on the circuit.
 */
export function bannerStripTexture(palette, words) {
  const W = 2048, H = 256, cells = 4, cw = W / cells;
  const c = canvasOf(W, H);
  const g = c.getContext('2d');
  for (let i = 0; i < cells; i++) {
    const x0 = i * cw;
    const p = palette[i % palette.length];
    g.fillStyle = p.bg;
    g.fillRect(x0, 0, cw, H);

    // A diagonal accent sweep — the standard visual grammar of a sponsor board.
    g.save();
    g.beginPath(); g.rect(x0, 0, cw, H); g.clip();
    g.fillStyle = p.accent;
    g.beginPath();
    g.moveTo(x0 + cw * 0.60, 0); g.lineTo(x0 + cw * 1.02, 0);
    g.lineTo(x0 + cw * 1.02, H); g.lineTo(x0 + cw * 0.44, H);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.moveTo(x0 + cw * 0.52, 0); g.lineTo(x0 + cw * 0.60, 0);
    g.lineTo(x0 + cw * 0.44, H); g.lineTo(x0 + cw * 0.36, H);
    g.closePath(); g.fill();
    g.restore();

    g.fillStyle = p.fg;
    g.font = `bold ${Math.round(H * 0.52)}px Helvetica, Arial, sans-serif`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const label = words[i % words.length];
    g.fillText(label, x0 + cw * 0.06, H * 0.52);

    // Border keeps panels reading as separate boards at a distance.
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 8;
    g.strokeRect(x0 + 4, 4, cw - 8, H - 8);
  }
  return texFrom(c, { srgb: true });
}

/** Soft foam texture: white filaments with an alpha falloff top and bottom. */
export function foamTexture(seed = 5) {
  const S = 256;
  const n = makeValueNoise2D(seed, S / 4);
  const c = canvasOf(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = fbm2D(n, x / 14, y / 30, 4);
      const band = 1 - Math.abs((x / S) * 2 - 1);
      const a = clamp01((v * 1.7 - 0.55)) * Math.pow(band, 0.8);
      const i = (y * S + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFrom(c, { srgb: true });
}

/** Radial glow sprite, used for nebulae, dust devils and lamp halos. */
export function glowTexture(inner = 'rgba(255,255,255,0.95)', outer = 'rgba(255,255,255,0)', stops = null) {
  const S = 256;
  const c = canvasOf(S, S);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  if (stops) for (const [o, col] of stops) grad.addColorStop(o, col);
  else { grad.addColorStop(0, inner); grad.addColorStop(1, outer); }
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return texFrom(c, { srgb: true });
}

/** Wispy nebula cloud: layered blurred blobs. */
export function nebulaTexture(seed = 11, hueA = '#6c3bff', hueB = '#ff4fa3') {
  const S = 512;
  const c = canvasOf(S, S);
  const g = c.getContext('2d');
  const n = makeValueNoise2D(seed, S / 8);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x / S) * 2 - 1, dy = (y / S) * 2 - 1;
      const r = Math.hypot(dx, dy);
      const v = fbm2D(n, x / 34, y / 34, 5);
      const a = clamp01((1 - r) * 1.35) * clamp01(v * 1.9 - 0.42);
      const i = (y * S + x) * 4;
      const mix = clamp01(fbm2D(n, x / 90 + 20, y / 90, 3) * 1.6 - 0.2);
      const A = new THREE.Color(hueA), B = new THREE.Color(hueB);
      img.data[i] = lerp(A.r, B.r, mix) * 255 * 1.6;
      img.data[i + 1] = lerp(A.g, B.g, mix) * 255 * 1.6;
      img.data[i + 2] = lerp(A.b, B.b, mix) * 255 * 1.6;
      img.data[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFrom(c, { srgb: true });
}

/** Banded gas-giant surface for the Rainbow Skyway's planets. */
export function planetTexture(seed = 3, colors = ['#f0c27b', '#c98a4b', '#8e5a35', '#f6e3c5']) {
  const W = 512, H = 256;
  const c = canvasOf(W, H);
  const g = c.getContext('2d');
  const n = makeValueNoise2D(seed, 64);
  const img = g.createImageData(W, H);
  const cols = colors.map((h) => new THREE.Color(h));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const warp = fbm2D(n, x / 40, y / 90, 4) * 22;
      const band = (y + warp) / H * colors.length * 1.7;
      const i0 = Math.floor(mod(band, cols.length));
      const i1 = (i0 + 1) % cols.length;
      const t = smoothstep(mod(band, 1));
      const a = cols[i0], b = cols[i1];
      const shade = 0.82 + fbm2D(n, x / 12, y / 12, 3) * 0.36;
      const i = (y * W + x) * 4;
      img.data[i] = lerp(a.r, b.r, t) * 255 * shade;
      img.data[i + 1] = lerp(a.g, b.g, t) * 255 * shade;
      img.data[i + 2] = lerp(a.b, b.b, t) * 255 * shade;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFrom(c, { srgb: true });
}

export { texFrom, canvasOf };
