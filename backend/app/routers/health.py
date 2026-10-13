"""Pipeline readiness / health check endpoints."""

import logging
import time

from fastapi import APIRouter, Request

from app.services.health_service import check_gemini, check_tts, pipeline_health
from fastapi.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/health/checks")
async def health_checks():
    """Full prerequisite health check (Gemini + TTS). Blocks pipeline start."""
    return await run_in_threadpool(pipeline_health)


@router.get("/api/health/gemini")
async def gemini_check():
    return check_gemini()


@router.get("/api/health/tts")
async def tts_check():
    return check_tts()


@router.get("/api/worker-status")
async def worker_status(request: Request):
    """Trạng thái hàng đợi + worker loop (chẩn đoán job kẹt queued).

    workers: {task_id: số giây từ heartbeat cuối}. alive=false + queue_size>0
    kéo dài = worker chết lặng (supervisor sẽ tạo lại trong vài giây).
    """
    from app.worker import _worker_heartbeats

    now = time.time()
    queue = request.app.state.job_queue
    jobs: dict = request.app.state.jobs
    beats = {str(k): round(now - v, 1) for k, v in _worker_heartbeats.items()}
    active = sum(
        1 for j in jobs.values()
        if j.get("status") in ("queued", "processing")
    )
    return {
        "queue_size": queue.qsize(),
        "workers": beats,
        "workers_alive": any(now - v < 15 for v in _worker_heartbeats.values()),
        "active_jobs": active,
        "now": now,
    }