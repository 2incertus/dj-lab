"""FastAPI backend for the dj-lab platform.

Single-worker job model: renders and analysis are CPU-heavy, so one job
runs at a time and its stdout is captured live for the UI console.
"""

import contextlib
import hashlib
import io
import json
import math
import os
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile, Form
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import analyze as an
from . import cabine as cab
from . import grid as gr
from . import recipes as rc

app = FastAPI(title="dj-lab")
STATIC = Path(__file__).parent / "static"

# PIN gate (homelab pattern): PIN_HASH env = sha256 of the PIN, cookie
# carries the hash itself. Empty PIN_HASH disables auth for local dev.
PIN_HASH = os.getenv("PIN_HASH", "")
# the installed Cabine app must reach its service worker and manifest
# before the PIN: browsers fetch both without cookies
UNGATED = ("/login", "/auth", "/health", "/cabine/sw.js", "/cabine/manifest.webmanifest")

_SAFE_NEXT = re.compile(r"/(?![/\\])[^\x00-\x20\x7f\\]*")


def safe_next(value) -> str:
    """Where to go after the PIN: a same-site path, else "/". Rejects
    "//host" and "/\\host" (both leave the site) and anything with
    whitespace, control characters or backslashes."""
    v = value if isinstance(value, str) else ""
    return v if _SAFE_NEXT.fullmatch(v) else "/"


@app.middleware("http")
async def pin_gate(request: Request, call_next):
    path = request.url.path
    if (not PIN_HASH or path in UNGATED
            or path.startswith(("/static/", "/favicon"))):
        return await call_next(request)
    if request.cookies.get("dj_auth") == PIN_HASH:
        return await call_next(request)
    if path.startswith(("/api/", "/audio/")):
        return JSONResponse({"detail": "auth required"}, status_code=401)
    if path == "/cabine" or path.startswith("/cabine/"):
        return RedirectResponse(f"/login?next={safe_next(path)}", status_code=307)
    return RedirectResponse("/login", status_code=307)


_LOGIN_HTML = """<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>dj-lab &middot; Brasil &times; M&aacute;quina</title>
<meta name="theme-color" content="#f7f2e8">
<meta property="og:site_name" content="dj-lab">
<meta property="og:title" content="Brasil x Maquina &middot; dj-lab">
<meta property="og:description" content="Brazilian roots pressed onto hypnotic techno frames. Seven blends, a crate, an intake engine and a playable mesa: lessons, jams, pressings.">
<meta property="og:image" content="https://dj.library.icu/static/share-card.png?v=3">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="https://dj.library.icu">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://dj.library.icu/static/share-card.png?v=3">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="dj-lab">
<link rel="icon" type="image/png" sizes="32x32" href="/static/favicon-32.png?v=3">
<link rel="icon" type="image/png" sizes="16x16" href="/static/favicon-16.png?v=3">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png?v=3">
<link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png?v=3">
<link rel="manifest" href="/static/manifest.json?v=3">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;
     background:oklch(0.96 0.015 85);color:oklch(0.25 0.02 60);
     font-family:system-ui,sans-serif}
form{text-align:center}
.stamp{display:inline-block;border:2px solid oklch(0.52 0.13 40);
       color:oklch(0.52 0.13 40);padding:4px 14px;font-weight:700;
       letter-spacing:0.2em;margin-bottom:24px}
input{font-size:28px;letter-spacing:0.4em;text-align:center;width:7ch;
      padding:10px;border:2px solid oklch(0.52 0.13 40);background:transparent;
      color:inherit;border-radius:4px}
p{opacity:0.6;font-size:13px}
</style></head><body><form id="f">
<div class="stamp">DJ-LAB</div><br>
<input id="pin" type="password" inputmode="numeric" autocomplete="off" autofocus>
<p>enter the pin to reach the pressing plant</p>
</form><script>
const f=document.getElementById("f"),pin=document.getElementById("pin");
const safeNext=v=>typeof v==="string"&&/^\\/(?![\\/\\\\])[^\\x00-\\x20\\x7f\\\\]*$/.test(v)?v:"/";
const next=safeNext(new URLSearchParams(location.search).get("next"));
f.addEventListener("submit",async e=>{e.preventDefault();
  const r=await fetch("/auth",{method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({pin:pin.value,next})});
  if(r.ok){const j=await r.json().catch(()=>({}));
    location.href=safeNext(j.next||next)}
  else{pin.value="";pin.placeholder="nope"}});
pin.addEventListener("input",()=>{if(pin.value.length>=4)f.requestSubmit()});
</script></body></html>"""


@app.get("/login")
def login_page():
    return HTMLResponse(_LOGIN_HTML)


@app.post("/auth")
async def auth(request: Request):
    body = await request.json()
    digest = hashlib.sha256(str(body.get("pin", "")).encode()).hexdigest()
    if not PIN_HASH or digest != PIN_HASH:
        raise HTTPException(401, "wrong pin")
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp = JSONResponse({"ok": True, "next": safe_next(body.get("next"))})
    resp.set_cookie("dj_auth", PIN_HASH, max_age=30 * 24 * 3600,
                    httponly=True, samesite="lax", secure=https)
    return resp


@app.get("/health")
def health():
    return {"ok": True}

BED_FILES = {1: "bed1_cosmic_roller_133", 2: "bed2_berimbau_roller_138",
             3: "bed3_broken_frame_146", 4: "bed4_dark_groove_132",
             5: "bed5_baiao_roller_135", 6: "bed6_maracatu_industrial_140",
             7: "bed7_atabaque_68_132"}
BED_BPM = {1: 133, 2: 138, 3: 146, 4: 132, 5: 135, 6: 140, 7: 132}

_jobs: list[dict] = []
_job_lock = threading.Lock()


class _LiveLog(io.StringIO):
    def __init__(self, job):
        super().__init__()
        self.job = job

    def write(self, s):
        self.job["log"] += s
        return len(s)


def _run_job(action: str, fn):
    job = {"id": len(_jobs) + 1, "action": action, "status": "running",
           "log": "", "started": time.time(), "ended": None}
    _jobs.append(job)

    def worker():
        try:
            with contextlib.redirect_stdout(_LiveLog(job)):
                fn()
            job["status"] = "done"
        except Exception as e:
            job["log"] += f"\nERROR: {e}"
            job["status"] = "failed"
        finally:
            job["ended"] = time.time()
            _job_lock.release()

    if not _job_lock.acquire(blocking=False):
        _jobs.pop()
        raise HTTPException(409, "a job is already running")
    threading.Thread(target=worker, daemon=True).start()
    return job["id"]


def _audio_urls(stem_dir: Path, base: str) -> dict | None:
    mp3 = stem_dir / f"{base}.mp3"
    if not mp3.exists():
        return None
    kind = stem_dir.name
    return {"mp3": f"/audio/{kind}/{base}.mp3",
            "wav": f"/audio/{kind}/{base}.wav"}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/mesa")
def mesa_page():
    return FileResponse(STATIC / "mesa.html")


@app.get("/escola")
def escola_page():
    """The escola grew into A Mesa; keep the old link working."""
    return RedirectResponse("/mesa", status_code=308)


MESA_EXPORTS = rc.ROOT / "renders" / "sessoes"
# what O Arquivo keeps: the mesa's wav masters and A Cabine's compressed takes
EXPORT_TYPES = {".wav": "audio/wav", ".webm": "audio/webm", ".m4a": "audio/mp4"}
_CLIENT_ID = re.compile(r"[A-Za-z0-9-]{8,64}")


def _export_kind(data: bytes):
    """File extension for an upload by its magic bytes, or None."""
    if data[:4] == b"RIFF":
        return ".wav"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return ".m4a"
    return None


def _probe_duration(f: Path):
    """Seconds of a compressed export via ffprobe, or None when it can't tell.
    A streamed webm (MediaRecorder) has no duration in its header, so fall
    back to the last audio packet's end."""
    import subprocess
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", str(f)],
                           capture_output=True, text=True, timeout=20)
        val = r.stdout.strip()
        if r.returncode == 0 and val and val != "N/A":
            d = float(val)
            if math.isfinite(d) and d > 0:
                return d
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                            "-show_entries", "packet=pts_time,duration_time",
                            "-of", "csv=p=0", str(f)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None
        end = None
        for line in r.stdout.splitlines():
            parts = line.strip().split(",")
            try:
                t = float(parts[0]) + (float(parts[1]) if len(parts) > 1 and parts[1] not in ("", "N/A") else 0.0)
            except (ValueError, IndexError):
                continue
            if math.isfinite(t) and (end is None or t > end):
                end = t
        return end if end and end > 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _export_duration(f: Path, st):
    if f.suffix == ".wav":
        try:
            head = f.open("rb").read(44)
            rate = int.from_bytes(head[24:28], "little")
            block = int.from_bytes(head[32:34], "little") or 4
            if rate:
                return round(max(0, st.st_size - 44) / (rate * block), 1)
        except OSError:
            pass
        return None
    side = f.with_name(f.name + ".dur")
    try:
        if side.stat().st_mtime >= st.st_mtime:
            return round(float(side.read_text().strip()), 1)
    except (OSError, ValueError):
        pass
    d = _probe_duration(f)
    if d is None:
        return None
    try:
        side.write_text(f"{d:.3f}")
    except OSError:
        pass
    return round(d, 1)


def _export_by_client_id(cid: str):
    """The export a previous upload with this exact client_id produced."""
    for side in MESA_EXPORTS.glob(f"*-{cid[:8]}.*.cid"):
        try:
            if side.read_text().strip() != cid:
                continue
        except OSError:
            continue
        f = side.with_name(side.name[:-len(".cid")])
        if f.suffix in EXPORT_TYPES and f.exists():
            return f.name
    return None


def _export_file(fname: str) -> Path:
    f = MESA_EXPORTS / Path(fname).name
    if f.suffix not in EXPORT_TYPES or not f.is_file():
        raise HTTPException(404, "no such export")
    return f


@app.get("/api/mesa/exports")
def mesa_exports():
    MESA_EXPORTS.mkdir(parents=True, exist_ok=True)
    out = []
    files = [p for p in MESA_EXPORTS.iterdir()
             if p.suffix in EXPORT_TYPES and p.is_file()]
    for f in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append({"file": f.name, "size": st.st_size,
                    "mtime": int(st.st_mtime), "dur": _export_duration(f, st)})
    return out


@app.post("/api/mesa/export")
async def mesa_export_save(request: Request, name: str = "sessao",
                           client_id: str | None = None):
    if client_id is not None and not _CLIENT_ID.fullmatch(client_id):
        raise HTTPException(400, "bad client_id")
    data = await request.body()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(413, "recording too large")
    MESA_EXPORTS.mkdir(parents=True, exist_ok=True)
    if client_id is not None:
        # a retry of an upload that already landed: hand back the same file
        existing = _export_by_client_id(client_id)
        if existing:
            return {"file": existing}
    ext = _export_kind(data)
    if ext is None:
        raise HTTPException(400, "not a wav, webm or m4a")
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-") or "sessao"
    stem = f"{safe}-{time.strftime('%Y%m%d-%H%M%S')}"
    if client_id is None:
        fname = f"{stem}{ext}"
    else:
        stem = f"{stem}-{client_id[:8]}"
        fname, n = f"{stem}{ext}", 2
        while (MESA_EXPORTS / fname).exists():   # same second, same id prefix
            fname, n = f"{stem}-{n}{ext}", n + 1
    dest = MESA_EXPORTS / fname
    part = MESA_EXPORTS / f".{fname}.part"
    part.write_bytes(data)
    part.replace(dest)
    for side in (".dur", ".cid"):
        dest.with_name(fname + side).unlink(missing_ok=True)
    if client_id is not None:
        dest.with_name(fname + ".cid").write_text(client_id)
    return {"file": fname}


@app.get("/api/mesa/export/{fname}")
def mesa_export_get(fname: str):
    f = _export_file(fname)
    return FileResponse(f, media_type=EXPORT_TYPES[f.suffix])


@app.delete("/api/mesa/export/{fname}")
def mesa_export_delete(fname: str):
    f = _export_file(fname)
    f.unlink()
    for side in (".dur", ".cid"):
        f.with_name(f.name + side).unlink(missing_ok=True)
    return {"deleted": fname}


@app.get("/api/state")
def state():
    analysis = []
    aj = rc.ROOT / "analysis.json"
    if aj.exists():
        analysis = json.loads(aj.read_text())
    blends = []
    for num, recipe in rc.RECIPES.items():
        specs = []
        for s in recipe.specs:
            found = rc.find_source(s)
            specs.append({"key": s.key, "want": s.want, "acquire": s.acquire,
                          "folder": s.folder, "stem": s.stem,
                          "found": found.name if found else None})
        bed_base = BED_FILES[num]
        blends.append({
            "num": num, "title": recipe.title, "slug": recipe.slug,
            "bpm": BED_BPM[num], "specs": specs,
            "bed": _audio_urls(rc.BEDS, bed_base),
            "demo": _audio_urls(rc.BEDS, f"{bed_base}__SYNTH_DEMO"),
            "blend": _audio_urls(rc.RENDERS, f"blend{num}_{recipe.slug}"),
        })
    auditions = []
    for a in rc.list_auditions():
        frame = BED_FILES[a["bed"]].split("_", 1)[1].replace("_", " ")
        auditions.append({**a,
                          "bed_title": f"the {frame} frame",
                          "bpm": BED_BPM[a["bed"]],
                          "urls": {"mp3": f"/audio/renders/auditions/{a['base']}.mp3",
                                   "wav": f"/audio/renders/auditions/{a['base']}.wav"}})
    return {"blends": blends, "analysis": analysis, "auditions": auditions,
            "busy": _job_lock.locked()}


@app.get("/api/jobs")
def jobs():
    return _jobs[-8:]


@app.post("/api/run/analyze")
def run_analyze():
    return {"job": _run_job("analyze", lambda: an.print_log(
        an.analyze_folder(rc.SOURCES, rc.ROOT / "analysis.json")))}


@app.post("/api/run/beds")
def run_beds(demo: bool = True):
    return {"job": _run_job("render beds",
                            lambda: rc.render_beds(demo=demo))}


@app.post("/api/run/blend/{num}")
def run_blend(num: int):
    if num not in rc.RECIPES:
        raise HTTPException(404, "no such blend")
    return {"job": _run_job(f"render blend {num}",
                            lambda: rc.render_blend(num))}


@app.post("/api/run/audition")
def run_audition(data: dict):
    num = int(data.get("bed", 0))
    stem = str(data.get("source", ""))
    if num not in rc.RECIPES:
        raise HTTPException(404, "no such bed")
    if not rc.find_by_stem(stem):
        raise HTTPException(404, "no such source")
    return {"job": _run_job(f"audition: {stem} over bed{num}",
                            lambda: rc.render_audition(num, stem))}


@app.post("/api/blend/{num}/adopt")
def adopt(num: int, data: dict):
    if num not in rc.RECIPES:
        raise HTTPException(404, "no such blend")
    stem = str(data.get("source", ""))
    if not rc.find_by_stem(stem):
        raise HTTPException(404, "no such source")
    rc.adopt_audition(num, stem)
    return {"job": _run_job(f"adopt: {stem} -> blend {num}",
                            lambda: rc.render_blend(num))}


@app.delete("/api/audition")
def discard_audition(bed: int, source: str):
    removed = []
    for ext in (".wav", ".mp3"):
        f = rc.AUDITIONS / f"audition_bed{bed}__{source}{ext}"
        if f.exists() and f.resolve().is_relative_to(rc.AUDITIONS):
            f.unlink()
            removed.append(f.name)
    return {"removed": removed}


@app.get("/api/pairings")
def pairings():
    pj = rc.ROOT / "pairings.json"
    return json.loads(pj.read_text()) if pj.exists() else []


@app.get("/api/references")
def references():
    tj = rc.ROOT / "reference" / "twisted_universe.json"
    return json.loads(tj.read_text())["curated"] if tj.exists() else []


@app.post("/api/run/engine")
def run_engine():
    from . import engine
    return {"job": _run_job("engine", lambda: engine.run(rc.ROOT))}


@app.post("/api/upload")
async def upload(folder: str = Form(...), file: UploadFile = None):
    if folder not in {"cosmic", "rhythmic", "lush", "percussion"}:
        raise HTTPException(400, "bad folder")
    name = re.sub(r"[^A-Za-z0-9._-]", "_", file.filename or "upload")
    ext = Path(name).suffix.lower()
    if ext not in an.AUDIO_EXTS and not name.endswith(".loop.json"):
        raise HTTPException(400, f"unsupported type {ext}")
    dest = rc.SOURCES / folder / name
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    return {"saved": str(dest.relative_to(rc.ROOT))}


@app.get("/api/intake/status")
def intake_status():
    from . import intake
    return intake.status()


@app.get("/api/intake/spotify/liked")
def intake_liked():
    from . import intake
    try:
        return {"tracks": intake.spotify_liked()}
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.get("/api/intake/spotify/search")
def intake_spotify_search(q: str):
    from . import intake
    try:
        return {"tracks": intake.spotify_search(q)}
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.get("/api/intake/youtube/search")
def intake_youtube_search(q: str):
    from . import intake
    return {"videos": intake.youtube_search(q)}


@app.get("/api/intake/soundcloud/search")
def intake_soundcloud_search(q: str):
    from . import intake
    try:
        return {"tracks": intake.soundcloud_search(q)}
    except Exception as e:
        raise HTTPException(502, f"soundcloud search failed: {e}")


@app.post("/api/intake/pull")
def intake_pull(data: dict):
    from . import intake
    url = data.get("url", "")
    folder = data.get("folder", "")
    source = intake.source_of(url) if isinstance(url, str) else None
    if source is None:
        raise HTTPException(400, "bad url")
    if folder not in intake.FOLDERS:
        raise HTTPException(400, "bad folder")
    return {"job": _run_job(
        f"pull from {source}",
        lambda: intake.pull(url, folder, data.get("name")))}


_STEM_NAMES = ("vocals", "drums", "bass", "other")


@app.get("/api/source/stems")
def source_stems_status(file: str):
    src = rc.find_file(Path(file).name)
    if not src:
        raise HTTPException(404, "no such source")
    out_dir = rc.STEMS / "htdemucs" / src.stem
    return {"ready": all((out_dir / f"{s}.wav").exists() for s in _STEM_NAMES)}


@app.post("/api/source/stems")
def source_stems_run(data: dict):
    src = rc.find_file(Path(str(data.get("file", ""))).name)
    if not src:
        raise HTTPException(404, "no such source")
    return {"job": _run_job("separate stems", lambda: rc.ensure_stems(src))}


@app.get("/api/source/stem-preview")
def source_stem_preview(file: str, stem: str):
    """Mono mp3 preview of one demucs stem, cached like source previews."""
    if stem not in _STEM_NAMES:
        raise HTTPException(400, "bad stem")
    src = rc.find_file(Path(file).name)
    if not src:
        raise HTTPException(404, "no such source")
    wav = rc.STEMS / "htdemucs" / src.stem / f"{stem}.wav"
    if not wav.exists():
        raise HTTPException(409, "stems not separated yet")
    import subprocess
    prev_dir = rc.ROOT / "previews"
    prev_dir.mkdir(exist_ok=True)
    out = prev_dir / f"{src.stem}__stem-{stem}.mp3"
    if not out.exists() or out.stat().st_mtime < wav.stat().st_mtime:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                        "-ac", "1", "-b:a", "96k", str(out)], check=True)
    return FileResponse(out, media_type="audio/mpeg")


@app.get("/api/source/preview")
def source_preview(file: str):
    """Serve a mono mp3 preview of a full source track for the section
    picker (decoding a 100 MB wav in the browser is too heavy). Transcoded
    once with ffmpeg and cached under previews/."""
    import subprocess
    src = rc.find_file(Path(file).name)
    if not src:
        raise HTTPException(404, "no such source")
    prev_dir = rc.ROOT / "previews"
    prev_dir.mkdir(exist_ok=True)
    out = prev_dir / (src.stem + ".mp3")
    if not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                        "-ac", "1", "-b:a", "96k", str(out)], check=True)
    return FileResponse(out, media_type="audio/mpeg")


@app.get("/api/source/loop")
def get_loop(file: str):
    src = rc.find_file(Path(file).name)
    if not src:
        raise HTTPException(404, "no such source")
    start, end = rc.sidecar_bounds(src)
    return {"start": start, "end": end}


@app.post("/api/source/loop")
def set_loop(data: dict):
    src = rc.find_file(Path(str(data.get("file", ""))).name)
    if not src:
        raise HTTPException(404, "no such source")
    start = float(data.get("start") or 0.0)
    end = data.get("end")
    sc = src.parent / (src.name + ".loop.json")
    sc.write_text(json.dumps({"start": round(start, 2),
                              "end": round(float(end), 2) if end else None}))
    return {"saved": str(sc.relative_to(rc.ROOT))}


@app.get("/audio/{kind}/{name:path}")
def audio(kind: str, name: str):
    if kind not in {"beds", "renders"} or ".." in name:
        raise HTTPException(404)
    path = (rc.ROOT / kind / name).resolve()
    if not path.is_relative_to(rc.ROOT) or not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


@app.get("/api/blend/{num}/settings")
def get_settings(num: int):
    if num not in rc.RECIPES:
        raise HTTPException(404, "no such blend")
    recipe = rc.RECIPES[num]
    manifest = None
    mf = rc.RENDERS / "stems" / f"blend{num}" / "manifest.json"
    if mf.exists():
        manifest = json.loads(mf.read_text())
    from . import beds as bd
    source_defaults = {}
    for s in recipe.specs:
        d = rc.spec_defaults(s)
        found = rc.find_source(s)
        if found:
            d["file"] = found.name
        source_defaults[s.key] = d
    return {
        "saved": rc.load_settings(num),
        "source_defaults": source_defaults,
        "files": rc.all_source_files(),
        "manifest": manifest,
        "stems_base": f"/audio/renders/stems/blend{num}",
        "bed_defaults": {"bpm": BED_BPM[num], "duck_depth_db": -8.0},
        "bed_knobs": bd.BED_KNOBS[num],
    }


@app.post("/api/blend/{num}/settings")
def post_settings(num: int, data: dict):
    if num not in rc.RECIPES:
        raise HTTPException(404, "no such blend")
    rc.save_settings(num, data)
    return {"saved": True}


# ---- A Cabine: the phone FLX4 ------------------------------------------

CABINE_SW = Path(__file__).parent / "cabine_sw.js"
CABINE_MANIFEST = {
    "name": "A Cabine",
    "short_name": "Cabine",
    "description": "A DDJ-FLX4 in your pocket, for practice on the train",
    "start_url": "/cabine",
    "scope": "/cabine",
    "display": "fullscreen",
    "orientation": "landscape",
    "background_color": "#2A0A2E",
    "theme_color": "#2A0A2E",
    "icons": [
        {"src": "/static/icon-180.png?v=3", "sizes": "180x180", "type": "image/png",
         "purpose": "any"},
        {"src": "/static/icon-192.png?v=3", "sizes": "192x192", "type": "image/png",
         "purpose": "any"},
        {"src": "/static/icon-512.png?v=3", "sizes": "512x512", "type": "image/png",
         "purpose": "any maskable"},
    ],
}


def _cabine_src(file) -> Path:
    src = rc.find_file(Path(str(file or "")).name) if file else None
    if not src:
        raise HTTPException(404, "no such track")
    return src


@app.get("/cabine")
def cabine_page():
    return FileResponse(STATIC / "cabine" / "cabine.html")


@app.get("/cabine/proof")
def cabine_proof_page():
    """Dev-only engine proof: two decks, load, play, scrub, underruns."""
    return FileResponse(STATIC / "cabine" / "proof.html")


@app.get("/cabine/sw.js")
def cabine_sw():
    return FileResponse(CABINE_SW, media_type="text/javascript",
                        headers={"Service-Worker-Allowed": "/cabine",
                                 "Cache-Control": "no-cache"})


@app.get("/cabine/manifest.webmanifest")
def cabine_manifest():
    return JSONResponse(CABINE_MANIFEST, media_type="application/manifest+json")


@app.get("/api/cabine/library")
def cabine_library():
    return {"tracks": cab.library()}


@app.get("/api/cabine/carry")
def cabine_carry(file: str):
    return FileResponse(cab.carry_mp3(_cabine_src(file)), media_type="audio/mpeg")


@app.get("/api/cabine/peaks")
def cabine_peaks(file: str):
    return FileResponse(cab.peaks(_cabine_src(file)),
                        media_type="application/octet-stream")


@app.get("/api/cabine/grid")
def cabine_grid(file: str):
    g = gr.load_grid(_cabine_src(file))
    if g is None:
        raise HTTPException(404, "no grid yet")
    return g


@app.post("/api/cabine/grid")
def cabine_grid_run(data: dict):
    src = _cabine_src(data.get("file"))
    return {"job": _run_job(f"beat grid: {src.name}", lambda: gr.ensure_grid(src))}


@app.post("/api/cabine/grid/fix")
def cabine_grid_fix(data: dict):
    src = _cabine_src(data.get("file"))
    g = gr.load_grid(src)
    if g is None:
        raise HTTPException(404, "no grid yet")
    value = data.get("value")
    try:
        value = None if value is None else float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "value must be a number")
    if value is not None and not math.isfinite(value):
        raise HTTPException(400, "value must be a finite number")
    try:
        fixed = gr.apply_fix(g, str(data.get("op", "")), value)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    gr.save_grid(src, fixed)
    return fixed


app.mount("/static", StaticFiles(directory=STATIC), name="static")
