import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.config import settings
from app.dependencies import get_jobs
from app.services.video_processor import resolve_video_path

router = APIRouter()

MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
}


def _meta_filename(video_id: str) -> str | None:
    meta_path = settings.temp_dir / "videos" / video_id / "meta.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8")).get("filename")
    except Exception:
        return None


def _srt_exists(video_id: str) -> bool:
    return (settings.temp_dir / "srt" / video_id / "subtitles.srt").exists()


@router.get("/api/videos")
async def list_videos(jobs: dict = Depends(get_jobs)):
    videos = []

    # ── Active jobs (queued / processing / error / cancelled) ──
    active = []
    active_rows_by_video: dict[str, dict] = {}
    for job_id, job in reversed(list(jobs.items())):
        status = job.get("status")
        if status not in ("queued", "processing", "error", "cancelled"):
            continue
        video_id = job.get("video_id")
        if not video_id:
            continue
        if job.get("cancelled") and _srt_exists(video_id):
            continue
        if video_id in active_rows_by_video:
            continue
        vdir = settings.temp_dir / "videos" / video_id
        has_video = (
            any(f.stem.startswith("video") for f in vdir.iterdir())
            if vdir.exists()
            else False
        )
        row = {
            "video_id": video_id,
            "filename": _meta_filename(video_id) or video_id,
            "has_video": has_video,
            "entries": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "progress": job.get("progress", 0),
            "phase": job.get("phase", ""),
            "job_id": job_id,
            "error": job.get("error") if status == "error" else None,
        }
        active_rows_by_video[video_id] = row
        active.append(row)
    videos.extend(active)

    # ── Completed videos (have SRT on disk) ──
    srt_root = settings.temp_dir / "srt"
    seen: set[str] = set()
    if srt_root.exists():
        for srt_dir in sorted(
            srt_root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            if not srt_dir.is_dir():
                continue
            srt_path = srt_dir / "subtitles.srt"
            if not srt_path.exists():
                continue
            video_id = srt_dir.name
            if video_id in seen:
                continue
            row = active_rows_by_video.get(video_id)
            if row and row["status"] not in ("cancelled",):
                continue
            seen.add(video_id)
            vdir = settings.temp_dir / "videos" / video_id
            has_video = (
                any(f.stem.startswith("video") for f in vdir.iterdir())
                if vdir.exists()
                else False
            )
            filename = _meta_filename(video_id) or video_id
            content = srt_path.read_text(encoding="utf-8")
            entries = sum(1 for block in content.split("\n\n") if "-->" in block)
            videos.append({
                "video_id": video_id,
                "filename": filename,
                "has_video": has_video,
                "entries": entries,
                "created_at": datetime.fromtimestamp(
                    srt_path.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
                "status": "done",
            })
    return {"videos": videos}


@router.delete("/api/video/{video_id}")
async def delete_video(video_id: str):
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    srt_dir = settings.temp_dir / "srt" / video_id
    video_dir = settings.temp_dir / "videos" / video_id
    frames_dir = settings.temp_dir / "frames" / video_id
    removed_any = False
    for d in (srt_dir, video_dir, frames_dir):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            removed_any = True
    if not removed_any:
        raise HTTPException(404, "Video not found")
    return {"deleted": video_id}


def _get_video_path(video_id: str) -> Path:
    video_dir = settings.temp_dir / "videos" / video_id
    if not video_dir.exists():
        raise HTTPException(404, "Video not found")
    for f in video_dir.iterdir():
        if f.stem.startswith("video"):
            return f
    raise HTTPException(404, "Video file not found")



def _media_type(path: Path) -> str:
    return MEDIA_TYPES.get(path.suffix.lower(), "video/mp4")


@router.get("/api/video/{video_id}")
async def get_video(video_id: str):
    video_path = _get_video_path(video_id)
    return FileResponse(str(video_path), media_type=_media_type(video_path))


@router.get("/api/frame/{video_id}")
async def get_frame(video_id: str):
    from app.services.video_processor import get_first_frame

    video_path = _get_video_path(video_id)
    try:
        frame_path = get_first_frame(str(video_path), video_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to extract frame: {e}")
    return FileResponse(str(frame_path), media_type="image/jpeg")
