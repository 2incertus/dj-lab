"""Techno sound generators and a step sequencer.

Musical notes for the learning log:

A techno kick is not a sample of a drum: it is a sine wave whose pitch
falls very fast (130 Hz -> ~48 Hz in ~40 ms). The falling pitch IS the
"punch"; the tail sine IS the sub bass. Saturating it (tanh) adds
harmonics so it reads on small speakers.

The "Berghain rumble" is the kick sent into a reverb whose output is
lowpassed and ducked by the kick itself. That swirling low mid bed is
what makes Dettmann/Rødhåd tracks feel like a room, not a drum machine.

Rolling hats (Mulero, Rene Wise) are 16th-note noise bursts with a
velocity wave and a few ms of swing. The velocity SHAPE, not the sound,
creates the hypnotic forward pull.
"""

import numpy as np
from scipy import signal as sps

from . import SR


def _env_exp(n: int, tau_s: float, sr: int = SR) -> np.ndarray:
    """Exponential decay envelope. Natural percussion decays
    exponentially, so this is the default shape for drum amplitude."""
    t = np.arange(n) / sr
    return np.exp(-t / tau_s)


def kick(f_start: float = 130.0, f_end: float = 47.0, sweep_tau: float = 0.035,
         amp_tau: float = 0.16, dur: float = 0.45, drive: float = 2.2,
         sr: int = SR) -> np.ndarray:
    """Pitch-swept sine kick. Phase is integrated from the instantaneous
    frequency curve so the sweep is click-free."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    freq = f_end + (f_start - f_end) * np.exp(-t / sweep_tau)
    phase = 2 * np.pi * np.cumsum(freq) / sr
    body = np.sin(phase) * _env_exp(n, amp_tau, sr)
    click = np.random.default_rng(7).normal(0, 1, int(0.003 * sr))
    b, a = sps.butter(2, 1500 / (sr / 2), "high")
    click = sps.lfilter(b, a, click) * 0.6
    body[: len(click)] += click
    return np.tanh(body * drive) / np.tanh(drive)


def sub_note(f0: float, dur: float, amp_tau: float = 0.25,
             sr: int = SR) -> np.ndarray:
    """Plain sine sub bass note with a soft attack (5 ms) to avoid clicks."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    x = np.sin(2 * np.pi * f0 * t) * _env_exp(n, amp_tau, sr)
    n_a = int(0.005 * sr)
    x[:n_a] *= np.linspace(0, 1, n_a)
    return x


def hat(dur: float = 0.045, hp_hz: float = 7500.0, tone: float = 0.0,
        seed: int = 3, sr: int = SR) -> np.ndarray:
    """Closed hat: highpassed white noise with a fast exponential decay.
    `tone` > 0 adds a metallic band around 9 kHz."""
    n = int(dur * sr)
    x = np.random.default_rng(seed).normal(0, 1, n)
    b, a = sps.butter(4, hp_hz / (sr / 2), "high")
    x = sps.lfilter(b, a, x)
    if tone > 0:
        b2, a2 = sps.butter(2, [8500 / (sr / 2), 9800 / (sr / 2)], "band")
        x = x + tone * sps.lfilter(b2, a2, x)
    x *= _env_exp(n, dur / 4, sr)
    return x / (np.max(np.abs(x)) + 1e-9)


def shaker(dur: float = 0.09, sr: int = SR) -> np.ndarray:
    """Softer band-limited noise, slower attack -- reads as a shaker."""
    n = int(dur * sr)
    x = np.random.default_rng(11).normal(0, 1, n)
    b, a = sps.butter(2, [3800 / (sr / 2), 7000 / (sr / 2)], "band")
    x = sps.lfilter(b, a, x)
    attack = int(0.02 * sr)
    env = np.ones(n)
    env[:attack] = np.linspace(0, 1, attack)
    x *= env * _env_exp(n, dur / 3, sr)
    return x / (np.max(np.abs(x)) + 1e-9)


def rim(sr: int = SR) -> np.ndarray:
    """Rimshot-ish tick: damped 1.1 kHz ring + click. Ghost-note fuel for
    the broken-techno frame."""
    n = int(0.06 * sr)
    t = np.arange(n) / sr
    ring = np.sin(2 * np.pi * 1120 * t) * _env_exp(n, 0.012, sr)
    click = np.random.default_rng(5).normal(0, 0.4, int(0.002 * sr))
    ring[: len(click)] += click
    return ring / (np.max(np.abs(ring)) + 1e-9)


def drone(root_hz: float, dur: float, detune_cents: float = 7.0,
          lp_hz: float = 900.0, sub_mix: float = 0.5, lfo_hz: float = 0.09,
          sr: int = SR) -> np.ndarray:
    """Root + fifth drone. Deliberately NO third: the source material is
    modal/minor, and a chord without a third cannot clash major-vs-minor.
    Two detuned saws beat slowly against each other (that slow phasing is
    the 'alive' quality in hypnotic techno pads)."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    det = 2 ** (detune_cents / 1200)
    fifth = root_hz * 1.5
    x = (sps.sawtooth(2 * np.pi * root_hz * t)
         + sps.sawtooth(2 * np.pi * root_hz * det * t)
         + 0.6 * sps.sawtooth(2 * np.pi * fifth * t)
         + 0.6 * sps.sawtooth(2 * np.pi * fifth / det * t))
    b, a = sps.butter(4, lp_hz / (sr / 2), "low")
    x = sps.lfilter(b, a, x)
    x += sub_mix * np.sin(2 * np.pi * (root_hz / 2) * t)
    swell = 1.0 - 0.35 * (0.5 + 0.5 * np.sin(2 * np.pi * lfo_hz * t))
    x *= swell
    edge = int(0.5 * sr)
    if n > 2 * edge:
        x[:edge] *= np.linspace(0, 1, edge)
        x[-edge:] *= np.linspace(1, 0, edge)
    return x / (np.max(np.abs(x)) + 1e-9)


def stab(root_hz: float, dur: float = 0.30, lp_hz: float = 1400.0,
         sr: int = SR) -> np.ndarray:
    """Minor-feel stab: root + fifth + octave saw hit, lowpassed, fast
    decay. Meant to be fed through a dotted delay in the sequencer."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    x = (sps.sawtooth(2 * np.pi * root_hz * t)
         + 0.8 * sps.sawtooth(2 * np.pi * root_hz * 1.5 * t)
         + 0.5 * sps.sawtooth(2 * np.pi * root_hz * 2.0 * t))
    b, a = sps.butter(4, lp_hz / (sr / 2), "low")
    x = sps.lfilter(b, a, x) * _env_exp(n, 0.07, sr)
    return x / (np.max(np.abs(x)) + 1e-9)


def riser(dur: float, sr: int = SR) -> np.ndarray:
    """Noise riser: white noise, resonant sweep 300 Hz -> 6 kHz, volume
    ramp. Classic tension tool before a drop."""
    n = int(dur * sr)
    x = np.random.default_rng(23).normal(0, 1, n)
    out = np.zeros(n)
    hop = int(0.05 * sr)
    for i in range(0, n, hop):
        frac = i / n
        fc = 300 * (6000 / 300) ** frac
        b, a = sps.butter(2, [max(fc * 0.8, 40) / (sr / 2),
                              min(fc * 1.25, sr / 2 - 100) / (sr / 2)], "band")
        seg = sps.lfilter(b, a, x[i: i + hop])
        out[i: i + len(seg)] = seg
    out *= np.linspace(0.05, 1.0, n) ** 2
    return out / (np.max(np.abs(out)) + 1e-9)


def karplus_strong(f0: float, dur: float, damping: float = 0.996,
                   buzz: float = 0.0, seed: int = 1,
                   sr: int = SR) -> np.ndarray:
    """Karplus-Strong plucked string: a noise burst circulates in a delay
    line of length sr/f0 with a gentle lowpass in the loop. The loop length
    sets the pitch; the lowpass makes highs die first, exactly like a real
    string. `buzz` mixes in re-excitation noise, approximating a berimbau
    played with the coin against the wire (the 'chiado' buzz)."""
    period = max(2, int(sr / f0))
    n = int(dur * sr)
    rng = np.random.default_rng(seed)
    buf = rng.normal(0, 1, period)
    out = np.zeros(n)
    for i in range(n):
        out[i] = buf[i % period]
        nxt = damping * 0.5 * (buf[i % period] + buf[(i + 1) % period])
        if buzz > 0 and i < int(0.12 * sr):
            nxt += buzz * rng.normal(0, 0.35)
        buf[i % period] = nxt
    return out / (np.max(np.abs(out)) + 1e-9)


# ----------------------------------------------------------------------
# Step sequencer
# ----------------------------------------------------------------------

def step_times(bpm: float, bars: int, steps_per_bar: int = 16,
               swing: float = 0.0, sr: int = SR):
    """Sample positions of every step. `swing` delays every odd 16th by
    that fraction of a step (0.06 ~= subtle machine swing ~ 8 ms at
    138 BPM). Swing is why a groove 'rolls' instead of marching."""
    step_s = (60.0 / bpm) / (steps_per_bar / 4)
    times = []
    for bar in range(bars):
        for s in range(steps_per_bar):
            t = (bar * steps_per_bar + s) * step_s
            if s % 2 == 1:
                t += swing * step_s
            times.append(int(t * sr))
    return times, step_s


def place(buf: np.ndarray, hit: np.ndarray, pos: int, gain: float) -> None:
    """Add `hit` into mono buffer at sample `pos` (clipped to length)."""
    end = min(pos + len(hit), len(buf))
    if end > pos >= 0:
        buf[pos:end] += hit[: end - pos] * gain


def sequence(bpm: float, bars: int, pattern: dict, length_s: float,
             swing: float = 0.0, steps_per_bar: int = 16,
             sr: int = SR) -> np.ndarray:
    """Render {step_index: (hit_array, velocity)} patterns into a mono
    buffer. Pattern keys repeat every bar. Velocity may be a list
    (cycled per bar) for rolling-hat waves. steps_per_bar=16 is the
    straight 16th grid; 12 gives triplet 8ths -- the 6/8-inside-4/4
    grid that candomble atabaques ride."""
    n = int(length_s * sr)
    buf = np.zeros(n)
    times, _ = step_times(bpm, bars, steps_per_bar=steps_per_bar,
                          swing=swing, sr=sr)
    for step, (hit, vel) in pattern.items():
        vels = vel if isinstance(vel, (list, tuple)) else [vel]
        for bar in range(bars):
            idx = bar * steps_per_bar + step
            if idx < len(times):
                place(buf, hit, times[idx], float(vels[bar % len(vels)]))
    return buf


def delay_send(x: np.ndarray, delay_s: float, feedback: float = 0.45,
               mix: float = 0.5, lp_hz: float = 3500.0,
               sr: int = SR) -> np.ndarray:
    """Feedback delay with a darkening lowpass in the loop. A dotted-16th
    or 3/16 delay on a stab is the single most 'hypnotic techno' effect
    there is: repeats land off-grid and imply polyrhythm."""
    d = int(delay_s * sr)
    out = x.copy()
    b, a = sps.butter(2, lp_hz / (sr / 2), "low")
    tap = x.copy()
    for _ in range(6):
        tap = np.roll(tap, d) * feedback
        tap[:d] = 0
        tap = sps.lfilter(b, a, tap)
        out += tap * mix
    return out
