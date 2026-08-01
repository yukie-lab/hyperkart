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
 */
export class AudioEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.masterVolume = opts.volume ?? 0.8;
    this.karts = new Map();
  }

  async start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.started = true;
  }

  attachKart(kart, isPlayer) {
    this.karts.set(kart, { isPlayer });
  }

  handleEvent(_event) {}

  update(_dt, _race, _listener) {}

  setMasterVolume(v) { this.masterVolume = v; }

  setMuted(b) { this.muted = b; }

  dispose() {
    this.karts.clear();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    this.ctx = null;
    this.started = false;
  }
}
