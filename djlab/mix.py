"""Layering, sidechain ducking, and the master bus.

Mixing notes for the learning log:

Gain staging: every layer gets a dB offset BEFORE summing, and the sum
runs through a compressor + limiter. This mirrors a real DJ/live setup:
channel faders -> mix bus -> club limiter.

Sidechain ducking: everything tonal (drones, rumble, source material) is
multiplied by an envelope that dips at every kick and recovers over
~200-300 ms. The dip is inaudible as an effect at low depth; what you
hear is the kick punching THROUGH the wall of sound. This is the glue
of warehouse techno, and it is also what a DJ fakes manually by riding
the EQ low band during a blend.

Frequency slotting: each layer is highpassed/lowpassed into its own
lane (kick owns 40-100 Hz, rumble 60-200, drones 100-900, hats 6 kHz+).
Two sounds fighting for the same band = mud; this is why you cut bass
on the incoming track during a DJ transition.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pedalboard import Pedalboard, Compressor, HighpassFilter, Limiter, LowpassFilter, Reverb

from . import SR
from . import audio as au


@dataclass
class Layer:
    name: str
    x: np.ndarray            # mono float array
    gain_db: float = 0.0
    duck: float = 0.0        # 0 = ignore kick, 1 = full sidechain depth
    hp_hz: float | None = None
    lp_hz: float | None = None
    pan: float = 0.0         # -1 left .. +1 right
    mute: bool = False
    is_source: bool = False  # True = Brazilian source, False = bed synth

    def apply_overrides(self, ov: dict) -> None:
        for field in ("gain_db", "duck", "hp_hz", "lp_hz", "pan", "mute"):
            if field in ov and ov[field] is not None:
                setattr(self, field, ov[field])


def sidechain_env(n: int, kick_positions: list[int], depth_db: float = -8.0,
                  attack_s: float = 0.012, release_s: float = 0.26,
                  sr: int = SR) -> np.ndarray:
    """Gain envelope: 1.0 everywhere, dipping to depth_db at each kick,
    recovering exponentially. Multiply any layer by this to duck it."""
    env = np.ones(n)
    floor = au.db_to_gain(depth_db)
    n_att = max(1, int(attack_s * sr))
    n_rel = max(1, int(release_s * sr))
    rel_curve = floor + (1.0 - floor) * (1 - np.exp(-np.arange(n_rel) / (n_rel / 5)))
    for pos in kick_positions:
        a0, a1 = pos, min(pos + n_att, n)
        env[a0:a1] = np.minimum(env[a0:a1], np.linspace(1.0, floor, a1 - a0))
        r0, r1 = a1, min(a1 + n_rel, n)
        env[r0:r1] = np.minimum(env[r0:r1], rel_curve[: r1 - r0])
    return env


def _process(layer: Layer, sr: int = SR) -> np.ndarray:
    fx = []
    if layer.hp_hz:
        fx.append(HighpassFilter(cutoff_frequency_hz=layer.hp_hz))
    if layer.lp_hz:
        fx.append(LowpassFilter(cutoff_frequency_hz=layer.lp_hz))
    x = layer.x.astype(np.float32)
    if fx:
        x = Pedalboard(fx)(x, sr)
    return x * au.db_to_gain(layer.gain_db)


def rumble_from(kick_track: np.ndarray, lp_hz: float = 160.0,
                sr: int = SR) -> np.ndarray:
    """The Berghain rumble: 100% wet reverb of the kick, lowpassed hard.
    Duck it against the kick when layering or it turns to soup."""
    rev = Pedalboard([
        Reverb(room_size=0.92, damping=0.4, wet_level=1.0, dry_level=0.0),
        LowpassFilter(cutoff_frequency_hz=lp_hz),
    ])
    return rev(kick_track.astype(np.float32), sr)


def mixdown(layers: list[Layer], length_n: int, kick_positions: list[int],
            duck_depth_db: float = -8.0, sr: int = SR,
            stems_out: dict | None = None) -> np.ndarray:
    """Sum layers to stereo with per-layer FX, pan, and sidechain.

    If stems_out is a dict, each layer's RAW mono signal (duck baked in,
    but pre-filter / pre-gain / pre-pan) is stored under its name so the
    browser mixer can re-apply those stages live with Web Audio nodes.
    """
    env = sidechain_env(length_n, kick_positions, duck_depth_db, sr=sr)
    out = np.zeros((length_n, 2), dtype=np.float32)
    for layer in layers:
        raw = layer.x.astype(np.float32)
        if len(raw) < length_n:
            raw = np.pad(raw, (0, length_n - len(raw)))
        raw = raw[:length_n]
        if stems_out is not None:
            stems_out[layer.name] = raw    # PRE-duck, and muted layers
        if layer.duck > 0:                 # export too: the browser
            raw = raw * (env * layer.duck  # mixer re-applies duck and
                         + (1.0 - layer.duck))  # mute live
        if layer.mute:
            continue
        x = _process(Layer(layer.name, raw, 0.0, 0.0,
                           layer.hp_hz, layer.lp_hz), sr)
        x = x * au.db_to_gain(layer.gain_db)
        left = np.sqrt(0.5 * (1 - layer.pan))
        right = np.sqrt(0.5 * (1 + layer.pan))
        out[:, 0] += x * left
        out[:, 1] += x * right
    return out


def master_bus(x: np.ndarray, sr: int = SR) -> np.ndarray:
    """Glue compression (slow, 2:1) then a limiter. The compressor makes
    the layers breathe together; the limiter guarantees no digital
    clipping on export."""
    board = Pedalboard([
        Compressor(threshold_db=-14, ratio=2.0, attack_ms=12, release_ms=220),
        Limiter(threshold_db=-1.5, release_ms=120),
    ])
    y = board(x.T.astype(np.float32), sr).T
    return au.peak_normalize(y, peak_db=-1.0)


def render(layers: list[Layer], length_s: float, kick_positions: list[int],
           out_path: str | Path, duck_depth_db: float = -8.0,
           sr: int = SR, stems_dir: str | Path | None = None,
           meta: dict | None = None) -> Path:
    """Mix, master, fade edges, write wav + mp3. With stems_dir, also
    write one mp3 per layer plus manifest.json for the browser mixer."""
    import json
    n = int(length_s * sr)
    stems_out = {} if stems_dir is not None else None
    mix = mixdown(layers, n, kick_positions, duck_depth_db, sr, stems_out)
    mix = master_bus(mix, sr)
    mix = au.fade(mix, 0.01, 0.8, sr)
    wav = au.save_wav(out_path, mix, sr)
    au.save_mp3(wav)
    if stems_dir is not None:
        stems_dir = Path(stems_dir)
        stems_dir.mkdir(parents=True, exist_ok=True)
        for name, raw in stems_out.items():
            stem_wav = au.save_wav(stems_dir / f"{name}.wav",
                                   au.fade(raw, 0.01, 0.5, sr), sr)
            au.save_mp3(stem_wav)
            stem_wav.unlink()          # keep mp3 only; stems are previews
        manifest = {
            "length_s": length_s,
            "duck_depth_db": duck_depth_db,
            "layers": [{
                "name": la.name, "gain_db": la.gain_db, "duck": la.duck,
                "hp_hz": la.hp_hz, "lp_hz": la.lp_hz, "pan": la.pan,
                "mute": la.mute, "is_source": la.is_source,
            } for la in layers],
        }
        manifest.update(meta or {})
        (stems_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return wav
