"""Telegram Auto Pipeline endpoint.

Creates a ``telegram_auto`` job that runs the full pipeline from a Douyin
link to final output, with Telegram checkpoint interactions.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request

from app.models import TelegramAutoRequest
from app.dependencies import get_jobs, get_job_queue

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/telegram/auto")
async def telegram_auto(
    body: TelegramAutoRequest,
    request: Request,
    jobs: dict = Depends(get_jobs),
    queue=Depends(get_job_queue),
):
    """Create a Telegram auto pipeline job and enqueue it."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL không hợp lệ")

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
        "url": url,
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
        "pipeline_preset": body.pipeline_preset,
        "playback_speed": body.playback_speed,
    }
    jobs[job_id] = job
    await queue.put(job_id)
    logger.info("telegram_auto job %s: queued (url=%s)", job_id, url[:60])

    return {"job_id": job_id}
