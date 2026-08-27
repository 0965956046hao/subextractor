"""Generate context images for videos that have NO source-provided thumbnails.

YouTube imports and local uploads don't carry Douyin-style cover/scene images.
For those, we sample the video itself: **1 frame every ``interval_sec`` seconds
(NO upper limit)**, then group the frames into sheets of ``frames_per_sheet``
(scaled small + stitched). The more frames there are, the more context images
(context sheets) are produced. All sheets are uploaded to Gemini (via
``context_service.generate_video_context``) so translation/meta steps get
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
    frames_per_sheet: int = 20,
    force: bool = False,
) -> list[Path]:
    """Sample 1 frame every ``interval_sec`` s (NO limit), then group frames into
    sheets of ``frames_per_sheet`` (scaled small + stitched). The more frames, the
    more context sheets are produced.

    Saves:
      - ``context/{video_id}/thumbnail.jpg`` — first sampled frame (cover)
      - ``context/{video_id}/context_images/context_sheet_000.jpg`` … — one
        stitched sheet per ``frames_per_sheet`` frames (ảnh bối cảnh)

    Returns the list of sheet paths, or ``[]`` if generation failed.
    Skips (returns existing sheets) when any sheet already exists unless ``force``.
    """
    video = _find_video_file(video_id)
    if not video or not video.exists():
        return []

    ctx_dir = settings.temp_dir / "context" / video_id
    sheet_dir = ctx_dir / "context_images"
    existing = sorted(sheet_dir.glob("context_sheet_*.jpg")) if sheet_dir.exists() else []
    if existing and not force:
        logger.info("Context sheets already exist for %s, skipping", video_id)
        return existing

    duration = _probe_duration(video)
    if duration <= 0:
        logger.warning("Cannot probe duration for %s, skip frame context", video_id)
        return []

    # Sample every interval_sec seconds, unlimited.
    times: list[float] = []
    t = 0.0
    while t < duration:
        times.append(t)
        t += interval_sec

    tmp = ctx_dir / "_frames_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    sheets: list[Path] = []
    try:
        frames: list[Path] = []
        for i, tt in enumerate(times):
            out = tmp / f"f{i:05d}.jpg"
            proc = subprocess.run(
                [
                    _ffmpeg(), "-ss", str(tt), "-i", str(video),
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
            return []

        ctx_dir.mkdir(parents=True, exist_ok=True)
        sheet_dir.mkdir(parents=True, exist_ok=True)

        # Cover = first sampled frame
        shutil.copyfile(frames[0], ctx_dir / "thumbnail.jpg")

        # Group frames into sheets of `frames_per_sheet`, stitch each group.
        for si in range(0, len(frames), frames_per_sheet):
            chunk = frames[si : si + frames_per_sheet]
            rows = (len(chunk) + _COLS - 1) // _COLS
            sheet = sheet_dir / f"context_sheet_{si // frames_per_sheet:03d}.jpg"
            proc = subprocess.run(
                [
                    _ffmpeg(),
                    "-pattern_type", "glob", "-i", str(tmp / "f*.jpg"),
                    "-filter_complex",
                    f"select='gte(n\\,{si})*lte(n\\,{si + len(chunk) - 1})',"
                    f"tile={_COLS}x{rows}:padding=8:color=black",
                    "-y", str(sheet),
                ],
                capture_output=True,
                timeout=60,
            )
            if sheet.exists() and sheet.stat().st_size > 0:
                sheets.append(sheet)
            else:
                logger.warning("Stitch %s failed: %s", sheet.name, proc.stderr[-300:])
        logger.info(
            "Context sheets generated for %s: %d frames → %d sheets",
            video_id, len(frames), len(sheets),
        )
        return sheets
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
