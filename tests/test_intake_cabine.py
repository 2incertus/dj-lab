"""Intake for A Cabine: SoundCloud search, the techno folder, the 15 minute
cap (a set is not a track) and a beat grid computed on every pull.

yt-dlp is replaced by a fake; nothing here touches the network."""

import json

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from djlab import intake
from djlab import recipes as rc
from djlab import server
from djlab.grid import MAX_TRACK_S, grid_path


class FakeYDL:
    """Stands in for yt_dlp.YoutubeDL. `info` is what extract_info returns;
    `on_download(opts, urls)` runs when download() is called."""
    info: dict = {}
    on_download = None
    calls: list = []

    def __init__(self, opts=None):
        self.opts = opts or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        FakeYDL.calls.append(("extract_info", url, download))
        return FakeYDL.info

    def download(self, urls):
        FakeYDL.calls.append(("download", list(urls)))
        if FakeYDL.on_download is None:
            raise AssertionError("download must not be called")
        FakeYDL.on_download(self.opts, urls)


@pytest.fixture
def ydl(monkeypatch):
    import yt_dlp
    FakeYDL.info, FakeYDL.on_download, FakeYDL.calls = {}, None, []
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    return FakeYDL


@pytest.fixture
def crate(tmp_path, monkeypatch):
    root = tmp_path / "root"
    sources = root / "sources"
    sources.mkdir(parents=True)
    monkeypatch.setattr(rc, "ROOT", root)
    monkeypatch.setattr(rc, "SOURCES", sources)
    monkeypatch.setattr(server, "PIN_HASH", "")
    from djlab import engine
    monkeypatch.setattr(engine, "run", lambda root: [])
    monkeypatch.setattr(intake, "analyze_into_log", lambda p: {
        "duration_s": round(sf.info(p).duration, 1), "bpm": 128.0, "note": "A",
        "mode": "minor", "camelot": "8A", "beat_cv": 0.01, "warp": "steady"})
    return root


def _write_click(click_track, seconds: float):
    def on_download(opts, urls):
        out = opts["outtmpl"].replace("%(ext)s", "wav")
        sf.write(out, click_track(128.0, seconds, 0.5), 44100)
    return on_download


def test_soundcloud_search_shape_and_too_long(ydl):
    ydl.info = {"entries": [
        {"id": "111", "url": "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A111",
         "title": "Hypnotic One", "uploader": "Someone", "duration": 412.0,
         "view_count": 1000},
        {"id": "222", "url": "https://api.soundcloud.com/tracks/222",
         "webpage_url": "https://soundcloud.com/dj/a-two-hour-set",
         "title": "Two Hour Set", "uploader": "DJ", "duration": 7200.0},
        {"id": "333", "url": "https://api.soundcloud.com/tracks/333",
         "title": "Exactly Fifteen", "channel": "C", "duration": float(MAX_TRACK_S)},
        None,
        {"title": "no id, skipped"},
    ]}
    out = intake.soundcloud_search("hypnotic techno", limit=5)
    assert ("extract_info", "scsearch5:hypnotic techno", False) in ydl.calls
    assert [t["id"] for t in out] == ["111", "222", "333"]
    assert set(out[0]) == {"id", "url", "title", "channel", "duration", "views",
                           "source", "too_long"}
    assert out[0]["url"] == "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A111"
    assert out[0]["channel"] == "Someone"
    assert out[0]["views"] == 1000
    assert out[1]["url"] == "https://soundcloud.com/dj/a-two-hour-set"   # webpage_url wins
    assert all(t["source"] == "soundcloud" for t in out)
    assert [t["too_long"] for t in out] == [False, True, False]


def test_youtube_search_flags_too_long(ydl):
    ydl.info = {"entries": [
        {"id": "a", "title": "track", "channel": "x", "duration": 380},
        {"id": "b", "title": "set", "channel": "y", "duration": 3600},
        {"id": "c", "title": "live, no duration", "channel": "z"},
    ]}
    out = intake.youtube_search("q")
    assert [v["too_long"] for v in out] == [False, True, False]
    assert out[0]["url"] == "https://www.youtube.com/watch?v=a"


def test_pull_refuses_sets_before_download(ydl, crate):
    ydl.info = {"title": "Boiler Room", "uploader": "BR", "duration": 3600}
    with pytest.raises(ValueError, match="that's a set, not a track"):
        intake.pull("https://soundcloud.com/br/boiler-room", "techno")
    assert not any(c[0] == "download" for c in ydl.calls)


def test_pull_refuses_long_file_when_duration_unknown(ydl, crate, monkeypatch, click_track):
    ydl.info = {"title": "Mystery", "uploader": "M"}          # no duration
    ydl.on_download = _write_click(click_track, 1.0)
    import soundfile

    class Long:
        def __init__(self, p):
            self.duration = MAX_TRACK_S + 60.0
    monkeypatch.setattr(soundfile, "info", lambda p: Long(p))
    with pytest.raises(ValueError, match="that's a set, not a track"):
        intake.pull("https://soundcloud.com/m/mystery", "techno")
    assert list((crate / "sources" / "techno").glob("*.wav")) == []


def test_pull_url_whitelist(crate, monkeypatch):
    seen = []
    monkeypatch.setattr(server, "_run_job", lambda action, fn: seen.append(action) or 7)
    c = TestClient(server.app)
    assert c.post("/api/intake/pull", json={"url": "https://evil.com/x",
                                            "folder": "techno"}).status_code == 400
    assert c.post("/api/intake/pull", json={"url": "https://soundcloud.com.evil.com/x",
                                            "folder": "techno"}).status_code == 400
    assert c.post("/api/intake/pull", json={"url": "https://soundcloud.com/a/b",
                                            "folder": "nope"}).status_code == 400
    for url in ("https://soundcloud.com/artist/track",
                "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A2309158322",
                "https://www.youtube.com/watch?v=abc"):
        r = c.post("/api/intake/pull", json={"url": url, "folder": "techno"})
        assert r.status_code == 200, url
        assert r.json() == {"job": 7}
    r = c.post("/api/intake/pull", json={"url": "https://www.youtube.com/watch?v=abc",
                                         "folder": "cosmic"})
    assert r.status_code == 200                               # mesa folders still work
    assert seen[0] == "pull from soundcloud" and seen[2] == "pull from youtube"


def test_soundcloud_search_route(crate, ydl):
    ydl.info = {"entries": [{"id": "1", "url": "https://api.soundcloud.com/tracks/1",
                             "title": "T", "uploader": "U", "duration": 300}]}
    r = TestClient(server.app).get("/api/intake/soundcloud/search", params={"q": "x"})
    assert r.status_code == 200
    assert r.json()["tracks"][0]["source"] == "soundcloud"


def test_pull_runs_grid(ydl, crate, capsys, click_track):
    ydl.info = {"title": "Kick Study", "uploader": "Lab", "duration": 8}
    ydl.on_download = _write_click(click_track, 8.0)
    wav = intake.pull("https://soundcloud.com/lab/kick-study", "techno")
    assert wav.parent == crate / "sources" / "techno"       # created on first pull
    assert wav.exists()
    sidecar = grid_path(wav)
    assert sidecar.exists()
    g = json.loads(sidecar.read_text())
    out = capsys.readouterr().out
    if g["reliable"]:
        assert f"grid: {g['bpm']} BPM, beat 1 at {round(g['downbeat_s'], 2)}s" in out
    else:
        assert "grid: unreliable, sync off for this track" in out


def test_pull_survives_grid_failure(ydl, crate, capsys, monkeypatch, click_track):
    from djlab import grid
    ydl.info = {"title": "Kick Study", "uploader": "Lab", "duration": 2}
    ydl.on_download = _write_click(click_track, 2.0)

    def boom(src):
        raise RuntimeError("model would not load")
    monkeypatch.setattr(grid, "ensure_grid", boom)
    wav = intake.pull("https://soundcloud.com/lab/kick-study", "techno")
    assert wav.exists()
    assert "grid: failed (model would not load)" in capsys.readouterr().out


def test_pull_prints_unreliable(ydl, crate, capsys, monkeypatch, click_track):
    from djlab import grid
    ydl.info = {"title": "Rubato", "uploader": "Lab", "duration": 2}
    ydl.on_download = _write_click(click_track, 2.0)
    monkeypatch.setattr(grid, "ensure_grid", lambda src: {
        "bpm": 97.3, "first_beat_s": 0.1, "downbeat_s": 0.1, "beat_cv": 0.3,
        "reliable": False, "source": "beat_this", "fixed": False})
    intake.pull("https://soundcloud.com/lab/rubato", "techno")
    assert "grid: unreliable, sync off for this track" in capsys.readouterr().out
