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

    workers: {task_id: số giây từ heartbeat cuối} — worker chỉ heartbeat mỗi
    vòng lặp (nhận job), NÊN job dài 2-4h làm heartbeat cũ đi là BÌNH THƯỜNG.
    Đọc kèm: `busy` (đang có job processing) và `last_activity_age_s` (log gần
    nhất). Nghi kẹt thật khi queue_size>0 mà không busy, không activity mới.
    Supervisor tự spawn dự phòng trong trường hợp đó (không kill worker bận).
    """
    from app.worker import _worker_heartbeats
    from app.services.job_utils import _last_job_activity

    now = time.time()
    queue = request.app.state.job_queue
    jobs: dict = request.app.state.jobs
    beats = {str(k): round(now - v, 1) for k, v in _worker_heartbeats.items()}
    busy = sum(1 for j in jobs.values() if j.get("status") == "processing")
    active = sum(
        1 for j in jobs.values()
        if j.get("status") in ("queued", "processing")
    )
    return {
        "queue_size": queue.qsize(),
        "workers": beats,
        "workers_alive": any(now - v < 15 for v in _worker_heartbeats.values()),
        "workers_busy": busy,
        "last_activity_age_s": round(now - _last_job_activity, 1) if _last_job_activity else None,
        "active_jobs": active,
        "now": now,
    }