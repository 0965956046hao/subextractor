# Watermark region selection before OCR — Design

- Date: 2026-09-04
- Scope: FE only (`pipeline-store.ts`, `AutoPipeline.tsx` check). BE unchanged (OCR → delogo).
- Decision: Approach A — tách 2 pha (chọn vùng sớm, delogo sau OCR).

## 1. Context

Pipeline hiện tại (`frontend/src/stores/pipeline-store.ts`):
- `runPrep` xử lý steps 0–3 (resolving, merging, region, subtitle_preview) rồi `enqueue(id, 4)`.
- `runPipeline` từ step 4: OCR (step 4, `POST /api/process` + `pollJob`) → step 5: `waitForWatermarkRegion` (stage `watermark_region`, render `WatermarkRegionSelector` trong `AutoPipeline.tsx`) → delogo FFmpeg (`POST /api/delogo`, SSE) → context/translate/...
- `STEPS[4]` = "OCR trích phụ đề", `STEPS[5]` = "Xoá watermark". `STEP_STAGE` ánh xạ `watermark_region`/`wm_delogo` → 5, `processing` → 4.

Vấn đề: user phải chờ OCR xong mới được chọn vùng watermark → chờ bị động giữa pipeline.

## 2. Goal

- FE: màn chọn vùng watermark xuất hiện ngay sau "Chọn vùng quét sub" (trước OCR).
- BE/execution: giữ nguyên OCR → delogo (delogo dùng regions đã chọn sớm, không hỏi lại).
- Không vỡ progress/resume/retry, tương thích pipeline cũ.

## 3. Design (Approach A)

### 3.1 Luồng mới
1. `runPrep` sau step 2 (`region`, đã có `region`):
   - Nếu `!removeWatermarkEnabled` → `markStepSkipped(5)` + log "Bỏ qua xoá watermark", đi tiếp step 3.
   - Nếu enabled:
     - `markStepStart(5)` sớm, `patch({stage:'watermark_region', resumeStep: 5})`, log "[wm] Chờ kéo vùng watermark...".
     - Gửi Telegram Mini App (`POST /api/telegram/web-app`, `mode:'watermark'`) — chuyển nguyên code từ `runPipeline`.
     - `await waitForWatermarkRegion(id)` → `patch({removeWatermarkRegions})` → log số vùng. Không chạy delogo ở đây.
     - Rời stage (về `subtitle_preview` ở step 3). Ghi chú log: "Đã chọn vùng, delogo sẽ chạy sau OCR".
2. Step 3 (`subtitle_preview`) giữ nguyên → `enqueue(id, 4)`.
3. `runPipeline` step 5 rút gọn thành chỉ delogo:
   - Nếu `!removeWatermarkEnabled` → skip như cũ.
   - Nếu enabled + `removeWatermarkRegions` đã có → bỏ block 5a (chờ), chạy thẳng 5b delogo (check `GET /api/delogo/{id}/status`, SSE `POST /api/delogo`, `markStepEnd(5)`).
   - Fallback tương thích: nếu enabled mà regions rỗng (pipeline cũ / resume lỗi) → chạy block chờ cũ 1 lần rồi delogo.
4. `STEPS`/`STEP_STAGE`/index giữ nguyên (OCR=4, WM=5). Chỉ sửa `STEPS[5].detail` thành "Chọn vùng trước OCR, FFmpeg delogo sau OCR (có thể tắt)".

### 3.2 UI
- `AutoPipeline.tsx`: không đổi logic; `WatermarkRegionSelector` vẫn render theo `stage==='watermark_region'` — giờ stage này xảy ra trước OCR nên user thấy sớm. Kiểm tra không còn banner chọn vùng WM chen trong stage `region`.

### 3.3 Error handling & resume
- Cancel khi đang chờ ở `runPrep`: `rejectWatermarkRegion` hoạt động như cũ (waiter chỉ đổi nơi đăng ký).
- Tắt WM trước confirm → skip step 5, tiếp tục OCR.
- `restorePaused`/reload giữa chờ: resume từ `resumeStep`; nếu regions đã có → bỏ chờ, chạy delogo.
- Delogo fail → `stage='wm_error'` như cũ; SRT từ OCR không mất; "Thử lại" enqueue từ step 5 dùng regions cũ, không bắt chọn lại.

## 4. Files
- `frontend/src/stores/pipeline-store.ts` — `runPrep` (+block chọn vùng), `runPipeline` (−block 5a, giữ 5b + fallback), `STEPS[5].detail`.
- `frontend/src/components/AutoPipeline.tsx` — verify-only.

## 5. Verification (manual, không có test suite)
1. Bật WM → chọn vùng sub → chọn vùng WM ngay → subtitle_preview → OCR → delogo không hỏi lại.
2. Tắt WM → không hiện chọn vùng, OCR → skip delogo.
3. Reload giữa chờ chọn vùng → resume đúng.
4. Pipeline cũ (đã OCR, chưa regions) retry step 5 → fallback chờ 1 lần.

## 6. Non-goals
- Không đổi BE (`/api/process`, `/api/delogo`, worker OCR).
- Không đảo index `STEPS`/`STEP_STAGE`.
- Không gộp 2 selector thành 1 màn.

## Self-review
- Không còn placeholder/TBD; thuật ngữ `runPrep`/`runPipeline`/`waitForWatermarkRegion` khớp code hiện tại.
- Không mâu thuẫn: STEPS giữ index nhưng tương tác sớm — đã ghi rõ + đổi `detail` để tránh hiểu lầm progress.
- Scope vừa 1 plan FE duy nhất, không lan sang BE.
