"""Shared retry helpers for Gemini API calls (google-genai).

Two layers:
1. `gemini_retry` — tenacity decorator that retries ONLY on overload/rate-limit/
   transient errors (429, 503, 5xx, RESOURCE_EXHAUSTED, QUOTA_EXCEEDED, ...)
   using random exponential backoff (2–10s) for at most 3 attempts on the SAME key.
2. `gemini_call_rotating` — same idea but ALSO rotates through every configured
   Gemini API key (round-robin). When a key reports usage exhausted / quota /
   rate-limit, the call is retried with the next key. Falls back to `gemini_retry`
   behavior when only one key is configured.
"""

import logging
import os
import random
import threading
import time
from collections.abc import Callable
from contextvars import ContextVar
import contextlib

from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_random_exponential,
)

from app.config import settings

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
    raise_if_gemini_cancelled()
    retryable = _is_retryable(e)
    if retryable:
        logger.info("Gemini transient error (%s), retrying…", e)
    return retryable


# ── Cooperative cancellation for Gemini retries ──────────────────────────
# Worker jobs run in a ThreadPoolExecutor and cancel cooperatively via
# `job["cancelled"]`. `run_in_executor` does NOT propagate contextvars into
# the worker thread, so each sync entry point must open the scope itself:
#   with gemini_cancel_scope(lambda: job.get("cancelled")):
#       ... gemini calls ...
# Without this, a cancelled job keeps hammering Gemini until all retry
# attempts are exhausted (status shows "cancelled" but logs keep flowing).
CancelCheck = Callable[[], bool]

_cancel_check: ContextVar[CancelCheck | None] = ContextVar(
    "gemini_cancel_check", default=None
)


@contextlib.contextmanager
def gemini_cancel_scope(is_cancelled: CancelCheck):
    """Abort in-flight Gemini retries when `is_cancelled()` becomes True."""
    token = _cancel_check.set(is_cancelled)
    try:
        yield
    finally:
        _cancel_check.reset(token)


def raise_if_gemini_cancelled() -> None:
    """Raise JobCancelled if the surrounding cancel scope was triggered."""
    cb = _cancel_check.get()
    if cb is not None and cb():
        from app.services.job_utils import JobCancelled

        raise JobCancelled()


def _sleep_interruptible(seconds: float) -> None:
    """Sleep in small slices so cancellation aborts the backoff promptly."""
    step = 0.25
    end = time.time() + seconds
    while True:
        raise_if_gemini_cancelled()
        remaining = end - time.time()
        if remaining <= 0:
            return
        time.sleep(min(step, remaining))


gemini_retry = retry(
    wait=wait_random_exponential(min=2, max=10),
    stop=stop_after_attempt(5),
    retry=retry_if_exception(_should_retry),
    reraise=True,
)


def _read_user_config() -> dict:
    import json
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def configured_gemini_keys() -> list[str]:
    """All Gemini API keys available for rotation.

    Priority: config-file `gemini_api_keys` list → legacy single
    `gemini_api_key` → env `GEMINI_API_KEY` / `STE_gemini_api_key`.
    """
    cfg = _read_user_config()
    keys: list[str] = []
    for k in (cfg.get("gemini_api_keys") or []):
        if isinstance(k, str) and k.strip():
            keys.append(k.strip())
    legacy = (cfg.get("gemini_api_key") or "").strip()
    if legacy and legacy not in keys:
        keys.append(legacy)
    env = os.environ.get("GEMINI_API_KEY", "") or settings.gemini_api_key
    if env and env not in keys:
        keys.append(env)
    return keys


_key_lock = threading.Lock()
_key_index = 0


def _next_key(keys: list[str]) -> str:
    global _key_index
    if not keys:
        return ""
    with _key_lock:
        key = keys[_key_index % len(keys)]
        _key_index += 1
    return key


def _mask(key: str) -> str:
    if len(key) <= 8:
        return "***"
    return f"{key[:4]}…{key[-4:]}"


def genai_generate_content_factory(key: str, timeout: float | None = None):
    """Build a `generate_content` callable that keeps its genai.Client alive.

    Do NOT use `lambda key: genai.Client(api_key=key).models.generate_content`
    directly — the temporary client gets garbage-collected (transport closed)
    before the request is sent, raising "Cannot send a request, as the client
    has been closed." This closure holds the client in scope for the call.

    `timeout` (seconds) is forwarded via `http_options` to the client.
    """
    from google import genai
    from google.genai import types as genai_types

    http_options = (
        genai_types.HttpOptions(timeout=int(timeout * 1000))
        if timeout is not None
        else None
    )
    client = genai.Client(api_key=key, http_options=http_options)

    def _call(*args, **kwargs):
        return client.models.generate_content(*args, **kwargs)

    return _call


def gemini_call_rotating(fn_factory, *args, _max_attempts: int = 5, _timeout: float | None = None, **kwargs):
    """Call a Gemini API with automatic key rotation on quota/rate-limit errors.

    `fn_factory(api_key: str, timeout: float | None)` must return the bound
    callable to invoke, e.g. `genai_generate_content_factory`.

    - No keys configured → raises the friendly "set a key" error.
    - Retryable error (429/RESOURCE_EXHAUSTED/QUOTA/...): rotate to the next key
      and retry, up to `_max_attempts` total (each attempt uses a fresh key).
    - Non-retryable errors are raised immediately.
    - `_timeout` (seconds) is forwarded to each `generate_content` call.
    """
    keys = configured_gemini_keys()
    if not keys:
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    last_err: Exception | None = None
    for i in range(_max_attempts):
        raise_if_gemini_cancelled()
        key = _next_key(keys)
        try:
            fn = fn_factory(key, timeout=_timeout)
            return fn(*args, **kwargs)
        except Exception as e:
            last_err = e
            if not _should_retry(e):
                raise
            if i < _max_attempts - 1:
                delay = random.uniform(2, 8)
                logger.info(
                    "Gemini call failed on key %s (attempt %d/%d): %s — rotating key, backoff %.1fs",
                    _mask(key), i + 1, _max_attempts, e, delay,
                )
                _sleep_interruptible(delay)
    raise last_err  # type: ignore[misc]


def upload_audio_to_gemini(audio_path, mime_type: str = "audio/wav") -> tuple[str, str]:
    """Upload an audio file to Gemini Files API. Returns (uri, mime_type).

    Uses the first configured Gemini API key.
    """
    from google import genai

    keys = configured_gemini_keys()
    if not keys:
        raise ValueError("GEMINI_API_KEY not set.")
    client = genai.Client(api_key=keys[0])
    uploaded = client.files.upload(file=str(audio_path), config={"mime_type": mime_type})
    return uploaded.uri, uploaded.mime_type


def delete_gemini_file(uri: str):
    """Delete a file from Gemini Files API by URI."""
    from google import genai

    keys = configured_gemini_keys()
    if not keys:
        return
    try:
        client = genai.Client(api_key=keys[0])
        client.files.delete(name=uri)
    except Exception:
        pass