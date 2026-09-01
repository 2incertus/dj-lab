"""FastAPI backend for the dj-lab platform.

Single-worker job model: renders and analysis are CPU-heavy, so one job
runs at a time and its stdout is captured live for the UI console.
"""

import contextlib
import hashlib
import io
import json
import os
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile, Form
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import analyze as an
from . import recipes as rc

app = FastAPI(title="dj-lab")
STATIC = Path(__file__).parent / "static"

# PIN gate (homelab pattern): PIN_HASH env = sha256 of the PIN, cookie
# carries the hash itself. Empty PIN_HASH disables auth for local dev.
PIN_HASH = os.getenv("PIN_HASH", "")


@app.middleware("http")
async def pin_gate(request: Request, call_next):
    path = request.url.path
    if (not PIN_HASH or path in ("/login", "/auth", "/health")
            or path.startswith(("/static/", "/favicon"))):
        return await call_next(request)
    if request.cookies.get("dj_auth") == PIN_HASH:
        return await call_next(request)
    if path.startswith(("/api/", "/audio/")):
        return JSONResponse({"detail": "auth required"}, status_code=401)
    return RedirectResponse("/login", status_code=307)


_LOGIN_HTML = """<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>dj-lab &middot; Brasil &times; M&aacute;quina</title>
<meta name="theme-color" content="#f7f2e8">
<meta property="og:site_name" content="dj-lab">
<meta property="og:title" content="Brasil x Maquina &middot; dj-lab">
<meta property="og:description" content="Brazilian roots pressed onto hypnotic techno frames. Seven blends, a crate, an intake engine and a playable mesa: lessons, jams, pressings.">
<meta property="og:image" content="https://dj.library.icu/static/share-card.png?v=2">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="https://dj.library.icu">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://dj.library.icu/static/share-card.png?v=2">
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
f.addEventListener("submit",async e=>{e.preventDefault();
  const r=await fetch("/auth",{method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({pin:pin.value})});
  if(r.ok)location.href="/";else{pin.value="";pin.placeholder="nope"}});
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
    resp = JSONResponse({"ok": True})
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


@app.get("/api/mesa/exports")
def mesa_exports():
    MESA_EXPORTS.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(MESA_EXPORTS.glob("*.wav"),
                    key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        dur = None
        try:
            head = f.open("rb").read(44)
            rate = int.from_bytes(head[24:28], "little")
            block = int.from_bytes(head[32:34], "little") or 4
            if rate:
                dur = round(max(0, st.st_size - 44) / (rate * block), 1)
        except OSError:
            pass
        out.append({"file": f.name, "size": st.st_size,
                    "mtime": int(st.st_mtime), "dur": dur})
    return out


@app.post("/api/mesa/export")
async def mesa_export_save(request: Request, name: str = "sessao"):
    data = await request.body()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(413, "recording too large")
    if data[:4] != b"RIFF":
        raise HTTPException(400, "not a wav")
    MESA_EXPORTS.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-") or "sessao"
    fname = f"{safe}-{time.strftime('%Y%m%d-%H%M%S')}.wav"
    (MESA_EXPORTS / fname).write_bytes(data)
    return {"file": fname}


@app.get("/api/mesa/export/{fname}")
def mesa_export_get(fname: str):
    f = MESA_EXPORTS / Path(fname).name
    if not f.exists():
        raise HTTPException(404, "no such export")
    return FileResponse(f, media_type="audio/wav")


@app.delete("/api/mesa/export/{fname}")
def mesa_export_delete(fname: str):
    f = MESA_EXPORTS / Path(fname).name
    if not f.exists():
        raise HTTPException(404, "no such export")
    f.unlink()
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


@app.post("/api/intake/pull")
def intake_pull(data: dict):
    from . import intake
    url = data.get("url", "")
    folder = data.get("folder", "")
    if not url.startswith("https://www.youtube.com/watch?v="):
        raise HTTPException(400, "bad url")
    if folder not in intake.FOLDERS:
        raise HTTPException(400, "bad folder")
    return {"job": _run_job(
        "pull from youtube",
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


app.mount("/static", StaticFiles(directory=STATIC), name="static")
