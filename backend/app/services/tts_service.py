"""Google Cloud Text-to-Speech synthesis (Vietnamese dubbing voice)."""

import json
import logging
import os
import subprocess
import time
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


def list_google_voices(lang: str = "vi-VN", max_results: int = 100) -> List[dict]:
    """List available Google TTS voices for a language (for the UI dropdown)."""
    try:
        from google.cloud import texttospeech
    except ImportError:
        raise ImportError("google-cloud-texttospeech not installed")

    client = _get_tts_client()
    response = client.list_voices(language_code=lang)
    voices = []
    for v in response.voices:
        voices.append({
            "voice_type": v.name,
            "display_name": f"{v.name}",
            "language_codes": list(v.language_codes or []),
            "gender": v.ssml_gender.name if v.ssml_gender else "",
        })
    # Google sorts by code; prefer the requested language first, keep stable.
    voices.sort(key=lambda x: (x["voice_type"]))
    return voices[:max_results]


def synthesize_preview(voice_name: str, text: str, out_path: Path) -> Path:
    """Synthesize a short preview MP3 for a voice (one-shot, no file reuse)."""
    try:
        from google.cloud import texttospeech
    except ImportError:
        raise ImportError("google-cloud-texttospeech not installed")

    if not voice_name:
        raise ValueError("Chưa chọn giọng.")

    client = _get_tts_client()
    synthesis_input = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(
        language_code="vi-VN",
        name=voice_name,
        ssml_gender=texttospeech.SsmlVoiceGender.NEUTRAL,
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        speaking_rate=1.0,
        pitch=0.0,
    )
    response = client.synthesize_speech(
        input=synthesis_input, voice=voice, audio_config=audio_config
    )
    out_path.write_bytes(response.audio_content)
    logger.info("Google TTS preview %s → %s", voice_name, out_path.name)
    return out_path


def _is_transient_tts_error(e: Exception) -> bool:
    """Return True only for retryable errors (quota / rate-limit / server 5xx)."""
    code = getattr(e, "code", None) or getattr(e, "status_code", None) or getattr(e, "status", None)
    if isinstance(code, int) and code in (408, 429, 500, 502, 503, 504):
        return True
    name = type(e).__name__.lower()
    return any(hint in name for hint in ("resourceexhausted", "ratelimit", "quota", "serviceunavailable", "deadlineexceeded", "backenderror", "unavailable"))


_TTS_MAX_ATTEMPTS = 5


def _synthesize_with_retry(client, entry, out_dir: Path, index: int, voice_name: str = "vi-VN-Standard-A", log_fn=None) -> Path:
    """Synthesize one entry, retrying transient errors with an increasing delay.

    Transient failures (quota / rate-limit / server 5xx) retry with a growing
    wait time (1s, 2s, 4s, 8s, … capped at 60s) up to `_TTS_MAX_ATTEMPTS` times,
    then raise. Permanent errors (400 invalid voice, 401 auth, …) raise
    immediately — retrying them is pointless.
    """
    wait = 1.0
    attempt = 0
    last_err = None
    while attempt < _TTS_MAX_ATTEMPTS:
        attempt += 1
        try:
            return synthesize_entry(client, entry, out_dir, index, voice_name=voice_name)
        except Exception as e:
            last_err = e
            if not _is_transient_tts_error(e):
                raise
            if log_fn and attempt == 1:
                log_fn(f"  TTS dòng {index} lỗi tạm thời ({e}), thử lại với thời gian chờ tăng dần...", level="warning")
            logger.warning("TTS transient error for entry %d (attempt %d/%d): %s", index, attempt, _TTS_MAX_ATTEMPTS, e)
            if attempt >= _TTS_MAX_ATTEMPTS:
                break
            time.sleep(wait)
            wait = min(wait * 2, 60.0)
    raise RuntimeError(f"TTS failed for entry {index} after {_TTS_MAX_ATTEMPTS} attempts: {last_err}") from last_err


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
    reused = 0
    for i, entry in enumerate(entries):
        if progress_callback:
            progress_callback(i, total)

        out_path = out_dir / f"{i + 1:04d}.mp3"
        if out_path.exists() and out_path.stat().st_size > 0:
            audio_files.append(out_path)
            synth_ok += 1
            reused += 1
            if log_fn:
                log_fn(f"  ✓ Dòng {i + 1}/{total}: đã có (tái sử dụng)", level="success")
            continue

        # Retry with increasing delay until success — no silent placeholder.
        try:
            path = _synthesize_with_retry(client, entry, out_dir, i + 1, voice_name=voice_name, log_fn=log_fn)
        except Exception as e:
            if log_fn:
                log_fn(f"  ✗ Dòng {i + 1}/{total}: thất bại ({e})", level="error")
            raise
        if path:
            audio_files.append(path)
            synth_ok += 1
            if log_fn:
                log_fn(f"  ✓ Dòng {i + 1}/{total}: thành công", level="success")

    if progress_callback:
        progress_callback(total, total)

    logger.info("TTS complete: %d audio files in %s", len(audio_files), out_dir)
    if log_fn:
        ok_note = f"TTS xong: {synth_ok} file giọng nói."
        if reused:
            ok_note += f" ({reused} dòng đã có sẵn, không gọi API.)"
        log_fn(ok_note, level="success")
    return audio_files


def synthesize_srt_capcut(video_id: str, progress_callback=None, use_custom_srt: bool = False, voice_name: str = "BV421_vivn_streaming", rate: str = "1.0", log_fn=None) -> List[Path]:
    """Convert all SRT entries to individual MP3 files via the CapCut service.

    Mirrors `synthesize_srt` (Google TTS) output contract so the rest of the
    dubbing pipeline (`combine_tts_mp3`, mix, mux) is unchanged:
    - 1 MP3 per entry, placed in ``tts/{video_id}/{voice_key}/{index:04d}.mp3``
    - failures → silent placeholder to keep entry alignment
    """
    from app.services.capcut_tts_client import generate_segments_to_dir

    voice_key = voice_name.replace("-", "_")
    out_dir = settings.temp_dir / "tts" / video_id / voice_key
    out_dir.mkdir(parents=True, exist_ok=True)

    if use_custom_srt:
        custom_path = out_dir / "custom_input.srt"
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

    total = len(entries)

    logger.info("CapCut TTS: synthesizing %d entries (voice=%s)", total, voice_name)
    if log_fn:
        log_fn(f"CapCut TTS: tổng hợp {total} dòng phụ đề bằng giọng {voice_name}...")

    # Resume: only submit lines whose MP3 is not yet on disk. Already-generated
    # files are reused as-is, so a retry continues from where it left off.
    missing_indices: List[int] = []
    missing_texts: List[str] = []
    for i, entry in enumerate(entries):
        idx = i + 1
        target = out_dir / f"{idx:04d}.mp3"
        if not entry.text.strip():
            continue
        if target.exists() and target.stat().st_size > 0:
            continue
        missing_indices.append(idx)
        missing_texts.append(entry.text.strip())

    written_names = set()
    if missing_texts:
        if log_fn:
            log_fn(f"  Còn {len(missing_texts)} dòng cần tổng hợp ({total - len(missing_texts)} dòng đã có sẵn)...")

        def cb(done: int, total_: int):
            if progress_callback:
                progress_callback(done, total_)

        written = generate_segments_to_dir(
            missing_texts,
            out_dir,
            voice=voice_name,
            rate=rate,
            prefix="segment",
            progress_callback=cb,
            log_fn=log_fn,
            indices=missing_indices,
        )
        written_names = {p.name for p in written}
    elif log_fn:
        log_fn(f"  Tất cả {total} dòng đã có sẵn — bỏ qua gen voice.", level="success")

    audio_files: List[Path] = []
    synth_ok = 0
    synth_fail = 0
    for i, entry in enumerate(entries):
        idx = i + 1
        target = out_dir / f"{idx:04d}.mp3"
        if not entry.text.strip():
            audio_files.append(None)
            if log_fn:
                log_fn(f"  ⏭ Dòng {idx}/{total}: bỏ qua (phụ đề rỗng)")
            continue
        if target.exists() and target.stat().st_size > 0:
            audio_files.append(target)
            synth_ok += 1
            if log_fn:
                log_fn(f"  ✓ Dòng {idx}/{total}: đã có (tái sử dụng)", level="success")
            continue
        # Try the service-named file (segment_0001.mp3) if present
        seg = out_dir / f"segment_{idx:04d}.mp3"
        if seg.name in written_names and seg.exists():
            seg.rename(target)
            audio_files.append(target)
            synth_ok += 1
            if log_fn:
                log_fn(f"  ✓ Dòng {idx}/{total}: thành công", level="success")
            continue
        logger.warning("CapCut TTS failed for entry %d: %s", idx, entry.text[:50])
        synth_fail += 1
        if log_fn:
            log_fn(f"  ✗ Dòng {idx}/{total}: thất bại (chèn khoảng lặng)", level="warning")
        silent_path = out_dir / f"{idx:04d}.mp3"
        _create_silence(silent_path, max(entry.end - entry.start, 0.5))
        audio_files.append(silent_path)

    if progress_callback:
        progress_callback(total, total)

    logger.info("CapCut TTS complete: %d audio files in %s", len(audio_files), out_dir)
    if log_fn:
        ok_note = f"CapCut TTS xong: {synth_ok} file giọng nói."
        if synth_fail:
            ok_note += f" {synth_fail} dòng lỗi (đã chèn khoảng lặng)."
        log_fn(ok_note, level="success" if synth_fail == 0 else "warning")
    return audio_files


def synthesize_srt_capcut_multi(
    video_id: str,
    entries,
    voice_map: dict,
    default_voice: str = "BV421_vivn_streaming",
    rate: str = "1.0",
    log_fn=None,
) -> List[Path]:
    """Convert each SRT entry to an MP3 using ITS OWN CapCut voice (multi-voice dub).

    `voice_map` maps SRT line number (1-based) → voice_type (from ``voice_map.json``
    generated during translation). Entries without an entry fall back to
    `default_voice`. Returns a list of MP3 paths aligned to `entries` — the same
    contract as `synthesize_srt_capcut` — so the rest of the dubbing pipeline
    (`combine_tts_mp3`, mix, mux) is unchanged.
    """
    from app.services.capcut_tts_client import generate_segments_to_dir

    voice_key = default_voice.replace("-", "_")
    out_dir = settings.temp_dir / "tts" / video_id / voice_key
    out_dir.mkdir(parents=True, exist_ok=True)

    total = len(entries)
    audio_files: List[Path] = [None] * total
    synth_ok = 0
    synth_fail = 0
    failed: List[int] = []

    # Group entries by voice so each distinct voice becomes ONE CapCut batch job.
    groups: dict[str, list] = {}
    for i, e in enumerate(entries):
        voice = voice_map.get(i + 1) or default_voice
        groups.setdefault(voice, []).append(i)

    if log_fn:
        log_fn(f"Nhiều giọng: tổng hợp {total} dòng bằng {len(groups)} giọng CapCut khác nhau...")

    import re

    def _write_found(voice_prefix: str, written, idxs):
        nonlocal synth_ok
        written_names = {p.name for p in written}
        found = []
        for pos, i in enumerate(idxs):
            target = out_dir / f"{i + 1:04d}.mp3"
            if target.exists():
                audio_files[i] = target
                synth_ok += 1
                found.append(i)
                continue
            seg = out_dir / f"{voice_prefix}_{pos + 1:04d}.mp3"
            if seg.name in written_names and seg.exists():
                seg.rename(target)
                audio_files[i] = target
                synth_ok += 1
                found.append(i)
                continue
            failed.append(i)
        return found

    for voice, idxs in groups.items():
        idxs = [i for i in idxs if entries[i].text.strip()]
        if not idxs:
            continue
        texts = [entries[i].text.strip() for i in idxs]
        # Unique prefix per voice so per-group files never collide in out_dir.
        prefix = "mv_" + re.sub(r"[^A-Za-z0-9_]", "_", voice)[:40]
        if log_fn:
            log_fn(f"  Giọng {voice}: {len(idxs)} dòng...")
        try:
            written = generate_segments_to_dir(
                texts,
                out_dir,
                voice=voice,
                rate=rate,
                prefix=prefix,
                progress_callback=None,
            )
        except Exception as e:
            logger.warning("CapCut multi-voice job failed for %s: %s", voice, e)
            written = []
        _write_found(prefix, written, idxs)

    # Fallback: any line whose assigned voice failed → retry with the DEFAULT voice.
    if failed:
        retry_idxs = [i for i in failed if entries[i].text.strip()]
        if log_fn:
            log_fn(
                f"  {len(retry_idxs)} dòng lỗi khi map giọng đã chọn — chuyển về giọng mặc định {default_voice}..."
            )
        retry_texts = [entries[i].text.strip() for i in retry_idxs]
        prefix = "mv_" + re.sub(r"[^A-Za-z0-9_]", "_", default_voice)[:40]
        try:
            written = generate_segments_to_dir(
                retry_texts,
                out_dir,
                voice=default_voice,
                rate=rate,
                prefix=prefix,
                progress_callback=None,
            )
        except Exception as e:
            logger.warning("CapCut fallback default-voice job failed: %s", e)
            written = []
        written_names = {p.name for p in written}
        still_failed = []
        for pos, i in enumerate(retry_idxs):
            target = out_dir / f"{i + 1:04d}.mp3"
            if target.exists():
                audio_files[i] = target
                synth_ok += 1
                continue
            seg = out_dir / f"{prefix}_{pos + 1:04d}.mp3"
            if seg.name in written_names and seg.exists():
                seg.rename(target)
                audio_files[i] = target
                synth_ok += 1
                continue
            still_failed.append(i)
        failed = still_failed

    # Final fallback: silence for anything still missing.
    for i in failed:
        if not entries[i].text.strip():
            continue
        idx = i + 1
        synth_fail += 1
        silent_path = out_dir / f"{idx:04d}.mp3"
        _create_silence(silent_path, max(entries[i].end - entries[i].start, 0.5))
        audio_files[i] = silent_path

    logger.info("CapCut multi-voice TTS complete: %d audio files in %s", synth_ok, out_dir)
    if log_fn:
        ok_note = f"CapCut multi-voice TTS xong: {synth_ok} file giọng nói."
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

        def log_per_line(msg: str, level: str = "info"):
            job_log_sync(loop, jobs, ws_clients, job_id, msg, level=level)

        audio_files = synthesize_srt(
            video_id,
            progress_callback=progress,
            use_custom_srt=job.get("use_custom_srt", False),
            voice_name=job.get("tts_voice", "vi-VN-Standard-A"),
            log_fn=log_per_line,
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
