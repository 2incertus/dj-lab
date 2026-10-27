// A Cabine: where the board goes on the screen (pure, unit-tested).
//
// Landscape screen, top to bottom: the strip (the "laptop screen", Task 10
// draws there), then the board. Nothing interactive goes in the safe areas:
// the sides (Dynamic Island, rounded corners) and the home indicator at the
// bottom. env(safe-area-inset-*) gives them on the iPhone; where it reads 0
// (Android, desktop, the e2e browsers) SAFE_FALLBACK stands in, so the layout
// is the iPhone's everywhere. The crossfader's hit box must end XFADER_CLEAR_PX
// above the bottom edge (home indicator plus the swipe-up zone).
//
// The panel is three sections side by side, as on the hardware: deck 1, the
// mixer (with Beat FX and browse), deck 2 (SECTIONS, percent of the panel's
// width). Two layouts (ruling R23):
//   "exact"   the whole panel at BOARD_ASPECT, centered: what the photo shows,
//             with STRIP_SHARE.exact of the height for the strip. On an
//             844 x 390 iPhone that leaves ~120 px unused at each side.
//   "spread"  (default) a slimmer strip (two lanes), the sections sized by the
//             taller height budget, each keeping its own proportions and every
//             part's size, and the width left over split into the two gaps
//             between them, so the board spans the whole usable width. Inside a
//             section every position is the photo's; only the distance between
//             deck 1, the mixer and deck 2 grows.
// Both shrink (keeping proportions) until the crossfader clears the bottom.

import { BOARD_ASPECT, CONTROLS } from "../flx4-map.js";

export const LAYOUT = "spread";
export const LAYOUTS = ["exact", "spread"];
export const STRIP_SHARE = { exact: 0.22, spread: 0.12 };
export const SAFE_FALLBACK = { side: 47, bottom: 21 };
export const XFADER_CLEAR_PX = 34;
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
 * @param mode     "spread" (default) | "exact"
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
  const stripTop = safe.top;
  const stripBottom = stripTop + Math.round(STRIP_SHARE[mode] * H);
  const availW = Math.max(0, W - safe.left - safe.right);
  const availH = Math.max(0, H - safe.bottom - stripBottom);
  const xfH = (H - XFADER_CLEAR_PX - stripBottom) / XFADER_BOTTOM;   // tallest board whose crossfader clears
  const height = Math.max(0, Math.min(availH, availW / BOARD_ASPECT, xfH));
  const natural = height * BOARD_ASPECT;
  const width = mode === "spread" ? availW : natural;
  const gap = mode === "spread" ? (availW - natural) / (SECTIONS.length - 1) : 0;
  const left = safe.left + (availW - width) / 2;
  // centered in the space below the strip, but never so low the crossfader
  // enters the clear zone
  const centered = stripBottom + (availH - height) / 2;
  const top = Math.max(stripBottom, Math.min(centered, H - XFADER_CLEAR_PX - XFADER_BOTTOM * height));
  const unit = height / 100;
  let x = 0;
  const sections = SECTIONS.map((s) => {
    const w = ((s.x1 - s.x0) / 100) * natural;
    const out = { ...s, left: x, width: w };
    x += w + gap;
    return out;
  });
  return { mode, left, top, width, height, unit, sections, stripTop, stripBottom, safe };
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
