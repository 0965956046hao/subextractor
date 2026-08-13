import asyncio
import json
import logging
import shlex
import subprocess
import tempfile
from pathlib import Path

from app.config import settings
from app.models import SrtEntry

logger = logging.getLogger(__name__)


def _srt_path(video_id: str) -> Path:
    p = settings.temp_dir / "srt" / video_id / "subtitles.srt"
    if not p.exists():
        raise FileNotFoundError(f"SRT not found for {video_id}")
    return p


def _video_path(video_id: str) -> Path:
    video_dir = settings.temp_dir / "videos" / video_id
    for f in video_dir.iterdir():
        if f.stem.startswith("video"):
            return f
    raise FileNotFoundError(f"Video not found: {video_id}")


def _fmt(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _parse_time(t: str) -> float:
    h, m, rest = t.split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def parse_srt(content: str) -> list[SrtEntry]:
    entries: list[SrtEntry] = []
    for block in content.strip().split("\n\n"):
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue
        time_match = None
        for ln in lines:
            t = ln.strip()
            if "-->" in t:
                time_match = t
                break
        if not time_match:
            continue
        parts = time_match.split("-->")
        if len(parts) != 2:
            continue
        start_label = parts[0].strip()
        end_label = parts[1].strip()
        try:
            start = _parse_time(start_label)
            end = _parse_time(end_label)
        except Exception:
            continue
        text_lines = [l for l in lines if l.strip() and "-->" not in l and not l.strip().isdigit()]
        text = " ".join(text_lines)
        entries.append(SrtEntry(
            index=len(entries) + 1,
            start=start,
            end=end,
            startLabel=start_label,
            endLabel=end_label,
            text=text,
        ))
    return entries


def entries_to_srt(entries: list[SrtEntry]) -> str:
    blocks: list[str] = []
    for i, e in enumerate(entries):
        blocks.append(f"{i + 1}\n{e.startLabel} --> {e.endLabel}\n{e.text}")
    return "\n\n".join(blocks) + "\n"


def _get_duration(video_path: str) -> float:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=30)
        return float(out.decode().strip())
    except Exception:
        return 0


def _ass_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    cs = int(round((sec - int(sec)) * 100))
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def srt_to_ass_blackbox(srt_content: str, vw: int = 1920, vh: int = 1080) -> str:
    """Convert SRT → ASS with an opaque black-box style (BlackBoxStyle)."""
    header = f"""[Script Info]
Title: Subtitle Black Box
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: {vw}
PlayResY: {vh}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: BlackBoxStyle,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,16,0,2,50,50,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header.rstrip("\n")]
    for e in parse_srt(srt_content):
        text = e.text.replace("{", "\\{").replace("}", "\\}")
        lines.append(
            f"Dialogue: 0,{_ass_time(e.start)},{_ass_time(e.end)},BlackBoxStyle,,0,0,0,,{text}"
        )
    return "\n".join(lines) + "\n"


def _get_video_resolution(video_path: str) -> tuple[int, int]:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            video_path,
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=30)
        w, h = out.decode().strip().split("x")
        return int(w), int(h)
    except Exception:
        return 1920, 1080


class JobCancelled(Exception):
    """Raised when the user requests to cancel a running job."""


def notify_ws_sync(loop: asyncio.AbstractEventLoop, ws_clients: dict, job_id: str, data: dict):
    from app.worker import notify_ws
    coro = notify_ws(ws_clients, job_id, data)
    asyncio.run_coroutine_threadsafe(coro, loop)


# ── FFmpeg hardcoding (runs in executor) ──

def _has_subtitles_filter() -> bool:
    """Check whether ffmpeg was built with libass (subtitles filter)."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-filters"],
            capture_output=True, text=True, timeout=15,
        )
        return "subtitles" in (out.stdout or "")
    except Exception:
        return False


def _find_font() -> str | None:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Verdana.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


def _render_subtitle(text: str, vw: int, vh: int, font_path):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGBA", (vw, vh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    max_w = max(200, vw - 120)
    font_size = 48
    font = None
    while font_size > 20:
        try:
            font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), text, font=font)
        if bbox[2] - bbox[0] <= max_w:
            break
        font_size -= 4

    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    pad_x, pad_y = 24, 16
    box_w = tw + pad_x * 2
    box_h = th + pad_y * 2
    bx = (vw - box_w) // 2
    by = vh - box_h - 120

    draw.rectangle([bx, by, bx + box_w, by + box_h], fill=(0, 0, 0, 255))
    draw.text((bx + pad_x - bbox[0], by + pad_y - bbox[1]), text, font=font, fill=(255, 255, 255, 255))
    return np.array(img)


def _overlay_subtitle(frame, overlay_rgba):
    import cv2
    import numpy as np

    alpha = overlay_rgba[:, :, 3:4].astype(np.float32) / 255.0
    overlay_bgr = cv2.cvtColor(overlay_rgba[:, :, :3], cv2.COLOR_RGB2BGR).astype(np.float32)
    blended = frame.astype(np.float32) * (1.0 - alpha) + overlay_bgr * alpha
    return blended.astype(np.uint8)


def burn_subtitles_pillow(
    video_path_str: str,
    srt_path_str: str,
    out_path: str,
    progress_callback=None,
):
    """Burn black-box subtitles using OpenCV + Pillow (no libass required)."""
    import cv2

    content = Path(srt_path_str).read_text(encoding="utf-8")
    entries = parse_srt(content)
    if not entries:
        raise RuntimeError("No subtitle entries")

    font_path = _find_font()

    cap = cv2.VideoCapture(video_path_str)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path_str}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    tmp_path = str(Path(out_path).with_suffix(".burn.mp4"))
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(tmp_path, fourcc, fps, (vw, vh))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("Cannot open video writer")

    cache = {}
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        ts = idx / fps
        active = [e for e in entries if e.start <= ts < e.end]
        if active:
            text = " ".join(e.text for e in active)
            if text not in cache:
                cache[text] = _render_subtitle(text, vw, vh, font_path)
            frame = _overlay_subtitle(frame, cache[text])
        writer.write(frame)
        idx += 1
        if progress_callback and total and idx % 10 == 0:
            progress_callback(min(90, int(idx / total * 90)))

    cap.release()
    writer.release()

    # Mux original audio back onto the burned video
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", video_path_str,
            "-i", tmp_path,
            "-map", "0:a:0",
            "-map", "1:v:0",
            "-c", "copy",
            out_path,
        ],
        check=True, capture_output=True, timeout=600,
    )
    Path(tmp_path).unlink(missing_ok=True)

    if progress_callback:
        progress_callback(100)
    return Path(out_path)


def run_hardcode_sync(
    video_path_str: str,
    srt_path_str: str,
    out_path: str,
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
    job_id: str,
):
    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "hardcode"})

    total_dur = _get_duration(video_path_str)
    vw, vh = _get_video_resolution(video_path_str)

    srt_content = Path(srt_path_str).read_text(encoding="utf-8")
    ass_content = srt_to_ass_blackbox(srt_content, vw, vh)
    ass_path = Path(out_path).with_suffix(".ass")
    ass_path.write_text(ass_content, encoding="utf-8")

    if not _has_subtitles_filter():
        # ffmpeg lacks libass — fall back to OpenCV + Pillow burn
        logger.info("hardcode job %s: libass missing, using Pillow burn", job_id)

        def progress_cb(pct: int):
            job["progress"] = pct
            notify_ws_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "hardcode",
            })

        burn_subtitles_pillow(video_path_str, srt_path_str, out_path, progress_callback=progress_cb)
        job["progress"] = 100
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 100, "phase": "done"})
        return Path(out_path)

    cmd = [
        "ffmpeg",
        "-i", video_path_str,
        "-vf", f"subtitles={shlex.quote(str(ass_path))}",
        "-c:v", "libx264",
        "-crf", "23",
        "-preset", "medium",
        "-c:a", "copy",
        "-y",
        out_path,
    ]

    logger.info("hardcode job %s: %s", job_id, " ".join(shlex.quote(str(p)) for p in cmd))

    proc = subprocess.Popen(
        cmd,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        bufsize=1,
    )

    last_progress = 0
    assert proc.stderr is not None
    for line in proc.stderr:
        if job.get("cancelled"):
            proc.terminate()
            raise JobCancelled()
        if "time=" in line and total_dur > 0:
            try:
                time_str = line.split("time=")[1].split()[0]
                h, m, s = time_str.split(":")
                secs = int(h) * 3600 + int(m) * 60 + float(s)
                pct = min(99, int(secs / total_dur * 100))
                if pct >= last_progress + 10:
                    last_progress = pct
                    job["progress"] = pct
                    notify_ws_sync(loop, ws_clients, job_id, {
                        "type": "progress", "progress": pct, "phase": "hardcode",
                    })
            except Exception:
                pass

    ret = proc.wait()
    if ret != 0:
        raise RuntimeError(f"FFmpeg hardcode failed with code {ret}")

    job["progress"] = 100
    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 100, "phase": "done"})
    return Path(out_path)


# ── Whisper alignment (runs in executor) ──

def run_align_sync(
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
    job_id: str,
):
    video_id = job["video_id"]
    srt_path = _srt_path(video_id)
    video_path = _video_path(video_id)

    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "align"})

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as af:
        audio_path = af.name

    try:
        job["phase"] = "extract_audio"
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 5, "phase": "extract_audio"})

        extract_cmd = [
            "ffmpeg", "-i", str(video_path),
            "-vn", "-ar", "16000", "-ac", "1",
            "-y", audio_path,
        ]
        subprocess.run(extract_cmd, check=True, capture_output=True, timeout=120)

        job["phase"] = "whisper"
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 20, "phase": "whisper"})

        srt_content = srt_path.read_text(encoding="utf-8")
        entries = parse_srt(srt_content)

        if not entries:
            return

        aligned = _whisper_subword_align(audio_path, entries, job, ws_clients, loop, job_id)

        new_srt = entries_to_srt(aligned)
        srt_path.write_text(new_srt, encoding="utf-8")

        job["progress"] = 100
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done", "video_id": video_id, "lines": len(aligned),
        })

    finally:
        try:
            Path(audio_path).unlink(missing_ok=True)
        except Exception:
            pass


def _whisper_subword_align(
    audio_path: str,
    entries: list[SrtEntry],
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
    job_id: str,
) -> list[SrtEntry]:
    try:
        import faster_whisper

        model = faster_whisper.WhisperModel("small", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(audio_path, word_timestamps=True)

        job["progress"] = 30
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 30, "phase": "align"})

        word_spans: list[tuple[float, float, str]] = []
        for seg in segments:
            if seg.words:
                for w in seg.words:
                    word_spans.append((w.start, w.end, w.word.strip()))

        if not word_spans:
            raise RuntimeError("Whisper returned no word timestamps")

        return _best_match_align(entries, word_spans, job, ws_clients, loop, job_id)

    except ImportError:
        return _whisper_basic_align(audio_path, entries, job, ws_clients, loop, job_id)


def _best_match_align(
    entries: list[SrtEntry],
    word_spans: list[tuple[float, float, str]],
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
    job_id: str,
) -> list[SrtEntry]:
    total_spans = len(word_spans)
    full_text = "".join(w[2] for w in word_spans).lower()
    full_text_no_space = full_text.replace(" ", "")

    aligned: list[SrtEntry] = []
    search_start = 0

    for i, entry in enumerate(entries):
        if job.get("cancelled"):
            raise JobCancelled()
        target = entry.text.lower().replace(" ", "").replace("\n", "")
        if not target:
            aligned.append(entry)
            continue

        best_pos = -1
        best_dist = float("inf")

        max_search = len(full_text_no_space) - len(target) + 1
        for pos in range(search_start, max_search):
            mismatch = sum(1 for a, b in zip(target, full_text_no_space[pos:pos + len(target)]) if a != b)
            if mismatch < best_dist:
                best_dist = mismatch
                best_pos = pos
            if mismatch == 0:
                break

        if best_pos >= 0 and best_dist < len(target) * 0.4:
            char_pos = 0
            span_idx = 0
            span_start = best_pos
            span_end = best_pos + len(target)

            while span_idx < total_spans and char_pos < span_start:
                char_pos += len(word_spans[span_idx][2])
                span_idx += 1

            start_span_idx = span_idx

            while span_idx < total_spans and char_pos < span_end:
                char_pos += len(word_spans[span_idx][2])
                span_idx += 1

            end_span_idx = min(span_idx, total_spans - 1) if span_idx > 0 else 0
            start_span_idx = min(start_span_idx, end_span_idx)

            new_start = word_spans[start_span_idx][0]
            new_end = word_spans[end_span_idx][1]
        else:
            new_start = entry.start
            new_end = entry.end

        aligned.append(SrtEntry(
            index=len(aligned) + 1,
            start=new_start,
            end=new_end,
            startLabel=_fmt(new_start),
            endLabel=_fmt(new_end),
            text=entry.text,
        ))
        job["progress"] = min(95, 30 + int((i + 1) / len(entries) * 65))
        if i % max(1, len(entries) // 10) == 0:
            notify_ws_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": job["progress"], "phase": "align",
            })

    return aligned


def _whisper_basic_align(
    audio_path: str,
    entries: list[SrtEntry],
    job: dict,
    ws_clients: dict,
    loop: asyncio.AbstractEventLoop,
    job_id: str,
) -> list[SrtEntry]:
    import whisper

    model = whisper.load_model("small")
    result = model.transcribe(audio_path, word_timestamps=True)

    segments = result.get("segments", [])
    all_words: list[dict] = []
    for seg in segments:
        words = seg.get("words", [])
        all_words.extend(words)

    if not all_words:
        return entries

    search_window = 1.5
    aligned: list[SrtEntry] = []

    for i, entry in enumerate(entries):
        if job.get("cancelled"):
            raise JobCancelled()

        mid = (entry.start + entry.end) / 2
        candidates = [
            w for w in all_words
            if abs(w["start"] - entry.start) < search_window
        ]
        if candidates:
            new_start = min(w["start"] for w in candidates)
            new_end = max(w["end"] for w in candidates)
        else:
            new_start = entry.start
            new_end = entry.end

        aligned.append(SrtEntry(
            index=i + 1,
            start=new_start,
            end=new_end,
            startLabel=_fmt(new_start),
            endLabel=_fmt(new_end),
            text=entry.text,
        ))
        job["progress"] = min(95, 30 + int((i + 1) / len(entries) * 65))
        if i % max(1, len(entries) // 10) == 0:
            notify_ws_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": job["progress"], "phase": "align",
            })

    return aligned

