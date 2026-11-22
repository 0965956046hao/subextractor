# Đo hiệu năng OCR mà không ghi đè kết quả

Chạy từ `backend/`, khi backend không có job đang chạy:

```powershell
.\.venv\Scripts\python.exe scripts/profile_ocr.py VIDEO_ID --output 'C:\Users\ADMIN\AppData\Local\Temp\opencode\ocr-profile-NEW-RUN'
```

- Thư mục output bắt buộc là thư mục mới. Script không xoá checkpoint/SRT production và không đưa job vào pipeline dịch/lồng tiếng.
- Dùng đúng `resolve_video_path`, vùng OCR/ngôn ngữ trong metadata và các cấu hình model/FPS/worker hiện tại. Không thay thuật toán/model để làm đẹp số đo.
- Khởi tạo một pool OCR riêng trong process riêng, gọi đúng `process_job_sync` và tạo checkpoint mới trong output. Không cần restart backend. Backend vẫn giữ model đã cấp phát, vì vậy VRAM đo được là tổng GPU, không chỉ process đo.
- Không chạy thêm job trên backend trong lúc đo. Script ghi nhận job khác mỗi khoảng 10 mẫu để phát hiện nhiễu, không can thiệp các job đó.
- Hiện chỉ nhận `--decode ffmpeg-gpu` (mặc định) hoặc `--decode ffmpeg-cpu`; không còn lựa chọn OpenCV. Script gọi đường decode production và ghi `actual_decoder` nếu NVDEC fallback CPU.

## Báo cáo

`report.json` chứa thông tin video, device detector/recognizer, thống kê từng chunk và mẫu GPU/CPU. `subtitles.srt` chỉ là kết quả diagnostic riêng.

- `wall_seconds`: thời gian thực từ bắt đầu OCR đến khi xong, không gồm tải model/warm-up.
- `frame_stream_seconds`: thời gian lấy frame kế tiếp, gồm mở/seek/decode/chọn frame/tqdm. Thời gian khi generator đang yield để chạy OCR **không** bị cộng vào đây.
- `crop_seconds`: cắt vùng phụ đề.
- `model_seconds`: host wall time gọi `ocr_image`, gồm pipeline nhận dạng, chuyển dữ liệu và parse kết quả. Không phải CUDA kernel time và có thể bao gồm chờ GPU/thread.
- `cache_check_seconds`: thời gian wrapper cache trừ thời gian model.
- `model_calls`, `cache_hits`, `sampled_frames`: phân biệt số ảnh được xét với số lần gọi model thật.
- `other_seconds`: thời gian segment còn lại (lock/chờ, subtitle logic, callback/log, v.v.).

`worker_totals` là tổng **worker-seconds**: với 2 worker có thể lớn gần 2 lần `wall_seconds`. Chỉ so tỷ trọng trên cùng tổng worker-seconds; không cộng chúng vào thời gian thực hoặc suy diễn trực tiếp mức tăng tốc khi thay một công đoạn.

GPU utilization/power/VRAM là số toàn GPU từ `nvidia-smi`. CPU process có thể lớn hơn 100% do sử dụng nhiều core. Đây là phép đo pipeline thực tế để định hướng tối ưu, không thay thế CUDA profiler nếu cần phân tích kernel/batching chi tiết.

## Thử decode GPU riêng (không đổi production)

```powershell
.\.venv\Scripts\python.exe scripts/compare_ocr_decode.py VIDEO_ID --output 'C:\Users\ADMIN\AppData\Local\Temp\opencode\ocr-decode-NEW-RUN' --baseline 'C:\Users\ADMIN\AppData\Local\Temp\opencode\ocr-profile-PREVIOUS-RUN'
```

- Chạy tuần tự 2 lượt OCR đầy đủ: FFmpeg NVDEC, rồi FFmpeg CPU đối chứng. Mỗi lượt có checkpoint/output mới. Model/FPS/worker/vùng phụ đề giữ nguyên.
- `--decode ffmpeg-gpu` yêu cầu CUVID và frame CUDA; nếu preflight lỗi sẽ thử FFmpeg CPU như production, báo `actual_decoder`. `--decode ffmpeg-cpu` không có hardware acceleration. Cả hai trả frame BGR qua pipe về RAM vì OCR hiện nhận NumPy. Khi phân tích phép đo phải kiểm tra decoder thực tế, không chỉ tên lượt chạy.
- Hiện hỗ trợ nguồn CFR; NVDEC giới hạn yuv420p 8-bit, CPU có thể chuyển các pixel format FFmpeg hỗ trợ. Chưa hỗ trợ VFR trong luồng OCR này.
- Giữ quy tắc chọn frame toàn cục (`index % step == 0`), seek tới start frame của mỗi chunk và giới hạn chính xác số frame đầu ra. Không dùng bộ lọc `fps` có thể nhân/bỏ frame theo timestamp khác với OpenCV.
- FFmpeg CPU đối chứng dùng NV12 trước chuyển BGR để khớp layout của NVDEC. Khi thử các mẫu ở giây 0/118/238/358 trên video `355db03ec8a4`, frame CPU/GPU FFmpeg khớp pixel tuyệt đối và timestamp khớp OpenCV. Ảnh BGR OpenCV không khớp pixel tuyệt đối với FFmpeg, vì vậy không được gán mọi chênh lệch với baseline OpenCV cho NVDEC.
- Báo cáo có `decoder_percent` từ `nvidia-smi`, tổng thời gian có tính transfer/pipe/FFmpeg startup/seek. Phần CPU process chỉ đo Python OCR, **không** gồm subprocess FFmpeg; xem thêm `system_cpu_percent` để tránh so CPU process sai giữa các backend.
- `comparison.json` đối chiếu số frame, tổng thời gian và SRT/text/timestamp. Độ giống SRT không phải độ chính xác vì không có transcript ground truth. Cần kiểm tra các dòng khác nhau trước khi cân nhắc áp dụng.

Không chạy hai lượt cùng lúc, không tự đổi decode mặc định và không restart dịch vụ.

### Kết quả lịch sử ngày 2026-11-18 — `355db03ec8a4` (trước khi bỏ decoder OpenCV)

Nguồn 394,37 giây, 1080p/30 FPS; OCR 15 FPS, 2 worker, PP-OCRv6 medium, checkpoint mới. Không ghi nhận job backend khác trong các mẫu theo dõi. Mỗi cấu hình mới đo một lượt, chưa có thống kê nhiều lượt.

| Đường đọc frame | Tổng OCR (không gồm khởi tạo model) | So baseline |
|---|---:|---:|
| OpenCV CPU | 221,39s | baseline |
| FFmpeg NVDEC | 176,61s | giảm 20,2% |
| FFmpeg CPU đối chứng | 169,57s | giảm 23,4% |

- Cả ba xét 6.096 frame (gồm overlap). FFmpeg CPU/NVDEC đều gọi OCR 5.999 lần, cache hit 97 lần và tạo SRT **giống hệt**, 212 entries.
- NVDEC decoder utilization trung bình 2,71%, cao nhất 6%; đối chứng CPU là 0%. GPU decode đã thực sự hoạt động, không phải fallback.
- NVDEC chậm hơn FFmpeg CPU khoảng 7,04s (4,2%) trong cặp đo này. Chưa có bằng chứng lợi ích của chuyển riêng decode sang GPU; không nên mặc định bật NVDEC chỉ dựa vào việc nó nhanh hơn OpenCV.
- OpenCV tạo 218 entries; FFmpeg tạo 212. Độ giống text 98,68% không phải độ chính xác; có khác biệt text/ranh giới, cần review trước khi dùng FFmpeg thay production. Không khẳng định FFmpeg tốt hơn hoặc làm mất 6 câu chỉ từ số entries.
- Báo cáo gốc: `C:\Users\ADMIN\AppData\Local\Temp\opencode\ocr-decode-355db03ec8a4-20261118-b\comparison.json`, kèm `report.json` từng lượt. OpenCV baseline nằm ở thư mục `ocr-profile-355db03ec8a4-20261118-a` cùng cấp.

Kết luận của phép đo lúc đó: chưa thấy lợi ích NVDEC so với FFmpeg CPU. Sau đó UI đã được bổ sung để người dùng tự chọn hai đường FFmpeg; decoder OpenCV đã được bỏ theo yêu cầu. Không gán mức giảm 20,2% riêng cho NVDEC vì đối chứng CPU còn nhanh hơn.
