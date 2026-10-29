// A Cabine: the board. Draws flx4-map's CONTROLS on a landscape screen, wires
// each to a touch widget (ui/controls.js) and routes it to an action.
//
// renderBoard(root, CONTROLS, bindings, opts) -> {setLit, setBlink, setMark,
//   setLatch, setLevel, notYet, padMode, shift, widget, stripSlot, recHost,
//   panelSlots, panels, hitTest, destroy}
//   bindings  {"deck.cueDown": (value, control) => ..., ...}: the board calls
//             bindings[action](value, control) for every action that is not
//             the board's own ("board.*"). control carries deck, index, band,
//             arg. Missing bindings are skipped. Task 10 binds the engine.
//   opts      {onCrate(): the "caixa" button, onPadMode(deck, mode),
//              layout: "phone" (default) | "panels" | "spread" | "exact" (ui/board-layout.js)}
//
// The panel is drawn as its three sections (deck 1, mixer, deck 2), each a
// positioned box; a control's x is relative to its section, so the layouts
// can move the sections apart while every part inside keeps the photo's
// centre. Sizes are px, from board-layout.js: small parts drawn bigger than
// the photo (placeControls), legends sized and placed around them
// (legendPlan), all set again on every resize.
//
// Touch: the jog, the faders and the crossfader take touches on their own
// element. Every other part is drawn with pointer-events: none; its section
// answers for it (a TouchRouter) and hands each touch to the part whose hit
// zone holds it (hitMap: grown past the drawn part, split by nearest centre),
// so a thumb that lands near a small button presses it.
//
// "phone" (default): the strip is a slim band on top (caixa at its left end,
// Beat FX and REC at its right end), the decks re-proportioned for a phone
// (board-layout.js phoneDeck), the mixer as on the panel. The browse list
// opens over the mixer under its BROWSE / LOAD row (browseHost).
//
// Every jog carries its jog display canvas (jogCanvases(), drawn by
// ui/jog-screen.js from app.js's frame loop), pointer-events: none.
// "panels": the two gaps beside the mixer are panelSlots() (screen CSS px);
// panels() gives their two elements (Task V2 draws the deck panels in them).
// Until then the left one holds the caixa button and the right one REC
// (recHost); the strip (browse list) shows over deck 1 while the list is open.
//
// The board itself owns three things, as the hardware does:
// - SHIFT, per deck and held (it also sends deck.setShift, so the deck can
//   turn a jog drag into fast search);
// - the pad mode per deck (HOT CUE, BEAT JUMP, SHIFT + BEAT JUMP = BEAT LOOP,
//   SAMPLER), which picks the pads' action (flx4-map PAD_MODES) and lights
//   the mode button;
// - the latching buttons (channel CUE, MASTER CUE), lit while on.
// Everything else that lights (PLAY, CUE, SYNC, pads, ON/OFF...) is lit from
// outside with setLit(id, on | colour), flashed with setBlink(id, on), the
// sync master's MASTER legend lit with setMark(id, on), and the meters with
// setLevel(id, 0..1). setLatch(id, on) puts a latching button (channel CUE,
// MASTER CUE) back in step with the engine when the board is drawn again.

import {
  CONTROLS as ALL_CONTROLS, INDICATORS, LEGENDS, PAD_MODES, DEFAULT_PAD_MODE, BOARD_ASPECT,
} from "../flx4-map.js";
import { Knob, Encoder, Fader, XFader, Button, Pad, Jog, Lever, TouchRouter } from "./controls.js";
import {
  fitBoard, sectionOf, placeControls, hitMap, legendPlan, panelSlots, faderCap, SECTIONS, LAYOUT, LAYOUTS, BIG_KINDS,
} from "./board-layout.js";

export const NOT_YET_MS = 1200;
export const NOT_YET_TEXT = "not yet";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (v) => `${+v.toFixed(4)}%`;

/** Average advance of an uppercase Archivo 600 glyph, in em (measured: 0.62). */
const CHAR_EM = 0.62;

/** Text fitting: --k is the largest font size, in units of --u (1 % of the
 *  board's height), that keeps `text` inside `widthPct` of the panel's width
 *  (and inside `heightPct` of its height when given). The CSS takes the
 *  smaller of that and the base legend size, so legends never run into their
 *  neighbours: the FLX4's own legends are tiny, and at phone size the room
 *  between parts is what decides. */
function fitK(text, widthPct, heightPct) {
  const n = Math.max(1, [...String(text).replace(/︎/g, "")].length);
  let k = (widthPct * BOARD_ASPECT) / (n * CHAR_EM);
  if (heightPct) k = Math.min(k, heightPct);
  return k.toFixed(3);
}

const PHONES_ICON = `<svg class="cab-board-phones" viewBox="0 0 12 10" aria-hidden="true"><path d="M1.5 8V6a4.5 4.5 0 0 1 9 0v2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="0.6" y="6" width="2.4" height="3.6" rx="0.6" fill="currentColor"/><rect x="9" y="6" width="2.4" height="3.6" rx="0.6" fill="currentColor"/></svg>`;

function legendHtml(c) {
  let h = "";
  if (c.label) {
    const k = fitK(c.label + (c.phones ? "  " : ""), c.lw ?? c.w + 2.4);
    h += `<span class="cab-board-lbl" style="--k:${k}">${c.phones ? PHONES_ICON : ""}${esc(c.label)}</span>`;
  }
  if (c.sub) {
    const k = fitK(c.sub, (c.sw ?? c.w + 0.8) - (c.subPlain ? 0 : 0.6), c.sh);   // the box's padding and border
    const at = c.subY !== undefined ? `;top:${(((c.subY - c.y) / c.h) * 100).toFixed(2)}%;margin-top:0` : "";
    h += `<span class="cab-board-sub${c.subPlain ? " cab-board-sub-plain" : ""}" style="--k:${k}${at}">${esc(c.sub)}</span>`;
  }
  return h;
}

/** Round faces wrap ("BEAT SYNC" on two lines): fit the longest word. */
function faceFitText(c) {
  if (c.look !== "round" && c.look !== "big") return c.face;
  return c.face.split(" ").reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** A box in percent of its section (x) and of the panel (y). */
function boxStyle(b) {
  const sec = sectionOf(b.x);
  const span = sec.x1 - sec.x0;
  return `left:${pct(((b.x - sec.x0) / span) * 100)};top:${pct(b.y)};width:${pct((b.w / span) * 100)};height:${pct(b.h)}`;
}

function controlHtml(c) {
  let extra = "";
  const cls = [`cab-board-ctl`, `cab-bk-${c.kind}`];
  if (c.look) cls.push(`cab-look-${c.look}`);
  if (c.lightColour) cls.push(`cab-light-${c.lightColour}`);
  if (c.v1 === false) cls.push("cab-drawn-only");
  if (c.deck) cls.push(`cab-deck${c.deck}`);
  if (!BIG_KINDS.includes(c.kind)) cls.push("cab-routed");
  let inner = "";
  switch (c.kind) {
    case "knob":
    case "encoder":
      inner = `<span class="cab-board-knob"><i></i></span>`;
      break;
    case "fader":
    case "xfader": {
      const capW = (c.cap.w / c.w) * 100;
      const capH = (c.cap.h / c.h) * 100;
      extra = `;--cap-w:${capW.toFixed(3)}%;--cap-h:${capH.toFixed(3)}%`
        + `;--cap-w-half:${(capW / 2).toFixed(3)}%;--cap-h-half:${(capH / 2).toFixed(3)}%`;
      inner = `<span class="cab-board-track"></span><span class="cab-board-ticks"></span><span class="cab-board-cap"></span>`;
      break;
    }
    case "jog":
      // the jog display (ui/jog-screen.js) on top: pointer-events none, the jog keeps every touch
      inner = `<span class="cab-board-ring"></span><span class="cab-board-plate"><i></i></span><span class="cab-board-hub"></span>`
        + `<canvas class="cab-jog-screen" aria-hidden="true"></canvas>`;
      break;
    case "lever":
      inner = `<span class="cab-board-slot"><i></i></span>`;
      break;
    case "pad":
      inner = "";
      break;
    default:
      inner = c.face
        ? `<span class="cab-board-face" style="--k:${fitK(faceFitText(c), c.fw ?? c.w * 0.86, c.h * 0.8)}">${esc(c.face)}</span>`
        : "";
  }
  return `<div class="${cls.join(" ")}" data-id="${esc(c.id)}" style="${boxStyle(c)}${extra}">${inner}${legendHtml(c)}</div>`;
}

function indicatorHtml(m) {
  const leds = Array.from({ length: m.leds }, (_, i) => `<i data-led="${m.leds - 1 - i}"></i>`).join("");
  return `<div class="cab-board-meter" data-id="${esc(m.id)}" style="${boxStyle(m)}">${leds}</div>`;
}

function legendItemHtml(l) {
  const cls = ["cab-board-legend"];
  if (l.boxed) cls.push("cab-board-legend-boxed");
  if (l.fill) cls.push("cab-board-legend-fill");
  if (l.small) cls.push("cab-board-legend-small");
  if (l.strong) cls.push("cab-board-legend-strong");
  const sec = sectionOf(l.x);
  const left = ((l.x - sec.x0) / (sec.x1 - sec.x0)) * 100;
  return `<span class="${cls.join(" ")}" data-legend="${LEGENDS.indexOf(l)}" style="left:${pct(left)};top:${pct(l.y)};--k:${fitK(l.text, l.tw ?? 4, l.th)}">${esc(l.text)}</span>`;
}

/** Everything that sits in one section, as its section's inner HTML. */
function sectionsHtml(controls) {
  return SECTIONS.map((sec) => {
    const inSec = (b) => sectionOf(b.x).key === sec.key;
    return `<div class="cab-board-sec cab-board-sec-${sec.key}" data-sec="${sec.key}">`
      + LEGENDS.filter(inSec).map(legendItemHtml).join("")
      + INDICATORS.filter(inSec).map(indicatorHtml).join("")
      + controls.filter(inSec).map(controlHtml).join("")
      + `</div>`;
  }).join("");
}

/** Read the safe-area insets (env(), or the --cab-inset-* test overrides). */
function readInsets(probe) {
  const cs = getComputedStyle(probe);
  const n = (v) => parseFloat(v) || 0;
  return { left: n(cs.paddingLeft), right: n(cs.paddingRight), bottom: n(cs.paddingBottom), top: n(cs.paddingTop) };
}

export function renderBoard(root, controls = ALL_CONTROLS, bindings = {}, opts = {}) {
  root.innerHTML = `
    <div class="cab-board-screen">
      <span class="cab-board-probe" aria-hidden="true"></span>
      <div class="cab-board-strip">
        <button type="button" class="cab-board-caixa">caixa</button>
        <div class="cab-board-strip-slot"></div>
      </div>
      <div class="cab-board" role="application" aria-label="DDJ-FLX4 board">
        ${sectionsHtml(controls)}
        <div class="cab-board-toast" role="status" aria-live="polite" hidden></div>
      </div>
      <div class="cab-board-browsehost"></div>
      <div class="cab-board-panel" data-panel="1"></div>
      <div class="cab-board-panel" data-panel="2"><div class="cab-board-rechost"></div></div>
      <div class="cab-turn">
        <p class="cab-turn-kicker">A Cabine</p>
        <h1 class="cab-turn-h">Turn sideways</h1>
        <p class="cab-turn-note">The board plays in landscape, like the FLX4 on a desk.</p>
        <button type="button" class="cab-turn-caixa">caixa</button>
      </div>
    </div>`;
  const screen = root.querySelector(".cab-board-screen");
  const board = screen.querySelector(".cab-board");
  const strip = screen.querySelector(".cab-board-strip");
  const probe = screen.querySelector(".cab-board-probe");
  const toast = board.querySelector(".cab-board-toast");
  const panelEls = [...screen.querySelectorAll(".cab-board-panel")];
  const caixa = screen.querySelector(".cab-board-caixa");
  const recHost = screen.querySelector(".cab-board-rechost");
  const browseHost = screen.querySelector(".cab-board-browsehost");
  const byId = new Map(controls.map((c) => [c.id, c]));
  const els = new Map([...board.querySelectorAll("[data-id]")].map((el) => [el.dataset.id, el]));
  const widgets = new Map();
  const secEls = new Map([...board.querySelectorAll("[data-sec]")].map((el) => [el.dataset.sec, el]));
  const mode = LAYOUTS.includes(opts.layout) ? opts.layout : LAYOUT;
  board.dataset.layout = mode;
  screen.dataset.mode = mode;
  // panels: the caixa button lives at the top of the left panel slot
  if (mode === "panels") panelEls[0].appendChild(caixa);
  const state = {
    shift: { 1: false, 2: false },
    padMode: { 1: DEFAULT_PAD_MODE, 2: DEFAULT_PAD_MODE },
    latch: {},
  };
  let toastTimer = null;
  const cleanups = [];
  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); cleanups.push(() => target.removeEventListener(type, fn, o)); };

  function setLit(id, lit) {
    const el = els.get(id);
    if (!el) return;
    el.classList.toggle("cab-lit", !!lit);
    if (typeof lit === "string") el.style.setProperty("--lit", lit);
    else el.style.removeProperty("--lit");
  }

  function setBlink(id, on) {
    const el = els.get(id);
    if (el) el.classList.toggle("cab-flash", !!on);
  }

  function setMark(id, on) {
    const el = els.get(id);
    if (el) el.classList.toggle("cab-master", !!on);
  }

  function setLatch(id, on) {
    if (!byId.has(id)) return;
    state.latch[id] = !!on;
    setLit(id, !!on);
  }

  function setLevel(id, v) {
    const el = els.get(id);
    if (!el) return;
    const leds = el.querySelectorAll("i");
    const n = leds.length;
    const x = Math.max(0, Math.min(1, Number(v) || 0));
    for (const led of leds) led.classList.toggle("cab-on", x > 0 && x >= Number(led.dataset.led) / n);
  }

  function notYet() {
    toast.textContent = NOT_YET_TEXT;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; toastTimer = null; }, NOT_YET_MS);
  }

  function lightPadMode(deck) {
    const mode = state.padMode[deck];
    for (const m of ["hotcue", "padfx1", "beatjump", "sampler"]) {
      setLit(`d${deck}-mode-${m}`, `mode-${m}` === PAD_MODES[mode].button);
    }
    const bj = els.get(`d${deck}-mode-beatjump`);
    if (bj) bj.classList.toggle("cab-blink", mode === "beatloop");
  }

  function setPadMode(deck, mode) {
    state.padMode[deck] = mode;
    lightPadMode(deck);
    if (opts.onPadMode) opts.onPadMode(deck, mode);
  }

  const BOARD = {
    padModeHotCue: (c) => setPadMode(c.deck, "hotcue"),
    padModeBeatJump: (c) => setPadMode(c.deck, "beatjump"),
    padModeBeatLoop: (c) => setPadMode(c.deck, "beatloop"),
    padModeSampler: (c) => setPadMode(c.deck, "sampler"),
    notYet: () => notYet(),
  };

  function run(action, value, c) {
    if (!action) return;
    const dot = action.indexOf(".");
    const target = action.slice(0, dot), method = action.slice(dot + 1);
    if (target === "board") { BOARD[method](c); return; }
    const fn = bindings[action];
    if (typeof fn === "function") fn(value, c);
  }

  /** SHIFT as this control reads it: its own deck's for a deck control,
   *  either deck's for the mixer and Beat FX. */
  const shifted = (c) => (c.section === "deck" ? state.shift[c.deck] : state.shift[1] || state.shift[2]);

  function onButton(c) {
    let pressedShifted = false;
    return (down) => {
      if (c.hold) {
        if (c.action === "deck.setShift") state.shift[c.deck] = down;
        run(c.action, down, c);
        return;
      }
      if (down) {
        pressedShifted = shifted(c);
        if (pressedShifted) { run(c.shift, c.shiftArg ?? true, c); return; }
        if (c.latch) {
          const v = !state.latch[c.id];
          state.latch[c.id] = v;
          setLit(c.id, v);
          run(c.action, v, c);
          return;
        }
        run(c.action, c.arg ?? true, c);
      } else if (c.up && !pressedShifted) {
        run(c.up, false, c);
      }
    };
  }

  function onPad(c) {
    return (down) => {
      if (!down) return;
      const m = PAD_MODES[state.padMode[c.deck]];
      if (shifted(c)) { if (m.shift) run(m.shift, c.index, c); return; }
      run(m.action, c.index, c);
    };
  }

  for (const c of controls) {
    const el = els.get(c.id);
    if (!el) continue;
    // small parts answer through their section's router (their hit zone)
    const env = BIG_KINDS.includes(c.kind) ? undefined : { routed: secEls.get(sectionOf(c.x).key) };
    if (c.v1 === false) {
      // drawn only: a press says "not yet" (SHIFT layers included), nothing moves
      const w = new Button(el, c, (down) => { if (down) notYet(); }, env);
      widgets.set(c.id, w);
      continue;
    }
    let w;
    switch (c.kind) {
      case "button": w = new Button(el, c, onButton(c), env); break;
      case "pad": w = new Pad(el, c, onPad(c), env); break;
      case "knob": w = new Knob(el, { ...c, value: c.def }, (v) => run(c.action, v, c), env); break;
      case "encoder":
        w = new Encoder(el, c, (e) => (e.press ? run(c.press, true, c) : run(c.action, e.turn, c)), env);
        break;
      case "fader": w = new Fader(el, { ...c, value: c.def }, (v) => run(c.action, v, c)); break;
      case "xfader": w = new XFader(el, { ...c, value: c.def }, (v) => run(c.action, v, c)); break;
      case "lever": w = new Lever(el, c, (i) => run(c.action, c.positions[i].value, c), env); break;
      case "jog":
        w = new Jog(el, c, (e) => {
          if ("touch" in e) run(c.touch, e.touch, c);
          else if ("turn" in e) run(c.action, e.turn, c);
          else run(c.ring, e.ring, c);
        });
        break;
      default: continue;
    }
    widgets.set(c.id, w);
  }
  lightPadMode(1);
  lightPadMode(2);

  // ---- layout ----------------------------------------------------------------------

  let portrait = null;
  let geo = null;                                  // {fit, drawn, map, slots}
  const legendEls = new Map();                     // plan key -> span
  for (const c of controls) {
    const el = els.get(c.id);
    if (!el) continue;
    const lbl = el.querySelector(":scope > .cab-board-lbl"), sub = el.querySelector(":scope > .cab-board-sub");
    const face = el.querySelector(":scope > .cab-board-face");
    if (lbl) legendEls.set(`${c.id}:label`, lbl);
    if (sub) legendEls.set(`${c.id}:sub`, sub);
    if (face) legendEls.set(`${c.id}:face`, face);
  }
  for (const el of board.querySelectorAll("[data-legend]")) legendEls.set(`legend:${el.dataset.legend}`, el);

  function placeLegends(f, drawn) {
    const plan = legendPlan(f, drawn, controls);
    for (const l of plan) {
      const el = legendEls.get(l.key);
      if (!el) continue;
      el.hidden = !!l.hidden;                     // a SHIFT legend v1 has no layer for, and no room
      if (l.hidden) continue;
      const owner = l.owner ? drawn.get(l.owner) : null;
      const sec = f.sections.find((t) => t.key === l.section);
      const ox = owner ? owner.x : sec.left, oy = owner ? owner.y : 0;
      const st = el.style;
      st.left = `${(l.x - ox).toFixed(2)}px`;
      st.top = `${(l.y - oy).toFixed(2)}px`;
      st.fontSize = `${l.px.toFixed(2)}px`;
      if (l.part === "face") {
        st.right = "auto"; st.bottom = "auto";
        st.width = `${l.w.toFixed(2)}px`; st.height = `${l.h.toFixed(2)}px`;
        const html = l.lines.map(esc).join("<br>");
        if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
        continue;
      }
      st.width = `${l.w.toFixed(2)}px`;
      st.height = `${l.h.toFixed(2)}px`;
      st.lineHeight = `${l.h.toFixed(2)}px`;
      st.bottom = "auto"; st.margin = "0"; st.transform = "none"; st.textAlign = "center"; st.padding = "0";
      el.dataset.side = l.side;
      el.classList.toggle("cab-board-sub-in", l.part === "sub" && l.side === "in");
      el.classList.toggle("cab-board-unfit", !l.fits);
      const c = l.owner ? byId.get(l.owner) : null;
      const icon = c && c.phones && l.part === "label" && l.icon !== false ? PHONES_ICON : "";
      const html = icon + esc(l.text);
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    }
    return plan;
  }

  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const isPortrait = H > W;
    if (isPortrait !== portrait) {
      portrait = isPortrait;
      screen.classList.toggle("cab-portrait", isPortrait);
      if (isPortrait) for (const w of widgets.values()) w.release();
    }
    if (isPortrait) return;
    const insets = readInsets(probe);
    // the same screen as last time: nothing moves (iOS fires resize often)
    const key = `${W}x${H} ${insets.left} ${insets.right} ${insets.top} ${insets.bottom}`;
    if (geo && geo.key === key) return;
    const f = fitBoard({ W, H, insets, mode });
    Object.assign(board.style, {
      left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px`, height: `${f.height}px`,
    });
    for (const sec of f.sections) {
      const el = secEls.get(sec.key);
      el.style.left = `${sec.left}px`;
      el.style.width = `${sec.width}px`;
    }
    board.style.setProperty("--u", `${(f.height / 100).toFixed(4)}px`);
    const drawn = placeControls(f, controls);
    for (const c of controls) {
      const el = els.get(c.id), d = drawn.get(c.id);
      if (!el || !d) continue;
      const sec = f.sections.find((t) => t.key === d.section);
      Object.assign(el.style, {
        left: `${(d.x - sec.left).toFixed(2)}px`, top: `${d.y.toFixed(2)}px`,
        width: `${d.w.toFixed(2)}px`, height: `${d.h.toFixed(2)}px`,
      });
      if (c.kind === "fader" || c.kind === "xfader") {
        // the cap as the layout drew it (phone: the tempo box is not the photo's)
        const cap = faderCap(f, c, d), cw = (cap.w / d.w) * 100, ch = (cap.h / d.h) * 100;
        el.style.setProperty("--cap-w", `${cw.toFixed(3)}%`); el.style.setProperty("--cap-h", `${ch.toFixed(3)}%`);
        el.style.setProperty("--cap-w-half", `${(cw / 2).toFixed(3)}%`); el.style.setProperty("--cap-h-half", `${(ch / 2).toFixed(3)}%`);
        const w = widgets.get(c.id);
        if (w && w.setCap) w.setCap({ w: cap.w / d.w, h: cap.h / d.h });
      }
    }
    const legends = placeLegends(f, drawn);
    const slots = panelSlots(f);
    geo = { fit: f, drawn, map: hitMap(f, drawn, controls), slots, key };
    if (mode === "panels") {
      slots.forEach((r, i) => Object.assign(panelEls[i].style, {
        left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
      }));
      // the strip (browse list) shows over the left panel slot and deck 1 while open
      const d1 = f.sections[0];
      Object.assign(strip.style, {
        left: `${f.left + d1.left}px`, width: `${d1.width + slots[0].w}px`, right: "auto",
        top: `${f.top}px`, height: `${Math.round(f.height * 0.55)}px`,
      });
    } else {
      if (mode === "phone") {
        // the browse list opens over the mixer, under the BROWSE / LOAD row (the
        // band is two list rows tall on a phone); BROWSE and LOAD stay uncovered
        const mix = f.sections.find((x) => x.key === "mixer");
        const ids = ["browse", "load1", "load2"];
        const top = Math.max(...ids.map((id) => drawn.get(id)).filter(Boolean).map((d) => d.y + d.h),
          ...legends.filter((l) => !l.hidden && ids.includes(l.owner)).map((l) => l.y + l.h)) + 3;
        Object.assign(browseHost.style, {
          left: `${f.left + mix.left}px`, top: `${f.top + top}px`, width: `${mix.width}px`,
          height: `${f.height - top}px`,
        });
      }
      Object.assign(strip.style, {
        left: `${f.safe.left}px`, right: `${f.safe.right}px`, width: "auto", top: `${f.stripTop}px`,
        height: `${f.stripBottom - f.stripTop}px`,
      });
    }
    screen.dataset.layout = JSON.stringify({ mode, left: f.left, top: f.top, width: f.width, height: f.height,
      sections: f.sections.map((x) => ({ key: x.key, left: x.left, width: x.width })) });
  }

  /** Which control a touch at client (x, y) goes to (the hit zones), or null. */
  function hitTest(x, y) {
    if (!geo) return null;
    const r = board.getBoundingClientRect();
    return geo.map.at(x - r.left, y - r.top);
  }

  const routers = [...secEls.values()].map((el) => new TouchRouter(el, (e) => {
    const id = hitTest(e.clientX, e.clientY);
    return id && !BIG_KINDS.includes(byId.get(id).kind) ? widgets.get(id) || null : null;
  }));

  layout();
  on(window, "resize", layout);
  on(window, "orientationchange", layout);
  if (window.visualViewport) on(window.visualViewport, "resize", layout);

  // ---- no page gestures on the board ---------------------------------------------------

  const stop = (e) => e.preventDefault();
  on(screen, "contextmenu", stop);
  on(screen, "touchmove", stop, { passive: false });           // no scroll, no pinch
  on(screen, "touchstart", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  on(screen, "dblclick", stop);
  on(document, "gesturestart", stop);                           // iOS pinch
  on(document, "gesturechange", stop);
  on(document, "visibilitychange", () => {
    if (document.hidden) for (const w of widgets.values()) w.release();
  });

  // Chrome on Android moves a touch onto the nearest "clickable" element within
  // the finger's radius (touch adjustment): with no click listener the board
  // was not one, so a tap on the deck's top edge went to caixa in the band.
  // A no-op click listener makes the board a target of its own.
  on(board, "click", () => {});

  const toCrate = () => { if (opts.onCrate) opts.onCrate(); };
  on(caixa, "click", toCrate);
  on(screen.querySelector(".cab-turn-caixa"), "click", toCrate);

  return {
    el: screen,
    board,
    setLit,
    setBlink,
    setMark,
    setLatch,
    setLevel,
    notYet,
    stripSlot: strip.querySelector(".cab-board-strip-slot"),
    /** panels: where REC goes (top of the right panel slot); null in the strip layouts. */
    recHost: mode === "panels" ? recHost : null,
    /** phone: where the strip's browse list opens (over the mixer); null in the other layouts. */
    browseHost: mode === "phone" ? browseHost : null,
    /** The two jog display canvases, deck 1 then deck 2 (ui/jog-screen.js draws them). */
    jogCanvases: () => [1, 2].map((n) => els.get(`d${n}-jog`)?.querySelector(".cab-jog-screen") || null),
    /** The two panel slots, screen CSS px [{x, y, w, h}, ...] (empty gaps outside "panels"). */
    panelSlots: () => (geo ? geo.slots.map((r) => ({ ...r })) : []),
    /** The two panel slot elements (Task V2 draws the deck panels in them). */
    panels: () => panelEls,
    layoutMode: mode,
    hitTest,
    geometry: () => geo,
    padMode: (deck) => state.padMode[deck],
    shift: (deck) => state.shift[deck],
    widget: (id) => widgets.get(id),
    control: (id) => byId.get(id),
    layout,
    destroy() {
      for (const r of routers) r.destroy();
      for (const w of widgets.values()) w.destroy();
      widgets.clear();
      for (const fn of cleanups) fn();
      if (toastTimer) clearTimeout(toastTimer);
      root.innerHTML = "";
    },
  };
}
