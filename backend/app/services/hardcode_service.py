"""Burn (hardcode) subtitles into the video using pure FFmpeg filters.

Filter chain:
  [0:v] scale → subtitles (libass) → overlay (logo) → drawtext (scrolling text) → [out]

The main burn path (run_hardcode_sync) is pure FFmpeg. The subtitle-preview
helpers (_render_subtitle / _overlay_subtitle / auto_fit_style) use Pillow +
OpenCV to render a single frame for the interactive "tự chỉnh vị trí" preview.
"""

import logging
import os
import shlex
import subprocess
import threading
import time
from pathlib import Path

from app.config import settings
from app.services.srt_utils import parse_srt
from app.services.media_utils import _get_duration, _get_video_resolution, _merge_audio_path, target_dims_min1080
from app.services.job_utils import JobCancelled, notify_ws_sync
from app.routers.config_router import get_subtitle_style

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Style helpers
# ---------------------------------------------------------------------------

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

    # _render_subtitle / srt_to_ass_blackbox scale font_size & margin_v by
    # th/1080, nên cả hai đều lưu ở chuẩn 1080p reference.
    s["font_size"] = max(18, int(font_px * 1080 / vh))
    # Đáy hộp phụ đề khớp chính xác mép dưới vùng OCR (y2). Không trừ thêm
    # hằng số -40px nữa: với video chiều cao nhỏ hệ số phóng to khiến sub
    # bị đẩy xuống lệch khỏi vùng đã chọn so với các video khác.
    s["margin_v"] = max(0, int((1 - y2) * vh * 1080 / vh))
    return s


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


_SUB_PAD_X = 24
_SUB_PAD_Y = 16
# Hiệu chỉnh dọc cho text \an5: tâm line-box libass ≠ tâm INK (do ascent/
# descender). Đơn vị = nhân với font_size. Đo bằng script calibration.
_ASS_TEXT_DY_RATIO = -0.04


def srt_to_ass_blackbox(
    srt_content: str,
    vw: int = 1920,
    vh: int = 1080,
    style: dict | None = None,
) -> str:
    """Convert SRT → ASS sao cho khung hình CHÍNH XÁC như preview Pillow.

    Mỗi entry phát 2 lớp sự kiện cùng thời điểm:
      Layer 0: nền hộp bo tròn vẽ bằng vector drawing (\\p1) — đúng
        box_color/box_opacity/box_radius/box_border như ``_render_subtitle``.
      Layer 1: text với \\pos đặt tại toạ độ pixel y hệt preview, kèm
        {\\fs<fit>} co giãn từng dòng giống logic shrink-to-fit của PIL.

    Không dùng BorderStyle=3 nữa vì libass không bo góc được, dùng nhầm
    OutlineColour làm màu nền và làm mất viền chữ khi bật nền.
    """
    from PIL import ImageFont

    s = dict(style or get_subtitle_style())
    # Chuẩn hoá về pixel thật của frame xuất (style lưu ở tham chiếu 1080p).
    font_size_ref = max(10, int(int(s.get("font_size", 48)) * vh / 1080))
    margin_v = max(0, int(int(s.get("margin_v", 40)) * vh / 1080))
    margin_h = int(int(s.get("margin_h", 0)) * vw / 1920)
    outline_w = max(0, int(s.get("outline_width", 0)))
    box_on = bool(s.get("box_enabled", True))
    box_radius = max(0, int(s.get("box_radius", 12)))
    box_border_w = max(0, int(s.get("box_border_width", 0)))
    pad_x, pad_y = _SUB_PAD_X, _SUB_PAD_Y

    font_path = _find_font(
        s.get("font_family", "Arial"), s.get("bold"), s.get("italic")
    )
    font_cache: dict[int, object] = {}

    def _font(size: int):
        if size not in font_cache:
            try:
                font_cache[size] = (
                    ImageFont.truetype(font_path, size)
                    if font_path and size >= 8
                    else ImageFont.load_default()
                )
            except OSError:
                font_cache[size] = ImageFont.load_default()
        return font_cache[size]

    def _hex_rgba(hex_color: str, alpha255: int) -> str:
        """&HAABBGGRR cho override tag \\1c\\alpha (ASS dùng BGR)."""
        h = (hex_color or "#FFFFFF").lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r, gg, b = h[0:2], h[2:4], h[4:6]
        a = max(0, min(255, alpha255))
        return f"&H{a:02X}{b}{gg}{r}".upper()

    outline_col = _hex_rgba(s.get("outline_color", "#000000"), 0)
    box_fill_alpha = 255 - max(0, min(255, int(s.get("box_opacity", 210))))
    box_col = _hex_rgba(s.get("box_color", "#000000"), box_fill_alpha)
    border_col = _hex_rgba(s.get("box_border_color", "#000000"), 0)

    header = f"""[Script Info]
Title: SubTitle Pixel-Matched
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: {vw}
PlayResY: {vh}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: SubStyle,{s.get('font_family', 'Arial')},{font_size_ref},{_hex_to_ass_color(s.get('text_color', '#FFFFFF'))},&H000000FF,{outline_col},{_hex_to_ass_color('#000000')},{1 if s.get('bold') else 0},{1 if s.get('italic') else 0},0,0,100,100,0,0,1,{outline_w},0,7,0,0,0,1
Style: BoxStyle,Arial,{font_size_ref},{box_col},&H000000FF,{box_col},&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: BoxBorder,Arial,{font_size_ref},{border_col},&H000000FF,{border_col},&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
"""

    events: list[str] = []
    for e in _resolve_overlaps(parse_srt(srt_content)):
        raw_text = " ".join((e.text or "").split())
        if not raw_text:
            continue
        t0, t1 = _ass_time(e.start), _ass_time(e.end)

        # ── Shrink-to-fit ĐO THẬT bằng font thật, y hệt _render_subtitle ──
        fs = font_size_ref
        max_w = max(200, vw - 160)
        bbox = _font(fs).getbbox(raw_text)
        while fs > 16 and (bbox[2] - bbox[0]) > max_w:
            fs -= 2
            bbox = _font(fs).getbbox(raw_text)
        tw_px, th_px = bbox[2] - bbox[0], bbox[3] - bbox[1]

        box_w = tw_px + pad_x * 2 + outline_w * 2
        box_h = th_px + pad_y * 2 + outline_w * 2
        bx = (vw - box_w) // 2 + margin_h
        by = vh - box_h - margin_v

        esc = raw_text.replace("{", "\\{").replace("}", "\\}")

        # Layer 0 — viền hộp (rect to hơn nằm sau) rồi nền hộp bo tròn
        if box_on:
            if box_border_w > 0:
                path_b = _ass_rounded_rect_path(
                    box_w + box_border_w * 2,
                    box_h + box_border_w * 2,
                    min(box_radius + box_border_w, (box_h + box_border_w) // 2),
                )
                events.append(
                    f"Dialogue: 0,{t0},{t1},BoxBorder,,0,0,0,,"
                    f"{{\\an7\\pos({bx - box_border_w},{by - box_border_w})\\p1}}"
                    f"{path_b}{{\\p0}}"
                )
            r = min(box_radius, box_h // 2, box_w // 2)
            path = _ass_rounded_rect_path(box_w, box_h, r)
            events.append(
                f"Dialogue: 1,{t0},{t1},BoxStyle,,0,0,0,,"
                f"{{\\an7\\pos({bx},{by})\\p1}}{path}{{\\p0}}"
            )

        # Layer 2 — text căn TÂM hộp bằng \an5: libass tự căn giữa theo số đo
        # font của nó nên không bao giờ lệch trái/phải (neo cạnh tay trước đây
        # lệch vì libass đo width khác PIL). dy hiệu chỉnh tỉ lệ fs để tâm INK
        # trùng tâm hộp (chữ có dấu/đuôi descender làm line-box lệch tâm).
        box_cx = bx + box_w // 2
        box_cy = by + box_h // 2 + round(_ASS_TEXT_DY_RATIO * fs)
        events.append(
            f"Dialogue: 2,{t0},{t1},SubStyle,,0,0,0,,"
            f"{{\\an5\\pos({box_cx},{box_cy})\\fs{fs}}}"
            f"{esc}"
        )

    return header + "\n".join(["[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"] + events) + "\n"


def _ass_rounded_rect_path(w: int, h: int, r: int) -> str:
    """ASS drawing path: hình chữ nhật bo tròn w×h bán kính r, gốc (0,0).

    Vẽ theo chiều kim đồng hồ bằng 'm' + 'l' + 'b' (bezier cung tròn 90°,
    hệ số ~0.5523 chuẩn cho arc xấp xỉ đường tròn).
    """
    if r <= 0:
        return f"m 0 0 l {w} 0 {w} {h} 0 {h}"
    k = 0.5523
    kr = r * k
    return (
        f"m {r} 0 "
        f"l {w - r} 0 b {int(w - r + kr)} 0 {w} {int(kr)} {w} {r} "
        f"l {w} {h - r} b {w} {int(h - r + kr)} {int(w - r + kr)} {h} {w - r} {h} "
        f"l {r} {h} b {int(r - kr)} {h} 0 {int(h - r + kr)} 0 {h - r} "
        f"l 0 {r} b 0 {int(r - kr)} {int(r - kr)} 0 {r} 0"
    )


def _resolve_overlaps(entries):
    """Clip overlapping subtitle entries so they never stack or concatenate.

    When two entries overlap in time, the LATER one wins the overlap region:
    the earlier entry is trimmed to end exactly when the later one starts.
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


def _has_drawtext_filter() -> bool:
    """Check whether ffmpeg was built with freetype (drawtext filter).

    Một số bản ffmpeg (build thiếu freetype) không có drawtext — khi đó
    watermark dạng chữ chạy phải bị bỏ qua thay vì làm chết cả job hardcode.
    """
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-filters"],
            capture_output=True, text=True, timeout=15,
        )
        # Match theo cột filter name để tránh nhầm với filter khác chứa chữ
        # "drawtext" trong phần mô tả.
        import re
        return bool(re.search(r"^\s*\S+\s+drawtext\s", out.stdout or "", re.M))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Font finder (macOS)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# FFmpeg text escaping helpers
# ---------------------------------------------------------------------------

def _escape_drawtext(text: str) -> str:
    """Escape special characters for FFmpeg drawtext filter option values.

    FFmpeg filter option parsing treats ``:`` as a key/value separator and
    ``\\`` as an escape character, so both must be escaped with ``\\``.
    """
    return text.replace("\\", "\\\\").replace(":", "\\:")


def _escape_fontfile(path: str) -> str:
    """Escape a font file path for drawtext's ``fontfile`` option value."""
    return path.replace("\\", "\\\\").replace(":", "\\:")


def _atempo_chain(speed: float) -> str:
    """Build atempo filter chain for arbitrary speed (0.5-3.0).

    FFmpeg atempo only supports 0.5-2.0 per filter, so chain multiple.
    """
    if abs(speed - 1.0) < 0.01:
        return ""
    # Decompose speed into factors within [0.5, 2.0]
    factors: list[str] = []
    s = float(speed)
    # Handle >2.0 by splitting
    while s > 2.0 + 1e-6:
        factors.append("atempo=2.0")
        s /= 2.0
    while s < 0.5 - 1e-6:
        factors.append("atempo=0.5")
        s /= 0.5
    factors.append(f"atempo={s:.4f}")
    return ",".join(factors)


def _scale_srt_speed(srt_content: str, speed: float) -> str:
    """Scale SRT timestamps by 1/speed (faster video → earlier subs)."""
    if abs(speed - 1.0) < 0.01:
        return srt_content
    from app.services.srt_utils import parse_srt, entries_to_srt, _fmt

    entries = parse_srt(srt_content)
    if not entries:
        return srt_content
    scaled = []
    for e in entries:
        ns = e.start / speed
        ne = e.end / speed
        # Ensure non-negative and end > start
        if ne <= ns:
            ne = ns + 0.1
        scaled.append(e.model_copy(update={"start": ns, "end": ne, "startLabel": _fmt(ns), "endLabel": _fmt(ne)}))
    return entries_to_srt(scaled)


# ---------------------------------------------------------------------------
# Subtitle preview render helpers (Pillow + OpenCV)
# ---------------------------------------------------------------------------

def _render_subtitle(
    text: str,
    vw: int,
    vh: int,
    font_path: str | None,
    style: dict | None = None,
    fixed_size: bool = False,
):
    """Render `text` as an RGBA overlay (numpy array) sized to the frame."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    s = style or get_subtitle_style()
    # font_size là tham chiếu 1080p → scale theo chiều cao thực tế.
    font_size = max(10, int(int(s.get("font_size", 48)) * vh / 1080))
    font_path = font_path or _find_font(
        s.get("font_family", "Arial"), s.get("bold"), s.get("italic")
    )
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
    # margin_v / margin_h đều là tham chiếu 1080p/1920p → scale theo khung hình.
    margin_v = max(0, int(int(s.get("margin_v", 40)) * vh / 1080))
    margin_h = int(int(s.get("margin_h", 0)) * vw / 1920)

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

    pad_x, pad_y = _SUB_PAD_X, _SUB_PAD_Y
    box_w = tw + pad_x * 2 + outline_w * 2
    box_h = th + pad_y * 2 + outline_w * 2
    bx = (vw - box_w) // 2 + margin_h
    # Anchor GIỐNG hệ libass ở bước hardcode: đáy box cách mép dưới đúng
    # margin_v (ASS Alignment=2 MarginV). Trước đây trừ thêm 40px làm vị trí
    # preview lệch hẳn so với video cuối (sub cuối cùng cao hơn chỗ đã kéo).
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


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_hardcode_sync(
    video_path_str: str,
    srt_path_str: str,
    out_path: str,
    job: dict,
    ws_clients: dict,
    loop,
    job_id: str,
):
    """Burn subtitles into the video using pure FFmpeg filters.

    Builds a single FFmpeg command that chains:
      scale → subtitles (libass) → overlay (logo) → drawtext (scrolling text)
    and uses ``-progress pipe:1`` for smooth WebSocket progress updates.

    Falls back to ``libx264`` when ``h264_videotoolbox`` is unavailable.
    """
    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "hardcode"})

    def _log(message: str, level: str = "info"):
        entry = {"message": message, "ts": time.time(), "level": level}
        job.setdefault("logs", []).append(entry)
        notify_ws_sync(loop, ws_clients, job_id, {"type": "log", **entry})

    _log("Nhúng phụ đề vào video (FFmpeg)...")

    total_dur = _get_duration(video_path_str)
    vw, vh = _get_video_resolution(video_path_str)
    tw, th = target_dims_min1080(vw, vh)
    if (tw, th) != (vw, vh):
        _log(f"Nâng độ phân giải xuất: {vw}x{vh} → {tw}x{th} (tối thiểu 1080p).")

    # ── Playback speed ─────────────────────────────────────────────────────
    try:
        playback_speed = float(job.get("playback_speed", 1.0) or 1.0)
    except Exception:
        playback_speed = 1.0
    if playback_speed < 0.5:
        playback_speed = 0.5
    if playback_speed > 3.0:
        playback_speed = 3.0
    if abs(playback_speed - 1.0) >= 0.01:
        _log(f"Tốc độ video: {playback_speed:.2f}x — sẽ scale video/audio/subtitle khi encode.")
        logger.info("hardcode job %s: playback_speed=%s", job_id, playback_speed)
    # Scaled duration for progress tracking
    scaled_dur = total_dur / playback_speed if playback_speed and playback_speed > 0 else total_dur

    # ── ASS subtitle file ──────────────────────────────────────────────────
    srt_content = Path(srt_path_str).read_text(encoding="utf-8")
    # Scale subtitle timestamps if speed != 1.0
    if abs(playback_speed - 1.0) >= 0.01:
        srt_content = _scale_srt_speed(srt_content, playback_speed)
        _log(f"Đã scale {len(parse_srt(srt_content))} dòng phụ đề theo tốc độ {playback_speed:.2f}x.")
    style = get_subtitle_style()
    if job.get("auto_fit") and job.get("region"):
        style = auto_fit_style(style, job["region"], vh, vw, srt_content)
        logger.info(
            "hardcode job %s: auto_fit → font_size=%s margin_v=%s",
            job_id, style.get("font_size"), style.get("margin_v"),
        )
    if job.get("style"):
        style = apply_style_override(style, job["style"])
        logger.info(
            "hardcode job %s: manual style → font_size=%s margin_v=%s",
            job_id, style.get("font_size"), style.get("margin_v"),
        )
    # ASS PlayRes = target dims so libass renders text crisply at the final size.
    ass_content = srt_to_ass_blackbox(srt_content, tw, th, style)
    ass_path = Path(out_path).with_suffix(".ass")
    ass_path.write_text(ass_content, encoding="utf-8")
    _log(f"Đã tạo file ASS phụ đề ({len(parse_srt(srt_content))} dòng) — chuẩn bị encode...")

    # FFmpeg subtitles filter: run from the ASS file's directory so a plain
    # filename (no special chars) can be passed — avoids escaping issues.
    ass_dir = str(ass_path.parent)
    ass_filename = ass_path.name

    # ── Audio source ───────────────────────────────────────────────────────
    video_id = Path(video_path_str).parent.name
    full_audio_path = settings.temp_dir / "tts" / video_id / "full_audio.m4a"

    def _valid_audio(p: Path) -> bool:
        return p.exists() and p.stat().st_size > 0 and _get_duration(str(p)) > 0

    audio_src: Path | None = None
    if _valid_audio(full_audio_path):
        audio_src = full_audio_path
        logger.info("hardcode job %s: using dubbed audio (%s)", job_id, audio_src.name)
        _log("Dùng audio đã lồng tiếng Việt (full_audio/dubbed).")
    else:
        if full_audio_path.exists():
            logger.warning(
                "hardcode job %s: dubbed audio invalid/corrupt, falling back", job_id,
            )
            _log("Audio lồng tiếng bị lỗi — tìm audio gốc thay thế.", "warning")
        # Video Douyin (đã merge) là video-only → fallback về audio gốc tải trong
        # bước merge (merged/{merge_id}_audio.mp4) để không mất tiếng.
        merge_audio = _merge_audio_path(video_id)
        if merge_audio and _valid_audio(merge_audio):
            audio_src = merge_audio
            logger.info("hardcode job %s: using original merged audio (%s)", job_id, audio_src.name)
            _log("Không có audio lồng tiếng — dùng audio gốc của video.")
        else:
            logger.warning("hardcode job %s: no dubbed/merged audio → video's own audio", job_id)
            _log(
                "Không tìm thấy audio lồng tiếng/audio gốc (chạy bước Lồng tiếng trước) "
                "— dùng audio của chính video.",
                "warning",
            )
    use_external_audio = audio_src is not None

    # ── Watermark (logo + scrolling text) ──────────────────────────────────
    has_libass = _has_subtitles_filter()
    watermark = None
    if job.get("watermark"):
        from app.routers.config_router import get_watermark

        watermark = get_watermark(job.get("watermark_preset"))
        if watermark.get("text") or watermark.get("logo_path"):
            logger.info(
                "hardcode job %s: watermark ON (preset=%s, %s)",
                job_id,
                watermark.get("preset_id"),
                "text+logo" if watermark.get("logo_path") else "text",
            )
            _log(
                f"Bật watermark: {watermark.get('text') or 'logo'} "
                f"(bộ: {watermark.get('preset_id') or 'default'})."
            )
        else:
            logger.info("hardcode job %s: watermark requested but no text/logo configured", job_id)
            watermark = None

    # ── Build FFmpeg filter chain ──────────────────────────────────────────
    if not has_libass:
        logger.warning("hardcode job %s: ffmpeg lacks 'subtitles' filter — subs NOT burned", job_id)
        _log(
            "⚠ FFmpeg thiếu filter 'subtitles' (libass) — phụ đề sẽ KHÔNG được nhúng "
            "vào video. Cài lại ffmpeg đầy đủ: brew reinstall ffmpeg",
            "warning",
        )
    has_logo = bool(watermark and watermark.get("logo_path"))
    has_scroll = bool(watermark and watermark.get("text"))
    if has_scroll and not _has_drawtext_filter():
        logger.warning(
            "hardcode job %s: ffmpeg lacks 'drawtext' filter — skipping scrolling text", job_id,
        )
        _log(
            "⚠ FFmpeg thiếu filter 'drawtext' (freetype) — bỏ qua chữ chạy watermark "
            "(logo vẫn giữ nguyên). Cài lại ffmpeg đầy đủ: brew reinstall ffmpeg",
            "warning",
        )
        has_scroll = False
    use_complex = has_logo or has_scroll

    # Escape the ASS filename for the subtitles filter.
    ass_fn_esc = ass_filename.replace("\\", "\\\\").replace(":", "\\:")

    if use_complex:
        # ── Complex filter graph: scale → setpts → subtitles → overlay → drawtext ──
        fc_parts: list[str] = []
        last_out = "0:v"

        # Scale
        fc_parts.append(f"[{last_out}]scale={tw}:{th}:flags=lanczos[scaled]")
        last_out = "scaled"

        # Playback speed (video)
        if abs(playback_speed - 1.0) >= 0.01:
            fc_parts.append(f"[{last_out}]setpts=PTS/{playback_speed}[spd]")
            last_out = "spd"

        # Subtitles (libass)
        if has_libass:
            fc_parts.append(f"[{last_out}]subtitles={ass_fn_esc}[sub]")
            last_out = "sub"

        # Logo overlay
        if has_logo:
            logo_path = watermark["logo_path"]
            logo_h = max(36, th // 7)
            logo_margin = int(logo_h // 2.5)
            fc_parts.append(
                f"movie={_escape_fontfile(logo_path)},scale=-1:{logo_h}[logo]"
            )
            fc_parts.append(
                f"[{last_out}][logo]overlay={logo_margin}:{logo_margin}[vlogo]"
            )
            last_out = "vlogo"

        # Scrolling text drawtext
        if has_scroll:
            font_path = _find_font(
                (style or get_subtitle_style()).get("font_family", "Arial"),
                (style or get_subtitle_style()).get("bold"),
                (style or get_subtitle_style()).get("italic"),
            )
            font_size = max(30, int(th * 0.04))
            gap = max(12, int(th * 0.022))
            dur = (scaled_dur if scaled_dur and scaled_dur > 0 else total_dur) if total_dur and total_dur > 0 else 1.0
            text_raw = watermark.get("text", "")

            # FFmpeg drawtext expression cho chữ chạy vòng quanh viền video.
            # ``mod(t/{dur},1)`` chu kỳ [0,1) mỗi vòng; quãng đường 1 vòng:
            #   L = 2*w + 2*h + 2*text_w  (w/h = kích thước frame sau scale)
            # D = tiến độ * L. 4 đoạn liên tiếp (TW=text_w, TH=text_h, g=gap):
            #   1. TRÊN  (L→R): D ≤ w       → x = D-TW,           y = g
            #   2. PHẢI  (T→B): D ≤ w+h     → x = w-TW-g,         y = D-w
            #   3. DƯỚI  (R→L): D ≤ 2w+h    → x = w-TW-g-(D-w-h), y = h-TH-g
            #   4. TRÁI  (B→T): còn lại     → x = g,              y = h-TH-g-(D-2w-h)
            # Toán tử so sánh dùng w/h runtime của drawtext (= tw/th sau scale).
            esc_text = _escape_drawtext(text_raw)
            W, H, g = tw, th, gap
            # Quãng đường mỗi cạnh tính theo kích thước TEXT thật để không bao
            # giờ tràn ra ngoài / nhảy cóc tại góc:
            #   trên:  x chạy -TW → w-TW           (dài w)
            #   phải:  y chạy g → h-TH-g           (dài h-TH-2g)
            #   dưới:  x chạy w-TW-g → g           (dài w-TW-2g)
            #   trái:  y chạy h-TH-g → -TH         (dài h-g: trôi hẳn khỏi
            #     mép trên rồi mới vòng lại → điểm wrap nằm ngoài màn hình)
            d_expr = (
                f"mod(t/{dur},1)*("
                f"{W}+({H}-text_h-2*{g})+({W}-text_w-2*{g})+({H}-{g}))"
            )
            b1 = f"{W}"
            b2 = f"({W}+({H}-text_h-2*{g}))"
            b3 = f"({W}+({H}-text_h-2*{g})+({W}-text_w-2*{g}))"
            x_expr = (
                f"if(lte({d_expr},{b1}),{d_expr}-text_w,"
                f"if(lte({d_expr},{b2}),{W}-text_w-{g},"
                f"if(lte({d_expr},{b3}),{W}-text_w-{g}-({d_expr}-{b2}),{g})))"
            )
            y_expr = (
                f"if(lte({d_expr},{b1}),{g},"
                f"if(lte({d_expr},{b2}),{g}+({d_expr}-{b1}),"
                f"if(lte({d_expr},{b3}),{H}-text_h-{g},{H}-text_h-{g}-({d_expr}-{b3}))))"
            )
            fc_parts.append(
                f"[{last_out}]drawtext="
                f"fontfile={_escape_fontfile(font_path)}:"
                f"fontsize={font_size}:"
                f"fontcolor=white@0.6:"
                f"text={esc_text}:"
                f"x='{x_expr}':"
                f"y='{y_expr}'"
                f"[vout]"
            )
            last_out = "vout"

        filter_complex = ";".join(fc_parts)
    else:
        # ── Simple chain: just scale + setpts + subtitles via -vf ───────────
        vf_parts = [f"scale={tw}:{th}:flags=lanczos"]
        if abs(playback_speed - 1.0) >= 0.01:
            vf_parts.append(f"setpts=PTS/{playback_speed}")
        if has_libass:
            vf_parts.append(f"subtitles={ass_fn_esc}")

    # ── Encoder selection ──────────────────────────────────────────────────
    def _has_videotoolbox() -> bool:
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-encoders"],
                capture_output=True, text=True, timeout=10,
            )
            return "h264_videotoolbox" in (out.stdout or "")
        except Exception:
            return False

    use_vtb = _has_videotoolbox()
    if use_vtb:
        v_enc = ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "8M"]
    else:
        v_enc = ["-c:v", "libx264", "-crf", "18", "-preset", "medium"]

    # ── Assemble the full FFmpeg command ───────────────────────────────────
    # Input layout: [0]=video, [1]=audio (nếu có nguồn audio riêng), [last]=logo
    cmd = ["ffmpeg", "-y", "-loglevel", "warning"]
    cmd += ["-i", video_path_str]

    audio_idx = 0  # input index for the audio stream
    if use_external_audio:
        cmd += ["-i", str(audio_src)]
        audio_idx = 1

    logo_idx = -1
    if has_logo:
        cmd += ["-i", watermark["logo_path"]]
        logo_idx = audio_idx + 1

    # Video filters
    if use_complex:
        cmd += ["-filter_complex", filter_complex]
        cmd += ["-map", f"[{last_out}]"]
    else:
        cmd += ["-vf", ",".join(vf_parts)]
        # Map video (qua -vf) rõ ràng. ffmpeg TẮT tự động chọn stream ngay khi
        # có bất kỳ -map nào → nếu chỉ map audio, video sẽ bị drop và file đầu
        # ra chỉ có tiếng không có hình.
        cmd += ["-map", "0:v"]

    # Audio mapping + speed (atempo)
    if use_external_audio:
        cmd += ["-map", f"{audio_idx}:a"]
    else:
        cmd += ["-map", "0:a?"]

    # Audio speed: atempo chain (0.5-2.0 per filter, chain if needed)
    if abs(playback_speed - 1.0) >= 0.01:
        atempo = _atempo_chain(playback_speed)
        if atempo:
            cmd += ["-filter:a", atempo]

    cmd += v_enc
    cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", "-shortest"]
    cmd += ["-progress", "pipe:1", "-stats_period", "0.5"]
    cmd += [out_path]

    logger.info("hardcode job %s: %s", job_id, " ".join(shlex.quote(str(p)) for p in cmd))
    _log("Khởi động FFmpeg encode phụ đề cứng...")

    # ── Run FFmpeg with progress tracking ──────────────────────────────────
    proc = subprocess.Popen(
        cmd,
        cwd=ass_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    last_progress = 0

    def _progress_watcher():
        """Read FFmpeg ``-progress`` output on stdout and push WebSocket updates."""
        nonlocal last_progress
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if job.get("cancelled"):
                proc.terminate()
                return
            if line.startswith("out_time_us="):
                try:
                    us = int(line.split("=", 1)[1])
                    secs = us / 1_000_000
                    ref_dur = scaled_dur if abs(playback_speed - 1.0) >= 0.01 else total_dur
                    if ref_dur and ref_dur > 0:
                        pct = min(99, int(secs / ref_dur * 100))
                        if pct >= last_progress + 10:
                            last_progress = pct
                            job["progress"] = pct
                            notify_ws_sync(loop, ws_clients, job_id, {
                                "type": "progress", "progress": pct, "phase": "hardcode",
                            })
                            _log(f"FFmpeg đang encode phụ đề... {pct}%")
                except (ValueError, ZeroDivisionError):
                    pass
            elif line.startswith("out_time="):
                # Fallback: parse HH:MM:SS.ss format
                try:
                    ts = line.split("=", 1)[1]
                    h, m, s = ts.split(":")
                    secs = int(h) * 3600 + int(m) * 60 + float(s)
                    ref_dur = scaled_dur if abs(playback_speed - 1.0) >= 0.01 else total_dur
                    if ref_dur and ref_dur > 0:
                        pct = min(99, int(secs / ref_dur * 100))
                        if pct >= last_progress + 10:
                            last_progress = pct
                            job["progress"] = pct
                            notify_ws_sync(loop, ws_clients, job_id, {
                                "type": "progress", "progress": pct, "phase": "hardcode",
                            })
                            _log(f"FFmpeg đang encode phụ đề... {pct}%")
                except (ValueError, ZeroDivisionError):
                    pass

    progress_thread = threading.Thread(target=_progress_watcher, daemon=True)
    progress_thread.start()

    # Read stderr in a separate thread so the pipe buffer doesn't block FFmpeg.
    stderr_lines: list[str] = []

    def _read_stderr():
        assert proc.stderr is not None
        for raw_line in proc.stderr:
            stderr_lines.append(raw_line.decode("utf-8", errors="replace"))

    stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
    stderr_thread.start()

    # Wait for completion, checking for cancellation periodically.
    while proc.poll() is None:
        if job.get("cancelled"):
            proc.terminate()
            proc.wait()
            raise JobCancelled()
        time.sleep(0.5)

    progress_thread.join(timeout=5)
    stderr_thread.join(timeout=5)

    ret = proc.returncode
    if ret != 0:
        err = "".join(stderr_lines)[:1000]
        raise RuntimeError(f"FFmpeg hardcode failed with code {ret}: {err}")

    job["progress"] = 100
    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 100, "phase": "done"})
    _log("FFmpeg encode xong 100%.", "success")
    return Path(out_path)
