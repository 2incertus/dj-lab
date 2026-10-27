// A Cabine: the board. Draws flx4-map's CONTROLS on a landscape screen, wires
// each to a touch widget (ui/controls.js) and routes it to an action.
//
// renderBoard(root, CONTROLS, bindings, opts) -> {setLit, setLevel, notYet,
//   padMode, shift, widget, destroy}
//   bindings  {"deck.cueDown": (value, control) => ..., ...}: the board calls
//             bindings[action](value, control) for every action that is not
//             the board's own ("board.*"). control carries deck, index, band,
//             arg. Missing bindings are skipped. Task 10 binds the engine.
//   opts      {onCrate(): the "caixa" button, onPadMode(deck, mode)}
//
// The board itself owns three things, as the hardware does:
// - SHIFT, per deck and held (it also sends deck.setShift, so the deck can
//   turn a jog drag into fast search);
// - the pad mode per deck (HOT CUE, BEAT JUMP, SHIFT + BEAT JUMP = BEAT LOOP,
//   SAMPLER), which picks the pads' action (flx4-map PAD_MODES) and lights
//   the mode button;
// - the latching buttons (channel CUE, MASTER CUE), lit while on.
// Everything else that lights (PLAY, CUE, SYNC, pads, ON/OFF...) is lit from
// outside with setLit(id, on | colour), and the meters with setLevel(id, 0..1).

import {
  CONTROLS as ALL_CONTROLS, INDICATORS, LEGENDS, PAD_MODES, DEFAULT_PAD_MODE,
} from "../flx4-map.js";
import { Knob, Encoder, Fader, XFader, Button, Pad, Jog, Lever } from "./controls.js";
import { fitBoard } from "./board-layout.js";

export const NOT_YET_MS = 1200;
export const NOT_YET_TEXT = "not yet";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (v) => `${v}%`;

const PHONES_ICON = `<svg class="cab-board-phones" viewBox="0 0 12 10" aria-hidden="true"><path d="M1.5 8V6a4.5 4.5 0 0 1 9 0v2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="0.6" y="6" width="2.4" height="3.6" rx="0.6" fill="currentColor"/><rect x="9" y="6" width="2.4" height="3.6" rx="0.6" fill="currentColor"/></svg>`;

function legendHtml(c) {
  let h = "";
  if (c.label) h += `<span class="cab-board-lbl">${c.phones ? PHONES_ICON : ""}${esc(c.label)}</span>`;
  if (c.sub) {
    const at = c.subY !== undefined ? ` style="top:${(((c.subY - c.y) / c.h) * 100).toFixed(2)}%;margin-top:0"` : "";
    h += `<span class="cab-board-sub${c.subPlain ? " cab-board-sub-plain" : ""}"${at}>${esc(c.sub)}</span>`;
  }
  return h;
}

function controlHtml(c) {
  let extra = "";
  const cls = [`cab-board-ctl`, `cab-bk-${c.kind}`];
  if (c.look) cls.push(`cab-look-${c.look}`);
  if (c.lightColour) cls.push(`cab-light-${c.lightColour}`);
  if (c.v1 === false) cls.push("cab-drawn-only");
  if (c.deck) cls.push(`cab-deck${c.deck}`);
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
      inner = `<span class="cab-board-ring"></span><span class="cab-board-plate"><i></i></span><span class="cab-board-hub"></span>`;
      break;
    case "lever":
      inner = `<span class="cab-board-slot"><i></i></span>`;
      break;
    case "pad":
      inner = "";
      break;
    default:
      inner = c.face ? `<span class="cab-board-face">${esc(c.face)}</span>` : "";
  }
  const style = `left:${pct(c.x)};top:${pct(c.y)};width:${pct(c.w)};height:${pct(c.h)}${extra}`;
  return `<div class="${cls.join(" ")}" data-id="${esc(c.id)}" style="${style}">${inner}${legendHtml(c)}</div>`;
}

function indicatorHtml(m) {
  const leds = Array.from({ length: m.leds }, (_, i) => `<i data-led="${m.leds - 1 - i}"></i>`).join("");
  return `<div class="cab-board-meter" data-id="${esc(m.id)}" style="left:${pct(m.x)};top:${pct(m.y)};width:${pct(m.w)};height:${pct(m.h)}">${leds}</div>`;
}

function legendItemHtml(l) {
  const cls = ["cab-board-legend"];
  if (l.boxed) cls.push("cab-board-legend-boxed");
  if (l.fill) cls.push("cab-board-legend-fill");
  if (l.small) cls.push("cab-board-legend-small");
  if (l.strong) cls.push("cab-board-legend-strong");
  return `<span class="${cls.join(" ")}" style="left:${pct(l.x)};top:${pct(l.y)}">${esc(l.text)}</span>`;
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
        <span class="cab-board-deckplate" style="left:0;width:34%"></span>
        <span class="cab-board-deckplate" style="left:66%;width:34%"></span>
        ${LEGENDS.map(legendItemHtml).join("")}
        ${INDICATORS.map(indicatorHtml).join("")}
        ${controls.map(controlHtml).join("")}
        <div class="cab-board-toast" role="status" aria-live="polite" hidden></div>
      </div>
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
  const byId = new Map(controls.map((c) => [c.id, c]));
  const els = new Map([...board.querySelectorAll("[data-id]")].map((el) => [el.dataset.id, el]));
  const widgets = new Map();
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
    if (c.v1 === false) {
      // drawn only: a press says "not yet" (SHIFT layers included), nothing moves
      const w = new Button(el, c, (down) => { if (down) notYet(); });
      widgets.set(c.id, w);
      continue;
    }
    let w;
    switch (c.kind) {
      case "button": w = new Button(el, c, onButton(c)); break;
      case "pad": w = new Pad(el, c, onPad(c)); break;
      case "knob": w = new Knob(el, { ...c, value: c.def }, (v) => run(c.action, v, c)); break;
      case "encoder":
        w = new Encoder(el, c, (e) => (e.press ? run(c.press, true, c) : run(c.action, e.turn, c)));
        break;
      case "fader": w = new Fader(el, { ...c, value: c.def }, (v) => run(c.action, v, c)); break;
      case "xfader": w = new XFader(el, { ...c, value: c.def }, (v) => run(c.action, v, c)); break;
      case "lever": w = new Lever(el, c, (i) => run(c.action, c.positions[i].value, c)); break;
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
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const isPortrait = H > W;
    if (isPortrait !== portrait) {
      portrait = isPortrait;
      screen.classList.toggle("cab-portrait", isPortrait);
      if (isPortrait) for (const w of widgets.values()) w.release();
    }
    if (isPortrait) return;
    const f = fitBoard({ W, H, insets: readInsets(probe) });
    Object.assign(board.style, {
      left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px`, height: `${f.height}px`,
    });
    board.style.setProperty("--u", `${(f.height / 100).toFixed(4)}px`);
    Object.assign(strip.style, {
      left: `${f.safe.left}px`, right: `${f.safe.right}px`, top: `${f.stripTop}px`,
      height: `${f.stripBottom - f.stripTop}px`,
    });
    screen.dataset.layout = JSON.stringify({ left: f.left, top: f.top, width: f.width, height: f.height });
  }
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

  const toCrate = () => { if (opts.onCrate) opts.onCrate(); };
  on(screen.querySelector(".cab-board-caixa"), "click", toCrate);
  on(screen.querySelector(".cab-turn-caixa"), "click", toCrate);

  return {
    el: screen,
    board,
    setLit,
    setLevel,
    notYet,
    padMode: (deck) => state.padMode[deck],
    shift: (deck) => state.shift[deck],
    widget: (id) => widgets.get(id),
    control: (id) => byId.get(id),
    layout,
    destroy() {
      for (const w of widgets.values()) w.destroy();
      widgets.clear();
      for (const fn of cleanups) fn();
      if (toastTimer) clearTimeout(toastTimer);
      root.innerHTML = "";
    },
  };
}
