import json
import uuid
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.config import settings

router = APIRouter()

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


@router.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    ext = Path(file.filename).suffix.lower() or ".mp4"
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    video_id = uuid.uuid4().hex[:12]
    video_dir = settings.temp_dir / "videos" / video_id
    video_dir.mkdir(parents=True, exist_ok=True)
    video_path = video_dir / f"video{ext}"

    written = 0
    try:
        with open(video_path, "wb") as f:
            while chunk := await file.read(64 * 1024):
                written += len(chunk)
                if settings.max_upload_size > 0 and written > settings.max_upload_size:
                    raise HTTPException(413, "File too large")
                f.write(chunk)
    except Exception as e:
        if video_path.exists():
            video_path.unlink()
        raise HTTPException(500, f"Upload failed: {e}")

    try:
        (video_dir / "meta.json").write_text(
            json.dumps({"filename": file.filename, "origin": "extract"}),
            encoding="utf-8",
        )
    except Exception:
        pass

    # Video upload local không có ảnh bìa/bối cảnh từ nguồn → tự sinh context ảnh
    # (chụp frame đều 30s, ghép thành 1 sheet) để Gemini dùng làm ngữ cảnh.
    # Chạy nền không block response.
    try:
        import threading
        from app.services import frame_context

        threading.Thread(
            target=frame_context.generate_context_frames,
            args=(video_id,),
            daemon=True,
        ).start()
    except Exception as e:  # never break the upload flow
        logger.warning("Frame context gen failed for %s: %s", video_id, e)

    return {"video_id": video_id}
