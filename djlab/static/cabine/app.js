// A Cabine: app entry. Opens the phone store, shows the crate (A Caixa) or
// the board, and keeps carried grids up to date.
//
// window.cabine = {store, sync, showCrate(), showBoard()} for later tasks.
// Portrait is always the crate; landscape shows the board once a deck has a
// track (Task 10), so with nothing loaded it stays on the crate too.

import { openStore } from "./store.js";
import { makeSync } from "./sync.js";
import { renderCrate } from "./ui/crate.js";

const root = document.getElementById("cab-root");
const landscape = window.matchMedia("(orientation: landscape)");

const app = {
  store: null,
  sync: null,
  screen: null,
  crate: null,
  decksLoaded: () => false,          // Task 10: true once a deck holds a track
  showCrate,
  showBoard,
};
window.cabine = app;

function leave() {
  if (app.crate) { app.crate.destroy(); app.crate = null; }
}

function showCrate() {
  leave();
  app.screen = "crate";
  root.dataset.screen = "crate";
  app.crate = renderCrate(root, { store: app.store, sync: app.sync, onBoard: showBoard });
  return app.crate.ready;
}

/** Placeholder until the board lands (Task 9). */
function showBoard() {
  leave();
  app.screen = "board";
  root.dataset.screen = "board";
  root.innerHTML = `
    <div class="cab-board-wait">
      <p class="cab-board-kicker">A Cabine</p>
      <h1 class="cab-board-h">${landscape.matches ? "The board is coming" : "Turn sideways"}</h1>
      <p class="cab-board-note">${landscape.matches
        ? "The FLX4 board is being built. Your carried tracks are safe on the phone."
        : "The board plays in landscape. Turn the phone on its side."}</p>
      <button type="button" class="cab-btn cab-btn-terra" id="cab-back-crate">back to A Caixa</button>
    </div>`;
  root.querySelector("#cab-back-crate").addEventListener("click", showCrate);
}

function onOrientation() {
  if (!landscape.matches) {
    if (app.screen === "board") showBoard();    // re-render: "turn sideways"
    return;
  }
  if (app.decksLoaded() && app.screen !== "board") showBoard();
  else if (app.screen === "board") showBoard();
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
