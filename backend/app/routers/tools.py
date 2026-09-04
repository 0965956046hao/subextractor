import asyncio
import json
import logging
import shlex
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from app.config import settings
from app.models import UpdateSrtRequest, PipelineState, TimelineAction
from app.dependencies import get_jobs, get_ws_clients, get_job_queue, get_pipeline_states
from app.services.media_utils import _srt_path, _srt_best_path, _video_path, _hardcoded_is_complete, _delogo_video_path
from app.services.srt_utils import _fmt, entries_to_srt, fix_timeline, merge_similar_adjacent, parse_srt, shift_overlaps, validate_timeline
from app.services.context_service import load_video_context, generate_video_context
import subprocess
import math
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
    srt_path = _srt_best_path(video_id)
    content = srt_path.read_text(encoding="utf-8")
    return {"entries": [e.model_dump() for e in parse_srt(content)]}


# ── GET /api/srt/{video_id}/validate ──
# Detect illogical timelines (end<=start, overlaps, out-of-order).

@router.get("/api/srt/{video_id}/validate")
async def validate_srt_timeline(video_id: str):
    srt_path = _srt_best_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    issues = validate_timeline(parse_srt(srt_path.read_text(encoding="utf-8")))
    return {"video_id": video_id, "issues": issues, "count": len(issues)}


# ── POST /api/srt/{video_id}/fix-timeline ──
# Auto-fix illogical timelines: min duration for end<=start, merge overlaps
# keeping the longest text. Backs up the previous content first.

@router.post("/api/srt/{video_id}/fix-timeline")
async def fix_srt_timeline(video_id: str):
    srt_path = _srt_best_path(video_id)
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
    srt_path = _srt_best_path(video_id)
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
    srt_path = _srt_best_path(video_id)
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


# ── POST /api/srt/{video_id}/retranslate ──
# Sau khi đối chiếu phát hiện các dòng chưa được dịch (giữ nguyên bản gốc),
# endpoint này tự động gọi Gemini dịch lại chỉ những dòng đó và trả về SRT đã
# vá. Body: { content: "<SRT đã dịch>", source_lang?, target_lang? }.

@router.post("/api/srt/{video_id}/retranslate")
async def retranslate_srt(video_id: str, request: Request):
    from app.services.translation_service import retranslate_untranslated

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    content = body.get("content", "")
    if not (content or "").strip():
        raise HTTPException(400, "Missing translated SRT content")
    source_lang = body.get("source_lang", "zh")
    target_lang = body.get("target_lang", "vi")
    try:
        updated = retranslate_untranslated(
            video_id,
            content,
            source_lang=source_lang,
            target_lang=target_lang,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    # Ghi luôn bản đã vá lên file SRT cuối (bản dịch) để các dòng chưa dịch
    # không bị rớt mất — trước đây chỉ trả về content mà không lưu.
    if updated != content:
        out_path = _srt_best_path(video_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(updated, encoding="utf-8")
    return {
        "video_id": video_id,
        "content": updated,
        "updated": updated != content,
    }


# ── PUT /api/srt/{video_id} ──

@router.put("/api/srt/{video_id}")
async def update_srt(video_id: str, body: UpdateSrtRequest):
    # Ghi về đúng file mà GET /entries đã đọc (_srt_best_path: ưu tiên bản dịch).
    # Trước đây ghi vào _srt_path (SRT gốc OCR) trong khi modal/transcript đọc
    # bản dịch → chỉnh sửa bị "mất" và risk-check vẫn thấy nội dung cũ.
    srt_path = _srt_best_path(video_id)
    # Preserve the pre-edit SRT on first overwrite so it can be inspected
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

    # Update the SRT file — cùng file mà modal đang hiển thị (_srt_best_path),
    # không phải SRT gốc OCR, nếu không chỉnh sửa sẽ không bao giờ được thấy.
    srt_path = _srt_best_path(video_id)
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
    if not _srt_best_path(video_id).exists():
        raise HTTPException(404, "SRT not found")

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
        apply_style_override,
        _find_font,
        _render_subtitle,
        _overlay_subtitle,
    )
    from app.routers.config_router import get_subtitle_style

    # Base style = cấu hình hiện tại; FE luôn gửi kèm font_size/margin_v/margin_h
    # nên không cần auto-fit ở đây (auto-fit chỉ dùng ở bước hardcode thật).
    style = get_subtitle_style()
    style = apply_style_override(style, style_override)

    font_path = _find_font(
        style.get("font_family", "Arial"),
        style.get("bold"),
        style.get("italic"),
    )
    # fixed_size=False để preview co-chữ-vừa-khung GIỐNG HỆT bước hardcode thật
    # (trước đây fixed_size=True làm dòng dài/video dọc hiện chữ to tràn khung
    # trong preview nhưng bị shrink ở video cuối → kéo xong bị lệch vị trí).
    overlay = _render_subtitle(sample_text, vw, vh, font_path, style)

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


# ── GET /api/delogo/{video_id}/status ──

@router.get("/api/delogo/{video_id}/status")
async def delogo_status(video_id: str):
    """Check if delogo.mp4 exists and is valid."""
    delogo_path = _delogo_video_path(video_id)
    exists = delogo_path.exists() and delogo_path.stat().st_size > 0
    valid = False
    if exists:
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(delogo_path)],
                capture_output=True,
                timeout=10,
                check=True,
            )
            duration_str = probe.stdout.decode("utf-8", errors="replace").strip()
            valid = bool(duration_str) and float(duration_str) > 0
        except Exception:
            valid = False
    return {"exists": exists, "valid": valid, "path": str(delogo_path) if exists else None}


# ── POST /api/telegram/web-app/{video_id} ──

@router.post("/api/telegram/web-app/{video_id}")
async def send_telegram_web_app(video_id: str, request: Request):
    """
    Send a Telegram message with Mini App button for watermark region selection.

    The Mini App URL will be: {web_app_url}?url={video_url}&videoid={video_id}
    """
    from app.services.telegram_service import telegram_service
    from app.services.video_processor import resolve_video_path

    if not telegram_service.has_connected_chats():
        raise HTTPException(400, "No Telegram devices connected")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    # Get video URL - use the new endpoint format
    video_url = body.get("video_url")
    if not video_url:
        # Build default URL using the tunnel/base URL
        base_url = body.get("base_url", "")
        if not base_url:
            # Try to get from config or use default
            from app.config import settings
            base_url = getattr(settings, "public_url", "http://localhost:8000")
        video_url = f"{base_url}/api/video/{video_id}/video.mp4?duration=10"

    # Mini App URL
    mode = str(body.get("mode", "") or "")
    mini_app_url = f"https://subtitlewatermark.vercel.app/?url={video_url}&videoid={video_id}"
    if mode:
        mini_app_url += f"&mode={mode}"

    # Message text
    text = (
        f"🖼️ <b>Chọn vùng watermark</b>\n\n"
        f"Video: <code>{video_id}</code>\n"
        f"Bấm nút bên dưới để mở Mini App và chọn vùng watermark cần xoá."
    )

    button_text = body.get("button_text", "🖼️ Chọn vùng watermark")

    # Send to all connected chats
    await telegram_service.broadcast_web_app_button(text, mini_app_url, button_text)

    return {
        "status": "ok",
        "mini_app_url": mini_app_url,
        "sent_to": len(telegram_service._chat_ids),
    }


# ── POST /api/delogo/{video_id} ──

@router.post("/api/delogo/{video_id}")
async def delogo_video(
    video_id: str,
    request: Request,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """
    Apply FFmpeg delogo filter to remove watermark(s).
    After success, updates pipeline state so frontend continues automatically.
    """

    video_path = _video_path(video_id)

    logger.info(
        f"[delogo] video_id={video_id} "
        f"video_path={video_path} "
        f"exists={video_path.exists()}"
    )

    # ============================================================
    # 1. Parse request body
    # ============================================================

    try:
        body = await request.json()

        if not isinstance(body, dict):
            raise HTTPException(
                status_code=400,
                detail="Request body must be a JSON object"
            )

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"[delogo] Failed to parse request body: {e}")

        raise HTTPException(
            status_code=400,
            detail="Invalid JSON request body"
        )

    # ============================================================
    # 2. Get regions
    # ============================================================

    raw_regions = body.get("regions")

    if not raw_regions:
        legacy_region = body.get("region")

        if legacy_region:
            raw_regions = [legacy_region]
        else:
            raw_regions = []

    logger.info(f"[delogo] Received regions: {raw_regions}")

    if not raw_regions:
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide regions: "
                "[{x1, y1, x2, y2}] "
                "with normalized coordinates 0..1"
            )
        )

    if not isinstance(raw_regions, list):
        raise HTTPException(
            status_code=400,
            detail="regions must be an array"
        )

    # Limit number of regions
    if len(raw_regions) > 20:
        raise HTTPException(
            status_code=400,
            detail="Maximum 20 delogo regions allowed"
        )

    # ============================================================
    # 3. Check video
    # ============================================================

    if not video_path.exists():
        logger.error(
            f"[delogo] Video file not found: {video_path}"
        )

        raise HTTPException(
            status_code=404,
            detail=f"Video not found: {video_id}"
        )

    if not video_path.is_file():
        logger.error(
            f"[delogo] Path is not a file: {video_path}"
        )

        raise HTTPException(
            status_code=500,
            detail="Video path is not a file"
        )

    file_size = video_path.stat().st_size

    logger.info(
        f"[delogo] Video size: "
        f"{file_size} bytes "
        f"({file_size / 1024 / 1024:.2f} MB)"
    )

    # ============================================================
    # 4. Get video resolution using ffprobe
    # ============================================================

    try:

        probe_cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            str(video_path),
        ]

        logger.info(
            f"[delogo] ffprobe command: "
            f"{' '.join(probe_cmd)}"
        )

        probe = subprocess.run(
            probe_cmd,
            capture_output=True,
            timeout=10,
            check=True,
        )

        probe_str = probe.stdout.decode(
            "utf-8",
            errors="replace"
        ).strip()

        logger.info(
            f"[delogo] ffprobe output: {probe_str}"
        )

        parts = probe_str.split("x")

        if len(parts) != 2:
            raise ValueError(
                f"Invalid ffprobe resolution: {probe_str}"
            )

        width = int(parts[0])
        height = int(parts[1])

        if width <= 0 or height <= 0:
            raise ValueError(
                f"Invalid video resolution: "
                f"{width}x{height}"
            )

    except subprocess.TimeoutExpired:

        logger.error(
            f"[delogo] ffprobe timeout: {video_path}"
        )

        raise HTTPException(
            status_code=500,
            detail="ffprobe timed out"
        )

    except subprocess.CalledProcessError as e:

        stderr = (
            e.stderr.decode(
                "utf-8",
                errors="replace"
            )
            if e.stderr
            else ""
        )

        logger.error(
            f"[delogo] ffprobe failed: {stderr}"
        )

        raise HTTPException(
            status_code=500,
            detail=f"ffprobe failed: {stderr[-500:]}"
        )

    except Exception as e:

        logger.exception(
            f"[delogo] Cannot determine resolution"
        )

        raise HTTPException(
            status_code=500,
            detail=f"Cannot probe video resolution: {e}"
        )

    logger.info(
        f"[delogo] Video resolution: "
        f"{width}x{height}"
    )

    # ============================================================
    # 4.5 Mini App (pixel format) → confirm regions only, no FFmpeg.
    # The frontend picks up the regions and runs delogo itself (so the
    # log shows "Đang xoá watermark" like clicking "Xác Nhận Vùng" on FE).
    # ============================================================

    is_miniapp = any(
        isinstance(r, dict)
        and all(k in r for k in ("x", "y", "width", "height"))
        and not all(k in r for k in ("x1", "y1", "x2", "y2"))
        for r in raw_regions
    )

    if is_miniapp:
        normalized_regions = []
        for r in raw_regions:
            px_x = float(r["x"])
            px_y = float(r["y"])
            px_w = float(r["width"])
            px_h = float(r["height"])
            normalized_regions.append({
                "x1": round(px_x / width, 6),
                "y1": round(px_y / height, 6),
                "x2": round((px_x + px_w) / width, 6),
                "y2": round((px_y + px_h) / height, 6),
            })

        ps = pipeline_states.get(video_id) or {}
        ps["watermark_confirm"] = {
            "regions": normalized_regions,
            "confirmed": True,
        }
        pipeline_states[video_id] = ps

        logger.info(
            f"[delogo] Mini App confirmed {len(normalized_regions)} region(s) "
            f"-> normalized {normalized_regions}"
        )
        return {"status": "confirmed", "regions": normalized_regions}

    # ============================================================
    # 5. Convert normalized coordinates -> pixels
    # ============================================================

    delogo_filters = []

    for index, region in enumerate(raw_regions):

        logger.info(
            f"[delogo] Processing region {index + 1}: "
            f"{region}"
        )

        if not isinstance(region, dict):
            raise HTTPException(
                status_code=400,
                detail=f"Region {index + 1} must be an object"
            )

        # --------------------------------------------------------
        # Support both formats:
        #   1. Normalized: {x1, y1, x2, y2} (0..1)
        #   2. Pixel: {x, y, width, height} (from Mini App)
        # --------------------------------------------------------

        has_normalized = all(key in region for key in ("x1", "y1", "x2", "y2"))
        has_pixel = all(key in region for key in ("x", "y", "width", "height"))

        if has_pixel and not has_normalized:
            # Convert pixel coordinates to normalized (0..1)
            px_x = float(region["x"])
            px_y = float(region["y"])
            px_w = float(region["width"])
            px_h = float(region["height"])
            x1 = px_x / width
            y1 = px_y / height
            x2 = (px_x + px_w) / width
            y2 = (px_y + px_h) / height
            logger.info(
                f"[delogo] Region {index + 1}: pixel ({px_x}, {px_y}, {px_w}, {px_h}) "
                f"-> normalized ({x1:.4f}, {y1:.4f}, {x2:.4f}, {y2:.4f})"
            )
        elif has_normalized:
            # Already normalized
            try:
                x1 = float(region["x1"])
                y1 = float(region["y1"])
                x2 = float(region["x2"])
                y2 = float(region["y2"])
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=400,
                    detail=f"Region {index + 1}: x1/y1/x2/y2 must be numbers"
                )
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} must contain "
                    "x1, y1, x2, y2 (normalized) or x, y, width, height (pixels)"
                )
            )

        # --------------------------------------------------------
        # Check NaN / Infinity
        # --------------------------------------------------------

        values = (x1, y1, x2, y2)

        if not all(
            math.isfinite(value)
            for value in values
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "contains invalid number"
                )
            )

        # --------------------------------------------------------
        # Clamp normalized coordinates
        # --------------------------------------------------------

        x1 = max(0.0, min(1.0, x1))
        y1 = max(0.0, min(1.0, y1))
        x2 = max(0.0, min(1.0, x2))
        y2 = max(0.0, min(1.0, y2))

        # --------------------------------------------------------
        # Handle dragging in any direction
        #
        # Example:
        #
        # x1=0.8, x2=0.5
        #
        # becomes:
        #
        # left=0.5
        # right=0.8
        # --------------------------------------------------------

        left = min(x1, x2)
        right = max(x1, x2)

        top = min(y1, y2)
        bottom = max(y1, y2)

        # --------------------------------------------------------
        # Ignore zero-size regions
        # --------------------------------------------------------

        if right - left <= 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "has zero width"
                )
            )

        if bottom - top <= 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "has zero height"
                )
            )

        # ========================================================
        # Convert to pixel coordinates
        # ========================================================

        x = int(round(left * width))
        y = int(round(top * height))

        x2_pixel = int(round(right * width))
        y2_pixel = int(round(bottom * height))

        # --------------------------------------------------------
        # Clamp coordinates
        # --------------------------------------------------------

        x = max(
            0,
            min(x, width - 1)
        )

        y = max(
            0,
            min(y, height - 1)
        )

        x2_pixel = max(
            x + 1,
            min(x2_pixel, width)
        )

        y2_pixel = max(
            y + 1,
            min(y2_pixel, height)
        )

        # ========================================================
        # Calculate size
        # ========================================================

        region_width = x2_pixel - x
        region_height = y2_pixel - y

        # --------------------------------------------------------
        # Final safety validation
        # --------------------------------------------------------

        if region_width <= 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "has invalid width"
                )
            )

        if region_height <= 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "has invalid height"
                )
            )

        if x + region_width > width:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "extends outside video width"
                )
            )

        if y + region_height > height:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Region {index + 1} "
                    "extends outside video height"
                )
            )

        # ========================================================
        # Build FFmpeg delogo filter
        # ========================================================

        filter_str = (
            f"delogo="
            f"x={x}:"
            f"y={y}:"
            f"w={region_width}:"
            f"h={region_height}"
        )

        delogo_filters.append(filter_str)

        logger.info(
            f"[delogo] Region {index + 1}: "
            f"normalized="
            f"({x1:.6f},"
            f"{y1:.6f},"
            f"{x2:.6f},"
            f"{y2:.6f}) "
            f"-> pixels="
            f"x={x},"
            f"y={y},"
            f"w={region_width},"
            f"h={region_height} "
            f"filter={filter_str}"
        )

    # ============================================================
    # 6. Build output path
    # ============================================================

    output = _delogo_video_path(video_id)

    output.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    logger.info(
        f"[delogo] Output path: {output}"
    )

    # ============================================================
    # 7. Build FFmpeg filter
    # ============================================================

    video_filter = ",".join(
        delogo_filters
    )

    # ============================================================
    # 8. FFmpeg command
    # ============================================================

    ffmpeg_cmd = [
        "ffmpeg",
        "-y",

        "-i",
        str(video_path),

        "-vf",
        video_filter,

        # Re-encode video because delogo modifies frames
        "-c:v",
        "h264_videotoolbox",
        # "libx264",

        "-b:v",
        "10M",

        # Good quality
        # "-preset",
        # "medium",

        # "-crf",
        # "18",

        # Keep audio without re-encoding
        "-c:a",
        "copy",

        # MP4 optimization
        "-movflags",
        "+faststart",

        # Progress output for parsing
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.5",

        str(output),
    ]

    logger.info(
        f"[delogo] FFmpeg command:\n"
        f"{' '.join(ffmpeg_cmd)}"
    )

    # ============================================================
    # 9. Get total duration for progress tracking
    # ============================================================

    total_duration_seconds = 0.0

    try:
        duration_probe = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "csv=p=0",
                str(video_path),
            ],
            capture_output=True,
            timeout=10,
            check=True,
        )
        duration_str = duration_probe.stdout.decode("utf-8", errors="replace").strip()
        total_duration_seconds = float(duration_str)
        logger.info(f"[delogo] Video duration: {total_duration_seconds:.2f}s")
    except Exception as e:
        logger.warning(f"[delogo] Cannot get duration: {e}")

    # ============================================================
    # 10. Run FFmpeg — SSE stream
    # ============================================================

    import subprocess as _sp
    import re as _re
    import threading
    import time as _time

    def _run_delogo_sse():
        start_time = _time.time()
        proc = _sp.Popen(
            ffmpeg_cmd,
            stdout=_sp.PIPE,
            stderr=_sp.PIPE,
        )

        assert proc.stdout is not None
        assert proc.stderr is not None

        last_progress_pct = 0

        # ffmpeg periodic stats line (frame=… fps=…) — bỏ khỏi log live để dễ đọc
        # (tiến trình % đã được parse riêng từ -progress pipe:1).
        _stats_re = _re.compile(r"frame=\s*\d+.*fps=")

        def _read_stderr():
            """Read stderr for logs and progress info."""
            nonlocal last_progress_pct
            for raw_line in iter(proc.stderr.readline, b""):
                line = raw_line.decode("utf-8", errors="replace").rstrip()
                if line:
                    # Try to parse progress from stderr (some FFmpeg versions output here)
                    if total_duration_seconds > 0:
                        time_match = _re.search(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d+)", line)
                        if time_match:
                            hours = int(time_match.group(1))
                            minutes = int(time_match.group(2))
                            seconds = int(time_match.group(3))
                            millis = int(time_match.group(4))
                            current_seconds = hours * 3600 + minutes * 60 + seconds + millis / (10 ** len(time_match.group(4)))
                            progress_pct = min(99, int((current_seconds / total_duration_seconds) * 100))
                            if progress_pct != last_progress_pct:
                                last_progress_pct = progress_pct
                    if _stats_re.search(line):
                        continue
                    # Yield will be done from main thread via queue
                    stderr_queue.put(("log", line))

        def _read_stdout():
            """Read stdout for -progress output."""
            nonlocal last_progress_pct
            for raw_line in iter(proc.stdout.readline, b""):
                line = raw_line.decode("utf-8", errors="replace").rstrip()
                if line.startswith("out_time_us="):
                    try:
                        out_time_us = int(line.split("=", 1)[1])
                        current_seconds = out_time_us / 1_000_000
                        if total_duration_seconds > 0:
                            progress_pct = min(99, int((current_seconds / total_duration_seconds) * 100))
                            if progress_pct != last_progress_pct:
                                last_progress_pct = progress_pct
                                stderr_queue.put(("progress", progress_pct, current_seconds))
                    except (ValueError, IndexError):
                        pass
                elif line.startswith("out_time="):
                    time_match = _re.search(r"out_time=(\d{2}):(\d{2}):(\d{2})\.(\d+)", line)
                    if time_match:
                        hours = int(time_match.group(1))
                        minutes = int(time_match.group(2))
                        seconds = int(time_match.group(3))
                        millis = int(time_match.group(4))
                        current_seconds = hours * 3600 + minutes * 60 + seconds + millis / (10 ** len(time_match.group(4)))
                        if total_duration_seconds > 0:
                            progress_pct = min(99, int((current_seconds / total_duration_seconds) * 100))
                            if progress_pct != last_progress_pct:
                                last_progress_pct = progress_pct
                                stderr_queue.put(("progress", progress_pct, current_seconds))

        from queue import Queue, Empty
        stderr_queue: Queue = Queue()

        # Start reader threads
        t_stderr = threading.Thread(target=_read_stderr, daemon=True)
        t_stdout = threading.Thread(target=_read_stdout, daemon=True)
        t_stderr.start()
        t_stdout.start()

        # Real-time drain: đẩy log/progress ra ngay khi ffmpeg còn chạy (không
        # buffer tới cuối như trước — người dùng theo dõi được tiến trình live).
        while True:
            try:
                item = stderr_queue.get(timeout=0.5)
            except Empty:
                if proc.poll() is not None:
                    break
                continue
            if item[0] == "log":
                yield f"data: {json.dumps({'type': 'log', 'message': item[1]})}\n\n"
            elif item[0] == "progress":
                yield f"data: {json.dumps({'type': 'progress', 'pct': item[1], 'current': item[2], 'total': total_duration_seconds})}\n\n"

        # Process xong → chờ reader threads đọc nốt rồi drain phần còn lại.
        t_stderr.join(timeout=5)
        t_stdout.join(timeout=5)

        while not stderr_queue.empty():
            try:
                item = stderr_queue.get_nowait()
            except Empty:
                break
            if item[0] == "log":
                yield f"data: {json.dumps({'type': 'log', 'message': item[1]})}\n\n"
            elif item[0] == "progress":
                yield f"data: {json.dumps({'type': 'progress', 'pct': item[1], 'current': item[2], 'total': total_duration_seconds})}\n\n"

        # Close streams
        if proc.stderr:
            proc.stderr.close()
        if proc.stdout:
            proc.stdout.close()

        # Check result
        if proc.returncode != 0:
            try:
                if output.exists():
                    output.unlink()
            except Exception:
                pass
            yield f"data: {json.dumps({'type': 'error', 'message': f'FFmpeg failed (code {proc.returncode})'})}\n\n"
            return

        # Verify output file exists
        if not output.exists():
            yield f"data: {json.dumps({'type': 'error', 'message': 'FFmpeg produced no output file'})}\n\n"
            return

        output_size = output.stat().st_size
        if output_size <= 0:
            try:
                output.unlink()
            except Exception:
                pass
            yield f"data: {json.dumps({'type': 'error', 'message': 'FFmpeg produced an empty output file'})}\n\n"
            return

        # Verify with ffprobe
        try:
            probe = _sp.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(output)],
                capture_output=True,
                timeout=10,
                check=True,
            )
            duration_str = probe.stdout.decode("utf-8", errors="replace").strip()
            if not duration_str or float(duration_str) <= 0:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Output video has no duration'})}\n\n"
                return
        except Exception as e:
            logger.warning(f"[delogo] ffprobe output failed: {e}")

        elapsed = _time.time() - start_time

        # Update pipeline state so frontend continues automatically
        ps = pipeline_states.get(video_id) or {}
        ps["watermark_confirm"] = {
            "regions": raw_regions,
            "confirmed": True,
        }
        pipeline_states[video_id] = ps

        yield f"data: {json.dumps({'type': 'done', 'video_id': video_id, 'path': str(output), 'width': width, 'height': height, 'regions': len(delogo_filters), 'filters': delogo_filters, 'output_size': output_size, 'elapsed': round(elapsed, 1)})}\n\n"

    return StreamingResponse(
        _run_delogo_sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

# ── POST /api/hardcode/{video_id} ──

@router.post("/api/hardcode/{video_id}")
async def hardcode_subtitles(video_id: str, request: Request):
    _srt_path(video_id)
    video_path = _video_path(video_id)

    jobs = get_jobs(request)
    ws_clients = get_ws_clients(request)
    queue = get_job_queue(request)

    # Optional body: { auto_fit, region, style, watermark: bool, watermark_preset: id, playback_speed }
    auto_fit = False
    region = None
    style = None
    watermark = False
    watermark_preset = None
    playback_speed = 1.0
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
            try:
                ps = float(raw.get("playback_speed", 1.0))
                if 0.5 <= ps <= 3.0:
                    playback_speed = ps
                elif 0.25 <= ps <= 4.0:
                    playback_speed = max(0.5, min(3.0, ps))
            except Exception:
                pass
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
        "playback_speed": playback_speed,
    }
    jobs[job_id] = job
    logger.info(
        "hardcode job %s: queued for %s (auto_fit=%s, watermark=%s, preset=%s, speed=%s)",
        job_id, video_id, auto_fit, watermark, watermark_preset, playback_speed,
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
        try:
            _srt_path(video_id)
        except FileNotFoundError:
            raise HTTPException(404, "SRT gốc không tồn tại — cần chạy OCR/trích xuất phụ đề trước.")

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

    srt_path = _srt_best_path(video_id)
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
async def check_tts_alignment(video_id: str, lang: str = "vi"):
    """Check TTS audio duration vs SRT duration for each line.

    Returns list of lines where audio is longer than the SRT time range.
    Each item: {index, text, srt_duration, audio_duration, voice_type, display_name}.
    """
    from app.services.srt_utils import parse_srt
    from app.services.media_utils import _get_audio_duration
    from app.services.translation_service import load_voice_map
    from app.services.context_service import _load_capcut_voice_display_map

    srt_path = _srt_best_path(video_id)
    if not srt_path.exists():
        raise HTTPException(404, "SRT not found")
    entries = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not entries:
        return {"issues": [], "total": 0}

    voice_map = load_voice_map(video_id)
    display_map = _load_capcut_voice_display_map(lang)

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
    keep_ranges = body.get("keep_ranges") or []
    if not isinstance(keep_ranges, list):
        keep_ranges = []
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
        "keep_ranges": keep_ranges,
    }
    ws_clients.setdefault(job_id, [])
    logger.info(
        "dub job %s: queued for %s (engine=%s, voice=%s, mute_original=%s, gain_db=%s, keep_ranges=%d)",
        job_id, video_id, tts_engine, tts_voice, mute_original, original_gain_db,
        len(keep_ranges),
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
    # Generic progress reports don't carry timeline_check / watermark_confirm —
    # preserve whatever the dedicated endpoints stored so remote tabs keep
    # seeing the popup / the pipeline resumes after remote watermark selection.
    prev = pipeline_states.get(video_id) or {}
    if body.timeline_check is None:
        new_state["timeline_check"] = prev.get("timeline_check")
    if prev.get("voice_check"):
        new_state["voice_check"] = prev["voice_check"]
    if prev.get("watermark_confirm"):
        new_state["watermark_confirm"] = prev["watermark_confirm"]
    if prev.get("keep_original_confirm"):
        new_state["keep_original_confirm"] = prev["keep_original_confirm"]
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


# ── POST /api/pipeline/{video_id}/voice ──

@router.post("/api/pipeline/{video_id}/voice")
async def update_voice_check(
    video_id: str,
    body: dict,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """Voice-review pause state, mirroring timeline_check so a remote client
    (Telegram Mini App) can resolve the desktop pipeline's voice check.
    Body: {action: "wait"} or {action: "continue"}."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    action = str(body.get("action", "") or "")
    ps = pipeline_states.get(video_id) or {}
    vc = dict(ps.get("voice_check") or {})
    if action == "wait":
        vc.update({"waiting": True, "decision": None})
    elif action == "continue":
        vc.update({"waiting": False, "decision": "continue"})
    else:
        raise HTTPException(400, "action must be wait|continue")
    ps["voice_check"] = vc
    pipeline_states[video_id] = ps
    return {"ok": True, "video_id": video_id}


# ── POST /api/pipeline/{video_id}/keep-original ──

@router.post("/api/pipeline/{video_id}/keep-original")
async def update_keep_original(
    video_id: str,
    body: dict,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """Xác nhận các đoạn giữ tiếng gốc từ tab khác / Telegram Mini App.
    Body: {"confirmed": true, "ranges": [{"start": 1.2, "end": 5.0}, ...]}."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    ps = pipeline_states.get(video_id) or {}
    ps["keep_original_confirm"] = {
        "confirmed": bool(body.get("confirmed")),
        "ranges": body.get("ranges") or [],
    }
    pipeline_states[video_id] = ps
    return {"ok": True, "video_id": video_id}
