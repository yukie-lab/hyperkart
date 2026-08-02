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
// How much of the distance from the barrier to a corner's centre of curvature
// the offset grid may use. At 1.0 the innermost column lands exactly on the
// centre and every quad around it is degenerate; past 1.0 the surface passes
// through the centre, the winding inverts, the triangles are back-face culled
// and the run-off simply stops in mid-air. This is the whole of that bug.
const FOLD_SAFETY = 0.86;
// Metres of clearance the innermost column keeps from that centre regardless.
const FOLD_CLEAR = 4;
// Metres the terrain's first column tucks *under* the run-off, on top of the
// per-ring chord allowance computed in `fitCorner`. The two surfaces are built
// at different arc resolutions, so they can only be joined by overlapping them.
const TERRAIN_LAP = 0.5;
// How far below the run-off's outer lip that tucked-under column sits. Big
// enough that the terrain's 6.4 m chord can never rise through the run-off's
// 1.6 m one, small enough to disappear behind a 1.6 m barrier.
const TERRAIN_SILL = 0.20;
// Rings of erosion-then-blur applied to the reach. Five rings is 32 m of arc,
// which is enough to bring the outer columns' sideways travel per ring under
// the ring spacing itself.
const REACH_SMOOTH = 5;
// The infield cap: a world-space grid, its cell size, and how far it is sunk
// below the road-space sheets so those win wherever they exist. 9 m is about
// the largest cell that still resolves the dune field it has to match.
const CAP_CELL = 9;
const CAP_SINK = 0.22;
// How far past the circuit's own bounding box the cap is generated. Only the
// *inside* of corners is ever short of ground — the outside always gets the
// full reach — so this only has to cover a hairpin's infield.
const CAP_MARGIN = 150;
const CURB_COLS = 6;          // enough columns to shape a crown and an outer lip
// Metres of kerb per texture tile, and stripes per tile. The product is the
// stripe length; splitting it this way is what makes the tile's texel density
// nearly square in world space. See the note on `Tex.curb` — an 8 m tile put
// the sampling footprint's long axis across the kerb, where there is nothing to
// resolve, and that is what made the stripes crawl.
//
// Two stripes to a 2 m tile made them a metre long on a strip 1.35 m wide, so
// each block was very nearly square and the kerb read as a barber's pole
// sixty pixels across — loud enough, at speed, to pull the eye off the racing
// line it is supposed to frame. Real rumble strips, and every kart game that
// has ever shipped, run half-metre blocks: three to one against the kerb's own
// width, which is what makes them read as a *rhythm* rather than as chequers.
const CURB_TILE = 2;
const CURB_STRIPES = 4;

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
   * @param {{facing?:'up'|'down'}} [opts] Which way the finished surface faces.
   */
  _strip(sList, latA, latB, cols, uvFn, yOffset = null, extra = null, opts = {}) {
    const n = sList.length;
    const m = cols + 1;
    // Which way the triangles come out depends on whether `u` runs along +right
    // or -right, and every strip on this circuit is built twice — once per side
    // — with `lat = side * something`. So on the negative side `u` runs
    // backwards and the whole surface is generated inside out. Both the left
    // kerb and the *entire left run-off* were built that way and were being
    // back-face culled: measured 0 of 7104 shoulder triangles facing up, which
    // is why hiding them changed nothing a critic could attribute and why the
    // kerb at sunsetCoast photographed as a ribbon of zero thickness with open
    // sea on both sides. There was no ground beside it, on that side, anywhere.
    const h0 = this.track.halfWidthAt(sList[0]);
    // A strip with no lateral span at all is the barrier: vertical, two-sided,
    // and with no "up" to get wrong. Left exactly as it was.
    const span = latB(sList[0], h0) - latA(sList[0], h0);
    const flip = span !== 0 && (span > 0) !== (opts.facing !== 'down');
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
        const [uu, vv] = uvFn(u, s, lat, half, p);
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
        const a = i0 + j, b = i1 + j, c = i1 + j + 1, d = i0 + j + 1;
        if (flip) {
          indices[ptr++] = a; indices[ptr++] = c; indices[ptr++] = b;
          indices[ptr++] = a; indices[ptr++] = d; indices[ptr++] = c;
        } else {
          indices[ptr++] = a; indices[ptr++] = b; indices[ptr++] = c;
          indices[ptr++] = a; indices[ptr++] = c; indices[ptr++] = d;
        }
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
      shader.uniforms.uRoadFar = { value: tex.meanColor ?? new THREE.Color(0.07, 0.07, 0.08) };

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
uniform vec3 uRoadFar;

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

// How much of the 6 m tile is still worth showing. A 3.5 cm chipping is worth
// about a pixel at thirty metres, and a pattern crossing that line at full
// contrast is what boiling *is* — measured at 21% of far-road pixels swinging
// past 16/255 in one 8.3 ms step, against 2.4% for the sky. Converging to the
// tile's own mean before it gets there is what a perfect filter would have
// produced anyway. A quarter of the tile is left in: two mips down it is
// already smooth, and taking it to nothing turns the far road into a plane.
// Everything below this point is authored in *road* space and is
// low-frequency in world space, so none of it can alias however far away it is
// — which is the whole reason the storytelling lives here and not in the tile.
float rFine = 1.0 - smoothstep( 4.0, 30.0, rDist );
diffuseColor.rgb = mix( uRoadFar, diffuseColor.rgb, 0.26 + 0.74 * rFine );

// Resurfacing patches, as a warped cell grid so the repairs come out as
// irregular quads with tarred seams rather than a checkerboard.
vec2 rCell = vec2( rLat, rArc ) / 13.0;
rCell += ( vec2( hkNoise( rCell * 1.7 ), hkNoise( rCell * 1.7 + 5.3 ) ) - 0.5 ) * 0.7;
vec2 rCellId = floor( rCell ) + 0.5;
float rPatch = step( 0.68, hkHash( rCellId ) );
vec2 rF = fract( rCell );
float rSeamD = min( min( rF.x, 1.0 - rF.x ), min( rF.y, 1.0 - rF.y ) );
// A 15 cm seam is sub-pixel well before it is out of sight, so widen it in
// screen space rather than letting it break into a dotted line.
float rSeam = rPatch * ( 1.0 - smoothstep( 0.0, max( 0.010, fwidth( rSeamD ) * 1.6 ), rSeamD ) );
rPatch *= smoothstep( 0.0, 0.05, rSeamD );

// Second sample of the same tile six times larger, pivoted on the tile's own
// mean so it adds 35 m of tonal drift without moving the road's brightness.
// A repair is a different batch of asphalt, not the same batch a shade darker,
// so inside a patch that large sample is taken from somewhere else entirely —
// which is what makes a seam read as two surfaces meeting rather than as a
// line drawn on one.
vec2 rMacroUv = vMapUv * 0.17
  + rPatch * ( vec2( hkHash( rCellId + 11.0 ), hkHash( rCellId + 23.0 ) ) - 0.5 ) * 2.6;
// Held to half of what it was. At full strength this is a cloud field metres
// across with no cause behind it — the "irregular dark blotches" of the
// review — and cloud with no cause is the oldest procedural-texture tell there
// is. Large-scale tone on a circuit comes from things that *happened* to it,
// which is what everything below this line is.
float rMacro = dot( texture2D( map, rMacroUv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.rgb *= mix( 1.0, rMacro / uBaseLuma, 0.17 );

// The circuit was laid in screeds a paver wide. Every joint between two of them
// is a cold joint that has opened a little and collected dirt, and it runs
// *along* the road — the one direction almost nothing else on this surface
// runs in, and the reason tyre wear on a real circuit never reads as crosswise
// noise. The lane boundaries wander slowly so they never look ruled.
float rScreed = rLat / 3.6 + 0.22 * hkNoise( vec2( rArc * 0.012, 0.0 ) );
float rScreedF = fract( rScreed );
float rJointD = min( rScreedF, 1.0 - rScreedF );
float rJoint = 1.0 - smoothstep( 0.0, max( 0.014, fwidth( rJointD ) * 1.6 ), rJointD );
float rBatch = hkHash( vec2( floor( rScreed ), 0.5 ) );

// Rubber only lays down where the cars actually drive, and that band wanders
// across the road with the corners instead of sitting dead centre.
float rLineC  = 0.30 * sin( rArc * 0.0295 ) + 0.16 * sin( rArc * 0.0113 + 1.9 );
float rWander = abs( rLane - rLineC );
float rRacing = 1.0 - smoothstep( 0.14, 0.76, rWander );
rRacing *= 0.70 + 0.30 * hkNoise( vec2( rArc * 0.05, 0.0 ) );
// The core of that band is *polished*, not merely dirty: a season of traffic
// fills the voids between the chippings and leaves a strip you can see the sun
// in. It is the single feature every photograph of a circuit has and this road
// did not, and it costs one smoothstep.
float rPolish = ( 1.0 - smoothstep( 0.0, 0.32, rWander ) ) * rRacing;

// The last metre before the kerb never gets driven on: bleached, open
// aggregate, with dust and marbles swept into the very edge. Kept to the
// last metre — any wider and it reads as a concrete gutter, not as wear.
float rEdge  = smoothstep( 0.74, 1.0, abs( rLane ) );
float rDirt  = smoothstep( 0.86, 1.0, abs( rLane ) );

diffuseColor.rgb *= mix( 0.975, 1.025, rBatch );
diffuseColor.rgb *= mix( 1.0, 0.72, rRacing );
diffuseColor.rgb *= mix( 1.0, 0.86, rPolish );
diffuseColor.rgb *= mix( 1.0, 1.15, rEdge );
diffuseColor.rgb  = mix( diffuseColor.rgb, diffuseColor.rgb * 0.94 + uGrime * 0.06, rDirt );
diffuseColor.rgb *= mix( 1.0, 0.90, rPatch );
diffuseColor.rgb *= mix( 1.0, 0.58, rSeam );
diffuseColor.rgb *= mix( 1.0, 0.74, rJoint );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
// Relief that has fallen off the end of the mip chain still scatters light, and
// with the fine normal now retired by thirty metres this is where that energy
// has to go instead. Not all the way to 1.0: that also kills the long sun sheen
// that sells dry tarmac.
roughnessFactor = mix( roughnessFactor, 0.94, ( 1.0 - rFine ) * 0.55 );
roughnessFactor = mix( roughnessFactor, 0.56, rRacing * 0.80 );
roughnessFactor = mix( roughnessFactor, 0.44, rPolish * 0.75 );
roughnessFactor = mix( roughnessFactor, 0.98, rEdge * 0.35 );
roughnessFactor = mix( roughnessFactor, 0.52, rSeam );
roughnessFactor = mix( roughnessFactor, 0.88, rJoint * 0.6 );
roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );`)
        .replace('#include <normal_fragment_maps>', `vec3 rMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
vec3 rMacN = texture2D( normalMap, vNormalMapUv * 0.17 ).xyz * 2.0 - 1.0;
// Two scales: the 35 m sample carries settlement and rutting and can never
// alias, the 6 m sample carries the chippings and is gone by thirty metres,
// where a chipping is worth a pixel. This fade used to run 8-44 m, and 44 m is
// well past the distance at which the chippings stop being resolvable — which
// is exactly why the far road was the least stable thing in the frame. Rubber
// fills the voids on the racing line, so the relief there is flattened too.
vec2 rN = rMacN.xy * 0.34 + rMapN.xy * rFine * mix( 1.0, 0.35, rRacing );
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
// converged to the average is just a kerb going soft with distance. Half-metre
// blocks reach that line sooner than metre-long ones did, so the fade comes in
// earlier — but only somewhat. Scaling it strictly with the stripe length put
// the start at 24 m, and a kerb that has gone pink by the time it is thirty
// metres away is a worse defect than the crawl: measured by orbiting a corner
// at 30 m, which is inside a normal chase camera's view of the next apex.
float kFar = smoothstep( 38.0, 92.0, kDist );
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
    this._groundWear(mat, t, { tile: 14, cacheKey: 'shoulder' });

    for (const side of [-1, 1]) {
      const geo = this._strip(
        rings,
        (s, half) => side * half,
        (s, half) => side * (half + shoulderW),
        4,
        // World XZ at the terrain's own tile, not road space at a tile of its
        // own. The run-off and the land past the barrier are the same sand or
        // the same dirt — the *same cached texture object* — yet the apron was
        // laid out in road space at a 5 m tile, so its grain ran with the
        // circuit instead of with the ground and its macro re-sample took one
        // fixed slice of the map for the entire lap. That is why a strip of
        // beach immediately beside the road read as a separate grey material
        // laid over it. Sharing the terrain's projection makes the join
        // disappear, and it is also what `_groundWear`'s slope re-projection
        // has assumed all along.
        (u, s, lat, half, p) => [p.x / 14, p.z / 14],
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
    // The only surface here that is *meant* to face down.
    const under = this._strip(
      rings,
      (s, half) => half,
      (s, half) => -half,
      ROAD_COLS,
      (u, s, lat) => [lat / 6, s / 6],
      () => -0.55,
      null,
      { facing: 'down' },
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

  /**
   * Everything outside the barrier, as two road-space sheets plus a cap.
   *
   * The sheets are offset grids: each ring steps sideways from the road's own
   * frame, which is what makes the run-off follow the circuit. That construction
   * has one hard limit — an offset curve folds through itself as soon as it is
   * pushed past the centre of curvature — and the limit bites on most of this
   * lap, not at some pathological corner. So the sheets are clamped short of
   * the centre, and what they can no longer cover is closed by a cap built in
   * world space, which has no centre of curvature to fold through.
   */
  _buildTerrain() {
    const n = Math.max(48, Math.round(this.track.length / TERRAIN_STEP));
    const noise = makeValueNoise2D(this.theme.key === 'coast' ? 1201 : 3307, 256);
    const isCoast = this.theme.key === 'coast';
    // Sea level follows the circuit's lowest point, never a fixed constant.
    const waterLevel = this.track.waterLevel;
    const wallOffset = TRACK_LAYOUT.shoulderWidth;
    const sp = this.track.spline;

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

    /**
     * The one height field both the sheets and the cap sample.
     *
     * `profile` on its own starts a metre below the barrier's foot on the
     * canyon and a metre *above* it on the coast, so joining it straight onto
     * the run-off leaves a step. The first metre and a half is therefore blended
     * back to the run-off's own outer lip, and under the run-off (d <= 0) it is
     * that lip dropped by a sill. Two meshes agreeing on one function is what
     * lets the cap close the sheets' gaps without drawing a seam.
     */
    const groundY = (d, worldX, worldZ, edgeY) => {
      const t = smoothstep(d / 1.5);
      const lip = edgeY - 0.42 - TERRAIN_SILL * (1 - t);
      return t <= 0 ? lip : lerp(lip, profile(d, worldX, worldZ, edgeY), t);
    };

    /**
     * What a corner allows: how far this side may reach, and how far its first
     * column has to tuck under the run-off.
     *
     * `side * curvature` is positive on the inside of the corner and negative
     * on the outside, and passes through zero on a straight — so deriving both
     * numbers from it is continuous, where testing which side is "the inside"
     * is not. That test flips at every corner exit, and a side that jumps from
     * a short reach to a long one between two rings 6.4 m apart draws a sliver
     * of terrain a hundred metres into the sky.
     *
     * The reach is *rescaled*, not clipped: clipping stacks every outer column
     * on the fold line and the quads between them span the whole infield as one
     * flat sheet. The previous pass rescaled but then floored the result at
     * 12 m, which put the fold straight back at every corner tighter than about
     * 45 m radius — sunsetCoast gets down to 20 m and canyonRush to 36 — and
     * that floor is what was still folding the sheet across the road.
     */
    const fitCorner = (curvature, half, side) => {
      const kap = side * curvature;
      if (kap <= 1e-5) return { reach: TERRAIN_REACH, inset: TERRAIN_LAP };
      // Distance from the barrier line to the corner's centre of curvature.
      const r = Math.max(1 / kap - (half + wallOffset), 0);
      return {
        // Two limits, because a proportional one alone is not enough: 14% of a
        // 12 m radius leaves the outermost column orbiting the centre at 1.7 m,
        // where the ring-to-ring step is 40 cm and any wobble in the width or
        // the reach flips it. An absolute clearance takes over as soon as the
        // corner is tight enough for that to matter.
        reach: Math.min(TERRAIN_REACH, Math.max(0, Math.min(r * FOLD_SAFETY, r - FOLD_CLEAR))),
        // Terrain rings are four times coarser than the run-off's, so on the
        // inside of a corner the chord between two of them bows outward of the
        // run-off's edge by L^2/8r — 0.6 m at sunsetCoast's tightest hairpin,
        // which is a 0.6 m slot of open sky between two surfaces that are
        // nominally coincident. Pulling the inner column in by that much plus a
        // margin makes the two overlap at every radius instead.
        inset: TERRAIN_LAP + (TERRAIN_STEP * TERRAIN_STEP) / (8 * Math.max(r, 1)),
      };
    };

    // Reach is a hyperbola in curvature, so where a long corner opens onto a
    // straight it swings by hundreds of metres over two or three rings — and the
    // far columns then travel sideways faster than the rings travel forward,
    // which shears the outer quads and at the extremes inverts them anyway.
    // (Measured: 82 inverted triangles left on sunsetCoast with the fold itself
    // already fixed, scattered out at 80-270 m where radii run into the
    // thousands.) Eroding to the local minimum before blurring keeps the result
    // at or below the fold-safe value at every single ring, which a blur alone
    // would not, while making it a smooth function of arc length.
    const frame = {};
    const reach = [new Float32Array(n), new Float32Array(n)];
    const inset = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const f = sp.frameAt((i / n) * this.track.length, frame);
      const half = f.width * 0.5;
      for (let q = 0; q < 2; q++) {
        const fit = fitCorner(f.curvature, half, q === 0 ? -1 : 1);
        reach[q][i] = fit.reach;
        inset[q][i] = fit.inset;
      }
    }
    for (let q = 0; q < 2; q++) reach[q] = blurRing(erodeRing(reach[q], REACH_SMOOTH), REACH_SMOOTH);
    // Sampled by the cap too, so both meshes agree on where the sheets stop.
    const reachAt = (s, side) => {
      const a = reach[side < 0 ? 0 : 1];
      const fi = mod(s / this.track.length, 1) * n;
      const i0 = Math.floor(fi);
      return lerp(a[i0 % n], a[(i0 + 1) % n], fi - i0);
    };

    // -- the two road-space sheets -------------------------------------------
    // One block of columns per side, with no quad spanning the road. The old
    // grid ran one column set straight across the circuit and dropped the two
    // quads over the tarmac, which left its innermost land 4.4 m clear of the
    // barrier: a 4.4 m slot of missing ground running the entire lap on both
    // sides, and the hole the wall was photographed floating over.
    const cols = TERRAIN_COLS / 2;
    const m = cols + 1;
    const ring = m * 2;
    const positions = new Float32Array(n * ring * 3);
    const uvs = new Float32Array(n * ring * 2);
    const ground = new Float32Array(n * ring * 2);
    const p = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const outward = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = (i / n) * this.track.length;
      const half = this.track.halfWidthAt(s);
      const f = sp.frameAt(s, frame);
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

      for (let q = 0; q < 2; q++) {
        const side = q === 0 ? -1 : 1;
        this._point(s, side * (half + wallOffset), edge);
        const edgeY = edge.y;
        for (let k = 0; k <= cols; k++) {
          const d = k === 0 ? -inset[q][i] : Math.pow(k / cols, 1.7) * reach[q][i];
          p.copy(edge).addScaledVector(outward, side * d);
          p.y = groundY(d, p.x, p.z, edgeY);
          // The left block is stored outermost-first so that both blocks wind
          // the same way round — otherwise the left half renders back-facing.
          const j = side < 0 ? cols - k : m + k;
          const kk = (i * ring + j) * 3;
          positions[kk] = p.x; positions[kk + 1] = p.y; positions[kk + 2] = p.z;
          const t = (i * ring + j) * 2;
          uvs[t] = p.x / 14; uvs[t + 1] = p.z / 14;
          // World height drives the damp band; the terrain starts a shoulder's
          // width out, so its "distance from the tarmac" carries that offset.
          ground[t] = p.y; ground[t + 1] = wallOffset + Math.max(d, 0);
        }
      }
    }

    const idx = [];
    for (let i = 0; i < n; i++) {
      const i0 = i * ring, i1 = ((i + 1) % n) * ring;
      for (let block = 0; block < 2; block++) {
        const b = block * m;
        for (let j = b; j < b + cols; j++) {
          idx.push(i0 + j, i1 + j, i1 + j + 1, i0 + j, i1 + j + 1, i0 + j + 1);
        }
      }
    }

    const cap = this._infieldCap(groundY, reachAt, wallOffset);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(concatF32(positions, cap.positions), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(concatF32(uvs, cap.uvs), 2));
    geo.setAttribute('aGround', new THREE.BufferAttribute(concatF32(ground, cap.ground), 2));
    const base = positions.length / 3;
    const index = new Uint32Array(idx.length + cap.index.length);
    index.set(idx, 0);
    for (let i = 0; i < cap.index.length; i++) index[idx.length + i] = cap.index[i] + base;
    geo.setIndex(new THREE.BufferAttribute(index, 1));
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

  /**
   * Ground for everywhere the offset sheets structurally cannot reach.
   *
   * A road-space grid tiles a band either side of the circuit. Inside a corner
   * tighter than that band is wide there is simply no way to lay one down — the
   * columns would have to pass through the centre of curvature and come back
   * out the far side — so the infield of every hairpin is bare, and clamping
   * the sheets (which is the only correct thing to do about the fold) makes
   * more of it bare, not less. The fix cannot be another road-space surface.
   *
   * So: a plain axis-aligned grid in world space. It samples the same height
   * field the sheets do, so the two surfaces agree wherever they meet; it is
   * dropped a hand's width so the sheets — which are four times finer near the
   * road — win every overlap; and it is only emitted where the sheets fall
   * short, which on these two circuits is a few hundred quads rather than a
   * second terrain.
   */
  _infieldCap(groundY, reachAt, wallOffset) {
    const sp = this.track.spline;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.pos[i * 3], z = sp.pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const x0 = Math.floor((minX - CAP_MARGIN) / CAP_CELL) * CAP_CELL;
    const z0 = Math.floor((minZ - CAP_MARGIN) / CAP_CELL) * CAP_CELL;
    const nx = Math.ceil((maxX + CAP_MARGIN - x0) / CAP_CELL) + 1;
    const nz = Math.ceil((maxZ + CAP_MARGIN - z0) / CAP_CELL) + 1;

    /**
     * Nearest centreline sample in *plan* view.
     *
     * `spline.project` weights vertical distance, which is right for a kart and
     * wrong for a column of air over a circuit that climbs 25 m — it would
     * happily match a point to a piece of road running 20 m underneath it.
     */
    const nearestIndex = (x, z) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < sp.count; i += 3) {
        const dx = x - sp.pos[i * 3], dz = z - sp.pos[i * 3 + 2];
        const dd = dx * dx + dz * dz;
        if (dd < bestD) { bestD = dd; best = i; }
      }
      for (let i = best - 3; i <= best + 3; i++) {
        const j = mod(i, sp.count);
        const dx = x - sp.pos[j * 3], dz = z - sp.pos[j * 3 + 2];
        const dd = dx * dx + dz * dz;
        if (dd < bestD) { bestD = dd; best = j; }
      }
      return best;
    };

    const count = nx * nz;
    const y = new Float32Array(count);
    const out = new Float32Array(count);
    const need = new Uint8Array(count);
    const inside = new Uint8Array(count);
    const frame = {};
    const edge = new THREE.Vector3();

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = x0 + ix * CAP_CELL, z = z0 + iz * CAP_CELL;
        const s = nearestIndex(x, z) * sp.ds;
        const f = sp.frameAt(s, frame);
        const half = f.width * 0.5;
        let rx = f.right.x, rz = f.right.z;
        const rl = Math.hypot(rx, rz) || 1;
        rx /= rl; rz /= rl;
        const lateral = (x - f.pos.x) * rx + (z - f.pos.z) * rz;
        const side = lateral < 0 ? -1 : 1;
        const d = Math.abs(lateral) - (half + wallOffset);
        this._point(s, side * (half + wallOffset), edge);
        let gy = groundY(d, x, z, edge.y);
        if (d < 0) {
          // This cell is over the circuit itself. The height field is anchored
          // on the barrier's foot, and on a 0.30 rad banked corner that foot
          // stands nearly four metres above the road beside it — so following
          // the field inward drives the cap up through the tarmac and paints a
          // wedge of sand across the racing line. Under the circuit the cap
          // follows the road's own banked plane and stays beneath it.
          gy = Math.min(gy, this._point(s, lateral, edge).y - 0.62);
        }
        const k = iz * nx + ix;
        y[k] = gy - CAP_SINK;
        out[k] = wallOffset + Math.max(d, 0);
        // A cell and a half of slack on both tests, so the cap always starts
        // *under* the sheet rather than butting against its edge.
        need[k] = d > reachAt(s, side) - CAP_CELL * 1.5 ? 1 : 0;
        inside[k] = d < TERRAIN_REACH - CAP_CELL * 1.5 ? 1 : 0;
      }
    }

    const remap = new Int32Array(count).fill(-1);
    const positions = [], uvs = [], groundAttr = [], index = [];
    const emit = (k) => {
      if (remap[k] >= 0) return remap[k];
      const ix = k % nx, iz = (k - ix) / nx;
      const x = x0 + ix * CAP_CELL, z = z0 + iz * CAP_CELL;
      const v = positions.length / 3;
      positions.push(x, y[k], z);
      uvs.push(x / 14, z / 14);
      groundAttr.push(y[k], out[k]);
      remap[k] = v;
      return v;
    };

    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix, b = (iz + 1) * nx + ix;
        const c = (iz + 1) * nx + ix + 1, e = iz * nx + ix + 1;
        if (!(need[a] || need[b] || need[c] || need[e])) continue;
        if (!(inside[a] && inside[b] && inside[c] && inside[e])) continue;
        const va = emit(a), vb = emit(b), vc = emit(c), ve = emit(e);
        // Wound so the face normal comes out +Y, matching every other ground
        // surface here; the reverse order renders the cap only from below.
        index.push(va, vb, vc, va, vc, ve);
      }
    }

    return {
      positions: new Float32Array(positions),
      uvs: new Float32Array(uvs),
      ground: new Float32Array(groundAttr),
      index,
    };
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

/** Ring-buffer minimum filter: never returns more than the input allowed. */
function erodeRing(src, r) {
  const n = src.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    for (let k = -r; k <= r; k++) lo = Math.min(lo, src[mod(i + k, n)]);
    out[i] = lo;
  }
  return out;
}

/** Ring-buffer box blur. Radius must not exceed the erosion's, or the result
 *  can rise back above the input at a local minimum. */
function blurRing(src, r) {
  const n = src.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[mod(i + k, n)];
    out[i] = sum / (2 * r + 1);
  }
  return out;
}

/** Join two vertex buffers of the same item size into one. */
function concatF32(a, b) {
  if (!b || !b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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
