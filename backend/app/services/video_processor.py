import json
import logging
import subprocess
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm

from app.config import settings

logger = logging.getLogger(__name__)


def get_video_info(video_path: str) -> dict:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-of", "default=noprint_wrappers=1",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    info = {}
    for line in result.stdout.strip().split("\n"):
        if "=" in line:
            k, v = line.split("=", 1)
            info[k] = v
    return info


def get_first_frame(video_path: str, video_id: str) -> Path:
    frames_dir = settings.temp_dir / "frames" / video_id
    frames_dir.mkdir(parents=True, exist_ok=True)
    output_path = frames_dir / "first_frame.jpg"

    cmd = [
        "ffmpeg", "-i", video_path,
        "-vframes", "1",
        "-qscale:v", "2",
        str(output_path),
        "-hide_banner", "-loglevel", "error", "-y",
    ]
    subprocess.run(cmd, check=True, timeout=60)

    return output_path


def stream_frames(
    video_path: str,
    fps: int | None = None,
) -> list[tuple[np.ndarray, float]]:
    target_fps = fps if fps is not None and fps > 0 else None
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = 1 if target_fps is None else max(1, int(round(video_fps / target_fps)))

    logger.info(
        "  source: %.2f fps, %d frames, step=%d -> ~%d target frames",
        video_fps, total_frames, step, total_frames // step,
    )

    frames: list[tuple[np.ndarray, float]] = []
    idx = 0

    pbar = tqdm(total=total_frames, desc="  frames", unit="fr", leave=False)
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % step == 0:
            timestamp = idx / video_fps
            frames.append((frame, timestamp))
        idx += 1
        pbar.update(1)
    pbar.close()

    cap.release()
    logger.info(
        "  extracted %d frames (%s)",
        len(frames), "every frame" if step == 1 else f"~{target_fps} fps",
    )
    return frames


def stream_frames_generator(
    video_path: str,
    fps: int | None = None,
    start_time: float | None = None,
    end_time: float | None = None,
):
    target_fps = fps if fps is not None and fps > 0 else None
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = 1 if target_fps is None else max(1, int(round(video_fps / target_fps)))

    # Calculate start/end frame numbers
    start_frame = int(start_time * video_fps) if start_time and start_time > 0 else 0
    end_frame = int(end_time * video_fps) if end_time and end_time > 0 else total_frames

    logger.info(
        "  video: %.2f fps, %d total frames, step=%d, start_frame=%d, end_frame=%d (%s)",
        video_fps, total_frames, step, start_frame, end_frame,
        "every frame" if step == 1 else f"~{target_fps} fps",
    )

    idx = 0
    if start_frame > 0:
        # Seek thay vì decode tuần tự từ đầu — khi OCR parallel, mỗi segment
        # decode lại prefix của mình sẽ tốn tổng cộng ~2.5x thời gian decode.
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        idx = start_frame
    extracted = 0
    pbar = tqdm(total=max(1, end_frame - idx), desc="  frames", unit="fr", leave=False)
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if idx >= start_frame and idx < end_frame and idx % step == 0:
                timestamp = idx / video_fps
                yield frame, timestamp
                extracted += 1
            idx += 1
            pbar.update(1)
    finally:
        pbar.close()
        cap.release()
        logger.info(
            "  extracted %d frames from %d-%d (%s)",
            extracted, start_frame, end_frame,
            "every frame" if step == 1 else f"~{target_fps} fps",
        )


def crop_region(frame: np.ndarray, region: dict) -> np.ndarray:
    h, w = frame.shape[:2]
    x1 = int(region["x1"] * w)
    y1 = int(region["y1"] * h)
    x2 = int(region["x2"] * w)
    y2 = int(region["y2"] * h)
    x1, x2 = sorted([x1, x2])
    y1, y2 = sorted([y1, y2])
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(w, max(x1 + 2, x2))
    y2 = min(h, max(y1 + 2, y2))
    return frame[y1:y2, x1:x2]


def compute_dhash(img: np.ndarray, hash_size: int = 8) -> int:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    resized = cv2.resize(gray, (hash_size + 1, hash_size), interpolation=cv2.INTER_AREA)
    diff = resized[:, 1:] > resized[:, :-1]
    return sum(bit << i for i, bit in enumerate(diff.flatten()))


def hamming_distance(h1: int, h2: int) -> int:
    return bin(h1 ^ h2).count("1")


def crops_visually_similar(
    a: np.ndarray,
    b: np.ndarray,
    diff_thresh: int = 12,
    ratio_thresh: float = 0.0008,
) -> bool:
    if a.shape != b.shape or a.size == 0:
        return False
    diff = cv2.absdiff(a, b)
    changed = np.count_nonzero(np.any(diff > diff_thresh, axis=2))
    return changed / (a.shape[0] * a.shape[1]) < ratio_thresh


def resolve_video_path(video_id: str) -> str:
    """Resolve the video used for OCR.

    Ưu tiên: delogo'd video > merged video (no audio) > original video.
    """
    video_dir = settings.temp_dir / "videos" / video_id

    # 1. Ưu tiên delogo'd video (đã xoá watermark) — ở videos/{id}/delogo.mp4.
    delogo_file = video_dir / "delogo.mp4"
    if delogo_file.exists() and delogo_file.stat().st_size > 0:
        return str(delogo_file)

    # 2. Merged video (no audio, từ Douyin)
    meta_file = video_dir / "meta.json"
    try:
        data = json.loads(meta_file.read_text(encoding="utf-8"))
        merge_id = data.get("source_merge_id")
        if merge_id:
            raw = settings.temp_dir / "merged" / f"{merge_id}_video.mp4"
            if raw.exists():
                return str(raw)
    except Exception:
        pass

    # 3. Original video
    for f in video_dir.iterdir():
        if f.stem.startswith("video"):
            return str(f)
    raise FileNotFoundError(f"Video not found: {video_id}")


def cleanup_video(video_id: str):
    import shutil
    for subdir in ["videos", "frames", "srt"]:
        p = settings.temp_dir / subdir / video_id
        if p.exists():
            shutil.rmtree(p)


def cleanup_temp_keep_srt(video_id: str):
    import shutil
    for subdir in ["videos", "frames"]:
        p = settings.temp_dir / subdir / video_id
        if p.exists():
            shutil.rmtree(p)
            logger.info("  cleaned %s/%s", subdir, video_id)


def cleanup_old_uploads():
    """Remove videos/frames of every upload except the most recent one (SRTs kept)."""
    import shutil
    videos_root = settings.temp_dir / "videos"
    if not videos_root.exists():
        return
    video_dirs = sorted(
        (d for d in videos_root.iterdir() if d.is_dir()),
        key=lambda d: d.stat().st_mtime,
    )
    for d in video_dirs[:-1]:
        shutil.rmtree(d)
        frames_dir = settings.temp_dir / "frames" / d.name
        if frames_dir.exists():
            shutil.rmtree(frames_dir)
        logger.info("  cleaned old upload %s", d.name)
