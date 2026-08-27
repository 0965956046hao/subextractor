"""Meta generation endpoints for the auto pipeline."""

import json
import logging
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

# Video ids currently generating meta in a background thread. Prevents the
# synchronous POST from holding the HTTP connection open (Gemini takes 20-60s,
# which made the Next.js proxy reset the socket -> ECONNRESET). The POST now
# returns immediately and the frontend polls GET /api/meta until meta.json exists.
_meta_running: set[str] = set()
_meta_lock = threading.Lock()


def _meta_path(video_id: str) -> Path:
    return settings.temp_dir / "meta" / video_id / "meta.json"


@router.post("/api/meta/{video_id}")
def generate_meta(video_id: str):
    """Kick off meta generation in the background; return immediately.

    Meta generation calls Gemini and can take 20-60s, so we run it in a daemon
    thread and return ``{"status": "pending"}`` right away. The client polls
    GET /api/meta/{video_id} until ``meta`` is populated.
    """
    from app.services.meta_service import generate_video_meta

    with _meta_lock:
        already = video_id in _meta_running

    if already:
        return {"status": "pending"}

    def _run() -> None:
        try:
            generate_video_meta(video_id)
            logger.info("Meta generated for %s", video_id)
        except Exception as e:
            logger.warning("Meta generation failed for %s: %s", video_id, e)
        finally:
            with _meta_lock:
                _meta_running.discard(video_id)

    with _meta_lock:
        _meta_running.add(video_id)
    threading.Thread(target=_run, daemon=True).start()
    return {"status": "pending"}


@router.get("/api/meta/{video_id}")
def get_meta(video_id: str):
    """Return the saved meta.json, or null when not generated yet."""
    path = _meta_path(video_id)
    if not path.exists():
        return {"meta": None}
    try:
        return {"meta": json.loads(path.read_text(encoding="utf-8"))}
    except Exception:
        return {"meta": None}
