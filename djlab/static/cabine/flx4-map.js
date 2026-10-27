// A Cabine: the DDJ-FLX4 top panel as data. Every control the board draws,
// where it sits, what it is, and which engine method it drives.
//
// Positions. Measured 2026-10-27 from two official Pioneer DJ images (kept in
// /tmp only, never in the repo; both are copyrighted):
//   [F] the operating instructions' part-names figure, "Part names and
//       functions > Top panel" (DDJ-FLX4 Instruction Manual, EN PDF, p. 11).
//       A vector drawing of the whole panel, both decks. The page was turned
//       into SVG (pdftocairo -svg) and every shape's bounding box read from
//       its path data, then normalized to the panel outline (384.11 x 212.84 pt
//       on the page, so BOARD_ASPECT = 1.805). Numbers below are that output,
//       rounded to 0.01 %.
//   [P] the product page's top-view render,
//       https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/
//       95D1B8CC-742D-4BB5-BF32-6A32C6BE8514.png, 1000 x 872 px, linked from
//       https://www.pioneerdj.com/en/product/controller/ddj-flx4/black/overview/
//       It shows deck 1, the mixer and the Beat FX column (deck 2 is cut off).
//       Least squares over 13 lit parts (IN, OUT, BEAT SYNC, SMART CFX, SMART
//       FADER, both channel CUEs, master CUE, ON/OFF, two pad mode buttons,
//       pads 1 and 8) maps [F] onto [P] with every center within 1 px of the
//       photo (panel 1503.5 x 832 px there, aspect 1.807). So [F] is the
//       hardware, and its boxes are used for everything. A box is the part's
//       whole drawn outline (bezel included for round buttons), which is a
//       little larger than the lit face in [P].
// Deck 2 is not a mirror of deck 1: the FLX4 repeats the same deck (tempo on
// the right of each jog, CUE and PLAY at each deck's left edge). In [F] every
// deck 2 part sits at deck 1's x + 65.37 % (+-0.04), same y and size; deck 2
// is generated from deck 1 with DECK2_DX so the two cannot drift apart.
//
// subY: where the control's SHIFT legend box starts (percent of panel height),
// measured like the rest; without it the legend sits right under the part.
// Coordinates: x, y, w, h in percent of the panel (x of its width, y of its
// height). The board scales them uniformly (BOARD_ASPECT is kept).
//
// Legends: label (printed above), face (on the part), sub (the boxed SHIFT
// legend under it), subPlain (an unboxed legend under it).
//
// Actions. "<target>.<method>" where target is deck | mixer | fx | sampler |
// strip | board, and the method is in that target's exported list (DECK_ACTIONS,
// MIXER_ACTIONS, BEATFX_ACTIONS, SAMPLER_ACTIONS, STRIP_ACTIONS, BOARD_ACTIONS;
// test/flx4-map.test.js enforces it). The board calls bindings[action](value,
// control): the control carries deck, index, band, arg so one binding serves
// both decks. Fields per kind:
//   button  action (pressed), up (released, hold buttons), shift (pressed with
//           SHIFT held), arg / shiftArg (the value passed), latch (the board
//           keeps an on/off state and passes it, lighting the button)
//   pad     index 0..7; the action comes from PAD_MODES[board pad mode]
//   knob    action(value 0..1), def (double-tap value), detent (center feel),
//           scale (the printed end marks, kept for reference; too small to draw)
//   encoder action(steps), press (pushed)
//   fader   action(value 0..1), dir: "down" (0 at the top) | "up" (1 at the top),
//           cap {w, h} (the cap's drawn size; travel = box minus cap)
//   xfader  action(value 0..1, 0 = left), cap {w, h}
//   jog     action = top plate turn (deg), touch = top plate touch (bool),
//           ring = outer ring turn (deg, after RING_BEND_GAIN)
//   lever   action(value), positions [{label, value}]
// SHIFT: per deck and held. A deck control reads its own deck's SHIFT; a
// mixer or Beat FX control reads either. With SHIFT held, a button or pad
// with no shift entry does nothing (its SHIFT layer is not in v1); knobs,
// faders and the jog ignore SHIFT here (the deck itself reads SHIFT for the
// jog's fast search, via deck.setShift).
// v1: false = drawn only. Tapping it shows "not yet" for 1.2 s, as does any
// "board.notYet" action.

/** Panel width / height, from the part-names figure [F]. */
export const BOARD_ASPECT = 1.805;
/** Deck 2 = deck 1 shifted right by this much (percent of panel width). */
export const DECK2_DX = 65.37;

/** Strip methods Task 10 builds (ui/strip.js and its app.js bindings).
 *  Task 10 must match these names. openBrowse is BROWSE's push: Task 10 makes
 *  a push while the list is open close it, as on the hardware. */
export const STRIP_ACTIONS = ["openBrowse", "browseMove", "load1", "load2", "closeBrowse"];

/** Handled by the board itself: pad mode routing and the "not yet" note. */
export const BOARD_ACTIONS = ["padModeHotCue", "padModeBeatJump", "padModeBeatLoop",
  "padModeSampler", "notYet"];

/** Pad modes: the pads' action and SHIFT action in each (DDJ-FLX4 manual,
 *  pp. 57-64; deck.js and sampler.js header tables). Beat Loop is SHIFT +
 *  BEAT JUMP; its pads have no SHIFT layer. */
export const PAD_MODES = {
  hotcue: { action: "deck.hotCue", shift: "deck.shiftHotCue", button: "mode-hotcue" },
  beatjump: { action: "deck.beatJump", shift: "deck.shiftBeatJump", button: "mode-beatjump" },
  beatloop: { action: "deck.beatLoop", shift: null, button: "mode-beatjump" },
  sampler: { action: "sampler.trigger", shift: "sampler.stop", button: "mode-sampler" },
};
export const DEFAULT_PAD_MODE = "hotcue";

/** Hot cue pad colours. No rekordbox screenshot from his install yet, so
 *  rekordbox 7's documented colours: rekordbox 7.2.18 Instruction Manual (EN),
 *  "[HOT CUE] panel" (p. 72): "If its color is green, a Cue is saved. If its
 *  color is orange, a loop is saved", and Preferences > View > [HOT CUE color]
 *  [CDJ] (p. 234): "Hot Cues in green and Hot Loop in amber". The manual does
 *  not say which [HOT CUE color] scheme is the PERFORMANCE default: replace
 *  these if his screenshot shows another. */
export const HOT_CUE_COLOURS = { cue: "#3fd43a", loop: "#ff9d1f" };

/** The spec's drawn-only list (section 5) and where each lives on the board. */
export const DRAWN_ONLY = {
  "Mic": ["mic-level"],
  "Smart CFX": ["smart-cfx"],
  "Smart Fader": ["smart-fader"],
  "PAD FX1": ["d1-mode-padfx1", "d2-mode-padfx1"],
  "PAD FX2": ["d1-mode-padfx1:shift", "d2-mode-padfx1:shift"],
  "KEYBOARD": ["d1-mode-hotcue:shift", "d2-mode-hotcue:shift"],
  "KEY SHIFT": ["d1-mode-sampler:shift", "d2-mode-sampler:shift"],
  "CUE/LOOP CALL memory cues": ["d1-call-prev:shift", "d1-call-next:shift",
    "d2-call-prev:shift", "d2-call-next:shift"],
};

// ---- deck 1, measured ------------------------------------------------------------

const DECK1 = [
  { id: "in", kind: "button", label: "IN", sub: "IN ADJ", subY: 14.23, x: 2.94, y: 7.00, w: 3.52, h: 6.35,
    action: "deck.loopIn", look: "round", lightColour: "orange" },
  { id: "out", kind: "button", label: "OUT", sub: "OUT ADJ", subY: 14.23, x: 8.23, y: 7.00, w: 3.52, h: 6.35,
    action: "deck.loopOut", look: "round", lightColour: "orange" },
  { id: "4beat", kind: "button", label: "4 BEAT/EXIT", sub: "ACTIVE", subY: 13.45, x: 14.01, y: 7.90, w: 2.52, h: 4.56,
    action: "deck.fourBeatExit", shift: "deck.shiftFourBeatExit", look: "round" },
  { id: "call-prev", kind: "button", label: "", face: "◀", sub: "DEL", subY: 13.45, x: 19.61, y: 8.45, w: 1.92, h: 3.46,
    action: "deck.loopHalve", shift: "board.notYet", look: "round" },
  { id: "call-next", kind: "button", label: "", face: "▶", sub: "MEMORY", subY: 13.45, x: 23.96, y: 8.45, w: 1.92, h: 3.46,
    action: "deck.loopDouble", shift: "board.notYet", look: "round" },
  { id: "sync", kind: "button", label: "\u2212MASTER", face: "BEAT SYNC", sub: "TEMPO RANGE", subY: 13.45,
    x: 28.41, y: 7.44, w: 3.06, h: 5.52, action: "deck.syncPress", shift: "deck.cycleRange",
    look: "round", lightColour: "orange" },
  { id: "jog", kind: "jog", label: "", x: 2.54, y: 15.30, w: 29.55, h: 53.34,
    action: "deck.jogTurn", touch: "deck.jogTouch", ring: "deck.jogRing" },
  { id: "shift", kind: "button", label: "SHIFT", x: 3.38, y: 66.16, w: 2.63, h: 3.85,
    action: "deck.setShift", hold: true, look: "square" },
  { id: "cue", kind: "button", label: "", face: "CUE", x: 1.97, y: 73.26, w: 5.48, h: 9.89,
    action: "deck.cueDown", up: "deck.cueUp", shift: "deck.shiftCue", look: "big", lightColour: "orange" },
  { id: "play", kind: "button", label: "", face: "▶/II", sub: "PLAY/PAUSE", subPlain: true,
    x: 1.97, y: 83.74, w: 5.48, h: 9.89, action: "deck.playPause", shift: "deck.shiftPlayPause",
    look: "big", lightColour: "green" },
  { id: "mode-hotcue", kind: "button", face: "HOT CUE", sub: "KEYBOARD", subY: 75.60, x: 8.50, y: 72.44, w: 3.82, h: 2.64,
    action: "board.padModeHotCue", shift: "board.notYet", look: "mode" },
  { id: "mode-padfx1", kind: "button", face: "PAD FX1", sub: "PAD FX2", subY: 75.60, x: 13.11, y: 72.44, w: 3.82, h: 2.64,
    action: "board.notYet", shift: "board.notYet", look: "mode", v1: false },
  { id: "mode-beatjump", kind: "button", face: "BEAT JUMP", sub: "BEAT LOOP", subY: 75.60, x: 17.72, y: 72.44, w: 3.82, h: 2.64,
    action: "board.padModeBeatJump", shift: "board.padModeBeatLoop", look: "mode" },
  { id: "mode-sampler", kind: "button", face: "SAMPLER", sub: "KEY SHIFT", subY: 75.60, x: 22.33, y: 72.44, w: 3.82, h: 2.64,
    action: "board.padModeSampler", shift: "board.notYet", look: "mode" },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
    id: `pad${i + 1}`, kind: "pad", label: "", index: i,
    x: [8.32, 12.92, 17.53, 22.14][i % 4], y: i < 4 ? 78.54 : 86.85, w: 4.19, h: 7.57,
    action: PAD_MODES.hotcue.action, shift: PAD_MODES.hotcue.shift,
  })),
  // the tempo box is the track (66.73 .. 92.07) plus half the cap at each end
  { id: "tempo", kind: "fader", label: "TEMPO", x: 28.08, y: 63.03, w: 3.68, h: 32.74,
    cap: { w: 3.68, h: 7.40 }, dir: "down", tempo: true, action: "deck.setTempo", def: 0.5 },
];

function deckControls(n, dx) {
  return DECK1.map((c) => ({
    ...c,
    id: `d${n}-${c.id}`,
    deck: n,
    section: "deck",
    x: Math.round((c.x + dx) * 100) / 100,
    v1: c.v1 !== false,
  }));
}

// ---- mixer and browse (measured) --------------------------------------------------------

function channel(n, dx) {
  const ch = (c) => ({ deck: n, section: "mixer", v1: true, ...c, id: `ch${n}-${c.id}`,
    x: Math.round((c.x + dx) * 100) / 100 });
  return [
    ch({ id: "trim", kind: "knob", label: "TRIM", x: 44.33, y: 11.46, w: 3.04, h: 5.49,
      action: "mixer.setTrim", def: 0.5, scale: ["-∞", "+9"] }),
    ch({ id: "hi", kind: "knob", label: "HI", band: "hi", x: 44.11, y: 20.18, w: 3.54, h: 6.39,
      action: "mixer.setEq", def: 0.5, detent: true, scale: ["-26", "+6"] }),
    ch({ id: "mid", kind: "knob", label: "MID", band: "mid", x: 44.11, y: 29.36, w: 3.54, h: 6.39,
      action: "mixer.setEq", def: 0.5, detent: true, scale: ["-26", "+6"] }),
    ch({ id: "low", kind: "knob", label: "LOW", band: "low", x: 44.11, y: 38.55, w: 3.54, h: 6.39,
      action: "mixer.setEq", def: 0.5, detent: true, scale: ["-26", "+6"] }),
    ch({ id: "cfx", kind: "knob", label: "CFX", x: 44.11, y: 47.73, w: 3.54, h: 6.39,
      action: "mixer.setCfx", def: 0.5, detent: true, scale: ["LOW", "HI"] }),
    ch({ id: "cue", kind: "button", face: "CUE", x: 44.20, y: 58.86, w: 3.27, h: 2.89,
      action: "mixer.setCue", latch: true, look: "mode" }),
    // box = the tick rail's width; height = track (66.90 .. 84.46) plus half the cap each end
    ch({ id: "fader", kind: "fader", label: "", x: 43.44, y: 65.10, w: 4.84, h: 21.15,
      cap: { w: 4.40, h: 3.59 }, dir: "up", action: "mixer.setFader", def: 1 }),
  ];
}

const CH2_DX = 8.29;                // channel 2 strip = channel 1 + 8.29 % in [F]

const MIXER = [
  { id: "browse", kind: "encoder", label: "", sub: "BACK", subY: 9.03, deck: null, section: "browse", v1: true,
    x: 47.96, y: 1.44, w: 4.08, h: 7.36, action: "strip.browseMove", press: "strip.openBrowse" },
  { id: "load1", kind: "button", label: "LOAD", deck: null, section: "browse", v1: true,
    x: 41.69, y: 5.10, w: 3.14, h: 2.68, action: "strip.load1", look: "square" },
  { id: "load2", kind: "button", label: "LOAD", sub: "VIEW", subY: 8.44, deck: null, section: "browse", v1: true,
    x: 55.19, y: 5.10, w: 3.14, h: 2.68, action: "strip.load2", look: "square" },
  ...channel(1, 0),
  ...channel(2, CH2_DX),
  { id: "master-level", kind: "knob", label: "MASTER LEVEL", deck: null, section: "mixer", v1: true,
    x: 59.75, y: 10.75, w: 4.17, h: 6.57, action: "mixer.setMasterLevel", def: 1, scale: ["-∞", "0"] },
  { id: "master-cue", kind: "button", face: "CUE", deck: null, section: "mixer", v1: true,
    x: 60.18, y: 22.00, w: 3.27, h: 2.89, action: "mixer.setMasterCue", latch: true, look: "mode" },
  { id: "mic-level", kind: "knob", label: "MIC LEVEL", deck: null, section: "mixer", v1: false,
    x: 36.40, y: 29.38, w: 3.54, h: 6.38, action: "board.notYet", def: 0, scale: ["-∞", "0"] },
  { id: "smart-cfx", kind: "button", face: "SMART CFX", sub: "FX SELECT", subY: 54.19, deck: null, section: "mixer",
    v1: false, x: 36.67, y: 48.20, w: 3.03, h: 5.47, action: "board.notYet", shift: "board.notYet",
    look: "round", lightColour: "orange" },
  { id: "phones-mix", kind: "knob", label: "MIX", phones: true, deck: null, section: "mixer", v1: true,
    x: 36.40, y: 58.93, w: 3.54, h: 6.39, action: "mixer.setPhonesMix", def: 0.5, scale: ["CUE", "MST"] },
  { id: "phones-level", kind: "knob", label: "LEVEL", phones: true, deck: null, section: "mixer", v1: true,
    x: 36.40, y: 68.69, w: 3.54, h: 6.39, action: "mixer.setPhonesLevel", def: 0.8, scale: ["-∞", "0"] },
  { id: "smart-fader", kind: "button", face: "SMART FADER", deck: null, section: "mixer", v1: false,
    x: 36.67, y: 79.97, w: 3.03, h: 5.47, action: "board.notYet", shift: "board.notYet",
    look: "round", lightColour: "orange" },
  // box = the track (45.00 .. 55.02) plus half the cap at each end, cap height
  { id: "xfader", kind: "xfader", label: "", deck: null, section: "mixer", v1: true,
    x: 44.01, y: 89.18, w: 12.01, h: 7.94, cap: { w: 1.99, h: 7.94 },
    action: "mixer.setCrossfader", def: 0.5 },
];

// ---- Beat FX (measured) ------------------------------------------------------------------

const FX = [
  { id: "fx-ch", kind: "lever", label: "", x: 59.95, y: 40.27, w: 3.79, h: 2.97,
    action: "fx.setTarget", def: 0,
    positions: [{ label: "1", value: "1" }, { label: "2", value: "2" }, { label: "1&2", value: "master" }] },
  { id: "fx-select", kind: "button", label: "FX SELECT", face: "▼", sub: "▲", subY: 52.97,
    x: 60.18, y: 49.50, w: 3.27, h: 2.89, action: "fx.select", arg: 1, shift: "fx.select", shiftArg: -1,
    look: "square" },
  { id: "fx-beat-down", kind: "button", label: "", face: "◀", sub: "AUTO", subY: 62.13, x: 59.16, y: 58.86, w: 2.31, h: 2.89,
    action: "fx.beat", arg: -1, look: "square" },
  { id: "fx-beat-up", kind: "button", label: "", face: "▶", sub: "TAP", subY: 62.13, x: 62.18, y: 58.86, w: 2.31, h: 2.89,
    action: "fx.beat", arg: 1, look: "square" },
  { id: "fx-level", kind: "knob", label: "LEVEL/DEPTH", x: 60.09, y: 68.69, w: 3.54, h: 6.39,
    action: "fx.setLevel", def: 0.5, scale: ["MIN", "MAX"] },
  { id: "fx-on", kind: "button", label: "ON/OFF", sub: "RELEASE FX", subY: 86.55, x: 60.08, y: 79.53, w: 3.52, h: 6.35,
    action: "fx.toggle", look: "round", lightColour: "orange" },
].map((c) => ({ deck: null, section: "fx", v1: true, ...c }));

/** Every control, deck 1 then deck 2, mixer, Beat FX. */
export const CONTROLS = [
  ...deckControls(1, 0),
  ...deckControls(2, DECK2_DX),
  ...MIXER,
  ...FX,
];

/** Display-only parts: the channel level indicators (five LEDs each,
 *  red / orange / orange / green / green from the top, as in [P]). */
export const INDICATORS = [
  { id: "ch1-meter", kind: "meter", deck: 1, x: 48.76, y: 24.78, w: 0.62, h: 15.61, leds: 5 },
  { id: "ch2-meter", kind: "meter", deck: 2, x: 50.61, y: 24.78, w: 0.62, h: 15.61, leds: 5 },
];

/** Printed legends that belong to no single control (percent of the panel,
 *  x/y = the text's center). The boxed "LOOP" between the CALL buttons is left
 *  out: at phone size it would cover the 1/2X and 2X legends it groups. */
export const LEGENDS = [
  ...[0, DECK2_DX].flatMap((dx) => [
    { text: "CUE/LOOP", x: 22.83 + dx, y: 3.9 },
    { text: "CALL", x: 22.83 + dx, y: 6.4 },
    { text: "1/2X", x: 20.57 + dx, y: 12.75, small: true },
    { text: "2X", x: 24.92 + dx, y: 12.75, small: true },
    { text: "\u2212", x: 28.9 + dx, y: 66.3 },
    { text: "0", x: 27.3 + dx, y: 79.4 },
    { text: "+", x: 28.9 + dx, y: 92.4 },
  ]),
  { text: "PERFORMANCE", x: 39.0, y: 12.9, small: true },
  { text: "DJ CONTROLLER", x: 39.0, y: 14.9, small: true },
  { text: "DDJ-FLX4", x: 39.0, y: 18.0, strong: true },
  { text: "1", x: 45.85, y: 63.85, strong: true },
  { text: "2", x: 54.16, y: 63.85, strong: true },
  { text: "BEAT FX", x: 61.9, y: 32.9 },
  { text: "1", x: 60.55, y: 37.6 },
  { text: "2", x: 61.5, y: 37.6 },
  { text: "1&2", x: 63.25, y: 37.6 },
  { text: "BEAT", x: 61.9, y: 56.4 },
];
