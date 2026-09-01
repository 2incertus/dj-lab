"""Time-stretching with half-time awareness.

The core trick of this whole project, in one function
(`plan`): you never stretch a 72 BPM baiao to 144 -- you LEAVE it at 72
and call it half-time. The only stretch applied is the small correction
between (source_bpm x mult) and the techno tempo, so a 70 BPM zabumba
under a 135 BPM kick is stretched by 135/140 = only 3.6%, not 93%.
Small ratios are what keep stretched audio sounding like music.

Two ways to change tempo:

1. Time-stretch (rubberband / phase vocoder): tempo changes, pitch does
   not. This is what "master tempo" / "keylock" does on a CDJ. Costs
   artifacts: transients smear, tails get 'phasey'. Rubberband's R3
   engine (-3) is used because it protects transients far better than a
   plain phase vocoder -- that matters for pandeiro and zabumba hits.

2. Repitch (resampling): tempo AND pitch change together, like the
   pitch fader on your AT-LP120 with keylock off. Zero artifacts, but
   +6% tempo = +1 semitone sharp. For dark percussive material,
   repitching DOWN often sounds BETTER (heavier, darker) -- techno DJs
   frequently prefer it. Both are provided; A/B them.
"""

import shutil
from dataclasses import dataclass

import numpy as np

from . import SR


@dataclass
class WarpPlan:
    mult: float        # 0.5 = half-time, 1 = straight, 2 = double-time
    rate: float        # stretch factor actually applied (>1 = faster)
    cents: float       # pitch shift IF repitching instead of stretching
    verdict: str

    def describe(self, source_bpm: float, target_bpm: float) -> str:
        feel = {0.5: "half-time", 1.0: "straight", 2.0: "double-time"}[self.mult]
        return (f"{source_bpm:.0f} BPM source, {feel} against {target_bpm:.0f} "
                f"-> stretch x{self.rate:.3f} ({(self.rate - 1) * 100:+.1f}%, "
                f"{self.cents:+.0f} cents if repitched). {self.verdict}")


def plan(source_bpm: float, target_bpm: float) -> WarpPlan:
    """Pick the multiplier (0.5/1/2) that needs the least stretching."""
    best = None
    for mult in (0.5, 1.0, 2.0):
        # After stretching by `rate`, the source runs at source_bpm*rate,
        # which must equal mult*target_bpm: 0.5 = its beats land on every
        # 2nd techno beat (half-time), 2.0 = two source beats per techno
        # beat (double-time).
        rate = (mult * target_bpm) / source_bpm
        if best is None or abs(np.log2(rate)) < abs(np.log2(best[1])):
            best = (mult, rate)
    mult, rate = best
    cents = 1200 * np.log2(rate)
    pct = abs(rate - 1)
    if pct < 0.06:
        verdict = "clean (within a turntable pitch fader's +-6%)"
    elif pct < 0.13:
        verdict = "ok, audible on tonal material -- fine for percussion"
    else:
        verdict = "FLAG: big stretch -- expect artifacts, consider slicing instead"
    return WarpPlan(mult, float(rate), float(cents), verdict)


def stretch(y: np.ndarray, rate: float, sr: int = SR,
            percussive: bool = True) -> np.ndarray:
    """Tempo change, pitch preserved. Rubberband R3 if available."""
    if abs(rate - 1.0) < 1e-4:
        return y
    if shutil.which("rubberband"):
        import pyrubberband as pyrb
        rbargs = {"-3": ""}
        if percussive:
            rbargs["--no-lamination"] = ""
        return pyrb.time_stretch(y, sr, rate, rbargs=rbargs)
    import librosa
    return librosa.effects.time_stretch(y, rate=rate)


def repitch(y: np.ndarray, rate: float, sr: int = SR) -> np.ndarray:
    """Tempo AND pitch change together -- the turntable pitch fader."""
    import librosa
    return librosa.resample(y, orig_sr=int(sr * rate), target_sr=sr)


def fit_to_length(y: np.ndarray, target_len: int, sr: int = SR,
                  percussive: bool = True) -> np.ndarray:
    """Stretch a segment so it lasts exactly target_len samples, then
    pad/trim the rounding error. Used to lock a sliced loop onto the
    techno bar grid."""
    if len(y) == 0:
        return np.zeros(target_len)
    rate = len(y) / target_len
    out = stretch(y, rate, sr, percussive)
    if len(out) < target_len:
        out = np.pad(out, (0, target_len - len(out)))
    return out[:target_len]


def tile(y: np.ndarray, total_len: int) -> np.ndarray:
    """Repeat a loop to fill total_len samples."""
    reps = int(np.ceil(total_len / max(len(y), 1)))
    return np.tile(y, reps)[:total_len]
