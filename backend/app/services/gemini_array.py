"""Array-only Gemini protocol: numbered text lines in, numbered lines out.

Gemini NEVER sees SRT indexes or timestamps — the backend owns the timeline.
Each line travels as "N|text" (0-based position). The response must use the
same numbering, so missing/duplicated positions are detected exactly and can
be retried surgically; unresolved slots fall back to their original text so a
line is never lost or shifted.

Used by translation (translate_srt / retranslate / context note) and by the
risk-check service.
"""

import logging
import re

from app.config import settings
from app.services.job_utils import JobCancelled
from app.services.retry_utils import (
    gemini_call_rotating,
    genai_generate_content_factory,
)

logger = logging.getLogger(__name__)

# "7|nội dung" — split on the FIRST pipe only (text may contain "|").
_NUM_LINE_RE = re.compile(r"^\s*(\d+)\s*\|\s?(.*)$")


def build_numbered_payload(texts: list[str]) -> str:
    """Render texts as numbered lines:  "0|text\\n1|text\\n...".

    Newlines inside a subtitle line would break the one-line-per-entry format
    → collapse internal whitespace first.
    """
    return "\n".join(f"{i}|{' '.join(t.split())}" for i, t in enumerate(texts))


def parse_numbered_response(text: str, n: int) -> dict[int, str]:
    """Parse a numbered-lines response into {position: translated_text}.

    Tolerates markdown fences, preamble/postamble and stray blank lines.
    Positions outside [0, n) are ignored; later duplicates keep the FIRST
    occurrence (matches how _reconcile used to treat echoed indexes).
    """
    out: dict[int, str] = {}
    for raw in (text or "").splitlines():
        m = _NUM_LINE_RE.match(raw.strip())
        if not m:
            continue
        i = int(m.group(1))
        if 0 <= i < n and i not in out:
            out[i] = m.group(2).strip()
    return out


def gemini_map_texts(
    texts: list[str],
    instruction: str,
    system_instruction: str,
    temperature: float = 0.3,
    max_attempts: int = 3,
    log_fn=None,
    require_complete: bool = False,
    cancelled_cb=None,
) -> list[str]:
    """Map N source texts to N processed texts via Gemini.

    Sends the numbered payload with `instruction`, parses the numbered reply,
    and retries only the MISSING positions (telling Gemini exactly which ones
    it skipped). After `max_attempts` rounds any slot still unresolved keeps
    its original text unless `require_complete=True` (translation): failed
    requests or unresolved positions then raise instead of returning source text.
    """
    n = len(texts)
    if n == 0:
        return []

    merged: dict[int, str] = {}
    payload = build_numbered_payload(texts)
    extra_note = ""

    for attempt in range(1, max_attempts + 1):
        if cancelled_cb and cancelled_cb():
            raise JobCancelled()
        prompt = (
            f"{instruction}\n\n{extra_note}\nInput lines ({n} total):\n\n{payload}"
            if extra_note
            else f"{instruction}\n\nInput lines ({n} total):\n\n{payload}"
        )
        try:
            response = gemini_call_rotating(
                genai_generate_content_factory,
                model=settings.gemini_model,
                contents=prompt,
                config={
                    "system_instruction": system_instruction,
                    "temperature": temperature,
                },
                _timeout=settings.gemini_timeout,
                _log_fn=log_fn,
                _cancelled_cb=cancelled_cb,
            )
            response_text = (response.text or "").strip()
        except JobCancelled:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("gemini_map_texts attempt %d failed: %s", attempt, e)
            if log_fn:
                log_fn(f"  Lượt {attempt}: lỗi Gemini ({e})", level="warning")
            if require_complete:
                # Transport retries are already exhausted by the shared helper.
                # Never turn a failed translation request into source text.
                raise RuntimeError("Gemini không dịch được batch sau các lần thử. Nếu lỗi 429 tiếp diễn, kiểm tra quota của project Gemini rồi chạy tiếp bước dịch.") from e
            continue

        got = parse_numbered_response(response_text, n)
        for i, t in got.items():
            if t and i not in merged:
                merged[i] = t

        missing = [i for i in range(n) if i not in merged]
        if not missing:
            break
        logger.warning(
            "gemini_map_texts: attempt %d returned %d/%d lines, missing %s",
            attempt, len(got), n, missing[:20],
        )
        if log_fn:
            log_fn(
                f"  Lượt {attempt}: nhận {len(got)}/{n} dòng, thiếu vị trí "
                f"{missing[:15]}{'…' if len(missing) > 15 else ''} — hỏi lại.",
                level="warning",
            )
        preview = ", ".join(f"{texts[i][:40]}" for i in missing[:10])
        extra_note = (
            f"IMPORTANT: your previous reply was INCOMPLETE ({len(got)} of {n} lines). "
            f"You MUST output EVERY position from 0 to {n - 1}, one line each, "
            f"format 'position|result'. Missing positions were: {missing}. "
            f"For example their sources start with: {preview}"
        )

    missing = [i for i in range(n) if i not in merged]
    if require_complete and missing:
        raise RuntimeError(f"Gemini trả thiếu {len(missing)}/{n} dòng sau {max_attempts} lượt. Chưa lưu batch này là bản dịch hoàn tất.")
    return [merged.get(i) or texts[i] for i in range(n)]
