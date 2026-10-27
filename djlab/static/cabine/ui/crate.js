// A Cabine: the crate screen (A Caixa). Portrait, phone first.
//
// Search YouTube / SoundCloud / Spotify (a Spotify pick only searches
// YouTube for the upload; he picks it), pull into sources/techno/ with the
// job polled, then carry tracks to the phone, remove them, and fix their
// grids. Everything the phone holds stays listed when the server is out
// of reach. Server actions (search, pull, carry, grid) that meet a 401 open
// the app's PIN card (sync.api {ask: true}); listing the crate never does,
// it offers a "PIN" button instead. The recordings the phone holds are
// listed with "waiting to upload" or "in O Arquivo".

import { formatBytes, formatDuration, formatBpm, mergeLibrary, uploadQuery } from "./crate-model.js";
import { Preview } from "./preview.js";
import { barPhaseAt } from "../engine/grid.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const TABS = [["youtube", "YouTube"], ["soundcloud", "SoundCloud"], ["spotify", "Spotify"]];
const NUDGES = [-10, -1, 1, 10];

const SHELL = `
<div class="cab-crate">
  <header class="cab-crate-head">
    <div>
      <h1 class="cab-crate-h1">A Caixa</h1>
      <p class="cab-crate-sub">the crate: find, pull, carry to the phone</p>
    </div>
    <div class="cab-crate-head-btns">
      <button type="button" class="cab-help-btn" id="cab-help" aria-label="install and help">?</button>
      <button type="button" class="cab-btn cab-btn-ink" id="cab-to-board">a cabine<small>the board</small></button>
    </div>
  </header>

  <section class="cab-storage" id="cab-storage" aria-live="polite">
    <p class="cab-storage-text">reading storage</p>
  </section>

  <section class="cab-panel cab-search">
    <h2 class="cab-h2">Buscar <small>find a track</small></h2>
    <div class="cab-tabs" role="tablist">
      ${TABS.map(([k, label]) => `<button type="button" role="tab" class="cab-tab" data-tab="${k}">${label}</button>`).join("")}
    </div>
    <form class="cab-search-form" id="cab-search-form">
      <input type="search" id="cab-q" class="cab-input" placeholder="artist, title" autocomplete="off" enterkeyhint="search">
      <button type="submit" class="cab-btn cab-btn-terra">buscar</button>
    </form>
    <div class="cab-context" id="cab-context" hidden></div>
    <p class="cab-msg" id="cab-search-msg" hidden></p>
    <ul class="cab-results" id="cab-results"></ul>
  </section>

  <div class="cab-job" id="cab-job" hidden aria-live="polite"></div>

  <section class="cab-panel cab-lib">
    <div class="cab-lib-head">
      <h2 class="cab-h2">Na caixa <small id="cab-lib-count"></small></h2>
      <button type="button" class="cab-btn cab-btn-quiet" id="cab-grid-all">grid everything</button>
    </div>
    <div class="cab-lib-tools">
      <input type="search" id="cab-filter" class="cab-input" placeholder="filter the crate" autocomplete="off">
      <button type="button" class="cab-chip" id="cab-only-phone" aria-pressed="false">on phone</button>
    </div>
    <p class="cab-msg cab-offline" id="cab-offline" hidden>Server out of reach: showing what is on the phone.</p>
    <p class="cab-msg cab-offline" id="cab-locked" hidden>The server asks for the PIN: showing what is on the phone.
      <button type="button" class="cab-link" id="cab-pin-open">PIN</button></p>
    <ul class="cab-tracks" id="cab-tracks"></ul>
  </section>

  <section class="cab-panel cab-recs" id="cab-recs" hidden>
    <h2 class="cab-h2">Gravações <small id="cab-recs-count"></small></h2>
    <ul class="cab-rec-list" id="cab-rec-list"></ul>
  </section>
</div>

<div class="cab-sheet-back" id="cab-sheet" hidden>
  <div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="cab-sheet-title">
    <div class="cab-sheet-grip"></div>
    <h3 class="cab-sheet-h" id="cab-sheet-title">Grade</h3>
    <p class="cab-sheet-track" id="cab-sheet-track"></p>
    <p class="cab-sheet-grid" id="cab-sheet-grid"></p>
    <div class="cab-beats" id="cab-beats" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="cab-sheet-row">
      <button type="button" class="cab-btn cab-btn-terra cab-wide" id="cab-listen">listen</button>
      <button type="button" class="cab-btn cab-btn-ink cab-wide" id="cab-beat1" disabled>this is beat 1</button>
    </div>
    <p class="cab-sheet-hint">Plays the copy on the phone through its speaker. Tap "this is beat 1" on the first kick of a bar.</p>
    <div class="cab-sheet-row">
      <button type="button" class="cab-btn cab-btn-quiet cab-wide" data-op="halve">halve <small>/2</small></button>
      <button type="button" class="cab-btn cab-btn-quiet cab-wide" data-op="double">double <small>x2</small></button>
    </div>
    <div class="cab-sheet-row cab-nudges">
      ${NUDGES.map((ms) => `<button type="button" class="cab-btn cab-btn-quiet" data-nudge="${ms}">${ms > 0 ? "+" : ""}${ms} ms</button>`).join("")}
    </div>
    <p class="cab-msg" id="cab-sheet-msg" hidden></p>
    <button type="button" class="cab-btn cab-btn-ink cab-sheet-done" id="cab-sheet-done">done</button>
  </div>
</div>`;

export function renderCrate(root, { store, sync, onBoard = () => {}, onHelp = () => {} }) {
  root.innerHTML = SHELL;
  const $ = (s) => root.querySelector(s);
  const state = {
    tab: "youtube",
    server: null,              // library tracks, null when unreachable
    locked: false,             // the library answered 401: no cookie on this phone
    carried: [],
    progress: new Map(),       // file -> {loaded, total, phase}
    filter: "",
    onlyPhone: false,
    busy: false,               // a pull / grid job this screen started is running
    sheetFile: null,
    lastSpotify: null,
  };
  const preview = new Preview(store);
  let alive = true;

  // ---- storage ------------------------------------------------------------------

  async function renderStorage() {
    const [est, carriedBytes] = await Promise.all([store.estimate(), store.carriedBytes()]);
    const box = $("#cab-storage");
    if (!box) return;
    const n = state.carried.length;
    box.dataset.carriedBytes = String(carriedBytes);
    box.dataset.usage = String(est.usage ?? "");
    $(".cab-storage-text").innerHTML =
      `<b>${n} ${n === 1 ? "track" : "tracks"} on the phone, ${formatBytes(carriedBytes)}</b>`
      + (est.usage !== null ? `<span>A Cabine uses ${formatBytes(est.usage)} of this phone's storage</span>` : "");
  }

  // ---- library ------------------------------------------------------------------

  async function loadLibrary() {
    try {
      const r = await sync.api("/api/cabine/library");
      state.server = (await r.json()).tracks || [];
      state.locked = false;
    } catch (e) {
      state.server = null;
      state.locked = e && e.status === 401;
    }
    await reloadCarried();
    await renderRecordings();
  }

  // ---- recordings ---------------------------------------------------------------

  const when = (ms) => {
    const d = new Date(ms);
    return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  };

  async function renderRecordings() {
    const recs = (await store.listRecordings()).filter((r) => !r.empty);
    if (!alive || !$("#cab-recs")) return;
    $("#cab-recs").hidden = recs.length === 0;
    const waiting = recs.filter((r) => !r.uploaded && !r.rejected).length;
    const up = recs.filter((r) => r.uploaded).length;
    const kept = recs.filter((r) => !r.uploaded && r.rejected).length;
    $("#cab-recs-count").textContent = [waiting && `${waiting} waiting to upload`,
      up && `${up} in O Arquivo`, kept && `${kept} kept on the phone`].filter(Boolean).join(", ");
    $("#cab-rec-list").innerHTML = recs.slice().reverse().map((r) => {
      const status = r.uploaded ? "in O Arquivo"
        : r.done === false ? "recording"
          : r.rejected ? (r.rejected === 413 ? "too big for O Arquivo, kept here" : "O Arquivo refused it, kept here")
            : "waiting to upload";
      const early = r.incomplete ? " &middot; stopped early" : "";
      const len = r.durationS ? formatDuration(r.durationS) : "";
      const part = r.part ? ` &middot; part ${r.part}` : "";
      return `<li class="cab-rec-row${r.uploaded ? " cab-rec-up" : ""}" data-rec="${esc(r.id)}">
        <span>${esc(when(r.createdAt || 0))}${part}${len ? ` &middot; ${esc(len)}` : ""}${early}</span>
        <b class="cab-rec-status">${status}</b></li>`;
    }).join("");
  }

  async function reloadCarried() {
    state.carried = await store.listTracks();
    if (!alive) return;
    renderTracks();
    renderStorage();
  }

  function rowHtml(r) {
    const prog = state.progress.get(r.file);
    const sub = [
      r.folder,
      r.grid ? `${formatBpm(r.grid.bpm)} BPM` : (r.bpm ? `${Math.round(r.bpm)} BPM` : ""),
      r.camelot,
      formatDuration(r.duration_s),
      r.bytes ? formatBytes(r.bytes) : "",
    ].filter(Boolean).map(esc).join(" &middot; ");
    const badges = [
      r.onPhone ? `<span class="cab-badge cab-badge-phone">on phone</span>` : "",
      r.gridPending ? `<span class="cab-badge cab-badge-pending" title="grid pending: asked again when the server is free">grade pendente</span>` : "",
      r.grid && r.grid.reliable === false ? `<span class="cab-badge cab-badge-warn" title="beats too irregular: sync and quantize off">no sync</span>` : "",
      !r.onServer && state.server ? `<span class="cab-badge">phone only</span>` : "",
    ].join("");
    let actions;
    if (prog) {
      const pct = prog.total ? Math.round((prog.loaded / prog.total) * 100) : null;
      const label = prog.phase === "audio" ? `levando ${pct !== null ? pct + "%" : ""}` : "levando";
      actions = `<span class="cab-carrying">${esc(label)}</span>`;
    } else if (r.onPhone) {
      actions = `<button type="button" class="cab-btn cab-btn-quiet cab-grid-open"${r.grid ? "" : " disabled"}>grade</button>`
        + `<button type="button" class="cab-btn cab-btn-quiet cab-remove" title="remove from the phone">tirar</button>`;
    } else {
      actions = `<button type="button" class="cab-btn cab-btn-terra cab-carry" title="carry to the phone">levar</button>`;
    }
    const bar = prog ? `<div class="cab-progress"><span style="width:${prog.total ? Math.round((prog.loaded / prog.total) * 100) : 8}%"></span></div>` : "";
    return `<li class="cab-track${r.onPhone ? " cab-on-phone" : ""}" data-file="${esc(r.file)}">
      <div class="cab-track-main">
        <b class="cab-track-title">${esc(r.title)}</b>
        <span class="cab-track-sub">${sub}</span>
        <span class="cab-badges">${badges}</span>
      </div>
      <div class="cab-track-actions">${actions}</div>
      ${bar}
    </li>`;
  }

  function visibleRows() {
    const rows = mergeLibrary(state.server, state.carried);
    const f = state.filter.trim().toLowerCase();
    return rows.filter((r) => (!state.onlyPhone || r.onPhone)
      && (!f || `${r.title} ${r.file} ${r.folder}`.toLowerCase().includes(f)));
  }

  function renderTracks() {
    const rows = visibleRows();
    $("#cab-offline").hidden = state.server !== null || state.locked;
    $("#cab-locked").hidden = !state.locked;
    $("#cab-lib-count").textContent = `${rows.length} ${rows.length === 1 ? "track" : "tracks"}`;
    $("#cab-tracks").innerHTML = rows.length ? rows.map(rowHtml).join("")
      : `<li class="cab-empty">${state.onlyPhone ? "Nothing on the phone yet. Tap levar on a track to carry it." : "No tracks match."}</li>`;
  }

  function rowFor(file) {
    return mergeLibrary(state.server, state.carried).find((r) => r.file === file);
  }

  async function carry(file) {
    const r = rowFor(file);
    state.progress.set(file, { phase: "audio", loaded: 0, total: r && r.bytes });
    renderTracks();
    try {
      const done = sync.carry(file, (p) => {
        if (p.phase === "audio") state.progress.set(file, p);
        if (p.phase === "stored") {
          state.progress.delete(file);
          reloadCarried();
        }
        if (p.phase === "audio") renderTracks();
      }, r && r.onServer ? r.meta : null);
      await done;
    } catch (e) {
      state.progress.delete(file);
      flashJob(`could not carry ${file}: ${e.message}`, "fail");
    }
    state.progress.delete(file);
    await reloadCarried();
  }

  $("#cab-tracks").addEventListener("click", async (ev) => {
    const li = ev.target.closest(".cab-track");
    if (!li) return;
    const file = li.dataset.file;
    if (ev.target.closest(".cab-carry")) carry(file);
    else if (ev.target.closest(".cab-remove")) {
      await sync.uncarry(file);
      if (state.sheetFile === file) closeSheet();
      await reloadCarried();
    } else if (ev.target.closest(".cab-grid-open")) openSheet(file);
  });

  $("#cab-filter").addEventListener("input", (e) => { state.filter = e.target.value; renderTracks(); });
  $("#cab-only-phone").addEventListener("click", (e) => {
    state.onlyPhone = !state.onlyPhone;
    e.currentTarget.setAttribute("aria-pressed", String(state.onlyPhone));
    renderTracks();
  });

  // ---- jobs (pull, grid everything) -----------------------------------------------

  function flashJob(html, kind = "") {
    const box = $("#cab-job");
    box.hidden = false;
    box.className = `cab-job${kind ? ` cab-job-${kind}` : ""}`;
    box.innerHTML = html;
  }

  const lastLines = (log, n) => String(log || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-n);

  async function runJob(label, start) {
    if (state.busy) return;
    state.busy = true;
    $("#cab-grid-all").disabled = true;
    root.querySelectorAll(".cab-pull").forEach((b) => { b.disabled = true; });
    flashJob(`<b>${esc(label)}</b> <span class="cab-job-live">starting</span>`, "run");
    try {
      const job = await start((j) => {
        const live = $(".cab-job-live");
        if (live) live.textContent = lastLines(j.log, 1)[0] || "working";
      });
      if (job && job.status === "done") {
        flashJob(`<b>${esc(label)}: done</b> <span>${esc(lastLines(job.log, 1)[0] || "")}</span>`, "ok");
      } else if (job) {
        const err = lastLines(job.log, 3).join(" / ").replace(/^ERROR:\s*/, "");
        flashJob(`<b>${esc(label)}: failed</b> <span>${esc(err)}</span>`, "fail");
      } else {
        flashJob(`<b>${esc(label)}</b> <span>still running on the server</span>`, "run");
      }
    } catch (e) {
      const msg = e.status === 409 ? "another job is running on the server, try again in a moment" : e.message;
      flashJob(`<b>${esc(label)}: not started</b> <span>${esc(msg)}</span>`, "fail");
    } finally {
      state.busy = false;
      if (alive) {
        $("#cab-grid-all").disabled = false;
        root.querySelectorAll(".cab-pull").forEach((b) => { b.disabled = false; });
        await loadLibrary();
      }
    }
  }

  $("#cab-grid-all").addEventListener("click", () =>
    runJob("grid everything", (onJob) => sync.gridAll(onJob)));

  // ---- search -----------------------------------------------------------------------

  function setTab(tab) {
    state.tab = tab;
    root.querySelectorAll(".cab-tab").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    });
  }

  function searchMsg(text) {
    const m = $("#cab-search-msg");
    m.hidden = !text;
    m.textContent = text || "";
  }

  function context(html) {
    const c = $("#cab-context");
    c.hidden = !html;
    c.innerHTML = html || "";
  }

  async function search() {
    const q = $("#cab-q").value.trim();
    if (!q) { searchMsg("Type an artist or a title first."); return; }
    $("#cab-results").innerHTML = "";
    searchMsg(`searching ${TABS.find(([k]) => k === state.tab)[1]}`);
    const path = { youtube: "/api/intake/youtube/search", soundcloud: "/api/intake/soundcloud/search",
      spotify: "/api/intake/spotify/search" }[state.tab];
    try {
      const d = await (await sync.api(`${path}?q=${encodeURIComponent(q)}`, { ask: true })).json();
      if (state.tab === "spotify") {
        state.lastSpotify = d.tracks || [];
        renderSpotify(state.lastSpotify);
      } else {
        renderUploads(state.tab === "youtube" ? d.videos || [] : d.tracks || []);
      }
    } catch (e) {
      searchMsg(`search failed: ${e.message}`);
    }
  }

  function renderUploads(items) {
    searchMsg(items.length ? "" : "Nothing found.");
    $("#cab-results").innerHTML = items.map((v, i) => `
      <li class="cab-result${v.too_long ? " cab-too-long" : ""}">
        <div class="cab-result-main">
          <b>${esc(v.title)}</b>
          <span>${esc(v.channel)} &middot; ${formatDuration(v.duration)}</span>
          ${v.too_long ? `<span class="cab-flag">that's a set, not a track</span>` : ""}
        </div>
        ${v.too_long ? "" : `<button type="button" class="cab-btn cab-btn-terra cab-pull" data-i="${i}"${state.busy ? " disabled" : ""}>pull</button>`}
      </li>`).join("");
    root.querySelectorAll("#cab-results .cab-pull").forEach((b) => b.addEventListener("click", () => {
      const v = items[Number(b.dataset.i)];
      runJob(`pulling ${v.title}`, (onJob) => sync.pull(v.url, onJob));
    }));
  }

  function renderSpotify(tracks) {
    context("");
    searchMsg(tracks.length ? "" : "Nothing found.");
    $("#cab-results").innerHTML = tracks.map((t, i) => `
      <li class="cab-result">
        <div class="cab-result-main">
          <b>${esc(t.title)}</b>
          <span>${esc(t.artist)} &middot; ${formatDuration((t.duration_ms || 0) / 1000)}</span>
        </div>
        <button type="button" class="cab-btn cab-btn-quiet cab-pick" data-i="${i}">pick the upload</button>
      </li>`).join("");
    root.querySelectorAll("#cab-results .cab-pick").forEach((b) => b.addEventListener("click", () => {
      const t = tracks[Number(b.dataset.i)];
      setTab("youtube");
      $("#cab-q").value = uploadQuery(t);
      context(`Pick the YouTube upload of <b>${esc(t.title)}</b> (${esc(String(t.artist || "").split(",")[0])}).`
        + ` <button type="button" class="cab-link" id="cab-back-spotify">back to Spotify</button>`);
      $("#cab-back-spotify").addEventListener("click", () => {
        setTab("spotify");
        renderSpotify(state.lastSpotify || []);
      });
      search();
    }));
  }

  root.querySelectorAll(".cab-tab").forEach((b) => b.addEventListener("click", () => {
    setTab(b.dataset.tab);
    context("");
    $("#cab-results").innerHTML = "";
    searchMsg("");
    if ($("#cab-q").value.trim()) search();
  }));
  $("#cab-search-form").addEventListener("submit", (e) => { e.preventDefault(); search(); });

  // ---- grid fix sheet -------------------------------------------------------------------

  let raf = 0;

  function sheetMsg(text, kind = "") {
    const m = $("#cab-sheet-msg");
    m.hidden = !text;
    m.className = `cab-msg${kind ? ` cab-msg-${kind}` : ""}`;
    m.textContent = text || "";
  }

  function renderSheetGrid() {
    const r = rowFor(state.sheetFile);
    if (!r) return;
    $("#cab-sheet-track").textContent = r.title;
    const g = r.grid;
    $("#cab-sheet-grid").innerHTML = g
      ? `<b>${formatBpm(g.bpm)} BPM</b> &middot; beat 1 at ${Number(g.downbeat_s).toFixed(3)} s${g.fixed ? " &middot; fixed by hand" : ""}`
      : "grade pendente: no grid yet";
    $("#cab-sheet").dataset.bpm = g ? String(g.bpm) : "";
    $("#cab-sheet").dataset.downbeat = g ? String(g.downbeat_s) : "";
  }

  function beatLights() {
    raf = 0;
    if (!state.sheetFile) return;
    const lights = root.querySelectorAll("#cab-beats i");
    const pos = preview.playing ? preview.heardPos() : null;
    const g = preview.track && preview.track.grid;
    const lit = pos !== null && g ? Math.floor(barPhaseAt(g, pos)) : -1;
    lights.forEach((el, i) => el.classList.toggle("cab-lit", i === lit));
    raf = requestAnimationFrame(beatLights);
  }

  function openSheet(file) {
    state.sheetFile = file;
    sheetMsg("");
    $("#cab-listen").textContent = "listen";
    $("#cab-beat1").disabled = true;
    renderSheetGrid();
    $("#cab-sheet").hidden = false;
    if (!raf) raf = requestAnimationFrame(beatLights);
  }

  function closeSheet() {
    state.sheetFile = null;
    $("#cab-sheet").hidden = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    preview.close();
  }

  async function applyFix(op, value) {
    const file = state.sheetFile;
    root.querySelectorAll("#cab-sheet [data-op], #cab-sheet [data-nudge], #cab-beat1").forEach((b) => { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
    sheetMsg("saving");
    try {
      const g = await sync.fixGrid(file, op, value);
      preview.setGrid(g);
      await reloadCarried();
      renderSheetGrid();
      sheetMsg(op === "downbeat" ? `beat 1 set at ${Number(g.downbeat_s).toFixed(3)} s` : "saved", "ok");
    } catch (e) {
      sheetMsg(e.status === 401 ? "the server asks for the PIN again" : `not saved: ${e.message}`, "fail");
    } finally {
      root.querySelectorAll("#cab-sheet [data-op], #cab-sheet [data-nudge], #cab-beat1").forEach((b) => {
        b.disabled = b.dataset.wasDisabled === "true";
      });
    }
  }

  root.querySelectorAll("#cab-sheet [data-op]").forEach((b) => b.addEventListener("click", () => applyFix(b.dataset.op)));
  root.querySelectorAll("#cab-sheet [data-nudge]").forEach((b) => b.addEventListener("click", () => applyFix("nudge", Number(b.dataset.nudge))));

  $("#cab-listen").addEventListener("click", async () => {
    const btn = $("#cab-listen");
    if (preview.playing) {
      preview.pause();
      btn.textContent = "listen";
      $("#cab-beat1").disabled = true;
      return;
    }
    btn.disabled = true;
    btn.textContent = "loading";
    try {
      await preview.start(state.sheetFile);
      btn.textContent = "pause";
      $("#cab-beat1").disabled = false;
      sheetMsg("");
    } catch (e) {
      btn.textContent = "listen";
      sheetMsg(`could not play: ${e.message}`, "fail");
    }
    btn.disabled = false;
  });

  // pointerdown, not click: the tap time is the touch, not the release
  $("#cab-beat1").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if ($("#cab-beat1").disabled || !preview.playing) return;
    const t = preview.tapTime();
    if (t === null) return;
    $("#cab-sheet").dataset.tapped = String(t);
    applyFix("downbeat", Math.round(t * 1e6) / 1e6);
  });

  $("#cab-sheet-done").addEventListener("click", closeSheet);
  $("#cab-sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });

  // ---- wiring ---------------------------------------------------------------------------

  $("#cab-to-board").addEventListener("click", () => onBoard());
  $("#cab-help").addEventListener("click", () => onHelp());
  $("#cab-pin-open").addEventListener("click", async () => {
    if (await sync.auth()) loadLibrary();
  });
  const off = sync.onchange(() => {
    if (alive) reloadCarried().then(() => { if (state.sheetFile) renderSheetGrid(); });
  });
  setTab("youtube");
  renderTracks();
  const ready = loadLibrary();

  return {
    ready,
    refresh: loadLibrary,
    refreshRecordings: () => renderRecordings(),
    destroy() {
      alive = false;
      off();
      closeSheet();
    },
  };
}
