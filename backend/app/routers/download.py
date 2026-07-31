import re

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse

from app.config import settings

router = APIRouter()


def _srt_path(video_id: str):
    srt_path = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    if not srt_path.exists():
        raise HTTPException(404, "SRT file not found. Process the video first.")
    return srt_path


def _srt_to_txt(content: str) -> str:
    lines: list[str] = []
    for block in re.split(r"\n\s*\n", content.strip()):
        parts = block.split("\n")
        if len(parts) >= 3 and "-->" in parts[1]:
            text = " ".join(p.strip() for p in parts[2:] if p.strip())
            if text:
                lines.append(text)
    return "\n".join(lines) + ("\n" if lines else "")


@router.get("/api/download/{video_id}")
async def download_subtitles(
    video_id: str,
    format: str = Query("srt", pattern="^(srt|txt)$"),
):
    srt_path = _srt_path(video_id)
    if format == "txt":
        txt = _srt_to_txt(srt_path.read_text(encoding="utf-8"))
        return PlainTextResponse(
            txt,
            media_type="text/plain",
            headers={
                "Content-Disposition": 'attachment; filename="subtitles.txt"'
            },
        )
    return FileResponse(
        str(srt_path),
        media_type="application/x-subrip",
        filename="subtitles.srt",
    )


@router.get("/api/srt/{video_id}")
async def get_srt(video_id: str):
    srt_path = _srt_path(video_id)
    return {"content": srt_path.read_text(encoding="utf-8")}
