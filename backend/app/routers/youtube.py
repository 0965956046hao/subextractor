import json
import logging
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from pydantic import BaseModel
from fastapi.responses import FileResponse

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

YOUTUBE_UPLOADER_DIR = Path(__file__).resolve().parent.parent.parent.parent / "youtubeuploader"
YOUTUBE_UPLOADER_BIN = YOUTUBE_UPLOADER_DIR / "youtubeuploader"
CLIENT_SECRETS_PATH = YOUTUBE_UPLOADER_DIR / "client_secrets.json"
REQUEST_TOKEN_PATH = YOUTUBE_UPLOADER_DIR / "request.token"

_youtube_jobs: dict[str, dict] = {}


class ListFilesRequest(BaseModel):
    path: str


class GenerateMetaRequest(BaseModel):
    title: str = ""
    ctr_title: str = ""
    description: str = ""
    tags: list[str] = []
    hashtags: list[str] = []
    episode: int = 1
    original_title: str = ""
    original_description: str = ""
    raw_input: str = ""


class UploadRequest(BaseModel):
    video_path: str
    meta_path: str
    thumbnail_path: str = ""
    privacy: str = "private"


@router.post("/api/youtube/pick-folder")
async def pick_folder():
    """Open native macOS folder picker via osascript."""
    script = (
        'osascript -e \'POSIX path of (choose folder with prompt "Chọn thư mục chứa video")\''
    )
    try:
        proc = subprocess.run(script, shell=True, capture_output=True, text=True, timeout=300)
        path = proc.stdout.strip()
        if path and proc.returncode == 0:
            return {"path": path}
        return {"path": "", "cancelled": True}
    except Exception as e:
        raise HTTPException(500, f"Folder picker failed: {e}")


@router.post("/api/youtube/list-files")
async def list_folder_files(body: ListFilesRequest):
    """List .mov files and image files in a folder."""
    folder = Path(body.path)
    if not folder.exists():
        raise HTTPException(404, f"Folder not found: {body.path}")
    if not folder.is_dir():
        raise HTTPException(400, "Path is not a directory")

    videos = sorted(
        [f.name for f in folder.glob("*.mov")] +
        [f.name for f in folder.glob("*.mp4")]
    )
    images = sorted(
        [f.name for f in folder.glob("*.jpg")] +
        [f.name for f in folder.glob("*.jpeg")] +
        [f.name for f in folder.glob("*.png")]
    )
    return {
        "path": str(folder),
        "videos": videos,
        "images": images,
    }


@router.post("/api/youtube/generate-meta")
async def generate_meta(body: GenerateMetaRequest, request: Request):
    """Use Gemini to parse raw input into structured meta.json."""
    from app.services.translation_service import _read_user_config
    from app.services.retry_utils import configured_gemini_keys, gemini_call_rotating, genai_generate_content_factory

    cfg = _read_user_config()
    keys = configured_gemini_keys()
    if not keys:
        raise HTTPException(400, "Gemini API key not configured")

    try:
        from google import genai
    except ImportError:
        raise HTTPException(400, "google-genai not installed")

    prompt = f"""Parse the following video metadata into a valid JSON object with this exact structure:

{{
  "title": "Vietnamese title here",
  "ctr_title": "Giật tít hấp dẫn bấm vào để xem",
  "description": "Full Vietnamese description with \\n line breaks",
  "tags": ["tag1", "tag2", ...],
  "hashtags": ["#Hashtag1", "#Hashtag2", ...],
  "episode": 1,
  "original_title": "Original Chinese/English title",
  "original_description": "Original short description"
}}

Rules:
- title: catchy Vietnamese title, include episode number if provided
- ctr_title: 3-5 đề xuất tiêu đề giật tít (clickbait) bằng tiếng Việt để tăng CTR, tách nhau bởi " | ". Mỗi tiêu đề ngắn gọn, kích thích tò mò, gây sốc nhẹ nhưng KHÔNG bịa nội dung không có trong video
- description: detailed Vietnamese description with paragraphs separated by \\n\\n, include info about genre, episode number, series name
- tags: 10-15 relevant search keywords in Vietnamese and original language
- hashtags: 8-10 hashtags with # prefix, no spaces (CamelCase format)
- episode: integer episode number
- original_title: keep the original language title
- original_description: keep the original short description

User input:
"""
    if body.raw_input:
        prompt += f"\nRaw content to parse:\n{body.raw_input}"
    else:
        prompt += f"""
Title: {body.title}
Description: {body.description}
Tags: {", ".join(body.tags) if body.tags else "none"}
Episode: {body.episode}
Original title: {body.original_title or "unknown"}
Original description: {body.original_description or "unknown"}
"""

    prompt += "\n\nOutput ONLY the JSON object, no markdown, no explanation."

    try:
        response = gemini_call_rotating(
            genai_generate_content_factory,
            model=settings.gemini_model,
            contents=prompt,
            config={"temperature": 0.3},
        )
        raw = response.text.strip()
        # Strip markdown code fences
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        meta = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Gemini returned invalid JSON: {e}\n\nRaw: {raw[:500]}")
    except Exception as e:
        raise HTTPException(500, f"Gemini API error: {e}")

    # Ensure all required fields
    meta.setdefault("title", body.title)
    meta.setdefault("ctr_title", body.ctr_title)
    meta.setdefault("description", body.description)
    meta.setdefault("tags", body.tags or [])
    meta.setdefault("hashtags", body.hashtags or [])
    meta.setdefault("episode", body.episode)
    meta.setdefault("original_title", body.original_title)
    meta.setdefault("original_description", body.original_description)

    return {"meta": meta}


class SaveMetaRequest(BaseModel):
    folder: str
    filename: str
    meta: dict


@router.post("/api/youtube/save-meta")
async def save_meta_file(body: SaveMetaRequest):
    """Save meta.json to disk."""
    folder = Path(body.folder)
    folder.mkdir(parents=True, exist_ok=True)
    filepath = folder / body.filename
    filepath.write_text(json.dumps(body.meta, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Meta saved to %s", filepath)
    return {"path": str(filepath)}


@router.get("/api/youtube/config")
async def get_youtube_config():
    """Check if youtubeuploader is configured."""
    return {
        "has_client_secrets": CLIENT_SECRETS_PATH.exists(),
        "has_request_token": REQUEST_TOKEN_PATH.exists(),
        "has_binary": YOUTUBE_UPLOADER_BIN.exists(),
        "secrets_path": str(CLIENT_SECRETS_PATH),
    }


class SaveSecretsRequest(BaseModel):
    content: str


@router.post("/api/youtube/config")
async def save_youtube_config(body: SaveSecretsRequest):
    """Save client_secrets.json for youtubeuploader."""
    try:
        json.loads(body.content)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON content")
    CLIENT_SECRETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLIENT_SECRETS_PATH.write_text(body.content, encoding="utf-8")
    logger.info("client_secrets.json saved to %s", CLIENT_SECRETS_PATH)
    return {"status": "ok", "path": str(CLIENT_SECRETS_PATH)}


@router.post("/api/youtube/setup")
async def setup_youtube_environment():
    """Install Go and build youtubeuploader binary (macOS)."""
    import platform
    if platform.system() != "Darwin":
        raise HTTPException(400, "Setup only supported on macOS")

    output_lines = []

    def run(cmd: list[str], cwd=None):
        proc = subprocess.run(cmd, cwd=cwd or str(YOUTUBE_UPLOADER_DIR),
                              capture_output=True, text=True, timeout=300)
        output_lines.append(f"$ {' '.join(cmd)}")
        if proc.stdout.strip():
            output_lines.append(proc.stdout.strip())
        if proc.stderr.strip():
            output_lines.append(proc.stderr.strip())
        return proc.returncode, proc.stdout, proc.stderr

    # Check if Go is installed
    rc, stdout, _ = run(["which", "go"])
    has_go = rc == 0

    if not has_go:
        output_lines.append("Installing Go via Homebrew...")
        rc, _, stderr = run(["brew", "install", "go"])
        if rc != 0:
            return {"status": "error", "output": output_lines,
                    "error": f"Failed to install Go: {stderr}"}
        output_lines.append("Go installed successfully")

    # Build youtubeuploader
    output_lines.append("Building youtubeuploader...")
    rc, _, stderr = run(["go", "build", "-o", "youtubeuploader", "./cmd/youtubeuploader"])
    if rc != 0:
        return {"status": "error", "output": output_lines,
                "error": f"Build failed: {stderr}"}

    output_lines.append("youtubeuploader built successfully")
    return {"status": "success", "output": output_lines,
            "binary": str(YOUTUBE_UPLOADER_BIN)}


def _ensure_imagemagick() -> str:
    """Return the magick binary path, installing via brew if needed."""
    if subprocess.run(["which", "magick"], capture_output=True).returncode == 0:
        return "magick"
    if subprocess.run(["which", "convert"], capture_output=True).returncode == 0:
        return "convert"
    logger.info("ImageMagick not found, installing via Homebrew...")
    proc = subprocess.run(["brew", "install", "imagemagick"], capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to install ImageMagick: {proc.stderr}")
    return "magick"


def _process_thumbnail(thumb_path: Path) -> Path:
    """Validate thumbnail is 1280x720; resize if needed. Returns processed path."""
    if not thumb_path.exists():
        return thumb_path

    magick = _ensure_imagemagick()

    # Check dimensions
    identify = subprocess.run(
        ["identify", "-format", "%wx%h", str(thumb_path)],
        capture_output=True, text=True,
    )
    dims = identify.stdout.strip()

    if dims == "1280x720":
        logger.info("Thumbnail already 1280x720: %s", thumb_path)
        return thumb_path

    logger.info("Thumbnail %s is %s, resizing to 1280x720", thumb_path.name, dims or "unknown")

    # Output as .jpg next to original
    out_path = thumb_path.with_suffix(".jpg")
    cmd = [
        magick, str(thumb_path),
        "-resize", "1280x720^",
        "-gravity", "center",
        "-extent", "1280x720",
        "-strip",
        "-quality", "90",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        logger.warning("ImageMagick resize failed: %s", proc.stderr)
        return thumb_path

    # Verify
    identify = subprocess.run(
        ["identify", "-format", "%wx%h", str(out_path)],
        capture_output=True, text=True,
    )
    logger.info("Processed thumbnail: %s -> %s (%s)", thumb_path.name, out_path.name, identify.stdout.strip())

    return out_path


def _start_upload(video_path: Path, meta_path: Path, thumbnail_path: str, privacy: str) -> dict:
    """Start YouTube upload in background, return job_id for polling."""
    if not CLIENT_SECRETS_PATH.exists():
        raise HTTPException(400, "client_secrets.json not found. Please configure YouTube API credentials first.")
    if not YOUTUBE_UPLOADER_BIN.exists():
        raise HTTPException(500, f"youtubeuploader binary not found at {YOUTUBE_UPLOADER_BIN}")

    if not video_path.exists():
        raise HTTPException(404, f"Video not found: {video_path}")
    if not meta_path.exists():
        raise HTTPException(404, f"Meta JSON not found: {meta_path}")

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "status": "uploading",
        "progress": 0,
        "output_lines": [],
        "error": None,
        "video_path": str(video_path),
        "meta_path": str(meta_path),
    }
    _youtube_jobs[job_id] = job

    cmd = [
        str(YOUTUBE_UPLOADER_BIN),
        "-filename", str(video_path),
        "-metaJSON", str(meta_path),
        "-privacy", privacy,
    ]
    if thumbnail_path:
        thumb = Path(thumbnail_path)
        if thumb.exists():
            try:
                thumb = _process_thumbnail(thumb)
            except Exception as e:
                logger.warning("Thumbnail processing failed: %s", e)
            cmd.extend(["-thumbnail", str(thumb)])

    logger.info("Running youtubeuploader: %s", " ".join(cmd))

    def _run():
        import re
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(YOUTUBE_UPLOADER_DIR),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0,
            )
            buffer = b""
            while True:
                chunk = proc.stdout.read(1) if proc.stdout else b""
                if not chunk:
                    break
                buffer += chunk
                if chunk in (b"\r", b"\n"):
                    line = buffer.decode("utf-8", errors="ignore").strip()
                    buffer = b""
                    if line:
                        job["output_lines"].append(line)
                        m = re.search(r"\((\d+(?:\.\d+)?)%\)", line)
                        if m:
                            try:
                                job["progress"] = min(99, int(float(m.group(1))))
                            except ValueError:
                                pass
                        logger.info("youtubeuploader: %s", line)

            proc.wait(timeout=3600)
            if proc.returncode == 0:
                job["status"] = "done"
                job["progress"] = 100
            else:
                job["status"] = "error"
                job["error"] = f"Exit code: {proc.returncode}"
        except subprocess.TimeoutExpired:
            proc.kill()
            job["status"] = "error"
            job["error"] = "Upload timed out after 1 hour"
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "uploading"}


@router.post("/api/youtube/upload")
async def upload_to_youtube(body: UploadRequest):
    """Start YouTube upload in background, return job_id for polling."""
    return _start_upload(Path(body.video_path), Path(body.meta_path), body.thumbnail_path, body.privacy)


@router.post("/api/youtube/upload/{video_id}")
async def upload_video_by_id(video_id: str):
    """Upload the hardcoded/dubbed video with the generated meta to YouTube."""
    # Resolve video path
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    video_path = None
    if hd_dir.exists():
        files = list(hd_dir.glob("*_hardcoded.mp4"))
        if files:
            video_path = files[0]
    if video_path is None:
        dubbed = settings.temp_dir / "tts" / video_id / "dubbed_video.mp4"
        if dubbed.exists():
            video_path = dubbed
    if video_path is None:
        raise HTTPException(404, "Video not found. Run hardcode/dub first.")

    meta_path = settings.temp_dir / "meta" / video_id / "meta.json"
    if not meta_path.exists():
        raise HTTPException(404, "meta.json not found. Run meta step first.")

    # Chỉ up thumbnail nếu có file thumbnail đã tạo
    thumbnail_path = ""
    thumb_file = settings.temp_dir / "thumb" / video_id / "thumbnail.png"
    if thumb_file.exists():
        thumbnail_path = str(thumb_file)

    return _start_upload(video_path, meta_path, thumbnail_path, "private")


@router.get("/api/youtube/upload/{job_id}")
async def get_upload_status(job_id: str):
    """Poll upload job status."""
    job = _youtube_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "output_lines": job["output_lines"],
        "error": job["error"],
    }


@router.get("/api/youtube/thumbnail/{path:path}")
async def serve_thumbnail(path: str):
    """Serve a thumbnail image from local filesystem."""
    p = Path("/") / path
    if not p.exists():
        raise HTTPException(404, "Image not found")
    ext = p.suffix.lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png"}.get(ext.lstrip("."), "image/jpeg")
    return FileResponse(str(p), media_type=mime)


@router.post("/api/youtube/upload-thumbnail")
async def upload_thumbnail(file: UploadFile = File(...), folder: str = Form("")):
    """Upload a custom thumbnail image to the video folder."""
    if not folder:
        raise HTTPException(400, "folder is required")
    dest = Path(folder)
    dest.mkdir(parents=True, exist_ok=True)
    filename = f"thumb_{file.filename or 'custom.jpg'}"
    filepath = dest / filename
    content = await file.read()
    filepath.write_bytes(content)
    logger.info("Thumbnail saved to %s", filepath)
    return {"path": str(filepath)}
