"""Telegram notification service.

Polls Telegram Bot API for /start commands, links chat_ids to the app,
and broadcasts notifications when jobs complete.

Architecture:
- Polling (getUpdates) instead of webhooks — works on localhost without public URL
- Registration tokens with 5-minute TTL for QR-based device linking
- Config persisted in user_config.json
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

CONFIG_FILE = settings.temp_dir / "user_config.json"
TELEGRAM_API = "https://api.telegram.org"
REGISTRATION_TTL = 300  # 5 minutes


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _write_config(cfg: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


class TelegramService:
    """Singleton managing Telegram bot polling, device registration, and notifications."""

    def __init__(self):
        self._token: str = ""
        self._bot_name: str = ""
        self._chat_ids: list[dict] = []
        self._poll_task: asyncio.Task | None = None
        self._offset: int = 0
        self._registration_tokens: dict[str, float] = {}  # token → created_at
        self._started: bool = False
        self._http: httpx.AsyncClient | None = None
        self._callback_handlers: dict[str, callable] = {}  # prefix → handler

    # ── Lifecycle ──

    async def load_from_config(self):
        """Load bot token from config and start polling if configured."""
        cfg = _read_config()
        token = cfg.get("telegram_bot_token", "")
        if token:
            self._bot_name = cfg.get("telegram_bot_name", "")
            self._chat_ids = cfg.get("telegram_connected_chats") or []
            await self.start(token)

    def _get_http(self) -> httpx.AsyncClient:
        """Get or create a shared httpx client."""
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(timeout=35)
        return self._http

    async def start(self, bot_token: str) -> str | None:
        """Start polling with the given bot token. Returns bot_name or None on error."""
        await self.stop()
        self._token = bot_token
        self._offset = 0

        # Verify token via getMe
        bot_name = await self._verify_bot(bot_token)
        if not bot_name:
            return None

        self._bot_name = bot_name
        self._started = True

        # Load existing connected chats from config
        cfg = _read_config()
        self._chat_ids = cfg.get("telegram_connected_chats") or []

        # Save to config
        self._save_to_config()

        # Start polling
        self._poll_task = asyncio.create_task(self._poll_loop())
        logger.info("Telegram bot started: @%s", bot_name)
        return bot_name

    async def stop(self):
        """Stop polling and save state."""
        self._started = False
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        self._poll_task = None
        if self._http and not self._http.is_closed:
            await self._http.aclose()
            self._http = None
        self._save_to_config()

    # ── Registration ──

    def create_registration_token(self) -> dict:
        """Create a short-lived registration token and return QR data."""
        self._cleanup_expired_tokens()
        token = uuid.uuid4().hex[:12]
        self._registration_tokens[token] = time.time()

        qr_url = f"https://t.me/{self._bot_name}?start={token}"

        return {
            "registration_token": token,
            "qr_data": qr_url,
            "expires_in": REGISTRATION_TTL,
        }

    def _cleanup_expired_tokens(self):
        """Remove registration tokens older than REGISTRATION_TTL."""
        now = time.time()
        expired = [
            t for t, ts in self._registration_tokens.items()
            if now - ts > REGISTRATION_TTL
        ]
        for t in expired:
            del self._registration_tokens[t]

    # ── Polling ──

    async def _poll_loop(self):
        """Long-poll Telegram for updates using a shared httpx client."""
        logger.info("Telegram polling started (bot=@%s)", self._bot_name)
        while self._started:
            try:
                client = self._get_http()
                resp = await client.get(
                    f"{TELEGRAM_API}/bot{self._token}/getUpdates",
                    params={
                        "offset": self._offset,
                        "timeout": 30,
                    },
                )
                data = resp.json()

                if not data.get("ok"):
                    logger.warning("Telegram getUpdates error: %s", data.get("description", data))
                    await asyncio.sleep(5)
                    continue

                results = data.get("result", [])
                if results:
                    logger.info("Telegram: received %d update(s)", len(results))

                for update in results:
                    self._offset = update["update_id"] + 1
                    await self._handle_update(update)

                # Cleanup expired tokens periodically
                self._cleanup_expired_tokens()

            except asyncio.CancelledError:
                break
            except httpx.HTTPError as e:
                logger.warning("Telegram poll HTTP error: %s", e)
                await asyncio.sleep(5)
            except Exception as e:
                logger.warning("Telegram poll error: %s", e, exc_info=True)
                await asyncio.sleep(5)

        logger.info("Telegram polling stopped")

    async def _handle_update(self, update: dict):
        """Process a single Telegram update.

        Routes callback queries to registered handlers first,
        then falls back to message-based command handling.
        """
        # Priority 1: callback_query (inline keyboard buttons)
        callback_query = update.get("callback_query")
        if callback_query:
            await self._handle_callback_query(callback_query)
            return

        # Priority 2: message commands
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
            parts = text.split(maxsplit=1)
            token = parts[1].strip() if len(parts) > 1 else ""

            if token and token in self._registration_tokens:
                # /start <token> — explicit registration
                del self._registration_tokens[token]
                self._chat_ids.append({
                    "chat_id": chat_id,
                    "name": user_name,
                    "connected_at": datetime.now().isoformat(),
                })
                self._save_to_config()

                await self.send_message(
                    chat_id,
                    "✅ <b>Đã kết nối thành công!</b>\n\n"
                    "Bạn sẽ nhận thông báo khi video xử lý xong.",
                )
                logger.info(
                    "Telegram device linked (with token): chat_id=%s name=%s", chat_id, user_name
                )
            elif text == "/start" and self._registration_tokens:
                # /start without token — but there are pending registrations
                # Auto-link to the most recent pending token (most likely the one being scanned now)
                self._cleanup_expired_tokens()
                if self._registration_tokens:
                    pending_token = list(self._registration_tokens.keys())[-1]
                    del self._registration_tokens[pending_token]
                    self._chat_ids.append({
                        "chat_id": chat_id,
                        "name": user_name,
                        "connected_at": datetime.now().isoformat(),
                    })
                    self._save_to_config()

                    await self.send_message(
                        chat_id,
                        "✅ <b>Đã kết nối thành công!</b>\n\n"
                        "Bạn sẽ nhận thông báo khi video xử lý xong.",
                    )
                    logger.info(
                        "Telegram device linked (auto): chat_id=%s name=%s", chat_id, user_name
                    )
                else:
                    await self.send_message(
                        chat_id,
                        "👋 Xin chào! Phiên kết nối đã hết hạn. "
                        "Vui lòng quét QR code mới từ màn hình Settings.",
                    )
            elif text == "/start":
                # /start without token and no pending registrations
                await self.send_message(
                    chat_id,
                    "👋 Xin chào! Để kết nối với ứng dụng, "
                    "vui lòng quét QR code từ màn hình Settings.",
                )
            elif text in ("/status", "/help"):
                count = len(self._chat_ids)
                await self.send_message(
                    chat_id,
                    f"📱 <b>SubTitleExtractor</b>\n\n"
                    f"Thiết bị đã kết nối: {count}\n"
                    f"Bot: @{self._bot_name}",
                )
        elif text.startswith("/douyin"):
            # Delegate to telegram_bot handler if registered
            await self._handle_douyin_command(chat_id, text)
        elif text.startswith("/"):
            # Unknown command
            await self.send_message(
                chat_id,
                "🤖 Lệnh không xác nhận. Gõ /status để xem trạng thái.",
            )

    # ── Callback query routing ──

    def register_callback_handler(self, prefix: str, handler: callable):
        """Register a handler for callback data starting with *prefix*.

        When a callback_query arrives whose ``data`` starts with *prefix*,
        ``handler(callback_query)`` is awaited.  Prefixes are matched
        longest-first so that ``douyin:config:`` beats ``douyin:``.
        """
        self._callback_handlers[prefix] = handler
        logger.debug("Registered callback handler for prefix: %s", prefix)

    async def _handle_callback_query(self, callback_query: dict):
        """Route a callback_query to the best-matching registered handler.

        Matches the longest prefix first.  If no prefix matches, the
        query is answered with a no-op to stop the loading spinner.
        """
        data = callback_query.get("data", "")
        cb_id = callback_query.get("id", "")

        # Find longest matching prefix
        matched_prefix: str | None = None
        for prefix in self._callback_handlers:
            if data.startswith(prefix):
                if matched_prefix is None or len(prefix) > len(matched_prefix):
                    matched_prefix = prefix

        if matched_prefix and matched_prefix in self._callback_handlers:
            try:
                await self._callback_handlers[matched_prefix](callback_query)
            except Exception as e:
                logger.warning(
                    "Callback handler error (prefix=%s, data=%s): %s",
                    matched_prefix, data, e, exc_info=True,
                )
                await self.answer_callback_query(cb_id, "❌ Có lỗi xảy ra.", show_alert=False)
        else:
            # No handler — just acknowledge the click to stop the spinner
            if cb_id:
                await self.answer_callback_query(cb_id)

    async def _handle_douyin_command(self, chat_id: int, text: str):
        """Handle /douyin command.

        Delegates to ``telegram_bot._handle_douyin()`` if the external
        Douyin bot service is available; otherwise sends a fallback message.
        """
        try:
            from app.services.telegram_bot import telegram_bot  # noqa: F811

            await telegram_bot._handle_douyin(chat_id, text)
        except ImportError:
            logger.warning("/douyin command received but telegram_bot module not available")
            await self.send_message(
                chat_id,
                "⚠️ Tính năng Douyin chưa sẵn sàng.",
            )
        except Exception as e:
            logger.warning("/douyin handler error: %s", e, exc_info=True)
            await self.send_message(
                chat_id,
                "❌ Có lỗi xảy ra khi xử lý lệnh Douyin.",
            )

    # ── Messaging ──

    async def send_message(
        self, chat_id: int, text: str, parse_mode: str = "HTML"
    ):
        """Send a message to a specific chat."""
        if not self._token:
            logger.warning("send_message called but no bot token")
            return
        try:
            client = self._get_http()
            resp = await client.post(
                f"{TELEGRAM_API}/bot{self._token}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": text,
                    "parse_mode": parse_mode,
                    "disable_web_page_preview": True,
                },
            )
            result = resp.json()
            if not result.get("ok"):
                logger.warning("Telegram sendMessage failed: %s", result.get("description"))
        except Exception as e:
            logger.warning("Telegram send to %s failed: %s", chat_id, e)

    async def send_message_with_keyboard(
        self,
        chat_id: int,
        text: str,
        keyboard: list[list[dict]],
        parse_mode: str = "HTML",
    ) -> int | None:
        """Send a message with an InlineKeyboard.

        Args:
            chat_id: Target chat ID.
            text: Message text (HTML by default).
            keyboard: 2D list of button dicts, each with ``text`` and
                ``callback_data`` keys.  Each inner list is one row.
            parse_mode: Telegram parse mode.

        Returns:
            The ``message_id`` of the sent message on success, or ``None``
            on failure.
        """
        if not self._token:
            logger.warning("send_message_with_keyboard called but no bot token")
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
                    "reply_markup": {"inline_keyboard": keyboard},
                },
            )
            result = resp.json()
            if result.get("ok"):
                return result["result"].get("message_id")
            logger.warning("Telegram sendMessageWithKeyboard failed: %s", result.get("description"))
            return None
        except Exception as e:
            logger.warning("Telegram send_message_with_keyboard to %s failed: %s", chat_id, e)
            return None

    async def edit_message(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        keyboard: list[list[dict]] | None = None,
        parse_mode: str = "HTML",
    ) -> bool:
        """Edit an existing message and optionally update its InlineKeyboard.

        Args:
            chat_id: Chat where the message lives.
            message_id: ID of the message to edit.
            text: New message text.
            keyboard: New inline keyboard (omit to keep current).
            parse_mode: Telegram parse mode.

        Returns:
            ``True`` if the edit succeeded.
        """
        if not self._token:
            logger.warning("edit_message called but no bot token")
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
            return False
        except Exception as e:
            logger.warning("Telegram editMessage for %s/%s failed: %s", chat_id, message_id, e)
            return False

    async def answer_callback_query(
        self,
        callback_query_id: str,
        text: str = "",
        show_alert: bool = False,
    ) -> bool:
        """Acknowledge an inline keyboard callback to stop the loading spinner.

        Args:
            callback_query_id: The ``id`` field from the callback_query update.
            text: Optional toast notification text.
            show_alert: If ``True``, show an alert dialog instead of a toast.

        Returns:
            ``True`` if the answer was accepted.
        """
        if not self._token:
            logger.warning("answer_callback_query called but no bot token")
            return False
        try:
            client = self._get_http()
            payload: dict = {
                "callback_query_id": callback_query_id,
                "show_alert": show_alert,
            }
            if text:
                payload["text"] = text
            resp = await client.post(
                f"{TELEGRAM_API}/bot{self._token}/answerCallbackQuery",
                json=payload,
            )
            result = resp.json()
            return result.get("ok", False)
        except Exception as e:
            logger.warning("Telegram answerCallbackQuery failed: %s", e)
            return False

    async def broadcast(self, text: str):
        """Send a message to all connected chats."""
        if not self._token or not self._chat_ids:
            return
        logger.info("Telegram broadcast to %d chat(s)", len(self._chat_ids))
        for ch in self._chat_ids[:]:  # copy to avoid mutation during iteration
            chat_id = ch.get("chat_id")
            if chat_id:
                await self.send_message(chat_id, text)

    async def send_web_app_button(
        self, chat_id: int, text: str, web_app_url: str, button_text: str = "Mở Mini App"
    ):
        """Send a message with an inline keyboard button that opens a Telegram Mini App."""
        if not self._token:
            logger.warning("send_web_app_button called but no bot token")
            return
        try:
            client = self._get_http()
            resp = await client.post(
                f"{TELEGRAM_API}/bot{self._token}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": text,
                    "parse_mode": "HTML",
                    "reply_markup": {
                        "inline_keyboard": [
                            [
                                {
                                    "text": button_text,
                                    "web_app": {"url": web_app_url},
                                }
                            ]
                        ]
                    },
                },
            )
            result = resp.json()
            if not result.get("ok"):
                logger.warning("Telegram sendWebAppButton failed: %s", result.get("description"))
        except Exception as e:
            logger.warning("Telegram send web app button to %s failed: %s", chat_id, e)

    async def broadcast_web_app_button(self, text: str, web_app_url: str, button_text: str = "Mở Mini App"):
        """Send a message with Mini App button to all connected chats."""
        if not self._token or not self._chat_ids:
            return
        logger.info("Telegram broadcast web app to %d chat(s)", len(self._chat_ids))
        for ch in self._chat_ids[:]:
            chat_id = ch.get("chat_id")
            if chat_id:
                await self.send_web_app_button(chat_id, text, web_app_url, button_text)

    async def send_video(self, chat_id: int, video_path: str, caption: str = "") -> bool:
        """Send a video file so it plays inline in the Telegram chat.

        Returns True if sent. False if too large (>49MB, Telegram bot limit)
        or the upload failed.
        """
        if not self._token:
            logger.warning("send_video called but no bot token")
            return False
        p = Path(video_path)
        if not (p.exists() and p.is_file()):
            return False
        # Telegram Bot API upload limit is 50 MB — stay safely under it.
        if p.stat().st_size > 49 * 1024 * 1024:
            logger.info("Telegram sendVideo skipped (%s > 49MB)", p.name)
            return False
        try:
            # Dedicated client with a long timeout — uploading video can take minutes.
            client = httpx.AsyncClient(timeout=600)
            try:
                with open(p, "rb") as f:
                    resp = await client.post(
                        f"{TELEGRAM_API}/bot{self._token}/sendVideo",
                        data={
                            "chat_id": str(chat_id),
                            "caption": caption,
                            "parse_mode": "HTML",
                            "supports_streaming": "true",
                        },
                        files={"video": (p.name, f, "video/mp4")},
                    )
            finally:
                await client.aclose()
            result = resp.json()
            if result.get("ok"):
                return True
            logger.warning("Telegram sendVideo failed: %s", result.get("description"))
            return False
        except Exception as e:
            logger.warning("Telegram sendVideo to %s failed: %s", chat_id, e)
            return False

    async def broadcast_video(self, video_path: str, caption: str = "") -> bool:
        """Send a video file to all connected chats.

        Returns True if at least one chat received the video.
        """
        if not self._token or not self._chat_ids:
            return False
        sent = False
        for ch in self._chat_ids[:]:
            chat_id = ch.get("chat_id")
            if chat_id:
                ok = await self.send_video(chat_id, video_path, caption)
                sent = sent or ok
        return sent

    async def send_audio(self, chat_id: int, audio_path: str, caption: str = "") -> bool:
        """Send an audio file (voice preview) to a specific chat. Returns True if sent."""
        if not self._token:
            return False
        p = Path(audio_path)
        if not (p.exists() and p.is_file()):
            return False
        try:
            client = httpx.AsyncClient(timeout=300)
            try:
                with open(p, "rb") as f:
                    resp = await client.post(
                        f"{TELEGRAM_API}/bot{self._token}/sendAudio",
                        data={
                            "chat_id": str(chat_id),
                            "caption": caption,
                            "parse_mode": "HTML",
                        },
                        files={"audio": (p.name, f, "audio/mpeg")},
                    )
            finally:
                await client.aclose()
            result = resp.json()
            if result.get("ok"):
                return True
            logger.warning("Telegram sendAudio failed: %s", result.get("description"))
            return False
        except Exception as e:
            logger.warning("Telegram sendAudio to %s failed: %s", chat_id, e)
            return False

    def has_connected_chats(self) -> bool:
        return bool(self._chat_ids)

    # ── Bot verification ──

    async def _verify_bot(self, token: str) -> str | None:
        """Verify bot token via getMe. Returns bot username or None."""
        try:
            client = self._get_http()
            resp = await client.get(
                f"{TELEGRAM_API}/bot{token}/getMe",
                timeout=10,
            )
            data = resp.json()
            if data.get("ok"):
                bot = data["result"]
                username = bot.get("username", "")
                logger.info("Telegram bot verified: @%s (id=%s)", username, bot.get("id"))
                return username
            logger.warning("Telegram getMe failed: %s", data.get("description", data))
            return None
        except Exception as e:
            logger.warning("Telegram verify error: %s", e)
            return None

    # ── Config persistence ──

    def _save_to_config(self):
        cfg = _read_config()
        cfg["telegram_bot_token"] = self._token
        cfg["telegram_bot_name"] = self._bot_name
        cfg["telegram_connected_chats"] = self._chat_ids
        _write_config(cfg)

    # ── Public getters ──

    def get_config(self) -> dict:
        return {
            "has_bot_token": bool(self._token),
            "bot_name": self._bot_name,
            "connected_chats": self._chat_ids,
        }

    def disconnect_chat(self, chat_id: int) -> bool:
        """Remove a connected chat. Returns True if found and removed."""
        before = len(self._chat_ids)
        self._chat_ids = [c for c in self._chat_ids if c.get("chat_id") != chat_id]
        if len(self._chat_ids) < before:
            self._save_to_config()
            return True
        return False


# Module-level singleton
telegram_service = TelegramService()
