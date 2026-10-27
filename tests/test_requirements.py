"""requirements.txt: reproducible grids (Beat This! pinned to a commit) and
the libraries the server imports directly."""

import re
from pathlib import Path

REQ = Path(__file__).resolve().parents[1] / "requirements.txt"


def _lines():
    return [ln.strip() for ln in REQ.read_text().splitlines() if ln.strip() and not ln.startswith("#")]


def test_beat_this_is_pinned_to_a_commit_archive():
    bt = [ln for ln in _lines() if ln.replace("-", "_").lower().startswith("beat_this")]
    assert len(bt) == 1, bt
    assert re.fullmatch(r"beat_this @ https://github\.com/CPJKU/beat_this/archive/[0-9a-f]{40}\.zip", bt[0]), bt[0]


def test_soundfile_is_listed():
    assert "soundfile" in [re.split(r"[<>=@ ]", ln)[0].lower() for ln in _lines()]
