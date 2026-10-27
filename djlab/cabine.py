"""A Cabine, server side: the track library the phone board loads from,
carry-ready MP3s, and waveform peaks.

Carried audio is what the phone keeps offline: MP3 VBR V0 (libmp3lame
-q:a 0), 44.1 kHz stereo, with the LAME header that lets decoders drop the
encoder delay, so beat times measured on the source line up on the carry.
Peaks are a tiny binary the board draws its waveforms from:

    b"PK01" | uint32 LE rate (peaks per second) | uint32 LE n | n x uint8

each value the max abs amplitude of the mono mix over 1/rate s, scaled so
the loudest peak of the track is 255.

Both are cached under carry/ (gitignored) and rebuilt when the source is
newer, like the mono previews behind /api/source/preview.
"""

import json
import os
import re
import struct
import subprocess
import threading
from pathlib import Path

import numpy as np

from . import recipes as rc
from . import grid as gr
from .grid import load_grid

MAX_TRACK_S = gr.MAX_TRACK_S   # 900: longer than 15 min is a set, not a track
CARRY = rc.ROOT / "carry"
SR = 44100
PEAK_RATE = 100


def title_of(src: Path) -> str:
    """Intake slugs are `<channel>__<title>`: "channel - title", dashes to spaces."""
    parts = [re.sub(r"[-_]+", " ", p).strip() for p in src.stem.split("__")]
    return " - ".join(p for p in parts if p) or src.stem


def _fresh(out: Path, src: Path) -> bool:
    return out.exists() and out.stat().st_mtime >= src.stat().st_mtime


def _tmp(out: Path) -> Path:
    return out.with_name(f".{out.name}.{os.getpid()}.{threading.get_ident()}.tmp")


def _carry_out(src: Path) -> Path:
    return CARRY / (src.stem + ".mp3")


def library() -> list[dict]:
    aj = rc.ROOT / "analysis.json"
    if not aj.exists():
        return []
    seen, items = set(), []
    for e in json.loads(aj.read_text()):
        name = Path(str(e.get("file", ""))).name
        dur = e.get("duration_s")
        if not name or name in seen or dur is None or dur > MAX_TRACK_S:
            continue
        seen.add(name)
        src = rc.find_file(name)
        if not src:
            continue
        carry = _carry_out(src)
        items.append((src.stat().st_mtime, {
            "file": src.name,
            "title": title_of(src),
            "folder": src.parent.name,
            "duration_s": dur,
            "bpm": e.get("bpm"),
            "key": e.get("key"),
            "camelot": e.get("camelot"),
            "beat_cv": e.get("beat_cv"),
            "grid": load_grid(src),
            "carry_bytes": carry.stat().st_size if _fresh(carry, src) else None,
        }))
    items.sort(key=lambda it: it[0], reverse=True)
    return [it[1] for it in items]


def carry_mp3(src: Path) -> Path:
    """The carried copy of a source: MP3 V0, 44.1 kHz stereo, cached by mtime."""
    src = Path(src)
    out = _carry_out(src)
    if not _fresh(out, src):
        CARRY.mkdir(parents=True, exist_ok=True)
        tmp = _tmp(out)
        try:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                            "-ac", "2", "-ar", str(SR), "-c:a", "libmp3lame",
                            "-q:a", "0", "-f", "mp3", str(tmp)], check=True)
            os.replace(tmp, out)
        finally:
            tmp.unlink(missing_ok=True)
    return out


def _peak_values(src: Path) -> np.ndarray:
    """Max abs sample of the mono mix per 1/PEAK_RATE s, streamed from ffmpeg."""
    win = SR // PEAK_RATE
    chunk = win * PEAK_RATE * 10 * 2          # 10 s of s16 mono per read
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(src), "-f", "s16le",
                             "-ac", "1", "-ar", str(SR), "-"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, rest = [], b""
    try:
        while True:
            buf = proc.stdout.read(chunk)
            if not buf:
                break
            buf = rest + buf
            whole = len(buf) // (win * 2) * (win * 2)
            rest = buf[whole:]
            if whole:
                a = np.abs(np.frombuffer(buf[:whole], dtype="<i2").astype(np.int32))
                out.append(a.reshape(-1, win).max(axis=1))
        if len(rest) >= 2:
            a = np.abs(np.frombuffer(rest[:len(rest) // 2 * 2], dtype="<i2").astype(np.int32))
            out.append(a.max(keepdims=True))
        err = proc.stderr.read()
    finally:
        proc.stdout.close()
        proc.stderr.close()
        rc_ = proc.wait()
    if rc_ != 0:
        raise RuntimeError(f"ffmpeg could not decode {src.name}: {err.decode(errors='replace').strip()}")
    return np.concatenate(out) if out else np.zeros(0, dtype=np.int32)


def peaks(src: Path) -> Path:
    src = Path(src)
    out = CARRY / (src.stem + ".peaks")
    if not _fresh(out, src):
        CARRY.mkdir(parents=True, exist_ok=True)
        v = _peak_values(src)
        top = int(v.max()) if len(v) else 0
        scaled = (np.rint(v * (255.0 / top)) if top else np.zeros(len(v))).astype(np.uint8)
        tmp = _tmp(out)
        try:
            tmp.write_bytes(b"PK01" + struct.pack("<II", PEAK_RATE, len(scaled))
                            + scaled.tobytes())
            os.replace(tmp, out)
        finally:
            tmp.unlink(missing_ok=True)
    return out
