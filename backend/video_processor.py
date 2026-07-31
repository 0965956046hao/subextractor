import subprocess
import os
import cv2

from config import TEMP_DIR, EXTRACT_FPS


def get_video_info(video_path: str) -> dict:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-of", "default=noprint_wrappers=1",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    info = {}
    for line in result.stdout.strip().split("\n"):
        if "=" in line:
            k, v = line.split("=", 1)
            info[k] = v
    return info


def extract_frames(video_path: str, video_id: str) -> list[tuple[str, float]]:
    frames_dir = os.path.join(TEMP_DIR, "frames", video_id)
    os.makedirs(frames_dir, exist_ok=True)

    output_pattern = os.path.join(frames_dir, "frame_%04d.jpg")

    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={EXTRACT_FPS}",
        "-qscale:v", "2",
        output_pattern,
        "-hide_banner", "-loglevel", "error", "-y",
    ]
    subprocess.run(cmd, check=True, timeout=600)

    frame_files = sorted(
        [f for f in os.listdir(frames_dir) if f.endswith(".jpg")],
        key=lambda x: int(x.replace("frame_", "").replace(".jpg", "")),
    )

    frames = []
    for i, fname in enumerate(frame_files):
        fpath = os.path.join(frames_dir, fname)
        timestamp = i / EXTRACT_FPS
        frames.append((fpath, timestamp))

    return frames


def get_first_frame(video_path: str, video_id: str) -> str:
    frames_dir = os.path.join(TEMP_DIR, "frames", video_id)
    os.makedirs(frames_dir, exist_ok=True)

    output_path = os.path.join(frames_dir, "first_frame.jpg")

    cmd = [
        "ffmpeg", "-i", video_path,
        "-vframes", "1",
        output_path,
        "-hide_banner", "-loglevel", "error", "-y",
    ]
    subprocess.run(cmd, check=True)

    return output_path


def cleanup_video(video_id: str):
    import shutil
    for d in ["videos", "frames", "srt"]:
        p = os.path.join(TEMP_DIR, d, video_id)
        if os.path.exists(p):
            shutil.rmtree(p)
