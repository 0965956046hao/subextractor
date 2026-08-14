import json
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

CONFIG_FILE = settings.temp_dir / "user_config.json"

ALLOWED_LOGO_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
LOGO_DIR = settings.temp_dir / "logo"
LOGO_FILENAME = "watermark_logo"


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


DEFAULT_SUBTITLE_STYLE = {
    "font_family": "Arial",
    "font_size": 48,
    "text_color": "#FFFFFF",
    "outline_color": "#000000",
    "outline_width": 0,
    "bold": False,
    "italic": False,
    "box_enabled": True,
    "box_color": "#000000",
    "box_opacity": 210,
    "box_radius": 12,
    "box_border_color": "#000000",
    "box_border_width": 0,
    "margin_v": 40,
    "margin_h": 0,
}


def get_subtitle_style() -> dict:
    cfg = _read_config()
    stored = cfg.get("subtitle_style") or {}
    merged = {**DEFAULT_SUBTITLE_STYLE, **stored}
    # coerce types so a malformed stored value can't crash the renderer
    for k, v in DEFAULT_SUBTITLE_STYLE.items():
        if k in ("bold", "italic", "box_enabled"):
            merged[k] = bool(merged.get(k, v))
        elif isinstance(v, (int, float)):
            try:
                merged[k] = int(merged.get(k, v))
            except (TypeError, ValueError):
                merged[k] = v
        elif isinstance(v, str):
            merged[k] = str(merged.get(k, v))
    return merged


class SaveConfigRequest(BaseModel):
    gemini_api_key: str = ""
    google_tts_json: str = ""
    auto_context_enabled: bool | None = None
    subtitle_style: dict | None = None
    watermark_text: str | None = None


def _logo_path() -> Path | None:
    """Return the current logo file path, or None if not uploaded yet."""
    cfg = _read_config()
    name = cfg.get("watermark_logo") or ""
    if not name:
        return None
    p = LOGO_DIR / name
    return p if p.exists() else None


def _has_logo() -> bool:
    return _logo_path() is not None


def get_watermark() -> dict:
    """Return the watermark config for burning: {text, logo_path}."""
    cfg = _read_config()
    text = (cfg.get("watermark_text") or "").strip()
    logo = _logo_path()
    return {"text": text, "logo_path": str(logo) if logo else None}


@router.get("/api/config")
async def get_config():
    """Get current user config."""
    cfg = _read_config()

    gemini_key = cfg.get("gemini_api_key", "") or ""
    has_gemini = bool(gemini_key)

    tts_raw = cfg.get("google_tts_credentials", "") or ""
    has_tts = bool(tts_raw)
    tts_json = ""
    tts_info = ""
    if has_tts:
        try:
            parsed = json.loads(tts_raw) if isinstance(tts_raw, str) else tts_raw
            if isinstance(parsed, dict):
                tts_json = json.dumps(parsed, ensure_ascii=False, indent=2)
                tts_info = parsed.get("client_email", "") or ""
        except Exception:
            tts_json = tts_raw if isinstance(tts_raw, str) else ""

    return {
        "has_gemini_key": has_gemini,
        "gemini_api_key": gemini_key,
        "has_tts_credentials": has_tts,
        "google_tts_credentials": tts_json,
        "tts_credentials_info": tts_info,
        "auto_context_enabled": cfg.get("auto_context_enabled", True),
        "subtitle_style": get_subtitle_style(),
        "watermark_text": cfg.get("watermark_text", ""),
        "has_watermark_logo": _has_logo(),
        "watermark_logo_name": (cfg.get("watermark_logo") or "") if _has_logo() else "",
    }


@router.post("/api/config")
async def save_config(body: SaveConfigRequest):
    """Save Gemini API key, Google TTS credentials and/or subtitle style."""
    cfg = _read_config()

    if body.gemini_api_key:
        cfg["gemini_api_key"] = body.gemini_api_key

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

    if body.watermark_text is not None:
        cfg["watermark_text"] = body.watermark_text.strip()

    if body.subtitle_style is not None:
        merged = get_subtitle_style()
        merged.update(body.subtitle_style)
        cfg["subtitle_style"] = merged

    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("User config saved to %s", CONFIG_FILE)
    return {"status": "ok", "saved": list(cfg.keys())}


@router.post("/api/config/logo")
async def upload_logo(file: UploadFile = File(...)):
    """Upload a watermark logo image. Stored under temp/logo/, not wiped by temp clear."""
    if not file.filename:
        raise HTTPException(400, "No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_LOGO_EXTS:
        raise HTTPException(400, f"Unsupported image type: {ext or '(none)'}")

    # Remove any previous logo, then save the new one under a stable name.
    cfg = _read_config()
    old_name = cfg.get("watermark_logo") or ""
    if old_name:
        (LOGO_DIR / old_name).unlink(missing_ok=True)

    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    new_name = f"{LOGO_FILENAME}{ext}"
    dest = LOGO_DIR / new_name

    try:
        with open(dest, "wb") as f:
            while chunk := await file.read(64 * 1024):
                f.write(chunk)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"Logo upload failed: {e}")

    cfg["watermark_logo"] = new_name
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Watermark logo uploaded to %s", dest)
    return {"status": "ok", "watermark_logo_name": new_name}


@router.get("/api/config/logo")
async def get_logo():
    """Serve the uploaded watermark logo image."""
    path = _logo_path()
    if not path:
        raise HTTPException(404, "No logo uploaded")
    return FileResponse(path)


@router.delete("/api/config/logo")
async def delete_logo():
    """Remove the uploaded watermark logo."""
    cfg = _read_config()
    old_name = cfg.get("watermark_logo") or ""
    if old_name:
        (LOGO_DIR / old_name).unlink(missing_ok=True)
    cfg.pop("watermark_logo", None)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "removed": True}
