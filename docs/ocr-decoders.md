# Chọn decoder video cho OCR

## UI

- Auto Pipeline → tab cấu hình nguồn/OCR → **Giải mã video**.
- Chi tiết từng pipeline có cùng lựa chọn. Khi đang chạy/chờ, tạm dừng trước khi đổi; tiếp tục sẽ dùng lựa chọn mới.
- Trang `/extract` cũng có lựa chọn ở bước chọn vùng phụ đề.
- Chỉ có 2 giá trị: `nvdec` (GPU — NVDEC), `ffmpeg_cpu` (CPU — FFmpeg).
- Video mới mặc định `nvdec`. Video cũ không có `ocrDecoder`, hoặc còn lưu giá trị decoder đã bỏ, được chuyển sang `ffmpeg_cpu` khi đọc cấu hình (localStorage/metadata/API).
- Setting lưu theo video ở `meta.json.pipeline_settings.ocrDecoder`, đồng thời lưu trong pipeline để reload/resume không lấy nhầm giá trị từ form tạo video mới.
- Đổi decoder không tự xoá kết quả đã hoàn tất. Muốn so sánh một video đã có SRT, chọn decoder rồi **chạy lại từ bước OCR** (reset cascade như trước).

## API và xử lý

`POST /api/process` nhận `decoder: "nvdec" | "ffmpeg_cpu"`, mặc định `nvdec`. Giá trị API cũ `opencv` chỉ được nhận để migrate sang `ffmpeg_cpu`; không còn nhánh decode tương ứng. Job cũ thiếu field dùng FFmpeg CPU khi tiếp tục.

- Decoder tách biệt engine OCR: chọn CPU decode vẫn có thể nhận dạng bằng PaddleOCR GPU.
- Trước khi tạo/load checkpoint, worker kiểm tra decoder bằng một frame thật. NVDEC không dùng được thì fallback **FFmpeg CPU**, kiểm tra CPU thành công rồi mới chạy. Nếu cả hai lỗi, báo lỗi rõ thay vì âm thầm dùng decoder đã bỏ.
- Nhánh FFmpeg hiện hỗ trợ nguồn CFR được xác nhận bằng nominal/average FPS. NVDEC giới hạn yuv420p 8-bit và ánh xạ H.264, HEVC, AV1, VP9, MPEG-2, VC-1 sang CUVID; format khác chuyển sang CPU. FFmpeg CPU chuyển pixel format được hỗ trợ sang BGR. Nguồn VFR/FPS không xác định hiện báo lỗi rõ; không còn fallback OpenCV.
- Giữ cách chọn `frame_index % step == 0`, timestamp theo frame index/FPS và overlap của checkpoint. Không dùng filter `fps` có thể sinh/bỏ frame khác với logic cũ.
- Frame NVDEC được download về RAM, chuyển BGR NumPy rồi crop/OCR như trước. Không đổi model, FPS, cache hay thuật toán subtitle.
- Dừng/đóng generator sẽ kill và wait FFmpeg. Watchdog kiểm tra cancel và timeout đọc frame 60s để pipe bị treo không giữ worker mãi.
- Lỗi xảy ra **sau** preflight sẽ báo lỗi và giữ checkpoint hoàn chỉnh, không âm thầm trộn decoder trong cùng lượt. Có thể chọn FFmpeg CPU để chạy tiếp bằng namespace tương ứng.
- Đã bỏ hai hàm đọc frame OCR bằng OpenCV cũ khỏi `video_processor.py`. Thư viện OpenCV vẫn dùng để crop/xử lý ảnh, đọc metadata và preview — không phải decoder OCR.

## Checkpoint

- Identity dùng **decoder thực tế**, không chỉ decoder yêu cầu.
- NVDEC và FFmpeg CPU có namespace riêng, kèm phiên bản implementation.
- Checkpoint từ decoder đã bỏ được giữ trên đĩa nhưng không được dùng lẫn với FFmpeg do khác chuyển đổi pixel. Checkpoint FFmpeg CPU/NVDEC hiện có vẫn giữ identity tương thích.
- NVDEC fallback CPU chỉ dùng namespace FFmpeg CPU; không đọc/gộp chunk NVDEC đã lưu.
- Không thay hành vi reset OCR hoàn chỉnh: chạy lại từ bước OCR vẫn xoá kết quả downstream theo cơ chế reset hiện có.

## Verify

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

```powershell
cd frontend
npx tsc --noEmit --incremental false
node scripts/test-ocr-decoder.cjs
```

Smoke test trước đây trên nguồn H.264 `355db03ec8a4`: NVDEC/FFmpeg CPU đều qua preflight thật, trả đúng số frame/timestamp. Thử nghiệm OCR đầy đủ trước tích hợp được ghi trong `ocr-profiling.md`; bảng OpenCV trong đó là dữ liệu lịch sử, không phải lựa chọn còn hỗ trợ.

Backend không có `--reload` cần restart khi không có job chạy để nạp schema/worker mới. Không cần restart CapCut TTS. Việc triển khai này không tự restart dịch vụ.
