"""Persist the auto-pipeline list so the FE can restore it after a page reload."""

import json
import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

PIPELINES_FILE = settings.temp_dir / "pipelines.json"


class PipelinesRequest(BaseModel):
    pipelines: list[dict[str, Any]] = []


@router.get("/api/pipelines")
async def get_pipelines():
    if PIPELINES_FILE.exists():
        try:
            data = json.loads(PIPELINES_FILE.read_text(encoding="utf-8"))
            return data
        except Exception:
            return {"pipelines": []}
    return {"pipelines": []}


@router.post("/api/pipelines")
async def save_pipelines(body: PipelinesRequest):
    PIPELINES_FILE.write_text(
        json.dumps({"pipelines": body.pipelines}, ensure_ascii=False),
        encoding="utf-8",
    )
    return {"status": "ok", "count": len(body.pipelines)}
