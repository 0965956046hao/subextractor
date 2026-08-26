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
) -> list[str]:
    """Map N source texts to N processed texts via Gemini.

    Sends the numbered payload with `instruction`, parses the numbered reply,
    and retries only the MISSING positions (telling Gemini exactly which ones
    it skipped). After `max_attempts` rounds any slot still unresolved keeps
    its original text. Always returns a list of len(texts).
    """
    n = len(texts)
    if n == 0:
        return []

    merged: dict[int, str] = {}
    payload = build_numbered_payload(texts)
    extra_note = ""

    for attempt in range(1, max_attempts + 1):
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
            )
            response_text = (response.text or "").strip()
        except Exception as e:  # noqa: BLE001
            logger.warning("gemini_map_texts attempt %d failed: %s", attempt, e)
            if log_fn:
                log_fn(f"  Lượt {attempt}: lỗi Gemini ({e})", level="warning")
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

    return [merged.get(i) or texts[i] for i in range(n)]
