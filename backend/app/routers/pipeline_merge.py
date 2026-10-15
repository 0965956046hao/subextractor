"""Merge finished pipeline videos (đã subtitle xong) into one file.

Mỗi video pipeline khi chạy xong có file `temp/hardcoded/{id}/*_hardcoded.mp4`
(hoặc `temp/export/{id}/exported.mp4`). Endpoint này nối các file đó theo đúng
thứ tự `video_ids` gửi lên: chuẩn hoá từng đoạn về cùng kích thước/fps/audio
rồi concat (giống luồng yt-merge nhưng giữ nguyên khổ dọc của video đầu).
"""

import logging
import os
import re
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
from app.services.media_utils import _video_playable

logger = logging.getLogger(__name__)
router = APIRouter()

_merge_dir = settings.temp_dir / "pipeline_merge"
_jobs: dict[str, dict] = {}


class PipelineMergeRequest(BaseModel):
    video_ids: list[str] = []
    output_name: str = ""


def _sanitize(name: str) -> str:
    name = (name or "").strip().replace("/", "_").replace("\\", "_")
    name = re.sub(r"\s+", " ", name)
    return name[:80]


def _finished_video(video_id: str) -> Path | None:
    """File sub-xong của 1 video pipeline (hardcoded > exported)."""
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    if hd_dir.exists():
        for f in sorted(hd_dir.glob("*_hardcoded.mp4")):
            try:
                if f.stat().st_size > 0 and _video_playable(str(f)):
                    return f
            except Exception:
                continue
    exp = settings.temp_dir / "export" / video_id / "exported.mp4"
    try:
        if exp.exists() and exp.stat().st_size > 0 and _video_playable(str(exp)):
            return exp
    except Exception:
        pass
    return None


def _probe_wh_fps(path: Path) -> tuple[int, int, int]:
    """(width, height, fps) của video qua ffprobe (fallback khi lỗi)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,avg_frame_rate",
             "-of", "default=noprint_wrappers=1", str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout
        w = h = 0
        fps = 0.0
        for line in out.splitlines():
            k, _, v = line.partition("=")
            v = v.strip()
            if k.strip() == "width":
                w = int(v)
            elif k.strip() == "height":
                h = int(v)
            elif k.strip() == "avg_frame_rate" and "/" in v:
                n, d = v.split("/", 1)
                fps = float(n) / float(d) if float(d) else 0.0
        return (w or 720, h or 1280, int(round(fps)) or 30)
    except Exception:
        return 720, 1280, 30


def _run_merge(job_id: str, vids: list[str]) -> None:
    job = _jobs[job_id]
    workdir = _merge_dir / job_id
    workdir.mkdir(parents=True, exist_ok=True)

    def _set(stage: str, progress: int, log: str | None = None):
        job["stage"] = stage
        job["progress"] = progress
        if log:
            job.setdefault("logs", []).append(
                {"message": log, "ts": time.time(), "level": "info"}
            )

    try:
        # B1: gom file sub-xong (đóng băng bằng hardlink/copy).
        srcs: list[Path] = []
        for vid in vids:
            f = _finished_video(vid)
            if f is None:
                raise RuntimeError(
                    f"Video {vid} chưa có file sub xong (hardcoded/export)."
                )
            dest = workdir / f"src_{len(srcs):03d}.mp4"
            try:
                os.link(f, dest)
            except Exception:
                shutil.copyfile(f, dest)
            srcs.append(dest)
            job.setdefault("logs", []).append(
                {"message": f"Đã gom: {f.name}", "ts": time.time(), "level": "info"}
            )

        # B2: chuẩn hoá về cùng khổ video đầu (giữ dọc/ngang gốc), fps, audio.
        tw, th, tfps = _probe_wh_fps(srcs[0])
        _set("Đang chuẩn hoá video...", 10,
             f"Chuẩn khổ {tw}x{th}@{tfps}fps cho {len(srcs)} đoạn...")
        normed: list[Path] = []
        for idx, p in enumerate(srcs):
            out = workdir / f"norm_{idx:03d}.mp4"
            cmd = [
                "ffmpeg", "-y", "-i", str(p),
                "-vf", f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
                       f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={tfps}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                "-movflags", "+faststart",
                str(out),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            if proc.returncode != 0:
                err = (proc.stderr or "")[-300:]
                raise RuntimeError(f"FFmpeg chuẩn hoá đoạn {idx + 1} thất bại: {err}")
            normed.append(out)
            job["progress"] = 10 + int((idx + 1) * 70 / max(1, len(srcs)))

        # B3: concat (demuxer — cùng codec nên copy nhanh).
        _set("Đang ghép các đoạn...", 82, "Đang ghép các đoạn lại...")
        lst = workdir / "list.txt"
        lst.write_text(
            "".join(f"file '{p.name}'\n" for p in normed), encoding="utf-8"
        )
        out_path = workdir / "merged.mp4"
        proc = subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", str(lst), "-c", "copy",
             "-movflags", "+faststart", str(out_path)],
            capture_output=True, text=True, timeout=1800,
        )
        if proc.returncode != 0:
            err = (proc.stderr or "")[-300:]
            raise RuntimeError(f"FFmpeg concat thất bại: {err}")

        job["status"] = "done"
        job["stage"] = "Hoàn tất"
        job["progress"] = 100
        try:
            job["output_size"] = out_path.stat().st_size
        except Exception:
            job["output_size"] = 0
        job.setdefault("logs", []).append(
            {"message": f"Merge xong {len(vids)} video.", "ts": time.time(), "level": "success"}
        )
        logger.info("pipeline-merge %s done (%d videos)", job_id, len(vids))
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        job.setdefault("logs", []).append(
            {"message": f"Merge thất bại: {e}", "ts": time.time(), "level": "error"}
        )
        logger.exception("pipeline-merge %s failed", job_id)


@router.post("/api/pipeline-merge")
def start_pipeline_merge(body: PipelineMergeRequest):
    """Bắt đầu job merge các video pipeline đã subtitle xong (theo thứ tự)."""
    ids: list[str] = []
    for v in body.video_ids or []:
        v = (v or "").strip()
        if v and v not in ids:
            ids.append(v)
    if len(ids) < 2:
        raise HTTPException(400, "Chọn ít nhất 2 video đã subtitle xong để merge.")
    if len(ids) > 50:
        raise HTTPException(400, "Tối đa 50 video/lần merge.")
    missing = [v for v in ids if _finished_video(v) is None]
    if missing:
        shown = ", ".join(missing[:5]) + ("..." if len(missing) > 5 else "")
        raise HTTPException(
            400, f"{len(missing)} video chưa có file sub xong: {shown}"
        )
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {
        "job_id": job_id,
        "status": "running",
        "stage": "Bắt đầu...",
        "progress": 0,
        "video_ids": ids,
        "output_name": _sanitize(body.output_name),
        "output_size": 0,
        "error": None,
        "logs": [{"message": f"Bắt đầu merge {len(ids)} video...", "ts": time.time(), "level": "info"}],
    }
    threading.Thread(target=_run_merge, args=(job_id, ids), daemon=True).start()
    return {"job_id": job_id}


@router.get("/api/pipeline-merge/{job_id}")
async def get_pipeline_merge_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Merge job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "output_size": job.get("output_size", 0),
        "error": job.get("error"),
        "logs": job.get("logs", []),
    }


@router.get("/api/pipeline-merge/{job_id}/download")
async def download_pipeline_merged(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Merge job not found")
    path = _merge_dir / job_id / "merged.mp4"
    if not path.exists():
        raise HTTPException(404, "Merged file not found")
    name = (job.get("output_name") or "").strip() or f"merged_{job_id}"
    return FileResponse(str(path), media_type="video/mp4", filename=f"{name}.mp4")
