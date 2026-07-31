# SubTitleExtractor — Project Instructions

## Tech Stack
- **Backend:** Python 3.10+, FastAPI, Uvicorn, Pydantic v2
- **Frontend:** Next.js 14+, TypeScript, Tailwind CSS (App Router)
- **OCR:** PaddleOCR (`lang='ch'` — Simplified Chinese), PaddlePaddle ≥ 2.6
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
│   │   │   ├── ocr_engine.py       # PaddleOCR wrapper + cache
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
dHash comparison between consecutive frames: if crop hash differs by ≤5 bits, the previous OCR text is reused. Avoids redundant PaddleOCR calls on near-identical frames.

### Upload streaming
File chunks are streamed to disk incrementally (64KB buffer), not loaded into memory. Max file size check is enforced during streaming.

## Run Commands
```bash
# Backend (from backend/ directory)
uvicorn app.main:app --reload --port 8000

# Frontend (from frontend/ directory)
npm run dev
```
