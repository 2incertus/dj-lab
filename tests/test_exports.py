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


def _moov_before_mdat(b: bytes) -> bool:
    i, order = 0, []
    while i + 8 <= len(b):
        size = struct.unpack(">I", b[i:i + 4])[0]
        order.append(b[i + 4:i + 8])
        if size < 8:
            break
        i += size
    return b"moov" in order and b"mdat" in order and order.index(b"moov") < order.index(b"mdat")


def test_m4a_stored_remuxed_and_playable(client, exports, tmp_path):
    """An M4A take is read and remuxed (audio copied, moov up front) before
    it is stored: what lands in O Arquivo is a file ffprobe can time."""
    data = _encode(tmp_path, "m4a")
    assert not _moov_before_mdat(data), "the fixture has its moov at the end"
    r = client.post("/api/mesa/export?name=cabine", content=data)
    assert r.status_code == 200, r.text
    f = r.json()["file"]
    assert re.fullmatch(r"cabine-\d{8}-\d{6}\.m4a", f)
    stored = (exports / f).read_bytes()
    assert stored[4:8] == b"ftyp"
    assert _moov_before_mdat(stored), "remuxed with +faststart"
    info = _probe(exports / f)
    assert info["codec_name"] == "aac", info
    assert float(info["duration"]) == pytest.approx(1.5, abs=0.1)
    assert sorted(p.name for p in exports.iterdir()) == [f], "no temp files left"
    g = client.get(f"/api/mesa/export/{f}")
    assert g.status_code == 200
    assert g.headers["content-type"] == "audio/mp4"
    assert g.content == stored


def test_truncated_m4a_is_refused(client, exports, tmp_path):
    """A Safari MP4 part cut before stop() (a crash) has no moov: ffmpeg
    cannot read it, so the server answers 400 and the phone keeps the take
    as refused. Nothing is written."""
    data = _encode(tmp_path, "m4a", 3.0)
    cut = data[:data.rfind(b"moov") - 4]
    assert cut[4:8] == b"ftyp" and b"moov" not in cut
    r = client.post("/api/mesa/export?name=cabine&client_id=ffffffff-1111-4222-8333-444455556666-2",
                    content=cut)
    assert r.status_code == 400, r.text
    assert "m4a" in r.json()["detail"]
    assert not exports.exists() or not any(exports.iterdir())


def test_webm_upload_is_stored_as_m4a(client, exports, tmp_path):
    """A WebM/Opus take (the Galaxy's MediaRecorder) becomes AAC in M4A, so
    tocar works on the iPhone; a retry with the same client id gets it back."""
    data = _encode(tmp_path, "webm", 2.0)
    assert data[:4] == b"\x1a\x45\xdf\xa3"
    cid = "5e6f7a8b-1111-4222-8333-444455556666"
    r = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=data)
    assert r.status_code == 200, r.text
    f = r.json()["file"]
    assert f.startswith("cabine-") and f.endswith(f"-{_cid_stem(cid)}.m4a")
    assert re.fullmatch(r"cabine-\d{8}-\d{6}-[0-9a-f]{8}\.m4a", f)
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
    assert re.fullmatch(rf"cabine-\d{{8}}-\d{{6}}-{_cid_stem(cid)}\.m4a", f)
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
    assert f3 != f and f3.endswith(f"-{_cid_stem(other)}.wav")
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


def _cid_stem(cid):
    return server.hashlib.sha256(cid.encode()).hexdigest()[:8]


def test_parts_of_one_ride_in_the_same_second_stay_idempotent(client, exports, tmp_path, monkeypatch):
    """iPhone parts share their first 8 characters (<ride>-1, <ride>-2) and,
    stored without a transcode, can land in the same second. Each part gets
    its own stem from a hash of the full id, and a retry of either (its
    response lost in a tunnel drop) returns the file it already made."""
    monkeypatch.setattr(server.time, "strftime", lambda fmt, *a: "20261027-120000")
    ride = "7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd"
    data = _encode(tmp_path, "m4a")
    f1 = client.post(f"/api/mesa/export?name=cabine&client_id={ride}-1", content=data).json()["file"]
    f2 = client.post(f"/api/mesa/export?name=cabine&client_id={ride}-2", content=data).json()["file"]
    assert f1 != f2
    # the parts of one ride group in O Arquivo: one stem (a hash of the
    # ride id), then -p<n>
    assert f1 == f"cabine-20261027-120000-{_cid_stem(ride)}-p1.m4a"
    assert f2 == f"cabine-20261027-120000-{_cid_stem(ride)}-p2.m4a"
    assert (exports / (f1 + ".cid")).read_text() == f"{ride}-1"
    assert (exports / (f2 + ".cid")).read_text() == f"{ride}-2"
    # a ride id without dashes (the no-randomUUID fallback) groups the same way
    r10 = client.post("/api/mesa/export?name=cabine&client_id=rabc123xyz-10", content=data).json()["file"]
    assert r10 == f"cabine-20261027-120000-{_cid_stem('rabc123xyz')}-p10.m4a"
    before = sorted(p.name for p in exports.iterdir())
    for cid, f in ((f"{ride}-2", f2), (f"{ride}-1", f1), ("rabc123xyz-10", r10)):
        r = client.post(f"/api/mesa/export?name=cabine&client_id={cid}", content=data)
        assert r.json() == {"file": f}, cid
    assert sorted(p.name for p in exports.iterdir()) == before
    # another ride's part 1 is a different recording with its own stem
    other_ride = "7c1d2e3f-aaaa-4bbb-8ccc-eeeeeeeeeeee"
    fo = client.post(f"/api/mesa/export?name=cabine&client_id={other_ride}-1", content=data).json()["file"]
    assert fo == f"cabine-20261027-120000-{_cid_stem(other_ride)}-p1.m4a"
    # a part 1 stored before the -p names (stem of the whole id) is still found
    old_part = f"{ride}-3"
    legacy_part = f"cabine-20261026-120000-{_cid_stem(old_part)}.m4a"
    (exports / legacy_part).write_bytes(data)
    (exports / (legacy_part + ".cid")).write_text(old_part)
    assert client.post(f"/api/mesa/export?name=cabine&client_id={old_part}", content=data).json() == {"file": legacy_part}
    # a suffixed name (two different ids whose hashes share 8 chars in one
    # second) is still found by its retry
    other = "11111111-2222-4333-8444-555555555555"
    suffixed = f"cabine-20261027-120000-{_cid_stem(other)}-2.m4a"
    (exports / suffixed).write_bytes(data)
    (exports / (suffixed + ".cid")).write_text(other)
    assert client.post(f"/api/mesa/export?name=cabine&client_id={other}", content=data).json() == {"file": suffixed}
    # an export made before the hash stems (named by the id's first 8) is found too
    legacy_id = "abcdef12-0000-4000-8000-000000000001"
    legacy = "cabine-20261001-090000-abcdef12.m4a"
    (exports / legacy).write_bytes(data)
    (exports / (legacy + ".cid")).write_text(legacy_id)
    assert client.post(f"/api/mesa/export?name=cabine&client_id={legacy_id}", content=data).json() == {"file": legacy}


@pytest.mark.parametrize("ext", ["webm", "m4a"])
def test_transcode_timeout_is_503_not_400(client, exports, tmp_path, monkeypatch, ext):
    """A transcode (webm) or remux (m4a) that runs out of time is the
    server's trouble: 503, so the phone keeps the take queued and retries
    (a 400 would mark it rejected)."""
    import subprocess as sp
    data = _encode(tmp_path, ext)
    real = sp.run

    def slow(cmd, *a, **k):
        if cmd and cmd[0] == "ffmpeg":
            raise sp.TimeoutExpired(cmd, k.get("timeout", 1))
        return real(cmd, *a, **k)

    monkeypatch.setattr(sp, "run", slow)
    r = client.post("/api/mesa/export?name=cabine&client_id=eeeeeeee-1", content=data)
    assert r.status_code == 503, r.text
    assert not exports.exists() or not any(exports.iterdir())
