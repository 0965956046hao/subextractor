import concurrent.futures
import json
import logging
import os
from pathlib import Path

from app.config import settings
from app.services.retry_utils import gemini_retry

logger = logging.getLogger(__name__)

CONTEXT_DIR_NAME = "context"
CONTEXT_FILE_NAME = "context.txt"
FILES_INDEX_NAME = "gemini_files.json"
SHARE_TEXT_NAME = "share_text.txt"
TRANSLATION_CONTEXT_NAME = "translation_context.txt"


def _context_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / CONTEXT_FILE_NAME


def _share_text_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / SHARE_TEXT_NAME


def _files_index_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / FILES_INDEX_NAME


def _translation_context_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / TRANSLATION_CONTEXT_NAME


def load_translation_context(video_id: str) -> str | None:
    """Load the accumulated translation context (built patch-by-patch)."""
    p = _translation_context_path(video_id)
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    return None


def append_translation_context(video_id: str, note: str) -> None:
    """Append a patch context note to the translation-context file."""
    p = _translation_context_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    prev = load_translation_context(video_id)
    content = f"{prev}\n\n{note}" if prev else note
    p.write_text(content, encoding="utf-8")


def _save_files_index(video_id: str, file_names: list[str]):
    p = _files_index_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(file_names), encoding="utf-8")


def _load_files_index(video_id: str) -> list[str]:
    p = _files_index_path(video_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _read_user_config() -> dict:
    import json
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def load_video_context(video_id: str) -> str | None:
    """Load previously generated video context, if it exists."""
    cp = _context_path(video_id)
    if cp.exists():
        return cp.read_text(encoding="utf-8").strip()
    return None


def save_share_text(video_id: str, text: str) -> None:
    """Persist the raw pasted share text so context generation can use it."""
    p = _share_text_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def load_share_text(video_id: str) -> str | None:
    """Load the saved share text, if any."""
    p = _share_text_path(video_id)
    if p.exists():
        try:
            return p.read_text(encoding="utf-8").strip()
        except Exception:
            return None
    return None


def _thumbnail_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / "thumbnail.txt"


def save_thumbnail(video_id: str, url: str) -> None:
    """Persist the extracted thumbnail URL for later use (fal.ai step)."""
    p = _thumbnail_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(url, encoding="utf-8")


def load_thumbnail(video_id: str) -> str | None:
    """Load the saved thumbnail URL, if any."""
    p = _thumbnail_path(video_id)
    if p.exists():
        try:
            return p.read_text(encoding="utf-8").strip()
        except Exception:
            return None
    return None


def generate_video_context(video_id: str) -> str | None:
    """Upload snapshot frames to Gemini File Store, then call Vision in one request.

    Files are uploaded to File Store (visible via GET /api/gemini/files),
    then all referenced in a single generate_content call.
    """
    snapshots_dir = settings.temp_dir / "frames" / video_id / "ocr_snapshots"
    if not snapshots_dir.exists():
        logger.info("No OCR snapshots found for %s, skipping context generation", video_id)
        return None

    jpg_files = sorted(snapshots_dir.glob("*.jpg"))
    if not jpg_files:
        logger.info("No snapshot images found for %s", video_id)
        return None

    # Sample up to 20 frames evenly spread across the timeline (min 10 when available)
    sample_count = min(20, len(jpg_files))
    step = max(1, len(jpg_files) // sample_count)
    sampled = jpg_files[::step][:sample_count]
    logger.info("Uploading %d/%d frames to Gemini File Store (%s)", len(sampled), len(jpg_files), video_id)

    try:
        from google import genai
    except ImportError:
        logger.warning("google-genai not installed, skipping context generation")
        return None

    api_key = settings.gemini_api_key or os.environ.get("GEMINI_API_KEY", "") or _read_user_config().get("gemini_api_key", "")
    if not api_key:
        logger.warning("GEMINI_API_KEY not set, skipping context generation")
        return None

    client = genai.Client(api_key=api_key)

    # Check if files already uploaded for this video_id — reuse to avoid spam
    existing_names = _load_files_index(video_id)
    uploaded_files = []

    if existing_names:
        logger.info("Found %d files in File Store for %s, reusing", len(existing_names), video_id)
        for name in existing_names:
            try:
                gf = gemini_retry(client.files.get)(name=name)
                uploaded_files.append(gf)
            except Exception:
                logger.debug("File %s gone from store", name)
        if uploaded_files:
            logger.info("Reused %d/%d files", len(uploaded_files), len(existing_names))

    if not uploaded_files:
        # Upload fresh — concurrently (up to 8 at a time)
        def _upload_one(f):
            try:
                gf = gemini_retry(client.files.upload)(file=str(f))
                logger.info("Uploaded: %s (%s)", gf.name, f.name)
                return gf
            except Exception as e:
                logger.warning("Upload failed %s: %s", f.name, e)
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(_upload_one, sampled))

        uploaded_files = [r for r in results if r is not None]

        if not uploaded_files:
            logger.warning("No frames uploaded for %s", video_id)
            return None

        _save_files_index(video_id, [gf.name for gf in uploaded_files])

    # Send all File Store files to Gemini Vision in ONE request
    share_hint = load_share_text(video_id)
    hint_text = ""
    if share_hint:
        hint_text = (
            f"\n\nSHARE TEXT (nội dung user dán kèm link, có thể chứa tiêu đề/mô tả video):\n"
            f"{share_hint}\n"
            "Dùng thông tin này để xác định chính xác tiêu đề, nội dung và bối cảnh video."
        )

    try:
        response = gemini_retry(client.models.generate_content)(
            model=settings.gemini_model,
            contents=[
                *uploaded_files,
                f"Analyze these {len(uploaded_files)} frames sampled from video '{video_id}'. "
                "Synthesize ALL frames together to understand the full video context. "
                "Describe in Vietnamese (4-6 sentences), including:\n"
                "- Content type (phim cổ trang / hiện đại / hoạt hình / tài liệu / tutorial...)\n"
                "- Time period and setting (bối cảnh lịch sử, không gian)\n"
                "- Main characters: count, gender (nam/nữ), estimated age, relationships\n"
                "- How characters address each other (xưng hô: huynh-đệ, anh-em, ngài-tiểu nhân, bạn-cậu...)\n"
                "- Overall tone (nghiêm túc / hài hước / hành động / lãng mạn...)\n"
                "- Any notable visual style, costumes, or recurring text on screen\n\n"
                "Be specific and detailed. This context will be used to improve subtitle translation accuracy."
                + hint_text,
            ],
        )

        context = response.text.strip()
    except Exception as e:
        logger.exception("Gemini Vision context generation failed: %s", e)
        return None

    if not context:
        return None

    cp = _context_path(video_id)
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(context, encoding="utf-8")
    logger.info("Video context saved for %s: %s", video_id, context[:120])
    return context
