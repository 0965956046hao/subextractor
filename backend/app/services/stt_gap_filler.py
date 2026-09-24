"""Fill OCR gaps with local audio STT (faster-whisper).

Only transcribes gaps that actually contain speech (vad_filter + no_speech_prob).
Silent/music gaps are skipped automatically.
"""

import logging
import subprocess
import tempfile
import time
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

_whisper_model = None
_whisper_model_name: str | None = None


def _get_model(model_name: str, log_fn=None):
    global _whisper_model, _whisper_model_name
    if _whisper_model is not None and _whisper_model_name == model_name:
        return _whisper_model
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper not installed. Run: pip install faster-whisper"
        ) from e
    msg = f"Đang tải faster-whisper model '{model_name}' (lần đầu ~460MB, có thể mất 1-3 phút)..."
    logger.info(msg)
    if log_fn:
        log_fn(msg)
    # Keep model in memory after first load; subsequent calls reuse it.
    t0 = time.time()
    _whisper_model = WhisperModel(model_name, device="cpu", compute_type="int8")
    _whisper_model_name = model_name
    dt = time.time() - t0
    msg2 = f"Đã tải model '{model_name}' xong ({dt:.1f}s)"
    logger.info(msg2)
    if log_fn:
        log_fn(msg2, level="success")
    return _whisper_model


def find_gaps(
    entries: list[tuple[float, float, str]],
    duration: float,
    min_gap: float = 0.5,
    start_offset: float = 0.0,
) -> list[tuple[float, float]]:
    """Return gaps where no OCR subtitle exists.

    entries must be sorted by start. Gaps include head (start_offset→first) and tail (last→duration).
    Only gaps >= min_gap are returned.
    """
    if duration <= 0:
        return []
    if not entries:
        if duration - start_offset >= min_gap:
            return [(start_offset, duration)]
        return []

    sorted_entries = sorted(entries, key=lambda e: e[0])
    gaps: list[tuple[float, float]] = []

    # head
    if sorted_entries[0][0] - start_offset >= min_gap:
        gap = (start_offset, sorted_entries[0][0])
        if gap[1] - gap[0] >= min_gap:
            gaps.append(gap)

    for i in range(len(sorted_entries) - 1):
        prev_end = sorted_entries[i][1]
        next_start = sorted_entries[i + 1][0]
        if next_start - prev_end >= min_gap:
            gaps.append((prev_end, next_start))

    # tail
    last_end = sorted_entries[-1][1]
    if duration - last_end >= min_gap:
        gaps.append((last_end, duration))

    return gaps


def _has_audio_stream(path: str) -> bool:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=10,
        )
        return "audio" in out.stdout
    except Exception:
        return False


def _resolve_audio_source(video_path: str, video_id: str | None = None) -> str:
    """Find best audio source: prefer vocals (demucs) > merged audio > video."""
    candidates: list[str] = []
    if video_id:
        try:
            from app.config import settings
            vocals = settings.temp_dir / "tts" / video_id / "separated" / "htdemucs" / "audio" / "vocals.wav"
            if vocals.exists() and vocals.stat().st_size > 1000:
                # Vocal sạch đã có từ lần dub trước — ưu tiên nhất (0 cost)
                return str(vocals)
        except Exception:
            pass
    if video_path:
        candidates.append(video_path)
    if video_id:
        try:
            from app.services.media_utils import _merge_audio_path, _video_path
            ma = _merge_audio_path(video_id)
            if ma and str(ma) not in candidates:
                candidates.insert(0, str(ma))  # audio file prioritized
            vp = _video_path(video_id)
            if str(vp) not in candidates:
                candidates.append(str(vp))
        except Exception:
            pass
    # Also try merged audio via temp/videos meta
    if video_id:
        try:
            import json
            from app.config import settings
            meta = settings.temp_dir / "videos" / video_id / "meta.json"
            data = json.loads(meta.read_text(encoding="utf-8"))
            mid = data.get("source_merge_id")
            if mid:
                ap = settings.temp_dir / "merged" / f"{mid}_audio.mp4"
                if ap.exists() and str(ap) not in candidates:
                    candidates.insert(0, str(ap))
        except Exception:
            pass
    for c in candidates:
        if Path(c).exists() and _has_audio_stream(c):
            return c
    # Fallback to first existing candidate even if probe fails
    for c in candidates:
        if Path(c).exists():
            return c
    return video_path


def _demucs_vocals_slice(wav_path: Path, log_fn=None) -> Path | None:
    """Try to separate vocals from a slice wav via demucs (lightweight per-slice).

    Returns path to vocals.wav if success, else None. Auto-skipped if demucs not installed.
    """
    import shutil
    if shutil.which("demucs") is None:
        return None
    def _slog(m, lvl="info"):
        if log_fn:
            try:
                log_fn(m, lvl)
            except TypeError:
                log_fn(m)
    # Use a temp out dir per slice to avoid collisions
    import tempfile as _tf
    out_dir = Path(_tf.mkdtemp(prefix="demucs_slice_"))
    try:
        # demucs expects the wav to have a proper stem; copy to a named file
        work_wav = out_dir / "audio.wav"
        # Ensure 16k mono already; just copy
        import shutil as _sh
        _sh.copy(str(wav_path), str(work_wav))
        cmd = ["demucs", "--two-stems=vocals", "-o", str(out_dir), str(work_wav)]
        _slog(f"    Demucs tách vocal slice {wav_path.name}...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            _slog(f"    Demucs slice fail: {(result.stderr or '')[-300:]}", "warning")
            return None
        # demucs output: out_dir/htdemucs/audio/vocals.wav
        vocals = out_dir / "htdemucs" / "audio" / "vocals.wav"
        if vocals.exists() and vocals.stat().st_size > 500:
            # Move to a stable temp path outside out_dir for caller to use
            dst = Path(_tf.mktemp(suffix="_vocals.wav"))
            _sh.copy(str(vocals), str(dst))
            return dst
        return None
    except Exception as e:
        logger.warning("demucs slice failed: %s", e)
        return None
    finally:
        try:
            import shutil as _sh2
            _sh2.rmtree(out_dir, ignore_errors=True)
        except Exception:
            pass


def _extract_audio_slice(
    video_path: str, start: float, end: float, wav_path: Path
) -> bool:
    """Extract mono 16k wav slice via ffmpeg. Returns True on success."""
    dur = end - start
    if dur <= 0.05:
        return False
    # Try -ss after -i for accurate seek if before -i fails (no audio case)
    cmds = [
        ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", video_path, "-t", f"{dur:.3f}", "-vn", "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", str(wav_path)],
        ["ffmpeg", "-y", "-i", video_path, "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-vn", "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", str(wav_path)],
    ]
    for cmd in cmds:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0 and wav_path.exists() and wav_path.stat().st_size > 500:
                return True
            # Log ffmpeg stderr for debugging
            err = (result.stderr or "")[:500]
            logger.warning("ffmpeg slice attempt failed [%s→%s] cmd=%s err=%s", start, end, " ".join(cmd[:6]), err)
        except Exception as e:
            logger.warning("ffmpeg slice [%s→%s] failed: %s", start, end, e)
    return False


def transcribe_gap(
    wav_path: str,
    gap_start: float,
    gap_end: float,
    language: str | None = None,
    model_name: str = "small",
    no_speech_threshold: float = 0.6,
    log_fn=None,
) -> list[tuple[float, float, str]]:
    """Transcribe a single wav slice. Returns list of (start, end, text).

    Timestamps are absolute (offset by gap_start). Segments with no_speech_prob
    > threshold are skipped (silent/music).
    """
    model = _get_model(model_name, log_fn=log_fn)

    def _slog2(msg, level="info"):
        if log_fn:
            try:
                log_fn(msg, level)
            except TypeError:
                log_fn(msg)

    # Try with VAD first; if no result, retry without VAD (covers low-volume speech)
    for attempt, use_vad in enumerate([True, False] if language else [True]):
        kwargs: dict = dict(
            vad_filter=use_vad,
            vad_parameters=dict(min_silence_duration_ms=500) if use_vad else {},
        )
        # If auto language gave no result, retry with zh on second attempt
        lang_try = language
        if attempt == 1 and not language:
            lang_try = "zh"
            _slog2(f"    Thử lại gap {gap_start:.1f}s với language=zh (không VAD)...")
        if lang_try:
            kwargs["language"] = lang_try

        import concurrent.futures as _cf
        out: list[tuple[float, float, str]] = []
        raw_cnt = 0
        filtered_nsp = 0
        filtered_re = 0

        def _do():
            nonlocal raw_cnt, filtered_nsp, filtered_re
            segs, info = model.transcribe(wav_path, **kwargs)
            # Log detected language
            if log_fn and hasattr(info, "language"):
                _slog2(f"    Whisper detect language={info.language} (prob {getattr(info,'language_probability',0):.2f})")
            res: list[tuple[float, float, str]] = []
            for seg in segs:
                raw_cnt += 1
                text = (seg.text or "").strip()
                if not text:
                    continue
                nsp = getattr(seg, "no_speech_prob", 0.0) or 0.0
                if nsp > no_speech_threshold:
                    filtered_nsp += 1
                    continue
                s = float(seg.start) + gap_start
                e = float(seg.end) + gap_start
                s = max(gap_start, min(s, gap_end))
                e = max(s + 0.2, min(e, gap_end))
                if e - s < 0.2:
                    continue
                import re as _re
                if not _re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ\u4e00-\u9fff]", text):
                    filtered_re += 1
                    continue
                res.append((s, e, text))
            return res

        try:
            with _cf.ThreadPoolExecutor(max_workers=1) as ex:
                fut = ex.submit(_do)
                out = fut.result(timeout=60)
        except _cf.TimeoutError:
            logger.warning("whisper transcribe timeout [%s→%s]", gap_start, gap_end)
            _slog2(f"    STT timeout gap {gap_start:.1f}s→{gap_end:.1f}s — bỏ qua", "warning")
            return []
        except Exception as e:
            logger.warning("whisper transcribe failed for gap [%s→%s]: %s", gap_start, gap_end, e)
            _slog2(f"    STT lỗi gap {gap_start:.1f}s: {e}", "warning")
            return []

        # Log why empty
        if not out:
            if raw_cnt == 0:
                _slog2(f"    Whisper trả 0 segment (raw 0, VAD={use_vad}, lang={lang_try or 'auto'})")
            else:
                _slog2(f"    Whisper raw {raw_cnt} seg, lọc nsp>{no_speech_threshold}:{filtered_nsp}, lọc regex:{filtered_re} (VAD={use_vad})")
            # If first attempt (VAD) gave no result, loop will retry without VAD / zh
            if attempt == 0 and use_vad:
                continue
            return []
        return out
    return []


def fill_gaps(
    video_path: str,
    ocr_entries: list[tuple[float, float, str]],
    duration: float,
    min_gap: float = 0.5,
    language: str | None = None,
    model_name: str = "small",
    no_speech_threshold: float = 0.6,
    log_fn=None,
    start_offset: float = 0.0,
    video_id: str | None = None,
) -> list[tuple[float, float, str]]:
    """Find gaps and STT-fill those with speech. Returns combined sorted entries.

    If faster-whisper is unavailable or all gaps are silent, returns ocr_entries unchanged.
    """
    def _slog(msg, level="info"):
        if log_fn:
            try:
                log_fn(msg, level)
            except TypeError:
                log_fn(msg)

    gaps = find_gaps(ocr_entries, duration, min_gap, start_offset)
    if not gaps:
        _slog("Không có khoảng trống đủ lớn để STT (gap < min_gap).")
        return ocr_entries

    # Guard: too many gaps (e.g. sparse OCR) — cap to avoid transcribing entire video
    MAX_GAPS = 20
    MAX_TOTAL_GAP_SEC = 120.0  # at most 2 minutes of audio STT per job
    if len(gaps) > MAX_GAPS:
        _slog(f"Phát hiện {len(gaps)} gap — chỉ STT {MAX_GAPS} gap lớn nhất để tránh treo.", "warning")
        gaps = sorted(gaps, key=lambda g: g[1] - g[0], reverse=True)[:MAX_GAPS]
        gaps.sort(key=lambda g: g[0])
    total_gap = sum(g[1] - g[0] for g in gaps)
    if total_gap > MAX_TOTAL_GAP_SEC:
        # Trim longest gaps to stay within budget (keep earliest gaps prioritized after sort)
        _slog(f"Tổng gap {total_gap:.1f}s vượt {MAX_TOTAL_GAP_SEC}s — sẽ cắt bớt.", "warning")
        trimmed: list[tuple[float, float]] = []
        acc = 0.0
        for g in gaps:
            dur = g[1] - g[0]
            if acc + dur > MAX_TOTAL_GAP_SEC:
                # cut this gap
                remain = MAX_TOTAL_GAP_SEC - acc
                if remain >= min_gap:
                    trimmed.append((g[0], g[0] + remain))
                break
            trimmed.append(g)
            acc += dur
        gaps = trimmed

    _slog(f"Phát hiện {len(gaps)} khoảng trống ≥{min_gap}s (tổng {sum(g[1]-g[0] for g in gaps):.1f}s), kiểm tra audio STT...")
    # Resolve audio source (merged video has no audio track)
    audio_source = _resolve_audio_source(video_path, video_id)
    if audio_source != video_path:
        _slog(f"  Dùng audio source: {Path(audio_source).name} (thay vì {Path(video_path).name})")
    elif not _has_audio_stream(audio_source):
        _slog("  Cảnh báo: không tìm thấy audio stream trong video — STT có thể thất bại", "warning")

    # Quick check: is model available? (also warms cache + shows download progress)
    try:
        _get_model(model_name, log_fn=log_fn)
    except Exception as e:
        _slog(f"STT gap-fill bỏ qua: {e}", "warning")
        logger.warning("STT gap-fill skipped: %s", e)
        return ocr_entries

    stt_entries: list[tuple[float, float, str]] = []
    lang = language if language else None

    for idx, (g_start, g_end) in enumerate(gaps):
        _slog(f"  Gap {idx+1}/{len(gaps)}: {g_start:.1f}s → {g_end:.1f}s ({g_end-g_start:.1f}s)")
        # Skip extremely long gaps? No, transcribe anyway — but cap slice length
        # to avoid huge wav: split >30s gaps into 30s chunks
        max_slice = 30.0
        slices: list[tuple[float, float]] = []
        cur = g_start
        while cur < g_end:
            nxt = min(cur + max_slice, g_end)
            slices.append((cur, nxt))
            cur = nxt

        for s_start, s_end in slices:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                wav_path = Path(tf.name)
            try:
                ok = _extract_audio_slice(audio_source, s_start, s_end, wav_path)
                if not ok:
                    _slog(f"    ffmpeg slice {s_start:.1f}s→{s_end:.1f}s thất bại (không có audio?)", "warning")
                    continue
                # Log wav size for debugging silent slices
                try:
                    sz = wav_path.stat().st_size
                    if sz < 5000:
                        _slog(f"    wav slice {s_start:.1f}s rất nhỏ ({sz} bytes) — có thể im lặng")
                except Exception:
                    pass
                segs = transcribe_gap(
                    str(wav_path), s_start, s_end, lang, model_name, no_speech_threshold, log_fn=log_fn
                )
                # Tự động lọc nhạc nền: chỉ khi raw có thoại nhưng nghi là nhạc
                if segs:
                    need_demucs = False
                    # Heuristic: với video zh mà STT ra toàn latin (lời bài hát tiếng Anh) → nghi nhạc
                    if lang == "zh":
                        has_cjk = any("\u4e00" <= ch <= "\u9fff" for t in segs for ch in t[2])
                        if not has_cjk:
                            need_demucs = True
                            _slog(f"    Raw STT toàn latin cho video zh ({len(segs)} dòng) → nghi nhạc nền, thử tách vocal")
                    # Nếu gap có nhiều hơn 1 dòng và raw text rất ngắn/lặp → cũng nghi nhạc
                    if not need_demucs and len(segs) == 1 and len(segs[0][2]) < 8:
                        # Kiểm tra nếu trước đó đã có vocal full video sẵn thì cũng thử
                        import pathlib as _pl
                        from app.config import settings as _st
                        vocals_full = _st.temp_dir / "tts" / (video_id or "") / "separated" / "htdemucs" / "audio" / "vocals.wav"
                        if vocals_full.exists():
                            need_demucs = True
                    if need_demucs:
                        vocals_path = _demucs_vocals_slice(wav_path, log_fn=log_fn)
                        if vocals_path:
                            try:
                                v_segs = transcribe_gap(
                                    str(vocals_path), s_start, s_end, lang, model_name, no_speech_threshold, log_fn=log_fn
                                )
                                if not v_segs:
                                    _slog(f"    Demucs: raw có {len(segs)} dòng nhưng vocal im lặng → bỏ (nhạc nền)", "warning")
                                    segs = []
                                else:
                                    _slog(f"    Demucs: dùng vocal sạch ({len(v_segs)} dòng thay {len(segs)} raw)")
                                    segs = v_segs
                            finally:
                                try:
                                    vocals_path.unlink(missing_ok=True)
                                except Exception:
                                    pass
                    for _s, _e, _t in segs:
                        _slog(f"    🎙️ STT [{_s:.1f}→{_e:.1f}] {_t[:80]}", "text")
                stt_entries.extend(segs)
            finally:
                try:
                    wav_path.unlink(missing_ok=True)
                except Exception:
                    pass

    if not stt_entries:
        _slog("STT không phát hiện thoại trong các gap — giữ nguyên OCR.", "info")
        return ocr_entries

    # Merge and sort
    combined = list(ocr_entries) + stt_entries
    combined.sort(key=lambda e: (e[0], e[1]))

    # De-duplicate: if STT entry overlaps heavily with OCR, prefer OCR (already has sub)
    # Since STT only runs on gaps, overlap should be minimal, but guard anyway.
    # Just sort — postprocess_entries will merge similar adjacent if needed.

    _slog(f"STT đã lấp {len(stt_entries)} dòng mới trong {len(gaps)} gap.", "success")

    return combined
