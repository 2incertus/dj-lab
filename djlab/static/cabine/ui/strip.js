// A Cabine: the waveform strip, the "laptop screen" above the board (spec
// section 5, "Waveform strip").
//
// new Strip(canvas, {decks, store, ctx, mixer, fx, reserveLeft, watch})
//   Two lanes, deck 1 on top. Each lane: a text row (artist - title | BPM
//   with tempo applied | the analyzed key, never tempo-shifted | -mm:ss |
//   SYNC, MASTER on the sync master) with a thin whole-track overview at its
//   right, and under it the scrolling waveform from the carried peaks
//   (100 per second) with the playhead in the middle, beat ticks and bar lines
//   from the grid, hot cue markers in the pad colours and the loop region
//   tinted. At the right: the Beat FX name, fraction and ON state, the two
//   channel meters with peak hold, and REC (app.js wires it to
//   engine/recorder.js: setRec(on, seconds) lights it red with mm:ss,
//   onRec(cb) gets the taps).
//
// Read-only (anti-goal): nothing on the waveform answers a touch. The only
// interactive things on the strip are the board's "caixa" button, REC, and
// the browse list's finger scroll.
//
// Latency: the playhead (and everything drawn around it) is at
// deck.posAt(ctx.currentTime - outputLatency - baseLatency), so on
// Bluetooth (150 to 250 ms) what he sees lines up with what he hears.
//
// Cost: peaks are drawn once per load into offscreen tiles (TILE_PX columns
// each); a frame only blits the visible part. frame(now) redraws at most
// FPS_MAX times a second and only the regions whose content changed. The
// caller owns the requestAnimationFrame loop (one loop for strip, lights and
// meters, app.js).
//
// Browse (BROWSE + LOAD): openBrowse() drops the carried-track list over the
// lanes, browseMove(steps) moves the highlight, highlighted() is the file
// LOAD loads, closeBrowse() hides it. The list also scrolls with a finger.

import { beatIndexAt, timeOfBeat, barPhaseAt } from "../engine/grid.js";
import { masterDeck } from "../engine/rig.js";
import { HOT_CUE_COLOURS } from "../flx4-map.js";
import { FX_FRACTIONS, FX_FRACTION_LABELS } from "../engine/fx.js";

export const WINDOW_S = 10;              // seconds of track across a lane
export const FPS_MAX = 30;
export const TILE_PX = 2048;             // columns per offscreen tile
export const METER_HOLD_S = 1.5;
export const METER_DECAY_DB_S = 20;
export const METER_FLOOR_DB = -48;
export const FLASH_MS = 1200;
const PANEL_W = 96;                      // Beat FX + meters
const REC_W = 40;
const GAP = 6;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- pure helpers (unit-tested) ----------------------------------------------------

/** REC's label: "REC" idle, the elapsed "mm:ss" while recording. */
export function recLabel(on, seconds) {
  if (!on) return "REC";
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The server's peaks file: "PK01" | uint32 LE rate | uint32 LE n | n x uint8. */
export function parsePeaks(buf) {
  if (!buf || buf.byteLength < 12) return null;
  const b = new Uint8Array(buf);
  if (b[0] !== 0x50 || b[1] !== 0x4b || b[2] !== 0x30 || b[3] !== 0x31) return null;
  const dv = new DataView(buf);
  const rate = dv.getUint32(4, true);
  const n = Math.min(dv.getUint32(8, true), b.length - 12);
  return rate > 0 ? { rate, values: b.subarray(12, 12 + n) } : null;
}

/** Max peak per column at pps columns per second, over duration seconds. */
export function peakColumns(peaks, pps, duration) {
  const n = Math.max(0, Math.ceil(duration * pps));
  const out = new Uint8Array(n);
  if (!peaks) return out;
  const v = peaks.values, r = peaks.rate;
  for (let x = 0; x < n; x++) {
    const a = Math.floor((x * r) / pps + 1e-9);
    const b = Math.max(a + 1, Math.floor(((x + 1) * r) / pps + 1e-9));
    let m = 0;
    for (let i = a; i < b && i < v.length; i++) if (v[i] > m) m = v[i];
    out[x] = m;
  }
  return out;
}

export function formatTime(s) {
  if (!Number.isFinite(s)) return "--:--";
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** The deck's text line as coloured segments [{text, dim?, on?}]. */
export function deckLine({ meta, bpm, remaining, sync, master }) {
  const m = meta || {};
  const segs = [
    { text: m.title || m.file || "" },
    { text: ` | ${bpm ? bpm.toFixed(2) : "---"} | ${m.key || "-"} | -${formatTime(remaining)}`, dim: true },
  ];
  if (sync) segs.push({ text: " | ", dim: true }, { text: "SYNC", on: true });
  if (master) segs.push({ text: " | ", dim: true }, { text: "MASTER", on: true });
  return segs;
}

/** One meter step: the bar falls at METER_DECAY_DB_S, the peak holds
 *  METER_HOLD_S then falls at the same rate. m = {db, peak, held} or null. */
export function meterStep(m, levelDb, dt) {
  const lv = Math.max(METER_FLOOR_DB, Number.isFinite(levelDb) ? levelDb : METER_FLOOR_DB);
  if (!m) return { db: lv, peak: lv, held: 0 };
  const db = Math.max(lv, m.db - METER_DECAY_DB_S * dt, METER_FLOOR_DB);
  if (lv >= m.peak) return { db, peak: lv, held: 0 };
  const held = m.held + dt;
  const over = Math.max(0, held - METER_HOLD_S) - Math.max(0, m.held - METER_HOLD_S);
  const peak = Math.max(lv, m.peak - METER_DECAY_DB_S * over, METER_FLOOR_DB);
  return { db, peak, held };
}

/** dB to 0..1 of the meter's travel. */
export function meterFraction(db) {
  return clamp((db - METER_FLOOR_DB) / -METER_FLOOR_DB, 0, 1);
}

/** Grid beats in [t0, t1): [{t, bar}] (bar: beat 1 of a bar, from downbeat_s). */
export function beatMarks(g, t0, t1) {
  if (!g || !(g.bpm > 0)) return [];
  const out = [];
  for (let n = Math.ceil(beatIndexAt(g, t0) - 1e-9); ; n++) {
    const t = timeOfBeat(g, n);
    if (t >= t1) break;
    const ph = barPhaseAt(g, t);
    out.push({ t, bar: ph < 1e-6 || ph > 4 - 1e-6 });
    if (out.length > 512) break;
  }
  return out;
}

/** Audio-clock time of what he hears now (Bluetooth adds ~0.2 s). */
export function playheadTime(ctx) {
  return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
}

/** Where everything goes in a W x H strip (CSS px) with `left` px reserved
 *  for the caixa button. */
export function stripLayout(W, H, left = 0) {
  const recX = W - REC_W - 4;
  const panelX = recX - GAP - PANEL_W;
  const x0 = left;
  const laneW = Math.max(40, panelX - GAP - x0);
  const laneH = H / 2;
  const textH = clamp(Math.round(laneH * 0.42), 9, 13);
  const overW = clamp(Math.round(laneW * 0.22), 60, 180);
  const lanes = [0, 1].map((i) => {
    const y = i * laneH;
    return {
      y, h: laneH,
      text: { x: x0, y, w: laneW - overW - GAP, h: textH },
      over: { x: x0 + laneW - overW, y: y + 2, w: overW, h: Math.max(3, textH - 4) },
      wave: { x: x0, y: y + textH, w: laneW, h: laneH - textH - (i === 0 ? 1 : 0) },
    };
  });
  return {
    W, H, lanes,
    list: { x: x0, y: 0, w: laneW, h: H },
    panel: { x: panelX, y: 0, w: PANEL_W, h: H },
    rec: { x: recX, y: Math.max(0, (H - 28) / 2), w: REC_W, h: Math.min(28, H) },
    pps: laneW / WINDOW_S,
  };
}

// ---- the strip -------------------------------------------------------------------

const COL = {
  bg: "#060607", lane: "#0b0b0d", wave: "#4aa8ff", waveDim: "#2a5f93", text: "#e6e6e6", dim: "#8d8d92",
  on: "#ff9d3c", tick: "#ffffff55", bar: "#ffffffaa", playhead: "#ff4d3d", loop: "rgba(255,157,31,0.22)",
  meterLo: "#5fe05a", meterMid: "#ff9d3c", meterHi: "#ff4d3d", flash: "#ff9d3c",
};
const FONT = (px, w = 600) => `${w} ${px}px Archivo, system-ui, -apple-system, sans-serif`;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export class Strip {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d", { alpha: false });
    this.store = opts.store || null;
    this.reserveLeft = opts.reserveLeft || (() => 0);
    this.decks = opts.decks || [];
    this.ctx = opts.ctx || null;
    this.mixer = opts.mixer || null;
    this.fx = opts.fx || null;
    this.lanes = [0, 1].map(() => ({ info: null, tiles: [], over: null, loading: false, flash: null }));
    this.meters = [null, null];
    this.drawn = [null, null];
    /** Counters (tests, and a look on the phone): tile builds, frames drawn. */
    this.stats = { prerenders: 0, frames: 0 };
    this._keys = {};
    this._last = -Infinity;
    this._lastMeterT = null;
    this.tracks = [];
    this.hl = 0;
    this.browseOpen = false;

    const slot = canvas.parentElement;
    this.slot = slot;
    this.list = document.createElement("div");
    this.list.className = "cab-strip-browse";
    this.list.hidden = true;
    this.list.innerHTML = `<ol class="cab-strip-list"></ol>`;
    slot.appendChild(this.list);
    this.rec = document.createElement("button");
    this.rec.type = "button";
    this.rec.className = "cab-strip-rec";
    this.rec.textContent = "REC";
    this.rec.title = "Record the master";
    this.rec.setAttribute("aria-pressed", "false");
    this._recShown = "REC";
    this._recCb = null;
    this._onRec = (e) => { e.preventDefault(); if (this._recCb) this._recCb(); };
    this.rec.addEventListener("click", this._onRec);
    slot.appendChild(this.rec);

    // the list scrolls with a finger (the board cancels native scrolling)
    this._drag = null;
    this._onDown = (e) => {
      this._drag = { id: e.pointerId, y: e.clientY, top: this.list.scrollTop };
      try { this.list.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    };
    this._onMove = (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      this.list.scrollTop = this._drag.top - (e.clientY - this._drag.y);
    };
    this._onUp = (e) => { if (this._drag && e.pointerId === this._drag.id) this._drag = null; };
    this.list.addEventListener("pointerdown", this._onDown);
    this.list.addEventListener("pointermove", this._onMove);
    this.list.addEventListener("pointerup", this._onUp);
    this.list.addEventListener("pointercancel", this._onUp);

    this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) {
      this._ro.observe(slot);
      // elements whose size moves the layout (the caixa button: its width
      // changes when the web font arrives), so that lands now, not on the
      // next rotation
      for (const el of opts.watch || []) this._ro.observe(el);
    }
    this.resize();
    this.refreshTracks().catch(() => {});
  }

  /** The engine arrives on the first tap. */
  setEngine({ decks, ctx, mixer, fx }) {
    this.decks = decks || [];
    this.ctx = ctx || null;
    this.mixer = mixer || null;
    this.fx = fx || null;
    this._keys = {};
  }

  // ---- browse --------------------------------------------------------------------

  async refreshTracks() {
    if (!this.store) return this.tracks;
    const keep = this.highlighted();
    this.tracks = await this.store.listTracks();
    const i = this.tracks.findIndex((t) => t.file === keep);
    this.hl = i >= 0 ? i : clamp(this.hl, 0, Math.max(0, this.tracks.length - 1));
    this._renderList();
    return this.tracks;
  }

  get isBrowseOpen() { return this.browseOpen; }

  openBrowse() {
    this.browseOpen = true;
    this.list.hidden = false;
    this._renderList();
    this.refreshTracks().catch(() => {});
  }

  closeBrowse() {
    this.browseOpen = false;
    this.list.hidden = true;
    // redraw the whole canvas: WebKit otherwise keeps a stale picture of the
    // list over the parts of the canvas that did not change
    this._keys = {};
    this._full = true;
  }

  browseMove(delta) {
    if (!this.tracks.length) return;
    this.hl = clamp(this.hl + Math.trunc(Number(delta) || 0), 0, this.tracks.length - 1);
    this._showHl();
  }

  /** The highlighted track's file, or null when nothing is carried. */
  highlighted() {
    const t = this.tracks[this.hl];
    return t ? t.file : null;
  }

  _renderList() {
    const ol = this.list.firstElementChild;
    if (!this.tracks.length) {
      ol.innerHTML = `<li class="cab-strip-empty">No tracks on this phone yet. Carry some from the caixa.</li>`;
      return;
    }
    ol.innerHTML = this.tracks.map((t, i) => {
      const m = t.meta || {};
      const bpm = m.bpm ? Number(m.bpm).toFixed(1) : "---";
      return `<li class="cab-strip-row${i === this.hl ? " cab-hl" : ""}" data-file="${esc(t.file)}">`
        + `<span class="cab-strip-t">${esc(m.title || t.file)}</span>`
        + `<span class="cab-strip-m">${bpm}</span><span class="cab-strip-m">${esc(m.key || "-")}</span>`
        + `<span class="cab-strip-m">${formatTime(m.duration_s)}</span></li>`;
    }).join("");
    this._showHl();
  }

  _showHl() {
    const rows = this.list.querySelectorAll(".cab-strip-row");
    rows.forEach((r, i) => r.classList.toggle("cab-hl", i === this.hl));
    const r = rows[this.hl];
    if (!r || this.list.hidden) return;
    const top = r.offsetTop, bottom = top + r.offsetHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight;
  }

  // ---- tracks on the decks -------------------------------------------------------------

  /** Deck i (0 or 1) is decoding a track (text row says so). */
  setLoading(i, file) {
    const L = this.lanes[i];
    L.info = null;
    L.tiles = [];
    L.over = null;
    L.loading = file || true;
    this._keys = {};
  }

  /** Deck i now holds `track` ({meta, peaks: ArrayBuffer|null}); null = empty. */
  setTrack(i, track) {
    const L = this.lanes[i];
    L.loading = false;
    L.info = track ? { meta: track.meta || {}, peaks: parsePeaks(track.peaks) } : null;
    this._prerender(i);
    this._keys = {};
  }

  /** A short message on deck i's text row (refused load). */
  flash(i, text, now = performance.now()) {
    this.lanes[i].flash = { text, until: now + FLASH_MS };
    this._keys = {};
  }

  flashing(i, now = performance.now()) {
    const f = this.lanes[i].flash;
    return f && now < f.until ? f.text : null;
  }

  // ---- size ----------------------------------------------------------------------------

  resize() {
    const r = this.slot.getBoundingClientRect();
    // hidden (portrait: the strip is display:none): keep the last good layout
    // and tiles, so turning back costs nothing
    if (r.width < 1 || r.height < 1) return;
    const W = Math.round(r.width), H = Math.round(r.height);
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 3);
    if (this.L && this.L.W === W && this.L.H === H && this.dpr === dpr && this._reserved === this.reserveLeft()) return;
    this.dpr = dpr;
    this._reserved = this.reserveLeft();
    this.L = stripLayout(W, H, this._reserved);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    const { list, rec } = this.L;
    Object.assign(this.list.style, { left: `${list.x}px`, top: `${list.y}px`, width: `${list.w}px`, height: `${list.h}px` });
    Object.assign(this.rec.style, { left: `${rec.x}px`, top: `${rec.y}px`, width: `${rec.w}px`, height: `${rec.h}px` });
    this._prerender(0);
    this._prerender(1);
    this._keys = {};
    this._full = true;
  }

  /** Peaks into offscreen tiles (waveform) and the overview, once per load. */
  _prerender(i) {
    const Ln = this.lanes[i];
    Ln.tiles = [];
    Ln.over = null;
    if (!Ln.info || !Ln.info.peaks || !this.L) return;
    this.stats.prerenders++;
    const lane = this.L.lanes[i];
    const dpr = this.dpr;
    const dur = Ln.info.peaks.values.length / Ln.info.peaks.rate;
    const cols = peakColumns(Ln.info.peaks, this.L.pps, dur);
    const h = Math.max(1, Math.round(lane.wave.h * dpr));
    const mid = h / 2;
    for (let x0 = 0; x0 < cols.length; x0 += TILE_PX) {
      const w = Math.min(TILE_PX, cols.length - x0);
      const c = makeCanvas(w, h);
      const g = c.getContext("2d");
      g.fillStyle = COL.wave;
      for (let x = 0; x < w; x++) {
        const a = (cols[x0 + x] / 255) * (mid - 1);
        if (a > 0.25) g.fillRect(x, mid - a, 1, 2 * a);
      }
      g.fillStyle = COL.waveDim;
      g.fillRect(0, mid - 0.5, w, 1);
      Ln.tiles.push({ c, x0, w });
    }
    const ow = Math.max(1, Math.round(lane.over.w * dpr)), oh = Math.max(1, Math.round(lane.over.h * dpr));
    const ocols = peakColumns(Ln.info.peaks, ow / dur, dur);
    const oc = makeCanvas(ow, oh);
    const og = oc.getContext("2d");
    og.fillStyle = "#1a1a1d";
    og.fillRect(0, 0, ow, oh);
    og.fillStyle = COL.waveDim;
    for (let x = 0; x < ow; x++) {
      const a = (ocols[x] / 255) * oh;
      og.fillRect(x, oh - a, 1, a);
    }
    Ln.over = oc;
    Ln.dur = dur;
  }

  // ---- drawing ---------------------------------------------------------------------------

  /** Call from requestAnimationFrame. Returns true if it drew. The caller
   *  stops calling it while the board is hidden (portrait). */
  frame(now = performance.now()) {
    if (now - this._last < 1000 / FPS_MAX - 2) return false;
    this._last = now;
    if (!this.L) return false;
    this.stats.frames++;
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this._full) {
      g.fillStyle = COL.bg;
      g.fillRect(0, 0, this.L.W, this.L.H);
      this._full = false;
    }
    const T = this.ctx ? playheadTime(this.ctx) : 0;
    const master = masterDeck(this.decks);
    const dt = this._lastMeterT === null ? 0 : (now - this._lastMeterT) / 1000;
    this._lastMeterT = now;
    for (let i = 0; i < 2; i++) this._drawLane(i, T, now, master);
    this._drawPanel(now, dt);
    return true;
  }

  _deck(i) {
    const d = this.decks[i];
    return d && d.state && d.state.loaded ? d : null;
  }

  _dirty(key, value) {
    if (this._keys[key] === value) return false;
    this._keys[key] = value;
    return true;
  }

  _drawLane(i, T, now, master) {
    const g = this.g;
    const lane = this.L.lanes[i];
    const Ln = this.lanes[i];
    const d = this._deck(i);
    const pos = d ? d.posAt(T) : 0;
    const pps = this.L.pps;
    if (d) this.drawn[i] = { pos, t: T, engine: d.posAt(this.ctx.currentTime), pps };
    else this.drawn[i] = null;
    const dur = d ? d.duration : 0;

    // text row + overview
    const flash = this.flashing(i, now);
    const st = d ? d.state : null;
    const bpm = d ? d.effectiveBpm() : null;
    const remaining = d ? dur - pos : 0;
    const textKey = flash ? `f${flash}` : !d ? `e${Ln.loading ? "l" : ""}`
      : `${bpm && bpm.toFixed(2)}|${formatTime(remaining)}|${st.syncOn}|${master === d}|${(Ln.info && Ln.info.meta.title) || ""}`;
    if (this._dirty(`t${i}`, textKey)) this._drawText(i, lane, d, flash, bpm, remaining, st, master);
    const ox = Ln.over && dur > 0 ? Math.round((pos / dur) * lane.over.w * this.dpr) : -1;
    if (this._dirty(`o${i}`, `${ox}|${!!Ln.over}`)) this._drawOverview(lane, Ln, ox);

    // waveform
    const L = st ? st.loop : null;
    const cues = st ? st.hotCues.map((h) => (h ? `${h.start}:${h.end}` : "-")).join(",") : "";
    const waveKey = d ? `${Math.round(pos * pps * this.dpr)}|${L.active}|${L.in}|${L.out}|${cues}|${st.cuePoint}|${Ln.tiles.length}|${d.grid ? d.grid.bpm + ":" + d.grid.first_beat_s + ":" + d.grid.downbeat_s : ""}`
      : `e${Ln.loading ? "l" : ""}`;
    if (!this._dirty(`w${i}`, waveKey)) return;
    const w = lane.wave;
    g.save();
    g.beginPath();
    g.rect(w.x, w.y, w.w, w.h);
    g.clip();
    g.fillStyle = COL.lane;
    g.fillRect(w.x, w.y, w.w, w.h);
    const cx = w.x + w.w / 2;
    if (d) {
      const x0 = cx - pos * pps;                    // screen x of the track's 0 s
      const t0 = pos - w.w / 2 / pps, t1 = pos + w.w / 2 / pps;
      if (L.active && L.out > L.in) {
        g.fillStyle = COL.loop;
        g.fillRect(x0 + L.in * pps, w.y, (L.out - L.in) * pps, w.h);
      }
      for (const tile of Ln.tiles) {
        const dx = x0 + tile.x0;
        if (dx + tile.w < w.x || dx > w.x + w.w) continue;
        g.drawImage(tile.c, 0, 0, tile.w, tile.c.height, dx, w.y, tile.w, w.h);
      }
      for (const m of beatMarks(d.grid, Math.max(0, t0), Math.min(dur, t1))) {
        const x = Math.round((x0 + m.t * pps) * this.dpr) / this.dpr;
        g.fillStyle = m.bar ? COL.bar : COL.tick;
        const th = m.bar ? Math.max(3, w.h * 0.3) : Math.max(2, w.h * 0.15);
        g.fillRect(x, w.y, 1, th);
        g.fillRect(x, w.y + w.h - th, 1, th);
      }
      const tri = Math.max(3, Math.min(6, w.h * 0.3));
      st.hotCues.forEach((h) => {
        if (!h || h.start < t0 - 1 || h.start > t1 + 1) return;
        const x = x0 + h.start * pps;
        g.fillStyle = h.end !== null ? HOT_CUE_COLOURS.loop : HOT_CUE_COLOURS.cue;
        g.fillRect(x - 0.5, w.y, 1, w.h);
        g.beginPath();
        g.moveTo(x - tri, w.y);
        g.lineTo(x + tri, w.y);
        g.lineTo(x, w.y + tri);
        g.closePath();
        g.fill();
      });
      if (st.cuePoint >= t0 && st.cuePoint <= t1) {
        g.fillStyle = COL.on;
        g.fillRect(x0 + st.cuePoint * pps - 0.5, w.y + w.h - 2, 1, 2);
      }
    }
    g.fillStyle = COL.playhead;
    g.fillRect(cx - 0.75, w.y, 1.5, w.h);
    g.restore();
  }

  _drawText(i, lane, d, flash, bpm, remaining, st, master) {
    const g = this.g;
    const r = lane.text;
    g.save();
    g.fillStyle = COL.bg;
    g.fillRect(r.x, r.y, r.w + GAP, r.h);
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    const fs = clamp(r.h - 2, 8, 11);
    g.font = FONT(fs);
    g.textBaseline = "middle";
    const y = r.y + r.h / 2 + 0.5;
    let x = r.x + 2;
    const put = (text, colour) => { g.fillStyle = colour; g.fillText(text, x, y); x += g.measureText(text).width; };
    put(`${i + 1} `, COL.dim);
    if (flash) put(flash, COL.flash);
    else if (!d) put(this.lanes[i].loading ? "loading" : "no track", COL.dim);
    else {
      const segs = deckLine({ meta: this.lanes[i].info ? this.lanes[i].info.meta : d.track && d.track.meta,
        bpm, remaining, sync: st.syncOn, master: master === d });
      for (const s of segs) put(s.text, s.on ? COL.on : s.dim ? COL.dim : COL.text);
    }
    g.restore();
  }

  _drawOverview(lane, Ln, ox) {
    const g = this.g;
    const r = lane.over;
    g.fillStyle = COL.bg;
    g.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    if (!Ln.over) {
      g.fillStyle = "#1a1a1d";
      g.fillRect(r.x, r.y, r.w, r.h);
      return;
    }
    g.drawImage(Ln.over, r.x, r.y, r.w, r.h);
    const px = ox / this.dpr;
    g.fillStyle = "rgba(0,0,0,0.45)";               // what has played
    g.fillRect(r.x, r.y, px, r.h);
    g.fillStyle = COL.playhead;
    g.fillRect(r.x + px - 0.5, r.y - 1, 1.5, r.h + 2);
  }

  _drawPanel(now, dt) {
    const g = this.g;
    const p = this.L.panel;
    const fx = this.fx;
    for (let c = 0; c < 2; c++) {
      let db = -Infinity;
      if (this.mixer) {
        const lin = this.mixer.channel(c + 1).level();
        db = lin > 0 ? 20 * Math.log10(lin) : -Infinity;
      }
      this.meters[c] = meterStep(this.meters[c], db, dt);
    }
    const fxKey = fx ? `${fx.state.name}|${fx.state.fraction}|${fx.state.on}|${fx.state.target}` : "-";
    const mk = this.meters.map((m) => `${Math.round(meterFraction(m.db) * p.w)}:${Math.round(meterFraction(m.peak) * p.w)}`).join("|");
    if (!this._dirty("p", `${fxKey}|${mk}`)) return;
    g.save();
    g.fillStyle = COL.bg;
    g.fillRect(p.x, p.y, p.w, p.h);
    const rowH = Math.min(14, p.h / 3.2);
    g.font = FONT(clamp(rowH - 3, 8, 10));
    g.textBaseline = "middle";
    let x = p.x;
    const y = p.y + rowH / 2 + 1;
    const put = (t, col) => { g.fillStyle = col; g.fillText(t, x, y); x += g.measureText(t).width; };
    if (fx) {
      const fi = FX_FRACTIONS.indexOf(fx.state.fraction);
      put(fx.state.name.toUpperCase(), COL.text);
      put(` ${FX_FRACTION_LABELS[fi] || fx.state.fraction} `, COL.dim);
      put(fx.state.on ? "ON" : "OFF", fx.state.on ? COL.on : COL.dim);
    } else {
      put("BEAT FX", COL.dim);
    }
    const mh = Math.max(3, Math.min(6, (p.h - rowH) / 4));
    const lab = 10;
    this.meters.forEach((m, c) => {
      const my = p.y + rowH + 2 + c * (p.h - rowH - 2) / 2 + ((p.h - rowH - 2) / 2 - mh) / 2;
      g.font = FONT(8);
      g.fillStyle = COL.dim;
      g.fillText(String(c + 1), p.x, my + mh / 2);
      const bx = p.x + lab, bw = p.w - lab;
      g.fillStyle = "#1a1a1d";
      g.fillRect(bx, my, bw, mh);
      const f = meterFraction(m.db);
      const seg = (from, to, col) => {
        const a = Math.max(from, 0), b = Math.min(to, f);
        if (b > a) { g.fillStyle = col; g.fillRect(bx + a * bw, my, (b - a) * bw, mh); }
      };
      seg(0, meterFraction(-12), COL.meterLo);
      seg(meterFraction(-12), meterFraction(-3), COL.meterMid);
      seg(meterFraction(-3), 1, COL.meterHi);
      const pk = meterFraction(m.peak);
      if (pk > 0) {
        g.fillStyle = m.peak > -3 ? COL.meterHi : COL.text;
        g.fillRect(bx + pk * bw - 1, my - 1, 1.5, mh + 2);
      }
    });
    g.restore();
  }

  /** 0..1 for the board's LED meters (the same ballistics as the strip's). */
  /** REC's tap handler (app.js). */
  onRec(cb) { this._recCb = cb; }

  /** REC lit red with the elapsed mm:ss while recording; DOM touched on change only. */
  setRec(on, seconds = 0) {
    const label = recLabel(on, seconds);
    if (label === this._recShown) return;
    this._recShown = label;
    this.rec.textContent = label;
    this.rec.classList.toggle("cab-on", !!on);
    this.rec.setAttribute("aria-pressed", String(!!on));
    this.rec.title = on ? "Stop recording" : "Record the master";
  }

  meterLevel(c) {
    const m = this.meters[c];
    return m ? meterFraction(m.db) : 0;
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this.list.removeEventListener("pointerdown", this._onDown);
    this.list.removeEventListener("pointermove", this._onMove);
    this.list.removeEventListener("pointerup", this._onUp);
    this.list.removeEventListener("pointercancel", this._onUp);
    this.list.remove();
    this.rec.removeEventListener("click", this._onRec);
    this.rec.remove();
  }
}
