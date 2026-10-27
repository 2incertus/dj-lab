import { test } from "node:test";
import assert from "node:assert/strict";

import { Deck, TEMPO_RANGES, BEAT_JUMP_PADS, BEAT_LOOP_PADS, DECK_ACTIONS } from "../engine/deck.js";
import { phaseAt, beatPeriod } from "../engine/grid.js";

// ---- test doubles ---------------------------------------------------------

/** Records every call the deck makes; the test plays the worklet's part by
 *  calling report(s, t) as the real processor posts {type:"pos", s, t}. */
class FakeVoice {
  constructor() {
    this.calls = [];
    this.rate = 1;
    this.immediate = false;
    this.running = false;
    this.pos = 0;
    this.loop = [null, null];
    this.seeks = [];
    this._cb = null;
  }
  load(pcm) { this.calls.push(["load"]); this.pcm = pcm; this.pos = 0; this.running = false; this.loop = [null, null]; }
  setRate(r, immediate = false) { this.calls.push(["rate", r, immediate]); this.rate = r; this.immediate = immediate; }
  seek(s, at) { this.calls.push(["seek", s, at]); this.seeks.push({ s, at }); this.pos = s; }
  setLoop(a, b) { this.calls.push(["loop", a, b]); this.loop = [a, b]; }
  play(at) { this.calls.push(["play", at]); this.running = true; this.playAt = at; }
  pause() { this.calls.push(["pause"]); this.running = false; }
  get position() { return this.pos; }
  onposition(cb) { this._cb = cb; }
  get underruns() { return 0; }
  report(s, t) { this.pos = s; this._cb && this._cb(s, t); }
  lastSeek() { return this.seeks[this.seeks.length - 1]; }
}

/** Audio clock + timers under test control. */
function clock() {
  const c = { t: 0, timers: [] };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const id = { at: c.t + ms / 1000, fn }; c.timers.push(id); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter((x) => x !== id); };
  c.advance = (s) => {
    const end = c.t + s;
    for (;;) {
      c.timers.sort((a, b) => a.at - b.at);
      const next = c.timers[0];
      if (!next || next.at > end + 1e-12) break;
      c.timers.shift();
      c.t = Math.max(c.t, next.at);
      next.fn();
    }
    c.t = end;
  };
  return c;
}

const grid = (bpm, first = 0, extra = {}) =>
  ({ bpm, first_beat_s: first, downbeat_s: first, beat_cv: 0.02, reliable: true, source: "test", fixed: false, ...extra });

const track = (g, dur = 300) => ({
  pcm: { left: new Int16Array(0), right: new Int16Array(0), sampleRate: 44100 },
  grid: g,
  meta: { file: "t.wav", duration_s: dur, bpm: g ? g.bpm : 125 },
  hotCues: null,
});

function setup(g = grid(120)) {
  const c = clock();
  const v = new FakeVoice();
  const d = new Deck(v, { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  d.load(track(g));
  return { c, v, d };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const circ = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

// ---- transport ------------------------------------------------------------

test("cue_while_paused_sets_point_and_holds_to_preview", () => {
  const { v, d } = setup(null);                 // no grid: cue lands exactly on the playhead
  v.report(10.2, 0);
  d.cueDown();
  assert.equal(d.state.cuePoint, 10.2);
  assert.equal(v.running, true, "holding CUE plays from the cue point");
  assert.equal(d.state.playing, true);
  d.cueUp();
  assert.equal(v.running, false);
  assert.equal(d.state.playing, false);
  assert.equal(v.lastSeek().s, 10.2, "release returns to the cue point");
});

test("cue_while_paused_quantizes_to_the_grid", () => {
  const { v, d } = setup(grid(120));
  v.report(10.2, 0);
  d.cueDown();
  assert.equal(d.state.cuePoint, 10.0);
  d.cueUp();
  assert.equal(v.lastSeek().s, 10.0);
});

test("cue_while_playing_returns_and_pauses", () => {
  const { c, v, d } = setup(null);
  v.report(10.2, 0);
  d.cueDown(); d.cueUp();                      // cue at 10.2
  d.playPause();
  c.t = 20;
  v.report(30, 20);
  d.cueDown();
  assert.equal(d.state.playing, false);
  assert.equal(v.running, false);
  assert.equal(v.lastSeek().s, 10.2);
  d.cueUp();
  assert.equal(v.running, false, "release after Back Cue does nothing");
});

test("play_pressed_while_cue_held_keeps_playing", () => {
  const { v, d } = setup(null);
  v.report(5, 0);
  d.cueDown();
  d.playPause();
  d.cueUp();
  assert.equal(d.state.playing, true);
  assert.equal(v.running, true);
});

test("shift_cue_goes_to_track_start_and_shift_play_does_nothing", () => {
  const { v, d } = setup();
  d.playPause();
  v.report(42, 0);
  d.shiftCue();
  assert.equal(v.lastSeek().s, 0);
  assert.equal(d.state.playing, true);
  const before = v.calls.length;
  d.shiftPlayPause();
  assert.equal(v.calls.length, before, "rekordbox: SHIFT + PLAY/PAUSE has no function");
  assert.equal(d.state.playing, true);
});

// ---- tempo -----------------------------------------------------------------

test("tempo_fader_down_is_faster", () => {
  const { v, d } = setup();
  assert.equal(d.state.range, 10, "default range +-10");
  d.setTempo(1);
  assert.ok(near(v.rate, 1.10), `rate ${v.rate}`);
  assert.ok(near(d.state.tempoPct, 10));
  d.setTempo(0.5);
  assert.ok(near(v.rate, 1.0));
  d.setTempo(0);
  assert.ok(near(v.rate, 0.90));
  assert.ok(near(d.effectiveBpm(), 108));
});

test("tempo_fine_resolution", () => {
  const { v, d } = setup();
  d.cycleRange(); d.cycleRange(); d.cycleRange();       // 10 -> 16 -> WIDE -> 6
  assert.equal(d.state.range, 6);
  let prev = null, worst = 0;
  for (let i = 2400; i <= 2600; i++) {
    d.setTempo(i / 5000);
    if (prev !== null) worst = Math.max(worst, Math.abs(v.rate - prev));
    prev = v.rate;
  }
  assert.ok(worst <= 0.0002 && worst > 0, `step ${worst}`);
});

test("range_cycles_6_10_16_wide", () => {
  const { v, d } = setup();
  d.setTempo(1);
  const seen = [];
  for (let i = 0; i < 4; i++) { d.cycleRange(); seen.push(d.state.range); }
  assert.deepEqual(seen, [16, 100, 6, 10]);
  assert.deepEqual(TEMPO_RANGES, [6, 10, 16, 100]);
  assert.ok(near(v.rate, 1.10), "slider position kept, tempo follows the range");
});

// ---- sync ------------------------------------------------------------------

function twoDecks(gA, gB) {
  const c = clock();
  const vA = new FakeVoice(), vB = new FakeVoice();
  const opts = { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout };
  const A = new Deck(vA, opts), B = new Deck(vB, opts);
  A.load(track(gA)); B.load(track(gB));
  return { c, vA, vB, A, B };
}

test("sync_matches_bpm_and_phase", () => {
  const gA = grid(128, 0), gB = grid(131, 0.137);
  const { c, vA, vB, A, B } = twoDecks(gA, gB);
  A.playPause(); B.playPause();
  c.t = 3;
  const sA = 10.25 * beatPeriod(gA);           // deck A at phase 0.25
  vA.report(sA, 3);
  vB.report(5.0, 3);
  assert.ok(near(phaseAt(gA, A.posAt(3)), 0.25));
  B.syncPress(A);
  assert.equal(B.state.syncOn, true);
  assert.ok(near(B.effectiveBpm(), 128), `bpm ${B.effectiveBpm()}`);
  assert.ok(near(vB.rate, 128 / 131));
  const { s, at } = vB.lastSeek();
  assert.ok(at > 3, "the phase jump is scheduled ahead on the audio clock");
  const aAt = sA + (at - 3) * 1.0;             // where A is at that moment, independently
  const errS = circ(phaseAt(gB, s), phaseAt(gA, aAt)) * beatPeriod(gA);
  assert.ok(errS < 0.001, `phase error ${errS * 1000} ms`);
  assert.ok(Math.abs(s - (5.0 + (at - 3) * 128 / 131)) <= beatPeriod(gB) / 2 + 1e-9, "never jumps more than half a beat");
});

test("synced_play_from_pause_starts_on_the_aligned_frame", () => {
  const gA = grid(128, 0), gB = grid(131, 0.137);
  const { c, vA, vB, A, B } = twoDecks(gA, gB);
  A.playPause();
  c.t = 3;
  const sA = 10.25 * beatPeriod(gA);           // master at phase 0.25
  vA.report(sA, 3);
  vB.report(5.0, 3);                           // B paused at its cue
  B.syncPress(A);
  const n = vB.calls.length;
  B.playPause();
  const after = vB.calls.slice(n);
  const plays = after.filter((x) => x[0] === "play");
  const seeks = after.filter((x) => x[0] === "seek");
  assert.equal(plays.length, 1);
  assert.equal(seeks.length, 1);
  const at = plays[0][1];
  assert.ok(at > 3, "start is scheduled, never 'now': nothing plays before the aligned seek");
  assert.equal(seeks[0][2], at, "seek and start land on the same audio-clock time");
  const idxSeek = after.indexOf(seeks[0]), idxPlay = after.indexOf(plays[0]);
  assert.ok(idxSeek < idxPlay, "the seek is queued before the start");
  const s = seeks[0][1];
  const aAt = sA + (at - 3);
  const errS = circ(phaseAt(gB, s), phaseAt(gA, aAt)) * beatPeriod(gA);
  assert.ok(errS < 0.001, `phase error ${errS * 1000} ms`);
  assert.ok(Math.abs(s - 5.0) <= beatPeriod(gB) / 2 + 1e-9, "cue shifted by at most half a beat");
  assert.ok(near(B.posAt(at), s), "the deck's own model agrees");
  assert.ok(near(B.posAt(at + 1), s + 128 / 131));
});

test("unsynced_play_from_pause_starts_now", () => {
  const { v, d } = setup();
  d.playPause();
  const p = v.calls.filter((x) => x[0] === "play");
  assert.equal(p.length, 1);
  assert.equal(p[0][1], undefined, "play() with no time = now");
});

test("sync_follows_master_tempo_and_cancels", () => {
  const { vB, A, B } = twoDecks(grid(128), grid(131));
  A.playPause(); B.playPause();
  B.syncPress(A);
  A.setTempo(1);                                // A to 128 * 1.10
  assert.ok(near(B.effectiveBpm(), 140.8), `follows: ${B.effectiveBpm()}`);
  B.setTempo(0.2);                             // slider on a synced deck is ignored
  assert.ok(near(B.effectiveBpm(), 140.8));
  B.syncPress(A);                              // cancel
  assert.equal(B.state.syncOn, false);
  assert.ok(near(B.effectiveBpm(), 140.8), "cancel keeps the synced tempo");
  B.setTempo(0.5);
  assert.ok(near(vB.rate, 1.0), "slider takes over again");
  A.setTempo(0.5);
  assert.ok(near(vB.rate, 1.0), "no longer follows");
});

test("deck_no_grid_disables_sync", () => {
  const { vB, A, B } = twoDecks(grid(128), grid(131, 0, { reliable: false }));
  assert.equal(B.state.noGrid, true);
  assert.equal(A.state.noGrid, false);
  A.playPause(); B.playPause();
  const n = vB.calls.length;
  B.syncPress(A);
  assert.equal(B.state.syncOn, false);
  assert.equal(vB.calls.length, n, "no rate change, no seek");
  // and the other way round: a reliable deck cannot sync to a gridless one
  const t2 = twoDecks(grid(128), null);
  t2.A.syncPress(t2.B);
  assert.equal(t2.A.state.syncOn, false);
  assert.equal(t2.B.state.noGrid, true);
});

test("load_turns_sync_off", () => {
  const { A, B } = twoDecks(grid(128), grid(131));
  B.syncPress(A);
  assert.equal(B.state.syncOn, true);
  B.load(track(grid(125)));
  assert.equal(B.state.syncOn, false);
});

// ---- loops -----------------------------------------------------------------

test("four_beat_loop_and_exit", () => {
  const { v, d } = setup(grid(120));
  d.playPause();
  v.report(10.1, 0);
  d.fourBeatExit();
  assert.deepEqual([d.state.loop.in, d.state.loop.out, d.state.loop.active], [10.0, 12.0, true]);
  assert.deepEqual(v.loop, [10.0, 12.0]);
  d.fourBeatExit();
  assert.equal(d.state.loop.active, false);
  assert.deepEqual(v.loop, [null, null]);
  assert.equal(d.state.playing, true, "exit keeps playing");
});

test("halve_double_only_with_loop", () => {
  const { v, d } = setup(grid(120));
  d.playPause();
  v.report(10.1, 0);
  d.loopHalve(); d.loopDouble();
  assert.equal(d.state.loop.active, false);
  assert.deepEqual(v.loop, [null, null]);
  d.fourBeatExit();
  d.loopHalve();
  assert.deepEqual(v.loop, [10.0, 11.0]);
  d.loopDouble(); d.loopDouble();
  assert.deepEqual(v.loop, [10.0, 14.0]);
  assert.equal(d.state.loop.out, 14.0);
});

test("halving_past_the_playhead_wraps_inside_the_new_loop", () => {
  const { c, v, d } = setup(grid(120));
  d.playPause();
  v.report(10.1, 0);
  d.fourBeatExit();                            // 10..12
  c.t = 1.5;
  v.report(11.6, 1.5);
  d.loopHalve();                               // 10..11, playhead at 11.6 -> 10.6
  assert.deepEqual(v.loop, [10.0, 11.0]);
  assert.ok(near(v.lastSeek().s, 10.6), `seek ${v.lastSeek().s}`);
});

test("manual_loop_in_out_and_adjust", () => {
  const { c, v, d } = setup(grid(120));
  d.playPause();
  v.report(20.04, 0);
  d.loopIn();
  assert.equal(d.state.loop.in, 20.0);
  assert.equal(d.state.loop.active, false);
  c.t = 3; v.report(23.03, 3);
  d.loopOut();
  assert.deepEqual(v.loop, [20.0, 23.0]);
  assert.equal(d.state.loop.active, true);
  d.loopIn();                                  // during loop playback: adjust IN with the jog
  assert.equal(d.state.loop.adjust, "in");
  d.jogTurn(72);                               // 72 deg = 0.2 turn = 0.1 s
  assert.ok(near(v.loop[0], 20.1), `in ${v.loop[0]}`);
  d.loopIn();
  assert.equal(d.state.loop.adjust, null);
});

test("beat_loop_pads_and_same_pad_cancels", () => {
  const { v, d } = setup(grid(120));
  assert.deepEqual(BEAT_LOOP_PADS, [0.25, 0.5, 1, 2, 4, 8, 16, 32]);
  d.playPause();
  v.report(10.3, 0);
  d.beatLoop(0);                                // 1/4 beat loop from the quarter at/below 10.3
  assert.deepEqual(v.loop, [10.25, 10.375]);
  d.beatLoop(5);                                // 8 beats, same in point
  assert.deepEqual(v.loop, [10.25, 14.25]);
  d.beatLoop(5);
  assert.equal(d.state.loop.active, false);
  assert.deepEqual(v.loop, [null, null]);
});

test("shift_four_beat_arms_the_nearest_saved_loop", () => {
  const { c, v, d } = setup(grid(120));
  d.playPause();
  v.report(10.1, 0);
  d.fourBeatExit();
  d.hotCue(2);                                 // saves loop 10..12 on pad C
  assert.deepEqual(d.state.hotCues[2], { start: 10.0, end: 12.0 });
  d.fourBeatExit();
  c.t = 1; v.report(30, 1);
  const n = v.seeks.length;
  d.shiftFourBeatExit();
  assert.equal(d.state.activeLoop, 2);
  assert.deepEqual(v.loop, [10.0, 12.0]);
  assert.equal(v.seeks.length, n, "arming does not move the playhead");
  d.shiftFourBeatExit();
  assert.equal(d.state.activeLoop, null);
  assert.deepEqual(v.loop, [null, null]);
});

// ---- hot cues and beat jump -------------------------------------------------

test("hotcue_set_jump_clear", () => {
  const { c, v, d } = setup(grid(120));
  v.report(20.2, 0);
  d.hotCue(0);
  assert.deepEqual(d.state.hotCues[0], { start: 20.0, end: null });
  assert.equal(v.running, false, "setting does not play");
  v.report(40, 0);
  d.hotCue(0);                                 // paused: playback starts from the hot cue
  assert.equal(v.lastSeek().s, 20.0);
  assert.equal(d.state.playing, true);
  assert.equal(v.running, true);
  c.t = 2; v.report(41.1, 2);
  d.hotCue(0);                                 // playing + quantize: keep the beat phase
  const { s, at } = v.lastSeek();
  const posAtJump = 41.1 + (at - 2);
  assert.ok(near(phaseAt(grid(120), s), phaseAt(grid(120), posAtJump), 1e-9));
  assert.ok(s >= 20.0 && s < 20.5);
  d.shiftHotCue(0);
  assert.equal(d.state.hotCues[0], null);
  d.shiftHotCue(0);                            // clearing an empty pad is harmless
  assert.equal(d.state.hotCues[0], null);
});

test("hotcues_come_from_the_track", () => {
  const { d } = setup();
  const t = track(grid(120));
  t.hotCues = [{ start: 1, end: null }, null, { start: 3, end: 5 }];
  d.load(t);
  assert.equal(d.state.hotCues.length, 8);
  assert.deepEqual(d.state.hotCues[2], { start: 3, end: 5 });
  assert.equal(d.state.hotCues[7], null);
});

test("beat_jump_keeps_phase", () => {
  const { c, v, d } = setup(grid(120));
  assert.deepEqual(BEAT_JUMP_PADS, [-1, 1, -2, 2, -4, 4, -8, 8]);
  d.playPause();
  c.t = 1; v.report(10.1, 1);
  d.beatJump(5);                               // +4 beats
  let { s, at } = v.lastSeek();
  assert.ok(near(s - (10.1 + (at - 1)), 2.0), `moved ${s - (10.1 + (at - 1))}`);
  c.t = 2; v.report(30.3, 2);
  d.beatJump(4);                               // -4 beats
  ({ s, at } = v.lastSeek());
  assert.ok(near(s - (30.3 + (at - 2)), -2.0));
  c.t = 3;
  d.playPause();                               // paused: immediate, exact
  v.report(50.0, 3);
  d.beatJump(1);
  assert.ok(near(v.lastSeek().s, 50.5));
});

test("shift_beat_jump_pads_7_8_scale_the_jump", () => {
  const { v, d } = setup(grid(120));
  v.report(50, 0);
  d.shiftBeatJump(7);                          // up: 2, 4, 8, 16
  d.beatJump(1);
  assert.ok(near(v.lastSeek().s, 51.0));
  d.shiftBeatJump(6); d.shiftBeatJump(6);      // down twice: 1/2 ...
  v.report(50, 0);
  d.beatJump(1);
  assert.ok(near(v.lastSeek().s, 50.25));
  for (let i = 0; i < 10; i++) d.shiftBeatJump(7);
  v.report(50, 0);
  d.beatJump(7);                               // capped at 64 beats
  assert.ok(near(v.lastSeek().s, 50 + 64 * 0.5));
});

// ---- jog -------------------------------------------------------------------

test("jog_touch_scrubs_and_release_restores_rate", () => {
  const { c, v, d } = setup(grid(120));
  d.setTempo(1);                               // 1.10
  d.playPause();
  v.report(10, 0);
  d.jogTouch(true);
  assert.equal(v.rate, 0, "touching the platter holds the record");
  assert.equal(v.immediate, true);
  c.advance(0.01);
  d.jogTurn(36);                               // 0.1 turn = 0.18 s forward
  assert.ok(v.rate > 0 && v.immediate, `scratch rate ${v.rate}`);
  c.advance(0.01);
  d.jogTurn(-72);
  assert.ok(v.rate < 0, "backward");
  c.advance(1.0);                              // finger still, record catches up and stops
  assert.equal(v.rate, 0);
  d.jogTouch(false);
  assert.ok(near(v.rate, 1.10), `release rate ${v.rate}`);
  assert.equal(v.running, true);
  assert.equal(d.state.playing, true);
});

test("jog_scrub_while_paused_stays_paused", () => {
  const { c, v, d } = setup(grid(120));
  v.report(10, 0);
  d.jogTouch(true);
  assert.equal(v.running, true, "scrubbing runs the voice");
  d.jogTurn(-36);
  assert.ok(v.rate < 0);
  c.advance(0.5);
  d.jogTouch(false);
  assert.equal(v.running, false);
  assert.equal(d.state.playing, false);
});

test("jog_ring_nudges_only_while_turning", () => {
  const { c, v, d } = setup(grid(120));
  d.playPause();
  c.advance(0.1);
  d.jogRing(20);
  assert.ok(v.rate > 1.0, `bend up ${v.rate}`);
  assert.ok(v.rate < 1.31);
  c.advance(0.2);
  assert.ok(near(v.rate, 1.0), `released ${v.rate}`);
  d.jogRing(-20);
  assert.ok(v.rate < 1.0);
  c.advance(0.2);
  assert.ok(near(v.rate, 1.0));
});

test("shift_jog_top_is_fast_search", () => {
  const { v, d } = setup(grid(120));
  d.playPause();
  v.report(10, 0);
  d.setShift(true);
  d.jogTurn(360);                              // one turn = 1.8 s x 16
  assert.ok(near(v.lastSeek().s, 10 + 1.8 * 16), `search ${v.lastSeek().s}`);
  d.setShift(false);
  assert.equal(d.state.shift, false);
});

// ---- contract -------------------------------------------------------------

test("every control-map action is a Deck method", () => {
  for (const name of DECK_ACTIONS) {
    assert.equal(typeof Deck.prototype[name], "function", name);
  }
  for (const name of ["playPause", "shiftPlayPause", "cueDown", "cueUp", "shiftCue", "jogTouch",
    "jogTurn", "jogRing", "setTempo", "cycleRange", "syncPress", "loopIn", "loopOut",
    "fourBeatExit", "shiftFourBeatExit", "loopHalve", "loopDouble", "hotCue", "shiftHotCue",
    "beatJump", "beatLoop", "effectiveBpm", "load"]) {
    assert.ok(DECK_ACTIONS.includes(name), name);
  }
});

test("nothing happens on an empty deck", () => {
  const c = clock();
  const v = new FakeVoice();
  const d = new Deck(v, { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  for (const name of DECK_ACTIONS) {
    if (name === "load" || name === "effectiveBpm") continue;
    d[name](0);
  }
  assert.equal(v.calls.length, 0);
  assert.equal(d.state.loaded, false);
});
