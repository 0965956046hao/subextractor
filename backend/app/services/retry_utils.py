"""Shared retry helpers for Gemini API calls (google-genai).

Two layers:
1. `gemini_retry` — tenacity decorator that retries ONLY on overload/rate-limit/
   transient errors (429, 503, 5xx, RESOURCE_EXHAUSTED, QUOTA_EXCEEDED, ...)
   using random exponential backoff (2–10s) for at most 3 attempts on the SAME key.
2. `gemini_call_rotating` — same idea but ALSO rotates through every configured
   Gemini API key (round-robin). When a key reports usage exhausted / quota /
   rate-limit, the call is retried with the next key. Falls back to `gemini_retry`
   behavior when only one key is configured. Quota exhaustion on
   gemini-3.5-flash-lite can fall back to gemini-3.1-flash-lite.
"""

import logging
import os
import random
import re
import threading
import time

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
    "timeout",
    "timedout",
    "deadline",
)


def _is_retryable(e: Exception) -> bool:
    # Timeout / network stall cũng retry (trước đây chỉ retry 429/503 → treo 40p không được retry).
    if isinstance(e, TimeoutError):
        return True
    msg = str(e).lower()
    if "timeout" in msg or "timed out" in msg or "deadline" in msg:
        return True
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

# Per-key/model cooldowns, shared by all jobs in this backend process. Keep the
# configured model unchanged so switching does not invalidate saved batches.
_QUOTA_FALLBACKS = {"gemini-3.5-flash-lite": "gemini-3.1-flash-lite"}
_quota_lock = threading.Lock()
_quota_cooldowns: dict[tuple[str, str], float] = {}


def _is_quota_exhausted(error: Exception) -> bool:
    message = str(error).lower()
    code = getattr(error, "code", None) or getattr(error, "status_code", None)
    if code is not None and str(code) != "429":
        return False
    exhausted = str(code) == "429" or "resource_exhausted" in message or "quota_exceeded" in message
    return exhausted and "quota" in message and ("exceed" in message or "exhaust" in message)


def _quota_retry_seconds(error: Exception) -> float:
    # google-genai includes structured RetryInfo in response_json; str(error)
    # includes the same object for older SDK versions/wrapped exceptions.
    payload = getattr(error, "response_json", None)
    if isinstance(payload, dict):
        body = payload.get("error")
        body = body if isinstance(body, dict) else payload
        details = body.get("details") or []
        details = details if isinstance(details, list) else []
        for detail in details:
            if isinstance(detail, dict):
                delay = str(detail.get("retryDelay", ""))
                if re.fullmatch(r"\d+(?:\.\d+)?s", delay):
                    return max(1.0, float(delay[:-1]))
    match = re.search(r"retryDelay[\"']?\s*:\s*[\"']?(\d+(?:\.\d+)?)s", str(error))
    if match:
        return max(1.0, float(match.group(1)))
    # No server reset hint: avoid hammering exhausted daily quotas every batch,
    # but retry short-term limits sooner. Nothing is persisted to disk.
    message = str(error).lower()
    return 3600.0 if "perday" in message or "per day" in message else 60.0


def _available_quota_keys(keys: list[str], model: str) -> list[str]:
    now = time.monotonic()
    with _quota_lock:
        for identity, until in list(_quota_cooldowns.items()):
            if until <= now:
                del _quota_cooldowns[identity]
        return [key for key in keys if _quota_cooldowns.get((model, key), 0) <= now]


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


def gemini_call_rotating(fn_factory, *args, _max_attempts: int = 5, _timeout: float | None = None, _cancelled_cb=None, _log_fn=None, **kwargs):
    """Call a Gemini API with automatic key rotation on quota/rate-limit errors.

    `fn_factory(api_key: str, timeout: float | None)` must return the bound
    callable to invoke, e.g. `genai_generate_content_factory`.

    - No keys configured → raises the friendly "set a key" error.
    - Retryable error (429/RESOURCE_EXHAUSTED/QUOTA/...): rotate to the next key
      and retry, up to `_max_attempts` total (each attempt uses a fresh key).
    - Non-retryable errors are raised immediately.
    - `_timeout` (seconds) is forwarded to each `generate_content` call.
    - Quota on gemini-3.5-flash-lite: rotate available keys, then fall back to
      gemini-3.1-flash-lite. Quota-exhausted key/model pairs respect RetryInfo.
      Transient 503/timeouts never trigger model switching.
    """
    keys = configured_gemini_keys()
    if not keys:
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")

    def check_cancelled():
        if _cancelled_cb is not None and _cancelled_cb():
            from app.services.job_utils import JobCancelled
            raise JobCancelled()

    requested_model = kwargs.get("model")
    fallback = _QUOTA_FALLBACKS.get(requested_model)
    models = [requested_model, fallback] if fallback else [requested_model]
    last_err: Exception | None = None
    for model in models:
        announced = False
        for i in range(max(1, _max_attempts)):
            check_cancelled()
            available = _available_quota_keys(keys, model) if fallback else keys
            if not available:
                break
            if model != requested_model and not announced:
                message = f"Gemini: {requested_model} hết quota trên các key vừa thử; chuyển sang {model}."
                logger.warning(message)
                if _log_fn:
                    _log_fn(message, level="warning")
                announced = True
            key = _next_key(available)
            call_kwargs = {**kwargs, "model": model} if model is not None else kwargs
            try:
                fn = fn_factory(key, timeout=_timeout)
                return fn(*args, **call_kwargs)
            except Exception as e:
                check_cancelled()
                last_err = e
                if fallback and _is_quota_exhausted(e):
                    delay = _quota_retry_seconds(e)
                    with _quota_lock:
                        _quota_cooldowns[(model, key)] = time.monotonic() + delay
                    logger.warning("Gemini quota: model %s, key %s — bỏ qua trong %.0fs", model, _mask(key), delay)
                    # Trying the same exhausted model/key after a 2-second sleep
                    # cannot fix a daily quota. Try a different key/model now.
                    continue
                if not _should_retry(e):
                    raise
                if i >= max(1, _max_attempts) - 1:
                    raise
                delay = random.uniform(2, 8)
                logger.info(
                    "Gemini call failed on key %s (attempt %d/%d): %s — rotating key, backoff %.1fs",
                    _mask(key), i + 1, _max_attempts, e, delay,
                )
                time.sleep(delay)
    if last_err is not None:
        raise last_err
    raise RuntimeError("Cả gemini-3.5-flash-lite và gemini-3.1-flash-lite đang hết quota; chờ quota được cấp lại hoặc đổi API key/project.")


def upload_audio_to_gemini(audio_path, mime_type: str = "audio/wav", timeout: float | None = None) -> tuple[str, str]:
    """Upload an audio file to Gemini Files API. Returns (uri, mime_type).

    Uses the first configured Gemini API key. Có timeout để tránh treo.
    """
    from google import genai
    from google.genai import types as genai_types

    keys = configured_gemini_keys()
    if not keys:
        raise ValueError("GEMINI_API_KEY not set.")
    if timeout is None:
        timeout = getattr(settings, "gemini_context_timeout", 300)
    http_options = genai_types.HttpOptions(timeout=int(timeout * 1000))
    client = genai.Client(api_key=keys[0], http_options=http_options)
    uploaded = client.files.upload(file=str(audio_path), config={"mime_type": mime_type})
    return uploaded.uri, uploaded.mime_type


def delete_gemini_file(uri: str, timeout: float | None = None):
    """Delete a file from Gemini Files API by URI."""
    from google import genai
    from google.genai import types as genai_types

    keys = configured_gemini_keys()
    if not keys:
        return
    try:
        if timeout is None:
            timeout = getattr(settings, "gemini_context_timeout", 300)
        http_options = genai_types.HttpOptions(timeout=int(timeout * 1000))
        client = genai.Client(api_key=keys[0], http_options=http_options)
        client.files.delete(name=uri)
    except Exception:
        pass
