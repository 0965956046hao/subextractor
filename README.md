# SubTitleExtractor

Upload video, select subtitle region, extract text via OCR → download `.srt` file.

## Requirements

- **Python** 3.10 – 3.12 (PaddlePaddle chưa support Python 3.13+)
- **Node.js** 18+
- **FFmpeg** (`brew install ffmpeg` trên macOS)

## Quick Start

### 1. Backend

```bash
cd backend

# Tạo virtual environment (chỉ lần đầu)
python3.12 -m venv .venv
source .venv/bin/activate

# Cài dependencies
pip install -r requirements.txt

# Chạy server
uvicorn main:app --host 0.0.0.0 --port 8000
```

API docs: http://localhost:8000/docs

### 2. Frontend

```bash
cd frontend

# Cài dependencies (chỉ lần đầu)
npm install

# Chạy dev server
npm run dev
```

Frontend: http://localhost:3000

### 3. Sử dụng

1. Mở http://localhost:3000
2. Kéo thả video (.mp4, .mov, .avi, …)
3. Chờ upload, chọn vùng subtitle trên frame đầu
4. Nhấn **Extract Subtitle** → chờ OCR processing
5. Download file `.srt`

## Project Structure

```
SubTitleExtractor/
├── backend/
│   ├── main.py               # FastAPI app (upload, frame, process, download)
│   ├── config.py             # Settings (fps, lang, threshold, paths)
│   ├── video_processor.py    # FFmpeg frame extraction
│   ├── ocr_engine.py         # PaddleOCR GPU wrapper
│   ├── subtitle_generator.py # Text diff → SRT
│   ├── requirements.txt
│   └── .venv/                # Python virtual env
├── frontend/
│   ├── src/
│   │   ├── app/page.tsx      # State machine (upload → select → result)
│   │   ├── components/
│   │   │   ├── UploadPage.tsx       # Drag & drop
│   │   │   ├── RegionSelector.tsx   # Canvas region selector
│   │   │   └── ResultPage.tsx       # Download SRT
│   │   └── lib/api.ts        # Axios API client
│   └── package.json
├── .opencode/                 # OpenCode config + skills
├── AGENTS.md                  # Project instructions
└── PLAN.md                    # Kiến trúc & plan
```

## API Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/api/upload` | Upload video → returns `video_id` |
| GET | `/api/frame/{video_id}` | Lấy frame đầu để chọn vùng |
| POST | `/api/process` | OCR toàn bộ frames → tạo `.srt` |
| GET | `/api/download/{video_id}` | Download file `.srt` |

## Cấu hình (`backend/config.py`)

| Key | Default | Mô tả |
|-----|---------|-------|
| `EXTRACT_FPS` | 2 | Số frame/second |
| `OCR_LANG` | `ch` | Simplified Chinese |
| `OCR_USE_GPU` | `true` | GPU (MPS/CUDA) |
| `SIMILARITY_THRESHOLD` | 0.85 | Ngưỡng detect text change |

## Tech Stack

- **Backend:** Python + FastAPI + PaddleOCR (GPU)
- **Frontend:** Next.js 14 + TypeScript + Tailwind
- **Video:** FFmpeg + OpenCV
- **Text diff:** rapidfuzz
# subextractor
