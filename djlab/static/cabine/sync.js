// A Cabine: moving tracks between the server and the phone.
//
//   carry(file, onProgress, meta?)  MP3 + peaks + grid onto the phone
//   uncarry(file)                   off the phone
//   refreshGrids({files})           fill in grids that were pending
//   fixGrid(file, op, value)        halve / double / nudge / downbeat
//   pull(url, onJob)                intake pull into sources/techno/, polled
//   gridAll(onJob)                  the "grid everything" job, polled
//
// The server runs one job at a time and answers 409 while one runs. For a
// grid that is "later", never a failure: the audio, peaks and meta are
// stored, the track shows "grid pending", and refreshGrids() asks again on
// app start, on `online`, after any pull or grid job, and after a fix.

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
  jobTimeoutMs = JOB_TIMEOUT_MS } = {}) {
  const q = (file) => encodeURIComponent(file);
  const listeners = [];
  const changed = (file, grid) => { for (const cb of listeners) { try { cb(file, grid); } catch (e) { /* listener bug */ } } };

  async function api(path, opts = {}) {
    const { json, allow = [], ...init } = opts;
    init.credentials = "same-origin";
    if (json !== undefined) {
      init.method = init.method || "POST";
      init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
      init.body = JSON.stringify(json);
    }
    const r = await fetchFn(`${base}${path}`, init);
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
    const r = await api(path);
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
  async function fetchGrid(file) {
    const r = await api(`/api/cabine/grid?file=${q(file)}`, { allow: [404] });
    return r.status === 404 ? null : r.json();
  }

  /** Start a grid job: job id, or null when another job holds the lock (409). */
  async function startGrid(file) {
    const r = await api("/api/cabine/grid", { json: { file }, allow: [409] });
    return r.status === 409 ? null : (await r.json()).job;
  }

  /** Poll /api/jobs until job `id` ends. Returns the job (null on timeout). */
  async function waitJob(id, onJob = () => {}) {
    const end = Date.now() + jobTimeoutMs;
    for (;;) {
      const jobs = await (await api("/api/jobs")).json();
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
      const { tracks } = await (await api("/api/cabine/library")).json();
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
    const peaks = await (await api(`/api/cabine/peaks?file=${q(file)}`)).arrayBuffer();
    onProgress({ phase: "grid" });
    let grid = null;
    let job = null;
    try {
      grid = await fetchGrid(file);
      if (!grid) job = await startGrid(file);
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
    const grid = await (await api("/api/cabine/grid/fix", { json: body })).json();
    await store.setGrid(file, grid);
    changed(file, grid);
    refreshGrids({ files: [file] }).catch(() => {});
    return grid;
  }

  async function runJob(path, json, onJob) {
    const { job } = await (await api(path, { json })).json();
    let last = null;
    try {
      last = await waitJob(job, onJob);
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

  /** Resolves when no refresh is running. */
  async function idle() {
    while (running) {
      try { await running; } catch (e) { /* reported elsewhere */ }
    }
  }

  return {
    store, api, carry, uncarry, refreshGrids, fixGrid, pull, gridAll, waitJob, idle,
    /** cb(file, grid) whenever a carried grid changes; returns an unsubscribe. */
    onchange(cb) {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
  };
}
