"""Shared fixtures: synthetic click tracks with a known grid.

A click track here is a four-on-the-floor kick at a fixed tempo whose
first beat lands at `offset_s`. Every `accent_every`-th kick is a
downbeat: louder, and it starts a new chord that rings for the bar.

Why the chord: Beat This! hears bar starts from harmonic change, not from
loudness. On kicks alone (accented or with a noise burst on beat 1) it
consistently put the downbeat one beat late; with a chord change per bar
it lands on the accent.
"""

from pathlib import Path

import numpy as np
import pytest


def make_click_track(bpm: float, seconds: float, offset_s: float,
                     sr: int = 44100, accent_every: int = 4) -> np.ndarray:
    n = int(round(seconds * sr))
    y = np.zeros(n, dtype=np.float32)
    kick_len = int(0.15 * sr)
    t = np.arange(kick_len) / sr
    # pitch sweep 150 -> 50 Hz with an exponential amplitude decay
    freq = 50.0 + 100.0 * np.exp(-t / 0.03)
    phase = 2 * np.pi * np.cumsum(freq) / sr
    kick = (np.sin(phase) * np.exp(-t / 0.05)).astype(np.float32)
    period = 60.0 / bpm
    bar_len = int(round(max(accent_every, 1) * period * sr))
    tb = np.arange(bar_len) / sr
    roots = (110.0, 146.83, 130.81, 98.0)       # A, D, C, G: a change every bar
    chords = [(sum(np.sin(2 * np.pi * f * m * tb) for m in (1.0, 1.25, 1.5))
               * 0.08 * np.exp(-tb / 1.0)).astype(np.float32) for f in roots]
    i = 0
    while True:
        start = int(round((offset_s + i * period) * sr))
        if start >= n:
            break
        accent = accent_every > 0 and i % accent_every == 0
        seg = kick * (0.9 if accent else 0.45)
        end = min(n, start + kick_len)
        y[start:end] += seg[:end - start]
        if accent:
            chord = chords[(i // accent_every) % len(chords)]
            end = min(n, start + bar_len)
            y[start:end] += chord[:end - start]
        i += 1
    return np.clip(y, -1.0, 1.0)


@pytest.fixture
def click_track():
    """click_track(bpm, seconds, offset_s, sr=44100, accent_every=4) -> np.ndarray"""
    return make_click_track


@pytest.fixture
def wav_file(tmp_path):
    """wav_file(bpm, seconds, offset_s, sr=44100, accent_every=4, name=...) -> Path"""
    def _make(bpm: float, seconds: float, offset_s: float, sr: int = 44100,
              accent_every: int = 4, name: str = "click.wav") -> Path:
        import soundfile as sf  # lazy: the host e2e run has no soundfile
        y = make_click_track(bpm, seconds, offset_s, sr=sr,
                             accent_every=accent_every)
        p = tmp_path / name
        sf.write(p, y, sr)
        return p
    return _make
