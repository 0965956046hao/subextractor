from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings
from app.services.video_processor import resolve_video_path

router = APIRouter()

MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
}


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
