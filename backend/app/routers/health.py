"""Pipeline readiness / health check endpoints."""

import logging

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from app.services.health_service import check_gemini, check_tts, pipeline_health

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/health/checks")
async def health_checks():
    """Full prerequisite health check (Gemini + TTS). Blocks pipeline start."""
    return await run_in_threadpool(pipeline_health)


@router.get("/api/health/gemini")
async def gemini_check():
    return check_gemini()


@router.get("/api/health/tts")
async def tts_check():
    return check_tts()