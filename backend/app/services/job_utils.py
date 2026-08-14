"""Shared job helpers: cancellation exception + sync WS notify bridge."""

import asyncio


class JobCancelled(Exception):
    """Raised when the user requests to cancel a running job."""


def notify_ws_sync(loop: asyncio.AbstractEventLoop, ws_clients: dict, job_id: str, data: dict):
    from app.worker import notify_ws
    coro = notify_ws(ws_clients, job_id, data)
    asyncio.run_coroutine_threadsafe(coro, loop)
