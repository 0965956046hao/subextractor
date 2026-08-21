"""Vocal separation (Demucs) + Vietnamese dubbing (instrumental + TTS)."""

import json
import logging
import re
import subprocess
from pathlib import Path
from typing import List

from app.config import settings
from app.services.srt_utils import entries_to_srt, merge_similar_adjacent, parse_srt
from app.services.media_utils import (
    _srt_path,
    _video_path,
    _get_audio_duration,
    _merge_audio_path,
)
from app.services.job_utils import notify_ws_sync, job_log_sync
from app.services.tts_service import synthesize_srt, synthesize_srt_capcut, synthesize_srt_capcut_multi
from app.services.translation_service import load_voice_map, generate_voice_map

logger = logging.getLogger(__name__)

MAX_TEMPO = 1.6


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


def _run_ffmpeg(cmd: list, timeout: int = 3600) -> None:
    """Run an ffmpeg command; raise RuntimeError with stderr tail on failure."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"FFmpeg timeout sau {timeout}s: {' '.join(cmd[:4])}..."
        ) from None
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed: {result.stderr[-500:]}")


def combine_tts_mp3(
    audio_files: List[Path],
    entries,
    out_path: Path,
) -> Path:
    """Gộp các file mp3 TTS thành 1 file full voice mp3 (đặt theo timestamp SRT).

    Gộp theo từng cửa sổ thời gian (mỗi chunk 600s): mỗi lệnh ffmpeg chỉ mix vài
    chục/trăm input thay vì toàn bộ — tránh lệnh ffmpeg duy nhất với hàng nghìn
    input bị quá chậm và bị timeout giữa chừng (hậu quả trước đây: full_voice.mp3
    bị cụt, dài bằng đúng phần ffmpeg kịp xử lý). Sau khi concat sẽ kiểm tra
    duration đầu ra phải đạt đủ thời lượng dòng phụ đề cuối.
    """
    CHUNK_SECONDS = 600.0

    # Thu thập các file TTS hợp lệ. File dài hơn khung phụ đề (mp3 > 1.02× khung)
    # được ép tốc độ (atempo) RIÊNG trước khi đưa vào amix — vì đặt atempo TRƯỚC
    # adelay ngay trong filter graph amix làm ffmpeg tính sai duration=longest,
    # khiến full_voice.mp3 bị cụt (chỉ ~0.2s).
    items: List[tuple[Path, float, float]] = []  # (af, start, end)
    tempo_files: List[Path] = []
    chunk_dir = out_path.parent
    chunk_files: List[Path] = []
    try:
        for i, entry in enumerate(entries):
            if i >= len(audio_files):
                break
            af = audio_files[i]
            if not af or not af.exists() or af.stat().st_size == 0:
                continue
            srt_dur = entry.end - entry.start
            mp3_dur = _get_audio_duration(af)
            tempo = "-"
            # Tolerance 10%: skip auto-atempo if audio already close to SRT timing
            # (user may have manually adjusted speed via the alignment panel).
            if srt_dur > 0 and mp3_dur > srt_dur * 1.10:
                speed = min(mp3_dur / srt_dur, MAX_TEMPO)
                adj = chunk_dir / f".tempo_{af.stem}_{i}.mp3"
                _run_ffmpeg([
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-i", str(af),
                    "-af", f"atempo={speed:.4f}",
                    "-ac", "1", "-ar", "24000",
                    "-c:a", "libmp3lame", "-b:a", "192k",
                    str(adj),
                ])
                af = adj
                tempo_files.append(adj)
                tempo = f"{speed:.4f}"
            items.append((af, entry.start, entry.end))
            logger.info(
                "  [%s] delay=%dms tempo=%s | %s",
                entry.startLabel, int(entry.start * 1000), tempo, entry.text,
            )

        if not items:
            raise RuntimeError("Không có file TTS nào để gộp")

        expected_end = max(end for _, _, end in items)

        # Gom entry theo chunk (entry thuộc chunk chứa thời điểm bắt đầu của nó).
        chunk_size = int(CHUNK_SECONDS)
        chunk_map: dict[int, List[tuple[Path, float]]] = {}
        chunk_last_end: dict[int, float] = {}
        for af, start, end in items:
            c = int(start // chunk_size)
            chunk_map.setdefault(c, []).append((af, start))
            chunk_last_end[c] = max(chunk_last_end.get(c, 0.0), end)

        min_chunk, max_chunk = min(chunk_map), max(chunk_map)
        for c in range(min_chunk, max_chunk + 1):
            chunk_start = c * chunk_size
            chunk_path = chunk_dir / f".combine_{c:04d}.mp3"
            chunk_items = sorted(chunk_map.get(c, []), key=lambda it: it[1])
            is_last = c == max_chunk
            if is_last:
                dur = max(0.5, chunk_last_end[c] - chunk_start)
            else:
                dur = CHUNK_SECONDS

            if not chunk_items:
                # Khoảng trống không có phụ đề → chèn silence đúng độ dài chunk.
                _run_ffmpeg([
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                    "-t", f"{dur:.3f}",
                    "-c:a", "libmp3lame", "-b:a", "192k",
                    str(chunk_path),
                ])
            else:
                cmd = ["ffmpeg", "-y", "-loglevel", "error"]
                parts = []
                for k, (af, start) in enumerate(chunk_items):
                    cmd.extend(["-i", str(af)])
                    delay_ms = int((start - chunk_start) * 1000)
                    if delay_ms < 0:
                        delay_ms = 0
                    parts.append(f"[{k}:a]adelay={delay_ms}|{delay_ms}[t{k}]")
                mix_in = "".join(f"[t{k}]" for k in range(len(chunk_items)))
                parts.append(
                    f"{mix_in}amix=inputs={len(chunk_items)}:duration=longest:"
                    f"dropout_transition=0:normalize=0,apad[out]"
                )
                cmd += [
                    "-filter_complex", ";".join(parts),
                    "-map", "[out]",
                    "-t", f"{dur:.3f}",
                    "-c:a", "libmp3lame", "-b:a", "192k",
                    "-ar", "24000", "-ac", "1",
                    str(chunk_path),
                ]
                _run_ffmpeg(cmd)
            chunk_files.append(chunk_path)

        # Concat các chunk (cùng codec/rate/sample format) → full_voice.mp3
        list_file = chunk_dir / ".combine_list.txt"
        list_file.write_text(
            "".join(f"file '{p.name}'\n" for p in chunk_files),
            encoding="utf-8",
        )
        _run_ffmpeg([
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c", "copy", str(out_path),
        ], timeout=3600)

        # Validate: full_voice phải đủ dài tới cuối dòng phụ đề cuối (nếu không,
        # xoá luôn file cụt để không bị tái sử dụng ở lần chạy sau).
        out_dur = _get_audio_duration(out_path)
        tolerance = max(1.5, expected_end * 0.02)
        if out_dur < expected_end - tolerance:
            out_path.unlink(missing_ok=True)
            raise RuntimeError(
                f"Gộp giọng lỗi: full_voice.mp3 chỉ dài {out_dur:.1f}s, "
                f"thiếu so với thời lượng phụ đề {expected_end:.1f}s"
            )
    finally:
        for p in chunk_files:
            p.unlink(missing_ok=True)
        for p in tempo_files:
            p.unlink(missing_ok=True)
        (chunk_dir / ".combine_list.txt").unlink(missing_ok=True)
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


def _db_to_volume(db: float) -> float:
    """Convert dB reduction to a linear volume multiplier (0 dB → 1.0)."""
    return float(10 ** (-db / 20))


def _voice_lang_from_name(voice_name: str) -> str:
    """Derive a target-language code (vi/en/zh...) from a TTS voice name.

    Google voice names look like "vi-VN-Standard-B" or "en-US-Standard-C";
    CapCut voices are plain voice_type ids with no lang prefix, so fall back
    to "vi" (the default dubbing language).
    """
    m = re.match(r"([a-z]{2,3})-[A-Z]{2}", voice_name or "")
    if m:
        return m.group(1).lower()
    return "vi"


def build_full_audio(
    video_id: str,
    voice_name: str = "vi-VN-Standard-B",
    tts_engine: str = "google",
    mute_original: bool = True,
    original_gain_db: float = 0.0,
    multi_voice: bool = False,
    progress_callback=None,
    log_fn=None,
) -> Path:
    """Gộp mp3 (theo SRT) + nhạc nền → 1 file full audio m4a.

    `tts_engine` = "google" (Google TTS) | "capcut" (CapCut gen-voice service).
    `multi_voice` = True: đọc ``voice_map.json`` và đọc mỗi dòng bằng giọng riêng
    (chỉ áp dụng cho engine CapCut).
    `mute_original` = True: Demucs tách giọng, giữ instrumental (no_vocals).
    `mute_original` = False: giữ nguyên audio gốc, giảm âm lượng `original_gain_db` dB.
    """
    video_path = _video_path(video_id)
    out_dir = settings.temp_dir / "tts" / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # Ưu tiên dùng file audio gốc tải về trong bước merge (merged/{merge_id}_audio.mp4)
    # để tách voice/instrument thay vì trích audio từ video đã merge.
    audio_source = _merge_audio_path(video_id) or video_path

    srt_path = _srt_path(video_id)
    srt_content = srt_path.read_text(encoding="utf-8")

    # Kiểm tra phụ đề trùng lặp trước khi tạo voice: nếu nội dung một dòng giống
    # line trước ≥80% thì không gen voice lại (chèn khoảng lặng) — đồng thời cập
    # nhật SRT: xóa luôn dòng trùng đó và nới dài endtime của dòng trước bằng
    # endtime của dòng vừa xóa, để phụ đề không hiển thị cùng text 2 lần.
    merged, dedup_changes = merge_similar_adjacent(parse_srt(srt_content))
    if dedup_changes:
        if log_fn:
            log_fn(f"Phát hiện {len(dedup_changes)} dòng phụ đề trùng (giống line trước ≥80%):")
            for c in dedup_changes:
                log_fn(f"  #Xóa dòng {c['index']}, nới endtime dòng {c['merged_into']}: {c['from']}  →  {c['to']}")
        dedup_content = entries_to_srt(merged)
        if dedup_content.strip() != srt_content.strip():
            backup = srt_path.with_name("subtitles_original.srt")
            if not backup.exists():
                backup.write_text(srt_content, encoding="utf-8")
            srt_path.write_text(dedup_content, encoding="utf-8")
        if log_fn:
            log_fn(f"Đã cập nhật SRT: xóa {len(dedup_changes)} dòng trùng, nới endtime dòng trước.")
        srt_content = dedup_content

    entries = parse_srt(srt_content)

    def cb(pct: int):
        if progress_callback:
            progress_callback(pct)

    cb(5)
    if mute_original:
        if log_fn:
            log_fn("Tách giọng khỏi nhạc nền (Demucs)...")
        no_vocals = out_dir / "separated" / "htdemucs" / "audio" / "no_vocals.wav"
        if no_vocals.exists() and no_vocals.stat().st_size > 0:
            instrumental = no_vocals
            background_volume = 1.0
            if log_fn:
                log_fn("Đã có nhạc nền từ lần chạy trước — tái sử dụng (bỏ qua Demucs).")
        else:
            try:
                instrumental = separate_instrumental(audio_source, out_dir)
                background_volume = 1.0
                if log_fn:
                    log_fn("Đã tách giọng xong, giữ lại nhạc nền.")
            except Exception as e:
                logger.warning("Demucs failed (%s) — dùng audio gốc làm nền (volume 0.3)", e)
                instrumental = extract_audio(audio_source, out_dir)
                background_volume = 0.3
                if log_fn:
                    log_fn(f"Demucs lỗi ({e}) — dùng audio gốc làm nền (âm lượng 30%).", level="warning")
    else:
        if log_fn:
            log_fn(f"Giữ nguyên audio gốc, giảm giọng nền {original_gain_db:g} dB...")
        instrumental = extract_audio(audio_source, out_dir)
        background_volume = _db_to_volume(original_gain_db)
        if log_fn:
            log_fn(f"Âm lượng nhạc nền gốc = {background_volume:.2f} ({original_gain_db:g} dB).")
    cb(40)

    if tts_engine == "capcut":
        if multi_voice:
            voice_map = load_voice_map(video_id)
            if not voice_map:
                # Bước dịch có thể đã bị bỏ qua (resume-skip khi SRT đã tồn tại)
                # hoặc chạy lại từ bước dub — nên chủ động tạo voice_map tại đây.
                if log_fn:
                    log_fn("Chưa có voice_map.json — đang tạo ngay tại bước lồng tiếng...")
                generate_voice_map(
                    video_id,
                    entries,
                    log_fn=log_fn,
                    target_lang=_voice_lang_from_name(voice_name),
                )
                voice_map = load_voice_map(video_id)
            if not voice_map:
                raise RuntimeError(
                    "Bật nhiều giọng nói nhưng không tạo được voice_map.json "
                    "(cần Gemini key + CapCut voice catalog). Chạy lại bước Dịch "
                    "hoặc kiểm tra cấu hình rồi thử lại."
                )
            else:
                if log_fn:
                    log_fn(f"Nhiều giọng nói: đọc {len(voice_map)} dòng với giọng riêng...")
                audio_files = synthesize_srt_capcut_multi(
                    video_id,
                    entries,
                    voice_map,
                    default_voice=voice_name,
                    rate=settings.capcut_tts_default_rate,
                    log_fn=log_fn,
                )
        else:
            audio_files = synthesize_srt_capcut(
                video_id,
                progress_callback=lambda i, total: cb(40 + int((i / total) * 35)) if total else None,
                voice_name=voice_name,
                rate=settings.capcut_tts_default_rate,
                log_fn=log_fn,
            )
    else:
        audio_files = synthesize_srt(
            video_id,
            progress_callback=lambda i, total: cb(40 + int((i / total) * 35)) if total else None,
            voice_name=voice_name,
            log_fn=log_fn,
        )
    cb(75)

    full_voice = out_dir / "full_voice.mp3"
    full_voice_meta = out_dir / "full_voice.meta.json"

    def _voice_matches() -> bool:
        try:
            m = json.loads(full_voice_meta.read_text(encoding="utf-8"))
            return m.get("voice") == voice_name and m.get("engine") == tts_engine
        except FileNotFoundError:
            # full_voice produced before the meta marker existed — keep legacy
            # reuse behaviour (matches the old mtime-only check).
            return True
        except Exception:
            return False

    # Only (re)synthesize when full_voice is missing/stale or the voice/engine
    # changed. Keeps re-runs of the dub step fast when per-entry mp3 cache was
    # cleaned up (e.g. a crashed run that already produced a full voice track).
    voice_dir = out_dir / voice_name.replace("-", "_")
    newest_mp3 = max(
        (p.stat().st_mtime for p in (voice_dir.glob("*.mp3") if voice_dir.exists() else [])),
        default=0.0,
    )
    full_voice_ok = (
        full_voice.exists() and full_voice.stat().st_size > 0
        and full_voice.stat().st_mtime >= newest_mp3
        and _voice_matches()
    )
    # Chống tái sử dụng full_voice.mp3 bị cụt (vd lần trước bị timeout giữa chừng):
    # file phải đủ dài phủ tới dòng phụ đề cuối mới được tái dùng.
    if full_voice_ok:
        expected_end = max((e.end for e in entries), default=0.0)
        full_voice_dur = _get_audio_duration(full_voice)
        if full_voice_dur < expected_end - max(1.5, expected_end * 0.02):
            if log_fn:
                log_fn(
                    f"full_voice.mp3 cũ bị cụt ({full_voice_dur:.1f}s < {expected_end:.1f}s) "
                    f"— tạo lại giọng...",
                    level="warning",
                )
            full_voice_ok = False
    if full_voice_ok:
        if not full_voice_meta.exists():
            full_voice_meta.write_text(
                json.dumps({"voice": voice_name, "engine": tts_engine}, ensure_ascii=False),
                encoding="utf-8",
            )
        if log_fn:
            log_fn("Đã có full_voice.mp3 từ lần chạy trước — tái sử dụng (bỏ qua tổng hợp giọng).")
    else:
        if tts_engine == "capcut":
            audio_files = synthesize_srt_capcut(
                video_id,
                progress_callback=lambda i, total: cb(40 + int((i / total) * 35)) if total else None,
                voice_name=voice_name,
                rate=settings.capcut_tts_default_rate,
                log_fn=log_fn,
            )
        else:
            audio_files = synthesize_srt(
                video_id,
                progress_callback=lambda i, total: cb(40 + int((i / total) * 35)) if total else None,
                voice_name=voice_name,
                log_fn=log_fn,
            )
        cb(75)
        if log_fn:
            log_fn(f"Gộp {len(audio_files)} đoạn giọng nói theo thời gian phụ đề...")
        combine_tts_mp3(audio_files, entries, full_voice)
        full_voice_meta.write_text(
            json.dumps({"voice": voice_name, "engine": tts_engine}, ensure_ascii=False),
            encoding="utf-8",
        )
        if log_fn:
            log_fn("Đã gộp giọng nói hoàn chỉnh (full_voice.mp3).")
    cb(85)

    # Guard: the full voice track MUST exist before we mix it with the
    # background and mux into the video (auto-dub contract).
    if not full_voice.exists() or full_voice.stat().st_size == 0:
        raise RuntimeError("full_voice.mp3 chưa được tạo — không thể trộn audio lồng tiếng.")

    full_audio = out_dir / "full_audio.m4a"
    instrumental_mtime = instrumental.stat().st_mtime if instrumental.exists() else 0.0
    if (
        full_audio.exists() and full_audio.stat().st_size > 0
        and full_audio.stat().st_mtime >= full_voice.stat().st_mtime
        and full_audio.stat().st_mtime >= instrumental_mtime
    ):
        if log_fn:
            log_fn("Đã có full_audio.m4a từ lần chạy trước — tái sử dụng (bỏ qua trộn nhạc).")
    else:
        if log_fn:
            log_fn("Trộn nhạc nền + giọng nói → full_audio.m4a...")
        _mix_background_with_voice(instrumental, full_voice, background_volume, full_audio)
        if log_fn:
            log_fn("Đã trộn xong audio lồng tiếng.")
    cb(100)
    return full_audio


def dub_audio_only(
    video_id: str,
    voice_name: str = "vi-VN-Standard-B",
    tts_engine: str = "google",
    mute_original: bool = True,
    original_gain_db: float = 0.0,
    multi_voice: bool = False,
    progress_callback=None,
    log_fn=None,
) -> Path:
    """Separate vocals → synthesize Vietnamese TTS → mix into dubbed audio (no video merge)."""
    full_audio = build_full_audio(
        video_id,
        voice_name,
        tts_engine,
        mute_original=mute_original,
        original_gain_db=original_gain_db,
        multi_voice=multi_voice,
        progress_callback=progress_callback,
        log_fn=log_fn,
    )
    return full_audio


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

        job_log_sync(loop, jobs, ws_clients, job_id, "Bắt đầu tạo audio lồng tiếng Việt (tách giọng + TTS + trộn)...")

        def _log(msg: str, level: str = "info"):
            job_log_sync(loop, jobs, ws_clients, job_id, msg, level=level)

        out = dub_audio_only(
            video_id,
            voice_name=job.get("tts_voice", "vi-VN-Standard-B"),
            tts_engine=job.get("tts_engine", "google"),
            mute_original=job.get("mute_original", True),
            original_gain_db=job.get("original_gain_db", 0.0),
            multi_voice=job.get("multi_voice", False),
            progress_callback=progress,
            log_fn=_log,
        )

        job["status"] = "done"
        job["progress"] = 100
        job["output_path"] = str(out)
        job_log_sync(loop, jobs, ws_clients, job_id, "Tạo audio lồng tiếng Việt hoàn tất!", level="success")
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
