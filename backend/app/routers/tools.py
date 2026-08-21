import asyncio
import json
import logging
import shlex
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.models import UpdateSrtRequest, PipelineState, TimelineAction
from app.dependencies import get_jobs, get_ws_clients, get_job_queue, get_pipeline_states
from app.services.media_utils import _srt_path, _video_path, _hardcoded_is_complete, _delogo_video_path
from app.services.srt_utils import _fmt, entries_to_srt, fix_timeline, merge_similar_adjacent, parse_srt, shift_overlaps, validate_timeline
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


# ── POST /api/srt/{video_id}/dedup ──
# Auto-fix duplicate subtitles by code (no LLM): merge consecutive cues whose
# text is >=80% similar, extending the previous cue's end over the duplicate.
# Backs up the previous content first. Runs after OCR and after translation as
# a double-check on both the original and translated SRT.

@router.post("/api/srt/{video_id}/dedup")
async def dedup_srt(video_id: str):
    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    current = srt_path.read_text(encoding="utf-8")
    entries = parse_srt(current)
    if not entries:
        return {"video_id": video_id, "entries": [], "changes": [], "count": 0}
    merged, changes = merge_similar_adjacent(entries)
    new_content = entries_to_srt(merged)
    if new_content.strip() != current.strip():
        backup = srt_path.with_name("subtitles_original.srt")
        if not backup.exists():
            backup.write_text(current, encoding="utf-8")
    srt_path.write_text(new_content, encoding="utf-8")
    return {
        "video_id": video_id,
        "entries": [e.model_dump() for e in merged],
        "changes": changes,
        "count": len(changes),
    }


# ── POST /api/srt/{video_id}/auto-fix-overlaps ──
# Auto-fix overlapping timelines by code (no LLM): scan the SRT line by line; if
# a line's start time is before the previous line's end time, push its start to
# after the previous line's end. Runs between Gemini translation and the manual
# timeline review. Backs up the previous content first.

@router.post("/api/srt/{video_id}/auto-fix-overlaps")
async def auto_fix_srt_overlaps(video_id: str):
    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    current = srt_path.read_text(encoding="utf-8")
    entries = parse_srt(current)
    if not entries:
        return {"video_id": video_id, "entries": [], "fixes": [], "count": 0}
    fixed, fixes = shift_overlaps(entries)
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


# ── POST /api/srt/{video_id}/compare ──
# Double-check #2: đối chiếu phụ đề (bản dịch) với file gốc còn trên đĩa, chạy
# NGAY SAU bước dịch và TRƯỚC khi ghi đè subtitles.srt bằng bản dịch. Phát hiện:
#   1) missing_ranges — khoảng thời gian trong bản gốc mà bản dịch không phủ
#      (dòng bị Gemini làm rơi mất, như lỗi mất đoạn 3:05-3:29 trước đây);
#   2) untranslated — dòng trong bản dịch còn giữ nguyên text bản gốc (chưa dịch).
# Body: { content: "<SRT đã dịch>" }.

def _merge_ranges(ranges: list[tuple[float, float]], tolerance: float) -> list[list[float]]:
    merged: list[list[float]] = []
    for s, e in ranges:
        if not merged or s > merged[-1][1] + tolerance:
            merged.append([s, e])
        else:
            merged[-1][1] = max(merged[-1][1], e)
    return merged


def _coverage_gaps(original, translated, tolerance: float = 0.3) -> list[dict]:
    """Time ranges covered by ``original`` but not by ``translated`` (in order)."""
    base = _merge_ranges(sorted((e.start, e.end) for e in original if e.end > e.start), tolerance)
    cover = _merge_ranges(sorted((e.start, e.end) for e in translated if e.end > e.start), tolerance)
    gaps: list[dict] = []
    for bs, be in base:
        covered = bs
        for cs, ce in cover:
            if ce <= covered + tolerance:
                continue
            if cs > be:
                break
            if cs > covered + tolerance:
                gaps.append({"from": _fmt(covered), "to": _fmt(cs), "duration": round(cs - covered, 3)})
            covered = max(covered, ce)
            if covered >= be - tolerance:
                break
        if covered < be - tolerance:
            gaps.append({"from": _fmt(covered), "to": _fmt(be), "duration": round(be - covered, 3)})
    return gaps


def _untranslated_lines(original, translated, threshold: float = 95.0) -> list[dict]:
    """Lines in ``translated`` still identical to their original counterpart."""
    from rapidfuzz import fuzz
    out: list[dict] = []
    for oe, te in zip(original, translated):
        a, b = oe.text.strip(), te.text.strip()
        if a and b and fuzz.ratio(a, b) >= threshold:
            out.append({"index": oe.index, "text": b})
    return out


@router.post("/api/srt/{video_id}/compare")
async def compare_srt(video_id: str, request: Request):
    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    original = parse_srt(srt_path.read_text(encoding="utf-8"))
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    translated_content = body.get("content", "")
    translated = parse_srt(translated_content) if (translated_content or "").strip() else []
    return {
        "video_id": video_id,
        "original_count": len(original),
        "translated_count": len(translated),
        "missing_ranges": _coverage_gaps(original, translated),
        "untranslated": _untranslated_lines(original, translated),
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


# ── POST /api/srt/{video_id}/re-translate-line ──
# Re-translate ONE SRT line with Gemini (same prompts as full SRT translation).
# The frontend timeline-check modal uses this for the "Dịch lại" button.

@router.post("/api/srt/{video_id}/re-translate-line")
async def re_translate_srt_line(video_id: str, request: Request):
    from app.services.translation_service import re_translate_line as _rt_line

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    index = int(body.get("index", 0))
    source_lang = str(body.get("source_lang", "zh") or "zh")
    target_lang = str(body.get("target_lang", "vi") or "vi")

    # Read the current SRT entry text so we can re-translate the same line.
    srt_path = _srt_path(video_id)
    current_entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    entry = next((e for e in current_entries if e.index == index), None)
    if entry is None:
        raise HTTPException(404, f"Không tìm thấy dòng #{index}")

    # Prefer the original (source-language) text so the re-translation works on
    # the source sentence, not on an already-translated text.
    source_text = entry.text
    orig_path = srt_path.with_name("subtitles_original.srt")
    if orig_path.exists():
        orig_entries = parse_srt(orig_path.read_text(encoding="utf-8"))
        src = next((e for e in orig_entries if e.index == index), None)
        if src is not None:
            source_text = src.text

    try:
        new_text = _rt_line(video_id, source_text, source_lang=source_lang, target_lang=target_lang)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return {"status": "ok", "index": index, "text": new_text}


# ── POST /api/srt/{video_id}/rewrite-line ──
# Rewrite a single SRT line using Gemini (make it shorter, keep meaning).

@router.post("/api/srt/{video_id}/rewrite-line")
async def rewrite_srt_line(video_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    index = int(body.get("index", 0))
    current_text = body.get("text", "").strip()
    mode = body.get("mode", "shorter")  # "shorter" or "manual"
    manual_text = body.get("manual_text", "").strip()

    if index < 1:
        raise HTTPException(400, "index required")
    if mode == "manual":
        if not manual_text:
            raise HTTPException(400, "manual_text required for manual mode")
        new_text = manual_text
    elif mode == "shorter":
        if not current_text:
            raise HTTPException(400, "text required for shorter mode")
        from app.services.translation_service import (
            _call_gemini, _clean_gemini_response, load_video_context,
            configured_gemini_keys,
        )
        if not configured_gemini_keys():
            raise HTTPException(400, "Gemini API key not configured")

        context = load_video_context(video_id)
        context_block = f"\nVIDEO CONTEXT:\n{context}\n" if context else ""

        prompt = (
            f"You are a subtitle editor. Rewrite the following subtitle line to be "
            f"SHORTER and more concise, while keeping the core meaning."
            f"{context_block}\n"
            f"Rules:\n"
            f"- Output ONLY the rewritten text, nothing else\n"
            f"- Keep it in the SAME LANGUAGE as the input\n"
            f"- Make it significantly shorter (fewer words/characters)\n"
            f"- Keep the meaning and emotion intact\n"
            f"- Natural for spoken subtitles (avoid formal/literary style)\n\n"
            f"Current text: {current_text}"
        )
        response = _call_gemini(prompt, {
            "system_instruction": "You are a concise subtitle editor. Output only the rewritten text.",
            "temperature": 0.4,
        })
        new_text = _clean_gemini_response(response.text.strip())
        # Take last non-empty line
        lines = [ln.strip() for ln in new_text.splitlines() if ln.strip()]
        new_text = lines[-1] if lines else current_text
    else:
        raise HTTPException(400, f"Unknown mode: {mode}")

    # Update the SRT file
    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    from app.services.srt_utils import parse_srt, entries_to_srt
    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if index > len(entries):
        raise HTTPException(400, f"Index {index} out of range (have {len(entries)} entries)")
    entries[index - 1] = entries[index - 1].model_copy(update={"text": new_text})
    srt_path.write_text(entries_to_srt(entries), encoding="utf-8")

    return {"status": "ok", "index": index, "text": new_text}


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


# ── POST /api/delogo/{video_id} ──

@router.post("/api/delogo/{video_id}")
async def delogo_video(video_id: str, request: Request):
    """Apply FFmpeg delogo filter to remove watermark from video."""
    import subprocess

    video_path = _video_path(video_id)

    # Parse region from body: { region: { x1, y1, x2, y2 } } (normalized 0-1)
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    region = body.get("region")
    if not region or not all(
        isinstance(region.get(k), (int, float))
        for k in ("x1", "y1", "x2", "y2")
    ):
        raise HTTPException(400, "Invalid region: provide { x1, y1, x2, y2 } normalized 0-1")

    # Get video resolution
    try:
        probe = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-of", "csv=s=x:p=0", str(video_path)],
            timeout=10,
        )
        w, h = map(int, probe.decode().strip().split("x"))
    except Exception:
        raise HTTPException(500, "Cannot probe video resolution")

    # Convert normalized → pixel coordinates
    x = int(float(region["x1"]) * w)
    y = int(float(region["y1"]) * h)
    rw = int((float(region["x2"]) - float(region["x1"])) * w)
    rh = int((float(region["y2"]) - float(region["y1"])) * h)

    # Clamp to valid range
    x = max(0, min(x, w - 1))
    y = max(0, min(y, h - 1))
    rw = max(1, min(rw, w - x))
    rh = max(1, min(rh, h - y))

    output = _delogo_video_path(video_id)
    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(video_path),
                "-vf", f"delogo=x={x}:y={y}:w={rw}:h={rh}",
                "-c:a", "copy",
                "-movflags", "+faststart",
                str(output),
            ],
            check=True,
            capture_output=True,
            timeout=600,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, f"FFmpeg delogo failed: {e.stderr.decode()[:500]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "FFmpeg delogo timed out")

    return {"status": "ok", "path": str(output)}


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
    # A previous crashed run can leave a partial encode at the final name. Refuse
    # to serve it so the frontend doesn't mistake a half-video for a done job.
    if not _hardcoded_is_complete(video_id):
        raise HTTPException(404, "Hardcoded file is incomplete. Run hardcode again.")
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
    if not _hardcoded_is_complete(video_id):
        raise HTTPException(404, "Hardcoded file is incomplete. Run hardcode again.")
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
    multi_voice = bool(body.get("multi_voice", False))

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
        "multi_voice": multi_voice,
    }
    jobs[job_id] = job
    logger.info("translate job %s: queued for %s (custom=%s)", job_id, video_id, bool(srt_content))
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "phase": "translate", "progress": 0, "error": None, "logs": []}


# ── GET /api/voice-map/{video_id} ──

@router.get("/api/voice-map/{video_id}")
async def get_voice_map(video_id: str, lang: str = "vi"):
    """Return the per-line CapCut voice assignment for multi-voice dubbing.

    ``map`` = {index: {voice_type, display_name}} so the frontend can show which
    voice reads each subtitle line.
    """
    from app.services.translation_service import load_voice_map
    from app.services.context_service import _load_capcut_voice_display_map

    voice_map = load_voice_map(video_id)
    display = _load_capcut_voice_display_map(lang)
    detail = {}
    for idx, vt in voice_map.items():
        detail[str(idx)] = {
            "voice_type": vt,
            "display_name": display.get(vt) or vt,
        }
    return {
        "exists": bool(voice_map),
        "voices": len(voice_map),
        "map": detail,
        "lang": lang,
    }


# ── POST /api/voice-map/{video_id} ──

@router.post("/api/voice-map/{video_id}")
async def generate_voice_map_now(request: Request, video_id: str):
    """Generate (or regenerate) the CapCut voice_map.json for multi-voice dubbing."""
    from fastapi.concurrency import run_in_threadpool
    from app.services.translation_service import generate_voice_map as _gen_voice_map

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    target_lang = str(body.get("target_lang", "vi") or "vi")

    srt_path = _srt_path(video_id)
    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not entries:
        raise HTTPException(400, "No SRT entries")

    voice_map = await run_in_threadpool(
        _gen_voice_map, video_id, entries, None, target_lang
    )
    if not voice_map:
        raise HTTPException(500, "Không tạo được voice_map.json (kiểm tra Gemini key / CapCut voice catalog).")
    return {"status": "done", "voices": len(voice_map)}


# ── PATCH /api/voice-map/{video_id}/line ──

@router.patch("/api/voice-map/{video_id}/line")
async def update_voice_map_line(request: Request, video_id: str):
    """Update a single line's voice in voice_map.json.

    Body: ``{"index": 1, "voice_type": "BV421_vivn_streaming"}``.
    """
    from app.services.translation_service import _voice_map_path
    import json as _json

    body = await request.json()
    index = body.get("index")
    voice_type = body.get("voice_type")
    if index is None or voice_type is None:
        raise HTTPException(400, "index and voice_type required")

    p = _voice_map_path(video_id)
    if not p.exists():
        raise HTTPException(404, "voice_map.json not found — generate first")

    try:
        data = _json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        raise HTTPException(500, "Cannot parse voice_map.json")

    data[str(index)] = voice_type
    p.write_text(_json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "index": index, "voice_type": voice_type}


# ── POST /api/voice-map/{video_id}/bulk-switch ──

@router.post("/api/voice-map/{video_id}/bulk-switch")
async def bulk_switch_voice(request: Request, video_id: str):
    """Start a bulk voice switch job: change all lines using from_voice → to_voice + regenerate TTS.

    Body: ``{"from_voice": "ttnt", "to_voice": "tntt"}``.
    Returns ``job_id`` for polling.
    """
    body = await request.json()
    from_voice = body.get("from_voice")
    to_voice = body.get("to_voice")
    if not from_voice or not to_voice:
        raise HTTPException(400, "from_voice and to_voice required")

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "job_type": "bulk_switch",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "cancelled": False,
        "from_voice": from_voice,
        "to_voice": to_voice,
    }
    ws_clients.setdefault(job_id, [])
    logger.info("bulk_switch job %s: queued for %s (%s → %s)", job_id, video_id, from_voice, to_voice)
    await queue.put(job_id)
    return {"job_id": job_id, "status": "queued"}


# ── GET /api/tts/{video_id}/check-alignment ──

@router.get("/api/tts/{video_id}/check-alignment")
async def check_tts_alignment(video_id: str):
    """Check TTS audio duration vs SRT duration for each line.

    Returns list of lines where audio is longer than the SRT time range.
    Each item: {index, text, srt_duration, audio_duration, voice_type, display_name}.
    """
    from app.services.srt_utils import parse_srt
    from app.services.media_utils import _get_audio_duration
    from app.services.translation_service import load_voice_map
    from app.services.context_service import _load_capcut_voice_display_map

    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not entries:
        return {"issues": [], "total": 0}

    voice_map = load_voice_map(video_id)
    display_map = _load_capcut_voice_display_map("vi")

    issues = []
    tts_dir = settings.temp_dir / "tts" / video_id
    for i, entry in enumerate(entries):
        idx = i + 1
        vt = voice_map.get(idx)
        if not vt:
            continue
        voice_key = vt.replace("-", "_")
        mp3_path = tts_dir / voice_key / f"{idx:04d}.mp3"
        if not mp3_path.exists():
            continue
        srt_dur = entry.end - entry.start
        audio_dur = _get_audio_duration(mp3_path)
        if audio_dur > 0 and audio_dur > srt_dur + 0.1:  # 100ms tolerance
            issues.append({
                "index": idx,
                "text": entry.text,
                "start": entry.start,
                "end": entry.end,
                "srt_duration": round(srt_dur, 3),
                "audio_duration": round(audio_dur, 3),
                "overshoot": round(audio_dur - srt_dur, 3),
                "voice_type": vt,
                "display_name": display_map.get(vt, vt),
            })

    return {"issues": issues, "total": len(entries), "checked": len(voice_map)}


# ── GET /api/tts/{video_id}/audio/{index} ──

@router.get("/api/tts/{video_id}/audio/{index}")
async def get_tts_audio(video_id: str, index: int):
    """Serve a single TTS MP3 file for preview."""
    from fastapi.responses import FileResponse
    from app.services.translation_service import load_voice_map

    voice_map = load_voice_map(video_id)
    vt = voice_map.get(index)
    if not vt:
        raise HTTPException(404, f"No voice assigned to index {index}")

    voice_key = vt.replace("-", "_")
    mp3_path = settings.temp_dir / "tts" / video_id / voice_key / f"{index:04d}.mp3"
    if not mp3_path.exists():
        raise HTTPException(404, f"MP3 not found: {mp3_path}")

    return FileResponse(str(mp3_path), media_type="audio/mpeg")


# ── POST /api/tts/{video_id}/set-speed ──

@router.post("/api/tts/{video_id}/set-speed")
async def set_tts_speed(request: Request, video_id: str):
    """Apply atempo to a single TTS MP3 to speed it up.

    Body: ``{"index": 1, "speed": 1.2}``.
    Overwrites the original MP3 with the sped-up version.
    """
    import subprocess
    import tempfile

    body = await request.json()
    index = body.get("index")
    speed = body.get("speed")
    if index is None or speed is None:
        raise HTTPException(400, "index and speed required")
    try:
        speed = float(speed)
    except (TypeError, ValueError):
        raise HTTPException(400, "speed must be a number")
    if speed < 0.5 or speed > 3.0:
        raise HTTPException(400, "speed must be between 0.5 and 3.0")

    from app.services.translation_service import load_voice_map

    voice_map = load_voice_map(video_id)
    vt = voice_map.get(int(index))
    if not vt:
        raise HTTPException(404, f"No voice assigned to index {index}")

    voice_key = vt.replace("-", "_")
    tts_dir = settings.temp_dir / "tts" / video_id / voice_key
    mp3_path = tts_dir / f"{int(index):04d}.mp3"
    if not mp3_path.exists():
        raise HTTPException(404, f"MP3 not found: {mp3_path}")

    # Apply atempo via ffmpeg, write to temp file then replace
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = tmp.name
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(mp3_path),
            "-af", f"atempo={speed:.4f}",
            "-ac", "1", "-ar", "24000",
            "-c:a", "libmp3lame", "-b:a", "192k",
            tmp_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            raise HTTPException(500, f"ffmpeg error: {proc.stderr}")
        import shutil
        shutil.move(tmp_path, str(mp3_path))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to set speed: {e}")

    # Return new duration
    from app.services.media_utils import _get_audio_duration
    new_dur = _get_audio_duration(mp3_path)
    return {"status": "ok", "index": index, "speed": speed, "new_duration": round(new_dur, 3)}


# ── POST /api/tts/{video_id}/regenerate-line ──

@router.post("/api/tts/{video_id}/regenerate-line")
async def regenerate_tts_line(request: Request, video_id: str):
    """Regenerate TTS for a single SRT line with a new voice.

    Body: ``{"index": 1, "voice_type": "BV421_vivn_streaming"}``.
    Writes the MP3 to ``tts/{video_id}/{voice_key}/{index:04d}.mp3``.
    """
    from fastapi.concurrency import run_in_threadpool
    from app.services.capcut_tts_client import generate_segments_to_dir
    from app.services.srt_utils import parse_srt

    body = await request.json()
    index = body.get("index")
    voice_type = body.get("voice_type")
    if index is None or voice_type is None:
        raise HTTPException(400, "index and voice_type required")

    srt_path = _srt_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not entries or index < 1 or index > len(entries):
        raise HTTPException(400, f"Invalid index {index} (have {len(entries)} entries)")

    text = entries[index - 1].text.strip()
    if not text:
        raise HTTPException(400, f"Entry #{index} is empty")

    voice_key = voice_type.replace("-", "_")
    out_dir = settings.temp_dir / "tts" / video_id / voice_key
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        await run_in_threadpool(
            generate_segments_to_dir,
            [text],
            out_dir,
            voice_type,
            "1.0",
            "",  # prefix empty → files named {index:04d}.mp3
            None,
            None,
            [index],
        )
    except Exception as e:
        raise HTTPException(500, f"TTS failed: {e}")

    target = out_dir / f"{index:04d}.mp3"
    if not target.exists():
        raise HTTPException(500, "TTS file not created")

    return {"status": "ok", "index": index, "voice_type": voice_type, "file": str(target)}


# ── POST /api/tts/{video_id}/rebuild-full-audio ──

@router.post("/api/tts/{video_id}/rebuild-full-audio")
async def rebuild_full_audio(request: Request, video_id: str):
    """Rebuild full_audio.m4a from existing per-line TTS MP3s + background music.

    Body (optional): ``{"mute_original": true, "original_gain_db": 0}``.
    """
    from fastapi.concurrency import run_in_threadpool
    from app.services.dub_service import build_full_audio

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    mute_original = body.get("mute_original", True)
    original_gain_db = body.get("original_gain_db", 0.0)

    try:
        full_audio = await run_in_threadpool(
            build_full_audio,
            video_id,
            "vi-VN-Standard-B",  # voice_name ignored for rebuild
            "capcut",
            mute_original,
            original_gain_db,
            True,  # multi_voice
        )
    except Exception as e:
        raise HTTPException(500, f"Rebuild failed: {e}")

    if not full_audio or not full_audio.exists():
        raise HTTPException(500, "full_audio.m4a not created")

    return {
        "status": "ok",
        "audio_url": f"/api/download/dubbed/{video_id}",
        "size": full_audio.stat().st_size,
    }


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
        raise HTTPException(404, "Dubbed audio not found. Run TTS first.")
    files = list(tts_dir.glob("full_audio.m4a"))
    if not files:
        raise HTTPException(404, "Dubbed audio not found. Run TTS first.")
    path = files[0]
    if path.stat().st_size == 0:
        raise HTTPException(404, "Dubbed audio is incomplete. Run TTS again.")
    return FileResponse(str(path), media_type="audio/mp4", filename=_original_download_name(video_id, "_dubbed", ".m4a"))


# ── GET /api/preview/dubbed/{video_id} (inline, cho iframe) ──

@router.get("/api/preview/dubbed/{video_id}")
async def preview_dubbed(video_id: str):
    tts_dir = settings.temp_dir / "tts" / video_id
    if not tts_dir.exists():
        raise HTTPException(404, "Dubbed audio not found")
    files = list(tts_dir.glob("full_audio.m4a"))
    if not files:
        raise HTTPException(404, "Dubbed audio not found")
    if files[0].stat().st_size == 0:
        raise HTTPException(404, "Dubbed audio is incomplete. Run TTS again.")
    return FileResponse(str(files[0]), media_type="audio/mp4")


# ── POST /api/dub/{video_id} ──

@router.post("/api/dub/{video_id}")
async def dub_subtitles(video_id: str, request: Request):
    """Separate vocals (keep instrumental) + Vietnamese TTS → dubbed audio (no video merge)."""
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
    multi_voice = bool(body.get("multi_voice", False))
    try:
        original_gain_db = float(body.get("original_gain_db", 0.0))
    except (TypeError, ValueError):
        original_gain_db = 0.0
    if tts_engine == "capcut" and not tts_voice:
        tts_voice = settings.capcut_tts_default_voice
    if not tts_voice:
        tts_voice = "vi-VN-Standard-B"

    # Multi-voice: BẮT BUỘC có voice_map.json trước khi bắt đầu lồng tiếng.
    # Nếu chưa có thì tạo đồng bộ tại đây và CHỜ xong; không tạo được thì từ chối
    # bắt đầu job (không lồng tiếng thiếu giọng). Không để việc tạo rơi vào job dub.
    if multi_voice and tts_engine == "capcut":
        from app.services.translation_service import load_voice_map, generate_voice_map
        from fastapi.concurrency import run_in_threadpool

        if not load_voice_map(video_id):
            srt_path = _srt_path(video_id)
            entries = (
                parse_srt(srt_path.read_text(encoding="utf-8"))
                if srt_path.exists()
                else []
            )
            if not entries:
                raise HTTPException(
                    400,
                    "Bật nhiều giọng nói nhưng chưa có phụ đề để tạo voice_map.json — hãy chạy OCR/dịch trước.",
                )
            voice_map = await run_in_threadpool(generate_voice_map, video_id, entries, None)
            if not voice_map:
                raise HTTPException(
                    400,
                    "Bật nhiều giọng nói nhưng không tạo được voice_map.json "
                    "(kiểm tra Gemini key / CapCut voice catalog) — chưa bắt đầu lồng tiếng.",
                )

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
        "multi_voice": multi_voice,
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
        # Dubbed audio (mix nhạc nền + giọng TTS)
        dubbed = tts_dir / "full_audio.m4a"
        if dubbed.exists():
            files.append({"id": "dubbed", "name": "Audio lồng tiếng", "size": dubbed.stat().st_size})
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
    """Upload context images to Gemini and generate video context via Vision."""
    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    target_lang = str(body.get("target_lang", "vi") or "vi")

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
        "target_lang": target_lang,
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
    new_state = body.model_dump()
    # Generic progress reports don't carry timeline_check — preserve whatever the
    # dedicated timeline endpoint stored so remote tabs keep seeing the popup.
    if body.timeline_check is None:
        new_state["timeline_check"] = (pipeline_states.get(video_id) or {}).get("timeline_check")
    pipeline_states[video_id] = new_state
    return {"ok": True, "video_id": video_id}


# ── GET /api/pipeline/{video_id} ──

@router.get("/api/pipeline/{video_id}")
async def get_pipeline_state(
    video_id: str,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """Read back the reported AutoPipeline state for a video, so the driving tab
    can observe decisions made from other tabs/browsers (timeline review)."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    return pipeline_states.get(video_id) or {}


# ── POST /api/pipeline/{video_id}/timeline ──

@router.post("/api/pipeline/{video_id}/timeline")
async def update_timeline_check(
    video_id: str,
    body: TimelineAction,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """Timeline-review state for the "Kiểm tra dịch sub" step. The driving tab
    reports 'wait' when it pauses for review; any tab/browser can report 'open'
    to expand the modal, 'close' to collapse it back to the small prompt, or
    'continue'/'fix' to resolve the pause, which the driving tab picks up via
    GET /api/pipeline/{video_id}."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    ps = pipeline_states.get(video_id) or {}
    tc = dict(ps.get("timeline_check") or {})
    if body.action == "wait":
        tc.update({
            "waiting": True,
            "open": bool(tc.get("open")),
            "fixing": False,
            "decision": None,
            "issues": body.issues,
        })
    elif body.action == "open":
        tc.update({"waiting": True, "open": True})
    elif body.action == "close":
        # Collapse the big modal back to the small waiting prompt — the
        # pipeline stays paused (waiting) for review.
        tc.update({"waiting": True, "open": False, "fixing": False})
    elif body.action in ("continue", "fix"):
        tc.update({
            "waiting": False,
            "open": False,
            "fixing": body.action == "fix",
            "decision": body.action,
        })
    ps["timeline_check"] = tc
    pipeline_states[video_id] = ps
    return {"ok": True, "video_id": video_id}
