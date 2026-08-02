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

/** Glyph size relative to its authored quad; see `_buildBoxes`. */
const CORE_SCALE = 0.70;

/**
 * Item-box appearance.
 *
 * Everything below writes *linear scene-referred* values, because the scene
 * renders into a half-float target and tone mapping only happens in the output
 * pass (see render/PostFX.js). Exposure is 0.52, so linear 1.9 is screen white
 * and the bloom threshold sits at 1.05 post-exposure — i.e. linear 2.0. The
 * shell body is therefore authored around 1.0-1.3 and *only* the edge frame is
 * allowed past 2.0. A box that reads as bright as the sky is a box that has
 * stopped being a prop and started being a light source, which is precisely
 * how these ended up as white cardboard cartons.
 */
const BOX_SHELL_VERT = /* glsl */`
  varying vec3 vNrm;
  varying vec3 vView;
  varying vec3 vObj;
  varying float vHueOff;
  void main() {
    vObj = position;
    // Per-box hue offset hashed from where the box stands. A single shared
    // material would otherwise paint every box on the circuit the same colour
    // in the same frame, and four identical boxes in a row is a texture, not
    // four separate pickups.
    vHueOff = fract(dot(modelMatrix[3].xyz, vec3(0.037, 0.019, 0.029)));
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNrm = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const BOX_SHELL_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vNrm;
  varying vec3 vView;
  varying vec3 vObj;
  varying float vHueOff;
  uniform float uTime;

  vec3 hue(float h) {
    // Cheap cosine palette. Hue as a continuous function beats an HSL helper
    // here because the fresnel term feeds it directly, every fragment.
    return 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67)));
  }

  void main() {
    // abs(): the shell is double-sided, and a back face whose normal points
    // away would otherwise report zero fresnel and go invisible at the rim,
    // which is the one place the effect has to be strongest.
    float ndv = abs(dot(normalize(vNrm), normalize(vView)));
    float f = pow(1.0 - ndv, 2.6);

    // Thin-film interference: the hue is a function of viewing angle, so the
    // colour sweeps as the box rotates and every face reads differently. That
    // angular dependence is the whole difference between "glass" and "a
    // translucent grey cube".
    vec3 film = hue(0.44 + vHueOff * 0.5 + f * 0.72 + vObj.y * 0.20 + normalize(vNrm).x * 0.09 + uTime * 0.05);
    // Pull toward white by the film's own strength: fully saturated rainbow
    // across a whole face reads as a beach ball, not as a coating.
    //
    // The white it was pulled toward was itself a pale cyan, and it took away
    // half the hue — so every box on the circuit landed on the same washed
    // mint, and at road distance a row of them read as blocks of ice. Warm
    // white, and a third less of it: the film has to be able to say which way
    // round the box is facing from forty metres, and it can only do that if
    // the faces are actually different colours.
    film = mix(vec3(1.00, 0.96, 0.86), film, 0.72);

    // Face shading from the world normal alone. There is no light here on
    // purpose: a magic prop that samples the scene's sun picks up the sun's
    // *intensity*, and this thing has to look identical at every point of a
    // lap and on all three tracks.
    float up = normalize(vNrm).y * 0.5 + 0.5;
    vec3 body = film * mix(0.85, 1.55, up);

    // Moulded frame along the cube edges. Two of the three object-space axes
    // being near the surface means "edge"; all three means "corner".
    //
    // Twice as thick as it was, because this is the box's silhouette and a
    // silhouette that is one screen pixel wide at forty metres is a silhouette
    // that the minification filter averages into the road behind it. The frame
    // is the one part of a box a player picks out of a busy frame at the far
    // end of a straight — it is what they change line for — and it has to
    // survive being small before anything else about the prop matters.
    vec3 e = abs(vObj) / 0.55;
    float m1 = max(max(e.x, e.y), e.z);
    float m2 = max(min(e.x, e.y), min(max(e.x, e.y), e.z));   // second largest
    float edge = smoothstep(0.76, 0.96, m2) * step(0.78, m1);

    // Depth attenuation for the far wall.
    //
    // A double-sided shell draws the back of the box through the front of it
    // at full strength, so every box carried a *second* complete copy of the
    // moulded frame — three bright lines converging on the glyph from the
    // corners. That is what made these read as empty wireframe cases with a
    // question mark floating in them rather than as containers holding
    // something. Any real translucent medium attenuates what is behind it;
    // this is the cheapest possible version of that, and it costs one mix.
    float far = gl_FrontFacing ? 1.0 : 0.26;
    edge *= far;

    // Interior volume: a slow diagonal caustic so the inside of the box is not
    // empty space. Very low amplitude — this is texture, not a feature.
    //
    // Frequencies scaled with the shell when it shrank, here and on the film's
    // vObj.y term above: both are cycles per *metre*, so leaving them alone
    // would have given the smaller box two thirds of a band across a face and
    // turned the pattern into a flat gradient.
    float caustic = 0.5 + 0.5 * sin(vObj.x * 10.0 + vObj.z * 7.0 - uTime * 1.7);

    // Face-on opacity nearly doubled. At 0.19 the flat of a face was almost
    // entirely the road behind it, which is exactly why these read as glass
    // blocks rather than as objects: a prop you can see through has no mass
    // and no colour of its own at any distance where it is only a few pixels.
    float a = (mix(0.34, 0.86, f) + caustic * 0.04) * far;
    vec3 col = body * (1.05 + caustic * 0.15);
    // The frame is the only part allowed past the bloom threshold, and it is
    // thin enough that it costs a fraction of a percent of the frame.
    col = mix(col, hue(0.30 + vHueOff * 0.5 + uTime * 0.11) * 2.1 + 0.40, edge);
    a = mix(a, 0.92 * far, edge);

    gl_FragColor = vec4(col, a);
  }`;

/**
 * The core. A screen-aligned billboard rather than a solid, because the thing
 * it has to communicate — "a random item is inside" — is a glyph, and a glyph
 * on a spinning polyhedron is edge-on half the time. Billboarding in the vertex
 * shader keeps it free: no per-frame quaternion writes for the dozens of boxes
 * a circuit carries.
 */
const BOX_CORE_VERT = /* glsl */`
  varying vec2 vP;
  varying float vHueOff;
  void main() {
    vP = position.xy;
    vHueOff = fract(dot(modelMatrix[3].xyz, vec3(0.037, 0.019, 0.029)));
    // Uniform scale of the instance, recovered from its own matrix, so the
    // holder's breathe and the collection pop still drive the glyph.
    float s = length(modelMatrix[0].xyz);
    vec4 mv = viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * s;
    gl_Position = projectionMatrix * mv;
  }`;

const BOX_CORE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vP;
  varying float vHueOff;
  uniform float uTime;

  float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }

  void main() {
    vec2 p = vP;
    float r = length(p) * 2.0;

    // A question mark, as three strokes. The hook is a ring with its
    // lower-left quadrant cut away; the descender runs from where the hook
    // ends into the centreline; the dot sits below.
    vec2 q = p - vec2(0.0, 0.15);
    float d = abs(length(q) - 0.13);
    if (q.x < 0.0 && q.y < 0.0) d = 1.0;
    d = min(d, seg(p, vec2(0.112, 0.088), vec2(0.0, -0.02)));
    d = min(d, seg(p, vec2(0.0, -0.02), vec2(0.0, -0.15)));
    d = min(d, length(p - vec2(0.0, -0.26)) - 0.004);
    // Wide strokes on purpose. At forty metres the whole glyph spans about a
    // dozen pixels, and a hairline one minifies to grey mush — the mark has to
    // survive being three pixels tall or it is decoration, not information.
    float glyph = smoothstep(0.072, 0.026, d);

    // Halo. Past about twenty metres the glyph itself is sub-pixel, and this
    // is what survives: a coloured point of light on the road. It is the
    // reason a box is findable at all at the far end of a straight.
    float halo = pow(smoothstep(0.62, 0.0, r), 2.4);
    // Hot nucleus behind the mark, so the box is lit from the inside rather
    // than being a display case with a sticker in it.
    float nucleus = pow(smoothstep(0.30, 0.0, r), 2.0);

    // Hue cycles through the item palette rather than sitting on one colour,
    // because the contents are random and the box should say so.
    float h = fract(uTime * 0.13 + vHueOff);
    vec3 tint = 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67)));
    tint = mix(vec3(1.0, 0.92, 0.72), tint, 0.72);

    // Counter-beat against the shell's slower breathe: two rates is what makes
    // a container read as holding something alive.
    float pulse = 0.82 + 0.18 * sin(uTime * 7.0);

    // The halo carries the box past about twenty metres, where the glyph is
    // sub-pixel and the shell is a dozen pixels of translucent nothing — so
    // it is the term that decides whether a box is findable down a straight,
    // and it was the faintest thing in the shader. Doubled.
    vec3 col = tint * (halo * 0.85 + nucleus * 0.70 + glyph * 2.40) * pulse;
    float a = clamp(halo * 0.30 + nucleus * 0.24 + glyph * 1.0, 0.0, 1.0);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

/**
 * The colour a given box is wearing at a given instant.
 *
 * A line-for-line copy of BOX_CORE_FRAG's tint — same position hash, same
 * cosine palette, same warm-white mix — so that the burst which replaces a box
 * is the colour of the box that was standing there. Every box on the circuit
 * wears a different hue and each one cycles, so the alternative is a fixed
 * gold pop that matches whatever it destroyed about a sixth of the time; that
 * is a generic effect with a tint on it, which is most of what made a pickup
 * indistinguishable from being hit.
 *
 * Duplicating six lines of shader arithmetic in JS is the cheap side of the
 * trade: the honest alternative is a uniform readback per pickup.
 */
const _tint = new THREE.Color();
function boxTint(pos, time) {
  const off = pos.x * 0.037 + pos.y * 0.019 + pos.z * 0.029;
  const h = (off - Math.floor(off)) + time * 0.13;
  const c = (k) => 0.5 + 0.5 * Math.cos(TAU * (h + k));
  // setRGB writes the working (linear) space directly, which is the space the
  // shader's gl_FragColor lands in — going through setHex would sRGB-decode a
  // number that was never encoded.
  return _tint.setRGB(
    lerp(1.0, c(0.0), 0.72),
    lerp(0.92, c(0.33), 0.72),
    lerp(0.72, c(0.67), 0.72),
  );
}

/**
 * The pool of light a box lays on the road under itself.
 *
 * One InstancedMesh for every box on the circuit, so the whole effect is a
 * single draw call. It does two jobs at once: the centre blends toward a warm
 * emissive so the box has a visible footprint, and an outer ring blends toward
 * a dark cool so the box is anchored to the surface instead of hovering in
 * front of it. A purely additive pool can only ever do the first.
 */
const BOX_POOL_VERT = /* glsl */`
  attribute float aOn;
  varying vec2 vUvP;
  varying float vOn;
  void main() {
    vUvP = position.xy * 2.0;
    vOn = aOn;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;

const BOX_POOL_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUvP;
  varying float vOn;
  uniform float uTime;
  void main() {
    if (vOn <= 0.001) discard;
    float r = length(vUvP);
    if (r > 1.0) discard;
    float g = pow(smoothstep(0.62, 0.0, r), 1.8);
    float shade = smoothstep(1.0, 0.34, r) * (1.0 - g);

    float pulse = 0.78 + 0.22 * sin(uTime * 3.1);
    float ga = g * 0.46 * pulse * min(vOn, 1.0) * vOn;
    float sa = shade * 0.26 * min(vOn, 1.0);

    vec3 glow = vec3(1.70, 1.14, 0.44);
    vec3 dark = vec3(0.035, 0.042, 0.062);
    float a = ga + sa;
    if (a < 0.004) discard;
    gl_FragColor = vec4((glow * ga + dark * sa) / a, a);
  }`;

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
    // 1.05 m, not 1.5. A 1.5 m cube stands as tall as the whole kart including
    // its rear wing, so approaching a row of them the pickups are the largest
    // objects on the circuit and the thing you are driving is not. A box is a
    // prop you collect, and it has to read as smaller than the vehicle.
    const geo = new THREE.BoxGeometry(1.05, 1.05, 1.05, 2, 2, 2);
    // Round the cube slightly for a moulded look.
    const p = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const v = new THREE.Vector3();
    const nv = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      // Blend the flat face normal toward the sphere normal by the amount the
      // position moves, rather than recomputing normals from the mesh.
      //
      // `computeVertexNormals` averages the two triangles meeting at each of a
      // 2x2 face's corners, and those triangles are split along the quad's
      // diagonal — so the interpolated normal has a crease along every
      // diagonal, and the fresnel term (a 2.6 power) amplifies it into a
      // visible line. Deriving the normal analytically has no crease.
      nv.fromBufferAttribute(nrm, i).lerp(v.clone().normalize(), 0.16).normalize();
      nrm.setXYZ(i, nv.x, nv.y, nv.z);
      v.lerp(v.clone().setLength(0.72), 0.16);
      p.setXYZ(i, v.x, v.y, v.z);
    }

    // Alpha-blended glass rather than `transmission`. Real transmission makes
    // three re-render the whole opaque scene into a refraction buffer, so a
    // single box in frame roughly doubled the scene's triangle count — for a
    // prop that reads as a flat white cube at race distance anyway.
    //
    // What replaced it — a physical material at opacity 0.34 with clearcoat 1
    // and envMapIntensity 2.2 — was no better: two double-sided layers of a
    // near-mirror pale-blue surface composite to about 0.56 coverage of a value
    // above 1.0, which is a white carton. The glass read has to come from
    // *angle*, not from a low opacity number: a fresnel that is nearly
    // transparent face-on and nearly opaque at the rim, with the hue moving as
    // it goes. Hand-authored because a lit PBR material cannot do it without
    // also inheriting the sun's intensity, which changes across a lap.
    this.boxMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BOX_SHELL_VERT,
      fragmentShader: BOX_SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.boxCoreMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BOX_CORE_VERT,
      fragmentShader: BOX_CORE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // The glyph quad keeps its authored 0.80 extent — the question mark's
    // stroke widths are absolute numbers in this space — and shrinks with the
    // shell through CORE_SCALE instead. Resizing the quad would have left the
    // hook and the descender sized for the old box.
    const coreGeo = new THREE.PlaneGeometry(0.80, 0.80);

    const n = this.track.itemBoxes.length;
    this.boxPoolOn = new Float32Array(n);
    const poolGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo.setAttribute('aOn', new THREE.InstancedBufferAttribute(this.boxPoolOn, 1));
    this.boxPoolMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BOX_POOL_VERT,
      fragmentShader: BOX_POOL_FRAG,
      transparent: true,
      depthWrite: false,
      // The road frame is not guaranteed right-handed, so half the quads would
      // be wound away from the camera and back-face culled out of existence.
      side: THREE.DoubleSide,
    });
    this.boxPool = new THREE.InstancedMesh(poolGeo, this.boxPoolMaterial, Math.max(n, 1));
    this.boxPool.name = 'itemBoxPool';
    this.boxPool.frustumCulled = false;   // one draw either way; culling it costs a bounds update
    this.boxPool.renderOrder = 2;
    this.group.add(this.boxPool);

    const frame = {};
    const basis = new THREE.Matrix4();
    const POOL_R = 2.3;

    for (let i = 0; i < n; i++) {
      const def = this.track.itemBoxes[i];
      const pos = this.track.placeOnRoad(def.s, def.lateral, new THREE.Vector3());

      // The pool has to lie in the road's plane, not the world's — sunsetCoast
      // banks hard enough that a horizontal quad would sink into the tarmac on
      // one side and float off it on the other.
      this.track.frameAt(def.s, frame);
      basis.makeBasis(frame.right, frame.tangent, frame.normal);
      basis.scale(new THREE.Vector3(POOL_R, POOL_R, 1));
      basis.setPosition(
        pos.x + frame.normal.x * 0.05,
        pos.y + frame.normal.y * 0.05,
        pos.z + frame.normal.z * 0.05,
      );
      this.boxPool.setMatrixAt(i, basis);
      this.boxPoolOn[i] = 1;

      pos.y += 1.02;
      const holder = new THREE.Group();
      holder.position.copy(pos);
      const core = new THREE.Mesh(coreGeo, this.boxCoreMaterial);
      core.scale.setScalar(CORE_SCALE);
      core.renderOrder = 3;
      holder.add(core);
      // Shell after core, so the glass tints the glyph rather than the glyph
      // being pasted on the outside of it.
      const shell = new THREE.Mesh(geo, this.boxMaterial);
      shell.castShadow = false;
      shell.renderOrder = 4;
      holder.add(shell);
      this.group.add(holder);
      this.boxes.push({
        s: def.s, lateral: def.lateral, pos, mesh: holder, core, shell, poolIndex: i,
        active: true, respawn: 0, phase: this.rng() * TAU, pop: 0,
      });
    }
    this.boxPool.instanceMatrix.needsUpdate = true;
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
    // The box shell is hand-shaded and deliberately takes no environment: see
    // the note in _buildBoxes about it having to look the same all lap.
    for (const m of [this.matGreen, this.matRed, this.matBanana]) {
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
    this.boxMaterial.uniforms.uTime.value = ctx.time;
    this.boxCoreMaterial.uniforms.uTime.value = ctx.time;
    this.boxPoolMaterial.uniforms.uTime.value = ctx.time;
    const on = this.boxPoolOn;

    for (const b of this.boxes) {
      b.phase += dt;
      on[b.poolIndex] = b.active ? 1 : (b.pop > 0 ? (b.pop / POP_TIME) * 1.9 : 0);

      if (!b.active) {
        b.respawn -= dt;
        // Collection pop: the box keeps drawing for a beat while it blows
        // outward, so a pickup is an event rather than a box that vanished.
        if (b.pop > 0) {
          b.pop = Math.max(0, b.pop - dt);
          const k = 1 - b.pop / POP_TIME;
          b.mesh.rotation.y += dt * 9;
          b.mesh.scale.setScalar(lerp(1, 1.9, smoothstep(clamp01(k))) * (1 - k * k));
          b.core.scale.setScalar(Math.max(0.001, 1 - k * 1.6) * CORE_SCALE);
          if (b.pop <= 0) b.mesh.visible = false;
        }
        if (b.respawn <= 0) {
          b.active = true;
          b.mesh.visible = true;
          b.core.scale.setScalar(CORE_SCALE);
        }
        continue;
      }

      // Respawn: snap back in with a short elastic overshoot rather than
      // materialising at full size on a single frame.
      const inT = clamp01((ctx.time - (b.bornAt ?? -99)) / 0.38);

      // Tumble on three axes, not one. A cube spun about world Y presents a
      // face square-on to the camera for most of every turn, so in any single
      // frame — which is all a still capture ever has — it reads as an
      // axis-aligned block sitting in the road rather than as something
      // hovering. The z term is small and prime-ish against the others so the
      // three never come back into phase.
      b.mesh.rotation.y = b.phase * 1.4;
      b.mesh.rotation.x = 0.38 + Math.sin(b.phase * 0.8) * 0.22;
      b.mesh.rotation.z = Math.sin(b.phase * 0.53) * 0.30;
      // The core is deliberately *not* spun: it billboards, and a question
      // mark you have to read while it cartwheels is a question mark nobody
      // reads. The shell's rotation carries all the motion.
      b.mesh.position.y = b.pos.y + Math.sin(b.phase * 2.1) * 0.15;
      // A slow breathe on the shell and a faster counter-beat on the core:
      // two rates make it read as a container with something alive inside.
      const breathe = 1 + Math.sin(b.phase * 2.1) * 0.045;
      const pop = inT < 1 ? lerp(0.2, 1, smoothstep(inT)) * (1 + Math.sin(inT * Math.PI) * 0.22) : 1;
      b.mesh.scale.setScalar(breathe * pop);
      b.core.scale.setScalar((1 + Math.sin(b.phase * 5.3) * 0.14) * pop * CORE_SCALE);

      // A sparkle every third of a second, but only for boxes the player can
      // actually see. A circuit carries dozens of boxes, and emitting for all
      // of them fills the whole particle pool with confetti nobody is looking
      // at — and starves the kart of its own sparks.
      if (eye && b.mesh.position.distanceToSquared(eye) < 3600) {
        b.spark = (b.spark || this.rng() * 0.5) + dt;
        if (b.spark > 0.34) {
          b.spark = 0;
          // Half the size and half the alpha it had. A dozen boxes in view were
          // throwing gold stars the same size and twice the brightness of the
          // player's own blue drift sparks, on the same grey asphalt — so the
          // loudest coloured thing on screen during a drift belonged to the
          // scenery. A box is a landmark; it does not get to outshine the
          // player's own state.
          this.fx?.trail(b.mesh.position, 0xffe27a, { size: 0.15, alpha: 0.15, life: 0.30, glow: 0.34 });
        }
      }

      for (const k of karts) {
        if (k.item || k.itemRoulette) continue;
        if (k.pos.distanceToSquared(b.mesh.position) < 3.2 * 3.2) {
          b.active = false;
          b.respawn = 3.0;
          b.pop = POP_TIME;
          b.bornAt = ctx.time + 3.0;
          // A dedicated effect, not the generic pop. `burst` is the shared
          // "something happened here" and it is right for a shell expiring;
          // a box is a *container*, and the whole of what makes taking one
          // feel like a reward is that it visibly comes apart.
          //
          // Handed the box's live colour, because the pickup and the impact
          // burst had converged into the same pale scatter and hue is one of
          // the four axes they now differ on. It is the box's colour rather
          // than a fixed gold so the burst belongs to the object the player
          // was looking at a frame earlier.
          this.fx?.itemBreak(b.mesh.position, boxTint(b.mesh.position, ctx.time));
          this.startRoulette(k, karts.length);
          break;
        }
      }
    }
    this.boxPool.geometry.attributes.aOn.needsUpdate = true;
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
          // No `hit` event here: `spinout` already raised one through the kart,
          // carrying the same cause. See `Race._wireEvents`.
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
          // `spinout` raised the `hit` event already — see `Race._wireEvents`
          // — and the FX for it are raised from there too. A second yellow
          // burst fired from here landed within two metres of the impact's
          // own, half a frame apart, so a banana strike was two overlapping
          // effects in two vocabularies for one collision. The peel's identity
          // now lives in `HIT_CAUSE.banana`, which is where the rest of the
          // hit vocabulary lives.
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
