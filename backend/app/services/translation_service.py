import logging
import os
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services.tool_services import parse_srt, entries_to_srt, _srt_path, _video_path

logger = logging.getLogger(__name__)

CHINESE_TO_VIETNAMESE_PROMPT = """You are a professional translator specializing in Chinese historical drama subtitles. 

Translate the following Chinese SRT subtitles to natural, fluent Vietnamese. Follow these rules:
1. Read the FULL context of all subtitle lines first before translating
2. Use natural Vietnamese sentence structure, not word-for-word translation
3. Adapt cultural terms appropriately (e.g. "tướng quân" for 将军, "bệ hạ" for 陛下)
4. Keep the original SRT format: index, timestamps, and translated text
5. Keep each translated line roughly the same length as the original to fit subtitle timing
6. DO NOT add any explanation, notes, or markdown formatting
7. Output ONLY the translated SRT content in valid SRT format

Here is the SRT to translate:

"""


def _get_gemini_client():
    """Lazy-load Gemini client when needed."""
    try:
        from google import genai
    except ImportError:
        raise ImportError(
            "google-genai not installed. Run: pip install google-genai"
        )

    api_key = settings.gemini_api_key or os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise ValueError(
            "GEMINI_API_KEY not set. Set STE_GEMINI_API_KEY in .env or export GEMINI_API_KEY"
        )

    return genai.Client(api_key=api_key)


def translate_srt(video_id: str, source_lang: str = "zh", target_lang: str = "vi", use_custom_srt: bool = False) -> str:
    """Translate SRT file using Gemini and save as translated_vi.srt."""
    if use_custom_srt:
        custom_path = settings.temp_dir / "translated" / video_id / "input.srt"
        if not custom_path.exists():
            raise ValueError("Custom SRT input not found")
        content = custom_path.read_text(encoding="utf-8")
    else:
        srt_path = _srt_path(video_id)
        content = srt_path.read_text(encoding="utf-8")

    entries = parse_srt(content)
    if not entries:
        raise ValueError("No subtitle entries found")

    logger.info("Translating %d SRT entries with Gemini (%s → %s)", len(entries), source_lang, target_lang)

    model = _get_gemini_client()

    # Send in batches of 50 entries to stay within context limits
    batch_size = 50
    translated_entries = []

    for batch_start in range(0, len(entries), batch_size):
        batch = entries[batch_start:batch_start + batch_size]
        batch_srt = entries_to_srt(batch)
        prompt = CHINESE_TO_VIETNAMESE_PROMPT + batch_srt
        logger.info("Sending batch %d-%d to Gemini", batch_start + 1, min(batch_start + batch_size, len(entries)))

        try:
            response = model.models.generate_content(
                model=settings.gemini_model,
                contents=prompt,
            )
            response_text = response.text.strip()
        except Exception as e:
            logger.error("Gemini API error: %s", e)
            raise RuntimeError(f"Translation failed: {e}")

        # Parse translated SRT back
        translated_batch = parse_srt(response_text)
        if not translated_batch:
            logger.warning("Gemini returned empty translation for batch %d-%d", batch_start + 1, min(batch_start + batch_size, len(entries)))
            # fallback: keep original
            translated_entries.extend(batch)
            continue

        translated_entries.extend(translated_batch)

    # Save translated SRT
    out_dir = settings.temp_dir / "translated" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "subtitles_vi.srt"
    out_content = entries_to_srt(translated_entries)
    out_path.write_text(out_content, encoding="utf-8")

    logger.info("Translation complete: %d entries saved to %s", len(translated_entries), out_path)
    return out_content


def _notify_ws_sync(loop, ws_clients, job_id, data):
    import asyncio
    async def _send():
        for ws in ws_clients.get(job_id, []):
            try:
                await ws.send_json(data)
            except Exception:
                pass
    if loop:
        asyncio.run_coroutine_threadsafe(_send(), loop)


def run_translate_sync(loop, job_id: str, jobs: dict, ws_clients: dict, video_id: str):
    """Run translation in background, reporting progress via WebSocket."""
    job = jobs[job_id]
    job["status"] = "processing"
    job["phase"] = "translating"

    try:
        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "log",
            "message": "Bắt đầu dịch với Gemini...",
            "ts": __import__("time").time(),
            "level": "info",
        })
        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "progress",
            "progress": 10,
            "phase": "translating",
        })

        result = translate_srt(video_id, use_custom_srt=job.get("use_custom_srt", False))

        job["progress"] = 100
        job["phase"] = "done"
        job["status"] = "done"

        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done",
            "progress": 100,
            "message": "Dịch hoàn tất",
        })

    except Exception as e:
        logger.exception("Translation failed")
        job["status"] = "error"
        job["error"] = str(e)
        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error",
            "message": f"Lỗi dịch: {e}",
        })
