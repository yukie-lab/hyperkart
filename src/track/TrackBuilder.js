import * as THREE from 'three';
import { TRACK_LAYOUT } from './Track.js';
import * as Tex from '../render/ProcTex.js';
import { clamp, clamp01, lerp, makeRng, makeValueNoise2D, fbm2D, mod, smoothstep, TAU } from '../core/MathX.js';

/**
 * Turns a `Track` into renderable geometry.
 *
 * Critically, every vertex height comes from `track.groundHeight()` — the same
 * function the physics step queries. The visible road and the collision road
 * are the same surface by construction, so karts can never float or sink.
 */

const RING_STEP = 1.6;        // metres between road cross-sections
const ROAD_COLS = 10;         // subdivisions across the driving surface
const TERRAIN_STEP = 6.4;     // terrain rings are coarser than road rings
const TERRAIN_COLS = 22;
const TERRAIN_REACH = 260;    // how far the surrounding land extends

export class TrackMesh {
  constructor(track, opts = {}) {
    this.track = track;
    this.theme = track.theme;
    this.envMap = opts.envMap || null;
    this.group = new THREE.Group();
    this.group.name = 'trackMesh';
    this.materials = [];
    this.animated = [];

    this._buildRoad();
    this._buildCurbs();
    this._buildMarkings();
    this._buildBoostPads();
    this._buildStartLine();
    if (!track.isVoid) {
      this._buildShoulders();
      this._buildBarriers();
      this._buildTerrain();
    } else {
      this._buildVoidEdges();
    }
  }

  // -- helpers --------------------------------------------------------------

  /** Arc positions for road-resolution rings, closing the loop exactly. */
  _roadRings() {
    const n = Math.max(64, Math.round(this.track.length / RING_STEP));
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (i / n) * this.track.length;
    return out;
  }

  _point(s, lat, out = new THREE.Vector3()) {
    return this.track.placeOnRoad(s, lat, out);
  }

  /**
   * Build a closed strip of geometry spanning laterally from `latA(s)` to
   * `latB(s)`, subdivided into `cols` columns.
   *
   * @param {(s:number, half:number)=>number} latA
   * @param {(s:number, half:number)=>number} latB
   * @param {(u:number, s:number, lat:number)=>[number,number]} uvFn
   * @param {(s:number, lat:number, u:number)=>number} [yOffset]
   */
  _strip(sList, latA, latB, cols, uvFn, yOffset = null) {
    const n = sList.length;
    const m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = sList[i];
      const half = this.track.halfWidthAt(s);
      const a = latA(s, half), b = latB(s, half);
      for (let j = 0; j < m; j++) {
        const u = j / cols;
        const lat = lerp(a, b, u);
        this._point(s, lat, p);
        if (yOffset) p.y += yOffset(s, lat, u);
        const k = (i * m + j) * 3;
        positions[k] = p.x; positions[k + 1] = p.y; positions[k + 2] = p.z;
        const [uu, vv] = uvFn(u, s, lat, half);
        const t = (i * m + j) * 2;
        uvs[t] = uu; uvs[t + 1] = vv;
      }
    }

    const indices = new Uint32Array(n * cols * 6);
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const i0 = i * m, i1 = ((i + 1) % n) * m;
      for (let j = 0; j < cols; j++) {
        indices[ptr++] = i0 + j; indices[ptr++] = i1 + j; indices[ptr++] = i1 + j + 1;
        indices[ptr++] = i0 + j; indices[ptr++] = i1 + j + 1; indices[ptr++] = i0 + j + 1;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  _mat(props) {
    const m = new THREE.MeshStandardMaterial(props);
    if (this.envMap) m.envMap = this.envMap;
    this.materials.push(m);
    return m;
  }

  _add(geo, mat, { cast = false, receive = true, renderOrder = 0 } = {}) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.renderOrder = renderOrder;
    this.group.add(mesh);
    return mesh;
  }

  // -- road -----------------------------------------------------------------

  _buildRoad() {
    const rings = this._roadRings();
    const curbW = TRACK_LAYOUT.curbWidth;
    const isRainbow = this.theme.roadSurface === 'rainbow';

    const geo = this._strip(
      rings,
      (s, half) => -(half - curbW),
      (s, half) => (half - curbW),
      ROAD_COLS,
      // Constant texel density: one texture tile every 4 m in both axes.
      (u, s, lat) => [lat / 6, s / 6],
    );

    let mat;
    if (isRainbow) {
      const t = Tex.rainbow({ size: 1024 });
      // Rainbow Road uses the U axis across the road, not world-scale tiling.
      remapU(geo, this.track, (lat, half) => (lat + half) / (2 * half));
      mat = this._mat({
        map: t.map,
        emissiveMap: t.emissiveMap,
        emissive: 0xffffff,
        emissiveIntensity: 1.35,
        metalness: 0.55,
        roughness: 0.18,
        envMapIntensity: 1.4,
      });
      t.map.repeat.set(1, 1);
      t.emissiveMap.repeat.set(1, 1);
    } else {
      const t = Tex.asphalt({ size: 1024, tint: 0x424244 });
      mat = this._mat({
        map: t.map,
        normalMap: t.normalMap,
        roughnessMap: t.roughnessMap,
        normalScale: new THREE.Vector2(t.normalScale * 0.5, t.normalScale * 0.5),
        metalness: 0.0,
        roughness: 1.0,
        // Tarmac is not a mirror: a strong sky reflection here reads as wet
        // road, which is what made the surface look like open water.
        envMapIntensity: 0.22,
        color: 0xffffff,
      });
    }
    this.road = this._add(geo, mat, { receive: true });
    this.road.name = 'road';
  }

  _buildCurbs() {
    if (this.theme.shoulder === 'none' && this.track.isVoid) return;
    const rings = this._roadRings();
    const curbW = TRACK_LAYOUT.curbWidth;
    const t = Tex.curb({ size: 512 });
    const mat = this._mat({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      metalness: 0.0,
      roughness: 1.0,
      envMapIntensity: 0.5,
    });

    for (const side of [-1, 1]) {
      const geo = this._strip(
        rings,
        (s, half) => side * (half - curbW),
        (s, half) => side * half,
        2,
        // 8 stripes per texture tile, tiled every 8 m => 1 m stripes.
        (u, s) => [u, s / 8],
        // Curbs sit a few centimetres proud of the road.
        (s, lat, u) => 0.035 * smoothstep(u),
      );
      this._add(geo, mat).name = `curb_${side}`;
    }
  }

  _buildMarkings() {
    if (this.track.isVoid) return;
    const rings = this._roadRings();
    const curbW = TRACK_LAYOUT.curbWidth;
    const t = Tex.laneMarkings({ size: 512 });
    t.map.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      transparent: true,
      opacity: 0.92,
      roughness: 0.62,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      envMapIntensity: 0.4,
    });
    this.materials.push(mat);
    const geo = this._strip(
      rings,
      (s, half) => -(half - curbW),
      (s, half) => (half - curbW),
      ROAD_COLS,
      (u, s) => [u, s / 12],
      () => 0.012,
    );
    this._add(geo, mat, { receive: false, renderOrder: 1 }).name = 'markings';
  }

  _buildShoulders() {
    const rings = this._roadRings();
    const shoulderW = TRACK_LAYOUT.shoulderWidth;
    const texFn = this.theme.shoulder === 'dirt' ? Tex.dirt
      : this.theme.shoulder === 'sand' ? Tex.sand
      : Tex.grass;
    const t = texFn({ size: 1024 });
    const mat = this._mat({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      metalness: 0.0,
      roughness: 1.0,
      envMapIntensity: 0.5,
    });

    for (const side of [-1, 1]) {
      const geo = this._strip(
        rings,
        (s, half) => side * half,
        (s, half) => side * (half + shoulderW),
        4,
        (u, s, lat) => [lat / 5, s / 5],
        // The apron falls away from the road edge so it reads as a run-off.
        (s, lat, u) => -0.38 * smoothstep(u) - 0.02,
      );
      this._add(geo, mat).name = `shoulder_${side}`;
    }
  }

  _buildBarriers() {
    const rings = this._roadRings();
    const shoulderW = TRACK_LAYOUT.shoulderWidth;
    const H = TRACK_LAYOUT.wallHeight;

    const tm = Tex.paintedMetal({ size: 512, tint: 0xf0f2f5 });
    const wallMat = this._mat({
      map: tm.map, normalMap: tm.normalMap, roughnessMap: tm.roughnessMap,
      normalScale: new THREE.Vector2(tm.normalScale, tm.normalScale),
      metalness: 0.35, roughness: 0.55, envMapIntensity: 0.9, side: THREE.DoubleSide,
    });
    const railMat = this._mat({
      color: this.theme.key === 'coast' ? 0xe2483c : 0xdb8a2a,
      metalness: 0.5, roughness: 0.34, envMapIntensity: 1.1, side: THREE.DoubleSide,
    });

    for (const side of [-1, 1]) {
      // Inner face of the barrier — a vertical strip at the run-off edge.
      const wall = this._strip(
        rings,
        (s, half) => side * (half + shoulderW),
        (s, half) => side * (half + shoulderW),
        3,
        (u, s) => [s / 3, u * (H / 3)],
        (s, lat, u) => -0.40 + u * H,
      );
      this._add(wall, wallMat, { cast: true }).name = `wall_${side}`;

      // Colour band along the top rail.
      const rail = this._strip(
        rings,
        (s, half) => side * (half + shoulderW - 0.16),
        (s, half) => side * (half + shoulderW + 0.16),
        1,
        (u, s) => [u, s / 3],
        () => -0.40 + H,
      );
      this._add(rail, railMat, { cast: true }).name = `rail_${side}`;
    }
  }

  _buildVoidEdges() {
    // Rainbow Skyway: glowing trim instead of physical barriers.
    const rings = this._roadRings();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.materials.push(mat);
    for (const side of [-1, 1]) {
      const geo = this._strip(
        rings,
        (s, half) => side * (half - 0.05),
        (s, half) => side * (half + 0.45),
        1,
        (u, s) => [u, s / 4],
        () => 0.02,
      );
      this._add(geo, mat, { receive: false }).name = `voidTrim_${side}`;
    }
    // Underside so the road isn't paper-thin when seen from below or in air.
    const under = this._strip(
      rings,
      (s, half) => half,
      (s, half) => -half,
      ROAD_COLS,
      (u, s, lat) => [lat / 6, s / 6],
      () => -0.55,
    );
    const underMat = this._mat({
      color: 0x1b1440, metalness: 0.7, roughness: 0.35,
      emissive: 0x2a1a60, emissiveIntensity: 0.5, envMapIntensity: 1.0,
    });
    this._add(under, underMat, { receive: false }).name = 'roadUnderside';
  }

  _buildBoostPads() {
    if (!this.track.boostPads.length) return;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a2a4a,
      emissive: 0x33bbff,
      emissiveIntensity: 2.4,
      roughness: 0.3,
      metalness: 0.2,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.materials.push(mat);
    this.boostPadMaterial = mat;

    for (const pad of this.track.boostPads) {
      const steps = Math.max(6, Math.round(pad.length / 1.2));
      const sList = [];
      for (let i = 0; i <= steps; i++) sList.push(pad.s + (i / steps) * pad.length);
      const half = this.track.halfWidthAt(pad.s);
      const c = pad.lane * half;
      const w = pad.halfWidth;

      const n = sList.length, m = 3;
      const positions = new Float32Array(n * m * 3);
      const uvs = new Float32Array(n * m * 2);
      const p = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          const u = j / (m - 1);
          this._point(sList[i], c + lerp(-w, w, u), p);
          const k = (i * m + j) * 3;
          positions[k] = p.x; positions[k + 1] = p.y + 0.02; positions[k + 2] = p.z;
          const t = (i * m + j) * 2;
          uvs[t] = u; uvs[t + 1] = i / (n - 1);
        }
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < m - 1; j++) {
          const i0 = i * m + j, i1 = (i + 1) * m + j;
          idx.push(i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      this._add(geo, mat, { receive: false, renderOrder: 2 }).name = 'boostPad';
    }
  }

  _buildStartLine() {
    const t = Tex.checker({ size: 512, squares: 10 });
    t.map.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: t.map, roughness: 0.55, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      envMapIntensity: 0.5,
    });
    this.materials.push(mat);
    const s0 = this.track.startS;
    const depth = 3.2;
    const steps = 4;
    const sList = [];
    for (let i = 0; i <= steps; i++) sList.push(s0 - depth * 0.5 + (i / steps) * depth);

    const half = this.track.halfWidthAt(s0);
    const cols = 12;
    const n = sList.length, m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const hw = this.track.halfWidthAt(sList[i]);
      for (let j = 0; j < m; j++) {
        const u = j / cols;
        this._point(sList[i], lerp(-hw, hw, u), p);
        const k = (i * m + j) * 3;
        positions[k] = p.x; positions[k + 1] = p.y + 0.014; positions[k + 2] = p.z;
        const tt = (i * m + j) * 2;
        uvs[tt] = u * (hw / 1.6); uvs[tt + 1] = i / (n - 1);
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < cols; j++) {
        const i0 = i * m + j, i1 = (i + 1) * m + j;
        idx.push(i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this._add(geo, mat, { receive: true, renderOrder: 1 }).name = 'startLine';
  }

  // -- surroundings ---------------------------------------------------------

  _buildTerrain() {
    const n = Math.max(48, Math.round(this.track.length / TERRAIN_STEP));
    const sList = new Float64Array(n);
    for (let i = 0; i < n; i++) sList[i] = (i / n) * this.track.length;

    const noise = makeValueNoise2D(this.theme.key === 'coast' ? 1201 : 3307, 256);
    const isCoast = this.theme.key === 'coast';
    // Sea level follows the circuit's lowest point, never a fixed constant.
    const waterLevel = this.track.waterLevel;

    /**
     * Height of the land at a given distance beyond the barrier.
     * Coast: falls to a beach then into the sea.
     * Canyon: climbs into mesa walls that box the circuit in.
     */
    const profile = (d, worldX, worldZ, edgeY) => {
      const nz = fbm2D(noise, worldX * 0.006, worldZ * 0.006, 5);
      const detail = fbm2D(noise, worldX * 0.05, worldZ * 0.05, 3);
      if (isCoast) {
        // Fall from the road edge down to a beach, meet the waterline, then
        // continue onto the seabed so the shore reads as a real coast rather
        // than a plane clipping through terrain.
        const toWater = edgeY - waterLevel;
        const shore = Math.pow(clamp01(d / 78), 1.45) * (toWater + 3.0);
        const dune = Math.pow(clamp01(1 - d / 44), 2) * nz * 3.4;
        const seabed = Math.pow(clamp01((d - 84) / 150), 1.3) * 22;
        return edgeY - 0.9 - shore + dune - seabed + detail * 0.6 * clamp01(1 - d / 95);
      }
      // Canyon
      const rise = Math.pow(clamp01((d - 18) / 90), 1.5) * (26 + nz * 34);
      const dip = -1.2 - clamp01(d / 20) * 2.0;
      return edgeY + dip + rise + detail * 1.4;
    };

    const wallOffset = TRACK_LAYOUT.shoulderWidth;
    const cols = TERRAIN_COLS;
    const m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = sList[i];
      const half = this.track.halfWidthAt(s);
      for (let j = 0; j < m; j++) {
        // Two-sided: columns run from far-left, across the track, to far-right.
        const u = j / cols;
        const side = u < 0.5 ? -1 : 1;
        const k01 = Math.abs(u - 0.5) * 2;                     // 0 at track, 1 far out
        const d = Math.pow(k01, 1.7) * TERRAIN_REACH;
        const lat = side * (half + wallOffset + d);
        this._point(s, lat, p);
        const edgeY = p.y;
        if (d > 0.5) p.y = profile(d, p.x, p.z, edgeY);
        else p.y = edgeY - 0.42;
        const kk = (i * m + j) * 3;
        positions[kk] = p.x; positions[kk + 1] = p.y; positions[kk + 2] = p.z;
        const t = (i * m + j) * 2;
        uvs[t] = p.x / 14; uvs[t + 1] = p.z / 14;
      }
    }

    const idx = new Uint32Array(n * cols * 6);
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const i0 = i * m, i1 = ((i + 1) % n) * m;
      for (let j = 0; j < cols; j++) {
        // Skip the two columns straddling the road itself.
        if (j === Math.floor(cols / 2) - 1 || j === Math.floor(cols / 2)) continue;
        idx[ptr++] = i0 + j; idx[ptr++] = i1 + j; idx[ptr++] = i1 + j + 1;
        idx[ptr++] = i0 + j; idx[ptr++] = i1 + j + 1; idx[ptr++] = i0 + j + 1;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx.slice(0, ptr), 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const texFn = isCoast ? Tex.sand : Tex.dirt;
    const t = texFn({ size: 1024, tint: this.theme.groundColor });
    const mat = this._mat({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      metalness: 0.0, roughness: 1.0, envMapIntensity: 0.55,
    });
    this._add(geo, mat, { receive: true }).name = 'terrain';

    if (isCoast && this.theme.water?.enabled) this._buildWater(waterLevel);
  }

  _buildWater(level) {
    // Two independent samplers over the same swell map: a long slow swell in
    // the base normal, a finer faster chop in the clearcoat normal. A single
    // scrolling layer only ever slides — the sea reads as moving because its
    // two scales move at different speeds and in different directions.
    const base = Tex.waterNormal({ size: 512 }).normalMap;
    const swell = base.clone();
    swell.repeat.set(24, 24);
    swell.anisotropy = 16;          // three clamps this to whatever the GPU has
    swell.needsUpdate = true;
    const chop = base.clone();
    chop.repeat.set(140, 140);
    chop.anisotropy = 16;
    chop.needsUpdate = true;
    this._waterTextures = [swell, chop];

    const geo = new THREE.PlaneGeometry(6000, 6000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshPhysicalMaterial({
      color: this.theme.water.color,
      // Not a mirror. At 0.11 the minified chop aliased into crawling speckle
      // across the whole bay, and the sea's own colour never showed through
      // the reflected sky — the surface read as corrugated cloth, not water.
      roughness: 0.24,
      metalness: 0.0,               // water is a dielectric
      normalMap: swell,
      normalScale: new THREE.Vector2(0.40, 0.40),
      clearcoat: 0.6,
      clearcoatRoughness: 0.14,
      clearcoatNormalMap: chop,
      clearcoatNormalScale: new THREE.Vector2(0.16, 0.16),
      envMapIntensity: 0.9,
      // The sun's own colour in the dielectric specular, so the glitter path
      // reads as sunlight on water rather than a grey highlight.
      specularColor: new THREE.Color(this.theme.water.sunColor ?? 0xffffff),
      specularIntensity: 1.0,
    });
    if (this.envMap) mat.envMap = this.envMap;
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = level;
    mesh.receiveShadow = false;
    mesh.name = 'ocean';
    this.group.add(mesh);
    this.waterMaterial = mat;
    this.animated.push((dt, time) => {
      swell.offset.set(time * 0.0060, time * 0.0035);
      chop.offset.set(time * -0.0140, time * 0.0210);
    });
  }

  // -- runtime --------------------------------------------------------------

  update(dt, time) {
    for (const fn of this.animated) fn(dt, time);
    if (this.boostPadMaterial) {
      this.boostPadMaterial.emissiveIntensity = 2.0 + Math.sin(time * 7) * 0.9;
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
    // Surface textures are shared out of the cache and outlive the track, but
    // the water's two samplers are clones owned by this build.
    for (const t of this._waterTextures ?? []) t.dispose();
  }
}

/** Rewrite the U channel of a road strip as a 0..1 span across the road. */
function remapU(geo, track, fn) {
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  // The strip was generated with u = lat/4; recover lat and renormalise.
  for (let i = 0; i < uv.count; i++) {
    const lat = uv.getX(i) * 4;
    const s = uv.getY(i) * 4;
    const half = track.halfWidthAt(s);
    uv.setXY(i, fn(lat, half), s / 10);
  }
  uv.needsUpdate = true;
}
