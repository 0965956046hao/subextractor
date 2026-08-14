"""Thumbnail endpoints: save URL, fal.ai regenerate (async), status, serve file."""

import logging
import threading

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

_thumb_jobs: dict = {}
_thumb_lock = threading.Lock()


@router.post("/api/context/{video_id}/thumbnail")
async def save_thumbnail_url(video_id: str, request: Request):
    """Persist the extracted thumbnail URL (from resolve) for later use."""
    from app.services.context_service import save_thumbnail

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    url = (body.get("url") or "").strip()
    if url:
        save_thumbnail(video_id, url)
    return {"status": "ok", "saved": bool(url)}


@router.post("/api/thumbnail/{video_id}")
async def start_thumbnail(video_id: str):
    """Start fal.ai thumbnail generation in background; poll /status for result."""
    from app.services.fal_service import update_thumbnail as do_update

    out_path = settings.temp_dir / "thumb" / video_id / "thumbnail.png"

    with _thumb_lock:
        if out_path.exists():
            _thumb_jobs[video_id] = {"status": "done", "error": None}
            return {"status": "done", "thumbnail_url": f"/api/thumbnail/{video_id}"}
        _thumb_jobs[video_id] = {"status": "processing", "error": None}

    def _run():
        try:
            do_update(video_id)
            _thumb_jobs[video_id] = {"status": "done", "error": None}
        except Exception as e:
            _thumb_jobs[video_id] = {"status": "error", "error": str(e)}
        logger.info("Thumbnail job done for %s: %s", video_id, _thumb_jobs[video_id].get("status"))

    threading.Thread(target=_run, daemon=True).start()
    return {"status": "processing"}


@router.get("/api/thumbnail/{video_id}/status")
async def thumbnail_status(video_id: str):
    """Poll thumbnail generation status."""
    out_path = settings.temp_dir / "thumb" / video_id / "thumbnail.png"
    if out_path.exists():
        return {"status": "done", "error": None, "thumbnail_url": f"/api/thumbnail/{video_id}"}

    job = _thumb_jobs.get(video_id)
    if job is None:
        return {"status": "idle", "error": None}
    return {"status": job.get("status", "processing"), "error": job.get("error")}


@router.get("/api/thumbnail/{video_id}")
async def serve_thumbnail(video_id: str):
    """Serve the generated thumbnail image."""
    path = settings.temp_dir / "thumb" / video_id / "thumbnail.png"
    if not path.exists():
        raise HTTPException(404, "Thumbnail not found. Run update first.")
    return FileResponse(str(path), media_type="image/png")
