"""E2E fixtures: drive the dev server (dj-lab-dev) with Playwright on the host.

The PIN gate cookie is the PIN_HASH from ~/config/dj-lab.env, read at test
time and never written anywhere.
"""

import os
from pathlib import Path

import pytest

ENV_FILE = Path.home() / "config" / "dj-lab.env"


def _pin_hash() -> str:
    for line in ENV_FILE.read_text().splitlines():
        key, sep, val = line.strip().partition("=")
        if sep and key == "PIN_HASH":
            return val.strip().strip('"').strip("'")
    return ""


@pytest.fixture(scope="session")
def base_url():
    return os.environ.get("DJLAB_E2E_URL", "http://127.0.0.1:8137")


@pytest.fixture(scope="session")
def auth_cookie(base_url):
    return {"name": "dj_auth", "value": _pin_hash(), "url": base_url}


@pytest.fixture(scope="session")
def playwright_instance():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def chromium(playwright_instance):
    browser = playwright_instance.chromium.launch(
        args=["--autoplay-policy=no-user-gesture-required"])
    yield browser
    browser.close()


@pytest.fixture
def authed_context(chromium, auth_cookie):
    """A desktop Chromium context already past the PIN gate."""
    ctx = chromium.new_context(viewport={"width": 1400, "height": 900})
    ctx.add_cookies([auth_cookie])
    yield ctx
    ctx.close()


@pytest.fixture
def api(playwright_instance, base_url, auth_cookie):
    """An authed APIRequestContext for setup and cleanup calls."""
    req = playwright_instance.request.new_context(
        base_url=base_url,
        extra_http_headers={"Cookie": f"dj_auth={auth_cookie['value']}"})
    yield req
    req.dispose()


# ---- A Cabine engine fixtures ----------------------------------------------
#
# Click tracks generated into the worktree's gitignored sources/techno/, with
# analysis.json entries and grid sidecars, so the dev server lists, carries
# (MP3) and grids them like any pulled track. Never committed.

import array
import json as _json
import math
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[2]
TECHNO = ROOT / "sources" / "techno"
SR = 44100

CLICK_TRACKS = {
    # name: (bpm, first_beat_s, seconds)
    "cabine-e2e-click120.wav": (120.0, 0.25, 20.0),
    "cabine-e2e-click128.wav": (128.0, 0.1, 60.0),
}
LONG_TRACK = "cabine-e2e-long14.wav"      # click128 looped to 14 minutes
LONG_SECONDS = 840.0


def _write_clicks(path: Path, bpm: float, first: float, seconds: float) -> None:
    """Stereo 16-bit clicks: 1 kHz bursts with a 6 ms decay, louder on beat 1."""
    n = int(seconds * SR)
    data = array.array("h", bytes(4 * n))          # interleaved L R, zeros
    period = 60.0 / bpm
    click_len = int(0.03 * SR)
    beat = 0
    while True:
        t = first + beat * period
        start = int(round(t * SR))
        if start >= n:
            break
        amp = 0.9 if beat % 4 == 0 else 0.6
        for j in range(min(click_len, n - start)):
            v = int(amp * 32767 * math.exp(-j / (0.006 * SR)) * math.sin(2 * math.pi * 1000 * j / SR))
            data[2 * (start + j)] = v
            data[2 * (start + j) + 1] = v
        beat += 1
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def _grid_for(bpm: float, first: float) -> dict:
    return {"bpm": bpm, "first_beat_s": first, "downbeat_s": first, "beat_cv": 0.0,
            "reliable": True, "source": "e2e-fixture", "fixed": False}


@pytest.fixture(scope="session")
def cabine_tracks():
    """Generate the click fixtures (once) and register them in the crate."""
    TECHNO.mkdir(parents=True, exist_ok=True)
    specs = dict(CLICK_TRACKS)
    for name, (bpm, first, secs) in CLICK_TRACKS.items():
        p = TECHNO / name
        if not p.exists():
            _write_clicks(p, bpm, first, secs)
    long_p = TECHNO / LONG_TRACK
    if not long_p.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-stream_loop", "-1",
                        "-i", str(TECHNO / "cabine-e2e-click128.wav"), "-t", str(LONG_SECONDS),
                        "-c:a", "pcm_s16le", str(long_p)], check=True)
    bpm, first, _ = CLICK_TRACKS["cabine-e2e-click128.wav"]
    specs[LONG_TRACK] = (bpm, first, LONG_SECONDS)

    for name, (bpm, first, _secs) in specs.items():
        sidecar = TECHNO / (name + ".grid.json")
        sidecar.write_text(_json.dumps(_grid_for(bpm, first), indent=2))

    aj = ROOT / "analysis.json"
    entries = _json.loads(aj.read_text()) if aj.exists() else []
    have = {Path(str(e.get("file", ""))).name for e in entries}
    added = False
    for name, (bpm, _first, secs) in specs.items():
        if name in have:
            continue
        entries.append({"file": str(TECHNO / name), "duration_s": secs, "bpm": bpm,
                        "beat_cv": 0.0, "key": "A min", "camelot": "8A",
                        "note": "e2e fixture (A Cabine engine tests)"})
        added = True
    if added:                                   # append, never drop existing entries
        tmp = aj.with_name(aj.name + ".e2e.tmp")
        tmp.write_text(_json.dumps(entries, indent=1))
        tmp.replace(aj)
    return {"click120": "cabine-e2e-click120.wav", "click128": "cabine-e2e-click128.wav",
            "long14": LONG_TRACK, "grids": {n: _grid_for(b, f) for n, (b, f, _s) in specs.items()}}


@pytest.fixture(scope="session")
def carried(cabine_tracks, playwright_instance, base_url, auth_cookie):
    """Warm the server's carry MP3s (the 14-minute encode takes a while)."""
    req = playwright_instance.request.new_context(
        base_url=base_url,
        extra_http_headers={"Cookie": f"dj_auth={auth_cookie['value']}"})
    for key in ("click120", "click128", "long14"):
        r = req.get(f"/api/cabine/carry?file={cabine_tracks[key]}", timeout=300_000)
        assert r.ok, f"carry {key}: {r.status}"
    req.dispose()
    return cabine_tracks


@pytest.fixture
def proof_page(authed_context, base_url):
    """The gated engine proof page, ready for page.evaluate."""
    page = authed_context.new_page()
    page.goto(f"{base_url}/cabine/proof")
    page.wait_for_function("() => window.cabineProof !== undefined")
    yield page
    page.close()


# ---- A Cabine crate fixtures (Task 8) ------------------------------------------
#
# The crate tests need the dev container started with CABINE_FAKE_INTAKE=1
# (dev-env.md, "e2e container"): the intake search routes then answer from
# tests/fixtures/intake_fake.json and a pull writes a short click track.

CRATE_TRACKS = {
    # name: (bpm, first_beat_s, seconds); crate-a has a grid, nogrid has none
    "cabine-e2e-crate-a.wav": (125.0, 0.2, 10.0),
    "cabine-e2e-crate-nogrid.wav": (124.0, 0.15, 8.0),
}
CRATE_A_GRID = _grid_for(125.0, 0.2)
HOLD_MARKER = TECHNO / ".cabine-e2e-hold"
FAKE_PULLED = ("cabine-e2e__tool-126.wav",)


def _fake_intake_on() -> bool:
    try:
        env = subprocess.run(["docker", "inspect", "dj-lab-dev", "--format", "{{json .Config.Env}}"],
                             check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return False
    return "CABINE_FAKE_INTAKE=1" in _json.loads(env)


def _drop_analysis(names) -> None:
    aj = ROOT / "analysis.json"
    if not aj.exists():
        return
    entries = _json.loads(aj.read_text())
    keep = [e for e in entries if Path(str(e.get("file", ""))).name not in names]
    if len(keep) != len(entries):
        tmp = aj.with_name(aj.name + ".e2e.tmp")
        tmp.write_text(_json.dumps(keep, indent=1))
        tmp.replace(aj)


def _clean_fake_pulls() -> None:
    for name in FAKE_PULLED:
        for p in (TECHNO / name, TECHNO / (name + ".grid.json")):
            p.unlink(missing_ok=True)
        for p in (ROOT / "carry").glob(Path(name).stem + ".*"):
            p.unlink(missing_ok=True)
    _drop_analysis(FAKE_PULLED)


@pytest.fixture(scope="session")
def crate_session():
    """Generate the crate click tracks once and register them in the crate."""
    if not _fake_intake_on():
        pytest.fail("the crate e2e tests need dj-lab-dev started with -e CABINE_FAKE_INTAKE=1 "
                    "(see the e2e container command in dev-env.md)")
    TECHNO.mkdir(parents=True, exist_ok=True)
    for name, (bpm, first, secs) in CRATE_TRACKS.items():
        p = TECHNO / name
        if not p.exists():
            _write_clicks(p, bpm, first, secs)
    aj = ROOT / "analysis.json"
    entries = _json.loads(aj.read_text()) if aj.exists() else []
    have = {Path(str(e.get("file", ""))).name for e in entries}
    new = [{"file": str(TECHNO / n), "duration_s": s, "bpm": b, "beat_cv": 0.0, "key": "A min",
            "camelot": "8A", "note": "e2e fixture (A Cabine crate tests)"}
           for n, (b, _f, s) in CRATE_TRACKS.items() if n not in have]
    if new:
        tmp = aj.with_name(aj.name + ".e2e.tmp")
        tmp.write_text(_json.dumps(entries + new, indent=1))
        tmp.replace(aj)
    return {"a": "cabine-e2e-crate-a.wav", "nogrid": "cabine-e2e-crate-nogrid.wav",
            "a_grid": CRATE_A_GRID, "hold": HOLD_MARKER, "techno": TECHNO}


@pytest.fixture
def crate_tracks(crate_session):
    """Per test: crate-a back to its known grid, nogrid without one, no fake pulls."""
    HOLD_MARKER.unlink(missing_ok=True)
    (TECHNO / (crate_session["a"] + ".grid.json")).write_text(_json.dumps(CRATE_A_GRID, indent=2))
    (TECHNO / (crate_session["nogrid"] + ".grid.json")).unlink(missing_ok=True)
    _clean_fake_pulls()
    yield crate_session
    HOLD_MARKER.unlink(missing_ok=True)
    (TECHNO / (crate_session["nogrid"] + ".grid.json")).unlink(missing_ok=True)
    _clean_fake_pulls()


@pytest.fixture
def phone_context(chromium, auth_cookie):
    """Chromium as a portrait phone: 390 x 844, touch, past the PIN gate."""
    ctx = chromium.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3,
                               is_mobile=True, has_touch=True)
    ctx.add_cookies([auth_cookie])
    yield ctx
    ctx.close()


@pytest.fixture
def crate_page(phone_context, base_url, crate_tracks):
    """/cabine on the crate screen, the library loaded."""
    page = phone_context.new_page()
    page.goto(f"{base_url}/cabine")
    page.wait_for_function("() => window.cabine && window.cabine.crate")
    page.evaluate("() => window.cabine.crate.ready")
    yield page
    page.close()
