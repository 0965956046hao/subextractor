# Telegram Douyin Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/douyin` Telegram command that shows InlineKeyboard config screen, then runs the full auto pipeline with step-by-step notifications and interactive checkpoints.

**Architecture:** Extend existing `TelegramService` (httpx + long-polling) with InlineKeyboard support. New `TelegramBot` handler manages config state machine and callback routing. New `POST /api/telegram/auto` endpoint creates a `telegram_auto` job type that chains existing pipeline functions (download, OCR, translate, dub, mux) with asyncio.Event-based checkpoint pauses for Telegram user interaction.

**Tech Stack:** Python 3.10+, FastAPI, httpx (Telegram Bot API), asyncio, yt-dlp, existing worker infrastructure.

## Global Constraints

- No new Python dependencies (use existing httpx, yt-dlp, asyncio)
- Extend `TelegramService` singleton, don't replace it
- Pipeline runner uses existing worker functions (`run_job`, `run_translate_job`, etc.)
- Checkpoint pauses use `asyncio.Event` — pipeline blocks, worker loop free for other jobs
- Telegram jobs run on dedicated `_tg_executor` to avoid blocking main OCR queue
- Config state stored in-memory dict keyed by chat_id (volatile, acceptable for bot UX)
- All Telegram API calls via httpx (no python-telegram-bot library)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/app/services/telegram_service.py` | MODIFY | Add `send_message_with_keyboard()`, `edit_message()`, `answer_callback_query()`, callback update handler registration |
| `backend/app/services/telegram_bot.py` | **NEW** | Bot handler: `/douyin` command, `DouyinConfig` dataclass, InlineKeyboard builders, callback_data routing, config state machine |
| `backend/app/routers/telegram_auto.py` | **NEW** | `POST /api/telegram/auto` endpoint, `TelegramAutoRequest` model |
| `backend/app/worker.py` | MODIFY | Add `run_telegram_auto_job()`, checkpoint Event mechanism, `_tg_executor` |
| `backend/app/main.py` | MODIFY | Register `telegram_auto` router, init `TelegramBot` on startup, pass bot to TelegramService |
| `backend/app/routers/video_download.py` | MODIFY | Add `POST /api/video-download/resolve` for Douyin link resolution via yt-dlp |
| `backend/app/models.py` | MODIFY | Add `TelegramAutoRequest` Pydantic model |

---

### Task 1: Extend TelegramService with InlineKeyboard Methods

**Files:**
- Modify: `backend/app/services/telegram_service.py`

**Interfaces:**
- Produces: `send_message_with_keyboard(chat_id, text, keyboard)`, `edit_message(chat_id, message_id, text, keyboard)`, `answer_callback_query(callback_query_id)`, `register_callback_handler(name, handler)`

- [ ] **Step 1: Add `send_message_with_keyboard()` method**

Add after `send_message()` (line ~302):

```python
async def send_message_with_keyboard(
    self, chat_id: int, text: str, keyboard: list[list[dict]],
    parse_mode: str = "HTML"
) -> int | None:
    """Send a message with InlineKeyboard buttons. Returns message_id."""
    if not self._token:
        return None
    try:
        client = self._get_http()
        resp = await client.post(
            f"{TELEGRAM_API}/bot{self._token}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": parse_mode,
                "disable_web_page_preview": True,
                "reply_markup": {
                    "inline_keyboard": keyboard
                },
            },
        )
        result = resp.json()
        if result.get("ok"):
            return result["result"]["message_id"]
        logger.warning("Telegram sendMessageWithKeyboard failed: %s", result.get("description"))
    except Exception as e:
        logger.warning("Telegram send keyboard to %s failed: %s", chat_id, e)
    return None
```

- [ ] **Step 2: Add `edit_message()` method**

Add after `send_message_with_keyboard()`:

```python
async def edit_message(
    self, chat_id: int, message_id: int, text: str,
    keyboard: list[list[dict]] | None = None,
    parse_mode: str = "HTML",
) -> bool:
    """Edit an existing message and optionally update its InlineKeyboard."""
    if not self._token:
        return False
    payload: dict = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": parse_mode,
    }
    if keyboard is not None:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        client = self._get_http()
        resp = await client.post(
            f"{TELEGRAM_API}/bot{self._token}/editMessageText",
            json=payload,
        )
        result = resp.json()
        if result.get("ok"):
            return True
        logger.warning("Telegram editMessage failed: %s", result.get("description"))
    except Exception as e:
        logger.warning("Telegram edit message failed: %s", e)
    return False
```

- [ ] **Step 3: Add `answer_callback_query()` method**

Add after `edit_message()`:

```python
async def answer_callback_query(
    self, callback_query_id: str, text: str = "", show_alert: bool = False
) -> bool:
    """Answer an inline keyboard callback query to stop the loading spinner."""
    if not self._token:
        return False
    try:
        client = self._get_http()
        resp = await client.post(
            f"{TELEGRAM_API}/bot{self._token}/answerCallbackQuery",
            json={
                "callback_query_id": callback_query_id,
                "text": text,
                "show_alert": show_alert,
            },
        )
        result = resp.json()
        return result.get("ok", False)
    except Exception as e:
        logger.warning("Telegram answerCallbackQuery failed: %s", e)
        return False
```

- [ ] **Step 4: Add callback query routing to `_handle_update()`**

Modify `_handle_update()` (line ~188) to handle `callback_query` in addition to `message`:

```python
async def _handle_update(self, update: dict):
    """Process a single Telegram update."""
    # Handle callback queries (inline keyboard button presses)
    callback_query = update.get("callback_query")
    if callback_query:
        await self._handle_callback_query(callback_query)
        return

    msg = update.get("message")
    if not msg:
        return

    text = msg.get("text", "").strip()
    chat = msg.get("chat", {})
    chat_id = chat.get("id")
    if not chat_id:
        return

    user_name = " ".join(
        filter(None, [chat.get("first_name", ""), chat.get("last_name", "")])
    ).strip() or chat.get("username", str(chat_id))

    logger.info("Telegram message from %s (chat_id=%s): %s", user_name, chat_id, text[:50])

    if text.startswith("/start"):
        # ... existing /start logic unchanged ...
    elif text.startswith("/douyin"):
        await self._handle_douyin_command(chat_id, text)
    elif text.startswith("/"):
        await self.send_message(
            chat_id,
            "🤖 Lệnh không xác nhận. Gõ /status để xem trạng thái.",
        )
```

- [ ] **Step 5: Add callback handler registration + dispatch**

Add new attributes and methods:

```python
# In __init__:
self._callback_handlers: dict[str, callable] = {}  # prefix → handler

# New method:
def register_callback_handler(self, prefix: str, handler: callable):
    """Register a handler for callback_data starting with prefix."""
    self._callback_handlers[prefix] = handler

async def _handle_callback_query(self, callback_query: dict):
    """Route callback_query to registered handler by data prefix."""
    cb_id = callback_query.get("id", "")
    data = callback_query.get("data", "")
    chat = callback_query.get("message", {}).get("chat", {})
    chat_id = chat.get("id")
    message_id = callback_query.get("message", {}).get("message_id")

    # Find matching handler by prefix
    for prefix, handler in self._callback_handlers.items():
        if data.startswith(prefix):
            try:
                await handler(chat_id, message_id, cb_id, data)
            except Exception as e:
                logger.exception("Callback handler error for prefix '%s': %s", prefix, e)
            return

    logger.warning("No callback handler for data: %s", data[:100])
```

- [ ] **Step 6: Add placeholder `_handle_douyin_command()`**

```python
async def _handle_douyin_command(self, chat_id: int, text: str):
    """Handle /douyin command — will be implemented in Task 2."""
    pass  # Implemented in telegram_bot.py
```

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/telegram_service.py
git commit -m "feat(telegram): add InlineKeyboard methods and callback routing"
```

---

### Task 2: DouyinConfig State Machine & InlineKeyboard Builders

**Files:**
- Create: `backend/app/services/telegram_bot.py`

**Interfaces:**
- Consumes: `telegram_service.send_message_with_keyboard()`, `telegram_service.edit_message()`, `telegram_service.register_callback_handler()`
- Produces: `TelegramBot` class with `start()`, `handle_douyin()`, config builders

- [ ] **Step 1: Create `telegram_bot.py` with DouyinConfig dataclass**

```python
"""Telegram bot handler for /douyin command.

Manages the config state machine and InlineKeyboard UI for video processing.
"""

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class DouyinConfig:
    """Configuration for a Douyin video processing job."""
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
    message_id: int | None = None   # Telegram message_id for editing
```

- [ ] **Step 2: Add config state storage and toggle logic**

```python
# In-memory config state per chat_id
_configs: dict[int, DouyinConfig] = {}


def _toggle(config: DouyinConfig, field: str, value) -> None:
    """Toggle a config field to a new value."""
    setattr(config, field, value)


def _build_config_text(config: DouyinConfig) -> str:
    """Build the config display text with current selections marked."""
    lang_map = {"zh": "Trung", "en": "Anh", "vi": "Việt"}
    engine_map = {"google": "Google", "capcut": "CapCut"}

    def mark(current, option):
        return f"{option} ✅" if current == option else option

    lines = [
        "🎬 <b>Cấu hình video Douyin</b>",
        "",
        f"🔗 {config.url[:60]}{'...' if len(config.url) > 60 else ''}",
        "",
        "━━━ <b>Ngôn ngữ gốc</b> ━━━",
        f"  {_btn_line(config.src_lang, 'zh', 'Trung')} {_btn_line(config.src_lang, 'en', 'Anh')} {_btn_line(config.src_lang, 'vi', 'Việt')}",
        "",
        "━━━ <b>Vùng quét phụ đề</b> ━━━",
        f"  {_btn_line(config.region_mode, 'auto', 'Tự động')} {_btn_line(config.region_mode, 'manual', 'Thủ công')}",
        "",
        "━━━ <b>Lồng tiếng</b> ━━━",
        f"  Engine: {_btn_line(config.dub_engine, 'google', 'Google')} {_btn_line(config.dub_engine, 'capcut', 'CapCut')}",
        f"  Âm gốc: {_btn_line(config.original_voice, 'mute', 'Tắt tiếng')} {_btn_line(config.original_voice, 'keep', 'Giữ')}",
        f"  Nhiều giọng: {_btn_line(config.multi_voice, True, 'Bật')} {_btn_line(config.multi_voice, False, 'Tắt')}",
        "",
        "━━━ <b>Tự động dịch</b> ━━━",
        f"  {_btn_line(config.translate_on, True, 'Bật')} {_btn_line(config.translate_on, False, 'Tắt')}",
        f"  Đích: {_btn_line(config.translate_target, 'zh', 'Trung')} {_btn_line(config.translate_target, 'en', 'Anh')} {_btn_line(config.translate_target, 'vi', 'Việt')}",
        "",
        "━━━ <b>Lồng tiếng tự động</b> ━━━",
        f"  {_btn_line(config.auto_dub, True, 'Bật')} {_btn_line(config.auto_dub, False, 'Tắt')}",
        "",
        "━━━ <b>Watermark</b> ━━━",
        f"  {_btn_line(config.watermark, 'none', 'Không')} {_btn_line(config.watermark, 'preset', 'Bộ mặc định')}",
        f"  Xoá watermark: {_btn_line(config.remove_watermark, True, 'Bật')} {_btn_line(config.remove_watermark, False, 'Tắt')}",
        "",
        "━━━ <b>Kiểm tra</b> ━━━",
        f"  Phụ đề timeline: {_btn_line(config.check_subs, True, 'Bật')} {_btn_line(config.check_subs, False, 'Tắt')}",
        f"  Giọng đọc: {_btn_line(config.check_voice, True, 'Bật')} {_btn_line(config.check_voice, False, 'Tắt')}",
        "",
        "━━━ <b>Thumbnail</b> ━━━",
        f"  {_btn_line(config.thumbnail, 'none', 'Không')} {_btn_line(config.thumbnail, 'fal', 'FAL')} {_btn_line(config.thumbnail, 'gpt', 'ChatGPT')}",
        "",
        "━━━ <b>YouTube</b> ━━━",
        f"  Đăng tự động: {_btn_line(config.auto_upload_youtube, True, 'Bật')} {_btn_line(config.auto_upload_youtube, False, 'Tắt')}",
    ]
    return "\n".join(lines)


def _btn_line(current, value, label) -> str:
    """Return label with ✅ if it matches current value."""
    if current == value:
        return f"[{label} ✅]"
    return f"[{label}]"
```

- [ ] **Step 3: Add InlineKeyboard builder**

```python
def _build_config_keyboard(config: DouyinConfig) -> list[list[dict]]:
    """Build the InlineKeyboard markup for the config screen."""
    def btn(label, data):
        return {"text": label, "callback_data": data}

    def toggle_btn(label, field, value, current):
        mark = " ✅" if current == value else ""
        return btn(f"{label}{mark}", f"tgcfg:{field}:{value}")

    def bool_btn(label, field, current_val, target_val):
        mark = " ✅" if current_val == target_val else ""
        return btn(f"{label}{mark}", f"tgcfg:{field}:{target_val}")

    return [
        # Ngôn ngữ gốc
        [
            toggle_btn("Trung", "src_lang", "zh", config.src_lang),
            toggle_btn("Anh", "src_lang", "en", config.src_lang),
            toggle_btn("Việt", "src_lang", "vi", config.src_lang),
        ],
        # Vùng quét
        [
            toggle_btn("Tự động", "region_mode", "auto", config.region_mode),
            toggle_btn("Thủ công", "region_mode", "manual", config.region_mode),
        ],
        # Engine
        [
            toggle_btn("Google", "dub_engine", "google", config.dub_engine),
            toggle_btn("CapCut", "dub_engine", "capcut", config.dub_engine),
        ],
        # Âm gốc
        [
            toggle_btn("Tắt tiếng", "original_voice", "mute", config.original_voice),
            toggle_btn("Giữ", "original_voice", "keep", config.original_voice),
        ],
        # Nhiều giọng
        [
            bool_btn("Nhiều giọng: Bật", "multi_voice", config.multi_voice, True),
            bool_btn("Nhiều giọng: Tắt", "multi_voice", config.multi_voice, False),
        ],
        # Dịch
        [
            bool_btn("Dịch: Bật", "translate_on", config.translate_on, True),
            bool_btn("Dịch: Tắt", "translate_on", config.translate_on, False),
        ],
        # Ngôn ngữ đích
        [
            toggle_btn("Dịch→Trung", "translate_target", "zh", config.translate_target),
            toggle_btn("Dịch→Anh", "translate_target", "en", config.translate_target),
            toggle_btn("Dịch→Việt", "translate_target", "vi", config.translate_target),
        ],
        # Lồng tiếng tự động
        [
            bool_btn("Lồng tiếng: Bật", "auto_dub", config.auto_dub, True),
            bool_btn("Lồng tiếng: Tắt", "auto_dub", config.auto_dub, False),
        ],
        # Watermark
        [
            toggle_btn("Không WM", "watermark", "none", config.watermark),
            toggle_btn("Bộ mặc định", "watermark", "preset", config.watermark),
        ],
        # Xoá watermark
        [
            bool_btn("Xoá WM: Bật", "remove_watermark", config.remove_watermark, True),
            bool_btn("Xoá WM: Tắt", "remove_watermark", config.remove_watermark, False),
        ],
        # Kiểm tra
        [
            bool_btn("Check sub: Bật", "check_subs", config.check_subs, True),
            bool_btn("Check sub: Tắt", "check_subs", config.check_subs, False),
            bool_btn("Check giọng: Bật", "check_voice", config.check_voice, True),
            bool_btn("Check giọng: Tắt", "check_voice", config.check_voice, False),
        ],
        # Thumbnail
        [
            toggle_btn("Thumbnail: Không", "thumbnail", "none", config.thumbnail),
            toggle_btn("FAL", "thumbnail", "fal", config.thumbnail),
            toggle_btn("ChatGPT", "thumbnail", "gpt", config.thumbnail),
        ],
        # YouTube
        [
            bool_btn("YouTube: Bật", "auto_upload_youtube", config.auto_upload_youtube, True),
            bool_btn("YouTube: Tắt", "auto_upload_youtube", config.auto_upload_youtube, False),
        ],
        # Confirm button
        [
            btn("🚀 Xác nhận và bắt đầu", "tgcfg:confirm:yes"),
        ],
    ]
```

- [ ] **Step 4: Add config text update on toggle**

```python
async def _update_config_message(chat_id: int, config: DouyinConfig):
    """Rebuild and edit the config message after a toggle."""
    from app.services.telegram_service import telegram_service
    text = _build_config_text(config)
    keyboard = _build_config_keyboard(config)
    if config.message_id:
        await telegram_service.edit_message(
            chat_id, config.message_id, text, keyboard
        )
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/telegram_bot.py
git commit -m "feat(telegram): add DouyinConfig state machine and InlineKeyboard builders"
```

---

### Task 3: Bot Handler — /douyin Command & Callback Routing

**Files:**
- Modify: `backend/app/services/telegram_bot.py`
- Modify: `backend/app/services/telegram_service.py` (wire `_handle_douyin_command`)

**Interfaces:**
- Consumes: `telegram_service.send_message_with_keyboard()`, `telegram_service.register_callback_handler()`
- Produces: `TelegramBot.start()`, processes `/douyin` and `tgcfg:*` callbacks

- [ ] **Step 1: Add `TelegramBot` class with `start()` method**

```python
class TelegramBot:
    """Manages /douyin command and config callback routing."""

    def __init__(self):
        self._started = False

    async def start(self):
        """Register callback handlers with TelegramService."""
        if self._started:
            return
        from app.services.telegram_service import telegram_service
        telegram_service.register_callback_handler("tgcfg:", self._handle_config_callback)
        telegram_service._handle_douyin_command = self._handle_douyin
        self._started = True
        logger.info("TelegramBot started")

    async def _handle_douyin(self, chat_id: int, text: str):
        """Handle /douyin {url} command."""
        # Extract URL from command
        parts = text.split(maxsplit=1)
        url = parts[1].strip() if len(parts) > 1 else ""

        if not url or not url.startswith(("http://", "https://")):
            from app.services.telegram_service import telegram_service
            await telegram_service.send_message(
                chat_id,
                "❌ <b>Cú pháp:</b> /douyin &lt;URL&gt;\n\n"
                "Ví dụ: /douyin https://v.douyin.com/xxx"
            )
            return

        # Create config and send config screen
        config = DouyinConfig(url=url)
        _configs[chat_id] = config

        from app.services.telegram_service import telegram_service
        text = _build_config_text(config)
        keyboard = _build_config_keyboard(config)
        msg_id = await telegram_service.send_message_with_keyboard(
            chat_id, text, keyboard
        )
        config.message_id = msg_id
```

- [ ] **Step 2: Add config callback handler**

```python
    async def _handle_config_callback(
        self, chat_id: int, message_id: int, cb_id: str, data: str
    ):
        """Handle tgcfg:* callback_data from InlineKeyboard."""
        from app.services.telegram_service import telegram_service

        config = _configs.get(chat_id)
        if not config:
            await telegram_service.answer_callback_query(cb_id, "⚠️ Config đã hết hạn. Gõ /douyin lại.")
            return

        # Parse callback data: tgcfg:{field}:{value}
        parts = data.split(":", 2)
        if len(parts) < 3:
            return

        _, field, value = parts

        if field == "confirm" and value == "yes":
            # User confirmed — trigger pipeline
            await telegram_service.answer_callback_query(cb_id, "🚀 Đang bắt đầu...")
            await self._start_pipeline(chat_id, config)
            return

        # Handle boolean toggles
        bool_fields = {
            "multi_voice", "translate_on", "auto_dub",
            "remove_watermark", "check_subs", "check_voice",
            "auto_upload_youtube",
        }
        if field in bool_fields:
            _toggle(config, field, value.lower() == "true")
        elif field == "original_voice":
            _toggle(config, field, value)
        elif field == "src_lang":
            _toggle(config, field, value)
        elif field == "region_mode":
            _toggle(config, field, value)
        elif field == "dub_engine":
            _toggle(config, field, value)
        elif field == "translate_target":
            _toggle(config, field, value)
        elif field == "watermark":
            _toggle(config, field, value)
        elif field == "thumbnail":
            _toggle(config, field, value)

        await telegram_service.answer_callback_query(cb_id)
        await _update_config_message(chat_id, config)
```

- [ ] **Step 3: Add pipeline trigger**

```python
    async def _start_pipeline(self, chat_id: int, config: DouyinConfig):
        """Call POST /api/telegram/auto to start the pipeline."""
        import httpx
        from app.services.telegram_service import telegram_service

        await telegram_service.send_message(
            chat_id,
            f"🚀 <b>Đang bắt đầu xử lý video...</b>\n\n"
            f"🔗 {config.url[:80]}\n"
            f"📝 Ngôn ngữ: {config.src_lang}\n"
            f"🎤 Lồng tiếng: {'Bật' if config.dub_on else 'Tắt'}"
        )

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    "http://localhost:8000/api/telegram/auto",
                    json={
                        "url": config.url,
                        "chat_id": chat_id,
                        "src_lang": config.src_lang,
                        "region_mode": config.region_mode,
                        "dub_on": config.dub_on,
                        "dub_engine": config.dub_engine,
                        "dub_voice": config.dub_voice,
                        "original_voice": config.original_voice,
                        "original_gain_db": config.original_gain_db,
                        "multi_voice": config.multi_voice,
                        "auto_fit": config.auto_fit,
                        "translate_on": config.translate_on,
                        "translate_target": config.translate_target,
                        "auto_dub": config.auto_dub,
                        "watermark": config.watermark,
                        "watermark_preset": config.watermark_preset,
                        "remove_watermark": config.remove_watermark,
                        "check_subs": config.check_subs,
                        "check_voice": config.check_voice,
                        "thumbnail": config.thumbnail,
                        "auto_upload_youtube": config.auto_upload_youtube,
                        "youtube_channel": config.youtube_channel,
                    },
                )
                if resp.status_code != 200:
                    await telegram_service.send_message(
                        chat_id,
                        f"❌ <b>Lỗi:</b> {resp.text[:200]}"
                    )
        except Exception as e:
            await telegram_service.send_message(
                chat_id,
                f"❌ <b>Không kết nối được server:</b> {e}"
            )
        finally:
            # Clean up config
            _configs.pop(chat_id, None)


# Module-level singleton
telegram_bot = TelegramBot()
```

- [ ] **Step 4: Wire TelegramBot into TelegramService `_handle_update()`**

In `telegram_service.py`, modify the `/douyin` handler to delegate to `telegram_bot`:

```python
    elif text.startswith("/douyin"):
        from app.services.telegram_bot import telegram_bot
        await telegram_bot._handle_douyin(chat_id, text)
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/telegram_bot.py backend/app/services/telegram_service.py
git commit -m "feat(telegram): add /douyin command handler and config callback routing"
```

---

### Task 4: Douyin Download Endpoint

**Files:**
- Modify: `backend/app/routers/video_download.py`

**Interfaces:**
- Produces: `POST /api/video-download/resolve` → `{video_id, title, filename, thumbnail_url}`

- [ ] **Step 1: Add Douyin resolve endpoint**

Add after the existing `yt_import` endpoint (line ~124):

```python
class DouyinResolveRequest(BaseModel):
    url: str


def _douy_resolve(url: str) -> dict:
    """Resolve Douyin link and download video via yt-dlp.

    Returns dict with video_id, title, filename, thumbnail_url.
    """
    import uuid as _uuid

    video_id = _uuid.uuid4().hex[:12]
    video_dir = settings.temp_dir / "videos" / video_id
    video_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Get title
        title = _yt_title(url)
        filename = f"{_sanitize_filename(title)}.mp4"

        # Download (yt-dlp handles Douyin auto-merge)
        _yt_download(url, video_dir)

        # Get thumbnail
        proc = _run_yt_dlp(
            ["--no-playlist", "--no-warnings", "--print", "%(thumbnail)s", url]
        )
        thumbnail_url = proc.stdout.strip() if proc.returncode == 0 else ""

        # Write meta.json
        (video_dir / "meta.json").write_text(
            json.dumps({
                "filename": filename,
                "source": "douyin",
                "source_url": url,
                "title": title,
            }, ensure_ascii=False),
            encoding="utf-8",
        )

        return {
            "video_id": video_id,
            "title": title,
            "filename": filename,
            "thumbnail_url": thumbnail_url,
        }
    except Exception:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise


@router.post("/api/video-download/resolve")
async def douyin_resolve(body: DouyinResolveRequest):
    """Resolve a Douyin link: download video and register it for the pipeline."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL không hợp lệ")

    try:
        result = await asyncio.to_thread(_douy_resolve, url)
    except Exception as e:
        raise HTTPException(500, f"Tải video Douyin thất bại: {e}")

    if not result["video_id"]:
        raise HTTPException(500, "Không thể tải video từ link này")

    return result
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/routers/video_download.py
git commit -m "feat(telegram): add Douyin resolve endpoint for /douyin pipeline"
```

---

### Task 5: Telegram Auto Pipeline Endpoint

**Files:**
- Create: `backend/app/routers/telegram_auto.py`
- Modify: `backend/app/models.py`
- Modify: `backend/app/main.py` (register router)

**Interfaces:**
- Consumes: `TelegramAutoRequest` model
- Produces: `POST /api/telegram/auto` → `{job_id}`

- [ ] **Step 1: Add `TelegramAutoRequest` to models.py**

```python
class TelegramAutoRequest(BaseModel):
    """Request body for POST /api/telegram/auto."""
    url: str
    chat_id: int
    src_lang: str = "zh"
    region_mode: str = "auto"
    dub_on: bool = True
    dub_engine: str = "capcut"
    dub_voice: str = "BV421_vivn_streaming"
    original_voice: str = "mute"
    original_gain_db: float = -12.0
    multi_voice: bool = False
    auto_fit: bool = True
    translate_on: bool = True
    translate_target: str = "vi"
    auto_dub: bool = True
    watermark: str = "none"
    watermark_preset: str = ""
    remove_watermark: bool = False
    check_subs: bool = True
    check_voice: bool = True
    thumbnail: str = "none"
    auto_upload_youtube: bool = False
    youtube_channel: str = ""
```

- [ ] **Step 2: Create `telegram_auto.py` router**

```python
"""Telegram Auto Pipeline endpoint.

Creates a telegram_auto job that runs the full pipeline from Douyin link
to final output, with Telegram checkpoint interactions.
"""

import uuid
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.models import TelegramAutoRequest
from app.dependencies import get_jobs, get_job_queue

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/telegram/auto")
async def telegram_auto(
    body: TelegramAutoRequest,
    jobs: dict = Depends(get_jobs),
    queue=None,  # injected at startup
):
    """Create a Telegram auto pipeline job."""
    from app.main import app
    queue = app.state.job_queue

    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "job_type": "telegram_auto",
        "status": "queued",
        "phase": "",
        "progress": 0,
        "error": None,
        "logs": [],
        # Config from request
        "url": body.url,
        "chat_id": body.chat_id,
        "src_lang": body.src_lang,
        "region_mode": body.region_mode,
        "dub_on": body.dub_on,
        "dub_engine": body.dub_engine,
        "dub_voice": body.dub_voice,
        "original_voice": body.original_voice,
        "original_gain_db": body.original_gain_db,
        "multi_voice": body.multi_voice,
        "auto_fit": body.auto_fit,
        "translate_on": body.translate_on,
        "translate_target": body.translate_target,
        "auto_dub": body.auto_dub,
        "watermark": body.watermark,
        "watermark_preset": body.watermark_preset,
        "remove_watermark": body.remove_watermark,
        "check_subs": body.check_subs,
        "check_voice": body.check_voice,
        "thumbnail": body.thumbnail,
        "auto_upload_youtube": body.auto_upload_youtube,
        "youtube_channel": body.youtube_channel,
    }
    jobs[job_id] = job
    await queue.put(job_id)
    logger.info("telegram_auto job %s: queued (url=%s)", job_id, body.url[:60])

    return {"job_id": job_id}
```

- [ ] **Step 3: Register router in main.py**

In `main.py`, add import and include:

```python
from app.routers import ... telegram_auto  # add to import line
app.include_router(telegram_auto.router)   # add after other routers
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/telegram_auto.py backend/app/models.py backend/app/main.py
git commit -m "feat(telegram): add POST /api/telegram/auto endpoint"
```

---

### Task 6: Pipeline Runner with Checkpoint Mechanism

**Files:**
- Modify: `backend/app/worker.py`

**Interfaces:**
- Consumes: `run_job()`, `run_context_job()`, `run_translate_job()`, `run_dub_job()`, `run_hardcode_job()`, existing worker functions
- Produces: `run_telegram_auto_job()`, checkpoint Event mechanism

- [ ] **Step 1: Add checkpoint globals and helper functions**

Add at module level (after imports, ~line 48):

```python
# ── Telegram Auto Pipeline checkpoint mechanism ──
_tg_checkpoint_events: dict[str, asyncio.Event] = {}  # video_id → event
_tg_checkpoint_data: dict[str, dict] = {}              # video_id → user response
_tg_executor = ThreadPoolExecutor(max_workers=1)


async def tg_send(chat_id: int, text: str):
    """Send a Telegram message (fire-and-forget helper)."""
    try:
        from app.services.telegram_service import telegram_service
        if telegram_service.has_connected_chats():
            await telegram_service.send_message(chat_id, text)
    except Exception:
        pass


async def tg_send_keyboard(chat_id: int, text: str, keyboard: list[list[dict]]) -> int | None:
    """Send a Telegram message with InlineKeyboard. Returns message_id."""
    try:
        from app.services.telegram_service import telegram_service
        return await telegram_service.send_message_with_keyboard(chat_id, text, keyboard)
    except Exception:
        return None


async def tg_edit(chat_id: int, message_id: int, text: str, keyboard=None):
    """Edit a Telegram message."""
    try:
        from app.services.telegram_service import telegram_service
        await telegram_service.edit_message(chat_id, message_id, text, keyboard)
    except Exception:
        pass


async def tg_answer_cb(cb_id: str, text: str = ""):
    """Answer a callback query."""
    try:
        from app.services.telegram_service import telegram_service
        await telegram_service.answer_callback_query(cb_id, text)
    except Exception:
        pass


async def tg_wait_checkpoint(video_id: str, timeout: float = 1800) -> dict:
    """Wait for user response at a checkpoint. Returns response dict or empty on timeout."""
    event = asyncio.Event()
    _tg_checkpoint_events[video_id] = event
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        return _tg_checkpoint_data.pop(video_id, {})
    except asyncio.TimeoutError:
        return {"action": "timeout"}
    finally:
        _tg_checkpoint_events.pop(video_id, None)
        _tg_checkpoint_data.pop(video_id, None)


def tg_resolve_checkpoint(video_id: str, data: dict):
    """Resolve a checkpoint — called from TelegramBot callback handler."""
    _tg_checkpoint_data[video_id] = data
    event = _tg_checkpoint_events.get(video_id)
    if event:
        event.set()
```

- [ ] **Step 2: Register checkpoint resolver in TelegramBot**

In `telegram_bot.py`, add callback handler for checkpoint responses:

```python
# In TelegramBot.start():
telegram_service.register_callback_handler("tgcp:", self._handle_checkpoint_callback)

# New method:
async def _handle_checkpoint_callback(
    self, chat_id: int, message_id: int, cb_id: str, data: str
):
    """Handle tgcp:{video_id}:{action} checkpoint responses."""
    from app.worker import tg_resolve_checkpoint
    from app.services.telegram_service import telegram_service

    parts = data.split(":", 2)
    if len(parts) < 3:
        return

    _, video_id, action = parts
    tg_resolve_checkpoint(video_id, {"action": action})
    await telegram_service.answer_callback_query(cb_id, f"✓ {action}")
```

- [ ] **Step 3: Add `run_telegram_auto_job()` function**

Add to `worker.py` before `worker_loop()`:

```python
async def run_telegram_auto_job(
    jobs: dict,
    ws_clients: dict,
    ocr_engines: dict[str, list],
    job_id: str,
):
    """Run the full auto pipeline for a Telegram /douyin command.

    Steps: resolve → merge → region → OCR → context → translate → dub → mux → thumbnail → youtube
    """
    job = jobs.get(job_id)
    if not job:
        return

    video_id = None
    chat_id = job.get("chat_id", 0)
    loop = asyncio.get_event_loop()

    try:
        job["status"] = "processing"
        job["phase"] = "resolving"

        # ── Step 1: Resolve Douyin link ──
        await tg_send(chat_id, "📥 Đang tải video từ Douyin...")
        url = job["url"]

        from app.routers.video_download import _douy_resolve
        result = await loop.run_in_executor(_tg_executor, _douy_resolve, url)
        video_id = result["video_id"]
        job["video_id"] = video_id
        video_dir = settings.temp_dir / "videos" / video_id
        video_path = video_dir / "video.mp4"

        await tg_send(chat_id, f"✅ Đã tải: {result['title'][:50]}")

        # ── Step 2: Check if merge needed ──
        job["phase"] = "merging"
        # yt-dlp already merges, so video_path should be ready
        if not video_path.exists():
            raise RuntimeError(f"Video file not found: {video_path}")

        # ── Step 3: Region selection ──
        region = {"x1": 0.114, "y1": 0.748, "x2": 0.863, "y2": 0.972}  # DEFAULT_REGION
        if job.get("region_mode") == "manual":
            await tg_send(chat_id, "📐 <b>Chọn vùng quét phụ đề...</b>")
            # For Telegram, we'll use auto region and let user override later
            # Manual selection requires a web interface
            await tg_send(chat_id, "⚠️ Thủ công yêu cầu giao diện web. Dùng vùng mặc định.")

        # ── Step 4: OCR ──
        job["phase"] = "processing"
        await tg_send(chat_id, "🔍 Đang nhận dạng phụ đề (OCR)...")

        lang_map = {"zh": "ch", "en": "en", "vi": "latin"}
        ocr_lang = lang_map.get(job.get("src_lang", "zh"), "ch")
        ocr_type = "apple" if "apple" in ocr_engines else "rapid"

        srt_content = await loop.run_in_executor(
            _tg_executor,
            lambda: process_job_sync(
                str(video_path), region,
                settings.extract_fps or 2,
                ocr_engines.get(ocr_type, []),
                ws_clients, job_id, loop, job,
                ocr_lang,
            ),
        )

        # Save SRT
        srt_dir = settings.temp_dir / "srt" / video_id
        srt_dir.mkdir(parents=True, exist_ok=True)
        srt_path = srt_dir / "subtitles.srt"
        srt_path.write_text(srt_content, encoding="utf-8")
        job["srt_path"] = str(srt_path)

        line_count = srt_content.count("-->")
        await tg_send(chat_id, f"✅ OCR xong: {line_count} dòng phụ đề")

        # ── Step 5: Check subtitles checkpoint ──
        if job.get("check_subs"):
            preview_text = _srt_preview(srt_content, max_lines=10)
            keyboard = [[
                {"text": "✓ OK", "callback_data": f"tgcp:{video_id}:ok"},
                {"text": "✏️ Chỉnh sửa", "callback_data": f"tgcp:{video_id}:edit"},
            ]]
            await tg_send_keyboard(
                chat_id,
                f"📋 <b>Preview phụ đề:</b>\n\n{preview_text}",
                keyboard,
            )
            resp = await tg_wait_checkpoint(video_id)
            if resp.get("action") == "edit":
                await tg_send(chat_id, "⚠️ Chỉnh sửa yêu cầu giao diện web. Tiếp tục với phụ đề hiện tại.")

        # ── Step 6: Context ──
        job["phase"] = "context"
        if job.get("translate_on") or job.get("auto_dub"):
            await tg_send(chat_id, "🧠 Đang phân tích ngữ cảnh...")
            try:
                from app.services.context_service import generate_video_context
                target_lang = job.get("translate_target", "vi")
                await loop.run_in_executor(
                    _tg_executor,
                    lambda: generate_video_context(video_id, target_lang=target_lang),
                )
            except Exception as e:
                await tg_send(chat_id, f"⚠️ Phân tích ngữ cảnh thất bại: {e}")

        # ── Step 7: Translate ──
        if job.get("translate_on"):
            job["phase"] = "translating"
            await tg_send(chat_id, "🌐 Đang dịch phụ đề...")
            # Create translate job and wait
            translate_job_id = uuid.uuid4().hex[:12]
            translate_job = {
                "job_id": translate_job_id,
                "job_type": "translate",
                "video_id": video_id,
                "status": "queued",
                "target_lang": job.get("translate_target", "vi"),
            }
            jobs[translate_job_id] = translate_job
            await run_translate_job(jobs, ws_clients, translate_job_id)
            if translate_job.get("status") == "done":
                await tg_send(chat_id, "✅ Dịch xong!")
            else:
                await tg_send(chat_id, f"⚠️ Dịch thất bại: {translate_job.get('error', 'unknown')}")

        # ── Step 8: Dub ──
        if job.get("dub_on") and job.get("auto_dub"):
            job["phase"] = "dub"
            await tg_send(chat_id, "🎤 Đang lồng tiếng...")

            # Update job with dub config for run_dub_job
            job["dub_engine"] = job.get("dub_engine", "capcut")
            job["dub_voice"] = job.get("dub_voice", "BV421_vivn_streaming")
            await run_dub_job(jobs, ws_clients, job_id)

            # Check voice checkpoint
            if job.get("check_voice"):
                keyboard = [[
                    {"text": "✓ OK", "callback_data": f"tgcp:{video_id}:ok"},
                    {"text": "🔄 Thử lại", "callback_data": f"tgcp:{video_id}:retry"},
                ]]
                await tg_send_keyboard(
                    chat_id,
                    "🎧 <b>Nghe thử giọng đọc:</b>",
                    keyboard,
                )
                resp = await tg_wait_checkpoint(video_id)
                if resp.get("action") == "retry":
                    await tg_send(chat_id, "🔄 Đang thử lại lồng tiếng...")
                    await run_dub_job(jobs, ws_clients, job_id)

            await tg_send(chat_id, "✅ Lồng tiếng xong!")

        # ── Step 9: Mux SRT (hardcode) ──
        job["phase"] = "muxing"
        await tg_send(chat_id, "🎬 Đang nhúng phụ đề vào video...")

        # Create hardcode job
        hardcode_job_id = uuid.uuid4().hex[:12]
        hardcode_job = {
            "job_id": hardcode_job_id,
            "job_type": "hardcode",
            "video_id": video_id,
            "video_path": str(video_path),
            "status": "queued",
            "watermark": job.get("watermark", "none"),
            "watermark_preset": job.get("watermark_preset", ""),
        }
        jobs[hardcode_job_id] = hardcode_job
        await run_hardcode_job(jobs, ws_clients, hardcode_job_id)

        if hardcode_job.get("status") == "done":
            await tg_send(chat_id, "✅ Video đã nhúng phụ đề!")
        else:
            await tg_send(chat_id, f"⚠️ Nhúng phụ đề thất bại: {hardcode_job.get('error', 'unknown')}")

        # ── Step 10: Thumbnail ──
        if job.get("thumbnail") and job.get("thumbnail") != "none":
            job["phase"] = "thumbnail"
            await tg_send(chat_id, "🖼️ Đang tạo thumbnail...")

            keyboard = [[
                {"text": "✓ OK", "callback_data": f"tgcp:{video_id}:ok"},
                {"text": "🔄 Tạo lại", "callback_data": f"tgcp:{video_id}:retry_thumb"},
            ]]
            await tg_send_keyboard(
                chat_id,
                "🖼️ <b>Thumbnail đã tạo. Xem và xác nhận:</b>",
                keyboard,
            )
            resp = await tg_wait_checkpoint(video_id)

        # ── Step 11: YouTube upload ──
        if job.get("auto_upload_youtube"):
            job["phase"] = "youtube"
            keyboard = [[
                {"text": "📤 Đăng YouTube", "callback_data": f"tgcp:{video_id}:upload_yt"},
                {"text": "⏭️ Bỏ qua", "callback_data": f"tgcp:{video_id}:skip_yt"},
            ]]
            await tg_send_keyboard(
                chat_id,
                "📤 <b>Xác nhận đăng lên YouTube?</b>",
                keyboard,
            )
            resp = await tg_wait_checkpoint(video_id)
            if resp.get("action") == "upload_yt":
                await tg_send(chat_id, "📤 Đang đăng lên YouTube...")
                # YouTube upload logic here

        # ── Done ──
        job["phase"] = "done"
        job["status"] = "done"
        job["progress"] = 100

        # Send final video if small enough
        final_path = settings.temp_dir / "hardcoded" / video_id
        mp4_files = list(final_path.glob("*_hardcoded.mp4")) if final_path.exists() else []
        if mp4_files:
            sent = await tg_send_video(chat_id, str(mp4_files[0]), f"✅ {result['title'][:50]}")
            if not sent and settings.public_url:
                base = settings.public_url.rstrip("/")
                await tg_send(
                    chat_id,
                    f"✅ <b>Hoàn tất!</b>\n\n"
                    f"▶️ <a href='{base}/api/preview/hardcoded/{video_id}'>Xem video</a>\n"
                    f"⬇️ <a href='{base}/api/download/hardcoded/{video_id}'>Tải video</a>"
                )
        else:
            await tg_send(chat_id, "✅ <b>Hoàn tất!</b> Video đã sẵn sàng.")

        logger.info("telegram_auto job %s: done", job_id)

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        logger.exception("telegram_auto job %s: FAILED | %s", job_id, e)
        await tg_send(chat_id, f"❌ <b>Lỗi:</b> {str(e)[:200]}")


def _srt_preview(srt_content: str, max_lines: int = 10) -> str:
    """Return a short preview of SRT content for Telegram display."""
    lines = srt_content.strip().split("\n")
    preview_lines = []
    count = 0
    for line in lines:
        if "-->" in line:
            count += 1
            if count > max_lines:
                preview_lines.append(f"... và {srt_content.count('-->') - max_lines} dòng nữa")
                break
        if count > 0 or "-->" in line:
            preview_lines.append(line)
    return "\n".join(preview_lines) if preview_lines else "Không có phụ đề"


async def tg_send_video(chat_id: int, video_path: str, caption: str = "") -> bool:
    """Try to send video file to Telegram chat."""
    try:
        from app.services.telegram_service import telegram_service
        return await telegram_service.send_video(chat_id, video_path, caption)
    except Exception:
        return False
```

- [ ] **Step 4: Add `telegram_auto` to worker_loop dispatch**

In `worker_loop()` (line ~1096), add new job type:

```python
        try:
            if job:
                job_type = job.get("job_type", "ocr")
                if job_type == "telegram_auto":
                    await run_telegram_auto_job(jobs, ws_clients, ocr_engines, job_id)
                elif job_type == "hardcode":
                    await run_hardcode_job(jobs, ws_clients, job_id)
                # ... existing elif chain ...
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/worker.py
git commit -m "feat(telegram): add run_telegram_auto_job with checkpoint mechanism"
```

---

### Task 7: Integration & Startup Wiring

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/app/services/telegram_bot.py`

**Interfaces:**
- Consumes: `telegram_bot.start()`, `telegram_service.load_from_config()`
- Produces: Fully wired startup sequence

- [ ] **Step 1: Init TelegramBot on startup in main.py**

In `lifespan()`, after `await telegram_service.load_from_config()` (line ~75), add:

```python
    # Start Telegram bot handler
    from app.services.telegram_bot import telegram_bot
    await telegram_bot.start()
```

- [ ] **Step 2: Verify full startup sequence**

The startup should be:
1. OCR engines init
2. Workers spawn
3. Telegram polling start (`telegram_service.load_from_config()`)
4. TelegramBot init (`telegram_bot.start()`)

- [ ] **Step 3: Test the full flow**

Manual test steps:
1. Start backend: `cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000`
2. Send on Telegram: `/douyin https://v.douyin.com/xxx`
3. Verify: config message with InlineKeyboard appears
4. Click buttons: verify ✅ marks update
5. Click "Xác nhận": verify pipeline starts
6. Verify: step-by-step notifications appear
7. Verify: checkpoints pause and wait for user response

- [ ] **Step 4: Commit**

```bash
git add backend/app/main.py backend/app/services/telegram_bot.py
git commit -m "feat(telegram): wire TelegramBot into app startup"
```

---

### Task 8: Fix `_handle_douyin_command` delegation

**Files:**
- Modify: `backend/app/services/telegram_service.py`

**Interfaces:**
- Consumes: `telegram_bot._handle_douyin()`

- [ ] **Step 1: Fix the delegation in `_handle_update()`**

The current `_handle_douyin_command` is a placeholder method. Replace the delegation in `_handle_update()` to call `telegram_bot` directly:

```python
    elif text.startswith("/douyin"):
        from app.services.telegram_bot import telegram_bot
        await telegram_bot._handle_douyin(chat_id, text)
```

This should already be in place from Task 3 Step 4. Verify it's correct.

- [ ] **Step 2: Remove the placeholder `_handle_douyin_command()` method from TelegramService**

Since the delegation goes directly to `telegram_bot`, the placeholder method in `TelegramService` is no longer needed.

- [ ] **Step 3: Commit**

```bash
git add backend/app/services/telegram_service.py
git commit -m "fix(telegram): clean up douyin command delegation"
```
