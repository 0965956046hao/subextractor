import json
import logging
import shutil
import ssl
import subprocess
import threading
import time
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


class ImportRequest(BaseModel):
    url: str = ""
    merge_id: str = ""
    filename: str = "douyin.mp4"


@router.post("/api/import-video")
def import_video(body: ImportRequest):
    """Import a video (merged file or external URL) into the OCR pipeline."""
    if not body.merge_id and not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, "url or merge_id required")

    video_id = uuid.uuid4().hex[:12]
    video_dir = settings.temp_dir / "videos" / video_id
    video_dir.mkdir(parents=True, exist_ok=True)
    video_path = video_dir / "video.mp4"

    try:
        if body.merge_id:
            src = settings.temp_dir / "merged" / f"{body.merge_id}.mp4"
            if not src.exists():
                raise HTTPException(404, "Merged file not found")
            shutil.copyfile(src, video_path)
        else:
            _download(body.url, video_path)
    except HTTPException:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise HTTPException(500, f"Import failed: {e}")

    try:
        (video_dir / "meta.json").write_text(
            json.dumps({"filename": body.filename or "douyin.mp4"}),
            encoding="utf-8",
        )
    except Exception:
        pass

    logger.info("imported video %s → %s", video_id, video_path)
    return {"video_id": video_id}


_READ_CHUNK = 1024 * 256
_CONNECT_TIMEOUT = 30
_READ_TIMEOUT = 60
_MAX_RETRIES = 3


def _download(url: str, dest: Path, on_progress=None) -> None:
    # Bypass certificate verification: local proxies (Clash/mihomo/mitm)
    # intercept HTTPS with a self-signed cert that Python doesn't trust.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    retryable = (TimeoutError, ConnectionError, OSError)
    last_err: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            _download_once(url, dest, ctx, on_progress)
            return
        except retryable as e:
            last_err = e
            logger.warning(
                "download attempt %d/%d failed: %s", attempt + 1, _MAX_RETRIES, e
            )
            if attempt < _MAX_RETRIES - 1:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Download failed after {_MAX_RETRIES} attempts: {last_err}")


def _download_once(url: str, dest: Path, ctx, on_progress) -> None:
    headers = {
        "User-Agent": _USER_AGENT,
        "Referer": "https://www.douyin.com/",
        "Accept": "*/*",
    }
    # Resume from the partial file already on disk.
    existing = dest.stat().st_size if dest.exists() else 0
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_CONNECT_TIMEOUT, context=ctx) as resp:
        status = getattr(resp, "status", 200)
        partial = status == 206 and existing > 0

        if partial:
            crange = resp.headers.get("Content-Range", "")
            total = int(crange.rsplit("/", 1)[-1]) if "/" in crange else 0
        else:
            total = int(resp.headers.get("Content-Length") or 0)

        # urllib's `timeout` also applies to every read(); raise it for the body
        # so a slow-but-alive server doesn't abort a large download.
        try:
            resp.fp.raw._sock.settimeout(_READ_TIMEOUT)
        except Exception:
            pass

        mode = "ab" if partial else "wb"
        done = existing if partial else 0
        with open(dest, mode) as f:
            while True:
                chunk = resp.read(_READ_CHUNK)
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

    def _set(stage: str, progress: int, log: str | None = None):
        job["stage"] = stage
        job["progress"] = progress
        if log:
            job.setdefault("logs", []).append({
                "message": log, "ts": time.time(), "level": "info",
            })

    try:
        _set("Đang tải video...", 0)
        logger.info("Downloading video track: %s", video_url[:120])
        _download(
            video_url, video_path,
            on_progress=lambda p: _set("Đang tải video...", int(p * 0.5), "Đang tải video..."),
        )

        _set("Đang tải audio...", 50, "Đang tải audio...")
        logger.info("Downloading audio track: %s", audio_url[:120])
        _download(
            audio_url, audio_path,
            on_progress=lambda p: _set("Đang tải audio...", 50 + int(p * 0.4)),
        )

        _set("Đang merge video + audio...", 90, "Đang merge video + audio (FFmpeg)...")

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
        job.setdefault("logs", []).append({
            "message": "Merge hoàn tất.", "ts": time.time(), "level": "success",
        })
        job["url"] = f"/api/download/merged/{merge_id}"
        job["filename"] = f"{merge_id}.mp4"
    except Exception as e:
        _cleanup()
        out_path.unlink(missing_ok=True)
        job["status"] = "error"
        job["error"] = str(e)
        job.setdefault("logs", []).append({
            "message": f"Merge thất bại: {e}", "ts": time.time(), "level": "error",
        })
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
        "logs": [{"message": "Bắt đầu tải video + audio rồi merge...", "ts": time.time(), "level": "info"}],
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
        "logs": job.get("logs", []),
    }


@router.get("/api/download/merged/{merge_id}")
async def download_merged(merge_id: str):
    path = settings.temp_dir / "merged" / f"{merge_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Merged file not found")
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)
