"""BPM + key detection and warp-risk flags.

Theory notes for the learning log:

BPM: librosa finds the tempo by autocorrelating an "onset envelope" (a
curve that spikes at every percussive hit). Machine music gives one
sharp answer; human music gives a blurry one. We report the beat-
interval coefficient of variation (CV): under ~5% is machine-tight,
5-12% is human-but-loopable, over ~12% is rubato -- it will NOT warp
cleanly and should be treated as free-floating texture or hand-sliced.

Octave errors are endemic in tempo detection (70 vs 140 BPM is the SAME
autocorrelation peak), which is why half/double candidates are always
printed. For this project that ambiguity is not a bug, it is the whole
technique: a 72 BPM baiao IS a 144 BPM techno track in half-time.

Key: we average a chromagram (energy in each of the 12 pitch classes)
over the whole file and correlate it against the Krumhansl-Schmuckler
major/minor templates -- 24 correlations, best one wins. Confidence is
the margin over the runner-up. Modal Brazilian material (dorian/
mixolydian) often reads as its relative major/minor; treat the reported
key as "tonal center", trust your ears for the mode, and prefer beds
with no third in the chord (ours have none).
"""

import json
from pathlib import Path

import numpy as np

from . import SR
from .audio import load

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                          2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                          2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CAMELOT = {("B", "maj"): "1B", ("F#", "maj"): "2B", ("C#", "maj"): "3B",
           ("G#", "maj"): "4B", ("D#", "maj"): "5B", ("A#", "maj"): "6B",
           ("F", "maj"): "7B", ("C", "maj"): "8B", ("G", "maj"): "9B",
           ("D", "maj"): "10B", ("A", "maj"): "11B", ("E", "maj"): "12B",
           ("G#", "min"): "1A", ("D#", "min"): "2A", ("A#", "min"): "3A",
           ("F", "min"): "4A", ("C", "min"): "5A", ("G", "min"): "6A",
           ("D", "min"): "7A", ("A", "min"): "8A", ("E", "min"): "9A",
           ("B", "min"): "10A", ("F#", "min"): "11A", ("C#", "min"): "12A"}

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aiff", ".aif"}


def detect_key(y: np.ndarray, sr: int = SR) -> dict:
    import librosa
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    scores = []
    for mode, profile in (("maj", MAJOR_PROFILE), ("min", MINOR_PROFILE)):
        for shift in range(12):
            r = np.corrcoef(np.roll(profile, shift), chroma)[0, 1]
            scores.append((r, NOTES[shift], mode))
    scores.sort(reverse=True)
    (best_r, note, mode), (second_r, _, _) = scores[0], scores[1]
    return {"key": f"{note} {mode}", "note": note, "mode": mode,
            "camelot": CAMELOT[(note, mode)],
            "confidence": round(float(best_r - second_r), 3)}


def detect_tempo(y: np.ndarray, sr: int = SR) -> dict:
    import librosa
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beats, sr=sr)
    cv = 1.0
    if len(beat_times) > 8:
        intervals = np.diff(beat_times)
        cv = float(np.std(intervals) / (np.mean(intervals) + 1e-9))
    return {"bpm": round(tempo, 1), "bpm_half": round(tempo / 2, 1),
            "bpm_double": round(tempo * 2, 1), "beat_cv": round(cv, 3)}


def warp_verdict(beat_cv: float) -> str:
    if beat_cv < 0.05:
        return "clean -- machine-tight, warps like a techno record"
    if beat_cv < 0.12:
        return "ok -- human timing, loop short sections (1-2 bars)"
    return "FLAG: rubato -- will not warp cleanly; use as free texture or hand-slice"


def analyze_file(path: Path) -> dict:
    y = load(path, mono=True)
    dur = len(y) / SR
    clip_frac = float(np.mean(np.abs(y) > 0.999))
    info = {"file": str(path), "duration_s": round(dur, 1),
            "clipping_pct": round(clip_frac * 100, 2)}
    info.update(detect_tempo(y))
    info.update(detect_key(y))
    info["warp"] = warp_verdict(info["beat_cv"])
    if clip_frac > 0.001:
        info["warp"] += " | FLAG: clipped samples (hot vinyl rip? re-record lower)"
    return info


def analyze_folder(folder: Path, out_json: Path | None = None) -> list[dict]:
    files = sorted(p for p in folder.rglob("*")
                   if p.suffix.lower() in AUDIO_EXTS)
    results = []
    for f in files:
        print(f"  analyzing {f.name} ...", flush=True)
        try:
            results.append(analyze_file(f))
        except Exception as e:
            results.append({"file": str(f), "error": str(e)})
    if out_json:
        out_json.write_text(json.dumps(results, indent=2))
    return results


def print_log(results: list[dict]) -> None:
    if not results:
        print("No audio files found. Drop sources first (see: dj sources).")
        return
    hdr = f"{'file':<44} {'dur':>6} {'BPM':>6} {'half':>6} {'2x':>6} {'key':>6} {'cam':>4} {'conf':>5}  warp"
    print("\n" + hdr)
    print("-" * len(hdr))
    for r in results:
        if "error" in r:
            print(f"{Path(r['file']).name:<44} ERROR: {r['error']}")
            continue
        print(f"{Path(r['file']).name:<44.44} {r['duration_s']:>6} {r['bpm']:>6} "
              f"{r['bpm_half']:>6} {r['bpm_double']:>6} {r['note'] + r['mode'][0]:>6} "
              f"{r['camelot']:>4} {r['confidence']:>5}  {r['warp']}")
    print()
