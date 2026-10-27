// A Cabine: moving tracks between the server and the phone.
//
//   carry(file, onProgress, meta?)  MP3 + peaks + grid onto the phone
//   uncarry(file)                   off the phone
//   refreshGrids({files})           fill in grids that were pending
//   fixGrid(file, op, value)        halve / double / nudge / downbeat
//   pull(url, onJob)                intake pull into sources/techno/, polled
//   gridAll(onJob)                  the "grid everything" job, polled
//
//   drainUploads()                  recordings the phone holds -> O Arquivo
//
// The server runs one job at a time and answers 409 while one runs. For a
// grid that is "later", never a failure: the audio, peaks and meta are
// stored, the track shows "grid pending", and refreshGrids() asks again on
// app start, on `online`, after any pull or grid job, and after a fix.
//
// The PIN (Task 11). The shell is public; every /api/ call is gated by the
// dj_auth cookie. A server action he started (search, pull, carry, grid fix,
// grid everything: api(path, {ask: true})) that meets a 401 calls
// onAuth(), which shows the in-app PIN card and resolves true once the
// cookie is set; the call then runs again. Background calls (library list,
// grid refresh) never ask; an upload drain that meets a 401 calls
// onLocked() and leaves the queue as it is, so the app can show the card
// without blocking the board.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const POLL_MS = 1500;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

export function makeSync({ store, fetch: fetchFn = (...a) => globalThis.fetch(...a), base = "",
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS,
  jobTimeoutMs = JOB_TIMEOUT_MS, onAuth = null, onLocked = () => {} } = {}) {
  const q = (file) => encodeURIComponent(file);
  const listeners = [];
  const changed = (file, grid) => { for (const cb of listeners) { try { cb(file, grid); } catch (e) { /* listener bug */ } } };

  async function api(path, opts = {}) {
    const { json, allow = [], ask = false, ...init } = opts;
    init.credentials = "same-origin";
    if (json !== undefined) {
      init.method = init.method || "POST";
      init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
      init.body = JSON.stringify(json);
    }
    let r = await fetchFn(`${base}${path}`, init);
    // a server action he started: the PIN card, then the same call again
    while (r.status === 401 && ask && onAuth && !allow.includes(401)) {
      if (!(await onAuth())) break;
      r = await fetchFn(`${base}${path}`, init);
    }
    if (!r.ok && !allow.includes(r.status)) {
      let detail = `HTTP ${r.status}`;
      try {
        const d = await r.json();
        if (d && d.detail) detail = typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
      } catch (e) { /* not json */ }
      throw new ApiError(r.status, detail);
    }
    return r;
  }

  async function download(path, onProgress) {
    const r = await api(path, { ask: true });
    const total = Number(r.headers && r.headers.get && r.headers.get("content-length")) || null;
    if (!r.body || typeof r.body.getReader !== "function") {
      const buf = await r.arrayBuffer();
      onProgress(buf.byteLength, total || buf.byteLength);
      return buf;
    }
    const reader = r.body.getReader();
    const parts = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out.buffer;
  }

  /** The server grid, or null (404). Throws on anything else. */
  async function fetchGrid(file, ask = false) {
    const r = await api(`/api/cabine/grid?file=${q(file)}`, { allow: [404], ask });
    return r.status === 404 ? null : r.json();
  }

  /** Start a grid job: job id, or null when another job holds the lock (409). */
  async function startGrid(file, ask = false) {
    const r = await api("/api/cabine/grid", { json: { file }, allow: [409], ask });
    return r.status === 409 ? null : (await r.json()).job;
  }

  /** Poll /api/jobs until job `id` ends. Returns the job (null on timeout). */
  async function waitJob(id, onJob = () => {}, ask = false) {
    const end = Date.now() + jobTimeoutMs;
    for (;;) {
      const jobs = await (await api("/api/jobs", { ask })).json();
      const job = jobs.find((j) => j.id === id);
      if (!job) return { id, status: "done", log: "" };     // scrolled out of the last 8: long done
      onJob(job);
      if (job.status !== "running") return job;
      if (Date.now() > end) return null;
      await sleep(pollMs);
    }
  }

  async function libraryMeta(file) {
    try {
      const { tracks } = await (await api("/api/cabine/library", { ask: true })).json();
      return tracks.find((t) => t.file === file) || { file };
    } catch (e) {
      return { file };
    }
  }

  async function carry(file, onProgress = () => {}, meta = null) {
    const m = { ...(meta || await libraryMeta(file)) };
    delete m.grid;                                      // the stored grid is the source of truth
    const mp3 = await download(`/api/cabine/carry?file=${q(file)}`,
      (loaded, total) => onProgress({ phase: "audio", loaded, total }));
    onProgress({ phase: "peaks" });
    const peaks = await (await api(`/api/cabine/peaks?file=${q(file)}`, { ask: true })).arrayBuffer();
    onProgress({ phase: "grid" });
    let grid = null;
    let job = null;
    try {
      grid = await fetchGrid(file, true);
      if (!grid) job = await startGrid(file, true);
    } catch (e) {
      grid = null;                                      // carry never fails because of the grid
    }
    await store.putTrack({ file, meta: m, grid, peaks, mp3 });
    onProgress({ phase: "stored", grid });
    if (!grid && job !== null) {
      try {
        const j = await waitJob(job);
        if (j && j.status === "done") grid = await fetchGrid(file);
      } catch (e) { grid = null; }
      if (grid) {
        await store.setGrid(file, grid);
        onProgress({ phase: "gridded", grid });
        changed(file, grid);
      }
    }
    return { grid, pending: !grid };
  }

  function uncarry(file) {
    return store.removeTrack(file);
  }

  // ---- refreshGrids: single flight, reruns once if asked again meanwhile -------

  let running = null;
  let again = false;
  const forced = new Set();

  async function refreshPass(acc) {
    const entries = await store.listTracks();
    const carried = new Set(entries.map((e) => e.file));
    const want = entries.filter((e) => !e.grid).map((e) => e.file);
    for (const f of forced) if (carried.has(f) && !want.includes(f)) want.push(f);
    forced.clear();
    const pending = [];
    for (let i = 0; i < want.length; i++) {
      const file = want[i];
      try {
        let grid = await fetchGrid(file);
        if (!grid) {
          const job = await startGrid(file);
          if (job === null) { pending.push(...want.slice(i)); break; }     // 409: later
          const j = await waitJob(job);
          grid = j && j.status === "done" ? await fetchGrid(file) : null;
        }
        if (grid) {
          await store.setGrid(file, grid);
          if (!acc.resolved.includes(file)) acc.resolved.push(file);
          changed(file, grid);
        } else {
          pending.push(file);
        }
      } catch (e) {
        pending.push(...want.slice(i));                // offline, 401, server down: later
        break;
      }
    }
    // a forced re-fetch of a gridded track that failed is not "pending"
    const stillNull = new Set((await store.listTracks()).filter((e) => !e.grid).map((e) => e.file));
    acc.pending = pending.filter((f) => stillNull.has(f));
  }

  function refreshGrids({ files = [] } = {}) {
    for (const f of files) forced.add(f);
    if (running) { again = true; return running; }
    running = (async () => {
      const acc = { resolved: [], pending: [] };
      try {
        do {
          again = false;
          await refreshPass(acc);
        } while (again);
      } finally {
        running = null;
      }
      return acc;
    })();
    return running;
  }

  async function fixGrid(file, op, value) {
    const body = { file, op };
    if (value !== undefined && value !== null) body.value = value;
    const grid = await (await api("/api/cabine/grid/fix", { json: body, ask: true })).json();
    await store.setGrid(file, grid);
    changed(file, grid);
    refreshGrids({ files: [file] }).catch(() => {});
    return grid;
  }

  async function runJob(path, json, onJob) {
    const { job } = await (await api(path, { json, ask: true })).json();
    let last = null;
    try {
      last = await waitJob(job, onJob, true);
    } finally {
      refreshGrids().catch(() => {});
    }
    await idle();
    return last;
  }

  /** Intake pull into sources/techno/; resolves with the finished job. */
  function pull(url, onJob = () => {}) {
    return runJob("/api/intake/pull", { url, folder: "techno" }, onJob);
  }

  /** Grid every analyzed track lacking one (body e.g. {folder}). */
  function gridAll(onJob = () => {}, body = {}) {
    return runJob("/api/cabine/grid/all", body, onJob);
  }

  // ---- uploads: recordings on the phone -> O Arquivo, one drain at a time -------

  let draining = null;
  let drainAgain = false;

  async function drainPass(acc) {
    for (const rec of await store.listRecordings()) {
      if (rec.uploaded || rec.done === false || rec.empty || rec.rejected) continue;
      const blob = await store.recordingBlob(rec.id);
      if (!blob || !blob.size) continue;                  // nothing was flushed
      let r;
      try {
        r = await fetchFn(`${base}/api/mesa/export?name=cabine&client_id=${encodeURIComponent(rec.id)}`, {
          method: "POST", credentials: "same-origin", body: blob,
          headers: { "Content-Type": rec.mime || blob.type || "application/octet-stream" },
        });
      } catch (e) {
        acc.offline = true;                                // no signal: the next drain
        return;
      }
      if (r.status === 401) {
        acc.locked = true;                                 // stays queued until the PIN
        return;
      }
      if (r.status === 400 || r.status === 413) {          // refused for good: kept, not resent
        await store.markRejected(rec.id, r.status);
        acc.rejected++;
        continue;
      }
      if (!r.ok) { acc.failed++; continue; }               // 5xx and the rest: the next drain
      let file = null;
      try { file = (await r.json()).file || null; } catch (e) { /* the server has it */ }
      await store.markUploaded(rec.id, file);
      acc.sent++;
    }
  }

  /** Upload every finished recording not yet on the server. Single flight:
   *  a call during a drain gets that drain (which runs once more after). */
  function drainUploads() {
    if (draining) { drainAgain = true; return draining; }
    draining = (async () => {
      const acc = { sent: 0, failed: 0, rejected: 0, locked: false, offline: false };
      try {
        do {
          drainAgain = false;
          acc.failed = 0;
          await drainPass(acc);
        } while (drainAgain && !acc.locked && !acc.offline);
      } finally {
        draining = null;
      }
      if (acc.locked) { try { onLocked(); } catch (e) { /* app hook */ } }
      return acc;
    })();
    return draining;
  }

  /** The PIN card on demand (the crate's "PIN" button). */
  async function auth() {
    return onAuth ? !!(await onAuth()) : false;
  }

  /** Resolves when no refresh is running. */
  async function idle() {
    while (running) {
      try { await running; } catch (e) { /* reported elsewhere */ }
    }
  }

  return {
    store, api, carry, uncarry, refreshGrids, fixGrid, pull, gridAll, waitJob, idle, drainUploads, auth,
    /** cb(file, grid) whenever a carried grid changes; returns an unsubscribe. */
    onchange(cb) {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
  };
}
