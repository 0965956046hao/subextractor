# Douyin Channel Batch → Pipeline (Hướng A: frontend-only batch)

Ngày: 2026-09-28. Trạng thái: đề xuất đã được user duyệt (hướng A).

## 1. Mục tiêu

Trên trang `/channels` (giữ nguyên luồng lưu kênh → quét), sau khi quét 1 kênh Douyin:

- Kết quả nhóm theo **playlist/collection (合集)** + nhóm "Tất cả video" flat như hiện tại.
- Mỗi video có **checkbox**; mỗi playlist có checkbox chọn cả bộ + chọn tất cả.
- Nút **"Đẩy N video vào pipeline"** kèm dropdown chọn **preset** (preset đã set sẵn ở `/auto`).
- Luật cấu hình (theo yêu cầu user):
  - N video **cùng 1 collection** → apply thẳng preset đã chọn cho cả N, enqueue N pipeline chạy nối tiếp.
  - N video thuộc **≥2 collection khác nhau** → hiện **popup hỏi**: "Dùng chung cấu hình (preset X) cho tất cả" hay "Set riêng từng cái".

Không thêm backend endpoint mới. Không thay đổi worker/pipeline runner.

## 2. Phạm vi / Không làm

- Làm: `scan/route.ts` (bắt thêm API mix), `channels/page.tsx` (checkbox + batch bar + popup), dùng `getPipelinePresets()` + `addPipeline()` có sẵn.
- Không làm: endpoint batch backend, Telegram bot batch, phân trang full kênh (giữ scroll 3 lần như hiện tại; ghi rõ `total` là số bắt được, không claim "toàn bộ" nếu Douyin không trả hết), quét nhanh không cần lưu.

## 3. Kiến trúc / Data flow

```
channels/page.tsx ──POST /api/channels/scan {url, since}──▶ scan/route.ts
      (puppeteer: intercept aweme/post/ + mix API)
scan/route.ts ──▶ { channel_name, total, filtered, videos[], playlists: [{id, title, videos[]}] }
page.tsx: group UI (collapsible per playlist) + selection state (Set<aweme_id>)
  ── user chọn preset + "Đẩy N video" ─▶ popup (nếu cross-collection)
  ──▶ N lần addPipeline(shareUrl, presetConfig...) ─▶ router.push("/auto")
```

- `shareUrl` mỗi video: ưu tiên `share_link_desc || share_url || https://www.douyin.com/video/{aweme_id}` (giữ logic hiện tại).
- Preset config → `addPipeline(url, regionMode, dub, autoFit, ...)` đúng thứ tự tham số hiện tại của store; lấy từ `preset.config` (mirror `applyPreset` trong `AutoPipeline.tsx`).
- Skip video đã tồn tại trong store (trùng URL/shareUrl) → báo "đã bỏ qua K video trùng".

## 4. Chi tiết thay đổi

### 4.1 `frontend/src/app/api/channels/scan/route.ts`

- Thêm listener cho response URL chứa `mix` (vd `aweme/v1/web/mix/list`, `channel/mix`, hoặc item có `mix_info`): thu thập `{mix_id, mix_name}` + map `aweme_id → mix_id`.
- Response thêm field `playlists: [{ id, title, count, videos: AwemeItem[] }]`; video không thuộc bộ nào → không nằm trong playlist nào (UI gom vào "Chưa phân loại").
- **Fallback:** nếu không bắt được mix API → `playlists: []`, UI chỉ hiện flat list + checkbox (không vỡ trang).
- Giữ nguyên filter `since`, sort desc, dedupe theo `aweme_id`.

### 4.2 `frontend/src/app/channels/page.tsx`

- State: `selected: Set<string>` (aweme_id), `playlists` từ scan result, `presetId` cho batch, `showCrossPopup: boolean`.
- UI:
  - Mỗi playlist = collapsible section: header (tên bộ, count, checkbox chọn cả bộ với trạng thái indeterminate).
  - Bảng "Tất cả video" giữ nguyên cột hiện tại + thêm cột checkbox đầu dòng.
  - Sticky bottom bar khi `selected.size > 0`: "Đã chọn N video · [dropdown preset] · [Đẩy vào pipeline] · [Bỏ chọn]".
  - Cột "Auto Pipeline" đơn lẻ giữ nguyên (chạy lẻ 1 video).
- Batch handler:
  1. Lấy preset được chọn (mặc định preset đầu tiên hoặc preset đang dùng ở `/auto` nếu có).
  2. Nhóm video đã chọn theo collection. Nếu ≥2 collection → mở popup với 2 lựa chọn:
     - **[Dùng chung preset X]:** apply preset cho cả N video, gọi `addPipeline(...)` từng URL, rồi `router.push("/auto")`.
     - **[Set riêng]:** gọi `addPipeline(...)` từng URL với cấu hình mặc định (không apply preset, `regionMode: "manual"`), mỗi pipeline sẽ dừng ở bước chọn vùng sub để user chỉnh tay từng cái, rồi `router.push("/auto")`.
  3. Skip video đã tồn tại trong store (trùng URL/shareUrl) → báo "đã bỏ qua K video trùng".
- i18n: thêm key `channel.*` mới vào dict hiện tại (vi/en), không hardcode tiếng Việt trong JSX.

## 5. Error handling

- Scan không ra mix → flat + checkbox (đã nêu ở 4.1).
- Preset list rỗng → disable nút batch, tooltip "Hãy tạo preset ở /auto trước".
- `addPipeline` khi backend chưa healthy: tái dùng `health` check như `AutoPipeline.handleAdd` (gọi check, không enqueue mù).
- Puppeteer/Chromium lỗi: giữ nguyên message lỗi scan hiện tại.

## 6. Testing (không có test/lint/CI trong repo)

- Manual: quét 1 kênh thật có 合集 → verify nhóm playlist đúng; tick lẻ / cả bộ / tất cả; batch cùng-collection (đi thẳng); batch cross-collection (popup hiện); preset apply đúng (so region/voice với preset); skip trùng.
- `npm run typecheck` (tsc --noEmit) trong `frontend/` phải pass.

## 7. Rủi ro

- Douyin đổi tên API mix → fallback flat list, tính năng chọn nhiều vẫn xài được, chỉ mất nhóm playlist. Ghi log console khi fallback để dễ debug.
