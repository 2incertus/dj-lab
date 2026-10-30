import { test } from "node:test";
import { fitBoard } from "../ui/board-layout.js";
import assert from "node:assert/strict";

import {
  formatBpm, formatTempo, formatRange, formatRemaining, keyShort, loopLabel, phaseCells, readout, ringState, PHASE_TOLERANCE,
  screenPlan, RED_LAST_S, MIN_PX, PRIORITY,
} from "../ui/jog-screen.js";

const grid = (bpm, first = 0, downbeat = first) => ({ bpm, first_beat_s: first, downbeat_s: downbeat, reliable: true });

/** A deck as the engine has it, enough for readout(). */
function fakeDeck({ bpm = 128, rate = 1, pos = 0, dur = 300, range = 10, sync = false, loop = null, key = "A min",
  g = grid(bpm), loaded = true, noGrid = false } = {}) {
  return {
    state: { loaded, playing: true, tempoPct: (rate - 1) * 100, range, syncOn: sync, noGrid,
      loop: loop || { in: null, out: null, active: false, beats: null } },
    grid: g,
    track: { meta: { title: "t", key, camelot: "8A", bpm } },
    duration: dur,
    posAt: () => pos,
    effectiveBpm: () => (loaded ? bpm * rate : null),
  };
}

// Archivo 600 runs about 0.6 em a glyph: a stand-in for canvas measureText
const measure = (text, px) => [...String(text)].length * px * 0.6;

test("bpm_has_two_decimals_and_a_placeholder", () => {
  assert.equal(formatBpm(128), "128.00");
  assert.equal(formatBpm(131.2349), "131.23");
  assert.equal(formatBpm(99.996), "100.00");
  assert.equal(formatBpm(null), "---.--");
  assert.equal(formatBpm(NaN), "---.--");
});

test("tempo_is_signed_with_one_decimal_never_minus_zero", () => {
  assert.equal(formatTempo(2.54), "+2.5%");
  assert.equal(formatTempo(-0.31), "-0.3%");
  assert.equal(formatTempo(0), "0.0%");
  assert.equal(formatTempo(-0.04), "0.0%", "rounds to zero: no sign");
  assert.equal(formatTempo(0.04), "0.0%");
  assert.equal(formatTempo(16), "+16.0%");
  assert.equal(formatTempo(undefined), "0.0%");
});

test("range_reads_like_the_hardware", () => {
  assert.equal(formatRange(6), "±6");
  assert.equal(formatRange(10), "±10");
  assert.equal(formatRange(16), "±16");
  assert.equal(formatRange(100), "W");
});

test("remaining_time_is_minus_m_ss", () => {
  assert.equal(formatRemaining(201.2), "-3:21");
  assert.equal(formatRemaining(9.6), "-0:10");
  assert.equal(formatRemaining(0), "-0:00");
  assert.equal(formatRemaining(-2), "-0:00");
  assert.equal(formatRemaining(Infinity), "--:--");
  assert.equal(formatRemaining(NaN), "--:--");
});

test("key_is_short_classic_notation", () => {
  assert.equal(keyShort({ key: "A min" }), "Am");
  assert.equal(keyShort({ key: "D# maj" }), "D#");
  assert.equal(keyShort({ key: "G# min", camelot: "1A" }), "G#m");
  assert.equal(keyShort({ camelot: "8A" }), "8A", "no key: the Camelot code");
  assert.equal(keyShort({}), "");
  assert.equal(keyShort(null), "");
  assert.equal(keyShort({ key: "weird" }), "weird");
});

test("loop_length_in_beats_with_fractions", () => {
  const g = grid(120);                                          // 0.5 s a beat
  assert.equal(loopLabel({ active: false, in: 0, out: 2, beats: 4 }, g), "");
  // drawn in an orange loop box, so the number alone reads as the loop's beats
  assert.equal(loopLabel({ active: true, in: 0, out: 2, beats: 4 }, g), "4");
  assert.equal(loopLabel({ active: true, in: 0, out: 0.25, beats: 0.5 }, g), "1/2");
  assert.equal(loopLabel({ active: true, in: 0, out: 0.0625, beats: 0.125 }, g), "1/8");
  assert.equal(loopLabel({ active: true, in: 0, out: 16, beats: 32 }, g), "32");
  assert.equal(loopLabel({ active: true, in: 1, out: 5, beats: null }, g), "8", "a manual loop: from its length");
  assert.equal(loopLabel({ active: true, in: 1, out: 1.7, beats: null }, g), "1.4");
  assert.equal(loopLabel({ active: true, in: 1, out: 5, beats: null }, null), "LOOP", "no grid: no length");
});

test("phase_cells_show_the_own_beat_alone_with_no_master", () => {
  assert.deepEqual(phaseCells(null, null), { cells: ["off", "off", "off", "off"], aligned: null });
  assert.deepEqual(phaseCells(0.2, null).cells, ["own", "off", "off", "off"]);
  assert.deepEqual(phaseCells(2.99, null).cells, ["off", "off", "own", "off"]);
  assert.deepEqual(phaseCells(3.5, null).cells, ["off", "off", "off", "own"]);
  assert.equal(phaseCells(3.5, null).aligned, null);
});

test("phase_cells_against_the_master", () => {
  // in phase: the same beat of the bar, within a few hundredths of a beat
  assert.deepEqual(phaseCells(1.52, 1.5), { cells: ["off", "both", "off", "off"], aligned: true });
  // the same beat but drifting a tenth of a beat: lit together, not aligned
  assert.deepEqual(phaseCells(1.6, 1.5), { cells: ["off", "both", "off", "off"], aligned: false });
  // a beat apart in the bar: two cells, not aligned
  assert.deepEqual(phaseCells(2.5, 1.5), { cells: ["off", "ref", "own", "off"], aligned: false });
  // across a beat line or the bar line: a few hundredths apart is in phase, one cell
  assert.deepEqual(phaseCells(3.99, 0.01), { cells: ["both", "off", "off", "off"], aligned: true });
  assert.deepEqual(phaseCells(0.01, 3.99), { cells: ["off", "off", "off", "both"], aligned: true });
  assert.deepEqual(phaseCells(1.99, 2.01), { cells: ["off", "off", "both", "off"], aligned: true });
  // a master with no grid: as if there were none
  assert.deepEqual(phaseCells(0.5, null).cells, ["own", "off", "off", "off"]);
});

test("phase_cells_read_the_signed_drift_from_the_master", () => {
  assert.equal(PHASE_TOLERANCE, 0.05);
  const at = (drift, master = 1.5) => phaseCells(master + drift, master);
  // within the tolerance either way: the master's cell, both, aligned
  assert.deepEqual(at(0.02), { cells: ["off", "both", "off", "off"], aligned: true });
  assert.deepEqual(at(-0.02), { cells: ["off", "both", "off", "off"], aligned: true });
  assert.deepEqual(at(-0.02, 0.01), { cells: ["both", "off", "off", "off"], aligned: true }, "across the bar line");
  // half a beat ahead: rounds to the next beat
  assert.deepEqual(at(0.5), { cells: ["off", "ref", "own", "off"], aligned: false });
  // a beat ahead, and nearly two behind (wrapping round the bar)
  assert.deepEqual(at(1.0), { cells: ["off", "ref", "own", "off"], aligned: false });
  assert.deepEqual(at(-1.98), { cells: ["off", "ref", "off", "own"], aligned: false });
  assert.deepEqual(at(-1.98, 0.2), { cells: ["ref", "off", "own", "off"], aligned: false });
  // a tenth of a beat off: the same cell, not aligned
  assert.deepEqual(at(0.1), { cells: ["off", "both", "off", "off"], aligned: false });
});

test("readout_of_a_synced_deck_against_its_master", () => {
  const master = fakeDeck({ bpm: 128, pos: 30.0 });               // 128: 0.46875 s a beat; 30 s = beat 64 = bar start
  const d = fakeDeck({ bpm: 127, rate: 128 / 127, pos: 60 / 127 * 9 + 0.01, dur: 240, sync: true, range: 16 });
  const r = readout(d, master, 0);
  assert.equal(r.bpm, "128.00");
  assert.equal(r.tempo, "+0.8%");
  assert.equal(r.range, "±16");
  assert.equal(r.tag, "SYNC");
  assert.equal(r.key, "Am");
  assert.equal(r.time, formatRemaining(240 - (60 / 127 * 9 + 0.01)));
  assert.deepEqual(r.phase.cells, ["ref", "own", "off", "off"], "beat 2 of its bar while the master is on 1");
  assert.equal(r.loop, "");
  assert.equal(r.red, false);
  const m = readout(master, master, 0);
  assert.equal(m.tag, "MASTER");
  assert.deepEqual(m.phase.cells, ["own", "off", "off", "off"], "the master reads its own bar");
});

test("readout_of_an_empty_deck_is_null_and_no_grid_has_no_phase", () => {
  assert.equal(readout(fakeDeck({ loaded: false }), null, 0), null);
  assert.equal(readout(null, null, 0), null);
  const r = readout(fakeDeck({ noGrid: true }), null, 0);
  assert.deepEqual(r.phase.cells, ["off", "off", "off", "off"]);
  assert.equal(readout(fakeDeck({ loop: { in: 0, out: 1.875, active: true, beats: 4 } }), null, 0).loop, "4");
});

test("position_ring_turns_red_in_the_last_30_s", () => {
  assert.equal(RED_LAST_S, 30);
  assert.deepEqual(ringState(0, 300), { frac: 0, red: false });
  assert.deepEqual(ringState(150, 300), { frac: 0.5, red: false });
  assert.equal(ringState(269.9, 300).red, false);
  assert.equal(ringState(270, 300).red, true);
  assert.deepEqual(ringState(400, 300), { frac: 1, red: true });
  assert.deepEqual(ringState(10, Infinity), { frac: 0, red: false }, "no duration yet: no ring");
  assert.equal(readout(fakeDeck({ pos: 280, dur: 300 }), null, 0).red, true);
  assert.equal(readout(fakeDeck({ pos: 280, dur: 300 }), null, 0).frac.toFixed(3), "0.933");
});

test("priority_order_is_the_briefs", () => {
  assert.deepEqual(PRIORITY, ["bpm", "time", "phase", "tempo", "tag", "key", "loop"]);
});

test("screen_plan_keeps_the_top_priorities_at_the_smallest_jog", () => {
  for (const D of [113, 135]) {
    const p = screenPlan(D, measure);
    for (const id of ["bpm", "time", "phase", "tempo", "tag"]) assert.ok(p.shown.has(id), `${id} at ${D}`);
    // whatever is dropped is dropped from the end of the priority list
    const kept = PRIORITY.map((id) => p.shown.has(id));
    assert.ok(kept.indexOf(false) === -1 || kept.slice(kept.indexOf(false)).every((k) => !k), `${D}: ${[...p.shown]}`);
    // every row of text is at least MIN_PX and inside the round screen
    for (const it of p.items) {
      assert.ok(it.px >= MIN_PX, `${it.id} ${it.px}px at ${D}`);
      const yFar = Math.max(Math.abs(it.y - it.px * 0.36), Math.abs(it.y + it.px * 0.36));
      const chord = 2 * Math.sqrt(Math.max(0, p.r * p.r - yFar * yFar));
      assert.ok(it.w <= chord + 0.01, `${it.id} ${it.w.toFixed(1)} wider than ${chord.toFixed(1)} at ${D}`);
    }
    // BPM is the biggest text
    const bpm = p.items.find((i) => i.id === "bpm");
    assert.ok(p.items.every((i) => i.px <= bpm.px), "BPM is the biggest");
    assert.ok(p.r < D / 2 * 0.8, "the screen sits inside the top plate");
  }
  // rows do not overlap
  const p = screenPlan(113, measure);
  const rows = [...p.items].sort((a, b) => a.y - b.y);
  for (let k = 1; k < rows.length; k++) {
    if (rows[k].row === rows[k - 1].row) continue;
    assert.ok(rows[k].y - rows[k].px * 0.36 >= rows[k - 1].y + rows[k - 1].px * 0.36 - 0.01, `${rows[k - 1].id} / ${rows[k].id}`);
  }
});

test("screen_plan_drops_from_the_end_when_the_jog_is_tiny", () => {
  const p = screenPlan(70, measure);
  assert.ok(p.shown.has("bpm"));
  assert.ok(!p.shown.has("loop"));
  const kept = PRIORITY.map((id) => p.shown.has(id));
  const firstOff = kept.indexOf(false);
  assert.ok(firstOff > 0 && kept.slice(firstOff).every((k) => !k), [...p.shown].join(","));
});

test("phone_jog_regains_lines_at_844x330", () => {
  // Task V4: the mode row and the pads gave their height back to the jog, so in
  // Safari's landscape (844 x 330) the display shows the tempo, SYNC / MASTER
  // and the key again; at 844 x 390 everything
  const iphone = { left: 47, right: 47, bottom: 21, top: 0 };
  const at = (H) => screenPlan(fitBoard({ W: 844, H, insets: iphone }).deck.meta.jog, measure).shown;
  for (const id of ["bpm", "time", "phase", "tempo", "tag", "key"]) assert.ok(at(330).has(id), `${id} at 844x330`);
  for (const id of PRIORITY) assert.ok(at(390).has(id), `${id} at 844x390`);
  // 844 x 300 (a browser's tab bar): the jog is what gives, BPM, time and phase stay
  for (const id of ["bpm", "time", "phase"]) assert.ok(at(300).has(id), `${id} at 844x300`);
});
