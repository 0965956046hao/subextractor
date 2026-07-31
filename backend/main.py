import os
import uuid
import asyncio
from contextlib import asynccontextmanager

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from config import TEMP_DIR
from video_processor import extract_frames, get_first_frame
from ocr_engine import OCREngine
from subtitle_generator import generate_srt


ocr_engine: OCREngine | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ocr_engine
    ocr_engine = OCREngine()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    video_id = uuid.uuid4().hex[:12]
    video_dir = os.path.join(TEMP_DIR, "videos", video_id)
    os.makedirs(video_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or ".mp4")[1] or ".mp4"
    video_path = os.path.join(video_dir, f"video{ext}")

    with open(video_path, "wb") as f:
        content = await file.read()
        f.write(content)

    return {"video_id": video_id}


def _resolve_video_path(video_id: str) -> str:
    video_dir = os.path.join(TEMP_DIR, "videos", video_id)
    for f in os.listdir(video_dir):
        if f.startswith("video"):
            return os.path.join(video_dir, f)
    raise HTTPException(404, "Video not found")


MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
}


def _media_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return MEDIA_TYPES.get(ext, "video/mp4")


@app.get("/api/video/{video_id}")
async def get_video(video_id: str):
    try:
        video_path = _resolve_video_path(video_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to resolve video path: {e}")
    return FileResponse(video_path, media_type=_media_type(video_path))


@app.get("/api/frame/{video_id}")
async def get_frame(video_id: str):
    video_path = _resolve_video_path(video_id)
    try:
        frame_path = get_first_frame(video_path, video_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to extract frame: {e}")
    return FileResponse(frame_path, media_type="image/jpeg")


@app.post("/api/process")
async def process_video(data: dict):
    video_id = data.get("video_id")
    region = data.get("region")

    if not video_id or not region:
        raise HTTPException(400, "Missing video_id or region")

    video_path = _resolve_video_path(video_id)

    loop = asyncio.get_event_loop()

    try:
        frames = await loop.run_in_executor(None, extract_frames, video_path, video_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to extract frames: {e}")

    if not frames:
        raise HTTPException(500, "No frames extracted")

    try:
        srt_content = await loop.run_in_executor(
            None, generate_srt, frames, region, ocr_engine
        )
    except Exception as e:
        raise HTTPException(500, f"OCR processing failed: {e}")

    srt_dir = os.path.join(TEMP_DIR, "srt", video_id)
    os.makedirs(srt_dir, exist_ok=True)
    srt_path = os.path.join(srt_dir, "subtitles.srt")

    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    return {"status": "ok", "video_id": video_id}


@app.get("/api/download/{video_id}")
async def download_srt(video_id: str):
    srt_path = os.path.join(TEMP_DIR, "srt", video_id, "subtitles.srt")

    if not os.path.exists(srt_path):
        raise HTTPException(404, "SRT file not found. Process the video first.")

    return FileResponse(
        srt_path,
        media_type="application/x-subrip",
        filename="subtitles.srt",
    )
