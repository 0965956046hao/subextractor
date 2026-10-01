# Text2Speech — Văn bản → Voice CapCut → 1 file MP3

Web **độc lập**, tách biệt backend (`:8000`), frontend (`:3000`) và capcut-tts-api (`:8100`).
Chạy riêng 1 process, 1 port duy nhất (mặc định **8200**) — backend FastAPI phục vụ luôn giao diện tĩnh, không cần `npm`.

## Chạy

```bash
cd text2speech
./start.sh                 # http://localhost:8200
TTS_PORT=8201 ./start.sh   # port khác
```

Yêu cầu trước:
- `capcut-tts-api` đang chạy ở `:8100` (web vẫn mở được nếu thiếu, nhưng gen voice sẽ lỗi).
- `ffmpeg` trong PATH (`brew install ffmpeg`) — dùng để gộp MP3.
- Python dùng chung venv của backend (`../backend/.venv`) — đã có sẵn fastapi/uvicorn/httpx.

## Luồng dùng

1. **Bước 1** — dán đoạn văn (hoặc tải file `.txt`), chỉnh “câu dài quá N ký tự thì chẻ nhỏ”, bấm **Tách thành từng dòng**.
   Tách theo dấu kết câu `. ! ? … 。 ！ ？` (giữ nguyên dấu), xuống dòng = ngắt ý,
   giữ nguyên viết tắt (`Mr.`, `Dr.`) và số thập phân (`3.14`), câu CJK liền nhau vẫn tách.
2. **Bước 2** — sửa từng dòng trực tiếp, thêm/xoá dòng, bấm ▶ nghe thử từng dòng.
3. **Bước 3** — chọn ngôn ngữ → chọn giọng (có ô tìm + nút nghe thử) → chỉnh khoảng nghỉ giữa câu →
   **Gen voice + gộp MP3** → nghe và tải 1 file MP3 duy nhất.

## API (cùng port 8200)

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Giao diện web |
| GET | `/api/health` | Trạng thái service + CapCut + ffmpeg |
| GET | `/api/langs` | Danh sách ngôn ngữ cho dropdown |
| GET | `/api/voices?lang=vi-VN` | Proxy danh sách giọng từ CapCut |
| POST | `/api/split` | `{text, max_len}` → `{lines, count}` |
| POST | `/api/preview` | `{voice, text}` → bytes MP3 nghe thử |
| POST | `/api/synthesize` | `{lines[], voice, rate, silence_ms, lang}` → `{job_id}` |
| GET | `/api/jobs/{id}` | Poll tiến độ `{status, progress, done, total}` |
| GET | `/api/download/{id}` | File MP3 đã gộp |
| GET | `/api/line-audio/{id}/{index}` | MP3 của từng dòng |
| DELETE | `/api/jobs/{id}` | Xoá job + file tạm |

File tạm nằm ở `text2speech/temp/jobs/{job_id}/` (`line_0001.mp3`… + `merged.mp3`).
