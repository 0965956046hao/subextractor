import logging
import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException

from app.config import settings
from app.models import ProcessRequest, JobStatus, LogEntry
from app.dependencies import get_jobs, get_ws_clients, get_job_queue
from app.services.video_processor import resolve_video_path
from app.worker import enqueue_job

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/process", response_model=JobStatus)
async def start_processing(
    req: ProcessRequest,
    jobs: dict = Depends(get_jobs),
    job_queue: asyncio.Queue = Depends(get_job_queue),
):
    video_dir = settings.temp_dir / "videos" / req.video_id
    if not video_dir.exists():
        raise HTTPException(404, "Video not found")

    region = req.region.model_dump()
    if region["x2"] - region["x1"] < 0.01 or region["y2"] - region["y1"] < 0.01:
        raise HTTPException(
            422,
            "Region is too small — drag a rectangle that covers the subtitle area (not a single point).",
        )

    video_path = resolve_video_path(req.video_id)
    job = enqueue_job(
        jobs=jobs,
        video_path=str(video_path),
        video_id=req.video_id,
        region=region,
        fps=req.fps,
        lang=req.lang,
        ocr_type=req.ocr_type,
        start_time=req.start_time,
        end_time=req.end_time,
    )
    await job_queue.put(job["job_id"])
    return JobStatus(
        job_id=job["job_id"],
        status=job["status"],
    )


@router.post("/api/process/{job_id}/cancel", response_model=JobStatus)
async def cancel_job(
    job_id: str,
    jobs: dict = Depends(get_jobs),
):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    job["cancelled"] = True
    job["status"] = "cancelled"
    logger.info("job %s: cancel requested", job_id)
    return JobStatus(
        job_id=job_id,
        status=job["status"],
        phase=job.get("phase", ""),
        progress=job.get("progress", 0),
    )


@router.get("/api/status/{job_id}", response_model=JobStatus)
async def get_status(
    job_id: str,
    jobs: dict = Depends(get_jobs),
):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return JobStatus(
        job_id=job_id,
        status=job["status"],
        phase=job.get("phase", ""),
        progress=job.get("progress", 0),
        error=job.get("error"),
        logs=[LogEntry(**entry) for entry in job.get("logs", [])],
    )


@router.websocket("/api/ws/{job_id}")
async def ws_progress(
    websocket: WebSocket,
    job_id: str,
):
    ws_clients: dict = websocket.app.state.ws_clients
    jobs: dict = websocket.app.state.jobs

    await websocket.accept()
    if job_id not in ws_clients:
        ws_clients[job_id] = set()
    ws_clients[job_id].add(websocket)

    job = jobs.get(job_id)
    if job:
        await websocket.send_json({
            "type": "progress",
            "progress": job.get("progress", 0),
            "phase": job.get("phase", ""),
        })
        for entry in job.get("logs", []):
            await websocket.send_json({"type": "log", **entry})
        if job["status"] == "done":
            await websocket.send_json({
                "type": "done",
                "video_id": job.get("video_id", ""),
            })
        elif job["status"] == "error":
            await websocket.send_json({
                "type": "error",
                "message": job.get("error", "Unknown error"),
            })

    try:
        while True:
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients[job_id].discard(websocket)
        if not ws_clients[job_id]:
            del ws_clients[job_id]
