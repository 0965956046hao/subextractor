import uuid
import time
import asyncio
import logging
import functools
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.services.video_processor import stream_frames_generator, crop_region, resolve_video_path
from app.services.ocr_engine import BaseOCREngine
from app.services.subtitle_generator import generate_srt, sec_to_srt
from app.services.hardcode_service import run_hardcode_sync
from app.services.align_service import run_align_sync
from app.services.job_utils import JobCancelled, notify_ws_sync
from app.services.media_utils import _srt_path

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
        "job_type": "ocr",
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
            # A slow / backgrounded client that isn't reading its socket would
            # otherwise block the event loop on send_json, freezing /api/status,
            # /api/frame and everything else (→ "socket hang up" in the proxy).
            # Bound the send so one stuck client can never stall the loop.
            await asyncio.wait_for(ws.send_json(data), timeout=2)
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
        (crop_region(frame, region), frame, ts)
        for frame, ts in stream_frames_generator(video_path, target_fps)
    )

    job["progress"] = 0
    last_pct_log = 0

    def progress_cb(idx: int, total: int):
        nonlocal last_pct_log
        if job.get("cancelled"):
            raise JobCancelled()
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

    # Create directory for OCR frame snapshots
    job_video_id = job.get("video_id", job_id)
    crops_dir = settings.temp_dir / "frames" / job_video_id / "ocr_snapshots"
    crops_dir.mkdir(parents=True, exist_ok=True)

    srt_content = generate_srt(
        crops, region, ocr_engine,
        progress_callback=progress_cb,
        text_callback=text_cb,
        total_frames=total_crops,
        save_crops_dir=crops_dir,
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
        if job.get("cancelled"):
            raise JobCancelled()
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

        srt_content = await loop.run_in_executor(_executor, fn)

        t_end = time.time()
        logger.info("job %s: saving SRT...  |  total %.1fs", job_id, t_end - t_start)

        job["phase"] = "saving"
        await job_log_async(job, ws_clients, "Đang lọc ký tự thừa và gộp phụ đề lần cuối…")
        await job_log_async(job, ws_clients, "Đang lưu file phụ đề…")
        if job.get("cancelled"):
            raise JobCancelled()
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

        # Fire-and-forget: auto-generate context (runs after "done" notification)
        from app.services.context_service import generate_video_context
        from app.routers.config_router import _read_config
        cfg = _read_config()
        if cfg.get("auto_context_enabled", True):
            asyncio.create_task(_auto_context(video_id, generate_video_context, loop))
        else:
            logger.info("Auto context generation disabled, skipping for %s", video_id)

    except JobCancelled:
        logger.info("job %s: cancelled by user", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await job_log_async(
            job, ws_clients,
            "Đã hủy xử lý video (không lưu phụ đề).",
            "warn",
        )
        await notify_ws(ws_clients, job_id, {
            "type": "cancelled",
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


async def run_hardcode_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        job["status"] = "processing"
        job["phase"] = "hardcode"
        await job_log_async(job, ws_clients, "Bắt đầu encode phụ đề vào video (hardcode)…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "hardcode",
        })

        video_path = job["video_path"]
        video_id = job.get("video_id", job_id)
        srt_path = str(_srt_path(video_id))

        out_dir = settings.temp_dir / "hardcoded" / video_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = str(out_dir / f"{Path(video_path).stem}_hardcoded.mp4")

        if (
            not job.get("watermark")
            and Path(out_path).exists()
            and Path(out_path).stat().st_size > 0
        ):
            job["status"] = "done"
            job["progress"] = 100
            job["output_path"] = out_path
            size_mb = Path(out_path).stat().st_size / (1024 * 1024)
            await job_log_async(
                job, ws_clients,
                f"Video đã có phụ đề cứng từ lần chạy trước ({size_mb:.1f} MB) — bỏ qua encode.",
                "success",
            )
            await notify_ws(ws_clients, job_id, {
                "type": "done", "video_id": video_id, "filename": Path(out_path).name,
            })
            return

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_hardcode_sync,
            video_path, srt_path, out_path,
            job, ws_clients, loop, job_id,
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        job["output_path"] = out_path

        size_mb = Path(out_path).stat().st_size / (1024 * 1024)
        await job_log_async(
            job, ws_clients,
            f"Hoàn tất! Video đã được gắn phụ đề cứng ({size_mb:.1f} MB).",
            "success",
        )
        await notify_ws(ws_clients, job_id, {
            "type": "done", "video_id": video_id, "filename": Path(out_path).name,
        })

    except JobCancelled:
        logger.info("hardcode job %s: cancelled", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await job_log_async(job, ws_clients, "Đã hủy encode phụ đề.", "warn")
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except asyncio.TimeoutError:
        logger.error("hardcode job %s: TIMEOUT", job_id)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(job, ws_clients, f"Quá thời gian xử lý ({settings.job_timeout}s).", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": "Job timed out"})
    except Exception as e:
        logger.exception("hardcode job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Có lỗi khi hardcode: {e}", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def run_align_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        job["status"] = "processing"
        job["phase"] = "align"
        await job_log_async(job, ws_clients, "Bắt đầu căn chỉnh phụ đề bằng AI (Whisper)…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "align",
        })

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_align_sync,
            job, ws_clients, loop, job_id,
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(
            job, ws_clients,
            "Hoàn tất! Phụ đề đã được căn chỉnh với âm thanh video.",
            "success",
        )

    except JobCancelled:
        logger.info("align job %s: cancelled", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await job_log_async(job, ws_clients, "Đã hủy căn chỉnh phụ đề.", "warn")
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except asyncio.TimeoutError:
        logger.error("align job %s: TIMEOUT", job_id)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(job, ws_clients, f"Quá thời gian xử lý ({settings.job_timeout}s).", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": "Job timed out"})
    except Exception as e:
        logger.exception("align job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Có lỗi khi căn chỉnh: {e}", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def run_translate_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        from app.services.translation_service import run_translate_sync

        job["status"] = "processing"
        job["phase"] = "translate"
        await job_log_async(job, ws_clients, "Bắt đầu dịch phụ đề bằng Gemini…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "translate",
        })

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_translate_sync,
            loop, job_id, jobs, ws_clients, job["video_id"],
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(job, ws_clients, "Dịch hoàn tất! File SRT tiếng Việt đã sẵn sàng.", "success")

    except JobCancelled:
        logger.info("translate job %s: cancelled", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await job_log_async(job, ws_clients, "Đã hủy dịch.", "warn")
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except asyncio.TimeoutError:
        logger.error("translate job %s: TIMEOUT", job_id)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(job, ws_clients, f"Quá thời gian xử lý ({settings.job_timeout}s).", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": "Job timed out"})
    except Exception as e:
        logger.exception("translate job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Có lỗi khi dịch: {e}", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def run_tts_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        from app.services.tts_service import run_tts_sync

        job["status"] = "processing"
        job["phase"] = "tts"
        await job_log_async(job, ws_clients, "Bắt đầu tổng hợp giọng nói TTS…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "tts",
        })

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_tts_sync,
            loop, job_id, jobs, ws_clients, job["video_id"],
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(job, ws_clients, "TTS hoàn tất! Video lồng tiếng đã sẵn sàng.", "success")

    except JobCancelled:
        logger.info("tts job %s: cancelled", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await job_log_async(job, ws_clients, "Đã hủy TTS.", "warn")
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except asyncio.TimeoutError:
        logger.error("tts job %s: TIMEOUT", job_id)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(job, ws_clients, f"Quá thời gian xử lý ({settings.job_timeout}s).", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": "Job timed out"})
    except Exception as e:
        logger.exception("tts job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Có lỗi khi TTS: {e}", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def run_dub_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        from app.services.dub_service import run_dub_sync

        job["status"] = "processing"
        job["phase"] = "dub"
        await job_log_async(job, ws_clients, "Bắt đầu lồng tiếng Việt (tách giọng + TTS)…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "dub",
        })

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_dub_sync,
            loop, job_id, jobs, ws_clients, job["video_id"],
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(job, ws_clients, "Lồng tiếng Việt hoàn tất!", "success")

    except JobCancelled:
        logger.info("dub job %s: cancelled", job_id)
        job["status"] = "cancelled"
        job["phase"] = ""
        await job_log_async(job, ws_clients, "Đã hủy lồng tiếng.", "warn")
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except asyncio.TimeoutError:
        logger.error("dub job %s: TIMEOUT", job_id)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(job, ws_clients, f"Quá thời gian xử lý ({settings.job_timeout}s).", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": "Job timed out"})
    except Exception as e:
        logger.exception("dub job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Có lỗi khi lồng tiếng: {e}", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def run_export_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        from app.services.export_service import run_export

        job["status"] = "processing"
        job["phase"] = "export"
        await job_log_async(job, ws_clients, "Bắt đầu xuất video...")
        await notify_ws(ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "export"})

        loop = asyncio.get_event_loop()
        tracks = job.get("tracks", [])
        tts_clips = job.get("tts_clips", [])

        def progress_cb(pct, msg):
            job["progress"] = pct
            if msg:
                _notify_sync(loop, ws_clients, job_id, {
                    "type": "log", "message": msg, "ts": time.time(), "level": "info",
                })
            _notify_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "export",
            })

        fn = functools.partial(
            run_export,
            job["video_id"], tracks, tts_clips, progress_cb,
        )

        out_path = await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(job, ws_clients, "Xuất video hoàn tất!", "success")

    except JobCancelled:
        job["status"] = "cancelled"
        await job_log_async(job, ws_clients, "Đã huỷ xuất video.", "warn")
    except Exception as e:
        logger.exception("export job %s: FAILED", job_id)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Lỗi xuất: {e}", "error")


async def _auto_context(video_id: str, generate_fn, loop):
    """Fire-and-forget context generation after OCR completes."""
    try:
        await loop.run_in_executor(_executor, generate_fn, video_id)
        logger.info("Auto context generated for %s", video_id)
    except Exception:
        logger.warning("Auto context generation failed (non-critical)", exc_info=True)


async def run_risk_check_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    job = jobs.get(job_id)
    if not job:
        return

    try:
        from app.services.risk_check_service import run_risk_check_sync

        job["status"] = "processing"
        job["phase"] = "risk_check"
        await job_log_async(job, ws_clients, "Bắt đầu kiểm tra rủi ro file sub bằng Gemini…")
        await notify_ws(ws_clients, job_id, {
            "type": "progress", "progress": 0, "phase": "risk_check",
        })

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_risk_check_sync,
            loop, job_id, jobs, ws_clients, job["video_id"],
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(job, ws_clients, "Kiểm tra rủi ro hoàn tất.", "success")

    except asyncio.TimeoutError:
        logger.error("risk_check job %s: TIMEOUT", job_id)
        job["status"] = "error"
        job["error"] = f"Job timed out after {settings.job_timeout}s"
        await job_log_async(job, ws_clients, f"Quá thời gian xử lý ({settings.job_timeout}s).", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": "Job timed out"})
    except Exception as e:
        logger.exception("risk_check job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Có lỗi khi kiểm tra rủi ro: {e}", "error")
        await notify_ws(ws_clients, job_id, {"type": "error", "message": str(e)})


async def run_context_job(jobs: dict, ws_clients: dict, job_id: str):
    """Generate video context from OCR snapshots via Gemini Vision."""
    from app.services.context_service import generate_video_context, load_video_context

    job = jobs[job_id]
    video_id = job.get("video_id", job_id)

    try:
        job["status"] = "processing"
        job["phase"] = "context"
        await job_log_async(job, ws_clients, "Đang upload ảnh snapshot lên Gemini File Store...", "info")
        await notify_ws(ws_clients, job_id, {"type": "progress", "progress": 20, "phase": "context"})

        loop = asyncio.get_event_loop()
        context = await loop.run_in_executor(_executor, generate_video_context, video_id)

        if context:
            job["status"] = "done"
            job["progress"] = 100
            await job_log_async(job, ws_clients, f"Đã sinh ngữ cảnh: {context[:150]}...", "text")
            await notify_ws(ws_clients, job_id, {"type": "done", "progress": 100, "context": context})
        else:
            job["status"] = "done"
            job["progress"] = 100
            await job_log_async(job, ws_clients, "Không tìm thấy ảnh snapshot để phân tích.", "warn")
            await notify_ws(ws_clients, job_id, {"type": "done", "progress": 100})

    except Exception as e:
        logger.exception("context job %s: FAILED", job_id)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Lỗi sinh ngữ cảnh: {e}", "error")


async def worker_loop(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, "BaseOCREngine"],
    queue: asyncio.Queue,
):
    logger.info("Worker loop started")
    while True:
        job_id = await queue.get()
        job = jobs.get(job_id)
        try:
            if job:
                job_type = job.get("job_type", "ocr")
                if job_type == "hardcode":
                    await run_hardcode_job(jobs, ws_clients, job_id)
                elif job_type == "align":
                    await run_align_job(jobs, ws_clients, job_id)
                elif job_type == "translate":
                    await run_translate_job(jobs, ws_clients, job_id)
                elif job_type == "tts":
                    await run_tts_job(jobs, ws_clients, job_id)
                elif job_type == "dub":
                    await run_dub_job(jobs, ws_clients, job_id)
                elif job_type == "export":
                    await run_export_job(jobs, ws_clients, job_id)
                elif job_type == "context":
                    await run_context_job(jobs, ws_clients, job_id)
                elif job_type == "risk_check":
                    await run_risk_check_job(jobs, ws_clients, job_id)
                else:
                    await run_job(jobs, ws_clients, ocr_engines, job_id)
        except Exception as e:
            logger.exception("Unhandled worker error for job %s: %s", job_id, e)
        finally:
            queue.task_done()
