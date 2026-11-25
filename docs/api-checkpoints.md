# Checkpoint Dịch Gemini và Lồng tiếng

## Dịch Gemini

- Model `gemini-3.5-flash-lite` tự fallback sang `gemini-3.1-flash-lite` khi Google trả lỗi quota `429 RESOURCE_EXHAUSTED`/quota exceeded. Trước đó vẫn thử xoay các API key khả dụng theo ngân sách retry; lỗi 503/timeout hoặc 429 không có dấu hiệu hết quota chỉ retry như cũ, không đổi model.
- Key/model bị hết quota được tạm bỏ qua theo `RetryInfo.retryDelay` của Google (ví dụ ~4,5 giờ trong lỗi quota ngày). Nếu không có thời gian chờ, mặc định 1 giờ với quota ngày và 60 giây với quota khác. Cooldown dùng chung trong RAM, không ghi key/cooldown xuống đĩa; restart backend sẽ kiểm tra lại. Hết cooldown sẽ thử model chính lại. Nếu cả hai model hết quota, không lặp gọi vô hạn; giữ fallback văn bản gốc hiện có sau hết retry.
- Việc đổi model chỉ áp dụng trong lời gọi API qua helper Gemini chung, không đổi setting model hay identity checkpoint, không dịch lại batch đã commit. Các batch trong một video có thể do hai model tạo; log dịch cho biết khi chuyển model. Model dự phòng vẫn phải được Google cấp quyền/quota cho API key/project; đổi model không bảo đảm vượt được quota chung của project.
- Sau mỗi batch 50 dòng, lưu bản dịch vào `temp/translated/{video_id}/checkpoints/{identity}/`.
- Bản dịch được lưu **trước** lời gọi tạo ghi chú ngữ cảnh. Pause trong lúc tạo ghi chú không làm mất batch đã dịch; resume tạo lại ghi chú nếu cần.
- Mỗi batch giữ ngữ cảnh trước/sau để resume không lặp ghi chú hoặc mất tính nhất quán tên nhân vật.
- Identity bao gồm SRT đầu vào, ngôn ngữ nguồn/đích, model, prompt và phiên bản checkpoint. Thay đổi đầu vào/cấu hình không tái dùng bản dịch cũ.
- Chỉ publish SRT cuối bằng atomic replace khi bước hoàn thành (kể cả chọn giọng nếu bật nhiều giọng). Không coi file dịch dở là kết quả hoàn chỉnh.
- Giữ logic fallback cũ: sau 3 lượt vẫn thiếu kết quả thì giữ các dòng đã dịch, dùng văn bản gốc cho vị trí còn thiếu, ghi cảnh báo và tiếp tục. Không xoá dòng hay đổi timeline. Lỗi request đã hết retry cũng dùng fallback này; pause/cancel vẫn dừng, không biến thành fallback.
- Batch có dòng fallback vẫn được lưu như batch hoàn tất và không tự dịch lại khi resume/restart. Muốn dịch lại phần còn nguyên gốc, dùng chức năng dịch lại dòng chưa dịch. Identity không đổi nên các checkpoint dịch đã lưu trước nâng cấp vẫn tái sử dụng được.

### Rà soát cuối trong Auto Pipeline

- Sau mỗi track Việt/Anh, frontend đối chiếu bản dịch rồi gửi `POST /api/srt/{id}/retranslate` với `background: true` nếu còn dòng chưa dịch. API trả `job_id` ngay, chạy trong lane `translate` và khóa Gemini hiện có; frontend poll `/api/status/{job_id}`, sau đó tải SRT đã vá. Không giữ request HTTP dài xuyên proxy trong lúc gọi Gemini.
- Dịch lại theo batch tối đa 50 dòng, giữ nguyên thứ tự/timeline và nguồn dịch của track. Có log tiến độ và kiểm tra pause/cancel giữa batch và trong retry Gemini. Hết retry vẫn giữ fallback cũ, không lặp rà soát vô hạn.
- Bản vá chỉ ghi vào đúng SRT ngôn ngữ đích bằng atomic replace sau khi lượt sửa xong và chưa bị hủy. Không xoá checkpoint dịch chính; lượt sửa đang dở chưa có checkpoint riêng, có thể phải làm lại sau restart.
- Client cũ không gửi `background` vẫn được hỗ trợ; lời gọi Gemini chạy trong thread, không chặn event loop của FastAPI. Client cũ vẫn có thể gặp timeout proxy nếu giữ request chờ quá lâu, nên cần cập nhật cả frontend lẫn backend.
- Frontend báo rõ HTTP status/nội dung khi proxy/backend trả text/HTML thay vì JSON, thay vì lỗi `Unexpected token ... is not valid JSON`.
- Khi reload trong lúc job dịch/vá đang chạy hoặc vừa xong, quay lại workflow dịch dùng SRT đã lưu để hoàn tất các bước rà soát/ngôn ngữ còn lại; không nhảy thẳng sang dub và bỏ qua track Anh.

## Lồng tiếng

- Google lưu checkpoint từng dòng trong `temp/tts/{video_id}/checkpoints/`; thay đổi một dòng/giọng chỉ tạo lại dòng không còn phù hợp.
- CapCut chia timeline thành **batch tối đa 150 dòng** (kể cả dòng trống/trùng). Nhiều giọng được gọi theo nhóm giọng trong cùng batch, chỉ commit khi mọi nhóm đã xử lý xong.
- Cache CapCut phụ thuộc text, thời gian, giọng thực tế, tốc độ và chính sách khoảng lặng của cả batch. Đổi/hỏng/thiếu một dòng làm mất hiệu lực **toàn bộ batch đó**, không ảnh hưởng batch khác có identity giữ nguyên.
- MP3 phải có checksum khớp và duration > 0. File dở/hỏng không được coi là checkpoint.
- CapCut tải MP3 vào thư mục tạm của lần chạy; callback tải xong chỉ cập nhật trạng thái trong RAM, **không lưu checkpoint từng dòng**. Khi cả batch xong, lưu MP3 và commit duy nhất `capcut_batches_v1/{identity}/batch.json` bằng atomic replace sau cùng. Không có manifest hợp lệ thì chạy lại toàn bộ batch, dù đã có vài MP3 trên đĩa. Service mất job sau restart (404) sẽ kết thúc poll để retry, thay vì chờ timeout dài.
- Google ngừng cấp việc/retry mới sau pause; kết quả của request đã gửi có thể hoàn tất và vẫn được lưu. CapCut gửi cancel cho job service khi phát hiện pause.
- Giữ đường dẫn MP3 từng dòng cũ cho chức năng nghe/sửa giọng. Kết quả tạo lại thủ công trên đường dẫn đã xác thực được đưa trở lại checkpoint.
- Full voice/full audio có metadata kiểm tra cấu hình, ghi file tạm rồi publish khi thành công. Pause khi đang gộp/trộn có thể phải làm lại phần gộp/trộn, nhưng không gọi lại TTS cho batch hợp lệ đã commit (Google: từng dòng).
- CapCut còn dòng lỗi sau **3 lượt tổng cộng ở cấp batch** (lần đầu + 2 lần thử lại) sẽ chèn khoảng lặng đúng thời lượng, ghi cảnh báo và tiếp tục pipeline. Trong cùng lần chạy, mỗi lượt chỉ gửi các dòng còn thiếu. Áp dụng cả một và nhiều giọng; SDK bên service vẫn có tối đa 3 lượt/segment riêng, không thay đổi. Google TTS giữ nguyên hành vi báo lỗi khi tổng hợp thất bại.
- Khoảng lặng do lỗi có `silence_kind: "fail"` trong metadata checkpoint và marker `.mp3.silence` ở đường dẫn audio từng dòng. Đây là fallback đã hoàn tất, **được tái sử dụng nhưng không được coi là giọng thật**. Khoảng lặng cố ý do dòng trùng dùng loại `dup` và vẫn được tái sử dụng.
- Resume dùng lại **mọi batch CapCut đã commit hợp lệ, kể cả batch có khoảng lặng `fail`**. Chỉ batch đang dở/chưa commit, file thiếu/hỏng, checksum sai hoặc identity không khớp mới phải tạo lại. Không tự quay lại sửa batch lỗi cũ trước khi đến phần chưa xử lý, và không có lượt tự rà soát/tạo lại giọng lỗi sau khi dub xong.
- `failed_indices` trong `batch.json` và `full_voice.meta.json` chỉ ghi nhận dòng dùng khoảng lặng lỗi; không tự làm mất hiệu lực cache batch/full voice. Audio tổng vẫn được kiểm tra identity, thời lượng và thay đổi MP3 như trước. Chỉnh sửa giọng thủ công được cập nhật ngược vào checkpoint, chỉ xoá marker lỗi của dòng đã sửa.
- Giữ nguyên định dạng/identity `capcut_batches_v1` và full voice: checkpoint batch đã lưu từ bản 4 lượt, kể cả có `fail`, dùng được ngay mà không phải di chuyển/xoá/tạo lại. Không đổi cách tính phần trăm tiến độ.
- Checkpoint CapCut từng dòng của phiên bản cũ được giữ trên đĩa nhưng không dùng làm batch đã commit. Lần chạy dub đầu theo chính sách mới có thể cần tạo lại audio; identity full voice cũng đổi để không bỏ qua cơ chế mới. Google không đổi identity hay cơ chế phục hồi.

## Pause, retry, làm lại

- Auto Pipeline có nút **Thử tiếp — giữ kết quả** cho video lỗi (nút **Thử tiếp** ở danh sách). Nút này không gọi reset-from, không xoá SRT, audio, checkpoint hay các quyết định duyệt; nó đưa pipeline về bước lỗi với ưu tiên resume. Ở bước dịch: dùng lại SRT đã có, chạy rà soát cuối cho track chưa duyệt và dịch ngôn ngữ còn thiếu. Checkpoint chỉ được dùng lại khi khớp đầu vào/cấu hình.
- Nút **Chạy lại** theo từng bước vẫn giữ hành vi reset/cascade cũ, khác với **Thử tiếp — giữ kết quả**. Nếu đã có SRT dịch hoàn tất, chạy lại bước dịch có thể xoá cả bản dịch lẫn checkpoint; không dùng nút này nếu chỉ muốn tiếp tục phần lỗi mà giữ output.
- Pause giữ file trên đĩa. Resume/restart backend rồi tiếp tục dùng lại checkpoint phù hợp.
- Retry/reset một bước **chưa có kết quả cuối** giữ riêng thư mục `checkpoints`.
- Chạy lại bước đã hoàn tất xoá checkpoint của bước đó theo cơ chế reset hiện có, **trừ dub có `failed_indices`**: trường hợp này giữ checkpoint và tái dùng mọi batch hợp lệ, kể cả khoảng lặng lỗi; chỉ ghép/trộn lại phần output đã xoá. Không tự retry giọng lỗi. Cờ `discard_checkpoint: true` vẫn buộc làm mới toàn bộ.
- `POST /api/video/{id}/reset-from` với `{"from_step": 7, "discard_checkpoint": true}` (hoặc bước 8) buộc bỏ checkpoint và làm mới. OCR giữ cờ `discard_ocr_checkpoint` riêng, không thay đổi.
- Không tự nhập MP3 legacy không có metadata vì không xác minh được text/engine/tốc độ. Lần chạy đầu sau nâng cấp có thể phải tạo lại những đoạn legacy đó.
- Request Gemini/TTS đã gửi và lệnh FFmpeg đang chạy không được bảo đảm huỷ tức thì; checkpoint chỉ đảm bảo tái sử dụng kết quả đã commit. Nhận diện/chọn giọng Gemini trong multi-voice chưa có checkpoint từng batch riêng; nếu bị ngắt ở phần này có thể cần chọn giọng lại, nhưng batch dịch đã lưu không phải dịch lại.

Không thay đổi OCR, watermark, scheduler hoặc tự restart dịch vụ.

Kiểm thử (mock API, không phát sinh chi phí):

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
