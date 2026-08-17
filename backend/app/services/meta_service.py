"""Generate video metadata (YouTube title/description/tags/hashtags) from context + share text."""

import json
import logging
import os

from app.config import settings
from app.services.context_service import load_video_context, load_share_text

logger = logging.getLogger(__name__)

PROMPT = """Parse the following video metadata into a valid JSON object with this exact structure:

{{
  "title": "Vietnamese title here",
  "description": "Full Vietnamese description with \\n line breaks",
  "tags": ["tag1", "tag2", ...],
  "hashtags": ["#Hashtag1", "#Hashtag2", ...],
  "episode": 1,
  "original_title": "Original Chinese/English title",
  "original_description": "Original short description"
}}

- title: catchy Vietnamese title, include episode number if provided
- description: detailed Vietnamese description with paragraphs separated by \\n\\n, include info about genre, episode number, series name
- tags: 10-15 relevant search keywords in Vietnamese and original language
- hashtags: 8-10 hashtags with # prefix, no spaces (CamelCase format)
- episode: integer episode number
- original_title: keep the original language title
- original_description: keep the original short description

VIDEO CONTEXT (analyzed from frames):
{context}

SHARE TEXT (pasted by user):
{share_text}

Output ONLY the JSON object, no markdown, no explanation.
"""


def _read_user_config() -> dict:
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def generate_video_meta(video_id: str) -> dict:
    """Generate meta.json from video context + share text via Gemini."""
    context = load_video_context(video_id) or ""
    share_text = load_share_text(video_id) or ""

    api_key = (
        settings.gemini_api_key
        or os.environ.get("GEMINI_API_KEY", "")
        or _read_user_config().get("gemini_api_key", "")
    )
    if not api_key:
        raise RuntimeError("Gemini API key not configured")

    try:
        from google import genai
    except ImportError:
        raise RuntimeError("google-genai not installed")

    client = genai.Client(api_key=api_key)

    prompt = PROMPT.format(
        context=context or "Không có",
        share_text=share_text or "Không có",
    )

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=prompt,
        config={"temperature": 0.3},
    )
    raw = response.text.strip()
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    meta = json.loads(raw)

    meta.setdefault("title", "")
    meta["ctr_title"] = meta.get("title", "")
    meta.setdefault("description", "")
    meta.setdefault("tags", [])
    meta.setdefault("hashtags", [])
    meta.setdefault("episode", 1)
    meta.setdefault("original_title", "")
    meta.setdefault("original_description", "")

    out_dir = settings.temp_dir / "meta" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info("Meta saved for %s: %s", video_id, meta.get("title", "")[:80])

    return meta
