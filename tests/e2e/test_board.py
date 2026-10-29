"""A Cabine board (Task 9, Cabine v2 Task V1): the FLX4 top panel on a
landscape phone, driven by the demo bindings (showBoard({demo: true}): every
action logged in window.cabine.boardLog, no audio; Task 10's engine bindings
are tested in test_play.py).

Three phones: Mathias's iPhone in WebKit, 844 x 390 (installed app) and
844 x 330 (Safari with its landscape bars, his screenshot), with the iPhone's
safe-area padding emulated through the --cab-inset-* CSS variables (WebKit on
Linux has no notch, so env() reads 0), and the Galaxy, 760 x 360 in Chromium
with touch. Multi-touch goes through CDP Input.dispatchTouchEvent, so it is
Chromium only.

v2: the default layout is "panels" (no strip band, the board as tall as the
screen allows, panel slots beside the mixer); small parts are drawn bigger and
answer in hit zones larger than what is drawn (ui/board-layout.js hitMap),
resolved by their section and handed to the widget.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

SHOTS = Path.home() / "cabine-shots" / "v2"
XFADER_CLEAR_PX = 34
# the iPhone's left inset when the Dynamic Island is on the left: more than the
# 47 px fallback, so the test proves the inset is read, not just the fallback
IPHONE_INSETS = {"left": 59, "right": 47, "bottom": 21}

PHONES = {
    "iphone-webkit": {"engine": "webkit", "w": 844, "h": 390, "insets": IPHONE_INSETS},
    "iphone-safari-webkit": {"engine": "webkit", "w": 844, "h": 330, "insets": {"left": 47, "right": 47, "bottom": 21}},
    "galaxy-chromium": {"engine": "chromium", "w": 760, "h": 360, "insets": None},
}
PANELS_TOP_PX = 6


@pytest.fixture(scope="session")
def webkit(playwright_instance):
    browser = playwright_instance.webkit.launch()
    yield browser
    browser.close()


def _context(browser, engine, w, h, auth_cookie):
    kw = {"viewport": {"width": w, "height": h}, "device_scale_factor": 3, "has_touch": True}
    if engine == "chromium":
        kw["is_mobile"] = True
    ctx = browser.new_context(**kw)
    ctx.add_cookies([auth_cookie])
    return ctx


def _open_board(ctx, base_url, insets=None, layout=None):
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base_url}/cabine")
    page.wait_for_function("() => window.cabine && window.cabine.store")
    page.evaluate("() => window.cabine.ready")
    if insets:
        page.evaluate("""(i) => {
            const s = document.documentElement.style;
            s.setProperty('--cab-inset-left', i.left + 'px');
            s.setProperty('--cab-inset-right', i.right + 'px');
            s.setProperty('--cab-inset-bottom', i.bottom + 'px');
        }""", insets)
    # the Task 9 demo bindings: these tests are about the board's touch
    # handling, with no tracks loaded (test_play.py drives the engine)
    page.evaluate("(m) => window.cabine.showBoard(m ? {layout: m, demo: true} : {demo: true})", layout)
    page.wait_for_selector(".cab-board .cab-board-ctl", state="attached")
    page.evaluate("() => document.fonts && document.fonts.ready")
    page.errors = errors
    return page


@pytest.fixture(params=list(PHONES))
def phone(request, chromium, webkit, base_url, auth_cookie):
    spec = PHONES[request.param]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    page = _open_board(ctx, base_url, spec["insets"])
    yield {"page": page, "ctx": ctx, "name": request.param, **spec}
    assert not page.errors, page.errors
    ctx.close()


@pytest.fixture
def galaxy(chromium, base_url, auth_cookie):
    ctx = _context(chromium, "chromium", 760, 360, auth_cookie)
    page = _open_board(ctx, base_url)
    yield page, ctx
    assert not page.errors, page.errors
    ctx.close()


def rects(page):
    return page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.cab-board .cab-board-ctl')]
        .map(el => { const r = el.getBoundingClientRect();
                     return [el.dataset.id, {l: r.left, t: r.top, r: r.right, b: r.bottom,
                             cx: r.left + r.width / 2, cy: r.top + r.height / 2}]; }))""")


def log(page):
    return page.evaluate("() => window.cabine.boardLog.map(e => ({action: e.action, value: e.value, id: e.id, deck: e.deck}))")


def lit(page, cid):
    return page.evaluate("(id) => document.querySelector(`[data-id='${id}']`).classList.contains('cab-lit')", cid)


def touch(cdp, kind, points):
    cdp.send("Input.dispatchTouchEvent", {
        "type": kind,
        "touchPoints": [{"x": x, "y": y, "id": i, "radiusX": 4, "radiusY": 4, "force": 1}
                        for i, (x, y) in points.items()],
    })


# ---- tests ---------------------------------------------------------------------------

# ---- geometry from the page -----------------------------------------------------------

GEO = """() => {
    const b = window.cabine.board, g = b.geometry(), r = b.board.getBoundingClientRect();
    const drawn = {};
    for (const [id, d] of g.drawn) drawn[id] = {l: r.left + d.x, t: r.top + d.y, r: r.left + d.x + d.w, b: r.top + d.y + d.h,
        w: d.w, h: d.h, cx: r.left + d.x + d.w / 2, cy: r.top + d.y + d.h / 2, shape: d.shape, section: d.section};
    const kinds = Object.fromEntries([...g.drawn.keys()].map(id => [id, b.control(id).kind]));
    const secs = Object.fromEntries(g.fit.sections.map(s => [s.key, {l: r.left + s.left, r: r.left + s.left + s.width,
        t: r.top, b: r.top + g.fit.height}]));
    return {drawn, kinds, secs, board: {l: r.left, t: r.top, r: r.right, b: r.bottom}, slots: b.panelSlots()};
}"""

BIG = {"jog", "fader", "xfader"}

# after the board's own listeners: which widget took the pointer
RECORD = """() => { window.__took = [];
    const b = window.cabine.board, ids = [...b.geometry().drawn.keys()];
    window.addEventListener('pointerdown', (e) => {
        const id = ids.find(i => { const w = b.widget(i); return w && w.pid === e.pointerId; });
        window.__took.push(id || null);
    }); }"""


def took(page):
    return page.evaluate("() => window.__took.splice(0)")


def in_shape(x, y, d):
    if not (d["l"] <= x < d["r"] and d["t"] <= y < d["b"]):
        return False
    if d["shape"] != "circle":
        return True
    return ((x - d["cx"]) ** 2 + (y - d["cy"]) ** 2) ** 0.5 <= d["w"] / 2


def edge_distance(x, y, d):
    """Distance from (x, y) to a drawn part's outline (0 inside)."""
    if d["shape"] == "circle":
        return max(0.0, ((x - d["cx"]) ** 2 + (y - d["cy"]) ** 2) ** 0.5 - d["w"] / 2)
    dx, dy = max(d["l"] - x, 0, x - d["r"]), max(d["t"] - y, 0, y - d["b"])
    return (dx * dx + dy * dy) ** 0.5


def zone_point(page, cid, d):
    """A point of cid's zone far outside its drawn box: the farthest (up to 30 px)
    whose whole 2 px neighbourhood is still cid's (touch coordinates round)."""
    return page.evaluate("""([id, d]) => { const b = window.cabine.board; let best = null;
        const mine = (x, y) => [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => b.hitTest(x + dx, y + dy) === id);
        for (let k = 30; k >= 2 && !best; k -= 1) {
            const pts = [[d.l - k, d.cy], [d.r + k, d.cy], [d.cx, d.t - k], [d.cx, d.b + k],
                         [d.l - k, d.t - k], [d.r + k, d.t - k], [d.l - k, d.b + k], [d.r + k, d.b + k]];
            for (const [x, y] of pts) if (mine(x, y)) { best = {x, y, k}; break; }
        }
        return best; }""", [cid, d])


# ---- tests ---------------------------------------------------------------------------

@pytest.mark.parametrize("layout", ["phone", "panels", "spread", "exact"])
@pytest.mark.parametrize("name", list(PHONES))
def test_every_control_hittable(name, layout, chromium, webkit, base_url, auth_cookie):
    spec = PHONES[name]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    try:
        page = _open_board(ctx, base_url, spec["insets"], layout)
        _check_hittable(page, {"name": name, "layout": layout, **spec})
        assert not page.errors, page.errors
    finally:
        ctx.close()


def _check_hittable(page, phone):
    w, h = phone["w"], phone["h"]
    ids = page.evaluate("async () => (await import('/static/cabine/flx4-map.js')).CONTROLS.map(c => c.id)")
    g = page.evaluate(GEO)
    boxes = rects(page)
    assert sorted(boxes) == sorted(ids), "every control is drawn once"
    # the drawn element is where the layout put it
    for cid, d in g["drawn"].items():
        bx = boxes[cid]
        assert abs(bx["l"] - d["l"]) < 0.6 and abs(bx["t"] - d["t"]) < 0.6 and abs(bx["r"] - d["r"]) < 0.6, (cid, bx, d)
    # a touch at every centre goes to its own control: the big ones take it on
    # their own element, the small ones through their section
    misses = page.evaluate("""(ids) => ids.filter(id => {
        const b = window.cabine.board, el = document.querySelector(`.cab-board [data-id='${id}']`);
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (b.hitTest(x, y) !== id) return true;
        const hit = document.elementFromPoint(x, y);
        if (!hit) return true;
        const big = ['jog', 'fader', 'xfader'].includes(b.control(id).kind);
        if (big) return !hit.closest('.cab-board-ctl') || hit.closest('.cab-board-ctl').dataset.id !== id;
        return hit !== el.closest('[data-sec]');
    })""", ids)
    assert misses == [], f"centers that do not reach their own control: {misses}"
    insets = phone["insets"] or {"left": 47, "right": 47, "bottom": 21}
    for cid, b in boxes.items():
        assert b["l"] >= insets["left"] - 0.5 and b["r"] <= w - insets["right"] + 0.5, f"{cid} in a side safe area"
        assert b["b"] <= h - insets["bottom"] + 0.5, f"{cid} in the home indicator zone"
        sec = g["secs"][g["drawn"][cid]["section"]]
        assert sec["l"] - 0.5 <= b["l"] and b["r"] <= sec["r"] + 0.5 and sec["t"] - 0.5 <= b["t"] and b["b"] <= sec["b"] + 0.5, \
            f"{cid} clipped by its section"
    assert boxes["xfader"]["b"] <= h - XFADER_CLEAR_PX + 0.5, boxes["xfader"]
    board = g["board"]
    assert page.evaluate("() => document.querySelector('.cab-board').dataset.layout") == phone["layout"]
    caixa = page.locator(".cab-board-caixa").bounding_box()
    expect(page.locator(".cab-board-caixa")).to_be_visible()
    if phone["layout"] == "panels":
        # no strip band: the board starts PANELS_TOP_PX from the top, deck 1 at the
        # left safe edge, deck 2 at the right one, two panel slots beside the mixer
        assert abs(board["t"] - PANELS_TOP_PX) < 0.5, board
        assert abs(board["l"] - insets["left"]) < 0.5 and abs(board["r"] - (w - insets["right"])) < 0.5, board
        assert page.evaluate("() => getComputedStyle(document.querySelector('.cab-board-strip')).visibility") == "hidden"
        slots = g["slots"]
        assert len(slots) == 2 and all(sl["w"] > 20 and sl["h"] > 200 for sl in slots), slots
        s0 = slots[0]
        assert s0["x"] - 0.5 <= caixa["x"] and caixa["x"] + caixa["width"] <= s0["x"] + s0["w"] + 0.5, (caixa, s0)
        assert caixa["height"] >= 44 - 0.5, "caixa is a full touch target"
        for i, sl in enumerate(slots):
            el = page.locator(f".cab-board-panel[data-panel='{i + 1}']").bounding_box()
            assert abs(el["x"] - sl["x"]) < 0.5 and abs(el["width"] - sl["w"]) < 0.5, (el, sl)
    elif phone["layout"] == "phone":
        # the slim waveform band on top (10 % of the usable height, 30 px at least),
        # caixa at its left end; the board under it, safe edge to safe edge
        strip = page.evaluate("() => { const r = document.querySelector('.cab-board-strip').getBoundingClientRect(); return {t: r.top, b: r.bottom, l: r.left, r: r.right}; }")
        band = strip["b"] - strip["t"]
        assert abs(band - max(30, round((h - insets["bottom"]) * 0.1))) < 1, strip
        assert board["t"] >= strip["b"] - 0.5 and min(b["t"] for b in boxes.values()) >= strip["b"] - 0.5
        assert abs(board["l"] - insets["left"]) < 0.5 and abs(board["r"] - (w - insets["right"])) < 0.5, board
        assert strip["l"] - 0.5 <= caixa["x"] and caixa["y"] >= strip["t"] - 0.5 and caixa["y"] + caixa["height"] <= strip["b"] + 0.5, (caixa, strip)
        assert page.evaluate("() => getComputedStyle(document.querySelector('.cab-board-strip')).visibility") == "visible"
    else:
        # the strip area is reserved above the board, the caixa button inside it
        strip = page.evaluate("() => { const r = document.querySelector('.cab-board-strip').getBoundingClientRect(); return {b: r.bottom, l: r.left}; }")
        assert min(b["t"] for b in boxes.values()) >= strip["b"] - 0.5
        assert caixa["x"] >= insets["left"] - 0.5 and caixa["y"] + caixa["height"] <= strip["b"]
        if phone["layout"] == "spread":
            assert abs(board["l"] - insets["left"]) < 0.5 and abs(board["r"] - (w - insets["right"])) < 0.5, board
        else:
            assert board["l"] > insets["left"] + 20, "exact: the panel at its own proportions, centered"
    _check_legends(page, g, phone)
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"board-{phone['name']}-{phone['layout']}-{w}x{h}.png"))


def _check_legends(page, g, phone):
    """Nothing clipped: every legend shown is at least 6 px, inside its section,
    its text inside its box, clear of the other legends and of every drawn part
    but its own (the tempo and channel marks sit in their fader's tick area)."""
    legs = page.evaluate("""() => [...document.querySelectorAll('.cab-board-lbl, .cab-board-sub, .cab-board-legend, .cab-board-face')]
        .filter(el => !el.hidden && el.offsetParent !== null && el.textContent.trim())
        .map(el => { const r = el.getBoundingClientRect(), ctl = el.closest('.cab-board-ctl');
            return {text: el.textContent.trim(), face: el.classList.contains('cab-board-face'),
                    owner: ctl ? ctl.dataset.id : null, sec: el.closest('[data-sec]').dataset.sec,
                    l: r.left, t: r.top, r: r.right, b: r.bottom,
                    px: parseFloat(getComputedStyle(el).fontSize), over: el.scrollWidth - el.clientWidth}; })""")
    assert len(legs) > 80, len(legs)
    tag = f"{phone['name']} {phone['layout']}"
    for a in legs:
        assert a["px"] >= 6 - 0.01, f"{tag}: '{a['text']}' at {a['px']} px"
        if a["face"]:
            continue
        sec = g["secs"][a["sec"]]
        assert sec["l"] - 0.5 <= a["l"] and a["r"] <= sec["r"] + 0.5 and sec["t"] - 0.5 <= a["t"] and a["b"] <= sec["b"] + 0.5, \
            f"{tag}: '{a['text']}' clipped {a}"
        assert a["over"] <= 1, f"{tag}: '{a['text']}' runs out of its box by {a['over']} px"
    if phone["layout"] not in ("panels", "phone"):
        return                                     # the old layouts keep their old crowding
    shown = [a for a in legs if not a["face"]]
    for i, a in enumerate(shown):
        for b in shown[i + 1:]:
            ov = min(a["r"], b["r"]) - max(a["l"], b["l"]), min(a["b"], b["b"]) - max(a["t"], b["t"])
            assert ov[0] <= 0.5 or ov[1] <= 0.5, f"{tag}: '{a['text']}' over '{b['text']}'"
        for cid, d in g["drawn"].items():
            if cid == a["owner"] or (a["owner"] is None and g["kinds"][cid] == "fader"):
                continue
            # the box against the part (a disc for the round ones), 0.5 px slack
            nx, ny = max(a["l"] + 0.5, min(d["cx"], a["r"] - 0.5)), max(a["t"] + 0.5, min(d["cy"], a["b"] - 0.5))
            if d["shape"] == "circle":
                hit = ((nx - d["cx"]) ** 2 + (ny - d["cy"]) ** 2) ** 0.5 < d["w"] / 2
            else:
                hit = d["l"] < nx < d["r"] and d["t"] < ny < d["b"]
            assert not hit, f"{tag}: '{a['text']}' covers {cid}"


@pytest.mark.parametrize("name", list(PHONES))
def test_tap_beside_a_small_button_presses_it(name, chromium, webkit, base_url, auth_cookie):
    """10 px outside a small button's drawn edge, on its emptiest side, is still
    that button: the tap reaches its widget (recorded after the board's own
    listeners) with the button's action."""
    spec = PHONES[name]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    try:
        page = _open_board(ctx, base_url, spec["insets"])
        g = page.evaluate(GEO)
        page.evaluate(RECORD)
        drawn, kinds = g["drawn"], g["kinds"]
        small = [cid for cid, k in kinds.items() if k == "button"]
        probes, crowded = {}, []
        for cid in small:
            d = drawn[cid]
            sec = g["secs"][d["section"]]
            best = None
            for x, y in ((d["l"] - 10, d["cy"]), (d["r"] + 10, d["cy"]), (d["cx"], d["t"] - 10), (d["cx"], d["b"] + 10)):
                if not (sec["l"] + 1 <= x < sec["r"] - 1 and sec["t"] + 1 <= y < sec["b"] - 1):
                    continue
                # clear of every other part by 1.5 px (sub-pixel edges round either way)
                if any(in_shape(x + dx, y + dy, o) for oid, o in drawn.items() if oid != cid
                       for dx, dy in ((0, 0), (1.5, 0), (-1.5, 0), (0, 1.5), (0, -1.5))):
                    continue
                mine = edge_distance(x, y, d)
                other = min(edge_distance(x, y, o) for oid, o in drawn.items()
                            if oid != cid and kinds[oid] not in BIG and o["section"] == d["section"])
                if other - mine > 2 and (best is None or other - mine > best[2]):
                    best = (x, y, other - mine)
            if best:
                probes[cid] = best[:2]
            else:
                crowded.append(cid)
        # a button with another part (or the section edge) within ~12 px on every
        # side has no empty side to probe (pad mode buttons, BEAT, the CUEs
        # between their knobs and faders): the rest, most of them, all answer
        assert len(probes) >= len(small) * 0.6, (len(probes), len(small), crowded)
        for cid, (x, y) in probes.items():
            page.touchscreen.tap(x, y)
            assert took(page) == [cid], f"{name}: 10 px beside {cid} at ({x:.1f}, {y:.1f})"
            page.wait_for_timeout(20)
        print(f"{name}: {len(probes)} buttons pressed from 10 px outside; no empty side: {crowded}")
        # the actions arrived (PLAY or IN 10 px outside its edge plays or sets the loop in)
        page.evaluate("() => { window.cabine.boardLog.length = 0; }")
        cid, action = next((c, a) for c, a in (("d2-play", "deck.playPause"), ("d2-in", "deck.loopIn"), ("d1-in", "deck.loopIn"))
                           if c in probes)
        x, y = probes[cid]
        page.touchscreen.tap(x, y)
        assert [e["action"] for e in log(page)] == [action]
        assert not page.errors, page.errors
    finally:
        ctx.close()


@pytest.mark.parametrize("name", list(PHONES))
def test_tap_between_two_controls_goes_to_the_nearer(name, chromium, webkit, base_url, auth_cookie):
    spec = PHONES[name]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    try:
        page = _open_board(ctx, base_url, spec["insets"])
        g = page.evaluate(GEO)
        page.evaluate(RECORD)
        pairs = [("d1-in", "d1-out"), ("d1-call-prev", "d1-call-next"), ("d1-mode-hotcue", "d1-mode-padfx1"),
                 ("fx-beat-down", "fx-beat-up"), ("ch1-hi", "ch1-mid"), ("d2-4beat", "d2-call-prev"),
                 ("d1-pad1", "d1-pad2"), ("load1", "ch1-trim"), ("d2-shift", "d2-cue"), ("ch2-cue", "ch2-cfx"),
                 ("d2-mode-sampler", "d2-pad4"), ("ch1-cue", "phones-mix")]
        for a, b in pairs:
            da, db = g["drawn"][a], g["drawn"][b]
            # exactly between the two drawn outlines on the line between the
            # centres, then 2 px to either side: the nearer one takes it
            line = [(da["cx"] + (db["cx"] - da["cx"]) * t / 400, da["cy"] + (db["cy"] - da["cy"]) * t / 400) for t in range(401)]
            mid = min(line, key=lambda p: abs(edge_distance(*p, da) - edge_distance(*p, db)))
            L = ((db["cx"] - da["cx"]) ** 2 + (db["cy"] - da["cy"]) ** 2) ** 0.5
            ux, uy = (db["cx"] - da["cx"]) / L, (db["cy"] - da["cy"]) / L
            for k, want in ((-2, a), (2, b)):
                x, y = mid[0] + ux * k, mid[1] + uy * k
                page.touchscreen.tap(x, y)
                assert took(page) == [want], f"{name}: {k:+} px from the middle between {a} and {b}"
                page.wait_for_timeout(20)
        assert not page.errors, page.errors
    finally:
        ctx.close()


@pytest.mark.parametrize("name", list(PHONES))
def test_zones_never_take_the_jog_or_a_fader(name, chromium, webkit, base_url, auth_cookie):
    """The jog's rim and the faders' edges stay theirs, right next to grown zones."""
    import math
    spec = PHONES[name]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    try:
        page = _open_board(ctx, base_url, spec["insets"])
        g = page.evaluate(GEO)
        page.evaluate(RECORD)
        d = g["drawn"]
        pts = []
        for deck in (1, 2):
            j = d[f"d{deck}-jog"]
            for ang in (200, 225, 250, 270, 290, 315, 340, 20, 60, 90, 120, 160):
                a = math.radians(ang)
                pts.append((f"d{deck}-jog", j["cx"] + (j["w"] / 2 - 2.5) * math.cos(a), j["cy"] - (j["w"] / 2 - 2.5) * math.sin(a)))
        for cid in ("d1-tempo", "d2-tempo", "ch1-fader", "ch2-fader", "xfader"):
            f = d[cid]
            for x, y in ((f["l"] + 1.5, f["cy"]), (f["r"] - 1.5, f["cy"]), (f["cx"], f["t"] + 1.5), (f["cx"], f["b"] - 1.5),
                         (f["l"] + 1.5, f["t"] + 1.5), (f["r"] - 1.5, f["b"] - 1.5)):
                pts.append((cid, x, y))
        for cid, x, y in pts:
            assert page.evaluate("([x, y]) => window.cabine.board.hitTest(x, y)", [x, y]) == cid, (cid, x, y)
            page.touchscreen.tap(x, y)
            assert took(page) == [cid], f"{name}: ({x:.1f}, {y:.1f}) inside {cid}"
            page.wait_for_timeout(15)
        # the jog's box corner is not the jog (its disc is): a neighbour's zone or nothing
        j = d["d1-jog"]
        page.touchscreen.tap(j["l"] + 2, j["b"] - 2)
        assert took(page) != ["d1-jog"]
        assert not page.errors, page.errors
    finally:
        ctx.close()


def test_knob_drag_from_its_zone_is_a_knob_drag(phone):
    """A drag that starts in a knob's enlarged zone, outside the drawn knob,
    behaves exactly like one on the knob: same values, capture kept."""
    page = phone["page"]
    g = page.evaluate(GEO)
    for cid in ("ch1-hi", "fx-level", "d1-in"):
        d = g["drawn"][cid]
        p = zone_point(page, cid, d)
        assert p and p["k"] >= 6, f"{cid}: a zone point well outside the drawn part {p}"
        assert not in_shape(p["x"], p["y"], d)
    hi = g["drawn"]["ch1-hi"]
    p = zone_point(page, "ch1-hi", hi)
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")
    page.mouse.move(p["x"], p["y"])
    page.mouse.down()
    page.mouse.move(p["x"], p["y"] - 20, steps=4)
    page.mouse.move(p["x"] + 80, p["y"] - 60, steps=8)        # across other zones: still the knob
    page.mouse.up()
    entries = log(page)
    assert entries and {e["id"] for e in entries} == {"ch1-hi"}, (p, entries)
    assert abs(entries[-1]["value"] - (0.5 + 60 / 180)) < 0.02, entries[-1]
    # a double tap in the zone resets it, as on the knob
    page.touchscreen.tap(p["x"], p["y"])
    page.wait_for_timeout(60)
    page.touchscreen.tap(p["x"], p["y"])
    assert log(page)[-1]["value"] == 0.5


def test_multitouch_shift_pad_and_fader(galaxy):
    page, ctx = galaxy
    b = rects(page)
    pad1, shift1, fader2 = b["d1-pad1"], b["d1-shift"], b["ch2-fader"]
    # set hot cue A on deck 1 first: pad 1 lights
    page.touchscreen.tap(pad1["cx"], pad1["cy"])
    assert lit(page, "d1-pad1")
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")

    cdp = ctx.new_cdp_session(page)
    # SHIFT held in its enlarged zone, outside the drawn key (v2 hit zones)
    zp = zone_point(page, "d1-shift", page.evaluate(GEO)["drawn"]["d1-shift"])
    assert zp and zp["k"] >= 6, zp
    sx, sy = zp["x"], zp["y"]
    fx, fy = fader2["cx"], fader2["t"] + 8
    touch(cdp, "touchStart", {0: (sx, sy)})                                   # SHIFT held on deck 1
    touch(cdp, "touchStart", {0: (sx, sy), 1: (fx, fy)})                      # thumb on the deck 2 fader
    for k in range(1, 4):
        touch(cdp, "touchMove", {0: (sx, sy), 1: (fx, fy + 6 * k)})
    touch(cdp, "touchStart", {0: (sx, sy), 1: (fx, fy + 18), 2: (pad1["cx"], pad1["cy"])})  # pad 1 tap
    for k in range(4, 7):
        touch(cdp, "touchMove", {0: (sx, sy), 1: (fx, fy + 6 * k), 2: (pad1["cx"], pad1["cy"])})
    touch(cdp, "touchEnd", {})
    entries = log(page)
    acts = [(e["action"], e["deck"]) for e in entries]
    assert acts[0] == ("deck.setShift", 1) and entries[0]["value"] is True, acts
    clear = [i for i, e in enumerate(entries) if e["action"] == "deck.shiftHotCue"]
    assert len(clear) == 1 and entries[clear[0]]["value"] == 0 and entries[clear[0]]["deck"] == 1, entries
    assert not any(e["action"] == "deck.hotCue" for e in entries), "SHIFT + pad clears, it does not call"
    faders = [i for i, e in enumerate(entries) if e["action"] == "mixer.setFader"]
    assert all(entries[i]["deck"] == 2 for i in faders)
    assert any(i < clear[0] for i in faders) and any(i > clear[0] for i in faders), \
        "the deck 2 fader kept moving around the SHIFT + pad tap"
    values = [entries[i]["value"] for i in faders]
    assert values == sorted(values, reverse=True) and values[-1] < 1, values   # pulled down
    assert ("deck.setShift", 1) == acts[-1] and entries[-1]["value"] is False, "SHIFT released last"
    assert not lit(page, "d1-pad1"), "hot cue A cleared"


def test_finger_slides_off_knob_keeps_capture(phone):
    page = phone["page"]
    b = rects(page)
    knob, jog = b["ch1-hi"], b["d1-jog"]
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")
    page.mouse.move(knob["cx"], knob["cy"])
    page.mouse.down()
    page.mouse.move(knob["cx"], knob["cy"] - 20, steps=4)
    # slide far off the knob, across the jog and the deck: still the knob's
    page.mouse.move(jog["cx"], knob["cy"] - 40, steps=8)
    page.mouse.move(jog["l"] + 5, knob["cy"] - 60, steps=8)
    page.mouse.up()
    entries = log(page)
    assert entries, "the knob moved"
    assert {e["id"] for e in entries} == {"ch1-hi"}, {e["id"] for e in entries}
    assert all(e["action"] == "mixer.setEq" for e in entries)
    assert abs(entries[-1]["value"] - (0.5 + 60 / 180)) < 0.02, entries[-1]
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")
    page.mouse.move(jog["cx"], jog["cy"])
    page.mouse.move(jog["cx"] + 40, jog["cy"] + 40, steps=4)
    assert log(page) == [], "after the lift the knob holds nothing"


def test_drawn_only_shows_not_yet(phone):
    page = phone["page"]
    b = rects(page)
    toast = page.locator(".cab-board-toast")
    expect(toast).to_be_hidden()
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")
    for cid in ("mic-level", "smart-cfx", "smart-fader", "d2-mode-padfx1"):
        page.touchscreen.tap(b[cid]["cx"], b[cid]["cy"])
        expect(toast).to_be_visible()
        expect(toast).to_have_text("not yet")
    page.wait_for_timeout(1400)
    expect(toast).to_be_hidden()
    assert log(page) == [], "drawn-only controls drive nothing"
    # a working control does not say it
    page.touchscreen.tap(b["d1-play"]["cx"], b["d1-play"]["cy"])
    expect(toast).to_be_hidden()
    assert [e["action"] for e in log(page)] == ["deck.playPause"]
    assert lit(page, "d1-play")


def test_no_page_scroll_or_zoom(phone):
    page = phone["page"]
    b = rects(page)
    state = "() => ({scale: window.visualViewport.scale, x: window.scrollX, y: window.scrollY, ox: window.visualViewport.offsetLeft, oy: window.visualViewport.offsetTop})"
    jog = b["d1-jog"]
    # what reached the page: the board must have cancelled every touchmove (no
    # scroll, no pinch) and every multi-finger touchstart (a bubbling listener
    # on window runs after the board's own handler, so it sees defaultPrevented)
    page.evaluate("""() => { window.__touches = [];
        for (const t of ['touchstart', 'touchmove'])
            window.addEventListener(t, e => window.__touches.push([t, e.touches.length, e.defaultPrevented]), {passive: true});
        const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
        document.querySelector('.cab-board').dispatchEvent(ev);
        window.__contextmenu = ev.defaultPrevented; }""")
    assert page.evaluate("() => window.__contextmenu") is True, "long press menu is cancelled"
    # double tap on the board (no double-tap zoom), a wheel, a drag across the panel
    for target in ("d1-jog", "ch1-mid", "fx-level"):
        x, y = b[target]["cx"], b[target]["cy"]
        page.touchscreen.tap(x, y)
        page.wait_for_timeout(60)
        page.touchscreen.tap(x, y)
    page.mouse.move(jog["cx"], jog["cy"])
    page.mouse.wheel(0, 400)
    if phone["engine"] == "chromium":
        cdp = phone["ctx"].new_cdp_session(page)
        cx, cy = b["ch1-low"]["cx"], b["ch1-low"]["cy"]
        touch(cdp, "touchStart", {0: (cx - 10, cy), 1: (cx + 10, cy)})            # pinch out
        for k in range(1, 8):
            touch(cdp, "touchMove", {0: (cx - 10 - 12 * k, cy), 1: (cx + 10 + 12 * k, cy)})
        touch(cdp, "touchEnd", {})
        cdp.send("Input.synthesizePinchGesture", {"x": cx, "y": cy, "scaleFactor": 2.5,
                                                   "gestureSourceType": "touch"})
        cdp.send("Input.synthesizeScrollGesture", {"x": cx, "y": cy, "yDistance": -200,
                                                    "gestureSourceType": "touch"})
    page.wait_for_timeout(300)
    if phone["engine"] == "chromium":
        seen = page.evaluate("() => window.__touches")
        moves = [t for t in seen if t[0] == "touchmove"]
        multi = [t for t in seen if t[0] == "touchstart" and t[1] > 1]
        assert moves and all(t[2] for t in moves), seen
        assert multi and all(t[2] for t in multi), seen
    # headless engines do not zoom on synthesized pinches even on a zoomable
    # page, so this is the floor, not the proof (the iPhone checklist is)
    s = page.evaluate(state)
    assert s == {"scale": 1, "x": 0, "y": 0, "ox": 0, "oy": 0}, s
    meta = page.evaluate("() => document.querySelector('meta[name=viewport]').content")
    assert "user-scalable=no" in meta and "maximum-scale=1" in meta
    css = page.evaluate("""() => { const s = getComputedStyle(document.querySelector('.cab-board-screen'));
        return [s.touchAction, s.overscrollBehaviorY || s.overscrollBehavior, s.webkitUserSelect || s.userSelect]; }""")
    assert css[0] == "none" and css[1] == "none" and css[2] == "none", css


@pytest.mark.parametrize("engine", ["webkit", "chromium"])
def test_portrait_shows_turn_sideways(engine, chromium, webkit, base_url, auth_cookie):
    browser = chromium if engine == "chromium" else webkit
    ctx = _context(browser, engine, 390, 844, auth_cookie)
    try:
        page = _open_board(ctx, base_url)
        card = page.locator(".cab-turn")
        expect(card).to_be_visible()
        expect(card.locator(".cab-turn-h")).to_have_text("Turn sideways")
        expect(page.locator(".cab-board")).to_be_hidden()
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"portrait-turn-{engine}.png"))
        # turning the phone: the board appears, laid out for landscape
        page.set_viewport_size({"width": 844, "height": 390})
        expect(page.locator(".cab-board")).to_be_visible()
        expect(card).to_be_hidden()
        page.set_viewport_size({"width": 390, "height": 844})
        expect(card).to_be_visible()
        # the crate is reachable from the card
        card.locator(".cab-turn-caixa").click()
        expect(page.locator(".cab-crate")).to_be_visible()
        assert page.evaluate("() => window.cabine.screen") == "crate"
        assert not page.errors, page.errors
    finally:
        ctx.close()


@pytest.mark.parametrize("name", ["iphone-safari-webkit", "galaxy-chromium"])
def test_panels_keep_caixa_rec_and_browse(name, chromium, webkit, base_url, auth_cookie):
    """The real board (engine bindings) in the panels layout: caixa at the top
    of the left panel slot, REC at the top of the right one, and BROWSE opens
    the track list over deck 1 without covering BROWSE or LOAD."""
    spec = PHONES[name]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    try:
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base_url}/cabine")
        page.wait_for_function("() => window.cabine && window.cabine.store")
        page.evaluate("() => window.cabine.ready")
        if spec["insets"]:
            page.evaluate("""(i) => { const s = document.documentElement.style;
                s.setProperty('--cab-inset-left', i.left + 'px'); s.setProperty('--cab-inset-right', i.right + 'px');
                s.setProperty('--cab-inset-bottom', i.bottom + 'px'); }""", spec["insets"])
        page.evaluate("() => window.cabine.showBoard({layout: 'panels'})")
        page.wait_for_function("() => window.cabine.strip")
        g = page.evaluate(GEO)
        s0, s1 = g["slots"]
        caixa, rec = page.locator(".cab-board-caixa"), page.locator(".cab-strip-rec")
        expect(caixa).to_be_visible()
        expect(rec).to_be_visible()
        cb, rb = caixa.bounding_box(), rec.bounding_box()
        assert s0["x"] - 0.5 <= cb["x"] and cb["x"] + cb["width"] <= s0["x"] + s0["w"] + 0.5 and cb["height"] >= 43.5, (cb, s0)
        assert s1["x"] - 0.5 <= rb["x"] and rb["x"] + rb["width"] <= s1["x"] + s1["w"] + 0.5 and rb["height"] >= 43.5, (rb, s1)
        strip = page.locator(".cab-board-strip")
        assert page.evaluate("() => getComputedStyle(document.querySelector('.cab-board-strip')).visibility") == "hidden"
        b = g["drawn"]["browse"]
        page.touchscreen.tap(b["cx"], b["cy"])
        page.wait_for_function("() => window.cabine.strip.isBrowseOpen", timeout=20_000)
        page.wait_for_function("() => getComputedStyle(document.querySelector('.cab-board-strip')).visibility === 'visible'")
        sb = strip.bounding_box()
        mixer = g["secs"]["mixer"]
        assert sb["x"] + sb["width"] <= mixer["l"] + 0.5, "the list never covers the mixer (BROWSE, LOAD)"
        for cid in ("browse", "load1", "load2"):
            d = g["drawn"][cid]
            hit = page.evaluate("([x, y]) => document.elementFromPoint(x, y).closest('.cab-board-strip') === null", [d["cx"], d["cy"]])
            assert hit, f"{cid} reachable with the list open"
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"panels-browse-{name}-{spec['w']}x{spec['h']}.png"))
        page.touchscreen.tap(b["cx"], b["cy"])
        page.wait_for_function("() => !window.cabine.strip.isBrowseOpen")
        page.wait_for_function("() => getComputedStyle(document.querySelector('.cab-board-strip')).visibility === 'hidden'")
        caixa.click()
        expect(page.locator(".cab-crate")).to_be_visible()
        assert not errors, errors
    finally:
        ctx.close()


PHONE_TARGETS = {"iphone-webkit": 44, "iphone-safari-webkit": 38}


@pytest.mark.parametrize("name", list(PHONE_TARGETS))
def test_phone_deck_zones_reach_the_target(name, chromium, webkit, base_url, auth_cookie):
    """The phone layout's decks: every small part answers a touch across at
    least 44 px (844 x 390) or 38 px (844 x 330) through its centre, both ways,
    checked with real taps at the zone's far edges."""
    spec = PHONES[name]
    target = PHONE_TARGETS[name]
    ctx = _context(webkit, "webkit", spec["w"], spec["h"], auth_cookie)
    try:
        page = _open_board(ctx, base_url, spec["insets"])
        assert page.evaluate("() => window.cabine.board.layoutMode") == "phone"
        g = page.evaluate(GEO)
        page.evaluate(RECORD)
        small = [cid for cid, k in g["kinds"].items() if k not in BIG and g["drawn"][cid]["section"] != "mixer"]
        assert len(small) == 2 * 21
        ext = page.evaluate("""(ids) => { const b = window.cabine.board, geo = ${GEO};
            return Object.fromEntries(ids.map(id => { const d = geo.drawn[id];
                const walk = (dx, dy) => { let k = 0; while (k < 200 && b.hitTest(d.cx + dx * (k + 0.5), d.cy + dy * (k + 0.5)) === id) k += 0.5; return k; };
                return [id, {l: walk(-1, 0), r: walk(1, 0), t: walk(0, -1), b: walk(0, 1)}]; })); }""".replace("${GEO}", "(" + GEO + ")()"), small)
        for cid in small:
            e, d = ext[cid], g["drawn"][cid]
            assert e["l"] + e["r"] >= target - 1 and e["t"] + e["b"] >= target - 1, f"{name}: {cid} zone {e}"
            # real taps 2 px inside each far edge
            for x, y in ((d["cx"] - e["l"] + 2, d["cy"]), (d["cx"] + e["r"] - 2, d["cy"]),
                         (d["cx"], d["cy"] - e["t"] + 2), (d["cx"], d["cy"] + e["b"] - 2)):
                page.touchscreen.tap(x, y)
                assert took(page) == [cid], f"{name}: {cid} at ({x:.1f}, {y:.1f})"
            page.wait_for_timeout(10)
        SHOTS.mkdir(parents=True, exist_ok=True)
        assert not page.errors, page.errors
    finally:
        ctx.close()


@pytest.mark.parametrize("name", ["iphone-safari-webkit", "galaxy-chromium"])
def test_phone_band_keeps_caixa_rec_and_browse(name, chromium, webkit, base_url, auth_cookie):
    """The real board in the phone layout: the waveform band on top with caixa
    at its left end and REC at its right end; BROWSE opens the list in the band."""
    spec = PHONES[name]
    browser = chromium if spec["engine"] == "chromium" else webkit
    ctx = _context(browser, spec["engine"], spec["w"], spec["h"], auth_cookie)
    try:
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base_url}/cabine")
        page.wait_for_function("() => window.cabine && window.cabine.store")
        page.evaluate("() => window.cabine.ready")
        if spec["insets"]:
            page.evaluate("""(i) => { const s = document.documentElement.style;
                s.setProperty('--cab-inset-left', i.left + 'px'); s.setProperty('--cab-inset-right', i.right + 'px');
                s.setProperty('--cab-inset-bottom', i.bottom + 'px'); }""", spec["insets"])
        page.evaluate("() => window.cabine.showBoard()")
        page.wait_for_function("() => window.cabine.strip")
        g = page.evaluate(GEO)
        band = page.locator(".cab-board-strip").bounding_box()
        caixa, rec = page.locator(".cab-board-caixa").bounding_box(), page.locator(".cab-strip-rec").bounding_box()
        expect(page.locator(".cab-strip-rec")).to_be_visible()
        assert band["y"] + band["height"] <= g["board"]["t"] + 0.5, "the band sits over the board"
        for r in (caixa, rec):
            assert band["y"] - 0.5 <= r["y"] and r["y"] + r["height"] <= band["y"] + band["height"] + 0.5, (r, band)
        assert caixa["x"] < band["x"] + 0.3 * band["width"] and rec["x"] > band["x"] + 0.7 * band["width"], (caixa, rec, band)
        b = g["drawn"]["browse"]
        page.touchscreen.tap(b["cx"], b["cy"])
        page.wait_for_function("() => window.cabine.strip.isBrowseOpen", timeout=20_000)
        lst = page.locator(".cab-strip-browse").bounding_box()
        assert band["y"] - 0.5 <= lst["y"] and lst["y"] + lst["height"] <= band["y"] + band["height"] + 0.5, (lst, band)
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"phone-browse-{name}-{spec['w']}x{spec['h']}.png"))
        page.touchscreen.tap(b["cx"], b["cy"])
        page.wait_for_function("() => !window.cabine.strip.isBrowseOpen")
        page.locator(".cab-board-caixa").click()
        expect(page.locator(".cab-crate")).to_be_visible()
        assert not errors, errors
    finally:
        ctx.close()
