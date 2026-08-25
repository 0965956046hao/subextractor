"""Telegram bot handler for the /douyin command.

Manages the config state machine and InlineKeyboard UI for processing a
Douyin video, then triggers the backend auto pipeline on confirmation.

The config is a small state machine with sub-screens:
- ``main``     — overview of all options + "Chọn giọng"/"Chọn preset"/"Chọn kênh" buttons
- ``voices``   — paginated voice picker (CapCut/Google, per voice language)
- ``presets``  — watermark preset picker
- ``channels`` — YouTube channel picker

Callback data conventions:
- ``tgcfg:{field}:{value}``  — toggle/select a config field
- ``tgcp:{video_id}:{action}`` — checkpoint response (resolved via worker)

Callback handlers receive the full ``callback_query`` dict from
``TelegramService._handle_callback_query`` (single argument).
"""

import asyncio
import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s\u4e00-\u9fff]+")

VOICES_PER_PAGE = 8

# Giá trị giảm âm lượng giọng gốc (dB dương = giảm), như FE slider 0–30 dB.
GAIN_OPTIONS = [0, 6, 12, 18, 24, 30]

LANG_MAP = {"zh": "Trung", "en": "Anh", "vi": "Việt"}
ENGINE_MAP = {"google": "Google TTS", "capcut": "CapCut"}
VOICE_LANG_MAP = {"vi-VN": "Việt", "en-US": "Anh"}


@dataclass
class DouyinConfig:
    """Configuration for a Douyin video processing job."""
    url: str
    src_lang: str = "zh"           # zh | en | vi
    region_mode: str = "auto"       # auto | manual
    dub_on: bool = True
    dub_engine: str = "capcut"      # google | capcut
    dub_voice: str = "BV421_vivn_streaming"
    voice_lang: str = "vi-VN"       # vi-VN | en-US
    original_voice: str = "mute"    # mute | keep
    original_gain_db: float = 0.0   # 0..30 (dB giảm, chỉ khi keep)
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
    # ── UI state ──
    screen: str = "main"            # main | voices | presets | channels
    page: int = 0                   # pagination for list screens


_configs: dict[int, DouyinConfig] = {}

# Cached dynamic data (keyed by engine+lang for voices).
_voice_cache: dict[tuple[str, str], list[dict]] = {}


# ── Dynamic data fetching ──

async def _fetch_capcut_voices(lang: str) -> list[dict]:
    from app.services.capcut_tts_client import list_voices
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, list_voices, lang)
    except Exception as e:
        logger.warning("CapCut voices fetch failed: %s", e)
        return []


async def _fetch_google_voices(lang: str) -> list[dict]:
    from app.services.tts_service import list_google_voices
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, list_google_voices, lang)
    except Exception as e:
        logger.warning("Google voices fetch failed: %s", e)
        return []


async def _get_voices(engine: str, lang: str) -> list[dict]:
    key = (engine, lang)
    if key not in _voice_cache:
        if engine == "capcut":
            _voice_cache[key] = await _fetch_capcut_voices(lang)
        else:
            _voice_cache[key] = await _fetch_google_voices(lang)
    return _voice_cache[key]


def _get_presets() -> list[dict]:
    try:
        from app.routers.config_router import _presets
        return _presets()
    except Exception as e:
        logger.warning("Watermark presets fetch failed: %s", e)
        return []


def _get_channels() -> list[dict]:
    try:
        from app.routers.config_router import _yt_channels
        return _yt_channels()
    except Exception as e:
        logger.warning("YouTube channels fetch failed: %s", e)
        return []


# ── Voice preview ──

async def _generate_voice_preview(engine: str, voice: str, lang: str) -> str | None:
    """Generate a preview MP3 for a voice; returns the file path or None."""
    from app.config import settings
    loop = asyncio.get_event_loop()
    out_dir = settings.temp_dir / "tts_preview"
    out_dir.mkdir(parents=True, exist_ok=True)

    if engine == "capcut":
        from app.services.capcut_tts_client import submit_job, poll_job, download_audio
        text = "Xin chào, đây là giọng đọc CapCut. Bạn có thích giọng này không?"
        try:
            job_id = await loop.run_in_executor(
                None, submit_job,
                [{"text": text, "start": 0.0, "end": 0.0}], voice, "1.0", "preview",
            )
            job = await loop.run_in_executor(None, poll_job, job_id, 60)
            if job.get("status") != "done":
                return None
            audio_files = job.get("audio_files") or []
            if not audio_files:
                return None
            filename = audio_files[0].split("/")[-1]
            out_path = out_dir / f"{voice.replace('/', '_')}.mp3"
            await loop.run_in_executor(None, download_audio, job_id, filename, out_path)
            return str(out_path)
        except Exception as e:
            logger.warning("CapCut preview failed for %s: %s", voice, e)
            return None
    else:
        from app.services.tts_service import synthesize_preview
        text = "Xin chào, đây là giọng đọc Google TTS. Bạn có thích giọng này không?"
        out_path = out_dir / f"google_{voice.replace('/', '_')}.mp3"
        try:
            await loop.run_in_executor(None, synthesize_preview, voice, text, out_path)
            return str(out_path)
        except Exception as e:
            logger.warning("Google preview failed for %s: %s", voice, e)
            return None


# ── Text rendering ──

def _shorten(url: str, max_len: int) -> str:
    return url if len(url) <= max_len else url[: max_len - 3] + "..."


def _extract_url(text: str) -> str:
    """Extract the first http(s) URL from a Douyin share message."""
    m = _URL_RE.search(text or "")
    if not m:
        return ""
    return m[0].rstrip("，。！？,;.!?")


def _voice_label(engine: str, voices: list[dict], voice_type: str) -> str:
    for v in voices:
        if v.get("voice_type") == voice_type:
            return v.get("display_name") or voice_type
    return voice_type


def _build_config_text(config: DouyinConfig, voices: list[dict]) -> str:
    def mark(current, value, label):
        return f"<b>{label} ✅</b>" if current == value else label

    voice = _voice_label(config.dub_engine, voices, config.dub_voice)
    preset_name = ""
    if config.watermark == "preset" and config.watermark_preset:
        preset_name = next(
            (p.get("name", "") for p in _get_presets() if p.get("id") == config.watermark_preset),
            "",
        ) or "Bộ mặc định"
    channel_name = ""
    if config.auto_upload_youtube and config.youtube_channel:
        channel_name = next(
            (c.get("name", "") for c in _get_channels() if c.get("id") == config.youtube_channel),
            "",
        )

    gain_line = ""
    if config.original_voice == "keep":
        gain_line = f"\nGiảm giọng gốc: <b>-{int(config.original_gain_db)} dB</b>"

    yt_line = f"Đăng tự động: {'<b>Bật ✅</b>' if config.auto_upload_youtube else 'Tắt'}"
    if config.auto_upload_youtube:
        yt_line += f" · Kênh: <b>{channel_name or 'Mặc định'}</b>"

    wm_line = (
        f"{mark(config.watermark, 'none', 'Không')} · {mark(config.watermark, 'preset', 'Bộ mặc định')}"
    )
    if config.watermark == "preset":
        wm_line += f" ({preset_name})"

    return (
        "🎬 <b>Cấu hình video Douyin</b>\n\n"
        f"🔗 <code>{_shorten(config.url, 55)}</code>\n\n"
        "━━━ <b>Ngôn ngữ gốc</b> ━━━\n"
        f"{mark(config.src_lang, 'zh', 'Trung')} · {mark(config.src_lang, 'en', 'Anh')} · {mark(config.src_lang, 'vi', 'Việt')}\n\n"
        "━━━ <b>Vùng quét phụ đề</b> ━━━\n"
        f"{mark(config.region_mode, 'auto', 'Tự động')} · {mark(config.region_mode, 'manual', 'Thủ công')}\n\n"
        "━━━ <b>Lồng tiếng</b> ━━━\n"
        f"Engine: {mark(config.dub_engine, 'google', 'Google')} · {mark(config.dub_engine, 'capcut', 'CapCut')}\n"
        f"Ngôn ngữ giọng: {mark(config.voice_lang, 'vi-VN', 'Việt')} · {mark(config.voice_lang, 'en-US', 'Anh')}\n"
        f"Giọng: <b>{voice}</b>\n"
        f"Âm gốc: {mark(config.original_voice, 'mute', 'Tắt tiếng')} · {mark(config.original_voice, 'keep', 'Giữ')}{gain_line}\n"
        f"Nhiều giọng: {'<b>Bật ✅</b>' if config.multi_voice else 'Tắt'}\n\n"
        "━━━ <b>Tự động dịch</b> ━━━\n"
        f"{'<b>Bật ✅</b>' if config.translate_on else 'Tắt'} · Đích: "
        f"{mark(config.translate_target, 'zh', 'Trung')} · {mark(config.translate_target, 'en', 'Anh')} · {mark(config.translate_target, 'vi', 'Việt')}\n\n"
        "━━━ <b>Lồng tiếng tự động</b> ━━━\n"
        f"{'<b>Bật ✅</b>' if config.auto_dub else 'Tắt'}\n\n"
        "━━━ <b>Watermark</b> ━━━\n"
        f"{wm_line}\n"
        f"Xoá WM: {'<b>Bật ✅</b>' if config.remove_watermark else 'Tắt'}\n\n"
        "━━━ <b>Kiểm tra</b> ━━━\n"
        f"Timeline: {'<b>Bật ✅</b>' if config.check_subs else 'Tắt'} · "
        f"Giọng đọc: {'<b>Bật ✅</b>' if config.check_voice else 'Tắt'}\n\n"
        "━━━ <b>Thumbnail</b> ━━━\n"
        f"{mark(config.thumbnail, 'none', 'Không')} · {mark(config.thumbnail, 'fal', 'FAL')} · {mark(config.thumbnail, 'gpt', 'ChatGPT')}\n\n"
        "━━━ <b>YouTube</b> ━━━\n"
        f"{yt_line}"
    )


# ── Keyboard rendering ──

def _btn(label, data):
    return {"text": label, "callback_data": data}


def _toggle_btn(label, field, value, current):
    mark = " ✅" if current == value else ""
    return _btn(f"{label}{mark}", f"tgcfg:{field}:{value}")


def _flip_btn(label, field, current):
    mark = " ✅" if current else ""
    return _btn(f"{label}{mark}", f"tgcfg:{field}:{str(not current).lower()}")


def _build_main_keyboard(config: DouyinConfig) -> list[list[dict]]:
    rows: list[list[dict]] = [
        [_toggle_btn("Trung", "src_lang", "zh", config.src_lang),
         _toggle_btn("Anh", "src_lang", "en", config.src_lang),
         _toggle_btn("Việt", "src_lang", "vi", config.src_lang)],
        [_toggle_btn("Vùng: Tự động", "region_mode", "auto", config.region_mode),
         _toggle_btn("Vùng: Thủ công", "region_mode", "manual", config.region_mode)],
        [_toggle_btn("Google", "dub_engine", "google", config.dub_engine),
         _toggle_btn("CapCut", "dub_engine", "capcut", config.dub_engine)],
        [_toggle_btn("Giọng Việt", "voice_lang", "vi-VN", config.voice_lang),
         _toggle_btn("Giọng Anh", "voice_lang", "en-US", config.voice_lang)],
        [_btn("🎤 Chọn giọng", "tgcfg:screen:voices"),
         _btn("🔊 Nghe thử", "tgcfg:preview:current")],
        [_toggle_btn("Âm gốc: Tắt tiếng", "original_voice", "mute", config.original_voice),
         _toggle_btn("Âm gốc: Giữ", "original_voice", "keep", config.original_voice)],
    ]
    if config.original_voice == "keep":
        gain_row = [_toggle_btn(f"-{g}dB", "original_gain_db", str(g), str(int(config.original_gain_db))) for g in GAIN_OPTIONS]
        rows.append(gain_row)
    rows += [
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
    ]
    if config.watermark == "preset":
        rows.append([_btn("📋 Chọn preset watermark", "tgcfg:screen:presets")])
    rows += [
        [_flip_btn("Xoá WM", "remove_watermark", config.remove_watermark)],
        [_flip_btn("Check timeline", "check_subs", config.check_subs),
         _flip_btn("Check giọng", "check_voice", config.check_voice)],
        [_toggle_btn("Thumb: Không", "thumbnail", "none", config.thumbnail),
         _toggle_btn("Thumb: FAL", "thumbnail", "fal", config.thumbnail),
         _toggle_btn("Thumb: GPT", "thumbnail", "gpt", config.thumbnail)],
        [_toggle_btn("YouTube: Bật", "auto_upload_youtube", "true", str(config.auto_upload_youtube).lower()),
         _toggle_btn("YouTube: Tắt", "auto_upload_youtube", "false", str(config.auto_upload_youtube).lower())],
    ]
    if config.auto_upload_youtube:
        rows.append([_btn("📺 Chọn kênh YouTube", "tgcfg:screen:channels")])
    rows.append([_btn("🚀 Xác nhận và bắt đầu", "tgcfg:confirm:yes")])
    return rows


def _build_voices_keyboard(config: DouyinConfig, voices: list[dict]) -> list[list[dict]]:
    total_pages = max(1, (len(voices) + VOICES_PER_PAGE - 1) // VOICES_PER_PAGE)
    page = min(config.page, total_pages - 1)
    start = page * VOICES_PER_PAGE
    chunk = voices[start:start + VOICES_PER_PAGE]

    rows: list[list[dict]] = []
    for i in range(0, len(chunk), 2):
        pair = chunk[i:i + 2]
        row = []
        for v in pair:
            vt = v.get("voice_type", "")
            mark = " ✅" if vt == config.dub_voice else ""
            row.append(_btn(f"{v.get('display_name', vt)}{mark}", f"tgcfg:dub_voice:{vt}"))
        rows.append(row)

    nav = []
    if page > 0:
        nav.append(_btn("◀ Trước", f"tgcfg:page:{page - 1}"))
    nav.append(_btn(f"Trang {page + 1}/{total_pages}", "tgcfg:noop"))
    if page < total_pages - 1:
        nav.append(_btn("Sau ▶", f"tgcfg:page:{page + 1}"))
    rows.append(nav)
    rows.append([_btn("🔊 Nghe thử giọng này", "tgcfg:preview:current"),
                 _btn("⬅ Quay lại", "tgcfg:screen:main")])
    return rows


def _build_presets_keyboard(config: DouyinConfig, presets: list[dict]) -> list[list[dict]]:
    rows: list[list[dict]] = []
    for p in presets:
        mark = " ✅" if p.get("id") == config.watermark_preset else ""
        rows.append([_btn(f"{p.get('name', p.get('id', ''))}{mark}", f"tgcfg:watermark_preset:{p.get('id')}")])
    if not rows:
        rows.append([_btn("Không có preset", "tgcfg:noop")])
    rows.append([_btn("⬅ Quay lại", "tgcfg:screen:main")])
    return rows


def _build_channels_keyboard(config: DouyinConfig, channels: list[dict]) -> list[list[dict]]:
    rows: list[list[dict]] = []
    rows.append([_btn("Mặc định", "tgcfg:youtube_channel:")])
    for c in channels:
        mark = " ✅" if c.get("id") == config.youtube_channel else ""
        rows.append([_btn(f"{c.get('name', c.get('id', ''))}{mark}", f"tgcfg:youtube_channel:{c.get('id')}")])
    rows.append([_btn("⬅ Quay lại", "tgcfg:screen:main")])
    return rows


def _build_config_keyboard(config: DouyinConfig, voices: list[dict]) -> list[list[dict]]:
    if config.screen == "voices":
        return _build_voices_keyboard(config, voices)
    if config.screen == "presets":
        return _build_presets_keyboard(config, _get_presets())
    if config.screen == "channels":
        return _build_channels_keyboard(config, _get_channels())
    return _build_main_keyboard(config)


# ── Field toggle mapping ──

_BOOL_FIELDS = {
    "multi_voice", "translate_on", "auto_dub", "remove_watermark",
    "check_subs", "check_voice", "auto_upload_youtube",
}

_STR_FIELDS = {
    "src_lang", "region_mode", "dub_engine", "translate_target",
    "watermark", "thumbnail", "original_voice", "voice_lang",
}


class TelegramBot:
    """Manages the /douyin command, config callbacks, and checkpoint responses."""

    def __init__(self):
        self._started = False

    async def start(self):
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

        voices = await _get_voices(config.dub_engine, config.voice_lang)
        msg_id = await telegram_service.send_message_with_keyboard(
            chat_id, _build_config_text(config, voices), _build_config_keyboard(config, voices)
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

        # ── Sub-screen navigation ──
        if field == "confirm" and value == "yes":
            await telegram_service.answer_callback_query(cb_id, "🚀 Đang bắt đầu...")
            await self._start_pipeline(chat_id, config)
            return

        if field == "screen":
            config.screen = value
            config.page = 0
            await telegram_service.answer_callback_query(cb_id)
            await self._render_config(chat_id, config)
            return

        if field == "page":
            try:
                config.page = int(value)
            except ValueError:
                pass
            await telegram_service.answer_callback_query(cb_id)
            await self._render_config(chat_id, config)
            return

        if field == "noop":
            await telegram_service.answer_callback_query(cb_id)
            return

        # ── Voice preview ──
        if field == "preview" and value == "current":
            await telegram_service.answer_callback_query(cb_id, "🔊 Đang tạo giọng đọc...")
            path = await _generate_voice_preview(config.dub_engine, config.dub_voice, config.voice_lang)
            if path:
                await telegram_service.send_audio(
                    chat_id, path,
                    f"🔊 {_voice_label(config.dub_engine, await _get_voices(config.dub_engine, config.voice_lang), config.dub_voice)}",
                )
            else:
                await telegram_service.send_message(chat_id, "⚠️ Không tạo được giọng đọc thử.")
            return

        # ── Field toggles ──
        if field == "dub_voice":
            setattr(config, field, value)
        elif field == "original_gain_db":
            try:
                config.original_gain_db = float(value)
            except ValueError:
                pass
        elif field == "watermark_preset":
            config.watermark_preset = value
        elif field == "youtube_channel":
            config.youtube_channel = value
        elif field in _BOOL_FIELDS:
            setattr(config, field, value == "true")
        elif field in _STR_FIELDS:
            setattr(config, field, value)

        await telegram_service.answer_callback_query(cb_id)
        await self._render_config(chat_id, config)

    async def _render_config(self, chat_id: int, config: DouyinConfig):
        from app.services.telegram_service import telegram_service
        voices = await _get_voices(config.dub_engine, config.voice_lang)
        if config.message_id:
            await telegram_service.edit_message(
                chat_id, config.message_id,
                _build_config_text(config, voices), _build_config_keyboard(config, voices),
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
