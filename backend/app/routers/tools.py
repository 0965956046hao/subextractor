import asyncio
import json
import logging
import shlex
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.models import UpdateSrtRequest
from app.dependencies import get_jobs, get_ws_clients, get_job_queue
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import parse_srt
from app.services.context_service import load_video_context, generate_video_context

logger = logging.getLogger(__name__)
router = APIRouter()


# ── GET /api/srt/{video_id}/entries ──

@router.get("/api/srt/{video_id}/entries")
async def get_srt_entries(video_id: str):
    srt_path = _srt_path(video_id)
    content = srt_path.read_text(encoding="utf-8")
    return {"entries": [e.model_dump() for e in parse_srt(content)]}


# ── PUT /api/srt/{video_id} ──

@router.put("/api/srt/{video_id}")
async def update_srt(video_id: str, body: UpdateSrtRequest):
    srt_path = _srt_path(video_id)
    srt_path.write_text(body.content, encoding="utf-8")
    return {"status": "ok", "video_id": video_id}


# ── POST /api/mux/{video_id} ──

@router.post("/api/mux/{video_id}")
async def mux_subtitles(video_id: str):
    srt_path = _srt_path(video_id)
    video_path = _video_path(video_id)

    muxed_dir = settings.temp_dir / "muxed" / video_id
    muxed_dir.mkdir(parents=True, exist_ok=True)
    out_path = muxed_dir / f"{video_path.stem}_muxed.mp4"

    if out_path.exists():
        out_path.unlink()

    cmd = [
        "ffmpeg",
        "-i", str(video_path),
        "-i", str(srt_path),
        "-c:v", "copy",
        "-c:a", "copy",
        "-c:s", "mov_text",
        "-metadata:s:s:0", "language=eng",
        "-disposition:s:0", "default",
        "-y",
        str(out_path),
    ]

    logger.info("mux %s: %s", video_id, " ".join(shlex.quote(str(p)) for p in cmd))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode(errors="replace")[-300:]
            raise HTTPException(500, f"FFmpeg mux failed: {err}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Muxing failed: {e}")

    return {
        "status": "ok",
        "video_id": video_id,
        "filename": out_path.name,
        "size": out_path.stat().st_size,
    }


# ── GET /api/download/muxed/{video_id} ──

@router.get("/api/download/muxed/{video_id}")
async def download_muxed(video_id: str):
    muxed_dir = settings.temp_dir / "muxed" / video_id
    if not muxed_dir.exists():
        raise HTTPException(404, "Muxed file not found. Run mux first.")
    files = list(muxed_dir.glob("*_muxed.mp4"))
    if not files:
        raise HTTPException(404, "Muxed file not found. Run mux first.")
    path = files[0]
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)


# ── POST /api/preview/subtitle/{video_id} ──

@router.post("/api/preview/subtitle/{video_id}")
async def preview_subtitle(video_id: str, request: Request):
    """Render the first frame with a subtitle overlay using a given style, for
    the manual "tự chỉnh vị trí" preview step.

    Body: { region: {x1,y1,x2,y2}, style: {font_size, margin_v, ...}, text? }
    Returns a JPEG of the frame with the subtitle burned at the given style.
    """
    import cv2

    video_path = _video_path(video_id)
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    region = body.get("region")
    style_override = body.get("style") or {}
    sample_text = body.get("text") or "Phụ đề tiếng Việt"

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise HTTPException(500, "Không đọc được video")
    ok, frame = cap.read()
    vh, vw = frame.shape[:2]
    cap.release()
    if not ok:
        raise HTTPException(500, "Không đọc được frame từ video")

    from app.services.hardcode_service import (
        auto_fit_style,
        apply_style_override,
        _find_font,
        _render_subtitle,
        _overlay_subtitle,
    )
    from app.routers.config_router import get_subtitle_style

    # Base style: start from the region-fit (matches what auto_fit would pick),
    # then let the user override font size / vertical position / etc.
    style = get_subtitle_style()
    if region and isinstance(region, dict):
        style = auto_fit_style(style, region, vh, vw)
    style = apply_style_override(style, style_override)

    font_path = _find_font(
        style.get("font_family", "Arial"),
        style.get("bold"),
        style.get("italic"),
    )
    overlay = _render_subtitle(sample_text, vw, vh, font_path, style, fixed_size=True)
    frame = _overlay_subtitle(frame, overlay)

    ok_jpg, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok_jpg:
        raise HTTPException(500, "Không encode được JPEG")
    return Response(content=buf.tobytes(), media_type="image/jpeg")


# ── POST /api/hardcode/{video_id} ──

@router.post("/api/hardcode/{video_id}")
async def hardcode_subtitles(video_id: str, request: Request):
    _srt_path(video_id)
    video_path = _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    # Optional body: { auto_fit: bool, region: {x1,y1,x2,y2}, style: {...} }
    auto_fit = False
    region = None
    style = None
    try:
        raw = await request.json()
        if isinstance(raw, dict):
            auto_fit = bool(raw.get("auto_fit", False))
            region = raw.get("region")
            if region and not all(
                isinstance(region.get(k), (int, float))
                for k in ("x1", "y1", "x2", "y2")
            ):
                region = None
            if isinstance(raw.get("style"), dict):
                style = raw["style"]
    except Exception:
        pass

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_path": str(video_path),
        "video_id": video_id,
        "job_type": "hardcode",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "auto_fit": auto_fit,
        "region": region,
        "style": style,
    }
    jobs[job_id] = job
    logger.info(
        "hardcode job %s: queued for %s (auto_fit=%s)",
        job_id, video_id, auto_fit,
    )
    await queue.put(job_id)
    return {"job_id": job_id}


# ── GET /api/download/hardcoded/{video_id} ──

@router.get("/api/download/hardcoded/{video_id}")
async def download_hardcoded(video_id: str):
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    if not hd_dir.exists():
        raise HTTPException(404, "Hardcoded file not found. Run hardcode first.")
    files = list(hd_dir.glob("*_hardcoded.mp4"))
    if not files:
        raise HTTPException(404, "Hardcoded file not found. Run hardcode first.")
    path = files[0]
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)


# ── GET /api/preview/hardcoded/{video_id} (inline, cho iframe) ──

@router.get("/api/preview/hardcoded/{video_id}")
async def preview_hardcoded(video_id: str):
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    if not hd_dir.exists():
        raise HTTPException(404, "Hardcoded file not found")
    files = list(hd_dir.glob("*_hardcoded.mp4"))
    if not files:
        raise HTTPException(404, "Hardcoded file not found")
    return FileResponse(str(files[0]), media_type="video/mp4")


# ── POST /api/align/{video_id} ──

@router.post("/api/align/{video_id}")
async def align_subtitles(video_id: str, request: Request):
    _srt_path(video_id)
    _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "align",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
    }
    jobs[job_id] = job
    logger.info("align job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id}


# ── POST /api/translate/{video_id} ──

@router.post("/api/translate/{video_id}")
async def translate_subtitles(video_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    srt_content = body.get("srt_content", "")
    source_lang = body.get("source_lang", "zh")
    target_lang = body.get("target_lang", "vi")

    if srt_content:
        tr_dir = settings.temp_dir / "translated" / video_id
        tr_dir.mkdir(parents=True, exist_ok=True)
        custom_srt = tr_dir / "input.srt"
        custom_srt.write_text(srt_content, encoding="utf-8")
    else:
        _srt_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "translate",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "use_custom_srt": bool(srt_content),
        "source_lang": source_lang,
        "target_lang": target_lang,
    }
    jobs[job_id] = job
    logger.info("translate job %s: queued for %s (custom=%s)", job_id, video_id, bool(srt_content))
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "translate", "progress": 0, "error": None, "logs": []}


# ── GET /api/download/translated/{video_id} ──

@router.get("/api/download/translated/{video_id}")
async def download_translated(video_id: str):
    tr_dir = settings.temp_dir / "translated" / video_id
    if not tr_dir.exists():
        raise HTTPException(404, "Translated SRT not found. Run translate first.")
    files = list(tr_dir.glob("*.srt"))
    if not files:
        raise HTTPException(404, "Translated SRT not found. Run translate first.")
    path = files[0]
    return FileResponse(str(path), media_type="application/x-subrip", filename=path.name)


# ── POST /api/tts/{video_id} ──

@router.post("/api/tts/{video_id}")
async def tts_subtitles(video_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    srt_content = body.get("srt_content", "")
    track_name = body.get("track_name", "")
    tts_voice = body.get("voice", "vi-VN-Standard-A")

    if srt_content:
        # Save custom SRT temporarily for TTS
        tts_srt_dir = settings.temp_dir / "tts" / video_id
        tts_srt_dir.mkdir(parents=True, exist_ok=True)
        custom_srt = tts_srt_dir / "custom_input.srt"
        custom_srt.write_text(srt_content, encoding="utf-8")
    else:
        _srt_path(video_id)

    _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "tts",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "use_custom_srt": bool(srt_content),
        "track_name": track_name,
        "tts_voice": tts_voice,
    }
    jobs[job_id] = job
    logger.info("tts job %s: queued for %s (custom=%s)", job_id, video_id, bool(srt_content))
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "tts", "progress": 0, "error": None, "logs": []}


# ── GET /api/download/dubbed/{video_id} ──

@router.get("/api/download/dubbed/{video_id}")
async def download_dubbed(video_id: str):
    tts_dir = settings.temp_dir / "tts" / video_id
    if not tts_dir.exists():
        raise HTTPException(404, "Dubbed video not found. Run TTS first.")
    files = list(tts_dir.glob("dubbed_video.mp4"))
    if not files:
        raise HTTPException(404, "Dubbed video not found. Run TTS first.")
    path = files[0]
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)


# ── GET /api/preview/dubbed/{video_id} (inline, cho iframe) ──

@router.get("/api/preview/dubbed/{video_id}")
async def preview_dubbed(video_id: str):
    tts_dir = settings.temp_dir / "tts" / video_id
    if not tts_dir.exists():
        raise HTTPException(404, "Dubbed video not found")
    files = list(tts_dir.glob("dubbed_video.mp4"))
    if not files:
        raise HTTPException(404, "Dubbed video not found")
    return FileResponse(str(files[0]), media_type="video/mp4")


# ── POST /api/dub/{video_id} ──

@router.post("/api/dub/{video_id}")
async def dub_subtitles(video_id: str, request: Request):
    """Separate vocals (keep instrumental) + Vietnamese TTS → dubbed video."""
    _srt_path(video_id)
    _video_path(video_id)

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    tts_engine = body.get("engine", "google")
    tts_voice = body.get("voice", "")
    mute_original = bool(body.get("mute_original", True))
    try:
        original_gain_db = float(body.get("original_gain_db", 0.0))
    except (TypeError, ValueError):
        original_gain_db = 0.0
    if tts_engine == "capcut" and not tts_voice:
        tts_voice = settings.capcut_tts_default_voice
    if not tts_voice:
        tts_voice = "vi-VN-Standard-B"

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "dub",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "tts_voice": tts_voice,
        "tts_engine": tts_engine,
        "mute_original": mute_original,
        "original_gain_db": original_gain_db,
    }
    ws_clients.setdefault(job_id, [])
    logger.info(
        "dub job %s: queued for %s (engine=%s, voice=%s, mute_original=%s, gain_db=%s)",
        job_id, video_id, tts_engine, tts_voice, mute_original, original_gain_db,
    )
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "dub", "progress": 0, "error": None, "logs": []}


# ── GET /api/srt/{video_id}/available ──

@router.get("/api/srt/{video_id}/available")
async def list_available_srts(video_id: str):
    """List all SRT files available for this video (original + translated)."""
    files = []

    orig = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    if orig.exists():
        files.append({"id": "original", "name": "Gốc (OCR)", "path": str(orig)})

    tr_dir = settings.temp_dir / "translated" / video_id
    if tr_dir.exists():
        for f in sorted(tr_dir.glob("*.srt")):
            files.append({"id": f.stem, "name": f"Dịch ({f.stem})", "path": str(f)})

    return {"files": files}


# ── GET /api/srt/{video_id}/load/{file_id} ──

@router.get("/api/srt/{video_id}/load/{file_id}")
async def load_srt_file(video_id: str, file_id: str):
    """Load a specific SRT file and return its parsed content."""
    if file_id == "original":
        path = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    else:
        path = settings.temp_dir / "translated" / video_id / f"{file_id}.srt"

    if not path.exists():
        raise HTTPException(404, f"SRT file not found: {file_id}")

    content = path.read_text(encoding="utf-8")
    from app.services.srt_utils import parse_srt
    entries = parse_srt(content)
    return {"entries": [e.model_dump() for e in entries]}


# ── GET /api/tts/{video_id}/available ──

@router.get("/api/tts/{video_id}/available")
async def list_available_tts(video_id: str):
    """List all TTS audio files for this video."""
    files = []
    tts_dir = settings.temp_dir / "tts" / video_id
    if tts_dir.exists():
        # List MP3 files grouped by voice subdirectory
        for subdir in sorted(tts_dir.iterdir()):
            if subdir.is_dir():
                mp3_files = sorted(subdir.glob("*.mp3"))
                if mp3_files:
                    voice_label = subdir.name.replace("_", "-")
                    files.append({
                        "id": subdir.name,
                        "name": f"TTS {voice_label} ({len(mp3_files)} files)",
                        "count": len(mp3_files),
                    })
        # Legacy: MP3s directly in tts dir (old format)
        mp3_files = sorted(tts_dir.glob("*.mp3"))
        if mp3_files:
            files.append({
                "id": "legacy",
                "name": f"Audio TTS legacy ({len(mp3_files)} files)",
                "count": len(mp3_files),
            })
        # Also check for remuxed video
        dubbed = tts_dir / "dubbed_video.mp4"
        if dubbed.exists():
            files.append({"id": "dubbed", "name": "Video lồng tiếng", "size": dubbed.stat().st_size})
    return {"files": files}


# ── POST /api/project/{video_id}/save ──

@router.post("/api/project/{video_id}/save")
async def save_project(video_id: str, request: Request):
    """Save full timeline project state."""
    body = await request.json()
    proj_dir = settings.temp_dir / "projects" / video_id
    proj_dir.mkdir(parents=True, exist_ok=True)
    (proj_dir / "project.json").write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok"}


# ── GET /api/project/{video_id}/load ──

@router.get("/api/project/{video_id}/load")
async def load_project(video_id: str):
    """Load full timeline project state."""
    proj_path = settings.temp_dir / "projects" / video_id / "project.json"
    if not proj_path.exists():
        return {"tracks": [], "tts_clips": [], "video_muted": False}
    return json.loads(proj_path.read_text(encoding="utf-8"))


# ── POST /api/export/{video_id} ──

@router.post("/api/export/{video_id}")
async def export_video(video_id: str, request: Request):
    """Export final video with burned subtitles and mixed TTS audio."""
    _video_path(video_id)
    body = await request.json()

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "export",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "tracks": body.get("tracks", []),
        "tts_clips": body.get("tts_clips", []),
    }
    jobs[job_id] = job
    logger.info("export job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "export", "progress": 0, "error": None, "logs": []}


# ── GET /api/download/exported/{video_id} ──

@router.get("/api/download/exported/{video_id}")
async def download_exported(video_id: str):
    exp_dir = settings.temp_dir / "export" / video_id
    if not exp_dir.exists():
        raise HTTPException(404, "Exported file not found. Run export first.")
    files = list(exp_dir.glob("exported.mp4"))
    if not files:
        raise HTTPException(404, "Exported file not found. Run export first.")
    return FileResponse(str(files[0]), media_type="video/mp4", filename=files[0].name)

@router.get("/api/tts-audio/{video_id}/{rest:path}")
async def serve_tts_audio(video_id: str, rest: str):
    path = settings.temp_dir / "tts" / video_id / rest
    if not path.exists():
        raise HTTPException(404, "Audio file not found")
    return FileResponse(str(path), media_type="audio/mpeg")


# ── GET /api/context/{video_id} ──

@router.get("/api/context/{video_id}")
async def get_context(video_id: str):
    """Return the saved video context text, or empty."""
    ctx = load_video_context(video_id)
    return {"video_id": video_id, "context": ctx or ""}


# ── POST /api/context/{video_id}/share-text ──

@router.post("/api/context/{video_id}/share-text")
async def save_share_text_endpoint(video_id: str, request: Request):
    """Persist the raw pasted share text for context generation."""
    from app.services.context_service import save_share_text

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    text = (body.get("text") or "").strip()
    if text:
        save_share_text(video_id, text)
    return {"status": "ok", "saved": bool(text)}


# ── POST /api/context/{video_id}/generate ──

@router.post("/api/context/{video_id}/generate")
async def generate_context(request: Request, video_id: str):
    """Upload snapshots to Gemini and generate video context via Vision."""
    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    # Check API key
    from app.services.translation_service import _read_user_config
    import os
    cfg = _read_user_config()
    has_key = bool(
        settings.gemini_api_key
        or os.environ.get("GEMINI_API_KEY", "")
        or cfg.get("gemini_api_key", "")
    )
    if not has_key:
        raise HTTPException(400, "Gemini API key not configured. Vào Settings (⚙️) để nhập key.")

    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "context",
        "status": "queued",
        "phase": "context",
        "progress": 0,
        "created_at": __import__("time").time(),
        "cancelled": False,
    }
    ws_clients.setdefault(job_id, [])

    logger.info("context job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id}


# ── Gemini File Store ──

@router.get("/api/gemini/files")
async def list_gemini_files(request: Request, video_id: str = ""):
    """List files in Gemini File Store, optionally filtered by video_id via local index."""
    try:
        from google import genai
    except ImportError:
        raise HTTPException(400, "google-genai not installed")

    from app.services.translation_service import _read_user_config
    from app.services.context_service import _load_files_index
    import os
    cfg = _read_user_config()
    api_key = settings.gemini_api_key or os.environ.get("GEMINI_API_KEY", "") or cfg.get("gemini_api_key", "")
    if not api_key:
        raise HTTPException(400, "Gemini API key not configured")

    client = genai.Client(api_key=api_key)

    if video_id:
        # Look up file names from local index, then get details from Gemini
        indexed_names = set(_load_files_index(video_id))
        if not indexed_names:
            return {"count": 0, "files": [], "video_id": video_id}

        result_files = []
        try:
            for f in client.files.list():
                try:
                    if f.name in indexed_names:
                        result_files.append({
                            "name": f.name,
                            "display_name": getattr(f, "display_name", "") or f.name,
                            "size_bytes": getattr(f, "size_bytes", 0) or 0,
                            "create_time": str(getattr(f, "create_time", "") or ""),
                        })
                except Exception:
                    continue
        except Exception as e:
            raise HTTPException(500, f"Failed to list files: {e}")

        return {"count": len(result_files), "files": result_files, "video_id": video_id}

    # No filter — list all files from Gemini
    try:
        all_files = list(client.files.list())
    except Exception as e:
        raise HTTPException(500, f"Failed to list files: {e}")

    result_files = []
    for f in all_files:
        try:
            result_files.append({
                "name": f.name or "",
                "display_name": getattr(f, "display_name", "") or f.name or "",
                "size_bytes": getattr(f, "size_bytes", 0) or 0,
                "create_time": str(getattr(f, "create_time", "") or ""),
            })
        except Exception:
            continue

    return {"count": len(result_files), "files": result_files}


@router.delete("/api/gemini/files/{name:path}")
async def delete_gemini_file(name: str, request: Request):
    """Delete a file from Gemini File Store by name."""
    try:
        from google import genai
    except ImportError:
        raise HTTPException(400, "google-genai not installed")

    from app.services.translation_service import _read_user_config
    import os
    cfg = _read_user_config()
    api_key = settings.gemini_api_key or os.environ.get("GEMINI_API_KEY", "") or cfg.get("gemini_api_key", "")
    if not api_key:
        raise HTTPException(400, "Gemini API key not configured")

    client = genai.Client(api_key=api_key)
    try:
        client.files.delete(name=name)
    except Exception as e:
        raise HTTPException(500, f"Failed to delete file: {e}")

    return {"deleted": name}
