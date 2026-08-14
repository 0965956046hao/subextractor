"""Background worker: queue, WebSocket notify, and per-entry voice generation."""

import asyncio
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Set

from service.config import settings

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1)


def shutdown_executor():
    _executor.shutdown(wait=False, cancel_futures=True)


class JobCancelled(Exception):
    pass


def new_job(segments: List[dict], voice: str, rate: str, filename_prefix: str) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "segments": segments,
        "voice": voice,
        "rate": rate,
        "filename_prefix": filename_prefix,
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "logs": [],
        "audio_files": [],
        "out_dir": None,
    }
    return job


async def notify_ws(ws_clients: Dict[str, set], job_id: str, data: dict):
    clients = ws_clients.get(job_id, set())
    for ws in clients.copy():
        try:
            await ws.send_json(data)
        except Exception:
            clients.discard(ws)


def _notify_sync(loop: asyncio.AbstractEventLoop, ws_clients: dict, job_id: str, data: dict):
    coro = notify_ws(ws_clients, job_id, data)
    asyncio.run_coroutine_threadsafe(coro, loop)


def job_log(
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
    message: str,
    level: str = "info",
):
    entry = {"message": message, "ts": time.time(), "level": level}
    job.setdefault("logs", []).append(entry)
    logger.info("job %s: [%s] %s", job["job_id"], level, message)
    _notify_sync(loop, ws_clients, job["job_id"], {"type": "log", **entry})


def process_job_sync(
    client,
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
):
    job_id = job["job_id"]
    out_dir = settings.temp_dir / "jobs" / job_id / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    job["out_dir"] = str(out_dir)

    segments = job["segments"]
    total = len(segments)
    voice = job["voice"]
    rate = job["rate"]
    prefix = job["filename_prefix"]

    job_log(job, ws_clients, loop, f"Bắt đầu tạo giọng đọc ({total} đoạn, voice={voice})…")

    def progress_cb(done: int, total: int):
        if job.get("cancelled"):
            raise JobCancelled()
        pct = int((done / total) * 100) if total else 100
        job["progress"] = pct
        _notify_sync(loop, ws_clients, job_id, {
            "type": "progress", "progress": pct, "phase": "tts",
        })

    texts = [s["text"] for s in segments]
    written = client.generate_speech_to_files(
        texts,
        out_dir,
        voice=voice,
        rate=rate,
        prefix=prefix,
        progress_callback=progress_cb,
    )

    if not written:
        raise RuntimeError("Không tạo được đoạn audio nào (tất cả segment đều thất bại)")

    job["audio_files"] = [str(p) for p in sorted(written)]
    job["progress"] = 100
    job["status"] = "done"
    job["phase"] = "done"
    job_log(job, ws_clients, loop, f"Hoàn tất! Đã tạo {len(written)}/{total} file audio.", "success")
    _notify_sync(loop, ws_clients, job_id, {
        "type": "done", "progress": 100, "audio_files": job["audio_files"],
    })


async def run_tts_job(client, jobs: dict, ws_clients: dict, job_id: str):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        if job.get("cancelled"):
            raise JobCancelled()
        job["status"] = "processing"
        job["phase"] = "tts"
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "tts",
        })

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            _executor,
            process_job_sync,
            client, job, ws_clients, loop,
        )

    except JobCancelled:
        logger.info("job %s: cancelled", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except Exception as e:
        logger.exception("job %s: FAILED", job_id)
        job["status"] = "error"
        job["error"] = str(e)
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def worker_loop(client, jobs: dict, ws_clients: dict, queue: asyncio.Queue):
    logger.info("Worker loop started")
    while True:
        job_id = await queue.get()
        job = jobs.get(job_id)
        try:
            if job:
                await run_tts_job(client, jobs, ws_clients, job_id)
        except Exception as e:
            logger.exception("Unhandled worker error for job %s: %s", job_id, e)
        finally:
            queue.task_done()