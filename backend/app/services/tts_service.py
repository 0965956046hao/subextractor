"""Google Cloud Text-to-Speech synthesis (Vietnamese dubbing voice)."""

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import List

from app.config import settings
from app.services.srt_utils import parse_srt
from app.services.media_utils import _srt_path
from app.services.job_utils import notify_ws_sync, job_log_sync

logger = logging.getLogger(__name__)


def _get_tts_client():
    """Lazy-load Google Cloud TTS client."""
    try:
        from google.cloud import texttospeech
    except ImportError:
        raise ImportError(
            "google-cloud-texttospeech not installed. Run: pip install google-cloud-texttospeech"
        )

    # Check env vars first, then user config
    creds_path = settings.google_tts_credentials or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not creds_path:
        # Read from user config JSON
        cf = settings.temp_dir / "user_config.json"
        if cf.exists():
            try:
                cfg = json.loads(cf.read_text(encoding="utf-8"))
                creds_json = cfg.get("google_tts_credentials", "")
                if isinstance(creds_json, dict):
                    creds_json = json.dumps(creds_json, ensure_ascii=False)
                if creds_json:
                    # Write to temp file and point to it
                    creds_file = settings.temp_dir / "tts_service_account.json"
                    creds_file.write_text(creds_json, encoding="utf-8")
                    creds_path = str(creds_file)
            except Exception:
                pass

    if not creds_path:
        raise ValueError("Google TTS credentials not set. Vào Settings (⚙️) để nhập Service Account JSON.")

    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path
    return texttospeech.TextToSpeechClient()


def synthesize_entry(client, entry, out_dir: Path, index: int, voice_name: str = "vi-VN-Standard-A") -> Path:
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
        name=voice_name,
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


def synthesize_srt(video_id: str, progress_callback=None, use_custom_srt: bool = False, voice_name: str = "vi-VN-Standard-A", log_fn=None) -> List[Path]:
    """Convert all SRT entries to individual MP3 files."""
    voice_key = voice_name.replace("-", "_")
    out_dir = settings.temp_dir / "tts" / video_id / voice_key
    out_dir.mkdir(parents=True, exist_ok=True)

    if use_custom_srt:
        custom_path = out_dir / "custom_input.srt"
        # Fallback: custom SRT is saved in parent tts dir by the router
        if not custom_path.exists():
            custom_path = settings.temp_dir / "tts" / video_id / "custom_input.srt"
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

    audio_files: List[Path] = []
    total = len(entries)

    logger.info("Synthesizing %d entries (voice=%s)", total, voice_name)
    if log_fn:
        log_fn(f"TTS: tổng hợp {total} dòng phụ đề bằng giọng {voice_name}...")

    synth_ok = 0
    synth_fail = 0
    for i, entry in enumerate(entries):
        if progress_callback:
            progress_callback(i, total)

        try:
            path = synthesize_entry(client, entry, out_dir, i + 1, voice_name=voice_name)
            if path:
                audio_files.append(path)
                synth_ok += 1
        except Exception as e:
            logger.warning("TTS failed for entry %d: %s", i + 1, e)
            synth_fail += 1
            # Create silent placeholder
            silent_path = out_dir / f"{i + 1:04d}.mp3"
            _create_silence(silent_path, max(entry.end - entry.start, 0.5))
            audio_files.append(silent_path)

    if progress_callback:
        progress_callback(total, total)

    logger.info("TTS complete: %d audio files in %s", len(audio_files), out_dir)
    if log_fn:
        ok_note = f"TTS xong: {synth_ok} file giọng nói."
        if synth_fail:
            ok_note += f" {synth_fail} dòng lỗi (đã chèn khoảng lặng)."
        log_fn(ok_note, level="success" if synth_fail == 0 else "warning")
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


def run_tts_sync(loop, job_id: str, jobs: dict, ws_clients: dict, video_id: str):
    """Run TTS in background, reporting progress via WebSocket."""
    job = jobs[job_id]
    job["status"] = "processing"
    job["phase"] = "tts"

    try:
        job_log_sync(loop, jobs, ws_clients, job_id, "Bắt đầu tổng hợp giọng nói TTS...")

        last_pct = 0

        def progress(i, total):
            nonlocal last_pct
            pct = int((i / total) * 90) if total > 0 else 0
            if pct > last_pct:
                last_pct = pct
                job["progress"] = pct
                notify_ws_sync(loop, ws_clients, job_id, {
                    "type": "progress",
                    "progress": pct,
                    "phase": "tts",
                })

        audio_files = synthesize_srt(
            video_id,
            progress_callback=progress,
            use_custom_srt=job.get("use_custom_srt", False),
            voice_name=job.get("tts_voice", "vi-VN-Standard-A"),
        )

        # Build list of audio file URLs for FE (use relative paths from out_dir)
        audio_urls = []
        for af in audio_files:
            if af and af.exists() and af.stat().st_size > 0:
                rel = str(af.relative_to(settings.temp_dir / "tts" / video_id))
                audio_urls.append(f"/api/tts-audio/{video_id}/{rel}")

        job_log_sync(loop, jobs, ws_clients, job_id, f"Đã tạo {len(audio_files)} file audio.")
        job["progress"] = 100
        job["phase"] = "done"
        job["status"] = "done"
        job["audio_urls"] = audio_urls

        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "done",
            "progress": 100,
            "message": "TTS hoàn tất",
            "audio_urls": audio_urls,
        })

    except Exception as e:
        logger.exception("TTS failed")
        job["status"] = "error"
        job["error"] = str(e)
        notify_ws_sync(loop, ws_clients, job_id, {
            "type": "error",
            "message": f"Lỗi TTS: {e}",
        })
