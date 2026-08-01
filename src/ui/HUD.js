import { clamp01, lerp, mod } from '../core/MathX.js';
import { DRIFT } from '../kart/KartTuning.js';

/**
 * HUD.
 *
 * Rendered as DOM rather than in-scene geometry: text stays vector-sharp at
 * any resolution and costs nothing in the 3D pass. The minimap is the one
 * canvas element, redrawn at a reduced rate since it only needs to convey
 * relative position.
 */

const CSS = `
.hk-hud { position:absolute; inset:0; font-family: "Inter", system-ui, -apple-system, sans-serif;
  color:#fff; user-select:none; -webkit-user-select:none; }
.hk-hud * { box-sizing:border-box; }

.hk-pos { position:absolute; left:2.2vmin; bottom:2.2vmin; display:flex; align-items:baseline;
  text-shadow:0 0.4vmin 1.6vmin rgba(0,0,0,.75), 0 0 .4vmin rgba(0,0,0,.5); }
.hk-pos-num { font-size:13vmin; font-weight:900; line-height:.82; letter-spacing:-.04em;
  background:linear-gradient(180deg,#fff 25%,#ffd75e 62%,#ff9a1f 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 .3vmin .5vmin rgba(0,0,0,.55)); }
.hk-pos-ord { font-size:4.6vmin; font-weight:800; margin-left:.4vmin; color:#ffd75e;
  filter:drop-shadow(0 .3vmin .5vmin rgba(0,0,0,.55)); }

.hk-lap { position:absolute; left:2.4vmin; top:2.2vmin; text-shadow:0 .3vmin 1.2vmin rgba(0,0,0,.8); }
.hk-lap-label { font-size:1.9vmin; font-weight:800; letter-spacing:.28em; opacity:.85; }
.hk-lap-val { font-size:5.4vmin; font-weight:900; line-height:.95; letter-spacing:-.02em; }
.hk-lap-val small { font-size:3vmin; opacity:.7; font-weight:800; }

.hk-item { position:absolute; left:50%; top:2.2vmin; transform:translateX(-50%);
  width:13vmin; height:13vmin; border-radius:2.4vmin;
  background:radial-gradient(circle at 50% 30%, rgba(255,255,255,.28), rgba(255,255,255,.06) 60%, rgba(0,0,0,.28));
  border:.36vmin solid rgba(255,255,255,.55);
  box-shadow:0 .8vmin 2.4vmin rgba(0,0,0,.5), inset 0 0 2vmin rgba(255,255,255,.22);
  backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center;
  transition:transform .18s cubic-bezier(.2,1.6,.4,1); }
.hk-item.spin { animation:hkSpin .28s linear infinite; }
.hk-item.pop { transform:translateX(-50%) scale(1.16); }
@keyframes hkSpin { 0%{filter:hue-rotate(0)} 100%{filter:hue-rotate(360deg)} }
.hk-item-icon { font-size:7.4vmin; line-height:1; filter:drop-shadow(0 .4vmin .8vmin rgba(0,0,0,.55)); }
.hk-item-count { position:absolute; right:-.6vmin; bottom:-.6vmin; min-width:4vmin; height:4vmin;
  border-radius:2vmin; background:#ff9a1f; border:.3vmin solid #fff; color:#3a1e00;
  font-size:2.4vmin; font-weight:900; display:flex; align-items:center; justify-content:center;
  box-shadow:0 .4vmin 1vmin rgba(0,0,0,.5); }

.hk-speed { position:absolute; right:2.4vmin; bottom:2.2vmin; width:26vmin; height:26vmin; }
.hk-speed svg { position:absolute; inset:0; overflow:visible; }
.hk-speed-num { position:absolute; left:0; right:0; top:53%; text-align:center;
  font-size:7.2vmin; font-weight:900; letter-spacing:-.04em; line-height:1;
  text-shadow:0 .4vmin 1.4vmin rgba(0,0,0,.8); }
.hk-speed-unit { position:absolute; left:0; right:0; top:76%; text-align:center;
  font-size:1.8vmin; font-weight:800; letter-spacing:.3em; opacity:.72; }

.hk-map { position:absolute; right:2.4vmin; top:2.2vmin; width:22vmin; height:22vmin;
  border-radius:2vmin; background:rgba(4,10,20,.42); border:.3vmin solid rgba(255,255,255,.32);
  box-shadow:0 .8vmin 2.4vmin rgba(0,0,0,.45); backdrop-filter:blur(7px); overflow:hidden; }
.hk-map canvas { width:100%; height:100%; display:block; }

.hk-coins { position:absolute; left:2.4vmin; bottom:17vmin; display:flex; align-items:center; gap:.8vmin;
  font-size:3.4vmin; font-weight:900; text-shadow:0 .3vmin 1vmin rgba(0,0,0,.8); }
.hk-coins span:first-child { color:#ffd75e; font-size:3.8vmin; }

.hk-center { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  pointer-events:none; }
.hk-count { font-size:26vmin; font-weight:900; letter-spacing:-.05em;
  background:linear-gradient(180deg,#fff 20%,#ffd75e 55%,#ff6a1f 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 1vmin 3vmin rgba(0,0,0,.7)); animation:hkCount .95s ease-out; }
@keyframes hkCount { 0%{transform:scale(2.4);opacity:0} 22%{transform:scale(1);opacity:1} 100%{transform:scale(.92);opacity:.9} }
.hk-go { font-size:30vmin; font-weight:900; letter-spacing:-.06em;
  background:linear-gradient(180deg,#eaffff 10%,#4de1ff 45%,#0a7bd8 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 1vmin 4vmin rgba(0,120,255,.6)); animation:hkGo .6s cubic-bezier(.15,1.8,.4,1); }
@keyframes hkGo { 0%{transform:scale(.2);opacity:0} 40%{transform:scale(1.14)} 100%{transform:scale(1);opacity:1} }

.hk-toast { position:absolute; left:50%; top:22vmin; transform:translateX(-50%);
  font-size:4.4vmin; font-weight:900; letter-spacing:-.02em; white-space:nowrap;
  text-shadow:0 .4vmin 1.6vmin rgba(0,0,0,.8); animation:hkToast 1.5s ease-out forwards; }
@keyframes hkToast { 0%{opacity:0;transform:translateX(-50%) translateY(2vmin) scale(.9)}
  16%{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}
  74%{opacity:1} 100%{opacity:0;transform:translateX(-50%) translateY(-2vmin)} }

.hk-times { position:absolute; right:2.4vmin; top:26vmin; text-align:right;
  font-size:2.0vmin; font-weight:700; opacity:.9; line-height:1.6;
  text-shadow:0 .2vmin .8vmin rgba(0,0,0,.8); font-variant-numeric:tabular-nums; }
.hk-times b { font-weight:900; color:#ffd75e; }
`;

const ITEM_ICONS = {
  banana: '🍌', tripleBanana: '🍌', greenShell: '🟢', tripleGreen: '🟢',
  redShell: '🔴', tripleRed: '🔴', mushroom: '🍄', tripleMushroom: '🍄',
  star: '⭐', thunder: '⚡', bulletBill: '🚀',
};

const ORDINALS = ['', 'st', 'nd', 'rd'];
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13) ? 'th' : (ORDINALS[n % 10] || 'th');

export class HUD {
  constructor(root) {
    if (!document.getElementById('hk-hud-style')) {
      const style = document.createElement('style');
      style.id = 'hk-hud-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.el = document.createElement('div');
    this.el.className = 'hk-hud';
    this.el.innerHTML = `
      <div class="hk-lap">
        <div class="hk-lap-label">LAP</div>
        <div class="hk-lap-val"><span data-lap>1</span><small>/<span data-laps>3</span></small></div>
      </div>
      <div class="hk-item"><div class="hk-item-icon" data-item></div><div class="hk-item-count" data-count style="display:none"></div></div>
      <div class="hk-map"><canvas data-map width="256" height="256"></canvas></div>
      <div class="hk-times" data-times></div>
      <div class="hk-coins"><span>◉</span><span data-coins>0</span></div>
      <div class="hk-pos"><span class="hk-pos-num" data-pos>1</span><span class="hk-pos-ord" data-ord>st</span></div>
      <div class="hk-speed">
        <svg viewBox="0 0 100 100">
          <path d="M 12 84 A 44 44 0 1 1 88 84" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="7" stroke-linecap="round"/>
          <path data-arc d="M 12 84 A 44 44 0 1 1 88 84" fill="none" stroke="url(#hkgrad)" stroke-width="7" stroke-linecap="round"/>
          <defs><linearGradient id="hkgrad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stop-color="#4de1ff"/><stop offset="55%" stop-color="#ffd75e"/><stop offset="100%" stop-color="#ff4d4d"/>
          </linearGradient></defs>
        </svg>
        <div class="hk-speed-num" data-speed>0</div>
        <div class="hk-speed-unit">KM/H</div>
      </div>
      <div class="hk-center" data-center></div>
    `;
    root.appendChild(this.el);

    const q = (s) => this.el.querySelector(s);
    this.dom = {
      lap: q('[data-lap]'), laps: q('[data-laps]'),
      item: q('.hk-item'), itemIcon: q('[data-item]'), itemCount: q('[data-count]'),
      pos: q('[data-pos]'), ord: q('[data-ord]'),
      speed: q('[data-speed]'), arc: q('[data-arc]'),
      coins: q('[data-coins]'), center: q('[data-center]'),
      times: q('[data-times]'),
      map: q('[data-map]'),
    };

    this.mapCtx = this.dom.map.getContext('2d');
    // The arc path length, needed for the stroke-dash speedometer sweep.
    this.arcLen = this.dom.arc.getTotalLength();
    this.dom.arc.style.strokeDasharray = `${this.arcLen}`;
    this.dom.arc.style.strokeDashoffset = `${this.arcLen}`;

    this._mapAccum = 0;
    this._mapPath = null;
    this._lastItem = undefined;
    this._lastPos = -1;
    this._lastLap = -1;
    this._displaySpeed = 0;
  }

  setTrack(track) {
    this.track = track;
    this.dom.laps.textContent = track.laps;
    // Pre-project the centreline into minimap space once.
    const sp = track.spline;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.pos[i * 3], z = sp.pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const pad = 26;
    const w = maxX - minX + pad * 2, h = maxZ - minZ + pad * 2;
    const scale = Math.min(256 / w, 256 / h);
    this._map = {
      scale,
      ox: 128 - ((minX + maxX) / 2) * scale,
      oy: 128 - ((minZ + maxZ) / 2) * scale,
    };
    const path = new Path2D();
    for (let i = 0; i <= sp.count; i += 4) {
      const j = i % sp.count;
      const x = sp.pos[j * 3] * scale + this._map.ox;
      const y = sp.pos[j * 3 + 2] * scale + this._map.oy;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
    this._mapPath = path;
  }

  /**
   * @param {number} dt
   * @param {{player:any, karts:any[], time:number, state:string, countdown:number}} race
   */
  update(dt, race) {
    const p = race.player;
    if (!p) return;

    // Position -----------------------------------------------------------
    if (p.rank !== this._lastPos) {
      this._lastPos = p.rank;
      this.dom.pos.textContent = p.rank;
      this.dom.ord.textContent = ordinal(p.rank);
    }

    // Lap ------------------------------------------------------------------
    const lap = Math.min(Math.max(p.lap, 1), this.track.laps);
    if (lap !== this._lastLap) {
      this._lastLap = lap;
      this.dom.lap.textContent = lap;
      if (lap > 1) this.toast(lap === this.track.laps ? 'FINAL LAP!' : `LAP ${lap}`,
        lap === this.track.laps ? '#ff6a3d' : '#ffd75e');
    }

    // Speed ----------------------------------------------------------------
    // Smooth the readout so it doesn't strobe between adjacent integers.
    this._displaySpeed += (p.speedKmh - this._displaySpeed) * Math.min(1, dt * 14);
    this.dom.speed.textContent = Math.round(this._displaySpeed);
    const frac = clamp01(this._displaySpeed / (p.stats.topSpeed * 3.6 * 1.65));
    this.dom.arc.style.strokeDashoffset = `${this.arcLen * (1 - frac)}`;

    // Item -----------------------------------------------------------------
    const shown = p.itemRoulette ? p.itemRoulette.display : p.item;
    if (shown !== this._lastItem) {
      this._lastItem = shown;
      this.dom.itemIcon.textContent = shown ? (ITEM_ICONS[shown] || '?') : '';
      this.dom.item.classList.toggle('pop', !!shown && !p.itemRoulette);
      setTimeout(() => this.dom.item.classList.remove('pop'), 200);
    }
    this.dom.item.classList.toggle('spin', !!p.itemRoulette);
    const uses = p.itemUses || 0;
    this.dom.itemCount.style.display = uses > 1 ? 'flex' : 'none';
    if (uses > 1) this.dom.itemCount.textContent = uses;

    this.dom.coins.textContent = p.coins;

    // Lap times ------------------------------------------------------------
    if (p.lapTimes.length) {
      this.dom.times.innerHTML = p.lapTimes
        .map((t, i) => `L${i + 1} <b>${fmtTime(t)}</b>`).join('<br>');
    }

    // Minimap --------------------------------------------------------------
    this._mapAccum += dt;
    if (this._mapAccum > 1 / 30) { this._mapAccum = 0; this._drawMap(race); }
  }

  _drawMap(race) {
    const ctx = this.mapCtx;
    const m = this._map;
    if (!m) return;
    ctx.clearRect(0, 0, 256, 256);

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 13;
    ctx.stroke(this._mapPath);
    ctx.strokeStyle = 'rgba(255,255,255,.30)';
    ctx.lineWidth = 9;
    ctx.stroke(this._mapPath);

    // Start line tick.
    const sp = this.track.spline;
    const si = sp.indexAt(this.track.startS);
    ctx.save();
    ctx.translate(sp.pos[si * 3] * m.scale + m.ox, sp.pos[si * 3 + 2] * m.scale + m.oy);
    ctx.rotate(-sp.heading[si]);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-7, -1.6, 14, 3.2);
    ctx.restore();

    for (const k of race.karts) {
      const x = k.pos.x * m.scale + m.ox;
      const y = k.pos.z * m.scale + m.oy;
      ctx.beginPath();
      ctx.arc(x, y, k.isPlayer ? 7.5 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = k.isPlayer ? '#fff' : `#${k.stats.color.toString(16).padStart(6, '0')}`;
      ctx.fill();
      if (k.isPlayer) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ff9a1f';
        ctx.stroke();
      }
    }
  }

  toast(text, color = '#fff') {
    const d = document.createElement('div');
    d.className = 'hk-toast';
    d.textContent = text;
    d.style.color = color;
    this.el.appendChild(d);
    setTimeout(() => d.remove(), 1600);
  }

  countdown(n) {
    this.dom.center.innerHTML = n > 0
      ? `<div class="hk-count">${n}</div>`
      : `<div class="hk-go">GO!</div>`;
    setTimeout(() => { if (this.dom.center.firstChild) this.dom.center.innerHTML = ''; }, n > 0 ? 950 : 900);
  }

  setVisible(v) { this.el.style.display = v ? '' : 'none'; }

  dispose() { this.el.remove(); }
}

export function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
