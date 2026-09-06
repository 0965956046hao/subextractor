"""Channel-watch endpoints: status + manual scan trigger."""

import asyncio
import logging

from fastapi import APIRouter

from app.services import channel_watch

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/channel-watch")
async def channel_watch_status():
    """Watchlist scan status + newest videos per channel (from temp files)."""
    return channel_watch.read_status()


@router.post("/api/channel-watch/scan")
async def channel_watch_scan_now():
    """Trigger one watchlist scan + Telegram notify now (background)."""
    asyncio.create_task(channel_watch.scan_and_notify())
    return {"status": "accepted"}
