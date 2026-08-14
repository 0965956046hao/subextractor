"""Meta generation endpoints for the auto pipeline."""

import json
import logging

from fastapi import APIRouter, HTTPException

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/meta/{video_id}")
def generate_meta(video_id: str):
    """Generate meta.json from context + share text via Gemini."""
    from app.services.meta_service import generate_video_meta

    try:
        meta = generate_video_meta(video_id)
    except Exception as e:
        raise HTTPException(500, f"Tạo meta thất bại: {e}")
    return {"meta": meta}


@router.get("/api/meta/{video_id}")
def get_meta(video_id: str):
    """Return the saved meta.json, or empty object."""
    path = settings.temp_dir / "meta" / video_id / "meta.json"
    if not path.exists():
        return {"meta": {}}
    try:
        return {"meta": json.loads(path.read_text(encoding="utf-8"))}
    except Exception:
        return {"meta": {}}
