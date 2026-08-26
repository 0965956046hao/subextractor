# Design: Chọn đoạn giữ tiếng gốc khi lồng tiếng (Keep Original Ranges)

Ngày: 2026-08-26
Trạng thái: Đã duyệt bởi user

## Bài toán

Trong Auto Pipeline, tuỳ chọn **"Âm thanh gốc → Tắt tiếng gốc"** (`muteOriginal=true`) chạy Demucs tách giọng và chỉ giữ nhạc nền — mất toàn bộ tiếng thoại gốc. Cần cho phép người dùng chọn trước các **đoạn thời gian** được giữ nguyên tiếng gốc (thoại + nhạc), trong khi vẫn lồng TTS tiếng Việt đè lên.

## Yêu cầu đã chốt

1. Trong đoạn được chọn: nghe **cả tiếng gốc + giọng TTS** (TTS vẫn đọc bình thường).
2. Bước chọn xuất hiện **trước khi chạy Demucs** (bên trong bước Lồng tiếng), UI giống phần chọn vùng xoá watermark.
3. Chỉ hiện khi bật toggle opt-in riêng — mặc định pipeline chạy tự động không bị dừng.

## Kiến trúc

### 1. Data model (frontend)

- `Pipeline` (frontend/src/stores/pipeline-store.ts) thêm:
  - `keepOriginalEnabled: boolean` — toggle opt-in, mặc định `false`.
  - `keepOriginalRanges: { start: number; end: number }[]` — giây.
- Toggle render trong nhóm cấu hình lồng tiếng, chỉ enable khi `muteOriginal = true`.
- Không thêm step mới vào `STEPS` (giữ nguyên index mọi nơi); việc chờ nằm bên trong bước Lồng tiếng.

### 2. Luồng frontend

1. `runPipeline` tới bước dub: nếu `dubOn && muteOriginal && keepOriginalEnabled && keepOriginalRanges.length === 0`:
   - `patch(id, { stage: "keep_original" })`
   - `await waitForKeepOriginal(id)` — pattern y hệt `waitForWatermarkRegion`: waiter map + poll `GET /api/pipeline/{id}` field `keep_original_confirm` để nhận xác nhận từ Telegram Mini App / tab khác.
2. `AutoPipeline.tsx` render modal `KeepOriginalSelector` khi `pipeline.stage === "keep_original"`.
3. Xác nhận → resolve ranges → gọi API dub kèm `keep_ranges`. Bỏ qua → resolve `[]` → luồng cũ.
4. Re-run/resume dub: nếu ranges đã có trong store thì không hỏi lại.

### 3. UI `KeepOriginalSelector`

- Dùng lại `VideoPlayer`; canvas overlay vẽ **trên thanh timeline** (trục thời gian dưới video), không vẽ trên khung hình.
- Tương tác:
  - Kéo trên timeline = tạo đoạn mới; kéo 2 đầu = chỉnh biên.
  - Click đoạn = chọn; nút Xoá xoá đoạn đang chọn.
  - Nút "+ Thêm đoạn" = tạo đoạn quanh playhead (±2s).
  - `Space` = play/pause; danh sách đoạn hiển thị `mm:ss – mm:ss`.
- Màu: đoạn giữ tô **xanh lá**, vùng bị mute tối màu (phân biệt với vùng watermark xanh dương).
- Nút: **Xác nhận** / **Bỏ qua (mute tất cả)**.

### 4. Backend

- `POST /api/dub/{video_id}` nhận thêm `keep_ranges: [{start, end}]` (giây) trong body — auto-pipeline gọi đúng endpoint này.
- Mini App xác nhận từ xa: route mới `POST /api/pipeline/{video_id}/keep-original` (body `{confirmed: bool, ranges}`) ghi vào trạng thái pipeline — đối xứng với flow timeline (`POST /api/pipeline/{id}/timeline`); `GET /api/pipeline/{id}` trả kèm field `keep_original_confirm` cho frontend poll.
- `build_full_audio(..., keep_ranges=None)` trong backend/app/services/dub_service.py:
  - Vẫn chạy Demucs lấy instrumental như cũ.
  - Hàm mới `_mix_background_with_keep_ranges(instrumental, original_wav, ranges)`:

    ```
    [1:a]volume=0:enable='between(t,s1,e1)+between(t,s2,e2)...'[kept];
    [0:a][kept]amix=inputs=2:duration=first:normalize=0[out]
    ```

    Kết quả: nhạc nền đầy đủ, tiếng gốc chỉ còn trong đoạn chọn.
  - Mix tiếp với `full_voice.mp3` bằng `_mix_background_with_voice` như hiện tại.
- Normalize ranges trước khi build filter: sort theo start, gộp overlap/adjacent (<0.05s), clamp `[0, duration]`, cap 200 đoạn.

### 5. Lỗi & edge cases

- Ranges rỗng sau normalize → fallback đúng luồng mute cũ.
- Ranges phủ toàn bộ video → background = original nguyên bản (bỏ volume filter).
- Cancel pipeline lúc đang chờ → reject waiter (pattern có sẵn).
- `volume=0` ngoài đoạn giữ cả nhạc gốc → chấp nhận: mục tiêu là "nhạc nền không lời" ngoài đoạn, đúng hành vi Demucs.

### 6. Verify

- Frontend: `npm run typecheck` (repo không có test/linter/formatter).
- Backend: không có test framework — kiểm chứng bằng cách chạy pipeline thật với toggle bật, dùng `ffmpeg volumedetect` trên `full_audio.m4a` trong/ngoài đoạn để xác nhận tiếng gốc chỉ còn ở đoạn đã chọn.

## Không làm trong phạm vi này

- Không đổi số bước `STEPS`, không đổi luồng Google/CapCut TTS.
- Không áp dụng cho luồng `/extract` thủ công (chỉ Auto Pipeline).
- Không waveform hiển thị chi tiết — chỉ timeline đơn giản.
