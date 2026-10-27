// A Cabine: app entry. Opens the phone store, shows the crate (A Caixa) or
// the board, keeps carried grids up to date, and binds the board to the
// audio engine (Task 10).
//
// window.cabine = {store, sync, showCrate(), showBoard(opts), board, strip,
//   engine, boardLog} for later tasks and the e2e tests.
// The crate works in both orientations. The board is landscape only: in
// portrait it shows its "turn sideways" card, with a way back to the crate.
// Rotating to landscape opens the board once a deck has a track.
//
// The engine (engine/rig.js) is made once, on the first touch on the board:
// navigator.audioSession.type = "playback" first (so the silent switch does
// not mute it on the iPhone), then the AudioContext inside that tap (iOS
// starts audio only from a gesture), then the two deck worklets, the mixer,
// Beat FX and the sampler. Actions from that first touch wait for it
// (ui/bindings.js). One requestAnimationFrame loop drives the strip (at most
// 30 fps), the board's lights and its meters.
//
// Task 11, the phone shell:
// - The service worker (/cabine/sw.js, scope /cabine) caches the shell, so
//   the installed app opens with no signal. The worklet module loads offline
//   too (engine/deck-voice.js falls back to its cached source as a blob URL).
// - The shell is public; any /api/ call that answers 401 is answered with
//   the in-app PIN card (ui/cards.js). Server actions on the crate wait for
//   it and run again; the board and carried tracks never do. An upload that
//   meets a 401 stays queued and the card shows on the crate (never over the
//   board); "later" quiets it until the phone comes back online.
// - REC on the strip: engine/recorder.js on mixer.masterTap. Finished takes
//   upload to O Arquivo (sync.drainUploads) on start, on `online`, every
//   60 s while online and right after a take ends.
// - Audio session and interruptions: if the context goes "interrupted" or
//   "suspended" while a deck plays or REC runs, the "tap to resume" veil
//   shows; the tap resumes the context, sets the audio session again and
//   takes the wake lock again. Any pointerup while the context is not
//   running also resumes it (a first tap whose resume did not take on iOS).
// - Screen: the wake lock is held while a deck plays or REC runs, taken
//   again on `visibilitychange`. Installed on Android, the first board tap
//   asks for fullscreen and a landscape lock (rejections ignored).
// - First run: the install card at the top of the crate (also behind "?").

import { openStore, storeSource } from "./store.js";
import { makeSync } from "./sync.js";
import { renderCrate } from "./ui/crate.js";
import { renderBoard } from "./ui/board.js";
import { makeDemoBindings } from "./ui/board-demo-bindings.js";
import { makeBindings } from "./ui/bindings.js";
import { Strip } from "./ui/strip.js";
import { createRig } from "./engine/rig.js";
import { workletLoads } from "./engine/deck-voice.js";
import { loadTrack } from "./engine/loader.js";
import { CONTROLS } from "./flx4-map.js";
import { Recorder } from "./engine/recorder.js";
import { makePinCard, installCard, installSeen, isInstalled, makeResumeVeil } from "./ui/cards.js";

export const UPLOAD_EVERY_MS = 60000;
export const AWAKE_CHECK_MS = 1000;

const root = document.getElementById("cab-root");
const landscape = window.matchMedia("(orientation: landscape)");

const app = {
  store: null,
  sync: null,
  screen: null,
  crate: null,
  board: null,
  strip: null,
  engine: null,
  bind: null,
  recorder: null,
  pin: null,
  veil: null,
  sw: { registered: false, error: null },
  wake: { held: false, requests: 0, releases: 0 },
  boardLog: [],
  decksLoaded: () => !!app.engine && app.engine.decks.some((d) => d.state.loaded),
  showCrate,
  showBoard,
  startEngine,
  toggleRec,
  showInstall,
  resumeAudio,
  expectsPlayback,
};
window.cabine = app;

let enginePromise = null;
let raf = null;
let meterShown = [-1, -1];

function leave() {
  if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  if (app.strip) { app.strip.destroy(); app.strip = null; }
  if (app.crate) { app.crate.destroy(); app.crate = null; }
  if (app.board) { app.board.destroy(); app.board = null; }
}

function showCrate() {
  leave();
  app.screen = "crate";
  root.dataset.screen = "crate";
  app.crate = renderCrate(root, { store: app.store, sync: app.sync, onBoard: showBoard, onHelp: showInstall });
  if (!installSeen()) showInstall();
  if (pinWanted) { pinWanted = false; needPin(); }
  return app.crate.ready;
}

/** The install and help card, at the top of the crate. */
function showInstall() {
  if (app.screen !== "crate") return;
  const crate = root.querySelector(".cab-crate");
  if (!crate) return;
  let card = crate.querySelector(".cab-install");
  if (!card) {
    card = installCard();
    crate.insertBefore(card, crate.querySelector(".cab-storage"));
  }
  if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
}

// ---- the PIN ----------------------------------------------------------------------

let pinWanted = false;          // a background 401 while the board was up
let pinSnoozed = false;         // "later": no card from background calls until back online

/** Interactive: a server action is waiting on the card. */
async function askPin() {
  const ok = await app.pin.ask();
  if (ok) { pinSnoozed = false; afterAuth(); }
  else pinSnoozed = true;
  return ok;
}

/** Background (an upload met a 401): the card, on the crate only. */
function needPin() {
  if (app.pin.isOpen || pinSnoozed) return;
  if (app.screen !== "crate") { pinWanted = true; return; }
  askPin();
}

function afterAuth() {
  drain();
  app.sync.refreshGrids().catch(() => {});
  if (app.crate) app.crate.refresh();
}

// ---- uploads ---------------------------------------------------------------------

function drain() {
  return app.sync.drainUploads()
    .catch(() => null)
    .then((r) => { if (app.crate) app.crate.refreshRecordings(); return r; });
}

// ---- REC ---------------------------------------------------------------------------

async function toggleRec() {
  let rig;
  try {
    rig = await startEngine();
  } catch (e) { return null; }
  if (!app.recorder) {
    app.recorder = new Recorder(rig.ctx, rig.mixer.masterTap, app.store, {
      onfinish: () => { drain(); },
    });
  }
  const rec = app.recorder;
  try {
    if (rec.state === "recording") {
      const id = await rec.stop();
      if (app.strip) app.strip.flash(0, "recording saved on the phone");
      return id;
    }
    const id = await rec.start();
    keepAwake();
    return id;
  } catch (e) {
    console.error("A Cabine: REC", e);
    if (app.strip) app.strip.flash(0, `cannot record: ${e.message || e}`);
    return null;
  }
}

// ---- audio session, interruptions, the screen ------------------------------------------

function setAudioSession() {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = "playback"; } catch (e) { /* older Safari */ }
  }
}

/** A deck plays or REC runs: what the veil and the wake lock care about. */
function expectsPlayback() {
  const e = app.engine;
  return !!((e && e.decks.some((d) => d.state.playing)) || (app.recorder && app.recorder.state === "recording"));
}

function onCtxState() {
  const ctx = app.engine ? app.engine.ctx : null;
  if (!ctx) return;
  if ((ctx.state === "interrupted" || ctx.state === "suspended") && expectsPlayback()) app.veil.show();
  else if (ctx.state === "running") app.veil.hide();
}

/** The veil's tap (and any tap while the context is not running). */
function resumeAudio() {
  const ctx = app.engine ? app.engine.ctx : (pendingCtx || null);
  setAudioSession();
  if (!ctx || ctx.state === "closed") return Promise.resolve();
  const p = ctx.state === "running" ? Promise.resolve() : ctx.resume();
  return p.then(() => {
    if (ctx.state === "running") app.veil.hide();
    keepAwake();
  }).catch(() => {});
}

let wakeSentinel = null;
let wakePending = false;

function keepAwake() {
  const wl = navigator.wakeLock;
  const want = expectsPlayback() && document.visibilityState === "visible";
  if (want && !wakeSentinel && !wakePending && wl && typeof wl.request === "function") {
    wakePending = true;
    app.wake.requests++;
    wl.request("screen").then((s) => {
      wakeSentinel = s;
      app.wake.held = true;
      s.addEventListener("release", () => {
        if (wakeSentinel === s) { wakeSentinel = null; app.wake.held = false; }
      });
      if (!expectsPlayback()) keepAwake();                 // stopped meanwhile
    }).catch(() => {}).finally(() => { wakePending = false; });
  } else if (!want && wakeSentinel && document.visibilityState === "visible") {
    const s = wakeSentinel;
    wakeSentinel = null;
    app.wake.held = false;
    app.wake.releases++;
    s.release().catch(() => {});
  }
}

let fullscreenAsked = false;

/** Installed on Android: fullscreen and landscape on the first board tap. */
function askFullscreen() {
  if (fullscreenAsked || !isInstalled()) return;
  fullscreenAsked = true;
  const el = document.documentElement;
  const lock = () => {
    const o = screen.orientation;
    if (o && typeof o.lock === "function") return o.lock("landscape").catch(() => {});
    return null;
  };
  if (!document.fullscreenElement && typeof el.requestFullscreen === "function") {
    el.requestFullscreen({ navigationUI: "hide" }).then(lock, () => {});
  } else {
    try { const p = lock(); if (p) p.catch(() => {}); } catch (e) { /* not on iOS */ }
  }
}

let pendingCtx = null;

/** Make the engine (once). Call it inside a user gesture. */
function startEngine() {
  if (enginePromise) return enginePromise;
  setAudioSession();                               // before the context: the silent switch
  const ctx = pendingCtx || new AudioContext({ latencyHint: "interactive" });
  pendingCtx = ctx;
  ctx.resume().catch(() => {});
  enginePromise = createRig(ctx).then((rig) => {
    pendingCtx = null;
    ctx.addEventListener("statechange", onCtxState);
    app.workletLoad = workletLoads.get(ctx) || null;      // "direct" or "blob" (offline WebKit)
    app.engine = rig;
    if (app.strip) app.strip.setEngine(rig);
    app.bind.flush();
    return rig;
  }).catch((e) => {
    enginePromise = null;
    console.error("A Cabine: the audio engine did not start", e);
    if (app.strip) app.strip.flash(0, "audio did not start: tap again");
    throw e;
  });
  return enginePromise;
}

function bindingsOnce() {
  if (app.bind) return app.bind;
  app.bind = makeBindings({
    getRig: () => app.engine,
    strip: () => app.strip,
    board: () => app.board,
    store: app.store,
    source: storeSource(app.store),
    loadTrack: (ctx, source, file) => loadTrack(ctx, source, file),
  });
  app.bind.onNeedEngine(() => { startEngine().catch(() => {}); });
  app.boardLog = app.bind.log;
  return app.bind;
}

/** A board drawn again over a running engine: widgets and latches follow it. */
function matchWidgets(board, rig) {
  const set = (id, v) => { const w = board.widget(id); if (w && typeof w.set === "function") w.set(v); };
  const m = rig.mixer.state;
  m.channels.forEach((ch, k) => {
    const n = k + 1;
    for (const b of ["trim", "hi", "mid", "low", "cfx", "fader"]) set(`ch${n}-${b}`, ch[b]);
    board.setLatch(`ch${n}-cue`, ch.cue);
  });
  set("xfader", m.crossfader);
  set("master-level", m.masterLevel);
  set("phones-mix", m.phonesMix);
  set("phones-level", m.phonesLevel);
  board.setLatch("master-cue", m.masterCue);
  set("fx-level", rig.fx.state.level);
  set("fx-ch", ["1", "2", "master"].indexOf(rig.fx.state.target));
  rig.decks.forEach((d, k) => set(`d${k + 1}-tempo`, d._fader));
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  const strip = app.strip;
  // portrait shows the "turn sideways" card: nothing to draw, no lights to set
  if (!strip || !app.board || app.board.el.classList.contains("cab-portrait")) return;
  const rec = app.recorder;
  strip.setRec(!!rec && rec.state === "recording", rec ? rec.elapsed() : 0);
  if (!strip.frame(now)) return;
  if (!app.engine || !app.board) return;
  app.bind.refreshLights();
  for (let c = 0; c < 2; c++) {
    const lv = Math.round(strip.meterLevel(c) * 5) / 5;          // five LEDs
    if (lv !== meterShown[c]) { meterShown[c] = lv; app.board.setLevel(`ch${c + 1}-meter`, lv); }
  }
  app.engine.fx.refresh();                                       // cheap when nothing changed
}

/** The FLX4 board over the engine. opts.layout: "spread" | "exact"
 *  (ui/board-layout.js, also ?board=exact); opts.demo: the Task 9 stand-in
 *  bindings (no audio; the board's own e2e tests use them). */
function showBoard(opts = {}) {
  leave();
  app.screen = "board";
  root.dataset.screen = "board";
  // "spread" by default; ?board=exact shows the panel at the photo's proportions
  const layout = opts.layout || new URLSearchParams(location.search).get("board") || undefined;
  if (opts.demo) {
    const demo = makeDemoBindings();
    app.board = renderBoard(root, CONTROLS, demo.bindings, {
      onCrate: () => showCrate(), onPadMode: demo.onPadMode, layout,
    });
    demo.attach(app.board);
    app.boardLog = demo.log;
    return app.board;
  }
  const bind = bindingsOnce();
  app.board = renderBoard(root, CONTROLS, bind.bindings, { onCrate: () => showCrate(), layout });
  app.boardLog = bind.log;
  bind.resetLights();
  meterShown = [-1, -1];
  const canvas = document.createElement("canvas");
  canvas.className = "cab-strip-canvas";
  canvas.setAttribute("aria-hidden", "true");
  app.board.stripSlot.appendChild(canvas);
  const caixa = app.board.el.querySelector(".cab-board-caixa");
  app.strip = new Strip(canvas, { store: app.store, reserveLeft: () => (caixa ? caixa.offsetWidth + 8 : 0),
    watch: caixa ? [caixa] : [] });
  if (app.engine) {
    app.strip.setEngine(app.engine);
    app.engine.decks.forEach((d, i) => { if (d.state.loaded && d.track) app.strip.setTrack(i, d.track); });
    matchWidgets(app.board, app.engine);
  }
  // the first touch anywhere on the board starts the audio (iOS: only in a gesture)
  app.board.el.addEventListener("pointerdown", () => { startEngine().catch(() => {}); }, { capture: true });
  // fullscreen needs user activation, which a touch only grants on its release
  app.board.el.addEventListener("pointerup", () => { askFullscreen(); }, { capture: true });
  app.strip.onRec(() => { toggleRec(); });
  raf = requestAnimationFrame(tick);
  return app.board;
}

function onOrientation() {
  // the board lays itself out on rotation (portrait shows its "turn sideways"
  // card); only an unloaded crate-to-board switch happens here
  if (landscape.matches && app.decksLoaded() && app.screen !== "board") showBoard();
}

function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/cabine/sw.js", { scope: "/cabine" })
    .then(() => { app.sw.registered = true; })
    .catch((e) => { app.sw.error = String(e && e.message || e); });
}

async function boot() {
  registerWorker();
  app.pin = makePinCard();
  app.veil = makeResumeVeil(() => { resumeAudio(); });
  app.store = await openStore();
  app.sync = makeSync({ store: app.store, onAuth: askPin, onLocked: needPin });
  app.store.persist();                          // ask once; Safari may say no until installed
  // a recording a crash (or a closed tab) left open: keep what was flushed
  await app.store.finishStale(new Set()).catch(() => []);
  await showCrate();
  app.sync.refreshGrids().catch(() => {});
  drain();
  setInterval(() => { if (navigator.onLine !== false) drain(); }, UPLOAD_EVERY_MS);
  window.addEventListener("online", () => {
    pinSnoozed = false;
    app.sync.refreshGrids().catch(() => {});
    drain();
    if (app.crate) app.crate.refresh();
  });
  window.addEventListener("offline", () => { if (app.crate) app.crate.refresh(); });
  landscape.addEventListener("change", onOrientation);
  // iOS: a first tap whose resume did not take, or a context the system
  // suspended: any later tap tries again
  document.addEventListener("pointerup", () => {
    const ctx = app.engine ? app.engine.ctx : pendingCtx;
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") resumeAudio();
  }, { capture: true });
  document.addEventListener("visibilitychange", () => keepAwake());
  setInterval(keepAwake, AWAKE_CHECK_MS);
}

app.ready = boot().catch((e) => {
  root.innerHTML = `<p class="cab-fatal">A Cabine could not open its storage: ${String(e && e.message || e)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</p>`;
  throw e;
});
