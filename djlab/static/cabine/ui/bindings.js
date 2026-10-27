// A Cabine: the board's actions bound to the engine (Task 10).
//
// makeBindings(env) -> {bindings, load(n), refreshLights(), flush(),
//   onNeedEngine(cb), log}
//   env {getRig(): the engine (engine/rig.js) or null until the first tap,
//        strip: ui/strip.js Strip (or a function returning the current one:
//        the board and its strip are drawn again after a visit to the crate),
//        board(): the rendered board, store,
//        source: the loader's source (store.js storeSource),
//        loadTrack: engine/loader.js loadTrack (injectable for tests)}
//
// bindings["<target>.<method>"](value, control) is what ui/board.js calls for
// every flx4-map action that is not the board's own. control carries deck
// (1 | 2), band, index and arg. Actions that arrive before the engine exists
// (the AudioContext is created on the first tap) wait in order and run when
// flush() is called. Every action is logged ({action, value, id, deck, t},
// window.cabine.boardLog) like the Task 9 demo bindings.
//
// rekordbox behaviors decided here:
// - LOAD_LOCK: on, read as rekordbox's default (Preferences > Controller >
//   Deck: "lock" stops a track loading onto a playing deck). UNCONFIRMED,
//   from his rekordbox screenshot. A refused LOAD flashes the deck's line
//   on the strip.
// - LOAD loads the highlighted track (the list need not be open, as with
//   rekordbox's browser on the laptop); loading closes the list. The deck is
//   emptied first (Deck.unload: the worklet drops the old PCM), then the new
//   track is decoded, then loaded; its saved hot cues come back with it.
//   One decode at a time per deck (phone memory): LOAD on a deck that is
//   still loading is ignored. Leaving for the caixa mid-load still loads the
//   deck; the next board puts it on its strip.
// - Hot cues are saved to the phone on every set and clear (ruling R5).
// - BROWSE pushed while the list is open closes it.
// - CUE/LOOP CALL with no loop active: "not yet" (memory cues are out of v1).
// - Beat FX re-reads the BPM (BeatFx.refresh) after every deck action, so
//   tempo, sync, load and master changes all reach it.
//
// Lights (refreshLights, called from the strip's frame loop, only changed
// ones touch the DOM). The DDJ-FLX4 manual's part-names tables (pp. 18-20,
// "13 PLAY/PAUSE button", "14 CUE button") give no indicator states for
// PLAY/PAUSE or CUE; the rekordbox manual neither. So these two follow the
// Pioneer CDJ / DDJ convention [B, CONFIRM ON HIS RIG]: PLAY lit while
// playing, flashing while paused; CUE lit at the cue point while paused (and
// while held), flashing when paused away from it, dark while playing. The
// manual does say "When Beat FX is turned on, the button flashes" (Beat FX,
// "Using Beat FX"), so ON/OFF flashes while on. The rest [B]: BEAT SYNC lit
// while on, its MASTER legend lit on the sync master; IN / OUT lit while a
// loop plays (the one being adjusted flashes); pads in HOT CUE mode lit in
// the set cue's colour, in BEAT LOOP mode the running loop's pad.

import { HOT_CUE_COLOURS } from "../flx4-map.js";
import { masterDeck } from "../engine/rig.js";

export const LOAD_LOCK = true;                 // UNCONFIRMED, from his rekordbox screenshot
export const LOAD_LOCK_TEXT = "load lock: the deck is playing";
const AT_CUE_S = 0.002;

const cueKey = (cues) => cues.map((h) => (h ? `${h.start}:${h.end}` : "-")).join(",");

export function makeBindings(env) {
  const { getRig, store, source } = env;
  const S = () => (typeof env.strip === "function" ? env.strip() : env.strip);
  const boardOf = () => (env.board ? env.board() : null);
  const log = [];
  const pending = [];
  const needCbs = [];
  const loading = { 1: false, 2: false };
  const shown = new Map();                      // light id -> last value set
  let lightsRuns = 0;

  const deckOf = (rig, c) => rig.decks[(c && c.deck ? c.deck : 1) - 1];
  const otherOf = (rig, c) => rig.decks[c && c.deck === 2 ? 0 : 1];

  /** A deck action, then the Beat FX BPM re-read. */
  const deckAct = (fn) => (rig, v, c) => {
    const d = deckOf(rig, c);
    fn(d, v, c, rig);
    rig.fx.refresh();
  };

  /** Hot cue set / clear, saved to the phone when the cues changed. */
  const cueAct = (fn) => deckAct((d, v) => {
    const before = cueKey(d.state.hotCues);
    fn(d, v);
    if (cueKey(d.state.hotCues) !== before && d.track && d.track.file && store) {
      store.putHotCues(d.track.file, d.state.hotCues.map((h) => (h ? { ...h } : null)))
        .catch((e) => console.warn(`A Cabine: hot cues for ${d.track.file} not saved`, e));
    }
  });

  const callAct = (method) => deckAct((d) => {
    if (!d.state.loop.active) { const b = boardOf(); if (b) b.notYet(); return; }
    d[method]();
  });

  const impl = {
    "deck.playPause": deckAct((d) => d.playPause()),
    "deck.shiftPlayPause": deckAct((d) => d.shiftPlayPause()),
    "deck.cueDown": deckAct((d) => d.cueDown()),
    "deck.cueUp": deckAct((d) => d.cueUp()),
    "deck.shiftCue": deckAct((d) => d.shiftCue()),
    "deck.jogTouch": deckAct((d, v) => d.jogTouch(!!v)),
    "deck.jogTurn": deckAct((d, v) => d.jogTurn(v)),
    "deck.jogRing": deckAct((d, v) => d.jogRing(v)),
    "deck.setTempo": deckAct((d, v) => d.setTempo(v)),
    "deck.cycleRange": deckAct((d) => d.cycleRange()),
    "deck.syncPress": deckAct((d, v, c, rig) => d.syncPress(otherOf(rig, c))),
    "deck.loopIn": deckAct((d) => d.loopIn()),
    "deck.loopOut": deckAct((d) => d.loopOut()),
    "deck.fourBeatExit": deckAct((d) => d.fourBeatExit()),
    "deck.shiftFourBeatExit": deckAct((d) => d.shiftFourBeatExit()),
    "deck.loopHalve": callAct("loopHalve"),
    "deck.loopDouble": callAct("loopDouble"),
    "deck.hotCue": cueAct((d, i) => d.hotCue(i)),
    "deck.shiftHotCue": cueAct((d, i) => d.shiftHotCue(i)),
    "deck.beatJump": deckAct((d, i) => d.beatJump(i)),
    "deck.shiftBeatJump": deckAct((d, i) => d.shiftBeatJump(i)),
    "deck.beatLoop": deckAct((d, i) => d.beatLoop(i)),
    "deck.setShift": deckAct((d, v) => d.setShift(!!v)),

    "mixer.setTrim": (rig, v, c) => rig.mixer.setTrim(c.deck, v),
    "mixer.setEq": (rig, v, c) => rig.mixer.setEq(c.deck, c.band, v),
    "mixer.setCfx": (rig, v, c) => rig.mixer.setCfx(c.deck, v),
    "mixer.setFader": (rig, v, c) => rig.mixer.setFader(c.deck, v),
    "mixer.setCue": (rig, v, c) => rig.mixer.setCue(c.deck, !!v),
    "mixer.setCrossfader": (rig, v) => rig.mixer.setCrossfader(v),
    "mixer.setMasterLevel": (rig, v) => rig.mixer.setMasterLevel(v),
    "mixer.setMasterCue": (rig, v) => rig.mixer.setMasterCue(!!v),
    "mixer.setPhonesMix": (rig, v) => rig.mixer.setPhonesMix(v),
    "mixer.setPhonesLevel": (rig, v) => rig.mixer.setPhonesLevel(v),

    "fx.select": (rig, v) => rig.fx.select(v),
    "fx.beat": (rig, v) => rig.fx.beat(v),
    "fx.setTarget": (rig, v) => rig.fx.setTarget(v),
    "fx.setLevel": (rig, v) => rig.fx.setLevel(v),
    "fx.toggle": (rig) => rig.fx.toggle(),

    "sampler.trigger": (rig, i) => rig.sampler.trigger(i),
    "sampler.stop": (rig, i) => rig.sampler.stop(i),

    "strip.load1": () => { load(1); },
    "strip.load2": () => { load(2); },
  };

  // the strip's browse needs no engine
  const direct = {
    "strip.openBrowse": () => { const s = S(); if (s) { if (s.isBrowseOpen) s.closeBrowse(); else s.openBrowse(); } },
    "strip.closeBrowse": () => { const s = S(); if (s) s.closeBrowse(); },
    "strip.browseMove": (v) => { const s = S(); if (s) s.browseMove(v); },
  };

  function record(action, value, c) {
    log.push({ action, value, id: c ? c.id : null, deck: c ? c.deck : null, t: Date.now() });
    if (log.length > 2000) log.splice(0, log.length - 1000);
  }

  const bindings = {};
  for (const [a, fn] of Object.entries(impl)) {
    bindings[a] = (value, c) => {
      record(a, value, c);
      const rig = getRig();
      if (!rig) {
        pending.push([fn, value, c]);
        for (const cb of needCbs) cb();
        return;
      }
      fn(rig, value, c);
    };
  }
  for (const [a, fn] of Object.entries(direct)) {
    bindings[a] = (value, c) => {
      record(a, value, c);
      for (const cb of needCbs) cb();          // any first touch starts the engine
      fn(value, c);
    };
  }

  /** Run what waited for the engine, in order. */
  function flush() {
    const rig = getRig();
    if (!rig) return;
    while (pending.length) {
      const [fn, value, c] = pending.shift();
      fn(rig, value, c);
    }
  }

  /** LOAD n: the highlighted track onto deck n (see the header). */
  async function load(n) {
    const rig = getRig();
    if (!rig) return;
    const i = n - 1;
    const strip = S();
    if (!strip || loading[n]) return;               // one decode at a time per deck (phone memory)
    const file = strip.highlighted();
    if (!file) { strip.flash(i, "nothing to load: carry tracks from the caixa"); return; }
    const deck = rig.decks[i];
    if (LOAD_LOCK && deck.state.playing) { strip.flash(i, LOAD_LOCK_TEXT); return; }
    strip.closeBrowse();
    loading[n] = true;
    deck.unload();
    strip.setLoading(i, file);
    rig.fx.refresh();
    let track;
    try {
      track = await env.loadTrack(rig.ctx, source, file);
    } catch (e) {
      loading[n] = false;
      const s = S();                                // the board may have been left meanwhile
      if (s) {
        s.setTrack(i, null);
        s.flash(i, `could not load: ${String((e && e.message) || e).slice(0, 80)}`);
      }
      return;
    }
    loading[n] = false;
    track.file = file;
    deck.load(track);
    const s = S();                                  // a new board puts the decks' tracks on its strip
    if (s) s.setTrack(i, track);
    rig.fx.refresh();
    if (env.onLoaded) env.onLoaded(n, file);
  }

  function show(b, id, v) {
    if (shown.get(id) === v) return;
    shown.set(id, v);
    if (id.startsWith("blink:")) b.setBlink(id.slice(6), v);
    else if (id.startsWith("mark:")) b.setMark(id.slice(5), v);
    else b.setLit(id, v);
  }

  /** Mirror engine state on the board's lights (only changes touch the DOM). */
  function refreshLights() {
    const rig = getRig();
    const b = boardOf();
    if (!rig || !b) return;
    lightsRuns++;
    const master = masterDeck(rig.decks);
    rig.decks.forEach((d, k) => {
      const n = k + 1;
      const st = d.state;
      const paused = st.loaded && !st.playing;
      const atCue = paused && Math.abs(d.posAt() - st.cuePoint) < AT_CUE_S;
      show(b, `d${n}-play`, st.playing || paused);
      show(b, `blink:d${n}-play`, paused);
      show(b, `d${n}-cue`, st.cueHeld || paused);
      show(b, `blink:d${n}-cue`, paused && !atCue && !st.cueHeld);
      show(b, `d${n}-sync`, st.syncOn);
      show(b, `mark:d${n}-sync`, master === d);
      const L = st.loop;
      show(b, `d${n}-in`, L.active);
      show(b, `d${n}-out`, L.active);
      show(b, `blink:d${n}-in`, L.active && L.adjust === "in");
      show(b, `blink:d${n}-out`, L.active && L.adjust === "out");
      const mode = b.padMode ? b.padMode(n) : "hotcue";
      for (let p = 0; p < 8; p++) {
        let v = false;
        if (mode === "hotcue" && st.hotCues[p]) {
          v = st.hotCues[p].end !== null ? HOT_CUE_COLOURS.loop : HOT_CUE_COLOURS.cue;
        } else if (mode === "beatloop" && L.active && L.pad === p) {
          v = HOT_CUE_COLOURS.loop;
        }
        show(b, `d${n}-pad${p + 1}`, v);
      }
    });
    show(b, "fx-on", !!rig.fx.state.on);
    show(b, "blink:fx-on", !!rig.fx.state.on);
  }

  return {
    bindings,
    load,
    flush,
    refreshLights,
    /** Forget what the lights show (a new board was drawn). */
    resetLights: () => shown.clear(),
    onNeedEngine: (cb) => { needCbs.push(cb); },
    log,
    get lightsRuns() { return lightsRuns; },
  };
}
