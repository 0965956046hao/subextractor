# Telegram Douyin Bot — Design Spec

## Overview

When a user sends `/douyin {link}` on Telegram, the bot responds with an InlineKeyboard config screen. After the user confirms, the backend runs the full auto pipeline with step-by-step Telegram notifications and interactive checkpoints.

## User Flow

1. User sends `/douyin https://v.douyin.com/xxx` on Telegram
2. Bot parses URL, creates `DouyinConfig`, sends config message with InlineKeyboard
3. User clicks buttons → bot `edit_message()` updates selection with ✅ marks
4. User clicks "🚀 Xác nhận và bắt đầu" → bot calls `POST /api/telegram/auto`
5. Backend creates `telegram_auto` job, starts pipeline
6. Bot sends step-by-step notifications: "Đang tải video...", "OCR xong!", "Đang dịch..."
7. At checkpoints: sends preview + buttons, waits for user callback
8. Done: sends final video/link + download buttons

## Architecture

```
User sends /douyin {link} on Telegram
        │
        ▼
TelegramBot._handle_douyin()
  → Send config message with InlineKeyboard
  → User clicks buttons → callback_data updates config state
  → User clicks "Xác nhận" → POST /api/telegram/auto
        │
        ▼
POST /api/telegram/auto
  → Create TelegramAutoJob (job_type="telegram_auto")
  → Enqueue to dedicated Telegram executor
  → Return job_id
        │
        ▼
worker.py → run_telegram_auto_job()
  → Step 1: Resolve Douyin link (yt-dlp download)
  → Step 2: Merge video+audio (FFmpeg)
  → Step 3: OCR (auto region or pause for user)
  → Step 4: Context analysis (Gemini)
  → Step 5: Translate (if enabled)
  → Step 6: Dub (if enabled)
  → Step 7: Mux SRT (hardcode)
  → Step 8: Thumbnail (if enabled)
  → Step 9: YouTube upload (if enabled)
  → At checkpoints → send Telegram message + wait for asyncio.Event
```

## Config State Machine

### DouyinConfig dataclass

```python
@dataclass
class DouyinConfig:
    url: str
    src_lang: str = "zh"           # zh | en | vi
    region_mode: str = "auto"       # auto | manual
    dub_on: bool = True
    dub_engine: str = "capcut"      # google | capcut
    dub_voice: str = "BV421_vivn_streaming"
    original_voice: str = "mute"    # mute | keep
    original_gain_db: float = -12.0
    multi_voice: bool = False
    auto_fit: bool = True
    translate_on: bool = True
    translate_target: str = "vi"    # zh | en | vi
    auto_dub: bool = True
    watermark: str = "none"         # none | preset
    watermark_preset: str = ""
    remove_watermark: bool = False
    check_subs: bool = True
    check_voice: bool = True
    thumbnail: str = "none"         # none | fal | gpt
    auto_upload_youtube: bool = False
    youtube_channel: str = ""
```

### InlineKeyboard Layout

```
🎬 Cấu hình video Douyin

━━━ Ngôn ngữ gốc ━━━
[Zh] [En] [Vi]  ← current: Zh ✅

━━━ Vùng quét phụ đề ━━━
[Tự động ✅] [Thủ công]

━━━ Lồng tiếng ━━━
Engine: [Google] [CapCut ✅]
Giọng:  [BV421_vivn_streaming ✅] [Nghe thử]
Âm gốc: [Tắt tiếng ✅] [Giữ]
Nhiều giọng: [Bật] [Tắt ✅]

━━━ Tự động dịch ━━━
[Bật ✅] [Tắt]
Đích: [Trung] [Anh] [Việt ✅]

━━━ Lồng tiếng tự động ━━━
[Bật ✅] [Tắt]

━━━ Watermark ━━━
[Không ✅] [Bộ mặc định]
Xoá watermark: [Bật] [Tắt ✅]

━━━ Kiểm tra ━━━
Phụ đề timeline: [Bật ✅] [Tắt]
Giọng đọc: [Bật ✅] [Tắt]

━━━ Thumbnail ━━━
[Không] [FAL] [ChatGPT]

━━━ YouTube ━━━
[Đăng tự động: Tắt ✅]

━━━━━━━━━━━━━━━━━━
[🚀 Xác nhận và bắt đầu]
```

### Callback Data Format

- Config toggle: `tgcfg:{field}:{value}` — e.g. `tgcfg:src_lang:en`
- Confirm: `tgcfg:confirm:yes`
- Voice preview: `tgcfg:voice_preview:{voice_id}`
- Checkpoint response: `tgcp:{video_id}:{action}` — e.g. `tgcp:abc123:ok`

## Pipeline Runner

### Execution Model

Telegram auto jobs run on a **separate executor** (`_tg_executor = ThreadPoolExecutor(max_workers=1)`) to avoid blocking the main OCR job queue.

### Checkpoint Mechanism

```python
_checkpoint_events: dict[str, asyncio.Event] = {}  # video_id → event
_checkpoint_data: dict[str, dict] = {}              # video_id → user response
```

1. Pipeline reaches checkpoint → sends Telegram message with buttons
2. Creates `asyncio.Event` for this video_id
3. Pipeline `await`s the event (blocks this job, worker free for others)
4. User clicks button → callback handler sets `_checkpoint_data` + `_checkpoint_events[video_id].set()`
5. Pipeline reads response, continues or modifies behavior

### Pipeline Steps

| Step | Job Type | Pause? | Telegram Message |
|------|----------|--------|-----------------|
| 1. Resolve Douyin | inline (yt-dlp) | No | "Đang tải video từ Douyin..." |
| 2. Merge A/V | inline (FFmpeg) | No | "Đang gộp audio..." |
| 3. Region | — | **Yes (if manual)** | Gửi ảnh frame + nút [Tự động] / [Chọn trên web] |
| 4. OCR | `run_job()` | No | "Đang nhận dạng... X%" |
| 5. Check subs | — | **Yes (if check_subs)** | Gửi SRT preview text + nút [OK] / [Chỉnh sửa] |
| 6. Context | `run_context_job()` | No | "Đang phân tích ngữ cảnh..." |
| 7. Translate | `run_translate_job()` | No | "Đang dịch..." |
| 8. Dub | `run_dub_job()` | **Yes (if check_voice)** | Gửi audio preview + nút [OK] / [Thử lại] |
| 9. Mux SRT | `run_hardcode_job()` | No | "Đang nhúng phụ đề..." |
| 10. Thumbnail | inline | **Yes (if enabled)** | Gửi thumbnail image + nút [OK] / [Tạo lại] |
| 11. YouTube | — | **Yes (if enabled)** | "Xác nhận đăng lên YouTube?" + nút [Đăng] / [Bỏ qua] |
| 12. Done | — | No | "✅ Hoàn tất!" + link tải |

## Douyin Download

Use `yt-dlp` (already in requirements) to resolve + download Douyin links:

```python
# POST /api/video-download/resolve
# Body: { url: "https://v.douyin.com/xxx" }
# yt-dlp auto-detects Douyin → downloads video+audio → merges mp4
# Returns: { video_id, title, filename, thumbnail_url }
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `backend/app/services/telegram_bot.py` | **NEW** | Bot handler: `/douyin`, InlineKeyboard builders, callback_data router, config state machine |
| `backend/app/routers/telegram_auto.py` | **NEW** | `POST /api/telegram/auto` endpoint |
| `backend/app/services/telegram_service.py` | MODIFY | Add `send_message_with_keyboard()`, `edit_message()`, `answer_callback_query()`, callback update routing |
| `backend/app/worker.py` | MODIFY | Add `run_telegram_auto_job()`, checkpoint Event mechanism, separate executor |
| `backend/app/main.py` | MODIFY | Register `telegram_auto` router, start `TelegramBot` on startup |
| `backend/app/routers/video_download.py` | MODIFY | Add `POST /api/video-download/resolve` for Douyin |
| `backend/app/models.py` | MODIFY | Add `TelegramAutoRequest` Pydantic model |

## Error Handling

- If Douyin download fails → send error message to Telegram, stop pipeline
- If OCR fails → send error message, stop pipeline
- If checkpoint times out (30 min) → auto-skip with default behavior
- If Telegram API fails → log warning, continue pipeline (non-critical)
- Pipeline cancellation: user sends `/cancel {video_id}` → sets cancelled flag

## Testing

- Unit test: `DouyinConfig` state transitions, callback_data parsing
- Integration test: Mock Telegram API, verify message sequence
- Manual test: Send `/douyin` with real Douyin link, verify full flow
