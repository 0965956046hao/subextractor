import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()

IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


@router.get("/api/image/{file_path:path}")
async def get_image(file_path: str):
    """Serve an image file from the temp directory.

    Path must be a relative path under temp/, e.g.:
        /api/image/thumb/{video_id}/thumbnail.jpg
        /api/image/context/{video_id}/context_001.jpg
        /api/image/frames/{video_id}/first_frame.jpg
    """
    if not file_path or ".." in file_path or file_path.startswith("/"):
        raise HTTPException(400, "Invalid path")

    target = (settings.temp_dir / file_path).resolve()
    temp_root = settings.temp_dir.resolve()

    if not str(target).startswith(str(temp_root)):
        raise HTTPException(403, "Access denied")

    if not target.exists() or not target.is_file():
        raise HTTPException(404, "Image not found")

    ext = target.suffix.lower()
    media_type = IMAGE_TYPES.get(ext, "application/octet-stream")

    return FileResponse(str(target), media_type=media_type)
