import logging
import json

from app.config import settings
from app.models import SrtEntry
from app.services.media_utils import _srt_path
from app.services.srt_utils import parse_srt, entries_to_srt
from app.services.context_service import load_video_context, load_translation_context, append_translation_context
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.gemini_array import build_numbered_payload, gemini_map_texts
from app.services.retry_utils import (
    configured_gemini_keys,
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


# Array protocol: Gemini only ever sees numbered TEXT lines ("0|nội dung") —
# never indexes/timestamps — so it cannot touch the SRT timeline at all.
CHINESE_TRANSLATE_PROMPT = """You are a professional subtitle translator. Your ONLY job is to translate Chinese subtitle lines to {target_lang_name}.

Input: numbered lines in the form "position|chinese text".
Output: EXACTLY the same positions, one line each, in the form "position|{target_lang_name} translation".

Rules:
1. Read the full context of all lines first, then translate each one.
2. Use natural {target_lang_name}, not word-for-word. Adapt cultural terms ({culture_examples}).
3. Keep each translation similar in length to its source line so subtitle timing works.
4. Replace ALL Chinese characters with {target_lang_name} — never echo Chinese text back.
5. Strip dashes ("-", "--"), stray punctuation, repeated symbols ("。。", "。。。", "!!!", "~") and noise markers from the result.
6. Output one line PER input position, same order, same count ({line_hint}). NEVER merge two lines, NEVER split one line, NEVER skip a position.
7. Output ONLY the "position|translation" lines — no explanations, no markdown, no code fences.
8. {politeness_rule}
"""

GENERIC_TRANSLATE_PROMPT = """You are a professional subtitle translator. Translate the following subtitle lines from {source_lang_name} to {target_lang_name}.

Input: numbered lines in the form "position|text".
Output: EXACTLY the same positions, one line each, in the form "position|{target_lang_name} translation".

Rules:
1. Read the full context of all lines first, then translate each one.
2. Use natural {target_lang_name}; avoid mechanical, word-for-word translation.
3. Adapt cultural terms appropriately (e.g., 将军 → "General", 陛下 → "Your Majesty", 大人 → "My Lord/Excellency").
4. Keep each translation similar in length to its source line so subtitle timing works.
5. Strip dashes ("-", "--"), stray punctuation, repeated symbols ("。。", "。。。", "!!!", "~") and noise markers from the result.
6. Output one line PER input position, same order, same count ({line_hint}). NEVER merge two lines, NEVER split one line, NEVER skip a position.
7. Output ONLY the "position|translation" lines — no explanations, no markdown, no code fences.
8. {politeness_rule}
"""

# After each patch is translated, ask Gemini to summarize the patch so the NEXT
# patch can keep names, honorifics, tone and terminology consistent.
PATCH_CONTEXT_PROMPT = """You are a subtitle-translation consistency assistant.

The following numbered lines were JUST translated from {source_lang_name} to {target_lang_name}.
Write a SHORT (max ~5 sentences) context note in {target_lang_name} capturing what an upcoming patch must know to stay consistent:
- Character names, titles, honorifics and how they address each other
- Repeated terminology or idioms and the translation chosen for them
- The tone/register being used
- Any plot facts established in this patch that matter later

Do NOT include line numbers or timestamps. Output ONLY the context note, no preamble.

Translated lines:

"""


LANG_NAMES = {
    "zh": "Chinese", "en": "English", "vi": "Vietnamese",
    "ja": "Japanese", "ko": "Korean", "fr": "French",
}


def _build_patch_context_note(translated_texts: list[str], source_lang: str, target_lang: str) -> str:
    """Ask Gemini to summarize a translated patch into a reusable context note."""
    sn = LANG_NAMES.get(source_lang, source_lang)
    tn = LANG_NAMES.get(target_lang, target_lang)
    prompt = PATCH_CONTEXT_PROMPT.format(source_lang_name=sn, target_lang_name=tn)
    payload = "\n".join(f"{i}|{t}" for i, t in enumerate(translated_texts))
    try:
        response = gemini_map_texts_call_note(prompt, payload)
        return response.strip()
    except Exception as e:
        logger.warning("Patch context note failed: %s", e)
        return ""


def gemini_map_texts_call_note(prompt: str, payload: str) -> str:
    """One-shot Gemini call for the patch context note (numbered lines in, prose out)."""
    from app.services.retry_utils import gemini_call_rotating, genai_generate_content_factory

    response = gemini_call_rotating(
        genai_generate_content_factory,
        model=settings.gemini_model,
        contents=f"{prompt}\n\n{payload}",
        config={
            "system_instruction": "You build concise translation-consistency notes.",
            "temperature": 0.2,
        },
    )
    return response.text.strip()


def _build_base_prompt(source_lang: str, target_lang: str, video_id: str, n_lines: int) -> str:
    """Build the shared Gemini instruction for a language pair (+video context)."""
    sn = LANG_NAMES.get(source_lang, source_lang)
    tn = LANG_NAMES.get(target_lang, target_lang)
    line_hint = f"you receive {n_lines} lines, you output exactly {n_lines} lines"
    politeness_rule_vi = ('Never use "mày" / "tao" (informal disrespectful pronouns). '
                          'Use polite alternatives like "ta", "ngươi", "anh", "cô", "tôi" depending on context')
    if target_lang == "vi":
        culture_examples = '将军→"tướng quân", 陛下→"bệ hạ", 大人→"đại nhân"'
        politeness_rule = politeness_rule_vi
    else:
        culture_examples = 'e.g., 将军 → "General", 陛下 → "Your Majesty", 大人 → "My Lord/Excellency"'
        politeness_rule = (f'Use an appropriate polite register for {tn}; avoid rude or overly informal '
                           'words unless the original clearly intends them')
    if source_lang == "zh":
        base_prompt = CHINESE_TRANSLATE_PROMPT.format(
            target_lang_name=tn,
            culture_examples=culture_examples,
            politeness_rule=politeness_rule,
            line_hint=line_hint,
        )
    else:
        base_prompt = GENERIC_TRANSLATE_PROMPT.format(
            source_lang_name=sn,
            target_lang_name=tn,
            politeness_rule=politeness_rule,
            line_hint=line_hint,
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

    # Array protocol: only the SOURCE texts travel to Gemini — no timeline.
    batch = [orig_by_idx[i] for i in untranslated_idx]
    texts = [b.text for b in batch]

    base_prompt = _build_base_prompt(source_lang, target_lang, video_id, len(texts))
    patch_context = load_translation_context(video_id)
    if patch_context:
        base_prompt = (
            "PREVIOUS PATCH CONTEXT (keep character names, honorifics, terminology and tone "
            f"CONSISTENT with these):\n{patch_context}\n\n{base_prompt}"
        )

    results = gemini_map_texts(
        texts,
        instruction=(
            base_prompt
            + "\nIMPORTANT: translate EVERY line below; replace all source-language text."
        ),
        system_instruction="You are a professional subtitle translator. Always translate ALL text to the target language. Never output text in the source language.",
        temperature=0.7,
        log_fn=log_fn,
    )

    fixed_by_idx = dict(zip(untranslated_idx, results))

    out: list = []
    retranslated: list[int] = []
    for te in translated:
        new_text = fixed_by_idx.get(te.index)
        if new_text is not None and new_text.strip() and new_text != te.text.strip():
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

    # Accumulated translation context keeps names/honorifics/terminology consistent
    patch_context = load_translation_context(video_id)
    if patch_context:
        logger.info("Using accumulated translation context (%d chars)", len(patch_context))

    SYSTEM_INSTRUCTION = (
        "You are a professional subtitle translator. Always answer with numbered "
        "'position|translation' lines covering EVERY input position."
    )

    # Send in batches of 50 entries to stay within context limits.
    # Array protocol: only texts leave the backend; timestamps never do.
    batch_size = 50
    translated_entries = []
    total_batches = (len(entries) + batch_size - 1) // batch_size

    for bi, batch_start in enumerate(range(0, len(entries), batch_size)):
        batch = entries[batch_start:batch_start + batch_size]
        texts = [e.text for e in batch]

        instruction = _build_base_prompt(source_lang, target_lang, video_id, len(texts))
        if patch_context:
            instruction = (
                "PREVIOUS PATCH CONTEXT (already-translated subtitles; keep character names, "
                "honorifics, terminology and tone CONSISTENT with these):\n"
                f"{patch_context}\n\n{instruction}"
            )

        logger.info("Sending batch %d-%d to Gemini", batch_start + 1, min(batch_start + batch_size, len(entries)))
        if log_fn:
            log_fn(f"Dịch batch {bi + 1}/{total_batches} ({len(batch)} dòng: {batch_start + 1}–{min(batch_start + batch_size, len(entries))})...")

        results = gemini_map_texts(
            texts,
            instruction=instruction,
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.3,
            log_fn=log_fn,
        )

        # Zip 1:1 back onto the ORIGINAL entries — timeline untouched by design.
        out_batch: list[SrtEntry] = []
        changed = 0
        for b, r in zip(batch, results):
            new_text = (r or "").strip()
            if new_text != b.text.strip():
                changed += 1
            out_batch.append(SrtEntry(
                index=b.index,
                start=b.start,
                end=b.end,
                startLabel=b.startLabel,
                endLabel=b.endLabel,
                text=new_text or b.text.strip(),
            ))
        translated_entries.extend(out_batch)

        if changed == 0 and len(texts) > 0:
            logger.warning("Batch %d-%d: Gemini echoed input without translating", bi + 1, bi + len(batch))
            if log_fn:
                log_fn(f"  Batch {bi + 1}: bản dịch trùng bản gốc, có thể chưa được dịch.", level="warning")
        else:
            logger.info("Batch %d translated (%d/%d lines changed)", bi + 1, changed, len(batch))
            if log_fn:
                log_fn(f"  Batch {bi + 1}: dịch xong {len(out_batch)} dòng ({changed} dòng thay đổi).")

        # Build a context note from this patch and append it so the NEXT patch
        # keeps names, honorifics, terminology and tone consistent.
        note = _build_patch_context_note(
            [e.text for e in out_batch], source_lang, target_lang,
        )
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
