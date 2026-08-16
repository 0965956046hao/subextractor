"""CapCut TTS voice catalog + voice preview (listen) endpoints.

Proxies to the capcut-tts-api gen-voice service (:8100) for the voice list and
generates a short one-shot preview MP3 for a chosen voice so users can audition
voices in the UI before starting the pipeline.
"""

import asyncio
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.config import settings
from app.services.capcut_tts_client import (
    CapCutTTSError,
    check_health,
    list_voices,
    submit_job,
    poll_job,
    download_audio,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["capcut"])

PREVIEW_TEXT = "Xin chào, đây là giọng đọc CapCut. Bạn có thích giọng này không?"
PREVIEW_TIMEOUT = 60


@router.get("/api/capcut/voices")
async def capcut_voices(lang: Optional[str] = "vi-VN"):
    """List CapCut voices (default Vietnamese) from the gen-voice service."""
    try:
        return await run_in_threadpool(list_voices, lang=lang)
    except CapCutTTSError as e:
        raise HTTPException(502, f"CapCut TTS service lỗi: {e}") from e


@router.get("/api/capcut/health")
async def capcut_health():
    """Report CapCut gen-voice service status."""
    h = await run_in_threadpool(check_health)
    if not h.get("healthy"):
        return {"healthy": False, "message": "CapCut TTS service không chạy (port 8100)", "voices_loaded": 0}
    return {"healthy": True, "message": "CapCut TTS service hoạt động", "voices_loaded": h.get("voices_loaded", 0)}


@router.post("/api/capcut/preview")
async def capcut_preview(body: dict):
    """Generate a short preview MP3 for a voice and return its audio bytes.

    Body: {"voice": "BV421_vivn_streaming", "text": "optional override"}
    """
    voice = body.get("voice") or settings.capcut_tts_default_voice
    text = (body.get("text") or PREVIEW_TEXT).strip()[:200]
    if not text:
        text = PREVIEW_TEXT

    try:
        job_id = await run_in_threadpool(
            submit_job,
            [{"text": text, "start": 0.0, "end": 0.0}],
            voice, rate="1.0", filename_prefix="preview",
        )
        job = await asyncio.get_event_loop().run_in_executor(None, lambda: poll_job(job_id, timeout=PREVIEW_TIMEOUT))
    except CapCutTTSError as e:
        raise HTTPException(502, f"CapCut TTS lỗi khi tạo preview: {e}") from e

    if job.get("status") != "done":
        raise HTTPException(502, f"CapCut TTS preview thất bại: {job.get('error', job.get('status', 'unknown'))}")

    audio_files = job.get("audio_files") or []
    if not audio_files:
        raise HTTPException(502, "CapCut TTS preview không trả audio nào")

    filename = Path(audio_files[0]).name
    out_path = settings.temp_dir / "tts_preview" / f"{voice.replace('/', '_')}.mp3"
    try:
        await run_in_threadpool(download_audio, job_id, filename, out_path)
    except CapCutTTSError as e:
        raise HTTPException(502, f"Không tải được audio preview: {e}") from e

    return Response(content=out_path.read_bytes(), media_type="audio/mpeg")
