// Just enough of an element for ui/controls.js: listeners, pointer capture,
// a bounding rect, style custom properties, classList and dataset.

export class FakeEl {
  constructor(rect = { left: 0, top: 0, width: 100, height: 100 }) {
    this.rect = rect;
    this.listeners = new Map();
    this.captured = new Set();
    this.props = new Map();
    this.classes = new Set();
    this.dataset = {};
    this.style = { setProperty: (k, v) => this.props.set(k, String(v)), removeProperty: (k) => this.props.delete(k) };
    const classes = this.classes;
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
      contains: (c) => classes.has(c),
    };
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(fn);
  }

  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }

  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  hasPointerCapture(id) { return this.captured.has(id); }

  /** Fire a pointer event; x/y are client coordinates. */
  fire(type, pointerId, x = 0, y = 0, extra = {}) {
    const ev = { type, pointerId, clientX: x, clientY: y, pointerType: "touch", button: 0,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of this.listeners.get(type) || []) fn(ev);
    return ev;
  }
}

/** A manual clock with setTimeout, for the knob's double tap and the fader's still hold. */
export function fakeClock() {
  let t = 0;
  let timers = [];
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers = timers.filter((x) => x.id !== id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
}
