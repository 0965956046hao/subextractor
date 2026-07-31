# SubTitleExtractor — Kế hoạch tái cấu trúc toàn diện

> **Mục tiêu:** Biến project từ prototype không hoạt động / chậm / kém ổn định thành production-ready app với kiến trúc rõ ràng, hiệu năng cao, dễ maintain.

---

## I. CHẨN ĐOÁN VẤN ĐỀ HIỆN TẠI

### 🔴 Backend

| # | Vấn đề | File | Mức độ |
|---|--------|------|--------|
| 1 | **Global mutable state** (`ocr_engine` là module-level variable) | `main.py:18` | Cao |
| 2 | **Không có Pydantic model** — dùng raw dict cho request body | `main.py:99` | Cao |
| 3 | **Side effect tại import time** — tạo temp dirs khi import config | `config.py:12-15` | Trung bình |
| 4 | **Không cleanup frames** — sau khi OCR xong, hàng ngàn file JPG vẫn còn trên disk | `video_processor.py` | Cao |
| 5 | **Extract ALL frames upfront** — dù video dài 2h vẫn extract hết => tốn disk, chậm | `video_processor.py:24` | **Nghiêm trọng** |
| 6 | **Timestamp sai** — dùng `i / EXTRACT_FPS` thay vì PTS thực tế từ container | `video_processor.py:47` | Cao |
| 7 | **OCR từng frame một** — không batch, mỗi frame load lại ảnh từ disk | `subtitle_generator.py:25` | Cao |
| 8 | **Không caching OCR** — cùng 1 text bị OCR lại nhiều lần | `subtitle_generator.py` | Trung bình |
| 9 | **So sánh text đơn giản** — naive fuzzy ratio, không merge line-level | `subtitle_generator.py:32` | Trung bình |
| 10 | **Upload đọc hết file vào memory** — video 500MB => 500MB RAM | `main.py:49` | Cao |
| 11 | **Không job queue** — processing đồng bộ, HTTP request timeout nếu video dài | `main.py:98-132` | **Nghiêm trọng** |
| 12 | **Không progress tracking / WebSocket** — user không biết đang xử lý tới đâu | `main.py` | **Nghiêm trọng** |
| 13 | **Hardcode FPS=2** — không adaptive, kém với video chậm/nhanh | `config.py:6` | Trung bình |
| 14 | **`get_video_info` không dùng** — function viết ra không dùng | `video_processor.py:8` | Thấp |
| 15 | **Không error boundary** — một frame lỗi => crash cả process | `subtitle_generator.py` | Cao |
| 16 | **Không graceful GPU fallback** — nếu GPU không available thì crash | `ocr_engine.py:9` | Cao |
| 17 | **requirements.txt version không pin** — dễ bị breaking change | `requirements.txt` | Cao |
| 18 | **Không healthcheck / startup validation** — FFmpeg, PaddleOCR có sẵn không? | - | Trung bình |

### 🔴 Frontend

| # | Vấn đề | File | Mức độ |
|---|--------|------|--------|
| 1 | **Không upload progress** — user không thấy % upload | `UploadPage.tsx` | Cao |
| 2 | **Không polling/WS khi process** — user không biết xử lý tới đâu | `ResultPage.tsx` | **Nghiêm trọng** |
| 3 | **Region selector không lưu video state** — pause/unpaused bị reset | `RegionSelector.tsx` | Trung bình |
| 4 | **Canvas logic rối** — `useCallback` + `useEffect` phức tạp, không debounce | `RegionSelector.tsx` | Trung bình |
| 5 | **Không responsive tốt** — video container hardcode max-width | `RegionSelector.tsx` | Trung bình |
| 6 | **Không error boundary React** — crash toàn page | `page.tsx` | Cao |
| 7 | **No loading skeleton** — chỉ text "Uploading..." | `UploadPage.tsx` | Thấp |
| 8 | **Axios không timeout** — request treo vô hạn | `api.ts` | Cao |
| 9 | **Không request cancellation** — user đi qua step khác, request cũ vẫn chạy | `api.ts` | Trung bình |
| 10 | **Next.js config dùng `rewrites`** — tốt nhưng thiếu error handling | `next.config.js` | Thấp |

---

## II. KIẾN TRÚC MỚI

### Backend Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  FastAPI     │────▶│  Job Queue    │────▶│  Worker Pool   │
│  (HTTP API)  │     │  (Redis/     │     │  (Background)  │
│             │◀────│   in-process) │◀────│               │
└──────┬──────┘     └──────────────┘     └───────┬───────┘
       │                                          │
       ▼                                          ▼
┌──────────────┐                      ┌──────────────────┐
│  WebSocket   │                      │  VideoProcessor   │
│  (progress)  │                      │  + OCREngine      │
└──────────────┘                      │  + SubtitleGen    │
                                      └──────────────────┘
```

### Frontend Architecture

```
┌──────────────┐      ┌────────────────┐      ┌───────────────┐
│  Upload Step  │─────▶│  RegionSelect   │─────▶│  Process Step │
│  (drag-drop)  │      │  (canvas +     │      │  (progress +  │
│              │      │   video)        │      │   download)   │
└──────────────┘      └────────────────┘      └───────────────┘
                            │                        │
                            ▼                        ▼
                    ┌────────────────┐      ┌───────────────┐
                    │  /api/frame/*  │      │  WS /ws/:id   │
                    │  /api/video/*  │      │  (progress)   │
                    └────────────────┘      └───────────────┘
```

---

## III. KẾ HOẠCH THỰC HIỆN (THEO PHASE)

---

### 🔷 PHASE 1: Backend Core Overhaul (2-3 ngày)

#### 1.1 Config + Project Structure
- [ ] Dùng `pathlib.Path` thay `os.path`
- [ ] Config dùng pydantic-settings (env vars + .env file)
- [ ] Không side effect khi import
- [ ] Validate FFmpeg availability at startup
- [ ] Cấu trúc thư mục mới:

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── config.py              # pydantic-settings
│   ├── models.py              # Pydantic schemas
│   ├── dependencies.py        # FastAPI deps
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── upload.py          # POST /api/upload
│   │   ├── video.py           # GET /api/video/{id}, /api/frame/{id}
│   │   ├── process.py         # POST /api/process, WS /api/ws/{id}
│   │   └── download.py        # GET /api/download/{id}
│   ├── services/
│   │   ├── __init__.py
│   │   ├── video_processor.py # FFmpeg + OpenCV
│   │   ├── ocr_engine.py      # PaddleOCR wrapper
│   │   └── subtitle_generator.py
│   └── worker.py              # Background job processor
├── temp/                      # gitignored
├── requirements.txt
└── pyproject.toml
```

#### 1.2 Upload Endpoint (File Streaming)
- [ ] Upload dùng `UploadFile` **streaming** (không `await file.read()` hết)
- [ ] Validate file type, file size (backend check)
- [ ] Stream file chunks directly to disk
- [ ] Trả về `video_id` ngay lập tức
- [ ] Tự động cleanup nếu upload fail

#### 1.3 Frame Extraction (On-Demand + Streaming)
**Vấn đề:** Hiện tại extract ALL frames trước, rất tốn disk.

**Giải pháp:** 
- [ ] Extract frames **on-the-fly** bằng FFmpeg pipe qua stdout → OpenCV
- [ ] Dùng Generator pattern: mỗi frame được yield và xử lý ngay
- [ ] Không ghi file JPG tạm trừ frame đầu tiên (cho region selector)
- [ ] Lấy PTS thực tế từ FFmpeg thay vì tính `i / FPS`
- [ ] Adaptive FPS: dựa vào độ phức tạp của video

```python
# Ý tưởng:
def extract_frames_stream(video_path: str, fps: int = 2):
    """Generator: yield (cv2_frame, pts_timestamp) từng cái một."""
    # Mở FFmpeg process với pipe output là raw video
    # Đọc từng frame, parse PTS từ stderr hoặc packet
    # yield frame để OCR ngay lập tức
```

#### 1.4 OCR Engine (Batch + Cache)
- [ ] Load ảnh 1 lần, OCR nhiều region nếu cần
- [ ] **Text cache:** nếu frame kế tiếp giống frame trước (SSIM/hash), reuse kết quả
- [ ] Batch OCR: gộp nhiều frame crop vào 1 lần gọi PaddleOCR `ocr.ocr()` với list ảnh
- [ ] GPU fallback: tự động detect MPS (macOS) / CUDA / CPU
- [ ] Retry logic nếu OCR fail (max 2 lần)
- [ ] Preprocessing: crop ảnh với padding, tăng contrast trước khi OCR

#### 1.5 Subtitle Generator (Smart Diff)
**Vấn đề:** chỉ so sánh text đơn giản, miss gradual changes.

**Giải pháp:**
- [ ] Multi-frame window: so sánh text của frame hiện tại với N frame gần nhất
- [ ] Line-level diff: tách text thành lines, diff từng line
- [ ] Temporal merge: nếu text xuất hiện ≥ 3 frame liên tiếp => stable subtitle
- [ ] SRT cleanup: trim whitespace, merge duplicate lines
- [ ] Output validation: không xuất subtitle trống

#### 1.6 Job Queue + WebSocket Progress
**Vấn đề:** Xử lý đồng bộ, không biết progress, HTTP timeout.

**Giải pháp:**
- [ ] **Simple in-process queue** (dùng `asyncio.Queue`) — không cần Redis cho MVP
- [ ] POST `/api/process` → tạo job, trả về `job_id` ngay, chạy background
- [ ] WebSocket `/api/ws/{job_id}` → push progress events:
  ```json
  {"type": "progress", "current": 45, "total": 200, "phase": "ocr"}
  {"type": "text_chunk", "text": "...", "timestamp": "00:01:23,456"}
  {"type": "done", "srt_path": "..."}
  {"type": "error", "message": "..."}
  ```
- [ ] Client polling fallback: GET `/api/status/{job_id}` cho trường hợp WS không kết nối được
- [ ] Job timeout: hủy nếu quá 30 phút
- [ ] Cleanup job data sau 1 giờ

#### 1.7 Pydantic Models + Error Handling
- [ ] Request/Response models bằng Pydantic v2
- [ ] Custom exception handlers (`HTTPException` + JSON response)
- [ ] Global error handler cho unhandled exceptions
- [ ] Structured logging (structlog hoặc Python logging)

---

### 🔷 PHASE 2: Frontend Nâng cấp (2-3 ngày)

#### 2.1 Upload Component
- [ ] Upload progress bar (dùng `axios.onUploadProgress` hoặc `fetch` với `ReadableStream`)
- [ ] File size validation trước khi upload (>500MB → warning)
- [ ] Drag-drop refinement: preview thumbnail
- [ ] Loading skeleton animation

#### 2.2 Region Selector (Canvas Refactor)
- [ ] **RequestAnimationFrame loop** thay vì redraw mỗi state change
- [ ] Sử dụng `useRef` cho rect state để tránh re-render không cần thiết
- [ ] Lưu video playback state (currentTime) khi chuyển step
- [ ] Thêm zoom controls (optional)
- [ ] Keyboard shortcuts: Space = play/pause, Enter = confirm
- [ ] Touch events support (mobile)
- [ ] Debounce mousemove handler

#### 2.3 Process + Progress Page
- [ ] **WebSocket connection** tới `/api/ws/{job_id}`
- [ ] Progress bar với phases: "Extracting frames → OCR → Generating subtitle"
- [ ] Live preview: realtime text chunks khi OCR đang chạy
- [ ] ETA calculation dựa trên tốc độ OCR
- [ ] Cancel button → gửi signal hủy job
- [ ] Download SRT + preview trước khi download
- [ ] Auto-retry nếu kết nối WebSocket bị drop

#### 2.4 API Layer
- [ ] Axios interceptors: global error toast, auth headers (nếu cần)
- [ ] AbortController support cho request cancellation
- [ ] Timeout config (30s upload, 5 phút process polling)
- [ ] Type-safe API client (generated types từ backend models)

---

### 🔷 PHASE 3: Infrastructure & Performance (1-2 ngày)

#### 3.1 Backend Performance
- [ ] **Async OCR:** dùng `run_in_executor` với `ProcessPoolExecutor` cho OCR
- [ ] **Frame skip optimization:** nếu video 30fps, extract 2fps nhưng skip những frame gần giống nhau (dùng histogram diff)
- [ ] **Concurrent frame processing:** pipeline pattern (read frame → OCR → compare)
- [ ] **Memory-mapped video:** dùng OpenCV `VideoCapture` với seek thay vì FFmpeg extract all
- [ ] **SRT generation streaming:** ghi SRT incremental thay vì build cả file trong memory

#### 3.2 Frontend Performance
- [ ] Next.js **App Router** optimization (sử dụng Server Components cho static parts)
- [ ] Code splitting: lazy load RegionSelector (heavy component)
- [ ] Image optimization: video first frame serve dạng thumbnail nhỏ
- [ ] Bundle analysis: kiểm tra và giảm bundle size

#### 3.3 Deployment
- [ ] **Dockerfile** cho backend (Python slim + FFmpeg + OpenCV)
- [ ] **Dockerfile** cho frontend (multi-stage build)
- [ ] **docker-compose.yml** (backend + frontend)
- [ ] Healthcheck endpoints
- [ ] Graceful shutdown (handle SIGTERM)

---

### 🔷 PHASE 4: Quality & Edge Cases (1-2 ngày)

#### 4.1 Testing
- [ ] Unit test: `subtitle_generator`, `ocr_engine`, `video_processor`
- [ ] Integration test: full pipeline với video test ngắn
- [ ] API test: dùng `httpx.AsyncClient` với FastAPI `TestClient`
- [ ] Frontend test: Playwright component test cho RegionSelector

#### 4.2 Edge Cases
- [ ] Video không có subtitle (detect & báo sớm)
- [ ] Video nhiều ngôn ngữ (JP subtitle trong video Chinese)
- [ ] Video with hardcoded subs (text in frame) vs. soft subs
- [ ] Horizontal vs. vertical subtitle
- [ ] Subtitle style changes (màu sắc, font size)
- [ ] Very long video (3h+) → chunked processing
- [ ] Corrupted video file handling
- [ ] Concurrent upload xử lý cùng lúc

#### 4.3 Monitoring & Logging
- [ ] Request logging middleware
- [ ] Job duration metrics
- [ ] OCR success rate tracking
- [ ] Error rate alerting

---

## IV. TECHNICAL DECISIONS

### Backend Stack (Updated)

| Thành phần | Lựa chọn | Lý do |
|-----------|----------|-------|
| Framework | FastAPI | Giữ nguyên, phù hợp |
| Config | pydantic-settings + .env | Type-safe config |
| Video I/O | OpenCV `VideoCapture` (seek) + FFmpeg pipe | Memory efficient |
| Job Queue | `asyncio.Queue` + background task | Không cần Redis cho MVP |
| WebSocket | FastAPI WebSocket | Native support |
| Logging | structlog | Structured, dễ parse |
| Testing | pytest + httpx + pytest-asyncio | |

### Frontend Stack (Updated)

| Thành phần | Lựa chọn | Lý do |
|-----------|----------|-------|
| Framework | Next.js 14 App Router | Giữ nguyên |
| State | React hooks + useReducer | Đủ dùng, không cần Zustand |
| API | axios (nâng cấp interceptors) | Giữ nguyên, thêm features |
| Canvas | useRef + requestAnimationFrame | Performance |
| Progress | WebSocket | Real-time |
| Testing | Playwright | E2E testing |

---

## V. PRIORITY ORDER (Actionable)

### Ngay lập tức (Critical Path)
1. **Backend: Kiến trúc lại module** — tách routers, services, models
2. **Backend: Frame extraction on-demand** — không ghi tất cả frames ra disk
3. **Backend: Job queue + WebSocket** — processing bất đồng bộ
4. **Frontend: WebSocket progress** — user thấy được tiến trình

### Quan trọng
5. **Backend: Pydantic models** — validation + docs
6. **Backend: OCR batch + cache** — performance tăng 3-5x
7. **Frontend: Region selector refactor** — mượt hơn, ít re-render
8. **Frontend: Upload progress** — user experience

### Nên làm
9. **Backend: Cleanup mechanism** — tự động xóa temp files
10. **Backend: GPU fallback** — MPS cho Apple Silicon
11. **Frontend: Cancel processing**
12. **Backend: Subtitle generator smart diff**
13. **Docker setup**

### Nice to have
14. **Testing**
15. **Monitoring**
16. **Edge case handling**
17. **Mobile touch support**

---

## VI. RISK ASSESSMENT

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| PaddleOCR không support MPS | Cao | Trung bình | Fallback CPU + warning |
| Video rất dài (>3h) | Cao | Thấp | Chunked processing |
| Memory leak khi xử lý nhiều video | Cao | Trung bình | Resource limiting + cleanup cron |
| FFmpeg version incompatibility | Trung bình | Thấp | Validate version at startup |
| WebSocket connection unstable | Trung bình | Cao | Polling fallback |
| Browser canvas performance | Thấp | Thấp | WebGL acceleration nếu cần |

---

## VII. SUCCESS METRICS

- [ ] Thời gian xử lý video 10 phút < 3 phút (hiện tại không đo được vì không chạy)
- [ ] RAM usage < 500MB cho video 1h
- [ ] Disk usage < 100MB tạm thời (hiện tại = video_duration * 2fps * 50KB = rất lớn)
- [ ] Region selector response < 16ms per frame (60fps)
- [ ] WebSocket latency < 200ms
- [ ] Upload video 500MB < 10s (local network)
- [ ] Zero crash trên happy path
