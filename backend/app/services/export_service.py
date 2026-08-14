import logging
import subprocess
from pathlib import Path
from typing import List, Dict, Any

from app.config import settings
from app.services.media_utils import _srt_path, _video_path
from app.services.srt_utils import parse_srt

logger = logging.getLogger(__name__)


def _build_ass_header(vw: int = 1920, vh: int = 1080) -> str:
    return f"""[Script Info]
Title: SubtitleExtractor Export
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: {vw}
PlayResY: {vh}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _rgb_to_ass_bgr(hex_color: str) -> str:
    r = hex_color[1:3]
    g = hex_color[3:5]
    b = hex_color[5:7]
    return f"&H00{b}{g}{r}"


def _sec_to_ass_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    cs = int((sec - int(sec)) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _alignment_from_xy(x_pct: float, y_pct: float) -> int:
    """Convert x/y percentages to ASS alignment (1-9)."""
    if y_pct < 33:
        row = 0  # top
    elif y_pct < 66:
        row = 1  # middle
    else:
        row = 2  # bottom

    if x_pct < 33:
        col = 0  # left
    elif x_pct < 66:
        col = 1  # center
    else:
        col = 2  # right

    return col * 3 + row + 1


def _get_video_resolution(video_path: Path) -> tuple[int, int]:
    """Get video width and height using ffprobe."""
    import json
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", "-select_streams", "v:0", str(video_path)],
            capture_output=True, text=True, timeout=10,
        )
        info = json.loads(result.stdout)
        stream = info["streams"][0]
        return int(stream["width"]), int(stream["height"])
    except Exception:
        return 1920, 1080


def generate_ass(video_id: str, tracks: List[Dict[str, Any]]) -> Path:
    """Generate ASS subtitle file from project tracks with full styling."""
    out_dir = settings.temp_dir / "export" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    video_path = _video_path(video_id)
    vw, vh = _get_video_resolution(video_path)

    ass_lines = _build_ass_header(vw, vh).split("\n")

    for track in tracks:
        for entry in track.get("entries", []):
            style = entry.get("style") or {}
            start = entry.get("start", 0)
            end_val = entry.get("end", 0)
            text = entry.get("text", "")

            if not text:
                continue

            # Convert pixel x/y → percentages for ASS alignment
            px = style.get("x", vw // 2)
            py = style.get("y", int(vh * 0.93))
            x_pct = (px / vw) * 100 if vw else 50
            y_pct = (py / vh) * 100 if vh else 90
            font_name = style.get("fontFamily", "Arial")
            font_size = int(style.get("fontSize", 16) * 3)
            text_color = _rgb_to_ass_bgr(style.get("textColor", "#FFFFFF"))
            bold = -1 if style.get("bold") else 0
            italic = -1 if style.get("italic") else 0
            alignment = _alignment_from_xy(x_pct, y_pct)
            margin_v = max(10, int(100 - y_pct))

            # Build per-entry style line
            style_name = f"Entry_{entry.get('index', 0)}"
            style_line = (
                f"Style: {style_name},{font_name},{font_size},{text_color},"
                f"&H000000FF,&H00000000,&H80000000,{bold},{italic},0,0,100,100,0,0,"
                f"1,2,2,{alignment},10,10,{margin_v},1"
            )
            ass_lines.append(style_line)

            start_ts = _sec_to_ass_time(start)
            end_ts = _sec_to_ass_time(end_val)
            text_escaped = text.replace("\n", "\\N")
            event = (
                f"Dialogue: 0,{start_ts},{end_ts},{style_name},,0,0,0,,{text_escaped}"
            )
            ass_lines.append(event)

    # Rebuild file with proper ordering
    header_end = ass_lines.index([l for l in ass_lines if l.startswith("[Events]")][0]) + 2
    header = ass_lines[:header_end]
    styles = [l for l in ass_lines if l.startswith("Style: ")]
    events = [l for l in ass_lines if l.startswith("Dialogue: ")]
    # Remove duplicated default style
    unique_styles = []
    seen = set()
    for s in styles:
        name = s.split(",")[0].split(": ", 1)[1]
        if name not in seen:
            seen.add(name)
            unique_styles.append(s)

    final = header[:-2] + unique_styles + [""] + events

    ass_path = out_dir / "subtitles.ass"
    ass_path.write_text("\n".join(final), encoding="utf-8")
    logger.info("Generated ASS: %d styles, %d events → %s", len(unique_styles), len(events), ass_path)
    return ass_path


def build_ffmpeg_export_cmd(
    video_path: Path,
    ass_path: Path,
    tts_audio_files: List[Path],
    tts_entries: List[Dict[str, Any]],
    out_path: Path,
) -> List[str]:
    """Build FFmpeg command to burn subtitles and mix TTS audio."""
    cmd = ["ffmpeg", "-y", "-i", str(video_path)]

    # Add TTS audio inputs
    for af in tts_audio_files:
        if af and af.exists():
            cmd.extend(["-i", str(af)])

    # Build complex filter
    filter_parts = [f"[0:v]subtitles='{ass_path}':force_style='Fontsize=48'[vout]"]

    # Audio filters: mix original (30%) + TTS clips (100%) at correct timestamps
    audio_mix_parts = []

    # Original audio at 30%
    filter_parts.append("[0:a]volume=0.3[a_orig]")
    audio_mix_parts.append("[a_orig]")

    # TTS clips with delays
    for i, (af, entry) in enumerate(zip(tts_audio_files, tts_entries)):
        if not af or not af.exists():
            continue
        delay_ms = int(entry.get("start", 0) * 1000)
        filter_parts.append(f"[{i+1}:a]adelay={delay_ms}|{delay_ms},volume=1.0[a_tts{i}]")
        audio_mix_parts.append(f"[a_tts{i}]")

    if len(audio_mix_parts) > 1:
        mix_inputs = "".join(audio_mix_parts)
        filter_parts.append(
            f"{mix_inputs}amix=inputs={len(audio_mix_parts)}:duration=first:dropout_transition=0,volume=1.5[aout]"
        )
    else:
        filter_parts.append("[0:a]volume=1.0[aout]")

    filter_complex = ";".join(filter_parts)

    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "[vout]",
        "-map", "[aout]",
        "-c:v", "libx264", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "256k",
        "-movflags", "+faststart",
        str(out_path),
    ])
    return cmd


def run_export(
    video_id: str,
    tracks: List[Dict[str, Any]],
    tts_clips: List[Dict[str, Any]],
    progress_callback=None,
) -> Path:
    """Export final video with all subtitles burned and TTS mixed."""
    video_path = _video_path(video_id)
    out_dir = settings.temp_dir / "export" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # Generate ASS file from project tracks
    ass_path = generate_ass(video_id, tracks)

    # Find TTS audio files
    tts_files: List[Path] = []
    for clip in tts_clips:
        if not clip.get("url"):
            continue
        # Extract path from URL: /api/tts-audio/{video_id}/{rest}
        parts = clip["url"].split("/api/tts-audio/")[1]
        file_path = settings.temp_dir / "tts" / video_id / parts.split("/", 2)[-1] if "/" in parts.split("/", 2)[-1] else settings.temp_dir / "tts" / video_id / parts
        if file_path.exists():
            tts_files.append(file_path)

    out_path = out_dir / "exported.mp4"

    if progress_callback:
        progress_callback(30, "Building FFmpeg command...")

    cmd = build_ffmpeg_export_cmd(video_path, ass_path, tts_files, tts_clips, out_path)
    logger.info("Export FFmpeg: %s", " ".join(cmd[:8]))

    if progress_callback:
        progress_callback(40, "Encoding video...")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    # Parse FFmpeg stderr for progress
    duration = None
    try:
        dur_proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
            capture_output=True, text=True, timeout=10,
        )
        duration = float(dur_proc.stdout.strip()) if dur_proc.stdout.strip() else None
    except Exception:
        pass

    for line in proc.stderr:
        if "time=" in line and duration:
            try:
                time_str = line.split("time=")[1].split()[0]
                h, m, s = time_str.split(":")
                secs = float(h) * 3600 + float(m) * 60 + float(s)
                pct = min(99, int(secs / duration * 60) + 40)
                if progress_callback:
                    progress_callback(pct, "")
            except Exception:
                pass

    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg export failed with code {proc.returncode}")

    if progress_callback:
        progress_callback(100, "Complete")

    logger.info("Export complete: %s", out_path)
    return out_path
