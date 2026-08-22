# Kế hoạch: Đăng ký thông báo qua Telegram

> **Mục tiêu:** Cho phép người dùng kết nối app với Telegram để nhận thông báo tự động khi video xử lý xong.

---

## Tổng quan kiến trúc

```
Desktop App (Frontend)                Backend (FastAPI)                  Telegram API
       │                                    │                                │
       │ 1. GET /api/telegram/config        │                                │
       │ ─────────────────────────────────▶  │                                │
       │  { bot_token, connected_chats }    │                                │
       │                                    │                                │
       │ 2. POST /api/telegram/qr           │                                │
       │ ─────────────────────────────────▶  │                                │
       │  { qr_data, registration_token }   │                                │
       │  QR: https://t.me/BOT?start=TOKEN  │                                │
       │                                    │                                │
       │                                    │  3. POST /getMe                │
       │                                    │ ──────────────────────────────▶ │
       │                                    │  { bot name }                  │
       │                                    │                                │
       │                                    │  4. Polling /getUpdates        │
       │                                    │ ◀────────────────────────────── │
       │                                    │  { message: "/start TOKEN" }   │
       │                                    │                                │
       │  5. WS / WS poll → "Đã kết nối"   │  5. Lưu chat_id → config      │
       │ ◀─────────────────────────────────  │                                │
       │                                    │                                │
       │                                    │  6. Job hoàn thành            │
       │                                    │  → sendNotification(chat_id)   │
       │                                    │ ──────────────────────────────▶ │
       │                                    │  { text: "✅ Video đã xong!" } │
       │                                    │                                │
       │  7. User nhận tin trên Telegram ◀──────────────────────────────────── │
```

**Chiến lược kết nối:** Polling (GET /getUpdates) thay vì Webhook — phù hợp cho app chạy localhost, không cần public URL hay ngrok.

---

## Phase 1: Backend — Telegram Service + Config

### 1.1 Thêm dependency

**File:** `backend/requirements.txt`
```
qrcode[pil]>=7.4
```

`httpx` đã có sẵn. `qrcode` dùng để tạo QR server-side.

### 1.2 Config endpoints

**File:** `backend/app/routers/config_router.py`

Thêm vào `user_config.json` các key mới:
```json
{
  "telegram_bot_token": "123456:ABC-DEF...",
  "telegram_bot_name": "MyVideoBot",
  "telegram_connected_chats": [
    { "chat_id": 123456789, "name": "User Name", "connected_at": "2026-08-21T10:00:00" }
  ]
}
```

**Endpoints mới:**

| Method | Path | Mô tả |
|--------|------|-------|
| `GET` | `/api/telegram/config` | Lấy trạng thái: bot token, bot name, danh sách chat đã kết nối |
| `POST` | `/api/telegram/config` | Lưu bot token (start polling) |
| `DELETE` | `/api/telegram/config` | Xoá bot token (stop polling, xóa connected chats) |
| `POST` | `/api/telegram/connect` | Tạo registration_token + QR code |
| `POST` | `/api/telegram/disconnect/{chat_id}` | Ngắt kết nối 1 chat |

**Pydantic models:**
```python
class TelegramConfigRequest(BaseModel):
    bot_token: str

class TelegramConnectResponse(BaseModel):
    registration_token: str
    qr_data: str          # "https://t.me/BOT_NAME?start=REG_TOKEN"
    qr_image_base64: str  # PNG base64 для отображения на фронте
    expires_in: int       # seconds (300 = 5 phút)
```

### 1.3 Telegram Service

**File mới:** `backend/app/services/telegram_service.py`

```python
class TelegramService:
    """Singleton — quản lý bot token, polling, connected chats."""

    def __init__(self):
        self._token: str = ""
        self._bot_name: str = ""
        self._chat_ids: list[dict] = []
        self._poll_task: asyncio.Task | None = None
        self._offset: int = 0
        self._registration_tokens: dict[str, float] = {}  # token → created_at

    # ── Lifecycle ──
    async def start(self, bot_token: str):  ...
    async def stop(self): ...

    # ── Registration ──
    def create_registration_token(self) -> str: ...
    def get_qr_url(self, token: str) -> str: ...
    def generate_qr_image(self, url: str) -> str: ...  # base64 PNG

    # ── Polling ──
    async def _poll_loop(self): ...
    async def _handle_update(self, update: dict): ...
    async def _verify_bot(self, token: str) -> str | None: ...  # getMe → bot_name

    # ── Notifications ──
    async def send_notification(self, chat_id: int, text: str, parse_mode: str = "HTML"): ...
    async def broadcast(self, text: str): ...  # gửi tới tất cả connected chats

    # ── Config persistence ──
    def load_from_config(self): ...
    def save_to_config(self): ...
```

**Registration token flow:**
1. Frontend gọi `POST /api/telegram/connect`
2. Backend tạo `reg_token = uuid4().hex[:12]`, lưu vào `_registration_tokens` với TTL 5 phút
3. Trả về QR URL: `https://t.me/{bot_name}?start={reg_token}`
4. User quét QR → Telegram mở bot → user gửi `/start {reg_token}`
5. Polling loop nhận update → tìm `reg_token` trong `_registration_tokens` → lưu `chat_id` → xóa token
6. Frontend poll `GET /api/telegram/config` và thấy `connected_chats` thay đổi → UI cập nhật

**Polling loop logic:**
```python
async def _poll_loop(self):
    async with httpx.AsyncClient() as client:
        while True:
            try:
                resp = await client.get(
                    f"https://api.telegram.org/bot{self._token}/getUpdates",
                    params={"offset": self._offset, "timeout": 30},
                    timeout=35,
                )
                data = resp.json()
                for update in data.get("result", []):
                    self._offset = update["update_id"] + 1
                    await self._handle_update(update)
            except Exception as e:
                logger.warning("Telegram poll error: %s", e)
                await asyncio.sleep(5)
```

**_handle_update logic:**
```python
async def _handle_update(self, update: dict):
    msg = update.get("message") or update.get("my_chat_member")
    if not msg:
        return
    text = msg.get("text", "")
    chat = msg.get("chat", {})
    chat_id = chat.get("id")
    user_name = chat.get("first_name", "") + " " + chat.get("last_name", "")

    if text.startswith("/start"):
        parts = text.split(maxsplit=1)
        token = parts[1].strip() if len(parts) > 1 else ""
        if token in self._registration_tokens:
            # Liên kết chat_id
            self._chat_ids.append({
                "chat_id": chat_id,
                "name": user_name.strip(),
                "connected_at": datetime.now().isoformat(),
            })
            del self._registration_tokens[token]
            self.save_to_config()
            # Gửi tin nhắn xác nhận
            await self.send_notification(chat_id, "✅ Đã kết nối thành công!")
```

### 1.4 Hook vào Worker

**File:** `backend/app/worker.py`

Sau mỗi `notify_ws(... {"type": "done" ...})`, gọi `telegram_service.broadcast(...)`.

Điểm hook chính (4 chỗ发送 "done"):

| Line | Job type | Thông báo |
|------|----------|-----------|
| ~255 | OCR | "✅ OCR hoàn tất! Video: {video_id}" |
| ~342 | Hardcode | "✅ Video đã xử lý xong! File: {filename}" |
| ~392 | Export | "✅ Video đã export! File: {filename}" |
| ~873 | Context | "✅ Context đã tạo" |

**Pattern:**
```python
# Sau khi notify_ws(ws_clients, job_id, {"type": "done", ...})
try:
    from app.services.telegram_service import telegram_service
    await telegram_service.broadcast(
        f"✅ <b>Video xử lý xong!</b>\n"
        f"🎬 {video_id}\n"
        f"📁 {filename}"
    )
except Exception:
    pass  # không crash nếu Telegram lỗi
```

### 1.5 Startup / Shutdown

**File:** `backend/app/main.py`

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... existing code ...
    from app.services.telegram_service import telegram_service
    telegram_service.load_from_config()  # đọc token từ config, start polling nếu có
    # ...
    yield
    await telegram_service.stop()  # stop polling
    worker.cancel()
```

---

## Phase 2: Frontend — Settings Section 8

### 2.1 API functions

**File:** `frontend/src/lib/api.ts`

```typescript
export interface TelegramConfig {
  has_bot_token: boolean;
  bot_name: string;
  connected_chats: Array<{
    chat_id: number;
    name: string;
    connected_at: string;
  }>;
}

export interface TelegramQR {
  registration_token: string;
  qr_data: string;
  qr_image_base64: string;
  expires_in: number;
}

export async function getTelegramConfig(): Promise<TelegramConfig>
export async function saveTelegramToken(bot_token: string): Promise<{status: string}>
export async function deleteTelegramConfig(): Promise<{status: string}>
export async function getTelegramQR(): Promise<TelegramQR>
export async function disconnectTelegramChat(chat_id: number): Promise<{status: string}>
```

### 2.2 Settings Page — Section 8

**File:** `frontend/src/app/settings/page.tsx`

Thêm section mới sau section 7 (Watermark), trước nút Save.

**States mới:**
```typescript
const [tgConfig, setTgConfig] = useState<TelegramConfig | null>(null);
const [tgToken, setTgToken] = useState("");
const [tgQR, setTgQR] = useState<TelegramQR | null>(null);
const [tgBusy, setTgBusy] = useState(false);
const [tgCountdown, setTgCountdown] = useState(0);
```

**UI Layout:**

```
┌─────────────────────────────────────────────────┐
│ 8. THÔNG BÁO TELEGRAM                          │
│                                                 │
│ Trạng thái: ● Đã kết nối (2 thiết bị)          │
│                                                 │
│ ┌─ Nếu chưa có bot token: ────────────────────┐ │
│ │ Bot Token: [________________] [Lưu]          │ │
│ │                                             │ │
│ │ Hướng dẫn:                                  │ │
│ │ 1. Mở @BotFather trên Telegram              │ │
│ │ 2. /newbot → đặt tên → copy token           │ │
│ │ 3. Dán token vào ô trên                     │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ┌─ Nếu đã có bot token: ─────────────────────┐ │
│ │ Bot: @MyVideoBot                            │ │
│ │                                             │ │
│ │ [Kết nối thiết bị mới]                     │ │
│ │                                             │ │
│ │ ┌─ QR Code ──────────────────────────────┐  │ │
│ │ │  ██████████████████████████             │  │ │
│ │ │  ██ ▄▄▄▄▄ █▀█ █▄▀ █▄▀█ ██             │  │ │
│ │ │  ██ █   █ █▀▀▀█ ▀▄▀▄▀ █ ██             │  │ │
│ │ │  ██ ▀▄▄▄▄ █▄█▀██▀█▀██ ██              │  │ │
│ │ │  ▄▄▄▄▄ ▄▄▄▄▄ █▄█▀██▀█ ██              │  │ │
│ │ │  █▄█▀▄█▀▄▄▀▀▀▀▀▄█▄▀▀▄█               │  │ │
│ │ │  ▀  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀               │  │ │
│ │ │                                         │  │ │
│ │ │  Quét bằng Telegram trong 4:32         │  │ │
│ │ └─────────────────────────────────────────┘  │ │
│ │                                             │ │
│ │ Thiết bị đã kết nối:                       │ │
│ │ ┌──────────────────────────────┐            │ │
│ │ │ 🟢 Nguyễn Văn A  21/08/2026  │ [Ngắt]    │ │
│ │ │ 🟢 Trần Thị B    20/08/2026  │ [Ngắt]    │ │
│ │ └──────────────────────────────┘            │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 2.3 QR Code polling

Sau khi click "Kết nối thiết bị mới":
1. Gọi `getTelegramQR()` → nhận `qr_image_base64` + `registration_token`
2. Hiển thị QR image + countdown timer (5 phút)
3. Poll `getTelegramConfig()` mỗi 2 giây để kiểm tra có chat mới không
4. Khi `connected_chats.length` tăng → QR biến mất, hiện "Đã kết nối!"
5. Countdown hết → QR hết hạn → hiện nút "Tạo QR mới"

### 2.4 i18n keys

**File:** `frontend/src/lib/i18n.tsx`

Keys mới (EN):
```
"settings.telegram.title": "8. Telegram Notifications"
"settings.telegram.desc": "Connect your Telegram to receive notifications when tasks complete."
"settings.telegram.howto": "How to create a bot:"
"settings.telegram.botFather": "@BotFather on Telegram"
"settings.telegram.steps": "→ send /newbot → name your bot → copy the token → paste below"
"settings.telegram.tokenPh": "Paste your Telegram bot token..."
"settings.telegram.save": "Save Token"
"settings.telegram.connected": "Connected"
"settings.telegram.notConnected": "Not connected"
"settings.telegram.connectDevice": "Connect new device"
"settings.telegram.scanQR": "Scan with Telegram"
"settings.telegram.expiresIn": "expires in {time}"
"settings.telegram.expired": "QR expired"
"settings.telegram.qrNew": "Generate new QR"
"settings.telegram.connectedDevices": "Connected devices"
"settings.telegram.disconnect": "Disconnect"
"settings.telegram.noDevices": "No devices connected yet."
"settings.telegram.botName": "Bot: @{name}"
"settings.telegram.saved": "Bot token saved!"
"settings.telegram.connectSuccess": "Device connected!"
"settings.telegram.disconnectSuccess": "Device disconnected."
```

Keys mới (VI) — tương ứng bản dịch.

---

## Phase 3: Thông báo khi Job hoàn thành

### 3.1 Thông báo format

```python
NOTIFICATION_TEMPLATE = """
✅ <b>Video xử lý xong!</b>

🎬 <b>{title}</b>
⏱ Thời gian: {duration}
📁 {filename}
🔗 <a href="{download_url}">Tải về</a>
"""
```

### 3.2 Broadcast từ worker

**File:** `backend/app/worker.py`

Tạo helper function:
```python
async def _telegram_broadcast_safe(text: str):
    try:
        from app.services.telegram_service import telegram_service
        if telegram_service.has_connected_chats():
            await telegram_service.broadcast(text)
    except Exception:
        pass
```

Gọi hàm này tại 4 điểm "done" trong worker:
1. `run_job()` (OCR done) — line ~255
2. `run_hardcode_job()` — line ~342
3. `run_export_job()` — line ~392
4. Context done — line ~873

### 3.3Thông tin trong thông báo

Tùy job type, nội dung khác nhau:

| Job type | Thông báo |
|----------|-----------|
| OCR | "✅ OCR hoàn tất! File SRT đã sẵn sàng." |
| Hardcode | "✅ Video đã xử lý xong! {filename}" |
| Export | "✅ Video đã export! {filename}" |
| Context | "✅ Context đã tạo." |
| Error | "❌ Xử lý thất bại: {error}" |

---

## Phase 4: Kiểm tra & Cleanup

### 4.1 Registration token cleanup

```python
async def _cleanup_expired_tokens(self):
    """Xóa registration_token hết hạn (>5 phút)."""
    now = time.time()
    expired = [t for t, ts in self._registration_tokens.items() if now - ts > 300]
    for t in expired:
        del self._registration_tokens[t]
```

Chạy mỗi 60 giây trong `_poll_loop`.

### 4.2 Graceful shutdown

```python
async def stop(self):
    if self._poll_task and not self._poll_task.done():
        self._poll_task.cancel()
        try:
            await self._poll_task
        except asyncio.CancelledError:
            pass
    self.save_to_config()
```

### 4.3 Bot token validation

Khi user save bot token:
1. Gọi `getMe` để verify token hợp lệ
2. Lưu `bot_name` vào config
3. Nếu token sai → trả lỗi rõ ràng

---

## File cần tạo/sửa

### Tạo mới
| File | Mô tả |
|------|-------|
| `backend/app/services/telegram_service.py` | Telegram bot service (polling + notifications) |

### Sửa
| File | Thay đổi |
|------|----------|
| `backend/app/config.py` | Thêm `STE_telegram_bot_token` env (optional) |
| `backend/app/main.py` | Import + lifespan: load/start/stop telegram_service |
| `backend/app/worker.py` | Thêm `_telegram_broadcast_safe()` call tại 4 điểm done |
| `backend/app/routers/config_router.py` | Thêm 5 endpoints Telegram config + QR |
| `backend/requirements.txt` | Thêm `qrcode[pil]>=7.4` |
| `frontend/src/lib/api.ts` | Thêm Telegram API functions + types |
| `frontend/src/lib/i18n.tsx` | Thêm ~25 keys EN + VI |
| `frontend/src/app/settings/page.tsx` | Thêm section 8 UI + state + handlers |

---

## Flow hoàn chỉnh

### Setup (lần đầu)
```
User mở Settings → Section 8
  → Nhập bot token từ @BotFather
  → Click "Lưu"
  → Backend verify bằng getMe → lưu bot_name
  → UI hiện "Đã lưu! Bot: @MyVideoBot"

User click "Kết nối thiết bị mới"
  → Backend tạo registration_token
  → Frontend hiện QR code (https://t.me/MyVideoBot?start=abc123)
  → User quét QR bằng Telegram trên điện thoại
  → Telegram mở bot → user nhấn "Start"
  → Backend polling nhận "/start abc123" → lưu chat_id
  → Frontend poll config → thấy chat_id mới → hiện "Đã kết nối!"
```

### Usage (hàng ngày)
```
User xử lý video trong AutoPipeline
  → Pipeline hoàn thành step 11 (hoặc step nào đó)
  → Worker gọi _telegram_broadcast_safe("✅ Video xử lý xong!")
  → TelegramService.broadcast() gửi tin nhắn tới tất cả connected chats
  → User nhận thông báo trên Telegram
```

### Disconnect
```
User mở Settings → Section 8
  → Click "Ngắt" bên cạnh device
  → Backend xóa chat_id khỏi config
  → Device đó không nhận thông báo nữa
```

---

## Ước tính thời gian

| Phase | Thời gian |
|-------|-----------|
| Phase 1: Backend Service + Config | 3-4 giờ |
| Phase 2: Frontend Settings UI | 2-3 giờ |
| Phase 3: Worker hook +通知 format | 1 giờ |
| Phase 4: Testing + cleanup | 1 giờ |
| **Tổng** | **7-9 giờ** |
