# SubTitleExtractor — Project Instructions

## Run Commands
```bash
# Convenience: starts both backend (uvicorn) + frontend (Next.js) at once
./dev.sh

# Or individually:
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
| GET | `/api/srt/{video_id}` | Raw SRT content as JSON `{content: "..."}` |

## Key Architecture

### No temp frame files
OpenCV `VideoCapture` → in-memory frames → crop → OCR on numpy arrays. Only the first frame is written to disk (for region selector).

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
All env vars prefixed with `STE_`. Module-level `settings.temp_dir.mkdir(…)` runs at **import time** — creates `temp/`, `temp/videos/`, `temp/frames/`, `temp/srt/`. Do NOT add more import-time side effects.

## Frontend Design System
Custom Tailwind tokens defined in `tailwind.config.js` and `globals.css`:
- **Colors:** `paper` (#f8f8f6), `ink`/`ink-muted`/`ink-light`, `glass`/`glass-stroke`/`glass-hover`
- **Components (CSS classes):** `double-bezel` (gradient-border container), `double-bezel-inner`, `btn-island`/`btn-island-primary`/`btn-island-secondary`/`btn-island-icon`, `glass-panel`, `eyebrow`, `tag`
- **Animations:** `fade-in`, `fade-up`, `scale-in`, `shimmer`, `pulse-glow` — use via Tailwind `animate-*` or `<AnimatedBlock>` from `lib/animation.tsx`
- **Font:** Plus Jakarta Sans (Google Fonts, loaded via `next/font` in layout.tsx)
- All bespoke UI should use these classes, not ad-hoc styling.
