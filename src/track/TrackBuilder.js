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
const CURB_COLS = 6;          // enough columns to shape a crown and an outer lip
// Metres of kerb per texture tile, and stripes per tile. The product is the
// stripe length, which stays at the 1 m every circuit uses; splitting it this
// way is what makes the tile's texel density nearly square in world space.
// See the note on `Tex.curb` — an 8 m tile put the sampling footprint's long
// axis across the kerb, where there is nothing to resolve, and that is what
// made the stripes crawl.
const CURB_TILE = 2;
const CURB_STRIPES = 2;

// -- boost strips ------------------------------------------------------------
// Metres of road per chevron. At 3 m a 12 m pad carries four arrows, which is
// enough repetition to read as a direction and few enough to stay legible in
// peripheral vision; the same figure sets the arrow's size on every track.
const BOOST_PITCH = 3.0;
// Metres over which the decal fades in at each end. The old pad ended in a
// hard straight line drawn across the road, which is the single loudest tell
// that a decal is a polygon.
const BOOST_END_FADE = 1.5;
// Chevrons per second of apparent forward flow. Slower than the road passes
// underneath (ten pitches a second at racing speed) so the two motions read as
// separate things rather than beating against each other.
const BOOST_SCROLL = 1.15;
// Emissive on the arms only. Tuned against the sky, not chosen: see the
// measurements in _buildBoostPads.
const BOOST_EMISSIVE = 0.70;
// Rainbow Skyway's road runs at emissiveIntensity 1.35 and its bloom threshold
// sits just above it, so the arms have to clear the road they are painted on to
// register at all. Still under the road's own figure — the pad accents the
// ribbon, it does not out-glow it.
const BOOST_EMISSIVE_NEON = 1.25;
// How far the glow pool reaches past the pad, as a fraction of the pad's own
// half-extent. Proportional rather than absolute so the margin lands at the
// same place in the spill texture on both axes — one texture, one plateau.
// Was 0.48, which put the falloff 2.9 m out from a 12 m pad: far enough that
// the pool stopped reading as light lying on the road and started reading as a
// patch of blue haze hanging over it.
const BOOST_SPILL_RATIO = 0.28;
// Was 0x3d7899, which decodes to 0.32 linear blue and was being added to a road
// sitting at 0.05-0.15 — two to six times the surface's own value, on a pool
// three metres wider than the pad. A/B against a capture with the pool hidden:
// the pad without it read as paint on tarmac, the pad with it read as a patch
// of haze, and the chevrons lost contrast to their own glow. A third of that,
// over a tighter footprint, lifts the tarmac without competing with the arms.
const BOOST_SPILL_TINT = 0x1b3c52;
// Plate colour, and how much of it covers the road. Tarmac sits near 0.075
// linear albedo and the old plate at 0x123c56 decodes to 0.006/0.045/0.093 —
// darker than the road in red and green and level with it in blue, so on every
// tarmac circuit the bed was invisible and the pad read as stripes with nothing
// under them. This one is lighter than the tarmac and unmistakably blue.
const BOOST_PLATE = 0x2a5c78;
const BOOST_PLATE_ALPHA = 0.86;
// Rainbow Skyway's bed cannot be dark: the road under it emits, so an opaque
// dark plate is a hole cut in the ribbon, which reads as a hazard and not as a
// boost. A light-handed indigo tint that the road still glows through gives the
// arms something to sit on without taking the ribbon away.
const BOOST_PLATE_NEON = 0x1d2a63;
const BOOST_PLATE_ALPHA_NEON = 0.56;

// Checker squares per 3.2 m of start line, which is also its depth — so this is
// both the square size in metres (3.2 / n) and the number of rows.
const START_SQUARES = 4;
const START_DEPTH = 3.2;

/**
 * Cross-section of a rumble strip, `u` running from the tarmac edge outward.
 *
 * A kerb is not a flat plate: it steps up off the road over a few centimetres,
 * crowns, then rolls over an outer lip. Modelling that is what gives it a lit
 * top and a shadowed under-edge for free, instead of asking a normal map to
 * imply a silhouette it cannot produce. The outer value lands exactly on the
 * shoulder's own starting height, so the kerb→run-off join has no cliff in it.
 */
function curbY(u) {
  return lerp(0.0, 0.058, smoothstep(u / 0.16)) - 0.078 * smoothstep((u - 0.68) / 0.32);
}

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
   * @param {{name:string, size:number, fn:(u:number,s:number,lat:number,half:number,p:THREE.Vector3)=>number[]}} [extra]
   *        Optional custom vertex attribute. Surfaces that need to know where
   *        they sit *on the circuit* (rather than in tile space) get it here —
   *        macro wear has to live in road space or it repeats with the tile.
   */
  _strip(sList, latA, latB, cols, uvFn, yOffset = null, extra = null) {
    const n = sList.length;
    const m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const extras = extra ? new Float32Array(n * m * extra.size) : null;
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
        if (extras) {
          const vals = extra.fn(u, s, lat, half, p);
          for (let q = 0; q < extra.size; q++) extras[(i * m + j) * extra.size + q] = vals[q];
        }
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
    if (extras) geo.setAttribute(extra.name, new THREE.BufferAttribute(extras, extra.size));
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
      // Constant texel density: one texture tile every 6 m in both axes.
      (u, s, lat) => [lat / 6, s / 6],
      null,
      // Road space, for the wear shader: signed 0..1 across the driving
      // surface, metres travelled, and metres from the crown.
      { name: 'aRoad', size: 3, fn: (u, s, lat, half) => [lat / Math.max(half - curbW, 0.01), s, lat] },
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
      // Dry asphalt sits around 0.07 linear albedo — roughly a ninth of the
      // sand beside it, which is what keeps the circuit reading as a ribbon
      // laid across the dunes rather than as another shade of them. Biased a
      // touch blue so a low warm sun lands it on neutral grey instead of tan.
      // Per-theme, because sun elevation decides how much of the surface's
      // brightness it can supply. Canyon's sun is at 56 degrees and puts real
      // light on a flat road; the coast's is at 16 and puts almost none, so
      // the same tarmac that reads correctly at noon reads as a void at golden
      // hour. Physically that is just true, and the answer a circuit designer
      // reaches for is a lighter surface, not a brighter sun.
      const t = Tex.asphalt({ size: 1024, tint: this.theme.roadTint ?? 0x4d4d54 });
      mat = this._mat({
        map: t.map,
        normalMap: t.normalMap,
        roughnessMap: t.roughnessMap,
        normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
        metalness: 0.0,
        roughness: 1.0,
        // This was 0.22, to stop a strong sky reflection reading as wet road.
        // It cured the wrong thing: `envMapIntensity` scales the *diffuse*
        // irradiance the probe delivers as well as the specular, so cutting it
        // starved the tarmac of sky light. Under sunsetCoast's 16-degree sun,
        // which puts almost no direct light on a flat road, that left the
        // driving surface at a median of 3/255 — darker than the sea beside
        // it. Fully rough and non-metallic already keeps the specular lobe
        // wide and dim; the wet look came from the over-driven normal map
        // that the texture rebuild removed.
        envMapIntensity: 1.0,
        color: 0xffffff,
      });
      this._asphaltWear(mat, t);
    }
    this.road = this._add(geo, mat, { receive: true });
    this.road.name = 'road';
  }

  /**
   * Everything about the road that cannot live in a 6 m tile.
   *
   * A tile that repeats every 6 m goes past five times a second at racing
   * speed, so anything recognisable baked into it strobes. The features that
   * make a circuit read as a *place* — the rubbered-in line, resurfacing
   * patches and their tar seams, bleached aggregate and dust at the margins —
   * are therefore evaluated in road space here, on top of the tile.
   *
   * The same injection carries the anti-aliasing fix: the tile is sampled at
   * two scales and the fine one is faded out at the distance where its
   * footprint drops below a texel, with roughness widened to stand in for the
   * relief that was lost. That is the ocean's two-scale trick applied to a
   * surface that was crawling for exactly the same reason.
   */
  _asphaltWear(mat, tex) {
    const grime = new THREE.Color(this.theme.groundColor ?? 0x8a7a5c);
    // three keys its program cache on material *parameters*, so two standard
    // materials that differ only in injected source would silently share one
    // compiled shader — and the road would come out wearing the terrain's.
    mat.customProgramCacheKey = () => 'hk-asphalt';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBaseLuma = { value: Math.max(tex.meanLuma ?? 0.05, 1e-3) };
      shader.uniforms.uGrime = { value: grime };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec3 aRoad;
varying vec3 vRoad;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vRoad = aRoad;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vRoad;
uniform float uBaseLuma;
uniform vec3 uGrime;

float hkHash( vec2 p ) {
  p = fract( p * vec2( 0.3183099, 0.3678794 ) );
  p += dot( p, p + 27.71 );
  return fract( p.x * p.y * 41.31 );
}
float hkNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hkHash( i ), hkHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( hkHash( i + vec2( 0.0, 1.0 ) ), hkHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
float rDist = length( vViewPosition );
float rLane = vRoad.x;            // -1 at the left kerb, +1 at the right
float rArc  = vRoad.y;            // metres travelled along the lap
float rLat  = vRoad.z;            // metres from the crown

// Rubber only lays down where the cars actually drive, and that band wanders
// across the road with the corners instead of sitting dead centre.
float rLineC  = 0.30 * sin( rArc * 0.0295 ) + 0.16 * sin( rArc * 0.0113 + 1.9 );
float rRacing = 1.0 - smoothstep( 0.16, 0.72, abs( rLane - rLineC ) );
rRacing *= 0.70 + 0.30 * hkNoise( vec2( rArc * 0.05, 0.0 ) );

// The last metre before the kerb never gets driven on: bleached, open
// aggregate, with dust and marbles swept into the very edge. Kept to the
// last metre — any wider and it reads as a concrete gutter, not as wear.
float rEdge  = smoothstep( 0.76, 1.0, abs( rLane ) );
float rDirt  = smoothstep( 0.86, 1.0, abs( rLane ) );

// Resurfacing patches, as a warped cell grid so the repairs come out as
// irregular quads with tarred seams rather than a checkerboard.
vec2 rCell = vec2( rLat, rArc ) / 13.0;
rCell += ( vec2( hkNoise( rCell * 1.7 ), hkNoise( rCell * 1.7 + 5.3 ) ) - 0.5 ) * 0.7;
float rPatch = step( 0.70, hkHash( floor( rCell ) + 0.5 ) );
vec2 rF = fract( rCell );
float rSeamD = min( min( rF.x, 1.0 - rF.x ), min( rF.y, 1.0 - rF.y ) );
// A 15 cm seam is sub-pixel well before it is out of sight, so widen it in
// screen space rather than letting it break into a dotted line.
float rSeam = rPatch * ( 1.0 - smoothstep( 0.0, max( 0.010, fwidth( rSeamD ) * 1.6 ), rSeamD ) );
rPatch *= smoothstep( 0.0, 0.05, rSeamD );

// Second sample of the same tile six times larger, pivoted on the tile's own
// mean so it adds 35 m of tonal drift without moving the road's brightness.
float rMacro = dot( texture2D( map, vMapUv * 0.17 ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.rgb *= mix( 1.0, rMacro / uBaseLuma, 0.34 );

diffuseColor.rgb *= mix( 1.0, 0.74, rRacing );
diffuseColor.rgb *= mix( 1.0, 1.12, rEdge );
diffuseColor.rgb  = mix( diffuseColor.rgb, diffuseColor.rgb * 0.94 + uGrime * 0.055, rDirt );
diffuseColor.rgb *= mix( 1.0, 0.90, rPatch );
diffuseColor.rgb *= mix( 1.0, 0.58, rSeam );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
float rFine = 1.0 - smoothstep( 8.0, 44.0, rDist );
// Relief that has fallen off the end of the mip chain still scatters light.
// Widening the lobe to stand in for it is what stops the far road flattening
// into plastic once the chippings stop resolving — but only part way: pushing
// it all the way to 1.0 also kills the long sun sheen that sells dry tarmac.
roughnessFactor = mix( roughnessFactor, 0.90, ( 1.0 - rFine ) * 0.30 );
roughnessFactor = mix( roughnessFactor, 0.56, rRacing * 0.80 );
roughnessFactor = mix( roughnessFactor, 0.98, rEdge * 0.35 );
roughnessFactor = mix( roughnessFactor, 0.52, rSeam );
roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );`)
        .replace('#include <normal_fragment_maps>', `vec3 rMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
vec3 rMacN = texture2D( normalMap, vNormalMapUv * 0.17 ).xyz * 2.0 - 1.0;
// Two scales: the 35 m sample carries settlement and rutting and can never
// alias, the 6 m sample carries the chippings and is faded out where its
// footprint drops below a texel. Rubber fills the voids on the racing line,
// so the relief there is flattened too.
vec2 rN = rMacN.xy * 0.30 + rMapN.xy * rFine * mix( 1.0, 0.45, rRacing );
normal = normalize( tbn * vec3( rN * normalScale, 1.0 ) );`);
    };
  }

  _buildCurbs() {
    if (this.theme.shoulder === 'none' && this.track.isVoid) return;
    const rings = this._roadRings();
    const curbW = TRACK_LAYOUT.curbWidth;
    const t = Tex.curb({
      size: 512,
      dirtTint: this.theme.groundColor ?? 0x8a7a5c,
      stripes: CURB_STRIPES,
    });
    const mat = this._mat({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      metalness: 0.0,
      roughness: 1.0,
      envMapIntensity: 0.5,
    });
    this._curbWear(mat, t);

    for (const side of [-1, 1]) {
      const geo = this._strip(
        rings,
        (s, half) => side * (half - curbW),
        (s, half) => side * half,
        CURB_COLS,
        (u, s) => [u, s / CURB_TILE],
        (s, lat, u) => curbY(u),
        // Metres round the lap, and how far across the strip — everything that
        // has to differ between one kerb and the next needs both.
        { name: 'aCurb', size: 2, fn: (u, s) => [s, u] },
      );
      this._add(geo, mat).name = `curb_${side}`;
    }
  }

  /**
   * The part of a kerb's history that cannot live in a two-metre tile.
   *
   * Shrinking the tile to fix the crawl cost the texture its per-stripe
   * variety: with one red and one white to a tile, every red was the same red.
   * That variety was never really the tile's job — an eight metre tile repeated
   * too, just more slowly — so it moves here, alongside the two things that
   * were always wrong in tile space. Paint ages by the *length* of kerb, not by
   * the stripe: a run in the sun bleaches and a shaded one does not. And rubber
   * lands where the field actually rides the inside of a corner, which is a
   * property of the circuit, not of the texture.
   *
   * It also carries the other half of the crawl fix. Past sixty metres or so a
   * 1 m stripe is worth a pixel on a kerb that is itself a pixel tall, and no
   * filter makes a pattern at that scale hold still — every pixel simply flips
   * between red and white as the circuit slides under it. Measured on the far
   * kerb at canyonRush: 89/255 peak swing over one scroll period. So the
   * stripes are faded to the colour they average to, which is what a perfect
   * filter would have produced anyway, and they get there before they are small
   * enough to strobe. Same reasoning, and nearly the same distances, as the
   * two-scale fades already on the road and the terrain.
   */
  _curbWear(mat, tex) {
    mat.customProgramCacheKey = () => 'hk-curb';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCurbFar = { value: tex.meanColor ?? new THREE.Color(0.4, 0.3, 0.3) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aCurb;
varying vec2 vCurb;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vCurb = aCurb;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vCurb;
uniform vec3 uCurbFar;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
float kArc = vCurb.x;             // metres round the lap
float kU   = vCurb.y;             // 0 at the tarmac joint, 1 at the outer lip
float kDist = length( vViewPosition );

// The stripes are resolved, then they are not. Crossing that line with the
// pattern still at full contrast is the crawl; crossing it having already
// converged to the average is just a kerb going soft with distance.
float kFar = smoothstep( 42.0, 105.0, kDist );
diffuseColor.rgb = mix( diffuseColor.rgb, uCurbFar, kFar );

// Two incommensurate periods, neither of them a multiple of the tile, so no
// two lengths of kerb wear alike anywhere on a 1.4-1.7 km circuit.
float kAge = 0.5 + 0.30 * sin( kArc * 0.1370 ) + 0.20 * sin( kArc * 0.0413 + 2.1 );
diffuseColor.rgb *= mix( 0.78, 1.06, kAge );

// Karts ride the kerb at the corners and nowhere else, and they only ever
// touch the crown — the outer roll stays clean, which is what makes the rubber
// read as tyre marks rather than as a dirty texture.
float kRide  = smoothstep( 0.45, 1.0, 0.5 + 0.5 * sin( kArc * 0.0327 + 0.7 ) );
float kCrown = 1.0 - smoothstep( 0.0, 0.50, abs( kU - 0.34 ) );
float kRub   = kRide * kCrown * ( 1.0 - kFar );
diffuseColor.rgb *= mix( 1.0, 0.62, kRub );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp( mix( roughnessFactor, 0.99, kRub * 0.7 ), 0.05, 1.0 );`)
        // Chipped paint and coarse concrete are millimetres of relief. Once
        // they stop resolving the normal map only supplies specular sparkle,
        // which crawls for the same reason the albedo did.
        .replace('#include <normal_fragment_maps>', `vec3 kMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
normal = normalize( tbn * vec3( kMapN.xy * normalScale * ( 1.0 - kFar ), 1.0 ) );`);
    };
  }

  _buildMarkings() {
    if (this.track.isVoid) return;
    const rings = this._roadRings();
    const curbW = TRACK_LAYOUT.curbWidth;
    const t = Tex.laneMarkings({ size: 512 });
    t.map.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      alphaMap: t.alphaMap,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      transparent: true,
      opacity: 0.92,
      roughness: 1.0,
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
    const t = texFn({ size: 1024, tint: this.theme.groundColor });
    const mat = this._mat({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      metalness: 0.0,
      roughness: 1.0,
      envMapIntensity: 0.5,
    });
    this._groundWear(mat, t, { tile: 5, cacheKey: 'shoulder' });

    for (const side of [-1, 1]) {
      const geo = this._strip(
        rings,
        (s, half) => side * half,
        (s, half) => side * (half + shoulderW),
        4,
        (u, s, lat) => [lat / 5, s / 5],
        // The apron falls away from the road edge so it reads as a run-off.
        (s, lat, u) => -0.38 * smoothstep(u) - 0.02,
        // World height (for the waterline) and metres out from the tarmac.
        { name: 'aGround', size: 2, fn: (u, s, lat, half, p) => [p.y, u * shoulderW] },
      );
      this._add(geo, mat).name = `shoulder_${side}`;
    }
  }

  /**
   * Shared treatment for every off-track surface: shoulders and terrain.
   *
   * Three jobs, all of which need to know where a fragment is in the *world*
   * rather than in its tile:
   *
   *  - Break the repeat. The terrain tiles every 14 m across half a kilometre
   *    of dune, which the eye picks up instantly as wallpaper. A second sample
   *    of the same map five times larger, pivoted on the map's own mean so the
   *    ground's brightness does not move, buys 70 m of drift over the top.
   *  - Hold still. Same fix as the road: fade the fine normal out once its
   *    footprint drops under a texel and widen the specular lobe to stand in
   *    for the relief that was lost.
   *  - Meet its neighbours. Sand is compacted and rubber-stained for the first
   *    couple of metres off the tarmac, and damp for the last couple above the
   *    waterline, so both joins are a gradient rather than a polygon edge.
   */
  _groundWear(mat, tex, { tile, waterLevel = null, cacheKey }) {
    mat.customProgramCacheKey = () => `hk-ground-${cacheKey}`;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBaseLuma = { value: Math.max(tex.meanLuma ?? 0.2, 1e-3) };
      // Far below any geometry disables the damp band without a second shader.
      shader.uniforms.uWater = { value: waterLevel ?? -1e6 };
      shader.uniforms.uTile = { value: 1 / tile };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aGround;
varying vec2 vGround;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vGround = aGround;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vGround;
uniform float uBaseLuma;
uniform float uWater;
uniform float uTile;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
float gDist = length( vViewPosition );
float gWorldY = vGround.x;
float gOut = vGround.y;          // metres out from the edge of the tarmac

float gMacro = dot( texture2D( map, vMapUv * 0.19 ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.rgb *= mix( 1.0, gMacro / uBaseLuma, 0.40 );

// Ground UVs are world XZ, so anything steep is drawn through a badly
// stretched sample. Re-project the steep parts against height instead.
vec3 gUp = normalize( mat3( viewMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
float gSlope = smoothstep( 0.30, 0.80, 1.0 - abs( dot( normalize( vNormal ), gUp ) ) );
if ( gSlope > 0.001 ) {
  vec2 gWallUv = vec2( vMapUv.x + vMapUv.y, gWorldY * uTile );
  diffuseColor.rgb = mix( diffuseColor.rgb, texture2D( map, gWallUv ).rgb, gSlope );
}

// Karts leave the circuit here: the first couple of metres are packed flat
// and stained, which is what makes the run-off look used instead of laid.
float gEdge = 1.0 - smoothstep( 0.0, 2.4, gOut );
diffuseColor.rgb *= mix( 1.0, 0.76, gEdge );

// Damp sand above the tideline: darker, deeper, and it holds a sheen.
float gWet = 1.0 - smoothstep( 0.0, 2.4, gWorldY - uWater );
diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.60, 0.55, 0.53 ), gWet );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
float gFine = 1.0 - smoothstep( 24.0, 130.0, gDist );
roughnessFactor = mix( roughnessFactor, 0.99, ( 1.0 - gFine ) * 0.35 );
roughnessFactor = mix( roughnessFactor, 1.00, gEdge * 0.40 );
roughnessFactor = mix( roughnessFactor, 0.30, gWet );
roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );`)
        .replace('#include <normal_fragment_maps>', `vec3 gN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
vec3 gM = texture2D( normalMap, vNormalMapUv * 0.19 ).xyz * 2.0 - 1.0;
// Water fills the ripples in; packed run-off has been flattened by tyres.
vec2 gNxy = ( gM.xy * 0.55 + gN.xy * gFine ) * mix( 1.0, 0.30, max( gWet, gEdge * 0.7 ) );
normal = normalize( tbn * vec3( gNxy * normalScale, 1.0 ) );`);
    };
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

  /**
   * Boost strips, as decals painted on the road rather than slabs laid over it.
   *
   * Four things have to be true at once for a pad to work at 110 km/h, and the
   * previous version had none of them: it has to say which way to drive (hence
   * chevrons), it has to belong to the road surface (hence a feathered edge and
   * a pool of spill light), it has to say "speed" rather than "warning" (hence
   * a scroll along the direction of travel, not a brightness pulse), and it has
   * to accent the frame rather than own it (hence emissive confined to the
   * arrows and held below sky white).
   *
   * All pads on a track are merged into one buffer, and all their spill quads
   * into a second: the pads are static, share a material, and are 80 triangles
   * between them, so four meshes were four draw calls spent on nothing.
   */
  _buildBoostPads() {
    if (!this.track.boostPads.length) return;
    // Rainbow Skyway's road is emissive and is the brightest thing in its own
    // world, so a pad tuned to read against dark tarmac vanishes into it: the
    // weathered plate is part-transparent by design and lets a glowing road
    // straight through, and arms at tarmac brightness lose to a surface that
    // emits more than they do. Same decal, re-pitched for the surface it is
    // painted on — which is the same reason the asphalt carries a per-theme
    // tint a few methods up.
    const isNeon = this.theme.roadSurface === 'rainbow';
    const t = Tex.boostPad({
      size: 512,
      wear: isNeon ? 0.15 : 1,
      plate: isNeon ? BOOST_PLATE_NEON : BOOST_PLATE,
      plateAlpha: isNeon ? BOOST_PLATE_ALPHA_NEON : BOOST_PLATE_ALPHA,
    });
    // Chevrons are authored one per texture tile, and the tile is mapped to a
    // fixed number of metres of road — so every pad gets the same size arrow
    // regardless of its length, and the scroll is one shared texture offset
    // rather than per-pad bookkeeping.
    const mat = this._mat({
      map: t.map,
      emissiveMap: t.emissiveMap,
      alphaMap: t.alphaMap,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      emissive: 0xffffff,
      // Set against the sky, not in the abstract. The old pad ran at 2.4 across
      // its whole area and measured 1.2x the sky's luma — the single brightest
      // thing in frame, ahead of the player's own kart. The arms now cover 40%
      // of the pad, so this only has to light the arrows.
      emissiveIntensity: isNeon ? BOOST_EMISSIVE_NEON : BOOST_EMISSIVE,
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.5,
      transparent: true,
      // Vertex alpha carries the fade at the two ends; see below.
      vertexColors: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.boostPadMaterial = mat;
    this._boostMaps = [t.map, t.emissiveMap, t.alphaMap, t.normalMap, t.roughnessMap];

    const padParts = [];
    for (const pad of this.track.boostPads) padParts.push(this._boostPadStrip(pad));
    this._add(mergeStrips(padParts), mat, { receive: false, renderOrder: 3 }).name = 'boostPad';

    // The pool exists to put the arms' light onto the dark surface around them.
    // Rainbow Skyway has no dark surface — its road emits more than the pad does
    // — so there is nothing for a bounce to land on, and shot against a capture
    // with the pool hidden all it did was wash the ribbon pale and take the
    // chevrons' contrast with it. One surface, one reason, no pool here.
    if (isNeon) return;

    const ts = Tex.boostSpill({ size: 256, core: 1 / (1 + BOOST_SPILL_RATIO) });
    const spillMat = new THREE.MeshBasicMaterial({
      alphaMap: ts.alphaMap,
      color: BOOST_SPILL_TINT,
      transparent: true,
      // Additive, because this is light landing on the tarmac and not paint on
      // it: over dark asphalt it lifts and tints, and it can never draw an edge.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.materials.push(spillMat);

    const spillParts = [];
    for (const pad of this.track.boostPads) spillParts.push(this._boostSpillStrip(pad));
    this._add(mergeStrips(spillParts), spillMat, { receive: false, renderOrder: 2 }).name = 'boostPadSpill';
  }

  /** One pad's decal: positions, tiling chevron UVs, and an end-fade alpha. */
  _boostPadStrip(pad) {
    // 40 cm rings. The end fade is evaluated per vertex, so the rings have to
    // be finer than the fade is long or the ramp comes out as a visible facet.
    const steps = Math.max(8, Math.round(pad.length / 0.4));
    const cols = 4;
    const half = this.track.halfWidthAt(pad.s);
    const c = pad.lane * half;
    const w = pad.halfWidth;
    const n = steps + 1, m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const colors = new Float32Array(n * m * 4);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const along = (i / steps) * pad.length;
      const s = pad.s + along;
      // The leading edge was a hard straight line cutting across the road.
      // Fading in over a metre and a half is what turns it into a decal that
      // was sprayed on, and it costs nothing in gameplay — the trigger volume
      // in Track.isOnBoostPad is untouched.
      const fade = smoothstep(along / BOOST_END_FADE)
        * smoothstep((pad.length - along) / BOOST_END_FADE);
      for (let j = 0; j < m; j++) {
        const u = j / cols;
        this._point(s, c + lerp(-w, w, u), p);
        const k = (i * m + j) * 3;
        positions[k] = p.x; positions[k + 1] = p.y + 0.015; positions[k + 2] = p.z;
        const tt = (i * m + j) * 2;
        uvs[tt] = u; uvs[tt + 1] = along / BOOST_PITCH;
        const kc = (i * m + j) * 4;
        colors[kc] = colors[kc + 1] = colors[kc + 2] = 1;
        colors[kc + 3] = fade;
      }
    }
    return { positions, uvs, colors, n, m };
  }

  /** One pad's spill quad: a margin wider and longer, mapped 0..1 once. */
  _boostSpillStrip(pad) {
    const steps = Math.max(6, Math.round(pad.length / 1.0));
    const cols = 6;
    const half = this.track.halfWidthAt(pad.s);
    const c = pad.lane * half;
    const w = pad.halfWidth * (1 + BOOST_SPILL_RATIO);
    const marginS = pad.length * 0.5 * BOOST_SPILL_RATIO;
    const len = pad.length + marginS * 2;
    const n = steps + 1, m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = pad.s - marginS + (i / steps) * len;
      for (let j = 0; j < m; j++) {
        const u = j / cols;
        // Clamped to the kerb line: a glow pool that spilled onto the rumble
        // strip would read as the kerb being lit, not the road.
        const lat = clamp(c + lerp(-w, w, u), -(half - 0.4), half - 0.4);
        this._point(s, lat, p);
        const k = (i * m + j) * 3;
        positions[k] = p.x; positions[k + 1] = p.y + 0.010; positions[k + 2] = p.z;
        const tt = (i * m + j) * 2;
        uvs[tt] = u; uvs[tt + 1] = i / steps;
      }
    }
    return { positions, uvs, colors: null, n, m };
  }

  _buildStartLine() {
    // Four squares to the 3.2 m tile, so the checker is laid in 80 cm squares
    // and the strip is exactly four rows deep. It was ten, which is 32 cm — the
    // size of a bathroom tile, not of a start line — and at any distance past
    // the braking zone a 32 cm square is under a pixel, so the whole band
    // collapsed into moire and read as a grey mesh laid across the road. The
    // depth is unchanged: this only changes how the strip is divided up.
    const t = Tex.checker({ size: 512, squares: START_SQUARES });
    t.map.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      alphaMap: t.alphaMap,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      roughness: 1.0, metalness: 0.0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      envMapIntensity: 0.5,
    });
    this.materials.push(mat);
    const s0 = this.track.startS;
    const depth = START_DEPTH;
    const steps = 4;
    const sList = [];
    for (let i = 0; i <= steps; i++) sList.push(s0 - depth * 0.5 + (i / steps) * depth);

    // The line stops at the tarmac, not at the barrier. It was spanning the
    // full half-width, so on every track it ran out over the rumble strip and
    // onto the run-off — paint laid across a kerb no circuit would ever paint.
    const curbW = TRACK_LAYOUT.curbWidth;
    const cols = 12;
    const n = sList.length, m = cols + 1;
    const positions = new Float32Array(n * m * 3);
    const uvs = new Float32Array(n * m * 2);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const hw = this.track.halfWidthAt(sList[i]) - curbW;
      for (let j = 0; j < m; j++) {
        const u = j / cols;
        this._point(sList[i], lerp(-hw, hw, u), p);
        const k = (i * m + j) * 3;
        positions[k] = p.x; positions[k + 1] = p.y + 0.014; positions[k + 2] = p.z;
        const tt = (i * m + j) * 2;
        // Squares stay square in world space: one texture tile every 3.2 m on
        // both axes, which is also exactly the depth of the strip.
        uvs[tt] = u * (2 * hw / START_DEPTH); uvs[tt + 1] = i / (n - 1);
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
    const ground = new Float32Array(n * m * 2);
    const p = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const frame = {};
    const outward = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = sList[i];
      const half = this.track.halfWidthAt(s);
      const f = this.track.spline.frameAt(s, frame);
      // The road's own right vector is *banked* — up to 0.30 rad of roll on
      // this circuit. Riding it out to the far columns tilts the whole
      // landscape with the corner, and 260 m of lever arm turns 0.30 rad into a
      // 104 m rise (measured, canyonRush s=1077). Where the bank changes sign
      // between two corners the outer terrain therefore swings from +80 m to
      // -80 m over a few metres of arc, and what that draws is a several-
      // hundred-metre near-vertical face silhouetted against the sky. Land
      // beside a banked corner is not itself banked: past the barrier the
      // terrain leaves the road frame and goes out horizontally.
      outward.set(f.right.x, 0, f.right.z);
      if (outward.lengthSq() < 1e-8) outward.set(1, 0, 0);
      outward.normalize();
      // How far the inside of this corner can be offset before the surface
      // passes through the centre of curvature and turns itself inside out.
      // Corners here get down to a 36 m radius against a 260 m reach, so this
      // is not a corner case, it is most of the lap. Past the fold the winding
      // inverts and the triangles are culled, which is why the run-off simply
      // stopped and left the road ribbon hanging over the sea at sunsetCoast
      // and over open sky at canyonRush. The reach is *rescaled* rather than
      // clipped: clipping stacks every outer column on the fold line and the
      // quads between them span the whole infield as one flat sheet.
      // `side * curvature` is positive on the inside of the corner and negative
      // on the outside, and it passes through zero on a straight — so deriving
      // the reach from it directly is continuous, where testing which side is
      // "the inside" is not. That test flips at every corner exit, and a side
      // that jumps from a 12 m reach to a 260 m one between two rings 6.4 m
      // apart draws a sliver of terrain a hundred metres into the sky.
      // Verified against ring spacing: at canyonRush s=304 (R=36 m) consecutive
      // rings 30 m to the negative side are 1.04 m apart where the centreline
      // gives 6.4 m, so negative is the inside there and curvature is negative.
      const reachFor = (side) => {
        const kap = side * f.curvature;
        if (kap <= 1e-5) return TERRAIN_REACH;
        return Math.max(12, Math.min(TERRAIN_REACH, 0.86 / kap - wallOffset - half));
      };
      const reachL = reachFor(-1), reachR = reachFor(1);

      for (let j = 0; j < m; j++) {
        // Two-sided: columns run from far-left, across the track, to far-right.
        const u = j / cols;
        const side = u < 0.5 ? -1 : 1;
        const k01 = Math.abs(u - 0.5) * 2;                     // 0 at track, 1 far out
        const d = Math.pow(k01, 1.7) * (side < 0 ? reachL : reachR);
        this._point(s, side * (half + wallOffset), edge);
        const edgeY = edge.y;
        p.copy(edge).addScaledVector(outward, side * d);
        if (d > 0.5) p.y = profile(d, p.x, p.z, edgeY);
        else p.y = edgeY - 0.42;
        const kk = (i * m + j) * 3;
        positions[kk] = p.x; positions[kk + 1] = p.y; positions[kk + 2] = p.z;
        const t = (i * m + j) * 2;
        uvs[t] = p.x / 14; uvs[t + 1] = p.z / 14;
        // World height drives the damp band; the terrain starts a shoulder's
        // width out, so its "distance from the tarmac" carries that offset.
        ground[t] = p.y; ground[t + 1] = wallOffset + d;
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
    geo.setAttribute('aGround', new THREE.BufferAttribute(ground, 2));
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
    this._groundWear(mat, t, {
      tile: 14,
      waterLevel: isCoast && this.theme.water?.enabled ? waterLevel : null,
      cacheKey: 'terrain',
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
    if (this._boostMaps) {
      // Was a whole-pad brightness throb, which is the visual grammar of a
      // hazard light: it says "look at me", not "go faster". Sliding the
      // chevrons down the road instead says which way and how fast, and it is
      // the same cue every real-world arrow board uses. Negative because the
      // sampled V has to fall for the pattern to travel forward.
      const off = -time * BOOST_SCROLL;
      for (const m of this._boostMaps) m.offset.y = off;
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

/**
 * Concatenate open grid strips into one indexed geometry.
 *
 * The parts share a material and never move, so drawing them separately spends
 * a draw call per part on nothing. Unlike `_strip` these grids do *not* close
 * on themselves, so the index walk stops one row short rather than wrapping.
 */
function mergeStrips(parts) {
  let verts = 0, quads = 0;
  for (const p of parts) { verts += p.n * p.m; quads += (p.n - 1) * (p.m - 1); }
  const hasColor = parts[0].colors != null;
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const colors = hasColor ? new Float32Array(verts * 4) : null;
  const indices = new Uint32Array(quads * 6);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo * 3);
    uvs.set(p.uvs, vo * 2);
    if (colors) colors.set(p.colors, vo * 4);
    for (let i = 0; i < p.n - 1; i++) {
      for (let j = 0; j < p.m - 1; j++) {
        const i0 = vo + i * p.m + j, i1 = vo + (i + 1) * p.m + j;
        indices[io++] = i0; indices[io++] = i1; indices[io++] = i1 + 1;
        indices[io++] = i0; indices[io++] = i1 + 1; indices[io++] = i0 + 1;
      }
    }
    vo += p.n * p.m;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Rewrite the U channel of a road strip as a 0..1 span across the road. */
function remapU(geo, track, fn) {
  const uv = geo.attributes.uv;
  // The strip was generated with u = lat/6, v = s/6; recover both and
  // renormalise. (This read 4, so the seven bands used to stop short of the
  // road edge and the whole pattern crawled forward against the geometry.)
  for (let i = 0; i < uv.count; i++) {
    const lat = uv.getX(i) * 6;
    const s = uv.getY(i) * 6;
    const half = track.halfWidthAt(s);
    uv.setXY(i, fn(lat, half), s / 10);
  }
  uv.needsUpdate = true;
}
