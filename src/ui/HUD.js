import { clamp01 } from '../core/MathX.js';
import { KEYMAP } from '../core/Input.js';

/** `KeyW` -> `W`, `ArrowUp` -> `↑`, and so on. */
function keyLabel(code) {
  const named = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    Space: 'Space', Escape: 'Esc',
  };
  if (named[code]) return named[code];
  return code.startsWith('Key') ? code.slice(3) : code;
}

/** First two bindings per action; more than two on a card is noise. */
const kb = (action) => [...new Set((KEYMAP[action] || []).map(keyLabel))].slice(0, 2);

/**
 * The controls card, built from `KEYMAP` itself so it cannot drift from what
 * the game actually listens for.
 *
 * `pause` is deliberately absent: it exists in the keymap and nothing consumes
 * it, and offering a player a key that does nothing is worse than saying
 * nothing. The last row is not a control at all — it is the rule that had a
 * player convinced the boxes were broken.
 */
const HELP_ROWS = [
  { keys: kb('accel'), what: 'Accelerate' },
  { keys: kb('brake'), what: 'Brake, then reverse' },
  { keys: [...kb('left'), ...kb('right')], what: 'Steer' },
  {
    keys: kb('drift'),
    what: 'Hop, and hold to drift',
    note: 'Hold through a corner to charge a mini-turbo — blue, orange, purple.',
  },
  { keys: kb('item'), what: 'Use the item you are holding' },
  { keys: kb('look'), what: 'Look behind' },
  {
    keys: ['?'],
    what: 'Drive through a ? box to get an item',
    note: 'One at a time: a box will not open while your slot is full.',
  },
];

/**
 * HUD.
 *
 * Rendered as DOM rather than in-scene geometry: text stays vector-sharp at
 * any resolution and costs nothing in the 3D pass. The minimap is the one
 * canvas element, redrawn at a reduced rate since it only needs to convey
 * relative position.
 *
 * Two rules govern everything below.
 *
 * 1. LEGIBILITY IS NOT OPTIONAL. The HUD floats over pale sand, black
 *    asphalt, bright water and a magenta nebula within a single race, so no
 *    element may rely on the background being dark. Every text cluster
 *    carries its own local scrim plus a stacked dark shadow, and every panel
 *    has an opaque-enough plate. White-on-white is a bug, not a style.
 *
 * 2. THE HOT PATH IS SACRED. update() runs on every rendered frame. Anything
 *    that reads layout (offsetWidth, getBoundingClientRect, getTotalLength),
 *    parses markup (innerHTML) or writes an unchanged value is forbidden
 *    there. All of that happens at construction or behind a change guard, and
 *    state-change flourishes are one-shot Web Animations so the compositor
 *    owns them instead of the main thread.
 */

// Unique-per-instance suffix for SVG gradient ids. Two HUDs in one document
// (menu preview + race) would otherwise collide on `url(#...)` references,
// and the second one silently renders unfilled black shapes.
let UID = 0;

const CSS = `
.hk-hud {
  /* --u is the whole type/space scale, and every size below is a multiple of
     it. A floor only, no ceiling.

     The ceiling used to be 12.2px, on the theory that pure vmin goes
     cartoonish above 1440p. It does not — it holds angular size, which is the
     opposite. A 4K television is not viewed closer than a 1080p one, so a HUD
     that stops growing at ~1220px of viewport height is a HUD that shrinks:
     the speedo measured 14.1% of frame width at 720p and 1080p, 11.9% at
     1440p and 7.9% at 2160p, while the gutters beside it stayed at a
     proportional 2.8vmin. That mismatch is what read as cartoonish, not the
     scale itself. Above the floor the HUD is now one fixed design blown up,
     identical as a fraction of the frame at every resolution.

     The floor is the half that was always load-bearing: below ~660px of
     viewport height 1vmin puts the micro-labels under 10px and the HUD goes
     illegible, so a small window gets a proportionally larger HUD on purpose.
     vmin rather than vh so a portrait window scales off its short side and the
     centre column cannot outgrow the frame it sits in. */
  --u: max(6.6px, 1vmin);

  --gold:#ffd45c; --gold-2:#ff9c22; --gold-3:#b45a00;
  --ice:#8fe9ff;  --ice-2:#2ba6ff;
  --hot:#ff6a3a;  --gain:#5df2a0;  --loss:#ff5c78;
  --plate:rgba(8,14,26,.55);
  --edge:rgba(255,255,255,.30);

  /* Optical margins. Unlike the type scale these stay a pure fraction of the
     viewport — a title-safe margin is a property of the screen, not of the
     text, so a clamped unit would let the HUD hug the bezel at 4K. Notched
     displays get pushed in further by the env() insets. */
  --gx: 2.8vmin;
  --gy: 2.4vmin;
  --sl: calc(var(--gx) + env(safe-area-inset-left, 0px));
  --sr: calc(var(--gx) + env(safe-area-inset-right, 0px));
  --st: calc(var(--gy) + env(safe-area-inset-top, 0px));
  --sb: calc(var(--gy) + env(safe-area-inset-bottom, 0px));

  /* The universal dark halo. Three stacked shadows read as an outline plus a
     cast shadow, which survives both a white sky and a black tunnel. */
  --halo: 0 0 calc(var(--u)*.55) rgba(0,0,0,.95),
          0 calc(var(--u)*.2) calc(var(--u)*.6) rgba(0,0,0,.85),
          0 calc(var(--u)*.6) calc(var(--u)*1.8) rgba(0,0,0,.6);
  --haloF: drop-shadow(0 0 calc(var(--u)*.34) rgba(0,0,0,.95))
           drop-shadow(0 calc(var(--u)*.22) calc(var(--u)*.55) rgba(0,0,0,.8))
           drop-shadow(0 calc(var(--u)*.7) calc(var(--u)*1.7) rgba(0,0,0,.55));

  position:absolute; inset:0; color:#fff; user-select:none; -webkit-user-select:none;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  /* Tabular figures everywhere: without them the speed readout jitters
     horizontally every time a 1 replaces a 0. */
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings:"tnum" 1,"lnum" 1,"ss01" 1;
  font-synthesis: none;
}
.hk-hud * { box-sizing:border-box; }

/* Shared micro-label: the small tracked-out caps above each readout. */
.hk-cap { font-size:calc(var(--u)*1.55); font-weight:800; letter-spacing:.30em;
  line-height:1; text-transform:uppercase; opacity:.78; text-shadow:var(--halo); }

/* ---- CLUSTER SCRIMS ------------------------------------------------------
   One soft dark ellipse per text cluster, giving it a contrast floor over a
   white sky or a bleached sand straight. They are their own elements rather
   than backgrounds on the clusters because a gradient painted inside a text
   box always reveals that box's edge, and a faint grey rectangle behind the
   lap counter looks worse than no scrim at all.

   ONE peak and ONE falloff, shared by all five. They used to be five unrelated
   gradients — peaks from .52 to .74, two different mid stops, one with no mid
   stop at all, and footprints picked by eye. Toggling the scrim layer alone
   against a fixed sunsetCoast capture, the five corners of the same frame came
   out 47% (top centre) to 67% (bottom left) darker than the render beneath
   them, all of it stacked on a render vignette already at 0.42: the ocean and
   the beach were being taken to a third of their brightness to carry a coin
   count and a position numeral. Now the same measurement reads 32.9-33.9% at
   all five.

   The peak is .36. Legibility here has never rested on the scrim alone: every
   glyph also carries --halo (an outline plus a cast shadow) and the position
   numeral a .62u dark stroke, and the scrim only has to stop a white-on-white
   frame. .36 does that and still leaves the sea reading as sea. The stops are
   100 / 84 / 48 / 0 percent of the peak, steepening outward so the far edge
   fades out instead of banding.

   Each footprint is the cluster's measured bounding box plus an 8u falloff
   margin — sized to the text it actually serves, not to the corner it sits
   in. Measured with getBoundingClientRect at 1080p, in --u from the screen
   edge: lap 12.3 x 12.0, item slot + ITEM tag 6.7 either side of centre and
   18.4 down, minimap + gap rail + splits 24.3 x 38.4 (lap 3, three split
   rows), coins + position 15.7 x 20.2, speedo 26.6 x 26.2. In --u rather than
   px so the scrim tracks the type it is protecting at every resolution.

   The ellipse radii are per-instance because the top-centre one is anchored
   at 50% and would otherwise need twice its box to fall off; the stop list —
   the falloff itself — is written once. */
.hk-scrim { position:absolute; pointer-events:none; --srx:100%; --sry:100%;
  background:radial-gradient(ellipse var(--srx) var(--sry) at var(--sx) var(--sy),
    rgba(3,7,16,.36), rgba(3,7,16,.30) 46%, rgba(3,7,16,.17) 74%, rgba(3,7,16,0) 100%); }
.s-tl { --sx:0%;   --sy:0%;   left:0;  top:0;    width:calc(var(--u)*20); height:calc(var(--u)*20); }
.s-tr { --sx:100%; --sy:0%;   right:0; top:0;    width:calc(var(--u)*32); height:calc(var(--u)*46); }
.s-bl { --sx:0%;   --sy:100%; left:0;  bottom:0; width:calc(var(--u)*24); height:calc(var(--u)*28); }
.s-br { --sx:100%; --sy:100%; right:0; bottom:0; width:calc(var(--u)*35); height:calc(var(--u)*34); }
.s-tc { --sx:50%;  --sy:0%;   --srx:50%; left:50%; top:0; transform:translateX(-50%);
  width:calc(var(--u)*30); height:calc(var(--u)*26); }

/* ---- LAP (top-left) ------------------------------------------------------
   Lap and position are the two values a player reads mid-corner, so they get
   the largest type and the strongest contrast treatment. */
.hk-lap { position:absolute; left:var(--sl); top:var(--st); }
.hk-lap-row { display:flex; align-items:baseline; gap:calc(var(--u)*.2); margin-top:calc(var(--u)*.4); }
.hk-lap-val { font-size:calc(var(--u)*8.4); font-weight:900; line-height:.82; letter-spacing:-.04em;
  text-shadow:var(--halo); }
.hk-lap-sep { font-size:calc(var(--u)*4.0); font-weight:900; opacity:.4; line-height:1;
  text-shadow:var(--halo); }
.hk-lap-tot { font-size:calc(var(--u)*3.6); font-weight:900; opacity:.66; line-height:1;
  text-shadow:var(--halo); }
/* A short accent rule under the label anchors the cluster to the corner. */
.hk-lap-rule { width:calc(var(--u)*4.4); height:calc(var(--u)*.34); margin-bottom:calc(var(--u)*.7);
  background:linear-gradient(90deg,var(--gold),rgba(255,212,92,0));
  box-shadow:0 0 calc(var(--u)*.8) rgba(255,180,60,.5); }
.hk-hud.final .hk-lap-rule { background:linear-gradient(90deg,var(--hot),rgba(255,106,58,0));
  box-shadow:0 0 calc(var(--u)*1.1) rgba(255,106,58,.75); }
.hk-hud.final .hk-lap-val { color:#ffd9c8; }

/* ---- ITEM SLOT (top-centre) ---------------------------------------------
   Chamfered rather than rounded: the bevel is what separates "designed frame"
   from "div with border-radius". Built as two clipped layers so the bevel has
   a real edge — a border on a clip-path element gets clipped away. */
.hk-item { position:absolute; left:50%; top:var(--st); transform:translateX(-50%);
  width:calc(var(--u)*13.4); height:calc(var(--u)*13.4);
  --chamfer: calc(var(--u)*2.6);
  --rim:#9fb4cc;
  /* The zero-offset shadow is an outline in disguise: it is what stops the
     frame dissolving into a white sky or a bleached sand straight. */
  filter:drop-shadow(0 0 calc(var(--u)*.3) rgba(0,0,0,.9))
         drop-shadow(0 calc(var(--u)*1) calc(var(--u)*2.4) rgba(0,0,0,.6)); }
.hk-item-frame { position:absolute; inset:0;
  clip-path:polygon(var(--chamfer) 0,calc(100% - var(--chamfer)) 0,100% var(--chamfer),
    100% calc(100% - var(--chamfer)),calc(100% - var(--chamfer)) 100%,var(--chamfer) 100%,
    0 calc(100% - var(--chamfer)),0 var(--chamfer));
  background-image:linear-gradient(152deg,#ffffff 0%,var(--rim) 26%,rgba(255,255,255,.55) 48%,
    var(--rim) 70%,rgba(34,48,70,.95) 100%);
  transition:background-image .25s linear, opacity .25s linear; }
/* Dimmed, not blank: an empty slot has to look like a state, not a bug. */
.hk-item.empty .hk-item-frame { opacity:.62; }
.hk-item.rolling .hk-item-frame { background-image:linear-gradient(152deg,#ffffff 0%,#8fe9ff 30%,
  rgba(255,255,255,.7) 50%,#2ba6ff 78%,rgba(20,40,70,.95) 100%); }
.hk-item.empty .hk-item-well { background:
    radial-gradient(ellipse 90% 70% at 50% 8%, rgba(255,255,255,.10), rgba(255,255,255,0) 62%),
    linear-gradient(180deg, rgba(12,20,34,.62), rgba(4,7,14,.72)); }
.hk-item-well { position:absolute; inset:calc(var(--u)*.34);
  clip-path:polygon(calc(var(--chamfer) - var(--u)*.34) 0,calc(100% - var(--chamfer) + var(--u)*.34) 0,
    100% calc(var(--chamfer) - var(--u)*.34),100% calc(100% - var(--chamfer) + var(--u)*.34),
    calc(100% - var(--chamfer) + var(--u)*.34) 100%,calc(var(--chamfer) - var(--u)*.34) 100%,
    0 calc(100% - var(--chamfer) + var(--u)*.34),0 calc(var(--chamfer) - var(--u)*.34));
  background:
    radial-gradient(ellipse 90% 70% at 50% 8%, rgba(255,255,255,.20), rgba(255,255,255,0) 62%),
    linear-gradient(180deg, rgba(16,26,44,.78), rgba(5,9,18,.86));
  backdrop-filter:blur(calc(var(--u)*.7)) saturate(1.15);
  overflow:hidden; }
/* Corner brackets — four hairlines that read as machined tooling marks. */
.hk-item-well::before, .hk-item-well::after { content:''; position:absolute;
  width:calc(var(--u)*2.4); height:calc(var(--u)*2.4); pointer-events:none;
  border-color:rgba(255,255,255,.34); border-style:solid; opacity:.9; }
.hk-item-well::before { left:calc(var(--u)*.9); top:calc(var(--u)*.9); border-width:calc(var(--u)*.22) 0 0 calc(var(--u)*.22); }
.hk-item-well::after  { right:calc(var(--u)*.9); bottom:calc(var(--u)*.9); border-width:0 calc(var(--u)*.22) calc(var(--u)*.22) 0; }

/* Rolling sweep. It lives inside the well so the octagon clip contains it —
   a ring drawn outside the frame pokes past the flat edges and hides at the
   corners, which reads as a rendering fault rather than a spin-up. */
.hk-item-rim { position:absolute; inset:-30%; opacity:0; pointer-events:none;
  background:conic-gradient(from 0turn, rgba(143,233,255,0) 0 38%, rgba(143,233,255,.34) 62%,
    rgba(255,255,255,.85) 78%, rgba(143,233,255,.3) 88%, rgba(143,233,255,0) 100%);
  -webkit-mask:radial-gradient(closest-side, #0000 22%, #000 72%);
  mask:radial-gradient(closest-side, #0000 22%, #000 72%);
  transition:opacity .16s linear; }
.hk-item.rolling .hk-item-rim { opacity:1; animation:hkRim .42s linear infinite; }
@keyframes hkRim { to { transform:rotate(1turn); } }

/* Idle shimmer: proof the empty slot is deliberate rather than broken. */
.hk-item-shine { position:absolute; inset:-20%; pointer-events:none; opacity:0;
  background:linear-gradient(112deg, rgba(255,255,255,0) 42%, rgba(255,255,255,.16) 50%, rgba(255,255,255,0) 58%); }
.hk-item.empty .hk-item-shine { opacity:1; animation:hkShine 3.4s cubic-bezier(.6,0,.35,1) infinite; }
@keyframes hkShine { 0%,58% { transform:translateX(-70%); } 100% { transform:translateX(70%); } }

.hk-item-icon { position:absolute; inset:calc(var(--u)*1.7); display:flex; align-items:center; justify-content:center; }
.hk-item-icon svg { width:100%; height:100%; display:block;
  filter:drop-shadow(0 calc(var(--u)*.3) calc(var(--u)*.6) rgba(0,0,0,.6)); }
.hk-item.rolling .hk-item-icon { animation:hkReel .09s steps(2,end) infinite; }
@keyframes hkReel { 0%{transform:translateY(-6%) scaleY(1.07)} 100%{transform:translateY(6%) scaleY(.94)} }

/* Empty mark + label. Dim, centred, unmistakably "no item yet". */
.hk-item-mark { position:absolute; inset:calc(var(--u)*3.2); opacity:0; transition:opacity .2s linear; }
.hk-item.empty .hk-item-mark { opacity:.30; }
.hk-item-mark svg { width:100%; height:100%; display:block; }
.hk-item-tag { position:absolute; left:0; right:0; top:calc(100% + var(--u)*.7); text-align:center;
  font-size:calc(var(--u)*1.45); font-weight:800; letter-spacing:.34em; opacity:0;
  text-transform:uppercase; text-shadow:var(--halo); transition:opacity .22s linear; }
.hk-item.empty .hk-item-tag { opacity:.55; }

.hk-item-count { position:absolute; right:calc(var(--u)*-1.0); bottom:calc(var(--u)*-1.0);
  min-width:calc(var(--u)*4.0); height:calc(var(--u)*4.0); padding:0 calc(var(--u)*.5);
  border-radius:calc(var(--u)*2);
  background:linear-gradient(180deg,#fff2c4,var(--gold-2)); border:calc(var(--u)*.26) solid #2a1400;
  color:#3a1e00; font-size:calc(var(--u)*2.3); font-weight:900; letter-spacing:-.03em;
  display:none; align-items:center; justify-content:center;
  box-shadow:0 calc(var(--u)*.4) calc(var(--u)*1) rgba(0,0,0,.6); }
.hk-item.multi .hk-item-count { display:flex; }

/* ---- STAR / INVINCIBILITY (under the item slot) --------------------------
   A star changes how the kart behaves — it cannot be hit, it shoves everyone
   it touches and it carries its own boost — and none of that was visible
   anywhere in the HUD. The slot itself is the wrong home: the star is spent
   the instant it is used, so the slot is legitimately empty (or already
   holding the next item) while the effect runs. This is a separate status
   chip, sized and centred to the slot above it so the two read as one column,
   and it takes over the ITEM tag's line rather than stacking on top of it.

   The chip *is* the timer: the fill retreats as the effect drains, which is
   one transform per tick instead of a second bar element.

   The whole centre stack is budgeted in --u so nothing in it can collide at
   any resolution — slot 0-13.4, chip 13.9-17.1, lap banner 17.7-23.1, all
   measured from the top gutter. Crossing the line while a star is running has
   to look composed, not like two panels fighting for the same 40 pixels. The
   countdown's lamp gantry (14.4-16.6) shares this chip's line; see the centre
   stage below for why that needs no arbitration. */
.hk-star { position:absolute; left:50%; top:calc(var(--st) + var(--u)*13.9); transform:translateX(-50%);
  width:calc(var(--u)*13.4); height:calc(var(--u)*3.2);
  display:none; align-items:center; justify-content:center; gap:calc(var(--u)*.55);
  --chamfer:calc(var(--u)*1.0); overflow:hidden;
  clip-path:polygon(var(--chamfer) 0,calc(100% - var(--chamfer)) 0,100% var(--chamfer),
    100% calc(100% - var(--chamfer)),calc(100% - var(--chamfer)) 100%,var(--chamfer) 100%,
    0 calc(100% - var(--chamfer)),0 var(--chamfer));
  background:linear-gradient(180deg, rgba(30,20,2,.86), rgba(8,6,2,.90));
  box-shadow:inset 0 0 0 calc(var(--u)*.16) rgba(255,225,120,.45);
  filter:drop-shadow(0 0 calc(var(--u)*.3) rgba(0,0,0,.9))
         drop-shadow(0 calc(var(--u)*.5) calc(var(--u)*1.3) rgba(0,0,0,.6)); }
.hk-hud.star .hk-star { display:flex; }
/* One line, one owner. */
.hk-hud.star .hk-item.empty .hk-item-tag { opacity:0; }
.hk-star-fill { position:absolute; left:0; top:0; bottom:0; width:100%; transform-origin:0 50%;
  background:linear-gradient(90deg, rgba(255,120,220,.55), rgba(255,214,60,.60) 34%,
    rgba(110,255,180,.55) 66%, rgba(120,205,255,.55));
  will-change:transform; }
/* The sheen is what says "invincible" rather than "a yellow progress bar". */
.hk-star-fill::after { content:''; position:absolute; inset:0;
  background:linear-gradient(105deg, rgba(255,255,255,0) 38%, rgba(255,255,255,.55) 50%, rgba(255,255,255,0) 62%);
  animation:hkStarSheen 1.15s linear infinite; }
@keyframes hkStarSheen { from { transform:translateX(-120%); } to { transform:translateX(120%); } }
.hk-star-ico { position:relative; width:calc(var(--u)*2.2); height:calc(var(--u)*2.2); flex:0 0 auto; }
.hk-star-ico svg { width:100%; height:100%; display:block;
  filter:drop-shadow(0 0 calc(var(--u)*.28) rgba(0,0,0,.85)); }
.hk-star-txt { position:relative; font-size:calc(var(--u)*1.5); font-weight:900; letter-spacing:.30em;
  text-transform:uppercase; text-shadow:0 calc(var(--u)*.12) calc(var(--u)*.3) rgba(0,0,0,.95),
    0 0 calc(var(--u)*.5) rgba(0,0,0,.9); }
/* Last second and a half: the chip flashes so the drop-off is not a surprise. */
.hk-star.ending { animation:hkStarEnd .34s steps(2,end) infinite; }
@keyframes hkStarEnd { 0% { opacity:1; } 100% { opacity:.55; } }

/* ---- MINIMAP (top-right) -------------------------------------------------
   Same chamfered-octagon frame as the item slot: two panels sharing one shape
   language is what makes a HUD look authored rather than assembled. */
.hk-map { position:absolute; right:var(--sr); top:var(--st);
  width:calc(var(--u)*21.5); height:calc(var(--u)*21.5); --chamfer:calc(var(--u)*2.2);
  filter:drop-shadow(0 calc(var(--u)*.8) calc(var(--u)*2.2) rgba(0,0,0,.55)); }
.hk-map-frame { position:absolute; inset:0;
  clip-path:polygon(var(--chamfer) 0,calc(100% - var(--chamfer)) 0,100% var(--chamfer),
    100% calc(100% - var(--chamfer)),calc(100% - var(--chamfer)) 100%,var(--chamfer) 100%,
    0 calc(100% - var(--chamfer)),0 var(--chamfer));
  background:linear-gradient(160deg,rgba(255,255,255,.62),rgba(255,255,255,.20) 46%,rgba(120,145,175,.45)); }
.hk-map-well { position:absolute; inset:calc(var(--u)*.32);
  clip-path:polygon(calc(var(--chamfer) - var(--u)*.32) 0,calc(100% - var(--chamfer) + var(--u)*.32) 0,
    100% calc(var(--chamfer) - var(--u)*.32),100% calc(100% - var(--chamfer) + var(--u)*.32),
    calc(100% - var(--chamfer) + var(--u)*.32) 100%,calc(var(--chamfer) - var(--u)*.32) 100%,
    0 calc(100% - var(--chamfer) + var(--u)*.32),0 calc(var(--chamfer) - var(--u)*.32));
  background:
    radial-gradient(ellipse 80% 80% at 50% 40%, rgba(28,44,74,.62), rgba(28,44,74,0) 70%),
    linear-gradient(170deg, rgba(10,18,34,.74), rgba(3,6,14,.84));
  backdrop-filter:blur(calc(var(--u)*.7)) saturate(1.1); overflow:hidden; }
.hk-map canvas { width:100%; height:100%; display:block; }

/* ---- CONTROLS (the ? beside the minimap, and its panel) -------------------
   The button borrows the item slot's and minimap's chamfered octagon so it
   reads as part of the same instrument cluster rather than as a web widget
   dropped on top of the game. */
.hk-help { position:absolute; top:var(--st); right:calc(var(--sr) + var(--u)*23.2);
  width:calc(var(--u)*5.6); height:calc(var(--u)*5.6); --chamfer:calc(var(--u)*1.1);
  cursor:pointer; pointer-events:auto; border:0; padding:0; color:#eaf2ff;
  font:800 calc(var(--u)*3)/1 var(--hkf); letter-spacing:0;
  /* Above the backdrop, or the one control the player just used to open the
     card cannot be used to close it — the click lands on the sheet behind. */
  z-index:6;
  /* Dark well, light rim — the minimap's construction, not its inverse. Over a
     bright sky a pale button on a pale background disappears, and this one has
     to be findable on all three circuits without being loud on any. */
  background:linear-gradient(170deg,rgba(10,18,34,.80),rgba(3,6,14,.86));
  box-shadow:0 0 0 calc(var(--u)*.26) rgba(255,255,255,.40) inset;
  /* No backdrop-filter here. The well is opaque enough not to need one, and a
     backdrop filter has to sample a backdrop that may not be composited yet on
     the first frame after a load — which made rainbowSkyway's t=20 capture
     differ on the first run of a batch and agree on every run after it. */
  clip-path:polygon(var(--chamfer) 0,calc(100% - var(--chamfer)) 0,100% var(--chamfer),
    100% calc(100% - var(--chamfer)),calc(100% - var(--chamfer)) 100%,var(--chamfer) 100%,
    0 calc(100% - var(--chamfer)),0 var(--chamfer));
  filter:drop-shadow(0 calc(var(--u)*.6) calc(var(--u)*1.6) rgba(0,0,0,.5));
  transition:background .16s, transform .16s; }
.hk-help:hover, .hk-help:focus-visible { color:#ffd75e;
  box-shadow:0 0 0 calc(var(--u)*.26) rgba(255,215,94,.85) inset;
  transform:scale(1.06); outline:0; }
.hk-help-sheet { position:absolute; inset:0; display:none; pointer-events:auto; z-index:5;
  align-items:center; justify-content:center;
  background:radial-gradient(ellipse 70% 70% at 50% 45%, rgba(6,12,24,.62), rgba(3,6,14,.82)); }
.hk-hud.help-open .hk-help-sheet { display:flex; }
.hk-help-card { --chamfer:calc(var(--u)*2.4); width:min(calc(var(--u)*74), 86vw);
  padding:calc(var(--u)*3.4) calc(var(--u)*3.8) calc(var(--u)*3);
  background:linear-gradient(168deg,rgba(24,38,64,.96),rgba(8,14,28,.97));
  box-shadow:0 0 0 calc(var(--u)*.22) rgba(255,255,255,.22) inset;
  clip-path:polygon(var(--chamfer) 0,calc(100% - var(--chamfer)) 0,100% var(--chamfer),
    100% calc(100% - var(--chamfer)),calc(100% - var(--chamfer)) 100%,var(--chamfer) 100%,
    0 calc(100% - var(--chamfer)),0 var(--chamfer)); }
.hk-help-h { font:800 calc(var(--u)*3.1)/1 var(--hkf); letter-spacing:.10em;
  color:#fff; margin-bottom:calc(var(--u)*2.4); }
.hk-help-h span { color:#ffd75e; }
.hk-help-row { display:flex; align-items:center; gap:calc(var(--u)*1.4);
  padding:calc(var(--u)*.72) 0; border-top:1px solid rgba(255,255,255,.10); }
.hk-help-row:first-of-type { border-top:0; }
.hk-help-keys { flex:0 0 calc(var(--u)*20); display:flex; gap:calc(var(--u)*.5); flex-wrap:wrap; }
.hk-help-keys kbd { font:700 calc(var(--u)*1.75)/1 var(--hkf); color:#0a1526;
  background:linear-gradient(180deg,#f2f6ff,#c3d0e4);
  border-radius:calc(var(--u)*.4); padding:calc(var(--u)*.62) calc(var(--u)*.9);
  box-shadow:0 calc(var(--u)*.22) 0 rgba(0,0,0,.35); }
.hk-help-what { font:600 calc(var(--u)*1.95)/1.25 var(--hkf); color:#dbe6f7; }
.hk-help-what i { display:block; font-style:normal; font-weight:500;
  font-size:calc(var(--u)*1.6); color:#8fa4c2; margin-top:calc(var(--u)*.24); }
.hk-help-foot { margin-top:calc(var(--u)*2.2); font:500 calc(var(--u)*1.6)/1.4 var(--hkf);
  color:#8fa4c2; }
.hk-help-foot b { color:#dbe6f7; font-weight:700; }
/* The card is shown once before the lights, holding the countdown, and on
   demand during the race. Same card, and it must not claim the wrong one. */
.hk-help-start { display:none; }
.hk-hud.help-start .hk-help-start { display:inline; }
.hk-hud.help-start .hk-help-race { display:none; }
/* Every way out of the card, made visible. The first version said "close this
   to start the race" and then did not say how, with no close control anywhere
   on it — which is the question it immediately produced. */
.hk-help-card { position:relative; }
.hk-help-x { position:absolute; top:calc(var(--u)*1.6); right:calc(var(--u)*1.8);
  width:calc(var(--u)*3.6); height:calc(var(--u)*3.6); cursor:pointer;
  border:0; padding:0; border-radius:50%; color:#c6d4e8;
  font:700 calc(var(--u)*2.4)/1 var(--hkf);
  background:rgba(255,255,255,.10); transition:background .15s, color .15s; }
.hk-help-x:hover, .hk-help-x:focus-visible { background:rgba(255,215,94,.22); color:#ffd75e; outline:0; }
.hk-help-go { display:none; width:100%; margin-top:calc(var(--u)*2.2); cursor:pointer;
  border:0; padding:calc(var(--u)*1.5) 0; color:#10203a;
  font:800 calc(var(--u)*2.3)/1 var(--hkf); letter-spacing:.12em;
  background:linear-gradient(180deg,#ffe694,#ffc93e);
  box-shadow:0 calc(var(--u)*.35) 0 rgba(0,0,0,.35);
  transition:filter .15s, transform .1s; }
.hk-hud.help-start .hk-help-go { display:block; }
.hk-help-go:hover, .hk-help-go:focus-visible { filter:brightness(1.08); outline:0; }
.hk-help-go:active { transform:translateY(calc(var(--u)*.2)); }

/* ---- RIGHT RAIL: gaps, then splits ---------------------------------------
   Both hang off the minimap and both are variable-height, so they share one
   flow column rather than each carrying its own absolute top — otherwise the
   splits have to reserve space for a gap strip that is sometimes three rows
   and sometimes hidden. Width is locked to the map so the three panels share
   one right edge and one left edge. */
.hk-rail { position:absolute; right:var(--sr); top:calc(var(--st) + var(--u)*22.6);
  width:calc(var(--u)*21.5); display:flex; flex-direction:column; gap:calc(var(--u)*1.1); }

/* ---- GAP TO RIVALS -------------------------------------------------------
   Place alone tells a player nothing about whether the kart ahead is one
   second away or twenty, which is the difference between attacking and
   settling. Distance is converted to seconds against the pair's mean speed:
   metres are meaningless to a driver, seconds are the unit every decision is
   actually made in. */
.hk-gaps { display:none; flex-direction:column; }
.hk-gaps.on { display:flex; }
.hk-gap-row { display:flex; align-items:center; gap:calc(var(--u)*.55);
  font-size:calc(var(--u)*1.85); font-weight:800; line-height:1.32; white-space:nowrap;
  text-shadow:var(--halo); }
.hk-gap-chev { flex:0 0 auto; font-size:calc(var(--u)*1.5); line-height:1; opacity:.95; }
/* The chevron is a direction marker first. It only takes an alarm colour once
   the gap is inside a second — a permanently red "behind" arrow cries wolf for
   a rival twenty seconds back. */
.hk-gap-row.ahead .hk-gap-chev { color:var(--ice); }
.hk-gap-row.behind .hk-gap-chev { color:rgba(255,255,255,.55); }
.hk-gap-row.ahead.close .hk-gap-chev { color:var(--gain); }
.hk-gap-row.behind.close .hk-gap-chev { color:var(--loss); }
/* The dot carries the rival's livery so it matches its own blip on the map
   above. The inner light rim is not decoration: Onyx is #1a1a22, and a black
   disc with only a black outline disappears entirely against the nebula. */
.hk-gap-dot { flex:0 0 auto; width:calc(var(--u)*1.05); height:calc(var(--u)*1.05); border-radius:50%;
  background:#8fa3bd;
  box-shadow:inset 0 0 0 calc(var(--u)*.12) rgba(255,255,255,.45),
             0 0 0 calc(var(--u)*.16) rgba(0,0,0,.8); }
.hk-gap-name { flex:1 1 auto; overflow:hidden; text-overflow:clip; letter-spacing:.10em;
  text-transform:uppercase; opacity:.88; }
.hk-gap-t { flex:0 0 auto; font-weight:900; letter-spacing:-.02em; }
.hk-gap-t i { font-style:normal; font-size:.72em; font-weight:800; opacity:.55; margin-left:.1em; }
/* Under a second is a pass in progress, so the number changes colour rather
   than the row: a tinted row at this size just looks like a selection. */
.hk-gap-row.ahead.close .hk-gap-t { color:var(--gain); }
.hk-gap-row.behind.close .hk-gap-t { color:var(--loss); }
/* Nobody ahead / nobody behind is a state, not a blank line — same rule the
   empty item slot follows. The furniture dims but the label does not, because
   "LEADING" is the most valuable thing that row will ever say. */
.hk-gap-row.none .hk-gap-chev, .hk-gap-row.none .hk-gap-t { opacity:.34; }
.hk-gap-row.none .hk-gap-dot { background:transparent;
  box-shadow:inset 0 0 0 calc(var(--u)*.16) rgba(255,255,255,.45); }
.hk-gap-row.none .hk-gap-name { opacity:.7; letter-spacing:.16em; }
.hk-gap-row.ahead.none .hk-gap-name { color:var(--gold); opacity:.95; }
.hk-gap-row.none .hk-gap-t i { display:none; }
/* The player's own line, drawn as a rule rather than a fourth readout: the
   position numeral already owns that number, bottom-left. */
.hk-gap-you { display:flex; align-items:center; gap:calc(var(--u)*.5); margin:calc(var(--u)*.28) 0; }
.hk-gap-you::before, .hk-gap-you::after { content:''; height:calc(var(--u)*.22); flex:1 1 auto;
  background:linear-gradient(90deg,rgba(255,212,92,0),var(--gold)); }
.hk-gap-you::after { background:linear-gradient(90deg,var(--gold),rgba(255,212,92,0)); }
.hk-gap-you span { font-size:calc(var(--u)*1.35); font-weight:900; letter-spacing:.26em;
  text-transform:uppercase; color:var(--gold); text-shadow:var(--halo); }
.hk-hud.final .hk-gap-you span { color:var(--hot); }

/* ---- SPLITS (under the gaps) --------------------------------------------- */
.hk-times { text-align:right; line-height:1.5; }
.hk-times:empty { display:none; }
.hk-times-row { font-size:calc(var(--u)*1.75); font-weight:800; letter-spacing:.02em;
  text-shadow:var(--halo); opacity:.9; white-space:nowrap; }
.hk-times-row i { font-style:normal; opacity:.55; letter-spacing:.2em; margin-right:calc(var(--u)*.6); }
.hk-times-row b { font-weight:900; }
.hk-times-row.best b { color:var(--gold); }

/* ---- COINS (bottom-left, above position) --------------------------------- */
.hk-coins { position:absolute; left:var(--sl); bottom:calc(var(--sb) + var(--u)*13.6);
  display:flex; align-items:center; gap:calc(var(--u)*.75); }
.hk-coin-ico { width:calc(var(--u)*3.3); height:calc(var(--u)*3.3); display:block;
  filter:drop-shadow(0 0 calc(var(--u)*.25) rgba(0,0,0,.9))
         drop-shadow(0 calc(var(--u)*.25) calc(var(--u)*.6) rgba(0,0,0,.7)); }
.hk-coins-val { font-size:calc(var(--u)*3.5); font-weight:900; letter-spacing:-.02em;
  text-shadow:var(--halo); }

/* ---- POSITION (bottom-left) — the hero element ---------------------------
   Rendered twice: a dark stroked copy behind the gradient fill. A gradient
   clipped to text cannot take a text-shadow, and drop-shadow alone smears at
   this size, so the stroke is what keeps the numeral readable on sand. */
/* The extra lift is an optical correction, not a gutter change: line-height
   .78 makes the glyph overflow its own line box, so aligning the box to the
   safe margin puts the ink itself past it. */
.hk-pos { position:absolute; left:var(--sl); bottom:calc(var(--sb) + var(--u)*.9);
  display:flex; align-items:flex-start; will-change:transform; }
.hk-pos-num { position:relative; font-size:calc(var(--u)*13.2); font-weight:900; line-height:.78;
  letter-spacing:-.05em; }
.hk-pos-num::before { content:attr(data-v); position:absolute; inset:0; z-index:0;
  -webkit-text-stroke:calc(var(--u)*.62) rgba(2,5,12,.88); color:transparent;
  filter:drop-shadow(0 calc(var(--u)*.5) calc(var(--u)*1.6) rgba(0,0,0,.65)); }
/* NOTE: background-image, never the background shorthand. The shorthand resets
   background-clip to border-box, and the gain/loss overrides below would then
   silently turn the numeral into a solid coloured rectangle. */
.hk-pos-fill { position:relative; z-index:1;
  background-image:linear-gradient(178deg,#ffffff 12%,var(--gold) 48%,var(--gold-2) 76%,var(--gold-3) 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent; }
.hk-pos-ord { position:relative; font-size:calc(var(--u)*4.4); font-weight:900; line-height:1;
  margin-left:calc(var(--u)*.3); margin-top:calc(var(--u)*1.3); letter-spacing:-.02em; }
.hk-pos-ord::before { content:attr(data-v); position:absolute; inset:0;
  -webkit-text-stroke:calc(var(--u)*.5) rgba(2,5,12,.88); color:transparent; }
.hk-pos-ord span { position:relative; color:var(--gold); }
/* Tint sweeps back to gold on its own, so a gain/loss reads even if two
   changes land inside a second. */
.hk-pos.gain .hk-pos-fill { background-image:linear-gradient(178deg,#ffffff 10%,var(--gain) 55%,#0fae66 100%); }
.hk-pos.gain .hk-pos-ord span { color:var(--gain); }
.hk-pos.loss .hk-pos-fill { background-image:linear-gradient(178deg,#ffffff 10%,var(--loss) 55%,#9c0d2c 100%); }
.hk-pos.loss .hk-pos-ord span { color:var(--loss); }
.hk-pos-arrow { position:absolute; left:calc(100% + var(--u)*.4); top:calc(var(--u)*.6);
  font-size:calc(var(--u)*3.2); font-weight:900; opacity:0; pointer-events:none;
  text-shadow:var(--halo); }

/* ---- SPEED (bottom-right) ------------------------------------------------ */
.hk-speed { position:absolute; right:calc(var(--sr) - var(--u)*1.2); bottom:calc(var(--sb) - var(--u)*1.2);
  width:calc(var(--u)*25); height:calc(var(--u)*25); }
.hk-speed svg { position:absolute; inset:0; overflow:visible;
  filter:drop-shadow(0 calc(var(--u)*.4) calc(var(--u)*1.2) rgba(0,0,0,.7)); }
.hk-speed-num { position:absolute; left:0; right:0; top:54%; transform:translateY(-50%);
  text-align:center; font-size:calc(var(--u)*7.0); font-weight:900; letter-spacing:-.055em;
  line-height:1; text-shadow:var(--halo); transition:color .18s linear; }
.hk-speed.boost .hk-speed-num { color:#e8fbff; text-shadow:var(--halo),0 0 calc(var(--u)*2.4) rgba(90,220,255,.85); }
.hk-speed-unit { position:absolute; left:0; right:0; top:70%; text-align:center;
  font-size:calc(var(--u)*1.5); font-weight:800; letter-spacing:.34em; opacity:.7;
  text-transform:uppercase; text-shadow:var(--halo); }
.hk-arc-glow { opacity:0; transition:opacity .12s linear; }
.hk-speed.boost .hk-arc-glow { opacity:.85; }
.hk-needle { transform-box:view-box; transform-origin:50px 54px; }

/* ---- CENTRE STAGE: countdown, banners, finish ----------------------------
   .hk-center holds the countdown and nothing else; the banner and the finish
   card below are their own absolutely-positioned elements. (No backticks in
   this block, ever — the whole stylesheet is one template literal.)

   It is hung off the top gutter in --u, like the item slot, the star chip and
   the lap banner. It used to be a full-screen flex box centred on the viewport
   and then lifted by a padding-bottom of 11u — a bet that half of that lift
   would cover the distance from the centre of the frame to the top of the
   player's own kart. It does not. Measured on the grid at 720p, 1080p,
   1440p and 2160p, the chase camera parks the kart's silhouette from 53.2% of
   frame height down and the driver's helmet from 59.7% — the same fractions at
   every resolution, because that is a property of the camera, not the screen.
   The lamp row landed at 60.1%: dead on the helmet, reading as two glowing
   mouse ears growing out of the driver's head. And because the lift was
   denominated in --u while the distance it had to cover is a fraction of the
   frame, it bought *less* clearance the smaller the window got.

   So the anchor is now the one thing in this HUD that cannot move, and the
   centre column's budget from the top gutter reads end to end:

     slot 0–13.4, lamp gantry 14.4–16.6, star chip 13.9–17.1,
     lap banner 17.7–23.1, countdown numeral 18.4–48.4,
     kart silhouette from ~50.6, helmet from ~58.7.

   The numeral crosses the chip's and the banner's bands, and that is fine
   rather than lucky: none of the three can be on screen at the same time. A
   star cannot be running before the start, lap 1 raises no banner, and the
   only other caller of banner() is the finish. Anyone widening one of those
   three has to re-check this list.

   Lamps above the numeral, not below it, which is also where a start gantry
   belongs: they hang off the item slot as if bolted to it, the numeral counts
   underneath, and neither of them is within 10u of the player's kart. */
.hk-center { position:absolute; left:0; right:0; top:var(--st);
  display:flex; flex-direction:column; align-items:center; pointer-events:none; }

/* 14.4 = clear of the 13.4u slot plus a 1u breath. It is a margin rather than
   a top offset because the slot is a *sibling* of this stage, not a box it can
   flow under. */
.hk-lamps { display:flex; gap:calc(var(--u)*1.5); margin-top:calc(var(--u)*14.4); }
/* An unlit lamp is a dark socket with a bright rim, not a pale translucent
   disc. It used to sit over the player's kart, where anything light read
   instantly; up here it sits in the sky band, which on sunsetCoast is the
   brightest thing in the frame, and a white-on-white circle is a bug. */
.hk-lamp { width:calc(var(--u)*2.2); height:calc(var(--u)*2.2); border-radius:50%;
  background:rgba(6,11,22,.60); border:calc(var(--u)*.26) solid rgba(255,255,255,.62);
  box-shadow:inset 0 calc(var(--u)*.2) calc(var(--u)*.45) rgba(0,0,0,.75),
             0 0 calc(var(--u)*.45) rgba(0,0,0,.85); }
/* One line, one owner — the same rule the star chip already follows. The
   gantry takes the ITEM tag's line for the length of the countdown, which is
   the one stretch of the race where the slot is guaranteed empty and the word
   ITEM is telling the player nothing the dashed mark inside the slot is not
   already saying. */
.hk-hud.counting .hk-item .hk-item-tag { opacity:0; }

.hk-count { font-size:calc(var(--u)*30); font-weight:900; letter-spacing:-.06em; line-height:1;
  position:relative; margin-top:calc(var(--u)*1.8);
  filter:drop-shadow(0 calc(var(--u)*.8) calc(var(--u)*2.2) rgba(0,0,0,.6)); }
.hk-count::before { content:attr(data-v); position:absolute; inset:0;
  -webkit-text-stroke:calc(var(--u)*1.25) rgba(2,5,12,.88); color:transparent; }
.hk-count span { position:relative; -webkit-background-clip:text; background-clip:text; color:transparent; }
.hk-count-ring { position:absolute; left:50%; top:50%; width:calc(var(--u)*34); height:calc(var(--u)*34);
  margin:calc(var(--u)*-17) 0 0 calc(var(--u)*-17); border-radius:50%;
  border:calc(var(--u)*.5) solid currentColor; opacity:0; }
.hk-lamp.on { background:radial-gradient(circle at 40% 34%,#fff,var(--lamp,#ff5030) 62%);
  border-color:rgba(255,255,255,.7);
  box-shadow:0 0 calc(var(--u)*1.6) var(--lamp,#ff5030),0 0 calc(var(--u)*4) rgba(255,80,48,.45); }

/* Banner: a slanted lozenge that wipes open, used for laps and callouts.
   It used to span the full width at 26% height, which is exactly where the
   horizon sits in a chase camera — so LAP 2 blacked out the approaching
   corner, the grandstand and the rival pack for the whole announcement. Now it
   is sized to its own text and parked in the clear sky band between the item
   slot and the horizon, so it occludes ~1% of the frame instead of ~11%.
   Position is measured in --u from the top gutter rather than in viewport
   percent, which is what keeps it tucked under the item slot at every
   resolution instead of drifting onto the skyline at 1440p. */
.hk-band { position:absolute; left:50%; top:calc(var(--st) + var(--u)*17.7); transform:translateX(-50%);
  height:calc(var(--u)*5.4); padding:0 calc(var(--u)*3.2);
  display:flex; align-items:center; justify-content:center; pointer-events:none; overflow:hidden;
  filter:drop-shadow(0 calc(var(--u)*.5) calc(var(--u)*1.4) rgba(0,0,0,.6)); }
/* Slanted ends rather than a skewed rectangle: at letterbox width a 1.4deg
   skew read as motion, but on a 300px lozenge it reads as a misaligned box.
   The parallelogram carries the same speed cue at any width, and the clip
   scales with the wipe because a transform scales the painted result. */
.hk-band-bg { position:absolute; inset:0; --sk:calc(var(--u)*1.9);
  clip-path:polygon(var(--sk) 0, 100% 0, calc(100% - var(--sk)) 100%, 0 100%);
  background:linear-gradient(90deg, rgba(5,10,20,.90), rgba(12,20,38,.80) 50%, rgba(5,10,20,.90)); }
.hk-band-bg::before, .hk-band-bg::after { content:''; position:absolute; height:calc(var(--u)*.3);
  background:linear-gradient(90deg,transparent,var(--bc,#ffd45c) 18%,var(--bc,#ffd45c) 82%,transparent); }
/* Each rule stops short of the slanted end it runs into, or it pokes out. */
.hk-band-bg::before { top:0; left:calc(var(--sk) + var(--u)*.5); right:calc(var(--u)*.5); }
.hk-band-bg::after { bottom:0; left:calc(var(--u)*.5); right:calc(var(--sk) + var(--u)*.5); }
.hk-band-streak { position:absolute; top:0; bottom:0; width:26%; transform:skewX(-18deg);
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent); }
.hk-band-txt { position:relative; font-size:calc(var(--u)*4.0); font-weight:900; letter-spacing:.03em;
  white-space:nowrap; text-shadow:var(--halo); }

/* Finish card. */
.hk-finish { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(calc(var(--u)*54), 84vw); padding:calc(var(--u)*3.2) calc(var(--u)*3.4) calc(var(--u)*2.8);
  --chamfer:calc(var(--u)*3.4); pointer-events:none; text-align:center;
  clip-path:polygon(var(--chamfer) 0,calc(100% - var(--chamfer)) 0,100% var(--chamfer),
    100% calc(100% - var(--chamfer)),calc(100% - var(--chamfer)) 100%,var(--chamfer) 100%,
    0 calc(100% - var(--chamfer)),0 var(--chamfer));
  background-image:linear-gradient(180deg, var(--gold) 0, var(--gold) calc(var(--u)*.4), rgba(0,0,0,0) calc(var(--u)*.4)),
    linear-gradient(165deg, rgba(14,23,42,.93), rgba(4,7,16,.96));
  filter:drop-shadow(0 calc(var(--u)*2) calc(var(--u)*5) rgba(0,0,0,.75)); }
.hk-finish-hdr { font-size:calc(var(--u)*2.2); font-weight:900; letter-spacing:.42em; opacity:.8;
  text-transform:uppercase; }
.hk-finish-place { display:flex; align-items:flex-start; justify-content:center; margin:calc(var(--u)*.6) 0 calc(var(--u)*1.6); }
.hk-finish-num { font-size:calc(var(--u)*14); font-weight:900; line-height:.8; letter-spacing:-.05em;
  background-image:linear-gradient(178deg,#fff 12%,var(--gold) 50%,var(--gold-2) 78%,var(--gold-3) 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 calc(var(--u)*.5) calc(var(--u)*1.4) rgba(0,0,0,.6)); }
.hk-finish-ord { font-size:calc(var(--u)*4.6); font-weight:900; color:var(--gold);
  margin:calc(var(--u)*1.4) 0 0 calc(var(--u)*.4); }
.hk-finish-rows { display:flex; flex-direction:column; gap:calc(var(--u)*.55); }
.hk-frow { display:flex; justify-content:space-between; align-items:baseline;
  font-size:calc(var(--u)*2.0); font-weight:800;
  padding:calc(var(--u)*.55) calc(var(--u)*1.0); background:rgba(255,255,255,.055); }
.hk-frow i { font-style:normal; opacity:.6; letter-spacing:.22em; font-size:calc(var(--u)*1.55);
  text-transform:uppercase; }
.hk-frow b { font-weight:900; font-size:calc(var(--u)*2.3); }
.hk-frow.hi b { color:var(--gold); }
.hk-finish-rule { height:calc(var(--u)*.3); margin:calc(var(--u)*1.4) 0 calc(var(--u)*1.6);
  background:linear-gradient(90deg,transparent,var(--gold),transparent); opacity:.8; }
`;

// Triples reuse their single's art, so icon nodes are keyed by art kind and a
// held Triple Banana and a Banana share one pre-built DOM node.
const ART_KIND = {
  banana: 'banana', tripleBanana: 'banana',
  greenShell: 'greenShell', tripleGreen: 'greenShell',
  redShell: 'redShell', tripleRed: 'redShell',
  mushroom: 'mushroom', tripleMushroom: 'mushroom',
  star: 'star', thunder: 'thunder', bulletBill: 'bulletBill',
};

// Item accent colours. The slot rim takes these so a held item is identifiable
// from peripheral vision, before the icon itself has been read.
const ITEM_TINT = {
  banana: '#ffd83d', tripleBanana: '#ffd83d',
  greenShell: '#4be06a', tripleGreen: '#4be06a',
  redShell: '#ff5346', tripleRed: '#ff5346',
  mushroom: '#ff6a6a', tripleMushroom: '#ff6a6a',
  star: '#ffe14d', thunder: '#7fd8ff', bulletBill: '#c9d6e4',
};

/**
 * Inline SVG item art.
 *
 * Hand-built rather than emoji: emoji shells render as flat coloured circles
 * that are indistinguishable at slot size, and their look drifts between
 * platforms. These are self-contained (no external assets) and read correctly
 * at every size the slot can take.
 */
function itemArt(id, uid) {
  const g = `hk${uid}_${id}`;
  switch (id) {
    // A true crescent (two arcs of different radius sharing their tips), not a
    // thick stroked arc — a stroked arc has parallel sides and reads as a
    // magnet or a wrench rather than fruit.
    case 'banana': case 'tripleBanana':
      return `<svg viewBox="0 0 64 64"><defs>
        <linearGradient id="${g}" x1=".1" y1="0" x2=".8" y2="1">
          <stop offset="0" stop-color="#fff7bd"/><stop offset=".42" stop-color="#ffd52e"/>
          <stop offset="1" stop-color="#c98d04"/></linearGradient></defs>
        <path d="M11 52 A25.5 25.5 0 0 1 50 13 A62 62 0 0 0 11 52 Z" fill="url(#${g})"
          stroke="#3a2703" stroke-opacity=".7" stroke-width="3.2" stroke-linejoin="round"/>
        <path d="M17 46 A26 26 0 0 1 43 20" fill="none" stroke="#fffbe0" stroke-opacity=".72"
          stroke-width="3.4" stroke-linecap="round"/>
        <path d="M49 15 l6 -6" stroke="#6b4a12" stroke-width="6" stroke-linecap="round"/>
        <circle cx="10.5" cy="53.5" r="3.6" fill="#6b4a12"/></svg>`;

    case 'greenShell': case 'tripleGreen':
    case 'redShell': case 'tripleRed': {
      // The belly is kept low and the scutes are outlined in light, or the
      // whole thing collapses into a two-tone circle that reads as a ball.
      // Scutes are drawn LIGHTER than the dome with a dark outline. Darker
      // plates on a dark dome vanish at slot size and the icon collapses into
      // a two-tone circle that reads as a ball, not a shell.
      const red = id[0] === 'r';
      const c1 = red ? '#ffb0a2' : '#7fea9a', c2 = red ? '#e0281c' : '#1a9c3c', c3 = red ? '#6d0a05' : '#053a14';
      return `<svg viewBox="0 0 64 64"><defs>
        <radialGradient id="${g}" cx=".34" cy=".24" r=".9">
          <stop offset="0" stop-color="${c2}"/><stop offset=".62" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/></radialGradient></defs>
        <circle cx="32" cy="32" r="23" fill="url(#${g})"/>
        <g fill="${c1}" stroke="${c3}" stroke-width="2.2" stroke-linejoin="round">
          <path d="M32 11 L44 20 L40 35 L24 35 L20 20 Z"/>
          <path d="M12.5 24 L20 20 L24 35 L13.5 37 Z"/>
          <path d="M51.5 24 L44 20 L40 35 L50.5 37 Z"/></g>
        <path d="M10.4 40 A23 23 0 0 0 53.6 40 Z" fill="#f8efd8"/>
        <path d="M10.4 40 h43.2" stroke="#05101c" stroke-opacity=".6" stroke-width="2.6"/>
        <ellipse cx="21" cy="17" rx="8" ry="4.6" fill="#fff" fill-opacity=".55" transform="rotate(-28 21 17)"/>
        <circle cx="32" cy="32" r="23" fill="none" stroke="#030a14" stroke-opacity=".75" stroke-width="3.2"/></svg>`;
    }

    case 'mushroom': case 'tripleMushroom':
      return `<svg viewBox="0 0 64 64"><defs>
        <linearGradient id="${g}" x1="0" y1="0" x2=".3" y2="1">
          <stop offset="0" stop-color="#ff9a8e"/><stop offset=".45" stop-color="#f0362f"/><stop offset="1" stop-color="#9c0d0a"/></linearGradient></defs>
        <path d="M24 34 h16 v11 a8 7.5 0 0 1 -16 0 z" fill="#0a0f18" fill-opacity=".55" transform="translate(0,2)"/>
        <path d="M24 34 h16 v11 a8 7.5 0 0 1 -16 0 z" fill="#fff3d6" stroke="#3a2a10" stroke-opacity=".5" stroke-width="2"/>
        <path d="M5 38 A27 24 0 0 1 59 38 Z" fill="url(#${g})" stroke="#2a0605" stroke-opacity=".55" stroke-width="2.6" stroke-linejoin="round"/>
        <g fill="#fff6e2"><ellipse cx="19" cy="27" rx="7" ry="5.4"/><ellipse cx="43" cy="25" rx="6" ry="4.8"/><ellipse cx="31" cy="16" rx="5" ry="3.8"/></g>
        <ellipse cx="17" cy="34" rx="8" ry="3" fill="#fff" fill-opacity=".22"/></svg>`;

    case 'star':
      return `<svg viewBox="0 0 64 64"><defs>
        <linearGradient id="${g}" x1=".2" y1="0" x2=".8" y2="1">
          <stop offset="0" stop-color="#fffce0"/><stop offset=".45" stop-color="#ffdf3d"/><stop offset="1" stop-color="#e8890a"/></linearGradient></defs>
        <polygon points="32,6 38.5,23.1 56.7,24 42.5,35.4 47.3,53 32,43 16.7,53 21.5,35.4 7.3,24 25.5,23.1"
          fill="url(#${g})" stroke="#4a2600" stroke-opacity=".6" stroke-width="3" stroke-linejoin="round"/>
        <polygon points="32,14 36,24.5 47,25 38.5,32 41.5,43 32,36.5 22.5,43 25.5,32 17,25 28,24.5"
          fill="#fff" fill-opacity=".35"/></svg>`;

    case 'thunder':
      return `<svg viewBox="0 0 64 64"><defs>
        <linearGradient id="${g}" x1=".2" y1="0" x2=".7" y2="1">
          <stop offset="0" stop-color="#ffffff"/><stop offset=".4" stop-color="#8fe9ff"/><stop offset="1" stop-color="#1a7fe0"/></linearGradient></defs>
        <path d="M39 4 L15 35 L29 35 L25 60 L50 26 L35 26 L43 4 Z" fill="url(#${g})"
          stroke="#06203a" stroke-opacity=".6" stroke-width="3" stroke-linejoin="round"/>
        <path d="M38 10 L21 32 L31 32 L28 50" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.6" stroke-linecap="round"/></svg>`;

    case 'bulletBill':
      return `<svg viewBox="0 0 64 64"><defs>
        <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#dfe9f6"/><stop offset=".36" stop-color="#8395ad"/>
          <stop offset=".72" stop-color="#4a5872"/><stop offset="1" stop-color="#232c3c"/></linearGradient>
        <linearGradient id="${g}b" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#8fe9ff"/>
          <stop offset="1" stop-color="#2b6dff" stop-opacity="0"/></linearGradient></defs>
        <path d="M20 23 L1 32 L20 41 Z" fill="url(#${g}b)"/>
        <g stroke="#05101c" stroke-opacity=".7" stroke-width="2.8" stroke-linejoin="round">
          <path d="M17 11 L27 19 V45 L17 53 Z" fill="#3a4760"/>
          <path d="M23 19 H37 A13 13 0 0 1 37 45 H23 Z" fill="url(#${g})"/></g>
        <rect x="27" y="23" width="19" height="4.6" rx="2.3" fill="#ffffff" fill-opacity=".55"/>
        <circle cx="46" cy="32" r="3.6" fill="#ffd45c" stroke="#4a2600" stroke-opacity=".6" stroke-width="1.8"/></svg>`;

    default:
      return '';
  }
}

// The deliberate-empty mark: a hollow chamfered lozenge, not a "?" glyph.
const EMPTY_MARK = `<svg viewBox="0 0 64 64"><path d="M32 6 L54 20 V44 L32 58 L10 44 V20 Z"
  fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round" stroke-dasharray="7 5"/>
  <circle cx="32" cy="32" r="5" fill="#fff"/></svg>`;

const COIN_ICON = `<svg class="hk-coin-ico" viewBox="0 0 32 32"><defs>
  <linearGradient id="hkcoin" x1=".2" y1="0" x2=".8" y2="1">
    <stop offset="0" stop-color="#fff5c0"/><stop offset=".5" stop-color="#ffcf3d"/><stop offset="1" stop-color="#c47a04"/></linearGradient></defs>
  <circle cx="16" cy="16" r="14" fill="url(#hkcoin)" stroke="#5a3600" stroke-opacity=".7" stroke-width="2.4"/>
  <circle cx="16" cy="16" r="9" fill="none" stroke="#8a5400" stroke-opacity=".5" stroke-width="2"/>
  <path d="M13 11 h6 v3 h-4 v2 h4 v3 h-4 v2 h4 v3 h-6 z" fill="#7a4a00" fill-opacity=".65"/></svg>`;

// Gauge geometry, shared by the arc, the ticks and the needle. 270° of sweep
// starting at the lower-left, which is the shape every car dash uses because
// the eye reads "full" as "pointing right".
const G = { cx: 50, cy: 54, r: 38, a0: 135, span: 270 };
const gp = (deg, rad) => [
  G.cx + Math.cos(deg * Math.PI / 180) * rad,
  G.cy + Math.sin(deg * Math.PI / 180) * rad,
];

const ORDINALS = ['', 'st', 'nd', 'rd'];
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13) ? 'th' : (ORDINALS[n % 10] || 'th');

/**
 * Distance between two karts expressed as the time one would take to cover it.
 *
 * Metres mean nothing to a driver — "eleven metres" is not a decision — but
 * "0.4 seconds" is the unit every overtake is judged in. Converting against the
 * pair's mean pace rather than the player's alone keeps the number honest when
 * one of them is spun or boosting. The floor (12 m/s ≈ 43 km/h) is what stops a
 * stopped kart reporting half a minute of gap to the rival alongside it.
 */
function rawGap(a, b) {
  const d = Math.abs(a.raceDistance - b.raceDistance);
  return d / Math.max(12, (Math.abs(a.speed) + Math.abs(b.speed)) * 0.5);
}

// A tenth of a second only changes a decision inside a few car lengths. Above
// ten seconds it is noise — and dropping it there also stops a row that is
// nowhere near rewriting itself five times a second for no reader.
const fmtGap = (g) => (g >= 99 ? '99' : g >= 10 ? g.toFixed(0) : g.toFixed(1));

const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const EASE_BACK = 'cubic-bezier(.2,1.7,.4,1)';

const REDUCE = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/**
 * The race clock, as of the last frame the HUD was updated on.
 *
 * The capture harness has to place every finite animation where it should be
 * at the race time being captured, and the Web Animations clock cannot tell it
 * that: that clock is wall time, which the harness deliberately does not
 * advance. Seeking to the race clock itself was the same mistake one level
 * down — an animation issued at race time 3.0 and captured at 3.2 was seeked
 * to 3200 ms and clamped to its own end. What the seek needs is time *since
 * this animation began*, so every animation started here carries the race
 * clock it was issued on.
 */
let RACE_NOW = 0;
const stamp = (a) => { a.__hkRaceStart = RACE_NOW; return a; };

/**
 * Run a multi-step keyframe sequence with LINEAR iteration timing.
 *
 * This exists because of a trap: the `easing` in an animation's options is the
 * timing function for the whole iteration, applied *before* keyframe offsets
 * are resolved. Passing a strong ease-out there squeezes a four-step sequence
 * into the first third of its duration, so a 940ms countdown numeral is
 * already fading at 300ms. Per-keyframe easing is what shapes each segment;
 * the iteration must stay linear.
 */
function seq(el, frames, duration, opts = {}) {
  // The CSS reduced-motion override in index.html cannot reach these: script
  // animations are outside the cascade. Collapsing to 1ms keeps every
  // `.finished` handler (which is what removes the transient nodes) intact.
  const d = REDUCE && REDUCE.matches ? 1 : duration;
  return stamp(el.animate(frames, { duration: d, easing: 'linear', ...opts }));
}

export class HUD {
  constructor(root) {
    if (!document.getElementById('hk-hud-style')) {
      const style = document.createElement('style');
      style.id = 'hk-hud-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.uid = ++UID;

    this.el = document.createElement('div');
    this.el.className = 'hk-hud';
    this.el.innerHTML = this._markup();
    root.appendChild(this.el);

    const q = (s) => this.el.querySelector(s);
    this.dom = {
      root: this.el,
      lap: q('[data-lap]'), laps: q('[data-laps]'),
      item: q('.hk-item'), itemIcon: q('[data-item]'), itemCount: q('[data-count]'),
      itemFrame: q('.hk-item-frame'),
      pos: q('.hk-pos'), posNum: q('[data-pos]'), posFill: q('[data-posfill]'),
      ord: q('[data-ord]'), ordSpan: q('[data-ordspan]'), arrow: q('[data-arrow]'),
      speed: q('.hk-speed'), speedNum: q('[data-speed]'),
      arc: q('[data-arc]'), arcGlow: q('[data-arcglow]'), needle: q('[data-needle]'),
      coins: q('[data-coins]'), center: q('[data-center]'),
      times: q('[data-times]'), map: q('[data-map]'),
      star: q('[data-star]'), starFill: q('[data-starfill]'),
      gaps: q('[data-gaps]'),
      help: q('[data-help]'), helpSheet: q('[data-helpsheet]'),
      helpX: q('[data-helpx]'), helpGo: q('[data-helpgo]'),
    };

    // Controls card. Toggled by the button, by `H`, and dismissed by clicking
    // anywhere off the card — the three things a player will try. It does not
    // pause: nothing in this build pauses, and a card that silently stopped the
    // race would be a bigger surprise than one that does not.
    this._helpOpen = false;
    this._onHelpKey = (e) => {
      if (e.code === 'KeyH' || (e.key === '?' && !e.repeat)) { this.toggleHelp(); }
      else if (e.code === 'Escape' && this._helpOpen) this.toggleHelp(false);
    };
    this.dom.help?.addEventListener('click', () => this.toggleHelp());
    this.dom.helpX?.addEventListener('click', () => this.toggleHelp(false));
    this.dom.helpGo?.addEventListener('click', () => this.toggleHelp(false));
    this.dom.helpSheet?.addEventListener('click', (e) => {
      if (e.target === this.dom.helpSheet) this.toggleHelp(false);
    });
    window.addEventListener('keydown', this._onHelpKey);

    // Gap rows are addressed by index (0 = ahead, 1 = behind) so the hot path
    // never runs a selector.
    this._gapRows = ['ahead', 'behind'].map((side) => {
      const row = this.el.querySelector(`[data-row="${side}"]`);
      return {
        row,
        dot: row.querySelector('.hk-gap-dot'),
        name: row.querySelector('.hk-gap-name'),
        val: row.querySelector('.hk-gap-t b'),
        // Mirrors, so a tick that computes an unchanged string writes nothing.
        smooth: 0, id: null, nameTxt: null, text: null, colour: null, close: null, none: null,
      };
    });

    // Every icon is built once and then only toggled. The roulette swaps the
    // visible item ~22 times a second; re-parsing SVG markup at that rate is
    // exactly the kind of hot-path work the class must not do.
    this._icons = {};
    for (const kind of new Set(Object.values(ART_KIND))) {
      const n = document.createElement('div');
      n.style.cssText = 'position:absolute;inset:0;display:none';
      n.innerHTML = itemArt(kind, this.uid);
      this.dom.itemIcon.appendChild(n);
      this._icons[kind] = n;
    }
    this._shownIcon = null;

    this.mapCtx = this.dom.map.getContext('2d');
    // Path length is a layout-ish query, so it is taken once here and never
    // again — the dash offset in update() is pure arithmetic from it.
    this.arcLen = this.dom.arc.getTotalLength();
    for (const a of [this.dom.arc, this.dom.arcGlow]) {
      a.style.strokeDasharray = `${this.arcLen}`;
      a.style.strokeDashoffset = `${this.arcLen}`;
    }

    this._mapAccum = 0;
    this._mapPath = null;
    this._mapPx = 256;
    this._displaySpeed = 0;
    this._needleVel = 0;      // needle has mass, so a boost makes it overshoot
    this._needleAngle = 0;
    this._surge = 0;
    this._finishShown = false;
    this._goShown = false;
    this._tint = 0;           // seconds left on the position gain/loss tint

    // Every value the HUD writes is mirrored here so update() can skip the
    // write when nothing changed. This is the difference between ~30 DOM
    // mutations per frame and ~0.
    this._c = {
      pos: -1, ord: '', lap: -1, laps: -1, speed: -1, coins: -1,
      item: undefined, multi: null, rolling: null, empty: null, uses: 0,
      times: -1, boost: null, arcOff: -1, glowOff: -1, needle: -999, final: false,
      star: null, starEnd: null, starFill: -1, gapsOn: null,
    };

    this._starMax = 1;
    this._starOut = null;   // in-flight chip fade, cancelled if a star returns
    this._gapAccum = 0;

    this._onResize = () => { this._sizeMap(); };
    window.addEventListener('resize', this._onResize);
    this._sizeMap();
  }

  _markup() {
    // Gauge ticks: 4 major + 24 minor, generated rather than hand-written so
    // the geometry constant above stays the single source of truth.
    let ticks = '';
    for (let i = 0; i <= 28; i++) {
      const major = i % 7 === 0;
      const a = G.a0 + (G.span * i) / 28;
      const [x1, y1] = gp(a, G.r + (major ? 7.5 : 5.5));
      const [x2, y2] = gp(a, G.r + 10.5);
      ticks += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"
        stroke="${major ? 'rgba(255,255,255,.62)' : 'rgba(255,255,255,.26)'}" stroke-width="${major ? 2.2 : 1.2}" stroke-linecap="round"/>`;
    }
    const [ax, ay] = gp(G.a0, G.r);
    const [bx, by] = gp(G.a0 + G.span, G.r);
    const arcD = `M ${ax.toFixed(2)} ${ay.toFixed(2)} A ${G.r} ${G.r} 0 1 1 ${bx.toFixed(2)} ${by.toFixed(2)}`;
    const u = this.uid;

    return `
      <div class="hk-scrim s-tl"></div><div class="hk-scrim s-tc"></div>
      <div class="hk-scrim s-tr"></div><div class="hk-scrim s-bl"></div>
      <div class="hk-scrim s-br"></div>

      <div class="hk-lap">
        <div class="hk-cap">Lap</div>
        <div class="hk-lap-rule"></div>
        <div class="hk-lap-row">
          <span class="hk-lap-val" data-lap>1</span>
          <span class="hk-lap-sep">/</span>
          <span class="hk-lap-tot" data-laps>3</span>
        </div>
      </div>

      <div class="hk-item empty">
        <div class="hk-item-frame"></div>
        <div class="hk-item-well">
          <div class="hk-item-rim"></div>
          <div class="hk-item-shine"></div>
          <div class="hk-item-mark">${EMPTY_MARK}</div>
          <div class="hk-item-icon" data-item></div>
        </div>
        <div class="hk-item-count" data-count></div>
        <div class="hk-item-tag">Item</div>
      </div>

      <div class="hk-star" data-star>
        <div class="hk-star-fill" data-starfill></div>
        <div class="hk-star-ico">${itemArt('star', `${u}s`)}</div>
        <div class="hk-star-txt">Star</div>
      </div>

      <div class="hk-map">
        <div class="hk-map-frame"></div>
        <div class="hk-map-well"><canvas data-map width="256" height="256"></canvas></div>
      </div>

      <button class="hk-help" data-help type="button" aria-label="Controls">?</button>
      <div class="hk-help-sheet" data-helpsheet>
        <div class="hk-help-card">
          <button class="hk-help-x" data-helpx type="button" aria-label="Close">×</button>
          <div class="hk-help-h">CONTROLS<span>.</span></div>
          ${HELP_ROWS.map((r) => `
          <div class="hk-help-row">
            <div class="hk-help-keys">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('')}</div>
            <div class="hk-help-what">${r.what}${r.note ? `<i>${r.note}</i>` : ''}</div>
          </div>`).join('')}
          <div class="hk-help-foot">
            A gamepad works too: left stick steers, right trigger accelerates,
            shoulder drifts.<br>
            <span class="hk-help-start">Nothing moves until you close this.</span>
            <span class="hk-help-race">The race keeps running while this is open.</span>
            <br>Close with <b>×</b>, <b>Esc</b>, <b>H</b>, or a click outside the card.
          </div>
          <button class="hk-help-go" data-helpgo type="button">START RACE</button>
        </div>
      </div>

      <div class="hk-rail">
        <div class="hk-gaps" data-gaps>
          ${['ahead', 'behind'].map((side) => `
          <div class="hk-gap-row ${side} none" data-row="${side}">
            <span class="hk-gap-chev">${side === 'ahead' ? '▲' : '▼'}</span>
            <span class="hk-gap-dot"></span>
            <span class="hk-gap-name">—</span>
            <span class="hk-gap-t"><b>—</b><i>s</i></span>
          </div>${side === 'ahead' ? '<div class="hk-gap-you"><span>You</span></div>' : ''}`).join('')}
        </div>
        <div class="hk-times" data-times></div>
      </div>

      <div class="hk-coins">${COIN_ICON}<span class="hk-coins-val" data-coins>0</span></div>

      <div class="hk-pos">
        <span class="hk-pos-num" data-pos data-v="1"><span class="hk-pos-fill" data-posfill>1</span></span>
        <span class="hk-pos-ord" data-ord data-v="st"><span data-ordspan>st</span></span>
        <span class="hk-pos-arrow" data-arrow></span>
      </div>

      <div class="hk-speed">
        <svg viewBox="0 0 100 100">
          <defs>
            <linearGradient id="hkg${u}" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stop-color="#4de1ff"/><stop offset="52%" stop-color="#ffd75e"/><stop offset="100%" stop-color="#ff4d4d"/>
            </linearGradient>
          </defs>
          <g>${ticks}</g>
          <path d="${arcD}" fill="none" stroke="rgba(4,10,20,.55)" stroke-width="10.5" stroke-linecap="round"/>
          <path d="${arcD}" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="6.5" stroke-linecap="round"/>
          <path class="hk-arc-glow" data-arcglow d="${arcD}" fill="none" stroke="#8fe9ff" stroke-width="14" stroke-linecap="round" opacity="0"/>
          <path data-arc d="${arcD}" fill="none" stroke="url(#hkg${u})" stroke-width="6.5" stroke-linecap="round"/>
          <g class="hk-needle" data-needle>
            <path d="M 50 8.5 L 50 23" fill="none" stroke="rgba(2,6,14,.8)" stroke-width="7.4" stroke-linecap="round"/>
            <path d="M 50 9.5 L 50 22" fill="none" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round"/>
          </g>
        </svg>
        <div class="hk-speed-num" data-speed>0</div>
        <div class="hk-speed-unit">km/h</div>
      </div>

      <div class="hk-center" data-center></div>
    `;
  }

  /**
   * Match the canvas backing store to real device pixels. At 1440p the map is
   * ~310 CSS px wide; drawing it into a 256px buffer is a visibly soft map,
   * which is the fastest way to make a HUD look cheap.
   */
  _sizeMap() {
    const r = this.dom.map.getBoundingClientRect();
    const px = Math.max(192, Math.min(640, Math.round(r.width * (window.devicePixelRatio || 1))));
    if (px === this._mapPx && this.dom.map.width === px) return;
    this._mapPx = px;
    this.dom.map.width = px;
    this.dom.map.height = px;
    // All draw code stays in a fixed 256-unit space; only this transform moves.
    this.mapCtx.setTransform(px / 256, 0, 0, px / 256, 0, 0);
  }

  setTrack(track) {
    this.track = track;
    this.dom.laps.textContent = track.laps;
    this._c.laps = track.laps;

    // Pre-project the centreline into minimap space once.
    const sp = track.spline;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.pos[i * 3], z = sp.pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const pad = 30;
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
    RACE_NOW = race.time ?? RACE_NOW;
    this._retireCountdown(race);
    const c = this._c;

    // Position -------------------------------------------------------------
    // The single most-glanced value, so it gets the loudest feedback: a punch
    // on any change, tinted by direction, plus a chevron that carries the
    // meaning even for a colour-blind player.
    if (p.rank !== c.pos) {
      const gained = c.pos > 0 && p.rank < c.pos;
      const lost = c.pos > 0 && p.rank > c.pos;
      c.pos = p.rank;
      const ord = ordinal(p.rank);
      this.dom.posFill.textContent = p.rank;
      this.dom.posNum.dataset.v = p.rank;
      if (ord !== c.ord) {
        c.ord = ord;
        this.dom.ordSpan.textContent = ord;
        this.dom.ord.dataset.v = ord;
      }
      if (gained || lost) this._punchPosition(gained);
    }
    if (this._tint > 0) {
      this._tint -= dt;
      if (this._tint <= 0) this.dom.pos.classList.remove('gain', 'loss');
    }

    // Lap --------------------------------------------------------------------
    const lap = Math.min(Math.max(p.lap, 1), this.track.laps);
    if (lap !== c.lap) {
      const first = c.lap < 0;
      c.lap = lap;
      this.dom.lap.textContent = lap;
      const final = lap === this.track.laps && this.track.laps > 1;
      if (final !== c.final) { c.final = final; this.el.classList.toggle('final', final); }
      if (!first && lap > 1) {
        this.banner(final ? 'FINAL LAP' : `LAP ${lap}`, final ? '#ff6a3a' : '#ffd45c');
      }
    }

    // Speed ------------------------------------------------------------------
    // The readout is smoothed so it does not strobe between adjacent integers;
    // the needle is a damped spring on top of that so a boost visibly slams it
    // past the true value and settles back, which is what sells the surge.
    this._displaySpeed += (p.speedKmh - this._displaySpeed) * Math.min(1, dt * 14);
    const kmh = Math.round(this._displaySpeed);
    if (kmh !== c.speed) { c.speed = kmh; this.dom.speedNum.textContent = kmh; }

    const boosting = !!p.boostActive;
    if (boosting !== c.boost) {
      c.boost = boosting;
      this.dom.speed.classList.toggle('boost', boosting);
      if (boosting) this._surgeSpeed();
    }
    this._surge *= Math.exp(-dt * 3.4);

    const top = p.stats.topSpeed * 3.6 * 1.65;
    const frac = clamp01((this._displaySpeed + this._surge * 26) / top);
    const off = Math.round(this.arcLen * (1 - frac) * 100) / 100;
    if (off !== c.arcOff) {
      c.arcOff = off;
      this.dom.arc.style.strokeDashoffset = `${off}`;
    }
    // The glow path sits at opacity 0 unless the gauge is in its boost state,
    // and it was being handed the same dash offset as the visible arc on every
    // single frame — a third of the whole HUD's DOM traffic spent painting
    // nothing. Its own mirror means it is caught up on the frame a boost
    // starts and then left alone for the rest of the lap.
    if (boosting && c.glowOff !== off) {
      c.glowOff = off;
      this.dom.arcGlow.style.strokeDashoffset = `${off}`;
    }

    // Needle spring. Stiff enough to track normal acceleration exactly, loose
    // enough that a mushroom throws it past the mark for a beat.
    const targetAngle = G.span * frac - G.span / 2;
    const k = 240, damping = 19;
    this._needleVel += ((targetAngle - this._needleAngle) * k - this._needleVel * damping) * Math.min(dt, 1 / 45);
    this._needleAngle += this._needleVel * Math.min(dt, 1 / 45);
    const na = Math.round(this._needleAngle * 5) / 5;
    if (na !== c.needle) {
      c.needle = na;
      this.dom.needle.style.transform = `rotate(${na}deg)`;
    }

    // Item -------------------------------------------------------------------
    // Three distinct beats, each with its own tell: rolling (rim sweeps, reel
    // jitters), locking in (slot overshoots and settles), spending (icon is
    // thrown out of the slot). Spending is keyed off the use count rather than
    // the item id, or a triple's second and third shots would be silent.
    const rolling = !!p.itemRoulette;
    const shown = rolling ? p.itemRoulette.display : p.item;
    const uses = p.itemUses || 0;
    const usesChanged = uses !== c.uses;

    if (uses < c.uses && c.item) this._spendItem(c.item);
    c.uses = uses;

    if (shown !== c.item) {
      c.item = shown;
      this._setIcon(shown ? ART_KIND[shown] : null);
      this.dom.itemFrame.style.setProperty('--rim', shown ? (ITEM_TINT[shown] || '#9fb4cc') : '#9fb4cc');
    }
    if (rolling !== c.rolling) {
      // Lock on the roulette *ending*, not on the icon changing: the last
      // cycled face is sometimes already the result, and that frame would
      // otherwise pass without the payoff animation.
      if (!rolling && c.rolling && p.item) this._lockItem();
      c.rolling = rolling;
      this.dom.item.classList.toggle('rolling', rolling);
    }
    const empty = !shown;
    if (empty !== c.empty) { c.empty = empty; this.dom.item.classList.toggle('empty', empty); }
    const multi = uses > 1;
    if (multi !== c.multi) { c.multi = multi; this.dom.item.classList.toggle('multi', multi); }
    if (multi && usesChanged) this.dom.itemCount.textContent = `×${uses}`;

    // Star -------------------------------------------------------------------
    // A star is spent the instant it is used, so the slot above is legitimately
    // empty (or already holding the next item) while the player is invincible.
    // Without this chip the only tell was the sparks on the kart itself, which
    // the player cannot see behind their own bodywork on a busy frame.
    const star = p.star > 0;
    if (star !== c.star) {
      c.star = star;
      if (star) {
        if (this._starOut) { this._starOut.cancel(); this._starOut = null; }
        this.el.classList.add('star');
        this._starMax = p.star;
        this._enterStar();
      } else {
        this._exitStar();
      }
    }
    if (star) {
      // A second star collected mid-effect refills rather than shortening it.
      if (p.star > this._starMax) this._starMax = p.star;
      const t = Math.round(clamp01(p.star / this._starMax) * 100) / 100;
      if (t !== c.starFill) { c.starFill = t; this.dom.starFill.style.transform = `scaleX(${t})`; }
      const ending = p.star < 1.5;
      if (ending !== c.starEnd) { c.starEnd = ending; this.dom.star.classList.toggle('ending', ending); }
    }

    // Gap to rivals ----------------------------------------------------------
    // Gated on the start because every kart shares a race distance of zero on
    // the grid, so a strip shown during the countdown reads "0.0" to everyone.
    const gapsOn = !!race.raceStarted && !p.finished;
    if (gapsOn !== c.gapsOn) { c.gapsOn = gapsOn; this.dom.gaps.classList.toggle('on', gapsOn); }
    if (gapsOn) {
      // Smoothed every frame because that is free arithmetic; written at 5 Hz
      // because that is not. A raw per-frame delta swings by tenths as either
      // kart corners, and a number that flickers is a number nobody reads.
      this._gapAccum += dt;
      const tick = this._gapAccum >= 0.2;
      if (tick) this._gapAccum = 0;
      this._updateGaps(dt, race, p, tick);
    }

    // Coins ------------------------------------------------------------------
    if (p.coins !== c.coins) {
      const up = p.coins > c.coins && c.coins >= 0;
      c.coins = p.coins;
      this.dom.coins.textContent = p.coins;
      if (up) this._pop(this.dom.coins.parentElement, 1.22, 260);
    }

    // Splits -----------------------------------------------------------------
    // Rebuilt only when a lap actually lands. The old code re-parsed this
    // markup on every single frame.
    if (p.lapTimes.length !== c.times) {
      c.times = p.lapTimes.length;
      const best = Math.min(...p.lapTimes);
      this.dom.times.innerHTML = p.lapTimes.map((t, i) =>
        `<div class="hk-times-row${t === best && p.lapTimes.length > 1 ? ' best' : ''}"><i>L${i + 1}</i><b>${fmtTime(t)}</b></div>`
      ).join('');
    }

    // Finish -----------------------------------------------------------------
    if (p.finished && !this._finishShown) { this._finishShown = true; this._showFinish(p, race); }

    // Minimap ----------------------------------------------------------------
    this._mapAccum += dt;
    if (this._mapAccum > 1 / 30) { this._mapAccum = 0; this._drawMap(race); }
  }

  // -- juice -----------------------------------------------------------------
  // All one-shot flourishes go through Web Animations rather than CSS classes:
  // no forced reflow to restart them, and transform/opacity keyframes stay on
  // the compositor while the game is rendering.

  _punchPosition(gained) {
    const el = this.dom.pos;
    el.classList.remove('gain', 'loss');
    el.classList.add(gained ? 'gain' : 'loss');
    // Short on purpose. In a twelve-kart pack places change constantly, and a
    // long tint would mean the ordinal is almost never its identity gold.
    this._tint = 0.75;
    seq(el, gained
      ? [{ transform: 'scale(1)', easing: EASE_OUT },
         { transform: 'scale(1.30) translateY(-7%)', offset: .3, easing: 'ease-in-out' },
         { transform: 'scale(1)' }]
      : [{ transform: 'scale(1)', easing: 'ease-out' },
         { transform: 'scale(.84) translateX(-4%)', offset: .22, easing: 'ease-in-out' },
         { transform: 'scale(1.04) translateX(3%)', offset: .58, easing: EASE_OUT },
         { transform: 'scale(1)' }],
      gained ? 560 : 520);

    const a = this.dom.arrow;
    a.textContent = gained ? '▲' : '▼';
    a.style.color = gained ? 'var(--gain)' : 'var(--loss)';
    seq(a, [
      { opacity: 0, transform: `translateY(${gained ? 70 : -70}%)`, easing: EASE_OUT },
      { opacity: 1, transform: 'translateY(0)', offset: .22 },
      { opacity: 1, transform: 'translateY(0)', offset: .68, easing: 'ease-in' },
      { opacity: 0, transform: `translateY(${gained ? -80 : 80}%)` },
    ], 1050);
  }

  /** The slot snaps shut on the rolled item: overshoot, spin settle, ring flash. */
  _lockItem() {
    seq(this.dom.item, [
      { transform: 'translateX(-50%) scale(1.36) rotate(-10deg)', easing: 'ease-in-out' },
      { transform: 'translateX(-50%) scale(.92) rotate(5deg)', offset: .42, easing: 'ease-in-out' },
      { transform: 'translateX(-50%) scale(1.07) rotate(-2deg)', offset: .72, easing: EASE_OUT },
      { transform: 'translateX(-50%) scale(1) rotate(0deg)' },
    ], 520);
    seq(this.dom.itemIcon,
      [{ opacity: 0, transform: 'scale(.35) rotate(-45deg)' }, { opacity: 1, transform: 'scale(1) rotate(0)' }],
      380, { easing: EASE_BACK });
    this._ring(this.dom.item, '#ffffff');
  }

  _setIcon(kind) {
    if (this._shownIcon) this._shownIcon.style.display = 'none';
    this._shownIcon = kind ? this._icons[kind] : null;
    if (this._shownIcon) this._shownIcon.style.display = 'block';
  }

  /** Spending an item throws the icon out of the slot rather than blanking it. */
  _spendItem(id) {
    const src = this._icons[ART_KIND[id]];
    if (!src) return;
    const ghost = document.createElement('div');
    ghost.className = 'hk-item-icon';
    ghost.style.cssText = 'pointer-events:none';
    ghost.appendChild(src.firstElementChild.cloneNode(true));
    this.dom.item.appendChild(ghost);
    seq(ghost, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.75) translateY(-46%)' }],
      380, { easing: 'cubic-bezier(.3,0,.6,1)' })
      .finished.then(() => ghost.remove(), () => ghost.remove());
    seq(this.dom.item, [
      { transform: 'translateX(-50%) scale(1)', easing: 'ease-out' },
      { transform: 'translateX(-50%) scale(.86)', offset: .28, easing: EASE_OUT },
      { transform: 'translateX(-50%) scale(1)' },
    ], 360);
    this._ring(this.dom.item, ITEM_TINT[id] || '#8fe9ff');
  }

  /** The chip drops in from under the slot, so the eye is led to it. */
  _enterStar() {
    seq(this.dom.star, [
      { opacity: 0, transform: 'translateX(-50%) translateY(-70%) scale(.72)', easing: EASE_OUT },
      { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1.09)', offset: .52, easing: 'ease-in-out' },
      { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)' },
    ], 460);
  }

  /**
   * Fade out rather than blink out. The `star` class carries `display:flex`,
   * so it has to survive until the animation lands — dropping it on the same
   * frame the timer expires would pre-empt the whole exit with `display:none`.
   */
  _exitStar() {
    const el = this.dom.star;
    el.classList.remove('ending');
    this._c.starEnd = null;
    const a = seq(el, [
      { opacity: 1, transform: 'translateX(-50%) scale(1)' },
      { opacity: 0, transform: 'translateX(-50%) scale(.88)' },
    ], 240, { easing: 'ease-in', fill: 'forwards' });
    this._starOut = a;
    a.finished.then(() => {
      if (this._starOut !== a) return;   // a new star already re-entered
      this._starOut = null;
      this.el.classList.remove('star');
      a.cancel();
      this._c.starFill = -1;
    }, () => {});
  }

  // -- gap to rivals ---------------------------------------------------------

  /** Standings are 1-based and already sorted; fall back to a scan if absent. */
  _rankedKart(race, rank) {
    if (rank < 1) return null;
    const st = race.standings;
    if (st) return rank <= st.length ? st[rank - 1] : null;
    for (const k of race.karts) if (k.rank === rank) return k;
    return null;
  }

  _updateGaps(dt, race, p, tick) {
    const a = 1 - Math.exp(-dt / 0.35);
    for (let i = 0; i < 2; i++) {
      const s = this._gapRows[i];
      const rival = this._rankedKart(race, p.rank + (i ? 1 : -1));
      const id = rival ? rival.index : -1;
      // A new kart in the slot must not inherit the old one's smoothed value,
      // and it must land immediately rather than on the next 5 Hz tick.
      const fresh = id !== s.id;
      if (fresh) { s.id = id; s.smooth = rival ? rawGap(p, rival) : 0; }
      else if (rival) s.smooth += (rawGap(p, rival) - s.smooth) * a;
      if (!tick && !fresh) continue;

      const none = !rival;
      if (none !== s.none) { s.none = none; s.row.classList.toggle('none', none); }
      // An empty row that says why it is empty beats an em-dash: leading the
      // race and running last are both information, not missing data.
      const name = none ? (i ? 'Last' : 'Leading') : rival.stats.name;
      if (name !== s.nameTxt) { s.nameTxt = name; s.name.textContent = name; }
      if (none) {
        if (s.text !== '—') { s.text = '—'; s.val.textContent = '—'; }
        if (s.close) { s.close = false; s.row.classList.remove('close'); }
        // The livery colour is an inline style, so it outranks the `.none`
        // rule that hollows the dot out; it has to be handed back explicitly.
        if (s.colour !== null) { s.colour = null; s.dot.style.background = ''; }
        continue;
      }
      if (fresh) {
        const col = `#${rival.stats.color.toString(16).padStart(6, '0')}`;
        if (col !== s.colour) { s.colour = col; s.dot.style.background = col; }
      }
      const txt = fmtGap(s.smooth);
      if (txt !== s.text) { s.text = txt; s.val.textContent = txt; }
      // Hysteresis, or a rival hovering on the threshold strobes the colour.
      const close = s.smooth < (s.close ? 1.25 : 1.0);
      if (close !== s.close) { s.close = close; s.row.classList.toggle('close', close); }
    }
  }

  _surgeSpeed() {
    this._surge = 1;
    this._needleVel += 900;   // kick the spring so the needle overshoots first
    this._pop(this.dom.speed, 1.07, 340);
  }

  /**
   * Expanding soft halo. A hard bordered rectangle was the first attempt and
   * it fought the octagonal frame; a radial ring has no shape of its own.
   */
  _ring(host, color) {
    const r = document.createElement('div');
    r.style.cssText = 'position:absolute;inset:-14%;pointer-events:none;border-radius:50%;' +
      `background:radial-gradient(closest-side, transparent 56%, ${color} 76%, transparent 100%);`;
    host.appendChild(r);
    seq(r, [{ opacity: .95, transform: 'scale(.82)' }, { opacity: 0, transform: 'scale(1.6)' }],
      500, { easing: 'ease-out' })
      .finished.then(() => r.remove(), () => r.remove());
  }

  /**
   * "You already have one."
   *
   * Fired when the player drives through a live box with a full slot. A nudge
   * sideways rather than a pop: a pop is what the slot does when something
   * *arrives*, and this is the opposite event, so it must not borrow the
   * reward's gesture. Small on purpose — it answers a question, it does not
   * demand attention mid-corner.
   */
  declineItem() {
    const el = this.dom.item;
    if (!el) return;
    seq(el, [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-5%)', offset: .25, easing: 'ease-out' },
      { transform: 'translateX(4%)', offset: .6, easing: 'ease-in-out' },
      { transform: 'translateX(0)' },
    ], 260);
    const f = this.dom.itemFrame;
    if (f) {
      seq(f, [
        { opacity: 1 }, { opacity: .45, offset: .3 }, { opacity: 1 },
      ], 260);
    }
  }

  _pop(el, scale, ms) {
    if (!el) return;
    seq(el, [
      { transform: 'scale(1)', easing: EASE_OUT },
      { transform: `scale(${scale})`, offset: .34, easing: 'ease-in-out' },
      { transform: 'scale(1)' },
    ], ms);
  }

  // -- minimap ---------------------------------------------------------------

  _drawMap(race) {
    const ctx = this.mapCtx;
    const m = this._map;
    if (!m) return;
    ctx.clearRect(0, 0, 256, 256);

    // Road drawn as three passes — dark casing, light surface, thin centre
    // highlight. A single grey stroke reads as a wire diagram; this reads as a
    // road at a glance, which is the whole point of a minimap.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 15.5; ctx.stroke(this._mapPath);
    ctx.strokeStyle = 'rgba(178,200,232,.55)'; ctx.lineWidth = 11; ctx.stroke(this._mapPath);
    ctx.strokeStyle = 'rgba(255,255,255,.30)'; ctx.lineWidth = 3.2; ctx.stroke(this._mapPath);

    // Start/finish: an actual checker bar, oriented to the track heading.
    const sp = this.track.spline;
    const si = sp.indexAt(this.track.startS);
    ctx.save();
    ctx.translate(sp.pos[si * 3] * m.scale + m.ox, sp.pos[si * 3 + 2] * m.scale + m.oy);
    ctx.rotate(Math.PI - sp.heading[si]);
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(-9.5, -3.5, 19, 7);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = (i % 2) ? '#ffffff' : '#12161e';
      ctx.fillRect(-9 + i * 3, -3, 3, 3);
      ctx.fillStyle = (i % 2) ? '#12161e' : '#ffffff';
      ctx.fillRect(-9 + i * 3, 0, 3, 3);
    }
    ctx.restore();

    // Rivals fade and shrink with distance so the two or three karts actually
    // in play stand out from the eight that are a straight away.
    const p = race.player;
    for (const k of race.karts) {
      if (k.isPlayer) continue;
      const d = Math.hypot(k.pos.x - p.pos.x, k.pos.z - p.pos.z);
      const near = clamp01(1 - d / 190);
      const alpha = 0.42 + near * 0.58;
      const rad = 3.8 + near * 2.6;
      const x = k.pos.x * m.scale + m.ox;
      const y = k.pos.z * m.scale + m.oy;
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(x, y, rad + 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = `#${k.stats.color.toString(16).padStart(6, '0')}`; ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Player: an arrow, not a dot. Direction of travel is the one thing a dot
    // cannot express, and it is what tells you which way the next corner goes.
    const px = p.pos.x * m.scale + m.ox;
    const py = p.pos.z * m.scale + m.oy;
    const pulse = 0.5 + 0.5 * Math.sin(race.time * 4.2);
    ctx.save();
    ctx.translate(px, py);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 17);
    halo.addColorStop(0, `rgba(255,214,90,${0.32 + pulse * 0.16})`);
    halo.addColorStop(1, 'rgba(255,214,90,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(Math.PI - p.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -10.5); ctx.lineTo(7.2, 8); ctx.lineTo(0, 4.2); ctx.lineTo(-7.2, 8);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(8,12,22,.85)';
    ctx.lineWidth = 2.8; ctx.lineJoin = 'round';
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }

  // -- centre stage ----------------------------------------------------------

  /** Sweeping banner. Also the public `toast` target, kept for callers. */
  banner(text, color = '#ffd45c') {
    if (this._finishShown) return;   // the results card owns the screen
    const d = document.createElement('div');
    d.className = 'hk-band';
    d.innerHTML = `<div class="hk-band-bg" style="--bc:${color}"></div>
      <div class="hk-band-streak"></div>
      <div class="hk-band-txt" style="color:${color}">${text}</div>`;
    this.el.appendChild(d);

    const bg = d.firstElementChild;
    const streak = d.children[1];
    const txt = d.children[2];
    // Bar wipes open from the centre, text lands late, streak crosses, all out.
    // The timings are ~25% tighter than the letterbox version: a lozenge this
    // small does not need a long read, and the whole event is over in 1.15s.
    seq(bg, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      240, { easing: EASE_OUT, fill: 'backwards' });
    seq(txt, [{ opacity: 0, transform: 'translateX(-16%) skewX(-14deg)' },
      { opacity: 1, transform: 'translateX(0) skewX(0)' }],
      280, { delay: 130, easing: EASE_OUT, fill: 'backwards' });
    seq(streak, [{ transform: 'translateX(-180%) skewX(-18deg)' }, { transform: 'translateX(420%) skewX(-18deg)' }],
      780, { delay: 170, easing: 'cubic-bezier(.4,0,.3,1)' });
    // The exit keeps the element's own translateX(-50%) centring — a bare
    // translateY here would snap the lozenge a half-width to the right.
    const out = stamp(d.animate([
      { opacity: 1, transform: 'translateX(-50%) translateY(0) scaleX(1)' },
      { opacity: 0, transform: 'translateX(-50%) translateY(-40%) scaleX(.94)' },
    ], { duration: 260, delay: 890, easing: 'ease-in', fill: 'forwards' }));
    out.finished.then(() => d.remove(), () => d.remove());
  }

  toast(text, color = '#fff') { this.banner(text, color); }

  /**
   * 3-2-1-GO. Three grid lamps fill as the count runs down, so the start reads
   * even in the half-second the numeral is mid-transition.
   */
  /**
   * @param {number} n       ticks remaining; <= 0 is GO
   * @param {number} raceTime the race clock at which this tick was issued
   *
   * The banner used to clear itself from `anim.finished` — the Web Animations
   * API's wall clock, which has nothing to do with the simulation. The capture
   * harness sits idle for a variable number of real seconds before it shoots,
   * so whether GO! was still on screen was a coin flip: six of fifteen
   * verification frames came back with a green banner over 24-43% of the
   * centre, and two HUD-on captures of the same code and the same sim time
   * differed on 10.7% of their pixels. Clearing off the race clock instead
   * makes a HUD-on capture as deterministic as the 3D one.
   */
  countdown(n, raceTime = 0) {
    if (n <= 0 && this._goShown) return;   // Race can emit tick 0 and 'go'
    if (n <= 0) this._goShown = true;
    // Events are drained before the HUD's own update, so take the clock from
    // the caller rather than letting these animations stamp a frame stale.
    RACE_NOW = raceTime;
    this._countAt = raceTime;
    this._countLife = n <= 0 ? 1.05 : 0.90;

    const go = n <= 0;
    const tone = go ? { a: '#d6fff0', b: '#3cf0a0', c: '#079c62', lamp: '#3cf0a0' }
      : n === 1 ? { a: '#fff0d8', b: '#ff8a2a', c: '#c03a00', lamp: '#ff8a2a' }
        : n === 2 ? { a: '#fff6d0', b: '#ffc32a', c: '#c07800', lamp: '#ffc32a' }
          : { a: '#ffe9e4', b: '#ff5a44', c: '#a01000', lamp: '#ff5a44' };
    const lit = go ? 3 : 4 - n;

    // Lamps first in source order as well as on screen: the gantry is bolted
    // under the item slot and the numeral counts below it.
    this.dom.center.innerHTML = `
      <div class="hk-lamps">${[0, 1, 2].map((i) =>
        `<div class="hk-lamp${i < lit ? ' on' : ''}" style="--lamp:${tone.lamp}"></div>`).join('')}</div>
      <div class="hk-count" data-v="${go ? 'GO!' : n}">
        <div class="hk-count-ring" style="color:${tone.b}"></div>
        <span style="background-image:linear-gradient(178deg,${tone.a} 14%,${tone.b} 56%,${tone.c} 100%)">${go ? 'GO!' : n}</span>
      </div>`;
    this.el.classList.add('counting');   // hands the ITEM tag's line to the gantry

    const lamps = this.dom.center.firstElementChild;
    const num = this.dom.center.lastElementChild;
    const ring = num.firstElementChild;
    const anim = seq(num, go
      ? [{ transform: 'scale(.25)', opacity: 0, easing: EASE_BACK },
         { transform: 'scale(1.22)', opacity: 1, offset: .18, easing: 'ease-out' },
         { transform: 'scale(1)', opacity: 1, offset: .34 },
         { transform: 'scale(1.05)', opacity: 1, offset: .78, easing: 'ease-in' },
         { transform: 'scale(1.55)', opacity: 0 }]
      : [{ transform: 'scale(2.6)', opacity: 0, easing: EASE_OUT },
         { transform: 'scale(1)', opacity: 1, offset: .2 },
         { transform: 'scale(.97)', opacity: 1, offset: .74, easing: 'ease-in' },
         { transform: 'scale(.86)', opacity: 0 }],
      go ? 1050 : 900, { fill: 'forwards' });
    // Shockwave: reads as impact without touching the 3D layer.
    seq(ring, [{ opacity: .85, transform: 'scale(.35)' }, { opacity: 0, transform: 'scale(1.5)' }],
      go ? 700 : 520, { easing: 'ease-out' });
    for (let i = 0; i < lit; i++) {
      if (i === lit - 1 || go) this._pop(lamps.children[i], 1.5, 420);
    }

    // Deliberately no `anim.finished` cleanup: see the note on this method.
    // `update()` retires the banner off the race clock.
  }

  /** Retire the countdown banner on sim time rather than on the wall clock. */
  _retireCountdown(race) {
    if (this._countAt === undefined || !this.dom.center.firstElementChild) return;
    if ((race?.time ?? 0) - this._countAt <= this._countLife) return;
    this.dom.center.innerHTML = '';
    this.el.classList.remove('counting');
    this._countAt = undefined;
  }

  _showFinish(p, race) {
    const place = p.finishPlace || p.rank;
    const best = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
    const card = document.createElement('div');
    card.className = 'hk-finish';
    card.innerHTML = `
      <div class="hk-finish-hdr">Finish</div>
      <div class="hk-finish-place">
        <span class="hk-finish-num">${place}</span><span class="hk-finish-ord">${ordinal(place)}</span>
      </div>
      <div class="hk-finish-rule"></div>
      <div class="hk-finish-rows">
        <div class="hk-frow"><i>Total</i><b>${fmtTime(p.finishTime)}</b></div>
        <div class="hk-frow hi"><i>Best lap</i><b>${best != null ? fmtTime(best) : '--:--.---'}</b></div>
        <div class="hk-frow"><i>Coins</i><b>${p.coins}</b></div>
        <div class="hk-frow"><i>Field</i><b>${race.karts.length} karts</b></div>
      </div>`;
    this.el.appendChild(card);
    this._finishCard = card;

    seq(card, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.82)' },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }],
      520, { easing: EASE_BACK });
    // Staggered rows: the eye is led down the card instead of being handed a
    // wall of numbers at once.
    const rows = card.querySelectorAll('.hk-frow');
    rows.forEach((r, i) => seq(r,
      [{ opacity: 0, transform: 'translateX(-10%)' }, { opacity: 1, transform: 'translateX(0)' }],
      400, { delay: 380 + i * 110, easing: EASE_OUT, fill: 'backwards' },
    ));
    seq(card.querySelector('.hk-finish-num'),
      [{ transform: 'scale(2.1)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      640, { delay: 120, easing: EASE_BACK, fill: 'backwards' });
  }

  setVisible(v) { this.el.style.display = v ? '' : 'none'; }

  /**
   * Show or hide the controls card. Omit `v` to flip it.
   *
   * `onHelpToggle` is how the pre-race showing releases the grid: main holds
   * the simulation until the card is dismissed, so the card is also the click
   * the browser wants before it will let an AudioContext run.
   */
  toggleHelp(v) {
    this._helpOpen = v === undefined ? !this._helpOpen : !!v;
    this.el.classList.toggle('help-open', this._helpOpen);
    if (!this._helpOpen) {
      this.dom.help?.blur();
      this.el.classList.remove('help-start');
    }
    this.onHelpToggle?.(this._helpOpen);
  }

  /** Mark the next showing as the one that holds the countdown. */
  openHelpAsStart() {
    this.el.classList.add('help-start');
    this.toggleHelp(true);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onHelpKey);
    this.el.remove();
  }
}

export function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
