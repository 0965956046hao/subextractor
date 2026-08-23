"""Whisper-based subtitle alignment (sync each SRT line to the audio)."""

import logging
import subprocess
import tempfile
import time
from pathlib import Path

from app.models import SrtEntry
from app.services.srt_utils import parse_srt, entries_to_srt, _fmt
from app.services.media_utils import _srt_path, _video_path, _get_audio_duration
from app.services.job_utils import JobCancelled, notify_ws_sync

logger = logging.getLogger(__name__)


def _job_log(job: dict, ws_clients: dict, loop, job_id: str, message: str, level: str = "info"):
    job.setdefault("logs", []).append({"message": message, "ts": time.time(), "level": level})
    notify_ws_sync(loop, ws_clients, job_id, {
        "type": "log", "message": message, "ts": time.time(), "level": level,
    })


def run_align_sync(
    job: dict,
    ws_clients: dict,
    loop,
    job_id: str,
):
    video_id = job["video_id"]
    srt_path = _srt_path(video_id)
    video_path = _video_path(video_id)

    notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 0, "phase": "align"})
    _job_log(job, ws_clients, loop, job_id, "Bắt đầu chỉnh khớp phụ đề với audio (Whisper)...")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as af:
        audio_path = af.name

    try:
        job["phase"] = "extract_audio"
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 5, "phase": "extract_audio"})
        _job_log(job, ws_clients, loop, job_id, "Tách audio từ video...")

        extract_cmd = [
            "ffmpeg", "-i", str(video_path),
            "-vn", "-ar", "16000", "-ac", "1",
            "-y", audio_path,
        ]
        _align_dur = _get_audio_duration(str(video_path))
        subprocess.run(extract_cmd, check=True, capture_output=True, timeout=max(120, int(_align_dur * 1.5)))

        job["phase"] = "whisper"
        notify_ws_sync(loop, ws_clients, job_id, {"type": "progress", "progress": 20, "phase": "whisper"})
        _job_log(job, ws_clients, loop, job_id, "Đang chỉnh khớp từng dòng phụ đề (Whisper)...")

        srt_content = srt_path.read_text(encoding="utf-8")
        entries = parse_srt(srt_content)

        if not entries:
            return

        aligned = _whisper_subword_align(audio_path, entries, job, ws_clients, loop, job_id)

        new_srt = entries_to_srt(aligned)
        # Preserve the original SRT before overwriting with the aligned version.
        backup = srt_path.with_name("subtitles_original.srt")
        if srt_path.exists() and not backup.exists():
            backup.write_text(srt_path.read_text(encoding="utf-8"), encoding="utf-8")
        srt_path.write_text(new_srt, encoding="utf-8")

        job["progress"] = 100
        _job_log(job, ws_clients, loop, job_id, f"Chỉnh khớp xong ({len(aligned)} dòng).", level="success")
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
    loop,
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
    loop,
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
    loop,
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
