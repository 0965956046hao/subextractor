"""Persistent single-worker YouTube → quiet cut → Facebook Page pipeline."""

import copy
import json
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from app.config import settings
from app.models import FacebookFlowIn
from app.services import store
from app.services.downloader import _format_for, _js_runtime_arg, safe_title
from app.services.facebook_client import FacebookClient, build_caption
from app.services.quiet_cut import cut_video, find_cut, run_media
from app.services.youtube_client import get_video

_tasks: dict[str, dict] = {}
_lock = threading.RLock()
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="facebook-flow")
_TERMINAL = {"done", "error"}


def _root() -> Path:
    return settings.temp_dir / "facebook_flows"


def _directory(task_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", task_id):
        raise ValueError("Mã flow không hợp lệ.")
    return _root() / task_id


def _save(task: dict) -> None:
    path = _directory(task["task_id"]) / "task.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _update(task_id: str, **fields) -> None:
    with _lock:
        _tasks[task_id].update(fields, updated_at=time.time())
        _save(_tasks[task_id])


_ACTIVE_STATUSES = {"queued", "checking", "downloading", "analyzing", "cutting", "uploading", "processing", "publishing"}


def _queue_positions() -> dict[str, int]:
    """Vị trí trong hàng đợi (1 = đang xử lý/tiếp theo), chỉ tính task chưa xong."""
    ordered = sorted(
        (t for t in _tasks.values() if t.get("status") in _ACTIVE_STATUSES),
        key=lambda t: t.get("created_at", 0),
    )
    return {t["task_id"]: i + 1 for i, t in enumerate(ordered)}


def _public(task: dict) -> dict:
    data = copy.deepcopy(task)
    data.pop("request", None)
    data["clip_ready"] = bool(task.get("clip_ready") and (_directory(task["task_id"]) / "clip.mp4").is_file())
    data["thumbnail_ready"] = bool((_directory(task["task_id"]) / "thumbnail.jpg").is_file())
    data["can_resume"] = task["status"] == "error" and bool(task.get("upload_finished"))
    data["queue_position"] = _queue_positions().get(task["task_id"], 0)
    return data


def restore_tasks() -> None:
    if not _root().exists():
        return
    with _lock:
        for path in _root().glob("*/task.json"):
            try:
                task = json.loads(path.read_text(encoding="utf-8"))
                if _directory(task["task_id"]) != path.parent:
                    continue
                if task["status"] not in _TERMINAL:
                    task.update(status="error", message="Flow bị gián đoạn do backend khởi động lại.",
                                error="Kiểm tra video Facebook đã tạo trước khi chạy lại; flow không tự đăng lại.")
                    _save(task)
                _tasks[task["task_id"]] = task
            except (ValueError, KeyError, OSError):
                continue


def list_tasks() -> list[dict]:
    with _lock:
        return [_public(t) for t in sorted(_tasks.values(), key=lambda t: t["created_at"], reverse=True)]


def get_task(task_id: str) -> dict | None:
    with _lock:
        task = _tasks.get(task_id)
        return _public(task) if task else None


def create_task(body: FacebookFlowIn) -> dict:
    config = store.load_config()
    if not config.get("facebook_page_id") or not config.get("facebook_page_token"):
        raise ValueError("Nhập Facebook Page ID và Page access token trong Cấu hình trước.")
    for tool in ("ffmpeg", "ffprobe", "yt-dlp"):
        if not shutil.which(tool):
            raise ValueError(f"Chưa cài {tool} trên máy chạy backend.")
    with _lock:
        for existing in _tasks.values():
            if (existing["video_id"] == body.video_id and existing["page_id"] == config["facebook_page_id"]
                    and existing["status"] not in _TERMINAL):
                return _public(existing)
        task_id = uuid.uuid4().hex[:12]
        _directory(task_id).mkdir(parents=True)
        task = {
            "task_id": task_id, "video_id": body.video_id, "title": body.title or body.video_id,
            "page_id": config["facebook_page_id"], "page_name": "", "api_version": config["facebook_api_version"],
            "status": "queued", "progress": 0, "message": "Đang chờ xử lý…", "error": "",
            "created_at": time.time(), "request": body.model_dump(),
            "facebook_video_id": "", "facebook_url": "", "upload_finished": False,
            "clip_ready": False, "thumbnail_ready": False, "cut": None,
        }
        _tasks[task_id] = task
        _save(task)
        _pool.submit(_run, task_id, config)
        return _public(task)


def create_tasks(bodies: list[FacebookFlowIn], page_id: str = "") -> dict:
    """Thêm nhiều video vào hàng đợi — worker đơn xử lý tuần tự từng video."""
    created: list[dict] = []
    skipped: list[dict] = []
    seen_in_batch: set[str] = set()
    for body in bodies:
        if body.video_id in seen_in_batch:
            skipped.append({"video_id": body.video_id, "reason": "Trùng trong danh sách vừa chọn."})
            continue
        seen_in_batch.add(body.video_id)
        with _lock:
            active = any(
                t["video_id"] == body.video_id and t["page_id"] == page_id
                and t["status"] not in _TERMINAL
                for t in _tasks.values()
            ) if page_id else False
        if active:
            skipped.append({"video_id": body.video_id, "reason": "Video đã có trong hàng đợi."})
            continue
        try:
            created.append(create_task(body))
        except ValueError as exc:
            skipped.append({"video_id": body.video_id, "reason": str(exc)})
    # Refresh queue_position sau khi thêm hàng loạt.
    with _lock:
        for task in created:
            task["queue_position"] = _queue_positions().get(task["task_id"], 0)
    return {"tasks": created, "skipped": skipped, "count": len(created)}


def resume_task(task_id: str) -> dict:
    config = store.load_config()
    with _lock:
        task = _tasks.get(task_id)
        if not task:
            raise KeyError(task_id)
        if task["status"] != "error" or not task.get("upload_finished"):
            raise ValueError("Chỉ tiếp tục được flow đã upload xong Facebook và đang lỗi.")
        if task["page_id"] != config.get("facebook_page_id"):
            raise ValueError("Hãy cấu hình lại đúng Page của flow này trước khi tiếp tục.")
        _update(task_id, status="queued", error="", message="Đang chờ tiếp tục video đã upload…")
        _pool.submit(_run, task_id, {**config, "facebook_api_version": task["api_version"]}, True)
        return _public(task)


def artifact(task_id: str, name: str) -> tuple[Path, str] | None:
    task = get_task(task_id)
    if not task or name not in ("clip", "thumbnail"):
        return None
    if name == "clip" and not task["clip_ready"]:
        return None
    path = _directory(task_id) / ("clip.mp4" if name == "clip" else "thumbnail.jpg")
    return (path, f"{safe_title(task['title'])}_{name}{path.suffix}") if path.is_file() else None


def delete_task(task_id: str) -> None:
    with _lock:
        task = _tasks.get(task_id)
        if not task:
            raise KeyError(task_id)
        if task["status"] not in _TERMINAL:
            raise ValueError("Flow đang chạy, chưa thể xóa.")
        shutil.rmtree(_directory(task_id))
        del _tasks[task_id]


def _download(video_id: str, directory: Path, browser: str) -> Path:
    command = [
        "yt-dlp", "--no-playlist", "--no-progress", "--no-warnings",
        "--merge-output-format", "mp4", "--retries", "3", "--fragment-retries", "3",
        *_js_runtime_arg(), "-f", _format_for("1080"), "-o", str(directory / "source.%(ext)s"),
    ]
    if browser:
        command += ["--cookies-from-browser", browser]
    run_media(command + [f"https://www.youtube.com/watch?v={video_id}"], timeout=7200)
    for path in directory.glob("source.*"):
        if path.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov"):
            return path
    raise RuntimeError("Không tìm thấy video sau khi tải YouTube.")


def _thumbnail(video_id: str, directory: Path) -> None:
    with httpx.Client(timeout=30) as client:
        for name in ("maxresdefault", "sddefault", "hqdefault", "mqdefault"):
            response = client.get(f"https://i.ytimg.com/vi/{video_id}/{name}.jpg")
            if response.status_code == 200 and response.headers.get("content-type", "").startswith("image/") and len(response.content) > 1000:
                (directory / "thumbnail.jpg").write_bytes(response.content)
                return
    raise RuntimeError("Không tải được thumbnail gốc từ YouTube.")


def _complete_publish(task_id: str, facebook: FacebookClient) -> None:
    task = get_task(task_id)
    video_id = task["facebook_video_id"]
    _update(task_id, status="processing", progress=90, message="Đợi Facebook xử lý video…")
    data = facebook.wait_ready(video_id)
    if not data.get("published"):
        if not task.get("thumbnail_ready"):
            _update(task_id, message="Đang đặt thumbnail gốc cho video…", progress=94)
            facebook.set_thumbnail(video_id, _directory(task_id) / "thumbnail.jpg")
            _update(task_id, thumbnail_ready=True)
        _update(task_id, status="publishing", progress=97, message="Đang xuất bản lên Facebook Page…")
        facebook.publish(video_id)
        # Success acknowledgement is not proof of publication; check the object.
        for _ in range(12):
            data = facebook.video_status(video_id)
            if data.get("published") and data.get("status", {}).get("video_status") == "ready":
                break
            time.sleep(5)
        else:
            raise RuntimeError("Đã gửi yêu cầu đăng nhưng Facebook chưa xác nhận. Bấm Tiếp tục để kiểm tra cùng video này.")
    url = data.get("permalink_url") or f"https://www.facebook.com/watch/?v={video_id}"
    if url.startswith("/"):
        url = "https://www.facebook.com" + url
    _update(task_id, status="done", progress=100, error="", message="Đã đăng video lên Facebook Page.", facebook_url=url)


def _run(task_id: str, config: dict, resume: bool = False) -> None:
    try:
        with FacebookClient(config) as facebook:
            _update(task_id, status="checking", progress=2, message="Kiểm tra Facebook Page…")
            page = facebook.check_page()
            _update(task_id, page_name=page.get("name", ""))
            if resume:
                _complete_publish(task_id, facebook)
                return
            with _lock:
                body = FacebookFlowIn(**_tasks[task_id]["request"])
            directory = _directory(task_id)
            tokens = store.get_valid_tokens()
            info = get_video((tokens or {}).get("access_token"), config.get("youtube_api_key", ""), body.video_id)
            title = body.title if body.title is not None else info["title"][:255]
            description = body.description if body.description is not None else info.get("description", "")
            tags = body.tags if body.tags is not None else info.get("tags", [])
            caption = build_caption(description, tags, title=title, video_id=body.video_id)
            _update(task_id, title=title, description=caption, tags=tags,
                    status="downloading", progress=5, message="Đang tải video và thumbnail từ YouTube…")
            _thumbnail(body.video_id, directory)
            source = _download(body.video_id, directory, body.cookies_from_browser)
            _update(task_id, status="analyzing", progress=40, message="Đang tìm khoảng lặng quanh mốc cắt…")
            cut = find_cut(source, body.target_minutes * 60, body.search_window, body.silence_db, body.silence_duration)
            _update(task_id, cut=cut, status="cutting", progress=50, message=f"Đang cắt tại {cut['seconds'] / 60:.2f} phút…")
            output = directory / "clip.mp4"
            cut_video(source, output, cut["seconds"])
            _update(task_id, clip_ready=True, status="uploading", progress=75, message="Đang upload video đã cắt lên Facebook…")
            facebook.upload(output, title, caption, lambda **fields: _update(task_id, **fields))
            _complete_publish(task_id, facebook)
    except Exception as exc:
        message = str(exc)
        for secret in (config.get("facebook_page_token"), config.get("youtube_api_key")):
            if secret:
                message = message.replace(secret, "[hidden]")
        _update(task_id, status="error", error=message[:2000], message="Flow dừng do lỗi.")
