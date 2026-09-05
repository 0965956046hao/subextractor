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


def _save_context_files(
    ctx_dst: Path,
    thumbnail_url: str,
    big_thumbs: list[str],
    on_log=None,
    on_complete=None,
) -> None:
    """Download thumbnail + big thumbs images into a context dir (2 threads).

    on_log(message, level) — ghi log tiến trình (tuỳ chọn).
    on_complete(kind)      — báo 1 nhánh ("thumbnail"/"big_thumbs") tải xong (tuỳ chọn).
    """
    ctx_dst.mkdir(parents=True, exist_ok=True)

    def _dl_thumb() -> None:
        if not thumbnail_url:
            return
        try:
            dest = ctx_dst / "thumbnail.jpg"
            _download(thumbnail_url, dest)
            logger.info("Thumbnail saved to %s", dest)
            if on_log:
                on_log("Đã tải thumbnail.", "info")
            if on_complete:
                on_complete("thumbnail")
        except Exception as e:
            logger.warning("Thumbnail download failed: %s", e)
            if on_log:
                on_log(f"Thumbnail: lỗi tải ảnh ({e})", "warn")

    def _dl_big_thumbs() -> None:
        bts = big_thumbs or []
        if not bts:
            return
        thumb_dir = ctx_dst / "context_images"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        ok = 0
        for idx, u in enumerate(bts):
            dest = thumb_dir / f"context_{idx}.jpg"
            try:
                _download(u, dest)
                ok += 1
            except Exception as e:
                logger.warning("Big thumb %d download failed: %s", idx, e)
        logger.info("%d big thumb images saved to %s", ok, thumb_dir)
        if ok:
            if on_log:
                on_log(f"Đã tải {ok} ảnh ngữ cảnh.", "info")
            if on_complete:
                on_complete("big_thumbs")
        elif on_log:
            on_log("Ảnh ngữ cảnh: lỗi tải ảnh", "warn")

    threads = [
        threading.Thread(target=_dl_thumb),
        threading.Thread(target=_dl_big_thumbs),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


class MergeRequest(BaseModel):
    video_url: str
    audio_url: str
    thumbnail_url: str = ""
    big_thumbs: list[str] = []


class ImportRequest(BaseModel):
    url: str = ""
    merge_id: str = ""
    filename: str = "douyin.mp4"
    thumbnail_url: str = ""
    big_thumbs: list[str] = []


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
            src = settings.temp_dir / "merged" / f"{body.merge_id}_video.mp4"
            if not src.exists():
                raise HTTPException(404, "Merged file not found")
            shutil.copyfile(src, video_path)
        else:
            # Download thumbnail + big_thumbs in parallel with the video itself.
            ctx_dst = settings.temp_dir / "context" / video_id
            ctx_dst.mkdir(parents=True, exist_ok=True)
            ctx_thread = None
            if body.thumbnail_url or body.big_thumbs:
                ctx_thread = threading.Thread(
                    target=_save_context_files,
                    args=(ctx_dst, body.thumbnail_url, body.big_thumbs),
                )
                ctx_thread.start()
            try:
                _download(body.url, video_path)
            finally:
                if ctx_thread:
                    ctx_thread.join()
    except HTTPException:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise HTTPException(500, f"Import failed: {e}")

    # Copy thumbnail vào context dir của video. Không copy context_images nữa:
    # context_service._context_image_paths đọc trực tiếp từ merged/{merge_id}_context/context_images,
    # nên bản copy là thừa (~vài MB/file x2 lần copy).
    if body.merge_id:
        ctx_src = settings.temp_dir / "merged" / f"{body.merge_id}_context"
        if ctx_src.exists():
            thumb_src = ctx_src / "thumbnail.jpg"
            if thumb_src.exists():
                ctx_dst = settings.temp_dir / "context" / video_id
                ctx_dst.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(thumb_src, ctx_dst / "thumbnail.jpg")
                logger.info("Copied thumbnail for %s from merge %s", video_id, body.merge_id)

    try:
        meta = {"filename": body.filename or "douyin.mp4", "origin": "pipeline"}
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


def _ffmpeg_bin(name: str = "ffmpeg") -> str:
    """Resolve ffmpeg/ffprobe binary on Windows (WinGet) and Unix."""
    # Check PATH first
    found = shutil.which(name)
    if found:
        return found
    # WinGet Gyan.FFmpeg installs to versioned dir, not always in process PATH
    import os, glob
    # Common WinGet location
    candidates = glob.glob(
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*-full_build\bin\ffmpeg.exe")
    )
    if name == "ffprobe":
        candidates = [c.replace("ffmpeg.exe", "ffprobe.exe") for c in candidates]
    for c in candidates:
        if Path(c).exists():
            return c
    # Fallback extra locations
    for p in [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\FFmpeg\bin\ffmpeg.exe",
    ]:
        pp = p.replace("ffmpeg.exe", f"{name}.exe") if name != "ffmpeg" else p
        if Path(pp).exists():
            return pp
    return name  # let subprocess raise clear error


def _probe_audio_codec(path: Path) -> str:
    """Return the audio codec name (e.g. 'aac', 'mp3', 'opus') via ffprobe."""
    try:
        proc = subprocess.run(
            [
                _ffmpeg_bin("ffprobe"), "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=15,
        )
        return (proc.stdout or "").strip().lower()
    except Exception:
        return ""


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


def _run_merge(merge_id: str, video_url: str, audio_url: str, thumbnail_url: str = "", big_thumbs: list[str] | None = None) -> None:
    job = _merge_jobs[merge_id]
    out_dir = settings.temp_dir / "merged"
    out_dir.mkdir(parents=True, exist_ok=True)

    video_path = out_dir / f"{merge_id}_video.mp4"
    audio_path = out_dir / f"{merge_id}_audio.mp4"
    out_path = out_dir / f"{merge_id}.mp4"
    ctx_dir = out_dir / f"{merge_id}_context"
    ctx_dir.mkdir(parents=True, exist_ok=True)

    state = {"lock": threading.Lock(), "done": 0.0, "parts": {}}
    _times: dict[str, float] = {}
    # Trọng số tiến trình: video 0.5, audio 0.4, thumbnail 0.05, big_thumbs 0.05.
    _WEIGHTS = {"video": 0.5, "audio": 0.4, "thumbnail": 0.05, "big_thumbs": 0.05}

    def _set(stage: str, progress: int, log: str | None = None):
        with state["lock"]:
            job["stage"] = stage
            job["progress"] = progress
            if log:
                job.setdefault("logs", []).append({
                    "message": log, "ts": time.time(), "level": "info",
                })

    def _update_progress(label: str, part: float, log: str | None = None):
        # part ∈ [0,1] của nhánh `label`; tổng = Σ(trọng số × part). Dùng max để
        # tiến trình không bao giờ lùi; cap ở 90 để chừa chỗ cho bước merge (90→100).
        with state["lock"]:
            state["parts"][label] = part
            done = sum(_WEIGHTS[k] * v for k, v in state["parts"].items())
            state["done"] = max(state["done"], done)
            job["stage"] = "Đang tải video + audio (song song)..."
            job["progress"] = min(90, int(state["done"] * 100))
            if log:
                job.setdefault("logs", []).append({
                    "message": log, "ts": time.time(), "level": "info",
                })

    def _download_track(label: str, url: str, dest: Path) -> None:
        logger.info("Downloading %s track (parallel): %s", label, url[:120])
        start = time.time()
        _download(
            url, dest,
            on_progress=lambda p: _update_progress(label, p / 100),
        )
        elapsed = time.time() - start
        _times[label] = elapsed
        msg = f"Đã tải {label} xong trong {elapsed:.1f}s."
        logger.info("%s download done for %s in %.1fs", label, merge_id, elapsed)
        _update_progress(label, 1.0, msg)

    def _load_times():
        with state["lock"]:
            return dict(_times)

    try:
        _set("Đang tải video + audio (song song)...", 0, "Bắt đầu tải video + audio + ảnh ngữ cảnh song song...")

        def _ctx_log(msg: str, level: str) -> None:
            with state["lock"]:
                job.setdefault("logs", []).append({
                    "message": msg, "ts": time.time(), "level": level,
                })

        def _ctx_complete(kind: str) -> None:
            _update_progress(kind, 1.0)

        # Tải video, audio, thumbnail và ảnh ngữ cảnh (big_thumbs) đồng thời.
        threads = [
            threading.Thread(target=_download_track, args=("video", video_url, video_path)),
            threading.Thread(target=_download_track, args=("audio", audio_url, audio_path)),
            threading.Thread(
                target=_save_context_files,
                args=(ctx_dir, thumbnail_url, big_thumbs or [], _ctx_log, _ctx_complete),
            ),
        ]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        times = _load_times()
        _t_video = times.get("video", 0.0)
        _t_audio = times.get("audio", 0.0)

        _set("Đang merge video + audio...", 90, "Đang merge video + audio (FFmpeg)...")

        audio_codec = _probe_audio_codec(audio_path)
        use_audio_copy = audio_codec == "aac"
        if use_audio_copy:
            logger.info("Audio already AAC → copy (no re-encode)")
        else:
            logger.info("Audio codec is %s → re-encode to AAC", audio_codec or "unknown")

        cmd = [
            _ffmpeg_bin("ffmpeg"),
            "-y",
            "-i", str(video_path),
            "-i", str(audio_path),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
        ]
        if use_audio_copy:
            cmd += ["-c:a", "copy"]
        else:
            cmd += ["-c:a", "aac", "-b:a", "192k"]
        cmd += [
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
        args=(merge_id, body.video_url, body.audio_url, body.thumbnail_url, body.big_thumbs),
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
