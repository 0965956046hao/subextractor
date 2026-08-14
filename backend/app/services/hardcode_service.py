"""Burn (hardcode) black-box subtitles into the video.

Supports two engines:
1. ffmpeg `subtitles` filter (needs libass) — fast, uses the generated ASS.
2. OpenCV + Pillow frame-by-frame burn — fallback when libass is missing.
"""

import logging
import shlex
import subprocess
from pathlib import Path

from app.config import settings
from app.services.srt_utils import parse_srt
from app.services.media_utils import _get_duration, _get_video_resolution
from app.services.job_utils import JobCancelled, notify_ws_sync

logger = logging.getLogger(__name__)


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
Style: BlackBoxStyle,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,16,0,2,50,50,40,1

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
    by = vh - box_h - 80

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
    audio_source: str | None = None,
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

    # Mux audio back onto the burned video (dubbed audio if available)
    audio_src = audio_source or video_path_str
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", audio_src,
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
    loop,
    job_id: str,
):
    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "hardcode"})

    total_dur = _get_duration(video_path_str)
    vw, vh = _get_video_resolution(video_path_str)

    srt_content = Path(srt_path_str).read_text(encoding="utf-8")
    ass_content = srt_to_ass_blackbox(srt_content, vw, vh)
    ass_path = Path(out_path).with_suffix(".ass")
    ass_path.write_text(ass_content, encoding="utf-8")

    # Chạy ffmpeg từ thư mục chứa file .ass, chỉ truyền tên file tương đối
    # để tránh lỗi escape đường dẫn tuyệt đối trong filter `subtitles`.
    ass_dir = str(ass_path.parent)
    ass_filename = ass_path.name

    # Use dubbed (instrumental + TTS Việt) audio if it exists, else original audio
    video_id = Path(video_path_str).parent.name
    full_audio_path = settings.temp_dir / "tts" / video_id / "full_audio.m4a"
    dubbed_path = settings.temp_dir / "tts" / video_id / "dubbed_video.mp4"
    if full_audio_path.exists():
        audio_src = full_audio_path
    elif dubbed_path.exists():
        audio_src = dubbed_path
    else:
        audio_src = None
    use_dubbed = audio_src is not None
    if use_dubbed:
        logger.info("hardcode job %s: using dubbed audio (%s)", job_id, audio_src.name)

    if not _has_subtitles_filter():
        # ffmpeg lacks libass — fall back to OpenCV + Pillow burn
        logger.info("hardcode job %s: libass missing, using Pillow burn", job_id)

        def progress_cb(pct: int):
            job["progress"] = pct
            notify_ws_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "hardcode",
            })

        burn_subtitles_pillow(
            video_path_str, srt_path_str, out_path,
            progress_callback=progress_cb,
            audio_source=str(audio_src) if use_dubbed else None,
        )
        job["progress"] = 100
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 100, "phase": "done"})
        return Path(out_path)

    if use_dubbed:
        cmd = [
            "ffmpeg",
            "-i", video_path_str,
            "-i", str(audio_src),
            "-vf", f"subtitles={ass_filename}",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "libx264",
            "-crf", "23",
            "-preset", "medium",
            "-c:a", "copy",
            "-shortest",
            "-y",
            out_path,
        ]
    else:
        cmd = [
            "ffmpeg",
            "-i", video_path_str,
            "-vf", f"subtitles={ass_filename}",
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
        cwd=ass_dir,
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
