import * as THREE from 'three';
import { TrackSpline } from './Spline.js';
import { SURFACE, offroadSurfaceFor, surfaceNamed } from './Tracks.js';
import { clamp, clamp01, lerp, mod, ringDelta, smoothstep } from '../core/MathX.js';

/**
 * The authoritative, renderer-agnostic model of a circuit.
 *
 * Physics, AI, items, the minimap and every art system query this object.
 * Nothing else is allowed to decide where the ground is — if the road surface
 * and the collision surface ever disagree, karts sink or float, so both the
 * mesh builder and the physics step call `groundHeight()` / `sampleGround()`.
 */

export const TRACK_LAYOUT = {
  curbWidth: 1.35,      // rumble strip, measured inward from the road edge
  shoulderWidth: 6.5,   // drivable off-road apron before the barrier
  wallHeight: 1.6,
  // How far a kart's *centre* may pass the edge of a void track before the
  // ground stops holding it. This is the kart's own radius, deliberately: a
  // kart falls once it has actually left the road, not while a third of it is
  // still over tarmac. See `sampleGround`.
  voidOverhang: 1.15,
};

export class Track {
  constructor(def) {
    this.def = def;
    this.theme = def.theme;
    this.name = def.name;
    this.laps = def.laps ?? 3;
    this.spline = new TrackSpline(def.nodes, { samples: 2600, closed: true });
    this.length = this.spline.length;
    this.offroadSurface = offroadSurfaceFor(def.theme);
    /**
     * Physics for the driving surface itself, named by the same field that
     * decides how it is *drawn*. A circuit whose road is rendered as ice is
     * therefore driven as ice, and there is no second field that can quietly
     * disagree with the first. Surfaces with no physics entry — `asphalt`,
     * `rainbow` — fall through to plain ROAD, which is what they were.
     */
    this.roadSurface = surfaceNamed(def.theme.roadSurface, SURFACE.ROAD);
    this.isVoid = !!def.theme.voidFall;

    this.startS = mod((def.startLineT ?? 0) * this.length, this.length);

    // Elevation range of the centreline. Anything that needs to sit *under*
    // the circuit (sea level, canyon floor, the void plane) derives from this
    // rather than from a hand-picked constant that a later layout change would
    // silently invalidate.
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.spline.count; i++) {
      const y = this.spline.pos[i * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.minY = minY;
    this.maxY = maxY;
    // How far the water sits below the circuit's lowest point. Authored per
    // theme because how high a circuit stands over its water is a composition
    // decision, not one the layout can be trusted to imply. Themes with no
    // water still get a level: the terrain's damp band and the coast's seabed
    // both reference it, and it costs nothing to be defined everywhere.
    this.waterLevel = minY - (def.theme.water?.drop ?? 11.5);

    this.ramps = (def.ramps || []).map((r) => ({
      s: mod(r.t * this.length, this.length),
      lane: r.lane || 0,
      height: r.height,
      length: r.length,
    }));

    this.boostPads = (def.boostPads || []).map((b) => ({
      s: mod(b.t * this.length, this.length),
      lane: b.lane || 0,
      length: b.length || 12,
      halfWidth: 3.0,
    }));

    this.itemBoxes = [];
    for (const group of def.itemBoxes || []) {
      const s = mod(group.t * this.length, this.length);
      const f = this.spline.frameAt(s, {});
      for (const lane of group.lanes) {
        this.itemBoxes.push({ s, lane, lateral: lane * f.width * 0.5 });
      }
    }

    this._tmpProj = {};
    this._tmpFrame = {};
    this._v = new THREE.Vector3();
  }

  // -- Geometry sampling ----------------------------------------------------

  /** Extra height added on top of the spline surface (jump ramps). */
  rampOffset(s, lateral) {
    let h = 0;
    for (const r of this.ramps) {
      const d = ringDelta(r.s, s, this.length);
      if (d < 0 || d > r.length) continue;
      const u = d / r.length;
      // Ramp up, short plateau, then a steep back edge. The drop is far
      // faster than gravity can follow, so karts launch off the lip — but the
      // surface stays continuous, so the mesh is watertight and physics never
      // has to special-case a vertical face.
      if (u < 0.70) h += r.height * smoothstep(u / 0.70);
      else if (u < 0.85) h += r.height;
      else h += r.height * (1 - smoothstep((u - 0.85) / 0.15));
    }
    return h;
  }

  /** Road surface Y at (s, lateral), including banking and ramps. */
  groundHeight(s, lateral) {
    const f = this.spline.frameAt(s, this._tmpFrame);
    return f.pos.y + f.right.y * lateral + this.rampOffset(s, lateral);
  }

  /** Half-width of drivable road at arc position `s`. */
  halfWidthAt(s) {
    return this.spline.frameAt(s, this._tmpFrame).width * 0.5;
  }

  /** Distance from centerline at which the barrier sits. */
  wallLateralAt(s) {
    return this.halfWidthAt(s) + TRACK_LAYOUT.shoulderWidth;
  }

  isOnBoostPad(s, lateral) {
    for (const b of this.boostPads) {
      const d = ringDelta(b.s, s, this.length);
      if (d < 0 || d > b.length) continue;
      const half = this.halfWidthAt(s);
      if (Math.abs(lateral - b.lane * half) <= b.halfWidth) return true;
    }
    return false;
  }

  /**
   * Full ground query for a world-space point.
   * `hint` is the previous frame's sample index — pass it for a local search.
   */
  sampleGround(pos, hint = -1, out = {}) {
    const p = this.spline.project(pos, hint, this._tmpProj);
    const half = p.width * 0.5;
    const absLat = Math.abs(p.lateral);
    const ramp = this.rampOffset(p.s, p.lateral);

    let surface;
    if (absLat <= half - TRACK_LAYOUT.curbWidth) {
      surface = this.isOnBoostPad(p.s, p.lateral) ? SURFACE.BOOST : this.roadSurface;
    } else if (absLat <= half + 0.15) {
      surface = SURFACE.CURB;
    } else {
      surface = this.offroadSurface;
    }

    out.s = p.s;
    out.lateral = p.lateral;
    out.index = p.index;
    out.width = p.width;
    out.halfWidth = half;
    out.curvature = p.curvature;
    out.heading = p.heading;
    out.tangent = p.tangent;
    out.right = p.right;
    out.normal = p.normal;
    out.height = p.height + ramp;
    out.onRoad = absLat <= half;
    out.surface = surface;
    out.wallLateral = half + TRACK_LAYOUT.shoulderWidth;
    out.beyondWall = absLat > out.wallLateral;
    // Off a rainbow road there is no ground at all — karts fall into the void.
    //
    // The lip used to sit 0.6 m past the edge, which is *inside* the kart: with
    // a 1.15 m radius, a kart was dropped while 0.55 m of it was still over the
    // road. Measured at the moment each fall was committed, 58.2% of them were
    // between 0.40 and 0.80 m past the edge — cars clipping a lip drawn through
    // their own bodywork. The overhang is now the kart's radius, so a kart
    // falls when it has genuinely left the road.
    out.hasGround = !(this.isVoid && absLat > half + TRACK_LAYOUT.voidOverhang);
    return out;
  }

  /** World-space position + orientation on the road at (s, lateral). */
  placeOnRoad(s, lateral, out = new THREE.Vector3()) {
    const f = this.spline.frameAt(s, this._tmpFrame);
    out.copy(f.pos).addScaledVector(f.right, lateral);
    out.y += this.rampOffset(s, lateral);
    return out;
  }

  frameAt(s, out = {}) { return this.spline.frameAt(s, out); }

  // -- Race logic -----------------------------------------------------------

  /**
   * Starting grid: two staggered columns behind the line, like a real kart
   * grid — pole on the inside, alternating, one row length apart.
   */
  startGrid(count) {
    const grid = [];
    const rowGap = 7.0;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const s = mod(this.startS - 12 - row * rowGap, this.length);
      const f = this.spline.frameAt(s, {});
      const lateral = side * f.width * 0.24;
      const pos = new THREE.Vector3().copy(f.pos).addScaledVector(f.right, lateral);
      grid.push({ pos, yaw: f.heading, s, lateral });
    }
    return grid;
  }

  /** Continuous race progress in meters, monotonic across the finish line. */
  progress(lap, s) {
    return lap * this.length + mod(s - this.startS, this.length);
  }

  /** Fraction 0..1 around the lap, measured from the start line. */
  lapFraction(s) {
    return mod(s - this.startS, this.length) / this.length;
  }

  dispose() {}
}
