"""Mini App annotation endpoints — persist OCR region & subtitle style.

The Telegram Mini App (annotator) posts the user's chosen OCR scan region and
subtitle size/position here. Values are stored in videos/{video_id}/meta.json
alongside ``filename`` / ``source_merge_id`` so the main pipeline can read them
back at the process / hardcode steps.
"""

import json
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


def _video_meta_path(video_id: str):
    return settings.temp_dir / "videos" / video_id / "meta.json"


def _read_meta(video_id: str) -> dict:
    path = _video_meta_path(video_id)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_meta(video_id: str, meta: dict):
    path = _video_meta_path(video_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


class RegionPayload(BaseModel):
    region: dict = Field(..., description="{x1,y1,x2,y2} normalized 0..1")
    start_time: float | None = None


class StylePayload(BaseModel):
    font_size: int | None = None
    margin_v: int | None = None
    margin_h: int | None = None


@router.post("/api/region/{video_id}")
async def save_ocr_region(video_id: str, body: RegionPayload):
    """Save the OCR scan region (+ optional start_time) chosen in the Mini App."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")

    region = body.region or {}
    keys = ("x1", "y1", "x2", "y2")
    if not all(k in region for k in keys):
        raise HTTPException(422, "region must include x1, y1, x2, y2")
    for k in keys:
        try:
            region[k] = float(region[k])
        except (TypeError, ValueError):
            raise HTTPException(422, f"region.{k} must be a number")
    if not (0 <= region["x1"] <= 1 and 0 <= region["y1"] <= 1
            and 0 <= region["x2"] <= 1 and 0 <= region["y2"] <= 1):
        raise HTTPException(422, "region coordinates must be normalized 0..1")

    meta = _read_meta(video_id)
    meta["region"] = region
    if body.start_time is not None:
        meta["start_time"] = body.start_time
    _write_meta(video_id, meta)

    logger.info("saved OCR region for %s: %s", video_id, region)
    return {"ok": True, "region": region, "start_time": body.start_time}


@router.post("/api/style/{video_id}")
async def save_subtitle_style(video_id: str, body: StylePayload):
    """Save the subtitle size/position chosen in the Mini App."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")

    style = {k: v for k, v in body.model_dump().items() if v is not None}

    meta = _read_meta(video_id)
    existing = meta.get("style") or {}
    if isinstance(existing, dict):
        existing.update(style)
    else:
        existing = style
    meta["style"] = existing
    _write_meta(video_id, meta)

    logger.info("saved subtitle style for %s: %s", video_id, existing)
    return {"ok": True, "style": existing}


@router.get("/api/annotation/{video_id}")
async def get_annotation(video_id: str):
    """Read back the saved region + style for a video (used by the pipeline)."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    meta = _read_meta(video_id)
    return {
        "region": meta.get("region"),
        "start_time": meta.get("start_time"),
        "style": meta.get("style"),
    }
