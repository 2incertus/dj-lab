"""A Cabine board (Task 9): the FLX4 top panel on a landscape phone, driven by
the demo bindings (every action logged in window.cabine.boardLog, no audio).

Two phones: Mathias's iPhone, 844 x 390 in WebKit with the iPhone's safe-area
padding emulated through the --cab-inset-* CSS variables (WebKit on Linux has
no notch, so env() reads 0), and the Galaxy, 760 x 360 in Chromium with touch.
Multi-touch goes through CDP Input.dispatchTouchEvent, so it is Chromium only.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

SHOTS = Path.home() / "cabine-shots" / "task9"
XFADER_CLEAR_PX = 34
# the iPhone's left inset when the Dynamic Island is on the left: more than the
# 47 px fallback, so the test proves the inset is read, not just the fallback
IPHONE_INSETS = {"left": 59, "right": 47, "bottom": 21}

PHONES = {
    "iphone-webkit": {"engine": "webkit", "w": 844, "h": 390, "insets": IPHONE_INSETS},
    "galaxy-chromium": {"engine": "chromium", "w": 760, "h": 360, "insets": None},
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


def _open_board(ctx, base_url, insets=None):
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
    page.evaluate("() => window.cabine.showBoard()")
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

def test_every_control_hittable(phone):
    page, w, h = phone["page"], phone["w"], phone["h"]
    ids = page.evaluate("async () => (await import('/static/cabine/flx4-map.js')).CONTROLS.map(c => c.id)")
    boxes = rects(page)
    assert sorted(boxes) == sorted(ids), "every control is drawn once"
    misses = page.evaluate("""(ids) => ids.filter(id => {
        const el = document.querySelector(`.cab-board [data-id='${id}']`);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || !hit.closest('.cab-board-ctl') || hit.closest('.cab-board-ctl').dataset.id !== id;
    })""", ids)
    assert misses == [], f"centers that do not hit their own control: {misses}"
    insets = phone["insets"] or {"left": 47, "right": 47, "bottom": 21}
    for cid, b in boxes.items():
        assert b["l"] >= insets["left"] - 0.5 and b["r"] <= w - insets["right"] + 0.5, f"{cid} in a side safe area"
        assert b["b"] <= h - insets["bottom"] + 0.5, f"{cid} in the home indicator zone"
    assert boxes["xfader"]["b"] <= h - XFADER_CLEAR_PX + 0.5, boxes["xfader"]
    # the strip area is reserved above the board, the caixa button inside it
    strip = page.evaluate("() => { const r = document.querySelector('.cab-board-strip').getBoundingClientRect(); return {b: r.bottom, l: r.left}; }")
    assert min(b["t"] for b in boxes.values()) >= strip["b"] - 0.5
    caixa = page.locator(".cab-board-caixa").bounding_box()
    assert caixa["x"] >= insets["left"] - 0.5 and caixa["y"] + caixa["height"] <= strip["b"]
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"board-{phone['name']}-{w}x{h}.png"))


def test_multitouch_shift_pad_and_fader(galaxy):
    page, ctx = galaxy
    b = rects(page)
    pad1, shift1, fader2 = b["d1-pad1"], b["d1-shift"], b["ch2-fader"]
    # set hot cue A on deck 1 first: pad 1 lights
    page.touchscreen.tap(pad1["cx"], pad1["cy"])
    assert lit(page, "d1-pad1")
    page.evaluate("() => { window.cabine.boardLog.length = 0; }")

    cdp = ctx.new_cdp_session(page)
    sx, sy = shift1["cx"], shift1["cy"]
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
