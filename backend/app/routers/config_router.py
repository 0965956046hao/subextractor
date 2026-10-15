import json
import logging
import shutil
import uuid
from datetime import datetime
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


def _write_config(cfg: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


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
    gemini_api_keys: list[str] | None = None
    google_tts_json: str = ""
    fal_key: str = ""
    auto_context_enabled: bool | None = None
    channel_watch_enabled: bool | None = None
    subtitle_style: dict | None = None
    watermark_text: str | None = None


class WatermarkPresetCreate(BaseModel):
    name: str = ""
    text: str = ""


class WatermarkPresetUpdate(BaseModel):
    name: str | None = None
    text: str | None = None


class PipelinePresetCreate(BaseModel):
    name: str = ""
    config: dict = {}


class PipelinePresetUpdate(BaseModel):
    name: str | None = None
    config: dict | None = None


# ── Watermark presets (mỗi bộ = 1 cặp text + logo) ──

DEFAULT_PRESET_NAME = "Bộ mặc định"


def _migrate_presets(cfg: dict) -> dict:
    """Upgrade old single watermark (watermark_text/watermark_logo) to presets."""
    if not cfg.get("watermark_presets"):
        legacy_text = (cfg.get("watermark_text") or "").strip()
        legacy_logo = cfg.get("watermark_logo") or ""
        preset = {
            "id": "default",
            "name": DEFAULT_PRESET_NAME,
            "text": legacy_text,
            "logo_file": legacy_logo,
        }
        cfg["watermark_presets"] = [preset]
        cfg["active_watermark_preset"] = "default"
        for k in ("watermark_text", "watermark_logo"):
            cfg.pop(k, None)
        _write_config(cfg)
    elif not cfg.get("active_watermark_preset") and cfg.get("watermark_presets"):
        cfg["active_watermark_preset"] = cfg["watermark_presets"][0]["id"]
        _write_config(cfg)
    return cfg


def _presets() -> list[dict]:
    cfg = _migrate_presets(_read_config())
    return cfg.get("watermark_presets") or []


def _preset(preset_id: str) -> dict | None:
    return next((p for p in _presets() if p.get("id") == preset_id), None)


def _pipeline_presets() -> list[dict]:
    """All saved pipeline configuration presets (each: {id, name, config})."""
    cfg = _read_config()
    return cfg.get("pipeline_presets") or []


def _active_preset_id(cfg: dict | None = None) -> str:
    cfg = cfg or _migrate_presets(_read_config())
    active = cfg.get("active_watermark_preset")
    if active and _preset(active):
        return active
    presets = cfg.get("watermark_presets") or []
    return presets[0]["id"] if presets else ""


def _preset_logo_path(preset_id: str) -> Path | None:
    p = _preset(preset_id)
    if not p or not p.get("logo_file"):
        return None
    path = LOGO_DIR / p["logo_file"]
    return path if path.exists() else None


def _gemini_keys(cfg: dict | None = None) -> list[str]:
    """All configured Gemini API keys (legacy single + list, deduped)."""
    cfg = cfg if cfg is not None else _read_config()
    keys: list[str] = []
    for k in (cfg.get("gemini_api_keys") or []):
        if isinstance(k, str) and k.strip():
            keys.append(k.strip())
    legacy = (cfg.get("gemini_api_key") or "").strip()
    if legacy and legacy not in keys:
        keys.append(legacy)
    return keys


def get_watermark(preset_id: str | None = None) -> dict:
    """Return the watermark config for burning: {text, logo_path, preset_id}.

    If preset_id is omitted, the active watermark preset is used.
    """
    cfg = _migrate_presets(_read_config())
    pid = preset_id or _active_preset_id(cfg)
    p = _preset(pid)
    if not p:
        return {"text": "", "logo_path": None, "preset_id": pid}
    logo = _preset_logo_path(pid)
    return {
        "text": (p.get("text") or "").strip(),
        "logo_path": str(logo) if logo else None,
        "preset_id": pid,
    }


@router.get("/api/config")
async def get_config():
    """Get current user config."""
    cfg = _read_config()

    gemini_keys = _gemini_keys(cfg)
    gemini_key = gemini_keys[0] if gemini_keys else ""
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

    presets = _presets()
    return {
        "has_gemini_key": has_gemini,
        "gemini_api_key": gemini_key,
        "gemini_api_keys": gemini_keys,
        "has_tts_credentials": has_tts,
        "google_tts_credentials": tts_json,
        "tts_credentials_info": tts_info,
        "has_fal_key": bool(cfg.get("fal_key")),
        "fal_key": cfg.get("fal_key", ""),
        "auto_context_enabled": cfg.get("auto_context_enabled", True),
        "channel_watch_enabled": cfg.get("channel_watch_enabled", False),
        "subtitle_style": get_subtitle_style(),
        "watermark_text": get_watermark().get("text", ""),
        "has_watermark_logo": bool(_preset_logo_path(_active_preset_id(cfg))),
        "watermark_logo_name": (_preset(_active_preset_id(cfg)) or {}).get("logo_file", ""),
        "watermark_presets": [
            {
                "id": p["id"],
                "name": p.get("name") or DEFAULT_PRESET_NAME,
                "text": p.get("text") or "",
                "has_logo": bool(_preset_logo_path(p["id"])),
                "logo_name": p.get("logo_file") or "",
                "active": p["id"] == _active_preset_id(cfg),
            }
            for p in presets
        ],
        "active_watermark_preset": _active_preset_id(cfg),
        "pipeline_presets": cfg.get("pipeline_presets") or [],
    }


@router.post("/api/config")
async def save_config(body: SaveConfigRequest):
    """Save Gemini API key, Google TTS credentials and/or subtitle style."""
    cfg = _read_config()

    if body.gemini_api_keys is not None:
        keys = [k.strip() for k in body.gemini_api_keys if isinstance(k, str) and k.strip()]
        if keys:
            cfg["gemini_api_keys"] = keys
            cfg["gemini_api_key"] = keys[0]
        else:
            # Clear all keys.
            cfg["gemini_api_keys"] = []
            cfg["gemini_api_key"] = ""
    elif body.gemini_api_key:
        keys = _gemini_keys(cfg)
        cfg["gemini_api_key"] = body.gemini_api_key
        if body.gemini_api_key not in keys:
            cfg["gemini_api_keys"] = [body.gemini_api_key] + [k for k in keys if k != body.gemini_api_key]
        else:
            cfg["gemini_api_keys"] = keys

    if body.fal_key is not None:
        cfg["fal_key"] = body.fal_key.strip()

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

    if body.channel_watch_enabled is not None:
        cfg["channel_watch_enabled"] = body.channel_watch_enabled

    if body.watermark_text is not None:
        cfg = _migrate_presets(cfg)
        active_id = _active_preset_id(cfg)
        for p in cfg.get("watermark_presets") or []:
            if p["id"] == active_id:
                p["text"] = body.watermark_text.strip()
                break

    if body.subtitle_style is not None:
        merged = get_subtitle_style()
        merged.update(body.subtitle_style)
        cfg["subtitle_style"] = merged

    _write_config(cfg)
    logger.info("User config saved to %s", CONFIG_FILE)
    return {"status": "ok", "saved": list(cfg.keys())}


# ── Pipeline config presets ──

@router.get("/api/config/pipeline-presets")
async def list_pipeline_presets():
    """List saved pipeline configuration presets."""
    cfg = _read_config()
    return {"presets": cfg.get("pipeline_presets") or []}


@router.post("/api/config/pipeline-presets")
async def create_pipeline_preset(body: PipelinePresetCreate):
    """Save the current pipeline config under a name."""
    cfg = _read_config()
    presets = cfg.setdefault("pipeline_presets", [])
    preset_id = f"pp_{uuid.uuid4().hex[:8]}"
    name = (body.name or "").strip() or f"Preset {len(presets) + 1}"
    preset = {
        "id": preset_id,
        "name": name,
        "config": body.config if isinstance(body.config, dict) else {},
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    presets.append(preset)
    _write_config(cfg)
    return {"id": preset_id, "name": name}


@router.put("/api/config/pipeline-presets/{preset_id}")
async def update_pipeline_preset(preset_id: str, body: PipelinePresetUpdate):
    """Overwrite a preset's config (and/or rename) — used for auto-save on run."""
    cfg = _read_config()
    presets = cfg.get("pipeline_presets") or []
    for p in presets:
        if p.get("id") == preset_id:
            if body.name is not None and body.name.strip():
                p["name"] = body.name.strip()
            if body.config is not None and isinstance(body.config, dict):
                p["config"] = body.config
            _write_config(cfg)
            return {"status": "ok", "id": preset_id}
    raise HTTPException(status_code=404, detail="Preset not found")


@router.delete("/api/config/pipeline-presets/{preset_id}")
async def delete_pipeline_preset(preset_id: str):
    """Delete a saved pipeline preset by id."""
    cfg = _read_config()
    presets = cfg.get("pipeline_presets") or []
    new = [p for p in presets if p.get("id") != preset_id]
    if len(new) == len(presets):
        raise HTTPException(status_code=404, detail="Preset not found")
    cfg["pipeline_presets"] = new
    _write_config(cfg)
    return {"status": "ok", "removed": True}


@router.post("/api/config/watermark/presets")
async def create_watermark_preset(body: WatermarkPresetCreate):
    """Create a new watermark preset (a text+logo pair)."""
    cfg = _migrate_presets(_read_config())
    preset_id = f"wm_{uuid.uuid4().hex[:8]}"
    presets = cfg.setdefault("watermark_presets", [])
    presets.append({
        "id": preset_id,
        "name": (body.name or "").strip() or f"Bộ {len(presets) + 1}",
        "text": (body.text or "").strip(),
        "logo_file": "",
    })
    _write_config(cfg)
    return {"status": "ok", "preset_id": preset_id}


@router.put("/api/config/watermark/presets/{preset_id}")
async def update_watermark_preset(preset_id: str, body: WatermarkPresetUpdate):
    """Update a watermark preset's name and/or text."""
    cfg = _migrate_presets(_read_config())
    for p in cfg.get("watermark_presets") or []:
        if p["id"] == preset_id:
            if body.name is not None:
                p["name"] = body.name.strip() or p.get("name") or DEFAULT_PRESET_NAME
            if body.text is not None:
                p["text"] = body.text.strip()
            _write_config(cfg)
            return {"status": "ok"}
    raise HTTPException(404, "Preset not found")


@router.delete("/api/config/watermark/presets/{preset_id}")
async def delete_watermark_preset(preset_id: str):
    """Delete a watermark preset and its logo file."""
    cfg = _migrate_presets(_read_config())
    presets = cfg.get("watermark_presets") or []
    p = next((x for x in presets if x["id"] == preset_id), None)
    if not p:
        raise HTTPException(404, "Preset not found")
    if p.get("logo_file"):
        (LOGO_DIR / p["logo_file"]).unlink(missing_ok=True)
    cfg["watermark_presets"] = [x for x in presets if x["id"] != preset_id]
    if cfg.get("active_watermark_preset") == preset_id:
        remaining = cfg["watermark_presets"]
        cfg["active_watermark_preset"] = remaining[0]["id"] if remaining else ""
    _write_config(cfg)
    return {"status": "ok", "removed": True}


@router.post("/api/config/watermark/active")
async def set_active_watermark_preset(body: dict):
    """Set which watermark preset is used by default."""
    preset_id = (body or {}).get("preset_id") or ""
    if not _preset(preset_id):
        raise HTTPException(404, "Preset not found")
    cfg = _migrate_presets(_read_config())
    cfg["active_watermark_preset"] = preset_id
    _write_config(cfg)
    return {"status": "ok", "active_watermark_preset": preset_id}


@router.post("/api/config/watermark/presets/{preset_id}/logo")
async def upload_preset_logo(preset_id: str, file: UploadFile = File(...)):
    """Upload a watermark logo for a specific preset."""
    if not _preset(preset_id):
        raise HTTPException(404, "Preset not found")
    if not file.filename:
        raise HTTPException(400, "No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_LOGO_EXTS:
        raise HTTPException(400, f"Unsupported image type: {ext or '(none)'}")

    cfg = _migrate_presets(_read_config())
    for p in cfg.get("watermark_presets") or []:
        if p["id"] != preset_id:
            continue
        old_name = p.get("logo_file") or ""
        if old_name:
            (LOGO_DIR / old_name).unlink(missing_ok=True)
        LOGO_DIR.mkdir(parents=True, exist_ok=True)
        new_name = f"{LOGO_FILENAME}_{preset_id}{ext}"
        dest = LOGO_DIR / new_name
        try:
            with open(dest, "wb") as f:
                while chunk := await file.read(64 * 1024):
                    f.write(chunk)
        except Exception as e:
            dest.unlink(missing_ok=True)
            raise HTTPException(500, f"Logo upload failed: {e}")
        p["logo_file"] = new_name
        _write_config(cfg)
        logger.info("Watermark logo uploaded for preset %s → %s", preset_id, dest)
        return {"status": "ok", "watermark_logo_name": new_name}
    raise HTTPException(404, "Preset not found")


@router.get("/api/config/watermark/presets/{preset_id}/logo")
async def get_preset_logo(preset_id: str):
    """Serve a watermark preset's logo image."""
    path = _preset_logo_path(preset_id)
    if not path:
        raise HTTPException(404, "No logo uploaded")
    return FileResponse(path)


@router.delete("/api/config/watermark/presets/{preset_id}/logo")
async def delete_preset_logo(preset_id: str):
    """Remove a watermark preset's logo."""
    cfg = _migrate_presets(_read_config())
    for p in cfg.get("watermark_presets") or []:
        if p["id"] == preset_id:
            if p.get("logo_file"):
                (LOGO_DIR / p["logo_file"]).unlink(missing_ok=True)
            p["logo_file"] = ""
            _write_config(cfg)
            return {"status": "ok", "removed": True}
    raise HTTPException(404, "Preset not found")


# ── YouTube channels (multi-account) ──

YOUTUBE_CHANNELS_DIR = settings.temp_dir / "youtube_channels"


class YouTubeChannelCreate(BaseModel):
    name: str = ""
    client_secrets: str = ""


class YouTubeChannelUpdate(BaseModel):
    name: str | None = None
    client_secrets: str | None = None


def _yt_channel_dir(channel_id: str) -> Path:
    return YOUTUBE_CHANNELS_DIR / channel_id


def _yt_channels(cfg: dict | None = None) -> list[dict]:
    cfg = cfg or _read_config()
    return cfg.get("youtube_channels") or []


def _yt_channel(channel_id: str, cfg: dict | None = None) -> dict | None:
    return next((c for c in _yt_channels(cfg) if c["id"] == channel_id), None)


def _yt_channel_token_path(channel_id: str) -> Path:
    return _yt_channel_dir(channel_id) / "request.token"


def _yt_channel_secrets_path(channel_id: str) -> Path:
    return _yt_channel_dir(channel_id) / "client_secrets.json"


@router.get("/api/config/youtube-channels")
async def list_youtube_channels():
    """List all saved YouTube channel credentials."""
    cfg = _read_config()
    channels = _yt_channels(cfg)
    result = []
    for ch in channels:
        token_path = _yt_channel_token_path(ch["id"])
        result.append({
            "id": ch["id"],
            "name": ch.get("name") or "YouTube Channel",
            "has_client_secrets": bool(ch.get("client_secrets")),
            "has_request_token": token_path.exists(),
            "created_at": ch.get("created_at", ""),
        })
    return {"channels": result}


@router.post("/api/config/youtube-channels")
async def create_youtube_channel(body: YouTubeChannelCreate):
    """Create a new YouTube channel credential entry."""
    cfg = _read_config()
    channels = cfg.setdefault("youtube_channels", [])

    channel_id = f"yt_{uuid.uuid4().hex[:8]}"
    name = (body.name or "").strip() or f"Channel {len(channels) + 1}"

    entry = {
        "id": channel_id,
        "name": name,
        "client_secrets": (body.client_secrets or "").strip(),
        "created_at": uuid.uuid4().hex[:4],  # short tag
    }
    channels.append(entry)

    # Write client_secrets.json to channel directory if provided
    ch_dir = _yt_channel_dir(channel_id)
    ch_dir.mkdir(parents=True, exist_ok=True)
    if entry["client_secrets"]:
        try:
            json.loads(entry["client_secrets"])
            (ch_dir / "client_secrets.json").write_text(
                entry["client_secrets"], encoding="utf-8"
            )
        except json.JSONDecodeError:
            pass

    _write_config(cfg)
    return {"status": "ok", "channel_id": channel_id, "name": name}


@router.put("/api/config/youtube-channels/{channel_id}")
async def update_youtube_channel(channel_id: str, body: YouTubeChannelUpdate):
    """Update a YouTube channel's name and/or client_secrets."""
    cfg = _read_config()
    ch = _yt_channel(channel_id, cfg)
    if not ch:
        raise HTTPException(404, "Channel not found")

    if body.name is not None:
        ch["name"] = body.name.strip() or ch.get("name") or "YouTube Channel"

    if body.client_secrets is not None:
        content = body.client_secrets.strip()
        ch["client_secrets"] = content
        ch_dir = _yt_channel_dir(channel_id)
        ch_dir.mkdir(parents=True, exist_ok=True)
        if content:
            try:
                json.loads(content)
                (ch_dir / "client_secrets.json").write_text(
                    content, encoding="utf-8"
                )
            except json.JSONDecodeError:
                pass
        else:
            (ch_dir / "client_secrets.json").unlink(missing_ok=True)

    _write_config(cfg)
    return {"status": "ok"}


@router.delete("/api/config/youtube-channels/{channel_id}")
async def delete_youtube_channel(channel_id: str):
    """Delete a YouTube channel and its files."""
    cfg = _read_config()
    channels = cfg.get("youtube_channels") or []
    ch = next((c for c in channels if c["id"] == channel_id), None)
    if not ch:
        raise HTTPException(404, "Channel not found")

    # Remove channel directory
    ch_dir = _yt_channel_dir(channel_id)
    if ch_dir.exists():
        shutil.rmtree(ch_dir, ignore_errors=True)

    cfg["youtube_channels"] = [c for c in channels if c["id"] != channel_id]
    _write_config(cfg)
    return {"status": "ok", "removed": True}


@router.post("/api/config/youtube-channels/{channel_id}/activate")
async def activate_youtube_channel(channel_id: str):
    """Set a channel as active — copies its secrets to the default youtubeuploader dir."""
    cfg = _read_config()
    ch = _yt_channel(channel_id, cfg)
    if not ch:
        raise HTTPException(404, "Channel not found")
    cfg["active_youtube_channel"] = channel_id
    _write_config(cfg)
    return {"status": "ok", "active_youtube_channel": channel_id}


@router.get("/api/config/youtube-channels/{channel_id}")
async def get_youtube_channel_detail(channel_id: str):
    """Get a single channel's details including client_secrets content."""
    cfg = _read_config()
    ch = _yt_channel(channel_id, cfg)
    if not ch:
        raise HTTPException(404, "Channel not found")
    token_path = _yt_channel_token_path(channel_id)
    return {
        "id": ch["id"],
        "name": ch.get("name") or "YouTube Channel",
        "client_secrets": ch.get("client_secrets") or "",
        "has_client_secrets": bool(ch.get("client_secrets")),
        "has_request_token": token_path.exists(),
    }


# ── YouTube OAuth connect (lấy lại request.token khi hết hạn/thu hồi) ──

YT_OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtubepartner",
    "https://www.googleapis.com/auth/youtube",
]


def _yt_oauth_app_cfg(channel_id: str) -> tuple[dict, str]:
    """Parse client_secrets của kênh → (app_cfg, redirect_uri).

    Raises HTTPException khi thiếu/sai định dạng credentials.
    """
    cfg = _read_config()
    ch = _yt_channel(channel_id, cfg)
    if not ch:
        raise HTTPException(404, "Channel not found")
    raw = (ch.get("client_secrets") or "").strip()
    if not raw:
        raise HTTPException(400, "Kênh chưa có client_secrets.json. Hãy dán credentials trước.")
    try:
        secrets = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(400, "client_secrets.json không phải JSON hợp lệ.")
    app_cfg = secrets.get("web") or secrets.get("installed") or {}
    if not app_cfg.get("client_id"):
        raise HTTPException(400, "client_secrets.json thiếu client_id.")
    redirect_uris = app_cfg.get("redirect_uris") or []
    redirect_uri = redirect_uris[0] if redirect_uris else "http://localhost:8080/oauth2callback"
    return app_cfg, redirect_uri


class YouTubeConnectRequest(BaseModel):
    code: str = ""
    redirect_uri: str = ""


@router.get("/api/config/youtube-channels/{channel_id}/auth-url")
async def youtube_channel_auth_url(channel_id: str):
    """Trả về Google OAuth URL để user mở tab mới và cấp quyền.

    Luồng thủ công: mở auth_url → đăng nhập/chọn kênh → Google redirect về
    localhost (không có server nghe nên browser báo lỗi kết nối — bình thường) →
    copy `code=...` trên thanh địa chỉ → dán vào ô Connect ở frontend.
    """
    import secrets
    import urllib.parse

    app_cfg, redirect_uri = _yt_oauth_app_cfg(channel_id)
    auth_uri = app_cfg.get("auth_uri") or "https://accounts.google.com/o/oauth2/auth"
    state = secrets.token_urlsafe(16)
    params = {
        "client_id": app_cfg.get("client_id", ""),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(YT_OAUTH_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    auth_url = f"{auth_uri}?{urllib.parse.urlencode(params)}"
    return {"auth_url": auth_url, "redirect_uri": redirect_uri, "state": state}


@router.post("/api/config/youtube-channels/{channel_id}/connect")
async def youtube_channel_connect(channel_id: str, body: YouTubeConnectRequest):
    """Đổi authorization `code` lấy refresh_token mới, ghi đè request.token."""
    import datetime

    import httpx

    code = (body.code or "").strip()
    if not code:
        raise HTTPException(400, "Thiếu mã code từ Google.")
    # User có thể dán nhầm cả URL redirect (?code=...&...) — bóc lấy code.
    if "code=" in code:
        import urllib.parse

        try:
            qs = urllib.parse.urlparse(code)
            q = urllib.parse.parse_qs(qs.query)
            if q.get("code"):
                code = q["code"][0]
            else:
                # Có thể user dán nguyên query string
                frag = urllib.parse.parse_qs(code)
                if frag.get("code"):
                    code = frag["code"][0]
        except Exception:
            pass
    # Bóc tiếp nếu vẫn còn lẫn '&' (dán cả "...code=xxx&scope=...")
    if "code=" in code:
        import urllib.parse

        m = urllib.parse.parse_qs(code.split("?", 1)[-1])
        if m.get("code"):
            code = m["code"][0]
    code = code.split("&")[0].split()[0].strip()

    app_cfg, default_redirect = _yt_oauth_app_cfg(channel_id)
    redirect_uri = (body.redirect_uri or "").strip() or default_redirect
    token_uri = app_cfg.get("token_uri") or "https://oauth2.googleapis.com/token"

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(token_uri, data={
                "code": code,
                "client_id": app_cfg.get("client_id", ""),
                "client_secret": app_cfg.get("client_secret", ""),
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            })
            if r.status_code != 200:
                detail = r.text[:300]
                logger.warning("YouTube OAuth exchange failed (%s): %s", r.status_code, detail)
                raise HTTPException(
                    400,
                    "Google từ chối mã code (có thể hết hạn hoặc sai redirect_uri). "
                    "Hãy bấm Connect YT để lấy code mới.",
                )
            new = r.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Không đổi được code với Google: {e}")

    if not new.get("access_token"):
        raise HTTPException(400, "Google không trả access_token. Hãy thử lấy code mới.")

    token_path = _yt_channel_token_path(channel_id)
    # Giữ refresh_token cũ nếu Google không trả mới (luồng re-auth đôi khi thiếu).
    old_refresh = ""
    if token_path.exists():
        try:
            old_refresh = (json.loads(token_path.read_text(encoding="utf-8")) or {}).get("refresh_token", "") or ""
        except Exception:
            old_refresh = ""
    refresh_token = new.get("refresh_token") or old_refresh
    expires_in = int(new.get("expires_in") or 3600)
    exp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=expires_in)
    token_data = {
        "access_token": new.get("access_token", ""),
        "token_type": new.get("token_type") or "Bearer",
        "refresh_token": refresh_token,
        "expiry": exp.isoformat().replace("+00:00", "Z"),
        "expires_in": expires_in,
    }
    try:
        token_path.parent.mkdir(parents=True, exist_ok=True)
        # Backup token cũ để cứu khi code sai.
        if token_path.exists():
            try:
                token_path.with_suffix(".token.bak").write_bytes(token_path.read_bytes())
            except Exception:
                pass
        token_path.write_text(json.dumps(token_data, indent=2), encoding="utf-8")
        try:
            token_path.chmod(0o600)
        except Exception:
            pass
    except Exception as e:
        raise HTTPException(500, f"Không lưu được request.token: {e}")

    logger.info("YouTube channel %s reconnected (token refreshed)", channel_id)
    return {"status": "ok", "has_request_token": True}


@router.delete("/api/config/youtube-channels/{channel_id}/token")
async def youtube_channel_disconnect(channel_id: str):
    """Xoá request.token của kênh (ngắt kết nối OAuth, giữ client_secrets)."""
    cfg = _read_config()
    if not _yt_channel(channel_id, cfg):
        raise HTTPException(404, "Channel not found")
    _yt_channel_token_path(channel_id).unlink(missing_ok=True)
    return {"status": "ok", "has_request_token": False}


def get_active_youtube_channel() -> str | None:
    """Return the active YouTube channel ID, or None."""
    cfg = _read_config()
    return cfg.get("active_youtube_channel")


def get_youtube_channel_secrets(channel_id: str) -> tuple[Path, Path]:
    """Return (secrets_path, token_path) for a given channel."""
    return _yt_channel_secrets_path(channel_id), _yt_channel_token_path(channel_id)


# ── Telegram notifications ──

class TelegramTokenRequest(BaseModel):
    bot_token: str


@router.get("/api/telegram/config")
async def get_telegram_config():
    """Get Telegram connection status."""
    from app.services.telegram_service import telegram_service
    return telegram_service.get_config()


@router.post("/api/telegram/config")
async def save_telegram_token(body: TelegramTokenRequest):
    """Save bot token and start polling. Returns bot name on success."""
    from app.services.telegram_service import telegram_service
    token = body.bot_token.strip()
    if not token:
        raise HTTPException(400, "Bot token is required")
    bot_name = await telegram_service.start(token)
    if not bot_name:
        raise HTTPException(400, "Invalid bot token. Check @BotFather.")
    return {"status": "ok", "bot_name": bot_name}


@router.delete("/api/telegram/config")
async def delete_telegram_config():
    """Remove bot token and stop polling."""
    from app.services.telegram_service import telegram_service
    await telegram_service.stop()
    telegram_service._token = ""
    telegram_service._bot_name = ""
    telegram_service._chat_ids = []
    telegram_service._save_to_config()
    return {"status": "ok"}


@router.post("/api/telegram/connect")
async def create_telegram_qr():
    """Create a registration QR code for device linking."""
    from app.services.telegram_service import telegram_service
    if not telegram_service._token:
        raise HTTPException(400, "Bot token not configured")
    return telegram_service.create_registration_token()


@router.post("/api/telegram/disconnect/{chat_id}")
async def disconnect_telegram_chat(chat_id: int):
    """Disconnect a specific chat_id."""
    from app.services.telegram_service import telegram_service
    removed = telegram_service.disconnect_chat(chat_id)
    if not removed:
        raise HTTPException(404, "Chat not found")
    return {"status": "ok", "removed": True}


@router.post("/api/telegram/test")
async def send_telegram_test():
    """Send a test message to all connected chats."""
    from app.services.telegram_service import telegram_service
    if not telegram_service.has_connected_chats():
        raise HTTPException(400, "No devices connected")
    await telegram_service.broadcast(
        "🔔 <b>Test thông báo</b>\n\n"
        "Kết nối Telegram đang hoạt động bình thường!\n"
        "Bạn sẽ nhận thông báo khi video xử lý xong."
    )
    return {"status": "ok", "sent": len(telegram_service._chat_ids)}


# Legacy single-logo endpoints — operate on the active preset (backward compat).
@router.post("/api/config/logo")
async def upload_logo(file: UploadFile = File(...)):
    """Upload a watermark logo for the active preset (legacy wrapper)."""
    cfg = _migrate_presets(_read_config())
    active_id = _active_preset_id(cfg)
    if not active_id:
        raise HTTPException(400, "No watermark preset available")
    return await upload_preset_logo(active_id, file)


@router.get("/api/config/logo")
async def get_logo():
    """Serve the active preset's watermark logo (legacy wrapper)."""
    cfg = _migrate_presets(_read_config())
    active_id = _active_preset_id(cfg)
    if not active_id:
        raise HTTPException(404, "No logo uploaded")
    return await get_preset_logo(active_id)


@router.delete("/api/config/logo")
async def delete_logo():
    """Remove the active preset's watermark logo (legacy wrapper)."""
    cfg = _migrate_presets(_read_config())
    active_id = _active_preset_id(cfg)
    if not active_id:
        raise HTTPException(404, "No logo uploaded")
    return await delete_preset_logo(active_id)
