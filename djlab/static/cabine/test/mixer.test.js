import { test } from "node:test";
import assert from "node:assert/strict";

import {
  trimGain, eqGainDb, dbToGain, cfxFilter, crossfaderGains, faderGain, phonesMixGains,
  levelGain, TRIM_MAX_DB, EQ_MAX_DB, CFX_DEAD_ZONE, CF_CUT_LAG, EQ_BANDS,
  OUTPUT_LEVEL_DB, CLIP_KNEE, softClip, softClipCurve, CLIP_RANGE,
  Mixer, MIXER_ACTIONS, CHANNEL_ACTIONS,
} from "../engine/mixer.js";
import { BeatFx, FX_NAMES, FX_FRACTIONS, FX_TARGETS, BEATFX_ACTIONS, fxBeatSeconds } from "../engine/fx.js";
import { Sampler, SAMPLER_PADS, SAMPLER_ACTIONS } from "../engine/sampler.js";
import { Deck } from "../engine/deck.js";
import { FakeContext, FakeDeck, FakeVoice } from "./fake-audio.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const db = (g) => 20 * Math.log10(g);

// ---- pure mixer math ----------------------------------------------------------

test("eq_kill_at_zero", () => {
  assert.equal(eqGainDb(0), -Infinity);
  assert.equal(dbToGain(eqGainDb(0)), 0, "a killed band passes nothing");
  assert.equal(eqGainDb(-0.1), -Infinity, "below the knob's travel is still a kill");
  assert.ok(eqGainDb(0.01) < -60, `just above the stop is nearly silent: ${eqGainDb(0.01)}`);
  let prev = -Infinity;
  for (let k = 0.01; k <= 1.0001; k += 0.01) {
    const g = eqGainDb(Math.min(k, 1));
    assert.ok(g > prev, `monotonic at ${k}`);
    prev = g;
  }
});

test("eq_unity_at_center", () => {
  assert.equal(eqGainDb(0.5), 0);
  assert.equal(dbToGain(0), 1);
  assert.equal(eqGainDb(1), EQ_MAX_DB);
  assert.equal(EQ_MAX_DB, 6);
  assert.deepEqual(EQ_BANDS, ["hi", "mid", "low"]);
  assert.ok(near(eqGainDb(0.75), EQ_MAX_DB / 2), "boost is linear in dB above center");
});

test("trim_unity_at_center_silent_at_minimum", () => {
  assert.equal(trimGain(0.5), 1);
  assert.equal(trimGain(0), 0, "fully counterclockwise: the manual's setup starts here");
  assert.ok(near(db(trimGain(1)), TRIM_MAX_DB, 1e-9));
  assert.equal(TRIM_MAX_DB, 9);
  assert.ok(near(db(trimGain(0.25)), -18.06, 0.01), "a quarter turn is about -18 dB");
  assert.ok(trimGain(0.49) < 1 && trimGain(0.51) > 1);
});

test("cfx_off_near_center_lowpass_left_highpass_right", () => {
  assert.equal(CFX_DEAD_ZONE, 0.02);
  for (const k of [0.5, 0.48, 0.52, 0.5 - 0.0199, 0.5 + 0.0199]) {
    assert.equal(cfxFilter(k).type, "off", `off at ${k}`);
  }
  const l = cfxFilter(0.47), r = cfxFilter(0.53);
  assert.equal(l.type, "lowpass");
  assert.equal(r.type, "highpass");
  assert.ok(l.freq > 15000, `just left of the dead zone the cutoff is still high: ${l.freq}`);
  assert.ok(r.freq < 30, `just right of it the cutoff is still low: ${r.freq}`);
  // counterclockwise lowers the low-pass cutoff, clockwise raises the high-pass cutoff
  let prev = Infinity;
  for (let k = 0.47; k >= 0; k -= 0.01) {
    const f = cfxFilter(Math.max(k, 0));
    assert.equal(f.type, "lowpass");
    assert.ok(f.freq < prev, `lowpass falls at ${k}`);
    prev = f.freq;
  }
  prev = 0;
  for (let k = 0.53; k <= 1; k += 0.01) {
    const f = cfxFilter(Math.min(k, 1));
    assert.equal(f.type, "highpass");
    assert.ok(f.freq > prev, `highpass rises at ${k}`);
    prev = f.freq;
  }
  assert.ok(cfxFilter(0).freq <= 100, "full left leaves only the lows");
  assert.ok(cfxFilter(1).freq >= 8000, "full right leaves only the highs");
  assert.ok(cfxFilter(0).q > 1.5 && cfxFilter(1).q > 1.5, "resonant at the ends");
});

test("crossfader_center_both_audible_ends_exclusive", () => {
  const [a, b] = crossfaderGains(0.5);
  assert.ok(near(a, b), "center is balanced");
  assert.ok(a > 0.5 && b > 0.5, `both audible at center: ${a} ${b}`);
  assert.deepEqual(crossfaderGains(0), [1, 0]);
  assert.deepEqual(crossfaderGains(1), [0, 1]);
  // Cut Lag (manual p. 78, default 1.0 mm): the far side stays fully cut near each edge
  assert.ok(CF_CUT_LAG > 0 && CF_CUT_LAG < 0.05);
  assert.deepEqual(crossfaderGains(CF_CUT_LAG * 0.9), [1, 0]);
  assert.deepEqual(crossfaderGains(1 - CF_CUT_LAG * 0.9), [0, 1]);
  assert.ok(crossfaderGains(CF_CUT_LAG + 0.01)[1] > 0, "past the lag the far side comes in");
  let pa = Infinity, pb = -Infinity;
  for (let x = 0; x <= 1.0001; x += 0.02) {
    const [ga, gb] = crossfaderGains(Math.min(x, 1));
    assert.ok(ga <= pa && gb >= pb, `monotonic at ${x}`);
    pa = ga; pb = gb;
  }
});

test("fader_and_level_tapers", () => {
  assert.equal(faderGain(0), 0);
  assert.equal(faderGain(1), 1);
  assert.ok(faderGain(0.5) > 0 && faderGain(0.5) < 0.5);
  assert.equal(levelGain(0), 0);
  assert.equal(levelGain(1), 1);
  const [c0, m0] = phonesMixGains(0), [c1, m1] = phonesMixGains(1), [cc, mc] = phonesMixGains(0.5);
  assert.deepEqual([c0, m0], [1, 0], "MIX full left: cue only");
  assert.ok(near(c1, 0, 1e-12) && m1 === 1, "MIX full right: master only");
  assert.ok(near(cc, mc) && cc > 0.5, "center blends both");
});

test("output_level_headroom_and_soft_clip", () => {
  // rekordbox Preferences > Mixer > Output Level, internal mixer: -21 .. -3 dB / NONE
  assert.ok([-21, -18, -15, -12, -9, -6, -3].includes(OUTPUT_LEVEL_DB), `${OUTPUT_LEVEL_DB}`);
  assert.equal(OUTPUT_LEVEL_DB, -6);
  for (const x of [0, 0.1, -0.3, CLIP_KNEE, -CLIP_KNEE]) assert.equal(softClip(x), x, `transparent at ${x}`);
  let prev = -Infinity;
  for (let x = -CLIP_RANGE; x <= CLIP_RANGE; x += 0.01) {
    const y = softClip(x);
    assert.ok(Math.abs(y) < 1, `ceiling at ${x}: ${y}`);
    assert.ok(y >= prev, `monotonic at ${x}`);
    assert.ok(Math.abs(y + softClip(-x)) < 1e-12, "odd");
    prev = y;
  }
  assert.ok(softClip(1) > 0.85 && softClip(2) > 0.95, "loud peaks are squeezed, not crushed");
  const curve = softClipCurve(1025);
  assert.equal(curve.length, 1025);
  assert.equal(curve[512], 0);
  assert.ok(Math.abs(curve[512 + 32] - softClip(CLIP_RANGE * 32 / 512)) < 1e-6);
});

test("mixer_has_headroom_on_every_channel_and_clippers_on_both_ears", () => {
  const ctx = new FakeContext();
  const m = new Mixer(ctx);
  for (const n of [1, 2]) {
    const ch = m.channel(n);
    assert.ok(Math.abs(ch.input.gain.value - dbToGain(OUTPUT_LEVEL_DB)) < 1e-12, "deck output level");
    assert.ok(ch.input.connectedTo(ch._nodes.trim));
  }
  const shapers = ctx.of("waveshaper");
  assert.equal(shapers.length, 2, "one clipper per ear");
  for (const w of shapers) assert.ok(w.curve && w.curve.length > 1000);
  assert.ok(m._masterClip.connectedTo(m.masterTap) || m._masterClip.outputs.some((o) => o.dest === m.masterTap),
    "the recorder taps after the master clipper");
});

// ---- Mixer graph (fake context: wiring, not sound) ---------------------------

test("mixer_output_is_a_two_input_merger_and_exposes_the_master_tap", () => {
  const ctx = new FakeContext();
  const m = new Mixer(ctx);
  assert.equal(m.output.kind, "merger");
  assert.equal(m.output.numberOfInputs, 2);
  assert.ok(m.masterTap && typeof m.masterTap.connect === "function");
  assert.ok(m.channel(1).input && m.channel(2).input);
  assert.throws(() => m.channel(3));
  for (const t of [1, 2, "1", "2", "master"]) {
    const ins = m.fxSend(t);
    assert.ok(ins.send && ins.ret, `insert ${t}`);
  }
  assert.equal(m.fxSend("1"), m.fxSend(1));
});

test("mixer_controls_drive_their_gains", () => {
  const ctx = new FakeContext();
  const m = new Mixer(ctx);
  const ch = m.channel(1);
  ch.setFader(0.5);
  assert.ok(near(ch._nodes.fader.gain.value, faderGain(0.5)));
  ch.setTrim(1);
  assert.ok(near(ch._nodes.trim.gain.value, trimGain(1)));
  ch.setEq("low", 0);
  assert.equal(ch._nodes.bands.low.gain.value, 0);
  ch.setCue(true);
  assert.equal(ch._nodes.cue.gain.value, 1);
  ch.setCue(false);
  assert.equal(ch._nodes.cue.gain.value, 0);
  m.setCrossfader(0);
  assert.equal(m.channel(1)._nodes.xf.gain.value, 1);
  assert.equal(m.channel(2)._nodes.xf.gain.value, 0);
  m.setTrim(2, 0.25);                            // the board's (channel, value) form
  assert.ok(near(m.channel(2)._nodes.trim.gain.value, trimGain(0.25)));
  assert.equal(m.state.channels[1].trim, 0.25);
});

test("every mixer action is a method", () => {
  for (const name of MIXER_ACTIONS) assert.equal(typeof Mixer.prototype[name], "function", name);
  const ch = new Mixer(new FakeContext()).channel(1);
  for (const name of CHANNEL_ACTIONS) assert.equal(typeof ch[name], "function", name);
  for (const name of ["setCrossfader", "setMasterLevel", "setMasterCue", "setPhonesMix",
    "setPhonesLevel", "setTrim", "setEq", "setCfx", "setFader", "setCue", "level"]) {
    assert.ok(MIXER_ACTIONS.includes(name), name);
  }
});

// ---- Beat FX ------------------------------------------------------------------

function fxRig({ bpm = 128, decks = [new FakeDeck(), new FakeDeck()] } = {}) {
  const ctx = new FakeContext();
  const mixer = new Mixer(ctx);
  const fx = new BeatFx(ctx, mixer, () => bpm, { decks });
  return { ctx, mixer, fx, decks };
}

test("fx_order_and_fraction_steps", () => {
  assert.deepEqual(FX_NAMES, ["Delay", "Echo", "Reverb", "Flanger", "Roll"]);
  assert.deepEqual(FX_FRACTIONS, [0.25, 0.5, 0.75, 1, 2, 4]);
  assert.deepEqual(FX_TARGETS, ["1", "2", "master"]);
  const { fx } = fxRig();
  assert.equal(fx.state.name, "Delay");
  const seen = [];
  for (let i = 0; i < 5; i++) { seen.push(fx.state.name); fx.select(1); }
  assert.deepEqual(seen, FX_NAMES, "FX SELECT walks the list in order");
  assert.equal(fx.state.name, "Delay", "and wraps");
  fx.select(-1);                                 // SHIFT + FX SELECT: reverse order
  assert.equal(fx.state.name, "Roll");
  fx.select(1);
  assert.equal(fx.state.fraction, 1, "default 1 beat");
  const down = [];
  for (let i = 0; i < 4; i++) { fx.beat(-1); down.push(fx.state.fraction); }
  assert.deepEqual(down, [0.75, 0.5, 0.25, 0.25], "BEAT < halves down and stops at 1/4");
  const up = [];
  for (let i = 0; i < 6; i++) { fx.beat(1); up.push(fx.state.fraction); }
  assert.deepEqual(up, [0.5, 0.75, 1, 2, 4, 4], "BEAT > steps up and stops at 4");
  fx.setTarget("master");
  assert.equal(fx.state.target, "master");
  fx.cycleTarget();
  assert.equal(fx.state.target, "1", "tap cycles 1 > 2 > master > 1");
  assert.throws(() => fx.setTarget("3"));
});

test("fx_delay_time_tracks_bpm", () => {
  assert.ok(near(fxBeatSeconds(128, 0.5), 0.234375));
  assert.ok(near(fxBeatSeconds(null, 1), 0.5), "no BPM: 120");
  let bpm = 128;
  const ctx = new FakeContext();
  const fx = new BeatFx(ctx, new Mixer(ctx), () => bpm, { decks: [] });
  fx.beat(-1); fx.beat(-1);                       // 1/2
  fx.setOn(true);
  assert.ok(near(fx._units.Delay.delay.delayTime.value, 0.234375));
  bpm = 120;
  fx.refresh();
  assert.ok(near(fx._units.Delay.delay.delayTime.value, 0.25), "follows a tempo change");
});

test("fx_off_closes_the_input_and_keeps_the_tail", () => {
  const { fx } = fxRig();
  fx.select(1);                                   // Echo
  fx.setLevel(1);
  fx.setOn(true);
  assert.equal(fx._units.Echo.gate.gain.value, 1);
  fx.setOn(false);
  assert.equal(fx._units.Echo.gate.gain.value, 0, "no new input after off");
  assert.ok(fx._wet.gain.value > 0, "the echo already in the loop rings out");
  assert.equal(fx.state.on, false);
});

test("roll_rolls_the_target_deck_and_master_holds_both_decks", () => {
  const decks = [new FakeDeck(true), new FakeDeck(true)];
  const { fx } = fxRig({ decks });
  for (let i = 0; i < 4; i++) fx.select(1);       // Roll
  assert.equal(fx.state.name, "Roll");
  fx.beat(-1);                                    // 3/4
  fx.setTarget("2");
  fx.setOn(true);
  assert.deepEqual(decks[1].rolls, [0.75]);
  assert.deepEqual(decks[0].rolls, []);
  fx.beat(1);                                     // a new length while rolling
  assert.deepEqual(decks[1].rolls, [0.75, 1]);
  fx.setOn(false);
  assert.deepEqual(decks[1].rolls, [0.75, 1, null]);
  decks[0].state.playing = false;
  fx.setTarget("master");
  fx.setOn(true);
  assert.deepEqual(decks[1].rolls.slice(-1), [1]);
  assert.deepEqual(decks[0].rolls, [1], "a stopped deck takes the hold (rolls when it plays)");
  fx.setTarget("1");                              // moving the lever ends the old roll
  assert.deepEqual(decks[1].rolls.slice(-1), [null]);
  assert.deepEqual(decks[0].rolls.slice(-2), [null, 1], "then holds on deck 1 alone");
  fx.select(1);                                   // leaving Roll ends it
  assert.deepEqual(decks[0].rolls.slice(-1), [null]);
  fx.setOn(false);
});

test("roll_off_reaches_every_target_deck", () => {
  const decks = [new FakeDeck(true, false), new FakeDeck(false)];   // no grid, paused
  const { fx } = fxRig({ decks });
  for (let i = 0; i < 4; i++) fx.select(1);
  fx.setTarget("master");
  fx.setOn(true);
  fx.setOn(false);
  assert.deepEqual(decks[0].rolls, [1, null], "off is sent whatever the deck did with on");
  assert.deepEqual(decks[1].rolls, [1, null]);
});

// Beat FX Roll against real decks (fake voice): the pause paths.
const rollTrack = (reliable = true) => ({
  pcm: { left: new Int16Array(0), right: new Int16Array(0), sampleRate: 44100 },
  grid: { bpm: 120, first_beat_s: 0, downbeat_s: 0, beat_cv: 0.02, reliable },
  meta: { duration_s: 300, bpm: 120 }, hotCues: null,
});

function rollRig({ loadA = true } = {}) {
  const c = { t: 0 };
  const now = () => c.t;
  const mk = (load) => {
    const v = new FakeVoice();
    const d = new Deck(v, { now, setTimeout: () => null, clearTimeout: () => {} });
    if (load) d.load(rollTrack());
    return { v, d };
  };
  const A = mk(loadA), B = mk(true);
  const ctx = new FakeContext();
  const fx = new BeatFx(ctx, new Mixer(ctx), () => 120, { decks: [A.d, B.d] });
  for (let i = 0; i < 4; i++) fx.select(1);       // Roll, 1 beat, CH 1
  return { c, A, B, fx };
}

test("roll_on_while_paused_starts_when_the_deck_plays", () => {
  const { c, A, fx } = rollRig();
  A.v.report(10.1, 0);
  fx.setOn(true);
  assert.equal(A.d.state.roll, null, "nothing rolls on a paused deck");
  assert.deepEqual(A.v.loop, [null, null]);
  fx.beat(-1);                                    // BEAT while paused: still nothing
  assert.equal(A.d.state.roll, null);
  c.t = 1;
  A.d.playPause();                                // PLAY: the held roll starts
  assert.deepEqual(A.d.state.roll, { beats: 0.75, in: 10.0, out: 10.375 });
  assert.deepEqual(A.v.loop, [10.0, 10.375]);
  c.t = 2;
  fx.setOn(false);
  assert.equal(A.d.state.roll, null);
  assert.deepEqual(A.v.loop, [null, null]);
  assert.ok(Math.abs(A.d.posAt() - 11.1) < 0.001, `slip ${A.d.posAt()}`);
  A.d.playPause(); A.d.playPause();               // off is off: play again does not roll
  assert.equal(A.d.state.roll, null);
});

test("pause_during_roll_stops_it_and_play_rolls_again", () => {
  const { c, A, fx } = rollRig();
  A.d.playPause();
  A.v.report(10.1, 0);
  fx.setOn(true);
  assert.deepEqual(A.d.state.roll, { beats: 1, in: 10.0, out: 10.5 });
  c.t = 0.6;                                      // rolled back to 10.2
  A.d.playPause();                                // pause: the roll ends where it is
  assert.equal(A.d.state.roll, null);
  assert.equal(A.d.state.loop.active, false);
  assert.deepEqual(A.v.loop, [null, null]);
  assert.ok(Math.abs(A.d.posAt() - 10.2) < 1e-9, `stays at ${A.d.posAt()}`);
  assert.equal(fx.state.on, true);
  c.t = 5;
  A.d.playPause();                                // play: Roll is still on, so it rolls
  assert.deepEqual(A.d.state.roll, { beats: 1, in: 10.0, out: 10.5 });
  c.t = 5.3;
  fx.setOn(false);
  assert.ok(Math.abs(A.d.posAt() - 10.5) < 0.001, `slip ${A.d.posAt()}`);
});

test("back_cue_during_roll_releases_the_loop", () => {
  const { c, A, fx } = rollRig();
  A.v.report(4, 0);
  A.d.cueDown(); A.d.cueUp();                     // cue at 4.0
  A.d.playPause();
  c.t = 6; A.v.report(10.1, 6);
  fx.setOn(true);
  A.d.cueDown();                                  // Back Cue while rolling
  assert.equal(A.d.state.roll, null);
  assert.deepEqual(A.v.loop, [null, null], "no roll loop left armed at the cue");
  assert.equal(A.d.state.playing, false);
  A.d.cueUp();
});

test("every beat fx action is a method", () => {
  for (const name of BEATFX_ACTIONS) assert.equal(typeof BeatFx.prototype[name], "function", name);
  for (const name of ["select", "beat", "setTarget", "setLevel", "setOn"]) {
    assert.ok(BEATFX_ACTIONS.includes(name), name);
  }
});

// ---- sampler ------------------------------------------------------------------

test("sampler_has_eight_pads_in_order_and_retriggers", () => {
  assert.deepEqual(SAMPLER_PADS, ["kick", "clap", "open hat", "closed hat", "rim",
    "crash noise", "sub drop", "synth stab"]);
  const ctx = new FakeContext();
  const out = ctx.createGain();
  const s = new Sampler(ctx, out);
  for (let i = 0; i < 8; i++) {
    const v = s.trigger(i);
    assert.ok(v, `pad ${i} plays`);
    assert.ok(v.out.connectedTo(s.output), `pad ${i} reaches the sampler bus`);
  }
  assert.ok(s.output.connectedTo(out), "the sampler bus feeds the master input");
  const first = s.trigger(0);
  const again = s.trigger(0);                     // manual p. 62: plays from the beginning again
  assert.notEqual(first, again);
  assert.equal(first.out.gain.value, 0, "the earlier hit is cut");
  s.stop(0);                                      // SHIFT + pad stops the slot
  assert.equal(again.out.gain.value, 0);
  assert.equal(s.trigger(8), null);
  for (const name of SAMPLER_ACTIONS) assert.equal(typeof Sampler.prototype[name], "function", name);
});

test("roll_off_after_a_no_grid_load_leaves_no_roll_behind", () => {
  const { c, A, fx } = rollRig();
  A.d.playPause();
  A.v.report(10.1, 0);
  fx.setOn(true);                                 // rolling, 1 beat
  assert.notEqual(A.d.state.roll, null);
  A.d.load(rollTrack(false));                     // a track with no reliable grid
  fx.beat(1);                                     // 2 beats: the deck cannot take it
  fx.setOn(false);
  A.d.load(rollTrack(true));                      // a gridded track, Beat FX off
  c.t = 1;
  A.d.playPause();
  assert.equal(A.d.state.roll, null, "Beat FX is off: nothing may roll");
  assert.deepEqual(A.v.loop, [null, null]);
});

test("a_deck_loaded_while_roll_is_on_rolls_when_it_plays", () => {
  const { c, A, fx } = rollRig({ loadA: false });    // deck 1 empty when Roll goes on
  fx.setOn(true);
  A.d.load(rollTrack(true));
  A.v.report(10.1, 0);
  c.t = 0.5;
  A.d.playPause();
  assert.deepEqual(A.d.state.roll, { beats: 1, in: 10.0, out: 10.5 }, "empty -> gridded, played");
  A.d.playPause();
  A.d.load(rollTrack(false));                     // no grid: plays without a roll
  A.d.playPause();
  assert.equal(A.d.state.roll, null);
  A.d.playPause();
  A.d.load(rollTrack(true));                      // gridded again, Roll still on
  A.v.report(20.3, 2);
  c.t = 2;
  A.d.playPause();
  assert.deepEqual(A.d.state.roll, { beats: 1, in: 20.0, out: 20.5 }, "no-grid -> gridded, played");
  fx.setOn(false);
  assert.equal(A.d.state.roll, null);
});
