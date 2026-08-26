import uuid
import time
import asyncio
import logging
import threading
import functools
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from app.config import settings
from app.services.video_processor import stream_frames_generator, crop_region, resolve_video_path
from app.services.ocr_engine import BaseOCREngine
from app.services.subtitle_generator import (
    generate_srt_entries,
    merge_parallel_entries,
    format_srt,
    sec_to_srt,
)
from app.services.hardcode_service import run_hardcode_sync
from app.services.align_service import run_align_sync
from app.services.job_utils import JobCancelled, notify_ws_sync

from datetime import datetime


async def _tg_notify(text: str):
    """Send Telegram notification to all connected chats (fire-and-forget)."""
    try:
        from app.services.telegram_service import telegram_service
        if telegram_service.has_connected_chats():
            await telegram_service.broadcast(text)
    except Exception:
        pass


async def _tg_notify_video(video_path, caption: str) -> bool:
    """Try to send the video file itself so it plays inline in Telegram chat.

    Returns True if at least one chat received it."""
    try:
        from app.services.telegram_service import telegram_service
        if telegram_service.has_connected_chats():
            return await telegram_service.broadcast_video(str(video_path), caption)
    except Exception:
        pass
    return False
from app.services.media_utils import _srt_path, _srt_best_path, _duration_covers, _get_duration, _video_path

logger = logging.getLogger(__name__)


_executor = ThreadPoolExecutor(max_workers=max(1, settings.job_workers))
_context_executor = ThreadPoolExecutor(max_workers=1)


def enqueue_job(
    jobs: dict,
    video_path: str,
    video_id: str,
    region: dict,
    fps: int | None = None,
    lang: str = "ch",
    ocr_type: str = "apple",
    start_time: float | None = None,
    end_time: float | None = None,
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
        "start_time": start_time,
        "end_time": end_time,
        "job_type": "ocr",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "srt_path": None,
    }
    jobs[job_id] = job
    logger.info("job %s: queued (lang=%s, ocr=%s, start=%s, end=%s)  |  %s", job_id, lang, ocr_type, start_time, end_time, video_path)
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


def _tg_notify_sync(loop: asyncio.AbstractEventLoop, chat_id, text: str):
    """Send a Telegram message from a worker thread (thread-safe bridge)."""
    try:
        from app.services.telegram_service import telegram_service

        async def _send():
            await telegram_service.send_message(chat_id, text)

        asyncio.run_coroutine_threadsafe(_send(), loop)
    except Exception:
        pass


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


def _ocr_segment_entries(
    video_path: str,
    region: dict,
    target_fps: int,
    engine: BaseOCREngine,
    lang: str,
    start_time: float,
    end_time: float,
    progress_cb,
) -> list[tuple[float, float, str]]:
    """OCR a single time segment and return its (start, end, text) entries."""
    crops = (
        (crop_region(frame, region), ts)
        for frame, ts in stream_frames_generator(
            video_path, target_fps, start_time=start_time, end_time=end_time
        )
    )
    # Mỗi segment dùng đúng 1 engine riêng (dHash cache + language độc lập),
    # nên không cần khoá chung. Vẫn giữ lock cho an toàn nếu engine bị chia sẻ.
    with engine.lock():
        engine.set_lang(lang)
        return generate_srt_entries(
            crops, engine,
            progress_callback=progress_cb,
            total_frames=None,
        )


def process_job_sync(
    video_path: str,
    region: dict,
    target_fps: int,
    engine_pool: list,
    ws_clients: dict,
    job_id: str,
    loop: asyncio.AbstractEventLoop,
    job: dict,
    lang: str,
    start_time: float | None = None,
    end_time: float | None = None,
):
    logger.info("job %s: extracting frames... (start=%s, end=%s)", job_id, start_time, end_time)
    t0 = time.time()

    import cv2

    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if cap.isOpened() else 0
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.release()

    # Adjust total frames if start_time or end_time specified
    if start_time and start_time > 0:
        skipped = int(start_time * video_fps)
        total_frames = max(0, total_frames - skipped)
    if end_time and end_time > 0:
        end_frame = int(end_time * video_fps)
        total_frames = min(total_frames, end_frame)

    # Đếm khớp với stream_frames_generator (step = round(video_fps / target_fps))
    # để progress bar không bị lệch do khác công thức round vs floor.
    if target_fps and target_fps > 0:
        step = max(1, int(round(video_fps / target_fps)))
        total_crops = max(1, (total_frames + step - 1) // step)
    else:
        total_crops = total_frames

    duration = total_frames / video_fps if video_fps > 0 else 0.0
    eff_start = start_time if (start_time and start_time > 0) else 0.0
    eff_end = end_time if (end_time and end_time > 0) else duration

    if start_time and start_time > 0:
        job_log(job, ws_clients, loop, f"Bắt đầu OCR từ giây {start_time:.1f}…")
    job_log(job, ws_clients, loop, "Đang đọc từng khung hình của video…")

    job["progress"] = 0

    parts = max(1, len(engine_pool))
    overlap = settings.ocr_parallel_overlap if parts > 1 else 0.0

    # ── Sequential (parts == 1) ────────────────────────────────────────────
    if parts <= 1 or (eff_end - eff_start) <= overlap * 2 + 1e-6:
        last_pct_log = 0
        tg_chat_id = job.get("chat_id")

        def progress_cb(idx: int, total: int):
            nonlocal last_pct_log
            if job.get("cancelled"):
                raise JobCancelled()
            if total_crops:
                pct = min(100, int((idx + 1) / total_crops * 100))
            else:
                pct = 100
            job["progress"] = pct
            if pct >= last_pct_log + 10:
                last_pct_log = pct
                job_log(
                    job, ws_clients, loop,
                    f"Đã nhận dạng được khoảng {pct}% của video…",
                    "info",
                )
                if tg_chat_id:
                    _tg_notify_sync(loop, tg_chat_id, f"🔍 OCR: {pct}%")
            _notify_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "ocr",
            })

        job_log(job, ws_clients, loop, "Bắt đầu nhận dạng chữ viết trong video…")
        logger.info("job %s: running OCR (sequential)...", job_id)

        entries = _ocr_segment_entries(
            video_path, region, target_fps, engine_pool[0], lang,
            eff_start, eff_end, progress_cb,
        )

        job["progress"] = 100
        _notify_sync(loop, ws_clients, job_id, {
            "type": "progress", "progress": 100, "phase": "ocr",
        })
    # ── Parallel (parts > 1) ───────────────────────────────────────────────
    else:
        job_log(
            job, ws_clients, loop,
            f"Chia video thành {parts} đoạn và nhận dạng song song…",
        )
        logger.info("job %s: running OCR on %d parallel segments", job_id, parts)

        seg_len = (eff_end - eff_start) / parts
        bounds = []
        for i in range(parts):
            s = eff_start + i * seg_len
            e = eff_start + (i + 1) * seg_len
            if i < parts - 1:
                e += overlap
            if i > 0:
                s -= overlap
            bounds.append((max(eff_start, s), min(eff_end, e)))

        progress_lock = threading.Lock()
        state = {"done": 0, "last_pct": 0, "last_log": 0}
        tg_chat_id = job.get("chat_id")

        def make_progress_cb():
            def cb(idx: int, total: int):
                if job.get("cancelled"):
                    raise JobCancelled()
                with progress_lock:
                    state["done"] += 1
                    pct = (
                        min(100, int(state["done"] / total_crops * 100))
                        if total_crops else 100
                    )
                    state["last_pct"] = pct
                    if pct >= state["last_log"] + 10:
                        state["last_log"] = pct
                        do_log = True
                    else:
                        do_log = False
                job["progress"] = pct
                if do_log:
                    job_log(
                        job, ws_clients, loop,
                        f"Đã nhận dạng được khoảng {pct}% của video…",
                        "info",
                    )
                    if tg_chat_id:
                        _tg_notify_sync(loop, tg_chat_id, f"🔍 OCR: {pct}%")
                _notify_sync(loop, ws_clients, job_id, {
                    "type": "progress", "progress": pct, "phase": "ocr",
                })
            return cb

        with ThreadPoolExecutor(max_workers=parts) as ex:
            futures = [
                ex.submit(
                    _ocr_segment_entries,
                    video_path, region, target_fps, engine_pool[i], lang,
                    s, e, make_progress_cb(),
                )
                for i, (s, e) in enumerate(bounds)
            ]
            segment_results = []
            for fut in as_completed(futures):
                segment_results.append(fut.result())  # propagate exceptions

        entries = merge_parallel_entries(segment_results)

        job["progress"] = 100
        _notify_sync(loop, ws_clients, job_id, {
            "type": "progress", "progress": 100, "phase": "ocr",
        })

    # Log extracted content (ordered, deduped) then format.
    for start, end, text in entries:
        job_log(
            job, ws_clients, loop,
            f"[{sec_to_srt(start)} → {sec_to_srt(end)}] {text}",
            "text",
        )

    srt_content = format_srt(entries)
    t2 = time.time()
    logger.info("job %s: OCR done in %.1fs", job_id, t2 - t0)
    return srt_content


async def run_job(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, list],
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
        if not ocr_engine:
            raise RuntimeError(
                f"OCR engine '{ocr_type}' không khả dụng trên máy chủ này"
            )
        await job_log_async(
            job, ws_clients,
            f"Đang xử lý bằng {ocr_engine[0].name} (ngôn ngữ: {lang})",
            "info",
        )

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            process_job_sync,
            video_path, region, target_fps,
            ocr_engine, ws_clients, job_id, loop, job,
            lang, job.get("start_time"), job.get("end_time"),
        )

        logger.info("job %s: processing started  |  %s", job_id, video_path)
        t_start = time.time()

        srt_content = await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

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

        # Telegram notification
        elapsed = time.time() - t_start
        mins, secs = divmod(int(elapsed), 60)
        now_str = datetime.now().strftime("%H:%M:%S")
        await _tg_notify(
            f"✅ <b>OCR hoàn tất!</b>\n"
            f"🎬 {video_id}\n"
            f"📄 {line_count} dòng phụ đề\n"
            f"⏱ {mins}m {secs}s\n"
            f"🕐 {now_str}"
        )

        # Fire-and-forget: auto-generate context (runs after "done" notification)
        from app.services.context_service import generate_video_context
        from app.routers.config_router import _read_config
        cfg = _read_config()
        if cfg.get("auto_context_enabled", True):
            target_lang = job.get("target_lang", "vi")
            asyncio.create_task(_auto_context(video_id, generate_video_context, loop, target_lang))
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
        srt_path = str(_srt_best_path(video_id))

        out_dir = settings.temp_dir / "hardcoded" / video_id
        out_dir.mkdir(parents=True, exist_ok=True)
        final_path = out_dir / f"{Path(video_path).stem}_hardcoded.mp4"
        # Burn into a .partial file, then rename on success: a crashed/killed
        # burn (OOM, machine sleep, …) then never leaves a half-encoded file at
        # the final path that later runs would mistake for a completed encode.
        partial_path = out_dir / f"{Path(video_path).stem}_hardcoded.partial.mp4"
        partial_path.unlink(missing_ok=True)
        partial_path.with_suffix(".ass").unlink(missing_ok=True)

        if (
            not job.get("watermark")
            and final_path.exists()
            and final_path.stat().st_size > 0
            and _duration_covers(video_path, str(final_path))
        ):
            job["status"] = "done"
            job["progress"] = 100
            job["output_path"] = str(final_path)
            size_mb = final_path.stat().st_size / (1024 * 1024)
            await job_log_async(
                job, ws_clients,
                f"Video đã có phụ đề cứng từ lần chạy trước ({size_mb:.1f} MB) — bỏ qua encode.",
                "success",
            )
            await notify_ws(ws_clients, job_id, {
                "type": "done", "video_id": video_id, "filename": final_path.name,
            })
            return

        # Partial / damaged previous output → discard and re-encode.
        if final_path.exists():
            src_dur = _get_duration(video_path)
            out_dur = _get_duration(str(final_path))
            logger.warning(
                "hardcode job %s: discarding incomplete previous output (src=%.1fs out=%.1fs)",
                job_id, src_dur, out_dur,
            )
            await job_log_async(
                job, ws_clients,
                f"File phụ đề cứng cũ bị dở dang ({out_dur:.0f}s / {src_dur:.0f}s) — sẽ encode lại đầy đủ.",
                "warn",
            )
            final_path.unlink(missing_ok=True)

        loop = asyncio.get_event_loop()

        fn = functools.partial(
            run_hardcode_sync,
            video_path, srt_path, str(partial_path),
            job, ws_clients, loop, job_id,
        )

        await asyncio.wait_for(
            loop.run_in_executor(_executor, fn),
            timeout=None if settings.job_timeout <= 0 else settings.job_timeout,
        )

        # Success → atomically publish the final file.
        if not (partial_path.exists() and partial_path.stat().st_size > 0):
            raise RuntimeError("Hardcode finished without producing an output file")
        final_path.unlink(missing_ok=True)
        partial_path.rename(final_path)
        partial_path.with_suffix(".ass").unlink(missing_ok=True)

        job["status"] = "done"
        job["progress"] = 100
        job["output_path"] = str(final_path)

        size_mb = final_path.stat().st_size / (1024 * 1024)
        await job_log_async(
            job, ws_clients,
            f"Hoàn tất! Video đã được gắn phụ đề cứng ({size_mb:.1f} MB).",
            "success",
        )
        await notify_ws(ws_clients, job_id, {
            "type": "done", "video_id": video_id, "filename": final_path.name,
        })

        # Telegram notification — gửi kèm video để xem ngay trong chat.
        now_str = datetime.now().strftime("%H:%M:%S")
        caption = (
            f"✅ <b>Video đã xử lý xong!</b>\n"
            f"🎬 {final_path.name}\n"
            f"📦 {size_mb:.1f} MB\n"
            f"🕐 {now_str}"
        )
        sent_inline = await _tg_notify_video(final_path, caption)
        if not sent_inline:
            # File quá lớn (>49MB) hoặc upload lỗi → gửi link xem/tải thay thế.
            if settings.public_url:
                base = settings.public_url.rstrip("/")
                caption += f'\n▶️ <a href="{base}/api/preview/hardcoded/{video_id}">Xem video</a>'
                caption += f'\n⬇️ <a href="{base}/api/download/hardcoded/{video_id}">Tải video</a>'
            await _tg_notify(caption)

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

        now_str = datetime.now().strftime("%H:%M:%S")
        await _tg_notify(f"✅ <b>Căn chỉnh phụ đề xong!</b>\n🎬 {job.get('video_id', job_id)}\n🕐 {now_str}")

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

        # run_translate_sync tự set status done/error + gửi WS. Chỉ thêm log
        # success + Telegram khi thực sự done (tránh ghi đè status=error).
        if job.get("status") == "done":
            await job_log_async(job, ws_clients, "Dịch hoàn tất! File SRT tiếng Việt đã sẵn sàng.", "success")
            now_str = datetime.now().strftime("%H:%M:%S")
            await _tg_notify(f"✅ <b>Dịch phụ đề xong!</b>\n🎬 {job['video_id']}\n🕐 {now_str}")

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

        now_str = datetime.now().strftime("%H:%M:%S")
        await _tg_notify(f"✅ <b>TTS hoàn tất!</b>\n🎬 {job.get('video_id', job_id)}\n🕐 {now_str}")

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

        now_str = datetime.now().strftime("%H:%M:%S")
        await _tg_notify(f"✅ <b>Lồng tiếng hoàn tất!</b>\n🎬 {job.get('video_id', job_id)}\n🕐 {now_str}")

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


async def run_bulk_switch_job(
    jobs: dict,
    ws_clients: dict,
    job_id: str,
):
    """Bulk switch voice for all lines using from_voice → to_voice, then regenerate TTS."""
    job = jobs.get(job_id)
    if not job:
        return

    video_id = job["video_id"]
    from_voice = job["from_voice"]
    to_voice = job["to_voice"]

    try:
        from app.services.translation_service import _voice_map_path, load_voice_map
        from app.services.capcut_tts_client import generate_segments_to_dir
        from app.services.srt_utils import parse_srt
        import json as _json

        job["status"] = "processing"
        job["phase"] = "bulk_switch"
        await job_log_async(job, ws_clients, f"Chuyển giọng {from_voice} → {to_voice}…")
        await notify_ws(ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "bulk_switch"})

        # 1. Update voice_map.json
        p = _voice_map_path(video_id)
        if not p.exists():
            raise ValueError("voice_map.json not found")

        data = _json.loads(p.read_text(encoding="utf-8"))
        changed = 0
        affected_indices = []
        for idx, vt in list(data.items()):
            if vt == from_voice:
                data[idx] = to_voice
                changed += 1
                affected_indices.append(int(idx))

        if changed == 0:
            await job_log_async(job, ws_clients, f"Không dòng nào dùng giọng {from_voice}.")
            job["status"] = "done"
            job["progress"] = 100
            return

        p.write_text(_json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        await job_log_async(job, ws_clients, f"Đã cập nhật voice_map: {changed} dòng.")
        await notify_ws(ws_clients, job_id, {"type": "progress", "progress": 20, "phase": "bulk_switch"})

        # 2. Regenerate TTS for each affected line
        srt_path = _srt_path(video_id)
        entries = parse_srt(srt_path.read_text(encoding="utf-8")) if srt_path.exists() else []
        voice_key = to_voice.replace("-", "_")
        out_dir = settings.temp_dir / "tts" / video_id / voice_key
        out_dir.mkdir(parents=True, exist_ok=True)

        loop = asyncio.get_event_loop()
        total = len(affected_indices)
        for i, idx in enumerate(affected_indices):
            if idx < 1 or idx > len(entries):
                continue
            text = entries[idx - 1].text.strip()
            if not text:
                continue
            await job_log_async(job, ws_clients, f"Gen TTS dòng #{idx}…")
            try:
                await loop.run_in_executor(
                    _executor,
                    functools.partial(
                        generate_segments_to_dir,
                        [text], out_dir, to_voice, "1.0", "", None, None, [idx],
                    ),
                )
            except Exception as e:
                await job_log_async(job, ws_clients, f"Lỗi gen TTS dòng #{idx}: {e}", "warn")
            progress = 20 + int(80 * (i + 1) / total)
            await notify_ws(ws_clients, job_id, {"type": "progress", "progress": progress, "phase": "bulk_switch"})

        job["status"] = "done"
        job["progress"] = 100
        await job_log_async(job, ws_clients, f"Chuyển giọng xong: {changed} dòng đã đổi + TTS đã tạo lại.", "success")

    except JobCancelled:
        logger.info("bulk_switch job %s: cancelled", job_id)
        job["status"] = "cancelled"
        await job_log_async(job, ws_clients, "Đã hủy.", "warn")
        await notify_ws(ws_clients, job_id, {"type": "cancelled"})
    except Exception as e:
        logger.exception("bulk_switch job %s: FAILED  |  %s", job_id, e)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Lỗi: {e}", "error")
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

        # Telegram notification
        now_str = datetime.now().strftime("%H:%M:%S")
        await _tg_notify(
            f"✅ <b>Video đã xuất xong!</b>\n"
            f"🎬 {job.get('video_id', job_id)}\n"
            f"🕐 {now_str}"
        )

    except JobCancelled:
        job["status"] = "cancelled"
        await job_log_async(job, ws_clients, "Đã huỷ xuất video.", "warn")
    except Exception as e:
        logger.exception("export job %s: FAILED", job_id)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Lỗi xuất: {e}", "error")


async def _auto_context(video_id: str, generate_fn, loop, target_lang: str = "vi"):
    """Fire-and-forget context generation after OCR completes.

    Runs on a dedicated executor so it never blocks the main job queue.
    """
    try:
        await loop.run_in_executor(_context_executor, generate_fn, video_id, target_lang)
        logger.info("Auto context generated for %s", video_id)
    except Exception:
        logger.warning("Auto context generation failed (non-critical)", exc_info=True)


# ── Telegram Auto Pipeline ────────────────────────────────────────────────

_tg_checkpoint_events: dict[str, asyncio.Event] = {}  # video_id → event
_tg_checkpoint_data: dict[str, dict] = {}              # video_id → user response

_LANG_TO_OCR = {"zh": "ch", "en": "en", "vi": "latin"}


def tg_resolve_checkpoint(video_id: str, data: dict):
    """Resolve a pending checkpoint — called from the TelegramBot callback handler."""
    _tg_checkpoint_data[video_id] = data
    event = _tg_checkpoint_events.get(video_id)
    if event:
        event.set()
    # Skip checkpoints (region/style) use a compound key "{video_id}:skip_*".
    action = data.get("action", "")
    if isinstance(action, str) and action.startswith("skip_"):
        key = f"{video_id}:{action}"
        _tg_checkpoint_data[key] = data
        ev = _tg_checkpoint_events.get(key)
        if ev:
            ev.set()


async def _tg_send(chat_id: int, text: str):
    try:
        from app.services.telegram_service import telegram_service
        await telegram_service.send_message(chat_id, text)
    except Exception:
        pass


async def _tg_send_keyboard(chat_id: int, text: str, keyboard: list[list[dict]]) -> int | None:
    try:
        from app.services.telegram_service import telegram_service
        return await telegram_service.send_message_with_keyboard(chat_id, text, keyboard)
    except Exception:
        return None


async def _tg_send_web_app(chat_id: int, text: str, web_app_url: str, button_text: str):
    """Send a Telegram Mini App button to a specific chat."""
    try:
        from app.services.telegram_service import telegram_service
        await telegram_service.send_web_app_button(chat_id, text, web_app_url, button_text)
    except Exception:
        pass


async def _tg_send_web_app_with_skip(
    chat_id: int, text: str, web_app_url: str, button_text: str, skip_data: str,
) -> None:
    """Send a Mini App button + a 'Bỏ qua' button (checkpoint) in one message."""
    try:
        from app.services.telegram_service import telegram_service
        keyboard = [
            [{"text": button_text, "web_app": {"url": web_app_url}}],
            [{"text": "⏭️ Bỏ qua (dùng mặc định)", "callback_data": skip_data}],
        ]
        await telegram_service.send_message_with_keyboard(chat_id, text, keyboard)
    except Exception:
        pass


def _annotation_path(video_id: str) -> Path:
    return settings.temp_dir / "videos" / video_id / "meta.json"


def _read_annotation_meta(video_id: str) -> dict:
    p = _annotation_path(video_id)
    if not p.exists():
        return {}
    try:
        import json as _json
        return _json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


async def _tg_wait_annotation(video_id: str, field: str, timeout: float = 900) -> dict | None:
    """Poll meta.json until `field` (region/style) is set by the Mini App.

    Returns the saved value dict, or None on timeout.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        meta = await asyncio.get_event_loop().run_in_executor(None, _read_annotation_meta, video_id)
        val = meta.get(field)
        if val:
            return val
        if asyncio.get_event_loop().time() >= deadline:
            return None
        await asyncio.sleep(2)


async def _tg_wait_annotation_or_skip(
    video_id: str, field: str, skip_key: str, timeout: float = 300,
) -> tuple[dict | None, bool]:
    """Poll meta.json for `field`; return early if user taps the skip checkpoint.

    Returns ``(value, skipped)`` — value is None on timeout; skipped=True when
    the user chose to bypass this step.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        meta = await asyncio.get_event_loop().run_in_executor(None, _read_annotation_meta, video_id)
        val = meta.get(field)
        if val:
            return val, False
        # Check skip checkpoint (non-blocking). Any data under the skip key
        # means the user tapped the skip button (action = "skip_region"/"skip_style").
        data = _tg_checkpoint_data.get(skip_key)
        if data:
            _tg_checkpoint_data.pop(skip_key, None)
            _tg_checkpoint_events.pop(skip_key, None)
            return None, True
        if asyncio.get_event_loop().time() >= deadline:
            return None, False
        await asyncio.sleep(2)


async def _tg_web_app_video_url(video_id: str) -> str:
    """Build the public video URL the Mini App needs to preview the frame."""
    base = (settings.public_url or "http://localhost:8000").rstrip("/")
    return f"{base}/api/video/{video_id}/video.mp4?duration=10"


async def _tg_next_step(chat_id: int):
    """Notify the user that the pipeline is moving to the next step."""
    await _tg_send(chat_id, "▶️ Đang thực hiện bước tiếp theo...")


async def _tg_wait_pipeline_decision(
    pipeline_states: dict, video_id: str, check_key: str, skip_key: str, timeout: float = 600,
) -> str | None:
    """Poll pipeline_states for a decision from the Mini App (timeline/voice check).

    ``check_key`` = "timeline_check" | "voice_check". Returns the decision
    ("continue"/"fix") or "skip" if the user tapped the Telegram skip button,
    or None on timeout.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        ps = pipeline_states.get(video_id) or {}
        check = ps.get(check_key) or {}
        decision = check.get("decision")
        if decision:
            return decision
        # Skip button (Telegram fallback). Any data under the skip key means skip.
        data = _tg_checkpoint_data.get(skip_key)
        if data:
            _tg_checkpoint_data.pop(skip_key, None)
            _tg_checkpoint_events.pop(skip_key, None)
            return "skip"
        if asyncio.get_event_loop().time() >= deadline:
            return None
        await asyncio.sleep(2)


def _init_pipeline_wait(pipeline_states: dict, video_id: str, check_key: str, issues: list | None = None):
    """Mark a review step as waiting so the Mini App / other tabs see the popup."""
    ps = pipeline_states.get(video_id) or {}
    entry = {"waiting": True, "open": False, "decision": None}
    if issues is not None:
        entry["issues"] = issues
    ps[check_key] = entry
    pipeline_states[video_id] = ps


async def _tg_wait_checkpoint(video_id: str, timeout: float = 1800) -> dict:
    """Wait for a user response at a checkpoint. Returns response dict or empty on timeout."""
    event = asyncio.Event()
    _tg_checkpoint_events[video_id] = event
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        return _tg_checkpoint_data.pop(video_id, {})
    except asyncio.TimeoutError:
        return {"action": "timeout"}
    finally:
        _tg_checkpoint_events.pop(video_id, None)
        _tg_checkpoint_data.pop(video_id, None)


def _srt_preview(srt_content: str, max_lines: int = 8) -> str:
    """Short preview of SRT content for Telegram display."""
    preview = []
    count = 0
    for line in srt_content.strip().split("\n"):
        if "-->" in line:
            count += 1
            if count > max_lines:
                remaining = srt_content.count("-->") - max_lines
                preview.append(f"\n… và {remaining} dòng nữa")
                break
        preview.append(line)
    return "\n".join(preview) if preview else "Không có phụ đề"


async def run_telegram_auto_job(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, list],
    job_id: str,
    pipeline_states: dict,
):
    """Run the full Douyin pipeline for a Telegram /douyin command.

    Steps: resolve → OCR → (context) → translate → dub → hardcode → (thumbnail)
    → (youtube) → done, with Telegram checkpoints at the interactive steps.
    """
    job = jobs.get(job_id)
    if not job:
        return

    chat_id = job.get("chat_id", 0)
    video_id = None
    loop = asyncio.get_event_loop()

    try:
        job["status"] = "processing"
        job["phase"] = "resolving"

        # ── Step 1: Resolve Douyin link (same flow as FE: resolve → merge → import) ──
        job["phase"] = "resolving"
        await _tg_send(chat_id, "📥 Đang phân tích link Douyin...")

        # 1a. Resolve via frontend Chrome resolver → video_url + audio_url + thumbnail + big_thumbs
        from app.routers.video_download import douyin_resolve, DouyinResolveRequest, _sanitize_filename
        from app.routers.video_merge import (
            merge_video_audio, import_video, MergeRequest, ImportRequest, get_merge_status,
        )

        rd = await douyin_resolve(DouyinResolveRequest(url=job["url"]))
        video_url = rd.get("video_url")
        audio_url = rd.get("audio_url")
        title = rd.get("title") or ""
        thumbnail = rd.get("thumbnail")
        big_thumbs = rd.get("bigThumbs") or []

        original_name = _sanitize_filename(title) or "video"
        imp_name = f"{original_name}.mp4"

        # 1b. Merge (nếu có 2 file video + audio riêng), rồi import.
        if audio_url and video_url:
            job["phase"] = "merging"
            await _tg_send(chat_id, "⬇️ Đang tải video + audio và gộp...")
            merge_result = merge_video_audio(MergeRequest(
                video_url=video_url,
                audio_url=audio_url,
                thumbnail_url=thumbnail or "",
                big_thumbs=big_thumbs,
            ))
            merge_id = merge_result["job_id"]

            # Poll merge status until done (mirrors FE pollMerge).
            for _ in range(360):
                ms = await get_merge_status(merge_id)
                if ms.get("status") == "done":
                    break
                if ms.get("status") == "error":
                    raise RuntimeError(ms.get("error") or "Merge thất bại")
                await asyncio.sleep(2)
            else:
                raise RuntimeError("Merge quá thời gian chờ")
            await _tg_send(chat_id, "✅ Đã tải và gộp video + audio xong.")

            imp_result = await loop.run_in_executor(
                _executor, import_video, ImportRequest(merge_id=merge_id, filename=imp_name)
            )
        else:
            # Chỉ 1 file video (đã có audio) → import trực tiếp theo URL.
            job["phase"] = "merging"
            await _tg_send(chat_id, "⬇️ Đang tải video...")
            imp_result = await loop.run_in_executor(
                _executor, import_video, ImportRequest(
                    url=video_url,
                    filename=imp_name,
                    thumbnail_url=thumbnail or "",
                    big_thumbs=big_thumbs,
                )
            )

        video_id = imp_result["video_id"]
        job["video_id"] = video_id
        video_path = str(_video_path(video_id))
        job["video_path"] = video_path

        # Lưu share text (ngữ cảnh gốc) — giống FE gửi /api/context/{id}/share-text.
        try:
            from app.services.context_service import save_share_text
            save_share_text(video_id, job["url"])
        except Exception:
            pass

        await _tg_send(chat_id, f"✅ Đã tải: {title[:60] or video_id}")

        # ── Step 1.5: Manual region + subtitle position (via Mini App) ──
        region = {"x1": 0.114, "y1": 0.748, "x2": 0.863, "y2": 0.972}  # DEFAULT_REGION
        selected_style = None

        if job.get("region_mode") == "manual":
            job["phase"] = "region"
            web_app_base = settings.annotation_web_app_url.rstrip("/")
            video_url = await _tg_web_app_video_url(video_id)

            # 1) Chọn vùng OCR (mode=ocr) — có nút Bỏ qua.
            await _tg_send(chat_id, "📐 <b>Chọn vùng quét phụ đề</b> — bấm Mini App, hoặc Bỏ qua để dùng vùng mặc định.")
            await _tg_send_web_app_with_skip(
                chat_id,
                f"📐 <b>Chọn vùng OCR</b>\nVideo: <code>{video_id}</code>",
                f"{web_app_base}/?url={video_url}&videoid={video_id}&mode=ocr",
                "📐 Chọn vùng quét sub",
                f"tgcp:{video_id}:skip_region",
            )
            chosen_region, skipped = await _tg_wait_annotation_or_skip(video_id, "region", f"{video_id}:skip_region")
            if chosen_region and all(k in chosen_region for k in ("x1", "y1", "x2", "y2")):
                region = {
                    "x1": float(chosen_region["x1"]),
                    "y1": float(chosen_region["y1"]),
                    "x2": float(chosen_region["x2"]),
                    "y2": float(chosen_region["y2"]),
                }
                await _tg_send(chat_id, f"✅ Đã chọn vùng: x {region['x1']:.2f}–{region['x2']:.2f} · y {region['y1']:.2f}–{region['y2']:.2f}")
                await _tg_next_step(chat_id)
            elif skipped:
                await _tg_send(chat_id, "⏭️ Bỏ qua — dùng vùng mặc định.")
                await _tg_next_step(chat_id)
            else:
                await _tg_send(chat_id, "⚠️ Không nhận được vùng — dùng vùng mặc định.")
                await _tg_next_step(chat_id)

            # 2) Chọn vị trí hiển thị sub (mode=subtitle) — có nút Bỏ qua.
            await _tg_send(chat_id, "🎨 <b>Chọn vị trí hiển thị phụ đề</b> — bấm Mini App, hoặc Bỏ qua để tự căn.")
            await _tg_send_web_app_with_skip(
                chat_id,
                f"🎨 <b>Chọn vị trí phụ đề</b>\nVideo: <code>{video_id}</code>",
                f"{web_app_base}/?url={video_url}&videoid={video_id}&mode=subtitle",
                "🎨 Chọn vị trí sub",
                f"tgcp:{video_id}:skip_style",
            )
            style_val, skipped_style = await _tg_wait_annotation_or_skip(video_id, "style", f"{video_id}:skip_style")
            if isinstance(style_val, dict) and style_val:
                selected_style = style_val
                await _tg_send(chat_id, "✅ Đã chọn vị trí phụ đề.")
                await _tg_next_step(chat_id)
            elif skipped_style:
                await _tg_send(chat_id, "⏭️ Bỏ qua — tự căn vị trí phụ đề.")
                await _tg_next_step(chat_id)

        # ── Step 2: OCR ──
        job["phase"] = "processing"
        await _tg_send(chat_id, "🔍 Đang nhận dạng phụ đề (OCR)...")

        ocr_lang = _LANG_TO_OCR.get(job.get("src_lang", "zh"), "ch")
        ocr_type = "apple" if "apple" in ocr_engines else "rapid"
        engine_pool = ocr_engines.get(ocr_type)
        if not engine_pool:
            raise RuntimeError(f"OCR engine '{ocr_type}' không khả dụng")

        # Create an OCR sub-job and run it via the existing runner.
        ocr_job_id = uuid.uuid4().hex[:12]
        ocr_job = {
            "job_id": ocr_job_id,
            "video_path": video_path,
            "video_id": video_id,
            "region": region,
            "fps": settings.extract_fps or None,
            "lang": ocr_lang,
            "ocr_type": ocr_type,
            "job_type": "ocr",
            "status": "queued",
            "phase": "",
            "progress": 0,
            "error": None,
            "chat_id": chat_id,
        }
        jobs[ocr_job_id] = ocr_job
        await run_job(jobs, ws_clients, ocr_engines, ocr_job_id)
        if ocr_job.get("status") != "done":
            raise RuntimeError(f"OCR thất bại: {ocr_job.get('error', 'unknown')}")

        srt_content = settings.temp_dir / "srt" / video_id / "subtitles.srt"
        srt_text = srt_content.read_text(encoding="utf-8")
        line_count = srt_text.count("-->")
        await _tg_send(chat_id, f"✅ OCR xong: {line_count} dòng phụ đề")

        # ── Step 4: Context (needed for translate/dub quality) ──
        if job.get("translate_on") or job.get("auto_dub"):
            job["phase"] = "context"
            await _tg_send(chat_id, "🧠 Đang phân tích ngữ cảnh video...")
            try:
                from app.services.context_service import generate_video_context
                context_text = await loop.run_in_executor(
                    _context_executor,
                    generate_video_context, video_id, job.get("translate_target", "vi"),
                )
                if context_text:
                    await _tg_send(chat_id, f"🧠 <b>Ngữ cảnh video:</b>\n{context_text}")
                else:
                    await _tg_send(chat_id, "⚠️ Không phân tích được ngữ cảnh (không quan trọng).")
            except Exception:
                await _tg_send(chat_id, "⚠️ Phân tích ngữ cảnh thất bại (không quan trọng).")

        # ── Step 5: Translate ──
        if job.get("translate_on"):
            job["phase"] = "translating"
            await _tg_send(chat_id, "🌐 Đang dịch phụ đề...")
            tr_job_id = uuid.uuid4().hex[:12]
            jobs[tr_job_id] = {
                "job_id": tr_job_id,
                "job_type": "translate",
                "video_id": video_id,
                "status": "queued",
                "source_lang": job.get("src_lang", "zh"),
                "target_lang": job.get("translate_target", "vi"),
                "multi_voice": job.get("multi_voice", False),
            }
            await run_translate_job(jobs, ws_clients, tr_job_id)
            if jobs[tr_job_id].get("status") == "done":
                await _tg_send(chat_id, "✅ Dịch xong!")
            else:
                await _tg_send(chat_id, f"⚠️ Dịch thất bại: {jobs[tr_job_id].get('error', 'unknown')}")

        # ── Step 5.5: Check subs (timeline review) via Mini App — chạy SAU khi dịch, ──
        # ── kiểm tra file SRT đã dịch (nếu có), fallback bản gốc. ──
        if job.get("check_subs"):
            job["phase"] = "timeline_check"
            await _tg_send(chat_id, "📝 Đang kiểm tra timeline phụ đề...")

            # Ưu tiên file đã dịch (translated/{id}/subtitles_{lang}.srt), fallback bản gốc.
            best_srt = _srt_best_path(video_id, job.get("translate_target", "vi"))
            best_srt_text = best_srt.read_text(encoding="utf-8")

            issues: list = []
            try:
                from app.services.srt_utils import parse_srt, validate_timeline
                issues = validate_timeline(parse_srt(best_srt_text))
            except Exception:
                issues = []

            _init_pipeline_wait(pipeline_states, video_id, "timeline_check", issues)

            web_app_base = settings.annotation_web_app_url.rstrip("/")
            video_url = await _tg_web_app_video_url(video_id)
            await _tg_send_web_app_with_skip(
                chat_id,
                "📝 <b>Kiểm tra phụ đề</b> — bấm Mini App để rà soát thời gian từng dòng, "
                "hoặc Bỏ qua để giữ nguyên.",
                f"{web_app_base}/?url={video_url}&videoid={video_id}&mode=timeline",
                "📝 Kiểm tra phụ đề",
                f"tgcp:{video_id}:skip_timeline",
            )
            if issues:
                await _tg_send(chat_id, f"⚠️ Phát hiện {len(issues)} lỗi timeline — chờ bạn duyệt.")

            decision = await _tg_wait_pipeline_decision(pipeline_states, video_id, "timeline_check", f"{video_id}:skip_timeline")
            if decision == "fix":
                await _tg_send(chat_id, "🔧 Đang tự sửa timeline phụ đề...")
                try:
                    from app.services.srt_utils import parse_srt, fix_timeline, entries_to_srt
                    fixed, _ = fix_timeline(parse_srt(best_srt_text))
                    best_srt.write_text(entries_to_srt(fixed), encoding="utf-8")
                    await _tg_send(chat_id, "✅ Đã sửa timeline phụ đề.")
                except Exception:
                    await _tg_send(chat_id, "⚠️ Sửa timeline thất bại — giữ nguyên.")
            elif decision == "skip":
                await _tg_send(chat_id, "⏭️ Bỏ qua kiểm tra phụ đề.")
                await _tg_next_step(chat_id)
            else:
                await _tg_send(chat_id, "✅ Đã xác nhận phụ đề.")
                await _tg_next_step(chat_id)

        # ── Step 6: Dub ──
        if job.get("dub_on") and job.get("auto_dub"):
            job["phase"] = "dub"
            await _tg_send(chat_id, "🎤 Đang lồng tiếng...")

            mute_original = job.get("original_voice", "mute") == "mute"
            multi_voice = job.get("multi_voice", False)
            dub_engine = job.get("dub_engine", "capcut")

            # Multi-voice (CapCut) requires voice_map.json before dubbing. The
            # translate step normally generates it, but if translation is off
            # we must generate it here (mirrors the /api/dub endpoint guard).
            if multi_voice and dub_engine == "capcut":
                from app.services.translation_service import load_voice_map, generate_voice_map
                from app.services.media_utils import _srt_path
                from app.services.srt_utils import parse_srt
                if not load_voice_map(video_id):
                    srt_p = _srt_path(video_id)
                    entries = parse_srt(srt_p.read_text(encoding="utf-8")) if srt_p.exists() else []
                    if entries:
                        await _tg_send(chat_id, "🎭 Đang tạo voice_map cho nhiều giọng...")
                        voice_map = await loop.run_in_executor(
                            _context_executor, generate_voice_map, video_id, entries, None
                        )
                        if not voice_map:
                            await _tg_send(chat_id, "⚠️ Không tạo được voice_map — lồng tiếng 1 giọng.")

            dub_job_id = uuid.uuid4().hex[:12]
            jobs[dub_job_id] = {
                "job_id": dub_job_id,
                "job_type": "dub",
                "video_id": video_id,
                "status": "queued",
                "tts_voice": job.get("dub_voice", "BV421_vivn_streaming"),
                "tts_engine": dub_engine,
                "mute_original": mute_original,
                "original_gain_db": job.get("original_gain_db", 0.0),
                "multi_voice": multi_voice,
            }
            await run_dub_job(jobs, ws_clients, dub_job_id)
            if jobs[dub_job_id].get("status") == "done":
                await _tg_send(chat_id, "✅ Lồng tiếng xong!")
            else:
                await _tg_send(chat_id, f"⚠️ Lồng tiếng thất bại: {jobs[dub_job_id].get('error', 'unknown')}")

            # Voice check — duyệt giọng đọc từng dòng qua Mini App (mode=voice)
            if job.get("check_voice"):
                job["phase"] = "voice_check"
                await _tg_send(chat_id, "🎧 Đang chuẩn bị kiểm tra giọng đọc...")

                _init_pipeline_wait(pipeline_states, video_id, "voice_check")

                web_app_base = settings.annotation_web_app_url.rstrip("/")
                video_url = await _tg_web_app_video_url(video_id)
                await _tg_send_web_app_with_skip(
                    chat_id,
                    "🎧 <b>Kiểm tra giọng đọc</b> — bấm Mini App để nghe và chỉnh giọng từng dòng, "
                    "hoặc Bỏ qua để giữ nguyên.",
                    f"{web_app_base}/?url={video_url}&videoid={video_id}&mode=voice",
                    "🎧 Kiểm tra giọng đọc",
                    f"tgcp:{video_id}:skip_voice",
                )

                decision = await _tg_wait_pipeline_decision(pipeline_states, video_id, "voice_check", f"{video_id}:skip_voice")
                if decision == "continue":
                    await _tg_send(chat_id, "✅ Đã xác nhận giọng đọc.")
                    await _tg_next_step(chat_id)
                elif decision == "skip":
                    await _tg_send(chat_id, "⏭️ Bỏ qua kiểm tra giọng đọc.")
                    await _tg_next_step(chat_id)
                else:
                    await _tg_send(chat_id, "⚠️ Không nhận được xác nhận — tiếp tục.")
                    await _tg_next_step(chat_id)

        # ── Step 7: Hardcode SRT into video ──
        job["phase"] = "muxing"
        await _tg_send(chat_id, "🎬 Đang nhúng phụ đề vào video...")
        hc_job_id = uuid.uuid4().hex[:12]
        jobs[hc_job_id] = {
            "job_id": hc_job_id,
            "job_type": "hardcode",
            "video_id": video_id,
            "video_path": video_path,
            "status": "queued",
            "watermark": job.get("watermark") == "preset",
            "watermark_preset": job.get("watermark_preset", ""),
            "auto_fit": job.get("auto_fit", True),
            "region": region,
            "style": selected_style,
        }
        await run_hardcode_job(jobs, ws_clients, hc_job_id)
        if jobs[hc_job_id].get("status") == "done":
            await _tg_send(chat_id, "✅ Video đã nhúng phụ đề!")
        else:
            await _tg_send(chat_id, f"⚠️ Nhúng phụ đề thất bại: {jobs[hc_job_id].get('error', 'unknown')}")

        # ── Done ──
        job["status"] = "done"
        job["progress"] = 100
        job["phase"] = "done"

        final_dir = settings.temp_dir / "hardcoded" / video_id
        mp4_files = list(final_dir.glob("*_hardcoded.mp4")) if final_dir.exists() else []

        base = (settings.public_url or "").rstrip("/")
        preview_link = f"{base}/api/preview/hardcoded/{video_id}" if base else ""
        download_link = f"{base}/api/download/hardcoded/{video_id}" if base else ""

        # Luôn gửi link xem video để user bấm mở (ưu tiên gửi file nếu nhỏ).
        if mp4_files:
            try:
                from app.services.telegram_service import telegram_service
                sent = await telegram_service.send_video(
                    chat_id, str(mp4_files[0]), f"✅ {result['title'][:50]}"
                )
            except Exception:
                sent = False
        else:
            sent = False

        done_text = "✅ <b>Hoàn tất!</b>\n\n"
        if preview_link:
            done_text += f"▶️ <a href='{preview_link}'>Xem video</a>"
        if download_link:
            done_text += f" · ⬇️ <a href='{download_link}'>Tải video</a>"

        if sent:
            # Đã gửi file video trực tiếp — vẫn kèm link để xem trên web nếu có.
            if preview_link:
                await _tg_send(chat_id, done_text)
        else:
            if preview_link:
                await _tg_send(chat_id, done_text)
            else:
                await _tg_send(chat_id, "✅ <b>Hoàn tất!</b> Video đã sẵn sàng.")

        logger.info("telegram_auto job %s: done", job_id)

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        logger.exception("telegram_auto job %s: FAILED | %s", job_id, e)
        await _tg_send(chat_id, f"❌ <b>Lỗi:</b> {str(e)[:200]}")


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
            job.get("lang", "vi"),
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
    """Generate video context from the Douyin context images (big thumbs)."""
    from app.services.context_service import generate_video_context, load_video_context

    job = jobs[job_id]
    video_id = job.get("video_id", job_id)
    target_lang = job.get("target_lang", "vi")

    try:
        job["status"] = "processing"
        job["phase"] = "context"
        await job_log_async(job, ws_clients, "Đang upload ảnh ngữ cảnh lên Gemini File Store...", "info")
        await notify_ws(ws_clients, job_id, {"type": "progress", "progress": 20, "phase": "context"})

        loop = asyncio.get_event_loop()
        context = await loop.run_in_executor(
            _executor,
            lambda: generate_video_context(video_id, target_lang=target_lang),
        )

        if context:
            job["status"] = "done"
            job["progress"] = 100
            await job_log_async(job, ws_clients, f"Đã sinh ngữ cảnh: {context[:150]}...", "text")
            await notify_ws(ws_clients, job_id, {"type": "done", "progress": 100, "context": context})
        else:
            job["status"] = "done"
            job["progress"] = 100
            await job_log_async(job, ws_clients, "Không tìm thấy ảnh ngữ cảnh để phân tích.", "warn")
            await notify_ws(ws_clients, job_id, {"type": "done", "progress": 100})

    except Exception as e:
        logger.exception("context job %s: FAILED", job_id)
        job["status"] = "error"
        job["error"] = str(e)
        await job_log_async(job, ws_clients, f"Lỗi sinh ngữ cảnh: {e}", "error")


async def worker_loop(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, list],
    queue: asyncio.Queue,
    pipeline_states: dict,
):
    logger.info("Worker loop started")
    while True:
        job_id = await queue.get()
        job = jobs.get(job_id)
        try:
            if job:
                job_type = job.get("job_type", "ocr")
                if job_type == "telegram_auto":
                    await run_telegram_auto_job(jobs, ws_clients, ocr_engines, job_id, pipeline_states)
                elif job_type == "hardcode":
                    await run_hardcode_job(jobs, ws_clients, job_id)
                elif job_type == "align":
                    await run_align_job(jobs, ws_clients, job_id)
                elif job_type == "translate":
                    await run_translate_job(jobs, ws_clients, job_id)
                elif job_type == "tts":
                    await run_tts_job(jobs, ws_clients, job_id)
                elif job_type == "dub":
                    await run_dub_job(jobs, ws_clients, job_id)
                elif job_type == "context":
                    await run_context_job(jobs, ws_clients, job_id)
                elif job_type == "risk_check":
                    await run_risk_check_job(jobs, ws_clients, job_id)
                elif job_type == "bulk_switch":
                    await run_bulk_switch_job(jobs, ws_clients, job_id)
                else:
                    await run_job(jobs, ws_clients, ocr_engines, job_id)
        except Exception as e:
            logger.exception("Unhandled worker error for job %s: %s", job_id, e)
        finally:
            queue.task_done()
