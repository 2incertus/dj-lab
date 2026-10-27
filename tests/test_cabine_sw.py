"""A Cabine's service worker: the precache list is every shell file on disk,
and its version is bumped whenever any of them changes.

The worker answers /cabine and every /static/cabine/** request from its
cache (offline-first), so a client change that ships without a new cache
version would never reach an installed phone. SHELL_HASH in the worker is
the fingerprint of the precached files; when this test fails on it, bump
VERSION and paste the new hash it prints.
"""

import hashlib
import re
from pathlib import Path

from djlab import server

DJLAB = Path(server.__file__).parent
STATIC = DJLAB / "static"
CABINE = STATIC / "cabine"
SW = DJLAB / "cabine_sw.js"

# under /static/cabine but not part of the shell: unit tests, the node
# package marker, the gated proof page, font licence texts
EXCLUDE_DIRS = {"test"}
EXCLUDE_FILES = {"package.json", "proof.html"}
EXCLUDE_SUFFIXES = {".txt", ".md"}


def _sw_text():
    return SW.read_text()


def _precache():
    m = re.search(r"const PRECACHE = \[(.*?)\];", _sw_text(), re.S)
    assert m, "cabine_sw.js has no PRECACHE list"
    return re.findall(r'"([^"]+)"', m.group(1))


def _on_disk():
    out = set()
    for p in CABINE.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(CABINE)
        if rel.parts[0] in EXCLUDE_DIRS or rel.name in EXCLUDE_FILES or p.suffix in EXCLUDE_SUFFIXES:
            continue
        out.add("/static/cabine/" + rel.as_posix())
    return out


def _disk_path(url: str) -> Path:
    path = url.split("?", 1)[0]
    assert path.startswith("/static/"), url
    return STATIC / path[len("/static/"):]


def shell_hash() -> str:
    h = hashlib.sha256()
    for url in sorted(u for u in _precache() if u.startswith("/static/")):
        h.update(url.encode() + b"\0")
        h.update(_disk_path(url).read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:16]


def test_precache_lists_every_shell_file_on_disk():
    listed = _precache()
    assert len(listed) == len(set(listed)), "duplicates in PRECACHE"
    cabine = {u for u in listed if u.startswith("/static/cabine/")}
    disk = _on_disk()
    assert disk - cabine == set(), f"on disk but not precached: {sorted(disk - cabine)}"
    assert cabine - disk == set(), f"precached but not on disk: {sorted(cabine - disk)}"
    # the pieces the offline board cannot start without
    for must in ("/static/cabine/cabine.html", "/static/cabine/cabine.css", "/static/cabine/app.js",
                 "/static/cabine/engine/deck-processor.js", "/static/cabine/engine/recorder.js"):
        assert must in listed, must
    assert any(u.startswith("/static/cabine/fonts/") and u.endswith(".woff2") for u in listed)
    # the icons the manifest and the page point at
    man_icons = {i["src"] for i in server.CABINE_MANIFEST["icons"]}
    assert man_icons <= set(listed), man_icons - set(listed)
    assert "/static/apple-touch-icon.png?v=3" in listed
    assert "/cabine/manifest.webmanifest" in listed
    for u in listed:
        if u.startswith("/static/"):
            assert _disk_path(u).is_file(), u
    # never cached: the gated proof page and the API
    assert not any(u.startswith(("/api/", "/audio/", "/cabine/proof")) for u in listed)


def test_cache_version_bumped_with_the_shell():
    src = _sw_text()
    v = re.search(r"const VERSION = (\d+);", src)
    assert v, "cabine_sw.js needs `const VERSION = <n>;`"
    assert re.search(r"`cabine-v\$\{VERSION\}`", src), "cache name is cabine-v<VERSION>"
    m = re.search(r'const SHELL_HASH = "([0-9a-f]{16})";', src)
    assert m, "cabine_sw.js needs `const SHELL_HASH = \"<16 hex>\";`"
    now = shell_hash()
    assert m.group(1) == now, (
        f"the shell changed: bump VERSION (now {v.group(1)}) in djlab/cabine_sw.js "
        f"and set SHELL_HASH = \"{now}\"")


def test_shell_has_no_network_fonts():
    html = (CABINE / "cabine.html").read_text()
    css = (CABINE / "cabine.css").read_text()
    assert "googleapis" not in html and "gstatic" not in html
    assert "googleapis" not in css and "gstatic" not in css
    for face in re.findall(r"@font-face\s*\{[^}]*\}", css):
        for url in re.findall(r"url\(([^)]+)\)", face):
            assert url.strip("\"'").startswith("/static/cabine/fonts/"), url
    assert css.count("@font-face") >= 2
