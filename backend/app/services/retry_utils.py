"""Gemini retries with shared concurrency, request spacing and 429 cooldown.

Both fixed-key calls and rotating-key calls use the same in-process gate.
Keys belonging to one project do not bypass its shared quota by rotating.
"""

import logging
import os
import random
import threading
import time
import re
from contextlib import contextmanager
from functools import wraps

from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_random_exponential,
)

from app.config import settings
from app.services.job_utils import JobCancelled

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
    if _is_rate_limited(e):
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


_retry_policy = retry(
    wait=wait_random_exponential(min=2, max=10),
    stop=stop_after_attempt(5),
    retry=retry_if_exception(_should_retry),
    reraise=True,
)


def _is_rate_limited(error: Exception) -> bool:
    code = getattr(error, "code", None) or getattr(error, "status_code", None)
    normalized = re.sub(r"[^a-z0-9]", "", str(error).lower())
    return str(code) == "429" or any(h in normalized for h in (
        "resourceexhausted", "quotaexceeded", "ratelimit", "429",
    ))


def _retry_after_seconds(error: Exception) -> float:
    """Honor Gemini RetryInfo and HTTP Retry-After when supplied."""
    headers = getattr(getattr(error, "response", None), "headers", {}) or {}
    value = headers.get("Retry-After") or headers.get("retry-after")
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        if value:
            from email.utils import parsedate_to_datetime
            try:
                return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                pass
    match = re.search(r"retryDelay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", str(error))
    return float(match.group(1)) if match else 0.0


class _GeminiGate:
    """One in-flight request + project-wide spacing/cooldown across all keys."""

    def __init__(self):
        self.condition = threading.Condition()
        self.busy = False
        self.next_at = 0.0
        self.rate_failures = 0

    @contextmanager
    def slot(self, log_fn=None, cancelled_cb=None):
        last_log = -float("inf")
        with self.condition:
            while True:
                if cancelled_cb and cancelled_cb():
                    raise JobCancelled()
                now = time.monotonic()
                remaining = self.next_at - now
                if not self.busy and remaining <= 0:
                    self.busy = True
                    self.next_at = now + settings.gemini_min_interval
                    break
                if log_fn and now - last_log >= 30:
                    message = (f"Gemini: đang chờ giới hạn gọi API, còn khoảng {max(1, int(remaining + 1))} giây."
                               if remaining > 0 else "Gemini: đang chờ lượt gọi API từ video khác...")
                    log_fn(message)
                    last_log = now
                self.condition.wait(timeout=0.5)
        try:
            yield
        except Exception as error:
            if _is_rate_limited(error):
                with self.condition:
                    self.rate_failures += 1
                    base = min(300.0, settings.gemini_rate_limit_cooldown * 2 ** min(self.rate_failures - 1, 10))
                    delay = max(_retry_after_seconds(error), base + random.uniform(0, base * 0.2))
                    self.next_at = max(self.next_at, time.monotonic() + delay)
                logger.warning("Gemini 429: shared cooldown %.1fs for all jobs/keys", delay)
                if log_fn:
                    log_fn(f"Gemini bị giới hạn quota/tốc độ (429). Tạm nghỉ chung {int(delay + 1)} giây trước khi thử lại.", level="warning")
            raise
        else:
            with self.condition:
                self.rate_failures = 0
        finally:
            with self.condition:
                self.busy = False
                self.condition.notify_all()


_gemini_gate = _GeminiGate()


def gemini_retry(fn):
    """Fixed-key calls (e.g. uploaded-file chat) share the same Gemini gate."""
    @wraps(fn)
    def guarded(*args, **kwargs):
        with _gemini_gate.slot():
            return fn(*args, **kwargs)
    return _retry_policy(guarded)


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
_key_model_index = 0


def configured_gemini_models(primary: str | None = None) -> list[str]:
    """Keep the configured primary first, then rotate through fallback models."""
    return list(dict.fromkeys(
        model.strip() for model in [primary or settings.gemini_model, *settings.gemini_models]
        if isinstance(model, str) and model.strip()
    ))


def _next_key_model(keys: list[str], models: list[str]) -> tuple[str, str]:
    """Visit every key/model pair; independent round robins can skip pairs."""
    global _key_model_index
    with _key_lock:
        index = _key_model_index
        _key_model_index += 1
        return keys[(index // len(models)) % len(keys)], models[index % len(models)]


def _is_model_unavailable(error: Exception) -> bool:
    code = getattr(error, "code", None) or getattr(error, "status_code", None)
    message = str(error).lower()
    return str(code) == "404" or (
        str(code) == "400" and "model" in message
        and any(hint in message for hint in ("not supported", "not found", "unsupported"))
    )


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

    http_options = genai_types.HttpOptions(
        timeout=int(timeout * 1000) if timeout is not None else None,
        retry_options=genai_types.HttpRetryOptions(attempts=1),
    )
    client = genai.Client(api_key=key, http_options=http_options)

    def _call(*args, **kwargs):
        return client.models.generate_content(*args, **kwargs)

    return _call


def gemini_call_rotating(fn_factory, *args, _max_attempts: int = 5, _timeout: float | None = None, _log_fn=None, _cancelled_cb=None, _keys=None, **kwargs):
    """Call Gemini with round-robin key/model pairs and bounded retries.

    `fn_factory(api_key: str, timeout: float | None)` must return the bound
    callable to invoke, e.g. `genai_generate_content_factory`.

    - No keys configured → raises the friendly "set a key" error.
    - Cycle models first, then advance the key; successful requests also rotate.
    - Retryable errors advance to the next pair, up to `_max_attempts` total.
    - Unavailable models are skipped for this call; other permanent errors fail.
    - `_keys` pins uploaded-file operations to the key owning their files.
    - `_timeout` (seconds) is forwarded to each `generate_content` call.
    """
    keys = list(_keys) if _keys is not None else configured_gemini_keys()
    if not keys:
        raise ValueError("GEMINI_API_KEY not set. Vào Settings (⚙️) để nhập key.")
    models = configured_gemini_models(kwargs.get("model")) if "model" in kwargs else []

    last_err: Exception | None = None
    for i in range(_max_attempts):
        key, model = _next_key_model(keys, models) if models else (_next_key(keys), None)
        call_kwargs = {**kwargs, "model": model} if model else kwargs
        try:
            with _gemini_gate.slot(_log_fn, _cancelled_cb):
                if model and _log_fn:
                    _log_fn(f"Gemini: dùng model {model} (lượt {i + 1}/{_max_attempts}).")
                fn = fn_factory(key, timeout=_timeout)
                return fn(*args, **call_kwargs)
        except Exception as e:
            last_err = e
            model_unavailable = bool(model) and _is_model_unavailable(e)
            if not model_unavailable and not _should_retry(e):
                raise
            if model_unavailable and model in models:
                models.remove(model)
                if not models:
                    raise
                if _log_fn:
                    _log_fn(f"Model {model} không khả dụng; chuyển sang model khác.", level="warning")
            if i < _max_attempts - 1:
                delay = random.uniform(2, 8)
                logger.info(
                    "Gemini call failed on key %s, model %s (attempt %d/%d): %s — rotating key/model, backoff %.1fs",
                    _mask(key), model or "fixed", i + 1, _max_attempts, e, delay,
                )
                end = time.monotonic() + delay
                while time.monotonic() < end:
                    if _cancelled_cb and _cancelled_cb():
                        raise JobCancelled()
                    time.sleep(min(0.5, max(0, end - time.monotonic())))
    raise last_err  # type: ignore[misc]


def gemini_chat_rotating(contents, config=None, *, client=None, api_key=None, **options):
    """Rotate chat models; pin the key when reusing key-scoped uploaded files."""
    def factory(key, timeout=None):
        chat_client = client
        if chat_client is None:
            from google import genai
            from google.genai import types
            chat_client = genai.Client(api_key=key, http_options=types.HttpOptions(
                timeout=int(timeout * 1000) if timeout is not None else None,
                retry_options=types.HttpRetryOptions(attempts=1),
            ))

        def call(model, contents, config=None):
            return chat_client.chats.create(model=model).send_message(contents, config=config)
        return call

    if client is not None and not api_key:
        raise ValueError("A reused Gemini client requires its upload API key.")
    return gemini_call_rotating(
        factory,
        model=settings.gemini_model,
        contents=contents,
        config=config,
        _keys=[api_key] if api_key else None,
        **options,
    )


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
