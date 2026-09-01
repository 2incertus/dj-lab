"""The synthesized techno frames ("beds"), fully knob-controllable.

Each bed is a stripped, functional groove that leaves a hole exactly
the shape of the Brazilian source that will sit in it. Every musical
parameter that shapes a bed's character is a KNOB: declared in
BED_KNOBS, editable from the web mixer, applied on re-press.

Knob semantics (the DSP lesson in each):
    swing_scale   multiplies every swing amount. 0 = rigid machine,
                  1 = as designed, 2 = drunk. Swing is 90% of "groove".
    kick_drive    tanh saturation. More drive = more harmonics = kick
                  reads on small speakers, at the cost of sub weight.
    kick_punch    the start Hz of the pitch sweep. Higher = clickier.
    kick_tail     amplitude decay seconds. Long tail = 909-ish boom.
    rumble_lp     lowpass on the reverb rumble. Open it and the room
                  gets bigger and dirtier.
    breakdown_*   which bars the kick drops out. A breakdown is just
                  subtraction; the source floods the space you clear.
    drone_lp      the drone's lowpass. This knob IS the dark/light axis.
    stab_feedback delay regeneration. Past 0.6 it self-oscillates into
                  dub-techno territory.
"""

import math

import numpy as np

from . import SR
from . import synth as sy
from .mix import Layer, rumble_from

A4 = 440.0
_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_hz(name: str) -> float:
    """'D2' -> Hz. A4 = 440."""
    pitch, octave = name[:-1], int(name[-1])
    semis = _NOTES.index(pitch) - 9 + (octave - 4) * 12
    return A4 * 2 ** (semis / 12)


def _knob(key, label, lo, hi, step, default):
    return {"key": key, "label": label, "min": lo, "max": hi,
            "step": step, "default": default}


def _common_knobs(swing=1.0, drive=2.2, punch=130, tail=0.16, rumble=160,
                  bd_start=0, bd_len=0):
    return [
        _knob("swing_scale", "swing", 0.0, 2.0, 0.05, swing),
        _knob("kick_drive", "kick drive", 1.0, 6.0, 0.1, drive),
        _knob("kick_punch", "kick punch Hz", 90, 190, 5, punch),
        _knob("kick_tail", "kick tail s", 0.06, 0.32, 0.01, tail),
        _knob("rumble_lp", "rumble lp Hz", 90, 320, 10, rumble),
        _knob("breakdown_start", "breakdown at bar", 0, 14, 1, bd_start),
        _knob("breakdown_len", "breakdown bars", 0, 8, 1, bd_len),
    ]


BED_KNOBS = {
    1: _common_knobs(swing=1.0, bd_start=8, bd_len=4) + [
        _knob("drone_lp", "drone lp Hz", 250, 1600, 25, 750),
        _knob("drone_lfo", "drone lfo Hz", 0.03, 0.25, 0.01, 0.09),
    ],
    2: _common_knobs() + [
        _knob("hat_base", "hat energy", 0.1, 1.0, 0.05, 0.5),
        _knob("stab_feedback", "stab feedback", 0.0, 0.7, 0.05, 0.5),
    ],
    3: _common_knobs(drive=2.2, punch=130, tail=0.09) + [
        _knob("sub_gain", "sub energy", 0.0, 1.5, 0.05, 0.9),
    ],
    4: _common_knobs(drive=2.8, bd_start=8, bd_len=4, rumble=190) + [
        _knob("drone_lp", "drone lp Hz", 250, 1600, 25, 520),
        _knob("drone_lfo", "drone lfo Hz", 0.03, 0.25, 0.01, 0.07),
        _knob("stab_feedback", "stab feedback", 0.0, 0.7, 0.05, 0.55),
    ],
    5: _common_knobs() + [
        _knob("hat_base", "hat energy", 0.1, 1.0, 0.05, 0.4),
        _knob("stab_feedback", "stab feedback", 0.0, 0.7, 0.05, 0.4),
        _knob("riser_on", "riser (0=off 1=on)", 0, 1, 1, 1),
    ],
    6: _common_knobs(drive=4.5, punch=150, tail=0.12, rumble=140) + [
        _knob("hat_tone", "hat metal", 0.0, 1.5, 0.05, 0.9),
        _knob("stab_feedback", "clang feedback", 0.0, 0.7, 0.05, 0.6),
    ],
    7: _common_knobs() + [
        _knob("drone_lp", "drone lp Hz", 250, 1600, 25, 600),
        _knob("drone_lfo", "drone lfo Hz", 0.03, 0.25, 0.01, 0.08),
        _knob("shaker_gain", "shaker energy", 0.0, 1.0, 0.05, 0.45),
    ],
}


def resolve_knobs(num: int, knobs: dict | None) -> dict:
    k = {d["key"]: d["default"] for d in BED_KNOBS[num]}
    for key, val in (knobs or {}).items():
        if key in k and val is not None:
            k[key] = float(val)
    return k


def _grid(bpm: float, min_len_s: float = 30.0):
    bar_s = 240.0 / bpm
    bars = math.ceil(min_len_s / bar_s)
    return bars, bars * bar_s + 0.5


def _bar_mask(bars: int, k: dict) -> list[int]:
    """1 = kick plays this bar; the breakdown knobs cut a hole."""
    mask = [1] * bars
    start, length = int(k["breakdown_start"]), int(k["breakdown_len"])
    if length > 0:
        for i in range(start, min(start + length, bars)):
            mask[i] = 0
    return mask


def _kick_kw(k: dict, **extra) -> dict:
    kw = dict(drive=k["kick_drive"], f_start=k["kick_punch"],
              amp_tau=k["kick_tail"])
    kw.update(extra)
    return kw


def _kick_track(bpm: float, bars: int, length_s: float, bar_on: list[int],
                steps: list[int] | dict[int, list[float]], swing: float = 0.0,
                kick_kw: dict | None = None, steps_per_bar: int = 16):
    """Kick layer + its onset positions (for sidechain)."""
    k = sy.kick(**(kick_kw or {}))
    if isinstance(steps, list):
        steps = {s: [1.0] for s in steps}
    pattern = {s: (k, [v * b for v, b in
                      zip((vels * bars)[:bars], bar_on)])
               for s, vels in ((s, list(np.resize(v, bars))) for s, v in steps.items())}
    track = sy.sequence(bpm, bars, pattern, length_s, swing=swing,
                        steps_per_bar=steps_per_bar)
    times, _ = sy.step_times(bpm, bars, steps_per_bar=steps_per_bar,
                             swing=swing)
    positions = []
    for s, vels in steps.items():
        for bar in range(bars):
            if bar_on[bar] and np.resize(vels, bars)[bar] > 0:
                positions.append(times[bar * steps_per_bar + s])
    return track, sorted(positions)


def _rolling_hats(bpm: float, bars: int, length_s: float, swing: float,
                  base: float = 0.5) -> np.ndarray:
    """16th hats with a velocity wave: the wave creates the rolling pull."""
    h = sy.hat(tone=0.4)
    wave = [1.0, 0.28, 0.55, 0.34, 0.85, 0.30, 0.60, 0.36,
            0.95, 0.28, 0.55, 0.34, 0.80, 0.32, 0.65, 0.42]
    pattern = {s: (h, wave[s] * base) for s in range(16)}
    return sy.sequence(bpm, bars, pattern, length_s, swing=swing)


def bed1_cosmic(root: str = "D2", bpm: float | None = None,
                knobs: dict | None = None):
    """~133 stripped hypnotic roller with a kickless breakdown where the
    cosmic material floats."""
    k = resolve_knobs(1, knobs)
    bpm, name = bpm or 133.0, "bed1_cosmic_roller_133"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(bpm, bars, length_s, bar_on, [0, 4, 8, 12],
                             kick_kw=_kick_kw(k))
    rumble = rumble_from(kick, lp_hz=k["rumble_lp"])
    hats = sy.sequence(bpm, bars, {2: (sy.hat(), 0.5), 6: (sy.hat(), 0.35),
                                   10: (sy.hat(), 0.5), 14: (sy.hat(), 0.4)},
                       length_s, swing=0.04 * sw)
    shk = sy.sequence(bpm, bars, {s: (sy.shaker(), 0.22 + 0.1 * (s % 4 == 0))
                                  for s in range(0, 16, 2)}, length_s,
                      swing=0.04 * sw)
    dr = sy.drone(note_hz(root), length_s, lp_hz=k["drone_lp"],
                  lfo_hz=k["drone_lfo"])
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("rumble", rumble, -10.0, 1.0, hp_hz=45, lp_hz=k["rumble_lp"]),
        Layer("hats", hats, -14.0, 0.0, hp_hz=6000, pan=0.15),
        Layer("shaker", shk, -20.0, 0.0, hp_hz=3000, pan=-0.2),
        Layer("drone", dr, -15.0, 0.8, hp_hz=55, lp_hz=k["drone_lp"] + 150),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def bed2_berimbau(root: str = "A2", bpm: float | None = None,
                  knobs: dict | None = None):
    """~138 rolling techno with the 150-600 Hz midrange kept empty for
    the berimbau."""
    k = resolve_knobs(2, knobs)
    bpm, name = bpm or 138.0, "bed2_berimbau_roller_138"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(bpm, bars, length_s, bar_on, [0, 4, 8, 12],
                             kick_kw=_kick_kw(k))
    rumble = rumble_from(kick, lp_hz=k["rumble_lp"])
    hats = _rolling_hats(bpm, bars, length_s, swing=0.055 * sw,
                         base=k["hat_base"])
    stab_hit = sy.stab(note_hz(root), lp_hz=1200)
    stab_seq = sy.sequence(bpm, bars, {14: (stab_hit, [0.0, 0.9])}, length_s)
    stab_seq = sy.delay_send(stab_seq, delay_s=(60 / bpm) * 0.75,
                             feedback=k["stab_feedback"])
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("rumble", rumble, -11.0, 1.0, hp_hz=45, lp_hz=k["rumble_lp"]),
        Layer("hats", hats, -13.0, 0.0, hp_hz=6500, pan=0.12),
        Layer("stab", stab_seq, -17.0, 0.6, hp_hz=600, lp_hz=2500, pan=-0.15),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def bed3_broken(root: str = "G1", bpm: float | None = None,
                knobs: dict | None = None):
    """~146 broken frame: kick off the 4/4 grid, syncopated sub, rim
    ghosts. The whole top end belongs to the source."""
    k = resolve_knobs(3, knobs)
    bpm, name = bpm or 146.0, "bed3_broken_frame_146"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(
        bpm, bars, length_s, bar_on,
        {0: [1.0], 7: [0.9, 0.0], 6: [0.0, 0.9], 10: [1.0], 13: [0.0, 0.8]},
        swing=0.03 * sw, kick_kw=_kick_kw(k, f_end=52))
    root_hz = note_hz(root)
    fourth = root_hz * 2 ** (5 / 12)
    g = k["sub_gain"]
    sub = sy.sequence(bpm, bars, {
        2: (sy.sub_note(root_hz, 0.28), 1.0 * g),
        8: (sy.sub_note(fourth, 0.22), [0.78 * g, 0.0]),
        11: (sy.sub_note(root_hz, 0.30), [0.0, 0.89 * g]),
    }, length_s, swing=0.03 * sw)
    rims = sy.sequence(bpm, bars, {3: (sy.rim(), 0.4), 9: (sy.rim(), [0.3, 0.5]),
                                   14: (sy.rim(), 0.35)}, length_s,
                       swing=0.08 * sw)
    hats = sy.sequence(bpm, bars, {2: (sy.hat(), 0.4), 10: (sy.hat(), 0.5)},
                       length_s, swing=0.08 * sw)
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("sub", sub, -7.0, 0.5, lp_hz=120),
        Layer("rims", rims, -16.0, 0.0, hp_hz=500, pan=0.2),
        Layer("hats", hats, -16.0, 0.0, hp_hz=6000, pan=-0.15),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def bed4_dark(root: str = "A1", bpm: float | None = None,
              knobs: dict | None = None):
    """~132 dark Dystopian groove; breakdown + 300 Hz-3 kHz left open
    for a voice."""
    k = resolve_knobs(4, knobs)
    bpm, name = bpm or 132.0, "bed4_dark_groove_132"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(bpm, bars, length_s, bar_on, [0, 4, 8, 12],
                             kick_kw=_kick_kw(k))
    rumble = rumble_from(kick, lp_hz=k["rumble_lp"])
    oh = sy.sequence(bpm, bars, {2: (sy.hat(0.13, 6000), 0.45),
                                 6: (sy.hat(0.13, 6000), 0.4),
                                 10: (sy.hat(0.13, 6000), 0.45),
                                 14: (sy.hat(0.13, 6000), 0.4)},
                     length_s, swing=0.04 * sw)
    dr = sy.drone(note_hz(root), length_s, lp_hz=k["drone_lp"], sub_mix=0.7,
                  lfo_hz=k["drone_lfo"])
    stab_hit = sy.stab(note_hz(root) * 4, lp_hz=900)
    stab_seq = sy.sequence(bpm, bars, {8: (stab_hit, [0.0, 0.0, 0.0, 0.8])},
                           length_s)
    stab_seq = sy.delay_send(stab_seq, delay_s=(60 / bpm) * 0.75,
                             feedback=k["stab_feedback"], lp_hz=2200)
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("rumble", rumble, -9.0, 1.0, hp_hz=45, lp_hz=k["rumble_lp"] + 10),
        Layer("open_hats", oh, -16.0, 0.0, hp_hz=5500, pan=0.1),
        Layer("drone", dr, -13.0, 0.85, hp_hz=45, lp_hz=k["drone_lp"] + 180),
        Layer("stab", stab_seq, -18.0, 0.6, hp_hz=400, lp_hz=2000, pan=0.18),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def bed5_baiao(root: str = "D2", bpm: float | None = None,
               knobs: dict | None = None):
    """~135 Mulero-style roller with the backbeat left empty for the
    half-timed zabumba; riser slot for the frevo horn."""
    k = resolve_knobs(5, knobs)
    bpm, name = bpm or 135.0, "bed5_baiao_roller_135"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(bpm, bars, length_s, bar_on, [0, 4, 8, 12],
                             kick_kw=_kick_kw(k))
    rumble = rumble_from(kick, lp_hz=k["rumble_lp"])
    perc = sy.sequence(bpm, bars, {3: (sy.rim(), 0.30), 7: (sy.rim(), 0.22),
                                   11: (sy.rim(), 0.30), 15: (sy.rim(), 0.20)},
                       length_s, swing=0.05 * sw)
    hats = _rolling_hats(bpm, bars, length_s, swing=0.05 * sw,
                         base=k["hat_base"])
    stab_hit = sy.stab(note_hz(root) * 2, dur=0.16, lp_hz=1600)
    stab_seq = sy.sequence(bpm, bars, {3: (stab_hit, 0.7), 11: (stab_hit, 0.55)},
                           length_s, swing=0.05 * sw)
    stab_seq = sy.delay_send(stab_seq, delay_s=(60 / bpm) * 0.375,
                             feedback=k["stab_feedback"])
    rise = np.zeros(int(length_s * SR))
    if k["riser_on"] >= 0.5:
        r = sy.riser(2 * 240 / bpm)
        rise[len(rise) - len(r) - int(0.5 * SR):len(rise) - int(0.5 * SR)] = r
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("rumble", rumble, -11.0, 1.0, hp_hz=45, lp_hz=k["rumble_lp"]),
        Layer("perc", perc, -15.0, 0.0, hp_hz=700, pan=-0.2),
        Layer("hats", hats, -15.0, 0.0, hp_hz=6500, pan=0.15),
        Layer("stab", stab_seq, -16.0, 0.5, hp_hz=500, lp_hz=3000),
        Layer("riser", rise, -14.0, 0.0, hp_hz=300),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def bed6_maracatu(root: str = "F1", bpm: float | None = None,
                  knobs: dict | None = None):
    """~140 industrial/Birmingham frame; 80-350 Hz clear for alfaias."""
    k = resolve_knobs(6, knobs)
    bpm, name = bpm or 140.0, "bed6_maracatu_industrial_140"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(bpm, bars, length_s, bar_on, [0, 4, 8, 12],
                             kick_kw=_kick_kw(k))
    rumble = rumble_from(kick, lp_hz=k["rumble_lp"])
    hats = sy.sequence(bpm, bars, {s: (sy.hat(0.03, 8500, tone=k["hat_tone"]),
                                       0.5 if s % 4 == 2 else 0.25)
                                   for s in range(0, 16, 2)},
                       length_s, swing=0.02 * sw)
    clang = sy.stab(note_hz(root) * 6, dur=0.10, lp_hz=3200)
    clang_seq = sy.sequence(bpm, bars, {6: (clang, [0.8, 0.0]),
                                        13: (clang, [0.0, 0.6])}, length_s)
    clang_seq = sy.delay_send(clang_seq, delay_s=(60 / bpm) * 0.75,
                              feedback=k["stab_feedback"], lp_hz=4000)
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("rumble", rumble, -10.0, 1.0, hp_hz=40, lp_hz=k["rumble_lp"] + 10),
        Layer("hats", hats, -15.0, 0.0, hp_hz=7000, pan=0.1),
        Layer("clang", clang_seq, -18.0, 0.5, hp_hz=900, lp_hz=5000, pan=-0.2),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def bed7_atabaque(root: str = "C2", bpm: float | None = None,
                  knobs: dict | None = None):
    """~132 tribal frame on a 12-step triplet grid so candomble 6/8
    material locks in without warping its feel."""
    k = resolve_knobs(7, knobs)
    bpm, name = bpm or 132.0, "bed7_atabaque_68_132"
    bars, length_s = _grid(bpm)
    sw = k["swing_scale"]
    bar_on = _bar_mask(bars, k)
    kick, kpos = _kick_track(bpm, bars, length_s, bar_on, [0, 3, 6, 9],
                             steps_per_bar=12, kick_kw=_kick_kw(k))
    rumble = rumble_from(kick, lp_hz=k["rumble_lp"])
    sg = k["shaker_gain"]
    shk = sy.sequence(bpm, bars, {s: (sy.shaker(0.07),
                                      sg if s % 3 == 0 else sg * 0.55)
                                  for s in range(12)},
                      length_s, steps_per_bar=12, swing=0.02 * sw)
    rims = sy.sequence(bpm, bars, {2: (sy.rim(), 0.4), 5: (sy.rim(), 0.3),
                                   8: (sy.rim(), 0.45), 11: (sy.rim(), 0.3)},
                       length_s, steps_per_bar=12, swing=0.02 * sw)
    dr = sy.drone(note_hz(root), length_s, lp_hz=k["drone_lp"], sub_mix=0.6,
                  lfo_hz=k["drone_lfo"])
    layers = [
        Layer("kick", kick, 0.0, 0.0, hp_hz=30),
        Layer("rumble", rumble, -11.0, 1.0, hp_hz=45, lp_hz=k["rumble_lp"] + 10),
        Layer("shaker", shk, -17.0, 0.0, hp_hz=3500, pan=0.18),
        Layer("rims", rims, -16.0, 0.0, hp_hz=600, pan=-0.15),
        Layer("drone", dr, -15.0, 0.8, hp_hz=50, lp_hz=k["drone_lp"] + 100),
    ]
    return dict(name=name, bpm=bpm, root=root, layers=layers,
                length_s=length_s, kick_positions=kpos, bars=bars)


def synthetic_berimbau_layer(bpm: float, bars: int, length_s: float,
                             low: str = "G#2") -> Layer:
    """SYNTHETIC berimbau demo (Karplus-Strong), clearly labeled: open
    string, stopped string (+2 semitones), chiado buzz, caxixi, at HALF
    the techno tempo."""
    half_bpm = bpm / 2
    half_bars = bars // 2
    f_low = note_hz(low)
    f_high = f_low * 2 ** (2 / 12)
    open_s = sy.karplus_strong(f_low, 0.55, buzz=0.15)
    high_s = sy.karplus_strong(f_high, 0.40, buzz=0.1, seed=2)
    buzz_s = sy.karplus_strong(f_low, 0.22, damping=0.986, buzz=0.9, seed=3)
    cax = sy.shaker(0.06)
    pat = {0: (open_s, 1.0), 4: (buzz_s, 0.7), 6: (high_s, 0.8),
           8: (high_s, 0.85), 10: (buzz_s, 0.7), 12: (open_s, 0.9)}
    line = sy.sequence(half_bpm, half_bars, pat, length_s, swing=0.05)
    cax_line = sy.sequence(half_bpm, half_bars,
                           {s: (cax, 0.5 if s % 4 == 0 else 0.3)
                            for s in range(0, 16, 2)}, length_s, swing=0.05)
    return Layer("SYNTH_berimbau_demo", line + 0.5 * cax_line, -8.0, 0.5,
                 hp_hz=140, lp_hz=5200, pan=-0.1)


ALL_BEDS = {1: bed1_cosmic, 2: bed2_berimbau, 3: bed3_broken,
            4: bed4_dark, 5: bed5_baiao, 6: bed6_maracatu, 7: bed7_atabaque}
