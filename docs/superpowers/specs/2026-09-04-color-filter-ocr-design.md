# Design: Chọn màu chữ cần OCR (Color Filter)

**Date:** 2026-09-04
**Status:** Approved
**Scope:** Step "Chọn vùng quét sub" — thêm bộ lọc màu trước OCR

## 1. Mục tiêu
Cho phép user chọn màu chữ subtitle cần OCR (ví dụ trắng `#FFFFFF`) + tolerance để loại chữ xám chồng, áp dụng cho cả RapidOCR và Apple Vision. Video có anti-aliasing/shadow nên cần so màu theo khoảng tolerance, không so chính xác.

## 2. Yêu cầu đã chốt
- MVP: **1 màu** (mở rộng multi-color phase 2)
- Eyedropper: **click trực tiếp lên frame video** để lấy màu (canvas getImageData)
- Tolerance: slider **0–100**, default **30**
- Toggle **Enable/Disable** per pipeline
- Áp dụng cho **cả RapidOCR + Apple Vision**
- Vị trí: panel mới trong `RegionSelector` (step chọn vùng quét)

## 3. Kiến trúc

```
RegionSelector (FE)
  ├─ Toggle enabled
  ├─ ColorPicker + HEX input + Eyedropper btn
  ├─ Tolerance slider
  └─ Preview Mask canvas (JS, realtime)
        ↓ ColorFilter {enabled, color, tolerance}
pipeline-store (FE) → ProcessRequest (BE)
        ↓
worker.py → BaseOCREngine.ocr_region_cached(crop, color_filter)
        ↓
apply_color_mask(crop, hex, tolerance) → masked_crop
        ↓
ocr_image(masked_crop) → text
```

## 4. Data Model

### Shared Type
```ts
// frontend/src/stores/pipeline-store.ts & backend/app/models.py
ColorFilter {
  enabled: boolean
  color: string   // "#RRGGBB"
  tolerance: number // 0-100
}
```
Default: `{ enabled:false, color:"#FFFFFF", tolerance:30 }`

### FE Store
- `Pipeline.colorFilter?: ColorFilter`
- `addPipeline(..., colorFilter)` / `addPipelineFromUpload(...)` extend thêm param.

### BE Model
```python
class ColorFilter(BaseModel):
    enabled: bool = False
    color: str = "#FFFFFF"
    tolerance: int = Field(default=30, ge=0, le=100)

class ProcessRequest(BaseModel):
    ...
    color_filter: ColorFilter | None = None
```

## 5. Frontend — `RegionSelector.tsx`

**Props mở rộng:**
```ts
interface Props {
  videoId: string
  onConfirmed: (region: Region, startTime?: number, colorFilter?: ColorFilter) => void
  initialColorFilter?: ColorFilter
}
```

**UI Panel (glass-panel) dưới video:**
- Row 1: Toggle `Enable color filter` + badge màu hiện tại
- Row 2: `input type=color` + `input HEX` + nút Eyedropper (khi bật: canvas overlay `cursor: crosshair`)
- Row 3: Slider tolerance 0–100 + label giá trị
- Row 4: Preview Mask canvas 320x~180 — crop hiện tại được mask theo JS logic, cập nhật mỗi khi color/tolerance/region đổi.

**Eyedropper logic:**
```ts
const pickColor = (e: pointerEvent) => {
  const rect = canvas.getBoundingClientRect()
  const x = (e.clientX - rect.left) * (canvas.width / rect.width)
  const y = (e.clientY - rect.top) * (canvas.height / rect.height)
  const [r,g,b] = ctx.getImageData(x,y,1,1).data
  onColorFilterChange({ ...filter, color: rgbToHex(r,g,b) })
}
```

**Preview Mask (JS):**
- Lấy `ImageData` của crop region, tính `dist = sqrt((r-R)²+(g-G)²+(b-B)²)` per pixel, nếu `dist > tolerance` → set pixel thành nền tương phản (luma>128 ? black : white).

**Tích hợp:**
- `extract/page.tsx` và `AutoPipeline.tsx` truyền `colorFilter` khi gọi `onConfirmed`.

## 6. Backend — `services/color_mask.py` (mới)

```python
def hex_to_rgb(hex_str: str) -> tuple[int,int,int]
def apply_color_mask(crop: np.ndarray, color_hex: str, tolerance: int) -> np.ndarray:
    # hex -> (R,G,B)
    # dist = np.linalg.norm(crop.astype(int) - RGB, axis=2)
    # mask = dist <= tolerance
    # bg = 0 if luma(R,G,B) > 128 else 255  # tương phản
    # result = np.where(mask[...,None], crop, bg)
    # return result
```

- Vectorized với numpy, không loop Python.
- Clamp tolerance, fallback hex invalid → #FFFFFF.
- Crop rỗng → return rỗng.

## 7. Backend — `services/ocr_engine.py`

- `BaseOCREngine.ocr_region_cached(self, crop: np.ndarray, color_filter: ColorFilter | None = None) -> str`
- Nếu `color_filter and color_filter.enabled` → `crop = apply_color_mask(crop, color_filter.color, color_filter.tolerance)` trước khi so dHash và trước `ocr_image`.
- dHash vẫn tính trên ảnh đã mask để cache đúng.

## 8. Backend — `worker.py` & `routers/process.py`

- `routers/process.py`: đọc `color_filter` từ `ProcessRequest`, truyền vào `enqueue_job`/job payload.
- `worker.py: process_job_sync` lấy `color_filter` từ job, truyền vào `ocr_region_cached` trong vòng lặp OCR (cả branch song song nếu có).
- Persist vào `videos/{id}/meta.json` nếu cần preview sau.

## 9. Error Handling
- HEX sai định dạng → fallback #FFFFFF, log warning.
- Tolerance ngoài 0–100 → clamp.
- disabled / None → bypass mask hoàn toàn.
- Crop size 0 → return "".

## 10. Testing
- Unit: `test_color_mask.py` — test white keep, gray removed, tolerance biên.
- Manual: video có chữ trắng + xám chồng, chọn #FFFFFF tolerance 30 → OCR chỉ ra text trắng.

## 11. Future (Phase 2)
- `colors: ColorFilter[]` + merge OCR multi-pass
- HSV distance, brightness/saturation threshold, invert
- `POST /api/preview/color-mask` endpoint trả PNG mask
- Preset lưu `user_config.json` + localStorage

## 12. Files thay đổi (MVP)
- `frontend/src/components/RegionSelector.tsx`
- `frontend/src/stores/pipeline-store.ts`
- `frontend/src/app/extract/page.tsx` & `frontend/src/components/AutoPipeline.tsx` (wiring)
- `backend/app/models.py`
- `backend/app/services/color_mask.py` (new)
- `backend/app/services/ocr_engine.py`
- `backend/app/worker.py`
- `backend/app/routers/process.py`
