"""Measure actual executor work, excluding lane/resource/executor queue waits."""

import threading
import time

from app.services.job_utils import JobCancelled

_lock = threading.RLock()
_TERMINAL = {"error", "cancelled"}


def start_processing(job: dict) -> None:
    with _lock:
        if job.get("cancelled"):
            raise JobCancelled()
        job.setdefault("processing_started_at", time.time())
        job["_processing_monotonic"] = time.monotonic()
        job["processing_finished_at"] = None


def stop_processing(job: dict) -> None:
    with _lock:
        started = job.pop("_processing_monotonic", None)
        if started is not None:
            job["processing_elapsed_ms"] = job.get("processing_elapsed_ms", 0.0) + max(
                0.0, (time.monotonic() - started) * 1000,
            )
            job["processing_finished_at"] = time.time()


def timed_job_call(job: dict, fn, *args):
    start_processing(job)
    try:
        return fn(*args)
    finally:
        stop_processing(job)


def timing_snapshot(job: dict) -> dict:
    with _lock:
        # Pause/cancel can be requested while a cooperative worker is stopping.
        # Freeze the UI at that request, never let it resume counting later.
        if job.get("cancelled") or job.get("status") in _TERMINAL:
            stop_processing(job)
        elapsed = job.get("processing_elapsed_ms", 0.0)
        started = job.get("_processing_monotonic")
        if started is not None:
            elapsed += max(0.0, (time.monotonic() - started) * 1000)
        return {
            "started_at": job.get("processing_started_at"),
            "finished_at": job.get("processing_finished_at"),
            "elapsed_ms": elapsed,
            "running": started is not None,
        }
