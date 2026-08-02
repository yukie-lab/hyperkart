import * as THREE from 'three';
import { RenderSystem, QUALITY_PRESETS } from './render/Renderer.js';
import { SkySystem } from './render/SkySystem.js';
import { Lighting } from './render/Lighting.js';
import { PostFX } from './render/PostFX.js';
import { Input } from './core/Input.js';
import { Loop } from './core/Loop.js';
import { ChaseCamera } from './kart/ChaseCamera.js';
import { Race, RACE_STATE } from './game/Race.js';
import { AIDriver } from './ai/AIDriver.js';
import { HUD } from './ui/HUD.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { TRACKS, TRACK_ORDER } from './track/Tracks.js';
import { clamp01 } from './core/MathX.js';

/**
 * Entry point: wires the render stack, the race, and input into one loop, and
 * exposes a small deterministic control surface on `window.__hk` so the
 * screenshot harness can drive the game to an exact moment and capture it.
 */

const params = new URLSearchParams(location.search);
const opt = (k, d) => (params.has(k) ? params.get(k) : d);

const trackId = TRACKS[opt('track', 'sunsetCoast')] ? opt('track', 'sunsetCoast') : 'sunsetCoast';
const quality = QUALITY_PRESETS[opt('quality', 'high')] ? opt('quality', 'high') : 'high';
const fieldSize = Math.max(2, Math.min(12, parseInt(opt('field', '12'), 10) || 12));
const autopilot = opt('auto', '0') === '1';
const shotMode = opt('shot', '0') === '1';

const container = document.getElementById('app');
const uiRoot = document.getElementById('ui');

// --- Render stack ----------------------------------------------------------
const rs = new RenderSystem(container, { quality, preserveDrawingBuffer: shotMode });
const scene = rs.scene;
const camera = rs.camera;

const trackDef = TRACKS[trackId];
rs.applyTheme(trackDef.theme);
const sky = new SkySystem(rs.renderer, scene);
const sunDir = sky.build(trackDef.theme);
const envMap = sky.envMap;

const lighting = new Lighting(scene, { quality: QUALITY_PRESETS[quality].shadow });
lighting.applyTheme(trackDef.theme, sunDir, sky.sunIntensity);

const race = new Race(scene, trackDef, {
  fieldSize,
  envMap,
  quality,
  maxParticles: QUALITY_PRESETS[quality].maxParticles,
  playerCharacter: opt('character', 'nova'),
  seed: parseInt(opt('seed', '20250802'), 10) || 20250802,
});
race.items.setEnvMap(envMap);

const post = new PostFX(rs.renderer, scene, camera, {
  msaa: QUALITY_PRESETS[quality].msaa,
});
post.applyTheme(trackDef.theme);
// Exposure is metered off the sky, not authored per track.
post.setExposure(sky.exposure);

const chase = new ChaseCamera(camera, { mode: opt('cam', 'chase') });
chase.snapTo(race.player);

const hud = new HUD(uiRoot);
hud.setTrack(race.track);

// Audio needs a user gesture before an AudioContext may run.
const audio = new AudioEngine({ volume: 0.8 });
for (const k of race.karts) audio.attachKart(k, k.isPlayer);
const kickAudio = () => { audio.start(); window.removeEventListener('pointerdown', kickAudio); window.removeEventListener('keydown', kickAudio); };
window.addEventListener('pointerdown', kickAudio);
window.addEventListener('keydown', kickAudio);

rs.onResize = (w, h) => post.setSize(w, h);
rs.onPixelRatioChange = (r) => post.setPixelRatio(r);
post.setSize(rs.width, rs.height);

// --- Input -----------------------------------------------------------------
const input = new Input(window);
// Autopilot lets the harness (and the attract mode) produce a real race
// without a human at the wheel.
const autoDriver = autopilot ? new AIDriver(race.player, race.track, { skill: 0.92, seed: 31337 }) : null;

let lookBack = false;
let shakeImpulse = 0;
let dipImpulse = 0;
let hitFlash = 0;

// --- Loop ------------------------------------------------------------------
const loop = new Loop({
  hz: 120,
  step: (dt) => {
    input.update(dt);

    let ctrl;
    if (autoDriver) {
      ctrl = autoDriver.update(dt, race._ctx);
      ctrl = {
        steer: ctrl.steer, accel: ctrl.accel, brake: ctrl.brake,
        drift: ctrl.drift, driftPressed: ctrl.driftPressed,
        item: false, itemPressed: !!ctrl.useItem,
      };
    } else {
      ctrl = input.state;
    }

    race.step(dt, ctrl);
    handleEvents(race.drainEvents());
    input.endFrame();
    lookBack = input.state.look;
  },
  render: (alpha, dt) => {
    presentFrame(alpha, dt);
    audio.update(dt, race, { pos: camera.position, quat: camera.quaternion });
    rs.adaptResolution(dt, loop.smoothedFrameMs);
  },
});

/**
 * Everything between "the simulation has a new state" and "a frame is on the
 * screen", in one place.
 *
 * The harness used to carry its own abbreviated copy of this, and the copy had
 * quietly diverged: it passed `hit: 0` literally, dropped `shakeImpulse` and
 * `dipImpulse` on the floor, and never called `sky.update`. So no capture this
 * project has ever taken could show a hit flash, an impact shake, a landing
 * compression, or a cloud that had moved — `uTime` sat at zero, which means
 * every sky in every review frame was the t=0 sky. Three rubric criteria were
 * being scored against evidence that structurally could not contain them.
 */
function presentFrame(alpha, dt) {
  const p = race.player;

  race.render(alpha, dt, camera.position);

  if (race.state === RACE_STATE.FINISHED && p.finished) {
    chase.updateOrbit(dt, p.visualPos, loop.simTime);
  } else {
    chase.update(dt, p, { lookBack, shakeImpulse, dipImpulse });
  }
  shakeImpulse = 0;
  dipImpulse = 0;

  sky.follow(camera.position);
  sky.update(dt, loop.simTime);
  lighting.update(dt, p.visualPos, _fwd.set(Math.sin(p.yaw), 0, Math.cos(p.yaw)));

  race.fx.setPixelScale(rs.height * rs.currentPixelRatio, camera.fov);

  // Where the kart is actually heading, in screen space, so the speed blur
  // radiates from the vanishing point of travel rather than from the middle of
  // the monitor.
  _focus.set(
    p.visualPos.x + Math.sin(p.yaw) * 26,
    p.visualPos.y + 1.2,
    p.visualPos.z + Math.cos(p.yaw) * 26,
  ).project(camera);

  post.update(dt, {
    speed01: clamp01(Math.abs(p.speed) / Math.max(p.stats.topSpeed, 1)),
    boosting: p.boostActive,
    hit: hitFlash,
    time: loop.simTime,
    center: [_focus.x * 0.5 + 0.5, _focus.y * 0.5 + 0.5],
  });
  hitFlash = 0;

  hud.update(dt, race);

  rs.beginFrame();
  post.render(dt);
}

const _fwd = new THREE.Vector3();
const _focus = new THREE.Vector3();

function handleEvents(events) {
  for (const e of events) {
    audio.handleEvent(e);
    switch (e.type) {
      case 'countdown':
        hud.countdown(e.n, race.time);
        break;
      case 'go':
        hud.countdown(0, race.time);
        break;
      case 'hit':
        if (e.kart === race.player) { shakeImpulse = 0.55; hitFlash = 1; }
        // `e.cause` is the one key every hit carries — this used to read `e.by`,
        // which only the item system's (now removed) duplicate event set, so the
        // banana branch was unreachable and every hit came out orange. The cause
        // goes to the FX layer too: a peel, a shell and a thunder are three
        // different events and should not share one burst.
        race.fx.impact(e.kart.pos, e.cause === 'banana' ? 0xf5d02a : 0xff7744, 30, e.cause);
        break;
      case 'wallHit':
        if (e.kart === race.player) shakeImpulse = Math.min(0.5, e.force * 0.5);
        break;
      case 'boost':
        if (e.kart === race.player && e.kind === 'drift') {
          shakeImpulse = 0.12 + (e.stage ?? 0) * 0.06;
        }
        break;
      case 'land':
        // A landing is a compression, not a rattle: the rig drops into the
        // suspension and recovers. Shake alone reads as hitting a pothole.
        if (e.kart === race.player) {
          shakeImpulse = Math.min(0.22, e.impact * 0.22);
          dipImpulse = Math.min(0.6, e.impact * 0.55);
        }
        break;
      case 'finish':
        if (e.kart === race.player) hud.toast(`FINISH — ${e.place}${ordinalSuffix(e.place)}`, '#ffd75e');
        break;
      // `itemGet` has no case: the HUD locks the slot off its own state diff in
      // `HUD.update`, and `audio.handleEvent` above sees every event regardless.
    }
  }
}

function ordinalSuffix(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
}

// In capture mode the harness owns the clock from the very first frame. Even
// starting the loop and stopping it at `ready` is not enough: waiting for that
// flag costs a variable number of real frames, so the simulation was already
// 0.11-0.13 s in — a different amount every run — before any capture began.
// That, plus the adaptive-resolution controller reacting to real frame time,
// is why two runs of identical code differed on most of their pixels and why
// no small visual regression could be measured.
if (!shotMode) loop.start();

// --- Harness ---------------------------------------------------------------
// Lets the screenshot tool fast-forward the deterministic simulation to an
// exact moment, pick a camera, and capture — the same frame every run.
const harness = {
  ready: false,
  version: 1,
  race, loop, chase, post, rs, sky, lighting, hud, audio, scene, camera,
  trackId,

  /**
   * Advance the simulation by `seconds`.
   *
   * The presentation layer is advanced too, which it did not used to be. A
   * seek only ran `race.step`, so every one-shot effect spawned during the
   * skipped span was born and then never aged: a captured frame arrived
   * carrying roughly two thousand frozen particles strewn around the circuit,
   * and the additive pool read 2480 of 2480 when a live race peaks near 579.
   * Every continuous effect was then being judged from the fraction of the
   * pool it could still win — and one agent nearly shipped an emission-rate
   * cut to fix "contention" that only existed in the harness.
   *
   * Ageing costs a particle update per step and no GPU work, which is cheap
   * next to being unable to review a visual effect at all.
   */
  seek(seconds) {
    const driver = autoDriver || new AIDriver(race.player, race.track, { skill: 0.92, seed: 31337 });
    const saved = loop.step;
    // Seat the rig on the selected mode *before* advancing, not after. `snapTo`
    // also clears roll, shake, dip and FOV kick, which is right for a camera
    // that has no history yet — a fresh page at t=0 — and wrong for one that
    // has just been driven through a corner.
    chase.snapTo(race.player);
    loop.step = (dt) => {
      const c = driver.update(dt, race._ctx);
      race.step(dt, {
        steer: c.steer, accel: c.accel, brake: c.brake,
        drift: c.drift, driftPressed: c.driftPressed,
        item: false, itemPressed: !!c.useItem,
      });
      handleEvents(race.drainEvents());
      race.render(1, dt, camera.position);
      // The camera lives through the seek like everything else.
      //
      // It used to be zeroed on arrival instead, to keep a frame's identity
      // independent of the route taken to reach it. d8246b3 bought that a
      // better way -- shot.mjs reloads the page per requested time, so there is
      // only ever one route -- but the reset stayed, and the eight settle
      // frames recover only part of what it threw away. Every capture in five
      // rounds of critique was 2.4-3.3 degrees under-banked and up to 5.8
      // degrees short on FOV, which is to say camera lean and FOV-driven speed,
      // two of the things the review exists to judge, were never once reviewed
      // at the value a player sees.
      chase.update(dt, race.player, { lookBack: false, shakeImpulse, dipImpulse });
      shakeImpulse = 0;
      dipImpulse = 0;
    };
    loop.fastForward(seconds);
    loop.step = saved;
    // Re-seat presentation state so the very next frame is correct.
    race.render(1, 1 / 60, camera.position);
    return { time: loop.simTime, lap: race.player.lap, speed: race.player.speedKmh };
  },

  /**
   * Advance the simulation and the presentation together, the way the live
   * loop does.
   *
   * The harness used to seek to a target and then present eight frames without
   * stepping anything, so every capture this project has ever taken showed the
   * world 133 ms after the moment it asked for. An impact flash lasting 55 ms
   * was structurally invisible to all of them — the effect was reviewed, and
   * repeatedly redesigned, purely on its litter. Stepping while settling costs
   * nothing and makes the requested time the time you actually see.
   */
  settle(frames = 8, dt = 1 / 60) {
    const driver = autoDriver || new AIDriver(race.player, race.track, { skill: 0.92, seed: 31337 });
    const steps = Math.max(1, Math.round(dt / loop.fixedDt));
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < steps; k++) {
        const c = driver.update(loop.fixedDt, race._ctx);
        race.step(loop.fixedDt, {
          steer: c.steer, accel: c.accel, brake: c.brake,
          drift: c.drift, driftPressed: c.driftPressed,
          item: false, itemPressed: !!c.useItem,
        });
        handleEvents(race.drainEvents());
        loop.simTime += loop.fixedDt;
      }
      presentFrame(1, dt);
    }
    return loop.simTime;
  },

  setCamera(mode) { chase.setMode(mode); },
  setHud(v) { hud.setVisible(v); },
  setQuality(q) { rs.setQuality(q); },

  /**
   * Hand the frame clock to the harness.
   *
   * Stops the live loop so that nothing advances between an explicit `seek`
   * and an explicit `frame`, and pins the pixel ratio so the adaptive
   * controller cannot resize the target mid-series. Both were sources of
   * capture nondeterminism that made small visual regressions unmeasurable.
   */
  stopForCapture() {
    loop.stop();
    rs.minPixelRatio = rs.maxPixelRatio = rs.currentPixelRatio;
    return { pixelRatio: rs.currentPixelRatio, simTime: loop.simTime };
  },

  /**
   * Render exactly one frame, awaiting GPU completion.
   *
   * The await yields to the browser, and the live `Loop` is driven by its own
   * requestAnimationFrame — so every settle frame the harness took was also
   * letting the simulation advance behind it, and letting `adaptResolution`
   * change the pixel ratio mid-capture. A capture asked for t=91.90 came back
   * holding state from t≈92.0, and two runs of identical code differed on most
   * of their pixels. `stopForCapture()` closes both holes.
   */
  async frame(dt = 1 / 60) {
    // Present first, pin the animations afterwards.
    //
    // The order matters more than anything else in this method. `presentFrame`
    // calls `hud.update()`, which changes classes on the item slot and the
    // banners, and a class change *starts a fresh CSS animation*. Pinning
    // before presenting therefore froze the previous frame's animations and
    // then let `hud.update` start new ones that ran free until the shutter --
    // so the item slot still alternated between two images across runs, over
    // exactly the 820..1100 x 0..271 it occupies, which is the region the
    // original t=12 failure had already pointed at.
    presentFrame(1, dt);

    // Seek the HUD's Web Animations to a deterministic time rather than
    // finishing them.
    //
    // `finish()` made captures reproducible and also deleted the thing being
    // reviewed: the countdown numeral is at opacity 0.273 mid-animation and at
    // exactly 0 once finished, so three rounds of critique judged "the opening
    // frame of a kart racer" with its single largest HUD element erased —
    // 171x279 px, laid out and composited every frame, invisible in every
    // capture. Infinite animations have no end to seek to, so they are rewound.
    //
    // Pinning `currentTime` to the race clock *itself* then repeated the same
    // error one level down. An animation is at `now - its own start`, not at
    // `now`: the countdown numeral runs 940 ms, so every capture taken after
    // race time 0.94 clamped it to its own end and rendered it fully faded.
    // Sampled across the 3.6 s countdown, the numeral appeared in one moment
    // out of five. HUD animations now carry the race clock they were issued
    // on, and the seek is relative to that.
    // Every finite animation is seeked, whatever its `playState`. Skipping the
    // finished ones made the capture depend on the wall clock, which is the one
    // thing it must never do: whether a 240 ms banner had finished by the time
    // the harness got round to shooting was a question about how fast the
    // machine felt, so t=12 on sunsetCoast alternated between exactly two
    // images across runs. With the HUD off the same four runs were already
    // byte-identical, which is what named the HUD as the source. Seeking a
    // genuinely finished animation to its own end is a no-op, so nothing is
    // lost by not asking.
    for (const a of document.getAnimations()) {
      try {
        const t = a.effect?.getComputedTiming?.();
        // Paused *before* being rewound. Rewinding a still-running animation
        // only resets it and lets it play on, and real time passes between here
        // and the shutter -- the item slot's reel is `steps(2,end)` over 90 ms,
        // so it landed on either of its two frames depending on how long the
        // screenshot took. That was 0.95% of the frame flipping between exactly
        // two images at t=12, which is precisely what was seen.
        if (t?.iterations === Infinity) { a.pause(); a.currentTime = 0; }
        else {
          a.pause();
          const dur = (t?.activeDuration ?? 0) || 0;
          const born = a.__hkRaceStart;
          // An unstamped animation is a CSS one, started by a class change at
          // a race time nobody recorded. Pin it to its END, not to zero: these
          // are 220 ms entrances, long finished by the time anything is
          // captured, and their end state is also the element's settled look --
          // so the frame is the same whether or not the animation still exists.
          // Pinning them to zero instead put the ITEM label on its first frame,
          // invisible, and since its existence depended on whether hud.update
          // had just re-triggered it, the label blinked in and out across runs.
          a.currentTime = born === undefined
            ? dur
            : Math.min(Math.max(0, (race.time - born) * 1000), dur);
        }
      } catch { /* an animation that cannot be settled is not worth failing a capture over */ }
    }
    // Force the pinned state through style and layout before the compositor is
    // allowed to sample it. Pausing settles an animation's state but does not
    // guarantee that state has been composited by the time the screenshot is
    // taken -- and reading a layout property is what a devtools inspection was
    // accidentally doing, which is why this always measured deterministic and
    // did not always photograph that way.
    void document.documentElement.offsetHeight;
    await new Promise((r) => requestAnimationFrame(r));
  },

  stats() {
    const p = race.player;
    return {
      time: loop.simTime,
      // Null in capture mode: the loop is not running, so `smoothedFrameMs`
      // is still its constructor value and any rate derived from it is
      // invented. Measure frame rate with the loop running instead.
      frameMs: loop.frameCount ? loop.smoothedFrameMs : null,
      fps: loop.frameCount ? 1000 / loop.smoothedFrameMs : null,
      pixelRatio: rs.currentPixelRatio,
      drawCalls: rs.renderer.info.render.calls,
      triangles: rs.renderer.info.render.triangles,
      programs: rs.renderer.info.programs?.length ?? 0,
      player: {
        rank: p.rank, lap: p.lap, speedKmh: Math.round(p.speedKmh),
        drift: p.drift.active, driftStage: p.drift.stage,
        boosting: p.boostActive, onRoad: p.ground.onRoad, item: p.item,
        pos: [p.pos.x, p.pos.y, p.pos.z],
      },
      state: race.state,
    };
  },
};

window.__hk = harness;
window.THREE = THREE;

// Signal readiness only once a frame has actually been presented, so the
// harness never screenshots a blank canvas.
requestAnimationFrame(() => requestAnimationFrame(() => {
  harness.ready = true;
  document.body.dataset.hkReady = '1';
}));

// Surface runtime errors to the harness rather than only the console.
window.__hkErrors = [];
window.addEventListener('error', (e) => window.__hkErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__hkErrors.push(String(e.reason)));
