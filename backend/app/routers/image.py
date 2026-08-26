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


@router.get("/api/context-images/{video_id}")
async def list_context_images(video_id: str):
    """List cover image + context (scene) images for a pipeline video.

    Returns {thumbnail: url|null, images: [url,...]} with URLs served by
    GET /api/image/{path}. Falls back to the merged-context copy when the
    video's own context dir has no thumbnail.
    """
    if not video_id or "/" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")

    import json as _json

    d = settings.temp_dir / "context" / video_id
    out: dict = {"thumbnail": None, "images": []}
    if not d.exists():
        return out

    thumb = d / "thumbnail.jpg"
    if not thumb.exists():
        # Fallback: bản context của lần merge gốc (meta.source_merge_id)
        try:
            meta_path = settings.temp_dir / "videos" / video_id / "meta.json"
            mid = (_json.loads(meta_path.read_text(encoding="utf-8")) or {}).get(
                "source_merge_id"
            )
            if mid and (settings.temp_dir / "merged" / f"{mid}_context" / "thumbnail.jpg").exists():
                out["thumbnail"] = f"/api/image/merged/{mid}_context/thumbnail.jpg"
        except Exception:
            pass
    else:
        out["thumbnail"] = f"/api/image/context/{video_id}/thumbnail.jpg"

    cdir = d / "context_images"
    if cdir.exists():
        for f in sorted(cdir.glob("context_*.jpg")):
            out["images"].append(
                f"/api/image/context/{video_id}/context_images/{f.name}"
            )
    return out
