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

    post.update(dt, {
      speed01: clamp01(Math.abs(p.speed) / Math.max(p.stats.topSpeed, 1)),
      boosting: p.boostActive,
      hit: hitFlash,
      time: loop.simTime,
    });
    hitFlash = 0;

    hud.update(dt, race);
    audio.update(dt, race, { pos: camera.position, quat: camera.quaternion });

    rs.beginFrame();
    post.render(dt);
    rs.adaptResolution(dt, loop.smoothedFrameMs);
  },
});

const _fwd = new THREE.Vector3();

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
        race.fx.impact(e.kart.pos, e.by === 'banana' ? 0xf5d02a : 0xff7744, 30);
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
      case 'itemGet':
        break;
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
    loop.step = (dt) => {
      const c = driver.update(dt, race._ctx);
      race.step(dt, {
        steer: c.steer, accel: c.accel, brake: c.brake,
        drift: c.drift, driftPressed: c.driftPressed,
        item: false, itemPressed: !!c.useItem,
      });
      handleEvents(race.drainEvents());
      race.render(1, dt, camera.position);
    };
    loop.fastForward(seconds);
    loop.step = saved;
    // Re-seat presentation state so the very next frame is correct.
    race.render(1, 1 / 60, camera.position);
    chase.snapTo(race.player);
    return { time: loop.simTime, lap: race.player.lap, speed: race.player.speedKmh };
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
    // Settle the HUD's Web Animations. Retiring the countdown off the race
    // clock made *whether* a banner is on screen deterministic, but its
    // keyframes still run on the browser's clock, so a grid capture came back
    // with the numeral at a different point in its scale curve every time —
    // 0.84% of the frame. Finishing them pins the HUD in its settled state.
    // Anything infinite (the item slot's idle shimmer) is rewound instead,
    // since it has no end to seek to.
    for (const a of document.getAnimations()) {
      try {
        const it = a.effect?.getComputedTiming?.().iterations;
        if (it === Infinity) a.currentTime = 0;
        else a.finish();
      } catch { /* an animation that cannot be settled is not worth failing a capture over */ }
    }
    race.render(1, dt, camera.position);
    chase.update(dt, race.player, { lookBack: false });
    sky.follow(camera.position);
    lighting.update(dt, race.player.visualPos, _fwd.set(Math.sin(race.player.yaw), 0, Math.cos(race.player.yaw)));
    race.fx.setPixelScale(rs.height * rs.currentPixelRatio, camera.fov);
    post.update(dt, {
      speed01: clamp01(Math.abs(race.player.speed) / race.player.stats.topSpeed),
      boosting: race.player.boostActive, hit: 0, time: loop.simTime,
    });
    hud.update(dt, race);
    rs.beginFrame();
    post.render(dt);
    await new Promise((r) => requestAnimationFrame(r));
  },

  stats() {
    const p = race.player;
    return {
      time: loop.simTime,
      frameMs: loop.smoothedFrameMs,
      fps: 1000 / loop.smoothedFrameMs,
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
