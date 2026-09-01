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
        logger.warning("Video file not found for %s", video_id)
        return []

    ctx_dir = settings.temp_dir / "context" / video_id
    sheet_dir = ctx_dir / "context_images"
    existing = sorted(sheet_dir.glob("context_sheet_*.jpg")) if sheet_dir.exists() else []
    if existing and not force:
        logger.info("Context sheets already exist for %s, skipping (use force=True to regenerate)", video_id)
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

    logger.info("Video %s: duration=%.1fs, will sample %d frames (every %ds)", video_id, duration, len(times), interval_sec)

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
                logger.debug("Extracted frame %d at %.1fs: %s", i, tt, out.name)
            else:
                logger.warning("Frame %d at %.1fs extraction failed: %s", i, tt, proc.stderr[-200:].decode() if isinstance(proc.stderr, bytes) else proc.stderr[-200:])

        if not frames:
            logger.warning("No frames extracted for %s", video_id)
            return []

        ctx_dir.mkdir(parents=True, exist_ok=True)
        sheet_dir.mkdir(parents=True, exist_ok=True)

        # Cover = first sampled frame
        shutil.copyfile(frames[0], ctx_dir / "thumbnail.jpg")
        logger.info("Thumbnail saved: %s", ctx_dir / "thumbnail.jpg")

        # Group frames into sheets - ALWAYS create at least 1 sheet if we have any frames
        num_chunks = (len(frames) + frames_per_sheet - 1) // frames_per_sheet
        logger.info("Creating %d context sheet(s) from %d frames (max %d per sheet)", num_chunks, len(frames), frames_per_sheet)
        
        for si in range(0, len(frames), frames_per_sheet):
            chunk = frames[si : si + frames_per_sheet]
            rows = (len(chunk) + _COLS - 1) // _COLS
            sheet = sheet_dir / f"context_sheet_{si // frames_per_sheet:03d}.jpg"
            
            # Use hstack/vstack instead of tile filter (more compatible)
            n = len(chunk)
            inputs = []
            for f in chunk:
                inputs.extend(["-i", str(f)])
            
            # Build filter complex: scale each to exact size -> hstack rows -> vstack rows (if multiple rows)
            filter_parts = []
            for i in range(n):
                filter_parts.append(f"[{i}:v]scale={_CELL_W}:{_CELL_H}[v{i}]")
            
            # Build rows using hstack, pad shorter rows with black frame files
            row_labels = []
            # Create a black frame file once for padding
            black_frame = tmp / "black_frame.jpg"
            if not black_frame.exists():
                proc = subprocess.run(
                    [_ffmpeg(), "-f", "lavfi", "-i", f"color=black:size={_CELL_W}x{_CELL_H}", "-frames:v", "1", "-y", str(black_frame)],
                    capture_output=True, timeout=10,
                )
            
            for r in range(rows):
                start = r * _COLS
                end = min(start + _COLS, n)
                row_inputs = " ".join(f"[v{i}]" for i in range(start, end))
                row_label = f"row{r}"
                actual_cols = end - start
                if actual_cols < _COLS:
                    # Add black frame inputs for padding
                    pad_count = _COLS - actual_cols
                    for p in range(pad_count):
                        pad_idx = n + p
                        inputs.extend(["-i", str(black_frame)])
                    # hstack real frames -> [real{r}] (only if >1 frame)
                    if actual_cols > 1:
                        filter_parts.append(f"{row_inputs}hstack=inputs={actual_cols}[real{r}]")
                        real_label = f"real{r}"
                    else:
                        real_label = f"v{start}"  # single frame, use directly
                    # hstack black frames -> [pad{r}] (only if >1 pad frame)
                    if pad_count > 1:
                        pad_indices = " ".join(f"[{n+p}:v]" for p in range(pad_count))
                        filter_parts.append(f"{pad_indices}hstack=inputs={pad_count}[pad{r}]")
                        pad_label = f"pad{r}"
                    else:
                        pad_label = f"[{n}:v]"  # single black frame, use directly
                    # Combine real + pad
                    filter_parts.append(f"[{real_label}] {pad_label}hstack=inputs=2[{row_label}]")
                else:
                    if actual_cols > 1:
                        filter_parts.append(f"{row_inputs}hstack=inputs={actual_cols}[{row_label}]")
                    else:
                        # Single frame, just use it directly
                        filter_parts.append(f"{row_inputs}[{row_label}]")
                row_labels.append(row_label)
            
            # Stack rows vertically (only if multiple rows)
            if rows > 1:
                filter_parts.append(f"{' '.join(f'[{rl}]' for rl in row_labels)}vstack=inputs={rows}[out]")
                final_label = "out"
            else:
                final_label = row_labels[0]
            
            # Add final output mapping
            filter_complex = ";".join(filter_parts)
            
            # Use -update 1 for single image output
            proc = subprocess.run(
                [_ffmpeg(), *inputs, "-filter_complex", filter_complex, "-map", f"[{final_label}]", "-update", "1", "-y", str(sheet)],
                capture_output=True,
                timeout=60,
            )
            if sheet.exists() and sheet.stat().st_size > 0:
                sheets.append(sheet)
                logger.info("Context sheet created: %s (%d frames, %d row%s)", sheet.name, len(chunk), rows, "s" if rows > 1 else "")
            else:
                stderr = proc.stderr[-500:].decode() if isinstance(proc.stderr, bytes) else proc.stderr[-500:]
                logger.warning("Stitch %s failed: %s", sheet.name, stderr)
        
        logger.info(
            "Context generation complete for %s: %d frames → %d sheets",
            video_id, len(frames), len(sheets),
        )
        return sheets
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _stitch_frames_fallback(frames: list[Path], output_path: Path) -> bool:
    """Fallback stitch using simple filter chain when tile filter fails."""
    if not frames:
        return False
    try:
        # Build filter: scale each frame then hstack/vstack
        n = len(frames)
        cols = min(5, n)
        rows = (n + cols - 1) // cols
        
        # Create inputs
        inputs = []
        for f in frames:
            inputs.extend(["-i", str(f)])
        
        # Build filter complex
        filter_parts = []
        for i in range(n):
            filter_parts.append(f"[{i}:v]scale=240:135:force_original_aspect_ratio=decrease,pad=240:135:(ow-iw)/2:(oh-ih)/2[v{i}]")
        
        # Stack horizontally then vertically
        hstack_parts = []
        for r in range(rows):
            start = r * cols
            end = min(start + cols, n)
            hstack_parts.append(f"[{' '.join(f'[v{i}]' for i in range(start, end))}]hstack=inputs={end-start}[row{r}]")
        
        vstack_part = f"[{' '.join(f'[row{r}]' for r in range(rows))}]vstack=inputs={rows}"
        
        filter_complex = ";".join(filter_parts + hstack_parts + [vstack_part])
        
        proc = subprocess.run(
            [_ffmpeg(), *inputs, "-filter_complex", filter_complex, "-y", str(output_path)],
            capture_output=True,
            timeout=60,
        )
        return output_path.exists() and output_path.stat().st_size > 0
    except Exception as e:
        logger.warning("Fallback stitch failed: %s", e)
        return False
