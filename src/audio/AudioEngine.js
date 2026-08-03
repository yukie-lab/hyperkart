/**
 * Procedural audio.
 *
 * There are no sound files in this project — everything is synthesised with
 * the Web Audio API at runtime: engine tone driven by RPM, tyre scrub, drift
 * charge, boost, impacts, item stings, crowd ambience and music.
 *
 * Owned by the audio system. `main` constructs one, starts it on the first
 * user gesture (browsers require this), forwards race events, and calls
 * `update()` each frame.
 *
 * Contract:
 *   new AudioEngine({ maxVoices })
 *   await .start()                  // resume the AudioContext
 *   .attachKart(kart, isPlayer)     // register a per-kart engine voice
 *   .handleEvent(event)             // race events: boost/hit/lap/countdown/...
 *   .update(dt, race, listener)     // listener = { pos, quat, velocity }
 *   .setMasterVolume(v) / .setMuted(b)
 *   .dispose()
 *
 * Two structural notes.
 *
 * Every node is built against `this.ctx`, which may be an `OfflineAudioContext`
 * passed in as `opts.context`. That is not a test seam bolted on afterwards —
 * it is the only way to verify a soundscape without listening to it, and
 * `AudioUtil` was written context-agnostic for exactly this reason.
 *
 * Nothing here may consume main-thread time proportional to the frame rate
 * beyond a fixed number of `setTargetAtTime` writes: the synthesis runs on the
 * audio thread, and `update()` only steers it.
 */
import {
  clamp, clamp01, lerp, midi, makeRng,
  makeNoiseBuffer, makeImpulse, softClipCurve,
  setTarget, setNow, expRamp, ampEnv, place, orient,
} from './AudioUtil.js';

/**
 * A kart engine is not one pitch. Real ones step through gears, and the ear
 * reads the *reset* at each shift as acceleration far more strongly than it
 * reads absolute pitch — so the tone climbs across a gear and drops back on
 * the change, rather than sweeping monotonically from idle to redline.
 */
const ENGINE = {
  gears: 5,
  idleHz: 42,
  gearBottom: 0.62,   // fraction of the gear's top pitch it restarts at
  topHz: 168,
  detune: 7,          // cents between the two saws; the beat is the "roughness"
  cutoffIdle: 420,
  cutoffFull: 5200,
  loadFloor: 0.16,    // audible at a standstill, so an idling grid is not silent
};

/** Distances in metres for the 3D panners. */
const SPACE = { ref: 9, max: 190, rolloff: 1.15 };

const MIX = {
  master: 0.9,
  engineSelf: 0.24,   // the player's own engine, not panned
  engineOther: 0.5,   // rivals, panned and distance-attenuated
  tyre: 0.5,
  wind: 0.16,
  ambience: 0.09,
  music: 0.16,
  reverbSend: 0.16,
};

export class AudioEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.masterVolume = opts.volume ?? 0.8;
    this.karts = new Map();
    this.maxVoices = opts.maxVoices ?? 12;
    this._rng = makeRng(0xa11d10);
    this._t = 0;
    this._musicBar = 0;
    this._nodes = null;
  }

  async start() {
    if (this.started) return;
    // An injected context is already running and must not be resumed.
    if (this.opts.context) {
      this.ctx = this.opts.context;
    } else {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    }
    this._build();
    this.started = true;
    for (const [kart, rec] of this.karts) {
      if (!rec.voice) rec.voice = this._makeVoice(kart, rec.isPlayer);
    }
  }

  // -- graph ----------------------------------------------------------------

  /**
   * Master chain: everything meets at `bus`, which is shaped and limited before
   * the destination. The waveshaper is a mathematical bound rather than a
   * flavour — twelve engines, a crowd and a thunder can coincide, and the sum
   * must still be inside 0 dBFS without anyone having to budget for it.
   */
  _build() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.masterVolume * MIX.master;

    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1.7);
    shaper.oversample = '2x';

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.005;
    comp.release.value = 0.16;

    const bus = ctx.createGain();
    bus.gain.value = 1;

    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx, { seconds: 1.9, decay: 2.7, damp: 0.4 });
    const verbGain = ctx.createGain();
    verbGain.gain.value = MIX.reverbSend;

    bus.connect(master);
    bus.connect(verb);
    verb.connect(verbGain);
    verbGain.connect(master);
    master.connect(shaper);
    shaper.connect(comp);
    comp.connect(ctx.destination);

    // Shared noise tables. One buffer feeds every scrub, wind and crowd voice;
    // allocating one per kart would cost megabytes for identical data.
    const white = makeNoiseBuffer(ctx, 2.0, { type: 'white', seed: 5150 });
    const pink = makeNoiseBuffer(ctx, 3.0, { type: 'pink', seed: 90210 });

    this._nodes = { master, shaper, comp, bus, verb, verbGain, white, pink };

    this._buildWind();
    this._buildAmbience();
    this._buildMusic();
  }

  /** Speed noise. Rises with velocity and opens up as the kart goes faster. */
  _buildWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._nodes.white;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bp); bp.connect(g); g.connect(this._nodes.bus);
    src.start();
    this._nodes.wind = { src, bp, g };
  }

  /** A crowd/air bed so the circuit is never digitally silent. */
  _buildAmbience() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._nodes.pink;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.value = MIX.ambience;
    src.connect(lp); lp.connect(g); g.connect(this._nodes.bus);
    src.start();
    this._nodes.ambience = { src, lp, g };
  }

  /**
   * A bed, not a composition: a slow fifth-based drone with a pulse on the
   * beat. It exists so the mix has a floor and a tempo to hang stings off,
   * and it is deliberately quiet enough to sit under the engines.
   */
  _buildMusic() {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this._nodes.bus);

    const voices = [];
    for (const [note, level] of [[33, 0.5], [40, 0.34], [52, 0.16]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(note);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;
      lp.Q.value = 0.7;
      const vg = ctx.createGain();
      vg.gain.value = level;
      o.connect(lp); lp.connect(vg); vg.connect(g);
      o.start();
      voices.push({ o, lp, vg });
    }
    this._nodes.music = { g, voices, level: 0 };
  }

  // -- karts ----------------------------------------------------------------

  attachKart(kart, isPlayer) {
    const rec = { isPlayer, voice: null };
    this.karts.set(kart, rec);
    if (this.started) rec.voice = this._makeVoice(kart, isPlayer);
  }

  /**
   * One engine voice plus one tyre voice per kart.
   *
   * The player's own kart is not panned: a racer's engine is *around* them, not
   * to one side, and panning it makes the camera feel like a microphone on a
   * boom. Rivals are panned and distance-attenuated so the pack has a shape.
   */
  _makeVoice(kart, isPlayer) {
    const ctx = this.ctx;
    const dest = this._nodes.bus;

    // The per-kart bus stays open; the engine and tyre gains under it are what
    // get steered. (Initialised to 0 it silences the whole voice no matter what
    // `_steerVoice` writes, which is precisely how the first version of this
    // shipped inaudible and how `tools/audioaudit.mjs` caught it.)
    const out = ctx.createGain();
    out.gain.value = 1;

    let panner = null;
    if (isPlayer) {
      out.connect(dest);
    } else {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = SPACE.ref;
      panner.maxDistance = SPACE.max;
      panner.rolloffFactor = SPACE.rolloff;
      out.connect(panner);
      panner.connect(dest);
    }

    // Engine: two detuned saws for body, a sine an octave down for weight.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = ENGINE.cutoffIdle;
    lp.Q.value = 1.1;
    const engGain = ctx.createGain();
    engGain.gain.value = 0;
    lp.connect(engGain); engGain.connect(out);

    const oscs = [];
    for (const [type, det, level] of [['sawtooth', -ENGINE.detune, 0.5],
      ['sawtooth', ENGINE.detune, 0.5], ['sine', 0, 0.42]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g); g.connect(lp);
      o.start();
      oscs.push(o);
    }

    // Tyres: bandpassed noise, opened by slip and by surface roughness.
    const tSrc = ctx.createBufferSource();
    tSrc.buffer = this._nodes.white;
    tSrc.loop = true;
    // Each kart reads the shared table from a different place so twelve karts
    // do not scrub in phase, which would sum into one loud comb-filtered tone.
    tSrc.loopStart = this._rng() * 1.5;
    tSrc.loopEnd = tSrc.loopStart + 0.4;
    const tBp = ctx.createBiquadFilter();
    tBp.type = 'bandpass';
    tBp.frequency.value = 1900;
    tBp.Q.value = 1.4;
    const tGain = ctx.createGain();
    tGain.gain.value = 0;
    tSrc.connect(tBp); tBp.connect(tGain); tGain.connect(out);
    tSrc.start(0, tSrc.loopStart);

    return { out, panner, lp, engGain, oscs, tSrc, tBp, tGain, gear: 0 };
  }

  // -- per-frame ------------------------------------------------------------

  update(dt, race, listener) {
    if (!this.started || !this._nodes) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._t += dt;

    if (listener?.pos) {
      place(ctx.listener, listener.pos.x, listener.pos.y, listener.pos.z, now);
      if (listener.quat) {
        // Three's camera looks down its own -Z; the Web Audio listener wants
        // that same forward vector, so rotate (0,0,-1) and (0,1,0) by the quat.
        const q = listener.quat;
        const f = _rotate(0, 0, -1, q);
        const u = _rotate(0, 1, 0, q);
        orient(ctx.listener, f[0], f[1], f[2], u[0], u[1], u[2], now);
      }
    }

    let player = null;
    for (const [kart, rec] of this.karts) {
      if (!rec.voice) continue;
      if (rec.isPlayer) player = kart;
      this._steerVoice(kart, rec, now);
    }

    if (player) {
      const v = clamp01(Math.abs(player.speed) / Math.max(player.stats.topSpeed, 1));
      const w = this._nodes.wind;
      setTarget(w.g.gain, MIX.wind * v * v, now, 0.08);
      setTarget(w.bp.frequency, lerp(500, 1500, v), now, 0.1);
      setTarget(w.bp.Q, lerp(0.5, 1.1, v), now, 0.1);
    }

    // The bed comes up once the lights go out and backs off at the flag.
    // Compared as a string rather than importing RACE_STATE, so the audio
    // system keeps no dependency on the game module.
    const target = MIX.music * (race?.state === 'racing' ? 1 : 0.35);
    setTarget(this._nodes.music.g.gain, target, now, 0.6);
  }

  /**
   * Steer one kart's continuous voices.
   *
   * Everything here is a `setTargetAtTime` on a value the simulation already
   * computed — no per-frame allocation, no node churn. `setTarget` drops writes
   * that would not change anything, which matters when twelve karts each push a
   * dozen parameters sixty times a second.
   */
  _steerVoice(kart, rec, now) {
    const v = rec.voice;
    const top = Math.max(kart.stats.topSpeed, 1);
    const speed01 = clamp01(Math.abs(kart.speed) / top);

    // Gears: pitch climbs across each band and resets on the change.
    const g = Math.min(ENGINE.gears - 1, Math.floor(speed01 * ENGINE.gears));
    const within = clamp01(speed01 * ENGINE.gears - g);
    const gearTop = lerp(ENGINE.idleHz * 2.2, ENGINE.topHz, (g + 1) / ENGINE.gears);
    const hz = lerp(gearTop * ENGINE.gearBottom, gearTop, within);
    const load = clamp01(Math.max(kart.engineLoad, ENGINE.loadFloor));
    // Airborne engines unload and rev; that is the sound of no traction.
    const revUp = kart.grounded ? 1 : 1.18;
    const boost = kart.boostActive ? 1.22 : 1;

    for (const o of v.oscs) setTarget(o.frequency, hz * revUp * boost, now, 0.045);
    setTarget(v.lp.frequency,
      lerp(ENGINE.cutoffIdle, ENGINE.cutoffFull, load * (kart.boostActive ? 1 : 0.82)), now, 0.06);

    const level = (rec.isPlayer ? MIX.engineSelf : MIX.engineOther)
      * lerp(0.35, 1, load) * (kart.finished ? 0.25 : 1);
    setTarget(v.engGain.gain, level, now, 0.05);

    // Tyres: drift is the loud case, surface rumble the textural one, and a
    // little sits under any fast cornering so the road is audible at all.
    const slip = clamp01(Math.abs(kart.lateralVel) * 0.42);
    const drift = kart.drift?.active ? 1 : 0;
    const scrub = clamp01(drift * 0.75 + slip * 0.6 + kart.rumble * 0.5) * (kart.grounded ? 1 : 0);
    setTarget(v.tGain.gain, MIX.tyre * scrub * lerp(0.3, 1, speed01), now, 0.05);
    setTarget(v.tBp.frequency, lerp(1300, 3000, drift ? 1 : speed01), now, 0.07);

    if (v.panner) place(v.panner, kart.pos.x, kart.pos.y, kart.pos.z, now, 0.03);
  }

  // -- one-shots ------------------------------------------------------------

  handleEvent(event) {
    if (!this.started || !this._nodes || !event) return;
    const now = this.ctx.currentTime;
    const at = event.kart ? event.kart.pos : null;
    const mine = !event.kart || this.karts.get(event.kart)?.isPlayer;
    // Rivals' events are quieter and placed; the player's are up front.
    const near = mine ? 1 : 0.45;

    switch (event.type) {
      case 'countdown':
        this._tone(now, midi(64), 0.16, { peak: 0.36 * near, decay: 0.28, type: 'triangle' });
        break;
      case 'go':
        this._tone(now, midi(76), 0.34, { peak: 0.46, decay: 0.5, type: 'triangle' });
        this._tone(now, midi(88), 0.34, { peak: 0.2, decay: 0.42, type: 'sine' });
        break;
      case 'boost':
        this._sweep(now, 260, 1500, 0.34, { peak: 0.34 * near, type: 'sawtooth' }, at);
        this._noise(now, { peak: 0.3 * near, decay: 0.42, f0: 700, f1: 4200 }, at);
        break;
      case 'driftStage': {
        // Each tier a fourth higher, so charge reads as a rising ladder.
        const stage = clamp(event.stage ?? 0, 0, 2);
        this._tone(now, midi(70 + stage * 5), 0.2, { peak: 0.24 * near, decay: 0.3, type: 'square' }, at);
        break;
      }
      case 'hit':
        this._thud(now, { peak: 0.6 * near, f: 92, decay: 0.34 }, at);
        this._noise(now, { peak: 0.5 * near, decay: 0.3, f0: 260, f1: 2600 }, at);
        break;
      case 'wallHit':
        this._thud(now, { peak: clamp01(event.force) * 0.55 * near, f: 74, decay: 0.28 }, at);
        this._noise(now, { peak: clamp01(event.force) * 0.32 * near, decay: 0.18, f0: 400, f1: 1800 }, at);
        break;
      case 'land':
        this._thud(now, { peak: clamp01(event.impact) * 0.42 * near, f: 66, decay: 0.2 }, at);
        break;
      case 'hop':
        this._tone(now, 340, 0.05, { peak: 0.13 * near, decay: 0.07, type: 'square' }, at);
        break;
      case 'trick':
        this._sweep(now, 700, 1700, 0.26, { peak: 0.2 * near, type: 'triangle' }, at);
        break;
      case 'itemBox':
      case 'itemGet':
        this._tone(now, midi(84), 0.1, { peak: 0.26 * near, decay: 0.14, type: 'sine' }, at);
        this._tone(now, midi(91), 0.1, { peak: 0.2 * near, decay: 0.22, type: 'sine' }, at, 0.07);
        break;
      case 'useMushroom':
        this._sweep(now, 400, 1200, 0.22, { peak: 0.3 * near, type: 'square' }, at);
        break;
      case 'useStar':
        for (let i = 0; i < 4; i++) {
          this._tone(now, midi(72 + i * 4), 0.12, { peak: 0.2 * near, decay: 0.2, type: 'triangle' }, at, i * 0.055);
        }
        break;
      case 'useThunder':
        this._noise(now, { peak: 0.62, decay: 1.15, f0: 3000, f1: 90 });
        this._thud(now, { peak: 0.5, f: 48, decay: 0.8 });
        break;
      case 'useBullet':
        this._sweep(now, 180, 900, 0.5, { peak: 0.34 * near, type: 'sawtooth' }, at);
        break;
      case 'useGreenShell':
      case 'useRedShell':
        // Found by the same trace that verified `itemDeclined`: shells were the
        // one item that could be thrown in silence. Red sits a fourth higher so
        // you can hear which one left your hands without looking.
        this._sweep(now, event.type === 'useRedShell' ? 520 : 390,
          event.type === 'useRedShell' ? 240 : 190, 0.20,
          { peak: 0.26 * near, type: 'square' }, at);
        this._noise(now, { peak: 0.18 * near, decay: 0.16, f0: 2200, f1: 700 }, at);
        break;
      case 'useBanana':
      case 'banana':
        this._noise(now, { peak: 0.2 * near, decay: 0.12, f0: 1500, f1: 500 }, at);
        break;
      case 'itemDeclined':
        // A soft, low, downward tick. Deliberately unlike the pickup's rising
        // pair: this is the same slot saying no.
        this._tone(now, midi(58), 0.05, { peak: 0.13 * near, decay: 0.10, type: 'sine' }, at);
        break;
      case 'shellBounce':
        this._tone(now, midi(79), 0.06, { peak: 0.2 * near, decay: 0.1, type: 'square' }, at);
        break;
      case 'lap':
        this._tone(now, midi(81), 0.18, { peak: 0.3, decay: 0.3, type: 'triangle' });
        break;
      case 'respawn':
        this._sweep(now, 900, 300, 0.3, { peak: 0.22 * near, type: 'sine' }, at);
        break;
      case 'finish':
        for (let i = 0; i < 3; i++) {
          this._tone(now, midi([72, 76, 79][i]), 0.5, { peak: 0.3, decay: 0.7, type: 'triangle' }, null, i * 0.12);
        }
        break;
      default:
        break;
    }
  }

  /**
   * A one-shot's nodes are created here and released by `onended`.
   *
   * Web Audio one-shots are cheap to make and impossible to reuse safely — an
   * `OscillatorNode` cannot restart once stopped — so the honest structure is
   * per-event allocation with a hard stop that guarantees collection.
   */
  _voiceOut(at) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    if (at) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = SPACE.ref;
      p.maxDistance = SPACE.max;
      p.rolloffFactor = SPACE.rolloff;
      place(p, at.x, at.y, at.z, ctx.currentTime, 0.001);
      g.connect(p); p.connect(this._nodes.bus);
    } else {
      g.connect(this._nodes.bus);
    }
    return g;
  }

  _tone(now, hz, dur, opts = {}, at = null, delay = 0) {
    const ctx = this.ctx;
    const t0 = now + delay;
    const g = this._voiceOut(at);
    const o = ctx.createOscillator();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(hz, t0);
    o.connect(g);
    const end = ampEnv(g, t0, { peak: opts.peak ?? 0.3, attack: opts.attack ?? 0.005, hold: dur, decay: opts.decay ?? 0.25 });
    o.start(t0);
    o.stop(end + 0.02);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  }

  _sweep(now, f0, f1, dur, opts = {}, at = null) {
    const ctx = this.ctx;
    const g = this._voiceOut(at);
    const o = ctx.createOscillator();
    o.type = opts.type || 'sawtooth';
    setNow(o.frequency, f0, now);
    expRamp(o.frequency, f1, now + dur);
    o.connect(g);
    const end = ampEnv(g, now, { peak: opts.peak ?? 0.3, attack: 0.008, hold: dur * 0.5, decay: dur * 0.7 });
    o.start(now);
    o.stop(end + 0.02);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  }

  _noise(now, opts = {}, at = null) {
    const ctx = this.ctx;
    const g = this._voiceOut(at);
    const src = ctx.createBufferSource();
    src.buffer = this._nodes.white;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    setNow(bp.frequency, opts.f0 ?? 900, now);
    expRamp(bp.frequency, opts.f1 ?? 300, now + (opts.decay ?? 0.3));
    src.connect(bp); bp.connect(g);
    const end = ampEnv(g, now, { peak: opts.peak ?? 0.3, attack: 0.004, hold: 0, decay: opts.decay ?? 0.3 });
    src.start(now, this._rng() * 1.5);
    src.stop(end + 0.02);
    src.onended = () => { try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  }

  _thud(now, opts = {}, at = null) {
    const ctx = this.ctx;
    const g = this._voiceOut(at);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = opts.f ?? 80;
    setNow(o.frequency, f * 2.4, now);
    expRamp(o.frequency, f * 0.7, now + (opts.decay ?? 0.3));
    o.connect(g);
    const end = ampEnv(g, now, { peak: opts.peak ?? 0.5, attack: 0.003, hold: 0, decay: opts.decay ?? 0.3 });
    o.start(now);
    o.stop(end + 0.02);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  }

  // -- control --------------------------------------------------------------

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this._nodes) {
      setTarget(this._nodes.master.gain, this.muted ? 0 : v * MIX.master, this.ctx.currentTime, 0.05);
    }
  }

  setMuted(b) {
    this.muted = b;
    if (this._nodes) {
      setTarget(this._nodes.master.gain, b ? 0 : this.masterVolume * MIX.master, this.ctx.currentTime, 0.05);
    }
  }

  dispose() {
    for (const [, rec] of this.karts) {
      const v = rec.voice;
      if (!v) continue;
      try {
        for (const o of v.oscs) o.stop();
        v.tSrc.stop();
        v.out.disconnect();
      } catch { /* a context already closed takes its nodes with it */ }
    }
    this.karts.clear();
    if (this._nodes) {
      try {
        this._nodes.wind.src.stop();
        this._nodes.ambience.src.stop();
        for (const m of this._nodes.music.voices) m.o.stop();
      } catch { /* as above */ }
    }
    this._nodes = null;
    if (this.ctx && !this.opts.context && this.ctx.state !== 'closed') this.ctx.close();
    this.ctx = null;
    this.started = false;
  }
}

/** Rotate a vector by a THREE-style quaternion, without importing three. */
function _rotate(x, y, z, q) {
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  return [
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  ];
}
