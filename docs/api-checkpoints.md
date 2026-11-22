# Checkpoint Dịch Gemini và Lồng tiếng

## Dịch Gemini

- Sau mỗi batch 50 dòng, lưu bản dịch vào `temp/translated/{video_id}/checkpoints/{identity}/`.
- Bản dịch được lưu **trước** lời gọi tạo ghi chú ngữ cảnh. Pause trong lúc tạo ghi chú không làm mất batch đã dịch; resume tạo lại ghi chú nếu cần.
- Mỗi batch giữ ngữ cảnh trước/sau để resume không lặp ghi chú hoặc mất tính nhất quán tên nhân vật.
- Identity bao gồm SRT đầu vào, ngôn ngữ nguồn/đích, model, prompt và phiên bản checkpoint. Thay đổi đầu vào/cấu hình không tái dùng bản dịch cũ.
- Chỉ publish SRT cuối bằng atomic replace khi bước hoàn thành (kể cả chọn giọng nếu bật nhiều giọng). Không coi file dịch dở là kết quả hoàn chỉnh.
- Giữ logic fallback cũ: sau 3 lượt vẫn thiếu kết quả thì giữ các dòng đã dịch, dùng văn bản gốc cho vị trí còn thiếu, ghi cảnh báo và tiếp tục. Không xoá dòng hay đổi timeline. Lỗi request đã hết retry cũng dùng fallback này; pause/cancel vẫn dừng, không biến thành fallback.
- Batch có dòng fallback vẫn được lưu như batch hoàn tất và không tự dịch lại khi resume/restart. Muốn dịch lại phần còn nguyên gốc, dùng chức năng dịch lại dòng chưa dịch. Identity không đổi nên các checkpoint dịch đã lưu trước nâng cấp vẫn tái sử dụng được.

## Lồng tiếng

- Google lưu checkpoint từng dòng trong `temp/tts/{video_id}/checkpoints/`; thay đổi một dòng/giọng chỉ tạo lại dòng không còn phù hợp.
- CapCut chia timeline thành **batch tối đa 150 dòng** (kể cả dòng trống/trùng). Nhiều giọng được gọi theo nhóm giọng trong cùng batch, chỉ commit khi mọi nhóm đã xử lý xong.
- Cache CapCut phụ thuộc text, thời gian, giọng thực tế, tốc độ và chính sách khoảng lặng của cả batch. Đổi/hỏng/thiếu một dòng làm mất hiệu lực **toàn bộ batch đó**, không ảnh hưởng batch khác có identity giữ nguyên.
- MP3 phải có checksum khớp và duration > 0. File dở/hỏng không được coi là checkpoint.
- CapCut tải MP3 vào thư mục tạm của lần chạy; callback tải xong chỉ cập nhật trạng thái trong RAM, **không lưu checkpoint từng dòng**. Khi cả batch xong, lưu MP3 và commit duy nhất `capcut_batches_v1/{identity}/batch.json` bằng atomic replace sau cùng. Không có manifest hợp lệ thì chạy lại toàn bộ batch, dù đã có vài MP3 trên đĩa. Service mất job sau restart (404) sẽ kết thúc poll để retry, thay vì chờ timeout dài.
- Google ngừng cấp việc/retry mới sau pause; kết quả của request đã gửi có thể hoàn tất và vẫn được lưu. CapCut gửi cancel cho job service khi phát hiện pause.
- Giữ đường dẫn MP3 từng dòng cũ cho chức năng nghe/sửa giọng. Kết quả tạo lại thủ công trên đường dẫn đã xác thực được đưa trở lại checkpoint.
- Full voice/full audio có metadata kiểm tra cấu hình, ghi file tạm rồi publish khi thành công. Pause khi đang gộp/trộn có thể phải làm lại phần gộp/trộn, nhưng không gọi lại TTS cho batch hợp lệ đã commit (Google: từng dòng).
- CapCut còn dòng lỗi sau 4 lượt retry sẽ chèn khoảng lặng đúng thời lượng, ghi cảnh báo và tiếp tục pipeline (khôi phục hành vi trước checkpoint). Áp dụng cả một và nhiều giọng. Google TTS giữ nguyên hành vi báo lỗi khi tổng hợp thất bại.
- Khoảng lặng do lỗi có `silence_kind: "fail"` trong metadata checkpoint và marker `.mp3.silence` ở đường dẫn audio từng dòng; không được tái dùng như giọng thành công. Khoảng lặng cố ý do dòng trùng dùng loại `dup` và vẫn được tái sử dụng.
- Batch CapCut có khoảng lặng `fail` vẫn cho pipeline tiếp tục, nhưng lần chạy lại bước dub sẽ tạo lại **toàn bộ batch có lỗi**, giữ các batch tốt. Trong cùng lần chạy, retry chỉ gửi các dòng còn thiếu của batch (tối đa 4 lượt). `full_voice.meta.json` lưu `failed_indices` để full voice có khoảng lặng do lỗi không che mất việc retry. Khi phục hồi thành công sẽ xoá marker lỗi, gộp/trộn lại audio.
- Checkpoint CapCut từng dòng của phiên bản cũ được giữ trên đĩa nhưng không dùng làm batch đã commit. Lần chạy dub đầu theo chính sách mới có thể cần tạo lại audio; identity full voice cũng đổi để không bỏ qua cơ chế mới. Google không đổi identity hay cơ chế phục hồi.

## Pause, retry, làm lại

- Pause giữ file trên đĩa. Resume/restart backend rồi tiếp tục dùng lại checkpoint phù hợp.
- Retry/reset một bước **chưa có kết quả cuối** giữ riêng thư mục `checkpoints`.
- Chạy lại bước đã hoàn tất xoá checkpoint của bước đó theo cơ chế reset hiện có, **trừ dub có `failed_indices`**: trường hợp này giữ checkpoint để tái dùng các batch tốt, chỉ tạo lại batch lỗi của CapCut. Cờ `discard_checkpoint: true` vẫn buộc làm mới toàn bộ.
- `POST /api/video/{id}/reset-from` với `{"from_step": 7, "discard_checkpoint": true}` (hoặc bước 8) buộc bỏ checkpoint và làm mới. OCR giữ cờ `discard_ocr_checkpoint` riêng, không thay đổi.
- Không tự nhập MP3 legacy không có metadata vì không xác minh được text/engine/tốc độ. Lần chạy đầu sau nâng cấp có thể phải tạo lại những đoạn legacy đó.
- Request Gemini/TTS đã gửi và lệnh FFmpeg đang chạy không được bảo đảm huỷ tức thì; checkpoint chỉ đảm bảo tái sử dụng kết quả đã commit. Nhận diện/chọn giọng Gemini trong multi-voice chưa có checkpoint từng batch riêng; nếu bị ngắt ở phần này có thể cần chọn giọng lại, nhưng batch dịch đã lưu không phải dịch lại.

Không thay đổi OCR, watermark, scheduler hoặc tự restart dịch vụ.

Kiểm thử (mock API, không phát sinh chi phí):

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
