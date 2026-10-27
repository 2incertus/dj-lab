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

import { openStore, storeSource } from "./store.js";
import { makeSync } from "./sync.js";
import { renderCrate } from "./ui/crate.js";
import { renderBoard } from "./ui/board.js";
import { makeDemoBindings } from "./ui/board-demo-bindings.js";
import { makeBindings } from "./ui/bindings.js";
import { Strip } from "./ui/strip.js";
import { createRig } from "./engine/rig.js";
import { loadTrack } from "./engine/loader.js";
import { CONTROLS } from "./flx4-map.js";

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
  boardLog: [],
  decksLoaded: () => !!app.engine && app.engine.decks.some((d) => d.state.loaded),
  showCrate,
  showBoard,
  startEngine,
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
  app.crate = renderCrate(root, { store: app.store, sync: app.sync, onBoard: showBoard });
  return app.crate.ready;
}

/** Make the engine (once). Call it inside a user gesture. */
function startEngine() {
  if (enginePromise) return enginePromise;
  if (navigator.audioSession) {
    try { navigator.audioSession.type = "playback"; } catch (e) { /* older Safari */ }
  }
  const ctx = new AudioContext({ latencyHint: "interactive" });
  ctx.resume().catch(() => {});
  enginePromise = createRig(ctx).then((rig) => {
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
  if (!strip || !strip.frame(now)) return;
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
  app.strip = new Strip(canvas, { store: app.store, reserveLeft: () => (caixa ? caixa.offsetWidth + 8 : 0) });
  if (app.engine) {
    app.strip.setEngine(app.engine);
    app.engine.decks.forEach((d, i) => { if (d.state.loaded && d.track) app.strip.setTrack(i, d.track); });
    matchWidgets(app.board, app.engine);
  }
  // the first touch anywhere on the board starts the audio (iOS: only in a gesture)
  app.board.el.addEventListener("pointerdown", () => { startEngine().catch(() => {}); }, { capture: true });
  raf = requestAnimationFrame(tick);
  return app.board;
}

function onOrientation() {
  // the board lays itself out on rotation (portrait shows its "turn sideways"
  // card); only an unloaded crate-to-board switch happens here
  if (landscape.matches && app.decksLoaded() && app.screen !== "board") showBoard();
}

async function boot() {
  app.store = await openStore();
  app.sync = makeSync({ store: app.store });
  app.store.persist();                          // ask once; Safari may say no until installed
  await showCrate();
  app.sync.refreshGrids().catch(() => {});
  window.addEventListener("online", () => {
    app.sync.refreshGrids().catch(() => {});
    if (app.crate) app.crate.refresh();
  });
  window.addEventListener("offline", () => { if (app.crate) app.crate.refresh(); });
  landscape.addEventListener("change", onOrientation);
}

app.ready = boot().catch((e) => {
  root.innerHTML = `<p class="cab-fatal">A Cabine could not open its storage: ${String(e && e.message || e)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</p>`;
  throw e;
});
