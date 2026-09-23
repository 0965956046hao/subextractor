"""Shared job helpers: cancellation exception + sync WS notify bridge."""

import asyncio
import time


class JobCancelled(Exception):
    """Raised when the user requests to cancel a running job."""


# Lần cuối CÓ HOẠT ĐỘNG job (log/progress), tính cả thread executor. Dùng để
# phân biệt "worker bận job dài" với "worker kẹt" trong /api/worker-status.
_last_job_activity: float = 0.0


def _touch_job_activity() -> None:
    global _last_job_activity
    _last_job_activity = time.time()


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
    _touch_job_activity()
    entry = {"message": message, "ts": time.time(), "level": level}
    job = jobs.get(job_id)
    if job is not None:
        job.setdefault("logs", []).append(entry)
    notify_ws_sync(loop, ws_clients, job_id, {"type": "log", **entry})
