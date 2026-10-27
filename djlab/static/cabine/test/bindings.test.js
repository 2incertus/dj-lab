import { test } from "node:test";
import assert from "node:assert/strict";

import { makeBindings, LOAD_LOCK } from "../ui/bindings.js";
import { CONTROLS, PAD_MODES, HOT_CUE_COLOURS } from "../flx4-map.js";
import { Deck } from "../engine/deck.js";

class Voice {
  constructor(log) { this.log = log; this._cb = null; }
  load(pcm) { this.log.push(["load", pcm && pcm.left ? pcm.left.length : 0]); }
  unload() { this.log.push(["unload"]); }
  setRate() {}
  seek() {}
  setLoop() {}
  play() {}
  pause() {}
  onposition(cb) { this._cb = cb; }
  get underruns() { return 0; }
}

const grid = (bpm) => ({ bpm, first_beat_s: 0, downbeat_s: 0, reliable: true });

function setup({ playing = false, stripGone = null } = {}) {
  const log = [];
  const clock = { t: 0 };
  const decks = [1, 2].map(() => new Deck(new Voice(log), { now: () => clock.t, setTimeout: () => 0, clearTimeout: () => {} }));
  const fx = { refreshes: 0, calls: [], state: { on: false, name: "Delay", fraction: 1, target: "1" },
    refresh() { this.refreshes++; }, select(v) { this.calls.push(["select", v]); }, beat(v) { this.calls.push(["beat", v]); },
    setTarget(v) { this.calls.push(["target", v]); }, setLevel(v) { this.calls.push(["level", v]); },
    toggle() { this.state.on = !this.state.on; } };
  const mixer = { calls: [], channel: () => ({ level: () => 0 }) };
  for (const m of ["setTrim", "setEq", "setCfx", "setFader", "setCue", "setCrossfader", "setMasterLevel",
    "setMasterCue", "setPhonesMix", "setPhonesLevel"]) mixer[m] = (...a) => mixer.calls.push([m, ...a]);
  const sampler = { calls: [], trigger(i) { this.calls.push(["trigger", i]); }, stop(i) { this.calls.push(["stop", i]); } };
  const rig = { ctx: { currentTime: 0 }, decks, mixer, fx, sampler };
  const strip = {
    hl: "b.mp3", open: false, flashes: [], loading: [], tracks: [], moves: [],
    highlighted() { return this.hl; },
    get isBrowseOpen() { return this.open; },
    openBrowse() { this.open = true; }, closeBrowse() { this.open = false; },
    browseMove(d) { this.moves.push(d); },
    flash(i, t) { this.flashes.push([i, t]); },
    setLoading(i, f) { this.loading.push([i, f]); log.push(["strip.loading", i]); },
    setTrack(i, t) { this.tracks.push([i, t && t.file]); },
  };
  const saved = [];
  const store = { putHotCues: async (f, c) => { saved.push([f, c.map((h) => (h ? h.start : null))]); } };
  const lit = new Map();
  const board = { notYets: 0, notYet() { this.notYets++; }, padMode: () => "hotcue",
    setLit: (id, v) => lit.set(id, v), setBlink: (id, v) => lit.set(`blink:${id}`, v),
    setMark: (id, v) => lit.set(`mark:${id}`, v), setLevel() {} };
  const loads = [];
  const loadTrack = async (ctx, source, file) => {
    log.push(["decode", file]);
    loads.push(file);
    return { pcm: { left: new Int16Array(441000), right: new Int16Array(441000), sampleRate: 44100 },
      grid: grid(file === "b.mp3" ? 131 : 128), meta: { file, title: file, duration_s: 300 },
      hotCues: new Array(8).fill(null), peaks: null };
  };
  let ready = true;
  const b = makeBindings({ getRig: () => (ready ? rig : null),
    strip: stripGone ? () => (stripGone.gone ? null : strip) : strip, board: () => board, store,
    source: {}, loadTrack });
  return { b, rig, decks, fx, mixer, sampler, strip, store, saved, board, lit, log, clock, loads,
    setReady: (v) => { ready = v; } };
}

const ctl = (id) => CONTROLS.find((c) => c.id === id);
const call = (b, action, value, id) => b.bindings[action](value, id ? ctl(id) : undefined);

test("every_control_action_resolves_to_a_binding", () => {
  const { b } = setup();
  const missing = [];
  for (const c of CONTROLS) {
    if (c.v1 === false) continue;
    for (const k of ["action", "shift", "up", "press", "touch", "ring"]) {
      const a = c[k];
      if (a && !a.startsWith("board.") && typeof b.bindings[a] !== "function") missing.push(`${c.id}.${k}=${a}`);
    }
  }
  for (const m of Object.values(PAD_MODES)) {
    for (const a of [m.action, m.shift]) if (a && typeof b.bindings[a] !== "function") missing.push(a);
  }
  assert.deepEqual(missing, []);
});

test("load_unloads_the_deck_before_decoding_and_closes_the_list", async () => {
  const { b, decks, log, strip, fx } = setup();
  strip.open = true;
  strip.hl = "a.mp3";
  await b.load(1);
  strip.hl = "b.mp3";
  log.length = 0;
  const r0 = fx.refreshes;
  await b.load(1);                                   // a swap on a loaded deck
  const order = log.map((e) => e[0]);
  assert.deepEqual(order.slice(0, 3), ["unload", "strip.loading", "decode"], order);
  assert.equal(order[order.length - 1], "load");
  assert.equal(decks[0].track.file, "b.mp3");
  assert.equal(decks[0].grid.bpm, 131);
  assert.equal(strip.open, false, "loading closes the list");
  assert.ok(fx.refreshes > r0, "Beat FX re-reads the BPM after a load");
});

test("load_lock_refuses_a_playing_deck", async () => {
  assert.equal(LOAD_LOCK, true, "rekordbox default: Load Lock on");
  const { b, decks, strip, loads } = setup();
  strip.hl = "a.mp3";
  await b.load(1);
  call(b, "deck.playPause", true, "d1-play");
  assert.equal(decks[0].state.playing, true);
  strip.hl = "b.mp3";
  await b.load(1);
  assert.equal(decks[0].track.file, "a.mp3", "still the first track");
  assert.equal(decks[0].state.playing, true, "still playing");
  assert.deepEqual(loads, ["a.mp3"], "nothing decoded");
  assert.equal(strip.flashes.length, 1);
  assert.match(strip.flashes[0][1], /load lock/i);
  call(b, "deck.playPause", true, "d1-play");      // paused: loads again
  await b.load(1);
  assert.equal(decks[0].track.file, "b.mp3");
});

test("hot_cues_are_saved_on_every_set_and_clear", async () => {
  const { b, strip, saved } = setup();
  strip.hl = "a.mp3";
  await b.load(1);
  call(b, "deck.hotCue", 2, "d1-pad3");
  await Promise.resolve();
  assert.deepEqual(saved.at(-1), ["a.mp3", [null, null, 0, null, null, null, null, null]]);
  call(b, "deck.hotCue", 2, "d1-pad3");             // calling a set cue: nothing new to save
  assert.equal(saved.length, 1);
  call(b, "deck.shiftHotCue", 2, "d1-pad3");
  await Promise.resolve();
  assert.deepEqual(saved.at(-1)[1], new Array(8).fill(null));
  assert.equal(saved.length, 2);
});

test("call_buttons_with_no_loop_say_not_yet", async () => {
  const { b, decks, board, strip } = setup();
  strip.hl = "a.mp3";
  await b.load(1);
  call(b, "deck.loopHalve", true, "d1-call-prev");
  call(b, "deck.loopDouble", true, "d1-call-next");
  assert.equal(board.notYets, 2);
  call(b, "deck.fourBeatExit", true, "d1-4beat");
  const len = decks[0].state.loop.out - decks[0].state.loop.in;
  call(b, "deck.loopHalve", true, "d1-call-prev");
  assert.equal(board.notYets, 2, "a loop is active: CALL halves it");
  assert.ok(Math.abs(decks[0].state.loop.out - decks[0].state.loop.in - len / 2) < 1e-9);
});

test("tempo_and_sync_refresh_beat_fx_and_sync_pairs_the_decks", async () => {
  const { b, decks, fx, strip } = setup();
  strip.hl = "a.mp3"; await b.load(1);
  strip.hl = "b.mp3"; await b.load(2);
  let r = fx.refreshes;
  call(b, "deck.setTempo", 0.7, "d1-tempo");
  assert.ok(fx.refreshes > r);
  r = fx.refreshes;
  call(b, "deck.syncPress", true, "d2-sync");
  assert.ok(fx.refreshes > r);
  assert.equal(decks[1].state.syncOn, true);
  assert.equal(decks[1]._master, decks[0], "deck 2 follows deck 1");
  r = fx.refreshes;
  call(b, "deck.cycleRange", true, "d1-sync");
  assert.ok(fx.refreshes > r);
});

test("mixer_fx_sampler_and_strip_actions_reach_their_targets", () => {
  const { b, mixer, fx, sampler, strip } = setup();
  call(b, "mixer.setEq", 0.2, "ch2-low");
  call(b, "mixer.setTrim", 0.6, "ch1-trim");
  call(b, "mixer.setCue", true, "ch1-cue");
  call(b, "mixer.setCrossfader", 1, "xfader");
  call(b, "mixer.setMasterCue", true, "master-cue");
  assert.deepEqual(mixer.calls, [["setEq", 2, "low", 0.2], ["setTrim", 1, 0.6], ["setCue", 1, true],
    ["setCrossfader", 1], ["setMasterCue", true]]);
  call(b, "fx.select", -1, "fx-select");
  call(b, "fx.beat", 1, "fx-beat-up");
  call(b, "fx.setTarget", "master", "fx-ch");
  call(b, "fx.toggle", true, "fx-on");
  assert.deepEqual(fx.calls, [["select", -1], ["beat", 1], ["target", "master"]]);
  assert.equal(fx.state.on, true);
  call(b, "sampler.trigger", 3, "d1-pad4");
  call(b, "sampler.stop", 3, "d2-pad4");
  assert.deepEqual(sampler.calls, [["trigger", 3], ["stop", 3]]);
  call(b, "strip.openBrowse", true, "browse");
  assert.equal(strip.open, true);
  call(b, "strip.browseMove", 2, "browse");
  assert.deepEqual(strip.moves, [2]);
  call(b, "strip.openBrowse", true, "browse");      // BROWSE pushed again closes the list
  assert.equal(strip.open, false);
});

test("actions_before_the_engine_exists_wait_for_it", async () => {
  const { b, mixer, setReady } = setup();
  setReady(false);
  const asked = [];
  b.onNeedEngine(() => asked.push(1));
  call(b, "mixer.setFader", 0.3, "ch1-fader");
  assert.deepEqual(mixer.calls, []);
  assert.equal(asked.length, 1);
  setReady(true);
  b.flush();
  assert.deepEqual(mixer.calls, [["setFader", 1, 0.3]]);
  assert.ok(b.log.some((e) => e.action === "mixer.setFader" && e.deck === 1), "every action is logged");
});

test("lights_mirror_the_decks", async () => {
  const { b, decks, lit, strip, fx } = setup();
  strip.hl = "a.mp3"; await b.load(1);
  strip.hl = "b.mp3"; await b.load(2);
  b.refreshLights();
  assert.equal(lit.get("d1-play"), true, "paused at the cue point: PLAY lit ...");
  assert.equal(lit.get("blink:d1-play"), true, "... and flashing");
  assert.equal(lit.get("d1-cue"), true, "CUE lit at the cue point");
  call(b, "deck.playPause", true, "d1-play");
  call(b, "deck.hotCue", 0, "d1-pad1");
  call(b, "deck.syncPress", true, "d2-sync");
  fx.state.on = true;
  b.refreshLights();
  assert.equal(lit.get("d1-play"), true);
  assert.equal(lit.get("blink:d1-play"), false, "playing: steady");
  assert.equal(lit.get("d1-pad1"), HOT_CUE_COLOURS.cue);
  assert.equal(lit.get("d1-pad2"), false);
  assert.equal(lit.get("d2-sync"), true);
  assert.equal(lit.get("d1-sync"), false);
  assert.equal(lit.get("mark:d1-sync"), true, "deck 1 is the sync master");
  assert.equal(lit.get("mark:d2-sync"), false);
  assert.equal(lit.get("fx-on"), true);
  assert.equal(lit.get("blink:fx-on"), true, "Beat FX ON/OFF flashes while on (manual)");
  call(b, "deck.fourBeatExit", true, "d1-4beat");
  b.refreshLights();
  assert.equal(lit.get("d1-in"), true, "IN / OUT lit while a loop plays");
  assert.equal(lit.get("d1-out"), true);
  assert.equal(decks[0].state.loop.active, true);
});

test("play_flashes_while_paused_and_cue_flashes_away_from_the_cue_point", async () => {
  const { b, decks, lit, strip, clock } = setup();
  strip.hl = "a.mp3"; await b.load(1);
  call(b, "deck.playPause", true, "d1-play");      // play from the cue point ...
  clock.t = 2;
  call(b, "deck.playPause", true, "d1-play");      // ... pause 2 s later, away from it
  b.refreshLights();
  assert.equal(lit.get("d1-play"), true);
  assert.equal(lit.get("blink:d1-play"), true, "paused: PLAY flashes");
  assert.equal(lit.get("d1-cue"), true);
  assert.equal(lit.get("blink:d1-cue"), true, "paused away from the cue point: CUE flashes");
  call(b, "deck.shiftCue", true, "d1-cue");          // back to 0 = the cue point
  b.refreshLights();
  assert.equal(lit.get("blink:d1-cue"), false, "at the cue point: CUE steady");
  assert.equal(lit.get("blink:d1-play"), true);
  call(b, "deck.playPause", true, "d1-play");
  b.refreshLights();
  assert.equal(lit.get("d1-cue"), false, "playing: CUE dark");
  assert.equal(lit.get("blink:d1-play"), false);
  assert.equal(lit.get("d2-play"), false, "an empty deck shows nothing");
  assert.equal(lit.get("d2-cue"), false);
  assert.ok(decks[0].state.playing);
});

test("a_second_load_on_a_loading_deck_is_ignored", async () => {
  const { b, strip, loads } = setup();
  strip.hl = "a.mp3";
  const first = b.load(1);
  strip.hl = "b.mp3";
  await b.load(1);                                   // while a.mp3 decodes
  await first;
  assert.deepEqual(loads, ["a.mp3"], "one decode at a time per deck");
});

test("leaving_for_the_caixa_mid_load_still_loads_the_deck", async () => {
  const stripGone = { gone: false };
  const { b, decks, strip } = setup({ stripGone });
  strip.hl = "a.mp3";
  const p = b.load(1);
  stripGone.gone = true;                             // the board (and its strip) went away
  await p;
  assert.equal(decks[0].track.file, "a.mp3", "the deck still gets its track");
});
