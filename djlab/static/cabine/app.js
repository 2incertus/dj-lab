// A Cabine: app entry. Opens the phone store, shows the crate (A Caixa) or
// the board, and keeps carried grids up to date.
//
// window.cabine = {store, sync, showCrate(), showBoard(), board} for later tasks.
// The crate works in both orientations. The board is landscape only: in
// portrait it shows its "turn sideways" card, with a way back to the crate.
// Rotating to landscape opens the board once a deck has a track (Task 10).

import { openStore } from "./store.js";
import { makeSync } from "./sync.js";
import { renderCrate } from "./ui/crate.js";
import { renderBoard } from "./ui/board.js";
import { makeDemoBindings } from "./ui/board-demo-bindings.js";
import { CONTROLS } from "./flx4-map.js";

const root = document.getElementById("cab-root");
const landscape = window.matchMedia("(orientation: landscape)");

const app = {
  store: null,
  sync: null,
  screen: null,
  crate: null,
  board: null,
  decksLoaded: () => false,          // Task 10: true once a deck holds a track
  showCrate,
  showBoard,
};
window.cabine = app;

function leave() {
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

/** The FLX4 board. Until Task 10 binds the engine it runs on the demo
 *  bindings (every action logged in app.boardLog, the obvious lights follow). */
function showBoard() {
  leave();
  app.screen = "board";
  root.dataset.screen = "board";
  const demo = makeDemoBindings();
  app.board = renderBoard(root, CONTROLS, demo.bindings, {
    onCrate: () => showCrate(),
    onPadMode: demo.onPadMode,
  });
  demo.attach(app.board);
  app.boardLog = demo.log;
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
