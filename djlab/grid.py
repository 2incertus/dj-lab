"""Beat grids for A Cabine: one constant tempo + phase per track.

A grid is the rekordbox idea of a track's beats: a single BPM, the time
of the first beat, and the time of a downbeat (beat 1 of a bar). Beat
This! (CPJKU) tracks beats and downbeats; a least-squares line through
the detected beats turns them into a constant grid. If Beat This! cannot
be imported or its model cannot load, librosa's beat tracker stands in.

Grids are stored next to the audio as `<file>.grid.json` sidecars. The
user can correct a grid on the board (halve, double, nudge, set the
downbeat); a corrected grid carries `fixed=True`.
"""

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import TypedDict

import numpy as np

from .audio import load

BEAT_THIS_SR = 22050
BEATS_PER_BAR = 4          # the FLX4 / rekordbox grid is 4/4
RUBATO_CV = 0.12           # same threshold as analyze.warp_verdict
MAX_TRACK_S = 900          # A Cabine refuses longer files (sets, not tracks)
MAX_NUDGE_MS = 60000       # a grid nudge is a correction, not a relocation

Grid = TypedDict("Grid", {"bpm": float, "first_beat_s": float, "downbeat_s": float,
                          "beat_cv": float, "reliable": bool, "source": str,
                          "fixed": bool})


def _wrap(t: float, period: float) -> float:
    """Wrap a time into [0, period). Python's float % is exact (fmod based)
    and constant time for any finite input; it can round up to `period`."""
    w = float(t) % period
    return 0.0 if w >= period else w


def _beat_cv(beat_times: np.ndarray) -> float:
    """Spread of inter-beat intervals, as analyze.detect_tempo computes it."""
    cv = 1.0
    if len(beat_times) > 8:
        intervals = np.diff(beat_times)
        cv = float(np.std(intervals) / (np.mean(intervals) + 1e-9))
    return round(cv, 3)


def _snap(t: float, first: float, period: float) -> float:
    """Grid beat nearest `t`, moved forward by whole bars if it is negative."""
    s = first + round((t - first) / period) * period
    return _wrap(s, BEATS_PER_BAR * period) if s < 0 else s


def fit_constant_grid(beat_times: np.ndarray, downbeat_times: np.ndarray | None) -> Grid:
    beats = np.sort(np.asarray(beat_times, dtype=float))
    if len(beats) < 2:
        raise ValueError("need at least 2 beats to fit a grid")
    med = float(np.median(np.diff(beats)))
    if med <= 0:
        raise ValueError("beat times do not advance")
    # beat index = cumulative intervals rounded to the median interval;
    # a skipped beat counts 2, a double detection (0) is dropped
    steps = np.rint(np.diff(beats) / med).astype(int)
    keep = np.concatenate([[True], steps > 0])
    idx = np.concatenate([[0], np.cumsum(steps)])[keep]
    times = beats[keep]

    slope, intercept = np.polyfit(idx, times, 1)
    # one refit without outliers (residual over a quarter beat)
    resid = np.abs(times - (slope * idx + intercept))
    inl = resid <= slope / 4
    if inl.sum() >= 2 and not inl.all():
        slope, intercept = np.polyfit(idx[inl], times[inl], 1)
        idx, times = idx[inl], times[inl]

    bpm = round(60.0 / slope, 2)
    period = 60.0 / bpm
    # re-solve the phase for the rounded tempo so the grid the board draws
    # (bpm, first_beat_s) is the best fit, not just the unrounded line
    intercept = float(np.mean(times - idx * period))
    first = _wrap(intercept, period)

    downbeat = first
    if downbeat_times is not None and len(downbeat_times) > 0:
        # bar phase = the beat-in-bar most downbeats land on
        k = np.rint((np.asarray(downbeat_times, dtype=float) - first) / period)
        phases = np.mod(k.astype(int), BEATS_PER_BAR)
        phase = int(np.bincount(phases, minlength=BEATS_PER_BAR).argmax())
        downbeat = first + phase * period

    cv = _beat_cv(beats)
    return Grid(bpm=float(bpm), first_beat_s=round(first, 6),
                downbeat_s=round(downbeat, 6), beat_cv=cv,
                reliable=bool(cv <= RUBATO_CV), source="fit", fixed=False)


@lru_cache(maxsize=1)
def _beat_this():
    """The Beat This! tracker, loaded once (checkpoint downloads on first use)."""
    import torch
    from beat_this.inference import Audio2Beats
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # Audio2Beats is File2Beats minus the file decoding: the audio is
    # decoded djlab-style (audio.load, ffmpeg fallback) and handed over
    return Audio2Beats(checkpoint_path="final0", device=device, dbn=False)


def _librosa_beats(y: np.ndarray, sr: int) -> np.ndarray:
    import librosa
    _, frames = librosa.beat.beat_track(y=y, sr=sr)
    return librosa.frames_to_time(frames, sr=sr)


def compute_grid(path: Path) -> Grid:
    y = load(path, sr=BEAT_THIS_SR, mono=True)
    try:
        beats, downbeats = _beat_this()(y, BEAT_THIS_SR)
        source = "beat_this"
    except Exception:
        beats, downbeats = _librosa_beats(y, BEAT_THIS_SR), None
        source = "librosa"
    g = fit_constant_grid(np.asarray(beats), None if downbeats is None
                          else np.asarray(downbeats))
    g["source"] = source
    return g


def grid_path(src: Path) -> Path:
    return src.parent / (src.name + ".grid.json")


def _sane(g) -> bool:
    """A grid whose numbers can be drawn (and serialized as strict JSON)."""
    try:
        nums = [float(g[k]) for k in ("bpm", "first_beat_s", "downbeat_s", "beat_cv")]
    except (KeyError, TypeError, ValueError):
        return False
    return all(math.isfinite(x) for x in nums) and nums[0] > 0


def load_grid(src: Path) -> Grid | None:
    """The sidecar grid, or None if there is none or it is unusable
    (e.g. NaN/Infinity written before fixes were checked)."""
    p = grid_path(Path(src))
    try:
        g = json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return g if isinstance(g, dict) and _sane(g) else None


def save_grid(src: Path, g: Grid) -> None:
    p = grid_path(Path(src))
    tmp = p.with_name(p.name + ".tmp")
    # allow_nan=False: never persist NaN/Infinity (ValueError instead)
    tmp.write_text(json.dumps(g, indent=2, allow_nan=False))
    os.replace(tmp, p)


def ensure_grid(src: Path) -> Grid:
    g = load_grid(src)
    if g is None:
        g = compute_grid(Path(src))
        save_grid(src, g)
    return g


def apply_fix(g: Grid, op: str, value: float | None = None) -> Grid:
    if value is not None:
        value = float(value)
        if not math.isfinite(value):
            # a NaN/inf nudge poisons the grid, and -inf never leaves the
            # "move the downbeat forward by bars" loop below
            raise ValueError(f"{op} needs a finite value")
        if op == "nudge" and abs(value) > MAX_NUDGE_MS:
            raise ValueError(f"nudge is limited to +-{MAX_NUDGE_MS} ms")
        if op == "downbeat" and not 0 <= value <= MAX_TRACK_S:
            raise ValueError(f"downbeat must be a time in 0..{MAX_TRACK_S} s")
    out = dict(g)
    period = 60.0 / g["bpm"]
    if op == "halve":
        out["bpm"] = round(g["bpm"] / 2, 2)
        # keep the downbeat on the grid: it anchors the surviving beats
        out["first_beat_s"] = _wrap(g["downbeat_s"], 60.0 / out["bpm"])
    elif op == "double":
        out["bpm"] = round(g["bpm"] * 2, 2)
        out["first_beat_s"] = _wrap(g["first_beat_s"], 60.0 / out["bpm"])
    elif op == "nudge":
        if value is None:
            raise ValueError("nudge needs a value in ms")
        shift = value / 1000.0
        out["first_beat_s"] = _wrap(g["first_beat_s"] + shift, period)
        out["downbeat_s"] = g["downbeat_s"] + shift
        if out["downbeat_s"] < 0:      # move forward by whole bars
            out["downbeat_s"] = _wrap(out["downbeat_s"], BEATS_PER_BAR * period)
    elif op == "downbeat":
        if value is None:
            raise ValueError("downbeat needs the tapped time in seconds")
        out["downbeat_s"] = _snap(float(value), g["first_beat_s"], period)
    else:
        raise ValueError(f"unknown grid fix: {op}")
    out["first_beat_s"] = round(float(out["first_beat_s"]), 6)
    out["downbeat_s"] = round(float(out["downbeat_s"]), 6)
    out["fixed"] = True
    return out
