# Design: Lấp chỗ thiếu sub bằng Audio STT + Gemini Translate

**Date:** 2026-09-15
**Status:** Approved
**Scope:** Pipeline OCR — tự động lấp gap không có sub cứng bằng audio speech-to-text (local) rồi dịch

## 1. Mục tiêu
Video bị thiếu sub cứng ở một số đoạn → output SRT cũng thiếu tương ứng. Khi **có thoại nhưng không có sub OCR** trong gap, tự động dùng audio STT để tạo sub, rồi dịch luôn bằng Gemini. Gap im lặng/nhạc nền thì bỏ qua. Lưu cả 2 bản: SRT gốc (OCR + STT gốc) và SRT dịch.

## 2. Yêu cầu đã chốt
- Trigger: **có speech trong gap** mới STT, không phải mọi gap theo độ dài.
- Engine STT: **local `faster-whisper small`** (`vad_filter=True` để loại silence, `no_speech_prob` để filter). Không thêm Silero VAD ở v1.
- Dịch: **Gemini** (reuse `translation_service.py`), không dùng `whisper translate`.
- Lưu: `srt/{id}/subtitles.srt` = OCR + STT gốc; `translated/{id}/subtitles_vi.srt` = bản dịch (bao gồm cả dòng STT đã dịch).
- Toggle: opt-in per job (`fill_gaps: bool`, default False) để tránh tốn CPU khi không cần.
- Worker single-thread, 1 job tại 1 thời điểm nên không lo parallel overload.

## 3. Kiến trúc

```
frame stream → OCR → generate_srt_entries (OCR entries)
                ↓
        detect_gaps(entries, duration, min_gap=0.5s)
                ↓ (mỗi gap)
        ffmpeg slice gap audio (16k mono wav temp) → faster-whisper small
                ↓ vad_filter + no_speech_prob<0.6 + text non-empty
        STT entries (source="stt")
                ↓
        merge OCR+STT (sort by start) → postprocess_entries → subtitles.srt
                ↓ (nếu translate_on)
        Gemini dịch: chỉ dịch các entry STT mới (hoặc toàn bộ nếu chưa dịch)
                ↓
        translated/subtitles_{lang}.srt
```

## 4. Data Model

### Config (`app/config.py`)
```python
stt_enabled: bool = False          # STE_stt_enabled, default False (opt-in global)
stt_model: str = "small"           # STE_stt_model: tiny/small/medium
stt_min_gap: float = 0.5           # STE_stt_min_gap (giây)
stt_no_speech_threshold: float = 0.6
stt_language: str = ""             # "" = auto, hoặc "zh"/"en"/"vi"
```

### ProcessRequest (`app/models.py`)
```python
class ProcessRequest(BaseModel):
    ...
    fill_gaps: bool = False        # bật STT gap-fill cho job này
    stt_language: str | None = None
```

### Internal
- `SrtEntry` giữ nguyên; STT entry là tuple `(start, end, text)` như OCR, thêm log tag `source=stt` để filter khi dịch.

## 5. Service mới — `services/stt_gap_filler.py`

```python
_whisper_model = None  # singleton
def _get_model(name: str):  # faster_whisper.WhisperModel(name, device="cpu", compute_type="int8")

def find_gaps(entries: list[tuple[float,float,str]], duration: float, min_gap: float) -> list[tuple[float,float]]:
    # gap = (prev_end, next_start) nếu next_start - prev_end >= min_gap
    # bao gồm head (0 → first.start) và tail (last.end → duration)

def extract_audio_slice(video_path: str, start: float, end: float, tmp_path: Path): # ffmpeg -ss start -to end -vn -ar 16000 -ac 1

def transcribe_gap(audio_path: str, language: str | None) -> list[tuple[float,float,str]]:
    # model.transcribe(audio_path, language=language, vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500))
    # filter segment.no_speech_prob > threshold -> skip
    # return segments with (seg.start+gap_start, seg.end+gap_start, seg.text.strip())

def fill_gaps(video_path: str, ocr_entries: list, duration: float, min_gap: float, language: str|None, log_fn) -> list:
    # for each gap: extract → transcribe → collect
    # sort + merge với ocr_entries, return combined sorted list
```

- Model load lazy, reuse singleton.
- Mỗi gap tạo temp wav riêng, xóa sau khi xong (try/finally).
- Timeout ffmpeg 60s, whisper 120s/gap.

## 6. Tích hợp Worker — `worker.py:process_job_sync`

- Sau khi `entries = ...` (cả branch sequential và parallel + `merge_parallel_entries`), nếu `job.get("fill_gaps") and settings.stt_enabled` hoặc `fill_gaps` tự quyết:
  ```python
  if job.get("fill_gaps"):
      from app.services.stt_gap_filler import fill_gaps
      duration = _get_duration(video_path)
      stt_entries = fill_gaps(video_path, entries, duration, settings.stt_min_gap, job.get("stt_language") or settings.stt_language, log_fn)
      # log số dòng STT thêm
  ```
- `log_fn` gọi `job_log` + WS `phase="stt_fill"`.
- Nếu STT fail → catch log warning, giữ nguyên `entries`, không fail job.
- Sau đó `postprocess_entries`/`format_srt` như cũ, nhưng nếu đã fill thì chạy postprocess trên combined.

## 7. Dịch — `translation_service.py`

- Không đổi logic chính. Khi job translate chạy sau OCR, nó đã đọc `subtitles.srt` (đã gồm STT gốc) nên tự dịch toàn bộ. 
- Optimize (optional): nếu chỉ muốn dịch dòng STT mới, có thể thêm hàm `translate_new_lines` nhưng v1 để translate toàn bộ cho đơn giản (idempotent).

## 8. Frontend (phase 2, không bắt buộc v1)
- `RegionSelector` / `AutoPipeline` thêm toggle "Lấp chỗ thiếu sub (STT)" → truyền `fill_gaps` trong `POST /api/process`.
- Hiển thị badge "STT" cho dòng được tạo từ audio trong `TranscriptPlayer`.

## 9. Error Handling
- Gap < min_gap → skip.
- Audio slice rỗng / ffmpeg fail → skip gap, log warn.
- Whisper `no_speech_prob > 0.6` hoặc text rỗng → skip.
- Model load fail (thiếu `faster-whisper`) → log error, skip STT, không fail job.
- Temp wav luôn cleanup.

## 10. Testing
- Manual: video có 2-3 gap thiếu sub (đã có file test) → bật fill_gaps → kiểm tra SRT có thêm dòng STT, gap im lặng không sinh rác.
- Edge: video toàn im lặng → 0 dòng STT.
- Unit: `find_gaps` với entries rỗng / 1 entry / nhiều entry.

## 11. Files thay đổi (v1)
- `backend/app/config.py` (stt_* settings)
- `backend/app/models.py` (ProcessRequest.fill_gaps)
- `backend/app/services/stt_gap_filler.py` (new)
- `backend/app/worker.py` (gọi fill_gaps sau OCR)
- `backend/requirements.txt` (thêm `faster-whisper`)
- `backend/app/routers/process.py` (truyền fill_gaps vào job)

## 12. Future
- Silero VAD pre-filter nếu whisper miss.
- `stt_language` auto-detect per gap.
- Tag `source` trong SRT (comment) để FE phân biệt OCR vs STT.
