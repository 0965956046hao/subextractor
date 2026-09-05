"""Generate video metadata (YouTube title/description/tags/hashtags) from context + share text."""

import json
import logging

from app.config import settings
from app.services.context_service import load_video_context, load_share_text
from app.services.job_utils import JobCancelled
from app.services.retry_utils import (
    configured_gemini_keys,
    gemini_model_chain,
    raise_if_gemini_cancelled,
    _is_retryable,
)

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


def _original_name(video_id: str) -> str:
    """Lấy tên gốc của video từ videos/{video_id}/meta.json (bỏ đuôi .mp4)."""
    meta = settings.temp_dir / "videos" / video_id / "meta.json"
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
        name = str(data.get("filename", "")).strip()
        return name.rsplit(".", 1)[0].strip() if name else ""
    except Exception:
        return ""


def generate_video_meta(video_id: str) -> dict:
    """Generate meta.json from video context + share text via Gemini."""
    context = load_video_context(video_id) or ""
    share_text = load_share_text(video_id) or ""

    keys = configured_gemini_keys()
    if not keys:
        raise RuntimeError("Gemini API key not configured")
    api_key = keys[0]

    try:
        from google import genai
    except ImportError:
        raise RuntimeError("google-genai not installed")

    client = genai.Client(api_key=api_key)

    prompt = PROMPT.format(
        context=context or "Không có",
        share_text=share_text or "Không có",
    )

    # Dùng Chat API thay vì Models.generate_content: tránh cảnh báo AFC
    # (automatic function calling) của SDK và chỉ thực hiện 1 lượt truy vấn
    # thay vì nhiều round-trip (tối đa 10) → nhanh hơn, không làm proxy
    # frontend reset socket (ECONNRESET) khi meta generation chạy lâu.
    # Model fallback: lỗi retryable thì đổi model kế tiếp, hết mới báo lỗi.
    response = None
    last_err: Exception | None = None
    chain = gemini_model_chain(settings.gemini_model)
    logger.info(
        "Meta: model %s%s",
        chain[0],
        f" (+{len(chain) - 1} fallbacks)" if len(chain) > 1 else "",
    )
    for model in chain:
        raise_if_gemini_cancelled()
        chat = client.chats.create(model=model)
        try:
            response = chat.send_message(prompt, config={"temperature": 0.3})
            if model != settings.gemini_model:
                logger.info("Meta fell back to model %s", model)
            break
        except JobCancelled:
            raise
        except Exception as e:
            last_err = e
            if not _is_retryable(e):
                raise
            logger.info("Meta model %s failed: %s — trying next model", model, e)
    if response is None:
        raise last_err or RuntimeError("Meta generation failed on all models")
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

    # Chuẩn hoá title: strip + cắt ≤100 ký tự (giới hạn YouTube). Nếu Gemini trả
    # title rỗng thì fallback về tên gốc của video để tránh lỗi "invalidTitle".
    title = str(meta.get("title", "")).strip()
    if not title:
        title = _original_name(video_id) or f"Video {video_id}"
    title = title[:100].strip()
    meta["title"] = title
    meta["ctr_title"] = title

    out_dir = settings.temp_dir / "meta" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info("Meta saved for %s: %s", video_id, meta.get("title", "")[:80])

    return meta
