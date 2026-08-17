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
    # libass quirk: with BorderStyle=3 but Outline=0 AND Shadow=0, the opaque
    # box is not drawn at all (zero border extent). Force a 1px border so the
    # black background box actually renders.
    if box_on and outline_w < 1:
        outline_w = 1
    back_alpha = 255 - max(0, min(255, int(s.get("box_opacity", 210))))
    # margin_h is a 1920px reference (positive = right); shift the horizontal
    # margins so the black box moves with the user's drag offset.
    margin_h = int(int(s.get("margin_h", 0)) * vw / 1920)
    margin_l = max(0, 50 + margin_h)
    margin_r = max(0, 50 - margin_h)

    header = f"""[Script Info]
Title: Subtitle Black Box
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: {vw}
PlayResY: {vh}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: SubStyle,{font},{size},{primary},&H000000FF,{outline_col},{back_col},{bold},{italic},0,0,100,100,0,0,{border_style},{outline_w},0,2,{margin_l},{margin_r},{max(0, int(int(s.get('margin_v', 40)) * vh / 1080))},1
"""
    # When using BorderStyle=3, apply box border colour as the outline colour so the
    # box edge is visible even if text outline is off.
    lines = [header.rstrip("\n")]
    for e in _resolve_overlaps(parse_srt(srt_content)):
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
    s["margin_v"] = max(0, int((1 - y2) * 1080))
    return s


def _resolve_overlaps(entries):
    """Clip overlapping subtitle entries so they never stack or concatenate.

    When two entries overlap in time, the LATER one (the one that started last)
    wins the overlap region: the earlier entry is trimmed to end exactly when
    the later one starts. Returns a new list with non-overlapping timeline.
    """
    if not entries:
        return []
    ordered = sorted(entries, key=lambda e: (e.start, e.end))
    resolved = [ordered[0]]
    for e in ordered[1:]:
        prev = resolved[-1]
        if e.start < prev.end:
            resolved[-1] = prev.model_copy(update={"end": e.start})
        resolved.append(e)
    return resolved


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


def _wrap_text(draw, text: str, font, max_w: int) -> list[str]:
    """Wrap text into multiple lines so no line exceeds max_w (video width)."""
    if not text:
        return [""]
    lines: list[str] = []
    current = ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        bbox = draw.textbbox((0, 0), trial, font=font)
        if current and bbox[2] - bbox[0] > max_w:
            lines.append(current)
            current = word
        else:
            current = trial
    if current:
        lines.append(current)
    return lines or [text]


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
    scale = vh / 1080
    font_size = max(10, int(font_size * scale))
    font_path = font_path or _find_font(s.get("font_family", "Arial"), s.get("bold"), s.get("italic"))
    try:
        font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    text_color = _hex_to_rgba(s.get("text_color", "#FFFFFF"))
    outline_color = _hex_to_rgba(s.get("outline_color", "#000000"))
    outline_w = max(0, int(int(s.get("outline_width", 0)) * scale))
    box_on = bool(s.get("box_enabled", True))
    box_color = _hex_to_rgba(s.get("box_color", "#000000"), int(s.get("box_opacity", 210)))
    box_radius = max(0, int(int(s.get("box_radius", 12)) * scale))
    box_border_color = _hex_to_rgba(s.get("box_border_color", "#000000"))
    box_border_w = max(0, int(int(s.get("box_border_width", 0)) * scale))
    # margin_v is a 1080p reference, same as font_size, so the box stays at the
    # same proportional position when the video resolution changes.
    margin_v = max(0, int(int(s.get("margin_v", 40)) * scale))
    # margin_h is a 1920px reference for horizontal offset (positive = right).
    margin_h = int(int(s.get("margin_h", 0)) * vw / 1920)

    img = Image.new("RGBA", (vw, vh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    max_w = max(200, vw - 160)
    # shrink text only if even the widest single word is too wide for the video
    if not fixed_size:
        while font_size > 16:
            try:
                font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
            except Exception:
                font = ImageFont.load_default()
            widest = max(
                (draw.textbbox((0, 0), w, font=font)[2] - draw.textbbox((0, 0), w, font=font)[0] for w in text.split()),
                default=0,
            )
            if widest <= max_w:
                break
            font_size -= 2

    # Wrap long lines so they fit within the video width (auto line break).
    lines = _wrap_text(draw, text, font, max_w)

    line_boxes = [draw.textbbox((0, 0), ln, font=font) for ln in lines]
    tw = max((b[2] - b[0] for b in line_boxes), default=0)
    line_heights = [b[3] - b[1] for b in line_boxes]
    line_tops = [b[1] for b in line_boxes]
    line_gap = max(2, int(font_size * 0.15))
    th = sum(line_heights) + line_gap * (len(lines) - 1)

    pad_x, pad_y = max(6, int(24 * scale)), max(4, int(16 * scale))
    box_w = tw + pad_x * 2 + outline_w * 2
    box_h = th + pad_y * 2 + outline_w * 2
    bx = (vw - box_w) // 2 + margin_h
    by = vh - box_h - margin_v

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

    # draw each wrapped line centered inside the box
    y = by + pad_y + outline_w
    for i, ln in enumerate(lines):
        lw = line_boxes[i][2] - line_boxes[i][0]
        lx = bx + pad_x + outline_w + (tw - lw) // 2
        draw.text(
            (lx, y - line_tops[i]),
            ln,
            font=font,
            fill=text_color,
            stroke_width=outline_w,
            stroke_fill=outline_color,
        )
        y += line_heights[i] + line_gap
    return np.array(img)


def _overlay_subtitle(frame, overlay_rgba):
    import cv2
    import numpy as np

    alpha = overlay_rgba[:, :, 3:4].astype(np.float32) / 255.0
    overlay_bgr = cv2.cvtColor(overlay_rgba[:, :, :3], cv2.COLOR_RGB2BGR).astype(np.float32)
    blended = frame.astype(np.float32) * (1.0 - alpha) + overlay_bgr * alpha
    return blended.astype(np.uint8)


def _render_watermark_frame(
    vw: int,
    vh: int,
    ts: float,
    duration: float,
    watermark: dict,
):
    """Build an RGBA overlay for the watermark: logo top-left + scrolling text.

    The scrolling text travels around the clip border in a full loop from the
    start of the video until the end (one revolution per video duration).
    """
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    text = (watermark.get("text") or "").strip()
    logo_path = watermark.get("logo_path")
    if not text and not logo_path:
        return None

    img = Image.new("RGBA", (vw, vh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- Logo: top-left, height = 1/7 of frame height; margin from top & left = half logo height. ---
    if logo_path:
        try:
            logo = Image.open(logo_path).convert("RGBA")
            logo_h = max(36, int(vh / 7))
            logo_w = int(logo.width * logo_h / logo.height)
            margin = int(logo_h // 2.5)
            logo = logo.resize((logo_w, logo_h), Image.LANCZOS)
            img.paste(logo, (margin, margin), logo)
        except Exception:
            pass

    if text:
        # Font scaled by resolution (~3.2% of height); white fill, no outline.
        font_size = max(30, int(vh * 0.04))
        font_path = _find_font("Arial", False, False)
        try:
            font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]

        # One full revolution per video duration. Position advances along a
        # rectangular perimeter: top (L→R), right (T→B), bottom (R→L), left (B→T).
        gap = max(12, int(vh * 0.022))
        perim = 2 * vw + 2 * vh
        dur = duration if duration and duration > 0 else 1.0
        dist = (ts / dur) % 1.0
        total = perim + 2 * tw
        d = dist * total

        if d <= vw:
            x, y = d - tw, gap
        elif d <= vw + vh:
            t = d - vw
            x, y = vw - tw - gap, t
        elif d <= 2 * vw + vh:
            t = d - vw - vh
            x, y = vw - t, vh - th - gap
        else:
            t = d - 2 * vw - vh
            x, y = gap, vh - t

        draw.text(
            (x, y),
            text,
            font=font,
            fill=(255, 255, 255, 153),
        )

    return np.array(img)


def burn_subtitles_pillow(
    video_path_str: str,
    srt_path_str: str,
    out_path: str,
    progress_callback=None,
    audio_source: str | None = None,
    style: dict | None = None,
    fixed_size: bool = False,
    watermark: dict | None = None,
):
    """Burn subtitles using OpenCV + Pillow (no libass required)."""
    import cv2

    content = Path(srt_path_str).read_text(encoding="utf-8")
    entries = _resolve_overlaps(parse_srt(content))
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
    duration = (total / fps) if fps and total else 0.0

    tmp_path = str(Path(out_path).with_suffix(".burn.mp4"))
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(tmp_path, fourcc, fps, (vw, vh))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("Cannot open video writer")

    cache = {}
    wm_cache = {}
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        ts = idx / fps
        active = [e for e in entries if e.start <= ts < e.end]
        if active:
            # Overlapping subtitles: never concatenate. Prioritize the one that
            # started LAST (the "later" subtitle wins), so a new line taking
            # over mid-scene replaces the previous one instead of merging text.
            e = max(active, key=lambda x: (x.start, x.end))
            text = e.text
            if text not in cache:
                cache[text] = _render_subtitle(text, vw, vh, font_path, style, fixed_size)
            frame = _overlay_subtitle(frame, cache[text])
        if watermark:
            wm_key = f"{int(ts * 10)}"
            if wm_key not in wm_cache:
                wm_cache[wm_key] = _render_watermark_frame(vw, vh, ts, duration, watermark)
            wm = wm_cache[wm_key]
            if wm is not None:
                frame = _overlay_subtitle(frame, wm)
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

    def _log(message: str, level: str = "info"):
        entry = {"message": message, "ts": time.time(), "level": level}
        job.setdefault("logs", []).append(entry)
        notify_ws_sync(loop, ws_clients, job_id, {"type": "log", **entry})

    _log("Nhúng phụ đề vào video (FFmpeg)...")

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
    _log(f"Đã tạo file ASS phụ đề ({len(parse_srt(srt_content))} dòng) — chuẩn bị encode...")

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
        _log("Dùng audio đã lồng tiếng Việt (full_audio/dubbed).")

    if not _has_subtitles_filter():
        # ffmpeg lacks libass — fall back to OpenCV + Pillow burn
        logger.info("hardcode job %s: libass missing, using Pillow burn", job_id)
        _log("FFmpeg thiếu libass → dùng engine vẽ phụ đề (Pillow) từng khung hình.")

        # Watermark (logo + scrolling text) is rendered by the Pillow path.
        watermark = None
        if job.get("watermark"):
            from app.routers.config_router import get_watermark
            watermark = get_watermark(job.get("watermark_preset"))
            if watermark.get("text") or watermark.get("logo_path"):
                logger.info("hardcode job %s: watermark ON (preset=%s, %s)", job_id, watermark.get("preset_id"), "text+logo" if watermark.get("logo_path") else "text")
                _log(f"Bật watermark: {watermark.get('text') or 'logo'} (bộ: {watermark.get('preset_id') or 'default'}).")
            else:
                logger.info("hardcode job %s: watermark requested but no text/logo configured", job_id)
                watermark = None

        def progress_cb(pct: int):
            job["progress"] = pct
            notify_ws_sync(loop, ws_clients, job_id, {
                "type": "progress", "progress": pct, "phase": "hardcode",
            })

        # Pillow path: also emit a log line every 10% so the UI log feed moves.
        last_pillow_log = {"pct": 0}

        def _pillow_log_cb(pct: int):
            progress_cb(pct)
            if pct - last_pillow_log["pct"] >= 10:
                last_pillow_log["pct"] = pct
                _log(f"Đang vẽ phụ đề khung hình... {pct}%")

        burn_subtitles_pillow(
            video_path_str, srt_path_str, out_path,
            progress_callback=_pillow_log_cb,
            audio_source=str(audio_src) if use_dubbed else None,
            style=style,
            # auto-fit or manual style must render at the exact size chosen.
            fixed_size=bool(job.get("auto_fit")) or bool(job.get("style")),
            watermark=watermark,
        )
        job["progress"] = 100
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 100, "phase": "done"})
        _log("Đã vẽ phụ đề xong toàn bộ khung hình.", "success")
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
    _log("Khởi động FFmpeg encode phụ đề cứng (libass)...")

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
                    _log(f"FFmpeg đang encode phụ đề... {pct}%")
            except Exception:
                pass

    ret = proc.wait()
    if ret != 0:
        raise RuntimeError(f"FFmpeg hardcode failed with code {ret}")

    job["progress"] = 100
    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 100, "phase": "done"})
    _log("FFmpeg encode xong 100%.", "success")
    return Path(out_path)
