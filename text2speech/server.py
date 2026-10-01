"""Text2Speech — service độc lập: nhập văn bản → tách câu → gen voice CapCut → gộp 1 MP3.

Chạy riêng, không phụ thuộc backend/app hay frontend Next.js hiện tại.
Chỉ gọi tới capcut-tts-api (:8100) để sinh voice, và dùng ffmpeg để gộp MP3.

    TTS_PORT=8200 CAPCUT_URL=http://localhost:8100 python server.py
"""

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("text2speech")

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
TEMP_DIR = BASE_DIR / "temp"
JOBS_DIR = TEMP_DIR / "jobs"
for d in (TEMP_DIR, JOBS_DIR):
    d.mkdir(parents=True, exist_ok=True)

CAPCUT_URL = os.environ.get("CAPCUT_URL", "http://localhost:8100").rstrip("/")
PORT = int(os.environ.get("TTS_PORT", "8200"))
HOST = os.environ.get("TTS_HOST", "0.0.0.0")

# ---------------------------------------------------------------- tách câu ---

# Viết tắt thường gặp — dấu chấm sau các từ này KHÔNG phải kết câu.
_ABBREV = {
    "mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e",
    "th", "tp", "ts", "bs", "pgs", "gs", "cn", "ks",
    "a", "b", "c", "sđt", "đt",
}

# Dấu ngắt phụ khi câu quá dài: phẩy / chấm phẩy / gạch ngang.
_SUB_SPLIT = re.compile(r"(.+?[,，、;；:：–—-])(\s+|$)")


def _ends_with_abbrev(fragment: str) -> bool:
    m = re.search(r"([A-Za-zÀ-ỹ]+)\.$", fragment.strip())
    if m and m.group(1).lower() in _ABBREV:
        return True
    # Số thập phân: "3.14" — chấm nằm giữa 2 chữ số thì không tách.
    if re.search(r"\d\.$", fragment.strip()):
        return True
    return False


def split_sentences(text: str, max_len: int = 180) -> list[str]:
    """Cắt đoạn văn thành từng dòng theo dấu kết câu.

    - Chuẩn hoá \\r\\n, tab → space; giữ xuống dòng như 1 điểm ngắt.
    - Mỗi câu giữ nguyên dấu kết câu (. ! ? … 。 ! ? …).
    - Câu dài hơn max_len được chẻ tiếp ở dấu phẩy/chấm phẩy.
    """
    if not text or not text.strip():
        return []
    max_len = max(40, min(500, max_len or 180))

    norm = text.replace("\r\n", "\n").replace("\r", "\n")
    norm = re.sub(r"[ \t]+", " ", norm)
    norm = re.sub(r"\n{3,}", "\n\n", norm).strip()

    # Ngắt thô theo xuống dòng trước (mỗi dòng nhập tay là 1 ý).
    paragraphs: list[str] = []
    for para in norm.split("\n"):
        para = para.strip()
        if para:
            paragraphs.append(para)

    # Dấu kết câu + quote đóng theo sau (giữ lại trong câu).
    _delim = re.compile(r"(\.{2,}|…+|[.!?。！？]+[\"'\"'”’）)\]]*)")
    # Ký tự mở đầu câu mới (chữ hoa Latin/VN, số, CJK, Hàn, quote mở).
    _fresh_start = re.compile(
        r'[A-ZÀ-ỸA-Z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af"\'"\'“‘（(\[]'
    )

    raw: list[str] = []
    for para in paragraphs:
        buf = ""
        pos = 0
        for m in _delim.finditer(para):
            end = m.end()
            after = para[end:]
            stripped = after.lstrip()
            at_end = not stripped
            # Dấu CJK (。、! ?) cho phép ngắt ngay cả khi không có khoảng trắng.
            is_cjk = m.group(1) and m.group(1)[0] in "。！？…"
            boundary = at_end or (
                after[:1].isspace()
                and (not stripped or bool(_fresh_start.match(stripped[:1])))
            ) or (is_cjk and bool(stripped) and bool(
                re.match(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z]', stripped[:1])))
            if not boundary:
                continue
            frag = (buf + para[pos:end]).strip()
            frag = re.sub(r"\s+", " ", frag)
            pos = end
            buf = ""
            if not frag:
                continue
            # Viết tắt / số thập phân → chưa kết câu, giữ lại gộp tiếp.
            if _ends_with_abbrev(frag) and not at_end:
                buf = frag + " "
                continue
            raw.append(frag)
        tail = (buf + para[pos:]).strip()
        tail = re.sub(r"\s+", " ", tail)
        if tail:
            raw.append(tail)

    # Fallback: nếu regex không tách được gì (không có dấu câu) → giữ nguyên dòng.
    if not raw:
        raw = paragraphs

    # Chẻ câu quá dài ở dấu phẩy/chấm phẩy.
    out: list[str] = []
    for sent in raw:
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) <= max_len:
            out.append(sent)
            continue
        parts = [p.strip() for p in re.split(r"(?<=[,，、;；:：–—-])\s+", sent) if p.strip()]
        # Gom các mảnh ngắn liền kề cho đỡ vụn (mỗi dòng ≤ max_len).
        cur = ""
        for p in parts:
            cand = f"{cur} {p}".strip() if cur else p
            if len(cand) <= max_len:
                cur = cand
            else:
                if cur:
                    out.append(cur)
                # Mảnh đơn vẫn quá dài → cắt cứng theo từ.
                while len(p) > max_len:
                    cut = p.rfind(" ", 0, max_len)
                    cut = cut if cut > max_len // 2 else max_len
                    out.append(p[:cut].strip())
                    p = p[cut:].strip()
                cur = p
        if cur:
            out.append(cur)
    return out


# ------------------------------------------------------------- gọi CapCut ---


def _capcut_post_tts(segments: list[dict], voice: str, rate: str) -> str:
    r = httpx.post(
        f"{CAPCUT_URL}/api/tts",
        json={"segments": segments, "voice": voice, "rate": rate,
              "filename_prefix": "line"},
        timeout=30,
    )
    r.raise_for_status()
    job_id = r.json().get("job_id")
    if not job_id:
        raise RuntimeError("CapCut trả về job_id rỗng")
    return job_id


def _capcut_poll(job_id: str, timeout: float = 600.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = httpx.get(f"{CAPCUT_URL}/api/tts/{job_id}", timeout=15)
        r.raise_for_status()
        job = r.json()
        if job.get("status") in ("done", "error", "cancelled"):
            return job
        time.sleep(1.0)
    raise TimeoutError(f"Job CapCut {job_id} timeout sau {timeout:.0f}s")


def _capcut_download(job_id: str, filename: str, out_path: Path) -> Path:
    r = httpx.get(f"{CAPCUT_URL}/api/tts/{job_id}/audio/{filename}", timeout=60)
    r.raise_for_status()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(r.content)
    return out_path


def _check_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _run(cmd: list[str], timeout: int = 600) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg lỗi: {result.stderr[-500:]}")


def merge_mp3(parts: list[Path], out_path: Path, silence_ms: int = 300) -> Path:
    """Gộp các MP3 theo thứ tự thành 1 file, chèn khoảng lặng giữa các đoạn."""
    if not parts:
        raise RuntimeError("Không có file voice nào để gộp")
    if not _check_ffmpeg():
        raise RuntimeError("Không tìm thấy ffmpeg trong PATH")
    silence_ms = max(0, min(5000, silence_ms))
    work = out_path.parent
    if len(parts) == 1 and silence_ms == 0:
        shutil.copyfile(parts[0], out_path)
        return out_path

    ordered = parts
    if silence_ms > 0:
        silence_path = work / ".silence.mp3"
        if not silence_path.exists():
            _run([
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i",
                f"anullsrc=r=24000:cl=mono:d={silence_ms / 1000:.3f}",
                "-c:a", "libmp3lame", "-b:a", "128k",
                "-ar", "24000", "-ac", "1",
                str(silence_path),
            ])
        ordered = []
        for i, p in enumerate(parts):
            ordered.append(p)
            if i < len(parts) - 1:
                ordered.append(silence_path)

    list_file = work / ".concat_list.txt"
    # Concat demuxer yêu cầu escape dấu ' trong tên file.
    lines = []
    for p in ordered:
        name = p.name.replace("'", "'\\''")
        lines.append(f"file '{name}'\n")
    list_file.write_text("".join(lines), encoding="utf-8")
    _run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c:a", "libmp3lame", "-b:a", "192k",
        "-ar", "24000", "-ac", "1",
        str(out_path),
    ])
    list_file.unlink(missing_ok=True)
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Gộp MP3 thất bại (file rỗng)")
    return out_path


# ------------------------------------------------------------------ jobs ---

jobs: dict[str, dict] = {}
jobs_lock = asyncio.Lock()


async def _run_synthesize(job_id: str):
    job = jobs[job_id]
    lines: list[str] = job["lines"]
    voice: str = job["voice"]
    rate: str = job["rate"]
    silence_ms: int = job["silence_ms"]
    work = JOBS_DIR / job_id
    work.mkdir(parents=True, exist_ok=True)
    try:
        job["status"] = "requesting"
        segments = [{"text": t, "start": 0.0, "end": 0.0} for t in lines]
        capcut_id = await run_in_threadpool(_capcut_post_tts, segments, voice, rate)
        job["capcut_job"] = capcut_id
        job["status"] = "generating"

        capcut_job = await run_in_threadpool(
            _capcut_poll, capcut_id, max(300.0, len(lines) * 12 + 120)
        )
        if capcut_job.get("status") != "done":
            raise RuntimeError(
                f"CapCut kết thúc với status={capcut_job.get('status')}: "
                f"{capcut_job.get('error', '')}"
            )
        audio_files: list[str] = capcut_job.get("audio_files") or []
        if not audio_files:
            raise RuntimeError("CapCut không trả về file audio nào")

        job["total"] = len(audio_files)
        parts: list[Path] = []
        for i, remote in enumerate(sorted(audio_files)):
            fname = Path(remote).name
            # Service đặt tên line_0001.mp3 (1-based) — giữ đúng thứ tự.
            target = work / f"line_{i + 1:04d}.mp3"
            await run_in_threadpool(_capcut_download, capcut_id, fname, target)
            if target.exists() and target.stat().st_size > 0:
                parts.append(target)
            job["done"] = len(parts)
            job["progress"] = int(len(parts) / len(audio_files) * 90)

        if not parts:
            raise RuntimeError("Không tải được file voice nào từ CapCut")

        job["status"] = "merging"
        merged = work / "merged.mp3"
        await run_in_threadpool(merge_mp3, parts, merged, silence_ms)
        job["merged"] = str(merged)
        job["parts"] = [str(p) for p in parts]
        job["status"] = "done"
        job["progress"] = 100
        logger.info("job %s done: %d lines → %s", job_id, len(parts), merged)
    except Exception as e:
        logger.exception("job %s failed", job_id)
        job["status"] = "error"
        job["error"] = str(e)


# ---------------------------------------------------------------- models ---

class SplitRequest(BaseModel):
    text: str = ""
    max_len: int = Field(default=180, ge=40, le=500)


class PreviewRequest(BaseModel):
    voice: str
    text: str = "Xin chào, đây là giọng đọc thử."
    lang: str = "vi-VN"


class SynthRequest(BaseModel):
    lines: list[str] = Field(min_length=1, max_length=500)
    voice: str
    rate: str = "1.0"
    silence_ms: int = Field(default=300, ge=0, le=5000)
    lang: str = "vi-VN"


# ------------------------------------------------------------------- app ---

app = FastAPI(title="Text2Speech (CapCut TTS)", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    try:
        r = httpx.get(f"{CAPCUT_URL}/api/health", timeout=5)
        r.raise_for_status()
        data = r.json()
        capcut = {"healthy": data.get("status") == "ok",
                  "voices_loaded": data.get("voices_loaded", 0)}
    except Exception as e:
        capcut = {"healthy": False, "voices_loaded": 0, "error": str(e)}
    return {"service": "text2speech", "ffmpeg": _check_ffmpeg(),
            "capcut": capcut, "capcut_url": CAPCUT_URL}


@app.get("/api/voices")
async def voices(lang: str = "vi-VN"):
    try:
        r = httpx.get(f"{CAPCUT_URL}/api/voices", params={"lang": lang}, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise HTTPException(502, f"Không lấy được danh sách giọng: {e}") from e


@app.get("/api/langs")
async def langs():
    """Các ngôn ngữ phổ biến cho dropdown (khớp catalog CapCut)."""
    return [
        {"value": "vi-VN", "label": "Tiếng Việt"},
        {"value": "en-US", "label": "English (US)"},
        {"value": "zh-CN", "label": "中文 (普通话)"},
        {"value": "ja-JP", "label": "日本語"},
        {"value": "ko-KR", "label": "한국어"},
        {"value": "th-TH", "label": "ภาษาไทย"},
        {"value": "id-ID", "label": "Bahasa Indonesia"},
        {"value": "fr-FR", "label": "Français"},
        {"value": "de-DE", "label": "Deutsch"},
        {"value": "es-ES", "label": "Español"},
        {"value": "pt-BR", "label": "Português (BR)"},
    ]


@app.post("/api/split")
async def split_text(req: SplitRequest):
    lines = split_sentences(req.text, req.max_len)
    return {"lines": lines, "count": len(lines)}


@app.post("/api/preview")
async def preview(req: PreviewRequest):
    """Sinh 1 đoạn preview ngắn, trả về bytes MP3 để nghe thử."""
    text = (req.text or "").strip()[:200] or "Xin chào, đây là giọng đọc thử."
    try:
        capcut_id = await run_in_threadpool(
            _capcut_post_tts,
            [{"text": text, "start": 0.0, "end": 0.0}],
            req.voice, "1.0",
        )
        capcut_job = await run_in_threadpool(_capcut_poll, capcut_id, 90.0)
    except Exception as e:
        raise HTTPException(502, f"CapCut lỗi khi tạo preview: {e}") from e
    if capcut_job.get("status") != "done" or not capcut_job.get("audio_files"):
        raise HTTPException(
            502, f"Preview thất bại: {capcut_job.get('error', 'không có audio')}")
    fname = Path(capcut_job["audio_files"][0]).name
    try:
        r = httpx.get(f"{CAPCUT_URL}/api/tts/{capcut_id}/audio/{fname}", timeout=60)
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(502, f"Không tải được audio preview: {e}") from e
    return Response(content=r.content, media_type="audio/mpeg")


@app.post("/api/synthesize")
async def synthesize(req: SynthRequest):
    lines = [t.strip() for t in req.lines if t and t.strip()]
    if not lines:
        raise HTTPException(400, "Danh sách dòng trống")
    if len(lines) > 500:
        raise HTTPException(400, "Tối đa 500 dòng / lần")
    job_id = uuid.uuid4().hex[:12]
    async with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 0,
            "total": len(lines),
            "done": 0,
            "lines": lines,
            "voice": req.voice,
            "rate": req.rate or "1.0",
            "silence_ms": req.silence_ms,
            "lang": req.lang,
            "error": None,
            "capcut_job": None,
            "merged": None,
            "parts": [],
            "created_at": time.time(),
        }
    asyncio.create_task(_run_synthesize(job_id))
    return {"job_id": job_id, "total": len(lines)}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} không tồn tại")
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "total": job["total"],
        "done": job["done"],
        "error": job.get("error"),
        "has_merged": bool(job.get("merged") and Path(job["merged"]).exists()),
        "line_count": len(job.get("parts") or []),
    }


@app.get("/api/download/{job_id}")
async def download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} không tồn tại")
    merged = job.get("merged")
    if not merged or not Path(merged).exists():
        raise HTTPException(404, "File MP3 chưa sẵn sàng")
    return FileResponse(merged, media_type="audio/mpeg",
                        filename=f"text2speech_{job_id}.mp3")


@app.get("/api/line-audio/{job_id}/{index}")
async def line_audio(job_id: str, index: int):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} không tồn tại")
    parts = job.get("parts") or []
    if not (0 <= index < len(parts)) or not Path(parts[index]).exists():
        raise HTTPException(404, f"Dòng {index} chưa có audio")
    return FileResponse(parts[index], media_type="audio/mpeg",
                        filename=f"line_{index + 1:04d}.mp3")


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    async with jobs_lock:
        job = jobs.pop(job_id, None)
    if not job:
        raise HTTPException(404, f"Job {job_id} không tồn tại")
    shutil.rmtree(str(JOBS_DIR / job_id), ignore_errors=True)
    return {"status": "deleted", "job_id": job_id}


# Serve giao diện tĩnh (đặt SAU các route /api).
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


@app.get("/robots.txt")
async def robots():
    return Response(content="User-agent: *\nDisallow: /\n", media_type="text/plain")


def main():
    import uvicorn

    logger.info("Text2Speech  >>>  http://localhost:%d  (CapCut: %s)", PORT, CAPCUT_URL)
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)


if __name__ == "__main__":
    main()
