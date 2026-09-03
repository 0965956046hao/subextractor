"""Generate context images for videos that have NO source-provided thumbnails.

YouTube imports and local uploads don't carry Douyin-style cover/scene images.
For those, we sample the video at **30-second intervals**, then group every 20
frames into a stitched composite sheet (context_sheet_NNN.jpg).  The last batch
keeps whatever frames remain (even if < 20).  This gives Gemini rich visual
context across the entire video, regardless of length.
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
_FRAME_INTERVAL = 30   # seconds between each sampled frame
_FRAMES_PER_SHEET = 20 # frames stitched into one context image


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


def _extract_frame(video: Path, timestamp: float, out: Path) -> bool:
    """Extract a single frame at ``timestamp`` seconds, scaled to cell size."""
    try:
        proc = subprocess.run(
            [
                _ffmpeg(), "-ss", str(timestamp), "-i", str(video),
                "-frames:v", "1",
                "-vf", f"scale={_CELL_W}:{_CELL_H}",
                "-y", str(out),
            ],
            capture_output=True,
            timeout=30,
        )
        return out.exists() and out.stat().st_size > 0
    except Exception:
        return False


def _stitch_sheet(frame_paths: list[Path], out_sheet: Path) -> bool:
    """Stitch a list of frame images into a single tiled sheet."""
    if not frame_paths:
        return False
    rows = (len(frame_paths) + _COLS - 1) // _COLS
    cmd = [_ffmpeg(), "-y"]
    for p in frame_paths:
        cmd += ["-i", str(p)]
    cmd += [
        "-filter_complex",
        f"tile={_COLS}x{rows}:padding=8:color=black",
        str(out_sheet),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
        return out_sheet.exists() and out_sheet.stat().st_size > 0
    except Exception:
        return False


def generate_context_frames(
    video_id: str,
    force: bool = False,
) -> list[Path]:
    """Extract frames every 30 s and group every 20 frames into a stitched sheet.

    Saves:
      - ``context/{video_id}/thumbnail.jpg`` — first sampled frame (cover)
      - ``context/{video_id}/context_images/context_sheet_000.jpg`` …
        one sheet per batch of 20 frames (last batch may have fewer)

    Returns the list of sheet paths, or ``[]`` if generation failed.
    Skips (returns existing sheets) when sheets already exist unless ``force``.
    """
    video = _find_video_file(video_id)
    if not video or not video.exists():
        return []

    ctx_dir = settings.temp_dir / "context" / video_id
    sheet_dir = ctx_dir / "context_images"
    existing = sorted(sheet_dir.glob("context_sheet_*.jpg")) if sheet_dir.exists() else []
    if existing and not force:
        logger.info("Context sheets already exist for %s (%d sheets), skipping", video_id, len(existing))
        return existing

    duration = _probe_duration(video)
    if duration <= 0:
        logger.warning("Cannot probe duration for %s, skip frame context", video_id)
        return []

    # ── 1. Build timestamp list: 0, 30, 60, … < duration ──
    times: list[float] = []
    t = 0.0
    while t < duration:
        times.append(t)
        t += _FRAME_INTERVAL

    if not times:
        logger.warning("No timestamps for %s (duration=%.1f)", video_id, duration)
        return []

    # ── 2. Group timestamps into batches of _FRAMES_PER_SHEET ──
    batches: list[list[float]] = []
    for i in range(0, len(times), _FRAMES_PER_SHEET):
        batches.append(times[i : i + _FRAMES_PER_SHEET])

    tmp = ctx_dir / "_frames_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    sheets: list[Path] = []
    try:
        ctx_dir.mkdir(parents=True, exist_ok=True)
        sheet_dir.mkdir(parents=True, exist_ok=True)

        total_extracted = 0
        for batch_idx, batch_times in enumerate(batches):
            # Extract frames for this batch
            batch_frames: list[Path] = []
            for i, tt in enumerate(batch_times):
                global_idx = batch_idx * _FRAMES_PER_SHEET + i
                out = tmp / f"f{global_idx:05d}.jpg"
                if _extract_frame(video, tt, out):
                    batch_frames.append(out)
                else:
                    logger.debug("Frame %d (%.1fs) for %s failed", global_idx, tt, video_id)

            if not batch_frames:
                logger.warning("Batch %d: no frames extracted for %s", batch_idx, video_id)
                continue

            total_extracted += len(batch_frames)

            # Cover = first frame of first batch only
            if batch_idx == 0:
                shutil.copyfile(batch_frames[0], ctx_dir / "thumbnail.jpg")

            # Stitch this batch into a sheet
            sheet = sheet_dir / f"context_sheet_{batch_idx:03d}.jpg"
            if _stitch_sheet(batch_frames, sheet):
                sheets.append(sheet)
            else:
                logger.warning("Stitch batch %d failed for %s", batch_idx, video_id)

        logger.info(
            "Context sheets generated for %s: %d frames → %d sheets",
            video_id, total_extracted, len(sheets),
        )
        return sheets
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
