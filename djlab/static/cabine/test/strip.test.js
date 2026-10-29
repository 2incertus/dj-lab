import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePeaks, formatTime, deckLine, meterStep, meterFraction, beatMarks, playheadTime, stripLayout,
  peakColumns, drawTextPx, pxContext, METER_HOLD_S, METER_DECAY_DB_S, METER_FLOOR_DB, WINDOW_S,
} from "../ui/strip.js";
import { masterDeck, fxBpm } from "../engine/rig.js";

const grid = (bpm, first = 0, downbeat = first) => ({ bpm, first_beat_s: first, downbeat_s: downbeat, reliable: true });

test("peaks_parse_the_pk01_format", () => {
  const b = new Uint8Array([0x50, 0x4b, 0x30, 0x31, 100, 0, 0, 0, 3, 0, 0, 0, 10, 255, 0]);
  const p = parsePeaks(b.buffer);
  assert.equal(p.rate, 100);
  assert.deepEqual([...p.values], [10, 255, 0]);
  assert.equal(parsePeaks(new ArrayBuffer(4)), null);
  assert.equal(parsePeaks(null), null);
  assert.equal(parsePeaks(new Uint8Array([1, 2, 3, 4, 100, 0, 0, 0, 0, 0, 0, 0]).buffer), null, "bad magic");
});

test("peak_columns_take_the_max_over_each_column", () => {
  const p = { rate: 100, values: Uint8Array.from({ length: 1000 }, (_, i) => (i === 455 ? 200 : i % 10)) };
  // 50 px per second: each column covers 2 peaks
  const cols = peakColumns(p, 50, 10);
  assert.equal(cols.length, 500);
  assert.equal(cols[227], 200, "the loud peak lands in its column");
  assert.equal(cols[0], 1);
  assert.equal(cols[1], 3);
});

test("time_formats_as_minutes_and_seconds", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(59.4), "0:59");
  assert.equal(formatTime(201.2), "3:21");
  assert.equal(formatTime(-3), "0:00");
  assert.equal(formatTime(Infinity), "--:--");
});

test("deck_line_is_title_and_key_the_jog_display_has_the_numbers", () => {
  // BPM, time, SYNC / MASTER moved to the jog display (ui/jog-screen.js, Task V2)
  const meta = { title: "Rene Wise - Rough Rider", key: "A min", bpm: 128 };
  const segs = deckLine({ meta, bpm: 131.234, remaining: 201.2, sync: true, master: false });
  const text = segs.map((s) => s.text).join("");
  assert.equal(text, "Rene Wise - Rough Rider | A min");
  assert.ok(segs[1].dim, "the key drawn dim");
  const bare = deckLine({ meta: { file: "x.wav" } }).map((s) => s.text).join("");
  assert.equal(bare, "x.wav | -");
  assert.ok(!/—/.test(text + bare), "no em dashes in copy");
});

test("meter_holds_the_peak_for_1_5_s_then_decays_20_db_per_s", () => {
  assert.equal(METER_HOLD_S, 1.5);
  assert.equal(METER_DECAY_DB_S, 20);
  let m = meterStep(null, -6, 0);
  assert.equal(m.db, -6);
  assert.equal(m.peak, -6);
  // silence: the bar falls at 20 dB/s, the peak holds 1.5 s first
  m = meterStep(m, -Infinity, 0.5);
  assert.ok(Math.abs(m.db - -16) < 1e-9, m.db);
  assert.equal(m.peak, -6);
  m = meterStep(m, -Infinity, 1.0);                   // t = 1.5: hold ends
  assert.equal(m.peak, -6);
  m = meterStep(m, -Infinity, 0.25);                  // 0.25 s past the hold
  assert.ok(Math.abs(m.peak - -11) < 1e-9, m.peak);
  assert.ok(Math.abs(m.db - -41) < 1e-9, "the bar fell 35 dB in 1.75 s");
  m = meterStep(m, -Infinity, 1);
  assert.equal(m.db, METER_FLOOR_DB, "and stops on the floor");
  assert.ok(Math.abs(m.peak - -31) < 1e-9, m.peak);
  // a louder hit resets the hold
  m = meterStep(m, -3, 0.1);
  assert.equal(m.peak, -3);
  assert.equal(m.held, 0);
  assert.equal(meterFraction(METER_FLOOR_DB), 0);
  assert.equal(meterFraction(0), 1);
  assert.ok(meterFraction(-24) > 0 && meterFraction(-24) < 1);
});

test("beat_marks_cover_the_window_with_bar_lines_on_downbeats", () => {
  const g = grid(120, 0.1, 0.6);                      // beat 0.5 s, bar 1 at 0.6
  const m = beatMarks(g, 0, 2.05);
  assert.deepEqual(m.map((x) => +x.t.toFixed(3)), [0.1, 0.6, 1.1, 1.6]);
  assert.deepEqual(m.map((x) => x.bar), [false, true, false, false]);
  assert.deepEqual(beatMarks(g, 2.5, 2.7).map((x) => x.bar), [true], "every 4th beat from the downbeat");
  assert.deepEqual(beatMarks(null, 0, 10), []);
  assert.deepEqual(beatMarks({ ...g, offset_s: 0.05 }, 0, 0.7).map((x) => +x.t.toFixed(3)), [0.15, 0.65],
    "the carry offset moves the grid");
});

test("playhead_time_subtracts_output_and_base_latency", () => {
  assert.ok(Math.abs(playheadTime({ currentTime: 10, outputLatency: 0.2, baseLatency: 0.01 }) - 9.79) < 1e-12);
  assert.equal(playheadTime({ currentTime: 10 }), 10, "browsers without the fields");
});

test("strip_layout_fits_two_lanes_and_the_side_panel", () => {
  for (const H of [47, 86]) {
    const L = stripLayout(750, H, 70);
    assert.equal(L.lanes.length, 2);
    const [a, b] = L.lanes;
    assert.ok(a.y === 0 && Math.abs(b.y + b.h - H) < 1e-9, "the lanes fill the height, deck 1 on top");
    assert.ok(a.wave.h >= 10, `waveform ${a.wave.h} px tall at H ${H}`);
    assert.ok(a.text.h >= 9);
    assert.ok(a.wave.x >= 70, "clear of the caixa button");
    assert.ok(a.over.x + a.over.w <= L.panel.x, "overview before the panel");
    assert.ok(L.panel.x + L.panel.w <= L.rec.x, "panel before REC");
    assert.ok(L.rec.x + L.rec.w <= 750);
    assert.ok(Math.abs(L.pps - a.wave.w / WINDOW_S) < 1e-9);
  }
});

test("master_and_fx_bpm_follow_the_sync_roles", () => {
  const deck = (bpm, playing) => ({ state: { loaded: bpm !== null, playing }, effectiveBpm: () => bpm, _followers: new Set() });
  const A = deck(128, true), B = deck(131, false);
  assert.equal(masterDeck([A, B]), null);
  B._followers.add(A);                                // A follows B
  assert.equal(masterDeck([A, B]), B);
  assert.equal(fxBpm([A, B], "master"), 131, "1&2 follows the sync master");
  assert.equal(fxBpm([A, B], "1"), 128);
  assert.equal(fxBpm([A, B], "2"), 131);
  B._followers.clear();
  assert.equal(fxBpm([A, B], "master"), 128, "no master: the playing deck");
  assert.equal(fxBpm([deck(null, false), deck(null, false)], "master"), null);
});

test("rec_label_shows_elapsed_mm_ss_while_recording", async () => {
  const { recLabel } = await import("../ui/strip.js");
  assert.equal(recLabel(false, 0), "REC");
  assert.equal(recLabel(true, 0), "00:00");
  assert.equal(recLabel(true, 75.9), "01:15");
  assert.equal(recLabel(true, 3725), "62:05");
});

test("strip_text_is_drawn_with_no_transform_in_backing_pixels", () => {
  // Playwright's WebKit applies a scaling transform twice on the first draw
  // after a canvas sat idle (text came out 3x too big at dpr 3); the jog display
  // draws with the identity transform, and so does the strip's text now
  const calls = [];
  let t = [3, 0, 0, 3, 0, 0];
  const g = {
    font: "", fillStyle: "", textBaseline: "",
    save() { calls.push(["save", [...t]]); }, restore() { calls.push(["restore"]); t = [3, 0, 0, 3, 0, 0]; },
    setTransform(...m) { t = m; },
    fillText(text, x, y) { calls.push(["fillText", text, x, y, [...t], this.font, this.fillStyle]); },
    measureText(text) { return { width: text.length * 10 * (parseFloat(this.font.split(" ")[1]) / 10) }; },
  };
  const adv = drawTextPx(g, 3, "1 no track", 4, 9, 10, "#abc");
  const ft = calls.find((c) => c[0] === "fillText");
  assert.deepEqual(ft[4], [1, 0, 0, 1, 0, 0], "drawn with the identity transform");
  assert.equal(ft[2], 12); assert.equal(ft[3], 27);                 // CSS px x dpr
  assert.match(ft[5], /^600 30px /, "the font in backing pixels");
  assert.equal(ft[6], "#abc");
  assert.ok(Math.abs(adv - 100) < 1e-9, "the advance comes back in CSS px");
  assert.deepEqual(t, [3, 0, 0, 3, 0, 0], "the caller's transform is restored");
});

test("slim_band_puts_the_title_beside_the_waveform", () => {
  // the phone layout's band is 31 to 37 px: two lanes of 15 to 18 px. A title
  // row over the waveform left it 5 or 6 px tall; beside it, the waveform
  // takes the lane's whole height
  for (const H of [31, 37]) {
    const L = stripLayout(750, H, 70);
    for (const [i, a] of L.lanes.entries()) {
      assert.ok(a.wave.h >= H / 2 - 1.5, `H ${H}: waveform ${a.wave.h} px tall`);
      assert.ok(a.text.x >= 70 && a.text.x + a.text.w <= a.wave.x, `H ${H}: the title left of the waveform`);
      assert.ok(a.text.h >= 9, `H ${H}: title row ${a.text.h}`);
      assert.ok(a.over.x >= a.text.x && a.over.x + a.over.w <= a.wave.x && a.over.y >= a.text.y + a.text.h - 0.5
        && a.over.y + a.over.h <= a.y + a.h + 1e-9, `H ${H}: the overview under the title`);
      assert.ok(a.wave.x + a.wave.w <= L.panel.x, "waveform before the panel");
      assert.ok(Math.abs(a.y - i * H / 2) < 1e-9);
    }
    assert.ok(Math.abs(L.pps - L.lanes[0].wave.w / WINDOW_S) < 1e-9);
    assert.equal(L.slim, true);
  }
  assert.equal(stripLayout(750, 47, 70).slim, false, "spread's 47 px band keeps the title row on top");
});

test("the_strip_draws_everything_in_backing_pixels", async () => {
  // the WebKit bug is not only the text's: a scaling transform set for the
  // frame was applied twice too. So the strip never sets one; pxContext scales
  // the coordinates instead (CSS px in, backing pixels out)
  const calls = [];
  const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => { t[k] = v; return true; } });
  const px = pxContext(g, 3);
  px.fillRect(1, 2, 3, 4);
  px.rect(1, 1, 2, 2);
  px.moveTo(1, 2); px.lineTo(3, 4);
  px.drawImage("img", 5, 6, 7, 8);
  px.drawImage("tile", 0, 0, 10, 20, 1, 2, 3, 4);
  px.fillStyle = "#123";
  px.save(); px.beginPath(); px.clip(); px.closePath(); px.fill(); px.restore();
  assert.deepEqual(calls.slice(0, 6), [["fillRect", 3, 6, 9, 12], ["rect", 3, 3, 6, 6], ["moveTo", 3, 6], ["lineTo", 9, 12],
    ["drawImage", "img", 15, 18, 21, 24], ["drawImage", "tile", 0, 0, 10, 20, 3, 6, 9, 12]]);
  assert.equal(g.fillStyle, "#123");
  assert.deepEqual(calls.slice(6).map((c) => c[0]), ["save", "beginPath", "clip", "closePath", "fill", "restore"]);
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../ui/strip.js", import.meta.url), "utf8");
  const sets = [...src.matchAll(/setTransform\(([^)]*)\)/g)].map((m) => m[1].replace(/\s/g, ""));
  assert.ok(sets.length > 0 && sets.every((a) => a === "1,0,0,1,0,0"), `only identity transforms: ${sets}`);
});
