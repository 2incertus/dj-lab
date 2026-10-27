// A Cabine: stand-in bindings for the board with no audio engine (tests and the
// pre-Task-10 placeholder). Every action is logged as {action, value, id, deck}
// and the obvious lights follow: PLAY toggles, CUE lights while held, SYNC and
// Beat FX ON toggle, hot cue pads light when set and go dark when cleared.
// Task 10 replaces these with the engine bindings in app.js.

import { CONTROLS, PAD_MODES, HOT_CUE_COLOURS } from "../flx4-map.js";

export function makeDemoBindings() {
  const log = [];
  let board = null;
  const playing = { 1: false, 2: false };
  const sync = { 1: false, 2: false };
  const cues = { 1: new Array(8).fill(false), 2: new Array(8).fill(false) };
  let fxOn = false;
  const lit = (id, v) => { if (board) board.setLit(id, v); };

  function lightPads(deck, mode) {
    for (let i = 0; i < 8; i++) {
      lit(`d${deck}-pad${i + 1}`, mode === "hotcue" && cues[deck][i] ? HOT_CUE_COLOURS.cue : false);
    }
  }

  const effects = {
    "deck.playPause": (v, c) => { playing[c.deck] = !playing[c.deck]; lit(`d${c.deck}-play`, playing[c.deck]); },
    "deck.cueDown": (v, c) => lit(`d${c.deck}-cue`, true),
    "deck.cueUp": (v, c) => lit(`d${c.deck}-cue`, false),
    "deck.syncPress": (v, c) => { sync[c.deck] = !sync[c.deck]; lit(`d${c.deck}-sync`, sync[c.deck]); },
    "deck.hotCue": (i, c) => { cues[c.deck][i] = true; lit(`d${c.deck}-pad${i + 1}`, HOT_CUE_COLOURS.cue); },
    "deck.shiftHotCue": (i, c) => { cues[c.deck][i] = false; lit(`d${c.deck}-pad${i + 1}`, false); },
    "fx.toggle": () => { fxOn = !fxOn; lit("fx-on", fxOn); },
  };

  const actions = new Set();
  for (const c of CONTROLS) {
    for (const k of ["action", "shift", "up", "press", "touch", "ring"]) {
      if (c[k] && !c[k].startsWith("board.")) actions.add(c[k]);
    }
  }
  for (const m of Object.values(PAD_MODES)) {
    actions.add(m.action);
    if (m.shift) actions.add(m.shift);
  }
  const bindings = {};
  for (const a of actions) {
    bindings[a] = (value, c) => {
      log.push({ action: a, value, id: c ? c.id : null, deck: c ? c.deck : null, t: Date.now() });
      if (effects[a]) effects[a](value, c);
    };
  }

  return {
    bindings,
    log,
    attach(b) { board = b; },
    onPadMode: (deck, mode) => lightPads(deck, mode),
  };
}
