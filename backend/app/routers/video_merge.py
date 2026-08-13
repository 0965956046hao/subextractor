import logging
import shutil
import ssl
import subprocess
import threading
import uuid
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

_merge_jobs: dict[str, dict] = {}


class MergeRequest(BaseModel):
    video_url: str
    audio_url: str


def _download(url: str, dest: Path, on_progress=None) -> None:
    # Bypass certificate verification: local proxies (Clash/mihomo/mitm)
    # intercept HTTPS with a self-signed cert that Python doesn't trust.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Referer": "https://www.douyin.com/",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if on_progress and total:
                    on_progress(min(99, int(done * 100 / total)))


def _run_merge(merge_id: str, video_url: str, audio_url: str) -> None:
    job = _merge_jobs[merge_id]
    out_dir = settings.temp_dir / "merged"
    out_dir.mkdir(parents=True, exist_ok=True)

    video_path = out_dir / f"{merge_id}_video.mp4"
    audio_path = out_dir / f"{merge_id}_audio.mp4"
    out_path = out_dir / f"{merge_id}.mp4"

    def _cleanup():
        for p in (video_path, audio_path):
            p.unlink(missing_ok=True)

    def _set(stage: str, progress: int):
        job["stage"] = stage
        job["progress"] = progress

    try:
        _set("Đang tải video...", 0)
        logger.info("Downloading video track: %s", video_url[:120])
        _download(
            video_url, video_path,
            on_progress=lambda p: _set("Đang tải video...", int(p * 0.5)),
        )

        _set("Đang tải audio...", 50)
        logger.info("Downloading audio track: %s", audio_url[:120])
        _download(
            audio_url, audio_path,
            on_progress=lambda p: _set("Đang tải audio...", 50 + int(p * 0.4)),
        )

        _set("Đang merge video + audio...", 90)

        cmd = [
            "ffmpeg",
            "-y",
            "-i", str(video_path),
            "-i", str(audio_path),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(out_path),
        ]
        logger.info("Merging %s + %s → %s", video_path.name, audio_path.name, out_path.name)

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            err = proc.stderr[-400:] if proc.stderr else "unknown error"
            raise RuntimeError(f"FFmpeg merge failed: {err}")

        _cleanup()
        job["status"] = "done"
        job["stage"] = "Hoàn tất"
        job["progress"] = 100
        job["url"] = f"/api/download/merged/{merge_id}"
        job["filename"] = f"{merge_id}.mp4"
    except Exception as e:
        _cleanup()
        out_path.unlink(missing_ok=True)
        job["status"] = "error"
        job["error"] = str(e)
        logger.exception("merge %s failed", merge_id)


@router.post("/api/video-merge")
def merge_video_audio(body: MergeRequest):
    """Start video+audio merge in background; poll status via GET."""
    if not body.video_url.startswith(("http://", "https://")):
        raise HTTPException(400, "Invalid video_url")
    if not body.audio_url.startswith(("http://", "https://")):
        raise HTTPException(400, "Invalid audio_url")

    merge_id = uuid.uuid4().hex[:12]
    _merge_jobs[merge_id] = {
        "job_id": merge_id,
        "status": "downloading_video",
        "stage": "Đang tải video...",
        "progress": 0,
        "url": None,
        "filename": None,
        "error": None,
    }

    threading.Thread(
        target=_run_merge,
        args=(merge_id, body.video_url, body.audio_url),
        daemon=True,
    ).start()

    return {"job_id": merge_id}


@router.get("/api/video-merge/{job_id}")
async def get_merge_status(job_id: str):
    job = _merge_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Merge job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "url": job["url"],
        "filename": job["filename"],
        "error": job["error"],
    }


@router.get("/api/download/merged/{merge_id}")
async def download_merged(merge_id: str):
    path = settings.temp_dir / "merged" / f"{merge_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Merged file not found")
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)
