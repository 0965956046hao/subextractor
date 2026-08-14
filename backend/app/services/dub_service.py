"""Vocal separation (Demucs) + Vietnamese dubbing (instrumental + Google TTS)."""

import logging
import subprocess
from pathlib import Path
from typing import List

from app.config import settings
from app.services.srt_utils import parse_srt
from app.services.media_utils import _srt_path, _video_path, _get_audio_duration
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.tts_service import synthesize_srt

logger = logging.getLogger(__name__)


def extract_audio(video_path: Path, out_dir: Path) -> Path:
    """Extract mono audio from the video to a wav file."""
    wav_path = out_dir / "audio.wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(video_path),
            "-vn", "-ac", "1", "-ar", "44100", str(wav_path),
        ],
        check=True, capture_output=True, timeout=300,
    )
    return wav_path


def separate_instrumental(video_path: Path, out_dir: Path) -> Path:
    """Extract audio and run Demucs to keep the instrumental (no_vocals)."""
    import shutil

    if shutil.which("demucs") is None:
        raise RuntimeError(
            "demucs chưa cài đặt. Chạy: pip install demucs"
        )

    wav_path = extract_audio(video_path, out_dir)

    sep_root = out_dir / "separated"
    sep_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["demucs", "--two-stems=vocals", "-o", str(sep_root), str(wav_path)],
        check=True, capture_output=True, timeout=3600,
    )

    no_vocals = sep_root / "htdemucs" / "audio" / "no_vocals.wav"
    if not no_vocals.exists():
        raise RuntimeError("Demucs không tạo được file instrumental (no_vocals.wav)")
    return no_vocals


def combine_tts_mp3(
    audio_files: List[Path],
    entries,
    out_path: Path,
) -> Path:
    """Gộp các file mp3 TTS thành 1 file full voice mp3 (đặt theo timestamp SRT)."""
    cmd = ["ffmpeg", "-y"]

    tts_inputs = []  # (input_idx, delay_ms, tempo_chain)
    next_idx = 0
    for i, entry in enumerate(entries):
        if i >= len(audio_files):
            break
        af = audio_files[i]
        if not af or not af.exists() or af.stat().st_size == 0:
            continue
        cmd.extend(["-i", str(af)])

        srt_dur = entry.end - entry.start
        mp3_dur = _get_audio_duration(af)
        tempo = ""
        if srt_dur > 0 and mp3_dur > srt_dur * 1.02:
            speed = mp3_dur / srt_dur
            chain = []
            while speed > 2.0:
                chain.append("atempo=2.0")
                speed /= 2.0
            chain.append(f"atempo={speed:.4f}")
            tempo = ",".join(chain) + ","

        delay_ms = int(entry.start * 1000)
        tempo_label = tempo.rstrip(",") if tempo else "-"
        logger.info(
            "  [%s] delay=%dms tempo=%s | %s",
            entry.startLabel, delay_ms, tempo_label, entry.text,
        )

        tts_inputs.append((next_idx, delay_ms, tempo))
        next_idx += 1

    if not tts_inputs:
        raise RuntimeError("Không có file TTS nào để gộp")

    parts = [
        f"[{idx}:a]{tempo}adelay={d}|{d}[t{k}]"
        for k, (idx, d, tempo) in enumerate(tts_inputs)
    ]
    mix_inputs = "".join(f"[t{k}]" for k in range(len(tts_inputs)))
    parts.append(f"{mix_inputs}amix=inputs={len(tts_inputs)}:duration=longest:dropout_transition=0:normalize=0[out]")

    cmd += [
        "-filter_complex", ";".join(parts),
        "-map", "[out]",
        "-c:a", "libmp3lame", "-b:a", "192k",
        str(out_path),
    ]

    logger.info("Running FFmpeg combine mp3 → %s", out_path.name)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg combine mp3 failed: {result.stderr[-500:]}")
    return out_path


def _mix_background_with_voice(
    background_path: Path,
    voice_path: Path,
    background_volume: float,
    out_path: Path,
) -> Path:
    """Mix background (instrumental/gốc) + full voice mp3 → single audio m4a."""
    if background_volume < 1.0:
        fc = (
            f"[0:a]volume={background_volume}[bg];"
            "[bg][1:a]amix=inputs=2:duration=longest:normalize=0[out]"
        )
    else:
        fc = "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[out]"

    cmd = [
        "ffmpeg", "-y",
        "-i", str(background_path),
        "-i", str(voice_path),
        "-filter_complex", fc,
        "-map", "[out]",
        "-c:a", "aac", "-b:a", "192k",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg background mix failed: {result.stderr[-500:]}")
    return out_path


def build_full_audio(
    video_id: str,
    voice_name: str = "vi-VN-Standard-B",
    progress_callback=None,
    log_fn=None,
) -> Path:
    """Gộp mp3 (theo SRT) + nhạc nền → 1 file full audio m4a."""
    video_path = _video_path(video_id)
    out_dir = settings.temp_dir / "tts" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    srt_path = _srt_path(video_id)
    entries = parse_srt(srt_path.read_text(encoding="utf-8"))

    def cb(pct: int):
        if progress_callback:
            progress_callback(pct)

    cb(5)
    if log_fn:
        log_fn("Tách giọng khỏi nhạc nền (Demucs)...")
    try:
        instrumental = separate_instrumental(video_path, out_dir)
        background_volume = 1.0
        if log_fn:
            log_fn("Đã tách giọng xong, giữ lại nhạc nền.")
    except Exception as e:
        logger.warning("Demucs failed (%s) — dùng audio gốc làm nền (volume 0.3)", e)
        instrumental = extract_audio(video_path, out_dir)
        background_volume = 0.3
        if log_fn:
            log_fn(f"Demucs lỗi ({e}) — dùng audio gốc làm nền (âm lượng 30%).", level="warning")
    cb(40)

    audio_files = synthesize_srt(
        video_id,
        progress_callback=lambda i, total: cb(40 + int((i / total) * 35)) if total else None,
        voice_name=voice_name,
        log_fn=log_fn,
    )
    cb(75)

    full_voice = out_dir / "full_voice.mp3"
    if log_fn:
        log_fn(f"Gộp {len(audio_files)} đoạn giọng nói theo thời gian phụ đề...")
    combine_tts_mp3(audio_files, entries, full_voice)
    if log_fn:
        log_fn("Đã gộp giọng nói hoàn chỉnh (full_voice.mp3).")
    cb(85)

    full_audio = out_dir / "full_audio.m4a"
    if log_fn:
        log_fn("Trộn nhạc nền + giọng nói → full_audio.m4a...")
    _mix_background_with_voice(instrumental, full_voice, background_volume, full_audio)
    if log_fn:
        log_fn("Đã trộn xong audio lồng tiếng.")
    cb(100)
    return full_audio


def dub_video_with_tts(
    video_id: str,
    voice_name: str = "vi-VN-Standard-B",
    progress_callback=None,
    log_fn=None,
) -> Path:
    """Separate vocals → synthesize Vietnamese TTS → mix into dubbed video."""
    video_path = _video_path(video_id)
    full_audio = build_full_audio(video_id, voice_name, progress_callback, log_fn)

    out_path = settings.temp_dir / "tts" / video_id / "dubbed_video.mp4"
    if log_fn:
        log_fn("Mux audio lồng tiếng vào video (FFmpeg)...")
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-i", str(full_audio),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "libx264", "-crf", "23", "-preset", "medium",
            "-c:a", "copy",
            "-shortest",
            str(out_path),
        ],
        check=True, capture_output=True, timeout=600,
    )
    if log_fn:
        log_fn("Đã tạo video lồng tiếng xong.")
    return out_path


def run_dub_sync(loop, job_id: str, jobs: dict, ws_clients: dict, video_id: str):
    """Run dubbing (vocal separation + TTS + mix) in background."""
    job = jobs[job_id]
    job["status"] = "processing"
    job["phase"] = "dub"

    try:
        last_pct = 0

        def progress(pct: int):
            nonlocal last_pct
            pct = int(pct)
            if pct > last_pct:
                last_pct = pct
                job["progress"] = pct
                notify_ws_sync(loop, ws_clients, job_id, {
                    "type": "progress", "progress": pct, "phase": "dub",
                })

        job_log_sync(loop, jobs, ws_clients, job_id, "Bắt đầu lồng tiếng Việt (tách giọng + TTS + trộn)...")

        def _log(msg: str, level: str = "info"):
            job_log_sync(loop, jobs, ws_clients, job_id, msg, level=level)

        out = dub_video_with_tts(
            video_id,
            voice_name=job.get("tts_voice", "vi-VN-Standard-B"),
            progress_callback=progress,
            log_fn=_log,
        )

        job["status"] = "done"
        job["progress"] = 100
        job["output_path"] = str(out)
        job_log_sync(loop, jobs, ws_clients, job_id, "Lồng tiếng Việt hoàn tất!", level="success")
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done", "progress": 100, "video_id": video_id,
        })
    except Exception as e:
        logger.exception("dub failed")
        job["status"] = "error"
        job["error"] = str(e)
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error",
            "message": f"Lỗi lồng tiếng: {e}",
        })
