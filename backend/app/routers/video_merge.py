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
        meta = {"filename": body.filename or "douyin.mp4"}
        if body.merge_id:
            meta["source_merge_id"] = body.merge_id
        (video_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass

    logger.info("imported video %s → %s", video_id, video_path)
    return {"video_id": video_id}


_READ_CHUNK = 4 * 1024 * 1024
_CONNECT_TIMEOUT = 30
_READ_TIMEOUT = 60
_MAX_RETRIES = 3


def _probe_range(url: str, ctx) -> tuple[int, bool]:
    """Probe the CDN: does it honor Range? Returns (total_bytes, supports_range)."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Referer": "https://www.douyin.com/",
            "Accept": "*/*",
            "Range": "bytes=0-0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_CONNECT_TIMEOUT, context=ctx) as resp:
            status = getattr(resp, "status", 200)
            crange = resp.headers.get("Content-Range", "")
            if status == 206 and "/" in crange:
                total = int(crange.rsplit("/", 1)[-1])
                logger.info("range supported for %s: total=%d", url[:80], total)
                return total, True
            total = int(resp.headers.get("Content-Length") or 0)
            logger.info("range NOT supported for %s (status=%s)", url[:80], status)
            return total, False
    except Exception as e:
        logger.warning("range probe failed for %s: %s", url[:80], e)
        return 0, False


def _download_range_part(url: str, start: int, end: int, dest: Path, ctx) -> int:
    """Download one byte-range into `dest`. Returns bytes written."""
    headers = {
        "User-Agent": _USER_AGENT,
        "Referer": "https://www.douyin.com/",
        "Accept": "*/*",
        "Range": f"bytes={start}-{end}",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_CONNECT_TIMEOUT, context=ctx) as resp:
        status = getattr(resp, "status", 200)
        if status != 206:
            raise RuntimeError(f"Expected 206, got {status}")
        crange = resp.headers.get("Content-Range", "")
        if not crange.startswith(f"bytes {start}-"):
            raise RuntimeError(f"Unexpected Content-Range: {crange}")
        try:
            resp.fp.raw._sock.settimeout(_READ_TIMEOUT)
        except Exception:
            pass
        count = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(_READ_CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                count += len(chunk)
        return count


def _download_range(url: str, dest: Path, total: int, ctx, on_progress=None) -> None:
    """Download `url` in parallel Range requests into `dest`."""
    n_parts = max(1, settings.parallel_download_connections)
    chunk = (total + n_parts - 1) // n_parts
    ranges = [(i * chunk, min((i + 1) * chunk - 1, total - 1)) for i in range(n_parts)]
    ranges = [r for r in ranges if r[0] <= r[1]]

    part_paths: dict[int, Path] = {}
    results: dict[int, int] = {}
    errors: list[Exception] = []
    lock = threading.Lock()

    def _worker(idx: int, start: int, end: int):
        part_path = dest.parent / f"{dest.name}.part{idx}"
        part_paths[idx] = part_path
        last_err: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            try:
                part_path.unlink(missing_ok=True)
                written = _download_range_part(url, start, end, part_path, ctx)
                with lock:
                    results[idx] = written
                    done = sum(results.values())
                    if on_progress and total:
                        on_progress(min(99, int(done * 100 / total)))
                return
            except (TimeoutError, ConnectionError, OSError, RuntimeError) as e:
                last_err = e
                if attempt < _MAX_RETRIES - 1:
                    time.sleep(2 * (attempt + 1))
        with lock:
            errors.append(last_err or RuntimeError(f"part {idx} failed"))

    threads = [
        threading.Thread(target=_worker, args=(i, s, e))
        for i, (s, e) in enumerate(ranges)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if errors:
        for p in part_paths.values():
            p.unlink(missing_ok=True)
        raise RuntimeError(f"Parallel download failed: {errors[0]}")

    if sum(results.values()) != total:
        for p in part_paths.values():
            p.unlink(missing_ok=True)
        raise RuntimeError(
            f"Range download size mismatch: got {sum(results.values())}, expected {total}"
        )

    with open(dest, "wb") as out:
        for i in range(len(ranges)):
            with open(part_paths[i], "rb") as f:
                shutil.copyfileobj(f, out)
    for p in part_paths.values():
        p.unlink(missing_ok=True)


def _download(url: str, dest: Path, on_progress=None) -> None:
    # Bypass certificate verification: local proxies (Clash/mihomo/mitm)
    # intercept HTTPS with a self-signed cert that Python doesn't trust.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    if settings.parallel_download_enabled:
        total, supports_range = _probe_range(url, ctx)
        if supports_range and total >= settings.parallel_download_min_size:
            try:
                logger.info("parallel range download %d bytes via %d connections", total, settings.parallel_download_connections)
                _download_range(url, dest, total, ctx, on_progress)
                return
            except Exception as e:
                logger.warning("parallel range download failed (%s), falling back to sequential", e)
                for p in dest.parent.glob(f"{dest.name}.part*"):
                    p.unlink(missing_ok=True)
                dest.unlink(missing_ok=True)

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
        _t_video_start = time.time()
        _download(
            video_url, video_path,
            on_progress=lambda p: _set("Đang tải video...", int(p * 0.5), "Đang tải video..."),
        )
        _t_video = time.time() - _t_video_start
        msg = f"Đã tải video xong trong {_t_video:.1f}s."
        logger.info("video download done for %s in %.1fs", merge_id, _t_video)
        _set("Đang tải video...", 50, msg)

        _set("Đang tải audio...", 50, "Đang tải audio...")
        logger.info("Downloading audio track: %s", audio_url[:120])
        _t_audio_start = time.time()
        _download(
            audio_url, audio_path,
            on_progress=lambda p: _set("Đang tải audio...", 50 + int(p * 0.4)),
        )
        _t_audio = time.time() - _t_audio_start
        msg = f"Đã tải audio xong trong {_t_audio:.1f}s."
        logger.info("audio download done for %s in %.1fs", merge_id, _t_audio)
        _set("Đang tải audio...", 90, msg)

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

        _t_merge_start = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            err = proc.stderr[-400:] if proc.stderr else "unknown error"
            raise RuntimeError(f"FFmpeg merge failed: {err}")
        _t_merge = time.time() - _t_merge_start
        msg = f"Đã merge video + audio xong trong {_t_merge:.1f}s."
        logger.info("merge done for %s in %.1fs", merge_id, _t_merge)
        _set("Đang merge video + audio...", 100, msg)

        _cleanup()
        job["status"] = "done"
        job["stage"] = "Hoàn tất"
        job["progress"] = 100
        job.setdefault("logs", []).append({
            "message": f"Merge hoàn tất — tải video {_t_video:.1f}s, tải audio {_t_audio:.1f}s, merge {_t_merge:.1f}s.",
            "ts": time.time(), "level": "success",
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
