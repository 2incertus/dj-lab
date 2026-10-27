import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBytes, formatDuration, formatBpm, mergeLibrary, uploadQuery, tapToSourceTime } from "../ui/crate-model.js";

test("bytes read like a phone's storage screen", () => {
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(null), "?");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(100), "1 KB");
  assert.equal(formatBytes(11.24 * 1024 * 1024), "11.2 MB");
  assert.equal(formatBytes(2.5 * 1024 ** 3), "2.50 GB");
});

test("durations are m:ss, unknown is a dash-free placeholder", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65.4), "1:05");
  assert.equal(formatDuration(899.9), "14:59");
  assert.equal(formatDuration(null), "?:??");
  assert.equal(formatDuration(NaN), "?:??");
});

test("bpm shows two decimals from the four-decimal grid", () => {
  assert.equal(formatBpm(128.0032), "128.00");
  assert.equal(formatBpm(127.996), "128.00");
  assert.equal(formatBpm(null), "?");
});

test("mergeLibrary: server order, carried state joined, phone-only tracks kept", () => {
  const server = [
    { file: "a.wav", title: "A", grid: { bpm: 120 }, carry_bytes: 100 },
    { file: "b.wav", title: "B", grid: null, carry_bytes: null },
  ];
  const carried = [
    { file: "b.wav", meta: { file: "b.wav", title: "B old" }, grid: null, bytes: 50, carriedAt: 2 },
    { file: "gone.wav", meta: { file: "gone.wav", title: "Gone" }, grid: { bpm: 130 }, bytes: 70, carriedAt: 1 },
  ];
  const rows = mergeLibrary(server, carried);
  assert.deepEqual(rows.map((r) => r.file), ["a.wav", "b.wav", "gone.wav"]);
  assert.deepEqual(rows.map((r) => r.onPhone), [false, true, true]);
  assert.equal(rows[0].bytes, 100, "server carry size when not carried");
  assert.equal(rows[1].bytes, 50, "the phone's own size when carried");
  assert.equal(rows[1].title, "B", "server meta wins when the server has the track");
  assert.equal(rows[1].gridPending, true);
  assert.equal(rows[2].gridPending, false);
  assert.equal(rows[2].grid.bpm, 130, "the carried grid is what the phone plays");
  assert.equal(rows[2].onServer, false);
  assert.equal(rows[0].gridPending, false, "only carried tracks can be grid pending");
});

test("mergeLibrary offline: only what is on the phone", () => {
  const rows = mergeLibrary(null, [{ file: "x.wav", meta: { title: "X" }, grid: null, bytes: 1, carriedAt: 1 }]);
  assert.deepEqual(rows.map((r) => [r.file, r.title, r.onPhone, r.gridPending]), [["x.wav", "X", true, true]]);
});

test("a Spotify pick searches YouTube for its first artist and title", () => {
  assert.equal(uploadQuery({ artist: "Amelie Lens, Farrago", title: "Feel It" }), "Amelie Lens Feel It");
  assert.equal(uploadQuery({ artist: "", title: "Solo" }), "Solo");
});

test("a tap maps to source seconds: latency taken off, carry offset removed, never negative", () => {
  const deck = { posAt: (T) => T * 1.0 };      // position == audio clock time
  const ctx = { currentTime: 10, outputLatency: 0.2, baseLatency: 0.01 };
  assert.ok(Math.abs(tapToSourceTime(deck, ctx, { offset_s: 0.05 }) - (10 - 0.21 - 0.05)) < 1e-9);
  assert.ok(Math.abs(tapToSourceTime(deck, { currentTime: 10 }, null) - 10) < 1e-9);
  assert.equal(tapToSourceTime(deck, { currentTime: 0.1, outputLatency: 0.2 }, null), 0);
});
