# SubTitleExtractor — Project Instructions

## Tech Stack
- **Backend:** Python 3.10+, FastAPI, Uvicorn, Pydantic v2
- **Frontend:** Next.js 14+, TypeScript, Tailwind CSS (App Router)
- **OCR:** RapidOCR (`lang='ch'` — Simplified Chinese) *hoặc* Apple Vision OCR (`VNRecognizeTextRequest` trên macOS) — người dùng chọn engine ở frontend (`ocr_type: rapid | apple`)
- **Video:** OpenCV `VideoCapture` (in-memory frame streaming) + FFmpeg
- **Text diff:** `rapidfuzz` (Levenshtein ratio, threshold ~0.85)
- **Config:** `pydantic-settings` (env vars + .env, prefix `STE_`)
- **Job Queue:** `asyncio.Queue` (in-process, no Redis)

## Project Structure
```
SubTitleExtractor/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py              # FastAPI app, lifespan, CORS
│   │   ├── config.py            # pydantic-settings (env vars)
│   │   ├── models.py            # Pydantic v2 schemas
│   │   ├── dependencies.py      # FastAPI DI (engine, jobs, ws)
│   │   ├── routers/
│   │   │   ├── __init__.py
│   │   │   ├── upload.py        # POST /api/upload (streaming)
│   │   │   ├── video.py         # GET /api/video/{id}, /api/frame/{id}
│   │   │   ├── process.py       # POST /api/process, WS /api/ws/{id}, GET /api/status/{id}
│   │   │   └── download.py      # GET /api/download/{id}
│   │   ├── services/
│   │   │   ├── __init__.py
│   │   │   ├── video_processor.py  # OpenCV frame streaming, crop, dhash
│   │   │   ├── ocr_engine.py       # BaseOCREngine (cache chung) + RapidOCR wrapper
│   │   │   ├── apple_ocr_engine.py # Apple Vision OCR wrapper (pyobjc, macOS)
│   │   │   └── subtitle_generator.py # SRT generation, merge
│   │   └── worker.py             # Background job runner + WS notify
│   ├── requirements.txt
│   └── temp/                     (gitignored)
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx         # Step-based workflow
│   │   │   └── globals.css
│   │   ├── components/
│   │   │   ├── UploadPage.tsx       # Drag-drop + progress bar
│   │   │   ├── RegionSelector.tsx   # Canvas with RAF, pointer events, keyboard
│   │   │   └── ResultPage.tsx       # WebSocket progress + download
│   │   └── lib/
│   │       └── api.ts               # Axios + WS helpers
│   ├── package.json
│   ├── next.config.js
│   └── tailwind.config.js
├── AGENTS.md
└── PLAN.md
```

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/upload` | Upload video file (streaming chunks) |
| GET | `/api/video/{video_id}` | Serve video file for preview |
| GET | `/api/frame/{video_id}` | Get first frame JPEG for region selection |
| POST | `/api/process` | Submit job (returns `job_id`) |
| GET | `/api/status/{job_id}` | Poll job status (fallback for WS) |
| WS | `/api/ws/{job_id}` | WebSocket realtime progress |
| GET | `/api/download/{video_id}` | Download .srt file |
| GET | `/api/health` | Health check |

## Key Architectural Decisions

### No temp frame files
Frames are read via OpenCV `VideoCapture` in-memory, cropped to region, and OCR'd directly from numpy arrays. No JPG files are written to disk during processing.

### Async job queue
`POST /api/process` returns immediately with a `job_id`. Background worker processes the video and pushes progress via WebSocket.

### OCR caching
dHash comparison between consecutive frames: if crop hash differs by ≤5 bits, the previous OCR text is reused. Avoids redundant OCR calls on near-identical frames. Cache logic lives in `BaseOCREngine` — shared by RapidOCR and Apple Vision engines.

### Dual OCR engines
`POST /api/process` nhận `ocr_type: "rapid" | "apple"`. Worker chọn engine từ `app.state.ocr_engines` dict (`main.py` khởi tạo cả hai; Apple engine bị disable nếu thiếu pyobjc). Cả hai engine implement cùng interface: `ocr_image(np.ndarray) -> str`, `set_lang()`, `ocr_region_cached()`, `log_stats()`.

### Upload streaming
File chunks are streamed to disk incrementally (64KB buffer), not loaded into memory. No size limit (or set `STE_max_upload_size` to override).

## Run Commands
```bash
# Convenience: starts capcut-tts-api service (:8100) + backend (uvicorn :8000) + frontend (Next.js :3000)
./dev.sh

# Or individually:
cd capcut-tts-api && ../backend/.venv/bin/python -m service.main    # CapCut TTS service :8100
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev             # tsc --noEmit for typecheck
```

There are **no tests, no linters, no formatters, no CI** in this repo.

## Critical: Stale Files
The old prototype files at `backend/` root level still exist and are **not the entry point**:
- `backend/main.py`, `backend/config.py`, `backend/ocr_engine.py`, `backend/video_processor.py`, `backend/subtitle_generator.py`

These import PaddleOCR directly (not RapidOCR), use `os.path`, have no job queue. **Do NOT reference or modify them.** The real app lives under `backend/app/`.

## Tech Stack
- **Backend:** Python 3.10+, FastAPI, Uvicorn, Pydantic v2, pydantic-settings (`STE_` prefix, env file)
- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS 3
- **OCR:** RapidOCR (langs: `ch`, `en`, `latin`) + Apple Vision (macOS only, langs: `zh-Hans`, `en-US`, `vi-VN`)
- **Video:** OpenCV `VideoCapture` (in-memory frames, no temp JPGs) + FFmpeg
- **Text diff:** `rapidfuzz` (Levenshtein ratio, threshold ~0.85)
- **Job Queue:** Single `asyncio.Queue` + `ThreadPoolExecutor(max_workers=1)` — processes ONE job at a time, no Redis

## Project Structure
```
backend/
├── app/
│   ├── main.py              # FastAPI app, lifespan (init OCR engines, start worker), CORS
│   ├── config.py            # pydantic-settings → Settings() with env prefix STE_
│   ├── models.py            # Pydantic v2: Region, ProcessRequest, JobStatus, LogEntry
│   ├── dependencies.py      # FastAPI DI providers (get_jobs, get_ws_clients, get_job_queue)
│   ├── routers/
│   │   ├── upload.py        # POST /api/upload (streaming 64KB chunks)
│   │   ├── video.py         # GET /api/videos, /api/video/{id}, /api/frame/{id}, DELETE /api/video/{id}
│   │   ├── process.py       # POST /api/process, POST /api/process/{id}/cancel, GET /api/status/{id}, WS /api/ws/{id}
│   │   └── download.py      # GET /api/download/{id}?format=srt|txt, GET /api/srt/{id}
│   ├── services/
│   │   ├── video_processor.py   # OpenCV frame generator, crop, dHash, get_first_frame
│   │   ├── ocr_engine.py        # BaseOCREngine (dHash cache ≤5 bits diff, max 15 streak) + OCREngine (RapidOCR)
│   │   ├── apple_ocr_engine.py  # Apple Vision OCR (pyobjc; disabled at startup if unavailable)
│   │   └── subtitle_generator.py # SRT generation, noise filtering, merge, flash detection
│   └── worker.py             # Background worker: enqueue_job, process_job_sync (run_in_executor), WS notify
├── requirements.txt
└── temp/                     (gitignored — videos/, frames/, srt/)

frontend/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout (+Jakarta Sans font)
│   │   ├── page.tsx            # Home: LibraryPage (video library grid)
│   │   ├── globals.css         # Tailwind + custom classes (double-bezel, btn-island, glass-panel, eyebrow, tag)
│   │   ├── extract/page.tsx    # 3-step workflow: UploadPage → RegionSelector → ResultPage
│   │   ├── settings/page.tsx   # Cấu hình: Gemini key, Google TTS, style phụ đề (font/màu/viền/nền)
│   │   └── video/[id]/page.tsx # Video detail: metadata, JobProgress (polling), TranscriptPlayer
│   ├── components/
│   │   ├── UploadPage.tsx         # Drag-drop upload + progress bar
│   │   ├── RegionSelector.tsx     # Canvas (RAF, pointer events, keyboard Enter/Space)
│   │   ├── ResultPage.tsx         # WebSocket progress + download links
│   │   ├── TranscriptPlayer.tsx   # Timestamped transcript viewer
│   │   └── LibraryPage.tsx        # Video library grid
│   └── lib/
│       ├── api.ts              # Axios instance (base=/api, timeout=30s) + WS URL builder + all API wrappers
│       └── animation.tsx       # AnimatedBlock component (staggered fade-in)
├── next.config.js              # Rewrites /api/* → localhost:8000/api/*
├── tailwind.config.js          # Custom theme: colors (paper, ink, glass), animations (fade-in, fade-up, scale-in, shimmer)
└── package.json                # npm run dev | build | start | typecheck
```

## API Endpoints (Complete)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/upload` | Upload video → `{video_id, filename}` |
| GET | `/api/videos` | List all videos (active jobs + completed with SRT) |
| GET | `/api/video/{video_id}` | Serve video file |
| GET | `/api/frame/{video_id}` | First frame JPEG for region selector |
| DELETE | `/api/video/{video_id}` | Delete video, frames, and SRT |
| POST | `/api/process` | Submit job → `{job_id}`. Body: `{video_id, region{x1,y1,x2,y2}, lang, ocr_type, fps?}` |
| POST | `/api/process/{job_id}/cancel` | Cancel a running job |
| GET | `/api/status/{job_id}` | Poll job status (fallback for WS) |
| WS | `/api/ws/{job_id}` | WebSocket: `{type:"progress"|"log"|"done"|"error", ...}` |
| GET | `/api/download/{video_id}?format=srt\|txt` | Download subtitle file (filename = `{original}.original.srt`) |
| GET | `/api/download/muxed/{video_id}` | Download merged video (filename = `{original}_muxed.mp4`) |
| GET | `/api/download/hardcoded/{video_id}` | Download hardcoded video (filename = `{original}_hardcoded.mp4`) |
| GET | `/api/download/dubbed/{video_id}` | Download dubbed video (filename = `{original}_dubbed.mp4`) |
| GET | `/api/download/exported/{video_id}` | Download exported video (filename = `{original}_exported.mp4`) |
| GET | `/api/srt/{video_id}` | Raw SRT content as JSON `{content: "..."}` |
| GET | `/api/capcut/voices?lang=vi-VN` | List CapCut voices (proxy → service :8100) |
| GET | `/api/capcut/health` | CapCut TTS service status |
| POST | `/api/capcut/preview` | Generate voice preview MP3 (body `{voice, text?}`) → audio/mpeg |

## Key Architecture

### Original filename flow (Auto Pipeline)
Khi resolve link Douyin (`/api/video-download/resolve`), frontend `pipeline-store.ts` lưu `rd.title` (tên gốc) vào `originalName` sau khi sanitize (`sanitizeFilename`), rồi gửi nó làm `filename` trong `POST /api/import-video` (thay vì hardcode `douyin.mp4`). Backend lưu vào `videos/{video_id}/meta.json`. Các endpoint download dùng tên này:
- `tools.py::_original_download_name(video_id, suffix)` → `{original}_muxed/hardcoded/dubbed/exported.mp4`
- `download.py::_download_name` → `{original}.original.srt/txt`
- `video.py::_meta_filename` → hiển thị tên trong library

### No temp frame files
OpenCV `VideoCapture` → in-memory frames → crop → OCR on numpy arrays. Only the first frame is written to disk (for region selector).

### Dual dub engines (Google TTS / CapCut)
`POST /api/dub/{video_id}` nhận `{engine: "google" | "capcut", voice}`. `dub_service.build_full_audio` chọn `synthesize_srt` (Google) hoặc `synthesize_srt_capcut` (gọi `capcut_tts_client` → HTTP tới service `capcut-tts-api` port 8100, mỗi entry 1 task, download MP3 về `tts/{video_id}/{voice_key}/{index:04d}.mp3`). Cả 2 đều giữ nguyên luồng sau: `combine_tts_mp3` → Demucs mix → mux. `pipeline_health()`: cần Gemini + ít nhất 1 engine dub sẵn sàng (`dub_engines`).

### OCR caching via dHash
`BaseOCREngine.ocr_region_cached()`: if consecutive frame crop hashes differ by ≤5 bits, reuse previous OCR text. Max streak: 15 frames (configurable). Shared by both RapidOCR and Apple Vision engines.

### Single-threaded worker
One `ThreadPoolExecutor(max_workers=1)` in `worker.py`. Jobs queue via `asyncio.Queue`, processed sequentially. OCR runs in executor to avoid blocking event loop. `_notify_sync` bridges sync code → async WebSocket.

### Subtitle pipeline
1. Stream frames via generator → `ocr_region_cached()` per frame
2. Detect boundaries when `rapidfuzz` similarity < 0.85
3. Require ≥2 stable consecutive frames to emit (filters 1-frame OCR blips)
4. Flash detection: absorb short transients between identical subtitles
5. Post-processing: noise filtering (rare glued CJK+Latin tokens), A-B-A merge, final merge pass

### Config (`backend/app/config.py`)
All env vars prefixed with `STE_`. Module-level `settings.temp_dir.mkdir(…)` runs at **import time** — creates `temp/`, `temp/videos/`, `temp/frames/`, `temp/srt/`, `temp/tts_preview/`. Do NOT add more import-time side effects.

### User config (`backend/app/routers/config_router.py`)
`GET/POST /api/config` reads/writes `temp/user_config.json`: `gemini_api_key`, `google_tts_credentials`, `auto_context_enabled`, and `subtitle_style` (font, size, colors, outline, bold/italic, box bg, radius, margin). `get_subtitle_style()` merges defaults (`DEFAULT_SUBTITLE_STYLE`) + stored values, coercing types — used by `hardcode_service` (both ASS and Pillow burn paths). Frontend settings UI lives at `/settings` (gear button in AutoPipeline header).

### CapCut TTS gen-voice service (`capcut-tts-api/`)
Sibling FastAPI project (port 8100, env prefix `CTTS_`) wrapping the CapCut TTS SDK (`capcut_tts_api.CapCutClient`). Endpoints: `POST /api/tts` (segments job), `GET /api/tts/{job_id}`, `GET /api/tts/{job_id}/audio/{filename}`, `GET /api/voices?lang=`. Run via `./dev.sh` (auto-starts) or `cd capcut-tts-api && ../backend/.venv/bin/python -m service.main`. Backend talks to it through `app/services/capcut_tts_client.py` (httpx).

## Frontend Design System
Custom Tailwind tokens defined in `tailwind.config.js` and `globals.css`:
- **Colors:** `paper` (#f8f8f6), `ink`/`ink-muted`/`ink-light`, `glass`/`glass-stroke`/`glass-hover`
- **Components (CSS classes):** `double-bezel` (gradient-border container), `double-bezel-inner`, `btn-island`/`btn-island-primary`/`btn-island-secondary`/`btn-island-icon`, `glass-panel`, `eyebrow`, `tag`
- **Animations:** `fade-in`, `fade-up`, `scale-in`, `shimmer`, `pulse-glow` — use via Tailwind `animate-*` or `<AnimatedBlock>` from `lib/animation.tsx`
- **Font:** Plus Jakarta Sans (Google Fonts, loaded via `next/font` in layout.tsx)
- All bespoke UI should use these classes, not ad-hoc styling.
