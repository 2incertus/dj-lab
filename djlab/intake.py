"""Crate intake: pull material from Spotify and YouTube into sources/.

Spotify goes through the taste engine's HTTP API -- the OAuth tokens
live in taste's DB and dj-lab never touches credentials; it asks the
same connector that feeds the taste profile. Spotify can't serve audio,
so a Spotify pick is resolved to a YouTube upload the user explicitly
chooses (never silently substituted), then yt-dlp grabs the audio and
the analyzer + pairing engine run on it so the new track lands in the
crate already scored against all seven frames.
"""

import json
import os
import re
from pathlib import Path

import httpx

from . import analyze as an
from . import recipes as rc

TASTE_URL = os.getenv("TASTE_URL", "http://host.docker.internal:8930").rstrip("/")

FOLDERS = {"cosmic", "rhythmic", "lush", "percussion"}


# ========================
# Taste engine (Spotify)
# ========================

def _taste_get(path: str, params: dict | None = None):
    try:
        r = httpx.get(f"{TASTE_URL}{path}", params=params or {}, timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise RuntimeError(f"taste engine unreachable at {TASTE_URL}{path}: {e}") from e


def status() -> dict:
    out = {"taste": False, "spotify": False, "now_playing": None}
    try:
        sp = _taste_get("/spotify/status")
        out["taste"] = True
        out["spotify"] = bool(sp.get("connected"))
    except RuntimeError:
        return out
    if out["spotify"]:
        try:
            out["now_playing"] = _taste_get("/spotify/now-playing")
        except RuntimeError:
            pass
    return out


def _norm_track(t: dict) -> dict:
    return {
        "title": t.get("name") or t.get("title") or "?",
        "artist": t.get("artist") or "",
        "album": t.get("album") or "",
        "art": t.get("album_art"),
        "duration_ms": t.get("duration_ms") or 0,
    }


def spotify_search(q: str, limit: int = 12) -> list[dict]:
    data = _taste_get("/spotify/search", {"q": q, "limit": limit})
    return [_norm_track(t) for t in data.get("tracks", [])]


def spotify_liked(limit: int = 100) -> list[dict]:
    data = _taste_get("/playlist/liked")
    return [_norm_track(t) for t in (data.get("liked") or [])[:limit]]


# ========================
# YouTube (yt-dlp)
# ========================

def youtube_search(q: str, limit: int = 8) -> list[dict]:
    from yt_dlp import YoutubeDL
    opts = {"quiet": True, "no_warnings": True,
            "extract_flat": "in_playlist", "skip_download": True}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
    out = []
    for e in info.get("entries") or []:
        if not e or not e.get("id"):
            continue
        out.append({
            "id": e["id"],
            "url": f"https://www.youtube.com/watch?v={e['id']}",
            "title": e.get("title") or "?",
            "channel": e.get("channel") or e.get("uploader") or "",
            "duration": e.get("duration"),
            "views": e.get("view_count"),
        })
    return out


def slugify(text: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "-", text.lower()).strip("-")
    return text[:60] or "track"


def pull(url: str, folder: str, name: str | None = None) -> Path:
    """Download audio from a YouTube URL into sources/<folder>/ as WAV,
    then analyze the file and re-score all pairings. Runs inside the
    single job worker, so print() lines stream to the UI console."""
    from yt_dlp import YoutubeDL
    if folder not in FOLDERS:
        raise ValueError(f"bad folder {folder}")
    dest_dir = rc.SOURCES / folder

    def hook(d):
        if d["status"] == "downloading":
            pct = d.get("_percent_str", "").strip()
            if pct.endswith("0.0%") or pct.endswith("5.0%"):
                print(f"  {pct} of {d.get('_total_bytes_str', '?').strip()}", flush=True)
        elif d["status"] == "finished":
            print("  download done, converting to wav ...", flush=True)

    with YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        meta = ydl.extract_info(url, download=False)
    title = meta.get("title") or "track"
    channel = meta.get("channel") or meta.get("uploader") or ""
    slug = slugify(name) if name else f"{slugify(channel)}__{slugify(title)}"
    print(f"pulling: {title}  [{channel}]  ({meta.get('duration', '?')}s)", flush=True)
    print(f"  -> sources/{folder}/{slug}.wav", flush=True)

    opts = {
        "quiet": True, "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": str(dest_dir / f"{slug}.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio",
                            "preferredcodec": "wav"}],
        "progress_hooks": [hook],
    }
    from yt_dlp.utils import DownloadError
    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([url])
    except DownloadError as e:
        if "403" not in str(e):
            raise
        # YouTube sometimes 403s the default web client's media URLs;
        # the android client usually still serves (lower-bitrate m4a).
        print("  403 from youtube, retrying with the android client ...", flush=True)
        opts["extractor_args"] = {"youtube": {"player_client": ["android"]}}
        with YoutubeDL(opts) as ydl:
            ydl.download([url])

    wav = dest_dir / f"{slug}.wav"
    if not wav.exists():
        raise RuntimeError(f"expected {wav} after download, not found")

    print("analyzing ...", flush=True)
    info = analyze_into_log(wav)
    print(f"  {info['bpm']} BPM  {info['note']} {info['mode']}  "
          f"({info['camelot']})  beat cv {info['beat_cv']}", flush=True)
    print(f"  {info['warp']}", flush=True)

    print("re-scoring pairings ...", flush=True)
    from . import engine
    pairings = engine.run(rc.ROOT)
    mine = [p for p in pairings if p["source"] == wav.stem][:3]
    if mine:
        print("best frames for this track:", flush=True)
        for p in mine:
            print(f"  {p['score']:>3}  {p['bed']}  [{p['plan']}]", flush=True)
    return wav


def analyze_into_log(path: Path) -> dict:
    """Analyze one file and merge it into analysis.json (keyed by path)."""
    info = an.analyze_file(path)
    aj = rc.ROOT / "analysis.json"
    entries = json.loads(aj.read_text()) if aj.exists() else []
    entries = [e for e in entries
               if Path(e.get("file", "")).name != path.name]
    entries.append(info)
    aj.write_text(json.dumps(entries, indent=2))
    return info
