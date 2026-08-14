"""Health checks for pipeline prerequisites (Gemini API key + Google TTS).

These do REAL verification (not just "key present"): Gemini actually makes a
tiny model call, Google TTS actually constructs a client and lists voices.
"""

import json
import logging
import os
from pathlib import Path

from app.config import settings
from app.services.retry_utils import gemini_retry

logger = logging.getLogger(__name__)


def _read_user_config() -> dict:
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _resolve_gemini_key() -> str:
    return (
        settings.gemini_api_key
        or os.environ.get("GEMINI_API_KEY", "")
        or _read_user_config().get("gemini_api_key", "")
    )


def _resolve_tts_credentials() -> str:
    env_creds = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if env_creds and os.path.isfile(env_creds):
        try:
            env_creds = Path(env_creds).read_text(encoding="utf-8")
        except Exception:
            env_creds = ""
    creds = (
        settings.google_tts_credentials
        or env_creds
        or _read_user_config().get("google_tts_credentials", "")
    )
    if isinstance(creds, dict):
        return json.dumps(creds, ensure_ascii=False)
    return creds or ""


def check_gemini() -> dict:
    """Verify the configured Gemini API key actually works."""
    key = _resolve_gemini_key()
    if not key:
        return {
            "service": "gemini",
            "configured": False,
            "healthy": False,
            "message": "Chưa nhập Gemini API key (Settings ⚙️)",
        }

    try:
        from google import genai

        client = genai.Client(api_key=key)
        resp = gemini_retry(client.models.generate_content)(
            model=settings.gemini_model,
            contents="Reply with exactly: OK",
        )
        # The key is valid if the call succeeded; text may be empty when the
        # model finishes on MAX_TOKENS. Treat a non-exception response as healthy.
        got_response = resp is not None and (getattr(resp, "text", "") or getattr(resp, "candidates", None))
        return {
            "service": "gemini",
            "configured": True,
            "healthy": got_response,
            "message": "Gemini API hoạt động bình thường" if got_response else "Gemini phản hồi trống (kiểm tra lại model)",
        }
    except Exception as e:
        logger.warning("Gemini health check failed: %s", e)
        return {
            "service": "gemini",
            "configured": True,
            "healthy": False,
            "message": f"Gemini API lỗi: {e}",
        }


def check_tts() -> dict:
    """Verify the configured Google TTS service account credentials work."""
    creds_json = _resolve_tts_credentials()
    if not creds_json:
        return {
            "service": "tts",
            "configured": False,
            "healthy": False,
            "message": "Chưa nhập Google TTS Service Account (Settings ⚙️)",
        }

    # Validate JSON shape early
    try:
        parsed = json.loads(creds_json)
    except json.JSONDecodeError:
        return {
            "service": "tts",
            "configured": True,
            "healthy": False,
            "message": "Google TTS credentials không phải JSON hợp lệ",
        }
    if parsed.get("type") != "service_account":
        return {
            "service": "tts",
            "configured": True,
            "healthy": False,
            "message": "Google TTS credentials không phải Service Account (cần 'type': 'service_account')",
        }

    try:
        from google.cloud import texttospeech
        from google.oauth2 import service_account

        creds = service_account.Credentials.from_service_account_info(parsed)
        client = texttospeech.TextToSpeechClient(credentials=creds)
        voices = client.list_voices(language_code="vi-VN")
        count = len(voices.voices) if voices else 0
        return {
            "service": "tts",
            "configured": True,
            "healthy": True,
            "message": f"Google TTS hoạt động ({count} giọng tiếng Việt)",
        }
    except Exception as e:
        logger.warning("TTS health check failed: %s", e)
        return {
            "service": "tts",
            "configured": True,
            "healthy": False,
            "message": f"Google TTS lỗi: {e}",
        }


def check_capcut() -> dict:
    """Verify the CapCut TTS gen-voice service is reachable."""
    from app.services.capcut_tts_client import check_health

    h = check_health()
    if not h.get("healthy"):
        return {
            "service": "capcut",
            "configured": False,
            "healthy": False,
            "message": "CapCut TTS service không chạy (cần khởi động port 8100)",
        }
    return {
        "service": "capcut",
        "configured": True,
        "healthy": True,
        "message": f"CapCut TTS service hoạt động ({h.get('voices_loaded', 0)} giọng)",
    }


def pipeline_health() -> dict:
    """Check all prerequisites for the AutoPipeline and report readiness."""
    gemini = check_gemini()
    tts = check_tts()
    capcut = check_capcut()
    checks = [gemini, tts, capcut]
    # Pipeline cần Gemini (translate) + ít nhất 1 engine lồng tiếng sẵn sàng.
    dub_ready = tts["healthy"] or capcut["healthy"]
    return {
        "healthy": gemini["healthy"] and dub_ready,
        "checks": checks,
        "dub_engines": {"google": tts["healthy"], "capcut": capcut["healthy"]},
    }