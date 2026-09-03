"""HTTP client for the capcut-tts-api gen-voice service.

The capcut-tts-api project (sibling of this repo) exposes a FastAPI service on
:8100 that wraps the CapCut TTS SDK. This client submits voice-generation jobs,
polls for completion, and downloads the per-segment MP3 files.

Endpoints used:
    GET  {url}/api/health
    GET  {url}/api/voices?lang=vi-VN
    POST {url}/api/tts                      {segments, voice, rate, filename_prefix}
    GET  {url}/api/tts/{job_id}
    GET  {url}/api/tts/{job_id}/audio/{filename}
"""

import logging
import shutil
import tempfile
import time

from pathlib import Path
from typing import List, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


def _base_url() -> str:
    return settings.capcut_tts_url.rstrip("/")


class CapCutTTSError(RuntimeError):
    pass


def check_health() -> dict:
    """Ping the service and report voices loaded."""
    try:
        r = httpx.get(f"{_base_url()}/api/health", timeout=5)
        r.raise_for_status()
        data = r.json()
        return {"healthy": data.get("status") == "ok", "voices_loaded": data.get("voices_loaded", 0)}
    except Exception as e:
        logger.warning("CapCut TTS service health check failed: %s", e)
        return {"healthy": False, "voices_loaded": 0, "error": str(e)}


def list_voices(lang: str = "vi-VN") -> List[dict]:
    """List CapCut voices from the service catalog, optionally filtered by lang."""
    try:
        r = httpx.get(f"{_base_url()}/api/voices", params={"lang": lang}, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise CapCutTTSError(f"Không lấy được danh sách giọng CapCut: {e}") from e


def submit_job(
    segments: List[dict],
    voice: str,
    rate: str = "1.0",
    filename_prefix: str = "segment",
) -> str:
    """Submit a TTS job to the service; returns the job_id."""
    try:
        r = httpx.post(
            f"{_base_url()}/api/tts",
            json={
                "segments": segments,
                "voice": voice,
                "rate": rate,
                "filename_prefix": filename_prefix,
            },
            timeout=30,
        )
        r.raise_for_status()
        job_id = r.json().get("job_id")
        if not job_id:
            raise CapCutTTSError("Service trả về job_id rỗng")
        return job_id
    except CapCutTTSError:
        raise
    except Exception as e:
        raise CapCutTTSError(f"Không gửi được job TTS CapCut: {e}") from e


def poll_job(
    job_id: str,
    timeout: Optional[float] = None,
    poll_interval: float = 1.0,
    log_fn=None,
) -> dict:
    """Poll a TTS job until done/error/cancelled; returns the final job dict.

    If ``log_fn`` is provided, per-segment logs emitted by the service (stored
    in ``job["logs"]``) are forwarded to it as soon as they appear, so the
    caller can stream progress to the UI while the batch is still generating.
    """
    deadline = time.time() + (timeout if timeout is not None else settings.capcut_tts_timeout)
    seen_logs = 0
    while time.time() < deadline:
        try:
            r = httpx.get(f"{_base_url()}/api/tts/{job_id}", timeout=15)
            r.raise_for_status()
        except Exception as e:
            logger.warning("Poll CapCut TTS job %s failed: %s", job_id, e)
            time.sleep(poll_interval)
            continue
        job = r.json()
        if log_fn:
            logs = job.get("logs") or []
            for entry in logs[seen_logs:]:
                log_fn(
                    entry.get("message", ""),
                    level=entry.get("level", "info"),
                )
            seen_logs = len(logs)
        status = job.get("status", "")
        if status in ("done", "error", "cancelled"):
            return job
        time.sleep(poll_interval)
    raise CapCutTTSError(f"Job TTS CapCut {job_id} timeout sau {settings.capcut_tts_timeout}s")


def download_audio(job_id: str, filename: str, out_path: Path) -> Path:
    """Download a single generated audio file from the service into out_path."""
    url = f"{_base_url()}/api/tts/{job_id}/audio/{filename}"
    try:
        r = httpx.get(url, timeout=60)
        r.raise_for_status()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(r.content)
        return out_path
    except Exception as e:
        raise CapCutTTSError(f"Không tải được audio CapCut {filename}: {e}") from e


def generate_segments_to_dir(
    texts: List[str],
    out_dir: Path,
    voice: str,
    rate: str = "1.0",
    prefix: str = "segment",
    progress_callback=None,
    log_fn=None,
    indices: Optional[List[int]] = None,
) -> List[Path]:
    """Submit one batch job for all texts, then download each MP3 into out_dir.

    Files are written as ``{out_dir}/{prefix}_{i:04d}.mp3`` (1-based index) to
    match the convention expected by `combine_tts_mp3`. Failures are skipped and
    a progress_callback(done, total) is invoked after each download. If
    ``log_fn`` is provided, per-segment service logs are streamed to it.

    ``indices`` (optional, same length as ``texts``) maps the k-th submitted
    text to its original 1-based line index, so downloaded files are named
    ``{prefix}_{indices[k]:04d}.mp3`` instead of by submission position. This
    lets a resume run submit only the still-missing lines while keeping the
    line numbering stable on disk.
    """
    segments = [{"text": t, "start": 0.0, "end": 0.0} for t in texts]
    job_id = submit_job(segments, voice, rate, prefix)
    logger.info("capcut tts job %s submitted (%d segments, voice=%s)", job_id, len(segments), voice)

    # First-time voice synthesis is slow (~3s/segment); scale the poll timeout
    # with the segment count so long videos don't hit the default ceiling.
    timeout = max(settings.capcut_tts_timeout, len(segments) * 10 + 120)
    job = poll_job(job_id, timeout=timeout, log_fn=log_fn)
    status = job.get("status")
    if status != "done":
        raise CapCutTTSError(f"Job TTS CapCut {job_id} kết thúc với status={status}: {job.get('error', '')}")

    audio_files = job.get("audio_files") or []
    written: List[Path] = []
    for path_str in audio_files:
        filename = Path(path_str).name
        i = _index_from_filename(filename, prefix)
        orig_idx = indices[i - 1] if indices and 1 <= i <= len(indices) else i
        target = out_dir / (f"{prefix}_{orig_idx:04d}.mp3" if prefix else f"{orig_idx:04d}.mp3")
        try:
            download_audio(job_id, filename, target)
            written.append(target)
        except Exception as e:
            logger.warning("capcut tts: cannot download %s: %s", filename, e)
        if progress_callback:
            progress_callback(len(written), len(audio_files))

    return written


def warmup_capcut(
    voice: str,
    rate: str = "1.0",
    text: str = "xin chào",
    attempts: int = 10,
) -> bool:
    """Làm ấm SDK CapCut (health-check) bằng cách sinh 1 đoạn ngắn trước batch.

    Trả True nếu sinh thành công. Dùng trước các batch lớn để tránh các segment
    đầu bị fail do cold-start của service (lần gọi đầu SDK thường chậm / drop vài
    đoạn đầu). Thất bại không cản trở batch chính — chỉ mang tính chất kiểm tra
    và làm ấm kết nối; batch chính vẫn được thử dù warm-up lỗi.
    """
    tmp = Path(tempfile.mkdtemp(prefix="capcut_warmup_"))
    try:
        for _ in range(max(1, attempts)):
            try:
                written = generate_segments_to_dir(
                    [text], tmp, voice=voice, rate=rate, prefix="warmup"
                )
                if any(p.exists() and p.stat().st_size > 0 for p in written):
                    return True
            except Exception as e:
                logger.warning("CapCut warmup attempt failed: %s", e)
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _index_from_filename(name: str, prefix: str) -> int:
    """Extract the 1-based segment index from a service-side filename."""
    import re

    m = re.search(r"(?:^|_)(\d{1,4})\.mp3$", name)
    if m:
        return int(m.group(1))
    return len(name)  # fallback — will sort to the end
