from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings

router = APIRouter()


@router.get("/api/download/{video_id}")
async def download_srt(video_id: str):
    srt_path = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    if not srt_path.exists():
        raise HTTPException(404, "SRT file not found. Process the video first.")
    return FileResponse(
        str(srt_path),
        media_type="application/x-subrip",
        filename="subtitles.srt",
    )
