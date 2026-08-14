import json
import logging
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

CONFIG_FILE = settings.temp_dir / "user_config.json"


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


class SaveConfigRequest(BaseModel):
    gemini_api_key: str = ""
    google_tts_json: str = ""
    fal_key: str = ""
    auto_context_enabled: bool | None = None


@router.get("/api/config")
async def get_config():
    """Get current user config (without sensitive full values)."""
    cfg = _read_config()
    return {
        "has_gemini_key": bool(cfg.get("gemini_api_key")),
        "has_tts_credentials": bool(cfg.get("google_tts_credentials")),
        "has_fal_key": bool(cfg.get("fal_key")),
        "auto_context_enabled": cfg.get("auto_context_enabled", True),
    }


@router.post("/api/config")
async def save_config(body: SaveConfigRequest):
    """Save Gemini API key, Google TTS credentials and/or fal.ai key."""
    cfg = _read_config()

    if body.gemini_api_key:
        cfg["gemini_api_key"] = body.gemini_api_key

    if body.fal_key:
        cfg["fal_key"] = body.fal_key

    if body.google_tts_json:
        # Validate it's a valid service account JSON
        try:
            parsed = json.loads(body.google_tts_json)
            if isinstance(parsed, dict) and parsed.get("type") != "service_account":
                return {"error": "JSON không phải Service Account key. Cần 'type': 'service_account'."}
        except json.JSONDecodeError:
            return {"error": "JSON không hợp lệ."}
        cfg["google_tts_credentials"] = body.google_tts_json

    if body.auto_context_enabled is not None:
        cfg["auto_context_enabled"] = body.auto_context_enabled

    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("User config saved to %s", CONFIG_FILE)
    return {"status": "ok", "saved": list(cfg.keys())}
