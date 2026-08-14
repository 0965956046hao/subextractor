"""Shared job helpers: cancellation exception + sync WS notify bridge."""

import asyncio
import time


class JobCancelled(Exception):
    """Raised when the user requests to cancel a running job."""


def notify_ws_sync(loop: asyncio.AbstractEventLoop, ws_clients: dict, job_id: str, data: dict):
    from app.worker import notify_ws
    coro = notify_ws(ws_clients, job_id, data)
    asyncio.run_coroutine_threadsafe(coro, loop)


def job_log_sync(
    loop: asyncio.AbstractEventLoop,
    jobs: dict,
    ws_clients: dict,
    job_id: str,
    message: str,
    level: str = "info",
):
    """Record a log entry in the job (visible via polling) AND push over WS."""
    entry = {"message": message, "ts": time.time(), "level": level}
    job = jobs.get(job_id)
    if job is not None:
        job.setdefault("logs", []).append(entry)
    notify_ws_sync(loop, ws_clients, job_id, {"type": "log", **entry})
