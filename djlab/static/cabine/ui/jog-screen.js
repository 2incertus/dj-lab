// A Cabine: the jog display (Cabine v2, Task V2), the screen in the centre of
// each jog like the DDJ-FLX6 / FLX10 jog screens, so the deck's numbers are
// on the deck and not on a laptop.
//
// new JogScreen(canvas)   canvas: a child of the jog's element (board.js), the
//   size of the jog's box, pointer-events: none, so every touch still goes to
//   the jog (its zones, scrub and bend are unchanged).
// screen.frame(deck, master, T) draws deck (engine/deck.js, or null) at
//   audio-clock time T (the strip's latency-compensated playheadTime, so what
//   he reads lines up with what he hears). It redraws only when what it shows
//   changed; the caller (app.js's one rAF loop) calls it at most 30 times a
//   second and never in portrait.
//
// What it shows, in the round screen over the top plate's centre:
//   top row      SYNC or MASTER (orange) and the analyzed key (Am, D#...)
//   line 1       the effective BPM, 2 decimals, the biggest text
//   line 2       tempo % (signed, 1 decimal) and the range (±6/±10/±16/W)
//   line 3       remaining time -m:ss (red in the last 30 s)
//   phase meter  4 cells: the deck's beat in its bar; with a sync master,
//                the master's beat is marked too (phaseCells)
//   bottom       the loop's length in beats, boxed, while a loop is active
// and around the top plate the position ring: the elapsed arc, light, red
// in the last RED_LAST_S seconds. The plate's own indicator line (board.js)
// still turns with the hand on it, outside the screen.
//
// If a size cannot hold everything, items are dropped from the end of
// PRIORITY (screenPlan), so the smallest jog keeps BPM, time and phase first.

import { barPhaseAt, beatPeriod } from "../engine/grid.js";

export const RED_LAST_S = 30;
/** The smallest text drawn, CSS px. */
export const MIN_PX = 7;
/** The screen's radius, and the ring's, as a share of the jog's radius (the
 *  top plate's edge is at 0.80). */
export const SCREEN_RATIO = 0.66;
export const RING_RATIO = 0.835;
/** What stays when room runs out: kept in this order, dropped from the end. */
export const PRIORITY = ["bpm", "time", "phase", "tempo", "tag", "key", "loop"];
/** Same beat of the bar within this much of a beat reads as in phase. */
export const PHASE_TOLERANCE = 0.05;

const RANGE_WIDE = 100;
const HALF_CAP = 0.36;                    // half the cap / digit height, in em

const COL = {
  disc: "#060708", discEdge: "#4a4a4f", text: "#f2f2f3", dim: "#9a9aa1", faint: "#55555b",
  on: "#ff9d3c", red: "#ff4d3d", key: "#8fc6ff", ring: "rgba(255,255,255,0.13)", arc: "#e9e9ec",
  cellOff: "#2a2a30", cellRef: "#7a7a82", cellOwn: "#e9e9ec",
};
export const FONT = (px, w = 600) => `${w} ${px.toFixed(2)}px Archivo, system-ui, -apple-system, sans-serif`;

// ---- pure helpers (unit-tested) ------------------------------------------------------

export function formatBpm(bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(2) : "---.--";
}

export function formatTempo(pct) {
  const v = Math.round((Number(pct) || 0) * 10) / 10;
  if (v === 0) return "0.0%";
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}%`;
}

export function formatRange(range) {
  return range >= RANGE_WIDE ? "W" : `±${range}`;
}

export function formatRemaining(s) {
  if (!Number.isFinite(s)) return "--:--";
  const t = Math.max(0, Math.round(s));
  return `-${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** "A min" -> "Am", "D# maj" -> "D#"; no key: the Camelot code. */
export function keyShort(meta) {
  if (!meta) return "";
  const k = String(meta.key || "").trim();
  if (!k) return meta.camelot ? String(meta.camelot) : "";
  const m = /^([A-G][#b]?)\s*(maj|min|major|minor)$/i.exec(k);
  if (!m) return k;
  return /^min/i.test(m[2]) ? `${m[1]}m` : m[1];
}

/** The active loop's length in beats ("4", "1/2", "1.4"), "" with no loop. */
export function loopLabel(L, grid) {
  if (!L || !L.active) return "";
  let beats = L.beats;
  if (!(beats > 0)) {
    if (!grid || !(grid.bpm > 0) || !(L.out > L.in)) return "LOOP";
    beats = (L.out - L.in) / beatPeriod(grid);
  }
  if (beats < 1) {
    const inv = Math.round(1 / beats);
    if (Math.abs(1 / inv - beats) < 1e-3) return `1/${inv}`;
  }
  const r = Math.round(beats * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** The 4-cell phase meter. own, master: bar phases in beats [0, 4) or null.
 *  cells: "off" | "own" (this deck's beat) | "ref" (the master's) | "both";
 *  aligned: null with no master, else whether the signed drift from the
 *  master (modulo the bar, in [-2, 2) beats) is under PHASE_TOLERANCE. In
 *  phase, the master's cell lights as both (two decks a hundredth of a beat
 *  either side of a beat line are in phase, not a beat apart); out of phase,
 *  this deck lights Math.round(drift) beats from the master's cell. */
export function phaseCells(own, master) {
  const cells = ["off", "off", "off", "off"];
  if (own === null || own === undefined || !Number.isFinite(own)) return { cells, aligned: null };
  const o = Math.min(3, Math.max(0, Math.floor(((own % 4) + 4) % 4)));
  if (master === null || master === undefined || !Number.isFinite(master)) {
    cells[o] = "own";
    return { cells, aligned: null };
  }
  const m = Math.min(3, Math.max(0, Math.floor(((master % 4) + 4) % 4)));
  const drift = ((((own - master) % 4) + 6) % 4) - 2;
  if (Math.abs(drift) < PHASE_TOLERANCE) {
    cells[m] = "both";
    return { cells, aligned: true };
  }
  const k = (((m + Math.round(drift)) % 4) + 4) % 4;
  if (k === m) {
    cells[m] = "both";                               // the same beat, drifting
  } else {
    cells[m] = "ref";
    cells[k] = "own";
  }
  return { cells, aligned: false };
}

/** The position ring: elapsed share of the track, red in the last RED_LAST_S. */
export function ringState(pos, dur) {
  if (!Number.isFinite(dur) || !(dur > 0)) return { frac: 0, red: false };
  const p = Math.min(dur, Math.max(0, pos));
  return { frac: p / dur, red: dur - p <= RED_LAST_S };
}

const reliableGrid = (d) => (d && d.grid && d.grid.bpm > 0 && !d.state.noGrid ? d.grid : null);

/** Everything the screen shows for deck d at audio time T, as text; null for
 *  an empty deck. master: the sync master (engine/rig.js masterDeck) or null. */
export function readout(d, master, T) {
  if (!d || !d.state || !d.state.loaded) return null;
  const st = d.state;
  const pos = d.posAt(T);
  const dur = d.duration;
  const g = reliableGrid(d);
  const own = g ? barPhaseAt(g, pos) : null;
  const mg = master && master !== d && master.state && master.state.loaded ? reliableGrid(master) : null;
  const ref = own !== null && mg ? barPhaseAt(mg, master.posAt(T)) : null;
  const ring = ringState(pos, dur);
  const meta = (d.track && d.track.meta) || {};
  return {
    bpm: formatBpm(d.effectiveBpm()),
    tempo: formatTempo(st.tempoPct),
    range: formatRange(st.range),
    // remaining time and the red ring are in track seconds, not tempo-adjusted
    // wall time (the CDJ convention, ruling R7-v2)
    time: formatRemaining(Number.isFinite(dur) ? dur - pos : NaN),
    red: ring.red,
    frac: ring.frac,
    key: keyShort(meta),
    tag: master === d ? "MASTER" : st.syncOn ? "SYNC" : "",
    phase: phaseCells(own, ref),
    loop: loopLabel(st.loop, g),
  };
}

// ---- layout ------------------------------------------------------------------------------

/** The rows, in units of the screen's radius: y of the row's centre, font
 *  size f, and what the widest text could be (the plan reserves for it). */
const ROWS = [
  { row: "top", y: -0.60, items: [{ id: "tag", f: 0.20, w: 700, tpl: "MASTER" }, { id: "key", f: 0.20, tpl: "G#m" }] },
  { row: "bpm", y: -0.27, items: [{ id: "bpm", f: 0.44, w: 700, tpl: "000.00" }] },
  { row: "tempo", y: 0.06, items: [{ id: "tempo", f: 0.22, tpl: "+00.0% ±16" }] },
  { row: "time", y: 0.35, items: [{ id: "time", f: 0.34, w: 700, tpl: "-00:00" }] },
  { row: "phase", y: 0.62, h: 0.09, wr: 1.0 },
  { row: "loop", y: 0.83, items: [{ id: "loop", f: 0.19, w: 700, tpl: "1/16", box: true }] },
];
const GAP_EM = 0.35;
const BOX_PAD_EM = 0.35;

/** Where everything goes on a jog D CSS px across. measure(text, px, weight)
 *  gives a text's width (canvas measureText; tests pass an estimate).
 *  -> {D, R, r, ring, items: [{id, row, x, y, px, w, weight, box}],
 *      phase: {x, y, w, h} | null, shown: Set} (x, y from the jog's centre). */
export function screenPlan(D, measure) {
  const R = D / 2;
  const r = SCREEN_RATIO * R;
  const chord = (yc, half) => {
    const yFar = Math.max(Math.abs(yc - half), Math.abs(yc + half));
    return yFar >= r ? 0 : 2 * Math.sqrt(r * r - yFar * yFar);
  };
  const spec = new Map();
  for (const row of ROWS) {
    if (!row.items) { spec.set("phase", row); continue; }
    for (const it of row.items) spec.set(it.id, { ...it, row });
  }
  const shown = new Set();
  const widthOf = (it) => {
    const px = it.f * r;
    return measure(it.tpl, px, it.weight || it.w || 600) + (it.box ? 2 * BOX_PAD_EM * px : 0);
  };
  let dropping = false;
  for (const id of PRIORITY) {
    if (dropping) break;
    const s = spec.get(id);
    let ok;
    if (id === "phase") {
      const h = Math.max(3, s.h * r);
      ok = s.wr * r <= chord(s.y * r, h / 2) - 2;
    } else {
      const px = s.f * r;
      const mates = s.row.items.filter((it) => it.id === id || shown.has(it.id));
      const total = mates.reduce((a, it) => a + widthOf(it), 0) + (mates.length - 1) * GAP_EM * px;
      const half = Math.max(...mates.map((it) => it.f * r)) * HALF_CAP;
      ok = px >= MIN_PX && total <= chord(s.row.y * r, half) - 2;
    }
    if (ok) shown.add(id);
    else dropping = true;
  }
  const items = [];
  for (const row of ROWS) {
    if (!row.items) continue;
    const vis = row.items.filter((it) => shown.has(it.id));
    if (!vis.length) continue;
    const ws = vis.map(widthOf);
    const total = ws.reduce((a, b) => a + b, 0) + (vis.length - 1) * GAP_EM * vis[0].f * r;
    let x = -total / 2;
    vis.forEach((it, k) => {
      items.push({ id: it.id, row: row.row, x: x + ws[k] / 2, y: row.y * r, px: it.f * r, w: ws[k],
        weight: it.w || 600, box: !!it.box });
      x += ws[k] + GAP_EM * it.f * r;
    });
  }
  const ph = spec.get("phase");
  const phase = shown.has("phase") ? { x: -ph.wr * r / 2, y: ph.y * r - Math.max(3, ph.h * r) / 2,
    w: ph.wr * r, h: Math.max(3, ph.h * r) } : null;
  return { D, R, r, ring: RING_RATIO * R, items, phase, shown };
}

// ---- the screen ----------------------------------------------------------------------------

export class JogScreen {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.plan = null;
    this.dpr = 1;
    this._key = null;
    this.last = null;
    /** Counters (tests): frames asked for, frames drawn. */
    this.stats = { frames: 0, draws: 0 };
    this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro && canvas.parentElement) this._ro.observe(canvas.parentElement);
    // the web font changes every width: plan again once it is in
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.resize(true)).catch(() => {});
    }
    this.resize();
  }

  resize(force = false) {
    const el = this.canvas.parentElement;
    if (!el) return;
    const rc = el.getBoundingClientRect();
    if (rc.width < 1 || rc.height < 1) return;          // hidden (portrait): keep the last plan
    const D = Math.round(Math.min(rc.width, rc.height) * 100) / 100;
    const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    if (!force && this.plan && this.plan.D === D && this.dpr === dpr) return;
    this.dpr = dpr;
    const bw = Math.round(D * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bw) {
      // WebKit can keep showing a drawn canvas's old layer at one backing
      // pixel per CSS pixel after its backing store is resized (seen in
      // Playwright's WebKit: the screen drawn three times too big). A fresh
      // canvas has no old layer.
      if (this._drawnOn && this.canvas.replaceWith) {
        const fresh = this.canvas.cloneNode(false);
        this.canvas.replaceWith(fresh);
        this.canvas = fresh;
        this.g = fresh.getContext("2d");
        this._drawnOn = false;
      }
      this.canvas.width = bw;
      this.canvas.height = bw;
    }
    const g = this.g;
    this.plan = screenPlan(D, (t, px, w) => { g.font = FONT(px, w); return g.measureText(t).width; });
    this._key = null;
  }

  /** Draw deck d (or null: empty) if what it shows changed. Returns true if it drew. */
  frame(d, master, T) {
    this.stats.frames++;
    const p = this.plan;
    if (!p) return false;
    const ro = readout(d, master, T);
    // the arc moves in steps of a CSS pixel along the ring (about one redraw
    // a second on a six-minute track)
    const steps = Math.max(1, Math.round(2 * Math.PI * p.ring));
    const key = ro ? [ro.bpm, ro.tempo, ro.range, ro.time, ro.red, ro.key, ro.tag, ro.loop,
      ro.phase.cells.join(""), ro.phase.aligned, Math.round(ro.frac * steps)].join("|") : "empty";
    if (key === this._key) return false;
    this._key = key;
    /** What is on the screen now (tests, and a look on the phone). */
    this.last = ro;
    this.stats.draws++;
    this._drawnOn = true;
    this._draw(ro);
    return true;
  }

  /** Drawn in backing-store pixels with the identity transform: Playwright's
   *  WebKit (Linux) applies a scaling transform twice on the first draw after
   *  the canvas sat idle (the screen came out three times too big); with no
   *  transform it draws right, and it costs nothing elsewhere. */
  _draw(ro) {
    const g = this.g, p = this.plan, k = this.dpr, c = (p.D / 2) * k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // the position ring, just outside the top plate
    const ring = p.ring * k;
    g.lineCap = "butt";
    g.lineWidth = Math.max(1.5, p.R * 0.03) * k;
    g.strokeStyle = COL.ring;
    g.beginPath();
    g.arc(c, c, ring, 0, 2 * Math.PI);
    g.stroke();
    if (ro && ro.frac > 0) {
      g.strokeStyle = ro.red ? COL.red : COL.arc;
      g.beginPath();
      g.arc(c, c, ring, -Math.PI / 2, -Math.PI / 2 + ro.frac * 2 * Math.PI);
      g.stroke();
    }
    // the screen
    const r = p.r * k;
    const grad = g.createRadialGradient(c, c - r * 0.3, r * 0.1, c, c, r);
    grad.addColorStop(0, "#14161a");
    grad.addColorStop(1, COL.disc);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(c, c, r, 0, 2 * Math.PI);
    g.fill();
    g.lineWidth = k;
    g.strokeStyle = COL.discEdge;
    g.stroke();
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    const base = (it) => c + (it.y + it.px * HALF_CAP) * k;
    const text = (it, s, colour) => {
      g.font = FONT(it.px * k, it.weight);
      g.fillStyle = colour;
      g.fillText(s, c + it.x * k, base(it));
    };
    if (!ro) {
      const bpm = p.items.find((it) => it.id === "bpm");
      if (bpm) text(bpm, "---.--", COL.faint);
      return;
    }
    // a row with one item missing (no tag) centres what is left
    const rowItems = (row) => p.items.filter((it) => it.row === row);
    const top = rowItems("top").filter((it) => (it.id === "tag" ? ro.tag : ro.key));
    for (const it of top) {
      const at = top.length === 1 ? { ...it, x: 0 } : it;
      text(at, it.id === "tag" ? ro.tag : ro.key, it.id === "tag" ? COL.on : COL.key);
    }
    for (const it of p.items) {
      if (it.id === "bpm") text(it, ro.bpm, COL.text);
      else if (it.id === "tempo") {
        g.font = FONT(it.px * k, it.weight);
        const a = ro.tempo, b = ` ${ro.range}`;
        const wa = g.measureText(a).width, wb = g.measureText(b).width;
        const x0 = c + it.x * k - (wa + wb) / 2;
        g.textAlign = "left";
        g.fillStyle = COL.text;
        g.fillText(a, x0, base(it));
        g.fillStyle = COL.dim;
        g.fillText(b, x0 + wa, base(it));
        g.textAlign = "center";
      } else if (it.id === "time") text(it, ro.time, ro.red ? COL.red : COL.text);
      else if (it.id === "loop" && ro.loop) {
        g.font = FONT(it.px * k, it.weight);
        const w = g.measureText(ro.loop).width + 2 * BOX_PAD_EM * it.px * k;
        const h = it.px * 1.25 * k;
        g.strokeStyle = COL.on;
        g.lineWidth = k;
        g.strokeRect(c + it.x * k - w / 2, c + it.y * k - h / 2, w, h);
        text(it, ro.loop, COL.on);
      }
    }
    if (p.phase) {
      const x = p.phase.x * k, y = p.phase.y * k, w = p.phase.w * k, h = p.phase.h * k;
      const gap = Math.max(k, w * 0.04);
      const cw = (w - 3 * gap) / 4;
      ro.phase.cells.forEach((s, n) => {
        const lit = s === "own" || s === "both";
        g.fillStyle = s === "ref" ? COL.cellRef
          : !lit ? COL.cellOff
            : ro.phase.aligned === false ? COL.on : COL.cellOwn;
        g.fillRect(Math.round(c + x + n * (cw + gap)), Math.round(c + y), Math.round(cw), Math.round(h));
      });
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}
