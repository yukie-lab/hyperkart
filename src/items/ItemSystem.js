import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, makeRng, mod, ringDelta, sign, smoothstep, TAU, wrapAngle } from '../core/MathX.js';

/**
 * Items: boxes, the roulette, held items, projectiles and hazards.
 *
 * Shells travel in track space (arc position + lateral offset) rather than
 * free 3D. That is what makes them reliably follow a banked, climbing circuit
 * and hug the road through a hairpin — a free rigid body would need constant
 * corrective forces and would still cut corners.
 */

export const ITEMS = {
  banana:         { name: 'Banana',        weight: 1, uses: 1 },
  tripleBanana:   { name: 'Triple Banana', weight: 1, uses: 3 },
  greenShell:     { name: 'Green Shell',   weight: 1, uses: 1 },
  tripleGreen:    { name: 'Triple Green',  weight: 1, uses: 3 },
  redShell:       { name: 'Red Shell',     weight: 1, uses: 1 },
  tripleRed:      { name: 'Triple Red',    weight: 1, uses: 3 },
  mushroom:       { name: 'Mushroom',      weight: 1, uses: 1 },
  tripleMushroom: { name: 'Triple Mushroom', weight: 1, uses: 3 },
  star:           { name: 'Star',          weight: 1, uses: 1 },
  thunder:        { name: 'Thunder',       weight: 1, uses: 1 },
  bulletBill:     { name: 'Bullet Bill',   weight: 1, uses: 1 },
};

/**
 * Roulette odds by race position, as rows of [item, weight].
 * Front runners get defensive scraps; the back of the field gets the tools to
 * catch up. This table is the single biggest lever on how a race feels.
 */
const ODDS = [
  // 1st
  [['banana', 40], ['greenShell', 30], ['tripleBanana', 15], ['mushroom', 15]],
  // 2nd-3rd
  [['banana', 26], ['greenShell', 26], ['redShell', 18], ['mushroom', 22], ['tripleGreen', 8]],
  // 4th-6th
  [['redShell', 24], ['mushroom', 24], ['greenShell', 14], ['tripleMushroom', 16], ['banana', 10], ['star', 12]],
  // 7th-9th
  [['tripleMushroom', 24], ['star', 22], ['redShell', 18], ['thunder', 10], ['tripleRed', 14], ['mushroom', 12]],
  // 10th+
  [['star', 24], ['bulletBill', 22], ['thunder', 20], ['tripleMushroom', 18], ['tripleRed', 16]],
];

/** How long a collected box keeps drawing while it blows apart. */
const POP_TIME = 0.30;

function oddsRow(rank, fieldSize) {
  const r = rank / Math.max(fieldSize, 2);
  if (rank === 1) return ODDS[0];
  if (r <= 0.3) return ODDS[1];
  if (r <= 0.55) return ODDS[2];
  if (r <= 0.8) return ODDS[3];
  return ODDS[4];
}

export class ItemSystem {
  constructor(track, scene, opts = {}) {
    this.track = track;
    this.scene = scene;
    this.rng = makeRng(opts.seed ?? 20250802);
    this.group = new THREE.Group();
    this.group.name = 'items';
    scene.add(this.group);

    this.projectiles = [];
    this.hazards = [];
    this.boxes = [];
    this.events = [];       // drained by the audio/FX layer each frame

    this._buildBoxes();
    this._buildPools();
    this._tmp = new THREE.Vector3();
  }

  // -- construction ---------------------------------------------------------

  _buildBoxes() {
    const geo = new THREE.BoxGeometry(1.5, 1.5, 1.5, 2, 2, 2);
    // Round the cube slightly for a moulded look.
    const p = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const l = v.length();
      v.lerp(v.clone().setLength(1.02), 0.16);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();

    // Alpha-blended glass rather than `transmission`. Real transmission makes
    // three re-render the whole opaque scene into a refraction buffer, so a
    // single box in frame roughly doubled the scene's triangle count — for a
    // prop that reads as a flat white cube at race distance anyway. Low opacity
    // plus a hot core inside sells "container with something in it" far better,
    // and costs one ordinary transparent draw.
    this.boxMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xbfe6ff,
      roughness: 0.06,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      iridescence: 1.0,
      iridescenceIOR: 1.7,
      iridescenceThicknessRange: [120, 520],
      transparent: true,
      opacity: 0.34,
      emissive: 0x1b3d5c,
      emissiveIntensity: 0.5,
      envMapIntensity: 2.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // The core carries the read: unlit, un-tonemapped and bright enough to
    // bloom a little, so a box is a point of light on the road from far away.
    this.boxCoreMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd23c, toneMapped: false, transparent: true, opacity: 0.95,
    });
    const coreGeo = new THREE.OctahedronGeometry(0.34, 0);

    for (const def of this.track.itemBoxes) {
      const pos = this.track.placeOnRoad(def.s, def.lateral, new THREE.Vector3());
      pos.y += 1.25;
      const holder = new THREE.Group();
      holder.position.copy(pos);
      const shell = new THREE.Mesh(geo, this.boxMaterial);
      shell.castShadow = false;
      holder.add(shell);
      const core = new THREE.Mesh(coreGeo, this.boxCoreMaterial);
      holder.add(core);
      this.group.add(holder);
      this.boxes.push({
        s: def.s, lateral: def.lateral, pos, mesh: holder, core, shell,
        active: true, respawn: 0, phase: this.rng() * TAU, pop: 0,
      });
    }
  }

  /**
   * The effects layer, if it exists yet.
   *
   * Items are built before the FX pools are, so this is resolved lazily rather
   * than injected. Going through the scene keeps the item code free of a
   * constructor argument that would only ever have one possible value.
   */
  get fx() { return this.scene.userData.kartFX || null; }

  _buildPools() {
    // Shared geometry for projectiles/hazards, instantiated on demand.
    this.geoShell = new THREE.SphereGeometry(0.46, 22, 16);
    this.geoBanana = new THREE.SphereGeometry(0.42, 16, 12);
    this.geoBanana.scale(1.0, 0.55, 1.5);

    this.matGreen = new THREE.MeshPhysicalMaterial({
      color: 0x2fbf4a, roughness: 0.22, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08,
      emissive: 0x0d3d18, emissiveIntensity: 0.5, envMapIntensity: 1.3,
    });
    this.matRed = new THREE.MeshPhysicalMaterial({
      color: 0xe8342c, roughness: 0.22, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08,
      emissive: 0x4a0d0a, emissiveIntensity: 0.6, envMapIntensity: 1.3,
    });
    this.matBanana = new THREE.MeshPhysicalMaterial({
      color: 0xf5d02a, roughness: 0.35, metalness: 0.0, clearcoat: 0.7, envMapIntensity: 1.1,
    });
  }

  setEnvMap(env) {
    for (const m of [this.boxMaterial, this.matGreen, this.matRed, this.matBanana]) {
      m.envMap = env; m.needsUpdate = true;
    }
  }

  // -- roulette -------------------------------------------------------------

  roll(kart, fieldSize) {
    const row = oddsRow(kart.rank, fieldSize);
    let total = 0;
    for (const [, w] of row) total += w;
    let r = this.rng() * total;
    for (const [id, w] of row) {
      r -= w;
      if (r <= 0) return id;
    }
    return row[0][0];
  }

  /** Begin the spinning-item animation; resolves after a short delay. */
  startRoulette(kart, fieldSize) {
    if (kart.item || kart.itemRoulette) return;
    const result = this.roll(kart, fieldSize);
    kart.itemRoulette = { t: 0, duration: kart.isPlayer ? 0.95 : 0.25, result, display: result };
    this.events.push({ type: 'itemBox', kart });
  }

  _updateRoulette(dt, kart) {
    const r = kart.itemRoulette;
    if (!r) return;
    r.t += dt;
    // Cycle the visible icon quickly, then settle on the real result.
    if (r.t < r.duration) {
      const keys = Object.keys(ITEMS);
      r.display = keys[Math.floor(r.t * 22) % keys.length];
    } else {
      kart.item = r.result;
      kart.itemUses = ITEMS[r.result].uses;
      kart.itemRoulette = null;
      this.events.push({ type: 'itemGet', kart, item: r.result });
    }
  }

  // -- use ------------------------------------------------------------------

  use(kart, ctx) {
    if (!kart.item) return;
    const id = kart.item;
    const consume = () => {
      kart.itemUses = (kart.itemUses ?? 1) - 1;
      if (kart.itemUses <= 0) { kart.item = null; kart.itemUses = 0; }
    };

    switch (id) {
      case 'mushroom':
      case 'tripleMushroom':
        kart.applyBoost('mushroom');
        this.events.push({ type: 'useMushroom', kart });
        consume();
        break;

      case 'banana':
      case 'tripleBanana':
        this._dropBanana(kart);
        consume();
        break;

      case 'greenShell':
      case 'tripleGreen':
        this._fireShell(kart, 'green', ctx);
        consume();
        break;

      case 'redShell':
      case 'tripleRed':
        this._fireShell(kart, 'red', ctx);
        consume();
        break;

      case 'star':
        kart.star = 7.0;
        kart.applyBoost('star');
        this.events.push({ type: 'useStar', kart });
        consume();
        break;

      case 'thunder':
        for (const other of ctx.karts) {
          if (other === kart) continue;
          other.flatten(2.4);
        }
        this.events.push({ type: 'useThunder', kart });
        consume();
        break;

      case 'bulletBill':
        kart.applyBoost('bullet');
        kart.star = 6.0;
        kart.bulletBill = 6.0;
        this.events.push({ type: 'useBullet', kart });
        consume();
        break;
    }
  }

  _dropBanana(kart) {
    const s = mod(kart.s - 3.2, this.track.length);
    const lateral = kart.lateral;
    const mesh = new THREE.Mesh(this.geoBanana, this.matBanana);
    mesh.castShadow = true;
    this.track.placeOnRoad(s, lateral, mesh.position);
    mesh.position.y += 0.30;
    mesh.rotation.y = this.rng() * TAU;
    this.group.add(mesh);
    this.hazards.push({ type: 'banana', s, lateral, mesh, owner: kart, life: 45, armed: 0.4 });
    this.events.push({ type: 'useBanana', kart });
  }

  _fireShell(kart, kind, ctx) {
    const s = mod(kart.s + 2.6, this.track.length);
    const mesh = new THREE.Mesh(this.geoShell, kind === 'red' ? this.matRed : this.matGreen);
    mesh.castShadow = true;
    this.track.placeOnRoad(s, kart.lateral, mesh.position);
    mesh.position.y += 0.46;
    this.group.add(mesh);

    let target = null;
    if (kind === 'red') {
      // Home on whoever is immediately ahead on track.
      let bestDs = Infinity;
      for (const o of ctx.karts) {
        if (o === kart) continue;
        const ds = ringDelta(kart.s, o.s, this.track.length);
        if (ds > 1 && ds < bestDs) { bestDs = ds; target = o; }
      }
    }

    this.projectiles.push({
      type: kind === 'red' ? 'redShell' : 'greenShell',
      s, lateral: kart.lateral, mesh, owner: kart,
      speed: kind === 'red' ? 38 : 34,
      life: kind === 'red' ? 14 : 9,
      bounces: kind === 'red' ? 0 : 4,
      dir: 1, target, armed: 0.12, spin: 0,
    });
    this.events.push({ type: kind === 'red' ? 'useRedShell' : 'useGreenShell', kart });
  }

  // -- simulation -----------------------------------------------------------

  update(dt, ctx) {
    const karts = ctx.karts;

    for (const k of karts) this._updateRoulette(dt, k);

    this._updateBoxes(dt, ctx, karts);
    this._updateProjectiles(dt, karts);
    this._updateHazards(dt, karts);

    for (const k of karts) {
      if (k.bulletBill > 0) {
        k.bulletBill -= dt;
        this._driveBulletBill(dt, k);
      }
    }
  }

  _updateBoxes(dt, ctx, karts) {
    const eye = karts.find((k) => k.isPlayer)?.pos ?? karts[0]?.pos ?? null;
    for (const b of this.boxes) {
      b.phase += dt;

      if (!b.active) {
        b.respawn -= dt;
        // Collection pop: the box keeps drawing for a beat while it blows
        // outward, so a pickup is an event rather than a box that vanished.
        if (b.pop > 0) {
          b.pop = Math.max(0, b.pop - dt);
          const k = 1 - b.pop / POP_TIME;
          b.mesh.rotation.y += dt * 9;
          b.mesh.scale.setScalar(lerp(1, 1.9, smoothstep(clamp01(k))) * (1 - k * k));
          b.core.scale.setScalar(Math.max(0.001, 1 - k * 1.6));
          if (b.pop <= 0) b.mesh.visible = false;
        }
        if (b.respawn <= 0) {
          b.active = true;
          b.mesh.visible = true;
          b.core.scale.setScalar(1);
        }
        continue;
      }

      // Respawn: snap back in with a short elastic overshoot rather than
      // materialising at full size on a single frame.
      const inT = clamp01((ctx.time - (b.bornAt ?? -99)) / 0.38);

      b.mesh.rotation.y = b.phase * 1.4;
      b.mesh.rotation.x = Math.sin(b.phase * 0.8) * 0.22;
      b.core.rotation.y = -b.phase * 3.0;
      b.core.rotation.z = b.phase * 1.7;
      b.mesh.position.y = b.pos.y + Math.sin(b.phase * 2.1) * 0.10;
      // A slow breathe on the shell and a faster counter-beat on the core:
      // two rates make it read as a container with something alive inside.
      const breathe = 1 + Math.sin(b.phase * 2.1) * 0.045;
      const pop = inT < 1 ? lerp(0.2, 1, smoothstep(inT)) * (1 + Math.sin(inT * Math.PI) * 0.22) : 1;
      b.mesh.scale.setScalar(breathe * pop);
      b.core.scale.setScalar((1 + Math.sin(b.phase * 5.3) * 0.14) * pop);

      // A sparkle every third of a second, but only for boxes the player can
      // actually see. A circuit carries dozens of boxes, and emitting for all
      // of them fills the whole particle pool with confetti nobody is looking
      // at — and starves the kart of its own sparks.
      if (eye && b.mesh.position.distanceToSquared(eye) < 3600) {
        b.spark = (b.spark || this.rng() * 0.5) + dt;
        if (b.spark > 0.34) {
          b.spark = 0;
          this.fx?.trail(b.mesh.position, 0xffe27a, { size: 0.26, alpha: 0.30, life: 0.42, glow: 0.5 });
        }
      }

      for (const k of karts) {
        if (k.item || k.itemRoulette) continue;
        if (k.pos.distanceToSquared(b.mesh.position) < 3.2 * 3.2) {
          b.active = false;
          b.respawn = 3.0;
          b.pop = POP_TIME;
          b.bornAt = ctx.time + 3.0;
          this.fx?.burst(b.mesh.position, 0xffdd55, {
            count: 26, speed: 9, size: 0.55, life: 0.5, alpha: 0.85, ring: 1.4,
          });
          this.startRoulette(k, karts.length);
          break;
        }
      }
    }
  }

  _updateProjectiles(dt, karts) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.armed = Math.max(0, p.armed - dt);
      p.spin += dt * 11;

      if (p.type === 'redShell' && p.target && !p.target.finished) {
        // Close the arc gap, then converge laterally onto the target.
        const ds = ringDelta(p.s, p.target.s, this.track.length);
        const closing = clamp(ds / 26, 0, 1);
        p.lateral = damp(p.lateral, p.target.lateral, lerp(5.5, 2.0, closing), dt);
        p.speed = lerp(46, 38, closing);
      } else if (p.type === 'greenShell') {
        // Bounce off the barriers instead of stopping at them.
        const half = this.track.halfWidthAt(p.s) + 5.0;
        if (Math.abs(p.lateral) > half) {
          p.lateral = sign(p.lateral) * half;
          p.dir = -p.dir;
          p.lateralVel = -(p.lateralVel || 0);
          p.bounces--;
          this.events.push({ type: 'shellBounce', pos: p.mesh.position.clone() });
          this.fx?.burst(p.mesh.position, 0x9bffc0, {
            count: 12, speed: 8, size: 0.38, life: 0.3, alpha: 0.8, ring: 0.8, gravity: 9,
          });
          if (p.bounces < 0) { this._removeProjectile(i); continue; }
        }
        p.lateral += (p.lateralVel || 0) * dt;
      }

      p.s = mod(p.s + p.speed * dt, this.track.length);
      this.track.placeOnRoad(p.s, p.lateral, p.mesh.position);
      p.mesh.position.y += 0.46;
      p.mesh.rotation.y = p.spin;
      p.mesh.rotation.x = p.spin * 0.6;

      // Wake. A shell moving at 38 m/s with nothing behind it reads as a
      // sliding prop; the trail is what makes it read as thrown.
      p.wake = (p.wake || 0) + dt;
      const step = p.type === 'redShell' ? 0.028 : 0.040;
      while (p.wake > step) {
        p.wake -= step;
        this.fx?.trail(p.mesh.position, p.type === 'redShell' ? 0xff5a3c : 0x4bff6a, {
          size: 0.30, alpha: p.type === 'redShell' ? 0.26 : 0.20, life: 0.26, glow: 0.62,
        });
      }

      if (p.life <= 0) {
        this.fx?.burst(p.mesh.position, p.type === 'redShell' ? 0xff5a3c : 0x4bff6a, {
          count: 14, speed: 6, size: 0.42, life: 0.35, alpha: 0.7, ring: 0.9,
        });
        this._removeProjectile(i);
        continue;
      }

      // Hits
      let hit = false;
      for (const k of karts) {
        if (k === p.owner && p.armed > 0) continue;
        if (k.pos.distanceToSquared(p.mesh.position) > 2.4 * 2.4) continue;
        if (k.star > 0 || k.invuln > 0) { continue; }
        if (k.spinout(p.type === 'redShell' ? 1.35 : 1.15, p.type)) {
          this.events.push({ type: 'hit', kart: k, by: p.type, pos: k.pos.clone() });
          hit = true;
          break;
        }
      }
      if (hit) this._removeProjectile(i);
    }
  }

  _removeProjectile(i) {
    const p = this.projectiles[i];
    this.group.remove(p.mesh);
    this.projectiles.splice(i, 1);
  }

  _updateHazards(dt, karts) {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      h.armed = Math.max(0, h.armed - dt);
      // Bananas settle with a small bob so a dropped one is easy to spot
      // against a busy road, and telegraph themselves before they expire.
      h.mesh.rotation.y += dt * 0.6;
      h.mesh.position.y = (h.baseY ?? (h.baseY = h.mesh.position.y))
        + Math.sin(h.life * 3.4) * 0.05;
      if (h.life < 1.2) h.mesh.scale.setScalar(1 + Math.sin(h.life * 26) * 0.10 * (1.2 - h.life));
      if (h.life <= 0) {
        this.group.remove(h.mesh);
        this.hazards.splice(i, 1);
        continue;
      }
      for (const k of karts) {
        if (k === h.owner && h.armed > 0) continue;
        if (k.star > 0 || k.invuln > 0) continue;
        if (k.pos.distanceToSquared(h.mesh.position) > 2.0 * 2.0) continue;
        if (k.spinout(1.0, 'banana')) {
          this.events.push({ type: 'hit', kart: k, by: 'banana', pos: k.pos.clone() });
          this.fx?.burst(h.mesh.position, 0xf5d02a, {
            count: 20, speed: 7, size: 0.5, life: 0.5, alpha: 0.8, ring: 1.1, gravity: 12,
          });
          this.group.remove(h.mesh);
          this.hazards.splice(i, 1);
          break;
        }
      }
    }
  }

  _driveBulletBill(dt, kart) {
    // Auto-pilot: lock onto the racing line and ignore the player's steering.
    const targetS = kart.s + 12;
    const target = this.track.placeOnRoad(targetS, 0, this._tmp);
    const desiredYaw = Math.atan2(target.x - kart.pos.x, target.z - kart.pos.z);
    kart.yaw = kart.yaw + wrapAngle(desiredYaw - kart.yaw) * (1 - Math.exp(-9 * dt));
    kart.lateral = damp(kart.lateral, 0, 4, dt);
    // Anything it touches gets knocked aside.
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
