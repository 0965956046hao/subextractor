"""Thumbnail endpoints: save URL, fal.ai regenerate, serve file."""

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


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
def update_thumbnail(video_id: str):
    """Regenerate the thumbnail via fal.ai image-to-image."""
    from app.services.fal_service import update_thumbnail as do_update

    try:
        path = do_update(video_id)
    except Exception as e:
        raise HTTPException(500, f"Tạo thumbnail thất bại: {e}")
    return {"thumbnail_url": f"/api/thumbnail/{video_id}"}


@router.get("/api/thumbnail/{video_id}")
async def serve_thumbnail(video_id: str):
    """Serve the generated thumbnail image."""
    path = settings.temp_dir / "thumb" / video_id / "thumbnail.png"
    if not path.exists():
        raise HTTPException(404, "Thumbnail not found. Run update first.")
    return FileResponse(str(path), media_type="image/png")
