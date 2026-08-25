"""Telegram bot handler for the /douyin command.

Manages the config state machine and InlineKeyboard UI for processing a
Douyin video, then triggers the backend auto pipeline on confirmation.

Callback data conventions:
- ``tgcfg:{field}:{value}``  — toggle a config field (handled here)
- ``tgcp:{video_id}:{action}`` — checkpoint response (resolved via worker)

Callback handlers receive the full ``callback_query`` dict from
``TelegramService._handle_callback_query`` (single argument).
"""

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s\u4e00-\u9fff]+")

CAPCUT_VOICES = [
    ("BV421_vivn_streaming", "Nhỏ Ngọt Ngào"),
    ("BV422_tts_female", "Nữ dịu dàng"),
    ("BV001_streaming", "Nam trầm"),
    ("BV027_streaming", "Nữ trẻ trung"),
]

LANG_MAP = {"zh": "Trung", "en": "Anh", "vi": "Việt"}
ENGINE_MAP = {"google": "Google TTS", "capcut": "CapCut"}
VOICE_LABEL = {v: n for v, n in CAPCUT_VOICES}


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
    message_id: int | None = None


_configs: dict[int, DouyinConfig] = {}


# ── Text rendering ──

def _build_config_text(config: DouyinConfig) -> str:
    def mark(current, value, label):
        return f"<b>{label} ✅</b>" if current == value else label

    voice = VOICE_LABEL.get(config.dub_voice, config.dub_voice)
    return (
        "🎬 <b>Cấu hình video Douyin</b>\n\n"
        f"🔗 <code>{_shorten(config.url, 55)}</code>\n\n"
        "━━━ <b>Ngôn ngữ gốc</b> ━━━\n"
        f"{mark(config.src_lang, 'zh', 'Trung')} · {mark(config.src_lang, 'en', 'Anh')} · {mark(config.src_lang, 'vi', 'Việt')}\n\n"
        "━━━ <b>Vùng quét phụ đề</b> ━━━\n"
        f"{mark(config.region_mode, 'auto', 'Tự động')} · {mark(config.region_mode, 'manual', 'Thủ công')}\n\n"
        "━━━ <b>Lồng tiếng</b> ━━━\n"
        f"Engine: {mark(config.dub_engine, 'google', 'Google')} · {mark(config.dub_engine, 'capcut', 'CapCut')}\n"
        f"Giọng: <b>{voice}</b>\n"
        f"Âm gốc: {mark(config.original_voice, 'mute', 'Tắt tiếng')} · {mark(config.original_voice, 'keep', 'Giữ')}\n"
        f"Nhiều giọng: {'<b>Bật ✅</b>' if config.multi_voice else 'Tắt'}\n\n"
        "━━━ <b>Tự động dịch</b> ━━━\n"
        f"{'<b>Bật ✅</b>' if config.translate_on else 'Tắt'} · Đích: "
        f"{mark(config.translate_target, 'zh', 'Trung')} · {mark(config.translate_target, 'en', 'Anh')} · {mark(config.translate_target, 'vi', 'Việt')}\n\n"
        "━━━ <b>Lồng tiếng tự động</b> ━━━\n"
        f"{'<b>Bật ✅</b>' if config.auto_dub else 'Tắt'}\n\n"
        "━━━ <b>Watermark</b> ━━━\n"
        f"{mark(config.watermark, 'none', 'Không')} · {mark(config.watermark, 'preset', 'Bộ mặc định')}\n"
        f"Xoá WM: {'<b>Bật ✅</b>' if config.remove_watermark else 'Tắt'}\n\n"
        "━━━ <b>Kiểm tra</b> ━━━\n"
        f"Timeline: {'<b>Bật ✅</b>' if config.check_subs else 'Tắt'} · "
        f"Giọng đọc: {'<b>Bật ✅</b>' if config.check_voice else 'Tắt'}\n\n"
        "━━━ <b>Thumbnail</b> ━━━\n"
        f"{mark(config.thumbnail, 'none', 'Không')} · {mark(config.thumbnail, 'fal', 'FAL')} · {mark(config.thumbnail, 'gpt', 'ChatGPT')}\n\n"
        "━━━ <b>YouTube</b> ━━━\n"
        f"Đăng tự động: {'<b>Bật ✅</b>' if config.auto_upload_youtube else 'Tắt'}"
    )


def _extract_url(text: str) -> str:
    """Extract the first http(s) URL from a Douyin share message.

    Douyin share text looks like::

        ``... 幻龙到底有多离谱？ https://v.douyin.com/O6-krtmu1qQ/ 复制此链接...``

    Matches the frontend ``extractUrl`` regex (stop at whitespace / CJK chars)
    and strips trailing punctuation.
    """
    m = _URL_RE.search(text or "")
    if not m:
        return ""
    return m[0].rstrip("，。！？,;.!?")


def _shorten(url: str, max_len: int) -> str:
    return url if len(url) <= max_len else url[: max_len - 3] + "..."
# ── Keyboard rendering ──

def _btn(label, data):
    return {"text": label, "callback_data": data}


def _toggle_btn(label, field, value, current):
    mark = " ✅" if current == value else ""
    return _btn(f"{label}{mark}", f"tgcfg:{field}:{value}")


def _flip_btn(label, field, current):
    """Single toggle button: shows ✅ when on, sends flipped value."""
    mark = " ✅" if current else ""
    return _btn(f"{label}{mark}", f"tgcfg:{field}:{str(not current).lower()}")


def _build_config_keyboard(config: DouyinConfig) -> list[list[dict]]:
    return [
        [_toggle_btn("Trung", "src_lang", "zh", config.src_lang),
         _toggle_btn("Anh", "src_lang", "en", config.src_lang),
         _toggle_btn("Việt", "src_lang", "vi", config.src_lang)],
        [_toggle_btn("Vùng: Tự động", "region_mode", "auto", config.region_mode),
         _toggle_btn("Vùng: Thủ công", "region_mode", "manual", config.region_mode)],
        [_toggle_btn("Google", "dub_engine", "google", config.dub_engine),
         _toggle_btn("CapCut", "dub_engine", "capcut", config.dub_engine)],
        [_toggle_btn("Âm gốc: Tắt tiếng", "original_voice", "mute", config.original_voice),
         _toggle_btn("Âm gốc: Giữ", "original_voice", "keep", config.original_voice)],
        [_flip_btn("Nhiều giọng", "multi_voice", config.multi_voice)],
        [_toggle_btn("Dịch: Bật", "translate_on", "true", str(config.translate_on).lower()),
         _toggle_btn("Dịch: Tắt", "translate_on", "false", str(config.translate_on).lower())],
        [_toggle_btn("Dịch→Trung", "translate_target", "zh", config.translate_target),
         _toggle_btn("Dịch→Anh", "translate_target", "en", config.translate_target),
         _toggle_btn("Dịch→Việt", "translate_target", "vi", config.translate_target)],
        [_toggle_btn("Lồng tiếng: Bật", "auto_dub", "true", str(config.auto_dub).lower()),
         _toggle_btn("Lồng tiếng: Tắt", "auto_dub", "false", str(config.auto_dub).lower())],
        [_toggle_btn("WM: Không", "watermark", "none", config.watermark),
         _toggle_btn("WM: Bộ mặc định", "watermark", "preset", config.watermark)],
        [_flip_btn("Xoá WM", "remove_watermark", config.remove_watermark)],
        [_flip_btn("Check timeline", "check_subs", config.check_subs),
         _flip_btn("Check giọng", "check_voice", config.check_voice)],
        [_toggle_btn("Thumb: Không", "thumbnail", "none", config.thumbnail),
         _toggle_btn("Thumb: FAL", "thumbnail", "fal", config.thumbnail),
         _toggle_btn("Thumb: GPT", "thumbnail", "gpt", config.thumbnail)],
        [_toggle_btn("YouTube: Bật", "auto_upload_youtube", "true", str(config.auto_upload_youtube).lower()),
         _toggle_btn("YouTube: Tắt", "auto_upload_youtube", "false", str(config.auto_upload_youtube).lower())],
        [_btn("🚀 Xác nhận và bắt đầu", "tgcfg:confirm:yes")],
    ]


# ── Field toggle mapping ──

_BOOL_FIELDS = {
    "multi_voice", "translate_on", "auto_dub", "remove_watermark",
    "check_subs", "check_voice", "auto_upload_youtube",
}

_STR_FIELDS = {
    "src_lang", "region_mode", "dub_engine", "translate_target",
    "watermark", "thumbnail", "original_voice",
}


class TelegramBot:
    """Manages the /douyin command, config callbacks, and checkpoint responses."""

    def __init__(self):
        self._started = False

    async def start(self):
        """Register callback handlers with TelegramService."""
        if self._started:
            return
        from app.services.telegram_service import telegram_service
        telegram_service.register_callback_handler("tgcfg:", self._handle_config_callback)
        telegram_service.register_callback_handler("tgcp:", self._handle_checkpoint_callback)
        self._started = True
        logger.info("TelegramBot started (handlers: tgcfg:, tgcp:)")

    # ── /douyin command ──

    async def _handle_douyin(self, chat_id: int, text: str):
        from app.services.telegram_service import telegram_service

        raw = text.split(maxsplit=1)[1].strip() if len(text.split(maxsplit=1)) > 1 else ""
        url = _extract_url(raw)

        if not url:
            await telegram_service.send_message(
                chat_id,
                "❌ <b>Không tìm thấy link.</b>\n\n"
                "Gửi lệnh kèm link Douyin, ví dụ:\n"
                "<code>/douyin https://v.douyin.com/xxx</code>\n\n"
                "Bạn cũng có thể dán nguyên đoạn chia sẻ của Douyin.",
            )
            return

        config = DouyinConfig(url=url)
        _configs[chat_id] = config

        msg_id = await telegram_service.send_message_with_keyboard(
            chat_id, _build_config_text(config), _build_config_keyboard(config)
        )
        config.message_id = msg_id

    # ── Config callbacks ──

    async def _handle_config_callback(self, callback_query: dict):
        from app.services.telegram_service import telegram_service

        cb_id = callback_query.get("id", "")
        data = callback_query.get("data", "")
        msg = callback_query.get("message") or {}
        chat_id = (msg.get("chat") or {}).get("id")

        if chat_id is None:
            await telegram_service.answer_callback_query(cb_id)
            return

        config = _configs.get(chat_id)
        if config is None:
            await telegram_service.answer_callback_query(cb_id, "⚠️ Phiên cấu hình đã hết hạn. Gõ /douyin lại.")
            return

        parts = data.split(":", 2)
        if len(parts) < 3:
            await telegram_service.answer_callback_query(cb_id)
            return

        _, field, value = parts

        if field == "confirm" and value == "yes":
            await telegram_service.answer_callback_query(cb_id, "🚀 Đang bắt đầu...")
            await self._start_pipeline(chat_id, config)
            return

        if field in _BOOL_FIELDS:
            setattr(config, field, value == "true")
        elif field in _STR_FIELDS:
            setattr(config, field, value)
        elif field == "dub_voice":
            setattr(config, field, value)

        await telegram_service.answer_callback_query(cb_id)
        if config.message_id:
            await telegram_service.edit_message(
                chat_id, config.message_id,
                _build_config_text(config), _build_config_keyboard(config),
            )

    # ── Checkpoint callbacks ──

    async def _handle_checkpoint_callback(self, callback_query: dict):
        from app.services.telegram_service import telegram_service
        from app.worker import tg_resolve_checkpoint

        cb_id = callback_query.get("id", "")
        data = callback_query.get("data", "")

        parts = data.split(":", 2)
        if len(parts) < 3:
            await telegram_service.answer_callback_query(cb_id)
            return

        _, video_id, action = parts
        tg_resolve_checkpoint(video_id, {"action": action})
        await telegram_service.answer_callback_query(cb_id)

    # ── Pipeline trigger ──

    async def _start_pipeline(self, chat_id: int, config: DouyinConfig):
        import httpx
        from app.services.telegram_service import telegram_service
        from app.config import settings

        _configs.pop(chat_id, None)

        await telegram_service.send_message(
            chat_id,
            "🚀 <b>Đang bắt đầu xử lý video...</b>\n\n"
            f"🔗 <code>{_shorten(config.url, 60)}</code>",
        )

        base = settings.public_url.rstrip("/") if settings.public_url else "http://localhost:8000"
        body = {
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
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{base}/api/telegram/auto", json=body)
                if resp.status_code != 200:
                    await telegram_service.send_message(
                        chat_id, f"❌ <b>Lỗi:</b> {resp.text[:200]}"
                    )
        except Exception as e:
            logger.warning("Telegram auto pipeline trigger failed: %s", e)
            await telegram_service.send_message(
                chat_id, f"❌ <b>Không kết nối được server:</b> {e}"
            )


telegram_bot = TelegramBot()
