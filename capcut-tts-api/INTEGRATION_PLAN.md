# INTEGRATION_PLAN — Thay Google TTS bằng CapCut Gen-Voice Service

> **Mục tiêu:** thay thế Google Cloud TTS trong pipeline SubTitleExtractor bằng
> service `capcut-tts-api` (FastAPI, port 8100) để gen giọng CapCut, giữ nguyên
> luồng xử lý clip hiện tại (per-entry MP3 → FFmpeg gộp theo timestamp SRT).

---

## I. Hiện trạng pipeline (đã đọc code)

- `backend/app/services/tts_service.py`:
  - `synthesize_srt()` — Google TTS, gen **1 MP3 / 1 entry SRT** → `temp/tts/{video_id}/{voice_key}/{index:04d}.mp3` (line 82).
  - `combine_tts_mp3()` — dùng FFmpeg `adelay` theo `entry.start` + `atempo` để gộp các MP3 thành `full_voice.mp3` (line 367).
  - `build_full_audio()` / `dub_video_with_tts()` — Demucs tách nhạc + gọi `synthesize_srt` + `combine_tts_mp3` + mix (line 461-529).
- `backend/app/worker.py` — `run_tts_job`/`run_dub_job` gọi `run_tts_sync`/`run_dub_sync` qua `ThreadPoolExecutor(max_workers=1)`.
- `backend/app/routers/tools.py` — nhận `voice` (mặc định `vi-VN-Standard-A`/`B`) từ frontend, lưu vào job `tts_voice`.
- `backend/app/config.py:26` — `google_tts_credentials`.

---

## II. Kiến trúc mới

```
┌────────────────────┐   HTTP POST /api/tts   ┌──────────────────────────┐
│  SubTitleExtractor  │ ─────────────────────▶ │  capcut-tts-api service  │
│  (FastAPI :8000)    │                        │  (FastAPI :8100)         │
│                     │ ◀───────────────────── │  job queue + WS + worker │
│  synthesize_srt →   │   GET /api/tts/{job}   │  CapCut API (editor-api) │
│  capcut_tts_client  │   + audio files        └──────────────────────────┘
└────────────────────┘
```

- Pipeline **giữ nguyên** `combine_tts_mp3`, Demucs, mix — chỉ thay nguồn sinh
  MP3 per-entry từ Google TTS → gọi HTTP tới service CapCut.
- Service CapCut gen mỗi segment thành 1 task riêng (`succeed` → parse
  `speech_url` → download MP3), trả file theo convention `NNNN.mp3`.

---

## III. Các bước thực hiện (theo thứ tự)

### Bước 1 — Cấu hình & client (1h)

1. Thêm vào `backend/app/config.py`:
   ```python
   capcut_tts_url: str = "http://localhost:8100"
   capcut_tts_default_voice: str = "BV421_vivn_streaming"
   ```
   (prefix `STE_` → env `STE_capcut_tts_url`).

2. Tạo `backend/app/services/capcut_tts_client.py`:
   - Dùng `httpx` (đã có trong stack FastAPI) hoặc `requests`.
   - Hàm `submit_tts(texts: list[str], voice: str, rate: str) -> job_id` → `POST /api/tts`.
   - Hàm `poll_until_done(job_id, timeout) -> dict` → `GET /api/tts/{job_id}`.
   - Hàm `download_audio(job_id, filename, out_path)` → `GET /api/tts/{job_id}/audio/{filename}`.
   - Hàm `list_voices(lang)` → `GET /api/voices`.

### Bước 2 — Thay `synthesize_srt` (2h)

Trong `tts_service.py`, thêm hàm song song (KHÔNG xóa Google TTS — giữ fallback):

```python
def synthesize_srt_capcut(video_id, progress_callback=None,
                          use_custom_srt=False, voice_name="BV421_vivn_streaming",
                          rate="1.0") -> List[Path]:
    # 1. đọc SRT (giống synthesize_srt hiện tại)
    # 2. submit 1 job tất cả text entries → service CapCut
    # 3. poll tới done (map progress_callback)
    # 4. download từng file segment_{i:04d}.mp3 → out_dir/{i:04d}.mp3
    # 5. segment lỗi → tạo silence placeholder (giữ _create_silence)
```

- Convention đổi tên file: service trả `segment_0001.mp3`, rename về `0001.mp3`
  cho khớp `combine_tts_mp3` (chỉ cần truyền đúng path list).
- `run_tts_sync` / `build_full_audio` chuyển sang gọi `synthesize_srt_capcut`.

### Bước 3 — Voice mapping (30m)

- `routers/tools.py`: đổi mặc định `voice` sang CapCut voice (`BV421_vivn_streaming`),
  hoặc giữ field `voice` nhưng thêm select box voices lấy từ `GET /api/voices`.
- Frontend nếu cần: liệt kê giọng CapCut từ endpoint `/api/voices` thay vì
  cứng `vi-VN-Standard-*`.

### Bước 4 — Khởi động service cùng pipeline (30m)

- `dev.sh`: thêm bước chạy `capcut-tts-api/run_service.sh` (hoặc uvicorn
  `service.main:app --port 8100`) trước/song song backend.
- Option: thêm `backend/requirements.txt`: `httpx`.

### Bước 5 — Fallback & error handling (1h)

- Nếu service CapCut không reachable hoặc job fail → **fallback về Google TTS**
  hiện tại (giữ nguyên code cũ, chỉ catch exception quanh `synthesize_srt_capcut`).
- Đảm bảo `JobCancelled` trong worker vẫn hoạt động: gọi `POST /api/tts/{id}/cancel`.

### Bước 6 — Kiểm thử (1h)

- Start service: `cd capcut-tts-api && ./run_service.sh`
- `curl POST :8100/api/tts` 1-2 segment → verify MP3.
- Chạy pipeline TTS với 1 video ngắn có SRT → đối chiếu `full_voice.mp3` đúng
  thứ tự/timestamp.
- Test fallback: tắt service CapCut → pipeline vẫn dùng Google TTS.

---

## IV. Rủi ro & lưu ý

| Rủi ro | Ảnh hưởng | Giảm thiểu |
|--------|-----------|------------|
| CapCut đổi thuật toán sign/status (hiện `succeed` không phải `success`) | Service hỏng | Giữ SDK + status check linh hoạt; đã fix `_SUCCESS_STATUSES` |
| Rate limit / chặn IP của CapCut | Job fail | Fallback Google TTS; retry segment; tăng poll_interval |
| TTS không có `need_subtitle_timestamp` → không có word-level timing | Chỉ cần audio, không sao | Pipeline tự đặt timing bằng SRT qua `combine_tts_mp3` |
| Giọng CapCut phụ thuộc `Voice.json` tĩnh | Thiếu giọng mới | Capture thủ công khi cần |
| Service chạy port riêng | Deploy phức tạp hơn | Cùng host trong `dev.sh`; có thể gộp module sau |

---

## V. File bị ảnh hưởng

- `backend/app/config.py` — +2 fields.
- `backend/app/services/tts_service.py` — +`synthesize_srt_capcut`, chuyển callers.
- `backend/app/services/capcut_tts_client.py` — **mới**.
- `backend/app/routers/tools.py` — voice mapping.
- `backend/app/routers/config_router.py` — (tuỳ chọn) hiển thị trạng thái service.
- `dev.sh` — khởi động service CapCut.
- `backend/requirements.txt` — +`httpx`.

---

## VI. Definition of Done

- [ ] `POST :8000` job TTS dùng giọng CapCut, ra MP3 đúng thứ tự entry.
- [ ] `dub` (Demucs + TTS + mix) hoạt động với giọng CapCut.
- [ ] Service CapCut chết → fallback Google TTS không crash pipeline.
- [ ] `./dev.sh` khởi động đủ cả 3 tiến trình (backend, frontend, capcut service).