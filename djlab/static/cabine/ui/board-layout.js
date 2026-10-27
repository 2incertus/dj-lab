// A Cabine: where the board goes on the screen (pure, unit-tested).
//
// Landscape screen, top to bottom: the strip (the "laptop screen", Task 10
// draws there) takes STRIP_SHARE of the height, the board fills the rest at
// BOARD_ASPECT, centered. Nothing interactive goes in the safe areas: the
// sides (Dynamic Island, rounded corners) and the home indicator at the
// bottom. env(safe-area-inset-*) gives them on the iPhone; where it reads 0
// (Android, desktop, the e2e browsers) SAFE_FALLBACK stands in, so the layout
// is the iPhone's everywhere. The crossfader's hit box must end XFADER_CLEAR_PX
// above the bottom edge (home indicator plus the swipe-up zone); the board
// shrinks, keeping its proportions, until it does.

import { BOARD_ASPECT, CONTROLS } from "../flx4-map.js";

export const STRIP_SHARE = 0.22;
export const SAFE_FALLBACK = { side: 47, bottom: 21 };
export const XFADER_CLEAR_PX = 34;

const XF = CONTROLS.find((c) => c.id === "xfader");
/** Where the crossfader's box ends, as a fraction of the board's height. */
export const XFADER_BOTTOM = (XF.y + XF.h) / 100;

/**
 * @param W, H     viewport in CSS px (landscape)
 * @param insets   {left, right, bottom, top}: env(safe-area-inset-*) values
 * @returns {left, top, width, height, stripTop, stripBottom, safe: {left, right, bottom, top}}
 */
export function fitBoard({ W, H, insets = {} }) {
  const safe = {
    left: Math.max(insets.left || 0, SAFE_FALLBACK.side),
    right: Math.max(insets.right || 0, SAFE_FALLBACK.side),
    bottom: Math.max(insets.bottom || 0, SAFE_FALLBACK.bottom),
    top: Math.max(insets.top || 0, 0),
  };
  const stripTop = safe.top;
  const stripBottom = stripTop + Math.round(STRIP_SHARE * H);
  const availW = Math.max(0, W - safe.left - safe.right);
  const availH = Math.max(0, H - safe.bottom - stripBottom);
  const xfH = (H - XFADER_CLEAR_PX - stripBottom) / XFADER_BOTTOM;   // tallest board whose crossfader clears
  const height = Math.max(0, Math.min(availH, availW / BOARD_ASPECT, xfH));
  const width = height * BOARD_ASPECT;
  const left = safe.left + (availW - width) / 2;
  // centered in the space below the strip, but never so low the crossfader
  // enters the clear zone
  const centered = stripBottom + (availH - height) / 2;
  const top = Math.max(stripBottom, Math.min(centered, H - XFADER_CLEAR_PX - XFADER_BOTTOM * height));
  return { left, top, width, height, stripTop, stripBottom, safe };
}
