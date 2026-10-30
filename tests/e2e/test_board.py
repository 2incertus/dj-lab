"""A Cabine board (Task 9, Cabine v2 Task V1): the FLX4 top panel on a
landscape phone, driven by the demo bindings (showBoard({demo: true}): every
action logged in window.cabine.boardLog, no audio; Task 10's engine bindings
are tested in test_play.py).

Three phones: Mathias's iPhone in WebKit, 844 x 390 (installed app),
844 x 330 (Safari with its landscape bars) and 844 x 300 (a browser with its
tab bar, his v3 screenshot; Task V4), with the iPhone's
safe-area padding emulated through the --cab-inset-* CSS variables (WebKit on
Linux has no notch, so env() reads 0), and the Galaxy, 760 x 360 in Chromium
with touch. Multi-touch goes through CDP Input.dispatchTouchEvent, so it is
Chromium only.

v2: the default layout is "phone" (a slim waveform band on top, the decks
re-proportioned for a phone, the mixer at the panel's proportions; "panels",
"spread" and "exact" stay for comparison). Small parts are drawn bigger and
answer in hit zones larger than what is drawn (ui/board-layout.js hitMap,
split by the nearest drawn outline; in phone a channel knob answers across its
whole row), resolved by their section and handed to the widget.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

SHOTS = Path.home() / "cabine-shots" / "v4"
XFADER_CLEAR_PX = 34
# the iPhone's left inset when the Dynamic Island is on the left: more than the
# 47 px fallback, so the test proves the inset is read, not just the fallback
IPHONE_INSETS = {"left": 59, "right": 47, "bottom": 21}

PHONES = {
    "iphone-webkit": {"engine": "webkit", "w": 844, "h": 390, "insets": IPHONE_INSETS},
    "iphone-safari-webkit": {"engine": "webkit", "w": 844, "h": 330, "insets": {"left": 47, "right": 47, "bottom": 21}},
    # Task V4: a browser in landscape with its tab bar (the owner's v3 screenshot)
    "iphone-tabbar-webkit": {"engine": "webkit", "w": 844, "h": 300, "insets": {"left": 47, "right": 47, "bottom": 21}},
    "galaxy-chromium": {"engine": "chromium", "w": 760, "h": 360, "insets": None},
}
PANELS_TOP_PX = 6
# board-layout.test.js KNOWN_UNFIT: legends with no clear room at 844 x 300
KNOWN_UNFIT = {
    "phone 844x300": ("legend:21", "legend:22", "smart-fader:face"),
    "panels 844x300": ("d1-mode-beatjump:sub", "d2-mode-beatjump:sub", "d1-sync:face", "d2-sync:face",
                       *(f"d{d}-mode-{m}:face" for d in (1, 2) for m in ("hotcue", "beatjump", "sampler"))),
}


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
    if phone["layout"] == "phone":
        _check_deck_legends_inside(page, phone["name"])
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"board-{phone['name']}-{phone['layout']}-{w}x{h}.png"))


def _check_legends(page, g, phone):
    """Nothing clipped: every legend shown is at least 6 px, inside its section,
    its text inside its box, clear of the other legends and of every drawn part
    but its own (the tempo and channel marks sit in their fader's tick area)."""
    legs = page.evaluate("""() => [...document.querySelectorAll('.cab-board-lbl, .cab-board-sub, .cab-board-legend, .cab-board-face')]
        .filter(el => !el.hidden && el.offsetParent !== null && el.textContent.trim())
        .map(el => { const r = el.getBoundingClientRect(), ctl = el.closest('.cab-board-ctl');
            const part = el.dataset.legend !== undefined ? null : el.classList.contains('cab-board-face') ? 'face'
                : el.classList.contains('cab-board-sub') ? 'sub' : 'label';
            return {text: el.textContent.trim(), face: el.classList.contains('cab-board-face'),
                    key: part ? `${ctl ? ctl.dataset.id : ''}:${part}` : `legend:${el.dataset.legend}`,
                    owner: ctl ? ctl.dataset.id : el.dataset.on || null, sec: el.closest('[data-sec]').dataset.sec,
                    l: r.left, t: r.top, r: r.right, b: r.bottom,
                    px: parseFloat(getComputedStyle(el).fontSize), over: el.scrollWidth - el.clientWidth}; })""")
    assert len(legs) > 80, len(legs)
    tag = f"{phone['name']} {phone['layout']}"
    for a in legs:
        assert a["px"] >= 6 - 0.01, f"{tag}: '{a['text']}' at {a['px']} px"
        if phone["layout"] == "phone" and a["sec"] != "mixer":
            # Task V3: nothing in a phone deck under 7 px
            assert a["px"] >= 7 - 0.01, f"{tag}: deck legend '{a['text']}' at {a['px']} px"
        if a["face"]:
            continue
        sec = g["secs"][a["sec"]]
        assert sec["l"] - 0.5 <= a["l"] and a["r"] <= sec["r"] + 0.5 and sec["t"] - 0.5 <= a["t"] and a["b"] <= sec["b"] + 0.5, \
            f"{tag}: '{a['text']}' clipped {a}"
        assert a["over"] <= 1, f"{tag}: '{a['text']}' runs out of its box by {a['over']} px"
    if phone["layout"] not in ("panels", "phone"):
        return                                     # the old layouts keep their old crowding
    # the legends board-layout.test.js KNOWN_UNFIT lists (no clear room at
    # 844 x 300 in the mixer and in the panels decks, short before Task V4)
    known = KNOWN_UNFIT.get(f"{phone['layout']} {phone['w']}x{phone['h']}", ())
    shown = [a for a in legs if not a["face"] and a["key"] not in known]
    for i, a in enumerate(shown):
        for b in shown[i + 1:]:
            ov = min(a["r"], b["r"]) - max(a["l"], b["l"]), min(a["b"], b["b"]) - max(a["t"], b["t"])
            assert ov[0] <= 0.5 or ov[1] <= 0.5, f"{tag}: '{a['text']}' over '{b['text']}'"
        for cid, d in g["drawn"].items():
            # (a legend's owner: its part, or for 1/2X and 2X the CALL button it is printed on)
            if cid == a["owner"] or (a["owner"] is None and g["kinds"][cid] == "fader"):
                continue
            # the box against the part (a disc for the round ones), 0.5 px slack
            nx, ny = max(a["l"] + 0.5, min(d["cx"], a["r"] - 0.5)), max(a["t"] + 0.5, min(d["cy"], a["b"] - 0.5))
            if d["shape"] == "circle":
                hit = ((nx - d["cx"]) ** 2 + (ny - d["cy"]) ** 2) ** 0.5 < d["w"] / 2
            else:
                hit = d["l"] < nx < d["r"] and d["t"] < ny < d["b"]
            assert not hit, f"{tag}: '{a['text']}' covers {cid}"


def _check_deck_legends_inside(page, tag):
    """Task V4: no legend on a phone deck's button is clipped. Each legend
    printed on a button (its name, its face, its SHIFT legend, 1/2X and 2X):
    its box inside the button's, and its text as the browser sets it (a Range
    over its lines, so WebKit's own widths) no wider than the button's inside;
    on a round button inside its disc. The mode row's names at 8 px or more."""
    out = page.evaluate("""() => {
        const res = [];
        for (const el of document.querySelectorAll('.cab-board-sec-deck1 .cab-board-ctl, .cab-board-sec-deck2 .cab-board-ctl')) {
            const id = el.dataset.id, b = el.getBoundingClientRect(), round = el.classList.contains('cab-look-round') || el.classList.contains('cab-look-big');
            const legs = [...el.querySelectorAll(':scope > .cab-board-face, :scope > .cab-board-in')];
            for (const s of document.querySelectorAll(`.cab-board-in[data-on='${id}']`)) legs.push(s);
            for (const l of legs) {
                if (l.hidden || !l.textContent.trim() || l.offsetParent === null) continue;
                const r = l.getBoundingClientRect();
                const range = document.createRange(); range.selectNodeContents(l);
                const lines = [...range.getClientRects()].filter(q => q.width > 0.5);
                const tl = Math.min(...lines.map(q => q.left)), tr = Math.max(...lines.map(q => q.right));
                res.push({id, text: l.textContent.trim(), face: l.classList.contains('cab-board-face'), round,
                    px: parseFloat(getComputedStyle(l).fontSize),
                    b: {l: b.left, t: b.top, r: b.right, bt: b.bottom}, box: {l: r.left, t: r.top, r: r.right, b: r.bottom},
                    text_l: tl, text_r: tr, text_h: lines.length ? Math.max(...lines.map(q => q.bottom)) - Math.min(...lines.map(q => q.top)) : 0});
            }
        }
        return res;
    }""")
    assert len(out) >= 2 * 20, (tag, len(out))
    for a in out:
        b = a["b"]
        what = f"{tag}: '{a['text']}' on {a['id']}"
        # the box: a face's box is as wide as its button
        assert b["t"] - 0.5 <= a["box"]["t"] and a["box"]["b"] <= b["bt"] + 0.5, f"{what}: box {a['box']} in {b}"
        assert b["l"] - 0.5 <= a["box"]["l"] and a["box"]["r"] <= b["r"] + 0.5, f"{what}: box {a['box']} in {b}"
        # the text as set: inside the bezel (1 px), centred
        cx = (b["l"] + b["r"]) / 2
        half = max(cx - a["text_l"], a["text_r"] - cx)
        if a["round"]:
            r = (b["r"] - b["l"]) / 2 - 1
            cy = (b["t"] + b["bt"]) / 2
            far = max(abs(a["box"]["t"] - cy), abs(a["box"]["b"] - cy))
            room = (r * r - far * far) ** 0.5 if far < r else 0
            assert half <= room + 0.75, f"{what}: text half-width {half:.1f} on a disc chord {room:.1f}"
        else:
            assert half <= (b["r"] - b["l"]) / 2 - 1 + 0.5, f"{what}: text {a['text_r'] - a['text_l']:.1f} wide on {b['r'] - b['l']:.1f}"
        if a["id"][3:].startswith("mode-"):
            assert a["px"] >= (8 if a["face"] else 7) - 0.01, f"{what} at {a['px']} px"


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
        # between their knobs and faders; since Task V3 the phone decks' loop
        # row, drawn nearly as big as its zones): the rest all answer
        assert len(probes) >= len(small) * 0.5, (len(probes), len(small), crowded)
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
    path = [(p["x"], p["y"])] + [(p["x"], p["y"] - 5 * k) for k in range(1, 5)] \
        + [(p["x"] + 10 * k, p["y"] - 20 - 5 * k) for k in range(1, 9)]          # across other zones: still the knob
    if phone["engine"] == "chromium":
        # a real touch (CDP), as a thumb does it
        cdp = phone["ctx"].new_cdp_session(page)
        touch(cdp, "touchStart", {0: path[0]})
        for pt in path[1:]:
            touch(cdp, "touchMove", {0: pt})
        touch(cdp, "touchEnd", {})
    else:
        page.mouse.move(*path[0])
        page.mouse.down()
        for pt in path[1:]:
            page.mouse.move(*pt)
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


# Task V3 (deck buttons bigger on mobile), Task V4 (mode row and pads back
# toward the FLX4): per viewport, every deck hit zone (the pads' and the mode
# row's their own), drawn buttons (short side), CUE and PLAY, pads (short
# side), the jog. At 844 x 390 the loop row's zones are a sixth of the deck
# wide (board-layout.test.js phone_390_shortfalls_are_the_decks_width); at
# 844 x 300 the jog is what gives.
PHONE_TARGETS = {
    "iphone-webkit": {"zone": 48, "loop_zone": 46, "button": 44, "cue": 52, "pad": 40, "pad_zone": 40, "mode_zone": 32, "jog": 140},
    "iphone-safari-webkit": {"zone": 44, "loop_zone": 44, "button": 40, "cue": 46, "pad": 36, "pad_zone": 40, "mode_zone": 32, "jog": 110},
    "iphone-tabbar-webkit": {"zone": 44, "loop_zone": 44, "button": 40, "cue": 46, "pad": 36, "pad_zone": 40, "mode_zone": 32, "jog": 80},
}
LOOP_ROW = ("in", "out", "4beat", "call-prev", "call-next", "sync")


@pytest.mark.parametrize("name", list(PHONE_TARGETS))
def test_phone_deck_zones_reach_the_target(name, chromium, webkit, base_url, auth_cookie):
    """The phone layout's decks with the iPhone's 47 px side insets: every
    small part answers a touch across the target through its centre, both
    ways, checked with real taps at the zone's far edges; every button, CUE
    and PLAY, the pads and the jog are drawn at their target size."""
    spec = PHONES[name]
    target = PHONE_TARGETS[name]
    ctx = _context(webkit, "webkit", spec["w"], spec["h"], auth_cookie)
    try:
        page = _open_board(ctx, base_url, {"left": 47, "right": 47, "bottom": 21})
        assert page.evaluate("() => window.cabine.board.layoutMode") == "phone"
        g = page.evaluate(GEO)
        page.evaluate(RECORD)
        boxes = rects(page)
        small = [cid for cid, k in g["kinds"].items() if k not in BIG and g["drawn"][cid]["section"] != "mixer"]
        assert len(small) == 2 * 21
        ext = page.evaluate("""(ids) => { const b = window.cabine.board, geo = ${GEO};
            return Object.fromEntries(ids.map(id => { const d = geo.drawn[id];
                const walk = (dx, dy) => { let k = 0; while (k < 200 && b.hitTest(d.cx + dx * (k + 0.5), d.cy + dy * (k + 0.5)) === id) k += 0.5; return k; };
                return [id, {l: walk(-1, 0), r: walk(1, 0), t: walk(0, -1), b: walk(0, 1)}]; })); }""".replace("${GEO}", "(" + GEO + ")()"), small)
        for cid in small:
            e, d = ext[cid], g["drawn"][cid]
            part = cid[3:]
            pad = g["kinds"][cid] == "pad"
            zw = target["loop_zone"] if part in LOOP_ROW else target["pad_zone"] if pad else target["zone"]
            zh = target["pad_zone"] if pad else target["mode_zone"] if part.startswith("mode-") else target["zone"]
            assert e["l"] + e["r"] >= zw - 1 and e["t"] + e["b"] >= zh - 1, f"{name}: {cid} zone {e}"
            # drawn, as the page lays it out
            bx = boxes[cid]
            short = min(bx["r"] - bx["l"], bx["b"] - bx["t"])
            want = target["pad"] if pad else target["cue"] if part in ("cue", "play") else 18 if part.startswith("mode-") else target["button"]
            assert short >= want - 0.6, f"{name}: {cid} drawn {short:.1f} px"
            # real taps 2 px inside each far edge
            for x, y in ((d["cx"] - e["l"] + 2, d["cy"]), (d["cx"] + e["r"] - 2, d["cy"]),
                         (d["cx"], d["cy"] - e["t"] + 2), (d["cx"], d["cy"] + e["b"] - 2)):
                page.touchscreen.tap(x, y)
                assert took(page) == [cid], f"{name}: {cid} at ({x:.1f}, {y:.1f})"
            page.wait_for_timeout(10)
        for deck in (1, 2):
            j = boxes[f"d{deck}-jog"]
            assert j["r"] - j["l"] >= target["jog"] - 0.6 and abs((j["r"] - j["l"]) - (j["b"] - j["t"])) < 0.6, j
            # Task V4: thin mode buttons over pads near square, PLAY's bottom on the pads'
            p1, m1, play = boxes[f"d{deck}-pad1"], boxes[f"d{deck}-mode-hotcue"], boxes[f"d{deck}-play"]
            ph, pw, mh = p1["b"] - p1["t"], p1["r"] - p1["l"], m1["b"] - m1["t"]
            assert 1.0 - 0.02 <= pw / ph <= 1.25 + 0.02, (name, pw, ph)
            assert mh <= max(0.5 * ph, 18) + 0.6, (name, mh, ph)
            assert abs(play["b"] - boxes[f"d{deck}-pad5"]["b"]) < 0.6, (name, play, boxes[f"d{deck}-pad5"])
        _check_deck_legends_inside(page, name)
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"phone-deck-targets-{name}-{spec['w']}x{spec['h']}.png"))
        assert not page.errors, page.errors
    finally:
        ctx.close()


@pytest.mark.parametrize("name", ["iphone-safari-webkit", "galaxy-chromium"])
def test_phone_band_keeps_caixa_rec_and_browse(name, chromium, webkit, base_url, auth_cookie):
    """The real board in the phone layout: the waveform band on top with caixa
    at its left end and REC at its right end; BROWSE opens the list over the
    mixer, under BROWSE and LOAD (Task V2: the band is two list rows tall)."""
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
        mixer = page.locator(".cab-board-sec-mixer").bounding_box()
        assert mixer["x"] - 0.5 <= lst["x"] and lst["x"] + lst["width"] <= mixer["x"] + mixer["width"] + 0.5, (lst, mixer)
        assert lst["y"] >= g["drawn"]["browse"]["b"] - 0.5 and lst["y"] + lst["height"] <= mixer["y"] + mixer["height"] + 0.5, lst
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"phone-browse-{name}-{spec['w']}x{spec['h']}.png"))
        page.touchscreen.tap(b["cx"], b["cy"])
        page.wait_for_function("() => !window.cabine.strip.isBrowseOpen")
        page.locator(".cab-board-caixa").click()
        expect(page.locator(".cab-crate")).to_be_visible()
        assert not errors, errors
    finally:
        ctx.close()


def test_a_tap_at_the_decks_top_edge_is_not_caixa(galaxy):
    """Regression: Chrome's touch adjustment moved a tap 2 to 4 px inside a
    deck's top edge onto caixa in the band above (it opened the crate). The
    board answers for itself: IN takes it, the board stays."""
    page, ctx = galaxy
    assert page.evaluate("() => window.cabine.board.layoutMode") == "phone"
    g = page.evaluate(GEO)
    page.evaluate(RECORD)
    top = g["secs"]["deck1"]["t"]
    for deck in (1, 2):
        d = g["drawn"][f"d{deck}-in"]
        for k in (2, 3, 4):
            page.touchscreen.tap(d["cx"], top + k)
            assert took(page) == [f"d{deck}-in"], f"deck {deck}: {k} px inside the top edge"
            page.wait_for_timeout(20)
    assert page.evaluate("() => window.cabine.screen") == "board"
    expect(page.locator(".cab-crate")).to_have_count(0)


def test_two_routers_shift_per_deck_and_a_mixer_knob(galaxy):
    """Thumbs on three sections at once: deck 1 SHIFT, a mixer knob being
    turned, deck 2 SHIFT. Each section's router keeps its own pointers, and
    SHIFT stays per deck. (CDP releases every point at once, so the second
    round holds deck 2's SHIFT only and taps a pad on each deck.)"""
    page, ctx = galaxy
    g = page.evaluate(GEO)
    d = g["drawn"]
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")
    cdp = ctx.new_cdp_session(page)
    s1, s2, k = (d["d1-shift"]["cx"], d["d1-shift"]["cy"]), (d["d2-shift"]["cx"], d["d2-shift"]["cy"]), d["ch2-mid"]
    kp = (k["cx"], k["cy"])
    shifts = "() => [window.cabine.board.shift(1), window.cabine.board.shift(2)]"
    touch(cdp, "touchStart", {0: s1})
    touch(cdp, "touchStart", {0: s1, 1: kp})
    for j in range(1, 4):
        touch(cdp, "touchMove", {0: s1, 1: (kp[0], kp[1] - 10 * j)})
    assert page.evaluate(shifts) == [True, False]
    touch(cdp, "touchStart", {0: s1, 1: (kp[0], kp[1] - 30), 2: s2})
    assert page.evaluate(shifts) == [True, True]
    for j in range(4, 7):
        touch(cdp, "touchMove", {0: s1, 1: (kp[0], kp[1] - 10 * j), 2: s2})
    touch(cdp, "touchEnd", {})
    assert page.evaluate(shifts) == [False, False]
    knob = [e for e in log(page) if e["id"] == "ch2-mid"]
    assert knob and abs(knob[-1]["value"] - (0.5 + 60 / 180)) < 0.02, knob[-1:]
    # deck 2's SHIFT held, the knob turning back down: a pad on deck 1 plays its
    # hot cue (no SHIFT there), a pad on deck 2 is SHIFT + pad
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")
    p1, p2 = d["d1-pad1"], d["d2-pad1"]
    touch(cdp, "touchStart", {2: s2})
    touch(cdp, "touchStart", {2: s2, 1: kp})
    touch(cdp, "touchMove", {2: s2, 1: (kp[0], kp[1] + 20)})
    touch(cdp, "touchStart", {2: s2, 1: (kp[0], kp[1] + 20), 3: (p1["cx"], p1["cy"])})
    assert page.evaluate(shifts) == [False, True]
    touch(cdp, "touchStart", {2: s2, 1: (kp[0], kp[1] + 20), 3: (p1["cx"], p1["cy"]), 4: (p2["cx"], p2["cy"])})
    touch(cdp, "touchEnd", {})
    acts = [(e["action"], e["deck"]) for e in log(page)]
    assert ("deck.hotCue", 1) in acts and ("deck.shiftHotCue", 2) in acts, acts
    assert ("deck.shiftHotCue", 1) not in acts and ("deck.hotCue", 2) not in acts, acts
    assert [e for e in log(page) if e["id"] == "ch2-mid"], "the knob turned in the same round"
    assert page.evaluate(shifts) == [False, False]


@pytest.mark.parametrize("ch", [1, 2])
def test_phone_knob_turns_from_its_rows_outer_end(ch, galaxy):
    """Ruling R3-v2: a channel knob answers across its whole row; a touch drag
    (CDP, a thumb) that starts at the row's outer end turns it."""
    page, ctx = galaxy
    for row, action in (("trim", "mixer.setTrim"), ("hi", "mixer.setEq"), ("low", "mixer.setEq"), ("cfx", "mixer.setCfx")):
        cid = f"ch{ch}-{row}"
        z = page.evaluate("(id) => { const b = window.cabine.board, r = b.board.getBoundingClientRect(), z = b.geometry().map.rowZone(id);"
                          " return z && {x: r.left + z.x, y: r.top + z.y, w: z.w, h: z.h}; }", cid)
        assert z, cid
        x = z["x"] + 2 if ch == 1 else z["x"] + z["w"] - 2
        y = z["y"] + z["h"] / 2
        assert page.evaluate("([x, y]) => window.cabine.board.hitTest(x, y)", [x, y]) == cid
        page.evaluate("() => { window.cabine.boardLog.length = 0; }")
        cdp = ctx.new_cdp_session(page)
        touch(cdp, "touchStart", {0: (x, y)})
        for j in range(1, 7):
            touch(cdp, "touchMove", {0: (x, y - 6 * j)})
        touch(cdp, "touchEnd", {})
        entries = log(page)
        assert entries and {e["id"] for e in entries} == {cid} and entries[-1]["action"] == action, (cid, entries)
        assert entries[-1]["value"] > 0.5 + 30 / 180, entries[-1]
