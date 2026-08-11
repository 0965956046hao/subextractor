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
