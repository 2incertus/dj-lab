import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeIDB, fakeStorage } from "./fake-idb.js";
import { openStore } from "../store.js";
import { makeSync, ApiError } from "../sync.js";

const G = (bpm = 128) => ({ bpm, first_beat_s: 0.1, downbeat_s: 0.1, beat_cv: 0.01, reliable: true, source: "beat_this", fixed: false });
const MP3 = new Uint8Array(3000).fill(7);
const PEAKS = new Uint8Array([80, 75, 48, 49, 100, 0, 0, 0, 2, 0, 0, 0, 10, 20]);

/**
 * A fake dj-lab server: routes keyed by "METHOD path", each a function
 * (url, body) -> Response. Records every call.
 */
function fakeServer(state = {}) {
  const s = {
    grids: { ...(state.grids || {}) },      // file -> grid
    jobs: [],
    busy: false,                            // another job holds the lock
    jobFinishes: state.jobFinishes || (() => true),
    calls: [],
    library: state.library || [],
  };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  s.fetch = async (url, opts = {}) => {
    const u = new URL(url, "http://x");
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    s.calls.push(`${method} ${u.pathname}${u.search}`);
    const file = u.searchParams.get("file") || (body && body.file);
    const key = `${method} ${u.pathname}`;
    if (s.offline) throw new TypeError("Failed to fetch");
    if (key === "GET /api/cabine/library") return json({ tracks: s.library });
    if (key === "GET /api/cabine/carry") return new Response(MP3, { headers: { "content-length": String(MP3.length) } });
    if (key === "GET /api/cabine/peaks") return new Response(PEAKS);
    if (key === "GET /api/cabine/grid") return s.grids[file] ? json(s.grids[file]) : json({ detail: "no grid yet" }, 404);
    if (key === "POST /api/cabine/grid") {
      if (s.busy || s.jobs.some((j) => j.status === "running")) return json({ detail: "a job is already running" }, 409);
      const job = { id: s.jobs.length + 1, action: `beat grid: ${file}`, status: "running", log: "", file };
      s.jobs.push(job);
      return json({ job: job.id });
    }
    if (key === "POST /api/cabine/grid/fix") {
      if (!s.grids[file]) return json({ detail: "no grid yet" }, 404);
      if (body.op === "spin") return json({ detail: "unknown grid fix: spin" }, 400);
      const g = { ...s.grids[file], fixed: true };
      if (body.op === "double") g.bpm *= 2;
      s.grids[file] = g;
      return json(g);
    }
    if (key === "POST /api/intake/pull" || key === "POST /api/cabine/grid/all") {
      if (s.busy || s.jobs.some((j) => j.status === "running")) return json({ detail: "a job is already running" }, 409);
      const job = { id: s.jobs.length + 1, action: key, status: "running", log: "starting\n" };
      s.jobs.push(job);
      return json({ job: job.id });
    }
    if (key === "GET /api/jobs") {
      // each poll advances running jobs: a grid job finishes and writes its grid
      for (const j of s.jobs) {
        if (j.status !== "running" || !s.jobFinishes(j)) continue;
        j.status = j.fail ? "failed" : "done";
        j.log += j.fail ? "ERROR: boom\n" : "finished\n";
        if (j.file && !j.fail) s.grids[j.file] = G(126);
      }
      return json(s.jobs.slice(-8));
    }
    return json({ detail: "not found" }, 404);
  };
  return s;
}

async function setup(state) {
  const server = fakeServer(state);
  const store = await openStore({ indexedDB: new FakeIDB(), storage: fakeStorage() });
  const sync = makeSync({ store, fetch: server.fetch, sleep: async () => {}, pollMs: 0 });
  return { server, store, sync };
}

const metaOf = (file) => ({ file, title: file, bpm: 128, duration_s: 10, grid: null, carry_bytes: 3000, samples: 441000 });

test("carry stores audio, peaks, meta and the server grid", async () => {
  const { server, store, sync } = await setup({ grids: { "a.wav": G() } });
  const phases = [];
  const r = await sync.carry("a.wav", (p) => phases.push(p.phase), metaOf("a.wav"));
  assert.deepEqual(r, { grid: G(), pending: false });
  const t = await store.getTrack("a.wav");
  assert.equal(t.mp3.byteLength, MP3.length);
  assert.deepEqual([...new Uint8Array(t.peaks)], [...PEAKS]);
  assert.deepEqual(t.grid, G());
  assert.equal(t.meta.title, "a.wav");
  assert.equal(t.meta.samples, 441000);
  assert.equal(t.meta.grid, undefined, "the stored grid is the one source of truth");
  assert.ok(phases.includes("audio") && phases.includes("stored"));
  assert.ok(!server.calls.some((c) => c.startsWith("POST")), "no grid job when the server has one");
});

test("carry reports download progress against content-length", async () => {
  const { sync } = await setup({ grids: { "a.wav": G() } });
  const seen = [];
  await sync.carry("a.wav", (p) => { if (p.phase === "audio") seen.push([p.loaded, p.total]); }, metaOf("a.wav"));
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[seen.length - 1], [MP3.length, MP3.length]);
});

test("carry without meta looks the track up in the library", async () => {
  const { store, sync } = await setup({ grids: { "a.wav": G() }, library: [metaOf("a.wav")] });
  await sync.carry("a.wav");
  assert.equal((await store.getEntry("a.wav")).meta.samples, 441000);
});

test("no grid on the server: carry starts a grid job, stores now, then fills the grid in", async () => {
  const { server, store, sync } = await setup();
  const phases = [];
  const r = await sync.carry("a.wav", (p) => phases.push(p.phase), metaOf("a.wav"));
  assert.ok(server.calls.includes("POST /api/cabine/grid"));
  assert.deepEqual(r, { grid: G(126), pending: false });
  assert.deepEqual((await store.getEntry("a.wav")).grid, G(126));
  // stored (grid pending) before the job finished, then gridded
  assert.ok(phases.indexOf("stored") < phases.indexOf("gridded"), phases.join());
});

test("a 409 (another job running) is later, not failure: grid pending", async () => {
  const { server, store, sync } = await setup();
  server.busy = true;
  const r = await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  assert.deepEqual(r, { grid: null, pending: true });
  const e = await store.getEntry("a.wav");
  assert.equal(e.grid, null);
  assert.ok((await store.getTrack("a.wav")).mp3.byteLength > 0, "audio is on the phone");
});

test("a failed grid job leaves the track carried with the grid pending", async () => {
  const { server, store, sync } = await setup({ jobFinishes: (j) => { j.fail = true; return true; } });
  const r = await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  assert.deepEqual(r, { grid: null, pending: true });
  assert.ok(await store.getEntry("a.wav"));
  assert.equal(server.jobs[0].status, "failed");
});

test("carry fails (and stores nothing) when the audio cannot be fetched", async () => {
  const { server, store, sync } = await setup();
  server.offline = true;
  await assert.rejects(sync.carry("a.wav", () => {}, metaOf("a.wav")));
  assert.equal(await store.getEntry("a.wav"), null);
});

test("api errors carry the status and the server's detail", async () => {
  const { sync } = await setup({ grids: { "a.wav": G() } });
  await assert.rejects(sync.fixGrid("a.wav", "spin"), (e) => e instanceof ApiError && e.status === 400 && /unknown grid fix/.test(e.message));
});

test("refreshGrids: 409 now, resolves on the next run", async () => {
  const { server, store, sync } = await setup();
  server.busy = true;
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  await sync.carry("b.wav", () => {}, metaOf("b.wav"));
  let r = await sync.refreshGrids();
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.pending.sort(), ["a.wav", "b.wav"]);
  assert.equal(server.calls.filter((c) => c === "POST /api/cabine/grid").length, 3,
    "two carries + one refresh POST, then it stops at the 409");
  server.busy = false;
  const changed = [];
  sync.onchange((file) => changed.push(file));
  r = await sync.refreshGrids();
  assert.deepEqual(r.resolved.sort(), ["a.wav", "b.wav"]);
  assert.deepEqual(r.pending, []);
  assert.deepEqual((await store.getEntry("a.wav")).grid, G(126));
  assert.deepEqual(changed.sort(), ["a.wav", "b.wav"]);
});

test("refreshGrids picks up a grid the server made meanwhile without a new job", async () => {
  const { server, store, sync } = await setup();
  server.busy = true;
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  server.busy = false;
  server.grids["a.wav"] = G(140);
  const before = server.calls.length;
  const r = await sync.refreshGrids();
  assert.deepEqual(r.resolved, ["a.wav"]);
  assert.ok(!server.calls.slice(before).some((c) => c.startsWith("POST")));
  assert.equal((await store.getEntry("a.wav")).grid.bpm, 140);
});

test("refreshGrids offline keeps everything pending and does not throw", async () => {
  const { server, sync } = await setup();
  server.busy = true;
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  server.offline = true;
  const r = await sync.refreshGrids();
  assert.deepEqual(r, { resolved: [], pending: ["a.wav"] });
});

test("refreshGrids is single-flight: a call during a run reruns once after it", async () => {
  const { server, sync } = await setup();
  server.busy = true;
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  server.busy = false;
  const p1 = sync.refreshGrids();
  const p2 = sync.refreshGrids();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1.resolved, ["a.wav"]);
  assert.equal(r1, r2);
  assert.equal(server.calls.filter((c) => c === "POST /api/cabine/grid").length, 2,
    "one from the carry (409), one from the refresh");
});

test("fixGrid posts the fix, stores the returned grid and re-fetches it", async () => {
  const { server, store, sync } = await setup({ grids: { "a.wav": G(64) } });
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  const g = await sync.fixGrid("a.wav", "double");
  assert.equal(g.bpm, 128);
  assert.equal(g.fixed, true);
  assert.equal((await store.getEntry("a.wav")).grid.bpm, 128);
  await sync.idle();
  const fixAt = server.calls.indexOf("POST /api/cabine/grid/fix");
  assert.ok(server.calls.slice(fixAt + 1).includes("GET /api/cabine/grid?file=a.wav"), "re-fetched after the fix");
});

test("fixGrid sends the value for nudges and taps", async () => {
  const sent = [];
  const { server, sync } = await setup({ grids: { "a.wav": G() } });
  const inner = server.fetch;
  server.fetch = async (url, opts) => { if (opts && opts.body) sent.push(JSON.parse(opts.body)); return inner(url, opts); };
  const sync2 = makeSync({ store: sync.store, fetch: server.fetch, sleep: async () => {}, pollMs: 0 });
  await sync2.fixGrid("a.wav", "nudge", -10);
  await sync2.fixGrid("a.wav", "downbeat", 1.234);
  assert.deepEqual(sent, [{ file: "a.wav", op: "nudge", value: -10 }, { file: "a.wav", op: "downbeat", value: 1.234 }]);
});

test("uncarry removes the track from the phone", async () => {
  const { store, sync } = await setup({ grids: { "a.wav": G() } });
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  await sync.uncarry("a.wav");
  assert.equal(await store.getTrack("a.wav"), null);
});

test("pull polls the job, reports log lines, and refreshes grids when it ends", async () => {
  const { server, store, sync } = await setup();
  server.busy = true;
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  server.busy = false;
  let polls = 0;
  server.jobFinishes = (j) => (j.action === "POST /api/intake/pull" ? ++polls >= 3 : true);
  const lines = [];
  const job = await sync.pull("https://soundcloud.com/x/y", (j) => lines.push(j.status));
  assert.equal(job.status, "done");
  assert.ok(lines.length >= 2 && lines[0] === "running");
  assert.deepEqual(JSON.parse(JSON.stringify((await store.getEntry("a.wav")).grid)), G(126), "refreshGrids ran after the pull");
});

test("pull while another job runs is a 409 ApiError", async () => {
  const { server, sync } = await setup();
  server.busy = true;
  await assert.rejects(sync.pull("https://soundcloud.com/x/y"), (e) => e instanceof ApiError && e.status === 409);
});

test("gridAll runs the job and then refreshes carried grids", async () => {
  const { server, sync } = await setup();
  const job = await sync.gridAll(() => {});
  assert.equal(job.status, "done");
  assert.ok(server.calls.includes("POST /api/cabine/grid/all"));
});

// ---- Task 11: the PIN card hook and the upload queue ------------------------------

/** The fake server behind a PIN: every /api/ call answers 401 until `authed`,
 *  and POST /api/mesa/export stores uploads by client id. */
function lockedServer(state = {}) {
  const s = fakeServer(state);
  const inner = s.fetch;
  s.authed = !!state.authed;
  s.exports = new Map();                // client_id -> {file, bytes, type}
  s.posts = [];
  s.exportStatus = null;                // force a status for the next export POST
  s.fetch = async (url, opts = {}) => {
    const u = new URL(url, "http://x");
    if (s.offline) throw new TypeError("Failed to fetch");
    if (u.pathname.startsWith("/api/") && !s.authed) {
      s.calls.push(`401 ${u.pathname}`);
      return new Response(JSON.stringify({ detail: "auth required" }), { status: 401 });
    }
    if (u.pathname === "/api/mesa/export" && (opts.method || "GET") === "POST") {
      const cid = u.searchParams.get("client_id");
      s.posts.push({ name: u.searchParams.get("name"), cid, type: opts.headers && opts.headers["Content-Type"] });
      if (s.exportStatus) { const st = s.exportStatus; s.exportStatus = null; return new Response("{}", { status: st }); }
      if (!s.exports.has(cid)) {
        const bytes = new Uint8Array(await opts.body.arrayBuffer());
        s.exports.set(cid, { file: `cabine-x-${cid.slice(0, 8)}.m4a`, bytes });
      }
      return new Response(JSON.stringify({ file: s.exports.get(cid).file }), { status: 200 });
    }
    return inner(url, opts);
  };
  return s;
}

async function lockedSetup(state = {}, hooks = {}) {
  const server = lockedServer(state);
  const store = await openStore({ indexedDB: new FakeIDB(), storage: fakeStorage() });
  const asked = [];
  const locked = [];
  const sync = makeSync({
    store, fetch: server.fetch, sleep: async () => {}, pollMs: 0,
    onAuth: hooks.onAuth || (async () => { asked.push(1); server.authed = true; return true; }),
    onLocked: () => locked.push(1),
  });
  return { server, store, sync, asked, locked };
}

async function finishedRecording(store, id, bytes, mime = "audio/webm;codecs=opus") {
  await store.startRecording({ id, mime, createdAt: Date.now() });
  await store.appendChunk(id, 0, new Blob([new Uint8Array(bytes)]));
  await store.finishRecording(id, { durationS: 60 });
}

test("a server action that meets a 401 asks for the PIN, then runs again", async () => {
  const { server, sync, asked } = await lockedSetup({ library: [metaOf("a.wav")] });
  const r = await sync.api("/api/cabine/library", { ask: true });
  assert.equal(r.status, 200);
  assert.equal(asked.length, 1);
  assert.deepEqual(server.calls.filter((c) => c.endsWith("/api/cabine/library")),
    ["401 /api/cabine/library", "GET /api/cabine/library"]);
});

test("carry, pull and fixGrid are server actions: they ask too", async () => {
  const { sync, store, asked } = await lockedSetup({ grids: { "a.wav": G() } });
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  assert.equal(asked.length, 1);
  assert.ok(await store.getEntry("a.wav"));
  const s2 = await lockedSetup({ grids: { "a.wav": G() } });
  await s2.sync.carry("a.wav", () => {}, metaOf("a.wav"));     // authed by its own card
  s2.server.authed = false;
  await s2.sync.fixGrid("a.wav", "double");
  assert.equal(s2.asked.length, 2);
  s2.server.authed = false;
  const job = await s2.sync.pull("https://youtube.com/watch?v=x");
  assert.equal(job.status, "done");
  assert.equal(s2.asked.length, 3);
});

test("background calls never ask: library listing, grid refresh", async () => {
  const { sync, store, asked } = await lockedSetup({ authed: true, grids: {} });
  await sync.carry("a.wav", () => {}, metaOf("a.wav"));
  const s = await lockedSetup();
  await assert.rejects(s.sync.api("/api/cabine/library"), (e) => e instanceof ApiError && e.status === 401);
  await s.store.putTrack({ file: "b.wav", meta: metaOf("b.wav"), peaks: PEAKS, mp3: MP3 });
  const r = await s.sync.refreshGrids();
  assert.deepEqual(r.pending, ["b.wav"]);
  assert.equal(s.asked.length, 0);
  assert.equal(asked.length, 0);
  assert.ok(store);
});

test("a declined PIN card fails the action with its 401", async () => {
  const { sync } = await lockedSetup({}, { onAuth: async () => false });
  await assert.rejects(sync.api("/api/intake/youtube/search?q=x", { ask: true }),
    (e) => e instanceof ApiError && e.status === 401);
});

test("drainUploads posts each finished take once, as name=cabine with its client id", async () => {
  const { server, store, sync } = await lockedSetup({ authed: true });
  await finishedRecording(store, "ride-aaaa-1", [1, 2, 3]);
  await store.startRecording({ id: "ride-live", mime: "audio/webm" });         // still recording
  await store.appendChunk("ride-live", 0, new Blob([new Uint8Array([9])]));
  const r = await sync.drainUploads();
  assert.deepEqual(r, { sent: 1, failed: 0, rejected: 0, locked: false, offline: false });
  assert.deepEqual(server.posts, [{ name: "cabine", cid: "ride-aaaa-1", type: "audio/webm;codecs=opus" }]);
  assert.deepEqual([...server.exports.get("ride-aaaa-1").bytes], [1, 2, 3]);
  const recs = await store.listRecordings();
  const done = recs.find((x) => x.id === "ride-aaaa-1");
  assert.equal(done.uploaded, true);
  assert.equal(done.file, "cabine-x-ride-aaa.m4a");
  assert.equal(recs.find((x) => x.id === "ride-live").uploaded, false);
  await sync.drainUploads();
  assert.equal(server.posts.length, 1, "nothing left to send");
});

test("drainUploads: a 401 keeps the queue, tells the app once, then uploads exactly once after the PIN", async () => {
  const { server, store, sync, locked, asked } = await lockedSetup();
  await finishedRecording(store, "ride-bbbb-1", [4, 5]);
  await finishedRecording(store, "ride-bbbb-2", [6]);
  const r1 = await sync.drainUploads();
  assert.equal(r1.locked, true);
  assert.equal(locked.length, 1);
  assert.equal(asked.length, 0, "a background drain never opens the card itself");
  assert.ok((await store.listRecordings()).every((x) => !x.uploaded));
  server.authed = true;
  const [a, b] = await Promise.all([sync.drainUploads(), sync.drainUploads()]);  // one drain at a time
  assert.equal(a.sent + (b === a ? 0 : b.sent), 2);
  assert.deepEqual(server.posts.filter((p) => p.cid).map((p) => p.cid).sort(), ["ride-bbbb-1", "ride-bbbb-2"]);
  assert.ok((await store.listRecordings()).every((x) => x.uploaded));
});

test("drainUploads: a server error retries on the next drain, offline stops quietly", async () => {
  const { server, store, sync } = await lockedSetup({ authed: true });
  await finishedRecording(store, "ride-cccc-1", [7]);
  server.exportStatus = 500;
  let r = await sync.drainUploads();
  assert.equal(r.failed, 1);
  assert.equal((await store.listRecordings())[0].uploaded, false);
  server.offline = true;
  r = await sync.drainUploads();
  assert.equal(r.offline, true);
  server.offline = false;
  r = await sync.drainUploads();
  assert.equal(r.sent, 1);
  assert.equal((await store.listRecordings())[0].uploaded, true);
});

test("drainUploads: 400 or 413 marks the take rejected (kept, never sent again); 503 keeps retrying", async () => {
  const { server, store, sync } = await lockedSetup({ authed: true });
  await finishedRecording(store, "ride-dddd-1", [1]);
  server.exportStatus = 413;
  let r = await sync.drainUploads();
  assert.equal(r.rejected, 1);
  let rec = (await store.listRecordings())[0];
  assert.equal(rec.rejected, 413);
  assert.equal(rec.uploaded, false);
  await sync.drainUploads();
  assert.equal(server.posts.length, 1, "a rejected take is not sent again");

  await finishedRecording(store, "ride-eeee-1", [2]);
  server.exportStatus = 503;
  r = await sync.drainUploads();
  assert.equal(r.failed, 1);
  assert.equal((await store.listRecordings()).find((x) => x.id === "ride-eeee-1").rejected, undefined);
  r = await sync.drainUploads();
  assert.equal(r.sent, 1);
});

test("drainUploads skips empty takes", async () => {
  const { server, store, sync } = await lockedSetup({ authed: true });
  await store.startRecording({ id: "ride-ffff-1", mime: "audio/webm" });
  await store.finishRecording("ride-ffff-1", { durationS: 0.1 });
  await sync.drainUploads();
  assert.equal(server.posts.length, 0);
});
