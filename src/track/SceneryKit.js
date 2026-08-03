import * as THREE from 'three';
import { clamp, clamp01, lerp, mod, ringDelta, smoothstep, makeValueNoise2D, fbm2D, TAU } from '../core/MathX.js';
import * as Tex from '../render/ProcTex.js';

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
    this._anchor = new THREE.Vector3();
    this._anchor2 = new THREE.Vector3();
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
    // Beyond the barrier the ground stops following the camber.
    //
    // `placeOnRoad` extends the banking for as far as it is asked. canyonRush
    // banks 20.6 degrees, so the extended plane is 4.81 m off the road centre
    // at the barrier line and keeps going — and the terrain was anchored to it,
    // which on the *inside* of a banked corner builds a sand wall that climbs
    // with distance and stands metres above the track. That is what a driver
    // sitting on the road, grounded, with the camera in its normal place 7.97 m
    // behind, was looking at when the circuit appeared to be buried.
    //
    // The reference blends from the barrier's own height, where it must match
    // the shoulder mesh exactly or there is a step, to the road *centre* by
    // twenty-five metres out, where the camber has no business being. The bank
    // and its shoulder are untouched; only the desert behind them stops being
    // tilted.
    let ref = p.y;
    if (d > 0.5) {
      const edgeY = this.track.placeOnRoad(s, side * (half + WALL_OFFSET), this._anchor).y;
      const centreY = this.track.placeOnRoad(s, 0, this._anchor2).y;
      const k = smoothstep(clamp01((d - 0.5) / 24.5));
      ref = edgeY + (centreY - edgeY) * k;
    }
    const y = d > 0.5 ? this.profile(d, p.x, p.z, ref) : p.y - 0.42;
    this._cache.set(key, y);
    return y;
  }

  /**
   * Height of the rendered terrain at (arc position, lateral offset).
   *
   * Planar across the *same triangle* the mesh is built from, not bilinear
   * across the quad. Those two disagree by half the quad's twist, and out at
   * the hoodoo band a quad is twenty metres across a falling ridge — which is
   * metres of error, and metres of error is exactly the gap of sky the critic
   * found under the canyon hoodoos. Bilinear puts a prop near the surface;
   * only the triangle puts it on the surface.
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
    // TrackBuilder splits every quad along the (i,j)-(i+1,j+1) diagonal, so
    // which of the two planes is in force is decided by which side of ti == tj
    // the sample falls on.
    return tj <= ti
      ? a + (c - a) * ti + (e - c) * tj
      : a + (b - a) * tj + (e - b) * ti;
  }

  /**
   * The lowest terrain within `radius` of (s, lateral).
   *
   * A mesa's base is a rigid disc. Sitting it on the height at its centre
   * leaves the downhill third of that disc hanging in the air, and a landform
   * that floats is worse than one that is buried. Anything with a real
   * footprint gets planted on the low corner of it instead.
   */
  groundMin(s, lateral, radius) {
    let lo = this.heightAt(s, lateral);
    for (let k = 0; k < 8; k++) {
      const th = (k / 8) * TAU;
      const y = this.heightAt(s + Math.cos(th) * radius, lateral + Math.sin(th) * radius);
      if (y < lo) lo = y;
    }
    return lo;
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
// Placement
// ---------------------------------------------------------------------------

/**
 * A periodic density field around the lap, in -1..1.
 *
 * Every harmonic is an integer number of cycles per lap, so the field is
 * continuous across the start/finish line. A generic noise would leave a seam
 * of doubled or missing props exactly at the one place on the circuit the
 * player looks at three times a race.
 */
export function loopField(rng, { cycles = 9, octaves = 3, gain = 0.55 } = {}) {
  const base = Math.max(1, Math.round(cycles));
  const terms = [];
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const a = Math.pow(gain, i);
    terms.push({ k: base * Math.pow(2, i), ph: rng() * TAU, a });
    norm += a;
  }
  return (u) => {
    let v = 0;
    for (const t of terms) v += Math.sin(u * TAU * t.k + t.ph) * t.a;
    return v / norm;
  };
}

/** Roughly normal-distributed in about [-1.7, 1.7]. Cheaper than Box-Muller. */
export const gauss = (rng) => (rng() + rng() + rng() - 1.5) * 1.15;

/**
 * Scatter prop sites along the circuit in drifts.
 *
 * Even spacing along the spline is the single most obvious tell of procedural
 * placement, so nothing here is spaced: a periodic density field decides where
 * a thicket is allowed to exist at all, sites are rejection-sampled against the
 * square of that field so they pile into its cores, and each accepted site
 * spawns a small cluster jittered around it. The result is drifts with real
 * gaps between them, which is what a photographed roadside looks like.
 *
 * Returns `[{ s, lateral, d, side, pos, u, v, w }]` ordered by arc position so
 * `chunkedInstances` can slice it into spatially compact, cullable chunks.
 */
export function scatterAlong(rng, terrain, opts = {}) {
  const {
    count = 100,
    band = [TERRAIN_INNER + 1, 40],
    sides = [-1, 1],
    cycles = 9,
    threshold = -0.1,
    bias = 2.0,             // exponent on the field; higher = tighter drifts
    cluster = [1, 1],
    clusterArc = 9,
    clusterLat = 5,
    minGap = 0,
    depthPow = 1.35,        // >1 pulls the band's mass toward the track
    accept = null,
  } = opts;

  const L = terrain.track.length;
  const fields = new Map();
  for (const side of sides) fields.set(side, loopField(rng, { cycles }));

  // Spatial hash on arc position only — props are a thin ribbon around a
  // 1-D curve, so one axis is enough to make the min-distance test O(1).
  const cellS = Math.max(minGap, 4);
  const cells = Math.max(1, Math.ceil(L / cellS));
  const grid = new Map();
  const tooClose = (s, lateral) => {
    if (minGap <= 0) return false;
    const ci = Math.floor(s / cellS);
    for (let k = -1; k <= 1; k++) {
      const bucket = grid.get(mod(ci + k, cells));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i += 2) {
        const ds = ringDelta(bucket[i], s, L);
        const dl = bucket[i + 1] - lateral;
        if (ds * ds + dl * dl < minGap * minGap) return true;
      }
    }
    return false;
  };
  const remember = (s, lateral) => {
    const ci = mod(Math.floor(s / cellS), cells);
    let b = grid.get(ci);
    if (!b) grid.set(ci, (b = []));
    b.push(s, lateral);
  };

  const out = [];
  const [cLo, cHi] = cluster;
  let guard = 0;
  const budget = count * 90 + 4000;

  while (out.length < count && guard++ < budget) {
    const side = sides[Math.floor(rng() * sides.length) % sides.length];
    const s0 = rng() * L;
    const f = fields.get(side)(s0 / L);
    if (f <= threshold) continue;
    const p = (f - threshold) / (1 - threshold);
    if (rng() > Math.pow(p, bias)) continue;

    const dCentre = lerp(band[0], band[1], Math.pow(rng(), depthPow));
    const n = cLo + Math.floor(rng() * (cHi - cLo + 1));
    for (let k = 0; k < n && out.length < count; k++) {
      const s = mod(s0 + (k === 0 ? 0 : gauss(rng) * clusterArc), L);
      const d = clamp(dCentre + (k === 0 ? 0 : gauss(rng) * clusterLat), band[0], band[1]);
      const lateral = side * (terrain.track.halfWidthAt(s) + WALL_OFFSET + d);
      if (tooClose(s, lateral)) continue;
      const pos = terrain.place(s, lateral, new THREE.Vector3());
      const item = { s, lateral, d, side, pos, u: rng(), v: rng(), w: rng() };
      if (accept && !accept(item)) continue;
      remember(s, lateral);
      out.push(item);
    }
  }

  out.sort((a, b) => a.s - b.s);
  return out;
}

const _tn = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _te1 = new THREE.Vector3();
const _te2 = new THREE.Vector3();

/**
 * Terrain normal by central differences over the sampler.
 *
 * Props are tilted toward this rather than left plumb: a rock standing
 * perfectly upright on a 20-degree dune is the second-most obvious tell of
 * procedural placement after even spacing.
 */
export function terrainNormal(terrain, s, lateral, out = new THREE.Vector3(), h = 4) {
  terrain.place(s + h, lateral, _tn[0]);
  terrain.place(s - h, lateral, _tn[1]);
  terrain.place(s, lateral + h, _tn[2]);
  terrain.place(s, lateral - h, _tn[3]);
  _te1.subVectors(_tn[0], _tn[1]);
  _te2.subVectors(_tn[2], _tn[3]);
  out.crossVectors(_te2, _te1).normalize();
  if (out.y < 0) out.negate();
  if (!isFinite(out.x)) out.set(0, 1, 0);
  return out;
}

const UP = new THREE.Vector3(0, 1, 0);
const _pq = new THREE.Quaternion();
const _pq2 = new THREE.Quaternion();
const _pv = new THREE.Vector3();
const _paxis = new THREE.Vector3();

/**
 * Instance transform: slope alignment, then a lean, then yaw.
 * `align` is a blend so a tree can take a fraction of the slope (trees grow
 * toward the light, boulders sit flat) rather than an all-or-nothing choice.
 */
export function poseMatrix(pos, opts = {}, out = new THREE.Matrix4()) {
  const { yaw = 0, normal = null, align = 0, lean = 0, leanDir = 0, scale = 1 } = opts;
  _pq.identity();
  if (normal && align > 0) {
    _pq2.setFromUnitVectors(UP, normal);
    _pq.slerp(_pq2, clamp01(align));
  }
  if (lean !== 0) {
    _paxis.set(Math.cos(leanDir), 0, Math.sin(leanDir));
    _pq2.setFromAxisAngle(_paxis, lean);
    _pq.multiply(_pq2);
  }
  if (yaw !== 0) {
    _pq2.setFromAxisAngle(UP, yaw);
    _pq.multiply(_pq2);
  }
  const s = typeof scale === 'number' ? _pv.set(scale, scale, scale) : _pv.set(scale[0], scale[1], scale[2]);
  return out.compose(pos, _pq, s);
}

// ---------------------------------------------------------------------------
// Contact shadows
// ---------------------------------------------------------------------------

/**
 * A soft dark disc, falloff baked into vertex colours so it needs no texture
 * and no alpha sorting — it is multiplied straight onto whatever is behind it.
 */
export function blobGeometry(segments = 14) {
  const positions = [0, 0, 0];
  const colors = [1, 1, 1];
  const uvs = [0.5, 0.5];
  const rings = [[0.0, 0.45], [0.52, 0.62], [1.0, 1.0]];
  const idx = [];
  for (const [r, shade] of rings) {
    if (r === 0) { colors[0] = colors[1] = colors[2] = shade; continue; }
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * TAU;
      positions.push(Math.cos(th) * r, 0, Math.sin(th) * r);
      colors.push(shade, shade, shade);
      uvs.push(0.5 + Math.cos(th) * 0.5 * r, 0.5 + Math.sin(th) * 0.5 * r);
    }
  }
  const m = segments + 1;
  for (let j = 0; j < segments; j++) idx.push(0, 1 + j + 1, 1 + j);
  for (let j = 0; j < segments; j++) {
    const a = 1 + j, b = 1 + m + j;
    idx.push(a, b + 1, b, a, a + 1, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Multiply-blended ambient occlusion under props.
 *
 * The shadow map only covers a box around the player, so anything past ~80 m
 * has no grounding cue at all and floats. This supplies the ambient-occlusion
 * half of the contact — the part that exists whether or not the sun is out.
 * Fog has to be undone by hand: a multiplier faded toward the fog colour is
 * still a multiplier, so without this the far props stamp hard dark discs onto
 * a wall of haze.
 */
export function blobMaterial(fogDensity = 0) {
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.MultiplyBlending,
    // Three's blend-func table for MultiplyBlending is (ZERO, SRC_COLOR),
    // which is only correct for premultiplied source; it warns otherwise.
    premultipliedAlpha: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const dens = fogDensity.toFixed(6);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vClear;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { float fd = ${dens} * max(-mvPosition.z, 0.0); vClear = 1.0 - exp(-fd * fd); }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vClear;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), vClear);');
  };
  mat.customProgramCacheKey = () => `blob${dens}`;
  return mat;
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
 * Omitting `color` keeps whatever colours the source geometry already carries,
 * so a part painted by `paintGeometry` can be merged without being flattened.
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
    const srcC = p.color === undefined ? g.attributes.color : null;
    col.set(p.color === undefined ? 0xffffff : p.color);
    for (let i = 0; i < src.count; i++) {
      if (srcC) col.setRGB(srcC.getX(i), srcC.getY(i), srcC.getZ(i));
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
export function sweepStack(points, sides = 8, { capStart = true, capEnd = true, vScale = 0.25, radial = null } = {}) {
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
    const r0 = points[i].r;
    for (let j = 0; j <= sides; j++) {
      const th = (j / sides) * TAU;
      // `radial` must be periodic in `th` over TAU or the seam splits open,
      // which is why it is handed the angle rather than the vertex index.
      const r = radial ? r0 * radial(th, i / Math.max(n - 1, 1)) : r0;
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
export function columnGeometry(height, r0, r1, {
  segs = 6, sides = 7, bendX = 0, bendZ = 0, curve = 2,
  flute = 0, ribs = 7, capStart = false,
} = {}) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const k = Math.pow(t, curve);
    pts.push({ p: new THREE.Vector3(bendX * k, height * t, bendZ * k), r: lerp(r0, r1, t) });
  }
  // Fluting in the *geometry*, not just in the vertex colour. A saguaro is
  // read almost entirely as a silhouette against sand, and a smooth cylinder
  // painted with stripes still has the outline of a bollard. `ribs` must stay
  // integral so the ring closes, and `sides` should be an exact multiple of it
  // so each ridge and each valley lands on a vertex instead of somewhere
  // between two.
  return sweepStack(pts, sides, {
    capStart, capEnd: true,
    radial: flute > 0 ? (th) => 1 - flute * (0.5 - 0.5 * Math.cos(th * ribs)) : null,
  });
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
 * A flat-topped mesa, one unit tall, standing on y = 0.
 *
 * Four scales of irregularity, because a butte's *silhouette* is the whole
 * read at the distance these are seen from and a stack of near-circular rings
 * gives a straight vertical edge against the sky — the single thing the critic
 * called out on the far slabs:
 *
 *   - the mass wobbles ring to ring (`wobble`);
 *   - the cliff face is fluted vertically, which is what erosion does to a
 *     sandstone wall and what breaks a flat edge into a serrated one;
 *   - a minority of faces carry a deep gully, because weathering around a
 *     butte is never even and a rim that varies evenly reads as lathe work;
 *   - the cap rim is notched per side, so the top edge is a broken line rather
 *     than one horizontal cut.
 */
export function mesaGeometry(rng, {
  rings = 8, sides = 13, wobble = 0.16, flute = 0.085, rim = 0.075, gullies = 0.34,
} = {}) {
  const positions = [], uvs = [], idx = [];
  const phase = [], fluteP = [], gully = [], rimY = [];
  for (let j = 0; j < sides; j++) {
    phase.push(rng() * TAU);
    fluteP.push(rng() * TAU);
    gully.push(rng() < gullies ? lerp(0.10, 0.26, rng()) : 0);
    // Biased toward zero: most of the rim is at full height and a few faces
    // are cut well back, which is how a cap rock actually fails.
    rimY.push(-Math.pow(rng(), 1.7) * rim);
  }
  const profileR = (t) => {
    // Talus apron, a near-vertical cliff, then a slight cap overhang.
    if (t < 0.24) return lerp(1.38, 1.02, smoothstep(t / 0.24));
    if (t < 0.86) return lerp(1.02, 0.93, (t - 0.24) / 0.62);
    return lerp(0.93, 0.74, (t - 0.86) / 0.14);
  };
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const rBase = profileR(t);
    for (let j = 0; j <= sides; j++) {
      const jj = j % sides;
      const th = (j / sides) * TAU;
      let r = rBase * (1 + Math.sin(phase[jj] + t * 1.7) * wobble + Math.sin(phase[jj] * 2.3) * wobble * 0.5);
      // Fluting fades out into the talus, where scree has filled the channels.
      r *= 1 - Math.abs(Math.sin(fluteP[jj] + t * 5.5)) * flute * smoothstep(clamp01((t - 0.16) / 0.36));
      r *= 1 - gully[jj] * Math.pow(clamp01(1 - Math.abs(t - 0.62) / 0.44), 1.6);
      // The rim notch only opens over the top fifth, so the cliff below it
      // stays plumb.
      positions.push(Math.cos(th) * r, t + rimY[jj] * Math.pow(t, 6), Math.sin(th) * r);
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
  // Cap. The apex sits slightly proud of the rim so the top is a low dome —
  // a flat disc reads as a cut, and its edge is the straight line above.
  const top = rings * m;
  const c = positions.length / 3;
  positions.push(0, 1 + rim * 0.35, 0); uvs.push(0.5, 1);
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

/**
 * Multiply a merged geometry's vertex colours toward black near its base.
 *
 * Every prop here is instanced, so it gets no baked lightmap and no
 * screen-space AO. Darkening the last half-metre of a trunk or the underside
 * of a boulder is what stops it reading as a decal pasted onto the ground —
 * it costs nothing at runtime and it survives being seen from any angle.
 */
export function darkenBase(geo, { height = 0.8, amount = 0.42, y0 = 0 } = {}) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  if (!col) return geo;
  for (let i = 0; i < pos.count; i++) {
    const k = clamp01((pos.getY(i) - y0) / height);
    const f = lerp(1 - amount, 1, smoothstep(k));
    col.setXYZ(i, col.getX(i) * f, col.getY(i) * f, col.getZ(i) * f);
  }
  col.needsUpdate = true;
  return geo;
}

/**
 * A grass/scrub tuft: blades splayed out of one point, each a tapered strip
 * that curves over. Two-sided, so four blades give eight readable silhouettes
 * for sixteen triangles — the cheapest ground cover that still moves.
 */
export function tuftGeometry(rng, { blades = 4, height = 0.8, width = 0.13, segs = 2, spread = 0.55, curl = 0.5 } = {}) {
  const positions = [], uvs = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const th = (b / blades) * TAU + rng() * 0.9;
    const dx = Math.cos(th), dz = Math.sin(th);
    const h = height * (0.55 + rng() * 0.75);
    const lean = spread * (0.5 + rng());
    const base = positions.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // Rises, then falls away outward — a blade that only rises reads as a spike.
      const out = h * lean * (t * 0.55 + curl * t * t);
      const y = h * (t - curl * 0.42 * t * t);
      const w = width * (1 - t * 0.92);
      positions.push(dx * out - dz * w, y, dz * out + dx * w); uvs.push(0, t);
      positions.push(dx * out + dz * w, y, dz * out - dx * w); uvs.push(1, t);
    }
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** A shrub: two or three squashed deformed spheres, which reads as foliage mass. */
export function blobClusterGeometry(rng, { lobes = 3, detail = 0, spread = 0.5, squash = 0.72 } = {}) {
  const parts = [];
  for (let i = 0; i < lobes; i++) {
    const r = 0.55 + rng() * 0.5;
    const th = rng() * TAU;
    const rad = i === 0 ? 0 : spread * (0.4 + rng());
    parts.push({
      geo: rockGeometry(rng, { detail, rough: 0.30, squash }),
      color: 0xffffff,
      m: T([Math.cos(th) * rad, r * 0.55 + rng() * 0.18, Math.sin(th) * rad], [0, rng() * TAU, 0], r),
    });
  }
  return mergeParts(parts);
}

/**
 * A spectator: tapered body, ball head, and optionally raised arms.
 * Deliberately crude — at grandstand distance a crowd is a shimmering colour
 * field, and the only two things that read are silhouette variety and motion.
 */
export function personGeometry(rng, { armsUp = false, skin = 0xe8c6a8 } = {}) {
  // One unit tall from sole to crown, so a caller scales by the height it
  // wants in metres. Proportions matter more than detail: at any distance a
  // figure that is too wide for its height reads as a bollard, not a person.
  // Hips narrower than shoulders, in one five-sided sweep. A straight cylinder
  // at human proportions reads as a candle, and the taper is most of what
  // makes it read as a torso — but a grandstand holds a thousand of these, so
  // it buys that silhouette in one sweep and an octahedron head, not four
  // primitives. Under forty triangles each.
  //
  // Three rings described a cone with a ball on it — which is a capsule, and
  // that is what a grandstand of them read as. A human silhouette at this
  // distance is carried by four features and none of them is detail: a waist
  // that is narrower than both the hips and the shoulders, shoulders that are
  // the widest thing below the head, a *neck* (the gap is what separates head
  // from body at twenty pixels), and arms breaking the outline at the sides.
  // Two more rings and two three-sided sticks buy all four inside the same
  // instanced draw, which is the constraint that matters here.
  const parts = [
    {
      geo: sweepStack([
        { p: new THREE.Vector3(0, 0.00, 0), r: 0.105 },   // planted, not floating
        { p: new THREE.Vector3(0, 0.30, 0), r: 0.128 },   // hips
        { p: new THREE.Vector3(0, 0.48, 0), r: 0.112 },   // waist
        { p: new THREE.Vector3(0, 0.68, 0), r: 0.175 },   // shoulders
        { p: new THREE.Vector3(0, 0.78, 0), r: 0.062 },   // neck
      // The neck cap is inside the head; only the sole needs closing, and it
      // needs closing because a stand is looked *up* at from the road.
      ], 5, { capStart: true, capEnd: false }),
      color: 0xffffff,
    },
    { geo: new THREE.OctahedronGeometry(0.118, 0), color: skin, m: T([0, 0.885, 0], [0, 0.4, 0], [1, 0.92, 1]) },
  ];
  // Arms either way. Raised is the celebration pose; hanging is what the rest
  // of the crowd is doing, and a figure with no arms at all is the bollard.
  for (const s of [-1, 1]) {
    // Asymmetric by a hair, off the caller's own generator: two spectators
    // standing in identical mirror-image poses is its own kind of tell.
    const j = (rng() - 0.5) * 0.28;
    parts.push(armsUp
      ? {
        geo: columnGeometry(0.34, 0.045, 0.034, { segs: 1, sides: 3, curve: 1 }),
        color: skin,
        m: T([s * 0.15, 0.50, 0], [0, 0, s * -0.34 + j * 0.5]),
      }
      : {
        geo: columnGeometry(0.36, 0.048, 0.036, { segs: 1, sides: 3, curve: 1 }),
        color: skin,
        m: T([s * 0.165, 0.63, 0.01], [0.10 + j, 0, s * 0.10 + Math.PI]),
      });
  }
  return mergeParts(parts);
}

/**
 * A pennant/flag along +X, subdivided so `applyFlag` has something to wave.
 * Built as a single-sided sheet rendered DoubleSide — a flag with thickness is
 * geometry spent on something nobody can see.
 */
export function pennantGeometry(span = 1.6, drop = 0.9, { segs = 6, taper = 0.45 } = {}) {
  const positions = [], uvs = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const hh = drop * lerp(1, taper, t);
    positions.push(span * t, 0, 0); uvs.push(t, 1);
    positions.push(span * t, -hh, 0); uvs.push(t, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
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

// ---------------------------------------------------------------------------
// Landforms
// ---------------------------------------------------------------------------

/**
 * The terrain's own texture set, for props that are made of the same rock.
 *
 * `ProcTex` caches on `(generator, size, seed, tint)` and `TrackBuilder` builds
 * the terrain from exactly this call, so asking for it a second time returns
 * the identical texture objects. A mesa sharing the ground's maps is therefore
 * free in memory, free in generation time, and — the point — cannot drift out
 * of step with the ground when the ground's tint is retuned.
 */
export function groundTexturesFor(theme) {
  const fn = theme.key === 'coast' ? Tex.sand : Tex.dirt;
  return fn({ size: 1024, tint: theme.groundColor });
}

/**
 * Landform material: ground texture projected triplanar, strata by world
 * height, contact darkening at the base.
 *
 * Landmark props are the one family in this folder that cannot be UV-mapped.
 * A mesa is a swept ring stack, an arch is a bent tube, and both are scaled
 * non-uniformly per instance — so any UV they carry is stretched by a
 * different factor on every face, and by a different factor again on the next
 * copy. Projecting from the three world axes removes the question, and using
 * the *ground's* maps to do it is what stops a formation reading as a prop
 * dropped next to the terrain rather than as part of it.
 *
 * Everything tunable is a uniform rather than a baked constant, so every
 * landform on a track shares one compiled program regardless of its settings.
 */
export function rockMaterial(tex, {
  tile = 14,             // metres per texture repeat — the terrain's own figure
  macro = 0.16,          // second, wider sample: breaks the tile on a 200 m butte
  macroDepth = 0.34,
  strata = 3.6,          // metres per sedimentary bed
  strataDepth = 0.20,
  strataWarp = 2.6,      // metres the bed contact wanders, so it is not a contour
  normalStrength = 0.85,
  contact = 0.40,        // how dark the last metres before the ground go
  contactFall = 6.0,     // over how many metres
  baseY = 0,             // ground height for non-instanced meshes
  ...rest
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    vertexColors: true,
    metalness: 0.0,
    roughness: 1.0,
    envMapIntensity: 0.55,
    ...rest,
  });
  const u = {
    uHkTile: { value: 1 / tile },
    uHkMacro: { value: macro },
    uHkMacroDepth: { value: macroDepth },
    uHkLuma: { value: Math.max(tex.meanLuma ?? 0.2, 1e-3) },
    uHkStrata: { value: TAU / Math.max(strata, 0.2) },
    uHkStrataDepth: { value: strataDepth },
    uHkWarp: { value: strataWarp },
    uHkNormal: { value: normalStrength },
    uHkContact: { value: contact },
    uHkFall: { value: Math.max(contactFall, 0.1) },
    uHkBaseY: { value: baseY },
  };
  mat.userData.rock = u;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uHkBaseY;
varying vec3 vHkW;
varying float vHkBase;`)
      // After <project_vertex>, so shader-side animation that moved
      // `transformed` is already accounted for.
      .replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
  vHkW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  // Props are placed *at* the terrain, so the instance origin is the contact
  // point. That is the only per-copy ground height available to the shader.
  vHkBase = ( modelMatrix * instanceMatrix[ 3 ] ).y;
#else
  vHkW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vHkBase = uHkBaseY;
#endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uHkTile, uHkMacro, uHkMacroDepth, uHkLuma;
uniform float uHkStrata, uHkStrataDepth, uHkWarp, uHkNormal, uHkContact, uHkFall;
varying vec3 vHkW;
varying float vHkBase;`)
      .replace('#include <map_fragment>', `
// Weights from the *geometric* world normal: derivatives of world position are
// exact under any instance scale, which the interpolated normal is not.
vec3 hkGeoN = normalize( cross( dFdx( vHkW ), dFdy( vHkW ) ) );
vec3 hkB = pow( abs( hkGeoN ), vec3( 4.0 ) );
hkB /= dot( hkB, vec3( 1.0 ) ) + 1e-5;
vec2 hkUvX = vHkW.zy * uHkTile;
vec2 hkUvY = vHkW.xz * uHkTile;
vec2 hkUvZ = vHkW.xy * uHkTile;
vec3 hkAlb = texture2D( map, hkUvX ).rgb * hkB.x
           + texture2D( map, hkUvY ).rgb * hkB.y
           + texture2D( map, hkUvZ ).rgb * hkB.z;
// One wide tap over the top. A 14 m tile repeats fourteen times up a butte and
// the eye reads that as wallpaper; pivoting on the map's own mean adds the
// drift without moving the formation's overall value.
float hkMacro = dot( texture2D( map, hkUvZ * uHkMacro + vec2( 0.37, 0.11 ) ).rgb,
                     vec3( 0.2126, 0.7152, 0.0722 ) );
hkAlb *= mix( 1.0, hkMacro / uHkLuma, uHkMacroDepth );
// Strata. Beds a couple of metres thick are what say "sedimentary rock"
// rather than "painted cone", and they read from a kilometre away. The
// contact wanders with the macro sample so it is geology, not a contour line.
hkAlb *= 1.0 + sin( ( vHkW.y + hkMacro * uHkWarp ) * uHkStrata ) * uHkStrataDepth;
// Contact darkening. The shadow map is a box around the player and these
// formations spend most of the lap outside it, so without this the base of
// every one of them is the same value as its sunlit cap and it floats.
hkAlb *= mix( 1.0 - uHkContact, 1.0, smoothstep( 0.0, 1.0, max( vHkW.y - vHkBase, 0.0 ) / uHkFall ) );
diffuseColor.rgb *= hkAlb;`)
      .replace('#include <normal_fragment_maps>', `
vec3 hkNX = texture2D( normalMap, hkUvX ).xyz * 2.0 - 1.0;
vec3 hkNY = texture2D( normalMap, hkUvY ).xyz * 2.0 - 1.0;
vec3 hkNZ = texture2D( normalMap, hkUvZ ).xyz * 2.0 - 1.0;
// Added to the shading normal, not swizzled into place over it: a blend that
// replaces the normal snaps a 40-degree cliff face onto whichever world axis
// won the weights, which is the classic triplanar tell. Adding the in-plane
// part keeps the face pointing where the geometry points.
vec3 hkD = vec3( 0.0, hkNX.y, hkNX.x ) * hkB.x
         + vec3( hkNY.x, 0.0, hkNY.y ) * hkB.y
         + vec3( hkNZ.x, hkNZ.y, 0.0 ) * hkB.z;
normal = normalize( normal + mat3( viewMatrix ) * hkD * uHkNormal );`);
  };
  // One program for every landform on the track: the tuning all rides in
  // uniforms, so nothing here forks the shader.
  mat.customProgramCacheKey = () => 'hk-rock';
  return mat;
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

/**
 * Flags and banners: a travelling wave whose amplitude grows away from the
 * hoist, so the fixed edge stays pinned to its pole instead of swimming.
 */
export function applyFlag(mat, { amp = 0.3, freq = 3.2, span = 1.6 } = {}) {
  return inject(mat, `|flag${amp}${freq}${span}`, '', `
    ${INSTANCE_ORIGIN}
    float ft = clamp(transformed.x / ${span.toFixed(3)}, 0.0, 1.0);
    float fw = sin(uTime * ${freq.toFixed(3)} + iPhase * 4.1 - ft * 6.2);
    transformed.z += fw * ${amp.toFixed(3)} * ft * ft;
    transformed.y += cos(uTime * ${(freq * 0.77).toFixed(3)} + iPhase * 2.7 - ft * 4.4)
                   * ${(amp * 0.30).toFixed(3)} * ft;
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
 * A strip of trackside hoardings, one cell per sponsor.
 *
 * The strip is what tiles along the barrier, so its cell count *is* the
 * circuit's advertising vocabulary: at four cells the player reads the same
 * two boards six times between one corner and the next, which is the loudest
 * possible statement that the world is generated. Eight brands, each with its
 * own layout as well as its own palette, is enough that no two adjacent boards
 * repeat and a run has to be a hundred metres long before the cycle closes.
 *
 * Layout variety matters as much as the count. Four boards that differ only in
 * their wordmark still read as one board recoloured — a real barrier carries
 * centred marks, stacked lockups and full-bleed chevrons side by side.
 *
 * Returns the texture with `userData.cells` set, because every caller has to
 * scale its UVs by the cell count to keep panels at a real 3 m width.
 */
export function bannerStripTexture(palette, brands) {
  const cells = brands.length;
  const CW = 512, H = 256, W = CW * cells;
  const c = canvasOf(W, H);
  const g = c.getContext('2d');

  // Fit to the box rather than trusting a point size: the brand names differ
  // in length by a factor of two and a fixed size either overflows the short
  // boards or leaves the long ones unreadable at distance.
  const fit = (text, px, maxW, weight = 'bold') => {
    let size = px;
    g.font = `${weight} ${Math.round(size)}px Helvetica, Arial, sans-serif`;
    const w = g.measureText(text).width;
    if (w > maxW) {
      size *= maxW / w;
      g.font = `${weight} ${Math.round(size)}px Helvetica, Arial, sans-serif`;
    }
    return size;
  };

  for (let i = 0; i < cells; i++) {
    const x0 = i * CW;
    const b = brands[i];
    const p = palette[i % palette.length];
    g.save();
    g.beginPath(); g.rect(x0, 0, CW, H); g.clip();
    g.fillStyle = p.bg;
    g.fillRect(x0, 0, CW, H);
    g.textBaseline = 'middle';
    const layout = i % 4;

    if (layout === 0) {
      // Diagonal accent sweep with the wordmark on the dark half.
      g.fillStyle = p.accent;
      g.beginPath();
      g.moveTo(x0 + CW * 0.60, 0); g.lineTo(x0 + CW * 1.02, 0);
      g.lineTo(x0 + CW * 1.02, H); g.lineTo(x0 + CW * 0.44, H);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.beginPath();
      g.moveTo(x0 + CW * 0.52, 0); g.lineTo(x0 + CW * 0.60, 0);
      g.lineTo(x0 + CW * 0.44, H); g.lineTo(x0 + CW * 0.36, H);
      g.closePath(); g.fill();
      g.fillStyle = p.fg;
      g.textAlign = 'left';
      fit(b.name, H * 0.46, CW * 0.50);
      g.fillText(b.name, x0 + CW * 0.06, H * 0.52);
    } else if (layout === 1) {
      // Centred wordmark between two rules, with a strapline under it.
      g.strokeStyle = p.accent;
      g.lineWidth = H * 0.045;
      g.beginPath();
      g.moveTo(x0 + CW * 0.10, H * 0.17); g.lineTo(x0 + CW * 0.90, H * 0.17);
      g.moveTo(x0 + CW * 0.10, H * 0.83); g.lineTo(x0 + CW * 0.90, H * 0.83);
      g.stroke();
      g.fillStyle = p.fg;
      g.textAlign = 'center';
      fit(b.name, H * 0.40, CW * 0.76);
      g.fillText(b.name, x0 + CW * 0.5, H * 0.44);
      fit(b.sub, H * 0.15, CW * 0.66, '');
      g.globalAlpha = 0.75;
      g.fillText(b.sub, x0 + CW * 0.5, H * 0.68);
      g.globalAlpha = 1;
    } else if (layout === 2) {
      // A mark in a keyline box, wordmark right of it. The glyph is what makes
      // a board legible at the distance the lettering has already dissolved.
      g.fillStyle = p.accent;
      g.fillRect(x0, 0, CW * 0.30, H);
      g.fillStyle = p.fg;
      g.save();
      g.translate(x0 + CW * 0.15, H * 0.5);
      g.rotate(Math.PI * 0.25);
      g.fillRect(-H * 0.20, -H * 0.20, H * 0.40, H * 0.40);
      g.restore();
      g.fillStyle = p.bg;
      g.save();
      g.translate(x0 + CW * 0.15, H * 0.5);
      g.rotate(Math.PI * 0.25);
      g.fillRect(-H * 0.09, -H * 0.09, H * 0.18, H * 0.18);
      g.restore();
      g.fillStyle = p.fg;
      g.textAlign = 'left';
      fit(b.name, H * 0.42, CW * 0.62);
      g.fillText(b.name, x0 + CW * 0.36, H * 0.5);
    } else {
      // Full-bleed chevrons behind a right-aligned lockup.
      g.fillStyle = p.accent;
      for (let k = -1; k < 5; k++) {
        g.beginPath();
        const bx = x0 + CW * (0.02 + k * 0.14);
        g.moveTo(bx, H); g.lineTo(bx + CW * 0.09, 0);
        g.lineTo(bx + CW * 0.15, 0); g.lineTo(bx + CW * 0.06, H);
        g.closePath(); g.fill();
      }
      g.fillStyle = p.bg;
      g.globalAlpha = 0.82;
      g.fillRect(x0 + CW * 0.30, 0, CW * 0.70, H);
      g.globalAlpha = 1;
      g.fillStyle = p.fg;
      g.textAlign = 'right';
      fit(b.name, H * 0.38, CW * 0.60);
      g.fillText(b.name, x0 + CW * 0.94, H * 0.40);
      fit(b.sub, H * 0.155, CW * 0.56, '');
      g.globalAlpha = 0.7;
      g.fillText(b.sub, x0 + CW * 0.94, H * 0.66);
      g.globalAlpha = 1;
    }

    // Border keeps panels reading as separate boards at a distance.
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 8;
    g.strokeRect(x0 + 4, 4, CW - 8, H - 8);
    g.restore();
  }
  const t = texFrom(c, { srgb: true });
  t.userData.cells = cells;
  return t;
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

/**
 * A single mote: a soft round core with a long tail into nothing.
 *
 * `PointsMaterial` with no map draws `gl_PointCoord` untouched, which is a
 * hard axis-aligned square — at any size above two pixels that is instantly
 * legible as a quad, and hundreds of them read as dirt on the lens. Written as
 * ImageData rather than a canvas gradient so the alpha ramp is exactly the
 * curve asked for and never passes through the 2D context's premultiplication.
 */
export function moteTexture(size = 64, core = 0.16, gamma = 2.6) {
  const c = canvasOf(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
      const r = Math.hypot(dx, dy);
      // Flat core, then a power falloff: a pure gaussian has no centre and
      // reads as fog, a hard disc has no glow and reads as a hole punch.
      const a = r >= 1 ? 0 : Math.pow(clamp01(1 - Math.max(r - core, 0) / (1 - core)), gamma);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = texFrom(c, { srgb: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
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
