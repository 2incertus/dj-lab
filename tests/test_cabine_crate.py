"""A Cabine crate, server side: the "grid everything" job and the test-only
fake intake (CABINE_FAKE_INTAKE=1) the crate e2e tests drive."""

import json
import threading
import time

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from djlab import cabine
from djlab import grid as gr
from djlab import intake
from djlab import intake_fake
from djlab import recipes as rc
from djlab import server
from djlab.grid import grid_path, save_grid

FAKE_GRID = {"bpm": 126.0, "first_beat_s": 0.1, "downbeat_s": 0.1, "beat_cv": 0.01,
             "reliable": True, "source": "beat_this", "fixed": False}


@pytest.fixture
def crate(tmp_path, monkeypatch):
    root = tmp_path / "root"
    sources = root / "sources"
    sources.mkdir(parents=True)
    monkeypatch.setattr(rc, "ROOT", root)
    monkeypatch.setattr(rc, "SOURCES", sources)
    monkeypatch.setattr(cabine, "CARRY", root / "carry")
    monkeypatch.setattr(server, "PIN_HASH", "")
    monkeypatch.delenv("CABINE_FAKE_INTAKE", raising=False)
    return root


@pytest.fixture
def client(crate):
    return TestClient(server.app)


@pytest.fixture
def computed(monkeypatch):
    """compute_grid stand-in: records the files it was asked for."""
    seen = []

    def fake(path):
        seen.append(path.name)
        if path.name.startswith("broken"):
            raise RuntimeError("could not decode")
        return dict(FAKE_GRID)
    monkeypatch.setattr(gr, "compute_grid", fake)
    return seen


def _wait_job(client, job_id, timeout=30.0):
    end = time.time() + timeout
    while time.time() < end:
        for j in client.get("/api/jobs").json():
            if j["id"] == job_id and j["status"] != "running":
                return j
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} still running after {timeout} s")


def _track(folder, name, entries, duration=200.0, analyzed=True):
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / name
    p.write_bytes(b"x")
    if analyzed:
        entries.append({"file": f"/elsewhere/{name}", "duration_s": duration, "bpm": 128.0})
    return p


def test_grid_all_grids_every_analyzed_ungridded_track(crate, client, computed):
    techno, lush = crate / "sources" / "techno", crate / "sources" / "lush"
    entries = []
    a = _track(techno, "a.wav", entries)
    b = _track(techno, "b.wav", entries)
    save_grid(b, dict(FAKE_GRID, bpm=99.0))
    long_ = _track(techno, "long.wav", entries, duration=1200.0)
    c = _track(lush, "c.wav", entries)
    loose = _track(techno, "loose.wav", entries, analyzed=False)
    broken = _track(lush, "broken.wav", entries)
    (crate / "analysis.json").write_text(json.dumps(entries))

    r = client.post("/api/cabine/grid/all", json={})
    assert r.status_code == 200
    job = _wait_job(client, r.json()["job"])
    assert job["status"] == "done", job["log"]
    assert job["action"] == "beat grid: every track"

    assert sorted(computed) == ["a.wav", "broken.wav", "c.wav"]
    assert json.loads(grid_path(a).read_text())["bpm"] == 126.0
    assert json.loads(grid_path(c).read_text())["bpm"] == 126.0
    assert json.loads(grid_path(b).read_text())["bpm"] == 99.0     # untouched
    for p in (long_, loose, broken):
        assert not grid_path(p).exists(), p.name

    lines = [ln for ln in job["log"].splitlines() if ln.strip()]
    # one line per track it worked on, then a summary
    assert any(ln.startswith("a.wav: 126.0 BPM") for ln in lines), lines
    # which tracker made each grid is in the log (a silent librosa fallback
    # would otherwise go unseen)
    assert any(ln.startswith("a.wav:") and "source=beat_this" in ln for ln in lines), lines
    assert any(ln.startswith("c.wav: 126.0 BPM") for ln in lines), lines
    assert any(ln.startswith("broken.wav: failed (could not decode)") for ln in lines), lines
    assert lines[-1] == "2 gridded, 1 failed, 3 to do", lines


def test_grid_all_folder_scope(crate, client, computed):
    techno, lush = crate / "sources" / "techno", crate / "sources" / "lush"
    entries = []
    _track(techno, "a.wav", entries)
    c = _track(lush, "c.wav", entries)
    (crate / "analysis.json").write_text(json.dumps(entries))
    job = _wait_job(client, client.post("/api/cabine/grid/all",
                                        json={"folder": "techno"}).json()["job"])
    assert job["status"] == "done"
    assert computed == ["a.wav"]
    assert not grid_path(c).exists()
    assert client.post("/api/cabine/grid/all", json={"folder": "../etc"}).status_code == 400


def test_grid_all_with_nothing_to_do(crate, client, computed):
    job = _wait_job(client, client.post("/api/cabine/grid/all", json={}).json()["job"])
    assert job["status"] == "done"
    assert computed == []
    assert "every track already has a grid" in job["log"]


def test_grid_all_is_409_while_a_job_runs(crate, client):
    assert server._job_lock.acquire(blocking=False)
    try:
        assert client.post("/api/cabine/grid/all", json={}).status_code == 409
    finally:
        server._job_lock.release()


# ---- fake intake (CABINE_FAKE_INTAKE=1) --------------------------------------

def test_fake_intake_is_off_by_default(crate, client, monkeypatch):
    monkeypatch.setattr(intake, "soundcloud_search", lambda q: [{"real": q}])
    monkeypatch.setattr(intake, "youtube_search", lambda q: [{"real": q}])
    assert client.get("/api/intake/soundcloud/search", params={"q": "x"}).json() == {"tracks": [{"real": "x"}]}
    assert client.get("/api/intake/youtube/search", params={"q": "x"}).json() == {"videos": [{"real": "x"}]}


def test_fake_intake_search_serves_fixtures(crate, client, monkeypatch):
    monkeypatch.setenv("CABINE_FAKE_INTAKE", "1")
    monkeypatch.setattr(intake, "soundcloud_search", lambda q: pytest.fail("real soundcloud called"))
    sc = client.get("/api/intake/soundcloud/search", params={"q": "techno"}).json()["tracks"]
    assert any(t["too_long"] for t in sc) and any(not t["too_long"] for t in sc)
    assert all(t["url"].startswith(intake.SOUNDCLOUD_PREFIXES) for t in sc)
    yt = client.get("/api/intake/youtube/search", params={"q": "techno"}).json()["videos"]
    assert any(t["too_long"] for t in yt) and any(not t["too_long"] for t in yt)
    assert all(t["url"].startswith(intake.YOUTUBE_PREFIX) for t in yt)
    sp = client.get("/api/intake/spotify/search", params={"q": "techno"}).json()["tracks"]
    assert sp and {"title", "artist", "duration_ms"} <= set(sp[0])


def test_fake_pull_writes_a_short_click_track_with_analysis(crate, client, monkeypatch, computed):
    monkeypatch.setenv("CABINE_FAKE_INTAKE", "1")
    item = next(t for t in intake_fake.fixtures()["soundcloud"]
                if not t["too_long"] and not t.get("hold"))
    r = client.post("/api/intake/pull", json={"url": item["url"], "folder": "techno"})
    job = _wait_job(client, r.json()["job"], timeout=60)
    assert job["status"] == "done", job["log"]
    wav = crate / "sources" / "techno" / f"{item['slug']}.wav"
    info = sf.info(str(wav))
    assert info.samplerate == 44100 and 4 <= info.duration <= 12
    entries = json.loads((crate / "analysis.json").read_text())
    assert [e["file"] for e in entries] == [str(wav)]
    assert entries[0]["duration_s"] == pytest.approx(info.duration, abs=0.1)
    assert grid_path(wav).exists()
    assert "grid: 126.0 BPM" in job["log"]
    # and it is in the library the crate lists
    files = [t["file"] for t in client.get("/api/cabine/library").json()["tracks"]]
    assert files == [wav.name]


def test_fake_pull_refuses_a_set(crate, client, monkeypatch):
    monkeypatch.setenv("CABINE_FAKE_INTAKE", "1")
    item = next(t for t in intake_fake.fixtures()["youtube"] if t["too_long"])
    job = _wait_job(client, client.post("/api/intake/pull", json={
        "url": item["url"], "folder": "techno"}).json()["job"])
    assert job["status"] == "failed"
    assert intake.SET_ERROR in job["log"]
    assert not list((crate / "sources").rglob("*.wav"))


def test_fake_pull_hold_keeps_the_job_lock_until_released(crate, client, monkeypatch):
    monkeypatch.setenv("CABINE_FAKE_INTAKE", "1")
    item = next(t for t in intake_fake.fixtures()["youtube"] if t.get("hold"))
    marker = intake_fake.hold_marker()
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("hold")
    job_id = client.post("/api/intake/pull", json={"url": item["url"], "folder": "techno"}).json()["job"]
    time.sleep(0.5)
    assert client.post("/api/cabine/grid/all", json={}).status_code == 409
    assert server._job_lock.locked()
    marker.unlink()
    job = _wait_job(client, job_id, timeout=10)
    assert job["status"] == "done"
    assert "holding the job lock" in job["log"]
    assert not list((crate / "sources").rglob("*.wav"))


def test_fake_pull_unknown_url_fails(crate, client, monkeypatch):
    monkeypatch.setenv("CABINE_FAKE_INTAKE", "1")
    job = _wait_job(client, client.post("/api/intake/pull", json={
        "url": "https://soundcloud.com/someone/not-a-fixture", "folder": "techno"}).json()["job"])
    assert job["status"] == "failed"
    assert "not in the fake intake fixtures" in job["log"]


def test_intake_grid_line_names_the_source(monkeypatch, tmp_path):
    p = tmp_path / "t.wav"
    monkeypatch.setattr(gr, "ensure_grid", lambda path: dict(FAKE_GRID))
    assert intake.grid_line(p) == "grid: 126.0 BPM, beat 1 at 0.1s, source=beat_this"
    monkeypatch.setattr(gr, "ensure_grid", lambda path: dict(FAKE_GRID, reliable=False, source="librosa"))
    assert intake.grid_line(p) == "grid: unreliable, sync off for this track, source=librosa"
