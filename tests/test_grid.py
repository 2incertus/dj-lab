import numpy as np
import pytest

from djlab import grid as grid_mod
from djlab.grid import (apply_fix, compute_grid, ensure_grid, fit_constant_grid,
                        grid_path, load_grid, save_grid)


def test_fit_recovers_bpm_and_phase():
    beats = 0.37 + np.arange(400) * 60 / 132.0 + np.random.default_rng(1).normal(0, 0.004, 400)
    g = fit_constant_grid(beats, None)
    assert abs(g["bpm"] - 132.0) < 0.02
    assert abs(g["first_beat_s"] - 0.37) < 0.005
    assert g["reliable"] is True


def test_fit_flags_rubato():
    rng = np.random.default_rng(2)
    beats = np.cumsum(rng.uniform(0.35, 0.65, 300))
    assert fit_constant_grid(beats, None)["reliable"] is False   # beat_cv > 0.12


def test_compute_grid_on_click_track(wav_file):
    p = wav_file(bpm=128.0, seconds=60, offset_s=0.25)
    g = compute_grid(p)
    assert g["source"] == "beat_this"              # not a silent librosa fallback
    assert abs(g["bpm"] - 128.0) < 0.05
    assert abs(g["first_beat_s"] - 0.25) < 0.01
    assert abs(g["downbeat_s"] - 0.25) < 0.01      # accents every 4


def test_fit_downbeat_phase_from_downbeats():
    period = 60 / 120.0
    beats = 0.37 + np.arange(64) * period
    downbeats = beats[2::4]                          # beat indices 2, 6, 10, ...
    g = fit_constant_grid(beats, downbeats)
    assert g["first_beat_s"] == pytest.approx(0.37, abs=1e-3)
    assert g["downbeat_s"] == pytest.approx(0.37 + 2 * period, abs=1e-3)
    # without downbeats the default is the first beat: the vote above mattered
    assert fit_constant_grid(beats, None)["downbeat_s"] == pytest.approx(0.37, abs=1e-3)


def test_fit_downbeat_majority_vote_wins():
    period = 60 / 120.0
    beats = 0.37 + np.arange(64) * period
    good = beats[2::4]                               # 16 votes for phase 2
    bad = beats[[1, 7, 12, 13, 21]]                  # 5 wrong votes (phases 1, 3, 0, 1, 1)
    downbeats = np.sort(np.concatenate([good, bad]))  # earliest one (beat 1) is wrong
    g = fit_constant_grid(beats, downbeats)
    assert g["downbeat_s"] == pytest.approx(0.37 + 2 * period, abs=1e-3)


def test_fixes():
    g = {"bpm": 66.0, "first_beat_s": 0.5, "downbeat_s": 0.5, "beat_cv": 0.02, "reliable": True, "source": "x", "fixed": False}
    assert apply_fix(g, "double")["bpm"] == 132.0
    assert apply_fix(g, "nudge", -10)["first_beat_s"] == pytest.approx(0.49)
    d = apply_fix(apply_fix(g, "double"), "downbeat", 1.40)   # beats at .5, .9545, 1.409 ...
    assert d["downbeat_s"] == pytest.approx(0.5 + 2 * 60 / 132, abs=1e-3)
    assert d["fixed"] is True


def test_sidecar_roundtrip(tmp_path):
    src = tmp_path / "track.wav"
    src.write_bytes(b"")
    assert grid_path(src).name.endswith(".wav.grid.json")
    assert grid_path(src).parent == src.parent
    assert load_grid(src) is None
    g = {"bpm": 128.0, "first_beat_s": 0.25, "downbeat_s": 0.25, "beat_cv": 0.01,
         "reliable": True, "source": "beat_this", "fixed": False}
    save_grid(src, g)
    assert load_grid(src) == g


def test_librosa_fallback_and_ensure_grid(wav_file, monkeypatch):
    def broken():
        raise ImportError("no beat_this here")
    monkeypatch.setattr(grid_mod, "_beat_this", broken)
    p = wav_file(bpm=128.0, seconds=20, offset_s=0.25)
    g = ensure_grid(p)
    assert g["source"] == "librosa"
    assert abs(g["bpm"] - 128.0) < 0.5
    assert grid_path(p).exists()
    assert load_grid(p) == g


@pytest.mark.parametrize("op", ["nudge", "downbeat"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_apply_fix_rejects_non_finite(op, bad):
    g = {"bpm": 128.0, "first_beat_s": 0.25, "downbeat_s": 0.25, "beat_cv": 0.01,
         "reliable": True, "source": "beat_this", "fixed": False}
    with pytest.raises(ValueError):
        apply_fix(g, op, bad)
