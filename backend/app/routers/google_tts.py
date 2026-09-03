"""Google TTS voice catalog + voice preview (listen) endpoints.

Lấy danh sách giọng Google Cloud TTS (mặc định tiếng Việt) và tạo MP3 preview
ngắn cho một giọng đã chọn để người dùng nghe thử trước khi bắt đầu pipeline.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.config import settings
from app.services.tts_service import list_google_voices, synthesize_preview

logger = logging.getLogger(__name__)
router = APIRouter(tags=["google_tts"])

PREVIEW_TEXTS: dict[str, str] = {
    "vi-VN": "Xin chào, đây là giọng đọc Google TTS. Bạn có thích giọng này không?",
    "en-US": "Hello, this is a Google TTS voice preview. Do you like this voice?",
    "zh-CN": "你好，这是Google TTS语音预览。你喜欢这个声音吗？",
    "ja-JP": "こんにちは、これはGoogle TTSの音声プレビューです。この声は好きですか？",
    "ko-KR": "안녕하세요, đây là bản xem trước giọng nói Google TTS. 이 목소리가 마음에 드시나요?",
}


@router.get("/api/google-tts/voices")
async def tts_voices(lang: Optional[str] = "vi-VN", max_results: int = 100):
    """List Google TTS voices (default Vietnamese)."""
    try:
        return await run_in_threadpool(list_google_voices, lang=lang, max_results=max_results)
    except Exception as e:
        logger.warning("Google TTS list_voices failed: %s", e)
        raise HTTPException(502, f"Google TTS không tải được danh sách giọng: {e}") from e


@router.post("/api/google-tts/preview")
async def tts_preview(body: dict):
    """Generate a short preview MP3 for a Google TTS voice and return audio bytes.

    Body: {"voice": "vi-VN-Standard-B", "text": "optional override", "lang": "vi-VN"}
    """
    voice = body.get("voice") or ""
    lang = body.get("lang") or "vi-VN"
    default_text = PREVIEW_TEXTS.get(lang, PREVIEW_TEXTS["vi-VN"])
    text = (body.get("text") or default_text).strip()[:200]
    if not text:
        text = default_text
    if not voice:
        raise HTTPException(400, "Chưa chọn giọng.")

    out_path = settings.temp_dir / "tts_preview" / f"google_{voice.replace('/', '_')}.mp3"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        await run_in_threadpool(synthesize_preview, voice, text, out_path)
    except Exception as e:
        logger.warning("Google TTS preview failed for %s: %s", voice, e)
        raise HTTPException(502, f"Google TTS preview lỗi: {e}") from e

    return Response(content=out_path.read_bytes(), media_type="audio/mpeg")
