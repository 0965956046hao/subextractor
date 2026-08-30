import logging
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

PROFILE_CONFIG_FILE = settings.temp_dir / "profiles.json"


class ProfileCheck(BaseModel):
    exists: bool
    path: str


class ProfilesCheck(BaseModel):
    douyin: ProfileCheck
    chatgpt: ProfileCheck


class ProfileConfig(BaseModel):
    douyin: str = ""
    chatgpt: str = ""


class ProfilesConfigResponse(BaseModel):
    config: ProfileConfig
    resolved: ProfilesCheck


def _read_profile_config() -> dict:
    if PROFILE_CONFIG_FILE.exists():
        try:
            import json
            return json.loads(PROFILE_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _write_profile_config(cfg: dict):
    PROFILE_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    import json
    PROFILE_CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def _resolve_profile_dir(service: str, cfg: dict) -> str:
    env_var = f"{service.upper()}_PROFILE_DIR"
    from_env = settings.__dict__.get(env_var.lower(), "")
    if from_env:
        return from_env
    from_cfg = cfg.get(service)
    if from_cfg:
        return from_cfg
    return str(settings.temp_dir / f"{service}-profile")


@router.get("/api/profiles/check", response_model=ProfilesCheck)
async def profiles_check():
    """Check if Douyin and ChatGPT profiles exist."""
    cfg = _read_profile_config()
    douyin_path = _resolve_profile_dir("douyin", cfg)
    chatgpt_path = _resolve_profile_dir("chatgpt", cfg)
    return {
        "douyin": {"exists": Path(douyin_path).exists(), "path": douyin_path},
        "chatgpt": {"exists": Path(chatgpt_path).exists(), "path": chatgpt_path},
    }


@router.get("/api/profiles/config", response_model=ProfilesConfigResponse)
async def profiles_config():
    """Get current profiles config and resolved paths."""
    cfg = _read_profile_config()
    douyin_path = _resolve_profile_dir("douyin", cfg)
    chatgpt_path = _resolve_profile_dir("chatgpt", cfg)
    return {
        "config": {"douyin": cfg.get("douyin", ""), "chatgpt": cfg.get("chatgpt", "")},
        "resolved": {
            "douyin": {"exists": Path(douyin_path).exists(), "path": douyin_path},
            "chatgpt": {"exists": Path(chatgpt_path).exists(), "path": chatgpt_path},
        },
    }


@router.post("/api/profiles/config")
async def save_profiles_config(body: ProfileConfig):
    """Save profiles config (paths for Douyin and ChatGPT)."""
    cfg = {
        "douyin": body.douyin.strip() if body.douyin else "",
        "chatgpt": body.chatgpt.strip() if body.chatgpt else "",
    }
    _write_profile_config(cfg)
    logger.info("Profiles config saved to %s", PROFILE_CONFIG_FILE)
    return {"status": "ok", "config": cfg}