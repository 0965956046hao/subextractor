"""Subtitle risk-check service.

Reads the current SRT, splits entries into batches and asks Gemini to flag
risky lines (check only — never edits the file). The review language is set by
the caller (`lang`), e.g. the pipeline's translate target. Risky categories:
- NOT_TRANSLATED: text is not in the expected language (still foreign content)
- TIMELINE_OVERLAP: line's time range overlaps the previous line
- ADJACENT_SIMILAR: content is still >80% similar to the adjacent line
  (should have been merged)

The result is saved to `temp/risk_check/{video_id}.json` and served back
through `GET /api/srt/{video_id}/risk-check`.
"""

import json
import logging
import time

from app.config import settings
from app.services.media_utils import _srt_path, _srt_best_path
from app.services.srt_utils import entries_to_srt, parse_srt
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.retry_utils import (
    gemini_call_rotating,
    configured_gemini_keys,
    genai_generate_content_factory,
)

logger = logging.getLogger(__name__)


RISK_CHECK_PROMPT_VI = """You are a Vietnamese subtitle quality reviewer. You review an SRT subtitle file that was machine-translated to Vietnamese.

For EACH subtitle line, check for these problems:
1. NOT_TRANSLATED — the text is NOT Vietnamese: it still contains Chinese characters, or is in another language that should have been translated to Vietnamese.
2. TIMELINE_OVERLAP — the line's time range overlaps the PREVIOUS line (its start time is BEFORE the previous line's end time).
3. ADJACENT_SIMILAR — the text is still very similar (>80% identical) to the PREVIOUS adjacent line, so they should have been merged into one.

Output ONLY a JSON array (no markdown, no explanations). One object per risky line:
[{"index": <line index>, "problems": ["NOT_TRANSLATED"], "note": "<ngắn gọn bằng tiếng Việt>"}]
Use the problems list with zero or more of the three keys above. If a line has no problem, do NOT include it. If no line has problems, output only [].
"""

RISK_CHECK_PROMPT_GENERIC = """You are a {lang_name} subtitle quality reviewer. You review an SRT subtitle file that was machine-translated to {lang_name}.

For EACH subtitle line, check for these problems:
1. NOT_TRANSLATED — the text is NOT {lang_name}: it still contains Chinese/other-language characters or foreign content that should have been translated to {lang_name}.
2. TIMELINE_OVERLAP — the line's time range overlaps the PREVIOUS line (its start time is BEFORE the previous line's end time).
3. ADJACENT_SIMILAR — the text is still very similar (>80% identical) to the PREVIOUS adjacent line, so they should have been merged into one.

Output ONLY a JSON array (no markdown, no explanations). One object per risky line:
[{{"index": <line index>, "problems": ["NOT_TRANSLATED"], "note": "<short note in {lang_name}>"}}]
Use the problems list with zero or more of the three keys above. If a line has no problem, do NOT include it. If no line has problems, output only [].
"""

RISK_LANG_NAMES = {
    "zh": "Chinese (Simplified, 简体中文)",
    "en": "English",
    "vi": "Vietnamese",
}


def _build_risk_check_prompt(lang: str) -> tuple[str, str]:
    """Return (prompt, system_instruction) for the given subtitle language.

    Defaults to Vietnamese when `lang` is unknown, matching legacy behaviour.
    """
    lang = (lang or "vi").lower()
    lang_name = RISK_LANG_NAMES.get(lang, RISK_LANG_NAMES["vi"])
    if lang == "vi":
        return RISK_CHECK_PROMPT_VI, (
            "You review Vietnamese subtitles and only flag risky lines. "
            "Always output a JSON array."
        )
    return RISK_CHECK_PROMPT_GENERIC.format(lang_name=lang_name), (
        f"You review {lang_name} subtitles and only flag risky lines. "
        "Always output a JSON array."
    )


BATCH_SIZE = 50
# Number of trailing lines of the previous batch reused as context in the next
# batch so adjacent-content comparisons stay meaningful across batch boundaries.
# E.g. batch 1 = lines 1-50, batch 2 = lines 40-90 (10-line overlap).
OVERLAP = 10
STEP = BATCH_SIZE - OVERLAP  # 40


def _parse_json_array(text: str) -> list[dict]:
    """Extract a JSON array from Gemini's response (strip fences/preamble)."""
    import re

    text = re.sub(r"```(?:json)?\s*\n?", "", text.strip())
    text = text.replace("```", "")
    # Find the first [ ... ] block and try to parse it.
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if isinstance(item, dict):
            out.append(item)
    return out


def check_subtitle_risks(video_id: str, lang: str = "vi", log_fn=None) -> list[dict]:
    """Run the Gemini risk check over the current SRT of `video_id`.

    `lang` is the language the subtitles are in (zh / en / vi); the prompt is
    built accordingly so the "NOT_TRANSLATED" rule matches that language.

    Returns a list of risky lines: {index, text, problems, note}.
    """
    srt_path = _srt_best_path(video_id)
    if not srt_path.exists():
        raise ValueError("SRT not found")

    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not entries:
        raise ValueError("No subtitle entries found")

    if not configured_gemini_keys():
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    total_batches = (len(entries) + STEP - 1) // STEP
    risks: list[dict] = []
    seen_indexes: set[int] = set()

    prompt, system_instruction = _build_risk_check_prompt(lang)

    def _call_gemini(contents, config: dict):
        return gemini_call_rotating(
            genai_generate_content_factory,
            model=settings.gemini_model,
            contents=contents,
            config=config,
        )

    for bi, batch_start in enumerate(range(0, len(entries), STEP)):
        batch = entries[batch_start:batch_start + BATCH_SIZE]
        batch_srt = entries_to_srt(batch)
        logger.info(
            "Risk-check batch %d-%d (lines %d-%d) to Gemini",
            batch_start + 1, min(batch_start + BATCH_SIZE, len(entries)),
            batch_start + 1, min(batch_start + BATCH_SIZE, len(entries)),
        )
        if log_fn:
            log_fn(
                f"Kiểm tra batch {bi + 1}/{total_batches} (dòng {batch_start + 1}–{min(batch_start + BATCH_SIZE, len(entries))}, "
                f"kèm {OVERLAP} dòng trước)..."
            )

        try:
            response = _call_gemini(
                prompt + "\n\n" + batch_srt,
                {
                    "system_instruction": system_instruction,
                    "temperature": 0.1,
                },
            )
            items = _parse_json_array(response.text.strip())
        except Exception as e:
            logger.error("Gemini risk-check error: %s", e)
            raise RuntimeError(f"Kiểm tra rủi ro thất bại: {e}")

        for item in items:
            try:
                local_index = int(item.get("index", 0))
            except (TypeError, ValueError):
                continue
            # The batch SRT renumbers lines 1..N. local_index 1 maps to the first
            # entry of the batch (global index batch_start + local_index). Only
            # the FIRST batch has no overlap; for later batches the first
            # OVERLAP local lines repeat the tail of the previous batch and must
            # NOT be double-reported.
            if batch_start > 0 and local_index <= OVERLAP:
                continue
            global_index = batch_start + local_index
            if 1 <= global_index <= len(entries) and global_index not in seen_indexes:
                problems = item.get("problems", [])
                if isinstance(problems, str):
                    problems = [problems]
                problems = [str(p) for p in problems if p]
                seen_indexes.add(global_index)
                risks.append({
                    "index": global_index,
                    "text": entries[global_index - 1].text,
                    "problems": problems,
                    "note": str(item.get("note", "") or ""),
                })

        if log_fn:
            log_fn(f"  Batch {bi + 1}: xong.")

    return risks


def run_risk_check_sync(loop, job_id: str, jobs: dict, ws_clients: dict, video_id: str, lang: str = "vi"):
    """Run risk check in background, saving the result and notifying via WS."""
    job = jobs[job_id]
    job["status"] = "processing"
    job["phase"] = "risk_check"

    try:
        job_log_sync(loop, jobs, ws_clients, job_id, "Bắt đầu kiểm tra rủi ro file sub bằng Gemini...")
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "progress", "progress": 10, "phase": "risk_check",
        })

        def _log(msg: str, level: str = "info"):
            job_log_sync(loop, jobs, ws_clients, job_id, msg, level=level)

        risks = check_subtitle_risks(video_id, lang=lang, log_fn=_log)

        out_dir = settings.temp_dir / "risk_check"
        out_dir.mkdir(parents=True, exist_ok=True)
        result = {"risks": risks, "checked_at": time.time()}
        (out_dir / f"{video_id}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        job["progress"] = 100
        job["phase"] = "done"
        job["status"] = "done"

        if risks:
            job_log_sync(loop, jobs, ws_clients, job_id,
                         f"Đã tìm thấy {len(risks)} dòng có rủi ro.", level="warn")
        else:
            job_log_sync(loop, jobs, ws_clients, job_id,
                         "Không phát hiện rủi ro nào.", level="success")

        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done", "progress": 100, "message": "Kiểm tra rủi ro hoàn tất",
        })

    except Exception as e:
        logger.exception("Risk-check failed")
        job["status"] = "error"
        job["error"] = str(e)
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error", "message": f"Lỗi kiểm tra rủi ro: {e}",
        })