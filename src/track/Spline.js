import * as THREE from 'three';
import { clamp, lerp, mod, ringDelta, wrapAngle } from '../core/MathX.js';

/**
 * Arc-length parameterized closed track spline with a rotation-minimizing
 * frame, per-point width/bank, and a uniform-grid nearest-point query.
 *
 * Everything downstream (physics ground contact, AI racing line, minimap,
 * item projectiles, prop scattering) talks to the track through this class,
 * so the road surface is defined in exactly one place.
 */
export class TrackSpline {
  /**
   * @param {Array<{p:[number,number,number], width?:number, bank?:number, surface?:string}>} nodes
   * @param {{samples?:number, closed?:boolean, tension?:number}} opts
   */
  constructor(nodes, opts = {}) {
    this.nodes = nodes;
    this.closed = opts.closed !== false;
    const samples = opts.samples || 2400;

    const pts = nodes.map((n) => new THREE.Vector3(n.p[0], n.p[1], n.p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, this.closed, 'centripetal', opts.tension ?? 0.5);

    // --- Uniform arc-length resample -------------------------------------
    // CatmullRomCurve3's own getSpacedPoints is fine but we need tangents,
    // widths and banks on the same grid, so we build the table ourselves.
    const dense = samples * 4;
    const rawPts = [];
    const rawU = [];
    let acc = 0;
    let prev = this.curve.getPoint(0);
    rawPts.push(prev.clone());
    rawU.push(0);
    const cumulative = [0];
    for (let i = 1; i <= dense; i++) {
      const u = i / dense;
      const p = this.curve.getPoint(u);
      acc += p.distanceTo(prev);
      cumulative.push(acc);
      rawPts.push(p.clone());
      rawU.push(u);
      prev = p;
    }
    this.length = acc;

    this.count = samples;
    this.ds = this.length / samples;

    this.pos = new Float32Array(samples * 3);
    this.tangent = new Float32Array(samples * 3);
    this.normal = new Float32Array(samples * 3);   // road up (banked)
    this.right = new Float32Array(samples * 3);    // road right (banked)
    this.width = new Float32Array(samples);
    this.bank = new Float32Array(samples);
    this.curvature = new Float32Array(samples);
    this.heading = new Float32Array(samples);
    this.surfaceId = new Uint8Array(samples);

    // Resample position on uniform arc length.
    let cursor = 0;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < samples; i++) {
      const target = (i / samples) * this.length;
      while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor++;
      const seg = cumulative[cursor + 1] - cumulative[cursor];
      const t = seg > 1e-6 ? (target - cumulative[cursor]) / seg : 0;
      tmp.lerpVectors(rawPts[cursor], rawPts[cursor + 1], t);
      this.pos[i * 3] = tmp.x; this.pos[i * 3 + 1] = tmp.y; this.pos[i * 3 + 2] = tmp.z;
    }

    // Tangents from central differences on the uniform grid.
    const a = new THREE.Vector3(), b = new THREE.Vector3(), tan = new THREE.Vector3();
    for (let i = 0; i < samples; i++) {
      this._getPos(mod(i + 1, samples), a);
      this._getPos(mod(i - 1, samples), b);
      tan.subVectors(a, b).normalize();
      this.tangent[i * 3] = tan.x; this.tangent[i * 3 + 1] = tan.y; this.tangent[i * 3 + 2] = tan.z;
      this.heading[i] = Math.atan2(tan.x, tan.z);
    }

    // Curvature (signed, in the horizontal plane) — drives AI braking and
    // procedural banking when a track doesn't author its own.
    for (let i = 0; i < samples; i++) {
      const h0 = this.heading[mod(i - 1, samples)];
      const h1 = this.heading[mod(i + 1, samples)];
      this.curvature[i] = wrapAngle(h1 - h0) / (2 * this.ds);
    }
    // Smooth curvature; raw central differences are noisy at this resolution.
    this.curvature = smoothRing(this.curvature, 12, 2);

    // --- Per-sample width / bank / surface from authored nodes ------------
    // Node i sits at arc position of its projected u; interpolate between them.
    const nodeS = nodes.map((n, idx) => {
      const u = this.closed ? idx / nodes.length : idx / (nodes.length - 1);
      // Convert curve-u to arc length by sampling the cumulative table.
      const k = clamp(Math.round(u * dense), 0, dense);
      return cumulative[k];
    });

    for (let i = 0; i < samples; i++) {
      const s = (i / samples) * this.length;
      const { i0, i1, t } = locateNode(nodeS, s, this.length, this.closed);
      const n0 = nodes[i0], n1 = nodes[i1];
      this.width[i] = lerp(n0.width ?? 14, n1.width ?? 14, t);
      const bank0 = n0.bank ?? null, bank1 = n1.bank ?? null;
      if (bank0 === null && bank1 === null) {
        this.bank[i] = NaN; // resolved below from curvature
      } else {
        this.bank[i] = lerp(bank0 ?? 0, bank1 ?? 0, t);
      }
      this.surfaceId[i] = (t < 0.5 ? n0.surface : n1.surface) === 'boost' ? 1 : 0;
    }

    // Auto-bank where unauthored: lean into the corner, proportional to how
    // hard it is, capped so karts never feel like they're on a wall.
    const autoBank = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      autoBank[i] = clamp(-this.curvature[i] * 210, -0.30, 0.30);
    }
    const smoothedAuto = smoothRing(autoBank, 40, 2);
    for (let i = 0; i < samples; i++) {
      if (Number.isNaN(this.bank[i])) this.bank[i] = smoothedAuto[i];
    }
    this.bank = smoothRing(this.bank, 16, 1);
    this.width = smoothRing(this.width, 10, 1);

    // --- Frames ----------------------------------------------------------
    // Rotation-minimizing frame (double reflection) keeps the road from
    // twisting on steep elevation changes, then bank is applied on top.
    this._buildFrames();

    // --- Spatial grid for nearest-sample queries -------------------------
    this._buildGrid();

    this.startIndex = 0;
  }

  _getPos(i, out) {
    out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    return out;
  }

  _buildFrames() {
    const n = this.count;
    const t0 = new THREE.Vector3(), t1 = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3(), rgt = new THREE.Vector3();
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

    // Seed the frame with world-up projected perpendicular to the tangent.
    t0.set(this.tangent[0], this.tangent[1], this.tangent[2]);
    nrm.copy(up).addScaledVector(t0, -up.dot(t0)).normalize();
    if (!Number.isFinite(nrm.x) || nrm.lengthSq() < 1e-6) nrm.set(0, 1, 0);

    const rawNormal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rawNormal[i * 3] = nrm.x; rawNormal[i * 3 + 1] = nrm.y; rawNormal[i * 3 + 2] = nrm.z;
      const j = mod(i + 1, n);
      this._getPos(i, p0); this._getPos(j, p1);
      t0.set(this.tangent[i * 3], this.tangent[i * 3 + 1], this.tangent[i * 3 + 2]);
      t1.set(this.tangent[j * 3], this.tangent[j * 3 + 1], this.tangent[j * 3 + 2]);

      // Double-reflection transport (Wang et al.) — stable and cheap.
      v1.subVectors(p1, p0);
      const c1 = v1.lengthSq();
      if (c1 < 1e-12) continue;
      const nL = nrm.clone().addScaledVector(v1, (-2 / c1) * v1.dot(nrm));
      const tL = t0.clone().addScaledVector(v1, (-2 / c1) * v1.dot(t0));
      v2.subVectors(t1, tL);
      const c2 = v2.lengthSq();
      if (c2 < 1e-12) { nrm.copy(nL); continue; }
      nrm.copy(nL).addScaledVector(v2, (-2 / c2) * v2.dot(nL)).normalize();
    }

    // Closing the loop leaves a twist error; distribute it around the ring.
    if (this.closed) {
      const first = new THREE.Vector3(rawNormal[0], rawNormal[1], rawNormal[2]);
      const last = nrm.clone();
      const tEnd = new THREE.Vector3(this.tangent[0], this.tangent[1], this.tangent[2]);
      const refRight = new THREE.Vector3().crossVectors(tEnd, first).normalize();
      let err = Math.atan2(last.dot(refRight), last.dot(first));
      err = wrapAngle(err);
      const q = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const f = i / n;
        axis.set(this.tangent[i * 3], this.tangent[i * 3 + 1], this.tangent[i * 3 + 2]);
        q.setFromAxisAngle(axis, -err * f);
        nrm.set(rawNormal[i * 3], rawNormal[i * 3 + 1], rawNormal[i * 3 + 2]).applyQuaternion(q);
        rawNormal[i * 3] = nrm.x; rawNormal[i * 3 + 1] = nrm.y; rawNormal[i * 3 + 2] = nrm.z;
      }
    }

    // Apply bank around the tangent to get the final road frame.
    const q = new THREE.Quaternion(), axis = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      axis.set(this.tangent[i * 3], this.tangent[i * 3 + 1], this.tangent[i * 3 + 2]);
      nrm.set(rawNormal[i * 3], rawNormal[i * 3 + 1], rawNormal[i * 3 + 2]);
      q.setFromAxisAngle(axis, this.bank[i]);
      nrm.applyQuaternion(q).normalize();
      // Right-handed: right = up x forward. Using forward x up instead yields a
      // left-handed frame, which silently winds every generated road strip
      // backwards — the surface then renders back-facing and is culled.
      rgt.crossVectors(nrm, axis).normalize();
      this.normal[i * 3] = nrm.x; this.normal[i * 3 + 1] = nrm.y; this.normal[i * 3 + 2] = nrm.z;
      this.right[i * 3] = rgt.x; this.right[i * 3 + 1] = rgt.y; this.right[i * 3 + 2] = rgt.z;
    }
  }

  _buildGrid() {
    // Bucket sample indices by XZ cell so `project` is O(1) instead of O(n).
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const pad = 200;
    this.gridMinX = minX - pad; this.gridMinZ = minZ - pad;
    this.cell = 12;
    this.gridW = Math.ceil((maxX - minX + pad * 2) / this.cell) + 1;
    this.gridH = Math.ceil((maxZ - minZ + pad * 2) / this.cell) + 1;
    this.grid = new Array(this.gridW * this.gridH);

    // Insert each sample into the cells within its road half-width + slack so
    // an off-road kart still finds the correct nearest segment.
    for (let i = 0; i < this.count; i++) {
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      const r = this.width[i] * 0.5 + 26;
      const cx0 = this._cx(x - r), cx1 = this._cx(x + r);
      const cz0 = this._cz(z - r), cz1 = this._cz(z + r);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cz * this.gridW + cx;
          if (k < 0 || k >= this.grid.length) continue;
          (this.grid[k] || (this.grid[k] = [])).push(i);
        }
      }
    }
  }

  _cx(x) { return clamp(Math.floor((x - this.gridMinX) / this.cell), 0, this.gridW - 1); }
  _cz(z) { return clamp(Math.floor((z - this.gridMinZ) / this.cell), 0, this.gridH - 1); }

  /** Sample index for a distance along the track. */
  indexAt(s) { return mod(Math.round(s / this.ds), this.count); }

  /** Interpolated frame at arc-length `s`. Fills and returns `out`. */
  frameAt(s, out = {}) {
    const f = mod(s / this.ds, this.count);
    const i0 = Math.floor(f), i1 = mod(i0 + 1, this.count), t = f - i0;
    out.pos = out.pos || new THREE.Vector3();
    out.tangent = out.tangent || new THREE.Vector3();
    out.normal = out.normal || new THREE.Vector3();
    out.right = out.right || new THREE.Vector3();
    lerpArr(this.pos, i0, i1, t, out.pos);
    lerpArr(this.tangent, i0, i1, t, out.tangent).normalize();
    lerpArr(this.normal, i0, i1, t, out.normal).normalize();
    lerpArr(this.right, i0, i1, t, out.right).normalize();
    out.width = lerp(this.width[i0], this.width[i1], t);
    out.bank = lerp(this.bank[i0], this.bank[i1], t);
    out.curvature = lerp(this.curvature[i0], this.curvature[i1], t);
    out.heading = this.heading[i0] + wrapAngle(this.heading[i1] - this.heading[i0]) * t;
    out.s = mod(s, this.length);
    return out;
  }

  /** World position on the road surface at (s, lateral offset). */
  surfacePoint(s, lateral, out = new THREE.Vector3()) {
    const f = this.frameAt(s, this._tmpFrame || (this._tmpFrame = {}));
    return out.copy(f.pos).addScaledVector(f.right, lateral);
  }

  /**
   * Project a world point onto the track.
   * Returns { s, lateral, height, normal, tangent, right, width, curvature,
   *           onRoad, index } — `height` is the road surface Y beneath `p`.
   */
  project(p, hint = -1, out = {}) {
    let best = -1, bestD = Infinity;

    // A hint from the previous frame turns this into a tiny local search.
    if (hint >= 0) {
      const span = 26;
      for (let k = -span; k <= span; k++) {
        const i = mod(hint + k, this.count);
        const dx = p.x - this.pos[i * 3], dy = p.y - this.pos[i * 3 + 1], dz = p.z - this.pos[i * 3 + 2];
        const d = dx * dx + dy * dy * 0.35 + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      // Trust the local result only if we landed comfortably inside the window.
      const off = Math.abs(ringDelta(hint, best, this.count));
      if (off > span - 4) best = -1;
    }

    if (best < 0) {
      const list = this.grid[this._cz(p.z) * this.gridW + this._cx(p.x)];
      bestD = Infinity;
      if (list) {
        for (let n = 0; n < list.length; n++) {
          const i = list[n];
          const dx = p.x - this.pos[i * 3], dy = p.y - this.pos[i * 3 + 1], dz = p.z - this.pos[i * 3 + 2];
          const d = dx * dx + dy * dy * 0.35 + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best < 0) {
        // Far outside the authored bounds — fall back to a coarse global scan.
        for (let i = 0; i < this.count; i += 4) {
          const dx = p.x - this.pos[i * 3], dz = p.z - this.pos[i * 3 + 2];
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }

    // Refine to sub-sample precision by projecting onto the adjacent segments.
    const refine = (i) => {
      const j = mod(i + 1, this.count);
      const ax = this.pos[i * 3], ay = this.pos[i * 3 + 1], az = this.pos[i * 3 + 2];
      const bx = this.pos[j * 3], by = this.pos[j * 3 + 1], bz = this.pos[j * 3 + 2];
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const len2 = ex * ex + ey * ey + ez * ez;
      if (len2 < 1e-9) return { t: 0, d: Infinity };
      let t = ((p.x - ax) * ex + (p.y - ay) * ey + (p.z - az) * ez) / len2;
      t = clamp(t, 0, 1);
      const qx = ax + ex * t, qy = ay + ey * t, qz = az + ez * t;
      const dx = p.x - qx, dy = p.y - qy, dz = p.z - qz;
      return { t, d: dx * dx + dy * dy * 0.35 + dz * dz };
    };

    const rA = refine(best);
    const prev = mod(best - 1, this.count);
    const rB = refine(prev);
    let baseIdx, tt;
    if (rB.d < rA.d) { baseIdx = prev; tt = rB.t; } else { baseIdx = best; tt = rA.t; }

    const s = mod((baseIdx + tt) * this.ds, this.length);
    const f = this.frameAt(s, out.frame || (out.frame = {}));

    // Lateral = signed distance along the road-right axis.
    const dx = p.x - f.pos.x, dy = p.y - f.pos.y, dz = p.z - f.pos.z;
    const lateral = dx * f.right.x + dy * f.right.y + dz * f.right.z;
    const height = f.pos.y + f.right.y * lateral;

    out.s = s;
    out.lateral = lateral;
    out.height = height;
    out.normal = f.normal;
    out.tangent = f.tangent;
    out.right = f.right;
    out.width = f.width;
    out.curvature = f.curvature;
    out.heading = f.heading;
    out.index = this.indexAt(s);
    out.onRoad = Math.abs(lateral) <= f.width * 0.5;
    return out;
  }
}

function lerpArr(arr, i0, i1, t, out) {
  out.set(
    lerp(arr[i0 * 3], arr[i1 * 3], t),
    lerp(arr[i0 * 3 + 1], arr[i1 * 3 + 1], t),
    lerp(arr[i0 * 3 + 2], arr[i1 * 3 + 2], t),
  );
  return out;
}

/** Box-blur a ring buffer `passes` times with radius `r`. */
function smoothRing(src, r, passes = 1) {
  let cur = src;
  const n = src.length;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += cur[mod(i + k, n)];
      out[i] = sum / (r * 2 + 1);
    }
    cur = out;
  }
  return cur;
}

function locateNode(nodeS, s, total, closed) {
  const n = nodeS.length;
  for (let i = 0; i < n; i++) {
    const a = nodeS[i];
    const b = i === n - 1 ? (closed ? total : nodeS[n - 1]) : nodeS[i + 1];
    if (s >= a && s <= b) {
      const t = b - a > 1e-6 ? (s - a) / (b - a) : 0;
      return { i0: i, i1: closed ? mod(i + 1, n) : Math.min(i + 1, n - 1), t };
    }
  }
  return { i0: n - 1, i1: 0, t: 0 };
}
