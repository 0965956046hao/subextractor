# YT Recent Videos

Project độc lập: kết nối YouTube Data API v3 theo cấu hình đã lưu, liệt kê video
đăng trong N ngày gần nhất (mặc định 2 ngày) từ danh sách kênh theo dõi. Hỗ trợ
tải video, upload video, xem/sửa mô tả, đăng bình luận. Giao diện giữ chung style
SubExtractor (dark `#111114`, accent `#4d93ff`, `double-bezel`, `btn-island`, `glass-panel`).

## Vì sao dùng OAuth 2.0 (không chỉ API key)?

| Nhu cầu | API key | OAuth |
|---|---|---|
| List video mới, xem mô tả | ✅ | ✅ |
| Tải video (yt-dlp, không cần API) | ✅ | ✅ |
| Upload video | ❌ | ✅ (`youtube.upload`) |
| Sửa tiêu đề/mô tả | ❌ | ✅ (`youtube.force-ssl`) |
| Đăng (bình luận) | ❌ | ✅ (`youtube.force-ssl`) |

→ Project dùng **OAuth 2.0** làm phương thức chính, API key là fallback read-only
khi chưa login. Lưu ý: YouTube Data API **không cho tạo community post** —
endpoint comment đăng bình luận top-level và ghi rõ giới hạn này.

## Cấu hình Google Cloud (1 lần)

1. https://console.cloud.google.com → tạo project → bật **YouTube Data API v3**.
2. Credentials → Create **OAuth client ID** (Desktop hoặc Web).
   - Web: thêm Authorized redirect URI = `http://localhost:8001/api/youtube/auth/callback`
3. Copy Client ID / Secret → nhập ở tab **Cấu hình** của app (lưu vào
   `backend/temp/yt_config.json`), hoặc điền vào `backend/.env` (`YTV_` prefix).

## Chạy

```bash
# Backend :8001
cd yt-recent-videos/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001

# Frontend :3001
cd yt-recent-videos/frontend
npm install && npm run dev   # http://localhost:3001
```

Mở http://localhost:3001 → tab **Cấu hình** → lưu Client ID/Secret + danh sách
kênh (channel ID `UC...` hoặc handle `@tenkenh`) → **Kết nối Google** → sang tab
**Mới nhất** bấm Tải lại để xem video 2 ngày qua.

## API

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/health` | Health check |
| GET/POST | `/api/config` | Đọc/lưu cấu hình (client id/secret, api key, kênh, days) |
| GET | `/api/youtube/auth/url` | URL login Google |
| GET | `/api/youtube/auth/callback` | OAuth callback (redirect về FE) |
| GET | `/api/youtube/auth/status` | Trạng thái kết nối |
| POST | `/api/youtube/auth/disconnect` | Ngắt kết nối |
| GET | `/api/videos/recent?days=2` | Video N ngày qua từ kênh theo dõi |
| GET | `/api/videos/{id}` | Chi tiết + mô tả đầy đủ |
| PUT | `/api/videos/{id}` | Sửa tiêu đề/mô tả/tags/privacy (OAuth) |
| GET | `/api/videos/{id}/download?quality=best` | Tải mp4 đồng bộ (chỉ file nhỏ — file lớn dùng tasks bên dưới) |
| POST | `/api/videos/{id}/download-tasks?quality=best` | Tạo tác vụ tải nền → `{task_id}` (không timeout) |
| GET | `/api/download-tasks` | List tác vụ + % tiến độ (FE polling 2s) |
| GET | `/api/download-tasks/{task_id}/file` | Tải file khi task done (tên = tên video) |
| DELETE | `/api/download-tasks/{task_id}` | Hủy task đang chạy / xóa task + file |
| GET | `/api/videos/{id}/thumbnail` | Ảnh thumbnail phân giải cao nhất (đính kèm khi đăng bài) |
| POST | `/api/videos/upload` | Upload video mới (OAuth, multipart) |
| POST | `/api/videos/{id}/comment` | Đăng bình luận (OAuth) |
| POST | `/api/analyze` | Phân tích link YT bất kỳ → tiêu đề, mô tả, thumbnail, tags, hashtag |
| POST | `/api/analyze/title-ai` | Gemini dịch + gợi ý 3–4 tiêu đề ~70 ký tự |
| GET/POST | `/api/analyzed` | List / lưu phân tích video (kèm kết quả AI) |
| GET/DELETE | `/api/analyzed/{video_id}` | Mở / xóa phân tích đã lưu |
| GET | `/api/analyzed/{video_id}/image` | Ảnh thumbnail gốc đã lưu local (link chết vẫn xem được) |
| POST/GET | `/api/analyzed/{video_id}/generated-thumbnail` | Lưu / xem thumbnail ChatGPT đã tạo |
| POST | `/api/chatgpt/login` | Mở Chrome profile riêng để đăng nhập ChatGPT Plus (Next.js route) |
| POST | `/api/chatgpt-thumbnail` | Upload ảnh gốc vào chatgpt.com, gửi prompt và lưu ảnh kết quả (Next.js route) |
| POST | `/api/facebook/check` | Kiểm tra Page ID khớp Page access token đã lưu |
| GET/POST | `/api/facebook/flows` | Lịch sử / tạo flow YouTube → cắt → Facebook (chạy nền; GET tách `active` / `uploaded`) |
| POST | `/api/facebook/flows/batch` | Thêm tối đa 20 video vào hàng đợi → `{tasks, skipped, count}` |
| POST | `/api/facebook/flows/{task_id}/resume` | Kiểm tra và tiếp tục cùng video Facebook đã upload xong |
| GET | `/api/facebook/flows/{task_id}/clip` | Tải MP4 đã cắt |
| GET | `/api/facebook/flows/{task_id}/thumbnail` | Thumbnail gốc dùng cho flow |
| DELETE | `/api/facebook/flows/{task_id}` | Xóa lịch sử và file local của flow đã dừng; không xóa bài Facebook |

## Flow YouTube → Facebook Page (khoảng 30 phút)

1. Máy chạy backend cần **yt-dlp nightly, FFmpeg và ffprobe** trong `PATH`.
2. Trong **Cấu hình → Facebook Page**, nhập Page ID dạng số, **Page access token**
   của chính Page đó và Graph API version (mặc định `v25.0`). Token cần quyền
   `pages_manage_posts`, `pages_read_engagement` và tài khoản có quyền tạo nội dung
   trên Page. Khi lấy Page token qua `/me/accounts`, cần thêm `pages_show_list`.
   Lưu rồi bấm **Kiểm tra Page đã lưu**. Phép kiểm tra này xác nhận danh tính Page;
   quyền đăng thực tế được Meta kiểm tra khi upload/publish. Token được giữ tại
   backend trong file cấu hình gitignored; GET config chỉ trả cờ đã lưu.
3. Chọn video trong **Mới nhất → Chi tiết → Cắt 30 phút → Facebook**, hoặc tab
   **YT → Facebook** để chọn video / dán URL. Cần API key YouTube hoặc OAuth để
   đọc đầy đủ mô tả và tags. Sửa tiêu đề, mô tả, thẻ nếu muốn trước khi chạy.
4. Bấm **Tải → Cắt → Đăng Facebook** cho 1 video đã chỉnh nội dung, hoặc tích
   chọn nhiều video rồi bấm **Thêm N video vào hàng đợi**. Hàng đợi xử lý tuần
   tự từng video (tải → tìm khoảng lặng → cắt → đăng), có số thứ tự
   `#1, #2…`; video trùng đang chạy bị bỏ qua và báo rõ trong thông báo.
   Tác vụ tiếp tục khi đổi tab hoặc đóng trình duyệt (backend vẫn phải chạy).
   Cookie YouTube tùy chọn lấy từ trình duyệt trên máy backend, dành cho video
   yêu cầu đăng nhập.
5. Mục **Đã upload** giữ các video đăng xong sau khi mở app lại: mở bài
   Facebook, xem lại video đã cắt và nội dung đã đăng, tải lại bản MP4.
   File cắt, thumbnail và lịch sử nằm trong
   `backend/temp/facebook_flows/{task_id}/` nên chừng nào chưa xóa thì vẫn
   xem/tải lại được.

### Điểm cắt và đầu ra

- Mặc định lấy từ đầu đến gần **30 phút**, tìm trong **29–31 phút** bằng
  `silencedetect`, ngưỡng **−35 dB**, khoảng lặng tối thiểu **0,5 giây**; chọn giữa
  khoảng lặng gần mốc nhất. Có thể chỉnh các tham số trên UI.
- Không tìm được khoảng lặng → báo lỗi, không tự cắt giữa câu rồi đăng. Video
  ngắn hơn 30 phút giữ toàn bộ; video không có audio cắt đúng mốc.
- Đây là phân tích mức âm lượng, không phải nhận biết ngữ nghĩa/câu nói. Nhạc nền
  có thể che khoảng nghỉ; điều chỉnh dB/vùng tìm nếu cần.
- Encode H.264/AAC MP4 để điểm cắt chính xác hơn stream-copy theo keyframe;
  giữ tỉ lệ hình gốc. File cắt, thumbnail, nội dung đăng và lịch sử nằm trong
  `backend/temp/facebook_flows/{task_id}/`. Có thể xem/tải clip trên UI.
- Thẻ YouTube được chuyển thành hashtag (bỏ dấu cách/ký tự phân tách, giữ chữ
  Unicode), nối vào cuối mô tả, tránh trùng hashtag sẵn có. Không dùng YouTube
  tag làm Facebook `content_tags` vì field đó có ý nghĩa khác.

### Đăng video dài / Reels

Flow dùng **Page Video API `/{page_id}/videos`** với upload chia chunk, phù hợp
video dài. Upload xong ở trạng thái chưa xuất bản → đợi xử lý → đặt thumbnail
YouTube làm ảnh bìa ưu tiên → xuất bản → kiểm tra `published` và `video_status`.
UI chỉ báo thành công khi đã xác nhận và trả link thực tế từ Facebook.

[Meta thông báo hợp nhất video thành Reels](https://about.fb.com/news/2025/06/making-it-easier-create-videos-facebook/)
với mọi độ dài/tỉ lệ. Tuy nhiên, API `/video_reels` có đặc tả riêng; flow này
**không ép video 30 phút qua endpoint Reels ngắn** và không đảm bảo nhãn Reel
trên Page chưa được Meta hỗ trợ hợp nhất. Kiểm tra cách hiển thị trên Page đích.

Nếu lỗi sau khi upload hoàn tất, **Tiếp tục video đã upload** kiểm tra và dùng
lại đúng Facebook video ID, không tạo bản upload mới. Nếu backend restart,
flow đang chạy chuyển sang lỗi gián đoạn; không tự đăng lại. Lỗi trước khi
upload hoàn tất cần kiểm tra video nháp trên Page trước khi tạo flow mới.
Xóa lịch sử/file local không xóa video đã tạo trên Facebook.

Kiểm tra offline (không đăng Facebook thật):

```bash
cd yt-recent-videos/backend
python -B -m unittest discover -s tests -v
```

## Tab Đăng bài (YouTube Community)

YouTube Data API **không có endpoint tạo community post** nên bước đăng cuối là
bán tự động: tab **Đăng bài** liệt kê video theo số ngày (1/2/3/7), tích chọn
nhiều clip, template động với biến `{title} {url} {video_id} {channel} {date}`
(lưu vào config, có preview trực tiếp từng bài + số ký tự + ảnh thumbnail),
rồi **Copy từng bài / Copy tất cả / Tải thumbnails / Mở YouTube Studio** để dán
và đăng. Muốn full-auto ngầm thì phải automation trình duyệt (fragile, dễ die
khi YouTube đổi giao diện) — chưa làm.

## Thumbnail bằng ChatGPT Plus

Tab **Phân tích** có khối **ChatGPT Plus · tạo lại thumbnail**. Luồng này không
cần OpenAI API key: Next.js dùng `puppeteer-core` mở Chrome profile riêng tại
`~/.yt-recent-videos/chatgpt-profile`, người dùng đăng nhập `chatgpt.com` một
lần rồi profile được tái sử dụng. Trước khi tạo, app tự lưu thumbnail gốc local,
đính kèm ảnh vào chat, gửi prompt 16:9 có tiêu đề tiếng Việt và `Phần N` (mặc
định 1), chờ ảnh tạo xong rồi lưu tại
`backend/temp/analyzed/{video_id}.generated.png`. Ảnh kết quả có preview phóng
to, copy clipboard và tải xuống. Nếu UI ChatGPT thay đổi selector, automation có
thể cần cập nhật.
