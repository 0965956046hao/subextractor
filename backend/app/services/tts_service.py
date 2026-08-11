import io
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import List

from app.config import settings
from app.services.tool_services import parse_srt, entries_to_srt, _srt_path, _video_path

logger = logging.getLogger(__name__)


def _get_tts_client():
    """Lazy-load Google Cloud TTS client."""
    try:
        from google.cloud import texttospeech
    except ImportError:
        raise ImportError(
            "google-cloud-texttospeech not installed. Run: pip install google-cloud-texttospeech"
        )

    creds_path = settings.google_tts_credentials or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if creds_path:
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path

    return texttospeech.TextToSpeechClient()


def synthesize_entry(client, entry, out_dir: Path, index: int) -> Path:
    """Synthesize a single SRT entry to MP3."""
    try:
        from google.cloud import texttospeech
    except ImportError:
        raise ImportError("google-cloud-texttospeech not installed")

    text = entry.text.strip()
    if not text:
        return None

    synthesis_input = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(
        language_code="vi-VN",
        name="vi-VN-Standard-A",  # Standard Vietnamese female voice
        ssml_gender=texttospeech.SsmlVoiceGender.FEMALE,
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        speaking_rate=1.0,
        pitch=0.0,
    )

    response = client.synthesize_speech(
        input=synthesis_input, voice=voice, audio_config=audio_config
    )

    out_path = out_dir / f"{index:04d}.mp3"
    out_path.write_bytes(response.audio_content)
    logger.debug("Synthesized %d: %s → %s", index, text[:50], out_path.name)
    return out_path


def synthesize_srt(video_id: str, progress_callback=None, use_custom_srt: bool = False) -> List[Path]:
    """Convert all SRT entries to individual MP3 files, then combine into one."""
    out_dir = settings.temp_dir / "tts" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    if use_custom_srt:
        custom_path = out_dir / "custom_input.srt"
        if not custom_path.exists():
            raise ValueError("Custom SRT input not found")
        content = custom_path.read_text(encoding="utf-8")
    else:
        srt_path = _srt_path(video_id)
        content = srt_path.read_text(encoding="utf-8")

    entries = parse_srt(content)

    if not entries:
        raise ValueError("No subtitle entries found")

    client = _get_tts_client()

    out_dir = settings.temp_dir / "tts" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    audio_files: List[Path] = []
    total = len(entries)

    logger.info("Synthesizing %d subtitle entries with Google Cloud TTS", total)

    for i, entry in enumerate(entries):
        if progress_callback:
            progress_callback(i, total)

        try:
            path = synthesize_entry(client, entry, out_dir, i + 1)
            if path:
                audio_files.append(path)
        except Exception as e:
            logger.warning("TTS failed for entry %d: %s", i + 1, e)
            # Create silent placeholder
            silent_path = out_dir / f"{i + 1:04d}.mp3"
            _create_silence(silent_path, max(entry.end - entry.start, 0.5))
            audio_files.append(silent_path)

    if progress_callback:
        progress_callback(total, total)

    logger.info("TTS complete: %d audio files in %s", len(audio_files), out_dir)
    return audio_files


def _create_silence(out_path: Path, duration_sec: float):
    """Create a silent MP3 placeholder using FFmpeg."""
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi",
                "-i", f"anullsrc=r=24000:cl=mono",
                "-t", str(duration_sec),
                "-c:a", "libmp3lame", "-b:a", "64k",
                str(out_path),
            ],
            capture_output=True,
            check=False,
            timeout=15,
        )
    except Exception:
        out_path.write_bytes(b"")


def combine_tts_with_video(video_id: str, audio_files: List[Path]) -> Path:
    """
    Mix TTS audio with original video.
    Uses SRT timestamps to position each audio clip correctly.
    Returns path to output video.
    """
    try:
        from google.cloud import texttospeech
    except ImportError:
        pass

    video_path = _video_path(video_id)
    srt_path = _srt_path(video_id)
    content = srt_path.read_text(encoding="utf-8")
    entries = parse_srt(content)

    # Create a filter_complex script that places each audio clip at its SRT timestamp
    # using FFmpeg's adelay filter
    filter_parts = []
    audio_inputs = []

    for i, entry in enumerate(entries):
        if i >= len(audio_files):
            break
        af = audio_files[i]
        if not af or not af.exists() or af.stat().st_size == 0:
            continue

        delay_ms = int(entry.start * 1000)
        audio_inputs.extend(["-i", str(af)])
        idx = len(audio_inputs) // 2  # 1-based index
        # Apply delay to align with subtitle timing, then mix
        filter_parts.append(f"[{idx - 1}:a]adelay={delay_ms}|{delay_ms}[a{i}]")

    if not filter_parts:
        logger.warning("No valid TTS audio files to combine")
        return None

    # Mix all delayed audio streams together
    mix_inputs = "".join([f"[a{i}]" for i in range(len(filter_parts))])
    filter_parts.append(f"{mix_inputs}amix=inputs={len(entries)}:duration=first:dropout_transition=0[tts]")

    # Mix TTS with original audio: keep original at 30%, TTS at 100%
    filter_parts.append("[0:a]volume=0.3[orig]")
    filter_parts.append("[orig][tts]amix=inputs=2:duration=first[out]")

    filter_complex = ";".join(filter_parts)

    out_dir = settings.temp_dir / "tts" / video_id
    out_path = out_dir / "dubbed_video.mp4"

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        *audio_inputs,
        "-filter_complex", filter_complex,
        "-map", "0:v:0",
        "-map", "[out]",
        "-c:v", "libx264", "-crf", "23", "-preset", "medium",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(out_path),
    ]

    logger.info("Running FFmpeg TTS mix: %s", " ".join(cmd[:8]))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

    if result.returncode != 0:
        logger.error("FFmpeg TTS mix failed:\n%s", result.stderr[-2000:])
        raise RuntimeError(f"FFmpeg TTS mix failed: {result.stderr[-500:]}")

    logger.info("TTS dubbed video saved to %s", out_path)
    return out_path


def _notify_ws_sync(loop, ws_clients, job_id, data):
    import asyncio
    async def _send():
        for ws in ws_clients.get(job_id, []):
            try:
                await ws.send_json(data)
            except Exception:
                pass
    if loop:
        asyncio.run_coroutine_threadsafe(_send(), loop)


def run_tts_sync(loop, job_id: str, jobs: dict, ws_clients: dict, video_id: str):
    """Run TTS in background, reporting progress via WebSocket."""
    import time
    job = jobs[job_id]
    job["status"] = "processing"
    job["phase"] = "tts"

    try:
        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "log",
            "message": "Bắt đầu tổng hợp giọng nói TTS...",
            "ts": time.time(),
            "level": "info",
        })

        last_pct = 0

        def progress(i, total):
            nonlocal last_pct
            pct = int((i / total) * 90) if total > 0 else 0
            if pct > last_pct:
                last_pct = pct
                job["progress"] = pct
                _notify_ws_sync(loop, ws_clients, job_id, {
                    "type": "progress",
                    "progress": pct,
                    "phase": "tts",
                })

        audio_files = synthesize_srt(
            video_id,
            progress_callback=progress,
            use_custom_srt=job.get("use_custom_srt", False),
        )

        # Build list of audio file URLs for FE
        audio_urls = []
        for af in audio_files:
            if af and af.exists() and af.stat().st_size > 0:
                audio_urls.append(f"/api/tts-audio/{video_id}/{af.name}")

        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "log",
            "message": f"Đã tạo {len(audio_files)} file audio.",
            "ts": time.time(),
            "level": "info",
        })
        job["progress"] = 100
        job["phase"] = "done"
        job["status"] = "done"
        job["audio_urls"] = audio_urls

        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done",
            "progress": 100,
            "message": "TTS hoàn tất",
            "audio_urls": audio_urls,
        })

    except Exception as e:
        logger.exception("TTS failed")
        job["status"] = "error"
        job["error"] = str(e)
        _notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error",
            "message": f"Lỗi TTS: {e}",
        })
