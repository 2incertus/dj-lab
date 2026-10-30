// A Cabine: where the board goes on the screen, how big each part is drawn and
// where each part answers a touch (pure, unit-tested in test/board-layout.test.js
// and test/flx4-map.test.js).
//
// Landscape screen. Nothing interactive goes in the safe areas: the sides
// (Dynamic Island, rounded corners) and the home indicator at the bottom.
// env(safe-area-inset-*) gives them on the iPhone; where it reads 0 (Android,
// desktop, the e2e browsers) SAFE_FALLBACK stands in, so the layout is the
// iPhone's everywhere. The crossfader's box must end XFADER_CLEAR_PX above the
// bottom edge (home indicator plus the swipe-up zone).
//
// The panel is three sections side by side, as on the hardware: deck 1, the
// mixer (with Beat FX and browse), deck 2 (SECTIONS, percent of the panel's
// width). Four layouts:
//   "phone"   (default, Cabine v2 V1b) a slim waveform band on top, the mixer
//             at the panel's proportions in the middle, the decks widened to
//             the rest and re-proportioned for a phone (fitPhone, phoneDeck,
//             below).
//   "panels"  (V1, for comparison) no strip band: the board takes the whole
//             usable height (PANELS_TOP_PX from the top, down to the bottom
//             rules), the sections scale uniformly to it, deck 1 at the left
//             safe edge, deck 2 at the right one, the mixer centred. The two
//             gaps left over are the panel slots (panelSlots(), CSS px).
//   "spread"  a strip band on top (STRIP_SHARE), the sections sized by the
//             height left and spread across the whole width (ruling R23).
//   "exact"   the whole panel at BOARD_ASPECT, centered: what the photo shows.
// All shrink until the crossfader clears the bottom.
//
// Drawn sizes (placeControls). Inside a section every part keeps the photo's
// centre. At phone size the FLX4's buttons are tiny, so small parts grow
// around their centre: round and small rectangular buttons to BUTTON_MIN_PX on
// their short side, knobs (and BROWSE) to KNOB_MIN_PX, each never past half
// the distance to a neighbour's centre (its shape stays on its side of the
// perpendicular bisector), never into a big part, a meter or out of its
// section. Pads keep their grid and fill the deck's pad area with PAD_GAP_PX
// gaps. The jog, the faders and the crossfader keep their box.
//
// Hit zones (hitMap). Every small part answers a touch in a zone larger than
// what is drawn: its drawn box grown by HIT_MARGIN_PX each side and to at least
// HIT_MIN_PX square, clamped to its section. Where two zones meet, the point
// goes to the nearer part, measured to what is drawn (for two parts of one
// size, the Voronoi split of their centres); a touch on a drawn part is that
// part's. The jog (its disc), the faders and
// the crossfader keep their drawn box as their zone and no zone enters them.
// board.js resolves a touch on the section with at(x, y) and hands it to the
// widget, which keeps the pointer captured as before.
//
// Legends (legendPlan). Each printed legend gets a size (never under
// LEGEND_MIN_PX; where the text cannot fit, the hardware's short form from
// SHORT) and a place: a label above its part, a SHIFT legend under it, or, when
// a grown part leaves no room there, beside it on the side away from the
// section's middle. In the phone decks (Task V3) there are no legend rows:
// every button carries its legends on itself (onButton: its name, SYNC's
// MASTER over its face, its SHIFT legend or 1/2X / 2X as a small bottom line),
// nothing under PHONE.legendMin; CUE/LOOP CALL and TEMPO sit beside the jog,
// the tempo marks in the fader's tick column.

import { BOARD_ASPECT, CONTROLS, INDICATORS, LEGENDS } from "../flx4-map.js";

export const LAYOUT = "phone";
export const LAYOUTS = ["phone", "panels", "spread", "exact"];
export const STRIP_SHARE = { exact: 0.22, spread: 0.12, panels: 0, phone: 0.10 };
export const SAFE_FALLBACK = { side: 47, bottom: 21 };
export const XFADER_CLEAR_PX = 34;
/** panels: the board's distance from the top edge (no strip above it). */
export const PANELS_TOP_PX = 6;
/** Every small control answers a touch at least this big (Apple's 44 pt). */
export const HIT_MIN_PX = 44;
/** ...and at least this far past its drawn edge, where there is room. */
export const HIT_MARGIN_PX = 12;
/** Drawn minimums: round and small rectangular buttons (short side), knobs. */
export const BUTTON_MIN_PX = 28;
export const KNOB_MIN_PX = 30;
/** A rectangular button's long side grows with it, up to this. */
export const BUTTON_LONG_MAX_PX = 36;
/** ...and never past this many times its short side (a part kept narrow by
 *  its neighbours does not turn into a tall bar). */
export const BUTTON_ASPECT_MAX = 1.3;
/** CH SELECT lever: a slide switch, not a button. */
export const LEVER_MIN_PX = 20;
export const PAD_GAP_PX = 3;
/** Space kept between two grown parts, and between a part and a big one. */
export const DRAW_GAP_PX = 2;
export const LEGEND_MIN_PX = 6;
/** The big continuous controls: their drawn box is their zone. */
export const BIG_KINDS = ["jog", "fader", "xfader"];
/** The panel's sections, percent of its width (deck plates end at 34 / 66 % in the figure). */
export const SECTIONS = [
  { key: "deck1", x0: 0, x1: 34 },
  { key: "mixer", x0: 34, x1: 66 },
  { key: "deck2", x0: 66, x1: 100 },
];

const XF = CONTROLS.find((c) => c.id === "xfader");
/** Where the crossfader's box ends, as a fraction of the board's height. */
export const XFADER_BOTTOM = (XF.y + XF.h) / 100;

/** The section an item at panel x (percent) belongs to. */
export function sectionOf(x) {
  return SECTIONS.find((s) => x >= s.x0 && x < s.x1) || SECTIONS[SECTIONS.length - 1];
}

/**
 * @param W, H     viewport in CSS px (landscape)
 * @param insets   {left, right, bottom, top}: env(safe-area-inset-*) values
 * @param mode     "phone" (default) | "panels" | "spread" | "exact"
 * @returns {mode, left, top, width, height, unit, sections: [{key, x0, x1, left, width}],
 *           stripTop, stripBottom, safe}; section left is relative to the board,
 *           unit = px per percent of the panel's height (a percent of its width
 *           is unit * BOARD_ASPECT px inside every section)
 */
export function fitBoard({ W, H, insets = {}, mode = LAYOUT }) {
  if (!LAYOUTS.includes(mode)) throw new Error(`board layout ${mode}`);
  const safe = {
    left: Math.max(insets.left || 0, SAFE_FALLBACK.side),
    right: Math.max(insets.right || 0, SAFE_FALLBACK.side),
    bottom: Math.max(insets.bottom || 0, SAFE_FALLBACK.bottom),
    top: Math.max(insets.top || 0, 0),
  };
  if (mode === "phone") return fitPhone(W, H, safe);
  const stripTop = safe.top;
  const stripBottom = stripTop + Math.round(STRIP_SHARE[mode] * H);
  const above = mode === "panels" ? Math.max(safe.top, PANELS_TOP_PX) : stripBottom;
  const availW = Math.max(0, W - safe.left - safe.right);
  const availH = Math.max(0, H - safe.bottom - above);
  const xfH = (H - XFADER_CLEAR_PX - above) / XFADER_BOTTOM;   // tallest board whose crossfader clears
  const height = Math.max(0, Math.min(availH, availW / BOARD_ASPECT, xfH));
  const natural = height * BOARD_ASPECT;
  const spread = mode !== "exact";
  const width = spread ? availW : natural;
  const gap = spread ? (availW - natural) / (SECTIONS.length - 1) : 0;
  const left = safe.left + (availW - width) / 2;
  // panels: at the top; the others centered in the space below the strip, but
  // never so low the crossfader enters the clear zone
  const centered = mode === "panels" ? above : above + (availH - height) / 2;
  const top = Math.max(above, Math.min(centered, H - XFADER_CLEAR_PX - XFADER_BOTTOM * height));
  const unit = height / 100;
  let x = 0;
  const sections = SECTIONS.map((s) => {
    const w = ((s.x1 - s.x0) / 100) * natural;
    const out = { ...s, left: x, width: w };
    x += w + gap;
    return out;
  });
  return { mode, left, top, width, height, unit, sections, stripTop, stripBottom: mode === "panels" ? stripTop : stripBottom, safe };
}

// ---- the "phone" layout (Cabine v2, Task V1b; Cabine v3, Task V3) -------------------------
//
// The FLX4's own proportions cap every part by the phone's height (V1: the
// smallest zone 20.5 x 28.5 px at 844 x 330 with 105 px of empty width each
// side). "phone" keeps the hardware's arrangement and re-solves the decks'
// proportions for a phone:
// - a slim two-lane waveform band across the top (STRIP_SHARE.phone of the
//   usable height, at least PHONE.bandMin px): the strip, caixa at its left
//   end, Beat FX status and REC at its right end;
// - the mixer keeps the panel's proportions (as tall as the crossfader rule
//   allows) and sits in the middle;
// - each deck takes all the width left on its side, PHONE.deckGap px off the
//   mixer, and lays its parts out by phoneDeck(): the loop row on top (IN, OUT,
//   4 BEAT/EXIT, CALL, CALL, SYNC, evenly), the jog under it, SHIFT / CUE / PLAY
//   in the left column, the mode row over the 2 x 4 pads, the tempo fader at
//   the deck's right edge (the outer edge for deck 2), as on the hardware.
// v3 ("deck buttons should be bigger on mobile"): no legend rows in a deck.
// Every button's legends print on it (legendPlan, deckLegends), so the loop
// row starts at the deck's top edge.
// v4 ("these buttons should be a bit smaller, more like original size"): the
// mode row and the pads go back toward the FLX4's proportions and give their
// height to the jog. On the photo a pad is 0.14 of the jog and a mode button
// 0.35 of a pad; on a phone the pads aim at PHONE.padJog of the jog (never
// under their floor, phoneTargets) and the mode buttons at PHONE.modePad of a
// pad (never under what their name and SHIFT legend need). CUE and PLAY keep
// their own size, no longer a pad row's height: SHIFT, CUE and PLAY stand on
// their own rhythm in the left column, bottom-aligned with the pads.

export const PHONE = {
  bandMin: 30, bandGap: 2, deckGap: 2,
  edge: 1, gap: 3, padGap: 4,
  tempoMin: 22, tempoMax: 30, tempoShare: 0.085,
  /** The jog's largest share of the deck's height (the photo's: 0.53). */
  jogShare: 0.5,
  /** Pads: about this share of the jog's diameter, at most this much wider than tall. */
  padJog: 0.30, padAspectMax: 1.2,
  /** Mode buttons: this share of a pad's height; their name never under modeMain px. */
  modePad: 0.45, modeMain: 8,
  /** No legend in a phone deck is smaller than this. */
  legendMin: 7,
  /** Between SHIFT and CUE, CUE and PLAY. */
  columnGap: 4,
};
/** The least mode button: its name (modeMain) over its SHIFT legend
 *  (legendMin), 1 px apart and 1 px inside the bezel. */
PHONE.modeMin = 1 + PHONE.modeMain + 1 + PHONE.legendMin + 1;

/** What a deck aims for, by its height: a browser with its tab bar (deck
 *  ~241 px tall at 844 x 300), Safari with its bars (~271 px at 844 x 330) to
 *  the installed app (~326 px at 844 x 390). button: every round button and
 *  the short side of SHIFT; cue: CUE and PLAY; zone: every hit zone but the
 *  pads' and the mode row's; pad: a pad's least short side; padZone: a pad's
 *  least hit zone; modeZone: the mode row's least zone height. */
export function phoneTargets(deckH) {
  const t = Math.min(1, Math.max(0, (deckH - 270) / 56));
  return { zone: 44 + 4 * t, button: 40 + 4 * t, cue: 46 + 6 * t, pad: 36 + 4 * t, padZone: 40, modeZone: 32 };
}

function fitPhone(W, H, safe) {
  const usable = H - safe.top - safe.bottom;
  const band = Math.max(PHONE.bandMin, Math.round(STRIP_SHARE.phone * usable));
  const stripTop = safe.top, stripBottom = stripTop + band;
  const above = stripBottom + PHONE.bandGap;
  const availW = Math.max(0, W - safe.left - safe.right);
  const availH = Math.max(0, H - safe.bottom - above);
  const xfH = (H - XFADER_CLEAR_PX - above) / XFADER_BOTTOM;
  const height = Math.max(0, Math.min(availH, xfH));
  const unit = height / 100;
  const mixW = ((SECTIONS[1].x1 - SECTIONS[1].x0) / 100) * height * BOARD_ASPECT;
  const mixL = (availW - mixW) / 2;
  const deckW = Math.max(0, mixL - PHONE.deckGap);
  const sections = [
    { ...SECTIONS[0], left: 0, width: deckW },
    { ...SECTIONS[1], left: mixL, width: mixW },
    { ...SECTIONS[2], left: mixL + mixW + PHONE.deckGap, width: deckW },
  ];
  return {
    mode: "phone", left: safe.left, top: above, width: availW, height, unit, sections, stripTop, stripBottom, safe,
    deck: phoneDeck(deckW, height),
  };
}

/**
 * One deck's parts for the phone layout, deck-relative px (deck 2 is the same
 * deck, as on the hardware).
 * Across: the left column (SHIFT, CUE, PLAY) at CUE's target, the four pad
 * columns, the tempo fader. The pads are as wide as the deck allows, but no
 * wider than PHONE.padAspectMax times their height; width they leave goes to
 * the tempo fader (up to its share), the rest either side of the pads.
 * Down: the loop row at the top edge (its buttons a sixth of the width at
 * most), the jog, the mode row, two pad rows. The gap under the loop row is
 * the least that gives its zones their target height, the one over the mode
 * row the least that gives the mode row its zone. The jog takes the rest
 * (round, at most PHONE.jogShare of the height), the pads PHONE.padJog of it
 * (never under their floor: their short side and their zone), the mode row
 * PHONE.modePad of a pad (never under PHONE.modeMin). When the jog reaches its
 * cap the pads grow back, up to square.
 * The left column on its own: PLAY's bottom on the pads' bottom, CUE over it,
 * SHIFT over CUE, PHONE.columnGap apart.
 * @returns {boxes: {[id without "dN-"]: {x, y, w, h, shape}}, legends: {[text]: {x, y, on?}}, meta}
 */
export function phoneDeck(Wd, Hd) {
  const P = PHONE, tg = phoneTargets(Hd), g = DRAW_GAP_PX;
  const btn = tg.button;                                      // SHIFT and the loop row
  // across
  const avail = Wd - 2 * P.edge - 2 * P.gap - 3 * P.padGap;
  const C = Math.max(btn, Math.min(tg.cue, avail - P.tempoMin - 4 * (btn + 2)));
  const pwMax = Math.max(0, (avail - P.tempoMin - C) / 4);  // the pads beside the narrowest tempo fader
  const padFloor = Math.min(pwMax, Math.max(tg.pad, tg.padZone - P.padGap / 2 - P.edge));
  let modeMin = P.modeMin;
  const modeH = (ph) => Math.max(modeMin, P.modePad * ph);
  // the mode row's zone reaches halfway to the pads and up to the jog's disc
  const modeGap = (mh) => Math.max(g, tg.modeZone - mh - P.padGap / 2);
  const across = (ph) => {
    const pw = Math.min(pwMax, P.padAspectMax * ph);
    const left = 4 * (pwMax - pw);                           // the width the pads leave
    const T = Math.min(P.tempoMax, Math.max(P.tempoMin, Wd * P.tempoShare), P.tempoMin + left);
    const side = (left - (T - P.tempoMin)) / 2;
    const padsX = P.edge + C + P.gap + side;
    return { pw, T, padsX, padsRight: padsX + 4 * pw + 3 * P.padGap, tempoX: Wd - P.edge - T };
  };
  let ph = padFloor, D = 0, jl = g, h = across(ph), lb = 0, loopX = [], pitch = 0, spare = 0, mh = modeH(ph), gm = modeGap(mh);
  for (let pass = 0; pass < 8; pass++) {
    h = across(ph);
    modeMin = modeLegendHeight(h.pw);
    // the loop row, evenly: IN and SYNC where sixths of the width put them,
    // unless SYNC's centre is within 2 px of the tempo fader's left edge (a
    // column too thin to tell apart): then 2 px left of it
    const in0 = Wd / 12, even = (11 * Wd) / 12;
    const sync0 = Math.abs(even - h.tempoX) < 2 ? h.tempoX - 2 : even;
    pitch = (sync0 - in0) / 5;
    loopX = [0, 1, 2, 3, 4, 5].map((i) => in0 + i * pitch);
    lb = Math.max(0, Math.min(btn, pitch - g));
    const loopBottom = P.edge + lb;
    const jcx = (P.edge + h.padsRight) / 2;
    const jogCap = Math.max(0, Math.min(2 * Math.min(jcx - P.edge, h.tempoX - g - jcx), P.jogShare * Hd));
    // the loop row's zone reaches down to the jog's disc: the gap under the row
    // is what the button nearest the jog's centre needs (with this D)
    const nearest = Math.min(...loopX.map((x) => Math.abs(x - jcx)));
    const R = D / 2, dx = Math.min(nearest, R);
    const depth = R > 0 ? R - Math.sqrt(R * R - dx * dx) : 0;
    jl = Math.max(g, tg.zone - loopBottom - depth);
    const room = Hd - loopBottom - jl - 2 * P.padGap - P.edge;   // the jog, the mode row and its gap, the pads
    const padsFor = (d) => Math.min(pwMax, Math.max(padFloor, P.padJog * d));
    const need = (d, p) => d + modeGap(modeH(p)) + modeH(p) + 2 * p;
    if (need(jogCap, padsFor(jogCap)) <= room) {
      // the jog at its cap: the pads grow back, up to square
      D = jogCap;
      const fill = (p) => need(D, p) <= room;
      ph = growMax(padsFor(D), Math.max(padsFor(D), pwMax), fill);
    } else {
      // the largest jog whose pads (and mode row) still fit; at 0 the pads give way
      D = growMax(0, jogCap, (d) => need(d, padsFor(d)) <= room);
      ph = padsFor(D);
      if (need(D, ph) > room) ph = growMax(0, ph, (p) => need(0, p) <= room);
    }
    mh = modeH(ph);
    gm = modeGap(mh);
    spare = Math.max(0, room - need(D, ph));
  }
  const { pw, T, padsX, padsRight, tempoX } = h;
  const loopTop = P.edge, loopBottom = loopTop + lb;
  const jcx = (P.edge + padsRight) / 2;
  const jogY = loopBottom + jl + spare / 2;
  const modeY = jogY + D + gm + spare / 2;
  const padY = modeY + mh + P.padGap;
  const b = {};
  const circle = (cx, cy, d) => ({ x: cx - d / 2, y: cy - d / 2, w: d, h: d, shape: "circle" });
  LOOP_ROW.forEach((id, i) => { b[id] = circle(loopX[i], loopTop + lb / 2, lb); });
  b.jog = circle(jcx, jogY + D / 2, D);
  ["hotcue", "padfx1", "beatjump", "sampler"].forEach((m, i) => {
    b[`mode-${m}`] = { x: padsX + i * (pw + P.padGap), y: modeY, w: pw, h: mh, shape: "rect" };
  });
  for (let i = 0; i < 8; i++) {
    b[`pad${i + 1}`] = { x: padsX + (i % 4) * (pw + P.padGap), y: padY + Math.floor(i / 4) * (ph + P.padGap), w: pw, h: ph, shape: "rect" };
  }
  // the left column, bottom-aligned with the pads: PLAY, CUE over it, SHIFT over CUE
  const padsBottom = padY + 2 * ph + P.padGap;
  const cueD = C, colX = P.edge + C / 2;
  b.play = circle(colX, padsBottom - cueD / 2, cueD);
  b.cue = circle(colX, b.play.y - P.columnGap - cueD / 2, cueD);
  b.shift = { x: P.edge, y: b.cue.y - P.columnGap - btn, w: C, h: btn, shape: "rect" };
  // the tempo fader: under SYNC (its zone's height apart) to the deck's bottom, at its right edge
  const tTop = loopBottom + Math.max(g, tg.zone - loopBottom);
  const tBottom = Hd - P.edge;
  b.tempo = { x: tempoX, y: tTop, w: T, h: tBottom - tTop, shape: "rect" };
  const capH = Math.max(18, Math.min(26, b.tempo.h * 0.12));
  const cx = (r) => r.x + r.w / 2;
  const callMid = (cx(b["call-prev"]) + cx(b["call-next"])) / 2;
  const L = P.legendMin;
  const legends = {
    // CUE/LOOP CALL under the two CALL buttons, beside the jog's shoulder
    "CUE/LOOP": { x: callMid, y: loopBottom + 1 + L / 2 },
    "CALL": { x: callMid, y: loopBottom + 2 + L * 1.5 },
    // 1/2X and 2X on the CALL buttons (deckLegends)
    "1/2X": { x: cx(b["call-prev"]), y: loopTop + lb * 0.75, on: "call-prev" },
    "2X": { x: cx(b["call-next"]), y: loopTop + lb * 0.75, on: "call-next" },
    // the tempo marks in the fader's left tick column
    "−": { x: b.tempo.x + 4.5, y: b.tempo.y + capH / 2, tick: true },
    "0": { x: b.tempo.x + 4.5, y: b.tempo.y + b.tempo.h / 2, tick: true },
    "+": { x: b.tempo.x + 4.5, y: tBottom - capH / 2, tick: true },
  };
  return { boxes: b, legends, tempoCap: { w: T, h: capH },
    meta: { targets: tg, jog: D, pad: { w: pw, h: ph }, mode: mh, column: C, cue: cueD, tempo: T, button: btn, loopButton: lb, pitch, spare } };
}

const LOOP_ROW = ["in", "out", "4beat", "call-prev", "call-next", "sync"];

/** The least height (from PHONE.modeMin, half px steps) at which every mode
 *  button w px wide holds its name at PHONE.modeMain px or more over its SHIFT
 *  legend (short forms allowed): a name that must break onto two lines makes
 *  the row taller. */
const MODE_BUTTONS = CONTROLS.filter((c) => c.deck === 1 && c.look === "mode");
const modeHeights = new Map();
function modeLegendHeight(w) {
  const key = Math.round(w * 100);
  if (modeHeights.has(key)) return modeHeights.get(key);
  let h = PHONE.modeMin;
  const fits = (hh) => MODE_BUTTONS.every((c) => onButton({ x: 0, y: 0, w, h: hh }, false,
    { main: c.face, bottom: { text: c.sub }, base: PHONE.modeMain, mainMin: PHONE.modeMain }).fits);
  while (h < 3 * PHONE.modeMin && !fits(h)) h += 0.5;
  modeHeights.set(key, h);
  return h;
}

/** A fader's cap in px for its drawn box d: the photo's cap scaled with the
 *  box, or (phone decks) the tempo cap phoneDeck chose. */
export function faderCap(fit, c, d) {
  if (fit.mode === "phone" && c.section === "deck" && c.kind === "fader") return { ...fit.deck.tempoCap, w: d.w };
  return { w: (c.cap.w / c.w) * d.w, h: (c.cap.h / c.h) * d.h };
}

/** The two gaps between the sections, in screen CSS px: [{x, y, w, h}, {x, y, w, h}]. */
export function panelSlots(fit) {
  const [d1, mx, d2] = fit.sections;
  return [
    { x: fit.left + d1.left + d1.width, y: fit.top, w: Math.max(0, mx.left - (d1.left + d1.width)), h: fit.height },
    { x: fit.left + mx.left + mx.width, y: fit.top, w: Math.max(0, d2.left - (mx.left + mx.width)), h: fit.height },
  ];
}

/** A panel box (percent) in screen px under a fitBoard result. */
export function placeBox(b, fit) {
  const s = fit.sections.find((t) => t.key === sectionOf(b.x).key);
  const px = fit.unit * BOARD_ASPECT;                    // px per percent of the width
  return {
    left: fit.left + s.left + (b.x - s.x0) * px,
    top: fit.top + b.y * fit.unit,
    width: b.w * px,
    height: b.h * fit.unit,
  };
}

// ---- geometry helpers (board-relative px rects {x, y, w, h}) -------------------------

const R = (x, y, w, h) => ({ x, y, w, h });
const cxOf = (r) => r.x + r.w / 2;
const cyOf = (r) => r.y + r.h / 2;
const rightOf = (r) => r.x + r.w;
const bottomOf = (r) => r.y + r.h;
const EPS = 1e-9;

function rectsOverlap(a, b) {
  return a.x < rightOf(b) - EPS && b.x < rightOf(a) - EPS && a.y < bottomOf(b) - EPS && b.y < bottomOf(a) - EPS;
}

/** Does rect r enter shape s (a rect, or a disc when s.shape === "circle")? */
function enters(r, s) {
  if (!rectsOverlap(r, s)) return false;
  if (s.shape !== "circle") return true;
  const rad = s.w / 2, cx = s.x + rad, cy = s.y + s.h / 2;
  const nx = Math.max(r.x, Math.min(cx, rightOf(r))), ny = Math.max(r.y, Math.min(cy, bottomOf(r)));
  return Math.hypot(nx - cx, ny - cy) < rad - EPS;
}

/** A round part's disc against a rect or disc. */
function shapesMeet(a, b) {
  if (a.shape === "circle" && b.shape === "circle") {
    return Math.hypot(cxOf(a) - cxOf(b), cyOf(a) - cyOf(b)) < a.w / 2 + b.w / 2 - EPS;
  }
  if (a.shape === "circle") return enters(b, a);
  return enters(a, b);
}

const inflate = (r, d) => ({ ...r, x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

/** Board-relative px box of a panel box (percent). */
function relBox(b, fit) {
  const p = placeBox(b, fit);
  return R(p.left - fit.left, p.top - fit.top, p.width, p.height);
}

function sectionRect(fit, key) {
  const s = fit.sections.find((t) => t.key === key);
  return R(s.left, 0, s.width, fit.height);
}

const isBig = (c) => BIG_KINDS.includes(c.kind);
const isRound = (c) => c.kind === "knob" || c.kind === "encoder" || c.look === "round" || c.look === "big";

/** Half the extent of a centred rect (hx, hy) or disc (r) along unit vector u. */
function support(shape, ux, uy) {
  return shape.r !== undefined ? shape.r : shape.hx * Math.abs(ux) + shape.hy * Math.abs(uy);
}

// ---- drawn sizes ---------------------------------------------------------------------

/** Largest v in [lo, hi] with pass(v) (pass(lo) holds; pass is monotone). */
function growMax(lo, hi, pass) {
  if (hi <= lo) return lo;
  if (pass(hi)) return hi;
  let a = lo, z = hi;
  for (let i = 0; i < 40; i++) {
    const m = (a + z) / 2;
    if (pass(m)) a = m; else z = m;
  }
  return a;
}

/**
 * Every control's drawn box, board-relative px.
 * @returns Map id -> {x, y, w, h, shape: "rect"|"circle", section, base: {x,y,w,h},
 *          limit: null | "neighbour" | "big" | "section" (why it stopped short of its minimum),
 *          cellW, cellH (pads: their grid cell)}
 */
export function placeControls(fit, controls = CONTROLS) {
  const out = new Map();
  const secOf = (c) => sectionOf(c.x).key;
  // phone: the decks' parts come from phoneDeck, final; the mixer as everywhere
  const phoneBox = (c) => {
    if (fit.mode !== "phone" || c.section !== "deck") return null;
    const r = fit.deck.boxes[c.id.replace(/^d[12]-/, "")];
    const sec = fit.sections.find((t) => t.key === secOf(c));
    return r ? { x: sec.left + r.x, y: r.y, w: r.w, h: r.h, shape: r.shape } : null;
  };
  const base = new Map(controls.map((c) => {
    const p = phoneBox(c);
    return [c.id, p ? R(p.x, p.y, p.w, p.h) : relBox(c, fit)];
  }));
  for (const c of controls) {
    const p = phoneBox(c);
    if (p) out.set(c.id, { ...R(p.x, p.y, p.w, p.h), shape: p.shape, section: secOf(c), base: base.get(c.id), limit: null });
  }

  // pads first: the grid fills the deck's pad area
  for (const deck of [1, 2]) {
    const pads = controls.filter((c) => c.kind === "pad" && c.deck === deck);
    if (!pads.length || out.has(pads[0].id)) continue;
    const bs = pads.map((c) => base.get(c.id));
    const area = R(Math.min(...bs.map((b) => b.x)), Math.min(...bs.map((b) => b.y)), 0, 0);
    area.w = Math.max(...bs.map(rightOf)) - area.x;
    area.h = Math.max(...bs.map(bottomOf)) - area.y;
    const cols = 4, rows = Math.ceil(pads.length / cols);
    const cellW = (area.w - (cols - 1) * PAD_GAP_PX) / cols;
    const cellH = (area.h - (rows - 1) * PAD_GAP_PX) / rows;
    const side = Math.min(cellW, cellH);
    for (const c of pads) {
      const col = c.index % cols, row = Math.floor(c.index / cols);
      const x = area.x + col * (cellW + PAD_GAP_PX) + (cellW - side) / 2;
      const y = area.y + row * (cellH + PAD_GAP_PX) + (cellH - side) / 2;
      out.set(c.id, { ...R(x, y, side, side), shape: "rect", section: secOf(c), base: base.get(c.id), limit: null, cellW, cellH });
    }
  }

  // big parts and the meters are fixed obstacles
  const obstacles = [];
  for (const c of controls) {
    if (!isBig(c)) continue;
    const b = base.get(c.id);
    const d = out.get(c.id) || { ...b, shape: c.kind === "jog" ? "circle" : "rect", section: secOf(c), base: b, limit: null };
    out.set(c.id, d);
    obstacles.push({ ...d, id: c.id });
  }
  for (const m of INDICATORS) obstacles.push({ ...relBox(m, fit), shape: "rect", section: sectionOf(m.x).key, id: m.id });

  const smalls = controls.filter((c) => !isBig(c) && c.kind !== "pad" && !out.has(c.id));
  for (const c of smalls) {
    const b = base.get(c.id);
    const sec = sectionRect(fit, secOf(c));
    const cx = cxOf(b), cy = cyOf(b);
    const round = isRound(c);
    const min = c.kind === "knob" || c.kind === "encoder" ? KNOB_MIN_PX : c.kind === "lever" ? LEVER_MIN_PX : BUTTON_MIN_PX;
    // the neighbours' half-planes: for each, how far this part may reach toward it
    const others = [];
    for (const n of controls) {
      if (n.id === c.id || isBig(n) || secOf(n) !== secOf(c)) continue;
      const nb = n.kind === "pad" ? out.get(n.id) : base.get(n.id);
      const dx = cxOf(nb) - cx, dy = cyOf(nb) - cy;
      const dist = Math.hypot(dx, dy);
      if (!(dist > 0)) continue;
      const ux = dx / dist, uy = dy / dist;
      // the split sits halfway, unless a part's own (ungrown) shape already reaches past it
      const mine = round ? { r: Math.max(b.w, b.h) / 2 } : { hx: b.w / 2, hy: b.h / 2 };
      const theirs = isRound(n) ? { r: Math.max(nb.w, nb.h) / 2 } : { hx: nb.w / 2, hy: nb.h / 2 };
      const split = Math.max(support(mine, ux, uy), Math.min(dist / 2, dist - support(theirs, ux, uy)));
      others.push({ ux, uy, reach: split - DRAW_GAP_PX / 2 });
    }
    const obs = obstacles.filter((o) => o.section === secOf(c)).map((o) => inflate(o, DRAW_GAP_PX));
    const ok = (w, h) => {
      const shape = round ? { r: w / 2 } : { hx: w / 2, hy: h / 2 };
      const r = R(cx - w / 2, cy - h / 2, w, h);
      if (r.x < sec.x - EPS || rightOf(r) > rightOf(sec) + EPS || r.y < sec.y - EPS || bottomOf(r) > bottomOf(sec) + EPS) {
        return "section";
      }
      for (const o of others) if (support(shape, o.ux, o.uy) > o.reach + EPS) return "neighbour";
      const me = round ? { ...r, shape: "circle" } : { ...r, shape: "rect" };
      for (const o of obs) if (shapesMeet(me, o)) return "big";
      return null;
    };
    const fits = (fn) => (v) => !fn(v);
    let w, h;
    if (round) {
      const d0 = Math.max(b.w, b.h);
      w = h = growMax(d0, Math.max(d0, min), fits((v) => ok(v, v)));
    } else {
      // first the short side, keeping the part as square as it can (both sides
      // up to t), then each side on its own to its target
      const s = Math.max(1, min / Math.min(b.w, b.h));
      const longT = Math.max(Math.max(b.w, b.h), Math.min(Math.max(b.w, b.h) * s, BUTTON_LONG_MAX_PX));
      const t = growMax(Math.min(b.w, b.h), min, fits((v) => ok(Math.max(b.w, v), Math.max(b.h, v))));
      w = Math.max(b.w, t);
      h = Math.max(b.h, t);
      const tw = b.w >= b.h ? longT : Math.max(min, b.w), th = b.h > b.w ? longT : Math.max(min, b.h);
      h = growMax(h, Math.max(h, Math.min(th, BUTTON_ASPECT_MAX * w)), fits((v) => ok(w, v)));
      w = growMax(w, Math.max(w, Math.min(tw, BUTTON_ASPECT_MAX * h)), fits((v) => ok(v, h)));
    }
    const why = ok(w + 0.05, h + 0.05);
    const short = Math.min(w, h);
    out.set(c.id, {
      ...R(cx - w / 2, cy - h / 2, w, h), shape: round ? "circle" : "rect", section: secOf(c), base: b,
      limit: short < min - 0.05 ? why || "neighbour" : null,
    });
  }
  // keep CONTROLS' order
  return new Map(controls.map((c) => [c.id, out.get(c.id)]));
}

// ---- hit zones -----------------------------------------------------------------------

/**
 * Where every touch goes, board-relative px.
 * @returns {at(x, y) -> id | null, region(id) -> {x, y, w, h} (the most a small
 *          zone may cover), extent(id) -> {w, h, limit}}
 * at(): inside a big part's shape (the jog's disc, a fader's box) = that part;
 * inside a small part's drawn shape = that part; else, among the small parts of
 * the same section whose region holds the point (the drawn box grown by
 * HIT_MARGIN_PX each side and to HIT_MIN_PX, clamped to the section), the one
 * whose drawn outline is nearest (ties: the nearer centre); else nothing.
 * Between two parts of the same size this is the Voronoi split of their
 * centres; between a wide part and a small one the border sits in the middle
 * of the gap between what is drawn, so a thumb 10 px off the wide part's edge
 * still lands on it.
 * extent(): the zone measured through the part's centre, across and down, and
 * when it is under HIT_MIN_PX what stopped it ("neighbour", "big", "section").
 */
/** Distance from (x, y) to drawn part d's outline (0 inside it). */
export function edgeDistance(x, y, d) {
  if (d.shape === "circle") return Math.max(0, Math.hypot(x - cxOf(d), y - cyOf(d)) - d.w / 2);
  const dx = Math.max(d.x - x, 0, x - rightOf(d)), dy = Math.max(d.y - y, 0, y - bottomOf(d));
  return Math.hypot(dx, dy);
}

export function hitMap(fit, drawn, controls = CONTROLS, { rows = true } = {}) {
  const big = [], small = [];
  for (const c of controls) {
    const d = drawn.get(c.id);
    if (isBig(c)) { big.push({ id: c.id, d }); continue; }
    const sec = sectionRect(fit, d.section);
    const w = Math.max(HIT_MIN_PX, d.w + 2 * HIT_MARGIN_PX), h = Math.max(HIT_MIN_PX, d.h + 2 * HIT_MARGIN_PX);
    const x0 = Math.max(sec.x, cxOf(d) - w / 2), x1 = Math.min(rightOf(sec), cxOf(d) + w / 2);
    const y0 = Math.max(sec.y, cyOf(d) - h / 2), y1 = Math.min(bottomOf(sec), cyOf(d) + h / 2);
    small.push({ id: c.id, d, cx: cxOf(d), cy: cyOf(d), region: R(x0, y0, x1 - x0, y1 - y0), section: d.section });
  }
  const inShape = (x, y, d) => {
    if (x < d.x || x >= rightOf(d) || y < d.y || y >= bottomOf(d)) return false;
    if (d.shape !== "circle") return true;
    return Math.hypot(x - cxOf(d), y - cyOf(d)) <= d.w / 2;
  };
  const inRect = (x, y, r) => x >= r.x && x < rightOf(r) && y >= r.y && y < bottomOf(r);
  const { spans, rowZones } = fit.mode === "phone" && rows ? knobRows(drawn) : { spans: null, rowZones: new Map() };
  function at(x, y) {
    for (const b of big) if (inShape(x, y, b.d)) return b.id;
    for (const s of small) if (inShape(x, y, s.d)) return s.id;
    let best = null, bd = Infinity, bc = Infinity;
    for (const s of small) {
      if (!inRect(x, y, s.region)) continue;
      const dist = edgeDistance(x, y, s.d), dc = Math.hypot(x - s.cx, y - s.cy);
      if (dist < bd - 1e-9 || (Math.abs(dist - bd) <= 1e-9 && dc < bc)) { bd = dist; bc = dc; best = s.id; }
    }
    // a knob's row only adds area: it takes a point nobody else answers, or one
    // a knob of its own channel would (never BROWSE, LOAD, a CUE or the Beat FX)
    for (const [id, z] of rowZones) {
      if (!inRect(x, y, z)) continue;
      if (best === null || sameChannelKnob(best, id)) return id;
      break;
    }
    return best;
  }
  const byId = new Map(small.map((s) => [s.id, s]));
  /** What sits at (x, y) when it is not `id`: why a walk from id's centre stopped. */
  function blocker(id, x, y) {
    const s = byId.get(id);
    const sec = sectionRect(fit, s.section);
    if (!inRect(x, y, sec)) return "section";
    for (const b of big) if (inShape(x, y, b.d)) return "big";
    if (!inRect(x, y, s.region)) return null;              // its own region ends here
    return "neighbour";
  }
  function extent(id) {
    const s = byId.get(id);
    if (!s) { const b = big.find((t) => t.id === id); return { w: b.d.w, h: b.d.h, limit: null }; }
    const step = 0.25;
    const walk = (dx, dy) => {
      let k = 0;
      while (k < 400 && at(s.cx + dx * (k + 1) * step, s.cy + dy * (k + 1) * step) === id) k++;
      return { len: k * step, why: blocker(id, s.cx + dx * (k + 1) * step, s.cy + dy * (k + 1) * step) };
    };
    const l = walk(-1, 0), r = walk(1, 0), t = walk(0, -1), b = walk(0, 1);
    const w = l.len + r.len + step, h = t.len + b.len + step;
    const whys = [l, r, t, b].map((q) => q.why).filter(Boolean);
    const limit = w < HIT_MIN_PX - 0.5 || h < HIT_MIN_PX - 0.5
      ? ["neighbour", "big", "section"].find((k) => whys.includes(k)) || null : null;
    return { w, h, limit };
  }
  return {
    at, extent, region: (id) => byId.get(id)?.region || null,
    /** phone: a channel knob's row zone {x, y, w, h}, else null. */
    rowZone: (id) => (rowZones.has(id) ? { ...rowZones.get(id) } : null),
    /** phone: channel n's span across the mixer {x, w}, else null. */
    channelSpan: (n) => (spans ? { ...spans[n] } : null),
  };
}

/** Ruling R3-v2, phone layout: each channel knob (TRIM, HI, MID, LOW, CFX)
 *  answers across its whole row inside its channel, so a vertical drag can
 *  start anywhere on the row. A channel runs from halfway between the
 *  mixer's outer column (MIC, SMART, phones | MASTER, Beat FX) and its knobs
 *  to the middle between the two channels' knobs; a row from halfway to the
 *  row above (TRIM: to LOAD) to halfway to the row below (CFX: to the channel
 *  CUE). Drawn parts keep their own touches, and a row only adds area: it
 *  takes a point the nearest-outline rule gives to nobody or to a knob of the
 *  same channel, never one it gives to another part (BROWSE, LOAD, a CUE). */
const KNOB_ROWS = ["trim", "hi", "mid", "low", "cfx"];
const KNOB_ID = /^ch([12])-(trim|hi|mid|low|cfx)$/;
const sameChannelKnob = (a, b) => {
  const ka = KNOB_ID.exec(a), kb = KNOB_ID.exec(b);
  return !!(ka && kb && ka[1] === kb[1]);
};
const LEFT_COLUMN = ["mic-level", "smart-cfx", "phones-mix", "phones-level", "smart-fader"];
const RIGHT_COLUMN = ["master-level", "master-cue", "fx-ch", "fx-select", "fx-beat-down", "fx-beat-up", "fx-level", "fx-on"];
function knobRows(drawn) {
  const get = (id) => drawn.get(id);
  const knobs = (n) => KNOB_ROWS.map((r) => get(`ch${n}-${r}`)).filter(Boolean);
  const outer = (ids) => ids.map(get).filter(Boolean);
  if (knobs(1).length < KNOB_ROWS.length || knobs(2).length < KNOB_ROWS.length) return { spans: null, rowZones: new Map() };
  const leftEdge = (Math.max(...outer(LEFT_COLUMN).map(rightOf)) + Math.min(...knobs(1).map((k) => k.x))) / 2;
  const mid = (cxOf(get("ch1-hi")) + cxOf(get("ch2-hi"))) / 2;
  const rightEdge = (Math.max(...knobs(2).map(rightOf)) + Math.min(...outer(RIGHT_COLUMN).map((k) => k.x))) / 2;
  const spans = { 1: { x: leftEdge, w: mid - leftEdge }, 2: { x: mid, w: rightEdge - mid } };
  const rowZones = new Map();
  for (const n of [1, 2]) {
    const cys = KNOB_ROWS.map((r) => cyOf(get(`ch${n}-${r}`)));
    const above = cyOf(get(`load${n}`) || get(`ch${n}-trim`));
    const below = cyOf(get(`ch${n}-cue`) || get(`ch${n}-cfx`));
    KNOB_ROWS.forEach((r, i) => {
      const k = get(`ch${n}-${r}`);
      // never shorter than the knob itself (TRIM sits closer to LOAD than to HI)
      const y0 = Math.min(k.y, (cys[i] + (i === 0 ? above : cys[i - 1])) / 2);
      const y1 = Math.max(bottomOf(k), (cys[i] + (i === KNOB_ROWS.length - 1 ? below : cys[i + 1])) / 2);
      rowZones.set(`ch${n}-${r}`, { x: spans[n].x, y: y0, w: spans[n].w, h: y1 - y0 });
    });
  }
  return { spans, rowZones };
}

// ---- legends -------------------------------------------------------------------------

/** Advance widths of Archivo 700 (the faces; 600 is a hair narrower), in em,
 *  measured in Chromium with canvas measureText. Legends are upper case. */
const ADVANCE = {
  A: 0.72, B: 0.72, C: 0.73, D: 0.74, E: 0.68, F: 0.62, G: 0.8, H: 0.75, I: 0.3, J: 0.6, K: 0.73, L: 0.59,
  M: 0.87, N: 0.75, O: 0.79, P: 0.68, Q: 0.79, R: 0.73, S: 0.68, T: 0.64, U: 0.75, V: 0.69, W: 0.96, X: 0.71,
  Y: 0.7, Z: 0.65, " ": 0.2, "/": 0.3, "&": 0.76, ".": 0.31, "-": 0.33, "+": 0.64, "\u2212": 0.64,
  "\u25C0": 0.77, "\u25B6": 0.77, "\u25BC": 0.99, "\u25B2": 0.99,
};
/** Slack on the measured widths (WebKit's text runs a little wider). */
const TEXT_SLACK = 1.04;

/** The hardware's own short forms, longest first, used only where the full
 *  legend cannot fit at LEGEND_MIN_PX. */
export const SHORT = {
  "KEYBOARD": ["KEYBD", "KEY"],
  "MEMORY": ["MEMO", "MEM"],
  "TEMPO RANGE": ["RANGE"],
  "BEAT LOOP": ["B.LOOP", "LOOP"],
  "BEAT JUMP": ["B.JUMP"],
  "KEY SHIFT": ["KEY SFT", "KEY"],
  "PAD FX2": ["FX2"],
  "PAD FX1": ["FX1"],
  "SAMPLER": ["SMPL"],
  "SMART CFX": ["CFX"],
  "SMART FADER": ["FADER"],
  "RELEASE FX": ["REL FX", "REL"],
  "LEVEL/DEPTH": ["LVL/DEPTH", "DEPTH"],
  "4 BEAT/EXIT": ["4BEAT/EXIT", "4 BEAT"],
  "MASTER LEVEL": ["MASTER"],
  "MIC LEVEL": ["MIC"],
  "FX SELECT": ["FX SEL"],
  "PLAY/PAUSE": ["PLAY"],
  "IN ADJ": ["ADJ"],
  "OUT ADJ": ["ADJ"],
  "ACTIVE": ["ACT"],
  "CUE/LOOP": ["CUE/LP"],
  "PERFORMANCE": ["PERF"],
  "DJ CONTROLLER": ["DJ CTRL"],
  "−MASTER": ["−MST"],
};

/** Width of text in em (one line, upper case). */
export function textEm(text) {
  let em = 0;
  for (const ch of String(text).replace(/\uFE0E/g, "").toUpperCase()) em += ADVANCE[ch] ?? (/[0-9]/.test(ch) ? 0.6 : 0.75);
  return em * TEXT_SLACK;
}

/** Text width in px at size px (one line). */
export function textWidth(text, px, extraEm = 0) {
  return (textEm(text) + extraEm) * px;
}

/**
 * The size and text for a legend in a room roomW (x roomH) px:
 * the largest size up to `base` that fits; under LEGEND_MIN_PX, the short form;
 * never under LEGEND_MIN_PX (fits = false says it still overflows).
 */
export function fitText(text, roomW, { base, roomH = Infinity, extraEm = 0, wrap = false, disc = 0 } = {}) {
  const best = (t) => {
    const shapes = [[t]];
    if (wrap && t.includes(" ")) shapes.push(t.split(" "));
    let out = null;
    for (const lines of shapes) {
      const g = Math.max(...lines.map(textEm));
      let px = Math.min(base, roomW / (g + extraEm), roomH / lines.length);
      // on a round face (disc = its inner radius) a block of lines is as wide
      // as the chord at its top and bottom edge
      for (let i = 0; disc && i < 6; i++) {
        const half = (lines.length * px) / 2;
        const chord = half < disc ? 2 * Math.sqrt(disc * disc - half * half) : 0;
        px = Math.min(base, chord / (g + extraEm), roomH / lines.length);
      }
      if (!out || px > out.px + 1e-9) out = { text: t, lines, px };
    }
    return out;
  };
  let f = best(text);
  for (const short of SHORT[text] || []) {
    if (f.px >= LEGEND_MIN_PX) break;
    const s = best(short);
    if (s.px > f.px) f = s;
  }
  const fits = f.px >= LEGEND_MIN_PX - 1e-9;
  return { text: f.text, lines: f.lines, px: Math.max(LEGEND_MIN_PX, f.px), fits };
}

const pxw = (fit) => fit.unit * BOARD_ASPECT;

/** Sizes to try for a legend: the full text from `base` down to `min`
 *  (LEGEND_MIN_PX), then each short form the same way. */
function* sizes(text, base, min = LEGEND_MIN_PX) {
  for (const t of [text, ...(SHORT[text] || [])]) {
    for (let px = base; px >= min - 1e-9; px -= 0.25) yield { text: t, px: Math.max(px, min) };
    if (base < min) yield { text: t, px: min };
  }
}

// ---- phone decks: legends on the buttons (Task V3) ------------------------------------

/** Short forms for a legend printed on its button, longest first: the
 *  hardware's (SHORT) plus a few made for the phone. */
const ON_SHORT = {
  ...SHORT,
  "TEMPO RANGE": ["T.RANGE", "RANGE"],
  "BEAT SYNC": ["SYNC"],
  "\u2212MASTER": ["MASTER", "MST"],
};

/** The ways to set a button's main legend: one line, broken at its "/" or
 *  its spaces, then each short form; cost grows down the list. */
function mainForms(text) {
  const out = [{ lines: [text], cost: 0 }];
  const t = String(text);
  const slash = t.indexOf("/");
  if (t.length > 6 && slash > 0 && slash < t.length - 1) out.push({ lines: [t.slice(0, slash + 1), t.slice(slash + 1)], cost: 0.5 });
  else if (t.includes(" ")) out.push({ lines: t.split(" "), cost: 0.5 });
  (ON_SHORT[text] || []).forEach((sh, k) => {
    out.push({ lines: [sh], cost: 1 + k });
    if (sh.includes(" ")) out.push({ lines: sh.split(" "), cost: 1.5 + k });
  });
  return out;
}

/** A button's main legend prints at least this share of its base size before
 *  a shorter form is taken for it or its captions. */
const MAIN_FLOOR = 0.65;

/** A caption's forms (one line each), then, when it may go, nothing. */
function captionForms(slot) {
  if (!slot) return [null];
  const out = [slot.text, ...(ON_SHORT[slot.text] || [])].map((t, k) => ({ text: t, cost: k }));
  if (slot.optional) out.push({ text: null, cost: 3 });
  return out;
}

/**
 * Legends on a button d (board-relative px; round or rect): an optional
 * caption on top, the main legend, an optional caption at the bottom (its
 * SHIFT legend), stacked 1 px apart (0.5 where 1 leaves no room) and centred. Captions at `min` px, the
 * main legend from `base` down to `min`. The least shortened set whose main
 * legend still prints at MAIN_FLOOR of `base` (and over `min`) wins; when none
 * does, the one with the biggest main legend.
 * @returns {top, main, bottom} each {text, lines, px, x, y, w, h} | null, fits
 */
export function onButton(d, round, { top = null, main, bottom = null, base, floorBase = base, min = PHONE.legendMin, mainMin = min }) {
  const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
  const ri = d.w / 2 - 1;                          // inside the bezel's 1 px ring
  const lineOk = (w, y0, y1) => {
    if (!round) return w <= d.w - 3 + 1e-9 && y0 >= -d.h / 2 + 1 - 1e-9 && y1 <= d.h / 2 - 1 + 1e-9;
    const far = Math.max(Math.abs(y0), Math.abs(y1));
    return far < ri && w <= 2 * Math.sqrt(ri * ri - far * far) - 1 + 1e-9;
  };
  const floor = Math.min(base, Math.max(mainMin + 1, MAIN_FLOOR * floorBase));
  const better = (a, b) => {
    const okA = a.px >= floor - 1e-9, okB = b.px >= floor - 1e-9;
    if (okA !== okB) return okA;
    if (okA) return a.cost < b.cost - 1e-9 || (Math.abs(a.cost - b.cost) < 1e-9 && a.px > b.px + 1e-9);
    return a.px > b.px + 1e-9 || (Math.abs(a.px - b.px) < 1e-9 && a.cost < b.cost - 1e-9);
  };
  /** The best set with `lg` px between the lines, or null. */
  const search = (lg) => {
    let best = null;
    for (const mf of mainForms(main)) {
      for (const tf of captionForms(top)) {
        for (const bf of captionForms(bottom)) {
          const cost = mf.cost + (tf ? tf.cost : 0) + (bf ? bf.cost : 0);
          const capT = tf && tf.text ? min : 0, capB = bf && bf.text ? min : 0;
          for (let px = base; px >= mainMin - 1e-9; px -= 0.25) {
            const H = (capT ? capT + lg : 0) + mf.lines.length * px + (capB ? capB + lg : 0);
            let y = -H / 2;
            const rows = [];
            if (capT) { rows.push({ slot: "top", text: tf.text, px: capT, y0: y, w: textWidth(tf.text, capT) }); y += capT + lg; }
            const mainTop = y;
            // the main lines as one block, as wide as its widest line
            const mw = Math.max(...mf.lines.map((ln) => textWidth(ln, px)));
            for (const ln of mf.lines) { rows.push({ slot: "main", text: ln, px, y0: y, w: mw }); y += px; }
            if (capB) { y += lg; rows.push({ slot: "bottom", text: bf.text, px: capB, y0: y, w: textWidth(bf.text, capB) }); }
            if (!rows.every((r) => lineOk(r.w, r.y0, r.y0 + r.px))) continue;
            if (!best || better({ px, cost }, best)) {
              const box = (r) => (r ? { text: r.text, lines: [r.text], px: r.px, x: cx - r.w / 2, y: cy + r.y0, w: r.w, h: r.px } : null);
              best = {
                px, cost,
                top: box(rows.find((r) => r.slot === "top")),
                bottom: box(rows.find((r) => r.slot === "bottom")),
                main: { text: mf.lines.join(" "), lines: mf.lines, px, x: cx - mw / 2, y: cy + mainTop, w: mw, h: mf.lines.length * px },
              };
            }
            break;                                   // the largest size for this set
          }
        }
      }
    }
    return best;
  };
  const best = search(1) || search(0.5);
  if (best) return { top: best.top, main: best.main, bottom: best.bottom, fits: true };
  // nothing fits: the shortest forms at the smallest size, stacked from the centre
  const sh = (slot) => (slot ? [slot.text, ...(ON_SHORT[slot.text] || [])].at(-1) : null);
  const m = mainForms(main).at(-1).lines;
  const mw = Math.max(...m.map((t) => textWidth(t, mainMin)));
  const y0 = cy - (m.length * mainMin) / 2;
  const cap = (t, y) => (t ? { text: t, lines: [t], px: min, x: cx - textWidth(t, min) / 2, y, w: textWidth(t, min), h: min } : null);
  return { fits: false, top: cap(sh(top), y0 - min), bottom: cap(sh(bottom), y0 + m.length * mainMin),
    main: { text: m.join(" "), lines: m, px: mainMin, x: cx - mw / 2, y: y0, w: mw, h: m.length * mainMin } };
}

const NUDGE = [0, 2, -2, 4, -4, 6, -6, 8, -8];

/**
 * Where every legend goes and how big, board-relative px.
 * @returns [{key, owner, part: "label"|"sub"|"face"|"legend", text, lines, px, fits,
 *            x, y, w, h (the text's box), side: "above"|"below"|"left"|"right"|"on"|"in"|"at",
 *            boxed (a boxed SHIFT legend), section}]
 * A legend is placed at the first spot, from the largest size down, where its
 * box stays in its section and clear of every part but its own, the meters
 * and the legends placed before it (faces, then labels, free legends, SHIFT
 * legends). fits = false: no clear spot even at the shortest form and
 * LEGEND_MIN_PX (it is drawn at its first spot).
 */
export function legendPlan(fit, drawn, controls = CONTROLS) {
  const u = fit.unit;
  const base = Math.max(LEGEND_MIN_PX, u * 1.85);
  const gap = Math.max(1, u * 0.5);
  const plan = [];
  const solids = [];                                   // what a legend must not cover
  for (const c of controls) solids.push({ ...drawn.get(c.id), id: c.id });
  for (const m of INDICATORS) solids.push({ ...relBox(m, fit), shape: "rect", id: m.id, section: sectionOf(m.x).key });
  const taken = [];
  const faders = new Set(controls.filter((c) => c.kind === "fader").map((c) => c.id));
  const clear = (r, owner, sec) => {
    const s = sectionRect(fit, sec);
    if (r.x < s.x + 0.5 || rightOf(r) > rightOf(s) - 0.5 || r.y < 0.5 || bottomOf(r) > fit.height - 0.5) return false;
    for (const o of solids) {
      // the printed marks beside a fader (TEMPO -/0/+, the channel numbers) sit in its tick area
      if (owner === null && faders.has(o.id)) continue;
      if (o.id !== owner && o.section === sec && enters(r, o)) return false;
    }
    for (const t of taken) if (t.section === sec && rectsOverlap(r, t)) return false;
    return true;
  };
  /** First clear spot over sizes x spots(w, h); else (optional) hidden, or
   *  the first spot at the smallest size. */
  const place = (entry, text, b, extraEm, hMul, spots, owner, sec, keep = true, optional = false, min = LEGEND_MIN_PX) => {
    for (const z of sizes(text, b, min)) {
      const tw = textWidth(z.text, z.px, extraEm), th = z.px * hMul;
      for (const sp of spots(tw, th, z)) {
        if (sp.inside ? sp.inside(sp.r) : clear(sp.r, owner, sec)) {
          return commit(entry, z, sp, true, sec, keep);
        }
      }
    }
    if (optional) {
      const out = { ...entry, text, lines: [text], px: LEGEND_MIN_PX, fits: true, hidden: true, x: 0, y: 0, w: 0, h: 0, side: "none", section: sec };
      plan.push(out);
      return out;
    }
    // nothing clear: the shortest form at the smallest size, at its first spot
    const shortest = [text, ...(SHORT[text] || [])].at(-1);
    const z = { text: shortest, px: min };
    const sp = spots(textWidth(z.text, z.px, extraEm), z.px * hMul, z)[0];
    return commit(entry, z, sp, false, sec, keep);
  };
  const commit = (entry, z, sp, fits, sec, keep) => {
    const r = sp.r;
    const out = { ...entry, text: z.text, lines: [z.text], px: z.px, fits, x: r.x, y: r.y, w: r.w, h: r.h, side: sp.side, section: sec };
    if (sp.side === "in") out.boxed = false;             // on the part itself: plain text
    plan.push(out);
    if (keep) taken.push({ ...r, section: sec });
    return out;
  };

  /** Spots around part d: its printed side (first), nudged; beside it, outward
   *  first; its printed side again up to 6 px onto its own edge (a knob's
   *  scale arc); the opposite side. onlyFirst: the printed side, nudged, only. */
  const aroundSpots = (d, sec, first, yFirst, onlyFirst = false) => (tw, th) => {
    const outward = cxOf(d) < sectionRect(fit, sec).x + sectionRect(fit, sec).w / 2 ? "left" : "right";
    const out = [];
    const main = first === "above" ? d.y - gap - th : yFirst;
    const away = first === "above" ? [0, -2, -4] : [0, 2, 4];
    const onto = first === "above" ? [1, 2, 3, 4, 5, 6] : [-1, -2, -3, -4];
    const printed = (dys) => {
      for (const dy of dys) for (const dx of NUDGE) out.push({ side: first, r: R(cxOf(d) - tw / 2 + dx, main + dy, tw, th) });
    };
    printed(away);
    if (onlyFirst) return out;
    const sideSpot = (side) => {
      for (const dy of [0, -2, 2, -4, 4, -6, 6]) {
        const x = side === "left" ? d.x - gap - tw : rightOf(d) + gap;
        out.push({ side, r: R(x, cyOf(d) - th / 2 + dy, tw, th) });
      }
    };
    sideSpot(outward);
    sideSpot(outward === "left" ? "right" : "left");
    printed(onto);
    const other = first === "above" ? bottomOf(d) + gap : d.y - gap - th;
    for (const dx of [0, 2, -2, 4, -4]) out.push({ side: first === "above" ? "below" : "above", r: R(cxOf(d) - tw / 2 + dx, other, tw, th) });
    return out;
  };

  const faceRooms = new Map();
  // a SHIFT legend for a layer v1 has (the others may be left off)
  const works = (c) => (c.sub === "\u25B2\uFE0E" || (!c.subPlain && c.shift && c.shift !== "board.notYet"));
  // phone decks (Task V3): every button's legends on the button itself
  const onDeck = new Set(), freeOn = new Map();
  const phoneDeck = (c) => fit.mode === "phone" && c.section === "deck";
  if (fit.mode === "phone") {
    const L = PHONE.legendMin;
    LEGENDS.forEach((l, i) => {
      const sec = sectionOf(l.x).key;
      const a = sec !== "mixer" ? fit.deck.legends[l.text] : null;
      if (a && a.on) freeOn.set(`d${sec.slice(-1)}-${a.on}`, i);
    });
    // parts that read as a row print their main legends at one size (the
    // smallest any of them needs)
    const ROWS_ALIKE = [["in", "out"], ["call-prev", "call-next"], ["cue", "play"],
      ["mode-hotcue", "mode-padfx1", "mode-beatjump", "mode-sampler"]];
    const rowOf = (c) => ROWS_ALIKE.find((r) => r.includes(c.id.slice(3)));
    // on each button: its name (the label, or the face), a name over a face
    // (SYNC's -MASTER), its SHIFT legend (or 1/2X, 2X on the CALL buttons;
    // a SHIFT legend for a layer v1 lacks, DEL, MEMORY, PLAY/PAUSE, may go)
    const fitOn = (c, cap) => {
      const d = drawn.get(c.id);
      const free = freeOn.get(c.id);
      const main = c.face || c.label;
      const top = c.face && c.label ? { text: c.label } : null;
      // (the mode row keeps every SHIFT legend: its height is made for them, Task V4)
      const bottom = free !== undefined ? { text: LEGENDS[free].text } : c.sub && !c.subPlain && (works(c) || c.look === "mode")
        ? { text: c.sub } : c.sub && !c.subPlain ? { text: c.sub, optional: true } : null;
      const short = Math.min(d.w, d.h);
      // the thin mode buttons (Task V4): the name at PHONE.modeMain px or more,
      // as big as the room over its SHIFT legend allows
      const mode = c.look === "mode";
      const base = mode ? Math.max(PHONE.modeMain, Math.min(11, d.h - 3 - L)) : Math.max(L, Math.min(14, short * 0.28));
      return onButton(d, isRound(c), { top, main, bottom, base: Math.max(mode ? PHONE.modeMain : 0, Math.min(base, cap)), floorBase: base,
        mainMin: mode ? PHONE.modeMain : L });
    };
    const firstPass = new Map();
    for (const c of controls) if (phoneDeck(c) && c.kind === "button") firstPass.set(c.id, fitOn(c, Infinity));
    for (const c of controls) {
      if (!phoneDeck(c) || c.kind !== "button") continue;
      const d = drawn.get(c.id);
      const free = freeOn.get(c.id);
      const row = rowOf(c);
      const cap = row ? Math.min(...row.map((r) => firstPass.get(`d${c.deck}-${r}`)?.main.px ?? Infinity)) : Infinity;
      const got = cap < firstPass.get(c.id).main.px - 1e-9 ? fitOn(c, cap) : firstPass.get(c.id);
      const top = c.face && c.label;
      const push = (key, part, owner, z, extra = {}) => {
        const out = { key, owner, part, boxed: false, text: z.text, lines: z.lines, px: z.px, fits: got.fits,
          x: z.x, y: z.y, w: z.w, h: z.h, side: "in", section: d.section, ...extra };
        plan.push(out);
        taken.push({ ...R(z.x, z.y, z.w, z.h), section: d.section });
      };
      if (c.face) {
        const m = got.main;
        plan.push({ key: `${c.id}:face`, owner: c.id, part: "face", boxed: false, text: m.text, lines: m.lines, px: m.px,
          fits: got.fits, x: d.x, y: m.y, w: d.w, h: m.h, side: "on", section: d.section });
        if (top && got.top) push(`${c.id}:label`, "label", c.id, got.top);
      } else {
        push(`${c.id}:label`, "label", c.id, got.main);
      }
      if (free !== undefined) push(`legend:${free}`, "legend", null, got.bottom, { on: c.id });
      if (c.sub) {
        if (got.bottom && free === undefined) push(`${c.id}:sub`, "sub", c.id, got.bottom);
        else plan.push({ key: `${c.id}:sub`, owner: c.id, part: "sub", boxed: false, text: c.sub, lines: [c.sub], px: L,
          fits: true, hidden: true, x: 0, y: 0, w: 0, h: 0, side: "none", section: d.section });
      }
      onDeck.add(c.id);
    }
  }
  // labels (printed above; TEMPO under its fader)
  for (const c of controls) {
    if (!c.label || onDeck.has(c.id)) continue;
    const d = drawn.get(c.id);
    if (phoneDeck(c) && c.kind === "fader") {
      // phone: TEMPO beside its fader, where the jog leaves room, nearest its middle
      const L = PHONE.legendMin;
      const spots = (tw, th) => {
        const out = [];
        for (let dy = 0; dy <= d.h / 2; dy += 1) {
          for (const y of dy ? [cyOf(d) - dy, cyOf(d) + dy] : [cyOf(d)]) out.push({ side: "left", r: R(d.x - 2 - tw, y - th / 2, tw, th) });
        }
        return out;
      };
      const entry = { key: `${c.id}:label`, owner: c.id, part: "label", boxed: false };
      place(entry, c.label, L, 0, 1, spots, c.id, d.section, true, false, L);
      continue;
    }
    const first = c.kind === "fader" ? "below" : "above";
    const spots = aroundSpots(d, d.section, first, bottomOf(d) + gap);
    // the headphone mark goes first when there is no room for it
    const entry = { key: `${c.id}:label`, owner: c.id, part: "label", boxed: false, icon: !!c.phones };
    if (c.phones) {
      const n = plan.length;
      const got = place(entry, c.label, base, 1.4, 1, spots, c.id, d.section);
      if (got.fits) continue;
      plan.splice(n, 1);
      taken.pop();
      entry.icon = false;
    }
    place(entry, c.label, base, 0, 1, spots, c.id, d.section);
  }
  // free legends, at their printed place (nudged off a grown part); lines
  // printed as a stack (same x, under 3 % apart: CUE/LOOP over CALL) move together
  const stacks = [];
  LEGENDS.forEach((l, i) => {
    const prev = stacks.at(-1), last = prev && LEGENDS[prev.at(-1)];
    if (last && Math.abs(last.x - l.x) < 0.01 && l.y > last.y && l.y - last.y < 3) prev.push(i);
    else stacks.push([i]);
  });
  const LEGEND_DY = [0, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((k) => [k, -k])];
  const LEGEND_DX = [0, ...[2, 4, 6, 8, 10].flatMap((k) => [k, -k])];
  for (const group of stacks) {
    if (group.some((i) => [...freeOn.values()].includes(i))) continue;          // on a button (above)
    const ls = group.map((i) => LEGENDS[i]);
    const sec = sectionOf(ls[0].x).key;
    const s = fit.sections.find((t) => t.key === sec);
    const lmin = fit.mode === "phone" && sec !== "mixer" ? PHONE.legendMin : LEGEND_MIN_PX;
    const bases = ls.map((l) => Math.max(lmin, l.small ? base * 0.9 : l.strong ? base * 1.15 : base));
    // where it is printed: the photo's place, or (phone decks) phoneDeck's anchor
    const anchor = (l) => {
      const a = fit.mode === "phone" && sec !== "mixer" ? fit.deck.legends[l.text] : null;
      return a ? { x: s.left + a.x, y: a.y } : { x: s.left + (l.x - s.x0) * pxw(fit), y: l.y * u };
    };
    const x = anchor(ls[0]).x;
    const yMid = (anchor(ls[0]).y + anchor(ls.at(-1)).y) / 2;
    const forms = (l) => [l.text, ...(SHORT[l.text] || [])];
    let done = null;
    // sizes: every line from its base down, full text first, then the short forms
    const tries = [];
    for (let k = 0; k <= Math.max(...ls.map((l) => forms(l).length - 1)); k++) {
      for (let px = Math.max(...bases); px >= lmin - 1e-9; px -= 0.25) {
        tries.push(ls.map((l, j) => ({ text: forms(l)[Math.min(k, forms(l).length - 1)], px: Math.max(lmin, Math.min(px, bases[j])) })));
      }
    }
    outer: for (const zs of tries) {
      const hs = zs.map((z) => z.px), H = hs.reduce((a, b) => a + b, 0) + (zs.length - 1);
      for (const dy of LEGEND_DY) for (const dx of LEGEND_DX) {
        let y = yMid - H / 2 + dy;
        const rs = zs.map((z) => { const tw = textWidth(z.text, z.px); const r = R(x - tw / 2 + dx, y, tw, z.px); y += z.px + 1; return r; });
        const ok = rs.every((r) => clear(r, null, sec)) && (rs.length < 2 || !rectsOverlap(rs[0], rs[1]));
        if (ok) { done = { zs, rs }; break outer; }
      }
    }
    // a two-line stack with no room for two lines: one line (CUE/LOOP CALL)
    let joined = false;
    if (!done && ls.length === 2) {
      const texts = [`${ls[0].text} ${ls[1].text}`, ...(SHORT[ls[0].text] || []).map((t) => `${t} ${ls[1].text}`)];
      const b0 = Math.min(...bases);
      one: for (const t of texts) {
        for (let px = b0; px >= lmin - 1e-9; px -= 0.25) {
          const tw = textWidth(t, px);
          for (const dy of LEGEND_DY) for (const dx of LEGEND_DX) {
            const r = R(x - tw / 2 + dx, yMid - px / 2 + dy, tw, px);
            if (clear(r, null, sec)) { done = { zs: [{ text: t, px }], rs: [r] }; joined = true; break one; }
          }
        }
      }
    }
    const fits = !!done;
    if (joined) {
      const [i0, i1] = group, z = done.zs[0], r = done.rs[0];
      plan.push({ key: `legend:${i0}`, owner: null, part: "legend", boxed: false, text: z.text, lines: [z.text],
        px: z.px, fits, x: r.x, y: r.y, w: r.w, h: r.h, side: "at", section: sec });
      plan.push({ key: `legend:${i1}`, owner: null, part: "legend", boxed: false, text: LEGENDS[i1].text, lines: [LEGENDS[i1].text],
        px: z.px, fits: true, hidden: true, joined: `legend:${i0}`, x: 0, y: 0, w: 0, h: 0, side: "none", section: sec });
      taken.push({ ...r, section: sec });
      continue;
    }
    if (!done) {
      const zs = ls.map((l) => ({ text: forms(l).at(-1), px: lmin }));
      let y = yMid - (zs.length * (lmin + 1)) / 2;
      done = { zs, rs: zs.map((z) => { const tw = textWidth(z.text, z.px); const r = R(x - tw / 2, y, tw, z.px); y += z.px + 1; return r; }) };
    }
    // (phone decks: the tempo marks sit in the fader's tick column, under its cap)
    const tick = fit.mode === "phone" && sec !== "mixer" && !!fit.deck.legends[ls[0].text]?.tick;
    group.forEach((i, j) => {
      const z = done.zs[j], r = done.rs[j];
      plan.push({ key: `legend:${i}`, owner: null, part: "legend", boxed: !!LEGENDS[i].boxed, text: z.text, lines: [z.text],
        px: z.px, fits, x: r.x, y: r.y, w: r.w, h: r.h, side: tick ? "tick" : "at", section: sec });
      taken.push({ ...r, section: sec });
    });
  }
  // legends under a part: the SHIFT legends (boxed) of what works in v1 first;
  // a SHIFT legend for a layer v1 does not have (no shift action, or "not
  // yet") is left off where there is no room for it
  // (PLAY/PAUSE, an unboxed name under PLAY, says what its face already shows: optional too)
  const subs = controls.filter((c) => c.sub && !onDeck.has(c.id));
  for (const c of [...subs.filter(works), ...subs.filter((x) => !works(x))]) {
    const d = drawn.get(c.id);
    const boxed = !c.subPlain;
    const em = boxed ? 0.5 : 0;                                    // the box's padding and border
    const hMul = boxed ? 1.2 : 1;
    const b = boxed ? Math.max(LEGEND_MIN_PX, base * 0.9) : base;
    const yWant = Math.max(c.subY !== undefined ? c.subY * u : 0, bottomOf(d) + gap);
    // a legend for a layer v1 lacks is shown only where it is printed
    const around = aroundSpots(d, d.section, "below", yWant, !works(c));
    // the pad mode buttons sit between the jog and the pads, and a round
    // button with no face has room on it: there, inside, at the bottom
    const inButton = c.kind === "button" && (c.look === "mode" || (works(c) && (!c.face || c.look === "square")));
    const spots = (tw0, th, z) => {
      const out = around(tw0, th);
      if (inButton) {
        const round = isRound(c);
        const tw = textWidth(z.text, z.px);                        // plain on the part, no box
        const th1 = z.px;
        const r = round ? R(cxOf(d) - tw / 2, cyOf(d) - th1 / 2, tw, th1) : R(cxOf(d) - tw / 2, bottomOf(d) - th1 - 1, tw, th1);
        const inside = round
          ? (q) => Math.hypot(q.w / 2, q.h / 2) <= d.w / 2 - 2
          : (q) => q.x >= d.x + 1.5 && rightOf(q) <= rightOf(d) - 1.5;
        // right after its printed place: inside reads as its own legend, beside it may not
        const k = out.findIndex((sp) => sp.side !== "below");
        out.splice(k < 0 ? out.length : k, 0, { side: "in", r, inside });
      }
      return out;
    };
    const got = place({ key: `${c.id}:sub`, owner: c.id, part: "sub", boxed }, c.sub, b, em, hMul, spots, c.id, d.section,
      true, !works(c));
    if (got.side === "in" && c.face) faceRooms.set(c.id, { top: d.y + 1, bottom: got.y - 0.5 });
  }
  // faces, on their parts (above a SHIFT legend that had to come inside)
  for (const c of controls) {
    if (!c.face || onDeck.has(c.id) || ["knob", "encoder", "fader", "xfader", "jog", "lever", "pad"].includes(c.kind)) continue;
    const d = drawn.get(c.id);
    const round = isRound(c);
    const room = faceRooms.get(c.id);
    const top = room ? room.top : d.y, h = room ? room.bottom - room.top : d.h;
    const roomW = d.w - (round ? 3 : 4), roomH = room ? h : d.h * (round ? 0.7 : 0.84);
    const fb = Math.max(LEGEND_MIN_PX, Math.min(Math.min(d.w, d.h) * 0.36, base * 1.6));
    const f = fitText(c.face, roomW, { base: fb, roomH, wrap: true, disc: round ? d.w / 2 - 1.5 : 0 });
    plan.push({ key: `${c.id}:face`, owner: c.id, part: "face", boxed: false, ...f, x: d.x, y: top, w: d.w, h,
      side: "on", section: d.section });
  }
  return plan;
}
