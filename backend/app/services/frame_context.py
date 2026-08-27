"""Generate context images for videos that have NO source-provided thumbnails.

YouTube imports and local uploads don't carry Douyin-style cover/scene images.
For those, we sample the video itself: 1 frame every ``interval_sec`` seconds
(up to ``max_frames``), then stitch the frames into a single contact-sheet
image. That sheet becomes the context image uploaded to Gemini (via
``context_service.generate_video_context``), so translation/meta steps get
visual context just like Douyin videos do.
"""

import logging
import shutil
import subprocess
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

_ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
_CELL_W = 240
_CELL_H = 135
_COLS = 5


def _find_video_file(video_id: str) -> Path | None:
    d = settings.temp_dir / "videos" / video_id
    if not d.exists():
        return None
    for c in sorted(d.glob("video.*")):
        if c.suffix.lower() in _ALLOWED_VIDEO_EXT:
            return c
    return None


def _probe_duration(video: Path) -> float:
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "csv=p=0",
                str(video),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        val = (proc.stdout or "").strip()
        return float(val) if val else 0.0
    except Exception:
        return 0.0


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def generate_context_frames(
    video_id: str,
    interval_sec: int = 30,
    max_frames: int = 20,
    force: bool = False,
) -> Path | None:
    """Sample frames every ``interval_sec`` s, stitch into one sheet image.

    Saves:
      - ``context/{video_id}/thumbnail.jpg`` — first sampled frame (cover)
      - ``context/{video_id}/context_images/context_sheet.jpg`` — stitched sheet

    Returns the sheet path, or ``None`` if it could not be generated.
    Skips (returns existing sheet) when the sheet already exists unless ``force``.
    """
    video = _find_video_file(video_id)
    if not video or not video.exists():
        return None

    ctx_dir = settings.temp_dir / "context" / video_id
    sheet_dir = ctx_dir / "context_images"
    sheet = sheet_dir / "context_sheet.jpg"
    if sheet.exists() and not force:
        logger.info("Context sheet already exists for %s, skipping", video_id)
        return sheet

    duration = _probe_duration(video)
    if duration <= 0:
        logger.warning("Cannot probe duration for %s, skip frame context", video_id)
        return None

    times = [i * interval_sec for i in range(max_frames) if i * interval_sec < duration]
    if not times:
        times = [0]

    tmp = ctx_dir / "_frames_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        frames: list[Path] = []
        for i, t in enumerate(times):
            out = tmp / f"f{i:03d}.jpg"
            proc = subprocess.run(
                [
                    _ffmpeg(), "-ss", str(t), "-i", str(video),
                    "-frames:v", "1",
                    "-vf",
                    f"scale={_CELL_W}:{_CELL_H}",
                    "-y", str(out),
                ],
                capture_output=True,
                timeout=30,
            )
            if out.exists() and out.stat().st_size > 0:
                frames.append(out)
            else:
                logger.debug("Frame %d for %s failed: %s", i, video_id, proc.stderr[-200:])

        if not frames:
            logger.warning("No frames extracted for %s", video_id)
            return None

        ctx_dir.mkdir(parents=True, exist_ok=True)
        sheet_dir.mkdir(parents=True, exist_ok=True)

        # Cover = first sampled frame
        shutil.copyfile(frames[0], ctx_dir / "thumbnail.jpg")

        # Stitch into a single contact-sheet image
        rows = (len(frames) + _COLS - 1) // _COLS
        proc = subprocess.run(
            [
                _ffmpeg(),
                "-pattern_type", "glob", "-i", str(tmp / "f*.jpg"),
                "-filter_complex",
                f"tile={_COLS}x{rows}:padding=8:color=black",
                "-y", str(sheet),
            ],
            capture_output=True,
            timeout=60,
        )
        if not (sheet.exists() and sheet.stat().st_size > 0):
            logger.warning("Stitch failed for %s: %s", video_id, proc.stderr[-300:])
            return None

        logger.info(
            "Context sheet generated for %s: %d frames, %s",
            video_id, len(frames), sheet,
        )
        return sheet
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
