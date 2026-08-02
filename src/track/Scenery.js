import * as THREE from 'three';
import { clamp01, lerp, makeRng, mod, TAU } from '../core/MathX.js';
import {
  TerrainSampler, WALL_OFFSET, TERRAIN_INNER, TERRAIN_REACH,
  scatterAlong, terrainNormal, poseMatrix, gauss, loopField,
  blobGeometry, blobMaterial,
  T, mergeParts, paintGeometry, darkenBase,
  rockGeometry, sweepStack, columnGeometry, frondGeometry, mesaGeometry,
  tuftGeometry, blobClusterGeometry, personGeometry, pennantGeometry,
  propMaterial, neonMaterial,
  applyWind, applyCrowd, applyBob, applyFlap, applyDrift, applyPulse, applyFlag,
  chunkedInstances, addMesh,
  bannerStripTexture, planetTexture,
} from './SceneryKit.js';

const UP_V = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Everything that dresses the circuit: vegetation, rocks, grandstands, crowds,
 * banners, signage, coastal props, canyon mesas, and the Rainbow Skyway's
 * celestial set pieces.
 *
 * Owned by the environment art system. `Race` constructs one of these and
 * calls `update()` each frame; nothing else in the codebase depends on its
 * internals, so it is free to build whatever it needs.
 *
 * Contract:
 *   new Scenery(track, scene, { envMap, quality, seed })
 *   .update(dt, time, cameraPos)
 *   .setEnvMap(envMap)
 *   .dispose()
 *
 * The composition rules every builder below follows:
 *
 *  - **Three depth layers.** Near trackside detail inside ~30 m, midground
 *    masses out to ~110 m, and a background silhouette ring at 500-1300 m. Fog
 *    is already tuned to separate them; without three populated layers it has
 *    nothing to separate and the world flattens onto the horizon.
 *  - **Drifts, never spacing.** All scatter goes through `scatterAlong`, which
 *    clusters against a periodic density field. Anything laid out at a regular
 *    interval is man-made on purpose (poles, hoardings, grandstands).
 *  - **Grounded.** Props are conformed to the sampled terrain, partially
 *    aligned to its slope, sunk a little, darkened at the base, and given a
 *    multiply-blended contact blob because the shadow map only covers a box
 *    around the player.
 *  - **Nothing inside the barrier.** Every band starts beyond `TERRAIN_INNER`,
 *    which is also the first place the terrain mesh actually exists.
 */

// Anything closer than this to the barrier is floating over the hole the
// terrain mesh leaves around the road.
const NEAR_D = TERRAIN_INNER + 0.9;

// Trackside advertising is a *brand system*, not a paint chart: two or three
// house colours, mostly dark or off-white, with saturation used sparingly.
// Giving every board its own bright hue turns the barrier into a rainbow
// ribbon that competes with the karts for attention and dates the whole image.
const COAST_SPONSORS = [
  { bg: '#16324a', accent: '#2f6f9e', fg: '#eaf2f8' },
  { bg: '#efe9dd', accent: '#d5cdba', fg: '#1d3145' },
  { bg: '#a83a2c', accent: '#d47a5c', fg: '#fdf3e7' },
  { bg: '#28352c', accent: '#46614c', fg: '#e9f0e4' },
];
const CANYON_SPONSORS = [
  { bg: '#6f3620', accent: '#a4623a', fg: '#f6e6d2' },
  { bg: '#ece5d6', accent: '#d3c6aa', fg: '#3a2a1c' },
  { bg: '#2c394b', accent: '#4f6379', fg: '#e8eef5' },
  { bg: '#b0731d', accent: '#dda94f', fg: '#33240d' },
];
const SPONSOR_WORDS = ['HYPER', 'NOVA', 'TURBO', 'APEX', 'VOLT', 'DRIFT'];

export class Scenery {
  constructor(track, scene, opts = {}) {
    this.track = track;
    this.scene = scene;
    this.theme = track.theme;
    this.envMap = opts.envMap || null;
    this.quality = opts.quality || 'high';
    this.seed = opts.seed ?? 1337;

    this.group = new THREE.Group();
    this.group.name = 'scenery';
    scene.add(this.group);

    this.materials = [];
    this.animated = [];

    this._all = [];        // every material, for disposal
    this._clocks = [];     // uTime uniforms driven from update()
    this._textures = [];
    this._blobs = [];      // pending contact-shadow instances
    this._crowd = [[], []];// pending spectators: [arms down, arms up]

    this.rng = makeRng((this.seed ^ 0x5cede) >>> 0);
    this.terrain = new TerrainSampler(track);
    this.fogDensity = scene.fog?.isFogExp2 ? scene.fog.density : 0;
    // Prop counts scale with the quality preset; the composition (where the
    // drifts are, where the gaps are) is identical at every setting so a low
    // preset thins a scene out rather than rearranging it.
    this.detail = this.quality === 'low' ? 0.40 : this.quality === 'medium' ? 0.68 : 1;

    if (track.isVoid) this._buildRainbow();
    else if (this.theme.key === 'coast') this._buildCoast();
    else this._buildCanyon();

    this._flushCrowd();
    this._flushBlobs();
  }

  // -- plumbing -------------------------------------------------------------

  /** Register a material: env map, clock, disposal. `env` off for unlit props. */
  _mat(mat, { env = true } = {}) {
    this._all.push(mat);
    if (env) {
      this.materials.push(mat);
      if (this.envMap) mat.envMap = this.envMap;
    }
    if (mat.userData.uTime) this._clocks.push(mat.userData.uTime);
    return mat;
  }

  _n(base) { return Math.max(1, Math.round(base * this.detail)); }

  /**
   * Queue a contact blob. Collected across every prop type and flushed into one
   * chunked instancer at the end, so the entire circuit's grounding costs a
   * handful of draw calls rather than one per prop family.
   */
  _blob(item, radius, { opacity = 1, lift = 0.06 } = {}) {
    const n = terrainNormal(this.terrain, item.s, item.lateral, new THREE.Vector3());
    const p = item.pos.clone().addScaledVector(n, lift);
    const m = poseMatrix(p, {
      normal: n, align: 1, yaw: item.u * TAU,
      scale: [radius, 1, radius * lerp(0.8, 1.25, item.v)],
    }, new THREE.Matrix4());
    // The geometry carries the radial falloff, so strength is just an instance
    // tint: 1.0 leaves the ground untouched, 0.45 is a full contact patch.
    // Warmer than neutral on purpose — occlusion removes sky light, which is
    // the blue half of the illumination, so a real contact patch is never grey.
    const t = lerp(1.0, 0.45, clamp01(opacity));
    this._blobs.push({ s: item.s, m, color: new THREE.Color(Math.min(1, t * 1.05), t, t * 0.93) });
  }

  _flushBlobs() {
    if (!this._blobs.length) return;
    this._blobs.sort((a, b) => a.s - b.s);
    const mat = this._mat(blobMaterial(this.fogDensity), { env: false });
    chunkedInstances(this.group, blobGeometry(10), mat, this._blobs,
      Math.min(10, Math.ceil(this._blobs.length / 90)), { name: 'sceneryBlob', renderOrder: -1 });
  }

  /** Queue a spectator. `armsUp` picks the raised-arms silhouette variant. */
  _person(s, pos, { yaw = 0, scale = 1, color = 0xffffff, armsUp = false }) {
    const m = new THREE.Matrix4().compose(
      pos,
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(scale, scale * lerp(0.94, 1.08, this.rng()), scale),
    );
    this._crowd[armsUp ? 1 : 0].push({ s, m, color });
  }

  _flushCrowd() {
    const total = this._crowd[0].length + this._crowd[1].length;
    if (!total) return;
    const glow = this.track.isVoid;
    const mat = this._mat(
      applyCrowd(glow
        ? neonMaterial({ side: THREE.DoubleSide })
        : propMaterial({ roughness: 0.9, envMapIntensity: 0.35 }), { amp: 0.13, freq: 4.6 }),
      { env: !glow },
    );
    for (let i = 0; i < 2; i++) {
      const list = this._crowd[i];
      if (!list.length) continue;
      list.sort((a, b) => a.s - b.s);
      const geo = personGeometry(makeRng(700 + i), { armsUp: i === 1 });
      darkenBase(geo, { height: 0.35, amount: 0.30 });
      chunkedInstances(this.group, geo, mat, list,
        Math.min(8, Math.ceil(list.length / 110)),
        { name: `crowd${i}`, inflate: 0.6 });
    }
  }

  /**
   * Scatter a prop family. Wraps `chunkedInstances` with the two things every
   * call site here wants: chunk count derived from population, and a bounding
   * sphere inflated to cover shader-side wind so instances do not pop out at
   * the edge of frame while they are still bending into view.
   */
  _spread(name, geo, mat, items, { per = 90, maxChunks = 9, ...opts } = {}) {
    if (!items.length) return [];
    return chunkedInstances(this.group, geo, mat, items,
      Math.min(maxChunks, Math.max(1, Math.ceil(items.length / per))), { name, ...opts });
  }

  /**
   * Horizontal direction of increasing lateral offset at `s`, taken as a
   * difference of two road points rather than from the spline's `right` — the
   * road banks, and a structure whose axes inherit the banking leans.
   */
  _lateralDir(s, out = new THREE.Vector3()) {
    const a = this.track.placeOnRoad(s, 1, _v1);
    const b = this.track.placeOnRoad(s, -1, _v2);
    out.subVectors(a, b);
    out.y = 0;
    return out.normalize();
  }

  /**
   * Which lateral sign is the *outside* of the bend at `s`.
   *
   * Derived rather than taken from the sign of `curvature`, whose handedness
   * depends on how the spline builds its frames: the midpoint of a chord always
   * falls inside the arc it subtends, so the vector from the arc to the chord
   * points at the inside of the corner no matter what convention is in use.
   */
  _outsideSign(s) {
    const L = this.track.length;
    const a = this.track.placeOnRoad(mod(s - 12, L), 0, _v1).clone();
    const b = this.track.placeOnRoad(mod(s + 12, L), 0, _v2).clone();
    const mid = this.track.placeOnRoad(s, 0, new THREE.Vector3());
    const lat = this._lateralDir(s, new THREE.Vector3());
    const inward = ((a.x + b.x) * 0.5 - mid.x) * lat.x + ((a.z + b.z) * 0.5 - mid.z) * lat.z;
    return inward < 0 ? 1 : -1;
  }

  /**
   * Basis for something that spans the road: X across (toward +lateral),
   * Y plumb, Z along the track. Gantries, arches, ring gates.
   */
  _crossBasis(s, y) {
    const x = this._lateralDir(s, new THREE.Vector3());
    const z = new THREE.Vector3(-x.z, 0, x.x);
    const p = this.track.placeOnRoad(s, 0, new THREE.Vector3());
    p.y = y;
    return new THREE.Matrix4().makeBasis(x, UP_V, z).setPosition(p);
  }

  /**
   * Basis for something that sits beside the road: X along the track, Y plumb,
   * Z away from the road on `side`. Grandstands and spectator fences.
   */
  _alongBasis(s, lateral, y, side) {
    const z = this._lateralDir(s, new THREE.Vector3()).multiplyScalar(side);
    const x = new THREE.Vector3(z.z, 0, -z.x);
    const p = this.track.placeOnRoad(s, lateral, new THREE.Vector3());
    p.y = y;
    return new THREE.Matrix4().makeBasis(x, UP_V, z).setPosition(p);
  }

  // =========================================================================
  // Shared set dressing
  // =========================================================================

  /**
   * Sponsor hoardings standing behind the barrier.
   *
   * Placed in runs with gaps rather than a continuous ribbon: an unbroken wall
   * of advertising hides the road beyond every corner, and a real circuit only
   * boards up the sections that face a camera. The bottom edge sits at the
   * barrier's top rail so the barrier hides the legs.
   */
  _hoardings(palette) {
    const tex = bannerStripTexture(palette, SPONSOR_WORDS);
    this._textures.push(tex);
    tex.repeat.set(1, 1);
    // Vertex colours multiply the sponsor map, which is what lets the dark top
    // rail live in the same mesh as the boards. Two meshes per run would have
    // doubled the busiest draw-call bucket in the scenery for one dark line.
    const mat = this._mat(new THREE.MeshStandardMaterial({
      map: tex, vertexColors: true, roughness: 0.62, metalness: 0.05,
      envMapIntensity: 0.5, side: THREE.DoubleSide,
    }));

    const L = this.track.length;
    const field = loopField(this.rng, { cycles: 9, octaves: 2 });
    const step = 5;
    const runs = [];
    let cur = null;
    for (let s = 0; s < L; s += step) {
      // Boards go where the density field allows *and* the road is not turning
      // hard — a hoarding on the outside of a hairpin is the one place it would
      // genuinely hide the apex from the driver.
      const curve = Math.abs(this.track.frameAt(s, {}).curvature);
      const open = field(s / L) > 0.14 && curve < 0.010;
      if (open) { if (!cur) runs.push((cur = { s0: s, s1: s })); else cur.s1 = s + step; }
      else cur = null;
    }

    // 3.0 x 1.5 m panels: the texture cell is 2:1, so this is the only board
    // size that does not stretch the lettering. Two-thirds of the earlier
    // height — a 2 m hoarding puts metre-high type beside a kart and the
    // signage stops reading as scenery and starts reading as UI.
    const H = 1.5, BASE = 1.14, TILE = 12;
    for (const run of runs) {
      const span = run.s1 - run.s0;
      if (span < 30) continue;
      for (const side of [-1, 1]) {
        const segs = Math.max(4, Math.round(span / 3.0));
        const pos = [], uv = [], col = [], idx = [];
        const p = new THREE.Vector3(), q = new THREE.Vector3();
        let uAcc = 0, prev = null;
        const push = (v3, y, u, vv, c) => { pos.push(v3.x, y, v3.z); uv.push(u, vv); col.push(c, c, c); };
        for (let i = 0; i <= segs; i++) {
          const s = run.s0 + (i / segs) * span;
          const half = this.track.halfWidthAt(s);
          const lat = side * (half + WALL_OFFSET + 0.62);
          this.track.placeOnRoad(s, lat, p);
          this.track.placeOnRoad(s, lat + side * 0.13, q);
          if (prev) uAcc += p.distanceTo(prev);
          prev = p.clone();
          const y0 = p.y - 0.40 + BASE;
          // Which way the arc runs across the screen flips with the side of
          // the road, so one side's lettering has to be mirrored to read.
          const u = side * uAcc / TILE;
          // Two sheets 13 cm apart with U mirrored on the outer one. A single
          // sheet drawn DoubleSide shows the sponsor's name reversed to anyone
          // looking across the circuit, which is the loudest possible tell.
          push(p, y0, u, 0, 0.94);
          push(p, y0 + H, u, 1, 1);
          push(p, y0 + H + 0.18, u, 1, 0.17);
          push(q, y0, -u, 0, 0.70);
          push(q, y0 + H, -u, 1, 0.76);
          push(q, y0 + H + 0.18, -u, 1, 0.15);
        }
        for (let i = 0; i < segs; i++) {
          const a = i * 6, b = a + 6;
          idx.push(a, a + 1, b + 1, a, b + 1, b);
          idx.push(a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
          idx.push(a + 4, a + 3, b + 3, a + 4, b + 3, b + 4);
          idx.push(a + 5, a + 4, b + 4, a + 5, b + 4, b + 5);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        addMesh(this.group, geo, mat, { name: 'hoarding', cast: false, receive: false });
      }
    }
    return runs;
  }

  /**
   * A grandstand: raked seating, a canopy on posts, and a filled crowd.
   * All copies share one geometry through an instancer, and the spectators go
   * into the shared crowd pool, so N stands cost two draw calls plus crowd.
   */
  _grandstands(fractions) {
    const rows = 10, rowH = 0.60, rowD = 0.94, width = 30, roofY = rows * rowH + 4.2;
    const parts = [];
    // Seating deck, stepped. One box per row rather than a ramp so the
    // silhouette against the sky is a staircase, which is what reads as seating.
    // The treads are dark on purpose: a pale deck behind a crowd flattens every
    // figure into the same value and the whole stand reads as printed texture.
    for (let r = 0; r < rows; r++) {
      parts.push({
        geo: new THREE.BoxGeometry(width, rowH + 0.12, rowD),
        color: r % 2 ? 0x39434d : 0x2f3841,
        m: T([0, r * rowH + rowH * 0.5, 2.4 + r * rowD]),
      });
    }
    // Substructure. A solid box would be simpler, but on a stand pitched above
    // a shoreline that box becomes a thirty-metre blank slab hanging over the
    // water — the most obvious "placed object" tell in the whole scene. A
    // recessed dark wall behind a row of piers reads as a building instead,
    // and still hides the ground it is standing on.
    parts.push({ geo: new THREE.BoxGeometry(width - 1.6, 7.0, rows * rowD + 1.4), color: 0x232a31, m: T([0, -3.4, 2.4 + rows * rowD * 0.5]) });
    for (let i = -6; i <= 6; i++) {
      parts.push({ geo: new THREE.BoxGeometry(1.5, 7.0, 1.1), color: 0x515a64, m: T([i * (width / 13), -3.4, 1.75]) });
    }
    parts.push({ geo: new THREE.BoxGeometry(width + 0.9, 0.5, rows * rowD + 3.0), color: 0x596270, m: T([0, -0.25, 2.2 + rows * rowD * 0.5]) });
    // Front fascia, in the circuit's accent red — the band that identifies the
    // structure as a grandstand from 200 m away.
    parts.push({ geo: new THREE.BoxGeometry(width + 0.9, 1.5, 0.4), color: 0xc2392f, m: T([0, 0.55, 1.85]) });
    // Canopy. Deliberately mid-value, not white: it is seen from underneath
    // almost every time, and a bright soffit blows out the crowd beneath it.
    parts.push({ geo: new THREE.BoxGeometry(width + 2.2, 0.36, rows * rowD + 2.4), color: 0x8c949c, m: T([0, roofY, 2.6 + rows * rowD * 0.5], [-0.12, 0, 0]) });
    parts.push({ geo: new THREE.BoxGeometry(width + 2.2, 0.85, 0.30), color: 0xc2392f, m: T([0, roofY - 0.75, 2.1]) });
    for (const sx of [-1, -0.34, 0.34, 1]) {
      for (const [zz, hh] of [[2.2, roofY - 1], [2.0 + rows * rowD, roofY + 0.6]]) {
        parts.push({ geo: new THREE.BoxGeometry(0.3, hh, 0.3), color: 0x99a1a9, m: T([sx * width * 0.47, hh * 0.5, zz]) });
      }
    }
    // Back wall closes the silhouette so the sky does not show through the crowd.
    parts.push({ geo: new THREE.BoxGeometry(width + 1.4, rows * rowH + 3.0, 0.35), color: 0x6e7680, m: T([0, (rows * rowH + 3.0) * 0.5 - 1, 2.4 + rows * rowD + 0.9]) });

    const geo = mergeParts(parts);
    darkenBase(geo, { height: 2.4, amount: 0.34, y0: -2.0 });
    const mat = this._mat(propMaterial({ roughness: 0.78, metalness: 0.12, envMapIntensity: 0.5 }));

    const L = this.track.length;
    const d = NEAR_D + 1.6;
    const items = [];
    for (const frac of fractions) {
      // Search around the requested position for the flattest ground the stand
      // can span. A deck is a rigid rectangle: dropped on a falling slope its
      // plinth becomes a five-metre blank wall, which is the single ugliest
      // thing a procedurally placed building can do.
      let best = null;
      const depth = rows * rowD + 3;
      for (let i = -10; i <= 10; i++) {
        const s = mod(frac * L + i * 9, L);
        for (const side of [-1, 1]) {
          const half = this.track.halfWidthAt(s);
          const lateral = side * (half + WALL_OFFSET + d);
          // Sample the whole footprint — along the arc *and* back into the
          // slope. Checking only the arc misses the direction the ground
          // actually falls away in, which on a coast is straight at the sea.
          let lo = Infinity, hi = -Infinity;
          for (let k = -2; k <= 2; k++) {
            for (const j of [0, depth * 0.5, depth]) {
              const y = this.terrain.heightAt(mod(s + k * 8, L), side * (half + WALL_OFFSET + d + j));
              if (y < lo) lo = y;
              if (y > hi) hi = y;
            }
          }
          const drowned = Math.max(0, this.track.waterLevel + 6 - lo);
          const score = (hi - lo) + drowned * 3
            + (side === this.terrain.outwardSign(s) ? 0 : 1.6) + Math.abs(i) * 0.05;
          if (!best || score < best.score) best = { s, side, lateral, y: lo, score };
        }
      }
      const { s, side, lateral, y } = best;
      const m = this._alongBasis(s, lateral, y - 0.15, side);
      items.push({ s, m });
      const faceYaw = Math.atan2(-m.elements[8], -m.elements[10]);

      // Populate it. Gaps are deliberate: a completely full stand reads as a
      // printed texture, a stand with holes reads as people who chose seats.
      const seatRng = makeRng(9000 + Math.round(s));
      const pos = new THREE.Vector3();
      for (let r = 0; r < rows; r++) {
        const fill = clamp01(0.92 - r * 0.045 + (seatRng() - 0.5) * 0.30);
        const cols = Math.floor(width / 0.54);
        for (let c = 0; c < cols; c++) {
          if (seatRng() > fill) continue;
          pos.set(
            (c - (cols - 1) * 0.5) * 0.54 + (seatRng() - 0.5) * 0.14,
            r * rowH + rowH + 0.05,
            2.4 + r * rowD - 0.15 + (seatRng() - 0.5) * 0.2,
          ).applyMatrix4(m);
          this._person(s, pos.clone(), {
            yaw: faceYaw + (seatRng() - 0.5) * 0.5,
            // Seated: about 1.25 m crown-to-seat, so the row behind still
            // clears the row in front over a 0.6 m rise.
            scale: lerp(1.14, 1.34, seatRng()),
            color: crowdColor(seatRng),
            armsUp: seatRng() < 0.22,
          });
        }
      }
    }
    this._spread('grandstand', geo, mat, items, { per: 2, maxChunks: 6, cast: true, receive: true });
  }

  /**
   * Standing spectator pockets: a run of crowd-control fence with people
   * behind it and a couple of pennants. These are what stop the parts of the
   * lap without a grandstand from reading as unattended.
   */
  _spectatorPockets(count, flagColors) {
    const fenceParts = [];
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 2.3;
      fenceParts.push({ geo: new THREE.BoxGeometry(2.1, 0.09, 0.06), color: 0xdfe4ea, m: T([x, 1.02, 0]) });
      fenceParts.push({ geo: new THREE.BoxGeometry(2.1, 0.07, 0.06), color: 0xdfe4ea, m: T([x, 0.62, 0]) });
      fenceParts.push({ geo: new THREE.BoxGeometry(0.08, 1.06, 0.08), color: 0xb9c0c8, m: T([x - 1.05, 0.53, 0]) });
    }
    const fenceGeo = mergeParts(fenceParts);
    const fenceMat = this._mat(propMaterial({ roughness: 0.5, metalness: 0.35, envMapIntensity: 0.8, side: THREE.DoubleSide }));

    const sites = scatterAlong(this.rng, this.terrain, {
      count, band: [NEAR_D, NEAR_D + 7], cycles: 13, threshold: 0.15,
      cluster: [1, 1], minGap: 34,
      accept: (it) => it.pos.y > this.track.waterLevel + 2.5,
    });

    const fenceItems = [];
    const flagItems = [];
    const pos = new THREE.Vector3();
    for (const site of sites) {
      const rng = makeRng(4400 + Math.round(site.s * 7 + site.d));
      const m = this._alongBasis(site.s, site.lateral, site.pos.y, site.side);
      const faceYaw = Math.atan2(-m.elements[8], -m.elements[10]);
      fenceItems.push({ s: site.s, m });
      this._blob(site, 7.5, { opacity: 0.5 });

      const heads = 6 + Math.floor(rng() * 14);
      for (let i = 0; i < heads; i++) {
        pos.set((rng() - 0.5) * 11.5, 0, 0.5 + rng() * 3.4);
        const gy = this.terrain.heightAt(site.s, site.lateral + (rng() - 0.5) * 6);
        pos.applyMatrix4(m);
        pos.y = gy;
        this._person(site.s, pos.clone(), {
          yaw: faceYaw + (rng() - 0.5) * 0.7,
          scale: lerp(1.62, 1.86, rng()),
          color: crowdColor(rng),
          armsUp: rng() < 0.34,
        });
      }
      // A pole with a pennant gives the pocket vertical presence and motion.
      if (rng() < 0.75) {
        pos.set((rng() - 0.5) * 12, 0, 1.0).applyMatrix4(m);
        pos.y = this.terrain.heightAt(site.s, site.lateral) + 2.9;
        flagItems.push({
          s: site.s,
          m: poseMatrix(pos.clone(), { yaw: rng() * TAU, scale: lerp(0.9, 1.4, rng()) }, new THREE.Matrix4()),
          color: flagColors[Math.floor(rng() * flagColors.length) % flagColors.length],
        });
      }
    }

    this._spread('spectatorFence', fenceGeo, fenceMat, fenceItems, { per: 9, maxChunks: 5, cast: false });

    if (flagItems.length) {
      const poleParts = [
        { geo: columnGeometry(3.4, 0.06, 0.045, { segs: 1, sides: 5, curve: 1 }), color: 0xcfd6dd, m: T([0, -2.9, 0]) },
      ];
      const flagGeo = mergeParts([
        ...poleParts,
        { geo: pennantGeometry(1.7, 0.95, { segs: 6, taper: 0.35 }), color: 0xffffff, m: T([0.05, 0.45, 0]) },
      ]);
      const flagMat = this._mat(applyFlag(propMaterial({ roughness: 0.72, side: THREE.DoubleSide }), { amp: 0.26, freq: 3.1, span: 1.75 }));
      this._spread('pennant', flagGeo, flagMat, flagItems, { per: 12, maxChunks: 5, inflate: 1.2 });
    }
  }

  /**
   * A gantry straddling the road: the strongest orienting landmark a circuit
   * has, and the only piece of scenery the player drives *under*. The beam
   * clears the tallest ramp launch by a wide margin.
   */
  _gantry(fractions, palette) {
    const tex = bannerStripTexture(palette, SPONSOR_WORDS);
    this._textures.push(tex);
    const beamMat = this._mat(new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.6, side: THREE.DoubleSide,
    }));
    const steelMat = this._mat(propMaterial({ roughness: 0.42, metalness: 0.55, envMapIntensity: 1.0 }));

    for (const frac of fractions) {
      const s = mod(frac * this.track.length, this.track.length);
      const half = this.track.halfWidthAt(s);
      const legLat = half + WALL_OFFSET + 1.2;
      const f = this.track.frameAt(s, {});
      const baseY = Math.min(
        this.terrain.heightAt(s, legLat),
        this.terrain.heightAt(s, -legLat),
      ) - 0.2;
      const m = this._crossBasis(s, baseY);
      const topY = f.pos.y - baseY + 8.4;

      // Legs and lattice, in the frame's local space (X across, Z along).
      // Each tower is a pair of legs braced together, not a single post. One
      // 0.55 m column carrying a 40 m beam reads as a stick holding up a
      // billboard; the pair reads as a structure that could take the load.
      const steel = [];
      for (const sx of [-1, 1]) {
        for (const dz of [-1.0, 1.0]) {
          steel.push({ geo: new THREE.BoxGeometry(0.46, topY + 1.9, 0.46), color: 0xdfe5ea, m: T([sx * legLat, (topY + 1.9) * 0.5, dz]) });
        }
        steel.push({ geo: new THREE.BoxGeometry(2.3, 0.6, 3.4), color: 0x9aa3ab, m: T([sx * legLat, 0.30, 0]) });
        for (let k = 0; k < 5; k++) {
          steel.push({
            geo: new THREE.BoxGeometry(0.20, 2.4, 0.20), color: 0xc8d0d8,
            m: T([sx * legLat, 1.4 + k * 2.0, 0], [k % 2 ? 0.66 : -0.66, 0, 0]),
          });
          steel.push({ geo: new THREE.BoxGeometry(0.22, 0.22, 2.2), color: 0xc8d0d8, m: T([sx * legLat, 1.4 + k * 2.0, 0]) });
        }
        // A diagonal back-stay planted outboard: the detail that says the
        // gantry is anchored rather than balanced.
        steel.push({
          geo: new THREE.BoxGeometry(0.26, topY * 0.85, 0.26), color: 0xbcc4cc,
          m: T([sx * (legLat + 1.9), topY * 0.40, 0], [0, 0, sx * 0.42]),
        });
      }
      // Truss above the beam.
      steel.push({ geo: new THREE.BoxGeometry(legLat * 2 + 1.4, 0.34, 0.9), color: 0xdfe5ea, m: T([0, topY + 1.7, 0]) });
      for (let k = -5; k <= 5; k++) {
        steel.push({ geo: new THREE.BoxGeometry(0.16, 1.6, 0.16), color: 0xc8d0d8, m: T([k * legLat * 0.18, topY + 0.9, 0], [0, 0, (k % 2 ? 0.42 : -0.42)]) });
      }
      const steelGeo = mergeParts(steel);
      steelGeo.applyMatrix4(m);
      steelGeo.computeBoundingSphere();
      addMesh(this.group, steelGeo, steelMat, { name: 'gantry', cast: true, receive: true });

      // Sponsor beam. Two faces so it reads coming and going.
      const beamW = legLat * 2, beamH = 1.55;
      const bg = new THREE.BoxGeometry(beamW, beamH, 0.5);
      // Three passes of the four-board strip across the span, so the panels
      // land at roughly the 3 m width a real hoarding panel has.
      const uv = bg.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 3);
      bg.applyMatrix4(T([0, topY + 0.6, 0]));
      bg.applyMatrix4(m);
      bg.computeBoundingSphere();
      addMesh(this.group, bg, beamMat, { name: 'gantryBeam', cast: true, receive: false });
    }
  }

  /**
   * The verge: tyre barriers and marker posts in the first ten metres behind
   * the wall.
   *
   * The terrain mesh leaves a hole either side of the road, so the nearest
   * ground a scattered prop can stand on is already ~12 m from the tarmac.
   * That leaves the fastest-moving band of the frame — the one the eye uses to
   * read speed — completely empty. These two families exist to fill it, and
   * they are man-made so a regular rhythm is correct rather than a tell.
   */
  _verge(accentColor) {
    const L = this.track.length;

    // Tyre stacks, in bundles on the outside of corners where a real circuit
    // would put them.
    const stackParts = [];
    for (let i = 0; i < 3; i++) {
      stackParts.push({
        geo: new THREE.TorusGeometry(0.46, 0.19, 4, 9),
        color: 0x14161a,
        m: T([0, 0.22 + i * 0.38, 0], [Math.PI * 0.5, i * 0.7, 0]),
      });
    }
    stackParts.push({ geo: new THREE.CylinderGeometry(0.5, 0.5, 0.1, 8), color: accentColor, m: T([0, 1.32, 0]) });
    const stackGeo = mergeParts(stackParts);
    darkenBase(stackGeo, { height: 0.5, amount: 0.45 });
    const stackMat = this._mat(propMaterial({ roughness: 0.95, envMapIntensity: 0.3 }));

    const stacks = [];
    const p = new THREE.Vector3();
    // A bundle every other eligible slot, not every one. An unbroken tyre wall
    // around the whole outside of a bend is a barrier, and it turns the
    // accent-capped top row into a dotted line that reads as a UI element.
    const bundleField = loopField(this.rng, { cycles: 23, octaves: 2 });
    for (let s = 0; s < L; s += 7.4) {
      const curve = Math.abs(this.track.frameAt(s, {}).curvature);
      if (curve < 0.013 || bundleField(s / L) < 0.05) continue;
      // Outside of the bend only: the inside of a corner is where a driver
      // looks for the apex and must stay clean.
      const side = this._outsideSign(s);
      const rows = 2;
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < 3; k++) {
          if (this.rng() < 0.18) continue;
          const ss = mod(s + k * 1.4 + (this.rng() - 0.5) * 0.5, L);
          const dd = NEAR_D + 0.2 + r * 1.15;
          const lateral = side * (this.track.halfWidthAt(ss) + WALL_OFFSET + dd);
          this.terrain.place(ss, lateral, p);
          stacks.push({
            s: ss,
            m: poseMatrix(p.clone().setY(p.y - 0.12), {
              yaw: this.rng() * TAU, scale: lerp(0.9, 1.12, this.rng()),
            }, new THREE.Matrix4()),
          });
        }
      }
    }
    this._spread('tyreStack', stackGeo, stackMat, stacks, { per: 60, maxChunks: 8, cast: true, receive: true });

    // Distance markers: a post every 25 m, every fourth one in the circuit's
    // accent colour. Cheap, but it is the thing that actually reads as speed
    // at the edge of the frame.
    const postGeo = mergeParts([
      { geo: columnGeometry(1.7, 0.07, 0.055, { segs: 1, sides: 5, curve: 1 }), color: 0xe8ecf0 },
      { geo: new THREE.BoxGeometry(0.52, 0.42, 0.05), color: 0xffffff, m: T([0, 1.55, 0]) },
    ]);
    darkenBase(postGeo, { height: 0.3, amount: 0.4 });
    const postMat = this._mat(propMaterial({ roughness: 0.6, metalness: 0.2, envMapIntensity: 0.7, side: THREE.DoubleSide }));
    const posts = [];
    let n = 0;
    for (let s = 0; s < L; s += 25) {
      for (const side of [-1, 1]) {
        const lateral = side * (this.track.halfWidthAt(s) + WALL_OFFSET + NEAR_D + 0.4);
        this.terrain.place(s, lateral, p);
        posts.push({
          s,
          m: poseMatrix(p.clone().setY(p.y - 0.1), { yaw: this.rng() * 0.4 - 0.2 }, new THREE.Matrix4()),
          color: (n % 4 === 0) ? accentColor : 0xf2f5f8,
        });
      }
      n++;
    }
    this._spread('markerPost', postGeo, postMat, posts, { per: 24, maxChunks: 6, cast: false });
  }

  /** Circling birds, high and slow — motion in the empty part of the frame. */
  _birds(count, color, radius, height) {
    const wing = [];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -1.0, 0.0, -0.10, 0.0, 0.06, 0.28, 0.0, 0.06, -0.34,
      1.0, 0.0, -0.10, 0.0, 0.06, -0.34, 0.0, 0.06, 0.28,
    ], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1], 2));
    g.computeVertexNormals();
    wing.push({ geo: g, color });
    const geo = mergeParts(wing);
    const mat = this._mat(applyFlap(propMaterial({ roughness: 0.85, side: THREE.DoubleSide }), { amp: 0.42, freq: 5.4 }), { env: true });

    const c = this.terrain.centre;
    const items = [];
    for (let i = 0; i < count; i++) {
      const th = this.rng() * TAU;
      const r = radius * lerp(0.55, 1.25, this.rng());
      const p = new THREE.Vector3(c.x + Math.cos(th) * r, height + this.rng() * 46, c.z + Math.sin(th) * r);
      items.push({
        s: i, m: poseMatrix(p, { yaw: th + Math.PI * 0.5, lean: (this.rng() - 0.5) * 0.4, scale: lerp(0.9, 1.9, this.rng()) }, new THREE.Matrix4()),
      });
    }
    const flock = new THREE.Group();
    flock.name = 'birdFlock';
    this.group.add(flock);
    chunkedInstances(flock, geo, mat, items, 1, { name: 'bird', inflate: 3 });
    // Orbiting the whole flock is one matrix update a frame and reads as
    // thermalling; per-bird pathing would cost an instance-matrix rewrite.
    flock.position.copy(c);
    this.animated.push((dt, time) => {
      flock.rotation.y = time * 0.026;
    });
    for (const child of flock.children) child.position.sub(c);
  }

  // =========================================================================
  // Sunset Coast
  // =========================================================================

  _buildCoast() {
    this._coastBackdrop();
    this._coastCover();
    this._palms();
    this._coastRocks();
    this._parasols();
    this._driftwood();
    this._buoysAndBoats();
    this._lighthouse();
    this._hoardings(COAST_SPONSORS);
    this._grandstands([0.0, 0.235, 0.50, 0.735]);
    this._spectatorPockets(this._n(22), [0xe2483c, 0xffcf3d, 0x7fd4ff, 0xffffff, 0x2b8a63]);
    this._verge(0xd23c33);
    this._gantry([0.0, 0.42], COAST_SPONSORS);
    this._birds(this._n(30), 0xf2e6d8, 330, this.track.maxY + 60);
  }

  /**
   * Headlands, sea stacks and islands ringing the bay at 500-1300 m.
   *
   * This is the layer fog exists for. Without it the sea meets the sky in a
   * dead straight line at every compass bearing and the circuit reads as a
   * model on a table; with it there is depth behind the depth.
   */
  _coastBackdrop() {
    const rng = makeRng(2201);
    const c = this.terrain.centre;
    const wl = this.track.waterLevel;
    const parts = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      // Angular jitter, not an even ring — a regular polygon of islands is
      // instantly readable as one at this scale.
      const th = (i / count) * TAU + (rng() - 0.5) * 0.30;
      const r = lerp(520, 1280, Math.pow(rng(), 0.7));
      const big = rng();
      const h = lerp(26, 128, Math.pow(big, 1.5));
      const w = h * lerp(1.5, 4.6, rng());
      const geo = rockGeometry(rng, { detail: 1, rough: 0.30, squash: 0.55 });
      // Islands sit *in* the water: the base is below sea level so there is no
      // visible seam where a landform meets the plane.
      parts.push({
        geo,
        color: 0xffffff,
        m: T([c.x + Math.cos(th) * r, wl + h * 0.30, c.z + Math.sin(th) * r],
          [(rng() - 0.5) * 0.16, rng() * TAU, (rng() - 0.5) * 0.16],
          [w, h, w * lerp(0.55, 1.0, rng())]),
      });
      // A couple of stacks in front of the larger masses for silhouette layering.
      if (big > 0.55) {
        for (let k = 0; k < 2; k++) {
          const rr = r * lerp(0.72, 0.92, rng());
          const tt = th + (rng() - 0.5) * 0.18;
          const hh = h * lerp(0.20, 0.45, rng());
          parts.push({
            geo: rockGeometry(rng, { detail: 0, rough: 0.42, squash: 1.5 }),
            color: 0xffffff,
            m: T([c.x + Math.cos(tt) * rr, wl + hh * 0.45, c.z + Math.sin(tt) * rr],
              [0, rng() * TAU, (rng() - 0.5) * 0.2], [hh * 0.55, hh, hh * 0.5]),
          });
        }
      }
    }
    const geo = mergeParts(parts);
    // Height-graded colour: wet dark rock at the waterline, sun-bleached scrub
    // on top. One gradient does the work of a texture at this distance.
    paintGeometry(geo, (v, col) => {
      const t = clamp01((v.y - wl) / 90);
      col.setRGB(lerp(0.30, 0.52, t), lerp(0.28, 0.47, t), lerp(0.30, 0.40, t));
    });
    geo.computeBoundingSphere();
    const mat = this._mat(propMaterial({ roughness: 0.95, envMapIntensity: 0.5, flatShading: true }));
    addMesh(this.group, geo, mat, { name: 'coastBackdrop', receive: false });
  }

  /** Marram grass and low scrub: the near-layer texture that fills frame edges. */
  _coastCover() {
    const wl = this.track.waterLevel;
    const grassItems = scatterAlong(this.rng, this.terrain, {
      count: this._n(1900), band: [NEAR_D, 46], cycles: 17, threshold: -0.42,
      bias: 1.3, cluster: [5, 13], clusterArc: 5.0, clusterLat: 3.2, depthPow: 2.0,
      accept: (it) => it.pos.y > wl + 1.0,
    });
    const grassGeo = mergeParts([
      { geo: tuftGeometry(makeRng(31), { blades: 5, height: 0.95, width: 0.055, segs: 2, spread: 0.42, curl: 0.62 }), color: 0xa8a267 },
    ]);
    darkenBase(grassGeo, { height: 0.30, amount: 0.55 });
    const grassMat = this._mat(applyWind(
      propMaterial({ roughness: 0.94, side: THREE.DoubleSide, envMapIntensity: 0.3 }),
      { amp: 0.10, freq: 1.9, height: 1.0, pow: 1.5, dirX: 1, dirZ: 0.6 },
    ));
    const items = [];
    const n = new THREE.Vector3();
    for (const it of grassItems) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.75, 2.1, it.u * it.u);
      items.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, normal: n, align: 0.8, scale: [sc, sc * lerp(0.7, 1.5, it.w), sc] }, new THREE.Matrix4()),
        // Authored in sRGB and kept dark: marram on pale sand only reads at
        // all because it is two stops below the ground it stands on.
        color: new THREE.Color().setHSL(lerp(0.11, 0.19, it.w), lerp(0.24, 0.52, it.u), lerp(0.17, 0.32, it.v), THREE.SRGBColorSpace),
      });
    }
    this._spread('beachGrass', grassGeo, grassMat, items, { per: 190, maxChunks: 10, inflate: 1.0 });

    // Coastal scrub: bigger, rarer, in tight thickets so the grass has
    // something to break against.
    const scrub = scatterAlong(this.rng, this.terrain, {
      count: this._n(230), band: [NEAR_D + 1, 52], cycles: 11, threshold: 0.0,
      bias: 2.2, cluster: [2, 6], clusterArc: 7, clusterLat: 4.5, minGap: 1.6,
      accept: (it) => it.pos.y > wl + 1.6,
    });
    const scrubGeo = blobClusterGeometry(makeRng(77), { lobes: 3, detail: 0, spread: 0.55, squash: 0.6 });
    paintGeometry(scrubGeo, (v, col) => {
      const t = clamp01(v.y / 1.3);
      col.setRGB(lerp(0.16, 0.34, t), lerp(0.21, 0.42, t), lerp(0.12, 0.20, t));
    });
    const scrubMat = this._mat(applyWind(propMaterial({ roughness: 0.92, flatShading: true }), { amp: 0.035, freq: 1.4, height: 1.6, pow: 1.6 }));
    const sItems = [];
    for (const it of scrub) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.7, 2.1, it.u);
      it.pos.y -= 0.15 * sc;
      sItems.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, normal: n, align: 0.55, scale: [sc, sc * lerp(0.6, 1.0, it.w), sc * lerp(0.85, 1.2, it.v)] }, new THREE.Matrix4()),
      });
      if (sc > 1.3) this._blob(it, sc * 1.5, { opacity: 0.55 });
    }
    this._spread('coastScrub', scrubGeo, scrubMat, sItems, { per: 60, maxChunks: 8, cast: false, inflate: 0.5 });
  }

  /** Palm thickets. Two silhouettes, heavy size variation, real gaps between groves. */
  _palms() {
    const wl = this.track.waterLevel;
    const variants = [
      { rng: makeRng(101), h: 9.2, fronds: 9, lean: 0.16, trunkR: 0.30 },
      { rng: makeRng(202), h: 6.2, fronds: 11, lean: 0.09, trunkR: 0.36 },
    ];
    const geos = variants.map((v) => {
      const parts = [{
        geo: columnGeometry(v.h, v.trunkR, v.trunkR * 0.56, {
          segs: 5, sides: 7, bendX: v.h * 0.13, bendZ: v.h * 0.05, curve: 2.1,
        }),
        color: 0x8a7256,
      }];
      const tipX = v.h * 0.13, tipZ = v.h * 0.05;
      for (let i = 0; i < v.fronds; i++) {
        const a = (i / v.fronds) * TAU + v.rng() * 0.5;
        const pitch = -0.10 - v.rng() * 0.42;
        parts.push({
          geo: frondGeometry(v.h * lerp(0.40, 0.56, v.rng()), v.h * 0.075, { segs: 4, droop: 0.85 + v.rng() * 0.5, fold: 0.34 }),
          color: v.rng() < 0.35 ? 0x5f8a3a : 0x47702e,
          m: T([tipX, v.h - 0.15, tipZ], [0, a, pitch]),
        });
      }
      for (let i = 0; i < 4; i++) {
        const a = v.rng() * TAU;
        parts.push({
          geo: new THREE.OctahedronGeometry(v.h * 0.030, 0), color: 0x6d5a2e,
          m: T([tipX + Math.cos(a) * v.h * 0.035, v.h - 0.45, tipZ + Math.sin(a) * v.h * 0.035]),
        });
      }
      const g = mergeParts(parts);
      darkenBase(g, { height: 1.5, amount: 0.40 });
      return g;
    });

    const mat = this._mat(applyWind(
      propMaterial({ roughness: 0.85, side: THREE.DoubleSide, envMapIntensity: 0.4 }),
      { amp: 0.045, freq: 0.95, height: 9, pow: 2.2, dirX: 1, dirZ: 0.5 },
    ));

    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(210), band: [NEAR_D + 0.8, 62], cycles: 9, threshold: 0.02,
      bias: 2.4, cluster: [3, 9], clusterArc: 9, clusterLat: 6, minGap: 3.0, depthPow: 1.5,
      accept: (it) => it.pos.y > wl + 2.2,
    });

    const buckets = [[], []];
    const n = new THREE.Vector3();
    for (const it of sites) {
      const vi = it.w < 0.62 ? 0 : 1;
      terrainNormal(this.terrain, it.s, it.lateral, n, 4);
      const sc = lerp(0.62, 1.35, Math.pow(it.u, 0.85));
      it.pos.y -= 0.25;
      buckets[vi].push({
        s: it.s,
        m: poseMatrix(it.pos, {
          yaw: it.v * TAU,
          normal: n, align: 0.35,
          lean: (it.u - 0.5) * variants[vi].lean * 2 + (it.v - 0.5) * 0.06,
          leanDir: it.w * TAU,
          scale: [sc, sc * lerp(0.85, 1.2, it.v), sc],
        }, new THREE.Matrix4()),
      });
      this._blob(it, sc * (vi === 0 ? 2.9 : 2.4), { opacity: 0.8 });
    }
    for (let i = 0; i < 2; i++) {
      this._spread(`palm${i}`, geos[i], mat, buckets[i], { per: 34, maxChunks: 8, cast: true, receive: true, inflate: 2.0 });
    }
  }

  /** Boulders and shingle: drifted, sunk, slope-aligned, wildly varied in size. */
  _coastRocks() {
    const wl = this.track.waterLevel;
    const geos = [0, 1, 2].map((i) => {
      const g = rockGeometry(makeRng(310 + i), { detail: i === 2 ? 1 : 0, rough: 0.30 + i * 0.06, squash: 0.62 + i * 0.08 });
      paintGeometry(g, (v, col) => {
        const t = clamp01(v.y * 0.5 + 0.5);
        col.setRGB(lerp(0.30, 0.55, t), lerp(0.27, 0.50, t), lerp(0.24, 0.44, t));
      });
      return g;
    });
    const mat = this._mat(propMaterial({ roughness: 0.95, envMapIntensity: 0.45, flatShading: true }));

    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(330), band: [NEAR_D, 96], cycles: 12, threshold: -0.18,
      bias: 2.0, cluster: [2, 8], clusterArc: 7, clusterLat: 6, minGap: 1.1, depthPow: 1.25,
      accept: (it) => it.pos.y > wl - 1.0,
    });
    const buckets = [[], [], []];
    const n = new THREE.Vector3();
    for (const it of sites) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      // Long tail on size: mostly shingle, occasionally something the size of a
      // car. A uniform size distribution is what makes scattered rock read as
      // gravel texture rather than as rocks.
      const sc = lerp(0.35, 4.2, Math.pow(it.u, 3.0));
      it.pos.y -= sc * 0.32;
      buckets[Math.floor(it.w * 3) % 3].push({
        s: it.s,
        m: poseMatrix(it.pos, {
          yaw: it.v * TAU, normal: n, align: 0.85,
          scale: [sc * lerp(0.8, 1.4, it.v), sc * lerp(0.55, 1.0, it.w), sc * lerp(0.8, 1.3, it.u)],
        }, new THREE.Matrix4()),
      });
      if (sc > 1.0) this._blob(it, sc * 1.4, { opacity: 0.6 });
    }
    for (let i = 0; i < 3; i++) {
      this._spread(`coastRock${i}`, geos[i], mat, buckets[i], { per: 46, maxChunks: 7, cast: true, receive: true });
    }
  }

  /** Beach umbrellas with towels — small human-scale colour, always in groups. */
  _parasols() {
    const wl = this.track.waterLevel;
    const canopy = new THREE.ConeGeometry(1.55, 0.62, 10, 1, true);
    // Segments alternate light and dark of the *same* value, so the per-instance
    // tint below turns each umbrella into a two-tone of one hue rather than
    // sixty identical red-and-white ones.
    paintGeometry(canopy, (v, col) => {
      const seg = Math.floor((Math.atan2(v.z, v.x) + Math.PI) / TAU * 10);
      const k = seg % 2 ? 1.0 : 0.52;
      col.setRGB(k, k, k);
    });
    const geo = mergeParts([
      { geo: canopy, m: T([0, 2.05, 0]) },
      { geo: columnGeometry(2.1, 0.045, 0.035, { segs: 1, sides: 5, curve: 1 }), color: 0xf0ece2 },
      { geo: new THREE.BoxGeometry(1.5, 0.03, 0.85), color: 0x62c8d8, m: T([1.15, 0.02, 0.5], [0, 0.4, 0]) },
      { geo: new THREE.BoxGeometry(1.4, 0.03, 0.8), color: 0xf5b93c, m: T([-0.9, 0.02, -0.9], [0, -0.7, 0]) },
    ], { keep: false });
    const mat = this._mat(propMaterial({ roughness: 0.8, side: THREE.DoubleSide, envMapIntensity: 0.5 }));

    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(64), band: [20, 66], cycles: 6, threshold: 0.28,
      bias: 2.0, cluster: [3, 7], clusterArc: 6, clusterLat: 5, minGap: 3.4,
      accept: (it) => it.pos.y > wl + 1.2 && it.pos.y < wl + 9,
    });
    const items = [];
    const n = new THREE.Vector3();
    for (const it of sites) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.85, 1.15, it.u);
      items.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, normal: n, align: 0.5, lean: (it.w - 0.5) * 0.16, leanDir: it.u * TAU, scale: sc }, new THREE.Matrix4()),
        color: new THREE.Color().setHSL(lerp(0.0, 0.62, Math.floor(it.w * 5) / 5), 0.55, 0.62),
      });
      this._blob(it, 2.2, { opacity: 0.45 });
    }
    this._spread('parasol', geo, mat, items, { per: 18, maxChunks: 4, cast: true });
  }

  /** Bleached driftwood along the tideline: near-ground horizontal interest. */
  _driftwood() {
    const wl = this.track.waterLevel;
    const geo = mergeParts([
      { geo: columnGeometry(3.4, 0.20, 0.12, { segs: 3, sides: 5, bendX: 0.5, curve: 1.4 }), color: 0xc9bda6, m: T([0, 0, 0], [0, 0, Math.PI * 0.5]) },
      { geo: columnGeometry(1.3, 0.09, 0.05, { segs: 1, sides: 4, curve: 1 }), color: 0xbdb096, m: T([1.4, 0.12, 0.1], [0.6, 0.3, 0.9]) },
    ]);
    darkenBase(geo, { height: 0.35, amount: 0.35 });
    const mat = this._mat(propMaterial({ roughness: 0.95, flatShading: true }));
    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(70), band: [26, 78], cycles: 14, threshold: -0.1,
      bias: 1.6, cluster: [1, 3], clusterArc: 8, clusterLat: 6, minGap: 5,
      accept: (it) => it.pos.y > wl + 0.2 && it.pos.y < wl + 6,
    });
    const items = [];
    const n = new THREE.Vector3();
    for (const it of sites) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.6, 1.5, it.u);
      it.pos.y -= 0.1;
      items.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, normal: n, align: 0.9, lean: (it.w - 0.5) * 0.3, leanDir: it.v * TAU, scale: sc }, new THREE.Matrix4()),
      });
      this._blob(it, sc * 2.0, { opacity: 0.5 });
    }
    this._spread('driftwood', geo, mat, items, { per: 26, maxChunks: 4, cast: true });
  }

  /** Channel markers and moored yachts: the layer that gives the sea a scale. */
  _buoysAndBoats() {
    const wl = this.track.waterLevel;
    const L = this.track.length;

    const buoyGeo = mergeParts([
      { geo: new THREE.ConeGeometry(0.85, 2.5, 8), color: 0xe2483c, m: T([0, 1.1, 0]) },
      { geo: new THREE.CylinderGeometry(0.9, 0.9, 0.6, 8), color: 0x1b1f26, m: T([0, -0.1, 0]) },
      { geo: columnGeometry(1.1, 0.05, 0.04, { segs: 1, sides: 4, curve: 1 }), color: 0x2b3038, m: T([0, 2.3, 0]) },
      { geo: new THREE.OctahedronGeometry(0.22, 0), color: 0xffdf6b, m: T([0, 3.45, 0]) },
    ]);
    const buoyMat = this._mat(applyBob(propMaterial({ roughness: 0.6, metalness: 0.1, envMapIntensity: 0.9 }), { amp: 0.42, freq: 0.85, roll: 0.13 }));

    const boatGeo = mergeParts([
      { geo: new THREE.ConeGeometry(1.05, 6.4, 6), color: 0xf2f4f7, m: T([0, 0.35, 0], [Math.PI * 0.5, 0, 0], [1, 1, 0.42]) },
      { geo: new THREE.BoxGeometry(1.3, 0.55, 2.2), color: 0xdfe4ea, m: T([0, 0.75, -0.4]) },
      { geo: columnGeometry(7.6, 0.09, 0.05, { segs: 1, sides: 4, curve: 1 }), color: 0xcfd6dd, m: T([0, 0.7, 0]) },
      { geo: pennantGeometry(5.6, 3.0, { segs: 4, taper: 0.12 }), color: 0xffffff, m: T([0.08, 7.4, 0], [0, Math.PI * 0.5, Math.PI * 0.5]) },
      { geo: pennantGeometry(3.0, 1.7, { segs: 3, taper: 0.15 }), color: 0xf5f7fa, m: T([-0.08, 5.2, 0], [0, -Math.PI * 0.5, Math.PI * 0.5]) },
    ]);
    const boatMat = this._mat(applyBob(propMaterial({ roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide, envMapIntensity: 1.0 }), { amp: 0.26, freq: 0.6, roll: 0.075 }));

    const buoys = [], boats = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < this._n(34); i++) {
      const s = this.rng() * L;
      const side = this.rng() < 0.5 ? -1 : 1;
      const d = lerp(95, 235, Math.pow(this.rng(), 0.8));
      const lateral = side * (this.track.halfWidthAt(s) + WALL_OFFSET + d);
      if (this.terrain.heightAt(s, lateral) > wl - 1.5) continue;
      this.track.placeOnRoad(s, lateral, p);
      p.y = wl + 0.1;
      const sc = lerp(0.8, 1.5, this.rng());
      buoys.push({ s, m: poseMatrix(p.clone(), { yaw: this.rng() * TAU, scale: sc }, new THREE.Matrix4()) });
    }
    for (let i = 0; i < this._n(12); i++) {
      const s = this.rng() * L;
      const side = this.rng() < 0.5 ? -1 : 1;
      const d = lerp(120, 300, this.rng());
      const lateral = side * (this.track.halfWidthAt(s) + WALL_OFFSET + d);
      if (this.terrain.heightAt(s, lateral) > wl - 3) continue;
      this.track.placeOnRoad(s, lateral, p);
      p.y = wl - 0.3;
      boats.push({ s, m: poseMatrix(p.clone(), { yaw: this.rng() * TAU, scale: lerp(0.9, 1.8, this.rng()) }, new THREE.Matrix4()) });
    }
    this._spread('buoy', buoyGeo, buoyMat, buoys, { per: 14, maxChunks: 4, inflate: 1.5 });
    this._spread('yacht', boatGeo, boatMat, boats, { per: 7, maxChunks: 3, inflate: 3 });
  }

  /**
   * The lighthouse: the one silhouette a player uses to know where on the lap
   * they are. Sited on the highest ground the circuit offers, and given a
   * rotating beam because at golden hour a lit beacon is the strongest
   * single point of interest available in this palette.
   */
  _lighthouse() {
    const L = this.track.length;
    let best = null;
    for (let i = 0; i < 240; i++) {
      const s = (i / 240) * L;
      const side = this.terrain.outwardSign(s);
      const lateral = side * (this.track.halfWidthAt(s) + WALL_OFFSET + 78);
      const y = this.terrain.heightAt(s, lateral);
      if (!best || y > best.y) best = { s, lateral, y, side };
    }
    if (!best) return;

    const H = 26;
    const parts = [
      { geo: columnGeometry(H, 3.1, 1.75, { segs: 6, sides: 12, curve: 1 }), color: 0xffffff },
      { geo: new THREE.CylinderGeometry(2.5, 2.1, 0.9, 12), color: 0x2b3038, m: T([0, H + 0.35, 0]) },
      { geo: new THREE.CylinderGeometry(1.5, 1.5, 2.6, 10, 1, true), color: 0x2a3a48, m: T([0, H + 2.1, 0]) },
      { geo: new THREE.ConeGeometry(2.2, 2.0, 10), color: 0xd23c33, m: T([0, H + 4.4, 0]) },
      { geo: new THREE.SphereGeometry(0.35, 8, 6), color: 0xffe9a8, m: T([0, H + 5.7, 0]) },
      // A keeper's cottage gives the tower a scale reference and a base mass.
      { geo: new THREE.BoxGeometry(7.5, 3.4, 5.5), color: 0xf0ece2, m: T([7.5, 1.7, 2.2], [0, 0.4, 0]) },
      { geo: new THREE.ConeGeometry(5.6, 2.0, 4), color: 0xb04a3a, m: T([7.5, 4.4, 2.2], [0, 0.4 + Math.PI * 0.25, 0]) },
    ];
    const geo = mergeParts(parts);
    // Candy-stripe the tower from world height so the bands are horizontal
    // regardless of how the column was swept.
    paintGeometry(geo, (v, col, i) => {
      const isTower = v.y < H && Math.hypot(v.x, v.z) < 3.4;
      if (!isTower) {
        const src = geo.attributes.color;
        col.setRGB(src.getX(i), src.getY(i), src.getZ(i));
        return;
      }
      const band = Math.floor(v.y / (H / 5)) % 2;
      if (band) col.setRGB(0.72, 0.13, 0.11); else col.setRGB(0.93, 0.92, 0.89);
    });
    darkenBase(geo, { height: 2.0, amount: 0.42 });
    geo.computeBoundingSphere();

    const mat = this._mat(propMaterial({ roughness: 0.7, envMapIntensity: 0.65 }));
    const m = this._crossBasis(best.s, best.y - 0.4).setPosition(
      this.track.placeOnRoad(best.s, best.lateral, new THREE.Vector3()).setY(best.y - 0.4),
    );
    geo.applyMatrix4(m);
    geo.computeBoundingSphere();
    addMesh(this.group, geo, mat, { name: 'lighthouse', cast: true, receive: true });

    // Rotating beam. Additive, unlit, no depth write — it is light, not a solid.
    const beamGeo = new THREE.ConeGeometry(2.6, 150, 10, 1, true);
    beamGeo.translate(0, -75, 0);
    beamGeo.rotateX(Math.PI * 0.5);
    paintGeometry(beamGeo, (v, col) => {
      const t = clamp01(1 - Math.abs(v.z) / 150);
      col.setRGB(t * 0.9, t * 0.78, t * 0.5);
    });
    const beamMat = this._mat(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    }), { env: false });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.name = 'lighthouseBeam';
    beam.frustumCulled = false;
    beam.renderOrder = 3;
    const lamp = new THREE.Vector3(0, H + 3.4, 0).applyMatrix4(m);
    beam.position.copy(lamp);
    this.group.add(beam);
    this.animated.push((dt, time) => { beam.rotation.y = -time * 0.55; });
  }

  // =========================================================================
  // Canyon Rush
  // =========================================================================

  _buildCanyon() {
    this._canyonBackdrop();
    this._mesas();
    this._canyonCover();
    this._cacti();
    this._canyonRocks();
    this._telegraphLine();
    this._rockArch([0.30, 0.72]);
    this._hoardings(CANYON_SPONSORS);
    this._grandstands([0.0, 0.26, 0.545, 0.80]);
    this._spectatorPockets(this._n(22), [0xc9541f, 0xf0a63c, 0xffffff, 0x2f3d52, 0xffe3a8]);
    this._verge(0xdb8a2a);
    this._gantry([0.0, 0.47], CANYON_SPONSORS);
    this._birds(this._n(20), 0x3a2e26, 300, this.track.maxY + 78);
  }

  /** A butte range on the horizon: the far layer the mid mesas read against. */
  _canyonBackdrop() {
    const rng = makeRng(4401);
    const c = this.terrain.centre;
    const baseY = this.track.minY - 6;
    const parts = [];
    const count = 30;
    for (let i = 0; i < count; i++) {
      const th = (i / count) * TAU + (rng() - 0.5) * 0.28;
      const r = lerp(560, 1350, Math.pow(rng(), 0.65));
      const h = lerp(70, 235, Math.pow(rng(), 1.4));
      const w = h * lerp(0.9, 2.4, rng());
      parts.push({
        geo: mesaGeometry(rng, { rings: 6, sides: 10, wobble: 0.18 }),
        color: 0xffffff,
        m: T([c.x + Math.cos(th) * r, baseY, c.z + Math.sin(th) * r], [0, rng() * TAU, 0], [w, h, w * lerp(0.6, 1.1, rng())]),
      });
    }
    const geo = mergeParts(parts);
    paintGeometry(geo, (v, col) => {
      // Strata: the horizontal banding is what makes a mesa read as sedimentary
      // rock instead of a cone, and it survives being 1 km away.
      const band = Math.sin(v.y * 0.09) * 0.5 + 0.5;
      const t = clamp01((v.y - baseY) / 240);
      col.setRGB(
        lerp(0.44, 0.60, t) * lerp(0.86, 1.06, band),
        lerp(0.30, 0.43, t) * lerp(0.88, 1.04, band),
        lerp(0.25, 0.36, t),
      );
    });
    geo.computeBoundingSphere();
    const mat = this._mat(propMaterial({ roughness: 0.98, envMapIntensity: 0.45, flatShading: true }));
    addMesh(this.group, geo, mat, { name: 'canyonBackdrop', receive: false });
  }

  /** Mid-layer mesas and hoodoos standing on the canyon rim. */
  _mesas() {
    const geos = [0, 1, 2].map((i) => {
      const rng = makeRng(660 + i);
      const g = mesaGeometry(rng, { rings: 7, sides: 11 + i, wobble: 0.14 + i * 0.05 });
      paintGeometry(g, (v, col) => {
        const band = Math.sin(v.y * 11 + i) * 0.5 + 0.5;
        const t = clamp01(v.y);
        col.setRGB(
          lerp(0.50, 0.66, t) * lerp(0.82, 1.10, band),
          lerp(0.31, 0.45, t) * lerp(0.85, 1.06, band),
          lerp(0.23, 0.34, t) * lerp(0.9, 1.05, band),
        );
      });
      return g;
    });
    const mat = this._mat(propMaterial({ roughness: 0.98, envMapIntensity: 0.4, flatShading: true }));
    // `mesaGeometry`'s talus apron reaches r = 1.34, so a mesa's real footprint
    // is 1.34x its width scale. Distance therefore has to be chosen *after*
    // size, not before: a scatter band that ignores this puts a 130 m-wide
    // butte 70 m from the barrier and it swallows the entire outside of the
    // corner. Nothing may reach back inside `keepOut`.
    const keepOut = NEAR_D + 14;
    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(52), band: [keepOut, TERRAIN_REACH - 40], cycles: 5, threshold: -0.25,
      bias: 1.5, cluster: [1, 3], clusterArc: 46, clusterLat: 30, minGap: 30, depthPow: 0.8,
    });
    const buckets = [[], [], []];
    const p = new THREE.Vector3();
    for (const it of sites) {
      const h = lerp(14, 52, Math.pow(it.u, 1.9));
      const w = h * lerp(0.42, 0.95, it.v);
      const footprint = w * 1.34;
      const d = Math.max(it.d, keepOut + footprint);
      if (d > TERRAIN_REACH - 20) continue;
      const lateral = it.side * (this.track.halfWidthAt(it.s) + WALL_OFFSET + d);
      this.terrain.place(it.s, lateral, p);
      p.y -= h * 0.06;
      buckets[Math.floor(it.w * 3) % 3].push({
        s: it.s,
        m: poseMatrix(p.clone(), { yaw: it.v * TAU, scale: [w, h, w * lerp(0.7, 1.2, it.w)] }, new THREE.Matrix4()),
      });
    }
    for (let i = 0; i < 3; i++) this._spread(`mesa${i}`, geos[i], mat, buckets[i], { per: 9, maxChunks: 5, cast: true, receive: true });

    // Hoodoos: tall thin stacks nearer the road, for vertical rhythm between
    // the mesas and the ground clutter.
    const hoodooGeo = mergeParts([
      { geo: mesaGeometry(makeRng(771), { rings: 8, sides: 8, wobble: 0.26 }), color: 0xffffff, m: T([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
      { geo: rockGeometry(makeRng(772), { detail: 0, rough: 0.3, squash: 0.5 }), color: 0xffffff, m: T([0, 1.02, 0], [0, 0.5, 0], [1.35, 0.3, 1.35]) },
    ]);
    paintGeometry(hoodooGeo, (v, col) => {
      const band = Math.sin(v.y * 14) * 0.5 + 0.5;
      col.setRGB(lerp(0.52, 0.68, band), lerp(0.33, 0.44, band), lerp(0.24, 0.32, band));
    });
    const hoodoos = scatterAlong(this.rng, this.terrain, {
      count: this._n(46), band: [NEAR_D + 3, 74], cycles: 8, threshold: 0.16,
      bias: 2.2, cluster: [1, 4], clusterArc: 12, clusterLat: 9, minGap: 7,
    });
    const hItems = [];
    for (const it of hoodoos) {
      const h = lerp(4.5, 15, Math.pow(it.u, 1.6));
      const w = h * lerp(0.16, 0.30, it.v);
      it.pos.y -= 0.4;
      hItems.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, lean: (it.w - 0.5) * 0.10, leanDir: it.u * TAU, scale: [w, h, w * lerp(0.85, 1.15, it.w)] }, new THREE.Matrix4()),
      });
      this._blob(it, w * 2.2, { opacity: 0.7 });
    }
    this._spread('hoodoo', hoodooGeo, mat, hItems, { per: 10, maxChunks: 6, cast: true, receive: true });
  }

  /** Dry brush and bunch grass. Sparser and yellower than the coast's cover. */
  _canyonCover() {
    const items = scatterAlong(this.rng, this.terrain, {
      count: this._n(1600), band: [NEAR_D, 62], cycles: 15, threshold: -0.34,
      bias: 1.4, cluster: [4, 12], clusterArc: 5.5, clusterLat: 4.0, depthPow: 1.9,
    });
    const geo = tuftGeometry(makeRng(88), { blades: 5, height: 0.72, width: 0.07, segs: 2, spread: 0.75, curl: 0.75 });
    paintGeometry(geo, (v, col) => {
      const t = clamp01(v.y / 0.8);
      col.setRGB(lerp(0.24, 0.55, t), lerp(0.20, 0.46, t), lerp(0.12, 0.26, t));
    });
    const mat = this._mat(applyWind(propMaterial({ roughness: 0.96, side: THREE.DoubleSide, envMapIntensity: 0.25 }), { amp: 0.07, freq: 2.3, height: 0.9, pow: 1.4 }));
    const out = [];
    const n = new THREE.Vector3();
    for (const it of items) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.7, 2.0, it.u * it.u);
      out.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, normal: n, align: 0.85, scale: [sc, sc * lerp(0.7, 1.4, it.w), sc] }, new THREE.Matrix4()),
        color: new THREE.Color().setHSL(lerp(0.08, 0.14, it.w), lerp(0.22, 0.50, it.u), lerp(0.15, 0.30, it.v), THREE.SRGBColorSpace),
      });
    }
    this._spread('desertBrush', geo, mat, out, { per: 175, maxChunks: 10, inflate: 0.8 });

    // Sagebrush: the mid-size mass between grass and boulder.
    const sage = scatterAlong(this.rng, this.terrain, {
      count: this._n(260), band: [NEAR_D + 1, 78], cycles: 10, threshold: -0.02,
      bias: 2.0, cluster: [2, 6], clusterArc: 8, clusterLat: 6, minGap: 1.8,
    });
    const sageGeo = blobClusterGeometry(makeRng(91), { lobes: 3, detail: 0, spread: 0.6, squash: 0.55 });
    paintGeometry(sageGeo, (v, col) => {
      const t = clamp01(v.y / 1.2);
      col.setRGB(lerp(0.20, 0.36, t), lerp(0.21, 0.36, t), lerp(0.14, 0.24, t));
    });
    const sageMat = this._mat(applyWind(propMaterial({ roughness: 0.95, flatShading: true }), { amp: 0.03, freq: 1.7, height: 1.4, pow: 1.5 }));
    const sItems = [];
    for (const it of sage) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.6, 1.9, it.u);
      it.pos.y -= 0.18 * sc;
      sItems.push({
        s: it.s,
        m: poseMatrix(it.pos, { yaw: it.v * TAU, normal: n, align: 0.5, scale: [sc, sc * lerp(0.55, 0.95, it.w), sc * lerp(0.85, 1.2, it.v)] }, new THREE.Matrix4()),
      });
      if (sc > 1.2) this._blob(it, sc * 1.5, { opacity: 0.5 });
    }
    this._spread('sagebrush', sageGeo, sageMat, sItems, { per: 62, maxChunks: 8, inflate: 0.4 });
  }

  /** Saguaro stands: three silhouettes, arms at different heights and angles. */
  _cacti() {
    const geos = [0, 1, 2].map((i) => {
      const rng = makeRng(820 + i);
      const H = [7.4, 5.2, 3.0][i];
      const parts = [{ geo: columnGeometry(H, 0.42, 0.30, { segs: 4, sides: 9, curve: 1 }), color: 0x4c7040 }];
      const arms = [2, 1, 0][i];
      for (let a = 0; a < arms; a++) {
        const side = a % 2 ? 1 : -1;
        const y0 = H * lerp(0.35, 0.62, rng());
        const reach = H * lerp(0.16, 0.26, rng());
        const rise = H * lerp(0.22, 0.42, rng());
        const pts = [];
        for (let k = 0; k <= 5; k++) {
          const t = k / 5;
          pts.push({
            p: new THREE.Vector3(side * reach * Math.sin(t * Math.PI * 0.5), y0 + rise * Math.pow(t, 1.6), 0),
            r: lerp(0.26, 0.19, t),
          });
        }
        parts.push({ geo: sweepStack(pts, 7, { capStart: false }), color: 0x4c7040, m: T([0, 0, 0], [0, rng() * TAU, 0]) });
      }
      const g = mergeParts(parts);
      paintGeometry(g, (v, col) => {
        // Ribbing from the azimuth around the trunk axis; a smooth green
        // cylinder reads as a bollard.
        const rib = Math.sin(Math.atan2(v.z, v.x) * 9) * 0.5 + 0.5;
        const t = clamp01(v.y / 8);
        col.setRGB(lerp(0.11, 0.19, rib) * lerp(0.85, 1.1, t), lerp(0.19, 0.30, rib), lerp(0.09, 0.15, rib));
      });
      darkenBase(g, { height: 1.0, amount: 0.42 });
      return g;
    });
    const mat = this._mat(applyWind(propMaterial({ roughness: 0.88, envMapIntensity: 0.35 }), { amp: 0.012, freq: 1.2, height: 7, pow: 2.4 }));

    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(240), band: [NEAR_D + 0.6, 84], cycles: 11, threshold: -0.08,
      bias: 2.2, cluster: [2, 7], clusterArc: 11, clusterLat: 8, minGap: 3.2, depthPow: 1.3,
    });
    const buckets = [[], [], []];
    const n = new THREE.Vector3();
    for (const it of sites) {
      const vi = it.w < 0.34 ? 0 : it.w < 0.7 ? 1 : 2;
      terrainNormal(this.terrain, it.s, it.lateral, n, 4);
      const sc = lerp(0.65, 1.35, it.u);
      it.pos.y -= 0.3;
      buckets[vi].push({
        s: it.s,
        m: poseMatrix(it.pos, {
          yaw: it.v * TAU, normal: n, align: 0.3,
          lean: (it.u - 0.5) * 0.13, leanDir: it.w * TAU,
          scale: [sc, sc * lerp(0.85, 1.25, it.v), sc],
        }, new THREE.Matrix4()),
      });
      this._blob(it, sc * 1.5, { opacity: 0.75 });
    }
    for (let i = 0; i < 3; i++) this._spread(`cactus${i}`, geos[i], mat, buckets[i], { per: 34, maxChunks: 8, cast: true, receive: true });
  }

  _canyonRocks() {
    const geos = [0, 1, 2].map((i) => {
      const g = rockGeometry(makeRng(930 + i), { detail: i === 2 ? 1 : 0, rough: 0.34 + i * 0.05, squash: 0.55 + i * 0.1 });
      paintGeometry(g, (v, col) => {
        const t = clamp01(v.y * 0.5 + 0.5);
        const band = Math.sin(v.y * 6 + i) * 0.5 + 0.5;
        col.setRGB(lerp(0.36, 0.60, t) * lerp(0.88, 1.06, band), lerp(0.23, 0.38, t), lerp(0.17, 0.28, t));
      });
      return g;
    });
    const mat = this._mat(propMaterial({ roughness: 0.98, envMapIntensity: 0.35, flatShading: true }));
    const sites = scatterAlong(this.rng, this.terrain, {
      count: this._n(380), band: [NEAR_D, 120], cycles: 13, threshold: -0.22,
      bias: 1.9, cluster: [3, 10], clusterArc: 8, clusterLat: 7, minGap: 1.0, depthPow: 1.2,
    });
    const buckets = [[], [], []];
    const n = new THREE.Vector3();
    for (const it of sites) {
      terrainNormal(this.terrain, it.s, it.lateral, n, 3);
      const sc = lerp(0.4, 5.0, Math.pow(it.u, 3.0));
      it.pos.y -= sc * 0.34;
      buckets[Math.floor(it.w * 3) % 3].push({
        s: it.s,
        m: poseMatrix(it.pos, {
          yaw: it.v * TAU, normal: n, align: 0.8,
          scale: [sc * lerp(0.8, 1.5, it.v), sc * lerp(0.5, 1.0, it.w), sc * lerp(0.8, 1.4, it.u)],
        }, new THREE.Matrix4()),
      });
      if (sc > 1.1) this._blob(it, sc * 1.4, { opacity: 0.62 });
    }
    for (let i = 0; i < 3; i++) this._spread(`canyonRock${i}`, geos[i], mat, buckets[i], { per: 52, maxChunks: 7, cast: true, receive: true });
  }

  /**
   * A power line following the circuit.
   *
   * Deliberately the one evenly-spaced thing on the track: poles marching into
   * the haze at a constant interval is the classic desert-highway depth cue,
   * and it only works *because* everything organic around it is irregular.
   */
  _telegraphLine() {
    const L = this.track.length;
    const span = 38;
    const count = Math.round(L / span);
    const side = this.terrain.outwardSign(0);
    const d = 46;

    const poleGeo = mergeParts([
      { geo: columnGeometry(9.0, 0.20, 0.13, { segs: 2, sides: 6, curve: 1 }), color: 0x6b5642 },
      { geo: new THREE.BoxGeometry(2.9, 0.16, 0.16), color: 0x5d4a38, m: T([0, 8.3, 0]) },
      { geo: new THREE.BoxGeometry(2.1, 0.14, 0.14), color: 0x5d4a38, m: T([0, 7.6, 0]) },
    ]);
    darkenBase(poleGeo, { height: 1.0, amount: 0.4 });
    const poleMat = this._mat(propMaterial({ roughness: 0.95, flatShading: true }));

    const items = [];
    const tops = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const s = (i / count) * L;
      const lateral = side * (this.track.halfWidthAt(s) + WALL_OFFSET + d + Math.sin(i * 1.7) * 3);
      this.terrain.place(s, lateral, p);
      const f = this.track.frameAt(s, {});
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      items.push({ s, m: poseMatrix(p.clone(), { yaw, scale: lerp(0.94, 1.06, mod(i * 0.37, 1)) }, new THREE.Matrix4()) });
      tops.push(p.clone().setY(p.y + 8.3));
      this._blob({ s, lateral, pos: p.clone(), u: 0.3, v: 0.5 }, 1.6, { opacity: 0.6 });
    }
    this._spread('telegraphPole', poleGeo, poleMat, items, { per: 7, maxChunks: 7, cast: true });

    // Sagging wires between the poles, as line geometry — a catenary sells the
    // span far better than a straight bar and costs almost nothing.
    const pts = [];
    for (let i = 0; i < tops.length; i++) {
      const a = tops[i], b = tops[(i + 1) % tops.length];
      for (let k = 0; k < 6; k++) {
        const t0 = k / 6, t1 = (k + 1) / 6;
        for (const t of [t0, t1]) {
          const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
          const y = lerp(a.y, b.y, t) - Math.sin(t * Math.PI) * 1.5;
          pts.push(x, y, z);
        }
      }
    }
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    wireGeo.computeBoundingSphere();
    const wireMat = this._mat(new THREE.LineBasicMaterial({ color: 0x2a2118, transparent: true, opacity: 0.65 }), { env: false });
    const wires = new THREE.LineSegments(wireGeo, wireMat);
    wires.name = 'telegraphWire';
    wires.frustumCulled = false;
    this.group.add(wires);
  }

  /**
   * A natural rock arch spanning the road. Landmark, gateway and the only
   * thing on this circuit that puts geometry over the driver's head.
   */
  _rockArch(fractions) {
    const mat = this._mat(propMaterial({ roughness: 0.98, envMapIntensity: 0.35, flatShading: true }));
    for (const frac of fractions) {
      const s = mod(frac * this.track.length, this.track.length);
      const half = this.track.halfWidthAt(s);
      const legLat = half + WALL_OFFSET + 3.5;
      const baseY = Math.min(this.terrain.heightAt(s, legLat), this.terrain.heightAt(s, -legLat)) - 1.5;
      const f = this.track.frameAt(s, {});
      const clear = f.pos.y - baseY + 15.5;

      const pts = [];
      const segs = 16;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const a = Math.PI * t;
        pts.push({
          p: new THREE.Vector3(-Math.cos(a) * legLat, Math.sin(a) * clear * 0.98, Math.sin(a * 2) * 1.6),
          r: lerp(4.6, 2.4, Math.sin(a)) * lerp(0.85, 1.15, Math.sin(t * 9)),
        });
      }
      const archGeo = sweepStack(pts, 9, { capStart: true, capEnd: true, vScale: 0.08 });
      const parts = [{ geo: archGeo, color: 0xffffff }];
      const rng = makeRng(1500 + Math.round(s));
      for (const sx of [-1, 1]) {
        parts.push({
          geo: rockGeometry(rng, { detail: 1, rough: 0.34, squash: 0.8 }), color: 0xffffff,
          m: T([sx * legLat, 2.0, 0], [0, rng() * TAU, 0], [8.5, 7.5, 8.5]),
        });
      }
      const geo = mergeParts(parts);
      paintGeometry(geo, (v, col) => {
        const band = Math.sin(v.y * 0.42) * 0.5 + 0.5;
        const t = clamp01(v.y / 26);
        col.setRGB(lerp(0.44, 0.62, t) * lerp(0.84, 1.08, band), lerp(0.27, 0.40, t), lerp(0.20, 0.30, t));
      });
      const m = this._crossBasis(s, baseY);
      geo.applyMatrix4(m);
      geo.computeBoundingSphere();
      addMesh(this.group, geo, mat, { name: 'rockArch', cast: true, receive: true });
    }
  }

  // =========================================================================
  // Rainbow Skyway
  // =========================================================================

  _buildRainbow() {
    this._planets();
    this._skyDust();
    this._shards();
    this._pylons();
    this._skyRings([0.10, 0.44, 0.79]);
    this._skyPlatforms();
    this._skyBanners();
  }

  /** Gas giants and a ringed world: the far layer this track otherwise lacks. */
  _planets() {
    const rng = makeRng(6001);
    const c = this.terrain.centre;
    const defs = [
      { r: 210, dist: 1650, az: 0.7, el: 0.30, cols: ['#f0c27b', '#c98a4b', '#8e5a35', '#f6e3c5'], ring: true },
      { r: 130, dist: 2100, az: 2.9, el: 0.20, cols: ['#7fb0e8', '#4c73b8', '#a9d6f5', '#2f4c86'], ring: false },
      { r: 78, dist: 1250, az: 4.6, el: 0.42, cols: ['#e08a9a', '#a2455f', '#f3c3cc', '#6d2d44'], ring: false },
    ];
    const mats = [];
    for (const d of defs) {
      const tex = planetTexture(Math.floor(rng() * 90), d.cols);
      this._textures.push(tex);
      const mat = this._mat(new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.6, fog: false,
      }));
      mats.push(mat);
      const geo = new THREE.SphereGeometry(d.r, 30, 20);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        c.x + Math.cos(d.az) * d.dist,
        this.track.maxY + Math.sin(d.el) * d.dist * 0.55,
        c.z + Math.sin(d.az) * d.dist,
      );
      mesh.rotation.z = 0.24;
      mesh.name = 'planet';
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.animated.push((dt, time) => { mesh.rotation.y = time * 0.006; });

      if (d.ring) {
        const rg = new THREE.RingGeometry(d.r * 1.35, d.r * 2.15, 64, 1);
        const rmat = this._mat(new THREE.MeshBasicMaterial({
          color: 0xd8c2a0, transparent: true, opacity: 0.42, side: THREE.DoubleSide,
          depthWrite: false, toneMapped: false, fog: false,
        }), { env: false });
        const ring = new THREE.Mesh(rg, rmat);
        ring.position.copy(mesh.position);
        ring.rotation.set(-Math.PI * 0.5 + 0.34, 0, 0.24);
        ring.name = 'planetRing';
        this.group.add(ring);
      }
    }
  }

  /**
   * A near dust field of glowing motes.
   *
   * The sky's own starfield is infinitely far away and therefore does not move
   * relative to the track. These sit within a few hundred metres, so they
   * parallax past the camera and give the void a sense of speed.
   */
  _skyDust() {
    const n = this._n(1400);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const L = this.track.length;
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const s = this.rng() * L;
      const side = this.rng() < 0.5 ? -1 : 1;
      const d = lerp(14, 260, Math.pow(this.rng(), 0.75));
      this.track.placeOnRoad(s, side * (this.track.halfWidthAt(s) + d), p);
      p.y += (this.rng() - 0.5) * 150;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      c.setHSL(this.rng(), 0.55, lerp(0.55, 0.95, this.rng()));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    const mat = this._mat(new THREE.PointsMaterial({
      size: 2.4, sizeAttenuation: true, vertexColors: true, transparent: true,
      opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true,
    }), { env: false });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'skyDust';
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  /** Crystal shards drifting alongside the roadway. */
  _shards() {
    const geos = [0, 1].map((i) => {
      const g = new THREE.OctahedronGeometry(1, 0);
      g.scale(0.5 + i * 0.2, 1.6 + i * 0.5, 0.5 + i * 0.2);
      return paintGeometry(g, (v, col) => {
        const t = clamp01(v.y * 0.4 + 0.5);
        col.setRGB(lerp(0.30, 0.85, t), lerp(0.16, 0.55, t), lerp(0.70, 1.0, t));
      });
    });
    const mat = this._mat(applyDrift(
      propMaterial({ roughness: 0.18, metalness: 0.6, envMapIntensity: 1.6, emissive: 0x2a1060, emissiveIntensity: 0.9, flatShading: true }),
      { amp: 3.4, freq: 0.18 },
    ));
    const L = this.track.length;
    const buckets = [[], []];
    const p = new THREE.Vector3();
    for (let i = 0; i < this._n(180); i++) {
      const s = this.rng() * L;
      const side = this.rng() < 0.5 ? -1 : 1;
      const d = lerp(26, 150, Math.pow(this.rng(), 1.2));
      this.track.placeOnRoad(s, side * (this.track.halfWidthAt(s) + d), p);
      p.y += lerp(-46, 20, this.rng());
      const sc = lerp(1.0, 4.6, Math.pow(this.rng(), 2.6));
      buckets[i % 2].push({
        s, m: poseMatrix(p.clone(), {
          yaw: this.rng() * TAU, lean: this.rng() * 1.4, leanDir: this.rng() * TAU, scale: sc,
        }, new THREE.Matrix4()),
      });
    }
    for (let i = 0; i < 2; i++) this._spread(`shard${i}`, geos[i], mat, buckets[i], { per: 30, maxChunks: 6, inflate: 8 });
  }

  /** Neon pylons flanking the roadway, pulsing out of phase with each other. */
  _pylons() {
    const parts = [
      { geo: columnGeometry(16, 0.55, 0.22, { segs: 3, sides: 6, curve: 1 }), color: 0x2a1a5e, m: T([0, -16, 0]) },
      { geo: new THREE.OctahedronGeometry(1.5, 0), color: 0xff5fd0, m: T([0, 0.6, 0], [0, 0, 0], [1, 1.8, 1]) },
      { geo: new THREE.TorusGeometry(1.9, 0.16, 6, 16), color: 0x66e8ff, m: T([0, -1.6, 0], [Math.PI * 0.5, 0, 0]) },
      { geo: new THREE.TorusGeometry(2.4, 0.14, 6, 16), color: 0x9a7bff, m: T([0, -4.4, 0], [Math.PI * 0.5, 0, 0]) },
    ];
    const geo = mergeParts(parts);
    const mat = this._mat(applyPulse(neonMaterial({ side: THREE.DoubleSide }), { freq: 2.0, depth: 0.35 }), { env: false });

    const L = this.track.length;
    const field = loopField(this.rng, { cycles: 8, octaves: 2 });
    const items = [];
    const p = new THREE.Vector3();
    const step = 11;
    for (let s = 0; s < L; s += step) {
      if (field(s / L) < -0.15) continue;
      for (const side of [-1, 1]) {
        if (this.rng() < 0.25) continue;
        const d = lerp(2.2, 5.5, this.rng());
        this.track.placeOnRoad(s, side * (this.track.halfWidthAt(s) + d), p);
        p.y -= 1.2;
        items.push({
          s, m: poseMatrix(p.clone(), {
            yaw: this.rng() * TAU, lean: side * lerp(0.05, 0.16, this.rng()), leanDir: 0,
            scale: lerp(0.75, 1.35, this.rng()),
          }, new THREE.Matrix4()),
        });
      }
    }
    this._spread('neonPylon', geo, mat, items, { per: 22, maxChunks: 9, inflate: 2 });
  }

  /** Rings the road threads through: the Skyway's landmark and its verticality. */
  _skyRings(fractions) {
    const mat = this._mat(applyPulse(neonMaterial({ side: THREE.DoubleSide }), { freq: 1.3, depth: 0.28 }), { env: false });
    const items = [];
    for (const frac of fractions) {
      const s = mod(frac * this.track.length, this.track.length);
      const f = this.track.frameAt(s, {});
      const R = this.track.halfWidthAt(s) + 13;
      const parts = [];
      for (let k = 0; k < 3; k++) {
        const g = new THREE.TorusGeometry(R + k * 1.5, 0.55 - k * 0.13, 6, 40);
        paintGeometry(g, (v, col) => {
          const a = Math.atan2(v.y, v.x);
          col.setHSL(mod(a / TAU + k * 0.3, 1), 0.85, 0.62);
        });
        parts.push({ geo: g, m: T([0, 0, k * 1.1 - 1.1]) });
      }
      const geo = mergeParts(parts);
      geo.applyMatrix4(this._crossBasis(s, f.pos.y));
      geo.computeBoundingSphere();
      addMesh(this.group, geo, mat, { name: 'skyRing', receive: false });
      items.push(s);
    }
    return items;
  }

  /**
   * Floating spectator platforms. A grand prix with no audience reads as a
   * test track, and on a void circuit the audience has to bring its own floor.
   */
  _skyPlatforms() {
    const deckParts = [
      { geo: new THREE.CylinderGeometry(7.5, 6.2, 0.9, 12), color: 0x3a2a7a, m: T([0, -0.45, 0]) },
      { geo: new THREE.TorusGeometry(7.5, 0.22, 6, 24), color: 0x66e8ff, m: T([0, 0.05, 0], [Math.PI * 0.5, 0, 0]) },
      { geo: new THREE.ConeGeometry(4.4, 5.0, 10), color: 0x241757, m: T([0, -3.4, 0], [Math.PI, 0, 0]) },
    ];
    const geo = mergeParts(deckParts);
    const mat = this._mat(applyDrift(
      propMaterial({ roughness: 0.3, metalness: 0.5, envMapIntensity: 1.3, emissive: 0x1d1050, emissiveIntensity: 0.8, flatShading: true }),
      { amp: 1.5, freq: 0.22 },
    ));
    const L = this.track.length;
    const items = [];
    const p = new THREE.Vector3();
    const count = this._n(20);
    for (let i = 0; i < count; i++) {
      // Irregular arc positions with a minimum separation, so the platforms
      // arrive in twos and threes rather than as a necklace.
      const s = mod((i / count) * L + gauss(this.rng) * 14, L);
      const side = this.rng() < 0.5 ? -1 : 1;
      const d = lerp(16, 40, this.rng());
      this.track.placeOnRoad(s, side * (this.track.halfWidthAt(s) + d), p);
      p.y += lerp(-8, 5, this.rng());
      const m = poseMatrix(p.clone(), { yaw: this.rng() * TAU, scale: lerp(0.85, 1.35, this.rng()) }, new THREE.Matrix4());
      items.push({ s, m });

      const rng = makeRng(2300 + i);
      const q = new THREE.Vector3();
      const heads = 8 + Math.floor(rng() * 10);
      for (let k = 0; k < heads; k++) {
        const th = rng() * TAU, rr = rng() * 5.6;
        q.set(Math.cos(th) * rr, 0.1, Math.sin(th) * rr).applyMatrix4(m);
        this._person(s, q.clone(), {
          yaw: rng() * TAU, scale: lerp(1.6, 1.9, rng()),
          color: new THREE.Color().setHSL(rng(), 0.9, 0.66), armsUp: rng() < 0.45,
        });
      }
    }
    this._spread('skyPlatform', geo, mat, items, { per: 4, maxChunks: 6, inflate: 4 });
  }

  /** Neon pennants on the platforms' masts — the only wind on a void track. */
  _skyBanners() {
    const geo = mergeParts([
      { geo: columnGeometry(9, 0.10, 0.06, { segs: 1, sides: 4, curve: 1 }), color: 0x8fa0ff, m: T([0, -9, 0]) },
      { geo: pennantGeometry(3.0, 1.5, { segs: 7, taper: 0.3 }), color: 0xff62c8, m: T([0.05, 0, 0]) },
      { geo: pennantGeometry(2.2, 1.1, { segs: 6, taper: 0.3 }), color: 0x62e8ff, m: T([0.05, -2.0, 0]) },
    ]);
    const mat = this._mat(applyFlag(neonMaterial({ side: THREE.DoubleSide }), { amp: 0.5, freq: 2.4, span: 3.0 }), { env: false });
    const L = this.track.length;
    const items = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < this._n(34); i++) {
      const s = this.rng() * L;
      const side = this.rng() < 0.5 ? -1 : 1;
      const d = lerp(4, 14, this.rng());
      this.track.placeOnRoad(s, side * (this.track.halfWidthAt(s) + d), p);
      p.y += 9.5;
      items.push({ s, m: poseMatrix(p.clone(), { yaw: this.rng() * TAU, scale: lerp(0.8, 1.5, this.rng()) }, new THREE.Matrix4()) });
    }
    this._spread('skyBanner', geo, mat, items, { per: 8, maxChunks: 6, inflate: 3 });
  }

  // -- runtime --------------------------------------------------------------

  setEnvMap(envMap) {
    this.envMap = envMap;
    for (const m of this.materials) { m.envMap = envMap; m.needsUpdate = true; }
  }

  update(dt, time, cameraPos) {
    for (const c of this._clocks) c.value = time;
    for (const fn of this.animated) fn(dt, time, cameraPos);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine) o.geometry?.dispose();
    });
    for (const m of this._all) m.dispose();
    for (const t of this._textures) t.dispose();
    this.scene.remove(this.group);
  }
}

/**
 * Spectator clothing.
 *
 * A crowd photographed from across a circuit is mostly *dark* — jackets,
 * denim, shadow between bodies — with a scatter of bright caps and shirts.
 * A uniform sample of bright saturated hues, which is the obvious thing to
 * write, produces confetti: every figure the same value, no depth, no mass.
 * Weighting hard toward low lightness is what turns it back into people.
 */
function crowdColor(rng) {
  const r = rng();
  // sRGB, not the linear working space: setHSL defaults to linear, where
  // L = 0.5 is already a bright colour and every "dark" jacket comes out
  // mid-grey. Authoring in the space the values were reasoned in is the
  // difference between a crowd and a bowl of sweets.
  const S = THREE.SRGBColorSpace;
  if (r < 0.46) {
    // Dark, near-neutral: the body of the crowd.
    return new THREE.Color().setHSL(lerp(0.55, 0.10, rng()), lerp(0.04, 0.22, rng()), lerp(0.10, 0.24, rng()), S);
  }
  if (r < 0.82) {
    // Mid tones, muted.
    return new THREE.Color().setHSL(rng(), lerp(0.12, 0.36, rng()), lerp(0.28, 0.48, rng()), S);
  }
  // The minority that actually carries colour.
  return new THREE.Color().setHSL(rng(), lerp(0.36, 0.62, rng()), lerp(0.40, 0.56, rng()), S);
}

