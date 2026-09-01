"""The blend recipes: bed + Brazilian source transforms, all editable.

Every musical decision here is a DEFAULT, not a rule. Per-blend settings
live in settings/blend{N}.json (written by the web mixer or by hand) and
override anything: bed bpm/root/duck depth, per-layer mix parameters,
and per-source musical parameters:

    file       any file from sources/ (swap sources freely)
    start/end  loop passage in seconds (overrides .loop.json sidecar)
    stem       demucs stem to isolate: drums|bass|vocals|other|null=full
    mode       tempo alignment: auto|half|straight|double|free
               (half = source beats land on every 2nd techno beat;
                free = no stretching at all, material floats)
    repitch    true = turntable-style resample (pitch moves with tempo)
    enter_bar  where the source enters (negative = bars from the end)
    kind       loop (tile a grid-fitted loop) | float (lay the passage
               in once, unwarped by default) | oneshot (single hit)
"""

import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from pedalboard import Pedalboard, Reverb

from . import SR
from . import analyze as an
from . import beds as bd
from . import synth as sy
from . import warp as wp
from .audio import load
from .mix import Layer, render

ROOT = Path(__file__).resolve().parent.parent
SOURCES, STEMS = ROOT / "sources", ROOT / "stems"
BEDS, RENDERS = ROOT / "beds", ROOT / "renders"
SETTINGS = ROOT / "settings"


@dataclass
class SourceSpec:
    key: str
    folder: str
    patterns: list[str]
    want: str
    acquire: str
    stem: str | None = None
    kind: str = "loop"            # loop | float | oneshot
    mode: str = "auto"            # auto | half | straight | double | free
    enter_bar: int = 0
    fx: str | None = None         # delay | reverb
    gain_db: float = -6.0
    duck: float = 0.5
    hp_hz: float | None = 100.0
    lp_hz: float | None = None


@dataclass
class Recipe:
    num: int
    slug: str
    title: str
    bed_fn: object
    root_octave: int
    specs: list[SourceSpec] = field(default_factory=list)


RECIPES = {
    1: Recipe(1, "cosmic_bed", "Cosmic bed -- Notaro over a 133 roller",
              bd.bed1_cosmic, 2, [
        SourceSpec("notaro", "cosmic", ["notaro", "vida"],
                   "the sitar/nature passage of 'Ah Vida Avida' (No Sub "
                   "Reino dos Metazoarios, 1973)",
                   "digital: streaming/Mr Bongo reissue; vinyl rip works too",
                   kind="float", mode="free", gain_db=-7.0, duck=0.35,
                   hp_hz=120.0)]),
    2: Recipe(2, "berimbau_roller", "Berimbau roller -- Nana under a 138 kick",
              bd.bed2_berimbau, 2, [
        SourceSpec("berimbau", "percussion", ["berimbau", "nana", "africadeus"],
                   "a solo berimbau passage (Nana Vasconcelos 'Africadeus' "
                   "or any clean berimbau+caxixi recording)",
                   "digital: Saudades (ECM 1980) / Africadeus reissues",
                   gain_db=-6.0, duck=0.6, hp_hz=130.0, lp_hz=6000.0)]),
    3: Recipe(3, "choro_breaks", "Choro as breaks -- pandeiro chops at 146",
              bd.bed3_broken, 1, [
        SourceSpec("pandeiro", "rhythmic", ["choro", "pixinguinha", "jacob",
                                            "bandolim", "epoca"],
                   "any driving choro with crisp pandeiro + cavaquinho "
                   "(pull one from your 'A Viola Chora' playlist)",
                   "digital: streaming", stem="drums",
                   gain_db=-5.0, duck=0.4, hp_hz=200.0),
        SourceSpec("cavaquinho", "rhythmic", ["choro", "pixinguinha", "jacob",
                                              "bandolim", "epoca"],
                   "the cavaquinho/melody stem of the same choro",
                   "digital: streaming", stem="other", fx="delay",
                   gain_db=-11.0, duck=0.5, hp_hz=350.0, lp_hz=6500.0)]),
    4: Recipe(4, "vocal_drop", "Vocal drop -- Evinha over a dark 132 groove",
              bd.bed4_dark, 1, [
        SourceSpec("evinha", "lush", ["evinha", "bandeira"],
                   "Evinha 'Que Bandeira' full track (Demucs pulls the "
                   "acapella)",
                   "digital: streaming/Mr Bongo Brazil 45s; or your vinyl",
                   stem="vocals", kind="float", mode="free", enter_bar=8,
                   fx="reverb", gain_db=-4.0, duck=0.25, hp_hz=170.0)]),
    5: Recipe(5, "baiao_engine", "Baiao engine -- Gonzaga under a 135 roller",
              bd.bed5_baiao, 2, [
        SourceSpec("gonzaga", "rhythmic", ["gonzaga", "baiao", "asa branca",
                                           "juazeiro"],
                   "a driving Luiz Gonzaga baiao (zabumba + triangle up "
                   "front)", "digital: streaming", stem="drums", mode="half",
                   gain_db=-5.0, duck=0.55, hp_hz=60.0),
        SourceSpec("frevo", "rhythmic", ["valenca", "alceu", "frevo", "spok"],
                   "a frevo brass passage for the riser stab (Alceu "
                   "Valenca or Spok Frevo Orquestra)",
                   "digital: streaming", stem="other", kind="oneshot",
                   enter_bar=-2, fx="delay", gain_db=-8.0, duck=0.4,
                   hp_hz=350.0)]),
    6: Recipe(6, "maracatu_industrial", "Maracatu weight -- alfaias under "
              "an industrial 140", bd.bed6_maracatu, 1, [
        SourceSpec("maracatu", "percussion", ["zumbi", "maracatu", "ciencia",
                                              "chico"],
                   "a maracatu with alfaias up front (Chico Science & Nacao "
                   "Zumbi 'Maracatu Atomico', or any nacao recording)",
                   "digital: streaming", stem="drums", mode="half",
                   gain_db=-5.0, duck=0.6, hp_hz=55.0)]),
    7: Recipe(7, "atabaque_68", "Atabaque 6/8 -- Os Tincoas inside a "
              "tribal 132", bd.bed7_atabaque, 2, [
        SourceSpec("atabaque", "percussion", ["tincoas", "gira", "atabaque"],
                   "candomble atabaques + voices (Os Tincoas 'Deixa a Gira "
                   "Gira' is the one)",
                   "digital: streaming (Os Tincoas reissues)", stem="drums",
                   mode="free", gain_db=-5.5, duck=0.5, hp_hz=80.0)]),
}


# ---------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------

def load_settings(num: int) -> dict:
    p = SETTINGS / f"blend{num}.json"
    if p.exists():
        return json.loads(p.read_text())
    return {}


def save_settings(num: int, data: dict) -> None:
    SETTINGS.mkdir(exist_ok=True)
    (SETTINGS / f"blend{num}.json").write_text(json.dumps(data, indent=2))


def spec_defaults(spec: SourceSpec) -> dict:
    return {"file": None, "start": None, "end": None, "stem": spec.stem,
            "mode": spec.mode, "repitch": False, "enter_bar": spec.enter_bar,
            "kind": spec.kind, "fx": spec.fx,
            "fx_amount": 0.36 if spec.fx == "reverb" else 0.5,
            "delay_time": 0.75}


# ---------------------------------------------------------------------
# source discovery + segments
# ---------------------------------------------------------------------

def find_source(spec: SourceSpec) -> Path | None:
    folder = SOURCES / spec.folder
    for pat in spec.patterns:
        for p in sorted(folder.glob("*")):
            if p.suffix.lower() in an.AUDIO_EXTS and pat.lower() in p.name.lower():
                return p
    return None


def find_file(name: str) -> Path | None:
    """Locate a source by filename anywhere under sources/ (used when the
    mixer swaps a blend onto a different crate track)."""
    for p in SOURCES.rglob(name):
        if p.suffix.lower() in an.AUDIO_EXTS:
            return p
    return None


def all_source_files() -> list[str]:
    return sorted(p.name for p in SOURCES.rglob("*")
                  if p.suffix.lower() in an.AUDIO_EXTS)


def sidecar_bounds(path: Path) -> tuple[float, float | None]:
    sc = path.parent / (path.name + ".loop.json")
    if sc.exists():
        data = json.loads(sc.read_text())
        return float(data.get("start", 0.0)), data.get("end")
    return 0.0, None


def _demucs_env_device() -> tuple[dict, str]:
    """Prefer the CUDA torch in .gpu-libs (host-mounted, shadows the image's
    CPU torch via PYTHONPATH); fall back to the CPU install."""
    import os
    env = os.environ.copy()
    gpu_libs = ROOT / ".gpu-libs"
    if gpu_libs.is_dir():
        env["PYTHONPATH"] = str(gpu_libs)
        probe = subprocess.run(
            [sys.executable, "-c",
             "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)"],
            env=env, capture_output=True)
        if probe.returncode == 0:
            return env, "cuda"
        env.pop("PYTHONPATH", None)
    return env, "cpu"


def ensure_stems(path: Path) -> dict[str, Path]:
    """Run Demucs (htdemucs) once per source file; cache under stems/."""
    out_dir = STEMS / "htdemucs" / path.stem
    stems = {s: out_dir / f"{s}.wav" for s in ("drums", "bass", "other", "vocals")}
    if not all(p.exists() for p in stems.values()):
        env, dev = _demucs_env_device()
        print(f"  demucs: separating {path.name} ({dev}) ...")
        r = subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs",
                            "-d", dev, "-o", str(STEMS), str(path)], env=env)
        if r.returncode != 0 and dev == "cuda":
            print("  cuda separation failed, falling back to cpu ...")
            subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs",
                            "-d", "cpu", "-o", str(STEMS), str(path)], check=True)
        elif r.returncode != 0:
            raise RuntimeError("demucs failed")
    return stems


def source_segment(path: Path, stem: str | None = None,
                   start: float | None = None, end: float | None = None,
                   default_dur: float = 30.0) -> np.ndarray:
    """Cut the working passage. Priority: explicit start/end (mixer) >
    .loop.json sidecar > leading-silence trim + first 30 s."""
    y_path = ensure_stems(path)[stem] if stem else path
    if start is None:
        start, end = sidecar_bounds(path)
    y = load(y_path, mono=True)
    if start == 0.0 and end is None:
        import librosa
        y, _ = librosa.effects.trim(y, top_db=25)
        return y[: int(default_dur * SR)]
    i0 = int(start * SR)
    i1 = int(end * SR) if end else min(i0 + int(default_dur * SR), len(y))
    return y[i0:i1]


# ---------------------------------------------------------------------
# source layer construction
# ---------------------------------------------------------------------

def _analyzed(path: Path) -> dict:
    info = an.analyze_file(path)
    print(f"  {path.name}: {info['bpm']} BPM (cv {info['beat_cv']}), "
          f"{info['key']} ({info['camelot']}), {info['warp']}")
    return info


def _bars_len(bpm: float, n_bars: int) -> int:
    return int(n_bars * 240.0 / bpm * SR)


def _mode_rate(mode: str, source_bpm: float, bed_bpm: float) -> float | None:
    """None = leave timing alone. Otherwise the stretch factor that puts
    the source in the requested relationship with the bed."""
    if mode == "free":
        return None
    if mode == "auto":
        return None                      # loop grid-fitting handles auto
    mult = {"half": 0.5, "straight": 1.0, "double": 2.0}[mode]
    return (mult * bed_bpm) / source_bpm


def build_source_layer(spec: SourceSpec, path: Path, bed: dict,
                       s_ov: dict, notes: list[str]) -> Layer:
    """One Brazilian source -> one Layer, honoring mixer overrides."""
    bpm = bed["bpm"]
    info = _analyzed(path)
    stem = s_ov.get("stem", spec.stem)
    y = source_segment(path, stem, s_ov.get("start"), s_ov.get("end"))
    mode = s_ov.get("mode", spec.mode)
    kind = s_ov.get("kind", spec.kind)
    enter_bar = int(s_ov.get("enter_bar", spec.enter_bar))
    use_repitch = bool(s_ov.get("repitch", False))

    if info["beat_cv"] <= 0.12 and mode == "auto":
        w = wp.plan(info["bpm"], bpm)
        notes.append(f"{spec.key}: {w.describe(info['bpm'], bpm)}")
    rate = _mode_rate(mode, info["bpm"], bpm)
    if rate:
        y = wp.repitch(y, rate) if use_repitch else wp.stretch(y, rate)
        notes.append(f"{spec.key}: {mode} {'repitch' if use_repitch else 'stretch'} "
                     f"x{rate:.3f} ({(rate - 1) * 100:+.1f}%)")

    total = int(bed["length_s"] * SR)
    if kind == "loop":
        unit = _bars_len(bpm, 2)
        n_units = max(1, round(len(y) / unit))
        fitted = wp.fit_to_length(y, unit * n_units)
        x = wp.tile(fitted, total)
        if enter_bar:
            off = _bars_len(bpm, enter_bar % bed["bars"])
            x = np.concatenate([np.zeros(off), x])[:total]
    elif kind == "float":
        off = _bars_len(bpm, enter_bar % bed["bars"]) if enter_bar else 0
        x = np.zeros(total)
        end_i = min(off + len(y), total)
        x[off:end_i] = y[: end_i - off]
    else:                                # oneshot
        hit = y[: int(4.0 * SR)]
        pos = (_bars_len(bpm, enter_bar) if enter_bar >= 0
               else total - _bars_len(bpm, -enter_bar) - int(0.5 * SR))
        pos = max(0, min(pos, total - len(hit)))
        x = np.zeros(total)
        x[pos:pos + len(hit)] = hit

    fx = s_ov.get("fx", spec.fx)
    amt = float(s_ov.get("fx_amount", 0.36 if fx == "reverb" else 0.5))
    if fx == "delay" and amt > 0:
        dtime = float(s_ov.get("delay_time", 0.75))
        x = sy.delay_send(x, delay_s=(60 / bpm) * dtime, feedback=0.45,
                          mix=amt)
    elif fx == "reverb" and amt > 0:
        wet = min(0.5 * amt, 0.5)
        x = Pedalboard([Reverb(room_size=0.5, wet_level=wet,
                               dry_level=1.0 - wet)])(x.astype(np.float32), SR)

    return Layer(spec.key, x, spec.gain_db, spec.duck,
                 hp_hz=spec.hp_hz, lp_hz=spec.lp_hz, is_source=True)


# ---------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------

def render_blend(num: int) -> Path | None:
    recipe = RECIPES[num]
    settings = load_settings(num)
    bed_ov = settings.get("bed", {})
    layer_ov = settings.get("layers", {})
    source_ov = settings.get("sources", {})
    print(f"\n=== Blend {num}: {recipe.title} ===")

    found: dict[str, Path | None] = {}
    for spec in recipe.specs:
        ov_file = source_ov.get(spec.key, {}).get("file")
        found[spec.key] = (find_file(ov_file) if ov_file
                           else find_source(spec))
    missing = [s for s in recipe.specs if not found[s.key]]

    root = bed_ov.get("root")
    if not root:
        for s in recipe.specs:
            if found[s.key]:
                info = an.analyze_file(found[s.key])
                root = f"{info['note']}{recipe.root_octave}"
                print(f"  bed re-tuned to {root} (source key {info['key']}, "
                      f"confidence {info['confidence']})")
                break
    bed_kw = dict(bpm=bed_ov.get("bpm"), knobs=bed_ov.get("knobs"))
    bed = recipe.bed_fn(root=root, **bed_kw) if root \
        else recipe.bed_fn(**bed_kw)

    notes: list[str] = []
    extras = [build_source_layer(spec, found[spec.key], bed,
                                 source_ov.get(spec.key, {}), notes)
              for spec in recipe.specs if found[spec.key]]
    for m in missing:
        print(f"  MISSING sources/{m.folder}/: {m.want}")
        print(f"    name it to match one of {m.patterns}; {m.acquire}")

    layers = bed["layers"] + extras
    for la in layers:
        la.apply_overrides(layer_ov.get(la.name, {}))

    out = (RENDERS / f"blend{num}_{recipe.slug}.wav" if extras
           else BEDS / f"{bed['name']}.wav")
    if not extras:
        print("  no sources yet -- rendering the techno bed alone")
    path = render(layers, bed["length_s"], bed["kick_positions"], out,
                  duck_depth_db=bed_ov.get("duck_depth_db", -8.0),
                  stems_dir=RENDERS / "stems" / f"blend{num}",
                  meta={"num": num, "bpm": bed["bpm"], "root": bed["root"],
                        "kick_positions_s": [round(p / SR, 4)
                                             for p in bed["kick_positions"]],
                        "sources": {k: (p.name if p else None)
                                    for k, p in found.items()},
                        "notes": notes})
    for n in notes:
        print(f"  note: {n}")
    print(f"  wrote {path} (+ .mp3 + stems)")
    return path


AUDITIONS = RENDERS / "auditions"


def find_by_stem(stem: str) -> Path | None:
    for p in SOURCES.rglob(f"{stem}.*"):
        if p.suffix.lower() in an.AUDIO_EXTS:
            return p
    return None


def render_audition(bed_num: int, source_stem: str) -> Path:
    """Press a quick test of an engine pairing: bed frame + ONE source in
    the frame's primary slot, written to renders/auditions/. Does not
    touch the real blend, its settings, or its stems. Stem separation is
    skipped (full mix) so the audition presses fast; adopting into the
    real blend applies the slot's stem choice."""
    recipe = RECIPES[bed_num]
    spec = recipe.specs[0]
    path = find_by_stem(source_stem)
    if not path:
        raise ValueError(f"no source named {source_stem}")
    print(f"\n=== Audition: {path.stem} over bed{bed_num} "
          f"({recipe.title.split('--')[0].strip()}) ===")
    info = _analyzed(path)
    root = f"{info['note']}{recipe.root_octave}"
    print(f"  bed re-tuned to {root}")
    bed = recipe.bed_fn(root=root)
    notes: list[str] = []
    ov = {"stem": None,
          "kind": "float" if info["beat_cv"] > 0.12 else spec.kind}
    layer = build_source_layer(spec, path, bed, ov, notes)
    AUDITIONS.mkdir(parents=True, exist_ok=True)
    out = AUDITIONS / f"audition_bed{bed_num}__{path.stem}.wav"
    p = render(bed["layers"] + [layer], bed["length_s"],
               bed["kick_positions"], out)
    for n in notes:
        print(f"  note: {n}")
    print(f"  audition pressed -> {p.name} (find it under Auditions in Lado A)")
    return p


def list_auditions() -> list[dict]:
    out = []
    if not AUDITIONS.exists():
        return out
    for p in sorted(AUDITIONS.glob("audition_bed*__*.mp3")):
        try:
            bed_part, stem = p.stem.split("__", 1)
            num = int(bed_part.replace("audition_bed", ""))
        except ValueError:
            continue
        if num in RECIPES:
            out.append({"bed": num, "source": stem, "base": p.stem})
    return out


def adopt_audition(bed_num: int, source_stem: str) -> None:
    """Make an auditioned pairing the real blend: point the frame's
    primary slot at this source (fresh override -- old passage/stem picks
    belonged to the previous track) and drop the audition files."""
    path = find_by_stem(source_stem)
    if not path:
        raise ValueError(f"no source named {source_stem}")
    key = RECIPES[bed_num].specs[0].key
    settings = load_settings(bed_num)
    settings.setdefault("sources", {})[key] = {"file": path.name}
    settings.setdefault("bed", {}).pop("root", None)
    save_settings(bed_num, settings)
    for ext in (".wav", ".mp3"):
        f = AUDITIONS / f"audition_bed{bed_num}__{source_stem}{ext}"
        if f.exists():
            f.unlink()


def render_beds(nums=None, demo: bool = False) -> list[Path]:
    """Render the naked techno frames (and the synthetic-berimbau demo)."""
    out = []
    for num in (nums or list(RECIPES)):
        bed = RECIPES[num].bed_fn()
        p = render(bed["layers"], bed["length_s"], bed["kick_positions"],
                   BEDS / f"{bed['name']}.wav")
        print(f"  wrote {p} (+ .mp3)")
        out.append(p)
        if demo and num == 2:
            demo_layer = bd.synthetic_berimbau_layer(
                bed["bpm"], bed["bars"], bed["length_s"])
            p = render(bed["layers"] + [demo_layer], bed["length_s"],
                       bed["kick_positions"],
                       BEDS / f"{bed['name']}__SYNTH_DEMO.wav")
            print(f"  wrote {p} (+ .mp3)  [synthetic berimbau stand-in]")
            out.append(p)
    return out


def print_sources() -> None:
    print("\nDrop zone: ~/dj-lab/sources/  (any format; wav/flac preferred)")
    print("Optional loop sidecar: <file>.loop.json with {\"start\": s, \"end\": s}\n")
    for r in RECIPES.values():
        print(f"Blend {r.num}: {r.title}")
        for s in r.specs:
            state = "FOUND" if find_source(s) else "needed"
            print(f"  [{state}] sources/{s.folder}/*{s.patterns[0]}*  -- {s.want}")
            print(f"          ({s.acquire})")
    print()
