import logging
import json
import os
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import parse_srt, entries_to_srt
from app.services.context_service import load_video_context
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.retry_utils import gemini_retry

logger = logging.getLogger(__name__)


def _read_user_config() -> dict:
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


CHINESE_TO_VIETNAMESE_PROMPT = """You are a professional translator. Your ONLY job is to translate Chinese to Vietnamese.

Translate EVERY subtitle line from Chinese to Vietnamese. NEVER keep any Chinese text in your output.
IMPORTANT: You MUST replace ALL Chinese characters with Vietnamese translation. Do NOT output the original Chinese text under any circumstances.

Rules:
1. Read the full context of all lines first
2. Use natural Vietnamese, not word-for-word
3. Adapt cultural terms (将军→"tướng quân", 陛下→"bệ hạ", 大人→"đại nhân")
4. Keep SRT format: index, timestamps, translated Vietnamese text
5. Keep lines similar length for subtitle timing
6. Merge consecutive duplicate lines: if two or more lines in a row have IDENTICAL text, combine them into one line with the earliest start time and latest end time
7. Remove all dash "-" characters from the translated text (e.g. "-", "--", "---")
8. Never use "mày" / "tao" (informal disrespectful pronouns). Use polite alternatives like "ta", "ngươi", "anh", "cô", "tôi" depending on context
9. You may ONLY merge adjacent lines whose content is identical (see rule 6). NEVER merge lines with different content. ALWAYS keep the original timeline (start/end times) unchanged — do not alter timestamps except when merging identical adjacent lines
10. Remove extra/unrelated characters that are not part of the subtitle content: stray punctuation, repeated symbols (e.g. "。。", "。。。", "!!!", "~"), noise markers, or filler characters
11. Output ONLY the translated SRT — no explanations, no markdown, no code fences

SRT to translate from Chinese to Vietnamese:

"""

GENERIC_TRANSLATE_PROMPT = """You are a professional subtitle translator. Translate the following SRT subtitles from {source_lang_name} to {target_lang_name}.

Rules:
1. Read the FULL context first before translating
2. Use natural sentence structure, not word-for-word translation
3. Keep the original SRT format: index, timestamps, and translated text
4. Keep each translated line roughly the same length
5. Remove all dash "-" characters from the translated text (e.g. "-", "--", "---")
6. Never use "mày" / "tao" (informal disrespectful pronouns). Use polite alternatives like "ta", "ngươi", "anh", "cô", "tôi" depending on context
7. Merge adjacent lines whose content is identical into one line with the earliest start time and latest end time. NEVER merge lines with different content. ALWAYS keep the original timeline (start/end times) unchanged
8. Remove extra/unrelated characters that are not part of the subtitle content: stray punctuation, repeated symbols (e.g. "。。", "。。。", "!!!", "~"), noise markers, or filler characters
9. DO NOT add any explanation or notes
10. Output ONLY the translated SRT content in valid SRT format

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

    api_key = settings.gemini_api_key or os.environ.get("GEMINI_API_KEY", "") or _read_user_config().get("gemini_api_key", "")
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    return genai.Client(api_key=api_key)


LANG_NAMES = {
    "zh": "Chinese", "en": "English", "vi": "Vietnamese",
    "ja": "Japanese", "ko": "Korean", "fr": "French",
}


def _clean_gemini_response(text: str) -> str:
    """Strip markdown fences and any preamble/postamble from Gemini SRT output."""
    import re
    # Remove ```srt ... ``` or ``` ... ``` fences
    text = re.sub(r"```(?:srt|subtitle|subtitles)?\s*\n?", "", text)
    text = text.replace("```", "")
    # Remove any leading non-digit lines before the first SRT index
    lines = text.strip().split("\n")
    start = 0
    for i, ln in enumerate(lines):
        if ln.strip().isdigit():
            start = i
            break
    return "\n".join(lines[start:]).strip()


def translate_srt(video_id: str, source_lang: str = "zh", target_lang: str = "vi", use_custom_srt: bool = False, log_fn=None) -> str:
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
    if log_fn:
        log_fn(f"Đọc được {len(entries)} dòng phụ đề, bắt đầu dịch {source_lang} → {target_lang}...")

    model = _get_gemini_client()

    # Build prompt based on language pair
    if source_lang == "zh" and target_lang == "vi":
        base_prompt = CHINESE_TO_VIETNAMESE_PROMPT
    else:
        sn = LANG_NAMES.get(source_lang, source_lang)
        tn = LANG_NAMES.get(target_lang, target_lang)
        base_prompt = GENERIC_TRANSLATE_PROMPT.format(source_lang_name=sn, target_lang_name=tn)

    # Load video context if available (generated from OCR snapshots)
    context = load_video_context(video_id)
    if context:
        context_prefix = f"VIDEO CONTEXT (use this to understand the scene and translate more accurately):\n{context}\n\n"
        base_prompt = context_prefix + base_prompt
        logger.info("Using video context for translation: %s", context[:100])

    # Send in batches of 50 entries to stay within context limits
    batch_size = 50
    translated_entries = []
    total_batches = (len(entries) + batch_size - 1) // batch_size

    for bi, batch_start in enumerate(range(0, len(entries), batch_size)):
        batch = entries[batch_start:batch_start + batch_size]
        batch_srt = entries_to_srt(batch)
        prompt = base_prompt + batch_srt
        logger.info("Sending batch %d-%d to Gemini", batch_start + 1, min(batch_start + batch_size, len(entries)))
        if log_fn:
            log_fn(f"Dịch batch {bi + 1}/{total_batches} ({len(batch)} dòng: {batch_start + 1}–{min(batch_start + batch_size, len(entries))})...")

        try:
            response = gemini_retry(model.models.generate_content)(
                model=settings.gemini_model,
                contents=prompt,
                config={
                    "system_instruction": "You are a professional subtitle translator. Always translate ALL text to the target language. Never output text in the source language.",
                    "temperature": 0.3,
                },
            )
            response_text = response.text.strip()
        except Exception as e:
            logger.error("Gemini API error: %s", e)
            raise RuntimeError(f"Translation failed: {e}")

        # Strip markdown code fences that Gemini sometimes wraps around SRT
        response_text = _clean_gemini_response(response_text)
        logger.debug("Gemini response (first 200 chars): %s", response_text[:200])

        # Parse translated SRT back
        translated_batch = parse_srt(response_text)
        if not translated_batch:
            logger.warning("Gemini returned empty translation for batch %d-%d, response: %s",
                           batch_start + 1, min(batch_start + batch_size, len(entries)),
                           response_text[:300])
            # fallback: keep original
            translated_entries.extend(batch)
            if log_fn:
                log_fn(f"  Batch {bi + 1}: Gemini trả về trống, giữ nguyên bản gốc.", level="warning")
            continue

        # Detect if Gemini echoed back the input (no translation)
        if len(translated_batch) == len(batch) and translated_batch[0].text.strip() == batch[0].text.strip():
            logger.warning("Gemini echoed input without translating batch %d-%d, retrying with per-line prompt",
                           batch_start + 1, min(batch_start + batch_size, len(entries)))
            if log_fn:
                log_fn(f"  Batch {bi + 1}: Gemini lặp lại bản gốc, thử lại với yêu cầu dịch rõ hơn...")
            # Retry with explicit per-line instruction
            retry_prompt = (
                base_prompt
                + "\nIMPORTANT: Translate EVERY line below from Chinese to Vietnamese. "
                + "Replace each Chinese text with its Vietnamese equivalent. "
                + "Do NOT output any Chinese characters.\n\n"
                + batch_srt
            )
            try:
                response2 = gemini_retry(model.models.generate_content)(
                    model=settings.gemini_model,
                    contents=retry_prompt,
                    config={
                        "system_instruction": "You are a subtitle translator. You must translate ALL text. Never echo the input.",
                        "temperature": 0.7,
                    },
                )
                response_text2 = _clean_gemini_response(response2.text.strip())
                translated_batch = parse_srt(response_text2)
            except Exception:
                pass

        if not translated_batch:
            logger.warning("Gemini retry also failed for batch %d-%d, keeping original",
                           batch_start + 1, min(batch_start + batch_size, len(entries)))
            translated_entries.extend(batch)
            if log_fn:
                log_fn(f"  Batch {bi + 1}: thử lại vẫn lỗi, giữ nguyên bản gốc.", level="warning")
            continue

        translated_entries.extend(translated_batch)
        if log_fn:
            log_fn(f"  Batch {bi + 1}: dịch xong {len(translated_batch)} dòng:")
            for te in translated_batch:
                log_fn(f"    {te.index}. {te.text}")
        else:
            logger.info("Batch %d translated %d lines", bi + 1, len(translated_batch))

    # Save translated SRT
    out_dir = settings.temp_dir / "translated" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "subtitles_vi.srt"
    out_content = entries_to_srt(translated_entries)
    out_path.write_text(out_content, encoding="utf-8")

    logger.info("Translation complete: %d entries saved to %s", len(translated_entries), out_path)
    if log_fn:
        log_fn(f"Đã dịch xong {len(translated_entries)}/{len(entries)} dòng, lưu file SRT tiếng Việt.", level="success")
    return out_content


def run_translate_sync(loop, job_id: str, jobs: dict, ws_clients: dict, video_id: str):
    """Run translation in background, reporting progress via WebSocket."""
    job = jobs[job_id]
    job["status"] = "processing"
    job["phase"] = "translating"

    try:
        job_log_sync(loop, jobs, ws_clients, job_id, "Bắt đầu dịch với Gemini...")
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "progress",
            "progress": 10,
            "phase": "translating",
        })

        def _log(msg: str, level: str = "info"):
            job_log_sync(loop, jobs, ws_clients, job_id, msg, level=level)

        result = translate_srt(
            video_id,
            source_lang=job.get("source_lang", "zh"),
            target_lang=job.get("target_lang", "vi"),
            use_custom_srt=job.get("use_custom_srt", False),
            log_fn=_log,
        )

        job["progress"] = 100
        job["phase"] = "done"
        job["status"] = "done"

        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done",
            "progress": 100,
            "message": "Dịch hoàn tất",
        })

    except Exception as e:
        logger.exception("Translation failed")
        job["status"] = "error"
        job["error"] = str(e)
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error",
            "message": f"Lỗi dịch: {e}",
        })
