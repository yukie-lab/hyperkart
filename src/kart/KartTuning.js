/**
 * Every number that defines how the game *feels*, in one place.
 *
 * Units are metric and real: metres, seconds, radians. Top speed of 30 m/s is
 * 108 km/h on the HUD, which combined with the FOV kick and speed lines reads
 * considerably faster than it measures — the same trick the genre has always
 * used.
 */

export const PHYS = {
  gravity: 26.0,
  // Karts sit this far above the road surface (axle height).
  rideHeight: 0.42,
  kartRadius: 1.15,
  kartLength: 2.3,
  /**
   * How far the *bodywork* reaches from the kart's centre, worst case.
   *
   * `kartRadius` describes the kart for kart-to-kart contact and is smaller
   * than the car: measured from the models, the half-diagonal is 1.74 m for a
   * dart, 1.90 for a gt and 2.17 for a bruiser. Parking a kart against a
   * barrier by its *radius* therefore leaves up to a metre of it on the far
   * side of the barrier line.
   *
   * On canyonRush that is not cosmetic. The terrain steps up about six metres
   * starting 7.0 m past the road edge — the embankment the barrier stands on —
   * while `_resolveWalls` clamps the kart's centre at 5.35 m. A kart resting
   * there at an angle puts its corner at 7.1-7.5 m, which is inside the
   * embankment, and the car is drawn half-swallowed by sand. Measured worst
   * case 5.77 m of burial at s=1264.
   */
  bodyReach: 2.2,
  // Vertical distance above ground before we consider the kart airborne.
  airborneThreshold: 0.22,
  // How fast the kart is pulled back down onto a descending road.
  groundStick: 9.0,
};

export const DRIVE = {
  topSpeed: 30.0,
  reverseSpeed: 9.0,
  accel: 19.0,
  brakeDecel: 30.0,
  coastDecel: 7.5,
  // Deceleration applied when above the current effective top speed.
  overspeedDecel: 11.0,

  // Steering ------------------------------------------------------------
  maxSteerRate: 2.15,        // rad/s at the sweet spot
  // Steering authority ramps in with speed, then bleeds off at the top end so
  // high-speed straights stay stable.
  steerRampSpeed: 9.0,
  steerHighSpeedFalloff: 0.60,
  airSteerFactor: 0.42,

  // Lateral slip — a small amount of body slide gives the kart weight without
  // turning it into a simulator.
  slipGain: 0.16,
  slipDecay: 6.0,
};

export const DRIFT = {
  // Minimum speed required to initiate a drift.
  minSpeed: 8.0,
  hopVelocity: 3.05,
  // Base rotation rate while drifting, before steer modulation.
  baseRate: 1.28,
  steerRange: 0.72,
  // Visual body yaw offset relative to travel direction.
  bodyAngleMin: 0.30,
  bodyAngleMax: 0.66,
  bodyAngleRate: 9.0,
  // Drift bleeds a little speed, so drifting everywhere is not free.
  speedPenalty: 0.965,
  // Charge accumulation. `chargeSteerBonus` used to add up to 0.34/s for
  // holding the stick *into* the slide, and it was never once earned: earning
  // it needs the corner to demand more yaw than the drift's own base arc
  // already delivers, which at 24-30 m/s means a radius under ~39 m, and these
  // circuits sit at 50/67/74 m at the 90th percentile. Measured over 245k
  // drifting frames across the three tracks, the mean earned rate was
  // 0.721/0.728/0.736 against an advertised 1.06 — on canyonRush the term
  // cleared zero on 1.25% of frames and never once reached half. So the
  // headline rate had never been delivered: purple nominally cost 3.58 s of
  // slide and actually cost 5.28 s, against a longest hold of ~5.7 s on the
  // one circuit that has a sweeper long enough, and 4.4 s on canyonRush. Purple
  // fired in 0 of 36 kart-races there and on rainbowSkyway.
  //
  // Folded into the base rather than made earnable: the input it pays for is
  // one no good driver gives. The drift arc is already tighter than every
  // corner here, so steering further into it drives you off the inside — the
  // parameter rewarded the mistake. Making it fire would mean loosening
  // DRIFT.baseRate, which is the signature pose, not an economy knob.
  // The thresholds below are untouched; they were never what was broken.
  chargeBase: 1.06,
  chargeSteerBonus: 0,
  // Charge thresholds for each mini-turbo tier. In seconds of committed slide
  // at the rate above: blue 0.94, orange 2.08, purple 3.58.
  stages: [
    { charge: 1.00, boost: 0.85, strength: 0.30, color: 0x53c4ff, name: 'blue' },
    { charge: 2.20, boost: 1.30, strength: 0.40, color: 0xffa524, name: 'orange' },
    { charge: 3.80, boost: 1.90, strength: 0.52, color: 0xc46bff, name: 'purple' },
  ],
  // Releasing the stick fully straight for this long cancels the drift.
  cancelTime: 0.28,
};

export const BOOST = {
  pad:      { time: 1.35, strength: 0.48 },
  mushroom: { time: 1.55, strength: 0.55 },
  star:     { time: 7.00, strength: 0.34 },
  bullet:   { time: 6.00, strength: 1.25 },
  trick:    { time: 0.70, strength: 0.28 },
  // Extra acceleration multiplier while any boost is active.
  accelMultiplier: 2.4,
};

export const DRAFT = {
  // Slipstream cone behind another kart.
  maxDistance: 13.0,
  minDistance: 2.2,
  halfAngle: 0.42,
  // Time in the cone before the slipstream boost fires.
  buildTime: 1.15,
  strength: 0.20,
  releaseBoost: { time: 0.9, strength: 0.30 },
};

export const COLLISION = {
  // Kart-vs-kart.
  restitution: 0.42,
  speedLoss: 0.90,
  // Wall.
  wallSpeedLoss: 0.62,
  wallBounce: 0.30,
  // A glancing wall hit shouldn't kill all momentum, a head-on one should.
  wallGlanceAngle: 0.55,
};

export const RESPAWN = {
  fallY: -60,          // below this, you're gone
  liftTime: 1.15,      // Lakitu pickup
  dropTime: 0.55,
  invulnTime: 1.5,
  height: 6.0,
};

/**
 * Per-character stat lines. Weight affects collisions, handling scales the
 * steer rate, and the speed/accel trade-off is the classic heavy-vs-light
 * spread. Values are multipliers on the DRIVE base.
 *
 * The second half of each row is pure presentation and is consumed only by
 * KartModel. Hue alone is not identity: at 1080p, from behind, at speed, what
 * separates one rival from another is silhouette. So every character also
 * picks a chassis `build` (track width, ride height, bodywork depth), a `wing`
 * (the tallest thing on the kart and therefore the first thing read), a
 * `helmet` profile and a `livery` pattern. Builds and wings are cached by
 * shape, so twelve karts still cost a handful of geometry buffers.
 */
export const CHARACTERS = [
  { id: 'nova',   name: 'Nova',   weight: 1.00, speed: 1.00, accel: 1.00, handling: 1.00, color: 0xff3b57, accent: 0xffe14d, cls: 'medium',
    build: 'gt',      wing: 'swan',     helmet: 'aero',   livery: 'bolt',    num: 1 },
  { id: 'blitz',  name: 'Blitz',  weight: 0.82, speed: 0.95, accel: 1.14, handling: 1.12, color: 0x30d0ff, accent: 0xffffff, cls: 'light',
    build: 'dart',    wing: 'ducktail', helmet: 'crest',  livery: 'chevron', num: 7 },
  { id: 'boulder',name: 'Boulder',weight: 1.30, speed: 1.08, accel: 0.86, handling: 0.88, color: 0x8b5a2b, accent: 0xffb020, cls: 'heavy',
    build: 'bruiser', wing: 'slab',     helmet: 'bucket', livery: 'blocks',  num: 44 },
  { id: 'iris',   name: 'Iris',   weight: 0.90, speed: 0.97, accel: 1.08, handling: 1.08, color: 0xc06bff, accent: 0x60ffd0, cls: 'light',
    build: 'dart',    wing: 'swan',     helmet: 'aero',   livery: 'wave',    num: 12 },
  { id: 'rook',   name: 'Rook',   weight: 1.18, speed: 1.05, accel: 0.92, handling: 0.94, color: 0x2b3f8b, accent: 0xff5a3c, cls: 'heavy',
    build: 'bruiser', wing: 'gt',       helmet: 'horn',   livery: 'stripe',  num: 3 },
  { id: 'sprig',  name: 'Sprig',  weight: 0.86, speed: 0.96, accel: 1.12, handling: 1.10, color: 0x4ad46a, accent: 0xfff0a0, cls: 'light',
    build: 'dart',    wing: 'gt',       helmet: 'dome',   livery: 'leaf',    num: 9 },
  { id: 'ember',  name: 'Ember',  weight: 1.02, speed: 1.02, accel: 0.99, handling: 0.99, color: 0xff7a1a, accent: 0x2b1b12, cls: 'medium',
    build: 'gt',      wing: 'gt',       helmet: 'dome',   livery: 'flame',   num: 5 },
  { id: 'frost',  name: 'Frost',  weight: 1.06, speed: 1.03, accel: 0.96, handling: 0.97, color: 0xa8e8ff, accent: 0x2060a0, cls: 'medium',
    build: 'gt',      wing: 'swan',     helmet: 'crest',  livery: 'shard',   num: 21 },
  { id: 'tarmac', name: 'Tarmac', weight: 1.24, speed: 1.06, accel: 0.89, handling: 0.91, color: 0x3a3f46, accent: 0xd8ff40, cls: 'heavy',
    build: 'bruiser', wing: 'ducktail', helmet: 'bucket', livery: 'hazard',  num: 88 },
  { id: 'pixel',  name: 'Pixel',  weight: 0.94, speed: 0.99, accel: 1.05, handling: 1.05, color: 0xff5fa8, accent: 0x40e0ff, cls: 'medium',
    build: 'gt',      wing: 'ducktail', helmet: 'crest',  livery: 'pixel',   num: 16 },
  { id: 'volt',   name: 'Volt',   weight: 0.88, speed: 0.98, accel: 1.10, handling: 1.09, color: 0xffe321, accent: 0x1a1a2e, cls: 'light',
    build: 'dart',    wing: 'slab',     helmet: 'crest',  livery: 'bolt',    num: 8 },
  { id: 'onyx',   name: 'Onyx',   weight: 1.34, speed: 1.10, accel: 0.84, handling: 0.86, color: 0x1a1a22, accent: 0x9b30ff, cls: 'heavy',
    build: 'bruiser', wing: 'slab',     helmet: 'horn',   livery: 'carbon',  num: 13 },
  // No two rows share build+wing+helmet. From behind at 108 km/h that triple
  // is the whole of a rival's identity; colour is only the tiebreak.
];

export function statsFor(characterId) {
  const c = CHARACTERS.find((x) => x.id === characterId) || CHARACTERS[0];
  return {
    ...c,
    topSpeed: DRIVE.topSpeed * c.speed,
    accel: DRIVE.accel * c.accel,
    steerRate: DRIVE.maxSteerRate * c.handling,
    mass: c.weight,
  };
}
