import * as THREE from 'three';
import { clamp, lerp, TAU } from '../core/MathX.js';

/**
 * Procedural geometry helpers. Everything in this game is generated at
 * runtime — no downloaded meshes — so these are the building blocks the art
 * systems compose into karts, props and track furniture.
 */

/**
 * A box with rounded edges and corners. Built by projecting a subdivided box
 * onto the Minkowski sum of an inner box and a sphere, which gives clean,
 * uniform fillets that catch highlights the way moulded plastic does.
 */
export function roundedBox(w, h, d, radius, segments = 4) {
  radius = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
  const pos = geo.attributes.position;
  const hx = w / 2 - radius, hy = h / 2 - radius, hz = d / 2 - radius;
  const v = new THREE.Vector3(), inner = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    inner.set(clamp(v.x, -hx, hx), clamp(v.y, -hy, hy), clamp(v.z, -hz, hz));
    v.sub(inner);
    if (v.lengthSq() > 1e-10) v.setLength(radius);
    v.add(inner);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Lathe a profile around Y. `profile` is [[radius, y], ...] from bottom to top.
 */
export function lathe(profile, segments = 32, phiStart = 0, phiLength = TAU) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-5), y));
  const geo = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A tyre: torus-like tread band with sidewalls, generated as a lathe around
 * the wheel axis (X) and rotated into place.
 */
export function tyreGeometry(outerR, innerR, width, segments = 28) {
  const shoulderR = outerR * 0.94;
  const profile = [
    [innerR, -width / 2],
    [innerR + (shoulderR - innerR) * 0.55, -width / 2],
    [shoulderR, -width / 2 + width * 0.12],
    [outerR, -width / 2 + width * 0.24],
    [outerR, width / 2 - width * 0.24],
    [shoulderR, width / 2 - width * 0.12],
    [innerR + (shoulderR - innerR) * 0.55, width / 2],
    [innerR, width / 2],
  ];
  const geo = lathe(profile, segments);
  geo.rotateZ(Math.PI / 2);
  return geo;
}

/**
 * Sweep a 2D cross-section along a 3D path. Used for guardrails, curbs, pipes
 * and the neon edge trim on Rainbow Skyway.
 *
 * @param {Array<[number,number]>} section  cross-section points (x = right, y = up)
 * @param {Array<{pos:THREE.Vector3, right:THREE.Vector3, up:THREE.Vector3}>} frames
 * @param {{closed?:boolean, uvScale?:number, cap?:boolean}} opts
 */
export function sweep(section, frames, opts = {}) {
  const closed = opts.closed !== false;
  const uvScale = opts.uvScale ?? 1;
  const n = frames.length;
  const m = section.length;
  const vertCount = n * m;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  // Accumulate arc length for a stable V coordinate along the sweep.
  const dist = new Float32Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);

  // Cross-section perimeter for the U coordinate.
  const secU = new Float32Array(m);
  for (let j = 1; j < m; j++) {
    const dx = section[j][0] - section[j - 1][0];
    const dy = section[j][1] - section[j - 1][1];
    secU[j] = secU[j - 1] + Math.hypot(dx, dy);
  }

  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    for (let j = 0; j < m; j++) {
      const [sx, sy] = section[j];
      p.copy(f.pos).addScaledVector(f.right, sx).addScaledVector(f.up, sy);
      const k = (i * m + j) * 3;
      positions[k] = p.x; positions[k + 1] = p.y; positions[k + 2] = p.z;
      const t = (i * m + j) * 2;
      uvs[t] = secU[j] * uvScale;
      uvs[t + 1] = dist[i] * uvScale;
    }
  }

  const quads = (n - (closed ? 0 : 1)) * (m - 1);
  const indices = new Uint32Array(quads * 6);
  let ptr = 0;
  const rows = closed ? n : n - 1;
  for (let i = 0; i < rows; i++) {
    const i0 = i * m, i1 = ((i + 1) % n) * m;
    for (let j = 0; j < m - 1; j++) {
      indices[ptr++] = i0 + j; indices[ptr++] = i1 + j; indices[ptr++] = i1 + j + 1;
      indices[ptr++] = i0 + j; indices[ptr++] = i1 + j + 1; indices[ptr++] = i0 + j + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

/** Capsule aligned to Y, used for limbs and driver torsos. */
export function capsule(radius, height, radialSegs = 16, capSegs = 8) {
  return new THREE.CapsuleGeometry(radius, height, capSegs, radialSegs);
}

/**
 * Merge an array of geometries into one buffer, baking per-geometry transforms.
 * Fewer draw calls matters a lot once there are twelve karts on screen.
 */
export function mergeGeometries(list) {
  const groups = [];
  let vertexTotal = 0, indexTotal = 0;
  for (const { geo } of list) {
    vertexTotal += geo.attributes.position.count;
    indexTotal += geo.index ? geo.index.count : geo.attributes.position.count;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const uvs = new Float32Array(vertexTotal * 2);
  const indices = new Uint32Array(indexTotal);
  let vOff = 0, iOff = 0;

  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const item of list) {
    const { geo, matrix } = item;
    const src = geo.attributes.position;
    const srcN = geo.attributes.normal;
    const srcUV = geo.attributes.uv;
    if (matrix) nm.getNormalMatrix(matrix);
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i);
      if (matrix) v.applyMatrix4(matrix);
      positions[(vOff + i) * 3] = v.x; positions[(vOff + i) * 3 + 1] = v.y; positions[(vOff + i) * 3 + 2] = v.z;
      if (srcN) {
        v.fromBufferAttribute(srcN, i);
        if (matrix) v.applyMatrix3(nm).normalize();
        normals[(vOff + i) * 3] = v.x; normals[(vOff + i) * 3 + 1] = v.y; normals[(vOff + i) * 3 + 2] = v.z;
      }
      if (srcUV) { uvs[(vOff + i) * 2] = srcUV.getX(i); uvs[(vOff + i) * 2 + 1] = srcUV.getY(i); }
    }
    const idx = geo.index;
    const start = iOff;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[iOff++] = idx.getX(i) + vOff;
    } else {
      for (let i = 0; i < src.count; i++) indices[iOff++] = i + vOff;
    }
    groups.push({ start, count: iOff - start, materialIndex: item.materialIndex ?? 0 });
    vOff += src.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  for (const g of groups) out.addGroup(g.start, g.count, g.materialIndex);
  return out;
}

/** Quick transform matrix builder for merge lists. */
export function xform(pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scale),
  );
}

/**
 * Build a smooth grid mesh from a height function. Used for terrain aprons and
 * water patches.
 */
export function heightfield(width, depth, segX, segZ, fn) {
  const geo = new THREE.PlaneGeometry(width, depth, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, fn(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();
  return geo;
}
