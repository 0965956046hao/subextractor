"""Subtitle risk-check service.

Reads the current SRT and flags risky lines. Two complementary layers:

1. CODE (deterministic): TIMELINE_OVERLAP — computed locally by comparing each
   line's start against the previous line's end. No AI involved.
2. GEMINI (text-only): NOT_TRANSLATED and ADJACENT_SIMILAR — reviewed via the
   numbered-lines array protocol ("position|text"). The model never sees SRT
   timestamps or indexes, so it cannot misreport positions beyond its own
   numbering, which is validated range-wise before use.

The result is saved to `temp/risk_check/{video_id}.json` and served back
through `GET /api/srt/{video_id}/risk-check`.
"""

import hashlib
import json
import logging
import re
import time

from app.config import settings
from app.services.media_utils import _srt_path, _srt_best_path
from app.services.srt_utils import entries_to_srt, parse_srt, _texts_similar
from app.services.gemini_array import build_numbered_payload
from app.services.job_utils import notify_ws_sync, job_log_sync, JobCancelled
from app.services.retry_utils import (
    gemini_call_rotating,
    configured_gemini_keys,
    genai_generate_content_factory,
    gemini_cancel_scope,
)

logger = logging.getLogger(__name__)


RISK_CHECK_PROMPT_VI = """You are a Vietnamese subtitle quality reviewer. You review machine-translated Vietnamese subtitle lines.

Input: numbered lines in the form "position|text" (consecutive subtitle lines, in order).

For EACH line, check for these problems:
1. NOT_TRANSLATED — the text is NOT Vietnamese: it still contains Chinese characters, or is in another language that should have been translated to Vietnamese.
2. ADJACENT_SIMILAR — the text is still very similar (>80% identical) to the PREVIOUS adjacent line, so they should have been merged into one. Compare ONLY with the immediately previous line in the input — NEVER reference distant line numbers.

Output ONLY a JSON array (no markdown, no explanations). One object per risky line:
[{"i": <position>, "problems": ["NOT_TRANSLATED"], "note": "<ngắn gọn bằng tiếng Việt>"}]
"i" is the input position number. Skip clean lines entirely. If no line has problems, output only [].
"""

RISK_CHECK_PROMPT_GENERIC = """You are a {lang_name} subtitle quality reviewer. You review machine-translated {lang_name} subtitle lines.

Input: numbered lines in the form "position|text" (consecutive subtitle lines, in order).

For EACH line, check for these problems:
1. NOT_TRANSLATED — the text is NOT {lang_name}: it still contains Chinese/other-language characters or foreign content that should have been translated to {lang_name}.
2. ADJACENT_SIMILAR — the text is still very similar (>80% identical) to the PREVIOUS adjacent line, so they should have been merged into one. Compare ONLY with the immediately previous line in the input — NEVER reference distant line numbers.

Output ONLY a JSON array (no markdown, no explanations). One object per risky line:
[{{"i": <position>, "problems": ["NOT_TRANSLATED"], "note": "<short note in {lang_name}>"}}]
"i" is the input position number. Skip clean lines entirely. If no line has problems, output only [].
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
            'Always output a JSON array using "i" for the input position.'
        )
    return RISK_CHECK_PROMPT_GENERIC.format(lang_name=lang_name), (
        f"You review {lang_name} subtitles and only flag risky lines. "
        'Always output a JSON array using "i" for the input position.'
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


def _entries_hash(entries) -> str:
    """Hash of the subtitle TEXT sequence (timing ignored).

    Text-level risks (NOT_TRANSLATED, ADJACENT_SIMILAR) depend only on this,
    so an unchanged hash means the previous Gemini verdict is still valid and
    the Gemini layer can be skipped — only timeline overlaps (timing) need a
    fresh pass in code.
    """
    h = hashlib.sha1()
    for e in entries:
        h.update((e.text or "").strip().encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def _load_cached_result(video_id: str) -> dict | None:
    p = settings.temp_dir / "risk_check" / f"{video_id}.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


# Chữ Hán (Unified Ideographs + Ext A + Compat). Một dòng phụ đề đích (vi/en)
# còn chứa ký tự này thì chắc chắn chưa dịch xong — định nghĩa khớp hệt
# prompt Gemini ("it still contains Chinese characters") nên tính bằng code.
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002a6df]")


def _check_untranslated_code(entries, lang: str = "vi") -> list[dict]:
    """Deterministic NOT_TRANSLATED: line still contains Chinese characters."""
    if (lang or "vi").lower() == "zh":
        return []  # đích là tiếng Trung → chữ Hán là bình thường
    risks: list[dict] = []
    for e in entries:
        if e.text and _CJK_RE.search(e.text):
            risks.append({
                "index": e.index,
                "text": e.text,
                "problems": ["NOT_TRANSLATED"],
                "note": "Còn sót chữ Trung Quốc chưa dịch.",
            })
    return risks


# Ngưỡng xác minh claim ADJACENT_SIMILAR của model (fuzz với dòng kề trước
# THẬT trong file). Prompt đòi >80%; cho model biên độ xuống 60% (diễn đạt
# lại cùng ý), dưới đó coi như ảo giác (vd chém "trùng dòng 24" ở xa) → loại.
ADJACENT_SIMILAR_MIN = 60.0


def _verify_adjacent_claim(entries, pos: int) -> tuple[bool, float, int]:
    """Verify a claimed ADJACENT_SIMILAR at `entries[pos]` vs its true predecessor.

    Returns (plausible, similarity_ratio, prev_index). Guards against model
    hallucinations that reference distant lines.
    """
    from rapidfuzz import fuzz

    if pos <= 0 or pos >= len(entries):
        return False, 0.0, -1
    prev, cur = entries[pos - 1], entries[pos]
    sim = fuzz.ratio(prev.text or "", cur.text or "")
    if sim < ADJACENT_SIMILAR_MIN:
        return False, sim, prev.index
    return True, sim, prev.index


def _check_adjacent_similar_code(entries) -> list[dict]:
    """Deterministic ADJACENT_SIMILAR: adjacent texts >=80% identical.

    Cùng ngưỡng với dedup (`_texts_similar`) để gắn cờ và tự gộp luôn đồng
    thuận với nhau.
    """
    risks: list[dict] = []
    for k in range(1, len(entries)):
        prev, cur = entries[k - 1], entries[k]
        if _texts_similar(prev.text, cur.text):
            risks.append({
                "index": cur.index,
                "text": cur.text,
                "problems": ["ADJACENT_SIMILAR"],
                "note": f"Nội dung rất giống dòng #{prev.index} liền trước, nên gộp lại.",
            })
    return risks


def _check_timeline_overlaps(entries) -> list[dict]:
    """Deterministic TIMELINE_OVERLAP detection (prev.end vs cur.start)."""
    risks: list[dict] = []
    for k in range(1, len(entries)):
        prev, cur = entries[k - 1], entries[k]
        if cur.start < prev.end - 0.001:  # 1ms tolerance for rounding noise
            risks.append({
                "index": cur.index,
                "text": cur.text,
                "problems": ["TIMELINE_OVERLAP"],
                "note": f"Bắt đầu lúc {cur.startLabel} sớm hơn kết thúc dòng trước ({prev.endLabel}).",
            })
    return risks


def check_subtitle_risks(video_id: str, lang: str = "vi", log_fn=None) -> list[dict]:
    """Run the risk check over the current SRT of `video_id`.

    `lang` is the language the subtitles are in (zh / en / vi). All three
    risk types are first computed deterministically in code (overlap timing,
    leftover CJK text, fuzzy-similar neighbours); Gemini then adds semantic
    judgement on top (union, never subtracts).

    Returns a list of risky lines: {index, text, problems, note}.
    """
    srt_path = _srt_best_path(video_id)
    if not srt_path.exists():
        raise ValueError("SRT not found")

    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not entries:
        raise ValueError("No subtitle entries found")

    risks: list[dict] = []
    by_risk_index: dict[int, dict] = {}

    def _add(index: int, text: str, problems: list[str], note: str):
        # Hợp nhất problems khi nhiều lớp cùng gắn cờ 1 dòng (vd vừa overlap
        # timing vừa sót chữ Hán) thay vì rớt mất verdict của lớp sau.
        r = by_risk_index.get(index)
        if r is None:
            r = {"index": index, "text": text, "problems": [], "note": ""}
            by_risk_index[index] = r
            risks.append(r)
        for p in problems:
            if p and p not in r["problems"]:
                r["problems"].append(p)
        if note and note not in r["note"]:
            r["note"] = (r["note"] + " " + note).strip()

    # ── Short-circuit: nội dung không đổi → tái dùng verdict Gemini cũ ──
    # Hash bằng nhau nghĩa là dãy text y hệt (cùng số dòng, cùng thứ tự) nên
    # index của risk cũ vẫn khớp. Chỉ tính lại overlap (timing) bằng code.
    cur_hash = _entries_hash(entries)
    cached = _load_cached_result(video_id)
    if cached and cached.get("texts_hash") == cur_hash:
        n_text = 0
        by_index = {e.index: e for e in entries}
        pos_by_index = {e.index: k for k, e in enumerate(entries)}
        for r in cached.get("risks") or []:
            problems = [p for p in (r.get("problems") or []) if p in ("NOT_TRANSLATED", "ADJACENT_SIMILAR")]
            if not problems:
                continue
            entry = by_index.get(r.get("index"))
            if entry is None:
                continue
            note = str(r.get("note") or "")
            if "ADJACENT_SIMILAR" in problems:
                # Verdict cũ có thể là ảo giác của model (vd "trùng dòng 24")
                # → xác minh lại với neighbour thật, sai thì purge luôn.
                ok, sim, prev_idx = _verify_adjacent_claim(entries, pos_by_index.get(entry.index, -1))
                if not ok:
                    logger.info(
                        "Risk-check cache: purging implausible ADJACENT_SIMILAR #%d", entry.index,
                    )
                    problems = [p for p in problems if p != "ADJACENT_SIMILAR"]
                else:
                    note = f"Giống {sim:.0f}% với dòng #{prev_idx} liền trước."
            if not problems:
                continue
            _add(entry.index, entry.text, problems, note)
            n_text += 1
        n_overlap = 0
        for r in _check_timeline_overlaps(entries):
            _add(r["index"], r["text"], r["problems"], r["note"])
            n_overlap += 1
        msg = (
            f"Nội dung không đổi — bỏ qua Gemini, dùng lại {n_text} rủi ro text cũ "
            f"+ kiểm tra lại {n_overlap} overlap timeline."
        )
        logger.info("Risk-check cache hit for %s: %s", video_id, msg)
        if log_fn:
            log_fn(msg)
        return risks

    if not configured_gemini_keys():
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    # ── Layer 1: code định đoạt (không phụ thuộc Gemini) ──
    # Overlap timing + sót chữ Hán + kề nhau giống nhau đều tính được chính
    # xác bằng code; Gemini ở layer 2 chỉ bổ sung nhận định ngữ nghĩa.
    # Nhờ vậy đuôi batch có bị model bỏ sót (vd #115-119) thì code vẫn bắt.
    n_overlap = 0
    for r in _check_timeline_overlaps(entries):
        _add(r["index"], r["text"], r["problems"], r["note"])
        n_overlap += 1
    if n_overlap:
        logger.info("Risk-check: %d TIMELINE_OVERLAP detected in code", n_overlap)
    n_untranslated = 0
    for r in _check_untranslated_code(entries, lang):
        _add(r["index"], r["text"], r["problems"], r["note"])
        n_untranslated += 1
    if n_untranslated:
        logger.info("Risk-check: %d NOT_TRANSLATED detected in code", n_untranslated)
    n_similar = 0
    for r in _check_adjacent_similar_code(entries):
        _add(r["index"], r["text"], r["problems"], r["note"])
        n_similar += 1
    if n_similar:
        logger.info("Risk-check: %d ADJACENT_SIMILAR detected in code", n_similar)

    # ── Layer 2: text-level risks via Gemini (numbered lines, no timeline) ──
    prompt, system_instruction = _build_risk_check_prompt(lang)
    total_batches = (len(entries) + STEP - 1) // STEP

    def _call_gemini(contents, config: dict):
        return gemini_call_rotating(
            genai_generate_content_factory,
            model=settings.gemini_model,
            contents=contents,
            config=config,
            _timeout=settings.gemini_timeout,
        )

    for bi, batch_start in enumerate(range(0, len(entries), STEP)):
        batch = entries[batch_start:batch_start + BATCH_SIZE]
        payload = build_numbered_payload([e.text for e in batch])
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
                prompt + "\n\nInput lines:\n\n" + payload,
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
                pos = int(item.get("i", item.get("position", item.get("index", -1))))
            except (TypeError, ValueError):
                continue
            if not (0 <= pos < len(batch)):
                continue
            # The first OVERLAP lines of later batches repeat the tail of the
            # previous batch and must NOT be double-reported.
            if batch_start > 0 and pos < OVERLAP:
                continue
            entry = batch[pos]
            problems = item.get("problems", [])
            if isinstance(problems, str):
                problems = [problems]
            problems = [str(p) for p in problems if p and p != "TIMELINE_OVERLAP"]
            note = str(item.get("note", "") or "")
            if "ADJACENT_SIMILAR" in problems:
                # Model hay chém verdict so với dòng ở xa ("trùng dòng 24")
                # trong khi định nghĩa là dòng LIỀN TRƯỚC → xác minh bằng fuzz
                # với neighbour thật, sai thì loại, đúng thì note lại cho factual.
                ok, sim, prev_idx = _verify_adjacent_claim(entries, batch_start + pos)
                if not ok:
                    logger.info(
                        "Risk-check: dropping implausible model ADJACENT_SIMILAR #%d (fuzz %.0f%% vs prev #%d)",
                        entry.index, sim, prev_idx,
                    )
                    problems = [p for p in problems if p != "ADJACENT_SIMILAR"]
                else:
                    note = f"Giống {sim:.0f}% với dòng #{prev_idx} liền trước."
            if not problems:
                continue
            _add(entry.index, entry.text, problems, note)

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

        risks = None
        with gemini_cancel_scope(lambda: job.get("cancelled")):
            risks = check_subtitle_risks(video_id, lang=lang, log_fn=_log)

        out_dir = settings.temp_dir / "risk_check"
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            saved_entries = parse_srt(_srt_best_path(video_id).read_text(encoding="utf-8"))
            texts_hash = _entries_hash(saved_entries)
        except Exception:
            texts_hash = ""
        result = {"risks": risks, "checked_at": time.time(), "texts_hash": texts_hash}
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

    except JobCancelled:
        raise
    except Exception as e:
        logger.exception("Risk-check failed")
        job["status"] = "error"
        job["error"] = str(e)
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error",
            "message": f"Lỗi kiểm tra rủi ro: {e}",
        })
