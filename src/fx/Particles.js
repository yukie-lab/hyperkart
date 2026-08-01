import * as THREE from 'three';
import { clamp01, lerp, makeRng, TAU } from '../core/MathX.js';

/**
 * A pooled GPU particle system.
 *
 * One draw call per blend mode, fixed-size buffers, no allocation during a
 * race. Particles are simulated on the CPU (a few thousand at most) but all
 * per-particle appearance — fade curve, size curve, rotation, soft edges — is
 * done in the shader, which keeps the CPU cost to a handful of float writes.
 */

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aLife;      // 0..1 remaining
  attribute float aRot;
  attribute vec4 aColor;
  varying vec4 vColor;
  varying float vLife;
  varying float vRot;
  uniform float uPixelScale;
  void main() {
    vColor = aColor;
    vLife = aLife;
    vRot = aRot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective-correct size, clamped so near particles don't fill the screen.
    float d = max(-mv.z, 0.35);
    gl_PointSize = clamp(aSize * uPixelScale / d, 1.0, 640.0);
  }`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec4 vColor;
  varying float vLife;
  varying float vRot;
  uniform int uShape;   // 0 = soft round, 1 = spark streak, 2 = smoke puff
  uniform float uTime;

  float hash(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p,p.yx+19.19); return fract((p.x+p.y)*p.x); }

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = mat2(c, -s, s, c) * uv;
    float r = length(uv) * 2.0;
    float a;

    if (uShape == 1) {
      // Four-point star: reads as a hot spark rather than a dot.
      float cross = max(0.0, 1.0 - abs(uv.x) * 9.0) + max(0.0, 1.0 - abs(uv.y) * 9.0);
      float core = smoothstep(1.0, 0.0, r);
      a = clamp(core * core * 1.4 + cross * smoothstep(1.0, 0.15, r) * 0.55, 0.0, 1.0);
    } else if (uShape == 2) {
      // Puff with a noisy, dissolving edge so smoke doesn't look like a disc.
      float n = hash(floor((uv + 0.5) * 14.0) + vLife);
      float edge = smoothstep(1.0, 0.35, r + n * 0.28 * (1.0 - vLife));
      a = edge * 0.9;
    } else {
      a = smoothstep(1.0, 0.0, r);
      a *= a;
    }

    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  }`;

export class ParticlePool {
  /**
   * @param {THREE.Scene} scene
   * @param {{max?:number, blending?:number, shape?:number, depthWrite?:boolean, toneMapped?:boolean}} opts
   */
  constructor(scene, opts = {}) {
    this.max = opts.max ?? 2000;
    this.count = 0;

    const n = this.max;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.color = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotVel = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.sizeGrow = new Float32Array(n);
    // Cached spawn colour so the fade curve can drive alpha per-frame.
    this.baseAlpha = new Float32Array(n);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1));
    this.geo.setDrawRange(0, 0);
    // Particles move constantly; a static bounding sphere would cull wrongly.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 600 },
        uShape: { value: opts.shape ?? 0 },
        uTime: { value: 0 },
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
    this.baseAlpha[i] = alpha;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.rot[i] = rot;
    this.rotVel[i] = rotVel;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.sizeGrow[i] = sizeGrow;
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

      this.rot[i] += this.rotVel[i] * dt;
      this.size[i] += this.sizeGrow[i] * dt;

      const t = l / this.maxLife[i];             // 1 -> 0
      // Fast attack, long decay: the shape almost all impact FX want.
      const fade = t > 0.85 ? (1 - t) / 0.15 : t / 0.85;
      this.color[i * 4 + 3] = this.baseAlpha[i] * clamp01(fade);
      alive++;
    }

    // Compact the buffer so the draw range stays tight.
    if (alive < this.count * 0.6 && this.count > 64) this._compact();

    this.geo.setDrawRange(0, this.count);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aRot.needsUpdate = true;
  }

  _compact() {
    let w = 0;
    for (let r = 0; r < this.count; r++) {
      if (this.life[r] <= 0) continue;
      if (w !== r) {
        for (let k = 0; k < 3; k++) {
          this.position[w * 3 + k] = this.position[r * 3 + k];
          this.velocity[w * 3 + k] = this.velocity[r * 3 + k];
        }
        for (let k = 0; k < 4; k++) this.color[w * 4 + k] = this.color[r * 4 + k];
        this.size[w] = this.size[r];
        this.life[w] = this.life[r];
        this.maxLife[w] = this.maxLife[r];
        this.rot[w] = this.rot[r];
        this.rotVel[w] = this.rotVel[r];
        this.gravity[w] = this.gravity[r];
        this.drag[w] = this.drag[r];
        this.sizeGrow[w] = this.sizeGrow[r];
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

  clear() { this.count = 0; this.geo.setDrawRange(0, 0); }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.material.dispose();
  }
}

const _c = new THREE.Color();
