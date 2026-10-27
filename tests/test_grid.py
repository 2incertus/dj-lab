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


def test_fit_stores_bpm_with_four_decimals():
    # exact beats at a tempo with more than two decimals: the sidecar keeps
    # four (display rounding is the client's job)
    bpm = 127.98765
    beats = 0.37 + np.arange(1900) * 60 / bpm
    g = fit_constant_grid(beats, None)
    assert g["bpm"] == round(bpm, 4) == 127.9877
    assert g["first_beat_s"] == pytest.approx(0.37, abs=1e-5)


def test_fit_grid_stays_on_the_beats_over_a_long_track():
    # ~15 minutes at 127.98765 BPM: two-decimal rounding (127.99) drifts
    # 16 ms over the track; four decimals keep every grid beat within 1 ms
    bpm = 127.98765
    beats = 0.37 + np.arange(1900) * 60 / bpm
    g = fit_constant_grid(beats, None)
    grid_beats = g["first_beat_s"] + np.arange(1900) * 60 / g["bpm"]
    worst = float(np.max(np.abs(grid_beats - beats)))
    assert worst < 0.001, f"grid off the beats by {worst * 1000:.2f} ms"


def test_two_decimal_sidecars_stay_valid(tmp_path):
    src = tmp_path / "old.wav"
    src.write_bytes(b"")
    g = {"bpm": 127.99, "first_beat_s": 0.37, "downbeat_s": 0.37, "beat_cv": 0.01,
         "reliable": True, "source": "beat_this", "fixed": False}
    save_grid(src, g)
    assert load_grid(src) == g
    assert apply_fix(g, "double")["bpm"] == 255.98


def test_halve_then_double_round_trips_at_four_decimals():
    g = {"bpm": 127.9877, "first_beat_s": 0.37, "downbeat_s": 0.37, "beat_cv": 0.01,
         "reliable": True, "source": "beat_this", "fixed": False}
    h = apply_fix(g, "halve")
    assert h["bpm"] == 127.9877 / 2                 # 63.99385: no precision lost
    assert apply_fix(h, "double")["bpm"] == 127.9877
    assert apply_fix(apply_fix(g, "double"), "halve")["bpm"] == 127.9877


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


def test_librosa_fallback_and_ensure_grid(wav_file, monkeypatch, capsys):
    def broken():
        raise ImportError("no beat_this here")
    monkeypatch.setattr(grid_mod, "_beat_this", broken)
    p = wav_file(bpm=128.0, seconds=20, offset_s=0.25)
    g = ensure_grid(p)
    assert g["source"] == "librosa"
    # the fallback is said out loud (inside a job, this lands in its log)
    assert "beat_this failed, using librosa: no beat_this here" in capsys.readouterr().out
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


@pytest.fixture
def deadline():
    """Fail (not hang) if the test body runs longer than 5 s."""
    import signal

    def boom(*_):
        raise TimeoutError("took over 5 s: a loop that never exits?")
    old = signal.signal(signal.SIGALRM, boom)
    signal.alarm(5)
    yield
    signal.alarm(0)
    signal.signal(signal.SIGALRM, old)


_G = {"bpm": 128.0, "first_beat_s": 0.25, "downbeat_s": 0.25, "beat_cv": 0.01,
      "reliable": True, "source": "beat_this", "fixed": False}


@pytest.mark.parametrize("op,bad", [
    ("nudge", -1e20), ("nudge", -1e300), ("nudge", 1e308),
    ("nudge", 60000.001), ("nudge", -60000.001),
    ("downbeat", -1e300), ("downbeat", 1e308), ("downbeat", -0.001),
    ("downbeat", 900.001),
])
def test_apply_fix_rejects_out_of_range(deadline, op, bad):
    with pytest.raises(ValueError):
        apply_fix(_G, op, bad)


def test_apply_fix_range_edges_are_accepted(deadline):
    period = 60 / 128.0
    for ms in (60000, -60000):
        g = apply_fix(_G, "nudge", ms)
        assert 0 <= g["first_beat_s"] < period
        assert 0 <= g["downbeat_s"]
        # the downbeat moved by whole bars at most: still on the nudged grid
        k = (g["downbeat_s"] - (0.25 + ms / 1000)) / (4 * period)
        assert abs(k - round(k)) < 1e-4
    # a tap at 0 s snaps to the beat at -0.219 s, moved forward one bar
    assert apply_fix(_G, "downbeat", 0)["downbeat_s"] == pytest.approx(0.25 - period + 4 * period)
    d = apply_fix(_G, "downbeat", 900)["downbeat_s"]
    assert abs(d - 900) <= period / 2 and 0 <= d


def test_wrap_and_snap_are_constant_time(deadline):
    # no loop: any finite input returns at once, inside its range
    for t in (-1e300, -1e20, -7.3, 0.0, 1e20, 1e300):
        w = grid_mod._wrap(t, 0.46875)
        assert 0 <= w < 0.46875
    for t in (-1e20, -50.0, -0.1):
        s = grid_mod._snap(t, 0.25, 0.46875)
        assert 0 <= s < 4 * 0.46875
