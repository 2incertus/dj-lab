"""The pairing engine: score every Brazilian source against every
techno frame.

This is deliberately NOT a neural net. It scores three things a DJ
actually weighs when auditioning a blend, and explains itself:

1. Tempo cost (45 pts) -- how far the best warp plan (half/straight/
   double) has to stretch the source. Under 6% is a pitch-fader move;
   over 13% will sound processed. Rubato material scores low unless the
   frame wants free-floating texture.
2. Role fit (35 pts) -- percussive vs tonal energy, measured by
   harmonic/percussive source separation (HPSS): a median filter along
   time catches steady tones, one along frequency catches transients.
   A zabumba wants a percussive hole, a sitar drone wants a tonal one.
3. Key clarity (20 pts) -- how confidently a tonal center was detected.
   Beds re-tune themselves to the source, so key CLASH is impossible by
   construction; what matters is whether the source is tonally stable
   enough for that re-tune to mean anything. Percussion-role frames
   ignore this axis (a pandeiro has no key to clash).
"""

import json
from pathlib import Path

import numpy as np

from . import SR
from . import analyze as an
from . import warp as wp
from .audio import load

# What each frame wants: percussive weight (0..1, rest is tonal),
# whether beatless/rubato texture is welcome, and the frame's tempo.
FRAME_WANTS = {
    1: {"bpm": 133, "perc": 0.15, "texture_ok": True,
        "name": "bed1 cosmic roller 133"},
    2: {"bpm": 138, "perc": 0.55, "texture_ok": True,
        "name": "bed2 berimbau roller 138"},
    3: {"bpm": 146, "perc": 0.85, "texture_ok": False,
        "name": "bed3 broken frame 146"},
    4: {"bpm": 132, "perc": 0.25, "texture_ok": True,
        "name": "bed4 dark groove 132"},
    5: {"bpm": 135, "perc": 0.80, "texture_ok": False,
        "name": "bed5 baiao roller 135"},
    6: {"bpm": 140, "perc": 0.90, "texture_ok": False,
        "name": "bed6 maracatu industrial 140"},
    7: {"bpm": 132, "perc": 0.85, "texture_ok": False,
        "name": "bed7 atabaque 6/8 132"},
}


def spectral_role(path: Path) -> dict:
    """Percussive-vs-tonal energy ratio via HPSS on a 60 s excerpt."""
    import librosa
    y = load(path, mono=True)
    mid = len(y) // 2
    y = y[max(0, mid - 30 * SR): mid + 30 * SR]
    harm, perc = librosa.effects.hpss(y)
    e_h, e_p = float(np.sum(harm ** 2)), float(np.sum(perc ** 2))
    ratio = e_p / (e_h + e_p + 1e-12)
    return {"perc_ratio": round(ratio, 3)}


def _tempo_score(info: dict, frame: dict) -> tuple[float, str]:
    if info["beat_cv"] > 0.12:
        if frame["texture_ok"]:
            return 0.75, "rubato, floated as free texture (no warp needed)"
        return 0.25, "rubato against a locked groove -- would need hand-slicing"
    plan = wp.plan(info["bpm"], frame["bpm"])
    pct = abs(plan.rate - 1)
    score = max(0.0, 1.0 - pct / 0.20)
    feel = {0.5: "half-time", 1.0: "straight", 2.0: "double-time"}[plan.mult]
    return score, (f"{feel} at x{plan.rate:.2f} "
                   f"({(plan.rate - 1) * 100:+.0f}% stretch)")


def _role_score(perc_ratio: float, frame: dict) -> tuple[float, str]:
    dist = abs(perc_ratio - frame["perc"])
    score = max(0.0, 1.0 - dist * 2.2)
    kind = ("percussive" if perc_ratio > 0.6
            else "tonal" if perc_ratio < 0.35 else "mixed")
    return score, f"{kind} source ({int(perc_ratio * 100)}% transient energy)"


def _local_path(file_str: str, root: Path) -> Path:
    """analysis.json may hold paths from another mount of the project
    (host /home/ubuntu/dj-lab vs container /app); remap by the sources/
    suffix so both roots resolve."""
    p = Path(file_str)
    if not p.exists() and "sources" in p.parts:
        i = p.parts.index("sources")
        p = root.joinpath(*p.parts[i:])
    return p


def score_pairings(analysis: list[dict], root: Path | None = None) -> list[dict]:
    root = root or Path(__file__).resolve().parent.parent
    out = []
    for info in analysis:
        if "error" in info:
            continue
        path = _local_path(info["file"], root)
        if not path.exists():
            print(f"  skipping {path.name}: file missing", flush=True)
            continue
        role = spectral_role(path)
        for num, frame in FRAME_WANTS.items():
            t_score, t_why = _tempo_score(info, frame)
            r_score, r_why = _role_score(role["perc_ratio"], frame)
            if frame["perc"] >= 0.6:
                k_score, k_why = 1.0, "key ignored (percussive frame)"
            else:
                k_score = min(info["confidence"] / 0.08, 1.0)
                k_why = (f"tonal center {info['key']} "
                         f"({'stable' if k_score > 0.7 else 'ambiguous'})")
            total = round(45 * t_score + 35 * r_score + 20 * k_score)
            out.append({
                "source": path.stem, "bed": frame["name"], "bed_num": num,
                "score": total,
                "plan": f"{info['bpm']} -> {frame['bpm']} BPM",
                "why": f"{t_why}; {r_why}; {k_why}",
            })
    out.sort(key=lambda p: -p["score"])
    return out


def run(root: Path) -> list[dict]:
    aj = root / "analysis.json"
    if not aj.exists():
        print("no analysis.json -- run analyze first")
        return []
    analysis = json.loads(aj.read_text())
    print(f"scoring {len(analysis)} sources x {len(FRAME_WANTS)} frames ...")
    pairings = score_pairings(analysis, root)
    (root / "pairings.json").write_text(json.dumps(pairings, indent=2))
    for p in pairings[:10]:
        print(f"  {p['score']:>3}  {p['source']} -> {p['bed']}  [{p['plan']}]")
        print(f"       {p['why']}")
    return pairings
