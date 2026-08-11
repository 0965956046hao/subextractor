import asyncio
import logging
import shlex
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.config import settings
from app.models import UpdateSrtRequest
from app.dependencies import get_jobs, get_ws_clients, get_job_queue
from app.services.tool_services import _srt_path, _video_path, parse_srt

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


# ── POST /api/hardcode/{video_id} ──

@router.post("/api/hardcode/{video_id}")
async def hardcode_subtitles(video_id: str, request: Request):
    _srt_path(video_id)
    video_path = _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

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
    }
    jobs[job_id] = job
    logger.info("hardcode job %s: queued for %s", job_id, video_id)
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
    from app.services.tool_services import parse_srt
    entries = parse_srt(content)
    return {"entries": [e.model_dump() for e in entries]}


# ── GET /api/tts/{video_id}/available ──

@router.get("/api/tts/{video_id}/available")
async def list_available_tts(video_id: str):
    """List available TTS dubbed files for this video."""
    files = []
    tts_dir = settings.temp_dir / "tts" / video_id
    if tts_dir.exists():
        dubbed = tts_dir / "dubbed_video.mp4"
        if dubbed.exists():
            files.append({"id": "dubbed", "name": "Video lồng tiếng", "size": dubbed.stat().st_size})
    return {"files": files}


# ── GET /api/tts-audio/{video_id}/{filename} ──

@router.get("/api/tts-audio/{video_id}/{filename}")
async def serve_tts_audio(video_id: str, filename: str):
    path = settings.temp_dir / "tts" / video_id / filename
    if not path.exists():
        raise HTTPException(404, "Audio file not found")
    return FileResponse(str(path), media_type="audio/mpeg")
