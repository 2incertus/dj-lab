"""A Cabine, playable (Task 10): the waveform strip, browse + LOAD, and every
board control bound to the engine.

Audio assertions run on Chromium (ruling R8: Playwright's WebKit on Linux is
not a faithful Safari audio stack); WebKit checks the strip's layout. Tracks
are carried into each page's own IndexedDB first, as on the phone.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.usefixtures("play_tracks")

SHOTS = Path.home() / "cabine-shots" / "task10"
IPHONE_INSETS = {"left": 59, "right": 47, "bottom": 21}


@pytest.fixture(scope="session")
def webkit(playwright_instance):
    browser = playwright_instance.webkit.launch()
    yield browser
    browser.close()


def _context(browser, engine, w=844, h=390, auth_cookie=None):
    kw = {"viewport": {"width": w, "height": h}, "device_scale_factor": 3, "has_touch": True}
    if engine == "chromium":
        kw["is_mobile"] = True
    ctx = browser.new_context(**kw)
    ctx.add_cookies([auth_cookie])
    return ctx


def _open(ctx, base_url, carry=(), insets=None):
    """/cabine with `carry` on the phone (carried in that order, so the last
    one is at the top of the list), then the board."""
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base_url}/cabine")
    page.wait_for_function("() => window.cabine && window.cabine.store")
    page.evaluate("() => window.cabine.ready")
    for f in carry:
        page.evaluate("async (f) => { await window.cabine.sync.carry(f); await new Promise(r => setTimeout(r, 5)); }", f)
    if insets:
        page.evaluate("""(i) => { const s = document.documentElement.style;
            s.setProperty('--cab-inset-left', i.left + 'px'); s.setProperty('--cab-inset-right', i.right + 'px');
            s.setProperty('--cab-inset-bottom', i.bottom + 'px'); }""", insets)
    page.evaluate("() => window.cabine.showBoard()")
    page.wait_for_selector(".cab-board .cab-board-ctl", state="attached")
    page.wait_for_function("() => window.cabine.strip && window.cabine.strip.tracks.length >= 0")
    page.errors = errors
    return page


def rects(page):
    return page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.cab-board .cab-board-ctl')]
        .map(el => { const r = el.getBoundingClientRect();
                     return [el.dataset.id, {l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
                             cx: r.left + r.width / 2, cy: r.top + r.height / 2}]; }))""")


def tap(page, b, cid):
    page.touchscreen.tap(b[cid]["cx"], b[cid]["cy"])


def turn_browse(page, b, steps):
    """Drag BROWSE: up = clockwise = +1 per 22 px."""
    x, y = b["browse"]["cx"], b["browse"]["cy"]
    page.mouse.move(x, y)
    page.mouse.down()
    dy = -25 * steps
    page.mouse.move(x, y + dy / 2, steps=3)
    page.mouse.move(x, y + dy, steps=3)
    page.mouse.up()


def drag(page, box, dx, dy, start=None):
    x, y = start or (box["cx"], box["cy"])
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx / 2, y + dy / 2, steps=5)
    page.mouse.move(x + dx, y + dy, steps=5)
    page.mouse.up()


def wait_loaded(page, deck, file):
    page.wait_for_function("""([d, f]) => { const e = window.cabine.engine;
        return e && e.decks[d].state.loaded && e.decks[d].track && e.decks[d].track.file === f; }""",
                           arg=[deck, file], timeout=30_000)


def load_both(page, a, b):
    """Browse to A, LOAD 1; browse to B, LOAD 2. The list is newest first: B, A."""
    r = rects(page)
    tap(page, r, "browse")                                 # the first touch also starts the engine
    page.wait_for_function("() => window.cabine.engine && window.cabine.strip.isBrowseOpen")
    assert page.evaluate("() => window.cabine.strip.highlighted()") == b
    turn_browse(page, r, 1)
    assert page.evaluate("() => window.cabine.strip.highlighted()") == a
    tap(page, r, "load1")
    wait_loaded(page, 0, a)
    assert page.evaluate("() => window.cabine.strip.isBrowseOpen") is False, "loading closes the list"
    tap(page, r, "browse")
    turn_browse(page, r, -1)
    assert page.evaluate("() => window.cabine.strip.highlighted()") == b
    tap(page, r, "load2")
    wait_loaded(page, 1, b)
    return r


MEASURE = """async ([freqs, ms]) => {
  const rig = window.cabine.engine, ctx = rig.ctx;
  const an = ctx.createAnalyser();
  an.fftSize = 32768;
  an.smoothingTimeConstant = 0;
  rig.mixer.masterTap.connect(an);
  await new Promise((r) => setTimeout(r, ms));
  const a = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(a);
  rig.mixer.masterTap.disconnect(an);
  const n = a.length, sr = ctx.sampleRate;
  let e = 0;
  for (let i = 0; i < n; i++) e += a[i] * a[i];
  const out = { rms: 10 * Math.log10(e / n + 1e-30) };
  for (const hz of freqs) {
    let re = 0, im = 0, wsum = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));    // Hann
      const ph = 2 * Math.PI * hz * i / sr;
      re += a[i] * w * Math.cos(ph); im -= a[i] * w * Math.sin(ph);
      wsum += w;
    }
    const amp = 2 * Math.sqrt(re * re + im * im) / wsum;
    out[hz] = amp > 0 ? 20 * Math.log10(amp) : -400;
  }
  return out;
}"""


def measure(page, freqs, ms=900):
    """Master level per frequency (dBFS of a sine's peak), keyed by frequency."""
    res = page.evaluate(MEASURE, [freqs, ms])
    return {(k if k == "rms" else float(k)): v for k, v in res.items()}


@pytest.fixture
def phone(chromium, base_url, auth_cookie):
    ctx = _context(chromium, "chromium", auth_cookie=auth_cookie)
    yield ctx
    ctx.close()


# ---- the ride ------------------------------------------------------------------------

def test_two_tracks_mix_end_to_end(phone, base_url, play_tracks):
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    r = load_both(page, a, b)
    tap(page, r, "d1-play")
    tap(page, r, "d2-play")
    page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
    tap(page, r, "d2-sync")
    page.wait_for_function("() => window.cabine.engine.decks[1].state.syncOn")
    page.wait_for_timeout(300)
    rate_b = page.evaluate("() => window.cabine.engine.decks[1]._baseRate()")
    assert abs(rate_b - 128 / 127) < 1e-9, "deck 2 (127 BPM) follows deck 1 (128 BPM)"
    assert page.evaluate("() => document.querySelector(\"[data-id='d2-sync']\").classList.contains('cab-lit')")
    assert page.evaluate("() => document.querySelector(\"[data-id='d1-sync']\").classList.contains('cab-master')")
    assert page.evaluate("() => document.querySelector(\"[data-id='d1-play']\").classList.contains('cab-lit')")
    fa, fb_lo, fb_hi = 110.0, 70.0 * rate_b, 2000.0 * rate_b

    center = measure(page, [fa, fb_lo, fb_hi])
    print(f"\ncenter: {center}")
    assert center[fa] > -40 and center[fb_lo] > -40 and center[fb_hi] > -40, "both decks on the master"

    # EQ low swap: deck 1's bass out, deck 2's sub up
    drag(page, r["ch1-low"], 0, 130)
    drag(page, r["ch2-low"], 0, -130)
    page.wait_for_timeout(200)
    eq = page.evaluate("() => window.cabine.engine.mixer.state.channels.map(c => c.low)")
    assert eq == [0, 1], eq
    swap = measure(page, [fa, fb_lo, fb_hi])
    print(f"after the low swap: {swap}")
    assert swap[fa] < center[fa] - 20, "deck 1's low cut (EQ mode, -26 dB)"
    assert swap[fb_lo] > center[fb_lo] + 4, "deck 2's low boosted (+6 dB)"
    assert abs(swap[fb_hi] - center[fb_hi]) < 1.5, "deck 2's 2 kHz untouched"

    # crossfader across to the right: deck 1 gone
    xf = r["xfader"]
    drag(page, xf, xf["w"] * 2, 0)
    page.wait_for_timeout(200)
    assert page.evaluate("() => window.cabine.engine.mixer.state.crossfader") == 1
    right = measure(page, [fa, fb_lo, fb_hi])
    print(f"crossfader right: {right}")
    assert right[fa] < -80, "deck 1 absent at full right"
    assert right[fb_lo] > -40 and right[fb_hi] > -40, "deck 2 still on"
    assert page.evaluate("() => window.cabine.engine.underruns()") == 0
    assert not page.errors, page.errors


def test_strip_read_only(phone, base_url, play_tracks):
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    load_both(page, a, b)
    snap = """() => { const e = window.cabine.engine;
        return { decks: e.decks.map(d => ({ pos: d.posAt(), playing: d.state.playing, cue: d.state.cuePoint,
                   hot: JSON.stringify(d.state.hotCues), loop: JSON.stringify(d.state.loop), sync: d.state.syncOn,
                   file: d.track.file })),
                 log: window.cabine.boardLog.length, browse: window.cabine.strip.isBrowseOpen }; }"""
    before = page.evaluate(snap)
    lanes = page.evaluate("""() => { const s = window.cabine.strip, c = s.canvas.getBoundingClientRect();
        return s.L.lanes.map(l => ({x: c.left + l.wave.x, y: c.top + l.wave.y, w: l.wave.w, h: l.wave.h,
                                    tx: c.left + l.text.x, ty: c.top + l.text.y})); }""")
    for lane in lanes:
        for fx in (0.1, 0.5, 0.9):
            page.touchscreen.tap(lane["x"] + fx * lane["w"], lane["y"] + lane["h"] / 2)
        page.touchscreen.tap(lane["tx"] + 40, lane["ty"] + 4)
        page.mouse.move(lane["x"] + 0.5 * lane["w"], lane["y"] + 2)
        page.mouse.down()
        page.mouse.move(lane["x"] + 0.2 * lane["w"], lane["y"] + 2, steps=6)        # a drag along it
        page.mouse.up()
    page.wait_for_timeout(200)
    after = page.evaluate(snap)
    assert after == before, "a touch on the waveform changes nothing"
    assert not page.errors, page.errors


def test_load_lock_on_playing_deck(phone, base_url, play_tracks):
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    r = load_both(page, a, b)
    tap(page, r, "d1-play")
    page.wait_for_function("() => window.cabine.engine.decks[0].state.playing")
    tap(page, r, "browse")
    assert page.evaluate("() => window.cabine.strip.highlighted()") == b
    tap(page, r, "load1")
    page.wait_for_timeout(400)
    st = page.evaluate("() => { const d = window.cabine.engine.decks[0]; return {file: d.track.file, playing: d.state.playing}; }")
    assert st == {"file": a, "playing": True}, st
    assert "load lock" in (page.evaluate("() => window.cabine.strip.flashing(0)") or "")
    # paused, the same LOAD goes through
    tap(page, r, "d1-play")
    page.wait_for_function("() => !window.cabine.engine.decks[0].state.playing")
    tap(page, r, "load1")
    wait_loaded(page, 0, b)
    assert not page.errors, page.errors


def test_swap_unloads_before_decode(phone, base_url, play_tracks):
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    r = load_both(page, a, b)
    page.evaluate("""() => {
        window.__msgs = [];
        const port = window.cabine.engine.voices[0].node.port;
        const post = port.postMessage.bind(port);
        port.postMessage = (m, t) => { if (m.type === 'load') window.__msgs.push(['load', m.left.length]); return post(m, t); };
        const dec = OfflineAudioContext.prototype.decodeAudioData;
        OfflineAudioContext.prototype.decodeAudioData = function (...args) { window.__msgs.push(['decode', 0]); return dec.apply(this, args); };
    }""")
    tap(page, r, "browse")
    assert page.evaluate("() => window.cabine.strip.highlighted()") == b
    tap(page, r, "load1")                                  # deck 1: A -> B
    wait_loaded(page, 0, b)
    msgs = page.evaluate("() => window.__msgs")
    print(f"\nswap messages: {msgs}")
    kinds = [m[0] if m[0] == "decode" else ("unload" if m[1] == 0 else "load") for m in msgs]
    assert kinds == ["unload", "decode", "load"], msgs
    assert msgs[2][1] > 44100 * 30, "the new track's PCM"
    assert not page.errors, page.errors


def test_playhead_is_latency_compensated(phone, base_url, play_tracks):
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    r = load_both(page, a, b)
    tap(page, r, "d1-play")
    page.wait_for_function("() => window.cabine.engine.decks[0].state.playing")
    page.wait_for_timeout(600)               # past 0.2 s: the drawn position is not clamped at 0
    res = page.evaluate("""async () => {
        const ctx = window.cabine.engine.ctx, s = window.cabine.strip;
        const frames = () => new Promise((r) => { let n = 0; const f = () => (++n > 6 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        const read = () => { const d = s.drawn[0]; return { lag: d.engine - d.pos, pos: d.pos, t: d.t }; };
        Object.defineProperty(ctx, 'outputLatency', { value: 0.2, configurable: true });
        Object.defineProperty(ctx, 'baseLatency', { value: 0, configurable: true });
        await frames();
        const fake = read();
        Object.defineProperty(ctx, 'outputLatency', { value: 0, configurable: true });
        await frames();
        const none = read();
        return { fake, none };
    }""")
    print(f"\nplayhead lag: {res}")
    assert abs(res["fake"]["lag"] - 0.2) < 0.002, "drawn 0.2 s behind the engine"
    assert abs(res["none"]["lag"]) < 0.002
    assert not page.errors, page.errors


def test_ui_frame_budget(phone, base_url, play_tracks):
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    r = load_both(page, a, b)
    tap(page, r, "d1-play")
    tap(page, r, "d2-play")
    page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
    cdp = phone.new_cdp_session(page)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    try:
        res = page.evaluate("""async () => {
            const u0 = window.cabine.engine.underruns();
            const d = [];
            let last = null;
            await new Promise((done) => {
                const end = performance.now() + 10000;
                const f = (t) => { if (last !== null) d.push(t - last); last = t;
                                   if (t < end) requestAnimationFrame(f); else done(); };
                requestAnimationFrame(f);
            });
            d.sort((x, y) => x - y);
            return { n: d.length, median: d[Math.floor(d.length / 2)], p90: d[Math.floor(d.length * 0.9)],
                     max: d[d.length - 1], underruns: window.cabine.engine.underruns() - u0,
                     playing: window.cabine.engine.decks.map(x => x.state.playing) };
        }""")
    finally:
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    print(f"\nframe budget (4x CPU throttle): {res}")
    assert res["playing"] == [True, True]
    assert res["median"] < 33, res
    assert res["underruns"] == 0, res
    assert not page.errors, page.errors


# ---- engine-level: sync drift and the gapless guard (offline renders) ------------------

ENGINE = """
  const { createRig } = await import('/static/cabine/engine/rig.js');
  const { loadTrack, networkSource } = await import('/static/cabine/engine/loader.js');
  const G = await import('/static/cabine/engine/grid.js');
"""


def test_sync_drift_under_3ms_over_120s(proof_page, play_tracks):
    """Deck A 128 BPM on the master (right ear), deck B 131 BPM synced to it
    and cued to the headphones (left ear, its fader down), rendered offline
    for 120 s through the real rig. Every 10 s: A's click onset on the right
    ear against B's on the left; the offset stays under 3 ms."""
    r = proof_page.evaluate("async ([fa, fb]) => {" + ENGINE + """
      const sr = 44100, secs = 120;
      const ctx = new OfflineAudioContext(2, secs * sr, sr);
      const rig = await createRig(ctx, { testHooks: true });
      const [A, B] = rig.decks;
      const src = networkSource();
      A.load(await loadTrack(ctx, src, fa, { log: () => {} }));
      B.load(await loadTrack(ctx, src, fb, { log: () => {} }));
      rig.mixer.setFader(2, 0);                 // B off the master ...
      rig.mixer.setCue(2, true);                // ... and in the headphones
      rig.mixer.setPhonesMix(0);                // headphones = cue only
      rig.mixer.setPhonesLevel(1);
      B.syncPress(A);
      A.playPause();
      B.playPause();                            // synced start: lands on A's phase
      await Promise.all(rig.voices.map((v) => v.sync()));
      const out = await ctx.startRendering();
      const R = out.getChannelData(1), L = out.getChannelData(0);
      const onset = (ch, from, to, thr) => {
        for (let i = Math.max(0, Math.round(from * sr)); i < Math.min(ch.length, Math.round(to * sr)); i++) {
          if (Math.abs(ch[i]) > thr) return i / sr;
        }
        return null;
      };
      const peak = (ch) => { let p = 0; for (let i = 0; i < ch.length; i += 7) p = Math.max(p, Math.abs(ch[i])); return p; };
      const thrR = 0.15 * peak(R), thrL = 0.15 * peak(L);
      const rows = [];
      for (let k = 1; k <= 11; k++) {
        const ta = onset(R, 10 * k, 10 * k + 1, thrR);
        const tb = ta === null ? null : onset(L, ta - 0.2, ta + 0.2, thrL);
        rows.push({ at: 10 * k, ta, tb, ms: ta !== null && tb !== null ? 1000 * (tb - ta) : null });
      }
      return { rows, rateB: B._baseRate(), syncOn: B.state.syncOn, under: rig.underruns() };
    }""", [play_tracks["click128_130"], play_tracks["click131"]])
    for row in r["rows"]:
        print(f"\n  t={row['at']:>3}s  A {row['ta']}  B {row['tb']}  offset {row['ms']} ms", end="")
    print()
    assert r["syncOn"] and abs(r["rateB"] - 128 / 131) < 1e-9, r
    offs = [row["ms"] for row in r["rows"]]
    assert all(o is not None for o in offs), r["rows"]
    assert max(abs(o) for o in offs) < 3, offs


def test_gapless_guard_trims_a_padded_decode(proof_page, play_tracks):
    """A decoder that leaves the encoder delay (576 + 529 = 1105 frames) and the
    padding (here 1008 - 529 = 479) in: the loader reads both from the LAME
    header, trims both, and the first click lands on the grid (1 ms). Without
    the guard the same decode is ~25 ms late."""
    r = proof_page.evaluate("async (file) => {" + ENGINE + """
      const { Deck } = await import('/static/cabine/engine/deck.js');
      const { DeckVoice } = await import('/static/cabine/engine/deck-voice.js');
      const { parseLameGapless } = await import('/static/cabine/engine/loader.js');
      const sr = 44100;
      const net = networkSource();
      const meta = await net.getMeta(file);
      const mp3 = await net.getMp3(file);
      const lame = parseLameGapless(mp3);
      // what a decoder that ignores the LAME header hands back: the encoder
      // delay + 529 decoder frames at the head, the padding less 529 at the tail
      const HEAD = lame.delay + 529, TAIL = lame.padding - 529;
      const real = await new OfflineAudioContext(2, 1, sr).decodeAudioData(mp3.slice(0));
      const n = real.length;
      const padded = new AudioBuffer({ length: n + HEAD + TAIL, numberOfChannels: 2, sampleRate: sr });
      for (let c = 0; c < 2; c++) padded.getChannelData(c).set(real.getChannelData(c), HEAD);
      const decodeCtx = { decodeAudioData: async () => padded };
      const logs = [];
      const render = async (samples) => {
        const ctx = new OfflineAudioContext(2, 2 * sr, sr);
        const source = { ...net, getMeta: async () => ({ ...meta, samples }) };
        const track = await loadTrack(ctx, source, file, { decodeCtx, log: (m) => logs.push(m) });
        const frames = track.pcm.left.length, gap = track.gapless;
        const voice = await DeckVoice.create(ctx, { testHooks: true });
        voice.connect(ctx.destination);
        const deck = new Deck(voice, { now: () => ctx.currentTime });
        deck.load(track);
        const p0 = 1.1;
        deck._seekNow(p0, 0);
        deck.playPause();
        await voice.sync();
        const out = await ctx.startRendering();
        const L = out.getChannelData(0);
        let k = -1;
        for (let i = 0; i < L.length; i++) { if (Math.abs(L[i]) > 0.2) { k = i; break; } }
        const next = G.timeOfBeat(track.grid, Math.ceil(G.beatIndexAt(track.grid, p0)));
        return { frames, gap, ms: 1000 * (p0 + k / sr - next) };
      };
      const guarded = await render(meta.samples);
      const unguarded = await render(null);
      return { samples: meta.samples, realDecode: n, guarded, unguarded, logs, lame, HEAD, TAIL };
    }""", play_tracks["click120"])
    print(f"\ngapless: real decode {r['realDecode']} vs source {r['samples']}; "
          f"guarded {r['guarded']['ms']:+.3f} ms, unguarded {r['unguarded']['ms']:+.3f} ms; {r['logs']}")
    g = r["guarded"]
    assert r["HEAD"] == 1105 and r["TAIL"] == 479, r["lame"]
    assert g["gap"]["action"] == "trimmed" and g["gap"]["head"] == 1105 and g["gap"]["tail"] == 479, g
    assert g["frames"] == r["samples"], g
    assert abs(g["ms"]) < 1, g
    assert r["unguarded"]["ms"] > 20, "the control: an untrimmed decode really is late"
    assert any("gapless guard" in m and "1105" in m for m in r["logs"]), r["logs"]


# ---- layout and screenshots --------------------------------------------------------------

@pytest.mark.parametrize("engine", ["chromium", "webkit"])
def test_strip_layout_and_playing_screenshot(engine, chromium, webkit, base_url, auth_cookie, play_tracks):
    browser = chromium if engine == "chromium" else webkit
    w, h = (844, 390)
    ctx = _context(browser, engine, w, h, auth_cookie)
    try:
        a, b = play_tracks["click128_130"], play_tracks["click131"]
        page = _open(ctx, base_url, carry=(a, b), insets=IPHONE_INSETS if engine == "webkit" else None)
        r = load_both(page, a, b)
        box = page.evaluate("""() => { const q = (s) => document.querySelector(s).getBoundingClientRect();
            const o = (r) => ({l: r.left, t: r.top, r: r.right, b: r.bottom});
            return { strip: o(q('.cab-board-strip')), canvas: o(q('.cab-strip-canvas')), rec: o(q('.cab-strip-rec')),
                     caixa: o(q('.cab-board-caixa')), board: o(q('.cab-board')),
                     lanes: window.cabine.strip.L.lanes.map(l => l.wave), recDisabled: document.querySelector('.cab-strip-rec').disabled }; }""")
        s, c = box["strip"], box["canvas"]
        assert abs(c["l"] - s["l"]) < 1 and abs(c["r"] - s["r"]) < 1 and abs(c["b"] - s["b"]) < 1.5, box
        assert box["rec"]["r"] <= s["r"] + 0.5 and box["rec"]["b"] <= s["b"] + 0.5 and box["rec"]["t"] >= s["t"] - 0.5
        assert box["recDisabled"] is False, "REC is live (Task 11)"
        assert box["lanes"][0]["x"] + c["l"] >= box["caixa"]["r"], "the waveform starts right of caixa"
        assert s["b"] <= box["board"]["t"] + 0.5, "the strip sits above the board"
        # browse open: the list stays inside the strip
        tap(page, r, "browse")
        lst = page.evaluate("() => { const r = document.querySelector('.cab-strip-browse').getBoundingClientRect(); return {l: r.left, t: r.top, r: r.right, b: r.bottom}; }")
        assert lst["t"] >= s["t"] - 0.5 and lst["b"] <= s["b"] + 0.5 and lst["l"] >= box["caixa"]["r"], lst
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"browse-{engine}-{w}x{h}.png"))
        tap(page, r, "browse")
        expect(page.locator(".cab-strip-browse")).to_be_hidden()
        tap(page, r, "d1-play")
        tap(page, r, "d2-play")
        page.wait_for_function("() => window.cabine.engine.decks.every(d => d.state.playing)")
        tap(page, r, "d2-sync")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / f"playing-{engine}-{w}x{h}.png"))
        page.screenshot(path=str(SHOTS / f"strip-{engine}-{w}x{h}.png"),
                        clip={"x": s["l"], "y": s["t"], "width": s["r"] - s["l"], "height": s["b"] - s["t"]})
        assert not page.errors, page.errors
    finally:
        ctx.close()


def test_portrait_stands_the_strip_down(phone, base_url, play_tracks):
    """Turned to portrait the strip draws nothing and keeps its layout and
    tiles; back in landscape it carries on without pre-rendering again."""
    a, b = play_tracks["tone_a"], play_tracks["tone_b"]
    page = _open(phone, base_url, carry=(a, b))
    r = load_both(page, a, b)
    tap(page, r, "d1-play")
    tap(page, r, "d2-play")
    page.evaluate("() => document.fonts.ready")
    page.wait_for_timeout(400)
    stats = "() => ({ ...window.cabine.strip.stats, lights: window.cabine.bind.lightsRuns })"
    s0 = page.evaluate(stats)
    assert s0["prerenders"] >= 2 and s0["frames"] > 0, s0
    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.locator(".cab-turn")).to_be_visible()
    page.wait_for_timeout(300)
    s1 = page.evaluate(stats)
    page.wait_for_timeout(1000)
    s2 = page.evaluate(stats)
    assert s2["frames"] == s1["frames"], f"drawing while hidden: {s1} -> {s2}"
    assert s2["lights"] == s1["lights"], f"lights refreshed while hidden: {s1} -> {s2}"
    assert s2["prerenders"] == s0["prerenders"], f"re-rendered for the hidden strip: {s0} -> {s2}"
    page.set_viewport_size({"width": 844, "height": 390})
    page.wait_for_timeout(600)
    s3 = page.evaluate(stats)
    assert s3["prerenders"] == s0["prerenders"], f"re-rendered on the way back: {s0} -> {s3}"
    assert s3["frames"] > s2["frames"], "drawing again in landscape"
    assert page.evaluate("() => window.cabine.engine.decks.every(d => d.state.playing)")
    assert not page.errors, page.errors
