import asyncio
import json
import logging
import shlex
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.models import UpdateSrtRequest, PipelineState
from app.dependencies import get_jobs, get_ws_clients, get_job_queue, get_pipeline_states
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import entries_to_srt, fix_timeline, parse_srt, validate_timeline
from app.services.context_service import load_video_context, generate_video_context

logger = logging.getLogger(__name__)
router = APIRouter()


def _original_download_name(video_id: str, suffix: str, ext: str = ".mp4") -> str:
    """Build a download filename from the original video name (meta.json).

    Falls back to the internal file name if no original name is recorded.
    """
    try:
        meta_path = settings.temp_dir / "videos" / video_id / "meta.json"
        if meta_path.exists():
            original = json.loads(meta_path.read_text(encoding="utf-8")).get("filename") or ""
            if original:
                return f"{Path(original).stem}{suffix}{ext}"
    except Exception:
        pass
    return f"video{suffix}{ext}"


# ── GET /api/srt/{video_id}/entries ──

@router.get("/api/srt/{video_id}/entries")
async def get_srt_entries(video_id: str):
    srt_path = _srt_path(video_id)
    content = srt_path.read_text(encoding="utf-8")
    return {"entries": [e.model_dump() for e in parse_srt(content)]}


# ── GET /api/srt/{video_id}/validate ──
# Detect illogical timelines (end<=start, overlaps, out-of-order).

@router.get("/api/srt/{video_id}/validate")
async def validate_srt_timeline(video_id: str):
    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    issues = validate_timeline(parse_srt(srt_path.read_text(encoding="utf-8")))
    return {"video_id": video_id, "issues": issues, "count": len(issues)}


# ── POST /api/srt/{video_id}/fix-timeline ──
# Auto-fix illogical timelines: min duration for end<=start, merge overlaps
# keeping the longest text. Backs up the previous content first.

@router.post("/api/srt/{video_id}/fix-timeline")
async def fix_srt_timeline(video_id: str):
    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    current = srt_path.read_text(encoding="utf-8")
    entries = parse_srt(current)
    if not entries:
        return {"video_id": video_id, "entries": [], "fixes": [], "count": 0}
    fixed, fixes = fix_timeline(entries)
    new_content = entries_to_srt(fixed)
    if new_content.strip() != current.strip():
        backup = srt_path.with_name("subtitles_original.srt")
        if not backup.exists():
            backup.write_text(current, encoding="utf-8")
    srt_path.write_text(new_content, encoding="utf-8")
    return {
        "video_id": video_id,
        "entries": [e.model_dump() for e in fixed],
        "fixes": fixes,
        "count": len(fixes),
    }


# ── PUT /api/srt/{video_id} ──

@router.put("/api/srt/{video_id}")
async def update_srt(video_id: str, body: UpdateSrtRequest):
    srt_path = _srt_path(video_id)
    # Preserve the original OCR SRT on first overwrite so it can be inspected
    # later (e.g. comparing timings after translation/hardcode).
    if srt_path.exists():
        current = srt_path.read_text(encoding="utf-8")
        if current.strip() != body.content.strip():
            backup = srt_path.with_name("subtitles_original.srt")
            if not backup.exists():
                backup.write_text(current, encoding="utf-8")
    srt_path.write_text(body.content, encoding="utf-8")
    return {"status": "ok", "video_id": video_id}


# ── POST /api/srt/{video_id}/risk-check ──
# Check-only: ask Gemini (in batches) to flag risky lines (untranslated text,
# overlapping timeline, adjacent content still similar). Never edits the SRT.
# Returns a job_id; poll /api/status/{job_id} then GET the result endpoint.

@router.post("/api/srt/{video_id}/risk-check")
async def start_risk_check(video_id: str, request: Request):
    _srt_path(video_id)

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    lang = str(body.get("lang", "vi") or "vi")

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "risk_check",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "lang": lang,
    }
    jobs[job_id] = job
    logger.info("risk-check job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued"}


@router.get("/api/srt/{video_id}/risk-check")
async def get_risk_check_result(video_id: str):
    result_path = settings.temp_dir / "risk_check" / f"{video_id}.json"
    if not result_path.exists():
        return {"video_id": video_id, "risks": [], "checked_at": None}
    data = json.loads(result_path.read_text(encoding="utf-8"))
    return {"video_id": video_id, **data}


# ── POST /api/mux/{video_id} ──

@router.post("/api/mux/{video_id}")
async def mux_subtitles(video_id: str):
    srt_path = _srt_path(video_id)
    video_path = _video_path(video_id)

    muxed_dir = settings.temp_dir / "muxed" / video_id
    muxed_dir.mkdir(parents=True, exist_ok=True)
    out_path = muxed_dir / f"{video_path.stem}_muxed.mp4"

    if out_path.exists():
        out_path.unlink()

    cmd = [
        "ffmpeg",
        "-i", str(video_path),
        "-i", str(srt_path),
        "-c:v", "copy",
        "-c:a", "copy",
        "-c:s", "mov_text",
        "-metadata:s:s:0", "language=eng",
        "-disposition:s:0", "default",
        "-y",
        str(out_path),
    ]

    logger.info("mux %s: %s", video_id, " ".join(shlex.quote(str(p)) for p in cmd))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode(errors="replace")[-300:]
            raise HTTPException(500, f"FFmpeg mux failed: {err}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Muxing failed: {e}")

    return {
        "status": "ok",
        "video_id": video_id,
        "filename": out_path.name,
        "size": out_path.stat().st_size,
    }


# ── GET /api/download/muxed/{video_id} ──

@router.get("/api/download/muxed/{video_id}")
async def download_muxed(video_id: str):
    muxed_dir = settings.temp_dir / "muxed" / video_id
    if not muxed_dir.exists():
        raise HTTPException(404, "Muxed file not found. Run mux first.")
    files = list(muxed_dir.glob("*_muxed.mp4"))
    if not files:
        raise HTTPException(404, "Muxed file not found. Run mux first.")
    path = files[0]
    return FileResponse(str(path), media_type="video/mp4", filename=_original_download_name(video_id, "_muxed"))


# ── POST /api/preview/subtitle/{video_id} ──

@router.post("/api/preview/subtitle/{video_id}")
async def preview_subtitle(video_id: str, request: Request):
    """Render a frame (at `time` seconds) with a subtitle overlay using a given
    style, for the manual "tự chỉnh vị trí" preview step.

    Body: { region: {x1,y1,x2,y2}, style: {font_size, margin_v, ...}, text?, time? }
    If `time` is omitted, the first frame is used. If the video has an SRT, the
    subtitle text at that timestamp is used (falling back to `text`).
    If `format: "overlay"`, returns a transparent PNG overlay (RGBA) sized to the
    video so the caller can layer it on top of a playing <video>. Otherwise a JPEG.
    Returns a JPEG of the frame with the subtitle burned at the given style.
    """
    import cv2

    video_path = _video_path(video_id)
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    region = body.get("region")
    style_override = body.get("style") or {}
    time_sec = float(body.get("time") or 0)
    overlay_only = body.get("format") == "overlay"
    sample_text = body.get("text") or "Phụ đề tiếng Việt"

    # Prefer the real SRT line visible at this timestamp so the user can scrub.
    try:
        srt_path = _srt_path(video_id)
        if srt_path.exists():
            for e in parse_srt(srt_path.read_text(encoding="utf-8")):
                if e.start <= time_sec < e.end:
                    sample_text = e.text
                    break
    except Exception:
        pass

    from fastapi.concurrency import run_in_threadpool

    # OpenCV frame read + subtitle render + encode are all CPU/IO-bound and
    # would otherwise block the event loop (freezing /api/status and everything
    # else) whenever a video is being processed. Run them in a worker thread.
    return await run_in_threadpool(
        _render_preview_image,
        video_path, time_sec, region, style_override, sample_text, overlay_only,
    )


def _render_preview_image(
    video_path: Path,
    time_sec: float,
    region: dict | None,
    style_override: dict,
    sample_text: str,
    overlay_only: bool,
) -> Response:
    """Blocking preview renderer — runs in a threadpool (see preview_subtitle)."""
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise HTTPException(500, "Không đọc được video")
    if time_sec > 0:
        cap.set(cv2.CAP_PROP_POS_MSEC, time_sec * 1000)
    ok, frame = cap.read()
    vh, vw = frame.shape[:2]
    cap.release()
    if not ok:
        raise HTTPException(500, "Không đọc được frame từ video")

    from app.services.hardcode_service import (
        auto_fit_style,
        apply_style_override,
        _find_font,
        _render_subtitle,
        _overlay_subtitle,
    )
    from app.routers.config_router import get_subtitle_style

    # Base style: start from the region-fit (matches what auto_fit would pick),
    # then let the user override font size / vertical position / etc.
    style = get_subtitle_style()
    if region and isinstance(region, dict):
        style = auto_fit_style(style, region, vh, vw)
    style = apply_style_override(style, style_override)

    font_path = _find_font(
        style.get("font_family", "Arial"),
        style.get("bold"),
        style.get("italic"),
    )
    overlay = _render_subtitle(sample_text, vw, vh, font_path, style, fixed_size=True)

    if overlay_only:
        import numpy as np

        # _render_subtitle returns PIL RGBA (RGB order); imencode expects BGR(A).
        rgba = np.ascontiguousarray(overlay)
        bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
        ok_png, buf = cv2.imencode(".png", bgra)
        if not ok_png:
            raise HTTPException(500, "Không encode được PNG")
        return Response(content=buf.tobytes(), media_type="image/png")

    frame = _overlay_subtitle(frame, overlay)

    ok_jpg, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok_jpg:
        raise HTTPException(500, "Không encode được JPEG")
    return Response(content=buf.tobytes(), media_type="image/jpeg")


# ── POST /api/hardcode/{video_id} ──

@router.post("/api/hardcode/{video_id}")
async def hardcode_subtitles(video_id: str, request: Request):
    _srt_path(video_id)
    video_path = _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    # Optional body: { auto_fit, region, style, watermark: bool, watermark_preset: id }
    auto_fit = False
    region = None
    style = None
    watermark = False
    watermark_preset = None
    try:
        raw = await request.json()
        if isinstance(raw, dict):
            auto_fit = bool(raw.get("auto_fit", False))
            region = raw.get("region")
            if region and not all(
                isinstance(region.get(k), (int, float))
                for k in ("x1", "y1", "x2", "y2")
            ):
                region = None
            if isinstance(raw.get("style"), dict):
                style = raw["style"]
            watermark = bool(raw.get("watermark", False))
            watermark_preset = raw.get("watermark_preset")
    except Exception:
        pass

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_path": str(video_path),
        "video_id": video_id,
        "job_type": "hardcode",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "auto_fit": auto_fit,
        "region": region,
        "style": style,
        "watermark": watermark,
        "watermark_preset": watermark_preset,
    }
    jobs[job_id] = job
    logger.info(
        "hardcode job %s: queued for %s (auto_fit=%s, watermark=%s, preset=%s)",
        job_id, video_id, auto_fit, watermark, watermark_preset,
    )
    await queue.put(job_id)
    return {"job_id": job_id}


# ── GET /api/download/hardcoded/{video_id} ──

@router.get("/api/download/hardcoded/{video_id}")
async def download_hardcoded(video_id: str):
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    if not hd_dir.exists():
        raise HTTPException(404, "Hardcoded file not found. Run hardcode first.")
    files = list(hd_dir.glob("*_hardcoded.mp4"))
    if not files:
        raise HTTPException(404, "Hardcoded file not found. Run hardcode first.")
    path = files[0]
    return FileResponse(str(path), media_type="video/mp4", filename=_original_download_name(video_id, "_hardcoded"))


# ── GET /api/preview/hardcoded/{video_id} (inline, cho iframe) ──

@router.get("/api/preview/hardcoded/{video_id}")
async def preview_hardcoded(video_id: str):
    hd_dir = settings.temp_dir / "hardcoded" / video_id
    if not hd_dir.exists():
        raise HTTPException(404, "Hardcoded file not found")
    files = list(hd_dir.glob("*_hardcoded.mp4"))
    if not files:
        raise HTTPException(404, "Hardcoded file not found")
    return FileResponse(str(files[0]), media_type="video/mp4")


# ── POST /api/align/{video_id} ──

@router.post("/api/align/{video_id}")
async def align_subtitles(video_id: str, request: Request):
    _srt_path(video_id)
    _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "align",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
    }
    jobs[job_id] = job
    logger.info("align job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id}


# ── POST /api/translate/{video_id} ──

@router.post("/api/translate/{video_id}")
async def translate_subtitles(video_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    srt_content = body.get("srt_content", "")
    source_lang = body.get("source_lang", "zh")
    target_lang = body.get("target_lang", "vi")

    if srt_content:
        tr_dir = settings.temp_dir / "translated" / video_id
        tr_dir.mkdir(parents=True, exist_ok=True)
        custom_srt = tr_dir / "input.srt"
        custom_srt.write_text(srt_content, encoding="utf-8")
    else:
        _srt_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "translate",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "use_custom_srt": bool(srt_content),
        "source_lang": source_lang,
        "target_lang": target_lang,
    }
    jobs[job_id] = job
    logger.info("translate job %s: queued for %s (custom=%s)", job_id, video_id, bool(srt_content))
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "translate", "progress": 0, "error": None, "logs": []}


# ── GET /api/download/translated/{video_id} ──

@router.get("/api/download/translated/{video_id}")
async def download_translated(video_id: str, lang: str = Query("vi")):
    tr_dir = settings.temp_dir / "translated" / video_id
    if not tr_dir.exists():
        raise HTTPException(404, "Translated SRT not found. Run translate first.")
    # Prefer the language-specific file; fall back to the only remaining .srt
    # (legacy files named subtitles_vi.srt / input.srt) for backward compat.
    path = tr_dir / f"subtitles_{lang}.srt"
    if not path.exists():
        files = list(tr_dir.glob("*.srt"))
        if not files:
            raise HTTPException(404, "Translated SRT not found. Run translate first.")
        path = files[0]
    return FileResponse(str(path), media_type="application/x-subrip", filename=path.name)


# ── POST /api/tts/{video_id} ──

@router.post("/api/tts/{video_id}")
async def tts_subtitles(video_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    srt_content = body.get("srt_content", "")
    track_name = body.get("track_name", "")
    tts_voice = body.get("voice", "vi-VN-Standard-A")

    if srt_content:
        # Save custom SRT temporarily for TTS
        tts_srt_dir = settings.temp_dir / "tts" / video_id
        tts_srt_dir.mkdir(parents=True, exist_ok=True)
        custom_srt = tts_srt_dir / "custom_input.srt"
        custom_srt.write_text(srt_content, encoding="utf-8")
    else:
        _srt_path(video_id)

    _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "tts",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "use_custom_srt": bool(srt_content),
        "track_name": track_name,
        "tts_voice": tts_voice,
    }
    jobs[job_id] = job
    logger.info("tts job %s: queued for %s (custom=%s)", job_id, video_id, bool(srt_content))
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "tts", "progress": 0, "error": None, "logs": []}


# ── GET /api/download/dubbed/{video_id} ──

@router.get("/api/download/dubbed/{video_id}")
async def download_dubbed(video_id: str):
    tts_dir = settings.temp_dir / "tts" / video_id
    if not tts_dir.exists():
        raise HTTPException(404, "Dubbed video not found. Run TTS first.")
    files = list(tts_dir.glob("dubbed_video.mp4"))
    if not files:
        raise HTTPException(404, "Dubbed video not found. Run TTS first.")
    path = files[0]
    return FileResponse(str(path), media_type="video/mp4", filename=_original_download_name(video_id, "_dubbed"))


# ── GET /api/preview/dubbed/{video_id} (inline, cho iframe) ──

@router.get("/api/preview/dubbed/{video_id}")
async def preview_dubbed(video_id: str):
    tts_dir = settings.temp_dir / "tts" / video_id
    if not tts_dir.exists():
        raise HTTPException(404, "Dubbed video not found")
    files = list(tts_dir.glob("dubbed_video.mp4"))
    if not files:
        raise HTTPException(404, "Dubbed video not found")
    return FileResponse(str(files[0]), media_type="video/mp4")


# ── POST /api/dub/{video_id} ──

@router.post("/api/dub/{video_id}")
async def dub_subtitles(video_id: str, request: Request):
    """Separate vocals (keep instrumental) + Vietnamese TTS → dubbed video."""
    _srt_path(video_id)
    _video_path(video_id)

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    tts_engine = body.get("engine", "google")
    tts_voice = body.get("voice", "")
    mute_original = bool(body.get("mute_original", True))
    try:
        original_gain_db = float(body.get("original_gain_db", 0.0))
    except (TypeError, ValueError):
        original_gain_db = 0.0
    if tts_engine == "capcut" and not tts_voice:
        tts_voice = settings.capcut_tts_default_voice
    if not tts_voice:
        tts_voice = "vi-VN-Standard-B"

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "dub",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "tts_voice": tts_voice,
        "tts_engine": tts_engine,
        "mute_original": mute_original,
        "original_gain_db": original_gain_db,
    }
    ws_clients.setdefault(job_id, [])
    logger.info(
        "dub job %s: queued for %s (engine=%s, voice=%s, mute_original=%s, gain_db=%s)",
        job_id, video_id, tts_engine, tts_voice, mute_original, original_gain_db,
    )
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "dub", "progress": 0, "error": None, "logs": []}


# ── GET /api/srt/{video_id}/available ──

@router.get("/api/srt/{video_id}/available")
async def list_available_srts(video_id: str):
    """List all SRT files available for this video (original + translated)."""
    files = []

    # Original OCR SRT: prefer the preserved backup if one exists (the live
    # subtitles.srt may have been overwritten by the translated version).
    backup = settings.temp_dir / "srt" / video_id / "subtitles_original.srt"
    orig = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    if backup.exists():
        files.append({"id": "original", "name": "Gốc (OCR)", "path": str(backup)})
        if orig.exists():
            files.append({"id": "current", "name": "Hiện tại (dịch/đã sửa)", "path": str(orig)})
    elif orig.exists():
        files.append({"id": "original", "name": "Gốc (OCR)", "path": str(orig)})

    tr_dir = settings.temp_dir / "translated" / video_id
    if tr_dir.exists():
        for f in sorted(tr_dir.glob("*.srt")):
            files.append({"id": f.stem, "name": f"Dịch ({f.stem})", "path": str(f)})

    return {"files": files}


# ── GET /api/srt/{video_id}/load/{file_id} ──

@router.get("/api/srt/{video_id}/load/{file_id}")
async def load_srt_file(video_id: str, file_id: str):
    """Load a specific SRT file and return its parsed content."""
    if file_id == "original":
        backup = settings.temp_dir / "srt" / video_id / "subtitles_original.srt"
        path = backup if backup.exists() else settings.temp_dir / "srt" / video_id / "subtitles.srt"
    elif file_id == "current":
        path = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    else:
        path = settings.temp_dir / "translated" / video_id / f"{file_id}.srt"

    if not path.exists():
        raise HTTPException(404, f"SRT file not found: {file_id}")

    content = path.read_text(encoding="utf-8")
    entries = parse_srt(content)
    return {"entries": [e.model_dump() for e in entries]}


# ── GET /api/tts/{video_id}/available ──

@router.get("/api/tts/{video_id}/available")
async def list_available_tts(video_id: str):
    """List all TTS audio files for this video."""
    files = []
    tts_dir = settings.temp_dir / "tts" / video_id
    if tts_dir.exists():
        # List MP3 files grouped by voice subdirectory
        for subdir in sorted(tts_dir.iterdir()):
            if subdir.is_dir():
                mp3_files = sorted(subdir.glob("*.mp3"))
                if mp3_files:
                    voice_label = subdir.name.replace("_", "-")
                    files.append({
                        "id": subdir.name,
                        "name": f"TTS {voice_label} ({len(mp3_files)} files)",
                        "count": len(mp3_files),
                    })
        # Legacy: MP3s directly in tts dir (old format)
        mp3_files = sorted(tts_dir.glob("*.mp3"))
        if mp3_files:
            files.append({
                "id": "legacy",
                "name": f"Audio TTS legacy ({len(mp3_files)} files)",
                "count": len(mp3_files),
            })
        # Also check for remuxed video
        dubbed = tts_dir / "dubbed_video.mp4"
        if dubbed.exists():
            files.append({"id": "dubbed", "name": "Video lồng tiếng", "size": dubbed.stat().st_size})
    return {"files": files}


# ── POST /api/project/{video_id}/save ──

@router.post("/api/project/{video_id}/save")
async def save_project(video_id: str, request: Request):
    """Save full timeline project state."""
    body = await request.json()
    proj_dir = settings.temp_dir / "projects" / video_id
    proj_dir.mkdir(parents=True, exist_ok=True)
    (proj_dir / "project.json").write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok"}


# ── GET /api/project/{video_id}/load ──

@router.get("/api/project/{video_id}/load")
async def load_project(video_id: str):
    """Load full timeline project state."""
    proj_path = settings.temp_dir / "projects" / video_id / "project.json"
    if not proj_path.exists():
        return {"tracks": [], "tts_clips": [], "video_muted": False}
    return json.loads(proj_path.read_text(encoding="utf-8"))


# ── POST /api/export/{video_id} ──

@router.post("/api/export/{video_id}")
async def export_video(video_id: str, request: Request):
    """Export final video with burned subtitles and mixed TTS audio."""
    _video_path(video_id)
    body = await request.json()

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "export",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "tracks": body.get("tracks", []),
        "tts_clips": body.get("tts_clips", []),
    }
    jobs[job_id] = job
    logger.info("export job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "export", "progress": 0, "error": None, "logs": []}


# ── GET /api/download/exported/{video_id} ──

@router.get("/api/download/exported/{video_id}")
async def download_exported(video_id: str):
    exp_dir = settings.temp_dir / "export" / video_id
    if not exp_dir.exists():
        raise HTTPException(404, "Exported file not found. Run export first.")
    files = list(exp_dir.glob("exported.mp4"))
    if not files:
        raise HTTPException(404, "Exported file not found. Run export first.")
    return FileResponse(str(files[0]), media_type="video/mp4", filename=_original_download_name(video_id, "_exported"))

@router.get("/api/tts-audio/{video_id}/{rest:path}")
async def serve_tts_audio(video_id: str, rest: str):
    path = settings.temp_dir / "tts" / video_id / rest
    if not path.exists():
        raise HTTPException(404, "Audio file not found")
    return FileResponse(str(path), media_type="audio/mpeg")


# ── GET /api/context/{video_id} ──

@router.get("/api/context/{video_id}")
async def get_context(video_id: str):
    """Return the saved video context text, or empty."""
    ctx = load_video_context(video_id)
    return {"video_id": video_id, "context": ctx or ""}


# ── POST /api/context/{video_id}/share-text ──

@router.post("/api/context/{video_id}/share-text")
async def save_share_text_endpoint(video_id: str, request: Request):
    """Persist the raw pasted share text for context generation."""
    from app.services.context_service import save_share_text

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    text = (body.get("text") or "").strip()
    if text:
        save_share_text(video_id, text)
    return {"status": "ok", "saved": bool(text)}


# ── POST /api/context/{video_id}/generate ──

@router.post("/api/context/{video_id}/generate")
async def generate_context(request: Request, video_id: str):
    """Upload snapshots to Gemini and generate video context via Vision."""
    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    # Check API key
    from app.services.retry_utils import configured_gemini_keys
    has_key = bool(configured_gemini_keys())
    if not has_key:
        raise HTTPException(400, "Gemini API key not configured. Vào Settings (⚙️) để nhập key.")

    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "context",
        "status": "queued",
        "phase": "context",
        "progress": 0,
        "created_at": __import__("time").time(),
        "cancelled": False,
    }
    ws_clients.setdefault(job_id, [])

    logger.info("context job %s: queued for %s", job_id, video_id)
    await queue.put(job_id)
    return {"job_id": job_id}


# ── Gemini File Store ──

@router.get("/api/gemini/files")
async def list_gemini_files(request: Request, video_id: str = ""):
    """List files in Gemini File Store, optionally filtered by video_id via local index."""
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(_list_gemini_files_sync, video_id)


def _list_gemini_files_sync(video_id: str) -> dict:
    """Blocking Gemini File Store listing — runs in a threadpool."""
    try:
        from google import genai
    except ImportError:
        raise HTTPException(400, "google-genai not installed")

    from app.services.translation_service import _read_user_config
    from app.services.context_service import _load_files_index
    from app.services.retry_utils import configured_gemini_keys
    cfg = _read_user_config()
    keys = configured_gemini_keys()
    api_key = keys[0] if keys else ""
    if not api_key:
        raise HTTPException(400, "Gemini API key not configured")

    client = genai.Client(api_key=api_key)

    if video_id:
        # Look up file names from local index, then get details from Gemini
        stored_key, indexed_files = _load_files_index(video_id)
        # File Store is key-scoped — use the key that uploaded these files,
        # falling back to the first configured key when the index has none.
        if stored_key and stored_key in keys:
            client = genai.Client(api_key=stored_key)
        indexed_names = set(indexed_files)
        if not indexed_names:
            return {"count": 0, "files": [], "video_id": video_id}

        result_files = []
        try:
            for f in client.files.list():
                try:
                    if f.name in indexed_names:
                        result_files.append({
                            "name": f.name,
                            "display_name": getattr(f, "display_name", "") or f.name,
                            "size_bytes": getattr(f, "size_bytes", 0) or 0,
                            "create_time": str(getattr(f, "create_time", "") or ""),
                        })
                except Exception:
                    continue
        except Exception as e:
            raise HTTPException(500, f"Failed to list files: {e}")

        return {"count": len(result_files), "files": result_files, "video_id": video_id}

    # No filter — list all files from Gemini
    try:
        all_files = list(client.files.list())
    except Exception as e:
        raise HTTPException(500, f"Failed to list files: {e}")

    result_files = []
    for f in all_files:
        try:
            result_files.append({
                "name": f.name or "",
                "display_name": getattr(f, "display_name", "") or f.name or "",
                "size_bytes": getattr(f, "size_bytes", 0) or 0,
                "create_time": str(getattr(f, "create_time", "") or ""),
            })
        except Exception:
            continue

    return {"count": len(result_files), "files": result_files}


@router.delete("/api/gemini/files/{name:path}")
async def delete_gemini_file(name: str, request: Request):
    """Delete a file from Gemini File Store by name."""
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(_delete_gemini_file_sync, name)


def _delete_gemini_file_sync(name: str) -> dict:
    """Blocking Gemini delete — runs in a threadpool."""
    try:
        from google import genai
    except ImportError:
        raise HTTPException(400, "google-genai not installed")

    from app.services.translation_service import _read_user_config
    from app.services.retry_utils import configured_gemini_keys
    cfg = _read_user_config()
    keys = configured_gemini_keys()
    api_key = keys[0] if keys else ""
    if not api_key:
        raise HTTPException(400, "Gemini API key not configured")

    client = genai.Client(api_key=api_key)
    try:
        client.files.delete(name=name)
    except Exception as e:
        raise HTTPException(500, f"Failed to delete file: {e}")

    return {"deleted": name}


# ── POST /api/pipeline/{video_id} ──

@router.post("/api/pipeline/{video_id}")
async def update_pipeline_state(
    video_id: str,
    body: PipelineState,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """Frontend AutoPipeline progress for a video. Tab 1 reports its step
    progress here; list_videos merges it into rows so every other tab mirrors
    the exact same stage / overall % / per-step progress."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    pipeline_states[video_id] = body.model_dump()
    return {"ok": True, "video_id": video_id}
