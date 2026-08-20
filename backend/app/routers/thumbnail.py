"""Thumbnail endpoints: save URL, fal.ai regenerate (async), status, serve file."""

import logging
import os
import threading

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

_thumb_jobs: dict = {}
_thumb_lock = threading.Lock()


@router.get("/api/context/{video_id}/thumbnail")
async def serve_context_thumbnail(video_id: str):
    """Serve the local thumbnail image downloaded during merge (if any)."""
    from app.services.context_service import load_thumbnail_file

    p = load_thumbnail_file(video_id)
    if not p:
        raise HTTPException(404, "Thumbnail not saved yet.")
    return FileResponse(str(p), media_type="image/jpeg")


@router.get("/api/context/{video_id}/context-images")
async def list_context_images(video_id: str):
    """List local context image filenames (big thumbs from merge)."""
    from app.services.context_service import _context_image_paths

    paths = _context_image_paths(video_id)
    return {"images": [p.name for p in paths]}


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


@router.get("/api/thumbnail/{video_id}/prompt")
def thumbnail_prompt(video_id: str):
    """Return the thumbnail-edit prompt + source image URL for the GPT flow.

    Uses the same prompt-building logic as the fal.ai flow so both engines
    produce the same kind of 16:9 edit.
    """
    from app.services.fal_service import get_thumbnail_prompt

    try:
        prompt, thumb_url = get_thumbnail_prompt(video_id)
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"prompt": prompt, "thumb_url": thumb_url}


@router.post("/api/thumbnail/{video_id}/gpt-result")
async def save_gpt_result(video_id: str, file: UploadFile = File(...)):
    """Save a ChatGPT-generated thumbnail image to the standard thumbnail path."""
    out_dir = settings.temp_dir / "thumb" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "thumbnail.png"
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, out_path)
    logger.info("GPT thumbnail saved for %s → %s", video_id, out_path)
    return {"status": "done", "thumbnail_url": f"/api/thumbnail/{video_id}"}


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
