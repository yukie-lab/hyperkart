import { clamp, damp } from './MathX.js';

/**
 * Unified input: keyboard + gamepad + touch, normalized into the analog shape
 * the kart controller consumes. Steering is smoothed here (not in physics) so
 * digital keys feel like an analog stick without the physics model caring.
 */

/**
 * Exported so the controls panel can be generated from the real bindings
 * rather than transcribed beside them. A help screen that is typed out by hand
 * is a help screen that goes stale the first time a key moves.
 *
 * `pause` is listed here and consumed by nothing — grep it. The panel therefore
 * does not show it, because a control list that offers a key which does nothing
 * is worse than one that omits it.
 */
export const KEYMAP = {
  accel: ['KeyW', 'ArrowUp', 'KeyZ'],
  brake: ['KeyS', 'ArrowDown', 'KeyX'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'ShiftRight', 'Space'],
  item: ['KeyE', 'ControlLeft', 'KeyQ'],
  look: ['KeyC'],
  pause: ['Escape', 'KeyP'],
};

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.raw = { steer: 0, accel: 0, brake: 0, drift: false, item: false, look: false };
    this.state = { steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false, item: false, itemPressed: false, look: false };
    this._prevDrift = false;
    this._prevItem = false;
    this.touch = { active: false, steer: 0, accel: 0, drift: false, item: false };
    this.enabled = true;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedThisFrame.add(e.code);
      if (Object.values(KEYMAP).some((list) => list.includes(e.code))) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => { this.keys.clear(); };

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    this._target = target;
  }

  any(list) { return list.some((c) => this.keys.has(c)); }
  pressed(action) { return (KEYMAP[action] || []).some((c) => this.pressedThisFrame.has(c)); }

  /** Poll gamepad state, if one is connected. Returns null when absent. */
  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      return {
        steer: clamp(dz(p.axes[0] || 0), -1, 1),
        accel: Math.max(p.buttons[7]?.value || 0, p.buttons[0]?.pressed ? 1 : 0),
        brake: Math.max(p.buttons[6]?.value || 0, p.buttons[1]?.pressed ? 1 : 0),
        drift: !!(p.buttons[5]?.pressed || p.buttons[4]?.pressed),
        item: !!(p.buttons[2]?.pressed || p.buttons[3]?.pressed),
        look: !!p.buttons[10]?.pressed,
      };
    }
    return null;
  }

  update(dt) {
    // Gathered in the player's terms: positive is a turn to the right.
    const kbSteer = (this.any(KEYMAP.right) ? 1 : 0) - (this.any(KEYMAP.left) ? 1 : 0);
    const kbAccel = this.any(KEYMAP.accel) ? 1 : 0;
    const kbBrake = this.any(KEYMAP.brake) ? 1 : 0;

    const gp = this._gamepad();
    const t = this.touch;

    // ...and negated once here, because `ctrl.steer` is a *yaw command*, not a
    // direction: the kart adds it to `yaw`, and the AI produces it as
    // `desiredYaw - yaw`. The chassis faces its own +Z, so positive yaw swings
    // the nose toward +X — screen-left, with the camera sitting behind it.
    // Turning right is therefore negative yaw. This is the only place the two
    // conventions meet; flipping it anywhere downstream would break the AI.
    const rawSteer = -clamp(kbSteer + (gp?.steer || 0) + (t.active ? t.steer : 0), -1, 1);
    const rawAccel = clamp(Math.max(kbAccel, gp?.accel || 0, t.active ? t.accel : 0), 0, 1);
    const rawBrake = clamp(Math.max(kbBrake, gp?.brake || 0), 0, 1);
    const drift = this.any(KEYMAP.drift) || !!gp?.drift || (t.active && t.drift);
    const item = this.any(KEYMAP.item) || !!gp?.item || (t.active && t.item);

    this.raw = { steer: rawSteer, accel: rawAccel, brake: rawBrake, drift, item, look: this.any(KEYMAP.look) || !!gp?.look };

    // Analog-feel smoothing: fast to engage, slightly slower to release.
    const rate = Math.abs(rawSteer) > Math.abs(this.state.steer) ? 14 : 10;
    this.state.steer = damp(this.state.steer, rawSteer, rate, dt);
    if (Math.abs(this.state.steer) < 0.002) this.state.steer = 0;
    this.state.accel = damp(this.state.accel, rawAccel, 18, dt);
    this.state.brake = damp(this.state.brake, rawBrake, 18, dt);

    this.state.drift = drift;
    this.state.driftPressed = drift && !this._prevDrift;
    this._prevDrift = drift;

    this.state.item = item;
    this.state.itemPressed = item && !this._prevItem;
    this._prevItem = item;

    this.state.look = this.raw.look;
  }

  /** Called by the loop after all consumers have read edge-triggered state. */
  endFrame() { this.pressedThisFrame.clear(); }

  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._target.removeEventListener('blur', this._onBlur);
  }
}
