import logging
import json

from app.config import settings
from app.models import SrtEntry
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import parse_srt, entries_to_srt
from app.services.context_service import load_video_context, load_translation_context, append_translation_context
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.retry_utils import (
    gemini_call_rotating,
    configured_gemini_keys,
    genai_generate_content_factory,
)

logger = logging.getLogger(__name__)


def _read_user_config() -> dict:
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


CHINESE_TRANSLATE_PROMPT = """You are a professional translator. Your ONLY job is to translate Chinese to {target_lang_name}.

Translate EVERY subtitle line from Chinese to {target_lang_name}. NEVER keep any Chinese text in your output.
IMPORTANT: You MUST replace ALL Chinese characters with {target_lang_name} translation. Do NOT output the original Chinese text under any circumstances.

Rules:
1. Read the full context of all lines first
2. Use natural {target_lang_name}, not word-for-word
3. Adapt cultural terms ({culture_examples})
4. Keep the SRT format: index, timestamps, translated {target_lang_name} text
5. Keep lines similar length for subtitle timing
6. Remove all dash "-" characters from the translated text (e.g. "-", "--", "---")
7. {politeness_rule}
8. Remove extra/unrelated characters that are not part of the subtitle content: stray punctuation, repeated symbols (e.g. "。。", "。。。", "!!!", "~"), noise markers, or filler characters
9. TIMELINE MUST STAY EXACTLY THE SAME: translate ONLY the text of each line. Keep the exact same number of lines, the same order, the same index number, the same start time and the same end time for every line. NEVER merge two lines into one, NEVER split one line into two, NEVER drop any line, NEVER reorder lines, NEVER change any timestamp.
10. Output ONLY the translated SRT — no explanations, no markdown, no code fences

SRT to translate from Chinese to {target_lang_name}:

"""

GENERIC_TRANSLATE_PROMPT = """You are a professional subtitle translator. Translate the following SRT subtitles from {source_lang_name} to {target_lang_name}.

Rules:
1. Read the full context of all lines before translating.
2. Use natural {target_lang_name}; avoid mechanical, word-for-word translation.
3. Adapt cultural terms appropriately (e.g., 将军 → "General", 陛下 → "Your Majesty", 大人 → "My Lord/Excellency").
4. Maintain the SRT format: sequence number, timestamps, and translated {target_lang_name} content.
5. Keep line lengths balanced to ensure proper subtitle display timing.
6. Remove all hyphens/dashes ("-", "--", "---") from the translated text.
7. {politeness_rule}
8. Remove extraneous or irrelevant characters that are not part of the subtitle content: redundant punctuation, repeated symbols (e.g., "。。", "。。。", "!!!", "~"), noise indicators, or filler characters.
9. TIMELINE MUST STAY EXACTLY THE SAME: translate ONLY the text of each line. Keep the exact same number of lines, the same order, the same index number, the same start time and the same end time for every line. NEVER merge lines, NEVER split lines, NEVER drop any line, NEVER reorder lines, NEVER change any timestamp.
10. Output only the translated SRT content—no explanations, no Markdown formatting, and no code blocks.
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


def _extract_indices(srt_text: str) -> list[int | None]:
    """Read the raw index number of every SRT block in Gemini's output."""
    idx: list[int | None] = []
    for block in srt_text.strip().split("\n\n"):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        first = lines[0] if lines else ""
        idx.append(int(first) if first.isdigit() else None)
    return idx


def _reconcile_batch(batch: list, translated: list, translated_text: str) -> list:
    """Force translated text back onto the batch's exact timeline (1:1).

    Gemini may drop, merge, split or renumber lines. This guarantees every
    original line survives with its exact index/timestamps: translated text is
    matched by the index Gemini echoed (batch-relative or global), and any
    unmatched original line falls back to its original text so no subtitle is
    ever lost and the timeline is never altered.
    """
    by_raw: dict[int, object] = {}
    positional: list = []
    for te, ridx in zip(translated, _extract_indices(translated_text)):
        if ridx is not None and ridx not in by_raw:
            by_raw[ridx] = te
        else:
            positional.append(te)

    def matched(key_for) -> dict:
        m: dict = {}
        for p, b in enumerate(batch):
            te = by_raw.get(key_for(b, p))
            if te is not None:
                m[p] = te
        return m

    rel = matched(lambda b, p: p + 1)
    glob = matched(lambda b, p: b.index)
    chosen = rel if len(rel) >= len(glob) else glob

    out: list = []
    pool = positional
    pool_i = 0
    for p, b in enumerate(batch):
        te = chosen.get(p)
        if te is None and pool_i < len(pool):
            te = pool[pool_i]
            pool_i += 1
        text = te.text.strip() if te is not None else ""
        out.append(SrtEntry(
            index=b.index,
            start=b.start,
            end=b.end,
            startLabel=b.startLabel,
            endLabel=b.endLabel,
            text=text or b.text.strip(),
        ))
    return out


def _build_base_prompt(source_lang: str, target_lang: str, video_id: str) -> str:
    """Build the shared Gemini prompt prefix for a language pair (+video context)."""
    sn = LANG_NAMES.get(source_lang, source_lang)
    tn = LANG_NAMES.get(target_lang, target_lang)
    if target_lang == "vi":
        culture_examples = '将军→"tướng quân", 陛下→"bệ hạ", 大人→"đại nhân"'
        politeness_rule = ('Never use "mày" / "tao" (informal disrespectful pronouns). '
                           'Use polite alternatives like "ta", "ngươi", "anh", "cô", "tôi" depending on context')
    else:
        culture_examples = 'e.g., 将军 → "General", 陛下 → "Your Majesty", 大人 → "My Lord/Excellency"'
        politeness_rule = (f'Use an appropriate polite register for {tn}; avoid rude or overly informal '
                           'words unless the original clearly intends them')
    if source_lang == "zh":
        base_prompt = CHINESE_TRANSLATE_PROMPT.format(
            target_lang_name=tn,
            culture_examples=culture_examples,
            politeness_rule=politeness_rule,
        )
    else:
        base_prompt = GENERIC_TRANSLATE_PROMPT.format(
            source_lang_name=sn,
            target_lang_name=tn,
            politeness_rule=politeness_rule,
        )

    # Load video context if available (generated from OCR snapshots)
    context = load_video_context(video_id)
    if context:
        context_prefix = f"VIDEO CONTEXT (use this to understand the scene and translate more accurately):\n{context}\n\n"
        base_prompt = context_prefix + base_prompt
        logger.info("Using video context for translation: %s", context[:100])
    return base_prompt


def retranslate_untranslated(
    video_id: str,
    translated_content: str,
    source_lang: str = "zh",
    target_lang: str = "vi",
    log_fn=None,
) -> str:
    """Re-translate lines that were left in the original language.

    Compares the translated SRT against the original on disk, finds lines still
    identical to the source (fuzzy ratio >= 95%), asks Gemini to translate only
    those lines, and splices the fixes back into the translated content.
    """
    from rapidfuzz import fuzz

    original_path = _srt_path(video_id)
    if not original_path.exists():
        raise ValueError("SRT gốc không tồn tại")
    original = parse_srt(original_path.read_text(encoding="utf-8"))
    translated = parse_srt(translated_content)
    if not original or not translated:
        return translated_content

    # Match by index so each translated line is paired with its original.
    orig_by_idx = {e.index: e for e in original}
    untranslated_idx: list[int] = []
    for te in translated:
        oe = orig_by_idx.get(te.index)
        if oe is None:
            continue
        a, b = oe.text.strip(), te.text.strip()
        if a and b and fuzz.ratio(a, b) >= 95.0:
            untranslated_idx.append(te.index)
    if not untranslated_idx:
        return translated_content

    if log_fn:
        log_fn(f"Phát hiện {len(untranslated_idx)} dòng chưa dịch, gửi lại Gemini: {untranslated_idx[:20]}{'...' if len(untranslated_idx) > 20 else ''}", level="warning")

    # Build a mini-SRT from the ORIGINAL untranslated lines so Gemini translates
    # the source text (not the echoed copy inside the translated content).
    batch = [orig_by_idx[i] for i in untranslated_idx]
    batch_srt = entries_to_srt(batch)

    base_prompt = _build_base_prompt(source_lang, target_lang, video_id)
    patch_context = load_translation_context(video_id)
    if patch_context:
        base_prompt = (
            "PREVIOUS PATCH CONTEXT (keep character names, honorifics, terminology and tone "
            f"CONSISTENT with these):\n{patch_context}\n\n{base_prompt}"
        )
    prompt = base_prompt + "\nTranslate ONLY these lines (keep the exact index/timestamps):\n\n" + batch_srt

    def _call_gemini(contents, config: dict):
        return gemini_call_rotating(
            genai_generate_content_factory,
            model=settings.gemini_model,
            contents=contents,
            config=config,
        )

    try:
        response = _call_gemini(prompt, {
            "system_instruction": "You are a professional subtitle translator. Always translate ALL text to the target language. Never output text in the source language.",
            "temperature": 0.3,
        })
        response_text = _clean_gemini_response(response.text.strip())
    except Exception as e:
        raise RuntimeError(f"Retranslation failed: {e}")

    translated_batch = parse_srt(response_text)
    if not translated_batch:
        if log_fn:
            log_fn("Gemini không trả về bản dịch cho các dòng chưa dịch — giữ nguyên.", level="warning")
        return translated_content

    reconciled = _reconcile_batch(batch, translated_batch, response_text)
    fixed_by_idx = {r.index: r for r in reconciled}

    out: list = []
    retranslated: list[int] = []
    for te in translated:
        fixed = fixed_by_idx.get(te.index)
        if fixed is not None and fixed.text.strip():
            new_text = fixed.text.strip()
            if new_text != te.text.strip():
                retranslated.append(te.index)
            te = SrtEntry(
                index=te.index, start=te.start, end=te.end,
                startLabel=te.startLabel, endLabel=te.endLabel,
                text=new_text,
            )
        out.append(te)

    if log_fn:
        if retranslated:
            log_fn(f"Đã dịch lại {len(retranslated)} dòng: {retranslated[:20]}{'...' if len(retranslated) > 20 else ''}", level="success")
        else:
            log_fn("Gemini trả về nội dung không đổi — giữ nguyên bản dịch hiện tại.", level="warning")

    return entries_to_srt(out)


def translate_srt(video_id: str, source_lang: str = "zh", target_lang: str = "vi", use_custom_srt: bool = False, log_fn=None) -> str:
    """Translate SRT file using Gemini and save as subtitles_{target_lang}.srt."""
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

    # Build prompt based on language pair (target language injected, not hardcoded)
    base_prompt = _build_base_prompt(source_lang, target_lang, video_id)

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

        # Gemini occasionally returns an empty/None response for a batch (safety
        # filter, transient hiccup). Retry a few times; if it still fails, keep the
        # original text for that batch instead of aborting the whole translation.
        response_text = None
        last_err: Exception | str | None = None
        for attempt in range(3):
            try:
                response = _call_gemini(prompt, {
                    "system_instruction": "You are a professional subtitle translator. Always translate ALL text to the target language. Never output text in the source language.",
                    "temperature": 0.3,
                })
                if response is not None and (response.text or "").strip():
                    response_text = response.text.strip()
                    break
                last_err = "Gemini trả về phản hồi rỗng"
            except Exception as e:  # noqa: BLE001
                last_err = e
                logger.warning("Gemini batch %d attempt %d failed: %s", bi + 1, attempt + 1, e)
            if attempt < 2:
                import time as _t
                _t.sleep(2 + attempt * 2)
        if not response_text:
            logger.warning("Gemini batch %d failed after retries (%s); giữ nguyên bản gốc.", bi + 1, last_err)
            if log_fn:
                log_fn(f"  Batch {bi + 1}: dịch thất bại, giữ nguyên bản gốc.", level="warning")
            translated_entries.extend(batch)
            continue

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
                response_text = response_text2
            except Exception:
                pass

        if not translated_batch:
            logger.warning("Gemini retry also failed for batch %d-%d, keeping original",
                           batch_start + 1, min(batch_start + batch_size, len(entries)))
            translated_entries.extend(batch)
            if log_fn:
                log_fn(f"  Batch {bi + 1}: thử lại vẫn lỗi, giữ nguyên bản gốc.", level="warning")
            continue

        # Force translated text back onto the original timeline so no line is
        # ever dropped and timestamps stay exactly as in the source SRT.
        reconciled = _reconcile_batch(batch, translated_batch, response_text)
        translated_entries.extend(reconciled)
        if log_fn:
            log_fn(f"  Batch {bi + 1}: dịch xong {len(reconciled)} dòng:")
            for te in reconciled:
                log_fn(f"    {te.index}. {te.text}")
        else:
            logger.info("Batch %d translated %d lines", bi + 1, len(reconciled))

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
