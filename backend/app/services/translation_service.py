import logging
import json

from app.config import settings
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import parse_srt, entries_to_srt
from app.services.context_service import (
    load_video_context,
    load_translation_context,
    append_translation_context,
    _load_capcut_voice_catalog,
)
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.retry_utils import (
    gemini_call_rotating,
    configured_gemini_keys,
    genai_generate_content_factory,
)

logger = logging.getLogger(__name__)


def _voice_map_path(video_id: str) -> Path:
    return settings.temp_dir / "translated" / video_id / "voice_map.json"


def load_voice_map(video_id: str) -> dict:
    """Load the saved per-line voice map: {index: voice_type}. Empty if absent."""
    p = _voice_map_path(video_id)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            return {int(k): v for k, v in data.items()}
        except Exception:
            return {}
    return {}


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
10. IMPORTANT — MERGE RULE: You may ONLY merge segments that are IMMEDIATELY NEXT TO EACH OTHER (adjacent, back-to-back in time) AND have IDENTICAL content. NEVER merge identical-looking content that is separated by other lines in between — if identical text reappears later after different content in between, it must stay as a separate subtitle line with its OWN timeline. ABSOLUTELY NEVER merge across a gap or over different content
11. Remove extra/unrelated characters that are not part of the subtitle content: stray punctuation, repeated symbols (e.g. "。。", "。。。", "!!!", "~"), noise markers, or filler characters
12. Output ONLY the translated SRT — no explanations, no markdown, no code fences

SRT to translate from Chinese to Vietnamese:

"""

GENERIC_TRANSLATE_PROMPT = """You are a professional subtitle translator. Translate the following SRT subtitles from {source_lang_name} to {target_lang_name}.

Rules:
1. Read the full context of all lines before translating.
2. Use natural Vietnamese; avoid mechanical, word-for-word translation.
3. Adapt cultural terms appropriately (e.g., 将军 → "General", 陛下 → "Your Majesty", 大人 → "My Lord/Excellency").
4. Maintain the SRT format: sequence number, timestamps, and translated Vietnamese content.
5. Keep line lengths balanced to ensure proper subtitle display timing.
6. Merge consecutive duplicate lines: if two or more adjacent lines share over 80% identical content, merge them into a single line spanning from the start time of the first duplicate to the end time of the last duplicate.
7. Remove all hyphens/dashes ("-", "--", "---") from the translated text.
8. Strictly avoid "mày" or "tao" (disrespectful/crude pronouns). Use polite alternatives such as "ta," "ngươi," "anh," "cô," or "tôi" depending on the context.
9. ONLY merge adjacent lines with identical content (see Rule 6). NEVER merge lines with different content. ALWAYS preserve original timestamps (start/end times)—do not alter them unless merging identical adjacent lines.
10. IMPORTANT — MERGING RULE: ONLY merge lines that are IMMEDIATELY ADJACENT (consecutive line numbers) AND have IDENTICAL content. DO NOT merge identical content if it is separated by intervening lines—if the exact same content reappears after different content, it must remain a separate subtitle line with its own timestamp. DO NOT merge across gaps or different content.
11. Remove extraneous or irrelevant characters that are not part of the subtitle content: redundant punctuation, repeated symbols (e.g., "。。", "。。。", "!!!", "~"), noise indicators, or filler characters.
12. Output only the translated SRT content—no explanations, no Markdown formatting, and no code blocks.
Here is the SRT to translate:

"""

# After each patch is translated, ask Gemini to summarize the patch so the NEXT
# patch can keep names, honorifics, tone and terminology consistent.
PATCH_CONTEXT_PROMPT = """You are a subtitle-translation consistency assistant.

The following is a patch of subtitles that was JUST translated from {source_lang_name} to {target_lang_name}.
Write a SHORT (max ~5 sentences) context note in {target_lang_name} capturing what an upcoming patch must know to stay consistent:
- Character names, titles, honorifics and how they address each other
- Repeated terminology or idioms and the translation chosen for them
- The tone/register being used
- Any plot facts established in this patch that matter later

Do NOT include timestamps or SRT indexes. Output ONLY the context note, no preamble.

Translated patch:

"""


def _build_patch_context_note(translated_batch, source_lang: str, target_lang: str) -> str:
    """Ask Gemini to summarize a translated patch into a reusable context note."""
    sn = LANG_NAMES.get(source_lang, source_lang)
    tn = LANG_NAMES.get(target_lang, target_lang)
    prompt = PATCH_CONTEXT_PROMPT.format(source_lang_name=sn, target_lang_name=tn)
    patch_srt = entries_to_srt(translated_batch)
    try:
        response = gemini_call_rotating(
            genai_generate_content_factory,
            model=settings.gemini_model,
            contents=prompt + patch_srt,
            config={
                "system_instruction": "You build concise translation-consistency notes.",
                "temperature": 0.2,
            },
        )
        return response.text.strip()
    except Exception as e:
        logger.warning("Patch context note failed: %s", e)
        return ""


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


VOICE_MAP_PROMPT = """You are a Vietnamese dubbing voice director. Assign the BEST CapCut voice to each SRT line.

VIDEO CONTEXT (character descriptions + suggested voices):
{context}

AVAILABLE CAPCUT VOICES (voice_type — display name):
{catalog}

RULES:
1. Read the video context: who is speaking (gender, age, personality, voice characteristics).
2. Pick a voice_type for EACH SRT line from the AVAILABLE list only. Never invent a voice.
3. MỖI NHÂN VẬT CHỈ DÙNG 1 GIỌNG duy nhất xuyên suốt video. Nếu cùng một nhân vật xuất hiện ở nhiều dòng (kể cả không liên tiếp), LUÔN gán cùng voice_type — tuyệt đối không đổi giọng cho cùng 1 nhân vật.
4. Chỉ đổi giọng khi chắc chắn người nói khác nhân vật (nam ↔ nữ, già ↔ trẻ, khác vai trò).
5. Giọng của nhân vật nam: ưu tiên giọng nam; nhân vật nữ: ưu tiên giọng nữ (xem tên/display_name của giọng).
6. Narrator/background lines: pick a neutral voice.
7. Output ONLY a JSON object mapping SRT index → voice_type, e.g. {{"1": "BV421_vivn_streaming", "2": "vi_female_huong"}}. No markdown, no explanation.

SRT LINES:
{srt}
"""


def generate_voice_map(video_id: str, entries, log_fn=None) -> dict:
    """Assign a CapCut voice to each SRT line via Gemini; save as voice_map.json.

    Returns {index: voice_type}. Saves to ``translated/{video_id}/voice_map.json``.
    """
    catalog = _load_capcut_voice_catalog()
    if not catalog:
        logger.warning("CapCut voice catalog unavailable — voice map skipped")
        return {}

    context = load_video_context(video_id) or "Không có"
    model = _get_gemini_client()

    base_prompt = VOICE_MAP_PROMPT.format(
        context=context,
        catalog=catalog,
        srt="{srt}",
    )

    voice_map: dict[int, str] = {}
    batch_size = 50
    total = len(entries)
    total_batches = (total + batch_size - 1) // batch_size

    for bi, batch_start in enumerate(range(0, total, batch_size)):
        batch = entries[batch_start:batch_start + batch_size]
        batch_srt = entries_to_srt(batch)
        prompt = base_prompt.replace("{srt}", batch_srt)
        if log_fn:
            log_fn(f"  Chọn giọng đọc batch {bi + 1}/{total_batches} ({len(batch)} dòng)...")
        try:
            response = gemini_retry(model.models.generate_content)(
                model=settings.gemini_model,
                contents=prompt,
                config={
                    "system_instruction": "You assign CapCut voices to subtitle lines. Output JSON only.",
                    "temperature": 0.2,
                },
            )
            raw = response.text.strip()
            raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            data = json.loads(raw)
            if isinstance(data, dict):
                for k, v in data.items():
                    idx = int(str(k).strip())
                    voice = str(v).strip()
                    if 1 <= idx <= len(batch) and voice:
                        voice_map[batch_start + idx] = voice
        except Exception as e:
            logger.warning("Voice map batch %d-%d failed: %s", batch_start + 1, min(batch_start + batch_size, total), e)
            if log_fn:
                log_fn(f"  Batch {bi + 1}: chọn giọng thất bại ({e}), bỏ qua.", level="warning")

    if not voice_map:
        return {}

    p = _voice_map_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({str(k): v for k, v in voice_map.items()}, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Voice map saved for %s: %d voices", video_id, len(voice_map))
    if log_fn:
        log_fn(f"Đã chọn giọng cho {len(voice_map)}/{total} dòng phụ đề.", level="success")
    return voice_map


def translate_srt(video_id: str, source_lang: str = "zh", target_lang: str = "vi", use_custom_srt: bool = False, multi_voice: bool = False, log_fn=None) -> str:
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

    # Validate at least one Gemini key is configured (keeps friendly error).
    if not configured_gemini_keys():
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    def _call_gemini(contents, config: dict):
        return gemini_call_rotating(
            genai_generate_content_factory,
            model=settings.gemini_model,
            contents=contents,
            config=config,
        )

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

    # Load accumulated translation context built from previously translated patches
    patch_context = load_translation_context(video_id)
    if patch_context:
        logger.info("Using accumulated translation context (%d chars)", len(patch_context))

    # Send in batches of 50 entries to stay within context limits
    batch_size = 50
    translated_entries = []
    total_batches = (len(entries) + batch_size - 1) // batch_size

    for bi, batch_start in enumerate(range(0, len(entries), batch_size)):
        batch = entries[batch_start:batch_start + batch_size]
        batch_srt = entries_to_srt(batch)

        # Prepend accumulated patch context so names/honorifics/terminology stay consistent
        if patch_context:
            patch_prefix = (
                "PREVIOUS PATCH CONTEXT (already-translated subtitles; keep character names, "
                "honorifics, terminology and tone CONSISTENT with these):\n"
                f"{patch_context}\n\n"
            )
            prompt = patch_prefix + base_prompt + batch_srt
        else:
            prompt = base_prompt + batch_srt
        logger.info("Sending batch %d-%d to Gemini", batch_start + 1, min(batch_start + batch_size, len(entries)))
        if log_fn:
            log_fn(f"Dịch batch {bi + 1}/{total_batches} ({len(batch)} dòng: {batch_start + 1}–{min(batch_start + batch_size, len(entries))})...")

        try:
            response = _call_gemini(prompt, {
                "system_instruction": "You are a professional subtitle translator. Always translate ALL text to the target language. Never output text in the source language.",
                "temperature": 0.3,
            })
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
                response2 = _call_gemini(retry_prompt, {
                    "system_instruction": "You are a subtitle translator. You must translate ALL text. Never echo the input.",
                    "temperature": 0.7,
                })
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

        # Build a context note from this patch and append it so the NEXT patch
        # keeps names, honorifics, terminology and tone consistent.
        note = _build_patch_context_note(translated_batch, source_lang, target_lang)
        if note:
            patch_context = (patch_context + "\n\n" + note) if patch_context else note
            append_translation_context(video_id, note)
            logger.info("Updated translation context after batch %d (%d chars)", bi + 1, len(patch_context))
            if log_fn:
                log_fn(f"  Batch {bi + 1}: đã cập nhật ngữ cảnh ({len(note)} ký tự) cho các batch tiếp theo.")

    # Save translated SRT, named by target language so multiple translations
    # (zh / en / vi) can coexist per video.
    out_dir = settings.temp_dir / "translated" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"subtitles_{target_lang}.srt"
    out_content = entries_to_srt(translated_entries)
    out_path.write_text(out_content, encoding="utf-8")

    # Multi-voice: ask Gemini to assign a CapCut voice to each line → voice_map.json
    if multi_voice:
        if log_fn:
            log_fn("Bật nhiều giọng nói — đang chọn giọng cho từng dòng phụ đề...")
        generate_voice_map(video_id, translated_entries, log_fn=log_fn)

    logger.info("Translation complete: %d entries saved to %s", len(translated_entries), out_path)
    if log_fn:
        lang_label = LANG_NAMES.get(target_lang, target_lang)
        log_fn(f"Đã dịch xong {len(translated_entries)}/{len(entries)} dòng, lưu file SRT {lang_label}.", level="success")
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
            multi_voice=job.get("multi_voice", False),
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
