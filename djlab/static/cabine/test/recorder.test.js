import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeIDB, fakeStorage } from "./fake-idb.js";
import { openStore } from "../store.js";
import { Recorder, pickFormat, CHUNK_MS, PART_S } from "../engine/recorder.js";

/** A MediaRecorder stand-in: emits a chunk on tick(), a last one on stop(). */
function fakeMR(supported) {
  const made = [];
  class MR {
    static isTypeSupported(t) { return supported.includes(t); }
    constructor(stream, opts) {
      this.stream = stream; this.opts = opts; this.mimeType = opts.mimeType; this.state = "inactive";
      this.ondataavailable = null; this.onstop = null; this.n = 0; made.push(this);
    }
    start(timeslice) { this.timeslice = timeslice; this.state = "recording"; }
    tick(bytes = [this.n]) {
      this.n++;
      this.ondataavailable({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
    }
    stop() {
      this.state = "inactive";
      setTimeout(() => {
        this.ondataavailable({ data: new Blob([new Uint8Array([0xee])], { type: this.mimeType }) });
        this.ondataavailable({ data: new Blob([]) });                // an empty one is ignored
        this.onstop();
      }, 0);
    }
  }
  MR.made = made;
  return MR;
}

function fakeGraph() {
  const dest = { stream: { id: "master-stream" } };
  const tap = { links: [], connect(n) { this.links.push(n); }, disconnect(n) { this.links = this.links.filter((x) => x !== n); } };
  const ctx = { createMediaStreamDestination: () => dest };
  return { ctx, tap, dest };
}

async function setup(supported, opts = {}) {
  const store = await openStore({ indexedDB: new FakeIDB(), storage: fakeStorage() });
  const MR = fakeMR(supported);
  const { ctx, tap, dest } = fakeGraph();
  let t = 1000;
  const timers = [];
  const rec = new Recorder(ctx, tap, store, {
    MediaRecorder: MR, now: () => t, newId: () => "ride-0001",
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    ...opts,
  });
  return { store, MR, ctx, tap, dest, rec, timers, advance: (ms) => { t += ms; } };
}

test("format: WebM/Opus in 5 s chunks where it exists, else MP4 in parts", () => {
  assert.deepEqual(pickFormat(fakeMR(["audio/webm;codecs=opus", "audio/mp4"])),
    { mime: "audio/webm;codecs=opus", parts: false });
  assert.deepEqual(pickFormat(fakeMR(["audio/mp4"])), { mime: "audio/mp4", parts: true });
  assert.equal(pickFormat(fakeMR([])), null);
  assert.equal(CHUNK_MS, 5000);
  assert.equal(PART_S, 300);
});

test("chromium: one recording, chunks land in the store as they come, master tap only", async () => {
  const { store, MR, tap, dest, rec, advance } = await setup(["audio/webm;codecs=opus"]);
  assert.equal(rec.state, "inactive");
  const id = await rec.start();
  assert.equal(id, "ride-0001");
  assert.equal(rec.state, "recording");
  assert.deepEqual(tap.links, [dest], "the master tap feeds the recorder");
  const mr = MR.made[0];
  assert.equal(mr.stream, dest.stream);
  assert.equal(mr.timeslice, CHUNK_MS);
  assert.equal(mr.mimeType, "audio/webm;codecs=opus");
  mr.tick([1, 2]);
  mr.tick([3]);
  await rec.flushed();
  let [r] = await store.listRecordings();
  assert.equal(r.id, "ride-0001");
  assert.equal(r.done, false);
  assert.equal(r.chunks, 2, "a crash now keeps 10 s");
  advance(61000);
  assert.equal(Math.round(rec.elapsed()), 61);
  assert.equal(await rec.stop(), "ride-0001");
  assert.equal(rec.state, "inactive");
  assert.deepEqual(tap.links, [], "unhooked from the master");
  [r] = await store.listRecordings();
  assert.equal(r.done, true);
  assert.equal(r.durationS, 61);
  const blob = await store.recordingBlob("ride-0001");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 0xee]);
});

test("safari: audio/mp4 records in parts of PART_S, each its own <ride>-<n>", async () => {
  const { store, MR, rec, timers, advance } = await setup(["audio/mp4"]);
  await rec.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, PART_S * 1000);
  MR.made[0].tick([1]);
  advance(PART_S * 1000);
  await timers[0].fn();                              // the 5-minute mark: next part
  assert.equal(MR.made.length, 2);
  assert.equal(MR.made[0].state, "inactive");
  assert.equal(MR.made[1].state, "recording");
  MR.made[1].tick([2]);
  advance(20000);
  assert.equal(await rec.stop(), "ride-0001");
  const recs = await store.listRecordings();
  assert.deepEqual(recs.map((r) => [r.id, r.done, r.ride, r.part]),
    [["ride-0001-1", true, "ride-0001", 1], ["ride-0001-2", true, "ride-0001", 2]]);
  assert.equal(recs[0].durationS, PART_S);
  assert.equal(recs[1].durationS, 20);
  assert.equal(recs[0].mime, "audio/mp4");
  assert.deepEqual([...new Uint8Array(await (await store.recordingBlob("ride-0001-1")).arrayBuffer())], [1, 0xee]);
  // each id fits the server's client_id rule
  for (const r of recs) assert.match(r.id, /^[A-Za-z0-9-]{8,64}$/);
});

test("start twice is one recording; stop when idle is a no-op; onfinish fires", async () => {
  const fin = [];
  const { MR, rec } = await setup(["audio/webm;codecs=opus"], { onfinish: (id) => fin.push(id) });
  await rec.start();
  await rec.start();
  assert.equal(MR.made.length, 1);
  await rec.stop();
  assert.equal(await rec.stop(), null);
  assert.deepEqual(fin, ["ride-0001"]);
});

test("no MediaRecorder format at all: start says so", async () => {
  const { rec } = await setup([]);
  await assert.rejects(rec.start(), /cannot record/);
  assert.equal(rec.state, "inactive");
});
