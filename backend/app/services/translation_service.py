import logging
import json
from pathlib import Path

from app.config import settings
from app.models import SrtEntry
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import parse_srt, entries_to_srt
from app.services.context_service import (
    load_video_context,
    load_translation_context,
    append_translation_context,
    _load_capcut_voice_catalog,
)
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.gemini_array import build_numbered_payload, gemini_map_texts
from app.services.retry_utils import (
    configured_gemini_keys,
    gemini_call_rotating,
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


def _transform_translated_text(text: str) -> str:
    """Chuyển đổi text sau khi dịch:
    1. Bo dau cham "." o cuoi cau (nhung khong xoa dau cham khac)
    2. Viet hoa chu cai dau tien cua cau
    
    Example:
        "tôi là mạnh." -> "Tôi là mạnh"
        "chào bạn!" -> "Chào bạn!"
        "xin chào." -> "Xin chào"
    """
    import re
    
    # 1. Bo dau cham "." o cuoi chu text (chi bo dau cham cuoi cung, khong xoa dau cham ben trong)
    # Su dung regex: neu text ket thuc bang . hoac ? hoac ! (theo sau bo dau trang)
    text = re.sub(r"\s*[\.\?!]\s*$", "", text)
    
    # 2. Viet hoa chu cai dau tien cua chu text (chi word dau tien)
    if text:
        text = text[0].upper() + text[1:] if len(text) > 1 else text.upper()
    
    return text


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

SPEAKER DIARIZATION (from audio analysis):
{diarization}

RULES:
1. Listen to the audio and read the speaker diarization to identify who speaks when.
2. Map each SRT line to the speaker who says it based on timestamps (start --> end).
3. Pick a voice_type for EACH SRT line from the AVAILABLE list only. Never invent a voice.
4. MỖI NHÂN VẬT CHỈ DÙNG 1 GIỌNG duy nhất xuyên suốt video. Nếu cùng một nhân vật xuất hiện ở nhiều dòng (kể cả không liên tiếp), LUÔN gán cùng voice_type — tuyệt đối không đổi giọng cho cùng 1 nhân vật.
5. Chỉ đổi giọng khi chắc chắn người nói khác nhân vật (nam ↔ nữ, già ↔ trẻ, khác vai trò).
6. Giọng của nhân vật nam: ưu tiên giọng nam; nhân vật nữ: ưu tiên giọng nữ (xem tên/display_name của giọng).
7. Narrator/background lines: pick a neutral voice.
8. Output ONLY a JSON object mapping SRT index → voice_type, e.g. {{"1": "BV421_vivn_streaming", "2": "vi_female_huong"}}. No markdown, no explanation.

{previous_assignments}
SRT LINES (with timestamps):
{srt}
"""


def generate_voice_map(video_id: str, entries, log_fn=None, target_lang: str = "vi") -> dict:
    """Assign a CapCut voice to each SRT line via Gemini; save as voice_map.json.

    Returns {index: voice_type}. Saves to ``translated/{video_id}/voice_map.json``.
    Uses audio diarization for accurate speaker identification.
    """
    catalog = _load_capcut_voice_catalog(target_lang)
    if not catalog:
        logger.warning("CapCut voice catalog unavailable for lang %s — voice map skipped", target_lang)
        if log_fn:
            log_fn("Không đọc được CapCut voice catalog — bỏ qua tạo voice_map.json.", "warning")
        return {}

    context = load_video_context(video_id) or "Không có"

    if not configured_gemini_keys():
        logger.warning("Gemini API key not configured — voice map skipped")
        if log_fn:
            log_fn("Chưa cấu hình Gemini API key — không tạo được voice_map.json.", "warning")
        return {}

    # Step 1: Extract audio and get diarization from Gemini
    # Ưu tiên: vocals.wav (demucs) > merged audio > video
    diarization_text = "Không có dữ liệu diarization (dùng context để suy luận)."
    audio_uri = None
    try:
        import subprocess

        audio_dir = settings.temp_dir / "translated" / video_id
        audio_dir.mkdir(parents=True, exist_ok=True)
        audio_path = audio_dir / "diarization_input.wav"

        # Fix 1: Ưu tiên vocals.wav từ demucs (đã tách voice, không có nhạc nền)
        demucs_vocals = settings.temp_dir / "tts" / video_id / "separated" / "htdemucs" / "audio" / "vocals.wav"
        if demucs_vocals.exists() and demucs_vocals.stat().st_size > 0:
            if log_fn:
                log_fn(f"Dùng vocals.wav từ demucs: {demucs_vocals.name}")
            subprocess.run(
                [
                    "ffmpeg", "-y", "-i", str(demucs_vocals),
                    "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
                    str(audio_path),
                ],
                check=True, capture_output=True, timeout=120,
            )
        else:
            from app.services.media_utils import _merge_audio_path
            merged_audio = _merge_audio_path(video_id)
            if merged_audio and merged_audio.exists():
                if log_fn:
                    log_fn(f"Dùng file audio có sẵn: {merged_audio.name}")
                subprocess.run(
                    [
                        "ffmpeg", "-y", "-i", str(merged_audio),
                        "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
                        str(audio_path),
                    ],
                    check=True, capture_output=True, timeout=120,
                )
            else:
                if log_fn:
                    log_fn("Không tìm thấy file audio, trích xuất từ video...")
                video_path = _video_path(video_id)
                subprocess.run(
                    [
                        "ffmpeg", "-y", "-i", str(video_path),
                        "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
                        str(audio_path),
                    ],
                    check=True, capture_output=True, timeout=120,
                )

        if audio_path.exists() and audio_path.stat().st_size > 0:
            if log_fn:
                log_fn("Đang upload audio lên Gemini để nhận diện speaker...")
            from app.services.retry_utils import upload_audio_to_gemini, delete_gemini_file
            audio_uri, audio_mime = upload_audio_to_gemini(audio_path, mime_type="audio/wav")

            # Fix 3: Include timestamps in SRT for diarization mapping
            srt_with_timestamps = entries_to_srt(entries)
            diarization_prompt = f"""Analyze this audio file and identify all distinct speakers.

For each speaker, provide:
1. A speaker label (Speaker 1, Speaker 2, etc.)
2. The timestamps (start - end) when they speak
3. A brief description (gender, age estimate, tone)

Then map each speaker to the SRT lines below based on timing overlap. Use the start/end timestamps to match speakers to lines.

SRT LINES (with timestamps):
{srt_with_timestamps}

Output format: JSON object with SRT index -> speaker info, e.g.:
{{
  "speakers": {{
    "Speaker 1": {{"gender": "male", "age": "young", "description": "deep voice, authoritative"}},
    "Speaker 2": {{"gender": "female", "age": "middle-aged", "description": "soft, gentle"}}
  }},
  "line_speakers": {{
    "1": "Speaker 1",
    "2": "Speaker 2"
  }}
}}"""

            from google.genai import types as genai_types
            contents = [
                genai_types.Part.from_text(text=diarization_prompt),
                genai_types.Part.from_uri(file_uri=audio_uri, mime_type=audio_mime),
            ]
            response = gemini_call_rotating(
                genai_generate_content_factory,
                model=settings.gemini_model,
                contents=contents,
                config={
                    "system_instruction": "You are an expert audio analyst. Identify speakers and their characteristics from the audio. Use timestamps to accurately map speakers to subtitle lines.",
                    "temperature": 0.2,
                },
            )

            raw = response.text.strip()
            raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            diarization_data = json.loads(raw)

            # Lưu raw diarization response vào translated folder
            diarization_file = settings.temp_dir / "translated" / video_id / "diarization.json"
            diarization_file.parent.mkdir(parents=True, exist_ok=True)
            diarization_file.write_text(json.dumps(diarization_data, ensure_ascii=False, indent=2), encoding="utf-8")
            if log_fn:
                log_fn(f"Đã lưu diarization.json ({diarization_file})")

            # Format diarization for voice map prompt
            speakers = diarization_data.get("speakers", {})
            line_speakers = diarization_data.get("line_speakers", {})

            diarization_lines = ["SPEAKER IDENTIFICATION:"]
            for spk, info in speakers.items():
                diarization_lines.append(f"  {spk}: {info.get('gender', 'unknown')}, {info.get('description', '')}")
            diarization_lines.append("\nLINE -> SPEAKER MAPPING:")
            for idx, spk in sorted(line_speakers.items(), key=lambda x: int(x[0])):
                diarization_lines.append(f"  Line {idx}: {spk}")

            diarization_text = "\n".join(diarization_lines)
            if log_fn:
                log_fn(f"Đã nhận diện {len(speakers)} speaker từ audio.", "success")

            # Clean up uploaded file
            delete_gemini_file(audio_uri)
            # Xóa file wav trung gian sau khi đã dùng xong (chỉ dùng cho diarization).
            audio_path.unlink(missing_ok=True)

    except Exception as e:
        logger.warning("Audio diarization failed, falling back to context-only: %s", e)
        if log_fn:
            log_fn(f"Không phân tích được audio ({e}), dùng context để suy luận.", "warning")

    # Step 2: Generate voice map with diarization info
    if log_fn:
        log_fn(f"Đang tạo voice_map.json: chọn giọng CapCut cho {len(entries)} dòng phụ đề (Gemini)...")

    base_prompt = VOICE_MAP_PROMPT.format(
        context=context,
        catalog=catalog,
        diarization=diarization_text,
        previous_assignments="",
        srt="{srt}",
    )

    voice_map: dict[int, str] = {}
    batch_size = 50
    total = len(entries)
    total_batches = (total + batch_size - 1) // batch_size

    for bi, batch_start in enumerate(range(0, total, batch_size)):
        batch = entries[batch_start:batch_start + batch_size]
        batch_srt = entries_to_srt(batch)

        # Fix 2: Cross-batch memory — tell Gemini đã assign giọng gì ở các batch trước
        previous_assignments = ""
        if voice_map:
            prev_lines = []
            for prev_idx in sorted(voice_map.keys()):
                if prev_idx <= batch_start:
                    entry = entries[prev_idx - 1] if 0 < prev_idx <= len(entries) else None
                    if entry:
                        prev_lines.append(f"  Line {prev_idx}: {voice_map[prev_idx]} ({entry.text[:40]}...)")
            if prev_lines:
                previous_assignments = (
                    "PREVIOUS VOICE ASSIGNMENTS (MUST stay consistent - do NOT change these):\n"
                    + "\n".join(prev_lines)
                    + "\n\n"
                )

        prompt = base_prompt.replace("{srt}", batch_srt).replace("{previous_assignments}", previous_assignments)
        if log_fn:
            log_fn(f"  Chọn giọng đọc batch {bi + 1}/{total_batches} ({len(batch)} dòng)...")
        try:
            response = gemini_call_rotating(
                genai_generate_content_factory,
                model=settings.gemini_model,
                contents=prompt,
                config={
                    "system_instruction": "You assign CapCut voices to subtitle lines. Output JSON only. Keep voice assignments consistent with PREVIOUS VOICE ASSIGNMENTS.",
                    "temperature": 0.2,
                },
            )
            raw = response.text.strip()
            raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            data = json.loads(raw)
            if isinstance(data, dict):
                for k, v in data.items():
                    try:
                        idx = int(str(k).strip())
                    except (ValueError, TypeError):
                        continue
                    voice = str(v).strip()
                    if not voice:
                        continue
                    # Gemini có thể trả index batch-relative (1..50) hoặc global
                    # (51..100) — chấp nhận cả hai.
                    if batch_start + 1 <= idx <= batch_start + len(batch):
                        voice_map[idx] = voice
                    elif 1 <= idx <= len(batch):
                        voice_map[batch_start + idx] = voice
        except Exception as e:
            logger.warning("Voice map batch %d-%d failed: %s", batch_start + 1, min(batch_start + batch_size, total), e)
            if log_fn:
                log_fn(f"  Batch {bi + 1}: chọn giọng thất bại ({e}), bỏ qua.", level="warning")

    if not voice_map:
        if log_fn:
            log_fn("Gemini không trả về kết quả chọn giọng — không tạo được voice_map.json.", "warning")
        return {}

    p = _voice_map_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({str(k): v for k, v in voice_map.items()}, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Voice map saved for %s: %d voices", video_id, len(voice_map))
    if log_fn:
        log_fn(f"Đã tạo voice_map.json: {len(voice_map)}/{total} dòng có giọng riêng.", "success")
    return voice_map


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


def _call_gemini(contents, config: dict):
    return gemini_call_rotating(
        genai_generate_content_factory,
        model=settings.gemini_model,
        contents=contents,
        config=config,
    )


def re_translate_line(video_id: str, source_text: str, source_lang: str = "zh", target_lang: str = "vi", log_fn=None) -> str:
    """Re-translate a single SRT line with Gemini (same prompts as translate_srt)."""
    if not configured_gemini_keys():
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    base_prompt = _build_base_prompt(source_lang, target_lang, video_id, n_lines=1)

    patch_context = load_translation_context(video_id)
    if patch_context:
        patch_prefix = (
            "PREVIOUS PATCH CONTEXT (already-translated subtitles; keep character names, "
            "honorifics, terminology and tone CONSISTENT with these):\n"
            f"{patch_context}\n\n"
        )
        base_prompt = patch_prefix + base_prompt

    line_srt = entries_to_srt([SrtEntry(index=1, start=0, end=0, startLabel="00:00:00,000", endLabel="00:00:00,000", text=source_text)])
    prompt = (
        base_prompt
        + "\n\nTranslate ONLY the single SRT line below. "
        + "Output ONLY the translated text — no index, no timestamps, no explanations, no code fences.\n\n"
        + line_srt
    )
    if log_fn:
        log_fn(f"Đang dịch lại 1 dòng với Gemini ({source_lang} → {target_lang})...")

    response = _call_gemini(prompt, {
        "system_instruction": "You are a professional subtitle translator. Always translate ALL text to the target language. Never output text in the source language.",
        "temperature": 0.3,
    })
    text = _clean_gemini_response(response.text.strip())
    # Strip the SRT framing: take the last non-empty line (the text).
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError("Gemini trả về kết quả rỗng khi dịch lại dòng.")
    new_text = lines[-1]
    if log_fn:
        log_fn(f"Đã dịch lại: {source_text}  →  {new_text}", level="success")
    return new_text


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


def translate_srt(video_id: str, source_lang: str = "zh", target_lang: str = "vi", use_custom_srt: bool = False, multi_voice: bool = False, log_fn=None, progress_callback=None) -> str:
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

        if progress_callback:
            progress_callback(bi + 1, total_batches)

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
            # Áp dụng chuyển đổi: bo dau cham cuoi cau + viet hoa chu cai dau tien
            new_text = _transform_translated_text(new_text)
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

    # Multi-voice: ask Gemini to assign a CapCut voice to each line → voice_map.json
    if multi_voice:
        if log_fn:
            log_fn("Bật nhiều giọng nói — tạo voice_map.json ngay trong bước Dịch Gemini...")
        generate_voice_map(video_id, translated_entries, log_fn=log_fn, target_lang=target_lang)

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

        def _progress(done_batches: int, total_batches: int):
            pct = 10 + int(80 * done_batches / max(1, total_batches))
            job["progress"] = pct
            notify_ws_sync(loop, ws_clients, job_id, {
                "type": "progress",
                "progress": pct,
                "phase": "translating",
            })

        result = translate_srt(
            video_id,
            source_lang=job.get("source_lang", "zh"),
            target_lang=job.get("target_lang", "vi"),
            use_custom_srt=job.get("use_custom_srt", False),
            multi_voice=job.get("multi_voice", False),
            log_fn=_log,
            progress_callback=_progress,
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
