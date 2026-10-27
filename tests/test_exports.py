"""O Arquivo: the mesa's export endpoints accept WAV, WebM and M4A, and an
upload carrying a client_id is idempotent (the phone may retry)."""

import re
import struct
import subprocess

import pytest
from fastapi.testclient import TestClient

from djlab import recipes as rc
from djlab import server


@pytest.fixture
def exports(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    d = root / "renders" / "sessoes"
    monkeypatch.setattr(rc, "ROOT", root)
    monkeypatch.setattr(server, "MESA_EXPORTS", d)
    monkeypatch.setattr(server, "PIN_HASH", "")
    return d


@pytest.fixture
def client(exports):
    return TestClient(server.app)


def _wav(seconds=1.0, rate=44100):
    n = int(seconds * rate)
    data = b"\x00\x00\x00\x00" * n
    head = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 2, rate, rate * 4, 4, 16)
            + b"data" + struct.pack("<I", len(data)))
    return head + data


def _encode(tmp_path, ext, seconds=1.5):
    """A tiny real compressed file made with ffmpeg (sine, a second and a half)."""
    out = tmp_path / f"tone.{ext}"
    codec = ["-c:a", "libopus"] if ext == "webm" else ["-c:a", "aac"]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                    "-i", f"sine=frequency=440:duration={seconds}",
                    "-ac", "2", *codec, str(out)], check=True)
    return out.read_bytes()


def test_wav_export_unchanged(client, exports):
    r = client.post("/api/mesa/export?name=sessao", content=_wav())
    assert r.status_code == 200
    body = r.json()
    assert list(body) == ["file"]
    assert re.fullmatch(r"sessao-\d{8}-\d{6}\.wav", body["file"])
    assert (exports / body["file"]).read_bytes() == _wav()
    # no sidecars for the plain wav path
    assert sorted(p.name for p in exports.iterdir()) == [body["file"]]
    listing = client.get("/api/mesa/exports").json()
    assert [x["file"] for x in listing] == [body["file"]]
    assert listing[0]["dur"] == 1.0
    g = client.get(f"/api/mesa/export/{body['file']}")
    assert g.status_code == 200
    assert g.headers["content-type"] == "audio/wav"
    # the old guard is still there
    assert client.post("/api/mesa/export?name=x", content=b"nope" * 10).status_code == 400


def _probe(path):
    """codec name and duration of a stored export, via ffprobe."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                          "-show_entries", "stream=codec_name,bit_rate:format=duration,format_name",
                          "-of", "default=nw=1", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def test_m4a_stored_as_is(client, exports, tmp_path):
    data = _encode(tmp_path, "m4a")
    r = client.post("/api/mesa/export?name=cabine", content=data)
    assert r.status_code == 200, r.text
    f = r.json()["file"]
    assert re.fullmatch(r"cabine-\d{8}-\d{6}\.m4a", f)
    assert (exports / f).read_bytes() == data
    g = client.get(f"/api/mesa/export/{f}")
    assert g.status_code == 200
    assert g.headers["content-type"] == "audio/mp4"
    assert g.content == data


def test_webm_upload_is_stored_as_m4a(client, exports, tmp_path):
    """A WebM/Opus take (the Galaxy's MediaRecorder) becomes AAC in M4A, so
    tocar works on the iPhone; a retry with the same client id gets it back."""
    data = _encode(tmp_path, "webm", 2.0)
    assert data[:4] == b"\x1a\x45\xdf\xa3"
    cid = "5e6f7a8b-1111-4222-8333-444455556666"
    r = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=data)
    assert r.status_code == 200, r.text
    f = r.json()["file"]
    assert re.fullmatch(r"cabine-\d{8}-\d{6}-5e6f7a8b\.m4a", f)
    stored = exports / f
    assert stored.read_bytes()[4:8] == b"ftyp"
    info = _probe(stored)
    assert info["codec_name"] == "aac"
    assert 120_000 <= int(info["bit_rate"]) <= 200_000, info
    assert float(info["duration"]) == pytest.approx(2.0, abs=0.1)
    # nothing of the webm is left behind, and the sidecar names the m4a
    names = sorted(p.name for p in exports.iterdir())
    assert names == [f, f + ".cid"], names
    assert (exports / (f + ".cid")).read_text() == cid
    g = client.get(f"/api/mesa/export/{f}")
    assert g.headers["content-type"] == "audio/mp4"
    listing = {x["file"]: x for x in client.get("/api/mesa/exports").json()}
    assert listing[f]["dur"] == pytest.approx(2.0, abs=0.1)
    # the retry returns the m4a, writes nothing
    before_retry = sorted(p.name for p in exports.iterdir())
    r2 = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=data)
    assert r2.json() == {"file": f}
    assert sorted(p.name for p in exports.iterdir()) == before_retry
    # a streamed webm (MediaRecorder: no duration in the header) transcodes too
    streamed = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi",
                               "-i", "sine=frequency=330:duration=3", "-ac", "2",
                               "-c:a", "libopus", "-f", "webm", "pipe:1"],
                              check=True, capture_output=True).stdout
    live = client.post("/api/mesa/export?name=cabine&client_id=cccccccc-3",
                       content=streamed).json()["file"]
    assert live.endswith(".m4a")
    assert float(_probe(exports / live)["duration"]) == pytest.approx(3.0, abs=0.1)
    # a webm ffmpeg cannot read is refused, nothing written
    before = sorted(p.name for p in exports.iterdir())
    bad = client.post("/api/mesa/export?name=cabine&client_id=dddddddd-4",
                      content=b"\x1a\x45\xdf\xa3" + b"garbage" * 50)
    assert bad.status_code == 400
    assert sorted(p.name for p in exports.iterdir()) == before


def test_unknown_format_400(client, exports):
    for junk in (b"ID3\x04" + b"\x00" * 64,           # an mp3 is not accepted
                 b"\x1a\x45\xdf",                       # too short for webm magic
                 b"xxxxftyp",                           # ftyp but nothing after
                 b"\x00" * 64):
        r = client.post("/api/mesa/export?name=cabine", content=junk)
        assert r.status_code == 400, junk
    assert not exports.exists() or not any(exports.iterdir())
    # malformed client ids are refused before anything is written
    for bad in ("short", "has space in it", "a" * 65, "../../etc/passwd", "abcd_efgh"):
        r = client.post("/api/mesa/export", params={"name": "cabine", "client_id": bad},
                        content=_wav())
        assert r.status_code == 400, bad
    assert not exports.exists() or not any(exports.iterdir())


def test_client_id_idempotent(client, exports, tmp_path):
    cid = "3f2b9c1e-8d7a-4b6c-9e5f-0a1b2c3d4e5f"
    data = _encode(tmp_path, "webm")
    r1 = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=data)
    assert r1.status_code == 200, r1.text
    f = r1.json()["file"]
    assert re.fullmatch(r"cabine-\d{8}-\d{6}-3f2b9c1e\.m4a", f)
    before = sorted(p.name for p in exports.iterdir())
    # a retry (even with different bytes) returns the existing file, writes nothing
    r2 = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=_wav())
    assert r2.status_code == 200
    assert r2.json() == {"file": f}
    assert sorted(p.name for p in exports.iterdir()) == before
    # same first 8 chars but a different full id is a different recording
    other = "3f2b9c1e-0000-4000-8000-000000000000"
    r3 = client.post(f"/api/mesa/export?name=cabine&client_id={other}", content=_wav())
    assert r3.status_code == 200
    f3 = r3.json()["file"]
    assert f3 != f and f3.endswith("-3f2b9c1e.wav")
    # delete removes the file and its sidecars, then the id is free again
    assert client.delete(f"/api/mesa/export/{f}").status_code == 200
    assert not [p for p in exports.iterdir() if p.name.startswith(f)]
    r4 = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=data)
    assert r4.status_code == 200 and (exports / r4.json()["file"]).exists()


def test_listing_includes_compressed_with_duration(client, exports, tmp_path):
    w = client.post("/api/mesa/export?name=sessao", content=_wav(2.0)).json()["file"]
    webm = client.post("/api/mesa/export?name=cabine&client_id=aaaaaaaa-1",
                       content=_encode(tmp_path, "webm", 1.5)).json()["file"]
    m4a = client.post("/api/mesa/export?name=cabine&client_id=bbbbbbbb-2",
                      content=_encode(tmp_path, "m4a", 1.5)).json()["file"]
    # a streamed webm (what MediaRecorder writes) has no duration in its header
    streamed = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi",
                               "-i", "sine=frequency=330:duration=2", "-ac", "2",
                               "-c:a", "libopus", "-f", "webm", "pipe:1"],
                              check=True, capture_output=True).stdout
    live = client.post("/api/mesa/export?name=cabine&client_id=cccccccc-3",
                       content=streamed).json()["file"]
    # uploads of webm are stored as m4a now; a webm already on disk (from
    # before the transcode) still lists and plays
    assert webm.endswith(".m4a") and live.endswith(".m4a")
    legacy = "cabine-20260101-000001.webm"
    (exports / legacy).write_bytes(streamed)
    # a broken compressed file must not break the listing
    (exports / "broken-20260101-000000.webm").write_bytes(b"\x1a\x45\xdf\xa3garbage")
    listing = client.get("/api/mesa/exports").json()
    by = {x["file"]: x for x in listing}
    assert set(by) == {w, webm, m4a, live, legacy, "broken-20260101-000000.webm"}
    assert by[legacy]["dur"] == pytest.approx(2.0, abs=0.15)
    assert client.get(f"/api/mesa/export/{legacy}").headers["content-type"] == "audio/webm"
    assert not any(n.endswith((".dur", ".cid")) for n in by)
    assert by[w]["dur"] == 2.0
    assert by[webm]["dur"] == pytest.approx(1.5, abs=0.15)
    assert by[m4a]["dur"] == pytest.approx(1.5, abs=0.15)
    assert by[live]["dur"] == pytest.approx(2.0, abs=0.15)
    assert by["broken-20260101-000000.webm"]["dur"] is None
    # ffprobe durations are cached in a sidecar
    assert (exports / f"{webm}.dur").exists()
    assert (exports / f"{m4a}.dur").exists()
    (exports / f"{webm}.dur").write_text("42.0")
    again = {x["file"]: x for x in client.get("/api/mesa/exports").json()}
    assert again[webm]["dur"] == 42.0
