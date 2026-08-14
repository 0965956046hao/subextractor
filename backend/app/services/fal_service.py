"""fal.ai image-to-image thumbnail regeneration."""

import json
import logging
import os
import shutil
import ssl
import urllib.request
from pathlib import Path

from app.config import settings
from app.services.context_service import load_video_context, load_thumbnail

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)


def _download(url: str, dest: Path) -> None:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT, "Referer": "https://www.douyin.com/"},
    )
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def _load_meta_title(video_id: str) -> str:
    p = settings.temp_dir / "meta" / video_id / "meta.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("title", "")
        except Exception:
            return ""
    return ""


def _resolve_fal_key() -> str:
    cf = settings.temp_dir / "user_config.json"
    cfg_key = ""
    if cf.exists():
        try:
            cfg_key = json.loads(cf.read_text(encoding="utf-8")).get("fal_key", "")
        except Exception:
            cfg_key = ""
    return settings.fal_key or os.environ.get("FAL_KEY", "") or cfg_key


def _build_prompt(context: str, title: str) -> str:
    parts = []
    if context:
        parts.append(context)
    parts.append("Regenerate this thumbnail in a 16:9 landscape format.")
    if title:
        parts.append(f'Replace the title text in the image with: "{title}"')
    parts.append(
        "All text in the image must be in Vietnamese, except when a title, "
        "proper name or brand must stay in English (character names, series names, logos, etc.). "
        "Keep the original characters, background, composition, lighting and art style. "
        "Only change the text/title and the aspect ratio."
    )
    return "\n".join(parts)


def update_thumbnail(video_id: str) -> Path:
    """Regenerate the thumbnail via fal.ai image-to-image (strength=0.3)."""
    thumb_url = load_thumbnail(video_id)
    if not thumb_url:
        raise RuntimeError("Thumbnail URL not saved — run resolve first.")

    context = load_video_context(video_id) or ""
    title = _load_meta_title(video_id)

    out_dir = settings.temp_dir / "thumb" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    input_path = out_dir / "input_thumb.jpg"
    _download(thumb_url, input_path)

    api_key = _resolve_fal_key()
    if not api_key:
        raise RuntimeError("FAL_KEY not configured")

    try:
        import fal_client
    except ImportError:
        raise RuntimeError("fal-client not installed. Run: pip install fal-client")

    os.environ["FAL_KEY"] = api_key

    prompt = _build_prompt(context, title)
    logger.info("fal.ai image-to-image for %s (strength=0.3, 16:9)", video_id)

    image_url = fal_client.upload_file(str(input_path))
    result = fal_client.subscribe(
        "fal-ai/flux/dev/image-to-image",
        arguments={
            "image_url": image_url,
            "prompt": prompt,
            "strength": 0.3,
            "image_size": "landscape_16_9",
        },
    )
    output_url = result["images"][0]["url"]

    output_path = out_dir / "thumbnail.png"
    _download(output_url, output_path)

    logger.info("Thumbnail updated for %s → %s", video_id, output_path)
    return output_path
