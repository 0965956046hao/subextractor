"""Pipeline readiness / health check endpoints."""

import logging
import time

from fastapi import APIRouter, Request

from app.services.health_service import check_gemini, check_tts, pipeline_health
from fastapi.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)
router = APIRouter()


def execution_job_status(job_id: str, job: dict, scheduler) -> dict:
    """Read-only execution state: lane ownership alone does not mean running."""
    from app.scheduler import lane_for, resources_for
    from app.services.processing_timing import timing_snapshot

    timing = timing_snapshot(job)
    job_type = job.get("job_type", "ocr")
    lane_name = lane_for(job_type)
    lane = scheduler.lanes.get(lane_name) if scheduler is not None else None
    position = lane.position(job_id) if lane is not None else None
    waiting_resources = []
    if lane is not None and lane.running == job_id and not timing["running"]:
        waiting_resources = [name for name in resources_for(job_type)
                             if scheduler.gates[name].owner not in (None, job_id)]
    if timing["running"]:
        state = "running"
    elif position is not None:
        state = "queued"
    elif waiting_resources:
        state = "waiting_resources"
    elif lane is not None and lane.running == job_id:
        state = "waiting_executor"
    else:
        state = "checking" if scheduler is None else "queued"
    return {"job_id": job_id, "video_id": job.get("video_id"), "job_type": job_type,
            "state": state, "lane": lane_name, "queue_position": position,
            "waiting_resources": waiting_resources, "processing_timing": timing}


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
    scheduler = getattr(request.app.state, "scheduler", None)
    snapshot = scheduler.snapshot() if scheduler is not None else {"lanes": {}, "resources": {}}
    return {
        "queue_size": queue.qsize(),
        "workers": beats,
        "workers_alive": any(now - v < 15 for v in _worker_heartbeats.values()),
        "active_jobs": active,
        "now": now,
        # Per-step lane state + shared gpu/gemini/cpu owners.
        "lanes": snapshot.get("lanes", {}),
        "resources": snapshot.get("resources", {}),
        "execution_jobs": [execution_job_status(job_id, job, scheduler)
                           for job_id, job in jobs.items()
                           if job.get("status") in ("queued", "processing")
                           or (job.get("status") == "done" and job.get("_processing_monotonic") is not None)],
    }
