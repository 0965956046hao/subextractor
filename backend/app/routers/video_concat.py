import json
import logging
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings
from app.services import media_utils

logger = logging.getLogger(__name__)
router = APIRouter()
_concat_jobs: dict[str, dict] = {}


class ConcatRequest(BaseModel):
    video_ids: list[str]
    artifact: str = "raw"  # "raw" | "result"
    name: str = ""


def _resolve_input(video_id: str, artifact: str) -> Path:
    if artifact == "result":
        hd_dir = settings.temp_dir / "hardcoded" / video_id
        hds = sorted(hd_dir.glob("*_hardcoded.mp4")) if hd_dir.exists() else []
        if hds and media_utils._hardcoded_is_complete(video_id):
            return hds[0]
        # Verified against routers/tools.py download_exported: the export dir
        # is singular "export" (temp/export/{video_id}/exported.mp4).
        exp = settings.temp_dir / "export" / video_id / "exported.mp4"
        if exp.exists():
            return exp
        raise FileNotFoundError(f"No finished result for {video_id}")
    try:
        return media_utils._original_video_path(video_id)
    except FileNotFoundError:
        raise FileNotFoundError(f"No source video for {video_id}")


def _probe_stream(path: Path) -> tuple[int, int, float, bool]:
    """Return (width, height, fps, has_audio) via ffprobe; sane defaults on failure."""
    w, h, fps, has_audio = 0, 0, 0.0, False
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate",
                "-of", "default=noprint_wrappers=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        info: dict[str, str] = {}
        for line in out.stdout.splitlines():
            if "=" in line:
                k, v = line.strip().split("=", 1)
                info[k] = v
        w, h = int(info.get("width", 0)), int(info.get("height", 0))
        num, _, den = info.get("r_frame_rate", "30/1").partition("/")
        fps = float(num) / float(den) if float(den or 0) else 30.0
    except Exception:
        pass
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=index",
                "-of", "csv=p=0",
                str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        has_audio = bool(out.stdout.strip())
    except Exception:
        pass
    if w <= 0 or h <= 0:
        w, h = 1920, 1080
    if not fps or fps <= 0:
        fps = 30.0
    return w, h, fps, has_audio


class _Cancelled(Exception):
    pass


def _check_cancel(job: dict) -> None:
    if job.get("cancel"):
        raise _Cancelled("Đã hủy gộp video.")


def _run_concat(concat_id: str, video_ids: list[str], artifact: str, name: str) -> None:
    job = _concat_jobs[concat_id]
    out_path = settings.temp_dir / "concat" / f"{concat_id}.mp4"

    def _set(stage: str, progress: int, msg: str, level: str = "info") -> None:
        job["stage"] = stage
        job["progress"] = progress
        job.setdefault("logs", []).append({"message": msg, "ts": time.time(), "level": level})

    try:
        # Resolve all inputs first (fail fast on missing artifacts).
        inputs: list[Path] = []
        for i, vid in enumerate(video_ids):
            _check_cancel(job)
            try:
                inputs.append(_resolve_input(vid, artifact))
            except FileNotFoundError as e:
                raise HTTPException(404, str(e))
            job["progress"] = int((i + 1) / len(video_ids) * 10)
        _set("Đang phân tích video...", 10, f"Đã tìm thấy {len(inputs)} video đầu vào.")

        # Probe geometry; target = max W×H (even), fps 30.
        dims: list[tuple[int, int, float, bool]] = []
        for i, p in enumerate(inputs):
            _check_cancel(job)
            dims.append(_probe_stream(p))
            job["progress"] = 10 + int((i + 1) / len(inputs) * 10)
        tw = max(2, max(d[0] for d in dims) // 2 * 2)
        th = max(2, max(d[1] for d in dims) // 2 * 2)
        all_audio = all(d[3] for d in dims)
        _set(
            "Đang nối video...",
            20,
            f"Nối {len(inputs)} video → {tw}x{th}@30fps"
            + ("" if all_audio else " (bỏ audio vì có video không có tiếng)."),
        )

        out_path.parent.mkdir(parents=True, exist_ok=True)
        n = len(inputs)
        vf_parts = [
            f"[{i}:v]scale={tw}:{th}:force_original_aspect_ratio=decrease,"
            f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v{i}]"
            for i in range(n)
        ]
        if all_audio:
            af_parts = [
                f"[{i}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=48000[a{i}]"
                for i in range(n)
            ]
            filtergraph = (
                ";".join(vf_parts + af_parts)
                + ";"
                + "".join(f"[v{i}][a{i}]" for i in range(n))
                + f"concat=n={n}:v=1:a=1[v][a]"
            )
        else:
            filtergraph = (
                ";".join(vf_parts)
                + ";"
                + "".join(f"[v{i}]" for i in range(n))
                + f"concat=n={n}:v=1:a=0[v]"
            )
        cmd = ["ffmpeg", "-y"]
        for p in inputs:
            cmd += ["-i", str(p)]
        cmd += ["-filter_complex", filtergraph, "-map", "[v]"]
        if all_audio:
            cmd += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-movflags", "+faststart", str(out_path)]
        logger.info("Concat %s: %d inputs → %s", concat_id, n, out_path.name)

        _t0 = time.time()
        proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        try:
            while proc.poll() is None:
                _check_cancel(job)
                time.sleep(0.5)
        except _Cancelled:
            proc.kill()
            proc.wait()
            raise
        _, stderr = proc.communicate()
        if proc.returncode != 0:
            err = stderr[-500:] if stderr else "unknown error"
            raise RuntimeError(f"FFmpeg concat failed: {err}")
        _set("Đang nối video...", 90, f"Đã nối xong trong {time.time() - _t0:.1f}s.")

        # Register as a library video: videos/{new_id}/video.mp4 + meta.json.
        new_id = uuid.uuid4().hex[:12]
        video_dir = settings.temp_dir / "videos" / new_id
        video_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out_path, video_dir / "video.mp4")
        filename = (name or f"concat_{concat_id}.mp4").strip() or f"concat_{concat_id}.mp4"
        if not filename.lower().endswith(".mp4"):
            filename += ".mp4"
        (video_dir / "meta.json").write_text(
            json.dumps({"filename": filename, "origin": "concat"}, ensure_ascii=False),
            encoding="utf-8",
        )

        job["status"] = "done"
        job["stage"] = "Hoàn tất"
        job["progress"] = 100
        job["video_id"] = new_id
        job["url"] = f"/api/video-concat/{concat_id}/download"
        job["filename"] = filename
        job.setdefault("logs", []).append({
            "message": f"Nối {n} video hoàn tất → {filename}.",
            "ts": time.time(), "level": "success",
        })
        logger.info("concat %s done → video %s", concat_id, new_id)
    except HTTPException as e:
        out_path.unlink(missing_ok=True)
        job["status"] = "error"
        job["error"] = e.detail
        job.setdefault("logs", []).append({
            "message": f"Nối video thất bại: {e.detail}", "ts": time.time(), "level": "error",
        })
        logger.warning("concat %s failed: %s", concat_id, e.detail)
    except _Cancelled as e:
        out_path.unlink(missing_ok=True)
        job["status"] = "cancelled"
        job["error"] = str(e)
        job.setdefault("logs", []).append({
            "message": str(e), "ts": time.time(), "level": "warn",
        })
        logger.info("concat %s cancelled", concat_id)
    except Exception as e:
        out_path.unlink(missing_ok=True)
        job["status"] = "error"
        job["error"] = str(e)
        job.setdefault("logs", []).append({
            "message": f"Nối video thất bại: {e}", "ts": time.time(), "level": "error",
        })
        logger.exception("concat %s failed", concat_id)


@router.post("/api/video-concat")
def start_concat(body: ConcatRequest):
    """Start a concat job in background; poll status via GET."""
    if not 2 <= len(body.video_ids) <= 50:
        raise HTTPException(400, "Need 2..50 video_ids")
    if body.artifact not in ("raw", "result"):
        raise HTTPException(400, "artifact must be 'raw' or 'result'")

    concat_id = uuid.uuid4().hex[:12]
    _concat_jobs[concat_id] = {
        "concat_id": concat_id,
        "status": "processing",
        "stage": "Đang chuẩn bị...",
        "progress": 0,
        "url": None,
        "filename": None,
        "video_id": None,
        "error": None,
        "cancel": False,
        "logs": [{"message": "Bắt đầu nối video...", "ts": time.time(), "level": "info"}],
    }

    threading.Thread(
        target=_run_concat,
        args=(concat_id, list(body.video_ids), body.artifact, body.name or ""),
        daemon=True,
    ).start()

    return {"concat_id": concat_id}


@router.get("/api/video-concat/{concat_id}")
async def get_concat_status(concat_id: str):
    job = _concat_jobs.get(concat_id)
    if not job:
        raise HTTPException(404, "Concat job not found")
    return {
        "concat_id": concat_id,
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "url": job["url"],
        "filename": job["filename"],
        "video_id": job.get("video_id"),
        "error": job["error"],
        "logs": job.get("logs", []),
    }


@router.delete("/api/video-concat/{concat_id}")
async def cancel_concat(concat_id: str):
    """Request cancellation of a running concat job (cooperative)."""
    job = _concat_jobs.get(concat_id)
    if not job:
        raise HTTPException(404, "Concat job not found")
    if job["status"] not in ("processing",):
        return {"concat_id": concat_id, "status": job["status"]}
    job["cancel"] = True
    return {"concat_id": concat_id, "status": "cancelling"}


@router.get("/api/video-concat/{concat_id}/download")
async def download_concat(concat_id: str):
    path = settings.temp_dir / "concat" / f"{concat_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Concat file not found")
    job = _concat_jobs.get(concat_id)
    filename = (job or {}).get("filename") or path.name
    return FileResponse(str(path), media_type="video/mp4", filename=filename)
