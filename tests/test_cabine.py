"""A Cabine server side: library, carried mp3s, waveform peaks, grid routes,
the page shell and its ungated service worker, and login ?next=."""

import hashlib
import json
import os
import struct
import subprocess

import numpy as np
import pytest
from fastapi.testclient import TestClient

from djlab import cabine
from djlab import recipes as rc
from djlab import server
from djlab.grid import grid_path, save_grid


@pytest.fixture
def crate(tmp_path, monkeypatch):
    """An empty crate under tmp_path, auth off."""
    root = tmp_path / "root"
    sources = root / "sources"
    sources.mkdir(parents=True)
    monkeypatch.setattr(rc, "ROOT", root)
    monkeypatch.setattr(rc, "SOURCES", sources)
    monkeypatch.setattr(cabine, "CARRY", root / "carry")
    monkeypatch.setattr(server, "PIN_HASH", "")
    return root


@pytest.fixture
def client(crate):
    return TestClient(server.app)


def _decode_s16(path, channels):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le",
                          "-ac", str(channels), "-ar", "44100", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<i2").reshape(-1, channels)


def test_library_excludes_sets(crate, client):
    folder = crate / "sources" / "techno"
    folder.mkdir()
    track = folder / "some-channel__deep-cut_extended.wav"
    dj_set = folder / "boiler-room__three-hour-set.wav"
    track.write_bytes(b"x")
    dj_set.write_bytes(b"x")
    # analysis.json may hold another machine's absolute paths: match by basename
    entries = [
        {"file": f"/elsewhere/sources/techno/{track.name}", "duration_s": 300.0,
         "bpm": 131.9, "key": "A min", "camelot": "8A", "beat_cv": 0.02},
        {"file": f"/elsewhere/sources/techno/{dj_set.name}", "duration_s": 3600.0,
         "bpm": 128.0, "key": "C maj", "camelot": "8B", "beat_cv": 0.03},
    ]
    (crate / "analysis.json").write_text(json.dumps(entries))

    tracks = client.get("/api/cabine/library").json()["tracks"]
    assert [t["file"] for t in tracks] == [track.name]
    t = tracks[0]
    assert t["title"] == "some channel - deep cut extended"
    assert t["folder"] == "techno"
    assert t["duration_s"] == 300.0 and t["bpm"] == 131.9
    assert t["key"] == "A min" and t["camelot"] == "8A" and t["beat_cv"] == 0.02
    assert t["grid"] is None and t["carry_bytes"] is None
    assert cabine.MAX_TRACK_S == 900


def test_library_item_has_the_exact_source_frame_count(crate, client):
    import soundfile as sf
    folder = crate / "sources" / "techno"
    folder.mkdir()
    a = folder / "a__exact.wav"
    b = folder / "b__at-48k.wav"
    c = folder / "c__unreadable.wav"
    sf.write(a, np.zeros((44100 * 3 + 17, 2), dtype=np.float32), 44100)
    sf.write(b, np.zeros((48000 * 2 + 1, 2), dtype=np.float32), 48000)
    c.write_bytes(b"x")
    entries = [{"file": p.name, "duration_s": 3.0, "bpm": 128.0} for p in (a, b, c)]
    (crate / "analysis.json").write_text(json.dumps(entries))
    tracks = {t["file"]: t for t in client.get("/api/cabine/library").json()["tracks"]}
    # the carried file's frame count at 44.1 kHz: the loader compares the decode with it
    assert tracks[a.name]["samples"] == 44100 * 3 + 17
    assert tracks[b.name]["samples"] == round((48000 * 2 + 1) * 44100 / 48000)
    assert tracks[c.name]["samples"] is None


def test_carry_mp3_aligned_with_wav(crate, wav_file):
    src = wav_file(bpm=128.0, seconds=4, offset_s=0.25)
    out = cabine.carry_mp3(src)
    assert out.suffix == ".mp3" and out.parent == cabine.CARRY
    pcm = _decode_s16(out, 2)
    assert pcm.shape[1] == 2
    loud = np.flatnonzero(np.abs(pcm[:, 0].astype(np.int32)) > 32768 * 10 ** (-20 / 20))
    onset_s = loud[0] / 44100
    assert abs(onset_s - 0.25) < 0.005, onset_s
    # same length as the wav: no encoder padding left at either end
    assert abs(len(pcm) / 44100 - 4.0) < 0.03
    # cached: a second call does not re-encode
    mtime = out.stat().st_mtime_ns
    assert cabine.carry_mp3(src).stat().st_mtime_ns == mtime


def test_peaks_format(crate, client, wav_file):
    src = wav_file(bpm=120.0, seconds=10, offset_s=0.25, name="pk.wav")
    data = cabine.peaks(src).read_bytes()
    assert data[:4] == b"PK01"
    rate, n = struct.unpack("<II", data[4:12])
    assert rate == 100
    assert abs(n - 1000) <= 1
    vals = np.frombuffer(data[12:], dtype=np.uint8)
    assert len(vals) == n
    assert vals.max() == 255
    # the loud bins are the downbeat kicks (every 2 s at 120 bpm from 0.25 s)
    assert vals[int(0.25 * 100)] >= 200
    assert vals[:20].max() == 0          # silence before the first kick

    # the route serves the same bytes for a crate track, gated by file lookup
    folder = crate / "sources" / "techno"
    folder.mkdir()
    os.replace(src, folder / src.name)
    r = client.get("/api/cabine/peaks", params={"file": src.name})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.content[:4] == b"PK01"
    assert client.get("/api/cabine/peaks", params={"file": "nope.wav"}).status_code == 404


def test_grid_fix_route_saves_sidecar(crate, client):
    folder = crate / "sources" / "techno"
    folder.mkdir()
    src = folder / "t.wav"
    src.write_bytes(b"x")
    assert client.get("/api/cabine/grid", params={"file": "t.wav"}).status_code == 404

    g = {"bpm": 66.0, "first_beat_s": 0.5, "downbeat_s": 0.5, "beat_cv": 0.02,
         "reliable": True, "source": "beat_this", "fixed": False}
    save_grid(src, g)
    assert client.get("/api/cabine/grid", params={"file": "t.wav"}).json() == g

    r = client.post("/api/cabine/grid/fix", json={"file": "t.wav", "op": "double"})
    assert r.status_code == 200
    assert r.json()["bpm"] == 132.0 and r.json()["fixed"] is True
    saved = json.loads(grid_path(src).read_text())
    assert saved["bpm"] == 132.0 and saved["fixed"] is True

    r = client.post("/api/cabine/grid/fix", json={"file": "t.wav", "op": "nudge", "value": -10})
    # applied to the saved (doubled) grid: first beat 0.5 wraps to 0.5 mod 60/132
    assert r.json()["first_beat_s"] == pytest.approx(0.5 % (60 / 132) - 0.010, abs=1e-6)
    assert json.loads(grid_path(src).read_text()) == r.json()
    assert client.post("/api/cabine/grid/fix",
                       json={"file": "t.wav", "op": "spin"}).status_code == 400
    assert client.post("/api/cabine/grid/fix",
                       json={"file": "nope.wav", "op": "double"}).status_code == 404
    # library carries the saved grid
    (crate / "analysis.json").write_text(json.dumps(
        [{"file": "t.wav", "duration_s": 200.0, "bpm": 66.0}]))
    assert client.get("/api/cabine/library").json()["tracks"][0]["grid"]["bpm"] == 132.0


def test_sw_served_with_scope_header_and_ungated(crate, monkeypatch):
    monkeypatch.setattr(server, "PIN_HASH", hashlib.sha256(b"test-pin").hexdigest())
    c = TestClient(server.app)

    r = c.get("/cabine/sw.js")
    assert r.status_code == 200
    assert r.headers["service-worker-allowed"] == "/cabine"
    assert r.headers["content-type"].startswith("text/javascript")
    assert "addEventListener" in r.text

    m = c.get("/cabine/manifest.webmanifest")
    assert m.status_code == 200
    man = m.json()
    assert man["name"] == "A Cabine" and man["short_name"] == "Cabine"
    assert man["start_url"] == "/cabine" and man["scope"] == "/cabine"
    assert man["display"] == "fullscreen" and man["orientation"] == "landscape"
    assert any(i["sizes"] == "512x512" for i in man["icons"])

    # the shell is public (it holds no data; the PIN card lives in the app):
    # a fresh home-screen install has its own cookie jar and must still open
    for path in ("/cabine", "/cabine?deck=1"):
        page = c.get(path, follow_redirects=False)
        assert page.status_code == 200, path
        assert 'id="cab-root"' in page.text and "viewport-fit=cover" in page.text
        assert "/cabine/manifest.webmanifest" in page.text
    # everything private stays behind the cookie
    assert c.get("/api/cabine/library").status_code == 401
    assert c.get("/api/cabine/carry", params={"file": "x.wav"}).status_code == 401
    assert c.post("/api/mesa/export", params={"name": "cabine"}, content=b"x").status_code == 401
    r = c.get("/cabine/other", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/login?next=/cabine/other"
    # the mesa keeps its redirect
    assert c.get("/mesa", follow_redirects=False).status_code == 307

    c.cookies.set("dj_auth", server.PIN_HASH)
    assert c.get("/cabine").status_code == 200


def test_login_next_rejects_offsite(crate, monkeypatch):
    assert server.safe_next("/cabine") == "/cabine"
    assert server.safe_next("/cabine?deck=1") == "/cabine?deck=1"
    for bad in ("//evil.com", "/\\evil.com", "https://evil.com", "evil.com",
                "/\t/evil.com", "", None, "javascript:alert(1)"):
        assert server.safe_next(bad) == "/", bad

    monkeypatch.setattr(server, "PIN_HASH", hashlib.sha256(b"test-pin").hexdigest())
    c = TestClient(server.app)
    r = c.post("/auth", json={"pin": "test-pin", "next": "//evil.com"})
    assert r.status_code == 200 and r.json()["next"] == "/"
    r = c.post("/auth", json={"pin": "test-pin", "next": "/cabine"})
    assert r.json()["next"] == "/cabine"
    # the login page validates next in JS too, before following it
    page = c.get("/login", params={"next": "//evil.com"}).text
    assert "location.search" in page and "safeNext" in page


def test_grid_fix_rejects_non_finite_value(crate, client):
    folder = crate / "sources" / "techno"
    folder.mkdir()
    src = folder / "t.wav"
    src.write_bytes(b"x")
    save_grid(src, {"bpm": 128.0, "first_beat_s": 0.25, "downbeat_s": 0.25,
                    "beat_cv": 0.01, "reliable": True, "source": "beat_this",
                    "fixed": False})
    before = grid_path(src).read_bytes()
    bodies = [json.dumps({"file": "t.wav", "op": op, "value": v})
              for op in ("nudge", "downbeat") for v in ("nan", "inf", "-Infinity")]
    bodies += ['{"file": "t.wav", "op": "nudge", "value": 1e999}',
               '{"file": "t.wav", "op": "nudge", "value": NaN}',
               '{"file": "t.wav", "op": "downbeat", "value": -Infinity}']
    for body in bodies:
        r = client.post("/api/cabine/grid/fix", content=body,
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400, body
        assert grid_path(src).read_bytes() == before, body


def test_library_tolerates_bad_sidecar(crate, client):
    folder = crate / "sources" / "techno"
    folder.mkdir()
    src = folder / "t.wav"
    src.write_bytes(b"x")
    # a sidecar poisoned before the fix: json.dumps writes NaN, the API cannot
    grid_path(src).write_text('{"bpm": 128.0, "first_beat_s": NaN, "downbeat_s": 0.25,'
                              ' "beat_cv": 0.01, "reliable": true, "source": "x",'
                              ' "fixed": true}')
    (crate / "analysis.json").write_text(json.dumps(
        [{"file": "t.wav", "duration_s": 200.0, "bpm": 128.0}]))
    r = client.get("/api/cabine/library")
    assert r.status_code == 200
    assert r.json()["tracks"][0]["grid"] is None
    assert client.get("/api/cabine/grid", params={"file": "t.wav"}).status_code == 404


@pytest.mark.parametrize("op,value", [("nudge", -1e20), ("downbeat", -1e300),
                                      ("downbeat", 1e308), ("nudge", 1e308)])
def test_grid_fix_rejects_out_of_range_value(crate, client, op, value):
    import signal

    def boom(*_):
        raise TimeoutError("grid fix took over 5 s")
    old = signal.signal(signal.SIGALRM, boom)
    signal.alarm(5)
    try:
        folder = crate / "sources" / "techno"
        folder.mkdir()
        src = folder / "t.wav"
        src.write_bytes(b"x")
        save_grid(src, {"bpm": 128.0, "first_beat_s": 0.25, "downbeat_s": 0.25,
                        "beat_cv": 0.01, "reliable": True, "source": "beat_this",
                        "fixed": False})
        before = grid_path(src).read_bytes()
        r = client.post("/api/cabine/grid/fix", json={"file": "t.wav", "op": op, "value": value})
        assert r.status_code == 400
        assert grid_path(src).read_bytes() == before
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)


def test_cabine_proof_page_is_gated(crate, monkeypatch):
    monkeypatch.setattr(server, "PIN_HASH", hashlib.sha256(b"test-pin").hexdigest())
    c = TestClient(server.app)
    r = c.get("/cabine/proof", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "/login?next=/cabine/proof"
    c.cookies.set("dj_auth", server.PIN_HASH)
    page = c.get("/cabine/proof")
    assert page.status_code == 200
    assert "/static/cabine/engine/deck-voice.js" in page.text
    assert "/static/cabine/engine/loader.js" in page.text


def test_cabine_static_assets_are_never_edge_cached(client):
    r = client.get("/static/cabine/cabine.css")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"
    r = client.get("/static/style.css")
    assert "cache-control" not in r.headers or r.headers["cache-control"] != "no-cache"
