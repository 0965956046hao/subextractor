import uuid
import time
import asyncio
import logging
import functools
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.services.video_processor import (
    stream_frames_generator,
    crop_region,
    cleanup_temp_keep_srt,
)
from app.services.ocr_engine import OCREngine
from app.services.subtitle_generator import generate_srt

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1)


def enqueue_job(
    jobs: dict,
    video_path: str,
    video_id: str,
    region: dict,
    fps: int | None = None,
) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_path": video_path,
        "video_id": video_id,
        "region": region,
        "fps": fps,
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "srt_path": None,
    }
    jobs[job_id] = job
    logger.info("job %s: queued  |  %s", job_id, video_path)
    return job


async def notify_ws(ws_clients: dict, job_id: str, data: dict):
    clients = ws_clients.get(job_id, set())
    for ws in clients.copy():
        try:
            await ws.send_json(data)
        except Exception:
            clients.discard(ws)


def _notify_sync(loop: asyncio.AbstractEventLoop, ws_clients: dict, job_id: str, data: dict):
    coro = notify_ws(ws_clients, job_id, data)
    asyncio.run_coroutine_threadsafe(coro, loop)


def process_job_sync(
    video_path: str,
    region: dict,
    target_fps: int,
    ocr_engine: OCREngine,
    ws_clients: dict,
    job_id: str,
    loop: asyncio.AbstractEventLoop,
    job: dict,
):
    logger.info("job %s: extracting frames...", job_id)
    t0 = time.time()

    frames: list[tuple] = []
    for frame, ts in stream_frames_generator(video_path, target_fps):
        crop = crop_region(frame, region)
        frames.append((crop, ts))

    t1 = time.time()
    logger.info("job %s: %d frames in %.1fs", job_id, len(frames), t1 - t0)

    total = len(frames)
    job["progress"] = 0

    def progress_cb(idx: int, _total: int):
        if idx % max(1, total // 100) == 0:
            pct = int((idx + 1) / total * 100) if total else 0
            job["progress"] = pct
            _notify_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "ocr",
            })

    logger.info("job %s: running OCR...", job_id)
    srt_content = generate_srt(
        frames, region, ocr_engine,
        progress_callback=progress_cb,
    )
    t2 = time.time()
    logger.info("job %s: OCR done in %.1fs", job_id, t2 - t1)
    return srt_content


async def run_job(
    jobs: dict,
    ws_clients: dict,
    ocr_engine: OCREngine,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        job["status"] = "processing"
        job["phase"] = "frames"
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "frames",
        })

        video_path = job["video_path"]
        region = job["region"]
        target_fps = job.get("fps") or settings.extract_fps

        ocr_engine.reset_cache()

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            process_job_sync,
            video_path, region, target_fps,
            ocr_engine, ws_clients, job_id, loop, job,
        )

        logger.info("job %s: processing started  |  %s", job_id, video_path)
        t_start = time.time()

        srt_content = await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=settings.job_timeout,
        )

        t_end = time.time()
        logger.info("job %s: saving SRT...  |  total %.1fs", job_id, t_end - t_start)

        job["phase"] = "saving"
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 100, "phase": "saving",
        })

        video_id = job.get("video_id", job_id)
        srt_dir = settings.temp_dir / "srt" / video_id
        srt_dir.mkdir(parents=True, exist_ok=True)
        srt_path = srt_dir / "subtitles.srt"
        srt_path.write_text(srt_content, encoding="utf-8")

        size_kb = srt_path.stat().st_size / 1024
        cleanup_temp_keep_srt(video_id)
        job["status"] = "done"
        job["progress"] = 100
        job["srt_path"] = str(srt_path)
        await notify_ws(ws_clients, job_id, {
            "type": "done", "video_id": video_id,
        })
        logger.info("job %s: done  |  %.1fKB  |  %.1fs total", job_id, size_kb, time.time() - t_start)

    except asyncio.TimeoutError:
        logger.error("job %s: TIMEOUT after %ds", job_id, settings.job_timeout)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await notify_ws(ws_clients, job_id, {
            "type": "error", "message": "Job timed out",
        })
    except Exception as e:
        logger.exception("job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await notify_ws(ws_clients, job_id, {
            "type": "error", "message": str(e),
        })


async def worker_loop(
    jobs: dict,
    ws_clients: dict,
    ocr_engine: OCREngine,
    queue: asyncio.Queue,
):
    logger.info("Worker loop started")
    while True:
        job_id = await queue.get()
        try:
            await run_job(jobs, ws_clients, ocr_engine, job_id)
        except Exception as e:
            logger.exception("Unhandled worker error for job %s: %s", job_id, e)
        finally:
            queue.task_done()
