import * as THREE from 'three';
import { roundedBox, lathe, tyreGeometry, capsule, mergeGeometries, xform } from '../render/GeoUtils.js';
import { clamp, clamp01, damp, lerp, smoothstep, TAU } from '../core/MathX.js';

/**
 * Procedural kart + driver.
 *
 * Geometry is shared across every instance (built once, cached by shape) while
 * materials are per-character so twelve karts on track cost twelve small
 * material sets rather than twelve full mesh builds.
 *
 * Parts that share a material *and* a moving parent are merged into a single
 * buffer at build time. Nothing about the model changes on screen; what
 * changes is that a kart is ~31 draw calls instead of 61, and with a full grid
 * on track the karts were 93% of everything the renderer submitted.
 */

const WHEEL_R = 0.36;
const WHEEL_W = 0.30;
const FRONT_WHEEL_R = 0.30;

let _cache = null;

function buildSharedGeometry() {
  if (_cache) return _cache;

  // --- Chassis --------------------------------------------------------
  const tub = roundedBox(1.22, 0.34, 1.82, 0.15, 5);
  tub.translate(0, 0.05, -0.05);

  const nose = roundedBox(0.92, 0.26, 0.86, 0.12, 4);
  nose.translate(0, 0.02, 0.98);
  // Taper the nose to a wedge for a bit of aggression.
  {
    const p = nose.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      const k = clamp01((z - 0.6) / 0.85);
      p.setX(i, p.getX(i) * lerp(1, 0.66, k));
      p.setY(i, p.getY(i) * lerp(1, 0.72, k) - k * 0.03);
    }
    nose.computeVertexNormals();
  }

  const sidePod = roundedBox(0.30, 0.30, 1.30, 0.13, 4);

  const bumperFront = roundedBox(1.30, 0.22, 0.22, 0.10, 4);
  bumperFront.translate(0, 0.02, 1.40);

  const bumperRear = roundedBox(1.34, 0.26, 0.24, 0.11, 4);
  bumperRear.translate(0, 0.06, -1.05);

  // --- Engine block & exhausts ---------------------------------------
  const engine = roundedBox(0.86, 0.44, 0.62, 0.14, 4);
  engine.translate(0, 0.36, -0.80);

  const exhaustPipe = lathe([
    [0.055, 0], [0.055, 0.34], [0.075, 0.36], [0.075, 0.40], [0.0, 0.40],
  ], 14);
  exhaustPipe.rotateX(Math.PI / 2 - 0.22);

  // --- Seat ------------------------------------------------------------
  const seatBase = roundedBox(0.60, 0.14, 0.56, 0.07, 3);
  seatBase.translate(0, 0.26, -0.10);
  const seatBack = roundedBox(0.60, 0.62, 0.16, 0.07, 3);
  seatBack.translate(0, 0.55, -0.38);

  // --- Rear wing -------------------------------------------------------
  const wingPlane = roundedBox(1.24, 0.05, 0.30, 0.024, 3);
  wingPlane.translate(0, 0.86, -1.06);
  const wingStrutL = roundedBox(0.06, 0.34, 0.10, 0.025, 2);
  wingStrutL.translate(-0.44, 0.68, -1.04);
  const wingStrutR = wingStrutL.clone();
  wingStrutR.translate(0.88, 0, 0);

  // --- Steering column -------------------------------------------------
  const wheelRim = new THREE.TorusGeometry(0.15, 0.028, 10, 22);
  const wheelSpoke = roundedBox(0.24, 0.022, 0.035, 0.011, 2);
  const column = new THREE.CylinderGeometry(0.028, 0.028, 0.34, 10);
  column.rotateX(Math.PI / 2 - 0.65);

  // --- Wheels ----------------------------------------------------------
  const tyreRear = tyreGeometry(WHEEL_R, WHEEL_R * 0.56, WHEEL_W, 30);
  const tyreFront = tyreGeometry(FRONT_WHEEL_R, FRONT_WHEEL_R * 0.56, WHEEL_W * 0.86, 26);

  const makeRim = (r, w) => {
    const g = lathe([
      [r * 0.20, -w * 0.42], [r * 0.56, -w * 0.46], [r * 0.58, -w * 0.30],
      [r * 0.58, w * 0.30], [r * 0.56, w * 0.46], [r * 0.20, w * 0.42],
    ], 24);
    g.rotateZ(Math.PI / 2);
    return g;
  };
  const rimRear = makeRim(WHEEL_R, WHEEL_W);
  const rimFront = makeRim(FRONT_WHEEL_R, WHEEL_W * 0.86);

  const spoke = roundedBox(0.055, 0.04, 0.19, 0.018, 2);
  const hub = new THREE.CylinderGeometry(0.075, 0.075, WHEEL_W * 0.9, 14);
  hub.rotateZ(Math.PI / 2);

  // --- Driver ----------------------------------------------------------
  const torso = capsule(0.20, 0.30, 16, 8);
  const head = new THREE.SphereGeometry(0.165, 24, 18);
  const helmet = new THREE.SphereGeometry(0.185, 26, 20, 0, TAU, 0, Math.PI * 0.62);
  const visor = new THREE.SphereGeometry(0.176, 24, 16, -0.9, 1.8, Math.PI * 0.30, Math.PI * 0.26);
  const arm = capsule(0.058, 0.26, 10, 5);
  const glove = new THREE.SphereGeometry(0.072, 12, 10);
  const legG = capsule(0.075, 0.20, 10, 5);

  // --- Merge siblings that share a material and a parent -----------------
  // Each entry is one draw call at render time. Anything that has to move on
  // its own — a wheel, the steering rack, the driver's head — stays out of
  // these lists and keeps its own transform.

  const wheelParts = (r, tyre, rim) => {
    const spokes = [];
    for (let i = 0; i < 5; i++) {
      spokes.push({ geo: spoke, matrix: xform([0, 0, 0], [(i / 5) * TAU, 0, 0], Array(3).fill(r / WHEEL_R)) });
    }
    return mergeBySlot([
      { slot: 'rubber', geo: tyre },
      { slot: 'chrome', geo: rim },
      { slot: 'darkMetal', geo: hub },
      ...spokes.map((s) => ({ slot: 'accent', ...s })),
    ]);
  };

  _cache = {
    // Parts kept separate because each one is the only user of its material
    // in its assembly — merging them would not remove a draw call.
    visor, head, helmet, arm, glove,

    chassis: mergeBySlot([
      { slot: 'body', geo: tub },
      { slot: 'body', geo: nose },
      { slot: 'body', geo: sidePod, matrix: xform([-0.72, 0.10, -0.05]) },
      { slot: 'body', geo: sidePod, matrix: xform([0.72, 0.10, -0.05]) },
      { slot: 'accent', geo: bumperFront },
      { slot: 'accent', geo: bumperRear },
      { slot: 'accent', geo: wingPlane },
      { slot: 'darkMetal', geo: engine },
      { slot: 'darkMetal', geo: wingStrutL },
      { slot: 'darkMetal', geo: wingStrutR },
      { slot: 'darkMetal', geo: column, matrix: xform([0, 0.48, 0.30]) },
      { slot: 'suit', geo: seatBase },
      { slot: 'suit', geo: seatBack },
      { slot: 'chrome', geo: exhaustPipe, matrix: xform([-0.26, 0.34, -1.10]) },
      { slot: 'chrome', geo: exhaustPipe, matrix: xform([0.26, 0.34, -1.10]) },
    ]),

    steeringRack: mergeBySlot([
      { slot: 'darkMetal', geo: wheelRim },
      { slot: 'chrome', geo: wheelSpoke, matrix: xform([0, 0, 0], [0, 0, 0]) },
      { slot: 'chrome', geo: wheelSpoke, matrix: xform([0, 0, 0], [0, 0, TAU / 3]) },
      { slot: 'chrome', geo: wheelSpoke, matrix: xform([0, 0, 0], [0, 0, (TAU * 2) / 3]) },
    ]),

    wheelFront: wheelParts(FRONT_WHEEL_R, tyreFront, rimFront),
    wheelRear: wheelParts(WHEEL_R, tyreRear, rimRear),

    driverBody: mergeBySlot([
      { slot: 'suit', geo: torso, matrix: xform([0, 0.30, 0], [-0.20, 0, 0]) },
      { slot: 'suit', geo: legG, matrix: xform([-0.12, 0.13, 0.30], [1.35, 0, 0]) },
      { slot: 'suit', geo: legG, matrix: xform([0.12, 0.13, 0.30], [1.35, 0, 0]) },
    ]),
  };
  return _cache;
}

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

function makeMaterials(character, envMap) {
  const body = new THREE.MeshPhysicalMaterial({
    color: character.color,
    metalness: 0.28,
    roughness: 0.26,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
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
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x14161a, metalness: 0.0, roughness: 0.85, envMapIntensity: 0.5,
  });
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xd8dde4, metalness: 1.0, roughness: 0.16, envMapIntensity: 1.6,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x30343c, metalness: 0.85, roughness: 0.42, envMapIntensity: 1.0,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x111820, metalness: 0.1, roughness: 0.06,
    transmission: 0.55, thickness: 0.3, ior: 1.45,
    envMapIntensity: 1.6, transparent: true, opacity: 0.92,
  });
  const suit = new THREE.MeshStandardMaterial({
    color: new THREE.Color(character.color).lerp(new THREE.Color(0x101018), 0.45),
    metalness: 0.05, roughness: 0.62, envMapIntensity: 0.8,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: 0xe8b48c, metalness: 0.0, roughness: 0.55, envMapIntensity: 0.7,
  });
  const glow = new THREE.MeshBasicMaterial({ color: character.accent });

  const all = [body, accent, rubber, chrome, darkMetal, glass, suit, skin];
  if (envMap) for (const m of all) { m.envMap = envMap; m.needsUpdate = true; }
  return { body, accent, rubber, chrome, darkMetal, glass, suit, skin, glow, all };
}

export class KartModel {
  constructor(character, opts = {}) {
    this.character = character;
    this.g = buildSharedGeometry();
    this.mats = makeMaterials(character, opts.envMap);
    this.group = new THREE.Group();
    this.group.name = `kart_${character.id}`;

    // `body` carries all lean/squash animation; `root` carries world placement
    // so physics never fights the presentation transforms.
    this.body = new THREE.Group();
    this.group.add(this.body);

    const M = this.mats;
    const add = (geo, mat, parent = this.body) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const G = this.g;

    /** Instantiate a pre-merged assembly: one mesh per material slot. */
    const addMerged = (parts, parent = this.body, cast = true) => {
      for (const [slot, geo] of parts) {
        const mesh = new THREE.Mesh(geo, M[slot]);
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
    };

    addMerged(G.chassis);

    // Steering wheel assembly.
    this.steering = new THREE.Group();
    this.steering.position.set(0, 0.60, 0.42);
    this.steering.rotation.x = -0.65;
    this.body.add(this.steering);
    addMerged(G.steeringRack, this.steering);

    // --- Wheels ---------------------------------------------------------
    // Order: FL, FR, RL, RR — matches `kart.suspension`.
    this.wheels = [];
    const wheelDefs = [
      { pos: [-0.76, FRONT_WHEEL_R, 0.86], front: true },
      { pos: [0.76, FRONT_WHEEL_R, 0.86], front: true },
      { pos: [-0.80, WHEEL_R, -0.78], front: false },
      { pos: [0.80, WHEEL_R, -0.78], front: false },
    ];
    for (const def of wheelDefs) {
      const pivot = new THREE.Group();          // steering
      pivot.position.set(...def.pos);
      const spin = new THREE.Group();           // rolling
      pivot.add(spin);
      this.body.add(pivot);

      const r = def.front ? FRONT_WHEEL_R : WHEEL_R;
      for (const [slot, geo] of def.front ? G.wheelFront : G.wheelRear) {
        const mesh = new THREE.Mesh(geo, M[slot]);
        // Only the tyre casts: the rim and spokes sit inside its silhouette,
        // so shadowing them again buys nothing but shadow-pass draw calls.
        mesh.castShadow = slot === 'rubber';
        spin.add(mesh);
      }
      this.wheels.push({ pivot, spin, front: def.front, base: pivot.position.clone(), radius: r });
    }

    // --- Driver ---------------------------------------------------------
    this.driver = new THREE.Group();
    this.driver.position.set(0, 0.44, -0.06);
    this.body.add(this.driver);

    addMerged(G.driverBody, this.driver);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.60, 0.02);
    this.driver.add(this.headGroup);
    add(G.head, M.skin, this.headGroup);
    const hel = add(G.helmet, M.accent, this.headGroup);
    hel.position.y = 0.015;
    const vis = new THREE.Mesh(G.visor, M.glass);
    vis.position.set(0, 0.015, 0.0);
    this.headGroup.add(vis);

    this.arms = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.19, 0.44, 0.02);
      this.driver.add(shoulder);
      const a = add(G.arm, M.suit, shoulder);
      a.position.set(0, -0.10, 0.14);
      a.rotation.set(1.15, 0, -s * 0.18);
      const gl = add(G.glove, M.accent, shoulder);
      gl.position.set(s * 0.02, -0.16, 0.30);
      this.arms.push(shoulder);
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
    this.anchors.exhaustL.position.set(-0.26, 0.42, -1.30);
    this.anchors.exhaustR.position.set(0.26, 0.42, -1.30);
    this.anchors.driftL.position.set(-0.80, 0.10, -0.78);
    this.anchors.driftR.position.set(0.80, 0.10, -0.78);
    this.anchors.item.position.set(0, 0.30, -1.35);
    this.anchors.nose.position.set(0, 0.20, 1.45);
    this.anchors.center.position.set(0, 0.45, 0);
    for (const k in this.anchors) this.body.add(this.anchors[k]);

    // Shadow-catching blob for cheap contact darkening under the kart.
    this.group.matrixAutoUpdate = true;

    this._leanZ = 0;
    this._pitch = 0;
    this._trickRot = 0;
    this._bob = Math.random() * TAU;
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
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.spin.rotation.x = -kart.wheelSpin * (WHEEL_R / w.radius);
      if (w.front) w.pivot.rotation.y = kart.wheelSteer * 0.52;
      // Suspension travel + a hint of static rake.
      const compress = kart.suspension[i] * 0.13;
      w.pivot.position.y = w.base.y - compress;
    }

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
    this.body.position.y = idleBob;

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

    // Driver ------------------------------------------------------------
    // The head leads the corner, and the arms counter-rotate with the wheel.
    this.headGroup.rotation.y = damp(this.headGroup.rotation.y, kart.wheelSteer * 0.42, 8, dt);
    this.headGroup.rotation.z = -this._leanZ * 0.5;
    this.steering.rotation.z = -kart.wheelSteer * 1.25;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      this.arms[i].rotation.z = -kart.wheelSteer * 0.36 * s;
      this.arms[i].rotation.x = kart.wheelSteer * 0.16;
    }

    // Star power: the whole kart flashes through the rainbow.
    if (kart.star > 0) {
      const hue = (performance.now() * 0.0012) % 1;
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
      g.traverse((o) => { if (o.isMesh && o.material.opacity !== undefined) {
        o.material.transparent = blink < 1 || o.material === this.mats.glass;
        if (o.material !== this.mats.glass) o.material.opacity = blink;
      } });
    }
  }

  dispose() {
    for (const m of this.mats.all) m.dispose();
  }
}

const _ONE = new THREE.Vector3(1, 1, 1);
