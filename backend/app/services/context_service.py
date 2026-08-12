import json
import logging
import os
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

CONTEXT_DIR_NAME = "context"
CONTEXT_FILE_NAME = "context.txt"
FILES_INDEX_NAME = "gemini_files.json"


def _context_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / CONTEXT_FILE_NAME


def _files_index_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / FILES_INDEX_NAME


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

    # Sample up to 16 frames evenly spread across the timeline
    sample_count = min(16, len(jpg_files))
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
                gf = client.files.get(name=name)
                uploaded_files.append(gf)
            except Exception:
                logger.debug("File %s gone from store", name)
        if uploaded_files:
            logger.info("Reused %d/%d files", len(uploaded_files), len(existing_names))

    if not uploaded_files:
        # Upload fresh
        for f in sampled:
            try:
                gf = client.files.upload(file=str(f))
                uploaded_files.append(gf)
                logger.info("Uploaded: %s (%s)", gf.name, f.name)
            except Exception as e:
                logger.warning("Upload failed %s: %s", f.name, e)

        if not uploaded_files:
            logger.warning("No frames uploaded for %s", video_id)
            return None

        _save_files_index(video_id, [gf.name for gf in uploaded_files])

    # Send all File Store files to Gemini Vision in ONE request
    try:
        response = client.models.generate_content(
            model=settings.gemini_model,
            contents=[
                *uploaded_files,
                f"Analyze these {len(uploaded_files)} frames from video '{video_id}'. "
                "Describe the video's context in Vietnamese (2-4 sentences): "
                "content type, setting/time period, visual style, characters. "
                "Be concise — this context improves subtitle translation accuracy.",
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
