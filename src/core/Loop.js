/**
 * Fixed-timestep simulation with interpolated rendering.
 *
 * Physics runs at a constant rate so drift charge timings and mini-turbo
 * windows are identical on every machine; rendering interpolates between the
 * last two sim states so motion stays smooth on high-refresh displays.
 *
 * `step(fixedDt)` advances the world. `render(alpha, frameDt)` draws it.
 */
export class Loop {
  constructor({ step, render, hz = 120, maxSubSteps = 6 }) {
    this.step = step;
    this.render = render;
    this.fixedDt = 1 / hz;
    this.maxSubSteps = maxSubSteps;
    this.accumulator = 0;
    this.simTime = 0;
    this.frameCount = 0;
    this.running = false;
    this._last = 0;
    this._raf = 0;
    this.timeScale = 1;
    // Rolling frame-time average drives the adaptive-resolution controller.
    this.smoothedFrameMs = 16.7;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = -1;
    const tick = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      // A rAF timestamp is when its frame *began*, which can predate the call
      // to `start()` if the page spent a long time building the scene first.
      // Seeding `_last` from the first callback instead of from the clock
      // keeps the opening delta from coming out negative — and a negative dt
      // runs every decaying effect backwards, which is how the first second of
      // a race ended up under a white flash that never faded.
      if (this._last < 0) this._last = now;
      let frameDt = (now - this._last) / 1000;
      this._last = now;
      // Clamp both ends: the ceiling stops a backgrounded tab spiralling the
      // accumulator, the floor stops time ever running backwards.
      frameDt = Math.min(Math.max(frameDt, 0), 0.25);
      this.smoothedFrameMs += ((frameDt * 1000) - this.smoothedFrameMs) * 0.1;
      frameDt *= this.timeScale;
      this.accumulator += frameDt;

      let steps = 0;
      while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
        this.step(this.fixedDt, this.simTime);
        this.simTime += this.fixedDt;
        this.accumulator -= this.fixedDt;
        steps++;
      }
      if (steps === this.maxSubSteps) this.accumulator = 0; // give up on the backlog

      this.render(this.accumulator / this.fixedDt, frameDt);
      this.frameCount++;
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  /**
   * Advance the simulation by `seconds` without rendering. Used by the
   * screenshot harness to reach a deterministic point in the race.
   */
  fastForward(seconds) {
    const n = Math.round(seconds / this.fixedDt);
    for (let i = 0; i < n; i++) {
      this.step(this.fixedDt, this.simTime);
      this.simTime += this.fixedDt;
    }
  }
}
