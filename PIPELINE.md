# SubTitleExtractor — Pipeline Flow

## Tổng quan kiến trúc

Pipeline được chia thành 2 runner trong `pipeline-store.ts`:
- **`runPrep()`** (Bước 0-3): Tương tác với user — nhập link, chọn vùng, chỉnh style
- **`runPipeline()`** (Bước 4-11): Xử lý nặng — OCR, dịch, lồng tiếng, render, upload

Các bước 4-11 chạy tuần tự qua frontend sequential queue — chỉ 1 video xử lý tại 1 thời điểm.

---

## Các bước pipeline

### Bước 0: Phân tích link

| | |
|---|---|
| **Frontend** | `runPrep()` — parse URL, detect nguồn (Douyin/YouTube/Upload) |
| **YouTube** | `POST /api/video-download/yt-import` → `video_download.py:yt_import()` → yt-dlp tải video → `temp/videos/{id}/video.mp4` |
| **Douyin** | `POST /api/video-download/resolve` → Puppeteer mở link, bắt CDN URLs → `{video_url, audio_url, title}` |
| **Output** | `{videoId, videoUrl, audioUrl, title, srcLang, ocrLang, thumbnail, bigThumbs}` |

---

### Bước 1: Tải video (Merge)

| | |
|---|---|
| **Frontend** | `runPrep()` — nếu có 2 stream (video+audio riêng) thì merge |
| **Skip** | YouTube (đã có video完整) |
| **Backend** | `POST /api/video-merge` → `video_merge.py:merge_video_audio()` — FFmpeg merge → `temp/merged/{merge_id}.mp4` |
| **Import** | `POST /api/import-video` → copy video vào `temp/videos/{video_id}/video.mp4`, copy context images, ghi `meta.json` |
| **Output** | `videoId` gán xong, video lưu tại `temp/videos/{video_id}/video.mp4` |

---

### Bước 2: Chọn vùng quét sub

| | |
|---|---|
| **Frontend** | Tương tác — user kéo vùng phụ đề trên `RegionSelector` canvas |
| **Auto** | Dùng `DEFAULT_REGION: {x1:0.114, y1:0.748, x2:0.863, y2:0.972}` |
| **Manual** | `stage: "region"` → user kéo → `waitForRegion(id)` |
| **Backend** | Không gọi — frontend only |
| **Input** | `GET /api/frame/{videoId}` — frame JPEG đầu tiên |
| **Output** | `region: {x1, y1, x2, y2}` (tọa độ chuẩn hóa 0-1) |

---

### Bước 3: Chỉnh kích thước & vị trí phụ đề

| | |
|---|---|
| **Frontend** | User chỉnh font_size, margin_v qua `SubtitlePreview` |
| **Skip** | Nếu `autoFit` bật |
| **Backend** | `POST /api/preview/subtitle/{videoId}` — render frame với phụ đề overlay (OpenCV + Pillow) |
| **Output** | `subtitleStyle: {font_size, margin_v, ...}` |

---

### Bước 3.5: Chọn vùng watermark (sub-step)

| | |
|---|---|
| **Frontend** | Nếu `removeWatermarkEnabled` → user vẽ vùng watermark trên video |
| **Backend** | Không gọi |
| **Output** | `removeWatermarkRegions: Region[]` |

---

### Bước 3.6: Xoá watermark (Delogo)

| | |
|---|---|
| **Frontend** | Gọi delogo nếu có watermark regions |
| **Backend** | `POST /api/delogo/{videoId}` → `tools.py:delogo_video()` — FFmpeg delogo filter → `temp/hardcoded/{videoId}/*_hardcoded.mp4` |
| **Fallback** | Nếu delogo fail → log warning, tiếp tục với video gốc |

---

### Bước 4: OCR trích phụ đề

| | |
|---|---|
| **Frontend** | `POST /api/process` → `process.py:start_processing()` → enqueue job |
| **Backend worker** | `worker.py:run_job()` → `process_job_sync()` chạy trên `_executor` ThreadPoolExecutor(1) |
| **Flow** | 1. `resolve_video_path()` tìm video (ưu tiên delogo > merged > original) |
| | 2. `stream_frames_generator()` — OpenCV đọc frame theo fps |
| | 3. `crop_region()` — cắt vùng phụ đề từ mỗi frame |
| | 4. `ocr_engine.ocr_region_cached()` — OCR + dHash cache (bỏ qua frame giống ≤5 bit) |
| | 5. `generate_srt()` — gộp text liền kề giống ≥85%, phát hiện flash, lọc noise |
| **Poll** | `GET /api/status/{jobId}` mỗi 1.5s |
| **WebSocket** | `WS /api/ws/{jobId}` — progress, logs realtime |
| **Post-OCR** | `runSrtAutoChecks()` — dedup + fix overlaps trên SRT gốc |
| **Output** | `temp/srt/{videoId}/subtitles.srt` |

---

### Bước 5: Phân tích ngữ cảnh (Context)

| | |
|---|---|
| **Frontend** | `POST /api/context/{videoId}` → `context.py:start_context_job()` |
| **Backend worker** | `worker.py:run_context_job()` → `context_service.py:generate_video_context()` |
| **Flow** | 1. Upload big_thumbs (ảnh ngữ cảnh) lên Gemini File Store |
| | 2. Gọi Gemini Vision phân tích: thể loại, nhân vật, giọng nói, bối cảnh |
| | 3. Lưu `context/{videoId}/context.txt` |
| **Skip** | Nếu `translateOn=false` hoặc `sourceLang === translateTarget` |
| **Output** | `context/{videoId}/context.txt` — mô tả video bằng text |

---

### Bước 6: Dịch Gemini

| | |
|---|---|
| **Frontend** | `POST /api/translate/{videoId}` → `tools.py:translate_subtitles()` → enqueue translate job |
| **Backend worker** | `worker.py:run_translate_job()` → `translation_service.py:translate_srt()` |
| **Flow** | 1. Đọc SRT gốc, parse thành entries |
| | 2. `_build_base_prompt()` — build prompt với video context + patch context |
| | 3. Dịch batch 50 dòng → Gemini với retry (3 lần/batch) |
| | 4. `_reconcile_batch()` — giữ timeline gốc 1:1, fallback dòng chưa dịch |
| | 5. `append_translation_context()` — lưu ngữ cảnh cho batch tiếp |
| **Multi-voice** | Nếu `multi_voice=true` → gọi `generate_voice_map()` ngay sau khi dịch |
| **Output** | `temp/translated/{videoId}/subtitles_{lang}.srt` |
| **Lưu ý** | Không ghi đè `srt/{id}/subtitles.srt` (giữ nguyên SRT gốc). Downstream dùng `_srt_best_path()` tự tìm bản dịch. |

---

### Bước 7: Lồng tiếng Việt (Dub)

| | |
|---|---|
| **Frontend** | `POST /api/dub/{videoId}` → `tools.py:dub_subtitles()` → enqueue dub job |
| **Backend worker** | `worker.py:run_dub_job()` → `dub_service.py:build_full_audio()` |
| **Flow** | 1. **Đọc SRT**: ưu tiên `translated/{id}/subtitles_{lang}.srt` (bản dịch Việt), fallback SRT gốc |
| | 2. Dedup: gộp dòng liền kề giống ≥80%, nới endtime |
| | 3. Demucs tách vocals/instrumental (`--two-stems=vocals`) |
| | 4. TTS: Google TTS hoặc CapCut TTS → gen audio per line (dùng text từ SRT đã dịch) |
| | 5. `combine_tts_mp3()` — gộp audio theo timeline SRT |
| | 6. `demucs mix` — trộn TTS + instrumental (giữ nhạc nền) |
| | 7. FFmpeg mux audio lồng tiếng vào video → `temp/tts/{id}/dubbed_video.mp4` |
| **Voice map** | `voice_map.json` — ánh xạ SRT index → voice_type (CapCut), đọc khi `multi_voice=true` |
| **Output** | `temp/tts/{videoId}/dubbed_video.mp4` |

> **Lưu ý**: Dub đọc **bản dịch** (subtitles_vi.srt) thay vì SRT gốc (tiếng Trung/Anh),确保 TTS đọc đúng text tiếng Việt.

---

### Bước 8: Nhúng SRT vào video (Hardcode)

| | |
|---|---|
| **Frontend** | `POST /api/hardcode/{videoId}` → `tools.py:hardcode_subtitles()` → enqueue hardcode job |
| **Backend worker** | `worker.py:run_hardcode_job()` → `hardcode_service.py` |
| **Flow** | 1. SRT → ASS (convert với subtitle style) |
| | 2. FFmpeg burn: `subtitles=` filter (nếu có libass) hoặc OpenCV+Pillow (fallback) |
| | 3. Upscale ≥1080p, CRF 18, medium preset |
| **Output** | `temp/hardcoded/{videoId}/*_hardcoded.mp4` |

---

### Bước 9: Tạo meta

| | |
|---|---|
| **Frontend** | `POST /api/meta/{videoId}` |
| **Backend** | Gemini tạo tiêu đề, mô tả, tags từ context + SRT đã dịch |
| **Output** | `temp/meta/{videoId}/meta.json` |

---

### Bước 10: Cập nhật thumbnail

| | |
|---|---|
| **Frontend** | Nếu `falThumbnail` hoặc `gptThumbnail` bật |
| **FAL** | `POST /api/fal-thumbnail/{videoId}` → fal.ai model generate 16:9 thumbnail |
| **ChatGPT** | `POST /api/chatgpt-thumbnail/{videoId}` → ChatGPT Vision fix thumbnail |
| **Output** | `temp/thumb/{videoId}/thumbnail.jpg` |

---

### Bước 11: Upload YouTube

| | |
|---|---|
| **Frontend** | Nếu `autoYoutube` bật |
| **Backend** | `POST /api/youtube/upload` → YouTube Data API v3 upload |
| **Input** | Video + meta + thumbnail từ các bước trước |
| **Output** | YouTube video URL |

---

## Luồng dữ liệu tổng thể

```
URL Douyin/YouTube/Upload
    │
    ▼
[Step 0] Resolve link → video URL + audio URL
    │
    ▼
[Step 1] Merge → temp/videos/{id}/video.mp4
    │
    ▼
[Step 2] User chọn vùng → region {x1,y1,x2,y2}
    │
    ▼
[Step 3] User chỉnh style → subtitleStyle
    │
    ▼
[Step 3.5-3.6] (optional) Delogo → hardcoded/{id}/*_hardcoded.mp4
    │
    ▼
[Step 4] OCR → temp/srt/{id}/subtitles.srt
    │
    ▼
[Step 5] Context → temp/context/{id}/context.txt
    │
    ▼
[Step 6] Translate → temp/translated/{id}/subtitles_{lang}.srt (KHÔNG overwrite gốc)
    │         └→ (multi_voice) → voice_map.json
    │
    ▼
[Step 7] Dub ← _srt_best_path() tự tìm subtitles_{lang}.srt (bản dịch)
    │         → TTS đọc text tiếng Việt
    │         → Demucs tách vocal/instrumental
    │         → mix TTS + nhạc nền
    │         → temp/tts/{id}/dubbed_video.mp4
    │
    ▼
[Step 8] Hardcode ← _srt_best_path() tự tìm bản dịch
    │         → temp/hardcoded/{id}/*_hardcoded.mp4
    │
    ▼
[Step 9] Meta → temp/meta/{id}/meta.json
    │
    ▼
[Step 10] Thumbnail → temp/thumb/{id}/thumbnail.jpg
    │
    ▼
[Step 11] Upload YouTube → video URL
```

---

## Backend Architecture

### SRT Path Helpers (`media_utils.py`)

```python
_srt_original_path(video_id)      # → srt/{id}/subtitles.srt (OCR output, always)
_srt_translated_path(video_id, lang="vi")  # → translated/{id}/subtitles_{lang}.srt (None if not exist)
_srt_best_path(video_id, lang="vi")        # → ưu tiên bản dịch, fallback bản gốc
_srt_path(video_id)               # → legacy, throw FileNotFoundError if not exist
```

**Flow mới** (sau optimization):
```
Step 4 OCR → ghi srt/{id}/subtitles.srt (gốc)
Step 6 Translate → ghi translated/{id}/subtitles_vi.srt (KHÔNG overwrite gốc)
Step 7 Dub → _srt_best_path() → đọc translated/{id}/subtitles_vi.srt ✅
Step 8 Hardcode → _srt_best_path() → đọc translated/{id}/subtitles_vi.srt ✅
```

### Job Queue
```
Frontend                  Backend
POST /api/process  ──→  enqueue_job() → asyncio.Queue
                          │
                          ▼
                     worker_loop()
                     ┌─────────────────┐
                     │ ThreadPoolExec(1)│ ← chỉ 1 job đồng thời
                     └────────┬────────┘
                              │
                     run_job / run_translate_job / run_dub_job / ...
                              │
                     WebSocket + Status API ──→ Frontend pollJob()
```

### Executor
```python
_executor = ThreadPoolExecutor(max_workers=1)       # OCR, hardcode, align, translate, tts, dub
_context_executor = ThreadPoolExecutor(max_workers=1) # context generation (riêng, không block job)
```

⚠️ **Lưu ý**: `_executor` chỉ 1 worker — nếu 1 job treo, tất cả job tiếp theo bị block.

### WebSocket Flow
```
Frontend                    Backend
connect WS /api/ws/{jobId}
    │                          │
    │  ◄── {type:"progress"}   │  (mỗi % thay đổi)
    │  ◄── {type:"log"}        │  (mỗi dòng log mới)
    │  ◄── {type:"done"}       │  (job hoàn tất)
    │  ◄── {type:"error"}      │  (job lỗi)
    │                          │
    │  pollJob() fallback ──→ GET /api/status/{jobId}
```

---

## Thư mục lưu trữ (temp/)

```
temp/
├── videos/{video_id}/          # Video gốc + meta.json
│   ├── video.mp4
│   └── meta.json               # {filename, source, source_merge_id, ...}
├── merged/                     # Video đã merge (video+audio từ Douyin)
│   ├── {merge_id}_video.mp4    # Video track
│   └── {merge_id}_audio.mp4    # Audio track
├── frames/                     # Frame JPEG (region selector)
├── srt/{video_id}/             # SRT gốc (từ OCR)
│   └── subtitles.srt
├── context/{video_id}/         # Context (Vision + diarization)
│   ├── context.txt             # Mô tả video từ Gemini Vision
│   ├── diarization.json        # Phân tích speaker từ audio
│   ├── context_images/         # Ảnh ngữ cảnh (big_thumbs)
│   └── files_index.json        # Gemini File Store index
├── translated/{video_id}/      # Bản dịch
│   ├── subtitles_{lang}.srt    # SRT đã dịch
│   ├── voice_map.json          # Ánh xạ dòng → giọng
│   ├── input.srt               # Custom SRT (nếu dùng SRT riêng)
│   └── diarization.json        # Kết quả phân tích speaker
├── tts/{video_id}/             # Lồng tiếng
│   ├── separated/htdemucs/audio/
│   │   ├── vocals.wav          # Giọng nói (đã tách bởi Demucs)
│   │   └── no_vocals.wav       # Nhạc nền (instrumental)
│   ├── {voice_key}/            # Audio TTS per voice
│   │   └── {index:04d}.mp3
│   ├── full_audio.m4a          # Audio TTS gộp theo timeline
│   └── dubbed_video.mp4        # Video đã lồng tiếng
├── hardcoded/{video_id}/       # Video đã nhúng phụ đề
│   └── *_hardcoded.mp4
├── muxed/                      # Video đã gộp SRT (mux)
├── meta/{video_id}/            # Metadata
│   └── meta.json
├── thumb/{video_id}/           # Thumbnail
│   └── thumbnail.jpg
├── projects/                   # Project data
└── tts_preview/                # Voice preview audio
```

---

## Config (env vars, prefix `STE_`)

| Env | Mô tả | Mặc định |
|---|---|---|
| `STE_temp_dir` | Thư mục tạm | `backend/temp/` |
| `STE_extract_fps` | FPS trích frame OCR | `15` |
| `STE_ocr_lang` | Ngôn ngữ OCR mặc định | `ch` |
| `STE_similarity_threshold` | Ngưỡng gộp dòng giống | `0.85` |
| `STE_job_timeout` | Timeout job (giây, 0=vô hạn) | `0` |
| `STE_gemini_api_key` | Gemini API key(s) | `""` |
| `STE_gfal_key` | FAL.ai API key | `""` |
| `STE_tts_workers` | Số luồng TTS song song | `3` |
| `STE_hardcode_workers` | Số luồng hardcode song song | `0` (auto) |

---

## Các lỗi thường gặp

| Lỗi | Nguyên nhân | Fix |
|---|---|---|
| Pipeline treo ở OCR | `_executor` bị block bởi job trước | Kiểm tra backend logs, restart backend |
| Delogo bị skip | `cur` snapshot cũ không update `removeWatermarkRegions` | ✅ Đã fix (re-read store sau patch) |
| OCR quét video có watermark | `resolve_video_path` không ưu tiên delogo'd video | ✅ Đã fix (ưu tiên `hardcoded/`) |
| Dub đọc text tiếng Trung | `dub_service` đọc SRT gốc thay vì bản dịch Việt | ✅ Đã fix (ưu tiên `translated/subtitles_{lang}.srt`) |
| Dịch lỗi `multi_voice` | `translate_srt()` thiếu param `multi_voice` | ✅ Đã fix |
| Audio diarization lỗi | SDK `google-genai` reject raw dict contents | ✅ Đã fix (dùng `Part.from_uri`) |
| Voice map lệch giọng | Diarization fail silent + batch không nhớ nhau | ✅ Đã fix (vocals.wav + cross-batch memory) |
| `translate_srt()` TypeError | `multi_voice` param bị xóa khi merge | ✅ Đã fix |
