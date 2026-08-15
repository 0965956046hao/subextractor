import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.config import settings
from app.dependencies import get_jobs
from app.services.video_processor import resolve_video_path

logger = logging.getLogger(__name__)

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
        if not has_video and not _srt_exists(video_id):
            continue
        row = {
            "video_id": video_id,
            "filename": _meta_filename(video_id) or video_id,
            "has_video": has_video,
            "entries": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "progress": job.get("progress", 0),
            "phase": job.get("phase", ""),
            "job_type": job.get("job_type", ""),
            "job_id": job_id,
            "error": job.get("error") if status == "error" else None,
            "logs": job.get("logs", []),
        }
        active_rows_by_video[video_id] = row
        active.append(row)
    videos.extend(active)

    # ── Completed videos (have SRT on disk) ──
    srt_root = settings.temp_dir / "srt"
    seen: set[str] = set(r["video_id"] for r in active)
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
            try:
                has_video = _get_video_path(video_id).exists()
            except Exception:
                has_video = False
            filename = _meta_filename(video_id) or video_id
            content = srt_path.read_text(encoding="utf-8")
            entries = sum(1 for block in content.split("\n\n") if "-->" in block)
            has_dubbed = (settings.temp_dir / "tts" / video_id / "dubbed_video.mp4").exists()
            videos.append({
                "video_id": video_id,
                "filename": filename,
                "has_video": has_video,
                "has_dubbed": has_dubbed,
                "entries": entries,
                "created_at": datetime.fromtimestamp(
                    srt_path.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
                "status": "done",
            })

    # ── Uploaded videos (no SRT, no active job) ──
    video_root = settings.temp_dir / "videos"
    if video_root.exists():
        for vdir in sorted(
            video_root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            if not vdir.is_dir():
                continue
            video_id = vdir.name
            if video_id in seen:
                continue
            has_video = any(f.stem.startswith("video") for f in vdir.iterdir())
            if not has_video:
                continue
            seen.add(video_id)
            videos.append({
                "video_id": video_id,
                "filename": _meta_filename(video_id) or video_id,
                "has_video": has_video,
                "entries": 0,
                "created_at": datetime.fromtimestamp(
                    vdir.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
                "status": "uploaded",
            })

    return {"videos": videos}


@router.post("/api/video/{video_id}/cleanup")
async def cleanup_video(video_id: str):
    """Delete intermediate temp data for a finished video, keeping only the
    final deliverables needed to re-view / re-download the result:
    - hardcoded/{video_id}/        (final video + ASS)
    - srt/{video_id}/              (final subtitles)
    - tts/{video_id}/dubbed_video.mp4 (dubbed video)
    - videos/{video_id}/meta.json  (original filename)
    - projects/{video_id}/         (editor project state)
    """
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    removed: list[str] = []

    # videos/: keep only meta.json (needed for download filename)
    video_dir = settings.temp_dir / "videos" / video_id
    if video_dir.exists():
        for f in video_dir.iterdir():
            if f.name == "meta.json":
                continue
            if f.is_dir():
                shutil.rmtree(f, ignore_errors=True)
            else:
                f.unlink(missing_ok=True)
        removed.append("videos")

    # frames/: first frame + ocr_snapshots — intermediate
    frames_dir = settings.temp_dir / "frames" / video_id
    if frames_dir.exists():
        shutil.rmtree(frames_dir, ignore_errors=True)
        removed.append("frames")

    # context/: context files — intermediate
    context_dir = settings.temp_dir / "context" / video_id
    if context_dir.exists():
        shutil.rmtree(context_dir, ignore_errors=True)
        removed.append("context")

    # translated/: redundant (step 6 already wrote translated text into srt/)
    translated_dir = settings.temp_dir / "translated" / video_id
    if translated_dir.exists():
        shutil.rmtree(translated_dir, ignore_errors=True)
        removed.append("translated")

    # tts/: keep only dubbed_video.mp4
    tts_dir = settings.temp_dir / "tts" / video_id
    if tts_dir.exists():
        for f in tts_dir.iterdir():
            if f.name == "dubbed_video.mp4":
                continue
            if f.is_dir():
                shutil.rmtree(f, ignore_errors=True)
            else:
                f.unlink(missing_ok=True)
        removed.append("tts")

    # muxed/: intermediate
    muxed_dir = settings.temp_dir / "muxed" / video_id
    if muxed_dir.exists():
        shutil.rmtree(muxed_dir, ignore_errors=True)
        removed.append("muxed")

    return {"cleaned": video_id, "removed": removed}


@router.delete("/api/video/{video_id}")
async def delete_video(video_id: str):
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    removed: list[str] = []
    # Merged sources are flat files `temp/merged/{merge_id}.mp4` keyed by a
    # merge_id different from video_id. Read meta.json BEFORE the videos dir
    # is removed so we can also clean up the flat merged file(s).
    merge_id = None
    meta_file = settings.temp_dir / "videos" / video_id / "meta.json"
    if meta_file.exists():
        try:
            import json as _json
            meta = _json.loads(meta_file.read_text(encoding="utf-8"))
            merge_id = meta.get("source_merge_id")
        except Exception:
            merge_id = None
    for name in TEMP_DATA_SUBDIRS:
        d = settings.temp_dir / name / video_id
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            removed.append(name)
    if merge_id:
        merged_dir = settings.temp_dir / "merged"
        for suffix in ("", "_video", "_audio"):
            f = merged_dir / f"{merge_id}{suffix}.mp4"
            if f.exists():
                f.unlink(missing_ok=True)
                removed.append("merged")
    if not removed:
        raise HTTPException(404, "Video not found")
    return {"deleted": video_id, "removed": removed}


@router.post("/api/video/{video_id}/abort")
async def abort_video(video_id: str, jobs: dict = Depends(get_jobs)):
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    cancelled = 0
    for job_id, job in jobs.items():
        if job.get("video_id") == video_id and job.get("status") != "done":
            job["cancelled"] = True
            job["status"] = "cancelled"
            cancelled += 1
            logger.info("job %s: aborted via video %s", job_id, video_id)
    srt_dir = settings.temp_dir / "srt" / video_id
    video_dir = settings.temp_dir / "videos" / video_id
    frames_dir = settings.temp_dir / "frames" / video_id
    deleted = False
    for d in (srt_dir, video_dir, frames_dir):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            deleted = True
    return {"aborted": video_id, "jobs_cancelled": cancelled, "deleted": deleted}


# Sub-directories of temp/ that hold generated data (NOT config files like
# user_config.json / tts_service_account.json, which must be preserved).
TEMP_DATA_SUBDIRS = (
    "videos", "frames", "srt", "muxed", "hardcoded", "tts",
    "translated", "merged", "context", "projects",
)


@router.post("/api/temp/clear")
async def clear_temp(jobs: dict = Depends(get_jobs)):
    for job in jobs.values():
        if job.get("status") not in ("done", "cancelled"):
            job["cancelled"] = True
            job["status"] = "cancelled"
    removed = 0
    for name in TEMP_DATA_SUBDIRS:
        d = settings.temp_dir / name
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True, exist_ok=True)
            removed += 1
    logger.info("temp cleared: %d subdirs wiped", removed)
    return {"cleared": True, "subdirs_wiped": removed}


def _get_video_path(video_id: str) -> Path:
    video_dir = settings.temp_dir / "videos" / video_id
    if video_dir.exists():
        for f in video_dir.iterdir():
            if f.stem.startswith("video"):
                return f
    # Fallback: after cleanup the original video is deleted — serve the final
    # hardcoded video so the result stays reviewable (library / detail pages).
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    if hd_dir.exists():
        for f in hd_dir.glob("*_hardcoded.mp4"):
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
