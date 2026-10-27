import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeIDB, fakeStorage } from "./fake-idb.js";
import { openStore, storeSource, DB_NAME, DB_VERSION } from "../store.js";

const bytes = (...v) => new Uint8Array(v).buffer;
const meta = (file, extra = {}) => ({ file, title: `t ${file}`, bpm: 128, duration_s: 10, ...extra });
const grid = { bpm: 128, first_beat_s: 0.1, downbeat_s: 0.1, reliable: true };

async function fresh(opts = {}) {
  const idb = new FakeIDB();
  const storage = fakeStorage(opts);
  const store = await openStore({ indexedDB: idb, storage, now: () => 1700000000000 });
  return { idb, storage, store };
}

test("opens the cabine database, version 2, with its object stores", async () => {
  const { idb } = await fresh();
  assert.equal(DB_NAME, "cabine");
  assert.equal(DB_VERSION, 2);
  assert.deepEqual(idb.opens, [["cabine", 2]]);
  const db = idb.dbs.get("cabine");
  for (const s of ["tracks", "audio", "hotcues", "recordings", "chunks"]) {
    assert.ok(db.objectStoreNames.contains(s), s);
  }
  // a second open does not try to recreate the stores
  await openStore({ indexedDB: idb, storage: fakeStorage() });
});

test("putTrack then getTrack round-trips meta, grid, peaks and mp3", async () => {
  const { store } = await fresh();
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid, peaks: bytes(1, 2, 3), mp3: bytes(9, 8, 7, 6) });
  const t = await store.getTrack("a.wav");
  assert.equal(t.file, "a.wav");
  assert.deepEqual(t.meta, meta("a.wav"));
  assert.deepEqual(t.grid, grid);
  assert.deepEqual([...new Uint8Array(t.peaks)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(t.mp3)], [9, 8, 7, 6]);
  assert.ok(t.mp3 instanceof ArrayBuffer, "the mp3 comes back as an ArrayBuffer");
  assert.equal(t.bytes, 7, "bytes = mp3 + peaks");
  assert.equal(t.carriedAt, 1700000000000);
  assert.equal(await store.getTrack("nope.wav"), null);
});

test("a Blob mp3 is stored as an ArrayBuffer", async () => {
  const { store } = await fresh();
  await store.putTrack({ file: "b.wav", meta: meta("b.wav"), grid: null, peaks: bytes(1), mp3: new Blob([new Uint8Array([5, 6])]) });
  const t = await store.getTrack("b.wav");
  assert.ok(t.mp3 instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(t.mp3)], [5, 6]);
  assert.equal(t.bytes, 3);
  assert.equal(t.grid, null);
});

test("getTrack hands out a fresh mp3 copy each call (Safari detaches decode input)", async () => {
  const { store } = await fresh();
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid, peaks: bytes(1), mp3: bytes(1, 2, 3, 4) });
  const first = await store.getTrack("a.wav");
  // what decodeAudioData does to its input on Safari
  structuredClone(first.mp3, { transfer: [first.mp3] });
  assert.equal(first.mp3.byteLength, 0, "detached");
  const second = await store.getTrack("a.wav");
  assert.notEqual(second.mp3, first.mp3);
  assert.deepEqual([...new Uint8Array(second.mp3)], [1, 2, 3, 4]);
});

test("listTracks returns the carried entries without audio, newest first", async () => {
  let t = 1000;
  const idb = new FakeIDB();
  const store = await openStore({ indexedDB: idb, storage: fakeStorage(), now: () => (t += 1000) });
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid, peaks: bytes(1), mp3: bytes(1, 2) });
  await store.putTrack({ file: "b.wav", meta: meta("b.wav"), grid: null, peaks: bytes(1), mp3: bytes(1, 2, 3) });
  const list = await store.listTracks();
  assert.deepEqual(list.map((e) => e.file), ["b.wav", "a.wav"]);
  for (const e of list) {
    assert.equal(e.mp3, undefined, "no audio in the listing");
    assert.equal(e.peaks, undefined);
    assert.ok(e.meta && e.bytes > 0 && e.carriedAt > 0);
  }
  assert.equal(list[0].grid, null);
  assert.deepEqual(list[1].grid, grid);
  // the listing reads only the light store
  const db = idb.dbs.get("cabine");
  assert.equal(db._stores.get("tracks").data.get("a.wav").mp3, undefined);
});

test("setGrid updates only the grid of a carried track", async () => {
  const { store } = await fresh();
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid: null, peaks: bytes(1), mp3: bytes(1, 2) });
  assert.equal(await store.setGrid("a.wav", { ...grid, bpm: 256 }), true);
  const t = await store.getTrack("a.wav");
  assert.equal(t.grid.bpm, 256);
  assert.deepEqual([...new Uint8Array(t.mp3)], [1, 2]);
  assert.equal(await store.setGrid("missing.wav", grid), false, "never creates a track");
  assert.equal(await store.getTrack("missing.wav"), null);
});

test("removeTrack drops the entry and its audio, keeps hot cues", async () => {
  const { idb, store } = await fresh();
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid, peaks: bytes(1), mp3: bytes(1, 2) });
  await store.putHotCues("a.wav", [1.5, null, null, null, null, null, null, null]);
  await store.removeTrack("a.wav");
  assert.equal(await store.getTrack("a.wav"), null);
  assert.deepEqual(await store.listTracks(), []);
  const db = idb.dbs.get("cabine");
  assert.equal(db._stores.get("audio").data.size, 0);
  assert.deepEqual((await store.getHotCues("a.wav"))[0], 1.5);
});

test("hot cues round-trip; none stored is null", async () => {
  const { store } = await fresh();
  assert.equal(await store.getHotCues("x.wav"), null);
  const cues = [0.5, null, 3.25, null, null, null, null, 9];
  await store.putHotCues("x.wav", cues);
  assert.deepEqual(await store.getHotCues("x.wav"), cues);
});

test("recordings: put, list, mark uploaded", async () => {
  const { store } = await fresh();
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  await store.putRecording({ id: "r1", blob, mime: "audio/webm", createdAt: 5, uploaded: false });
  await store.putRecording({ id: "r2", blob, mime: "audio/webm", createdAt: 6 });
  let list = await store.listRecordings();
  assert.deepEqual(list.map((r) => [r.id, r.uploaded]), [["r1", false], ["r2", false]]);
  await store.markUploaded("r1");
  list = await store.listRecordings();
  assert.deepEqual(list.map((r) => [r.id, r.uploaded]), [["r1", true], ["r2", false]]);
  await store.markUploaded("nope");                       // no throw, nothing created
  assert.equal((await store.listRecordings()).length, 2);
});

test("a version 1 database (Task 8 phones) upgrades in place: carried tracks stay", async () => {
  const idb = new FakeIDB();
  // the v1 layout, with a carried track in it
  const r = idb.open("cabine", 1);
  r.onupgradeneeded = () => {
    for (const [n, k] of [["tracks", "file"], ["audio", "file"], ["hotcues", "file"], ["recordings", "id"]]) {
      r.result.createObjectStore(n, { keyPath: k });
    }
  };
  await new Promise((ok) => { r.onsuccess = ok; });
  const v1 = new (await import("../store.js")).Store(r.result);
  await v1.putTrack({ file: "old.wav", meta: meta("old.wav"), peaks: bytes(1), mp3: bytes(2, 3) });
  const store = await openStore({ indexedDB: idb, storage: fakeStorage() });
  assert.ok(idb.dbs.get("cabine").objectStoreNames.contains("chunks"));
  assert.deepEqual([...new Uint8Array((await store.getTrack("old.wav")).mp3)], [2, 3]);
});

test("a recording grows chunk by chunk; what was flushed survives without finish", async () => {
  const { store } = await fresh();
  await store.startRecording({ id: "ride1", mime: "audio/webm;codecs=opus", createdAt: 10, ride: "ride1", part: 0 });
  const b = (...v) => new Blob([new Uint8Array(v)]);
  await store.appendChunk("ride1", 0, b(1, 2));
  await store.appendChunk("ride1", 1, b(3));
  await store.appendChunk("ride1", 2, b(4, 5, 6));
  let [rec] = await store.listRecordings();
  assert.equal(rec.done, false);
  assert.equal(rec.chunks, 3);
  assert.equal(rec.bytes, 6);
  assert.equal(rec.uploaded, false);
  // the app was killed here: the next start finishes what it finds
  assert.deepEqual(await store.finishStale(new Set()), ["ride1"]);
  [rec] = await store.listRecordings();
  assert.equal(rec.done, true);
  assert.equal(rec.recovered, true);
  const blob = await store.recordingBlob("ride1");
  assert.equal(blob.type, "audio/webm;codecs=opus");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5, 6]);
  // a live recording is left alone
  await store.startRecording({ id: "ride2", mime: "audio/webm", createdAt: 11 });
  assert.deepEqual(await store.finishStale(new Set(["ride2"])), []);
});

test("chunks come back in order past ten, and finish records the length", async () => {
  const { store } = await fresh();
  await store.startRecording({ id: "r-a", mime: "audio/mp4", createdAt: 1 });
  await store.startRecording({ id: "r-ab", mime: "audio/mp4", createdAt: 2 });
  for (let i = 11; i >= 0; i--) await store.appendChunk("r-a", i, new Blob([new Uint8Array([i])]));
  await store.appendChunk("r-ab", 0, new Blob([new Uint8Array([99])]));
  await store.finishRecording("r-a", { durationS: 61.5 });
  const blob = await store.recordingBlob("r-a");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const [a, ab] = await store.listRecordings();
  assert.equal(a.done, true);
  assert.equal(a.durationS, 61.5);
  assert.equal(ab.done, false);
  // the server confirmed it: the audio is freed, the row stays as "in O Arquivo"
  await store.markUploaded("r-a", "cabine-20261027-120000-r-a.m4a");
  const [a2] = await store.listRecordings();
  assert.equal(a2.uploaded, true);
  assert.equal(a2.file, "cabine-20261027-120000-r-a.m4a");
  assert.equal(await store.recordingBlob("r-a"), null);
  assert.deepEqual([...new Uint8Array(await (await store.recordingBlob("r-ab")).arrayBuffer())], [99]);
});

test("estimate and persist go through navigator.storage", async () => {
  const { store, storage } = await fresh({ usage: 4096, quota: 1 << 30 });
  assert.deepEqual(await store.estimate(), { usage: 4096, quota: 1 << 30 });
  assert.equal(await store.persist(), true);
  assert.deepEqual(storage.calls.filter((c) => c.startsWith("persist")), ["persisted", "persist"]);
  const denied = await fresh({ grant: false });
  assert.equal(await denied.store.persist(), false);
  const already = await fresh({ persisted: true });
  assert.equal(await already.store.persist(), true);
  assert.ok(!already.storage.calls.includes("persist"), "no prompt when already persisted");
  const none = await openStore({ indexedDB: new FakeIDB(), storage: null });
  assert.deepEqual(await none.estimate(), { usage: null, quota: null });
  assert.equal(await none.persist(), false);
});

test("carriedBytes sums what is on the phone", async () => {
  const { store } = await fresh();
  assert.equal(await store.carriedBytes(), 0);
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid, peaks: bytes(1), mp3: bytes(1, 2) });
  await store.putTrack({ file: "b.wav", meta: meta("b.wav"), grid, peaks: bytes(1, 1), mp3: bytes(1, 2, 3, 4) });
  assert.equal(await store.carriedBytes(), 9);
});

test("storeSource offers the loader's getMp3 / getGrid / getMeta from the store", async () => {
  const { store } = await fresh();
  await store.putTrack({ file: "a.wav", meta: meta("a.wav", { carry_offset_s: 0.01 }), grid, peaks: bytes(1), mp3: bytes(4, 5) });
  const src = storeSource(store);
  assert.deepEqual([...new Uint8Array(await src.getMp3("a.wav"))], [4, 5]);
  assert.deepEqual(await src.getGrid("a.wav"), grid);
  assert.equal((await src.getMeta("a.wav")).carry_offset_s, 0.01);
  await assert.rejects(src.getMp3("missing.wav"), /not on this phone/);
  assert.equal(await src.getGrid("missing.wav"), null);
  assert.deepEqual(await src.getMeta("missing.wav"), { file: "missing.wav" });
});

test("storeSource_hands_the_loader_saved_hot_cues_and_peaks", async () => {
  const { store } = await fresh();
  await store.putTrack({ file: "a.wav", meta: meta("a.wav"), grid, peaks: bytes(7, 8), mp3: bytes(4, 5) });
  const cues = [{ start: 1.5, end: null }, null, null, null, null, null, null, { start: 2, end: 3 }];
  await store.putHotCues("a.wav", cues);
  const src = storeSource(store);
  assert.deepEqual(await src.getHotCues("a.wav"), cues);
  assert.equal(await src.getHotCues("b.wav"), null);
  await src.getMp3("a.wav");
  assert.deepEqual([...new Uint8Array(await src.getPeaks("a.wav"))], [7, 8], "peaks from the same read");
  assert.deepEqual([...new Uint8Array(await src.getPeaks("a.wav"))], [7, 8], "and on their own");
  assert.equal(await src.getPeaks("missing.wav"), null);
});
