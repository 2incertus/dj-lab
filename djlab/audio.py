"""Audio I/O and gain staging helpers.

DSP notes for the learning log:

Digital audio here is float arrays in [-1.0, 1.0] at 44.1 kHz. Gain is
always expressed in decibels (dB) because perception of loudness is
logarithmic: +6 dB is roughly "twice as loud a voltage", and mixing
decisions in dB transfer directly to what you will later do on a mixer's
channel faders.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from . import SR


def db_to_gain(db: float) -> float:
    """dB -> linear amplitude multiplier. 0 dB = 1.0, -6 dB ~= 0.5."""
    return float(10.0 ** (db / 20.0))


def load(path: str | Path, sr: int = SR, mono: bool = False) -> np.ndarray:
    """Load any audio file as float32, resampled to `sr`.

    Tries libsndfile first (wav/flac/ogg/mp3). Anything else (m4a etc.)
    is decoded through ffmpeg to a temp wav. Returns shape (n,) if mono
    else (n, 2).
    """
    path = Path(path)
    try:
        data, file_sr = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
                 "-ar", str(sr), str(tmp.name)],
                check=True,
            )
            data, file_sr = sf.read(tmp.name, dtype="float32", always_2d=True)
            Path(tmp.name).unlink(missing_ok=True)
    if file_sr != sr:
        import librosa
        data = librosa.resample(data.T, orig_sr=file_sr, target_sr=sr).T
    if mono:
        return data.mean(axis=1)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    return data[:, :2]


def to_stereo(x: np.ndarray) -> np.ndarray:
    if x.ndim == 1:
        return np.stack([x, x], axis=1)
    return x


def save_wav(path: str | Path, x: np.ndarray, sr: int = SR) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, to_stereo(x).astype(np.float32), sr)
    return path


def save_mp3(wav_path: str | Path, mp3_path: str | Path | None = None) -> Path:
    """Encode an already-rendered wav to mp3 (V2 VBR, ~190 kbps)."""
    wav_path = Path(wav_path)
    mp3_path = Path(mp3_path) if mp3_path else wav_path.with_suffix(".mp3")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-codec:a", "libmp3lame", "-q:a", "2", str(mp3_path)],
        check=True,
    )
    return mp3_path


def fade(x: np.ndarray, fade_in_s: float = 0.01, fade_out_s: float = 0.05,
         sr: int = SR) -> np.ndarray:
    """Linear fade in/out. Every clip edge gets at least a few ms of fade:
    a waveform cut mid-cycle is a step discontinuity, which the ear hears
    as a click."""
    x = x.copy()
    n_in = min(int(fade_in_s * sr), len(x))
    n_out = min(int(fade_out_s * sr), len(x))
    ramp_in = np.linspace(0.0, 1.0, n_in)
    ramp_out = np.linspace(1.0, 0.0, n_out)
    if x.ndim == 1:
        x[:n_in] *= ramp_in
        x[len(x) - n_out:] *= ramp_out
    else:
        x[:n_in] *= ramp_in[:, None]
        x[len(x) - n_out:] *= ramp_out[:, None]
    return x


def peak_normalize(x: np.ndarray, peak_db: float = -1.0) -> np.ndarray:
    """Scale so the loudest sample sits at peak_db (default -1 dBFS,
    leaving headroom for mp3 encoding overshoot)."""
    peak = float(np.max(np.abs(x)))
    if peak < 1e-9:
        return x
    return x * (db_to_gain(peak_db) / peak)
