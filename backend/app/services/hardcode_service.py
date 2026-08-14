"""Burn (hardcode) black-box subtitles into the video.

Supports two engines:
1. ffmpeg `subtitles` filter (needs libass) — fast, uses the generated ASS.
2. OpenCV + Pillow frame-by-frame burn — fallback when libass is missing.
"""

import logging
import shlex
import subprocess
import time
from pathlib import Path

from app.config import settings
from app.services.srt_utils import parse_srt
from app.services.media_utils import _get_duration, _get_video_resolution
from app.services.job_utils import JobCancelled, notify_ws_sync
from app.routers.config_router import get_subtitle_style

logger = logging.getLogger(__name__)


def apply_style_override(style: dict, override: dict | None) -> dict:
    """Coerce + merge a partial style override onto a base style dict."""
    out = dict(style)
    if not isinstance(override, dict):
        return out
    for k, v in override.items():
        if v is None:
            continue
        try:
            if isinstance(out.get(k), bool):
                out[k] = bool(v)
            elif isinstance(out.get(k), (int, float)):
                out[k] = int(v)
            else:
                out[k] = v
        except (TypeError, ValueError):
            pass
    return out


def _ass_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    cs = int(round((sec - int(sec)) * 100))
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _hex_to_ass_color(hex_color: str) -> str:
    """#RRGGBB → ASS &HAABBGGRR (alpha 00 = opaque)."""
    h = hex_color.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        h = "FFFFFF"
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        r, g, b = 255, 255, 255
    return f"&H00{b:02X}{g:02X}{r:02X}"


def _hex_to_rgba(hex_color: str, opacity: int = 255) -> tuple:
    h = hex_color.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        h = "FFFFFF"
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        r, g, b = 255, 255, 255
    return (r, g, b, max(0, min(255, opacity)))


def srt_to_ass_blackbox(
    srt_content: str,
    vw: int = 1920,
    vh: int = 1080,
    style: dict | None = None,
) -> str:
    """Convert SRT → ASS using the configured subtitle style."""
    s = style or get_subtitle_style()
    font = s.get("font_family", "Arial")
    size = max(10, int(int(s.get("font_size", 48)) * vh / 1080))
    primary = _hex_to_ass_color(s.get("text_color", "#FFFFFF"))
    outline_col = _hex_to_ass_color(s.get("outline_color", "#000000"))
    bold = 1 if s.get("bold") else 0
    italic = 1 if s.get("italic") else 0
    outline_w = max(0, int(s.get("outline_width", 0)))
    box_on = bool(s.get("box_enabled", True))
    back_col = _hex_to_ass_color(s.get("box_color", "#000000"))
    # ASS BorderStyle: 1=outline+shadow, 3=opaque box
    border_style = 3 if box_on else 1
    back_alpha = 255 - max(0, min(255, int(s.get("box_opacity", 210))))

    header = f"""[Script Info]
Title: Subtitle Black Box
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: {vw}
PlayResY: {vh}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: SubStyle,{font},{size},{primary},&H000000FF,{outline_col},{back_col},{bold},{italic},0,0,100,100,0,0,{border_style},{outline_w},0,2,50,50,{max(0, int(int(s.get('margin_v', 40)) * vh / 1080))},1
"""
    # When using BorderStyle=3, apply box border colour as the outline colour so the
    # box edge is visible even if text outline is off.
    lines = [header.rstrip("\n")]
    for e in parse_srt(srt_content):
        text = e.text.replace("{", "\\{").replace("}", "\\}")
        lines.append(
            f"Dialogue: 0,{_ass_time(e.start)},{_ass_time(e.end)},SubStyle,,0,0,0,,{text}"
        )
    return "\n".join(lines) + "\n"


def auto_fit_style(
    style: dict,
    region: dict,
    vh: int,
    vw: int,
    srt_content: str = "",
) -> dict:
    """Derive a SINGLE uniform font size + margin_v so the burned sub covers the
    original sub region.

    region is normalized (0–1). The font size is computed ONCE from the region
    height (smallest size whose box just covers the region), then uniformly
    shrunk (still one size for all lines) only if the widest SRT line would
    overflow the region width. margin_v places the box bottom inside the region.
    """
    from PIL import Image, ImageDraw, ImageFont

    s = dict(style)
    x1 = max(0.0, min(1.0, float(region.get("x1", 0.0))))
    y1 = max(0.0, min(1.0, float(region.get("y1", 0.0))))
    x2 = max(0.0, min(1.0, float(region.get("x2", 1.0))))
    y2 = max(0.0, min(1.0, float(region.get("y2", 1.0))))
    rh = max(0.01, y2 - y1)
    rw = max(0.05, x2 - x1)

    region_h = max(40, int(rh * vh))
    region_w = max(100, int(rw * vw))

    font_path = _find_font(
        s.get("font_family", "Arial"),
        bool(s.get("bold")),
        bool(s.get("italic")),
    )
    texts = [e.text for e in parse_srt(srt_content)] or [" "]

    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    # Smallest font whose rendered box (~ font*1.25 + 32px padding) covers the region height
    font_px = max(18, int((region_h - 32) / 1.25))
    font_px = min(240, font_px)

    # Uniformly shrink while the widest line still overflows the region width.
    while font_px > 18:
        try:
            font = ImageFont.truetype(font_path, font_px) if font_path else ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()
        widest = max((draw.textbbox((0, 0), t, font=font)[2] for t in texts), default=0)
        if widest <= region_w - 16:
            break
        font_px -= 2

    # _render_subtitle scales font_size + margin_v by vh/1080, so store 1080p refs.
    s["font_size"] = max(18, int(font_px * 1080 / vh))
    s["margin_v"] = max(0, int((1 - y2) * 1080 - 40))
    return s


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


_FONT_DIRS = [
    "/System/Library/Fonts/Supplemental",
    "/System/Library/Fonts",
    "/Library/Fonts",
]


def _find_font(family: str = "Arial", bold: bool = False, italic: bool = False) -> str | None:
    """Resolve a font family to a .ttf/.ttc path on macOS (best-effort)."""
    fam = (family or "Arial").strip()
    variants = []
    if bold and italic:
        variants = ["Bold Italic", "Bold", "Italic", ""]
    elif bold:
        variants = ["Bold", ""]
    elif italic:
        variants = ["Italic", ""]
    else:
        variants = [""]

    names = [f"{fam} {v}".strip() for v in variants]
    for d in _FONT_DIRS:
        dpath = Path(d)
        if not dpath.is_dir():
            continue
        for f in sorted(dpath.iterdir()):
            if f.suffix.lower() not in (".ttf", ".ttc"):
                continue
            base = f.stem.replace(" ", "")
            for n in names:
                if base == n.replace(" ", ""):
                    return str(f)
    # fallbacks
    for d in _FONT_DIRS:
        dpath = Path(d)
        if not dpath.is_dir():
            continue
        for f in sorted(dpath.iterdir()):
            base = f.stem.lower().replace(" ", "")
            if f.suffix.lower() in (".ttf", ".ttc") and base in ("arial", "helvetica"):
                return str(f)
    return None


def _render_subtitle(
    text: str,
    vw: int,
    vh: int,
    font_path: str | None,
    style: dict | None = None,
    fixed_size: bool = False,
):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    s = style or get_subtitle_style()
    font_size = max(10, int(s.get("font_size", 48)))
    # scale font size relative to 1080p reference so it looks consistent
    font_size = max(10, int(font_size * vh / 1080))
    font_path = font_path or _find_font(s.get("font_family", "Arial"), s.get("bold"), s.get("italic"))
    try:
        font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    text_color = _hex_to_rgba(s.get("text_color", "#FFFFFF"))
    outline_color = _hex_to_rgba(s.get("outline_color", "#000000"))
    outline_w = max(0, int(s.get("outline_width", 0)))
    box_on = bool(s.get("box_enabled", True))
    box_color = _hex_to_rgba(s.get("box_color", "#000000"), int(s.get("box_opacity", 210)))
    box_radius = max(0, int(s.get("box_radius", 12)))
    box_border_color = _hex_to_rgba(s.get("box_border_color", "#000000"))
    box_border_w = max(0, int(s.get("box_border_width", 0)))
    # margin_v is a 1080p reference, same as font_size, so the box stays at the
    # same proportional position when the video resolution changes.
    margin_v = max(0, int(int(s.get("margin_v", 40)) * vh / 1080))

    img = Image.new("RGBA", (vw, vh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    max_w = max(200, vw - 160)
    # shrink text if too wide for the video (unless a single uniform size is required)
    if not fixed_size:
        while font_size > 16:
            try:
                font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
            except Exception:
                font = ImageFont.load_default()
            bbox = draw.textbbox((0, 0), text, font=font)
            if bbox[2] - bbox[0] <= max_w:
                break
            font_size -= 2

    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    top = bbox[1]

    pad_x, pad_y = 24, 16
    box_w = tw + pad_x * 2 + outline_w * 2
    box_h = th + pad_y * 2 + outline_w * 2
    bx = (vw - box_w) // 2
    by = vh - box_h - margin_v - 40

    # draw rounded background box
    if box_on:
        if box_radius > 0:
            draw.rounded_rectangle(
                [bx, by, bx + box_w, by + box_h],
                radius=box_radius,
                fill=box_color,
                outline=box_border_color if box_border_w > 0 else None,
                width=box_border_w,
            )
        else:
            draw.rectangle(
                [bx, by, bx + box_w, by + box_h],
                fill=box_color,
                outline=box_border_color if box_border_w > 0 else None,
                width=box_border_w,
            )

    # draw text with optional outline stroke
    draw.text(
        (bx + pad_x + outline_w, by + pad_y + outline_w - top),
        text,
        font=font,
        fill=text_color,
        stroke_width=outline_w,
        stroke_fill=outline_color,
    )
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
    style: dict | None = None,
    fixed_size: bool = False,
):
    """Burn subtitles using OpenCV + Pillow (no libass required)."""
    import cv2

    content = Path(srt_path_str).read_text(encoding="utf-8")
    entries = parse_srt(content)
    if not entries:
        raise RuntimeError("No subtitle entries")

    font_path = _find_font(
        (style or get_subtitle_style()).get("font_family", "Arial"),
        (style or get_subtitle_style()).get("bold"),
        (style or get_subtitle_style()).get("italic"),
    )

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
                cache[text] = _render_subtitle(text, vw, vh, font_path, style, fixed_size)
            frame = _overlay_subtitle(frame, cache[text])
        writer.write(frame)
        idx += 1
        if progress_callback and total and idx % 10 == 0:
            progress_callback(min(90, int(idx / total * 90)))

    cap.release()
    writer.release()

    # Mux audio back onto the burned video (dubbed audio if available).
    # Re-encode to H.264 (mp4v is MPEG-4 Part 2, unplayable in browsers).
    audio_src = audio_source or video_path_str
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", audio_src,
            "-i", tmp_path,
            "-map", "0:a:0",
            "-map", "1:v:0",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            "-shortest",
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
    job.setdefault("logs", []).append({
        "message": "Nhúng phụ đề vào video (FFmpeg)...",
        "ts": time.time(), "level": "info",
    })
    notify_ws_sync(loop, ws_clients, job_id, {
        "type": "log", "message": "Nhúng phụ đề vào video (FFmpeg)...",
        "ts": time.time(), "level": "info",
    })

    total_dur = _get_duration(video_path_str)
    vw, vh = _get_video_resolution(video_path_str)

    srt_content = Path(srt_path_str).read_text(encoding="utf-8")
    style = get_subtitle_style()
    if job.get("auto_fit") and job.get("region"):
        style = auto_fit_style(style, job["region"], vh, vw, srt_content)
        logger.info(
            "hardcode job %s: auto-fit ON → font_size=%s margin_v=%s",
            job_id, style["font_size"], style["margin_v"],
        )
    elif job.get("style"):
        style = apply_style_override(style, job["style"])
        logger.info(
            "hardcode job %s: manual style → font_size=%s margin_v=%s",
            job_id, style.get("font_size"), style.get("margin_v"),
        )
    ass_content = srt_to_ass_blackbox(srt_content, vw, vh, style)
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
            style=style,
            # auto-fit or manual style must render at the exact size chosen.
            fixed_size=bool(job.get("auto_fit")) or bool(job.get("style")),
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
