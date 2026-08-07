import uuid
import time
import asyncio
import logging
import functools
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.services.video_processor import stream_frames_generator, crop_region
from app.services.ocr_engine import BaseOCREngine
from app.services.subtitle_generator import generate_srt, sec_to_srt

logger = logging.getLogger(__name__)


_executor = ThreadPoolExecutor(max_workers=1)


def enqueue_job(
    jobs: dict,
    video_path: str,
    video_id: str,
    region: dict,
    fps: int | None = None,
    lang: str = "ch",
    ocr_type: str = "apple",
) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_path": video_path,
        "video_id": video_id,
        "region": region,
        "fps": fps,
        "lang": lang,
        "ocr_type": ocr_type,
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "srt_path": None,
    }
    jobs[job_id] = job
    logger.info("job %s: queued (lang=%s, ocr=%s)  |  %s", job_id, lang, ocr_type, video_path)
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


async def job_log_async(
    job: dict,
    ws_clients: dict,
    message: str,
    level: str = "info",
):
    entry = {"message": message, "ts": time.time(), "level": level}
    job.setdefault("logs", []).append(entry)
    logger.info("job %s: [%s] %s", job["job_id"], level, message)
    await notify_ws(ws_clients, job["job_id"], {"type": "log", **entry})


def process_job_sync(
    video_path: str,
    region: dict,
    target_fps: int,
    ocr_engine: BaseOCREngine,
    ws_clients: dict,
    job_id: str,
    loop: asyncio.AbstractEventLoop,
    job: dict,
):
    logger.info("job %s: extracting frames...", job_id)
    t0 = time.time()

    import cv2

    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if cap.isOpened() else 0
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.release()

    if target_fps and target_fps > 0:
        total_crops = max(1, round(total_frames * min(target_fps, video_fps) / video_fps))
    else:
        total_crops = total_frames

    job_log(job, ws_clients, loop, "Đang đọc từng khung hình của video…")

    crops = (
        (crop_region(frame, region), ts)
        for frame, ts in stream_frames_generator(video_path, target_fps)
    )

    job["progress"] = 0
    last_pct_log = 0

    def progress_cb(idx: int, total: int):
        nonlocal last_pct_log
        if total and idx % max(1, total // 100) == 0:
            pct = min(100, int((idx + 1) / total * 100))
            job["progress"] = pct
            if pct >= last_pct_log + 10:
                last_pct_log = pct
                job_log(
                    job, ws_clients, loop,
                    f"Đã nhận dạng được khoảng {pct}% của video…",
                    "info",
                )
            _notify_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "ocr",
            })

    job_log(job, ws_clients, loop, "Bắt đầu nhận dạng chữ viết trong video…")
    logger.info("job %s: running OCR...", job_id)

    def text_cb(start: float, end: float, text: str):
        job_log(
            job, ws_clients, loop,
            f"[{sec_to_srt(start)} → {sec_to_srt(end)}] {text}",
            "text",
        )

    srt_content = generate_srt(
        crops, region, ocr_engine,
        progress_callback=progress_cb,
        text_callback=text_cb,
        total_frames=total_crops,
    )
    t2 = time.time()
    logger.info("job %s: OCR done in %.1fs", job_id, t2 - t0)
    return srt_content


async def run_job(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, "BaseOCREngine"],
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        job["status"] = "processing"
        job["phase"] = "frames"
        await job_log_async(job, ws_clients, "Bắt đầu xử lý video…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "frames",
        })

        video_path = job["video_path"]
        region = job["region"]
        target_fps = job.get("fps") or settings.extract_fps or None
        lang = job.get("lang") or settings.ocr_lang
        ocr_type = job.get("ocr_type") or "apple"

        ocr_engine = ocr_engines.get(ocr_type)
        if ocr_engine is None:
            raise RuntimeError(
                f"OCR engine '{ocr_type}' không khả dụng trên máy chủ này"
            )
        ocr_engine.set_lang(lang)
        await job_log_async(
            job, ws_clients,
            f"Đang xử lý bằng {ocr_engine.name} (ngôn ngữ: {lang})",
            "info",
        )

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
        await job_log_async(job, ws_clients, "Đang lọc ký tự thừa và gộp phụ đề lần cuối…")
        await job_log_async(job, ws_clients, "Đang lưu file phụ đề…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 100, "phase": "saving",
        })

        video_id = job.get("video_id", job_id)
        srt_dir = settings.temp_dir / "srt" / video_id
        srt_dir.mkdir(parents=True, exist_ok=True)
        srt_path = srt_dir / "subtitles.srt"
        srt_path.write_text(srt_content, encoding="utf-8")

        size_kb = srt_path.stat().st_size / 1024
        line_count = srt_content.count("-->")
        job["status"] = "done"
        job["progress"] = 100
        job["srt_path"] = str(srt_path)
        await job_log_async(
            job, ws_clients,
            f"Hoàn tất! Đã nhận dạng {line_count} dòng phụ đề và lưu file SRT.",
            "success",
        )
        await notify_ws(ws_clients, job_id, {
            "type": "done", "video_id": video_id,
        })
        logger.info("job %s: done  |  %.1fKB  |  %.1fs total", job_id, size_kb, time.time() - t_start)

    except asyncio.TimeoutError:
        logger.error("job %s: TIMEOUT after %ds", job_id, settings.job_timeout)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(
            job, ws_clients,
            f"Quá thời gian xử lý ({settings.job_timeout} giây). Vui lòng thử lại với video ngắn hơn.",
            "error",
        )
        await notify_ws(ws_clients, job_id, {
            "type": "error", "message": "Job timed out",
        })
    except Exception as e:
        logger.exception("job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(
            job, ws_clients,
            f"Có lỗi xảy ra khi xử lý: {e}",
            "error",
        )
        await notify_ws(ws_clients, job_id, {
            "type": "error", "message": str(e),
        })


async def worker_loop(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, "BaseOCREngine"],
    queue: asyncio.Queue,
):
    logger.info("Worker loop started")
    while True:
        job_id = await queue.get()
        try:
            await run_job(jobs, ws_clients, ocr_engines, job_id)
        except Exception as e:
            logger.exception("Unhandled worker error for job %s: %s", job_id, e)
        finally:
            queue.task_done()
