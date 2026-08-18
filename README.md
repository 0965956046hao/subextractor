# SubTitleExtractor

> **Build app desktop (Tauri):** xem [BUILD.md](BUILD.md) — hướng dẫn step-by-step đóng gói khi có update code.

Trích xuất phụ đề (subtitle) từ video bằng OCR: upload video, chọn vùng hiển thị phụ đề, OCR toàn bộ frame và tải về file `.srt` (hoặc `.txt`).

## Tính năng

- **2 OCR engine, chọn được ở frontend:**
  - **RapidOCR** (`rapid`) — chạy mọi nền tảng, nhanh, hỗ trợ `ch` / `en` / `latin`
  - **Apple Vision** (`apple`) — macOS, chính xác với chữ in (pyobjc)
- Chọn vùng phụ đề bằng canvas trên frame đầu tiên (drag + keyboard)
- Xử lý **tất cả frame** (không downsample) — timestamps chính xác từng frame
- Cache dHash: frame gần giống nhau không OCR lại, tốc độ nhanh hơn
- Hậu xử lý: lọc ký tự nhiễu, gộp phụ đề lặp, loại OCR blip
- Hệ thống job nền (asyncio queue) + tiến trình realtime qua WebSocket
- Tải file theo tên video gốc, ví dụ `phim-tap-1.mp4` → `phim-tap-1.original.srt`

## Requirements

- **Python** 3.10+
- **Node.js** 18+
- **macOS** 12+ — *chỉ bắt buộc* khi dùng Apple Vision; RapidOCR chạy mọi nền tảng
- **FFmpeg** — khuyên dùng; backend dùng OpenCV `VideoCapture` để đọc frame

## Quick Start

### 1. Backend

```bash
cd backend

# Tạo virtual environment (chỉ lần đầu)
python3 -m venv .venv
source .venv/bin/activate

# Cài dependencies
pip install -r requirements.txt

# Chạy server
uvicorn app.main:app --reload --port 8000
```

> Trên macOS nhớ cài nhóm pyobjc trong `requirements.txt` (`pyobjc-framework-Vision`, `-Cocoa`, `-Quartz`) để dùng Apple Vision. Nếu thiếu, backend vẫn chạy nhưng Apple engine bị disable.

API docs (Swagger): http://localhost:8000/docs

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend: http://localhost:3000

### 3. Sử dụng

1. Mở http://localhost:3000
2. Bấm **New Extractor** (hoặc xem thư viện phụ đề đã trích xuất ở trang chủ)
3. Kéo thả video (`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`)
4. Chọn **OCR Engine** (RapidOCR / Apple Vision) + **ngôn ngữ**
5. Kéo chuột chọn vùng phụ đề trên frame đầu
6. Chờ xử lý (xem tiến trình + log realtime) → xem / tải file `.srt`

## DS2API (DeepSeek → OpenAI/Claude/Gemini proxy)

`./dev.sh` tự động start **ds2api** (port `5001`) cùng backend/frontend/capcut-tts-api.

- **WebUI Admin:** http://localhost:5001/admin — quản lý tài khoản DeepSeek, API keys, test API
- **Admin key:** `test-admin` (override bằng env `DS2API_ADMIN_KEY`)
- **Config:** `ds2api/config.json` — thêm account DeepSeek (`email` + `password`) và client keys ở đây (hoặc qua WebUI Admin)
- **Sửa config xong cần restart** ds2api (config chỉ nạp 1 lần lúc start, không hot-reload)

Ví dụ gọi API (chuẩn OpenAI):

```bash
curl http://localhost:5001/v1/chat/completions \
  -H "Authorization: Bearer <client-key-trong-config>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Xin chào"}]}'
```

> Lưu ý: model dùng là `deepseek-v4-flash` / `deepseek-v4-pro` (xem `/v1/models`). Client key phải nằm trong `ds2api/config.json` → `keys`/`api_keys`.

## Project Structure

```
SubTitleExtractor/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, lifespan, khởi tạo OCR engines
│   │   ├── config.py            # Settings (pydantic-settings, prefix STE_)
│   │   ├── models.py            # Pydantic v2 schemas
│   │   ├── dependencies.py      # FastAPI DI (engines, jobs, queue)
│   │   ├── routers/
│   │   │   ├── upload.py        # POST /api/upload (streaming chunk)
│   │   │   ├── video.py         # GET /api/video/{id}, /api/frame/{id}, /api/videos
│   │   │   ├── process.py       # POST /api/process, GET /api/status/{id}, WS /api/ws/{id}
│   │   │   └── download.py      # GET /api/download/{id}, /api/srt/{id}
│   │   ├── services/
│   │   │   ├── video_processor.py      # OpenCV frame streaming, crop, dhash
│   │   │   ├── ocr_engine.py           # BaseOCREngine (cache chung) + RapidOCR wrapper
│   │   │   ├── apple_ocr_engine.py     # Apple Vision OCR (pyobjc, macOS)
│   │   │   └── subtitle_generator.py   # SRT generation + hậu xử lý merge
│   │   └── worker.py            # Job runner nền + WS notify
│   ├── requirements.txt
│   └── temp/                    # Video / SRT tạm (gitignored)
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx         # Library (thư viện phụ đề)
│   │   │   ├── extract/page.tsx # Workflow: upload → chọn vùng → result
│   │   │   └── video/[id]/page.tsx  # Chi tiết video + transcript
│   │   ├── components/
│   │   │   ├── UploadPage.tsx       # Drag & drop + progress
│   │   │   ├── RegionSelector.tsx   # Canvas vẽ vùng phụ đề
│   │   │   ├── ResultPage.tsx       # WebSocket progress + downloads
│   │   │   ├── TranscriptPlayer.tsx # Xem transcript
│   │   │   └── LibraryPage.tsx      # Lưới thư viện
│   │   └── lib/
│   │       ├── api.ts           # Axios + WS helpers
│   │       └── animation.tsx    # Animations dùng chung
│   └── package.json
├── capcut-tts-api/             # CapCut TTS service (port 8100)
├── ds2api/                     # DeepSeek → OpenAI/Claude/Gemini proxy (port 5001)
│   ├── config.json             # Account DeepSeek + client keys (adminkey mặc định: test-admin)
│   └── cmd/ds2api/             # Entry Go
├── dev.sh                      # Start tất cả services cùng lúc
├── AGENTS.md                  # Project instructions
└── PLAN.md                    # Kiến trúc & plan
```

## API Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/api/upload` | Upload video (chunk 64KB) → `video_id` |
| GET | `/api/videos` | Danh sách video đã trích xuất |
| GET | `/api/video/{video_id}` | Phát video (preview) |
| GET | `/api/frame/{video_id}` | Frame đầu tiên (JPEG) để chọn vùng |
| DELETE | `/api/video/{video_id}` | Xóa video + SRT |
| POST | `/api/process` | Nhận job → `job_id` (body: `video_id`, `region`, `lang`, `fps`, `ocr_type`) |
| GET | `/api/status/{job_id}` | Poll trạng thái job (fallback không cần WS) |
| WS | `/api/ws/{job_id}` | WebSocket tiến trình realtime |
| GET | `/api/download/{video_id}?format=srt\|txt` | Download phụ đề (tên theo video gốc) |
| GET | `/api/srt/{video_id}` | Nội dung SRT dạng JSON |
| GET | `/api/health` | Health check |

`POST /api/process`:
```json
{
  "video_id": "abc123",
  "region": {"x1": 0.05, "y1": 0.8, "x2": 0.95, "y2": 0.97},
  "lang": "ch",
  "ocr_type": "rapid"
}
```

## Cấu hình (`backend/app/config.py`)

Cấu hình qua **biến môi trường** với prefix `STE_` hoặc file `.env` trong `backend/`.

| Env | Default | Mô tả |
|-----|---------|-------|
| `STE_EXTRACT_FPS` | `0` | Số frame/giây. `0` = lấy **tất cả frame** |
| `STE_OCR_LANG` | `ch` | Ngôn ngữ OCR mặc định (`ch` / `en` / `latin`) |
| `STE_SIMILARITY_THRESHOLD` | `0.85` | Ngưỡng phát hiện đổi text giữa 2 frame |
| `STE_MERGE_SIMILARITY` | `0.9` | Ngưỡng gộp 2 dòng phụ đề trùng nhau |
| `STE_SUBTITLE_FLASH_SECONDS` | `2.0` | Ngưỡng flash (OCR blip ngắn bị hấp thụ lại) |
| `STE_MAX_UPLOAD_SIZE` | `524288000` | Giới hạn upload (bytes) |
| `STE_JOB_TIMEOUT` | `1800` | Timeout xử lý 1 job (giây) |
| `STE_OCR_CACHE_MAX_STREAK` | `15` | Số frame liên tiếp tối đa được cache |
| `STE_DET_DB_THRESH` | `0.3` | Ngưỡng detection RapidOCR |
| `STE_TEXT_SCORE` | `0.5` | Ngưỡng text score RapidOCR |
| `STE_TEMP_DIR` | `backend/temp` | Thư mục lưu tạm |
| `STE_BASE_DIR` | — | Thư mục gốc backend |

Ví dụ `.env`:

```env
STE_EXTRACT_FPS=0
STE_OCR_LANG=ch
STE_JOB_TIMEOUT=3600
```

## OCR Engines

Cả hai engine implement chung interface: `ocr_image(np.ndarray) -> str`, `set_lang()`, `ocr_region_cached()`, `log_stats()`. Logic cache dHash (so frame liền nhau ≤5 bits khác → dùng lại text cũ) nằm trong `BaseOCREngine`, dùng chung cho cả hai.

| Engine | `ocr_type` | Yêu cầu | Lang hỗ trợ |
|--------|-----------|---------|-------------|
| RapidOCR | `rapid` | `rapidocr` (onnxruntime) | `ch`, `en`, `latin` |
| Apple Vision | `apple` | macOS + `pyobjc-framework-Vision/Cocoa/Quartz` | `zh-Hans`, `en-US`, `vi-VN` |

## Tech Stack

- **Backend:** Python 3.10+ · FastAPI · Pydantic v2 · Uvicorn
- **OCR:** RapidOCR (`rapidocr`) + Apple Vision (`pyobjc`)
- **Frontend:** Next.js 14+ · TypeScript · Tailwind CSS · Axios
- **Video:** OpenCV `VideoCapture` (in-memory) + FFmpeg
- **Text diff:** rapidfuzz (Levenshtein ratio)
- **Config:** pydantic-settings (env `STE_`, `.env`)