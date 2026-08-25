"""Video source resolvers for the AutoPipeline.

Adds a YouTube import path built on yt-dlp: given a YouTube URL it downloads the
best combined (video+audio) format into the video store and registers it, so the
pipeline can continue straight to region selection (skipping resolve → merge).
"""

import asyncio
import json
import logging
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

_DOWNLOAD_TIMEOUT = 900


class YtImportRequest(BaseModel):
    url: str


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[\u0000-\u001f<>:"/\\|?*\u007f]+', " ", name or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:120]
    return cleaned or "youtube_video"


def _ytdlp_cmd() -> list[str]:
    """Resolve the yt-dlp executable (venv binary or `python -m yt_dlp`)."""
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    return [sys.executable, "-m", "yt_dlp"]


def _run_yt_dlp(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    cmd = _ytdlp_cmd() + args
    logger.info("yt-dlp: %s", " ".join(str(a) for a in cmd))
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=_DOWNLOAD_TIMEOUT,
        cwd=str(cwd) if cwd else None,
    )


def _yt_title(url: str) -> str:
    proc = _run_yt_dlp(
        ["--no-playlist", "--no-warnings", "--print", "%(title)s", url]
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(f"Không lấy được thông tin video: {err}")
    return proc.stdout.strip()


def _yt_download(url: str, out_dir: Path) -> None:
    # Prefer MP4/H.264 (bv*[ext=mp4][vcodec^=avc1]) because some OpenCV builds
    # cannot decode AV1/VP9 when the OCR pipeline reads frames. Fall back to any
    # MP4, then anything (yt-dlp merges/converts to an .mp4 container).
    proc = _run_yt_dlp(
        [
            "--no-playlist",
            "--no-warnings",
            "-f", "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
            "--merge-output-format", "mp4",
            "-o", str(out_dir / "video.%(ext)s"),
            url,
        ]
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(f"Tải video thất bại: {err}")


def _download_and_register(url: str, source: str) -> dict:
    """Download a video via yt-dlp (auto-merge) and register it in the store.

    Returns ``{video_id, title, filename, video_path}``. Raises on failure.
    """
    video_id = uuid.uuid4().hex[:12]
    video_dir = settings.temp_dir / "videos" / video_id
    video_dir.mkdir(parents=True, exist_ok=True)

    try:
        title = _yt_title(url)
        filename = f"{_sanitize_filename(title)}.mp4"
        _yt_download(url, video_dir)
    except Exception as e:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise RuntimeError(str(e)) from e

    video_path = video_dir / "video.mp4"
    if not video_path.exists() or video_path.stat().st_size == 0:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise RuntimeError("Tải video thất bại: file rỗng hoặc không tìm thấy")

    try:
        (video_dir / "meta.json").write_text(
            json.dumps(
                {"filename": filename, "source": source, "source_url": url, "title": title},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass

    logger.info("%s import %s → %s (%s)", source, video_id, filename, video_path)
    return {"video_id": video_id, "title": title, "filename": filename, "video_path": str(video_path)}


@router.post("/api/video-download/yt-import")
async def yt_import(body: YtImportRequest):
    """Download a YouTube video via yt-dlp and register it for the pipeline."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL không hợp lệ")

    try:
        result = await asyncio.to_thread(_download_and_register, url, "youtube")
    except Exception as e:
        raise HTTPException(500, str(e))

    return {"video_id": result["video_id"], "title": result["title"], "filename": result["filename"]}


class DouyinResolveRequest(BaseModel):
    url: str


@router.post("/api/video-download/resolve")
async def douyin_resolve(body: DouyinResolveRequest):
    """Resolve a Douyin link: download the video via yt-dlp and register it.

    Returns ``{video_id, title, filename, video_url}`` where ``video_url`` is
    the local serving path for the downloaded file.
    """
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL không hợp lệ")

    try:
        result = await asyncio.to_thread(_download_and_register, url, "douyin")
    except Exception as e:
        raise HTTPException(500, f"Tải video Douyin thất bại: {e}")

    return {
        "video_id": result["video_id"],
        "title": result["title"],
        "filename": result["filename"],
        "video_url": f"/api/video/{result['video_id']}",
    }
    return {"video_id": video_id, "title": title, "filename": filename}
