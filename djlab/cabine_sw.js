// A Cabine service worker, served at /cabine/sw.js with
// Service-Worker-Allowed: /cabine, registered with scope "/cabine".
//
// Offline-first shell: on install it caches every file the app needs to
// open with no signal (PRECACHE) under "cabine-v<VERSION>"; on activate it
// drops older cabine-v caches.
//   - navigations to /cabine (any query) get the cached static shell
//     (/static/cabine/cabine.html), cache first, so the installed app opens
//     on a train with no signal and never waits on a slow network
//   - /static/cabine/**, the fonts, the icons and the manifest: cache first,
//     network as the fallback
//   - /api/*, /audio/* and /cabine/proof: never touched here (network only;
//     carried tracks live in IndexedDB, not in this cache)
//
// Bump VERSION on every client change, and set SHELL_HASH to what
// tests/test_cabine_sw.py prints: the test fails until both move, so an
// installed phone always gets the new shell.

const VERSION = 2;
const SHELL_HASH = "519f6aa9c9a47c37";
const CACHE = `cabine-v${VERSION}`;
const SHELL = "/static/cabine/cabine.html";

const PRECACHE = [
  "/static/cabine/cabine.html",
  "/static/cabine/app.js",
  "/static/cabine/cabine.css",
  "/static/cabine/engine/deck-processor.js",
  "/static/cabine/engine/deck-voice.js",
  "/static/cabine/engine/deck.js",
  "/static/cabine/engine/fx.js",
  "/static/cabine/engine/grid.js",
  "/static/cabine/engine/loader.js",
  "/static/cabine/engine/mixer.js",
  "/static/cabine/engine/recorder.js",
  "/static/cabine/engine/rig.js",
  "/static/cabine/engine/sampler.js",
  "/static/cabine/flx4-map.js",
  "/static/cabine/fonts/archivo-latin.woff2",
  "/static/cabine/fonts/fraunces-latin.woff2",
  "/static/cabine/store.js",
  "/static/cabine/sync.js",
  "/static/cabine/ui/bindings.js",
  "/static/cabine/ui/board-demo-bindings.js",
  "/static/cabine/ui/board-layout.js",
  "/static/cabine/ui/board.js",
  "/static/cabine/ui/cards.js",
  "/static/cabine/ui/controls.js",
  "/static/cabine/ui/crate-model.js",
  "/static/cabine/ui/crate.js",
  "/static/cabine/ui/preview.js",
  "/static/cabine/ui/strip.js",
  "/cabine/manifest.webmanifest",
  "/static/apple-touch-icon.png?v=3",
  "/static/icon-180.png?v=3",
  "/static/icon-192.png?v=3",
  "/static/icon-512.png?v=3",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // fetch fresh copies, not whatever the HTTP cache holds from an older shell
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("cabine-v") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const isShellNav = (req, url) => req.mode === "navigate" && url.pathname === "/cabine";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/audio/")) return;
  if (isShellNav(req, url)) {
    event.respondWith((async () => {
      const hit = await caches.match(SHELL, { cacheName: CACHE });
      return hit || fetch(req);
    })());
    return;
  }
  if (!PRECACHE.includes(url.pathname + url.search)) return;
  event.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: CACHE });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  })());
});

// the page asks which shell it runs (tests, and a look on the phone)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "version" && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION, cache: CACHE, hash: SHELL_HASH });
  }
});
