---
name: backend-dev
description: Use ONLY when writing Python/FastAPI backend code for SubTitleExtractor — video processing, OCR pipeline, SRT generation. Covers FastAPI endpoints, PaddleOCR integration, FFmpeg wrapper, OpenCV, subtitle logic.
---

# Backend Development — SubTitleExtractor

## Tech Stack
- Python 3.10+, FastAPI, Uvicorn
- PaddleOCR (model `ch_ppocr_mobile_v2.0` cho tiếng Trung)
- FFmpeg (subprocess) + OpenCV
- `rapidfuzz` (Levenshtein ratio)

## Project Structure
```
backend/
├── main.py              # FastAPI app, upload/download endpoints
├── config.py            # Settings (FPS, threshold, language, paths)
├── video_processor.py   # FFmpeg frame extraction
├── ocr_engine.py        # PaddleOCR wrapper class
├── subtitle_generator.py# Text change detection → SRT
├── requirements.txt
└── temp/                # Uploads + frames (gitignored)
```

## Key Conventions
- Async endpoints (`async def`) for I/O-bound routes
- Sync for CPU-bound (OCR, FFmpeg) — run via `run_in_executor` or thread pool
- Type hints everywhere
- Error handling: raise HTTPException with descriptive message
- Config in `config.py`, env vars via `os.getenv` with sensible defaults

## API Endpoints
| Method | Path | Input | Output |
|--------|------|-------|--------|
| POST | `/api/upload` | `multipart/form-data` file | `{ video_id }` |
| GET | `/api/frame/{video_id}` | — | frame ảnh (JPEG) để user chọn vùng |
| POST | `/api/process` | `{ video_id, region }` | `{ status, srt_path }` |
| GET | `/api/download/{video_id}` | — | file `.srt` |

## PaddleOCR Setup (GPU)
```python
from paddleocr import PaddleOCR
ocr = PaddleOCR(use_angle_cls=True, lang='ch', use_gpu=True)
```
- `lang='ch'` cho Simplified Chinese — tự động tải model lần đầu
- `use_gpu=True` — macOS Apple Silicon dùng MPS, NVIDIA dùng CUDA
- GPU giúp tăng tốc 2-4x, có thể tăng `rec_batch_num` cho batch processing
- Method `ocr_region(image_path, bbox)` crop ảnh theo [x1,y1,x2,y2] rồi OCR

## Subtitle Generation Logic
```
Duyệt frame theo timestamp:
  current_text = OCR(frame_crop)
  similarity = fuzz.ratio(current_text, prev_text)
  if similarity < THRESHOLD (0.85):
      -> end previous subtitle at prev timestamp
      -> start new subtitle at current timestamp
  prev_text = current_text
```
