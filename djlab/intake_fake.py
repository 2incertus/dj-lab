"""Test-only intake for the A Cabine crate e2e tests.

Active only when the env var CABINE_FAKE_INTAKE is "1" (the e2e dev
container sets it; production never does). The three search routes then
answer from tests/fixtures/intake_fake.json and a pull writes a short
click track into sources/techno/ (analysis and grid included) without
yt-dlp or the network.

A fixture item marked "hold" writes nothing: it keeps the single job
lock until the marker file sources/techno/.cabine-e2e-hold is removed
(or two minutes pass), so a test can carry a track while "another job
is running".
"""

import json
import os
import time
from pathlib import Path

import numpy as np

from . import recipes as rc

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "intake_fake.json"
SR = 44100
CLICK_BPM = 126.0
HOLD_MAX_S = 120.0


def enabled() -> bool:
    return os.getenv("CABINE_FAKE_INTAKE") == "1"


def fixtures() -> dict:
    return json.loads(FIXTURES.read_text())


def hold_marker() -> Path:
    return rc.SOURCES / "techno" / ".cabine-e2e-hold"


def search(kind: str, q: str) -> list[dict]:
    """The fixture results for a source, whatever the query."""
    keep = ("id", "url", "title", "channel", "duration", "views", "source", "too_long")
    items = fixtures().get(kind, [])
    if kind == "spotify":
        return [dict(t) for t in items]
    return [{k: t[k] for k in keep if k in t} for t in items]


def _item(url: str) -> dict | None:
    data = fixtures()
    for kind in ("youtube", "soundcloud"):
        for t in data.get(kind, []):
            if t["url"] == url:
                return t
    return None


def _click_track(seconds: float) -> np.ndarray:
    """Stereo four-on-the-floor clicks, louder on every fourth beat."""
    n = int(seconds * SR)
    y = np.zeros(n, dtype=np.float32)
    period = 60.0 / CLICK_BPM
    tail = int(0.04 * SR)
    t = np.arange(tail) / SR
    click = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t / 0.006)).astype(np.float32)
    beat = 0
    while True:
        start = int(round((0.1 + beat * period) * SR))
        if start >= n:
            break
        end = min(n, start + tail)
        y[start:end] += click[:end - start] * (0.9 if beat % 4 == 0 else 0.5)
        beat += 1
    return np.stack([y, y], axis=1)


def pull(url: str, folder: str, name: str | None = None) -> Path | None:
    from . import intake
    item = _item(url)
    if item is None:
        raise ValueError("that url is not in the fake intake fixtures")
    if item.get("too_long"):
        raise ValueError(intake.SET_ERROR)
    print(f"pulling (fake intake): {item['title']}  ({item['duration']}s)", flush=True)
    if item.get("hold"):
        marker = hold_marker()
        print("  holding the job lock ...", flush=True)
        end = time.time() + HOLD_MAX_S
        while marker.exists() and time.time() < end:
            time.sleep(0.1)
        print("  released", flush=True)
        return None

    import soundfile as sf
    slug = intake.slugify(name) if name else item["slug"]
    dest = rc.SOURCES / folder
    dest.mkdir(parents=True, exist_ok=True)
    wav = dest / f"{slug}.wav"
    print(f"  -> sources/{folder}/{wav.name}", flush=True)
    sf.write(str(wav), _click_track(float(item["duration"])), SR)
    print("analyzing ...", flush=True)
    info = intake.analyze_into_log(wav)
    print(f"  {info.get('bpm')} BPM  beat cv {info.get('beat_cv')}", flush=True)
    print("beat grid ...", flush=True)
    print(intake.grid_line(wav), flush=True)
    return wav
