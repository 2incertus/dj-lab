"""A Cabine on a train (Task 11): the offline shell, the in-app PIN card, the
recorder and the upload queue, and the interruption veil.

Chromium only (ruling R8): Playwright drives service workers there, and
context.set_offline(True) cuts the page and its worker. Every offline test
first lets the worker install and take the page, then goes offline and
reloads, as the installed app does when it opens with no signal.

The PIN itself is never known to the tests (only its hash is, read at test
time): where the card is filled in, /auth is answered by a route that sets
the same dj_auth cookie the server would.
"""

import json
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = Path.home() / "config" / "dj-lab.env"


def _pin_hash() -> str:
    for line in ENV_FILE.read_text().splitlines():
        key, sep, val = line.strip().partition("=")
        if sep and key == "PIN_HASH":
            return val.strip().strip('"').strip("'")
    return ""

pytestmark = pytest.mark.usefixtures("play_tracks")

EXPORTS = ROOT / "renders" / "sessoes"
SHOTS = Path.home() / "cabine-shots" / "task11"


# ---- helpers ----------------------------------------------------------------------------

def _phone(chromium, auth_cookie=None, init=None):
    ctx = chromium.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=3,
                               is_mobile=True, has_touch=True)
    if auth_cookie:
        ctx.add_cookies([auth_cookie])
    # the install card is checked in its own test; elsewhere it has been seen
    ctx.add_init_script("try { localStorage.setItem('cabine_install_seen', '1'); } catch (e) {}")
    ctx.add_init_script(GOERTZEL)
    if init:
        ctx.add_init_script(init)
    return ctx


def _boot(ctx, base_url, carry=()):
    """/cabine with `carry` on the phone and the service worker in control."""
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.goto(f"{base_url}/cabine")
    page.evaluate("() => window.cabine.ready")
    for f in carry:
        page.evaluate("async (f) => { await window.cabine.sync.carry(f); }", f)
    page.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=30_000)
    page.wait_for_function("""async () => { const ks = await caches.keys();
        return ks.some(k => k.startsWith('cabine-v')); }""", timeout=30_000)
    return page


def _offline_reload(ctx, page):
    ctx.set_offline(True)
    resp = page.reload()
    assert resp is not None and resp.from_service_worker, "the shell came from the service worker"
    page.evaluate("() => window.cabine.ready")
    assert page.evaluate("() => fetch('/health').then(() => 'online', () => 'offline')") == "offline"
    return resp


def rects(page):
    return page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.cab-board .cab-board-ctl')]
        .map(el => { const r = el.getBoundingClientRect();
                     return [el.dataset.id, {cx: r.left + r.width / 2, cy: r.top + r.height / 2}]; }))""")


def tap(page, r, cid):
    page.touchscreen.tap(r[cid]["cx"], r[cid]["cy"])


def board(page):
    page.evaluate("() => window.cabine.showBoard()")
    page.wait_for_selector(".cab-board .cab-board-ctl", state="attached")
    return rects(page)


def load(page, r, deck, file):
    """BROWSE (the first touch also starts the engine), highlight `file`, LOAD."""
    if not page.evaluate("() => !!window.cabine.strip && window.cabine.strip.isBrowseOpen"):
        tap(page, r, "browse")
    page.wait_for_function("() => window.cabine.engine && window.cabine.strip.isBrowseOpen", timeout=20_000)
    page.evaluate("() => window.cabine.strip.refreshTracks()")      # the list settles first
    page.evaluate("""(f) => { const s = window.cabine.strip; s.browseMove(-999);
        for (let i = 0; i < 99 && s.highlighted() !== f; i++) s.browseMove(1); }""", file)
    assert page.evaluate("() => window.cabine.strip.highlighted()") == file
    tap(page, r, f"load{deck + 1}")
    page.wait_for_function("""([d, f]) => { const e = window.cabine.engine;
        return e && e.decks[d].state.loaded && e.decks[d].track && e.decks[d].track.file === f; }""",
                           arg=[deck, file], timeout=30_000)


def wait_true(page, js, arg=None, timeout=30.0):
    """Poll an async page function until it resolves truthy (wait_for_function
    takes a returned Promise itself as truthy)."""
    end = time.time() + timeout
    while True:
        if page.evaluate(js, arg):
            return
        if time.time() > end:
            raise AssertionError(f"timed out waiting for: {js}")
        time.sleep(0.25)


UPLOADED = "async (id) => { const r = (await window.cabine.store.listRecordings()).find(x => x.id === id); return !!(r && r.uploaded); }"


def rec_tap(page):
    b = page.locator(".cab-strip-rec").bounding_box()
    page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


LEVELS = """async ([node, freqs, ms, channel]) => {
  const rig = window.cabine.engine, ctx = rig.ctx;
  const src = node === 'master' ? rig.mixer.masterTap : rig.mixer.output;
  const split = ctx.createChannelSplitter(2);
  const an = ctx.createAnalyser();
  an.fftSize = 32768; an.smoothingTimeConstant = 0;
  src.connect(split); split.connect(an, channel);
  await new Promise((r) => setTimeout(r, ms));
  const a = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(a);
  src.disconnect(split);
  return window.__goertzel(a, ctx.sampleRate, freqs);
}"""

GOERTZEL = """
window.__goertzel = (a, sr, freqs) => {
  const n = a.length, out = {};
  for (const hz of freqs) {
    let re = 0, im = 0, wsum = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      const ph = 2 * Math.PI * hz * i / sr;
      re += a[i] * w * Math.cos(ph); im -= a[i] * w * Math.sin(ph); wsum += w;
    }
    const amp = 2 * Math.sqrt(re * re + im * im) / wsum;
    out[hz] = amp > 0 ? 20 * Math.log10(amp) : -400;
  }
  return out;
};
"""


def levels(page, freqs, node="master", channel=0, ms=900):
    res = page.evaluate(LEVELS, [node, freqs, ms, channel])
    return {float(k): v for k, v in res.items()}


def _exports_for(rec_id):
    """Exports whose .cid sidecar is exactly this recording id."""
    if not EXPORTS.exists():
        return []
    out = []
    for side in EXPORTS.glob("*.cid"):
        try:
            if side.read_text().strip() == rec_id:
                out.append(side.name[:-len(".cid")])
        except OSError:
            pass
    return out


def _recordings(page):
    return page.evaluate("""async () => (await window.cabine.store.listRecordings())
        .map(r => ({id: r.id, done: r.done, uploaded: r.uploaded, file: r.file || null,
                    durationS: r.durationS, mime: r.mime, chunks: r.chunks}))""")


@pytest.fixture
def cleanup_exports(api):
    made = []
    yield made
    for f in made:
        api.delete(f"/api/mesa/export/{f}")


# ---- the shell ---------------------------------------------------------------------------

def test_shell_loads_offline(chromium, base_url, auth_cookie, play_tracks):
    """Visit, go offline, reload: the board renders, the AudioContext starts,
    the worklet module loads and a carried track plays, with no network."""
    a = play_tracks["tone_a"]
    ctx = _phone(chromium, auth_cookie)
    try:
        page = _boot(ctx, base_url, carry=(a,))
        _offline_reload(ctx, page)
        assert page.evaluate("() => window.cabine.screen") == "crate"
        assert page.locator(f'.cab-track[data-file="{a}"].cab-on-phone').count() == 1
        # the self-hosted fonts came from the cache too
        assert page.evaluate("async () => { await document.fonts.ready; return document.fonts.check('600 14px Archivo') && document.fonts.check('900 40px Fraunces'); }")
        r = board(page)
        load(page, r, 0, a)
        assert page.evaluate("() => window.cabine.engine.ctx.state") == "running"
        assert page.evaluate("() => window.cabine.workletLoad") in ("direct", "blob")
        tap(page, r, "d1-play")
        page.wait_for_function("() => window.cabine.engine.decks[0].state.playing")
        lv = levels(page, [110.0])
        print(f"\noffline master 110 Hz: {lv[110.0]:.1f} dBFS, worklet {page.evaluate('() => window.cabine.workletLoad')}")
        assert lv[110.0] > -40, "the carried track plays offline"
        assert page.evaluate("() => window.cabine.engine.underruns()") == 0
        assert page.locator(".cab-pin").count() == 0
        assert page.errors == []
    finally:
        ctx.close()


def test_worklet_falls_back_to_the_cached_source_offline(chromium, base_url, auth_cookie, play_tracks):
    """WebKit's addModule may skip the service worker: with the direct load
    refused, the module still loads from the cached source as a blob URL."""
    refuse = """(() => {
      const add = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = function (url, o) {
        if (!String(url).startsWith('blob:')) return Promise.reject(new DOMException('bypassed the worker', 'AbortError'));
        return add.call(this, url, o);
      };
    })();"""
    a = play_tracks["tone_a"]
    ctx = _phone(chromium, auth_cookie, init=refuse)
    try:
        page = _boot(ctx, base_url, carry=(a,))
        _offline_reload(ctx, page)
        r = board(page)
        load(page, r, 0, a)
        assert page.evaluate("() => window.cabine.workletLoad") == "blob"
        tap(page, r, "d1-play")
        page.wait_for_function("() => window.cabine.engine.decks[0].state.playing")
        assert levels(page, [110.0])[110.0] > -40
        assert page.errors == []
    finally:
        ctx.close()


def test_shell_loads_offline_with_no_cookie(chromium, base_url, auth_cookie, play_tracks):
    """A fresh home-screen install has no cookie: offline the board and the
    carried tracks work and no PIN card shows; back online, the crate lists
    what the phone holds and offers the PIN, and only a server action (a
    search) opens the card."""
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    ctx = _phone(chromium, auth_cookie)
    try:
        page = _boot(ctx, base_url, carry=(a, b))
        ctx.clear_cookies()
        _offline_reload(ctx, page)
        assert page.locator(".cab-track.cab-on-phone").count() >= 2
        r = board(page)
        load(page, r, 0, a)
        load(page, r, 1, b)
        tap(page, r, "d1-play")
        tap(page, r, "d2-play")
        page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
        assert levels(page, [110.0])[110.0] > -40
        assert page.locator(".cab-pin").count() == 0
        page.evaluate("() => window.cabine.showCrate()")
        assert page.locator(".cab-pin").count() == 0

        # online again, still no cookie: listing never asks, it offers the PIN
        ctx.set_offline(False)
        page.evaluate("() => window.cabine.crate.refresh()")
        page.wait_for_selector("#cab-locked", state="visible")
        assert page.locator(f'.cab-track[data-file="{a}"].cab-on-phone').count() == 1
        page.wait_for_timeout(500)
        assert page.locator(".cab-pin").count() == 0, "no card until he asks the server for something"
        # a server action: the card
        page.fill("#cab-q", "tool")
        page.click("#cab-search-form button[type=submit]")
        page.wait_for_selector(".cab-pin", state="visible")
        assert page.evaluate("() => window.cabine.engine.decks.every(d => d.state.playing)"), \
            "the decks never stopped for the card"
        # the right PIN: the search runs again and finds the fixture uploads
        hash_ = _pin_hash()
        ctx.route("**/auth", lambda route: route.fulfill(
            status=200, content_type="application/json", body='{"ok": true, "next": "/"}',
            headers={"Set-Cookie": f"dj_auth={hash_}; Path=/; HttpOnly; SameSite=Lax"}))
        page.fill(".cab-pin-input", "0000")
        page.wait_for_selector(".cab-pin", state="detached")
        page.wait_for_selector("#cab-results .cab-result", timeout=15_000)
        page.wait_for_selector("#cab-locked", state="hidden")
        assert page.errors == []
    finally:
        ctx.close()


def test_install_card_first_run_and_help(chromium, base_url, auth_cookie):
    ctx = chromium.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_cookies([auth_cookie])
    try:
        page = ctx.new_page()
        page.goto(f"{base_url}/cabine")
        page.evaluate("() => window.cabine.ready")
        card = page.locator(".cab-install")
        card.wait_for(state="visible")
        text = card.inner_text()
        assert "Share, then Add to Home Screen" in text
        assert "Chrome menu, Add to Home screen" in text
        assert "Bluetooth headphones lag a little; wired is tighter for jog and pads." in text
        assert "\u2014" not in text, "no em dashes in the copy"
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / "install-card-390x844.png"))
        page.click(".cab-install [data-install=close]")
        assert card.count() == 0
        assert page.evaluate("() => localStorage.getItem('cabine_install_seen')") == "1"
        page.reload()
        page.evaluate("() => window.cabine.ready")
        assert page.locator(".cab-install").count() == 0
        page.click("#cab-help")
        page.locator(".cab-install").wait_for(state="visible")
    finally:
        ctx.close()


# ---- recording ----------------------------------------------------------------------------

def test_offline_ride_records_and_uploads_later(chromium, base_url, auth_cookie, play_tracks, api,
                                                cleanup_exports, authed_context):
    """Carry two, go offline, play both for 60 s with REC, stop, come back
    online: within 70 s O Arquivo lists the cabine take, 60 +- 2 s long, and
    it plays from the mesa."""
    a, b = play_tracks["click128_130"], play_tracks["click131"]
    ctx = _phone(chromium, auth_cookie)
    try:
        page = _boot(ctx, base_url, carry=(a, b))
        _offline_reload(ctx, page)
        r = board(page)
        load(page, r, 0, a)
        load(page, r, 1, b)
        tap(page, r, "d1-play")
        tap(page, r, "d2-play")
        page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
        rec_tap(page)
        page.wait_for_function("() => window.cabine.recorder && window.cabine.recorder.state === 'recording'")
        page.wait_for_timeout(2500)
        btn = page.locator(".cab-strip-rec")
        assert "cab-on" in btn.get_attribute("class")
        assert btn.inner_text().strip() in ("00:02", "00:03")
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / "rec-on-844x390.png"))
        page.wait_for_function("() => window.cabine.recorder.elapsed() >= 60", timeout=70_000, polling=200)
        rec_tap(page)
        page.wait_for_function("() => window.cabine.recorder.state === 'inactive'")
        page.wait_for_function("() => document.querySelector('.cab-strip-rec').textContent === 'REC'")
        recs = [x for x in _recordings(page) if x["done"]]
        assert len(recs) == 1, recs
        take = recs[0]
        assert take["uploaded"] is False and take["mime"].startswith("audio/webm")
        assert abs(take["durationS"] - 60) < 1.5
        assert _exports_for(take["id"]) == [], "nothing reached the server while offline"
        page.evaluate("() => window.cabine.showCrate()")
        page.wait_for_selector(f'.cab-rec-row[data-rec="{take["id"]}"]')
        assert "waiting to upload" in page.locator(f'.cab-rec-row[data-rec="{take["id"]}"]').inner_text()

        # signal again
        t0 = time.time()
        ctx.set_offline(False)
        page.evaluate("() => window.dispatchEvent(new Event('online'))")
        made = None
        while time.time() - t0 < 70:
            files = _exports_for(take["id"])
            if files:
                made = files[0]
                break
            time.sleep(1)
        assert made, "the take reached O Arquivo within 70 s"
        cleanup_exports.append(made)
        print(f"\nuploaded {made} after {time.time() - t0:.1f} s")
        assert made.startswith("cabine-") and made.endswith(".m4a")
        listing = {x["file"]: x for x in api.get("/api/mesa/exports").json()}
        assert abs(listing[made]["dur"] - 60) <= 2, listing[made]
        wait_true(page, UPLOADED, take["id"])
        page.wait_for_function(f"""() => {{ const row = document.querySelector('.cab-rec-row[data-rec="{take["id"]}"]');
            return row && row.textContent.includes('in O Arquivo'); }}""")

        # it plays on /mesa
        mesa = authed_context.new_page()
        mesa.add_init_script("""(() => { const A = window.Audio; window.__audios = [];
            window.Audio = function (...a) { const x = new A(...a); window.__audios.push(x); return x; };
            window.Audio.prototype = A.prototype; })();""")
        mesa.goto(f"{base_url}/mesa")
        btn = mesa.locator(f'[data-arq-play="{made}"]')
        btn.wait_for(state="visible", timeout=15_000)
        btn.click()
        mesa.wait_for_function("""f => (window.__audios || []).some(a =>
            a.src.endsWith('/api/mesa/export/' + encodeURIComponent(f)) && !a.paused && a.currentTime > 0.5)""",
                               arg=made, timeout=15_000)
        btn.click()
        mesa.close()
        assert page.errors == []
    finally:
        ctx.close()


def test_webm_upload_is_stored_as_m4a(api, tmp_path, cleanup_exports):
    """What the Galaxy uploads (WebM/Opus) lands in O Arquivo as M4A (AAC)."""
    webm = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                           "-ac", "2", "-c:a", "libopus", "-f", "webm", "pipe:1"],
                          check=True, capture_output=True).stdout
    cid = f"e2e-webm-{int(time.time())}"
    r = api.post(f"/api/mesa/export?name=cabine&client_id={cid}", data=webm,
                 headers={"Content-Type": "audio/webm"})
    assert r.ok, r.text()
    f = r.json()["file"]
    cleanup_exports.append(f)
    assert f.startswith("cabine-") and f.endswith(".m4a")
    g = api.get(f"/api/mesa/export/{f}")
    assert g.headers["content-type"] == "audio/mp4"
    assert g.body()[4:8] == b"ftyp"
    out = tmp_path / "x.m4a"
    out.write_bytes(g.body())
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name:format=duration",
                                       "-of", "json", str(out)], check=True, capture_output=True, text=True).stdout)
    assert probe["streams"][0]["codec_name"] == "aac"
    assert abs(float(probe["format"]["duration"]) - 3.0) < 0.15
    listing = {x["file"]: x for x in api.get("/api/mesa/exports").json()}
    assert abs(listing[f]["dur"] - 3.0) < 0.2
    again = api.post(f"/api/mesa/export?name=cabine&client_id={cid}", data=webm,
                     headers={"Content-Type": "audio/webm"})
    assert again.json() == {"file": f}


def test_upload_queue_survives_401(chromium, base_url, auth_cookie, play_tracks, cleanup_exports):
    """The cookie is gone when the phone comes back online: the take stays
    queued and the PIN card shows on the crate; after the PIN it uploads,
    exactly once."""
    a = play_tracks["tone_a"]
    ctx = _phone(chromium, auth_cookie)
    posts = []
    ctx.on("response", lambda resp: posts.append(resp.status)
           if "/api/mesa/export?name=cabine" in resp.url and resp.request.method == "POST" else None)
    try:
        page = _boot(ctx, base_url, carry=(a,))
        _offline_reload(ctx, page)
        r = board(page)
        load(page, r, 0, a)
        tap(page, r, "d1-play")
        rec_tap(page)
        page.wait_for_function("() => window.cabine.recorder && window.cabine.recorder.elapsed() >= 5", polling=200)
        rec_tap(page)
        page.wait_for_function("() => window.cabine.recorder.state === 'inactive'")
        take = [x for x in _recordings(page) if x["done"]][0]

        ctx.clear_cookies()
        # online while the board is up: the card waits for the crate
        ctx.set_offline(False)
        page.evaluate("() => window.dispatchEvent(new Event('online'))")
        wait_true(page, "async () => (await window.cabine.sync.drainUploads()).locked")
        assert page.locator(".cab-pin").count() == 0, "never over the board"
        page.evaluate("() => window.cabine.showCrate()")
        page.wait_for_selector(".cab-pin", state="visible")
        assert 401 in posts and not any(200 <= s < 300 for s in posts)
        assert _exports_for(take["id"]) == []
        assert [x["uploaded"] for x in _recordings(page) if x["id"] == take["id"]] == [False]
        assert "waiting to upload" in page.locator(f'.cab-rec-row[data-rec="{take["id"]}"]').inner_text()

        hash_ = _pin_hash()
        ctx.route("**/auth", lambda route: route.fulfill(
            status=200, content_type="application/json", body='{"ok": true, "next": "/"}',
            headers={"Set-Cookie": f"dj_auth={hash_}; Path=/; HttpOnly; SameSite=Lax"}))
        page.fill(".cab-pin-input", "0000")
        page.wait_for_selector(".cab-pin", state="detached")
        wait_true(page, UPLOADED, take["id"])
        files = _exports_for(take["id"])
        cleanup_exports.extend(files)
        assert len(files) == 1, json.dumps([files, posts, _recordings(page)])
        # more drains (the 60 s timer, another online) send nothing more
        page.evaluate("() => window.cabine.sync.drainUploads()")
        page.evaluate("() => window.dispatchEvent(new Event('online'))")
        page.wait_for_timeout(1500)
        assert len([s for s in posts if 200 <= s < 300]) == 1, posts
        assert len(_exports_for(take["id"])) == 1
        assert page.errors == []
    finally:
        ctx.close()


def test_recording_is_master_only(chromium, base_url, auth_cookie, play_tracks):
    """Deck 1 (110 Hz) on the master, deck 2 (70 Hz + 2 kHz) on the
    headphones only (fader down, CUE on): the recording holds deck 1 and
    none of deck 2, while the headphones do carry deck 2."""
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    ctx = _phone(chromium, auth_cookie)
    # the take is read back from the phone; it never needs to reach O Arquivo
    ctx.route("**/api/mesa/export?**", lambda route: route.abort())
    try:
        page = _boot(ctx, base_url, carry=(a, b))
        r = board(page)
        load(page, r, 0, a)
        load(page, r, 1, b)
        page.evaluate("""() => { const m = window.cabine.engine.mixer;
            m.setFader(2, 0); m.setCue(2, true); m.setPhonesMix(0); m.setPhonesLevel(1); }""")
        tap(page, r, "d1-play")
        tap(page, r, "d2-play")
        page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
        phones = levels(page, [70.0, 2000.0], node="output", channel=0)
        print(f"\nheadphones (left): {phones}")
        assert phones[70.0] > -45 and phones[2000.0] > -45, "deck 2 is on the headphones"
        rec_tap(page)
        page.wait_for_function("() => window.cabine.recorder && window.cabine.recorder.elapsed() >= 4", polling=100)
        rec_tap(page)
        page.wait_for_function("() => window.cabine.recorder.state === 'inactive'")
        take = [x for x in _recordings(page) if x["done"]][0]
        got = page.evaluate("""async (id) => {
            const blob = await window.cabine.store.recordingBlob(id);
            const buf = await blob.arrayBuffer();
            const ac = new OfflineAudioContext(2, 1, 48000);
            const ab = await ac.decodeAudioData(buf);
            const ch = ab.getChannelData(0);
            const n = 32768, start = Math.floor(ab.sampleRate * 1.0);
            const a = ch.slice(start, start + n);
            return window.__goertzel(a, ab.sampleRate, [110, 70, 2000]);
        }""", take["id"])
        got = {float(k): v for k, v in got.items()}
        print(f"recording: {got}")
        assert got[110.0] > -40, "deck 1 is in the recording"
        assert got[70.0] < -70 and got[2000.0] < -70, "the cue-only deck never enters the recording"
        assert page.errors == []
    finally:
        ctx.close()


# ---- interruptions -------------------------------------------------------------------------

STUBS = """(() => {
  window.__wl = { requests: 0, sentinels: [] };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    request: async (type) => {
      window.__wl.requests++;
      const s = new EventTarget(); s.type = type; s.released = false;
      s.release = async () => { s.released = true; s.dispatchEvent(new Event('release')); };
      window.__wl.sentinels.push(s);
      return s;
    } } });
  window.__session = [];
  const session = {};
  Object.defineProperty(session, 'type', { get() { return window.__session[window.__session.length - 1] || 'auto'; },
                                           set(v) { window.__session.push(v); } });
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: session });
})();"""


def test_interruption_shows_resume_veil(chromium, base_url, auth_cookie, play_tracks):
    """A call (here ctx.suspend()) stops the audio with both decks playing:
    the veil shows, the decks hold their place; the tap resumes the context,
    sets the audio session and takes the wake lock again, and both decks go
    on from where they were."""
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    ctx = _phone(chromium, auth_cookie, init=STUBS)
    try:
        page = _boot(ctx, base_url, carry=(a, b))
        r = board(page)
        load(page, r, 0, a)
        assert page.evaluate("() => window.__session[0]") == "playback", "set before the context"
        load(page, r, 1, b)
        tap(page, r, "d1-play")
        tap(page, r, "d2-play")
        page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
        page.wait_for_function("() => window.cabine.wake.held")
        page.wait_for_timeout(1500)
        sessions_before = page.evaluate("() => window.__session.length")

        held = page.evaluate("""async () => { const e = window.cabine.engine;
            await e.ctx.suspend();
            // the system drops the wake lock during a call
            for (const s of window.__wl.sentinels) if (!s.released) await s.release();
            window.__wl.atRelease = window.__wl.requests;
            return e.decks.map(d => d.posAt()); }""")
        page.wait_for_selector(".cab-resume", state="visible")
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / "resume-veil-844x390.png"))
        page.wait_for_timeout(1200)
        still = page.evaluate("() => window.cabine.engine.decks.map(d => d.posAt())")
        assert all(abs(x - y) < 0.01 for x, y in zip(held, still)), (held, still)
        assert page.evaluate("() => window.cabine.engine.decks.every(d => d.state.playing)"), \
            "transport state kept"

        page.touchscreen.tap(422, 195)
        page.wait_for_function("() => window.cabine.engine.ctx.state === 'running'")
        page.wait_for_selector(".cab-resume", state="detached")
        page.wait_for_function("() => window.cabine.wake.held")
        assert page.evaluate("() => window.__wl.requests > window.__wl.atRelease"), "wake lock taken again"
        assert page.evaluate("() => window.__wl.sentinels.some(s => !s.released)")
        assert page.evaluate("() => window.__session.length") > sessions_before
        assert page.evaluate("() => window.__session[window.__session.length - 1]") == "playback"
        after = page.evaluate("() => window.cabine.engine.decks.map(d => d.posAt())")
        for x, y in zip(held, after):
            assert 0 <= y - x < 0.5, (held, after)
        page.wait_for_timeout(600)
        later = page.evaluate("() => window.cabine.engine.decks.map(d => d.posAt())")
        assert all(y > x + 0.3 for x, y in zip(after, later)), "both decks play on"
        assert levels(page, [110.0])[110.0] > -40
        assert page.errors == []
    finally:
        ctx.close()


def test_first_tap_retries_a_resume_that_did_not_take(chromium, base_url, auth_cookie, play_tracks):
    """iOS: a context left suspended after the first tap is resumed by the next pointerup."""
    a = play_tracks["tone_a"]
    ctx = _phone(chromium, auth_cookie)
    try:
        page = _boot(ctx, base_url, carry=(a,))
        r = board(page)
        load(page, r, 0, a)
        page.evaluate("() => window.cabine.engine.ctx.suspend()")
        page.wait_for_function("() => window.cabine.engine.ctx.state === 'suspended'")
        assert page.locator(".cab-resume").count() == 0, "no veil: nothing was playing"
        tap(page, r, "d1-cue")
        page.wait_for_function("() => window.cabine.engine.ctx.state === 'running'")
    finally:
        ctx.close()
