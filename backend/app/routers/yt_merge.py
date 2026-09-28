"""Ghép nhiều video YouTube trong 1 playlist thành 1 video rồi push lên YouTube.

Luồng FE: chọn kênh YT (credentials) → chọn playlist → list video trong
playlist → tick chọn theo thứ tự → bấm Ghép → poll job → Push lên YouTube.

- Playlist items đọc qua YouTube Data API v3 (dùng OAuth token theo channel).
- Ghép: tải từng video bằng yt-dlp (mp4 1080p), chuẩn hoá về cùng thông số
  rồi concat bằng FFmpeg (re-encode libx264/AAC — an toàn khi các nguồn
  khác codec/kích thước/fps).
- Upload: tái dùng youtube router (_start_upload + meta.json).
"""

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

_merge_jobs: dict[str, dict] = {}
_prep_jobs: dict[str, dict] = {}


def _probe_duration(path: Path) -> float:
    """Thời lượng video (giây) qua ffprobe, lỗi → 0."""
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        return max(0.0, float((proc.stdout or "").strip()))
    except Exception:
        return 0.0


def _yt_merge_dir() -> Path:
    d = settings.temp_dir / "yt_merge"
    d.mkdir(parents=True, exist_ok=True)
    return d


_JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")


def _projects_dir() -> Path:
    d = _yt_merge_dir() / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _valid_job_id(job_id: str) -> bool:
    return bool(job_id) and bool(_JOB_ID_RE.match(job_id))


def _save_project(job: dict) -> None:
    """Persist merge project ra đĩa để mở lại sau (danh sách merge)."""
    try:
        now = time.time()
        rec = {
            "id": job.get("job_id", ""),
            "name": job.get("output_name") or f"Ghép {len(job.get('segments') or job.get('video_ids') or [])} video",
            "status": job.get("status", "running"),
            "stage": job.get("stage", ""),
            "progress": job.get("progress", 0),
            "video_count": len(job.get("segments") or job.get("video_ids") or []),
            "total_trimmed": job.get("total_trimmed", 0),
            "items": job.get("items") or [],
            "segments": [
                {"video_id": s.get("video_id", ""), "start": s.get("start", 0), "end": s.get("end"),
                 "duration": s.get("duration", 0)}
                for s in (job.get("segments") or [])
            ],
            "prepare_job_id": job.get("prepare_job_id") or "",
            "output": job.get("output"),
            "output_size": job.get("output_size", 0),
            "meta": job.get("meta"),
            "push_channel_id": job.get("push_channel_id") or "",
            "push_playlist_id": job.get("push_playlist_id") or "",
            "thumb_path": job.get("thumb_path") or "",
            "upload_job_id": job.get("upload_job_id"),
            "error": job.get("error"),
            "created_at": job.get("created_at") or now,
            "updated_at": now,
        }
        if not rec["id"]:
            return
        (_projects_dir() / f"{rec['id']}.json").write_text(
            json.dumps(rec, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        logger.exception("save project failed")


def _load_project(job_id: str) -> dict | None:
    if not _valid_job_id(job_id):
        return None
    p = _projects_dir() / f"{job_id}.json"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _save_project_if_exists(job: dict) -> None:
    """Lưu tiến trình, trừ khi user đã xoá project (tránh ghi lại record)."""
    try:
        if (_projects_dir() / f"{job.get('job_id', '')}.json").exists():
            _save_project(job)
    except Exception:
        pass


# ── 1. List video trong playlist ──────────────────────────────

@router.get("/api/yt-merge/playlist-items")
async def list_playlist_items(channel_id: str = "", playlist_id: str = ""):
    """List video trong 1 playlist (kèm thumbnail/duration/position)."""
    import httpx

    if not playlist_id:
        raise HTTPException(400, "playlist_id is required")

    from app.routers.youtube import _yt_access_token

    access_token = _yt_access_token(channel_id)
    items: list[dict] = []
    page_token = ""
    try:
        with httpx.Client(timeout=30) as client:
            while True:
                params = {
                    "part": "snippet,contentDetails",
                    "playlistId": playlist_id,
                    "maxResults": "50",
                }
                if page_token:
                    params["pageToken"] = page_token
                r = client.get(
                    "https://www.googleapis.com/youtube/v3/playlistItems",
                    params=params,
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                if r.status_code == 401:
                    raise HTTPException(400, "YouTube auth expired. Please re-authenticate.")
                if r.status_code == 404:
                    raise HTTPException(404, "Playlist not found.")
                r.raise_for_status()
                data = r.json()
                for it in data.get("items") or []:
                    sn = it.get("snippet") or {}
                    cd = it.get("contentDetails") or {}
                    res = (sn.get("resourceId") or {})
                    thumbs = (sn.get("thumbnails") or {})
                    thumb = (
                        (thumbs.get("medium") or {}).get("url")
                        or (thumbs.get("default") or {}).get("url")
                        or ""
                    )
                    items.append({
                        "video_id": res.get("videoId", ""),
                        "title": sn.get("title", ""),
                        "position": sn.get("position", 0),
                        "published_at": sn.get("publishedAt", ""),
                        "channel_title": sn.get("videoOwnerChannelTitle", ""),
                        "thumbnail": thumb,
                    })
                page_token = data.get("nextPageToken") or ""
                if not page_token:
                    break
            # Bổ sung duration + description + tags qua videos.list (50 id/lần).
            ids = [i["video_id"] for i in items if i["video_id"]]
            details: dict[str, dict] = {}
            for k in range(0, len(ids), 50):
                chunk = ids[k:k + 50]
                vr = client.get(
                    "https://www.googleapis.com/youtube/v3/videos",
                    params={"part": "snippet,contentDetails", "id": ",".join(chunk)},
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                vr.raise_for_status()
                for v in (vr.json().get("items") or []):
                    sn2 = v.get("snippet") or {}
                    details[v.get("id", "")] = {
                        "duration": (v.get("contentDetails") or {}).get("duration", ""),
                        "description": sn2.get("description", ""),
                        "tags": sn2.get("tags") or [],
                        "category_id": sn2.get("categoryId", ""),
                    }
            for i in items:
                d = details.get(i["video_id"], {})
                i["duration"] = d.get("duration", "")
                i["description"] = d.get("description", "")
                i["tags"] = d.get("tags", [])
                i["category_id"] = d.get("category_id", "")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Could not list playlist items: {e}")
    return {"playlist_id": playlist_id, "total": len(items), "items": items}


# ── 1b. Video upload local (merge chung với video YouTube) ──────

ALLOWED_UPLOAD_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
_UPLOAD_ID_RE = re.compile(r"^upload_[0-9a-f]{12}$")

_EXT_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
}


def _uploads_dir() -> Path:
    d = _yt_merge_dir() / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_upload(uid: str) -> tuple[Path, dict] | None:
    """Trả (file, meta) của video upload, None nếu không tồn tại/id lạ."""
    if not uid or not _UPLOAD_ID_RE.match(uid):
        return None
    meta_path = _uploads_dir() / f"{uid}.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    f = _uploads_dir() / str(meta.get("file", ""))
    if not f.is_file():
        return None
    return f, meta


@router.post("/api/yt-merge/uploads")
async def upload_merge_files(files: list[UploadFile] = File(...)):
    """Upload 1 hoặc nhiều file video local để merge chung với video YT."""
    if not files:
        raise HTTPException(400, "Không có file nào.")
    d = _uploads_dir()
    items: list[dict] = []
    errors: list[str] = []
    for f in files:
        fname = f.filename or "video.mp4"
        ext = Path(fname).suffix.lower()
        if ext not in ALLOWED_UPLOAD_EXTS:
            errors.append(f"{fname}: định dạng không hỗ trợ (chỉ mp4/mov/mkv/webm/avi/m4v).")
            continue
        uid = f"upload_{uuid.uuid4().hex[:12]}"
        dest = d / f"{uid}{ext}"
        try:
            size = 0
            with open(dest, "wb") as out:
                while True:
                    chunk = await f.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    size += len(chunk)
            if size == 0:
                dest.unlink(missing_ok=True)
                errors.append(f"{fname}: file rỗng.")
                continue
            dur = _probe_duration(dest)
            meta = {
                "uid": uid,
                "title": Path(fname).stem,
                "filename": fname,
                "file": dest.name,
                "duration": round(dur, 2),
                "size": size,
            }
            (d / f"{uid}.json").write_text(
                json.dumps(meta, ensure_ascii=False), encoding="utf-8"
            )
            logger.info("merge upload %s → %s (%.0fs)", fname, dest.name, dur)
            items.append({
                "video_id": uid,
                "title": meta["title"],
                "duration": round(dur, 2),
                "size": size,
                "preview": f"/api/yt-merge/uploads/{uid}",
            })
        except Exception as e:
            dest.unlink(missing_ok=True)
            errors.append(f"{fname}: {e}")
        finally:
            try:
                await f.close()
            except Exception:
                pass
    return {"items": items, "errors": errors}


@router.get("/api/yt-merge/uploads/{uid}")
async def serve_merge_upload(uid: str):
    """Stream file video đã upload (xem trước từng tập/tổng)."""
    up = _resolve_upload(uid)
    if not up:
        raise HTTPException(404, "Uploaded file not found")
    f, meta = up
    mime = _EXT_MIME.get(f.suffix.lower(), "video/mp4")
    return FileResponse(str(f), media_type=mime, filename=str(meta.get("filename") or f.name))


@router.delete("/api/yt-merge/uploads/{uid}")
async def delete_merge_upload(uid: str):
    if not uid or not _UPLOAD_ID_RE.match(uid):
        raise HTTPException(404, "Uploaded file not found")
    d = _uploads_dir()
    try:
        meta = json.loads((d / f"{uid}.json").read_text(encoding="utf-8"))
        (d / str(meta.get("file", ""))).unlink(missing_ok=True)
    except Exception:
        pass
    (d / f"{uid}.json").unlink(missing_ok=True)
    return {"status": "ok", "removed": True}


# ── 2. Prepare: tải các video về, đo duration, xem/cắt trước khi ghép ─

class PrepareRequest(BaseModel):
    video_ids: list[str] = []
    titles: list[str] = []


def _run_prepare(job_id: str, video_ids: list[str], titles: list[str]) -> None:
    job = _prep_jobs[job_id]
    workdir = _yt_merge_dir() / f"prep_{job_id}"
    workdir.mkdir(parents=True, exist_ok=True)

    def _set(stage: str, progress: int, log: str | None = None):
        job["stage"] = stage
        job["progress"] = progress
        if log:
            job.setdefault("logs", []).append(
                {"message": log, "ts": time.time(), "level": "info"}
            )

    try:
        # Kiểm tra mạng/DNS trước khi đốt lượt tải (fail rõ thay vì 403/treo).
        if any(not _resolve_upload(v) for v in video_ids):
            _set("Đang kiểm tra kết nối YouTube...", 0, "Đang kiểm tra kết nối mạng...")
            _ensure_network()
        total = len(video_ids)
        for idx, vid in enumerate(video_ids):
            if job.get("cancel_requested"):
                raise _Cancelled()
            name = (titles[idx] if idx < len(titles) else "") or vid
            dest = workdir / f"part_{idx:03d}.mp4"
            # File upload local → dùng thẳng, khỏi tải.
            up = _resolve_upload(vid)
            if up is not None:
                src, umeta = up
                _set(
                    f"Nhận file upload {idx + 1}/{total}...",
                    int(idx * 100 / total),
                    f"Nhận file upload {idx + 1}/{total}: {name}",
                )
                try:
                    os.link(src, dest)
                except Exception:
                    shutil.copyfile(src, dest)
                name = str(umeta.get("title") or "") or name
            else:
                _set(
                    f"Đang tải video {idx + 1}/{total}...",
                    int(idx * 100 / total),
                    f"Đang tải {idx + 1}/{total}: {name}",
                )
                _download_one_yt(
                    vid, dest, name,
                    on_log=lambda m: job.setdefault("logs", []).append(
                        {"message": m, "ts": time.time(), "level": "warn"}
                    ),
                    job=job,
                )
            dur = _probe_duration(dest)
            try:
                size = dest.stat().st_size
            except Exception:
                size = 0
            (job.setdefault("parts", [])).append({
                "index": idx,
                "video_id": vid,
                "title": name,
                "duration": round(dur, 2),
                "size": size,
                "file": dest.name,
                "preview": f"/api/yt-merge/prepare/{job_id}/part/{idx}",
            })
            job["progress"] = int((idx + 1) * 100 / total)
            job.setdefault("logs", []).append(
                {"message": f"Đã tải {idx + 1}/{total}: {name} ({dur:.0f}s)",
                 "ts": time.time(), "level": "success"}
            )
        job["status"] = "done"
        job["stage"] = "Hoàn tất"
        job["progress"] = 100
    except _Cancelled:
        job["status"] = "cancelled"
        job["stage"] = "Đã dừng"
        job.setdefault("logs", []).append(
            {"message": "Đã dừng tải theo yêu cầu.", "ts": time.time(), "level": "warn"}
        )
        logger.info("yt-prepare %s cancelled by user", job_id)
        shutil.rmtree(workdir, ignore_errors=True)
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        job.setdefault("logs", []).append(
            {"message": f"Tải thất bại: {e}", "ts": time.time(), "level": "error"}
        )
        logger.exception("yt-prepare %s failed", job_id)


@router.post("/api/yt-merge/prepare")
async def start_prepare(body: PrepareRequest):
    """Tải trước các video để xem/cắt trên timeline trước khi ghép."""
    ids = [v.strip() for v in (body.video_ids or []) if v.strip()]
    if len(ids) < 1:
        raise HTTPException(400, "Chọn ít nhất 1 video.")
    if len(ids) > 50:
        raise HTTPException(400, "Tối đa 50 video/lần.")
    job_id = uuid.uuid4().hex[:12]
    _prep_jobs[job_id] = {
        "job_id": job_id,
        "status": "running",
        "stage": "Chuẩn bị...",
        "progress": 0,
        "video_ids": ids,
        "titles": body.titles or [],
        "parts": [],
        "error": None,
        "logs": [{"message": f"Bắt đầu tải {len(ids)} video...", "ts": time.time(), "level": "info"}],
    }
    threading.Thread(target=_run_prepare, args=(job_id, ids, body.titles or []), daemon=True).start()
    return {"job_id": job_id}


@router.get("/api/yt-merge/prepare/{job_id}")
async def get_prepare_status(job_id: str):
    job = _prep_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Prepare job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "parts": job.get("parts", []),
        "error": job.get("error"),
        "logs": job.get("logs", []),
    }


@router.get("/api/yt-merge/prepare/{job_id}/part/{index}")
async def serve_prepare_part(job_id: str, index: int):
    """Stream 1 video đã tải (dùng cho màn xem trước từng tập/tổng)."""
    job = _prep_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Prepare job not found")
    parts = job.get("parts") or []
    if index < 0 or index >= len(parts):
        raise HTTPException(404, "Part not found")
    path = _yt_merge_dir() / f"prep_{job_id}" / parts[index]["file"]
    if not path.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)


@router.post("/api/yt-merge/prepare/{job_id}/cancel")
async def cancel_prepare_job(job_id: str):
    """Dừng job tải video đang chạy."""
    job = _prep_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Prepare job not found")
    if job.get("status") != "running":
        return {"job_id": job_id, "status": job.get("status"), "cancelled": False}
    job["cancel_requested"] = True
    proc = job.get("proc")
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass
    return {"job_id": job_id, "status": "cancelling", "cancelled": True}


@router.delete("/api/yt-merge/prepare/{job_id}")
async def delete_prepare_job(job_id: str):
    _prep_jobs.pop(job_id, None)
    shutil.rmtree((_yt_merge_dir() / f"prep_{job_id}"), ignore_errors=True)
    return {"status": "ok", "removed": True}


# ── 3. Ghép video ─────────────────────────────────────────────

class Segment(BaseModel):
    video_id: str
    start: float = 0      # giây, cắt đầu
    end: float | None = None  # giây, cắt đuôi (None = đến hết video)


class ConcatRequest(BaseModel):
    channel_id: str = ""
    video_ids: list[str] = []   # thứ tự = thứ tự ghép
    titles: list[str] = []      # tiêu đề tương ứng (để log, optional)
    output_name: str = ""       # tên file output (optional)
    prepare_job_id: str = ""    # dùng lại file đã tải ở bước prepare
    segments: list[Segment] = []  # khoảng cắt từng tập (rỗng = lấy full)
    project_id: str = ""        # mở lại project cũ → ghi đè cùng id
    items: list[dict] = []      # snapshot hiển thị (video_id/title/thumbnail...)


# Proxy cho yt-dlp (nếu mạng cần proxy mới ra được YouTube):
# export YT_MERGE_PROXY="http://127.0.0.1:7890" trước khi chạy backend.
_YT_PROXY = (
    os.environ.get("YT_MERGE_PROXY", "").strip()
    or os.environ.get("HTTPS_PROXY", "").strip()
    or os.environ.get("https_proxy", "").strip()
)

# Dấu hiệu lỗi mạng thoáng qua (DNS sụt, timeout, rớt kết nối...) → thử lại.
_NETWORK_PATTERNS = (
    "failed to resolve", "nodename", "nor servname", "temporary failure",
    "network is unreachable", "timed out", "timedout", "connection reset",
    "connection aborted", "broken pipe", "socket", "eof occurred",
    "http error 500", "http error 502", "http error 503", "http error 504",
)


def _is_network_error(msg: str) -> bool:
    m = (msg or "").lower()
    return any(p in m for p in _NETWORK_PATTERNS)


def _ensure_network(host: str = "www.youtube.com", tries: int = 6, wait: int = 5) -> None:
    """Đợi mạng/DNS sẵn sàng trước khi tải; sụt hẳn thì báo rõ thay vì
    đốt hết lượt fallback client rồi mới fail."""
    import socket

    last: Exception | None = None
    for _ in range(max(1, tries)):
        try:
            socket.getaddrinfo(host, 443)
            return
        except OSError as e:
            last = e
            time.sleep(wait)
    raise RuntimeError(
        f"Không kết nối được {host} (lỗi DNS/mạng): {last}. "
        "Kiểm tra mạng rồi bấm Tải lại."
    )


# Thứ tự thử player client khi YouTube trả 403 (chặn bot client web).
# android/ios thường thoát được kiểm tra PO token của client web.
_PLAYER_CLIENT_FALLBACKS: list[list[str]] = [
    [],
    ["--extractor-args", "youtube:player_client=android"],
    ["--extractor-args", "youtube:player_client=ios"],
    ["--extractor-args", "youtube:player_client=web_embedded"],
    ["--extractor-args", "youtube:player_client=tv"],
]


class _Cancelled(Exception):
    """User bấm Dừng — thoát job ghép một cách có kiểm soát."""
    pass


def _run_proc(cmd: list[str], job: dict, timeout: int, label: str) -> None:
    """Chạy subprocess, cho phép hủy giữa chừng qua job["cancel_requested"].

    Ép timeout (mặc định tiến trình treo sẽ kẹt job ở running mãi).
    Raise _Cancelled khi user bấm dừng, RuntimeError khi lệnh lỗi/timeout.
    """
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    job["proc"] = proc
    deadline = time.monotonic() + max(1, timeout)
    try:
        while True:
            if job.get("cancel_requested"):
                try:
                    proc.terminate()
                except Exception:
                    pass
                try:
                    proc.communicate(timeout=10)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                raise _Cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    proc.kill()
                except Exception:
                    pass
                try:
                    proc.communicate(timeout=10)
                except Exception:
                    pass
                raise RuntimeError(f"{label} timeout sau {timeout}s.")
            try:
                _, err = proc.communicate(timeout=min(1.0, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
    finally:
        if job.get("proc") is proc:
            job.pop("proc", None)
    # Tiến trình có thể đã bị kill từ endpoint cancel ngay trước khi vòng
    # lặp kịp check flag → vẫn tính là user dừng, không phải lỗi.
    if job.get("cancel_requested"):
        raise _Cancelled()
    if proc.returncode != 0:
        raise RuntimeError(f"{label} thất bại: {(err or '')[-500:]}")


def _download_one_yt(
    video_id: str, dest: Path, label: str, on_log=None, job: dict | None = None,
    net_retries: int = 2,
) -> None:
    """Tải 1 video YouTube bằng yt-dlp, tự đổi player client khi gặp 403.

    Lỗi mạng thoáng qua (DNS/timeout/rớt kết nối) thì chờ rồi thử lại
    cả chuỗi client thêm `net_retries` vòng.
    """
    if _YT_PROXY and job is not None:
        job.setdefault("logs", []).append(
            {"message": f"Dùng proxy {_YT_PROXY} cho yt-dlp.", "ts": time.time(), "level": "info"}
        )
    round_n = 0
    while True:
        try:
            _download_with_clients(video_id, dest, label, on_log, job)
            return
        except _Cancelled:
            raise
        except RuntimeError as e:
            cancelled = job is not None and job.get("cancel_requested")
            if not cancelled and round_n < net_retries and _is_network_error(str(e)):
                round_n += 1
                wait = 15
                logger.warning(
                    "yt-dlp %s lỗi mạng, thử lại vòng %d/%d sau %ds",
                    label, round_n, net_retries, wait,
                )
                if on_log:
                    try:
                        on_log(f"Mạng chập chờn, thử tải lại {label} (lần {round_n})...")
                    except Exception:
                        pass
                for _ in range(wait):
                    if job is not None and job.get("cancel_requested"):
                        raise _Cancelled()
                    time.sleep(1)
                dest.unlink(missing_ok=True)
                continue
            raise


def _download_with_clients(
    video_id: str, dest: Path, label: str, on_log=None, job: dict | None = None,
) -> None:
    """Thử tải qua từng player client (web → android → ios...)."""
    last_err = ""
    for attempt, extra in enumerate(_PLAYER_CLIENT_FALLBACKS):
        if job is not None and job.get("cancel_requested"):
            raise _Cancelled()
        client_name = "web (mặc định)" if not extra else extra[1].split("=")[1]
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "--retries", "3",
            "--fragment-retries", "3",
            "--retry-sleep", "exp=1:5",
            "--socket-timeout", "30",
            * (["--proxy", _YT_PROXY] if _YT_PROXY else []),
            "-f",
            "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
            "--merge-output-format", "mp4",
            "--no-warnings",
            *extra,
            "-o", str(dest),
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            if job is not None:
                _run_proc(cmd, job, 1800, f"yt-dlp {label}")
            else:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
                if proc.returncode != 0:
                    raise RuntimeError(f"yt-dlp {label} thất bại: {(proc.stderr or '')[-500:]}")
        except _Cancelled:
            raise
        except RuntimeError as e:
            last_err = str(e)[-500:]
            logger.warning(
                "yt-dlp %s thất bại với client %s (thử %d/%d): %s",
                label, client_name, attempt + 1, len(_PLAYER_CLIENT_FALLBACKS),
                last_err[-200:],
            )
            if on_log and attempt < len(_PLAYER_CLIENT_FALLBACKS) - 1:
                try:
                    on_log(f"Tải {label} bị chặn 403, thử lại kiểu client khác...")
                except Exception:
                    pass
            dest.unlink(missing_ok=True)
            continue
        if dest.exists():
            if attempt:
                logger.info("yt-dlp %s ok bằng client %s", label, client_name)
            return
        last_err = "file not created"
        dest.unlink(missing_ok=True)
    raise RuntimeError(f"Tải video {label} thất bại: {last_err}")


def _run_concat(job_id: str, video_ids: list[str], titles: list[str]) -> None:
    job = _merge_jobs[job_id]
    workdir = _yt_merge_dir() / job_id
    workdir.mkdir(parents=True, exist_ok=True)
    parts: list[Path] = []

    def _set(stage: str, progress: int, log: str | None = None):
        job["stage"] = stage
        job["progress"] = progress
        if log:
            job.setdefault("logs", []).append(
                {"message": log, "ts": time.time(), "level": "info"}
            )

    try:
        # Ghép trực tiếp (không qua prepare) mà còn thiếu file → check mạng.
        segs0 = job.get("segments") or [{"video_id": v} for v in video_ids]
        if any(_resolve_upload(s.get("video_id", "")) is None for s in segs0):
            _set("Đang kiểm tra kết nối YouTube...", 0, "Đang kiểm tra kết nối mạng...")
            _ensure_network()
        total = len(video_ids)
        title_map = {v: (titles[i] if i < len(titles) else "") for i, v in enumerate(video_ids)}
        # File đã tải ở bước prepare (nếu có) → dùng lại, khỏi tải lại.
        prep_files: dict[str, Path] = {}
        prep_id = (job.get("prepare_job_id") or "").strip()
        if prep_id:
            pj = _prep_jobs.get(prep_id)
            if pj and pj.get("status") == "done":
                pdir = _yt_merge_dir() / f"prep_{prep_id}"
                for p in pj.get("parts") or []:
                    f = pdir / p.get("file", "")
                    if f.exists():
                        prep_files[p.get("video_id", "")] = f
        # Danh sách đoạn cần ghép (kèm khoảng cắt). Mặc định lấy full.
        segs = job.get("segments") or [
            {"video_id": v, "start": 0, "end": None} for v in video_ids
        ]

        # B1: chuẩn bị từng đoạn (dùng file prepare hoặc tải mới).
        for idx, seg in enumerate(segs):
            if job.get("cancel_requested"):
                raise _Cancelled()
            vid = seg.get("video_id", "")
            start = max(0.0, float(seg.get("start") or 0))
            end = seg.get("end")
            end = float(end) if end is not None else None
            name = title_map.get(vid, "") or vid
            _set(
                f"Chuẩn bị đoạn {idx + 1}/{len(segs)}...",
                int(idx * 20 / max(1, len(segs))),
                f"Chuẩn bị đoạn {idx + 1}/{len(segs)}: {name}",
            )
            dest = workdir / f"part_{idx:03d}.mp4"
            up = _resolve_upload(vid)
            if up is not None:
                src, _ = up
                try:
                    os.link(src, dest)
                except Exception:
                    shutil.copyfile(src, dest)
                job.setdefault("logs", []).append(
                    {"message": f"Dùng file đã upload: {name}", "ts": time.time(), "level": "info"}
                )
            elif vid in prep_files:
                try:
                    os.link(prep_files[vid], dest)
                except Exception:
                    shutil.copyfile(prep_files[vid], dest)
                job.setdefault("logs", []).append(
                    {"message": f"Dùng file đã tải: {name}", "ts": time.time(), "level": "info"}
                )
            else:
                # Tự fallback player client (web → android → ios...) khi 403.
                _download_one_yt(
                    vid, dest, name,
                    on_log=lambda m: job.setdefault("logs", []).append(
                        {"message": m, "ts": time.time(), "level": "warn"}
                    ),
                    job=job,
                )
            # Kẹp khoảng cắt vào đúng thời lượng file.
            dur = _probe_duration(dest)
            if dur > 0:
                start = min(start, max(0.0, dur - 0.1))
                if end is None or end > dur or end <= start:
                    end = dur if (end is None or end > dur) else end
                if end is not None and end <= start:
                    end = None
                    start = 0.0
            seg["start"] = start
            seg["end"] = end
            seg["duration"] = round(dur, 2)
            seg["src"] = str(dest)
            parts.append(dest)
            job.setdefault("logs", []).append(
                {"message": f"Đã chuẩn bị đoạn {idx + 1}/{len(segs)}: {name}", "ts": time.time(), "level": "success"}
            )

        # B2: chuẩn hoá từng đoạn về cùng thông số (1080p, 30fps, yuv420p,
        # aac 48k stereo) + áp khoảng cắt start/end của từng tập.
        _set("Đang cắt + chuẩn hoá video...", 20, "Đang cắt và chuẩn hoá các đoạn về 1080p/30fps...")
        normed: list[Path] = []
        for idx, seg in enumerate(segs):
            if job.get("cancel_requested"):
                raise _Cancelled()
            p = Path(seg["src"])
            out = workdir / f"norm_{idx:03d}.mp4"
            start = float(seg.get("start") or 0)
            end = seg.get("end")
            cmd = ["ffmpeg", "-y"]
            if start > 0:
                cmd += ["-ss", f"{start:.2f}"]
            cmd += ["-i", str(p)]
            if end is not None and float(end) > start:
                cmd += ["-t", f"{float(end) - start:.2f}"]
            cmd += [
                "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,"
                       "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                "-movflags", "+faststart",
                str(out),
            ]
            _run_proc(cmd, job, 3600, f"Cắt + chuẩn hoá đoạn {idx + 1}")
            normed.append(out)
            job["progress"] = 20 + int((idx + 1) * 60 / max(1, len(segs)))

        # B3: concat (demuxer — cùng codec nên copy nhanh).
        _set("Đang ghép các đoạn...", 82, "Đang ghép các đoạn lại...")
        lst = workdir / "list.txt"
        lst.write_text(
            "".join(f"file '{p.name}'\n" for p in normed), encoding="utf-8"
        )
        out_path = workdir / "merged.mp4"
        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(lst), "-c", "copy",
            "-movflags", "+faststart", str(out_path),
        ]
        _run_proc(cmd, job, 1800, "FFmpeg concat")

        job["status"] = "done"
        job["stage"] = "Hoàn tất"
        job["progress"] = 100
        job["output"] = f"/api/yt-merge/download/{job_id}"
        job["output_path"] = str(out_path)
        try:
            job["output_size"] = out_path.stat().st_size
        except Exception:
            job["output_size"] = 0
        job.setdefault("logs", []).append(
            {"message": f"Ghép xong {total} video.", "ts": time.time(), "level": "success"}
        )
        _save_project_if_exists(job)
    except _Cancelled:
        job["status"] = "cancelled"
        job["stage"] = "Đã dừng"
        job.setdefault("logs", []).append(
            {"message": "Đã dừng ghép theo yêu cầu.", "ts": time.time(), "level": "warn"}
        )
        logger.info("yt-merge %s cancelled by user", job_id)
        shutil.rmtree(workdir, ignore_errors=True)
        _save_project_if_exists(job)
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        job.setdefault("logs", []).append(
            {"message": f"Ghép thất bại: {e}", "ts": time.time(), "level": "error"}
        )
        logger.exception("yt-merge %s failed", job_id)
        _save_project_if_exists(job)


@router.post("/api/yt-merge/concat")
async def start_concat(body: ConcatRequest):
    """Bắt đầu job ghép các video (theo đúng thứ tự video_ids)."""
    ids = [v.strip() for v in (body.video_ids or []) if v.strip()]
    if len(ids) < 2:
        raise HTTPException(400, "Chọn ít nhất 2 video để ghép.")
    if len(ids) > 50:
        raise HTTPException(400, "Tối đa 50 video/lần ghép.")
    segs = [
        {"video_id": s.video_id.strip(), "start": max(0.0, s.start or 0),
         "end": (float(s.end) if s.end is not None else None)}
        for s in (body.segments or [])
        if s.video_id.strip()
    ]
    if segs and len(segs) < 2:
        raise HTTPException(400, "Chọn ít nhất 2 video để ghép.")
    # Mở lại project cũ → dùng lại id (ghi đè kết quả cũ).
    job_id = ""
    if body.project_id and _valid_job_id(body.project_id):
        if (_projects_dir() / f"{body.project_id}.json").exists():
            job_id = body.project_id
            shutil.rmtree((_yt_merge_dir() / job_id), ignore_errors=True)
    if not job_id:
        job_id = uuid.uuid4().hex[:12]
    total_trimmed = 0.0
    for s in segs:
        if s["end"] is not None and s["end"] > s["start"]:
            total_trimmed += s["end"] - s["start"]
    now = time.time()
    prev = _load_project(job_id) or {}
    _merge_jobs[job_id] = {
        "job_id": job_id,
        "status": "running",
        "stage": "Chuẩn bị...",
        "progress": 0,
        "channel_id": body.channel_id,
        "video_ids": ids,
        "titles": body.titles or [],
        "output_name": (body.output_name or "").strip() or prev.get("name") or "",
        "prepare_job_id": (body.prepare_job_id or "").strip(),
        "segments": segs,
        "items": body.items or prev.get("items") or [],
        "total_trimmed": round(total_trimmed, 1),
        "output": None,
        "output_path": None,
        "output_size": 0,
        "meta": prev.get("meta"),
        "push_channel_id": prev.get("push_channel_id") or "",
        "push_playlist_id": prev.get("push_playlist_id") or "",
        "thumb_path": prev.get("thumb_path") or "",
        "upload_job_id": None,
        "error": None,
        "created_at": prev.get("created_at") or now,
        "logs": [{"message": f"Bắt đầu ghép {len(segs) if segs else len(ids)} đoạn...", "ts": now, "level": "info"}],
    }
    _save_project(_merge_jobs[job_id])
    threading.Thread(
        target=_run_concat, args=(job_id, ids, body.titles or []), daemon=True
    ).start()
    return {"job_id": job_id}


# NOTE: các route GET cụ thể (/projects, /thumbnail, /download...) phải đăng ký
# TRƯỚC route generic /{job_id} bên dưới, nếu không sẽ bị nuốt → 404.


@router.get("/api/yt-merge/projects")
async def list_projects():
    """Danh sách các merge đã tạo (mới nhất trước)."""
    out: list[dict] = []
    try:
        files = sorted(
            _projects_dir().glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except Exception:
        files = []
    for p in files:
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(rec, dict):
            continue
        rec.pop("items", None)
        rec.pop("segments", None)
        rec.pop("meta", None)
        out.append(rec)
    return {"projects": out}


@router.get("/api/yt-merge/projects/{job_id}")
async def get_project(job_id: str):
    rec = _load_project(job_id)
    if not rec:
        raise HTTPException(404, "Project not found")
    return rec


@router.delete("/api/yt-merge/projects/{job_id}")
async def delete_project(job_id: str):
    if not _valid_job_id(job_id):
        raise HTTPException(404, "Project not found")
    _merge_jobs.pop(job_id, None)
    rec = _load_project(job_id)
    (_projects_dir() / f"{job_id}.json").unlink(missing_ok=True)
    shutil.rmtree((_yt_merge_dir() / job_id), ignore_errors=True)
    # Xoá luôn file prepare của project này (tránh rác temp).
    if rec and rec.get("prepare_job_id"):
        _prep_jobs.pop(rec["prepare_job_id"], None)
        shutil.rmtree((_yt_merge_dir() / f"prep_{rec['prepare_job_id']}"), ignore_errors=True)
    return {"status": "ok", "removed": True}


@router.get("/api/yt-merge/download/{job_id}")
async def download_merged(job_id: str):
    job = _merge_jobs.get(job_id)
    path: Path | None = None
    name = ""
    if job and job.get("status") == "done":
        path = Path(str(job.get("output_path") or ""))
        name = (job.get("output_name") or "").strip()
    if (path is None or not path.exists()) and _valid_job_id(job_id):
        # Backend vừa restart: đọc file merged.mp4 + record trên đĩa.
        p = _yt_merge_dir() / job_id / "merged.mp4"
        if p.exists():
            path = p
            rec = _load_project(job_id) or {}
            name = str(rec.get("name") or "").strip()
    if path is None or not path.exists():
        raise HTTPException(404, "Merged file not found")
    name = name or f"merged_{job_id}.mp4"
    if not name.endswith(".mp4"):
        name += ".mp4"
    return FileResponse(str(path), media_type="video/mp4", filename=name)


# ── 3. Push file đã ghép lên YouTube ──────────────────────────

class PushRequest(BaseModel):
    title: str = ""
    description: str = ""
    privacy: str = "private"
    channel_id: str = ""
    playlist_id: str = ""
    thumbnail_path: str = ""
    # Nội dung meta.json do FE nhập tay (JSON). Nếu có thì dùng làm base,
    # title/privacy trong đó được tôn trọng; thiếu title thì fallback sang
    # trường `title` riêng.
    meta: dict | None = None


@router.post("/api/yt-merge/thumbnail")
async def upload_merge_thumbnail(file: UploadFile = File(...)):
    """Upload ảnh thumbnail dùng khi push video đã ghép lên YouTube."""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png"}:
        raise HTTPException(400, "Thumbnail phải là file .jpg/.jpeg/.png")
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(400, "Thumbnail tối đa 10MB.")
    if len(content) == 0:
        raise HTTPException(400, "File rỗng.")
    d = _yt_merge_dir() / "thumbs"
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"{uuid.uuid4().hex[:8]}{ext}"
    dest.write_bytes(content)
    logger.info("merge thumbnail saved to %s (%d bytes)", dest, len(content))
    return {"path": str(dest)}


@router.get("/api/yt-merge/thumbnail")
async def serve_merge_thumbnail(path: str = ""):
    """Serve ảnh thumbnail đã upload (chỉ file trong thư mục thumbs)."""
    base = (_yt_merge_dir() / "thumbs").resolve()
    try:
        rp = Path(path).resolve()
    except Exception:
        raise HTTPException(404, "Thumbnail not found")
    if rp.parent != base or not rp.is_file():
        raise HTTPException(404, "Thumbnail not found")
    mime = "image/png" if rp.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(str(rp), media_type=mime, filename=rp.name)


@router.post("/api/yt-merge/upload/{job_id}")
async def push_merged_to_youtube(job_id: str, body: PushRequest):
    """Push video đã ghép lên YouTube (kèm meta + playlist)."""
    from app.routers.youtube import _merge_playlist_into_meta, _start_upload

    job = _merge_jobs.get(job_id)
    video_path: Path | None = None
    if job and job.get("status") == "done":
        video_path = Path(str(job.get("output_path") or ""))
    if video_path is None or not video_path.exists():
        # Backend vừa restart (mất job RAM): đọc file merged.mp4 trên đĩa.
        if _valid_job_id(job_id):
            p = _yt_merge_dir() / job_id / "merged.mp4"
            if p.exists():
                video_path = p
    if video_path is None or not video_path.exists():
        raise HTTPException(400, "Video chưa ghép xong.")

    title = (body.title or "").strip()
    if not title and job:
        title = (job.get("output_name") or "").strip()
    if not title:
        title = f"Ghép {len((job or {}).get('video_ids', []))} video"
    if body.privacy not in ("private", "unlisted", "public"):
        raise HTTPException(400, "privacy must be private|unlisted|public")

    if isinstance(body.meta, dict):
        meta = dict(body.meta)
        if not str(meta.get("title", "")).strip():
            meta["title"] = title
        meta.setdefault("description", body.description or "")
        # privacy của request là nguồn chuẩn (uploader Go đọc từ flag).
        meta["privacyStatus"] = body.privacy
    else:
        meta = {
            "title": title,
            "description": body.description or "",
            "tags": [],
            "hashtags": [],
            "privacyStatus": body.privacy,
        }
    if not str(meta.get("title", "")).strip():
        meta["title"] = title
    meta_path = video_path.parent / "meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if body.playlist_id:
        _merge_playlist_into_meta(meta_path, body.playlist_id)
    res = _start_upload(
        video_path, meta_path, body.thumbnail_path or "",
        body.privacy, body.channel_id or (job or {}).get("channel_id") or "",
    )
    # Lưu thông tin push vào project để mở lại sau vẫn thấy.
    try:
        rec = _load_project(job_id) or {}
        rec["meta"] = meta
        rec["push_channel_id"] = body.channel_id or rec.get("push_channel_id") or ""
        rec["push_playlist_id"] = body.playlist_id or rec.get("push_playlist_id") or ""
        rec["thumb_path"] = body.thumbnail_path or rec.get("thumb_path") or ""
        rec["upload_job_id"] = (res or {}).get("job_id")
        if str(meta.get("title", "")).strip():
            rec["name"] = str(meta["title"]).strip()
        if rec.get("id"):
            (_projects_dir() / f"{rec['id']}.json").write_text(
                json.dumps({**rec, "updated_at": time.time()}, ensure_ascii=False),
                encoding="utf-8",
            )
    except Exception:
        logger.exception("save push info failed")
    return res


@router.delete("/api/yt-merge/{job_id}")
async def delete_merge_job(job_id: str):
    job = _merge_jobs.pop(job_id, None)
    if not job:
        raise HTTPException(404, "Merge job not found")
    shutil.rmtree((_yt_merge_dir() / job_id), ignore_errors=True)
    return {"status": "ok", "removed": True}


# ── Route generic (đặt CUỐI để không nuốt các route cụ thể) ────

@router.get("/api/yt-merge/{job_id}")
async def get_concat_status(job_id: str):
    job = _merge_jobs.get(job_id)
    if not job:
        # Backend vừa restart: đọc record trên đĩa để list/detail vẫn xem được.
        rec = _load_project(job_id)
        if rec:
            return {
                "job_id": job_id,
                "status": rec.get("status", "done"),
                "stage": rec.get("stage", ""),
                "progress": rec.get("progress", 100),
                "output": rec.get("output"),
                "output_size": rec.get("output_size", 0),
                "error": rec.get("error"),
                "logs": [],
            }
        raise HTTPException(404, "Merge job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "output": job.get("output"),
        "output_size": job.get("output_size", 0),
        "error": job.get("error"),
        "logs": job.get("logs", []),
    }


@router.post("/api/yt-merge/{job_id}/cancel")
async def cancel_merge_job(job_id: str):
    """Yêu cầu dừng job ghép đang chạy (kill yt-dlp/FFmpeg, xoá file dở)."""
    job = _merge_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Merge job not found")
    if job.get("status") != "running":
        return {"job_id": job_id, "status": job.get("status"), "cancelled": False}
    job["cancel_requested"] = True
    proc = job.get("proc")
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass
    return {"job_id": job_id, "status": "cancelling", "cancelled": True}
