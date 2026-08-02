import * as THREE from 'three';
import { clamp01 } from '../core/MathX.js';

/**
 * A pooled GPU particle system.
 *
 * One draw call per blend mode, fixed-size buffers, no allocation during a
 * race. Particles are simulated on the CPU (a few thousand at most) but all
 * per-particle appearance — fade curve, size curve, rotation, colour ramp,
 * soft ground contact — is done in the shader, which keeps the CPU cost to a
 * handful of float writes.
 *
 * Shape is a per-particle attribute rather than a per-material uniform. That
 * matters more than it sounds: a boost plume needs a hot streak, a coloured
 * flame and a soft halo *in the same additive draw call*, and splitting them
 * across three pools would triple the draw calls and break the blend order.
 */

/** Per-particle sprite kinds. Values are baked into the fragment shader. */
export const SHAPE = {
  GLOW: 0,     // soft round falloff — cores, halos, plumes
  SPARK: 1,    // four-point star with a flicker — hot debris
  SMOKE: 2,    // noisy dissolving edge — tyre smoke, dust
  STREAK: 3,   // stretched along the velocity in screen space — speed lines
  RING: 4,     // expanding annulus — shockwaves, charge tells
  RIPPLE: 5,   // travelling concentric bands — exhaust heat shimmer
};

const VERT = /* glsl */`
  attribute vec3 aVel;
  attribute float aSize;
  attribute float aLife;      // 1 -> 0 normalised
  attribute float aRot;
  attribute vec4 aColor;
  attribute vec3 aColorB;     // colour at the end of life
  attribute float aShape;
  attribute float aGround;    // world Y to soft-fade against, or -1e9

  varying vec4 vColor;
  varying vec3 vColorB;
  varying float vLife;
  varying float vRot;
  varying float vShape;
  varying float vAng;
  varying float vSize;
  varying float vGround;
  varying float vFade;
  varying vec3 vWorld;

  uniform float uPixelScale;
  uniform vec2 uNear;      // distance at which a sprite is fully faded / fully visible
  uniform float uMaxPx;

  void main() {
    vColor = aColor;
    vColorB = aColorB;
    vLife = aLife;
    vRot = aRot;
    vShape = aShape;
    vGround = aGround;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;

    // Size envelope. Particles that appear at full size pop; every shipped
    // system eases them in over the first slice of life and settles them out
    // at the end, which is most of what separates "engine demo" from "game".
    float age = 1.0 - aLife;
    float env = mix(0.40, 1.0, smoothstep(0.0, 0.15, age))
              * mix(1.0, 0.76, smoothstep(0.55, 1.0, age));
    float sz = aSize * env;
    vSize = sz;

    // Screen-space travel direction. For a symmetric perspective projection
    // view-space x/y map linearly to pixels, so the view-space velocity angle
    // is already the on-screen angle — no aspect correction needed.
    vec3 vv = (viewMatrix * vec4(aVel, 0.0)).xyz;
    vAng = atan(vv.y, vv.x);

    float d = max(-mv.z, 0.35);
    // Near-camera fade. A chase camera sits a few metres behind the kart, so
    // everything the kart sheds sweeps straight through the lens: without this
    // one puff of tyre smoke at 1.5 m becomes a 700-pixel white disc that
    // swallows the frame. The range is per-pool because smoke needs metres of
    // runway to disappear and a spark needs centimetres.
    vFade = smoothstep(uNear.x, uNear.y, d);

    gl_PointSize = clamp(sz * uPixelScale / d, 1.0, uMaxPx);
  }`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec4 vColor;
  varying vec3 vColorB;
  varying float vLife;
  varying float vRot;
  varying float vShape;
  varying float vAng;
  varying float vSize;
  varying float vGround;
  varying float vFade;
  varying vec3 vWorld;

  uniform float uTime;
  // World-space Y of the camera's right and up basis vectors: enough to
  // reconstruct a billboard fragment's world height without a full matrix.
  uniform vec2 uBillY;

  float hash(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p,p.yx+19.19); return fract((p.x+p.y)*p.x); }
  mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  void main() {
    // +x right, +y up in screen space (gl_PointCoord's Y runs downward).
    vec2 local = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
    float r = length(local) * 2.0;
    float a;

    if (vShape < 0.5) {
      float g = smoothstep(1.0, 0.0, r);
      a = g * g;
    } else if (vShape < 1.5) {
      // Four-point star. The falloff is deliberately steep: a broad one turns
      // a hundred sparks into a single coloured fog, and the whole point of a
      // spark is that you can count them.
      vec2 uv = rot(vRot) * local;
      float cross = max(0.0, 1.0 - abs(uv.x) * 11.0) + max(0.0, 1.0 - abs(uv.y) * 11.0);
      float core = smoothstep(0.62, 0.0, r);
      a = clamp(core * core * core * 2.2 + cross * smoothstep(0.85, 0.10, r) * 0.55, 0.0, 1.0);
      // Sparks are burning particles, not lamps — they must scintillate.
      a *= 0.70 + 0.30 * sin(uTime * 52.0 + vRot * 13.0);
    } else if (vShape < 2.5) {
      // Puff with a noisy, dissolving edge so smoke doesn't look like a disc.
      vec2 uv = rot(vRot) * local;
      float n = hash(floor((uv + 0.5) * 13.0) + floor(vLife * 6.0));
      float edge = smoothstep(1.0, 0.32, r + n * 0.30 * (1.0 - vLife));
      a = edge * 0.92;
    } else if (vShape < 3.5) {
      // Velocity-aligned streak with a hot head — the speed-line primitive.
      vec2 q = rot(-vAng) * local;
      float band = smoothstep(0.5, 0.0, abs(q.y) * 6.5);
      float along = smoothstep(0.52, 0.0, abs(q.x));
      a = band * along;
      a += smoothstep(0.11, 0.0, length(vec2((q.x - 0.26) * 1.2, q.y * 2.4))) * 0.85;
      a = clamp(a, 0.0, 1.0);
    } else if (vShape < 4.5) {
      // Annulus that thins as it expands: a shockwave, not a growing disc.
      float w = mix(0.34, 0.05, 1.0 - vLife);
      a = smoothstep(w, 0.0, abs(r - 0.84));
    } else {
      // Heat shimmer. Without a copy of the frame buffer nothing here can
      // actually refract, so this instead does what refraction *looks* like:
      // fast travelling bands of low-contrast luminance over the exhaust.
      // At this alpha it reads as boiling air, and it costs no extra pass.
      float band = sin(r * 13.0 - uTime * 22.0 - vRot * 5.0);
      float n = hash(floor((local + 0.5) * 9.0) + floor(vLife * 5.0));
      a = max(0.0, band) * smoothstep(1.0, 0.25, r) * smoothstep(0.0, 0.30, r) * (0.55 + n * 0.45);
    }

    if (a <= 0.003) discard;

    // Colour over life. Squared so the head keeps its start colour and the
    // transition happens in the tail, which is where the eye reads "cooling".
    vec3 col = mix(vColorB, vColor.rgb, vLife * vLife);

    float alpha = vColor.a * a * vFade;

    // Soft ground contact: fade the part of the billboard that sinks into the
    // surface instead of letting the depth test slice it with a hard edge.
    if (vGround > -1.0e7) {
      float y = vWorld.y + (local.x * uBillY.x + local.y * uBillY.y) * vSize;
      alpha *= smoothstep(-0.04, 0.40, y - vGround);
    }

    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }`;

export class ParticlePool {
  /**
   * @param {THREE.Scene} scene
   * @param {{max?:number, blending?:number, depthWrite?:boolean, renderOrder?:number,
   *          nearFade?:[number,number], maxPx?:number}} opts
   */
  constructor(scene, opts = {}) {
    this.max = opts.max ?? 2000;
    this.count = 0;

    const n = this.max;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.color = new Float32Array(n * 4);
    this.colorB = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.norm = new Float32Array(n);      // life / maxLife, uploaded to aLife
    this.rot = new Float32Array(n);
    this.rotVel = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.sizeGrow = new Float32Array(n);
    this.shape = new Float32Array(n);
    this.ground = new Float32Array(n);
    this.bounce = new Float32Array(n);
    // Cached spawn colour so the fade curve can drive alpha per-frame.
    this.baseAlpha = new Float32Array(n);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    // Velocity is both the simulation state and a vertex attribute; sharing the
    // array means streak orientation costs nothing extra on the CPU.
    this.geo.setAttribute('aVel', new THREE.BufferAttribute(this.velocity, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4));
    this.geo.setAttribute('aColorB', new THREE.BufferAttribute(this.colorB, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.norm, 1));
    this.geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1));
    this.geo.setAttribute('aShape', new THREE.BufferAttribute(this.shape, 1));
    this.geo.setAttribute('aGround', new THREE.BufferAttribute(this.ground, 1));
    this.geo.setDrawRange(0, 0);
    // Particles move constantly; a static bounding sphere would cull wrongly.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 600 },
        uTime: { value: 0 },
        uBillY: { value: new THREE.Vector2(0, 1) },
        uNear: { value: new THREE.Vector2(...(opts.nearFade ?? [0.30, 1.30])) },
        uMaxPx: { value: opts.maxPx ?? 700 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: opts.depthWrite ?? false,
      depthTest: true,
      blending: opts.blending ?? THREE.AdditiveBlending,
    });
    this.material.toneMapped = opts.toneMapped ?? false;

    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder ?? 5;
    this.points.name = opts.name ?? 'fx_particles';
    scene.add(this.points);
    this.scene = scene;
  }

  /**
   * @param {{x,y,z}} p position
   * @param {{x,y,z}} v velocity
   * @param {THREE.Color|number} color
   */
  spawn(p, v, color, {
    size = 1, life = 1, alpha = 1, gravity = 0, drag = 1.5, rot = 0, rotVel = 0, sizeGrow = 0,
    shape = SHAPE.GLOW, colorB = null, ground = null, bounce = 0,
  } = {}) {
    let i;
    if (this.count < this.max) {
      i = this.count++;
    } else {
      // Pool is full: recycle the particle with the least life left.
      i = 0;
      let worst = Infinity;
      for (let j = 0; j < this.max; j += 7) {
        if (this.life[j] < worst) { worst = this.life[j]; i = j; }
      }
    }
    this.position[i * 3] = p.x; this.position[i * 3 + 1] = p.y; this.position[i * 3 + 2] = p.z;
    this.velocity[i * 3] = v.x; this.velocity[i * 3 + 1] = v.y; this.velocity[i * 3 + 2] = v.z;
    const c = color.isColor ? color : _c.setHex(color);
    this.color[i * 4] = c.r; this.color[i * 4 + 1] = c.g; this.color[i * 4 + 2] = c.b;
    this.color[i * 4 + 3] = alpha;
    const cb = colorB == null ? c : (colorB.isColor ? colorB : _c2.setHex(colorB));
    this.colorB[i * 3] = cb.r; this.colorB[i * 3 + 1] = cb.g; this.colorB[i * 3 + 2] = cb.b;
    this.baseAlpha[i] = alpha;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.norm[i] = 1;
    this.rot[i] = rot;
    this.rotVel[i] = rotVel;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.sizeGrow[i] = sizeGrow;
    this.shape[i] = shape;
    this.ground[i] = ground == null ? -1e9 : ground;
    this.bounce[i] = bounce;
    return i;
  }

  update(dt) {
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      let l = this.life[i];
      if (l <= 0) continue;
      l -= dt;
      if (l <= 0) { this.life[i] = 0; this.color[i * 4 + 3] = 0; continue; }
      this.life[i] = l;

      const i3 = i * 3;
      // Exponential drag, integrated analytically so it's stable at any dt.
      const d = Math.exp(-this.drag[i] * dt);
      this.velocity[i3] *= d;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * d - this.gravity[i] * dt;
      this.velocity[i3 + 2] *= d;

      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;

      // Debris that bounces off the road has weight; debris that sinks through
      // it reads as a decal that happens to be moving.
      const b = this.bounce[i];
      if (b > 0) {
        const floor = this.ground[i];
        if (this.position[i3 + 1] < floor) {
          this.position[i3 + 1] = floor;
          if (this.velocity[i3 + 1] < -0.5) {
            this.velocity[i3 + 1] = -this.velocity[i3 + 1] * b;
            this.velocity[i3] *= 0.58;
            this.velocity[i3 + 2] *= 0.58;
            this.rotVel[i] *= 0.5;
          } else {
            this.velocity[i3 + 1] = 0;
          }
        }
      }

      this.rot[i] += this.rotVel[i] * dt;
      this.size[i] = Math.max(0.01, this.size[i] + this.sizeGrow[i] * dt);

      const t = l / this.maxLife[i];             // 1 -> 0
      this.norm[i] = t;
      // Fast attack, long decay: the shape almost all impact FX want.
      const fade = t > 0.88 ? (1 - t) / 0.12 : t / 0.88;
      this.color[i * 4 + 3] = this.baseAlpha[i] * clamp01(fade);
      alive++;
    }

    // Compact the buffer so the draw range stays tight.
    if (alive < this.count * 0.6 && this.count > 64) this._compact();

    this.geo.setDrawRange(0, this.count);
    for (const k of UPLOAD) this.geo.attributes[k].needsUpdate = true;
  }

  _compact() {
    let w = 0;
    for (let r = 0; r < this.count; r++) {
      if (this.life[r] <= 0) continue;
      if (w !== r) {
        for (let k = 0; k < 3; k++) {
          this.position[w * 3 + k] = this.position[r * 3 + k];
          this.velocity[w * 3 + k] = this.velocity[r * 3 + k];
          this.colorB[w * 3 + k] = this.colorB[r * 3 + k];
        }
        for (let k = 0; k < 4; k++) this.color[w * 4 + k] = this.color[r * 4 + k];
        this.size[w] = this.size[r];
        this.life[w] = this.life[r];
        this.maxLife[w] = this.maxLife[r];
        this.norm[w] = this.norm[r];
        this.rot[w] = this.rot[r];
        this.rotVel[w] = this.rotVel[r];
        this.gravity[w] = this.gravity[r];
        this.drag[w] = this.drag[r];
        this.sizeGrow[w] = this.sizeGrow[r];
        this.shape[w] = this.shape[r];
        this.ground[w] = this.ground[r];
        this.bounce[w] = this.bounce[r];
        this.baseAlpha[w] = this.baseAlpha[r];
      }
      w++;
    }
    this.count = w;
  }

  setPixelScale(heightPx, fovDeg) {
    // Convert world-space particle size into point sprite pixels.
    this.material.uniforms.uPixelScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI / 180) / 2));
  }

  /** Feeds the shader the camera basis it needs for the soft ground fade. */
  setCamera(camera, time) {
    const e = camera.matrixWorld.elements;
    this.material.uniforms.uBillY.value.set(e[1], e[5]);
    this.material.uniforms.uTime.value = time;
  }

  clear() { this.count = 0; this.geo.setDrawRange(0, 0); }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.material.dispose();
  }
}

// Attributes that change every frame. `aShape`, `aGround` and `aColorB` change
// only on spawn, but compaction shuffles them, so they ride along.
const UPLOAD = ['position', 'aVel', 'aColor', 'aColorB', 'aSize', 'aLife', 'aRot', 'aShape', 'aGround'];

const _c = new THREE.Color();
const _c2 = new THREE.Color();
