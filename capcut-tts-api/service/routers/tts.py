"""TTS job submission, status, cancel, and WebSocket progress."""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from service.dependencies import get_capcut_client, get_job_queue, get_jobs, get_ws_clients
from service.models import TTSJobCreated, TTSJobStatus, TTSRequest
from service.worker import new_job

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["tts"])


def _job_to_status(job: dict) -> TTSJobStatus:
    return TTSJobStatus(
        job_id=job["job_id"],
        status=job["status"],
        phase=job.get("phase", ""),
        progress=job.get("progress", 0),
        error=job.get("error"),
        logs=job.get("logs", []),
        audio_files=job.get("audio_files", []),
        out_dir=job.get("out_dir"),
    )


@router.post("/tts", response_model=TTSJobCreated)
async def create_tts_job(
    req: TTSRequest,
    jobs: dict = Depends(get_jobs),
    queue: asyncio.Queue = Depends(get_job_queue),
):
    segments = [s.model_dump() for s in req.segments]
    job = new_job(segments, req.voice, req.rate, req.filename_prefix)
    jobs[job["job_id"]] = job
    await queue.put(job["job_id"])
    logger.info("job %s: queued (%d segments, voice=%s)", job["job_id"], len(segments), req.voice)
    return TTSJobCreated(job_id=job["job_id"])


@router.get("/tts/{job_id}", response_model=TTSJobStatus)
async def get_tts_job(job_id: str, jobs: dict = Depends(get_jobs)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return _job_to_status(job)


@router.post("/tts/{job_id}/cancel")
async def cancel_tts_job(job_id: str, jobs: dict = Depends(get_jobs)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    if job["status"] not in ("queued", "processing"):
        raise HTTPException(status_code=400, detail=f"Job {job_id} is not cancellable (status={job['status']})")
    job["cancelled"] = True
    return {"job_id": job_id, "status": "cancelling"}


@router.websocket("/tts/ws/{job_id}")
async def tts_ws(
    websocket: WebSocket,
    job_id: str,
    jobs: dict = Depends(get_jobs),
    ws_clients: dict = Depends(get_ws_clients),
):
    if job_id not in jobs:
        await websocket.close(code=4404)
        return
    await websocket.accept()
    ws_clients.setdefault(job_id, set()).add(websocket)
    try:
        await websocket.send_json({"type": "status", "job_id": job_id, "status": jobs[job_id]["status"]})
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.get(job_id, set()).discard(websocket)