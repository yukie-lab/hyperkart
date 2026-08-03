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
const START_SQUARES = 5;
// Was 3.2 m, which is 4-5 pixels tall from the back of the grid — measured, the
// whole band lifted that stretch of road by 11 luma out of 255, which is not a
// start line, it is a smudge. A real start/finish band is 4-6 m deep for the
// same reason: it has to be legible from a standing start thirty metres back.
// The square size is held at ~0.9 m, so this only adds a row.
const START_DEPTH = 4.6;
// Metres of solid white timing stripe along each edge of that band. This is the
// mark that survives distance: 90 cm chequers mip to a mid grey by fifty metres
// and a mid grey on tarmac is nothing, but a 45 cm line running the full width
// of the road is still a line, and two of them bound the band into an object.
const START_EDGE = 0.45;

// Painted grid boxes. Twelve is the largest field this game runs, and a circuit
// paints its boxes whether or not anyone turns up to fill them.
const GRID_SLOTS = 12;
// Box width and length in metres, and how far the staging bar sits ahead of the
// slot `Track.startGrid` actually places a kart at — far enough that the kart's
// nose is inside its own box rather than parked on the line.
const GRID_BOX_W = 2.9;
const GRID_BOX_L = 4.6;
const GRID_BOX_AHEAD = 1.5;
// Line widths in metres. 16 cm and 44 cm were chosen as "twice a lane marking"
// and were not: `Tex.laneMarkings` lays its edge lines at a half-width of 1.6%
// of the road, and this circuit's start/finish straight is 19 m, so those
// strokes are around 30 cm. The grid was painted *thinner* than the markings it
// had to be told apart from, in the same white and the same film — which is
// most of why a reviewer could not tell them apart. Both are now clearly
// heavier than anything else on the tarmac, which is what every circuit on
// earth does and for the same reason.
const GRID_LINE = 0.34;
const GRID_BAR = 0.70;
// The dark keyline packed against the inside of every stroke. Value contrast is
// local, not absolute: a white line on tarmac is a 60-luma step and the same
// line with rubber against it is a 200-luma one, which is the difference
// between a mark a reviewer had to hide to find and one they cannot miss.
const GRID_KEY = 0.10;
// Cap height of the painted position number, in metres. Sized against the box
// rather than the screen: 1.55 m fills the clear ground behind where a kart
// stands, which is the only part of a grid box still visible when the grid is
// full.
const GRID_NUM_H = 1.55;

// -- run-off detail ----------------------------------------------------------
// Metres of world to one tile of `Tex.groundDetail`, at the two scales the
// ground samples it. The fine one puts 2-5 cm stones under the kart; the coarse
// one is the same map stretched four and a half times, which turns the same
// stones into the 12-25 cm scatter that carries the middle distance. Two taps
// of one map rather than two maps: gravel *is* the coarse fraction of the same
// material, and grading it separately would be authoring two lies where one
// truth tiles.
const DETAIL_TILE = 1.15;
const DETAIL_TILE_MID = 5.2;
// The finest wavelength each of those tiles carries, in metres. These are the
// numbers the shader retires each layer on, so they have to be the *finest*
// content and not the average — a layer faded on its average wavelength spends
// half its life aliasing.
const DETAIL_LAMBDA = 0.030;
const DETAIL_LAMBDA_MID = 0.135;
// The gravel band, in metres out from the kerb's outer lip. A trap does not
// start at the kerb — the first hand's width is fines banked against it — and
// on a real circuit it runs two to four metres before the ground reverts.
const GRAVEL_IN = 0.30;
const GRAVEL_OUT = 3.3;
// Columns across the 6.5 m apron. See `_buildShoulders`.
const SHOULDER_COLS = 8;

// -- barriers ----------------------------------------------------------------
// Cross-section of the barrier, walked from the track-facing foot, up the inner
// face, over the cap, and down the outside. Lateral offsets are metres from the
// barrier line; heights are fractions of `TRACK_LAYOUT.wallHeight`, so a track
// that wants a taller barrier gets a taller one and not a stretched one.
//
// The previous barrier was a single vertical strip with `side: DoubleSide` and
// nothing else: a triangle census found 5328 faces per wall and **0 of them
// facing up**, which is a precise way of saying it had no thickness anywhere on
// the circuit. What that draws, from a chase camera, is a flat ribbon of paint
// terminating in a two-pixel trim line — and two pixels is the one feature
// width that neither the mip chain nor the AA resolve can hold still. It was
// also the last surface here whose winding carried no information, so it took
// its lighting from which way a triangle happened to face rather than from a
// normal that meant anything.
//
// The cap overhangs the faces by 9 cm on purpose. That overhang is what puts a
// shadow line under the top edge, and that shadow line is the entire reason an
// extruded barrier reads as an object rather than as a strip.
const WALL_PROFILE = [
  [-0.17, -0.060],   // inner foot, buried under the run-off so the join is not a seam
  [-0.17, 0.900],
  [-0.26, 0.9375],   // cap lip, flaring out over the face
  [-0.26, 1.000],
  [0.26, 1.000],
  [0.26, 0.9375],
  [0.17, 0.900],
  [0.17, -0.190],    // outer foot, buried in the terrain, which sits a sill lower
];
// Metres of barrier between cross-sections. Coarser than the road's 1.6 m
// because a barrier is a straight-edged object and 2.4 m of chord bows by 3.5 cm
// on this circuit's tightest corner — a third of the section's own thickness.
const WALL_STEP = 2.4;
// Metres of barrier per bolted panel. Real crash barrier arrives in four metre
// sections, and the joint between two of them is the cheapest mark on this
// surface that says the run was built rather than drawn.
const WALL_PANEL = 4.0;
// Support posts: metres between them, then width outward from the barrier's
// outer face, thickness along the run, and top/bottom as fractions of the wall
// height. The top stops short of the cap so the cap visibly overhangs it.
const POST_GAP = 5.4;
const POST_W = 0.20, POST_D = 0.14, POST_TOP = 0.81, POST_BASE = -0.22;

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
    // A road that emits its own light does not take a shadow. Rainbow Skyway
    // runs at emissiveIntensity 1.35 and is the brightest thing in its own
    // frame, but it was still receiving the karts' shadow multiply — so the
    // twelve brightest metres of the circuit carried grey smudges that read as
    // dirt on a light source. Asphalt keeps its shadows; the light strip does
    // not.
    this.road = this._add(geo, mat, { receive: !isRainbow });
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

  /**
   * The off-track surface this circuit is laid in.
   *
   * Cached by `ProcTex`, so every caller gets the same object — which matters
   * because the kerb has to know the colour of the ground that spills onto it,
   * and taking that from the theme hex instead would be a second opinion about
   * a surface that already has one.
   */
  _groundTex() {
    const fn = this.theme.shoulder === 'dirt' ? Tex.dirt
      : this.theme.shoulder === 'sand' ? Tex.sand
      : Tex.grass;
    return fn({ size: 1024, tint: this.theme.groundColor });
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
   *
   * It also owns half of the kerb-to-run-off join. The two surfaces meet at
   * exactly the same height and were still photographing as a hard geometric
   * edge, because agreeing on a height is not a transition — nothing crossed
   * the line in either direction. The ground banks against the kerb's foot in
   * `_groundWear`; the ground climbing *over* the outer roll belongs here,
   * where the kerb's own coordinates are.
   */
  _curbWear(mat, tex) {
    mat.customProgramCacheKey = () => 'hk-curb';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCurbFar = { value: tex.meanColor ?? new THREE.Color(0.4, 0.3, 0.3) };
      // The run-off's own mean, in linear light, rather than the theme hex: the
      // spill has to be the colour of the ground beside this kerb and not of an
      // idea about it. Half of it, because a tongue of sand over concrete is
      // thin enough to still read as concrete underneath.
      shader.uniforms.uCurbDirt = {
        value: (this._groundTex().meanColor ?? new THREE.Color(0.25, 0.2, 0.14)).clone(),
      };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aCurb;
varying vec2 vCurb;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vCurb = aCurb;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vCurb;
uniform vec3 uCurbFar;
uniform vec3 uCurbDirt;`)
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
diffuseColor.rgb *= mix( 1.0, 0.62, kRub );

// Run-off climbing over the outer roll. Every kart that rejoins drags some of
// it up, the wind moves the rest, and where it lands the kerb is buried rather
// than dirty — which is the difference between a kerb that ends at a line and a
// kerb that ends in the ground.
//
// Three incommensurate periods, the shortest at ten metres, so one corner shows
// both buried stretches and clean ones: a single period long enough to see the
// whole of is a kerb that is uniformly dirty, which is a texture and not a
// history. Weighted onto the outer third, because that is the only part of the
// section low enough for anything to climb, and deliberately *not* faded with
// distance — a boundary between two materials is the lowest-frequency thing on
// this surface and it is what should still be there when the stripes are not.
float kSpillW = 0.5 + 0.28 * sin( kArc * 0.2090 + 1.3 ) + 0.22 * sin( kArc * 0.0759 )
              + 0.16 * sin( kArc * 0.6130 + 0.4 );
float kSpill = smoothstep( 0.56, 1.04, kU + ( kSpillW - 0.5 ) * 0.34 );
diffuseColor.rgb = mix( diffuseColor.rgb, uCurbDirt * 1.20, kSpill * 0.76 );
// The last centimetres are under the lip and never see the sun. That contact
// line is what plants the kerb in the ground, the same way the barrier's cap
// overhang is what makes the barrier an object.
float kFoot = smoothstep( 0.86, 1.0, kU );
diffuseColor.rgb *= mix( 1.0, 0.60, kFoot );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp( mix( roughnessFactor, 0.99, max( kRub * 0.7, kSpill * 0.85 ) ), 0.05, 1.0 );`)
        // Chipped paint and coarse concrete are millimetres of relief. Once
        // they stop resolving the normal map only supplies specular sparkle,
        // which crawls for the same reason the albedo did. Sand fills that
        // relief in where it lies, so the spill flattens it too.
        .replace('#include <normal_fragment_maps>', `vec3 kMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
normal = normalize( tbn * vec3( kMapN.xy * normalScale * ( 1.0 - kFar ) * ( 1.0 - kSpill * 0.55 ), 1.0 ) );`);
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
    const t = this._groundTex();
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
        // Four columns over 6.5 m put the apron's fall-away ramp on 1.6 m
        // facets, and the first of them spanned the whole gravel band and the
        // kerb's contact shadow with two vertex normals. Eight is 14k triangles
        // on a mesh that is still one draw call, and it is the near band of the
        // largest surface in the frame.
        SHOULDER_COLS,
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
   * Four jobs, all of which need to know where a fragment is in the *world*
   * rather than in its tile:
   *
   *  - Stay quiet. This is the run-off. It is 30-40% of most frames, it is the
   *    surface the player must not be on, and every kart racer that has shipped
   *    keeps it deliberately duller than the tarmac for exactly that reason —
   *    the escape road should not be what pulls the eye off the racing line.
   *    Measured before this pass, it carried 1.5-1.7x the tarmac's
   *    high-frequency energy. The tile itself has been retuned (see
   *    `Tex.sand`), and here it is faded to its own mean colour with distance:
   *    the same two-scale treatment that fixed the kerb and then the road,
   *    applied harder and earlier because ground is seen at a more grazing
   *    angle than anything else in the scene.
   *  - Break the repeat. The terrain tiles every 14 m across half a kilometre
   *    of dune, which the eye picks up instantly as wallpaper. A second sample
   *    of the same map five times larger, pivoted on the map's own mean so the
   *    ground's brightness does not move, buys 70 m of drift over the top —
   *    and now that the tile is quiet, drift authored directly in world space
   *    over tens of metres carries the surface's whole character. None of it
   *    can alias at any distance, which is the entire point of putting it here
   *    rather than in a 14 m tile.
   *  - Hold still. Same fix as the road: fade the fine normal out once its
   *    footprint drops under a texel and widen the specular lobe to stand in
   *    for the relief that was lost.
   *  - Meet its neighbours. Sand is compacted and rubber-stained for the first
   *    couple of metres off the tarmac, and damp for the last couple above the
   *    waterline, so both joins are a gradient rather than a polygon edge.
   *  - Have a surface at all within arm's length. Everything above is authored
   *    at metres, and the tile under it stops at 16 cm because a 14 m tile
   *    cannot honestly hold anything finer. Between 16 cm and the pixel there
   *    was nothing, and that is precisely the band a 4K frame resolves: a
   *    700x500 crop of run-off at 3840x2160 came back holding one low-frequency
   *    mottle, a faint streak and nothing else, while the kerb a few hundred
   *    pixels away held grit, rubber and chipped paint at both resolutions.
   *    `Tex.groundDetail` supplies those scales and this fades them by *screen
   *    footprint* rather than by distance — see `gLod`. That distinction is the
   *    whole fix: a distance threshold is a statement about 1080p and cannot
   *    put anything more on a 4K screen, which is why every fade in this file
   *    previously produced the same picture at both.
   *
   * `strata` turns on sedimentary banding for the canyon, where the terrain
   * climbs into mesa walls sixty metres tall. Those walls are far enough away
   * that the tile has faded out entirely, and with nothing else on them they
   * photographed as a flat orange gradient — the only large object in that
   * circuit with no surface at all. Banding is a function of world height, so
   * it survives to the horizon and holds perfectly still while the camera does
   * not.
   */
  _groundWear(mat, tex, { tile, waterLevel = null, cacheKey, strata = 0 }) {
    // Shared by the shoulders and the terrain, and cached, so this is one map
    // pair for every off-track surface on every circuit.
    const detail = Tex.groundDetail({ size: 512 });
    mat.customProgramCacheKey = () => `hk-ground-${cacheKey}`;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBaseLuma = { value: Math.max(tex.meanLuma ?? 0.2, 1e-3) };
      shader.uniforms.uGroundFar = { value: tex.meanColor ?? new THREE.Color(0.22, 0.19, 0.14) };
      // Far below any geometry disables the damp band without a second shader.
      shader.uniforms.uWater = { value: waterLevel ?? -1e6 };
      shader.uniforms.uTile = { value: 1 / tile };
      shader.uniforms.uStrata = { value: strata };
      shader.uniforms.uDetailN = { value: detail.normalMap };
      shader.uniforms.uDetailG = { value: detail.grainMap };
      shader.uniforms.uDetailScale = { value: detail.normalScale };
      shader.uniforms.uDetailUv = { value: new THREE.Vector2(1 / DETAIL_TILE, 1 / DETAIL_TILE_MID) };
      shader.uniforms.uDetailLam = { value: new THREE.Vector2(DETAIL_LAMBDA, DETAIL_LAMBDA_MID) };
      shader.uniforms.uGravel = { value: new THREE.Vector2(GRAVEL_IN, GRAVEL_OUT) };

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
uniform vec3 uGroundFar;
uniform float uWater;
uniform float uTile;
uniform float uStrata;
uniform sampler2D uDetailN;
uniform sampler2D uDetailG;
uniform float uDetailScale;
uniform vec2 uDetailUv;          // tiles per metre, fine and coarse
uniform vec2 uDetailLam;         // finest wavelength each tap carries, metres
uniform vec2 uGravel;            // gravel band, metres out from the kerb

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
}

// How much of a feature of wavelength lam metres is still worth drawing when
// one pixel of the screen covers pix metres of this surface.
//
// A pattern is resolved while a pixel is a fraction of its period and is pure
// noise once a pixel spans one; carrying it at full contrast across that line
// is what aliasing *is*, and on ground — the most grazing surface in the frame
// — the line is crossed by the along-view axis first and by tens of metres. A
// hand-built mip chain, in other words, which procedural detail needs because
// the GPU cannot build one for it. Written against the footprint rather than the
// distance so that a screen with twice the pixels gets twice the detail instead
// of the same picture twice as large.
float gLod( float lam, float pix ) {
  return 1.0 - smoothstep( lam * 0.24, lam * 0.85, pix );
}

// The metre-scale lie of the loose material, as a scalar field in world metres.
// Sampled three times below to take its gradient, because a tonal field with no
// relief is a painting of a surface and the same field with relief is a
// surface. Six and two metres is a band no map and no mesh here can reach: the
// ground tile is fourteen metres across, and the terrain rings are 6.4 m apart.
float gRelief( vec2 q ) {
  return hkNoise( q * 0.170 ) * 0.62 + hkNoise( q * 0.530 + 3.1 ) * 0.38;
}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
float gDist = length( vViewPosition );
float gWorldY = vGround.x;
float gOut = vGround.y;          // metres out from the edge of the tarmac
vec2  gXZ = vMapUv / uTile;      // world metres; the ground's UV *is* world XZ
// One pixel's footprint on this surface, in world metres, along whichever axis
// is worse. On a plane seen this close to edge-on the two differ by an order of
// magnitude and it is always the long one that decides what is detail and what
// is noise.
float gPix = max( length( dFdx( gXZ ) ), length( dFdy( gXZ ) ) );

// Ground UVs are world XZ, so anything steep is drawn through a badly
// stretched sample. Re-project the steep parts against height instead — before
// the fade below, because this is still a fine-tile sample and has to be faded
// on the same schedule as the one it replaces.
vec3 gUp = normalize( mat3( viewMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
float gSteep = 1.0 - abs( dot( normalize( vNormal ), gUp ) );
float gSlope = smoothstep( 0.30, 0.80, gSteep );
if ( gSlope > 0.001 ) {
  vec2 gWallUv = vec2( vMapUv.x + vMapUv.y, gWorldY * uTile );
  diffuseColor.rgb = mix( diffuseColor.rgb, texture2D( map, gWallUv ).rgb, gSlope );
}

// How much of the 14 m tile is still worth showing. The road keeps a quarter of
// its own tile past thirty metres; this keeps a fifth past forty-five, and gets
// there sooner, because the ground is the flattest and therefore most grazing
// surface in the frame — a 16 cm grain is under a pixel *along* the view axis
// long before it is across it. Converging to the tile's own mean before that
// happens is what a perfect filter would have produced anyway.
float gFine = 1.0 - smoothstep( 10.0, 52.0, gDist );
diffuseColor.rgb = mix( uGroundFar, diffuseColor.rgb, 0.20 + 0.80 * gFine );

// Everything from here down is authored in world space at tens of metres, is
// low-frequency at every distance, and therefore cannot alias however far away
// it is. That is the whole reason the ground's character lives here and the
// tile only supplies grain.
float gMacro = dot( texture2D( map, vMapUv * 0.19 ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.rgb *= mix( 1.0, gMacro / uBaseLuma, 0.45 );

// Drift sheets: broad tongues of loose material banked over the lie of the
// land. Three scales — 95 m, 33 m and 13 m — because one is a gradient, two
// beat against each other, and three read as weather. Past fifty metres this
// is the only thing left carrying the run-off's shape, so it has to be worth
// looking at; being world-space and this size it is also the one part of the
// surface that is provably safe to draw at any distance. Centred on 1.0 so the
// ground's mean brightness — and with it the frame's exposure — does not move.
float gDrift = hkNoise( gXZ * 0.0105 + 4.7 ) * 0.40
             + hkNoise( gXZ * 0.0305 ) * 0.36
             + hkNoise( gXZ * 0.0770 + 11.3 ) * 0.24;
diffuseColor.rgb *= mix( 0.87, 1.13, gDrift );

// Wind scour at six metres, dragged along by the drift field so the two read
// as one weather system rather than two noise fields multiplied together, and a
// second pass of it at two metres dragged along by the first.
//
// Both used to be one term gated on gFine, which is the *tile's* schedule and
// far too short for them: a six-metre feature is fifty pixels across at a
// hundred metres and can no more alias than the drift sheets can. Retiring it
// at fifty metres with the tile is why the run-off past the braking zone was a
// painted ramp — between the tile dying at 52 m and the drift sheets starting
// at 13 m there was nothing at all with a shape to it, which is exactly the
// "one low-frequency mottle and a faint streak" in the review. Each now goes on
// its own wavelength, and each is worth looking at because it can afford to be.
float gScour = hkNoise( gXZ * 0.17 + vec2( gDrift * 3.0, 0.0 ) );
float gRipple = hkNoise( gXZ * 0.53 + vec2( 0.0, gScour * 1.7 ) );
diffuseColor.rgb *= mix( 1.0, mix( 0.905, 1.095, gScour ), gLod( 5.9, gPix ) );
diffuseColor.rgb *= mix( 1.0, mix( 0.945, 1.055, gRipple ), gLod( 1.9, gPix ) );

// -- the centimetre and decimetre scales ------------------------------------
// Two taps of one detail map, one at 1.15 m of world and one at 5.2 m, each
// retired on its own finest wavelength. Between them they occupy the whole band
// from the pixel up to where the 14 m tile takes over — the band this surface
// simply did not have, and the reason a 4K capture of it showed nothing a 1080p
// one did not.
vec2 gDetUv = gXZ * uDetailUv.x;
vec2 gMidUv = gXZ * uDetailUv.y;
float gDetW = gLod( uDetailLam.x, gPix );
float gMidW = gLod( uDetailLam.y, gPix );
vec3 gGrainF = texture2D( uDetailG, gDetUv ).rgb;
vec3 gGrainM = texture2D( uDetailG, gMidUv ).rgb;

// The gravel band inside the kerb. A trap is a strip of the coarse fraction
// swept out of the run-off, so it is the same map at the same two scales with
// the stones weighted up rather than a fourth material — and its edges are
// pushed about by a seven-metre noise, because a run-off that changes grade
// along a ruled line is a decal and not a place.
float gGravD = gOut + ( hkNoise( gXZ * 0.145 ) - 0.5 ) * 1.5;
float gGravel = smoothstep( uGravel.x, uGravel.x + 0.7, gGravD )
              * ( 1.0 - smoothstep( uGravel.y - 1.1, uGravel.y + 0.9, gGravD ) );
// Exposed stone is paler and greyer than the fines it was sorted out of, and
// that tonal shift is world- and road-space, so it is the part of the band that
// survives to any distance — the stones themselves cannot and do not.
float gGravStone = mix( gGrainM.b, gGrainF.b, gDetW * 0.5 );
// Darker than the ground beyond it, and washed toward grey.
//
// This band is the only thing telling a driver how far out the ground is still
// theirs, and it was barely telling them. Measured on canyonRush by masking
// the band with an A/B of this very term and sampling 12 px either side of its
// outer edge: the band sat 9.2 luma below the ground beyond it, which is 1.55x
// that ground's own variation. A boundary only half again as strong as the
// noise around it is why the run-off read as the desert having swallowed the
// circuit.
//
// The first attempt at this brightened the band and made it *worse* — 5.7, or
// 0.96x variation — because the band was already the darker of the two and
// lifting it closed the gap. Measure the sign before choosing it.
//
// B falls least, so the tint desaturates as it darkens: sorted stone is greyer
// than the fines it came out of, and darkening along the sand's own hue would
// only have made a shadowed patch of the same desert.
vec3 gGravTint = mix( vec3( 0.90, 0.91, 0.95 ), vec3( 1.10, 1.12, 1.18 ), gGravStone );
diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * gGravTint * 0.84, gGravel );

// Albedo modulation from both taps. R is half the multiplier and the map was
// normalised so its mean is exactly 1.0, which is what lets this ride on 40% of
// the frame without moving the exposure. The coarse tap is held to a third:
// the same stones stretched four and a half times are 20 cm across, and 20 cm
// stones at full contrast do not read as a run-off, they read as a cobbled
// yard. Weights are kept inside 0..1 on purpose — a mix factor over 1 is an
// extrapolation, and extrapolating an albedo is how a surface blows out.
float gMidA = gMidW * 0.34;
float gGrain = mix( 1.0, gGrainF.r * 2.0, gDetW ) * mix( 1.0, gGrainM.r * 2.0, gMidA );
diffuseColor.rgb *= gGrain;
float gRgh = mix( 1.0, gGrainF.g * 2.0, gDetW ) * mix( 1.0, gGrainM.g * 2.0, gMidA );

// The kerb's foot. Sand banks against it, and the last hand's width of it is in
// the kerb's own shadow all day. Both are missing from a join between two
// meshes that merely agree on a height, which is what "a hard geometric edge
// onto sand with no lip, no spill and no shadow" was describing — the surfaces
// met exactly and read as two materials butted together, because nothing
// crossed the line in either direction.
float gFoot = 1.0 - smoothstep( 0.0, 0.42, gOut );
float gBank = ( 1.0 - smoothstep( 0.10, 1.30, gOut ) ) * smoothstep( 0.02, 0.30, gOut );
diffuseColor.rgb *= mix( 1.0, 0.52, gFoot ) * mix( 1.0, 1.10, gBank );

// Sedimentary beds, for the canyon. Real mesa strata are near-horizontal, tilt
// slowly, and vary in thickness, so the bed coordinate is world height plus a
// hundred-metre warp; the band's own colour comes from a hash of which bed it
// is. Held to the parts of the terrain that actually stand up — a plain does
// not show its bedding — and the seam between two beds is widened in screen
// space so it can never break into a dotted line at range.
if ( uStrata > 0.0 ) {
  // From about nine degrees, because the terrain sheet's outer columns are
  // tens of metres apart and the mesa faces it draws only reach 35 degrees —
  // a threshold set for a cliff finds nothing on this circuit at all.
  float gTilt = smoothstep( 0.012, 0.16, gSteep );
  // Two sets at three to one: three metre beds inside nine metre formations.
  // One frequency alone lays down evenly spaced lines and what that draws is a
  // contour map, which is a worse artefact than the flat gradient it replaces —
  // bedding only convinces when the beds differ in *thickness*, and two
  // incommensurate sets is the cheapest way to say so.
  float gWarp = hkNoise( gXZ * 0.0072 ) * 1.7;
  float gBed = gWorldY * 0.33 + gWarp;
  float gFmn = gWorldY * 0.11 + gWarp * 0.34;
  float gBedF = fract( gBed ), gFmnF = fract( gFmn );
  // Softened over at least a tenth of a bed, so a bedding plane reads as a
  // weathered recess rather than as a wire drawn across the hill.
  float gSeam = ( 1.0 - smoothstep( 0.0, max( 0.11, fwidth( gBedF ) * 1.8 ), min( gBedF, 1.0 - gBedF ) ) ) * 0.45
              + ( 1.0 - smoothstep( 0.0, max( 0.07, fwidth( gFmnF ) * 1.8 ), min( gFmnF, 1.0 - gFmnF ) ) ) * 0.55;
  // Rock differs in what it is made of, not only in how bright it is: the
  // iron-rich formations are redder and the marls paler and greyer, and within
  // one of them each bed is a shade of the same thing. A pure value ramp reads
  // as lighting, which is exactly what this exists to replace.
  vec3 gBand = mix( vec3( 1.14, 0.99, 0.88 ), vec3( 0.86, 0.94, 1.03 ), hkHash( vec2( floor( gFmn ), 0.5 ) ) )
             * mix( 0.90, 1.10, hkHash( vec2( floor( gBed ), 9.0 ) ) );
  diffuseColor.rgb *= mix( vec3( 1.0 ), gBand * mix( 1.0, 0.86, gSeam ), uStrata * gTilt );
}

// Karts leave the circuit here: the first couple of metres are packed flat
// and stained, which is what makes the run-off look used instead of laid.
float gEdge = 1.0 - smoothstep( 0.0, 2.4, gOut );
diffuseColor.rgb *= mix( 1.0, 0.76, gEdge );

// Damp sand above the tideline: darker, deeper, and it holds a sheen.
float gWet = 1.0 - smoothstep( 0.0, 2.4, gWorldY - uWater );
diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.60, 0.55, 0.53 ), gWet );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
// Grit is the roughest thing on the circuit and exposed stone is not, so the
// detail map's own roughness rides in on the same two schedules its relief does
// — a normal without a matching roughness reads as embossed plastic.
roughnessFactor *= gRgh;
// Relief that has fallen off the end of the mip chain still scatters light, so
// the energy the retired normal used to carry goes here instead.
roughnessFactor = mix( roughnessFactor, 0.99, ( 1.0 - gFine ) * 0.45 );
roughnessFactor = mix( roughnessFactor, 1.00, gEdge * 0.40 );
roughnessFactor = mix( roughnessFactor, 0.98, gGravel * 0.55 );
roughnessFactor = mix( roughnessFactor, 0.30, gWet );
roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );`)
        .replace('#include <normal_fragment_maps>', `vec3 gN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
vec3 gM = texture2D( normalMap, vNormalMapUv * 0.19 ).xyz * 2.0 - 1.0;
// Water fills the ripples in; packed run-off has been flattened by tyres. The
// fine term now dies on the same schedule as the albedo above: a normal map is
// a specular multiplier, and per-pixel specular on a grazing plane is where all
// of this surface's measured temporal instability actually lived.
vec2 gNxy = ( gM.xy * 0.55 + gN.xy * gFine ) * mix( 1.0, 0.30, max( gWet, gEdge * 0.7 ) );
// The two detail taps, each carried exactly as far as it is resolvable and no
// further. Added outside the tile's own normalScale because this map has its
// own, set against what a stone two metres from the camera should look like
// rather than against what a fourteen-metre tile should. Gravel stands proud in
// a way drifted fines never do, so the band gets the same relief harder.
vec2 gDetN = ( texture2D( uDetailN, gDetUv ).xy * 2.0 - 1.0 ) * gDetW;
vec2 gMidN = ( texture2D( uDetailN, gMidUv ).xy * 2.0 - 1.0 ) * gMidW * 0.45;
// Relief for the metre scales, by finite difference on the same field that
// tinted them. It is the only term here that still exists at forty metres, and
// under a sun at sixteen degrees it is worth more than every finer scale put
// together: a run-off with tone but no shape is a ramp of colour, which is the
// failure on the far side of the moire this file spent the last pass removing.
float gH0 = gRelief( gXZ );
vec2 gGrad = vec2( gRelief( gXZ + vec2( 0.9, 0.0 ) ) - gH0,
                   gRelief( gXZ + vec2( 0.0, 0.9 ) ) - gH0 );
vec2 gTot = gNxy * normalScale
  + ( gDetN + gMidN ) * uDetailScale * ( 1.0 + gGravel * 0.9 ) * mix( 1.0, 0.40, gWet )
  - gGrad * 0.62 * gLod( 2.4, gPix ) * mix( 1.0, 0.45, gWet );
normal = normalize( tbn * vec3( gTot, 1.0 ) );`);
    };
  }

  /**
   * The barrier: an extruded section with a top cap, plus its posts.
   *
   * Both sides are merged into one buffer and the coloured top rail is painted
   * by the shader onto the cap it belongs to, so this is two draw calls where
   * it used to be four — and the rail can no longer z-fight the wall it sits
   * on, because it is no longer a separate surface sitting on it.
   *
   * Everything the run needs in order to read as *built* rather than drawn is
   * split by whether it has a silhouette. Thickness, the cap and its overhang,
   * and the posts are geometry, because no map produces a silhouette. Panel
   * joints, per-panel paint, the scuffed kick plate and the grime rising off
   * the run-off are shader, because they are flat and there are four hundred of
   * them. Both of those are the same call this file already made for the kerb.
   */
  _buildBarriers() {
    const shoulderW = TRACK_LAYOUT.shoulderWidth;
    const H = TRACK_LAYOUT.wallHeight;
    const n = Math.max(64, Math.round(this.track.length / WALL_STEP));
    const m = WALL_PROFILE.length;

    const tm = Tex.paintedMetal({ size: 512, tint: 0xf0f2f5 });
    const wallMat = this._mat({
      map: tm.map, normalMap: tm.normalMap, roughnessMap: tm.roughnessMap,
      normalScale: new THREE.Vector2(tm.normalScale, tm.normalScale),
      metalness: 0.35, roughness: 0.55, envMapIntensity: 0.9,
    });
    this._barrierWear(wallMat, this.theme.key === 'coast' ? 0xe2483c : 0xdb8a2a);

    // Distance along the section, so the U axis keeps a roughly square texel
    // density as the profile wraps over the cap rather than stretching across
    // whichever segment happens to be longest.
    const arc = new Float64Array(m);
    for (let k = 1; k < m; k++) {
      arc[k] = arc[k - 1] + Math.hypot(
        WALL_PROFILE[k][0] - WALL_PROFILE[k - 1][0],
        (WALL_PROFILE[k][1] - WALL_PROFILE[k - 1][1]) * H,
      );
    }

    const count = n * m * 2;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const aWall = new Float32Array(count * 2);
    const index = new Uint32Array(n * (m - 1) * 6 * 2);
    const p = new THREE.Vector3();
    const edge = new THREE.Vector3();
    let ptr = 0;

    for (let q = 0; q < 2; q++) {
      const side = q === 0 ? -1 : 1;
      const base = q * n * m;
      for (let i = 0; i < n; i++) {
        const s = (i / n) * this.track.length;
        const half = this.track.halfWidthAt(s);
        // Anchored on the barrier line, not on each profile point's own lateral
        // position. A corner here banks by up to 0.30 rad, and letting a 52 cm
        // section ride that bank would tilt the barrier with the road; a real
        // one is driven vertically into the ground whatever the road does.
        const footY = this._point(s, side * (half + shoulderW), edge).y - 0.40;
        for (let k = 0; k < m; k++) {
          const prof = WALL_PROFILE[k];
          this._point(s, side * (half + shoulderW + prof[0]), p);
          const v = base + i * m + k;
          positions[v * 3] = p.x;
          positions[v * 3 + 1] = footY + prof[1] * H;
          positions[v * 3 + 2] = p.z;
          uvs[v * 2] = arc[k] / 3;
          uvs[v * 2 + 1] = s / 3;
          aWall[v * 2] = s;                 // metres round the lap
          aWall[v * 2 + 1] = prof[1] * H;   // metres above the foot
        }
      }
      // The same rule, and the same reason, as `_strip`: the profile's lateral
      // runs along `side * right`, so on the negative side the whole section is
      // generated inside out. The cap is the one segment whose facing is known
      // in advance — it has to point up — and its lateral span is `side * 0.52`,
      // so the sign of `side` is the whole test.
      const flip = side < 0;
      for (let i = 0; i < n; i++) {
        const i0 = base + i * m, i1 = base + ((i + 1) % n) * m;
        for (let k = 0; k < m - 1; k++) {
          const a = i0 + k, b = i1 + k, c = i1 + k + 1, d = i0 + k + 1;
          if (flip) {
            index[ptr++] = a; index[ptr++] = c; index[ptr++] = b;
            index[ptr++] = a; index[ptr++] = d; index[ptr++] = c;
          } else {
            index[ptr++] = a; index[ptr++] = b; index[ptr++] = c;
            index[ptr++] = a; index[ptr++] = c; index[ptr++] = d;
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aWall', new THREE.BufferAttribute(aWall, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this._add(geo, wallMat, { cast: true, receive: true }).name = 'wall';

    this._buildBarrierPosts(tm, shoulderW, H);
  }

  /**
   * Support posts, on a fixed spacing outside the barrier.
   *
   * A barrier with no posts is a wall; a barrier with posts is a *structure*,
   * and on a circuit that turns constantly you are looking at the outside of
   * one of them for most of a lap. They are cheap — ten triangles each, five
   * hundred of them, one merged draw call — and they are the only thing here
   * that gives the run a rhythm you can read your own speed against.
   */
  _buildBarrierPosts(tm, shoulderW, H) {
    const nPost = Math.max(8, Math.round(this.track.length / POST_GAP));
    const boxes = nPost * 2;
    const positions = new Float32Array(boxes * 8 * 3);
    const uvs = new Float32Array(boxes * 8 * 2);
    // Bottom face omitted: it is buried and no camera in this game can be under
    // the terrain to see it.
    const QUADS = [[4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const index = new Uint32Array(boxes * QUADS.length * 6);
    const p = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const c0 = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
    const nrm = new THREE.Vector3(), out = new THREE.Vector3(), mid = new THREE.Vector3();
    let vo = 0, io = 0;

    for (const side of [-1, 1]) {
      for (let j = 0; j < nPost; j++) {
        const s = (j / nPost) * this.track.length;
        const half = this.track.halfWidthAt(s);
        const footY = this._point(s, side * (half + shoulderW), edge).y - 0.40;
        const lat0 = half + shoulderW + 0.17, lat1 = lat0 + POST_W;
        const base = vo;
        mid.set(0, 0, 0);
        for (let t = 0; t < 2; t++) {
          const y = footY + (t === 0 ? POST_BASE : POST_TOP) * H;
          const corners = [[-1, lat0], [-1, lat1], [1, lat1], [1, lat0]];
          for (const [ds, lat] of corners) {
            this._point(s + ds * POST_D * 0.5, side * lat, p);
            positions[vo * 3] = p.x; positions[vo * 3 + 1] = y; positions[vo * 3 + 2] = p.z;
            // A small fixed patch of the barrier's own map — a post has no
            // features of its own worth resolving, only its material.
            uvs[vo * 2] = 0.1 + (lat - lat0) * 0.5;
            uvs[vo * 2 + 1] = s / 2;
            mid.x += p.x; mid.y += y; mid.z += p.z;
            vo++;
          }
        }
        mid.multiplyScalar(1 / 8);
        // Winding decided per face against the box's own centre rather than
        // from a handedness argument. `side` mirrors the local frame, and the
        // last time this project asserted a winding instead of deriving one it
        // cost an entire side of every circuit.
        for (const [a, b, c, d] of QUADS) {
          c0.fromArray(positions, (base + a) * 3);
          c1.fromArray(positions, (base + b) * 3);
          c2.fromArray(positions, (base + c) * 3);
          nrm.copy(c1).sub(c0).cross(out.copy(c2).sub(c0));
          out.copy(c0).add(c1).add(c2).multiplyScalar(1 / 3).sub(mid);
          if (nrm.dot(out) >= 0) {
            index[io++] = base + a; index[io++] = base + b; index[io++] = base + c;
            index[io++] = base + a; index[io++] = base + c; index[io++] = base + d;
          } else {
            index[io++] = base + a; index[io++] = base + c; index[io++] = base + b;
            index[io++] = base + a; index[io++] = base + d; index[io++] = base + c;
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = this._mat({
      map: tm.map, normalMap: tm.normalMap, roughnessMap: tm.roughnessMap,
      normalScale: new THREE.Vector2(tm.normalScale, tm.normalScale),
      // Galvanised steel behind painted panels: darker, glossier, and never the
      // same value as the thing it holds up, or the posts stop reading at all.
      color: 0x4e535a, metalness: 0.80, roughness: 0.46, envMapIntensity: 1.0,
    });
    // Not shadow casters. Five hundred 20 cm sticks cost a shadow-map redraw and
    // return a dotted line the cascade cannot resolve at any distance that
    // matters.
    this._add(geo, mat, { cast: false, receive: true }).name = 'wallPost';
  }

  /**
   * The barrier's history, none of which needs geometry.
   *
   * Panels, their joints and their paint are a function of *arc length* — where
   * the section is on the circuit — and the kick plate and the grime are a
   * function of height above the foot. Neither is a property of a 3 m tile, so
   * neither can live in one: the same split that moved the kerb's per-stripe
   * variety and the road's racing line into road space.
   */
  _barrierWear(mat, railHex) {
    mat.customProgramCacheKey = () => 'hk-barrier';
    mat.onBeforeCompile = (shader) => {
      // A *shader uniform* consumed in linear light, unlike the canvas bytes
      // `paintTint` exists for — so the sRGB decode `new THREE.Color(hex)` does
      // is the right one here, and skipping it would light the rail nine times
      // too bright.
      shader.uniforms.uRail = { value: new THREE.Color(railHex) };
      shader.uniforms.uGrime = { value: new THREE.Color(this.theme.groundColor ?? 0x8a7a5c) };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aWall;
varying vec2 vWall;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vWall = aWall;`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vWall;
uniform vec3 uRail;
uniform vec3 uGrime;

float hkHash( vec2 p ) {
  p = fract( p * vec2( 0.3183099, 0.3678794 ) );
  p += dot( p, p + 27.71 );
  return fract( p.x * p.y * 41.31 );
}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
float wArc = vWall.x;             // metres round the lap
float wY   = vWall.y;             // metres above the barrier's foot

// Panel joints. A 2 cm shadow gap is sub-pixel long before it is out of sight,
// so it is widened in screen space rather than allowed to break into a dotted
// line — the same treatment the road's cold joints get, and for the same
// reason. The run wanders slowly so four hundred panels never look ruled off.
float wPanel = wArc / ${WALL_PANEL.toFixed(1)} + 0.14 * hkHash( vec2( floor( wArc / 137.0 ), 3.0 ) );
float wF = fract( wPanel );
float wJointD = min( wF, 1.0 - wF );
float wJoint = 1.0 - smoothstep( 0.0, max( 0.006, fwidth( wJointD ) * 1.7 ), wJointD );
float wBatch = hkHash( vec2( floor( wPanel ), 0.5 ) );

// No two panels were painted in the same year.
diffuseColor.rgb *= mix( 0.93, 1.05, wBatch );

// The cap and its lip take the circuit's trim colour. Painting it here rather
// than laying a second mesh on the cap is what stopped the trim z-fighting the
// surface it was supposed to be part of.
float wCap = smoothstep( 0.885 * ${TRACK_LAYOUT.wallHeight.toFixed(2)}, 0.930 * ${TRACK_LAYOUT.wallHeight.toFixed(2)}, wY );
diffuseColor.rgb = mix( diffuseColor.rgb, uRail * mix( 0.88, 1.06, wBatch ), wCap );

// The kick plate: the bottom 30 cm is where the debris, the spray and the
// occasional kart arrive, and it is scuffed back to bare metal in places.
float wKick = 1.0 - smoothstep( 0.26, 0.34, wY );
diffuseColor.rgb *= mix( 1.0, 0.74, wKick );

// Grime climbing off the run-off, in the run-off's own colour, and an occlusion
// darkening in the last hand's width. Between them they are what plants the
// barrier on the ground instead of leaving it hovering over a hard line.
float wDirt = ( 1.0 - smoothstep( 0.0, 0.62, wY ) ) * mix( 0.55, 1.0, wBatch );
diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.72 + uGrime * 0.16, wDirt );
diffuseColor.rgb *= mix( 1.0, 0.58, 1.0 - smoothstep( 0.0, 0.16, wY ) );

diffuseColor.rgb *= mix( 1.0, 0.34, wJoint );`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
// Trim paint on a cap is kept clean; a kick plate is not. Not taken all the
// way to a gloss: the cap is the one horizontal surface on this object and a
// 16-degree sun rakes straight along it, so every tenth off the roughness here
// costs a hundred metres of red flare down the outside of a corner.
roughnessFactor = mix( roughnessFactor, 0.42, wCap * 0.8 );
roughnessFactor = mix( roughnessFactor, 0.92, max( wKick * 0.6, wDirt * 0.7 ) );
roughnessFactor = mix( roughnessFactor, 0.88, wJoint );
roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );`);
    };
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
    const t = Tex.checker({
      size: 512,
      squares: START_SQUARES,
      edgeLine: START_EDGE / START_DEPTH,
    });
    t.map.repeat.set(1, 1);
    // Through `_mat`, so this decal carries the circuit's environment probe
    // like every other surface here. Three only reads
    // `material.envMapIntensity` when the *material* owns an envMap:
    //
    //   if ( material.envMap === null && scene.environment !== null )
    //     m_uniforms.envMapIntensity.value = scene.environmentIntensity;
    //
    // so on a decal built with a bare `new MeshStandardMaterial` the figure
    // written in the constructor is dead code — `markings` still carries a 0.4
    // the renderer has never read. Worth correcting, but not the reason this
    // band was faint: measured, routing it through the probe at 1.0 instead of
    // the scene's 0.74 moved 0.17% of the frame by exactly 1/255, because the
    // IBL is not what lights a horizontal surface under this sky. The band was
    // faint because 80 cm chequers mip to a mid grey; that is fixed above, in
    // its depth and its edge stripes.
    const mat = this._mat({
      map: t.map,
      alphaMap: t.alphaMap,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      roughness: 1.0, metalness: 0.0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      envMapIntensity: 1.0,
    });
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
    this._buildStartGrid();
  }

  /**
   * The starting grid, painted where the karts are actually placed.
   *
   * The opening frame of a kart racer is the one the whole game gets judged by,
   * and until now that frame was twelve karts sitting on bare tarmac forty
   * metres short of a chequered band nobody could see. A grid box is the only
   * mark on a circuit that says *this slot is yours*, and it is what turns a
   * staggered line of karts into a start.
   *
   * The slots come from `Track.startGrid` rather than from a second copy of its
   * arithmetic, so the paint cannot drift away from the karts if the row gap or
   * the stagger ever changes. Boxes are painted for the full field size whether
   * or not this race has one — the alternative is a circuit whose markings
   * depend on who entered.
   *
   * Each box takes its own cell of one atlas, which is the whole reason the
   * positions can be *numbered*: twelve different marks, still one texture, one
   * material and one draw call. Numbering is not decoration — it is the thing
   * that makes a grid unmistakably a grid rather than twelve rectangles, and the
   * previous version's central failure was that a reviewer had to hide it and
   * re-shoot to establish it existed at all.
   */
  _buildStartGrid() {
    const slots = this.track.startGrid(GRID_SLOTS);
    const cell = 256;
    const t = Tex.gridBox({
      size: cell,
      slots: GRID_SLOTS,
      lineW: GRID_LINE / GRID_BOX_W,
      barW: GRID_BAR / GRID_BOX_L,
      keyW: GRID_KEY / GRID_BOX_W,
      // The cell is square and the box is not, so the numeral has to be told
      // how much the world stretches it or a 12 arrives elongated down the road.
      aspect: GRID_BOX_L / GRID_BOX_W,
      numH: GRID_NUM_H / GRID_BOX_L,
    });
    // Through `_mat` for the reason set out on the start line's material: a
    // decal built with a bare constructor never receives the envMap, and its
    // `envMapIntensity` is silently replaced by the scene's.
    const mat = this._mat({
      map: t.map,
      alphaMap: t.alphaMap,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      transparent: true,
      opacity: 0.94,
      roughness: 1.0,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      envMapIntensity: 1.0,
    });

    // Enough subdivision to follow the road under the box. A grid sits on the
    // start/finish straight, but "straight" here is a harmonic curve and a 4.6 m
    // flat quad laid on it lifts its corners off the tarmac.
    const cols = 3, rows = 5;
    const parts = [];
    const p = new THREE.Vector3();
    for (let g = 0; g < slots.length; g++) {
      const slot = slots[g];
      const n = rows + 1, m = cols + 1;
      const positions = new Float32Array(n * m * 3);
      const uvs = new Float32Array(n * m * 2);
      const sBar = slot.s + GRID_BOX_AHEAD;
      // This box's cell of the atlas. Inset by half a texel so bilinear
      // filtering at the cell edge cannot reach across into the next number.
      const half = 0.5 / (cell * GRID_SLOTS);
      const u0 = g / GRID_SLOTS + half, u1 = (g + 1) / GRID_SLOTS - half;
      for (let i = 0; i < n; i++) {
        const f = i / rows;
        const s = sBar - GRID_BOX_L * (1 - f);
        for (let j = 0; j < m; j++) {
          const u = j / cols;
          this._point(s, slot.lateral + lerp(-GRID_BOX_W * 0.5, GRID_BOX_W * 0.5, u), p);
          const k = (i * m + j) * 3;
          positions[k] = p.x; positions[k + 1] = p.y + 0.013; positions[k + 2] = p.z;
          const tt = (i * m + j) * 2;
          uvs[tt] = lerp(u0, u1, u); uvs[tt + 1] = f;
        }
      }
      parts.push({ positions, uvs, colors: null, n, m });
    }
    // Twelve boxes, one material, no animation: twelve draw calls spent on
    // nothing if they stayed separate. Same reasoning as the boost pads. Drawn
    // after the lane markings, which run straight through the grid: a box is
    // newer paint than the lines it was laid over, and with both writing no
    // depth the order is the only thing that says so.
    this._add(mergeStrips(parts), mat, { receive: true, renderOrder: 2 }).name = 'startGrid';
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
      // Only the canyon has walls to band. On the coast the far terrain is a
      // beach going flat into the sea, and strata on a beach is a rock face.
      strata: isCoast ? 0 : 1,
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
