"""Media path + ffprobe helpers (shared by multiple services)."""

import subprocess
from pathlib import Path

from app.config import settings


def _srt_path(video_id: str) -> Path:
    p = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    if not p.exists():
        raise FileNotFoundError(f"SRT not found for {video_id}")
    return p


def _video_path(video_id: str) -> Path:
    video_dir = settings.temp_dir / "videos" / video_id
    for f in video_dir.iterdir():
        if f.stem.startswith("video"):
            return f
    raise FileNotFoundError(f"Video not found: {video_id}")


def _get_duration(video_path: str) -> float:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=30)
        return float(out.decode().strip())
    except Exception:
        return 0


def _get_video_resolution(video_path: str) -> tuple[int, int]:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            video_path,
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=30)
        w, h = out.decode().strip().split("x")
        return int(w), int(h)
    except Exception:
        return 1920, 1080


def _get_audio_duration(path: Path) -> float:
    """Return audio duration in seconds via ffprobe (0.0 on failure)."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=15,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0
