"""Shared retry helpers for Gemini API calls (google-genai).

Retries ONLY on overload/rate-limit/transient errors (429, 503, 5xx,
RESOURCE_EXHAUSTED, QUOTA_EXCEEDED, ...) using random exponential backoff
(2–10s) for at most 3 attempts, then re-raises the original error.
"""

import logging

from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_random_exponential,
)

logger = logging.getLogger(__name__)

_RETRYABLE_CODES = {408, 429, 500, 502, 503, 504}
_RETRYABLE_HINTS = (
    "resourceexhausted",
    "resourcelimited",
    "serviceunavailable",
    "ratelimit",
    "quota",
    "overloaded",
    "deadlineexceeded",
    "temporarilyunavailable",
    "backenderror",
)


def _is_retryable(e: Exception) -> bool:
    code = getattr(e, "code", None) or getattr(e, "status_code", None) or getattr(e, "status", None)
    if isinstance(code, int) and code in _RETRYABLE_CODES:
        return True
    name = type(e).__name__.lower()
    return any(hint in name for hint in _RETRYABLE_HINTS)


# Trả về True nếu muốn retry (lỗi quá tải), False nếu fail dứt điểm.
def _should_retry(e: Exception) -> bool:
    retryable = _is_retryable(e)
    if retryable:
        logger.info("Gemini transient error (%s), retrying…", e)
    return retryable


gemini_retry = retry(
    wait=wait_random_exponential(min=2, max=10),
    stop=stop_after_attempt(3),
    retry=retry_if_exception(_should_retry),
    reraise=True,
)