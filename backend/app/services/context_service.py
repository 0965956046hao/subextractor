import logging
import os
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

CONTEXT_DIR_NAME = "context"
CONTEXT_FILE_NAME = "context.txt"


def _context_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / CONTEXT_FILE_NAME


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
    """Upload snapshot frames to Gemini and ask Vision to describe the video context.

    Frames are sampled from temp/frames/{video_id}/ocr_snapshots/.
    Returns a Vietnamese description of the video's setting, characters, and genre.
    """
    snapshots_dir = settings.temp_dir / "frames" / video_id / "ocr_snapshots"
    if not snapshots_dir.exists():
        logger.info("No OCR snapshots found for %s, skipping context generation", video_id)
        return None

    # Collect snapshot files, sorted by name (which includes timestamps)
    jpg_files = sorted(snapshots_dir.glob("*.jpg"))
    if not jpg_files:
        logger.info("No snapshot images found for %s", video_id)
        return None

    # Sample up to 16 frames evenly distributed across the video timeline
    sample_count = min(16, len(jpg_files))
    step = max(1, len(jpg_files) // sample_count)
    sampled = jpg_files[::step][:sample_count]
    logger.info("Uploading %d/%d frames for video context (%s)", len(sampled), len(jpg_files), video_id)

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

    # Upload files to Gemini File API
    uploaded_files = []
    for f in sampled:
        try:
            gf = client.files.upload(file=str(f))
            uploaded_files.append(gf)
        except Exception as e:
            logger.warning("Failed to upload %s: %s", f.name, e)

    if not uploaded_files:
        logger.warning("No frames uploaded successfully for %s", video_id)
        return None

    try:
        # Build multimodal prompt with uploaded files
        parts = list(uploaded_files) + [
            "\n\nThese are key frames sampled from a video. "
            "Analyze the visuals and describe the video's context in Vietnamese (2-4 sentences). "
            "Include: what type of content this is (movie, drama, documentary, tutorial, etc.), "
            "the setting/time period, any notable visual style or characters. "
            "Be concise and specific — this context will be used to improve subtitle translation accuracy."
        ]

        response = client.models.generate_content(
            model=settings.gemini_model,
            contents=parts,
        )

        context = response.text.strip()
    except Exception as e:
        logger.exception("Gemini Vision context generation failed: %s", e)
        return None
    finally:
        # Clean up uploaded files from Gemini
        for gf in uploaded_files:
            try:
                client.files.delete(name=gf.name)
            except Exception:
                pass

    if not context:
        return None

    # Save context to disk
    cp = _context_path(video_id)
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(context, encoding="utf-8")
    logger.info("Video context saved for %s: %s", video_id, context[:120])

    return context
