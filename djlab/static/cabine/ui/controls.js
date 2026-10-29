// A Cabine: touch widgets for the board. Each is new X(el, spec, onChange, env)
// on an element board.js has already drawn; a widget only reads pointer
// events and sets CSS custom properties / classes on its element.
//
// One pointer per widget: the first touch on a widget owns it (and captures
// it with setPointerCapture) until it lifts; other touches on the same widget
// are ignored. Widgets are independent, so two thumbs on two widgets, or a
// held SHIFT plus anything, work at once. pointercancel (and a lost capture)
// is a release. A finger that slides off keeps driving the widget it started on.
//
// env = {now(), setTimeout, clearTimeout} (tests pass a fake clock), and
// routed: an element (the board's section). A routed widget does not listen on
// its own (drawn) element: a TouchRouter on that element hands it the touches
// that land in its hit zone, and the pointer is captured there. After the
// press everything is the same as a touch on the drawn part.

/** Knob: vertical drag, this many px for the whole sweep (SHIFT does not change it). */
export const KNOB_SWEEP_PX = 180;
/** Two taps closer than this (and within DOUBLE_TAP_SLOP_PX) = back to default. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** EQ / CFX center detent: values this close to center read as center. */
export const KNOB_DETENT = 0.025;
/** BROWSE: drag distance per step. */
export const ENCODER_STEP_PX = 22;
/** A touch that moves less than this and lifts quickly is a tap. */
export const TAP_SLOP_PX = 8;
export const TAP_MAX_MS = 450;
/** Tempo fader fine mode: hold still this long, then drag distance is scaled
 *  down by fineScale(travel): at least 1:8 (TEMPO_FINE_SCALE), more on a short
 *  fader, so one pixel never moves the tempo more than TEMPO_FINE_STEP at the
 *  finest range (+-6 %, a span of TEMPO_FINE_SPAN). The spec asks for 0.02 %
 *  steps at +-6 %; the board's tempo track is only ~70 px on the iPhone. */
export const TEMPO_FINE_HOLD_MS = 300;
export const TEMPO_FINE_SCALE = 8;
export const TEMPO_FINE_SPAN = 0.12;
export const TEMPO_FINE_STEP = 0.0002;
export const STILL_SLOP_PX = 3;
/** Jog: the inner 80 % of the radius is the top plate, the rest the outer
 *  ring, as on the FLX4 (ruling R24; the figure's plate edge is at 0.79 to
 *  0.83 R, the grooved ring outside it). */
export const JOG_TOP_PLATE_RATIO = 0.80;
/** The hub: inside this share of the radius a turn has no usable angle (a
 *  finger crossing the center would flip it 180 degrees), so moves there are
 *  dropped and the angle re-anchors on the way out. */
export const JOG_HUB_RATIO = 0.18;
/** No single move turns the jog more than this (a jump between events). */
export const JOG_MAX_STEP_DEG = 90;
/** Outer ring bend gain. The hardware jog is 118 mm across; the phone's drawn
 *  wheel is about 35 mm (smaller still on the 844 x 390 board: ~26 mm). The
 *  deck bends by angular speed (deck.js BEND_PER_TURN_PER_S), and the same
 *  thumb speed along a rim 118 / 35 = 3.4 times smaller sweeps 3.4 times the
 *  angle, so a thumb arc would bend 3.4 times harder than the finger arc it
 *  stands for. Scaling the ring's angle by about 35 / 118 = 0.30 puts them
 *  level; 0.35 is the starting value (a little livelier), to be tuned on the
 *  phone. The top plate is NOT scaled: one drawn turn is one platter turn
 *  (deck.js SECONDS_PER_TURN = 1.8 s), what he sees spinning is what he hears. */
export const RING_BEND_GAIN = 0.35;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Fader value change for dPx of drag along a track of lengthPx, divided by
 *  scale (1 = coarse, fineScale(lengthPx) in fine mode). */
export function faderDelta(dPx, lengthPx, scale = 1) {
  if (!(lengthPx > 0)) return 0;
  return dPx / lengthPx / (scale > 0 ? scale : 1);
}

/** Fine-mode divisor for a tempo track of travelPx: 1:8 or finer, enough for
 *  TEMPO_FINE_STEP per pixel at +-6 %. */
export function fineScale(travelPx) {
  if (!(travelPx > 0)) return TEMPO_FINE_SCALE;
  return Math.max(TEMPO_FINE_SCALE, Math.ceil(TEMPO_FINE_SPAN / TEMPO_FINE_STEP / travelPx - 1e-9));
}

/** Smallest signed difference a1 - a0, in degrees, in (-180, 180]. */
export function angleDelta(a0, a1) {
  let d = (a1 - a0) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Which part of a wheel of radius R a touch at (dx, dy) from its center hits. */
export function jogZone(dx, dy, R) {
  const r = Math.hypot(dx, dy);
  if (r > R) return null;
  return r <= JOG_TOP_PLATE_RATIO * R ? "plate" : "ring";
}

const defaultEnv = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

class Control {
  constructor(el, spec, onChange, env) {
    this.el = el;
    this.spec = spec || {};
    this.onChange = onChange || (() => {});
    this.env = { ...defaultEnv, ...(env || {}) };
    this.pid = null;
    /** Where the pointer is captured: the drawn element, or the router's. */
    this.cap = this.env.routed || el;
    this._h = {
      pointerdown: (e) => this._down(e),
      pointermove: (e) => { if (e.pointerId === this.pid) this.move(e); },
      pointerup: (e) => this._up(e, false),
      pointercancel: (e) => this._up(e, true),
      lostpointercapture: (e) => this._up(e, true),
    };
    if (!this.env.routed) for (const [t, fn] of Object.entries(this._h)) el.addEventListener(t, fn);
  }

  _down(e) {
    if (e.preventDefault) e.preventDefault();
    if (this.pid !== null) return;                     // one pointer per widget
    this.pid = e.pointerId;
    try { this.cap.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    this.el.classList.add("cab-held");
    if (this.down(e) === false) this._end(e, true);
  }

  _up(e, cancelled) {
    if (e.pointerId !== this.pid) return;
    this._end(e, cancelled);
  }

  _end(e, cancelled) {
    const id = this.pid;
    this.pid = null;
    this.el.classList.remove("cab-held");
    try { if (this.cap.hasPointerCapture && this.cap.hasPointerCapture(id)) this.cap.releasePointerCapture(id); } catch { /* ok */ }
    this.up(e, cancelled);
  }

  /** Release whatever holds it (screen change, destroy). */
  release() {
    if (this.pid !== null) this._end({ pointerId: this.pid, clientX: 0, clientY: 0 }, true);
  }

  destroy() {
    this.release();
    if (!this.env.routed) for (const [t, fn] of Object.entries(this._h)) this.el.removeEventListener(t, fn);
  }

  down() {}
  move() {}
  up() {}
}

/** Rotary knob, 0..1, vertical drag (up = clockwise), double tap = spec.def. */
export class Knob extends Control {
  constructor(el, spec, onChange, env) {
    super(el, spec, onChange, env);
    this._raw = clamp01(spec.value ?? spec.def ?? 0);
    this._lastTap = null;
    this._show(this.value);
  }

  get value() {
    return this.spec.detent && Math.abs(this._raw - 0.5) < KNOB_DETENT ? 0.5 : this._raw;
  }

  set(v) {
    this._raw = clamp01(v);
    this._show(this.value);
  }

  _show(v) {
    this.el.style.setProperty("--v", v.toFixed(4));
  }

  down(e) {
    const t = this.env.now();
    const last = this._lastTap;
    this._start = { y: e.clientY, x: e.clientX, raw: this._raw };
    if (last && t - last.t <= DOUBLE_TAP_MS
        && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DOUBLE_TAP_SLOP_PX) {
      this._lastTap = null;
      this._reset = true;
      this._emit(clamp01(this.spec.def ?? 0.5));
      return;
    }
    this._reset = false;
    this._lastTap = { t, x: e.clientX, y: e.clientY };
  }

  move(e) {
    if (this._reset) return;
    const s = this._start;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > DOUBLE_TAP_SLOP_PX) this._lastTap = null;
    this._emit(clamp01(s.raw + (s.y - e.clientY) / KNOB_SWEEP_PX));
  }

  _emit(raw) {
    const before = this.value;
    this._raw = raw;
    const v = this.value;
    this._show(v);
    if (v !== before) this.onChange(v);
  }
}

/** Endless rotary with a push (BROWSE): {turn: steps} while dragged
 *  (drag up = clockwise = +1, as a knob), {press: true} on a tap. */
export class Encoder extends Control {
  down(e) {
    this._start = { x: e.clientX, y: e.clientY, t: this.env.now() };
    this._acc = 0;
    this._moved = false;
    this._lastY = e.clientY;
  }

  move(e) {
    const s = this._start;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP_PX) this._moved = true;
    this._acc += this._lastY - e.clientY;
    this._lastY = e.clientY;
    const steps = Math.trunc(this._acc / ENCODER_STEP_PX);
    if (steps) {
      this._acc -= steps * ENCODER_STEP_PX;
      this.onChange({ turn: steps });
    }
  }

  up(e, cancelled) {
    if (cancelled || this._moved) return;
    const s = this._start;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) <= TAP_SLOP_PX && this.env.now() - s.t <= TAP_MAX_MS) {
      this.onChange({ press: true });
    }
  }
}

/** Linear fader, relative drag over the full drawn travel (the box minus the cap).
 *  spec.dir: "down" (0 at the top: TEMPO), "up" (1 at the top: channel faders),
 *  "right" (0 at the left: crossfader). spec.tempo: fine mode after a still hold. */
export class Fader extends Control {
  constructor(el, spec, onChange, env) {
    super(el, spec, onChange, env);
    this.value = clamp01(spec.value ?? spec.def ?? 0);
    this._fine = false;
    this._timer = null;
    this._show();
  }

  get horizontal() {
    return this.spec.dir === "right";
  }

  /** The cap's share of the box {w, h} (0..1), when the layout drew the box
   *  in other proportions than the photo's (the phone layout's tempo). */
  setCap(ratio) {
    this.capRatio = ratio || null;
  }

  /** Travel in px: the element's length minus the cap's (both drawn). */
  travelPx() {
    const r = this.el.getBoundingClientRect();
    const s = this.spec, k = this.capRatio;
    if (this.horizontal) return r.width * (1 - (k ? k.w : s.cap && s.w ? s.cap.w / s.w : 0));
    return r.height * (1 - (k ? k.h : s.cap && s.h ? s.cap.h / s.h : 0));
  }

  set(v) {
    this.value = clamp01(v);
    this._show();
  }

  _show() {
    // --p: the cap's position along the travel, 0 = top / left
    const p = this.spec.dir === "up" ? 1 - this.value : this.value;
    this.el.style.setProperty("--p", p.toFixed(4));
  }

  _pos(e) {
    return this.horizontal ? e.clientX : e.clientY;
  }

  down(e) {
    this._last = this._pos(e);
    this._len = this.travelPx();
    this._stillAt = this._last;
    this._arm();
  }

  _arm() {
    if (!this.spec.tempo || this._fine) return;
    if (this._timer !== null) this.env.clearTimeout(this._timer);
    this._timer = this.env.setTimeout(() => {
      this._timer = null;
      this._fine = true;
      this.el.classList.add("cab-fine");
    }, TEMPO_FINE_HOLD_MS);
  }

  move(e) {
    const p = this._pos(e);
    if (Math.abs(p - this._stillAt) > STILL_SLOP_PX) {
      this._stillAt = p;
      this._arm();
    }
    const d = p - this._last;
    this._last = p;
    const sign = this.spec.dir === "up" ? -1 : 1;
    const v = clamp01(this.value + sign * faderDelta(d, this._len, this._fine ? fineScale(this._len) : 1));
    if (v !== this.value) {
      this.value = v;
      this._show();
      this.onChange(v);
    }
  }

  up() {
    if (this._timer !== null) this.env.clearTimeout(this._timer);
    this._timer = null;
    this._fine = false;
    this.el.classList.remove("cab-fine");
  }
}

/** The crossfader: a horizontal Fader, 0 = left. */
export class XFader extends Fader {
  constructor(el, spec, onChange, env) {
    super(el, { ...spec, dir: "right", tempo: false }, onChange, env);
  }
}

/** Button: onChange(true) on press, onChange(false) on release. */
export class Button extends Control {
  down() {
    this.onChange(true);
  }

  up() {
    this.onChange(false);
  }
}

/** Performance pad: fires on press (velocity is not read). */
export class Pad extends Button {}

/** CH SELECT lever: a tap moves it to the next position (1 > 2 > 1&2 > 1). */
export class Lever extends Control {
  constructor(el, spec, onChange, env) {
    super(el, spec, onChange, env);
    this.index = spec.def || 0;
    this._show();
  }

  set(i) {
    this.index = i;
    this._show();
  }

  _show() {
    this.el.style.setProperty("--i", String(this.index));
    this.el.dataset.pos = String(this.index);
  }

  down() {
    this.index = (this.index + 1) % this.spec.positions.length;
    this._show();
    this.onChange(this.index);
  }
}

/** Jog wheel. Top plate (inner 80 %): {touch: true}, {turn: deg} per move,
 *  {touch: false}. Outer ring: {ring: deg * RING_BEND_GAIN}. Clockwise > 0. */
export class Jog extends Control {
  constructor(el, spec, onChange, env) {
    super(el, spec, onChange, env);
    this._spin = 0;
  }

  down(e) {
    const r = this.el.getBoundingClientRect();
    this._c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const zone = jogZone(e.clientX - this._c.x, e.clientY - this._c.y, r.width / 2);
    if (!zone) return false;                           // the box's corner, not the wheel
    this._zone = zone;
    this._R = r.width / 2;
    this._a = this._inHub(e) ? null : this._angle(e);
    this.el.dataset.zone = zone;
    if (zone === "plate") this.onChange({ touch: true });
    return true;
  }

  _angle(e) {
    return (Math.atan2(e.clientY - this._c.y, e.clientX - this._c.x) * 180) / Math.PI;
  }

  _inHub(e) {
    return Math.hypot(e.clientX - this._c.x, e.clientY - this._c.y) < JOG_HUB_RATIO * this._R;
  }

  move(e) {
    if (this._inHub(e)) { this._a = null; return; }      // no usable angle at the hub
    const a = this._angle(e);
    if (this._a === null) { this._a = a; return; }       // back out of the hub: re-anchor, no turn
    const raw = angleDelta(this._a, a);
    this._a = a;
    const d = Math.max(-JOG_MAX_STEP_DEG, Math.min(JOG_MAX_STEP_DEG, raw));
    if (!d) return;
    if (this._zone === "plate") {
      this._spin = (this._spin + d) % 360;
      this.el.style.setProperty("--spin", `${this._spin.toFixed(2)}deg`);
      this.onChange({ turn: d });
    } else {
      this.onChange({ ring: d * RING_BEND_GAIN });
    }
  }

  up() {
    delete this.el.dataset.zone;
    if (this._zone === "plate") this.onChange({ touch: false });
    this._zone = null;
  }
}

/** Hands touches on `el` (a board section) to routed widgets: resolve(e) says
 *  whose hit zone the touch is in (or null). The pointer stays that widget's,
 *  captured on `el`, until it lifts, is cancelled or loses its capture; a
 *  widget already held ignores a second finger, as on its own element. */
export class TouchRouter {
  constructor(el, resolve) {
    this.el = el;
    this.owners = new Map();                           // pointerId -> widget
    const end = (cancelled) => (e) => {
      const w = this.owners.get(e.pointerId);
      if (!w) return;
      this.owners.delete(e.pointerId);
      w._up(e, cancelled);
    };
    this._h = {
      pointerdown: (e) => {
        if (e.target !== undefined && e.target !== el) return;    // a big part's own element
        if (e.preventDefault) e.preventDefault();
        const w = resolve(e);
        if (!w || w.pid !== null) return;
        this.owners.set(e.pointerId, w);
        w._down(e);
        if (w.pid !== e.pointerId) this.owners.delete(e.pointerId);
      },
      pointermove: (e) => {
        const w = this.owners.get(e.pointerId);
        if (w && w.pid === e.pointerId) w.move(e);
      },
      pointerup: end(false),
      pointercancel: end(true),
      lostpointercapture: end(true),
    };
    for (const [t, fn] of Object.entries(this._h)) el.addEventListener(t, fn);
  }

  destroy() {
    for (const w of this.owners.values()) w.release();
    this.owners.clear();
    for (const [t, fn] of Object.entries(this._h)) this.el.removeEventListener(t, fn);
  }
}
