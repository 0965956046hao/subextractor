"""Step-level lane scheduler for the pipeline.

The backend used to run every queued job through a single ``asyncio.Queue``
with one worker (sequential).  That made two pipelines unable to overlap even
when they were at *different* steps (V1 hardcode + V2 OCR is perfectly safe on
a normal machine, apart from shared resources).

This module implements the approved design:

* One :class:`LaneQueue` per pipeline step, capacity 1 (FIFO).
* Jobs map to a lane through :data:`JOB_LANES` (several job types may share a
  lane, e.g. ``tts`` and ``bulk_switch`` live in the ``dub`` lane).
* Shared resources are protected by :class:`PriorityGate`: ``gpu``, ``gemini``
  and ``cpu``.  Acquisition order is always ``lane -> gpu -> gemini -> cpu``
  to make deadlocks impossible.
* Resumed pipelines may jump to the front of a lane queue through
  ``priority=True``.  Priority never preempts a job that is already running.

The scheduler only decides *when* a job may run.  It never imports worker job
runners, which keeps ``run_telegram_auto_job`` (and its direct calls into
``run_job`` / ``run_translate_job`` / ...) completely untouched.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from contextlib import asynccontextmanager
from typing import AsyncIterator

logger = logging.getLogger(__name__)


class LaneCancelled(Exception):
    """Raised when a queued job is cancelled before it starts running."""


# ── Mapping tables ─────────────────────────────────────────────────────────

# Job type -> lane.  Unknown types fall back to the OCR lane (same behaviour
# as the old single worker which treated unknown types as OCR), but every job
# type created by the app is listed explicitly.
JOB_LANES: dict[str, str] = {
    "ocr": "ocr",
    "delogo": "watermark",
    "watermark": "watermark",
    "context": "context",
    "translate": "translate",
    "align": "translate",
    "risk_check": "translate",
    "dub": "dub",
    "tts": "dub",
    "bulk_switch": "dub",
    "hardcode": "hardcode",
    "export": "export",
    "telegram_auto": "auto",
}

# Lane order is only used for stable snapshots/logging; workers are started
# for every lane independently.
LANES: tuple[str, ...] = (
    "ocr",
    "watermark",
    "context",
    "translate",
    "dub",
    "hardcode",
    "export",
    "auto",
)

# Fixed acquisition order for shared resources.  Never change this without
# changing every call site: inconsistent ordering is how deadlocks happen.
RESOURCES: tuple[str, ...] = ("gpu", "gemini", "cpu")

# Job type -> shared resources it needs.  Everything in a lane that touches
# the same hardware/API group gets the same guard.
JOB_RESOURCES: dict[str, tuple[str, ...]] = {
    "ocr": ("gpu",),
    # Watermark removal uses only its capacity-1 lane, not shared guards.
    "delogo": (),
    "watermark": (),
    "context": ("gemini",),
    "translate": ("gemini",),
    "align": ("gemini",),
    "risk_check": ("gemini",),
    "dub": ("cpu",),
    # TTS synthesis is network-bound (Google/CapCut API) and already bounded
    # by settings.tts_workers inside the job.  The lane alone is enough.
    "tts": (),
    "bulk_switch": (),
    # Subtitle embedding keeps its capacity-1 lane, but may overlap OCR/dub.
    # This changes scheduling only, not the GPU/CPU encoding implementation.
    "hardcode": (),
    "export": ("gpu", "cpu"),
    # Telegram auto deliberately bypasses all guards (approved decision).
    "telegram_auto": (),
}


def lane_for(job_type: str) -> str:
    return JOB_LANES.get(job_type, "ocr")


def resources_for(job_type: str) -> tuple[str, ...]:
    return JOB_RESOURCES.get(job_type, ())


# ── Lane queue ─────────────────────────────────────────────────────────────


class LaneQueue:
    """Capacity-1 FIFO queue for one pipeline step.

    ``high`` holds resumed/prioritised jobs (FIFO among themselves); ``normal``
    holds regular jobs.  Only the head of ``high`` (falling back to ``normal``)
    may run, and only when nothing else is running in this lane.
    """

    def __init__(self, name: str):
        self.name = name
        self._high: deque[str] = deque()
        self._normal: deque[str] = deque()
        self._queued: set[str] = set()
        self._cancelled: set[str] = set()
        # Ids currently blocked in :meth:`acquire` (direct work such as delogo).
        # Only these need a cancellation wakeup; queued job ids do not.
        self._acquirers: set[str] = set()
        self._running: str | None = None
        self._event = asyncio.Event()

    # -- introspection ----------------------------------------------------

    @property
    def running(self) -> str | None:
        return self._running

    def qsize(self) -> int:
        """Number of jobs waiting (excluding the running one)."""
        return len(self._high) + len(self._normal)

    def position(self, job_id: str) -> int | None:
        """1-based queue position, or ``None`` when not waiting."""
        ordered = list(self._high) + list(self._normal)
        try:
            return ordered.index(job_id) + 1
        except ValueError:
            return None

    def is_busy(self) -> bool:
        return self._running is not None or bool(self._high or self._normal)

    # -- queue operations -------------------------------------------------

    def enqueue(self, job_id: str, priority: bool = False) -> None:
        if self._running == job_id:
            return
        self._cancelled.discard(job_id)
        if job_id in self._queued:
            if priority:
                self.prioritize(job_id)
            return
        self._queued.add(job_id)
        (self._high if priority else self._normal).append(job_id)
        self._event.set()

    def prioritize(self, job_id: str) -> bool:
        """Move a waiting job to the front-priority deque.

        Resumed jobs keep FIFO order among themselves (append to ``high``), so
        two users hammering "resume" do not starve the first one.
        """
        if job_id in self._high:
            return False
        try:
            self._normal.remove(job_id)
        except ValueError:
            return False
        self._high.append(job_id)
        self._event.set()
        return True

    def cancel(self, job_id: str) -> None:
        """Cancel a waiting or running job.

        Running jobs are not preempted: the job runner notices
        ``job["cancelled"]`` and exits on its own.  Only a caller blocked in
        :meth:`acquire` needs to be woken with :class:`LaneCancelled`; other
        queued jobs are simply removed (remembering their id forever would
        leak one string per cancelled job).
        """
        if job_id in self._queued:
            try:
                self._high.remove(job_id)
            except ValueError:
                try:
                    self._normal.remove(job_id)
                except ValueError:
                    pass
            self._queued.discard(job_id)
        if job_id in self._acquirers:
            self._cancelled.add(job_id)
        self._event.set()

    def _pop_head(self) -> str | None:
        if self._running is not None:
            return None
        queue = self._high if self._high else self._normal
        if not queue:
            return None
        job_id = queue.popleft()
        self._queued.discard(job_id)
        return job_id

    # -- worker side ------------------------------------------------------

    async def next_job(self) -> str:
        """Wait for the next runnable job and mark it as running."""
        while True:
            head = self._high[0] if self._high else (
                self._normal[0] if self._normal else None
            )
            # Direct SSE callers own their queue entry. A lane worker must not
            # dispatch it as an OCR job or release its lane/resources early.
            job_id = self._pop_head() if head not in self._acquirers else None
            if job_id is not None:
                if job_id in self._cancelled:
                    self._cancelled.discard(job_id)
                    continue
                self._running = job_id
                return job_id
            # clear *before* re-checking to avoid losing a wakeup between the
            # check above and the await below.
            self._event.clear()
            if self._running is None and head is not None and head not in self._acquirers:
                continue
            await self._event.wait()

    async def acquire(self, job_id: str, priority: bool = False) -> None:
        """Enqueue ``job_id`` and block until it is the running job.

        Used by direct (non-job) work such as the delogo SSE endpoint.  Unlike
        :meth:`next_job` it knows which id it is waiting for, so cancellation
        can wake it immediately with :class:`LaneCancelled`.
        """
        self.enqueue(job_id, priority)
        self._acquirers.add(job_id)
        try:
            while True:
                if job_id in self._cancelled:
                    raise LaneCancelled(job_id)
                if self._running == job_id:
                    return
                if self._running is None:
                    head = self._high[0] if self._high else (
                        self._normal[0] if self._normal else None
                    )
                    if head == job_id:
                        self._pop_head()
                        self._running = job_id
                        return
                self._event.clear()
                if job_id in self._cancelled:
                    continue
                if self._running is None:
                    head = self._high[0] if self._high else (
                        self._normal[0] if self._normal else None
                    )
                    if head == job_id:
                        continue
                try:
                    await self._event.wait()
                except asyncio.CancelledError:
                    # Caller aborted (delogo client disconnected) while queued:
                    # remove ourselves so we do not get picked up later.
                    self._queued.discard(job_id)
                    for queue in (self._high, self._normal):
                        try:
                            queue.remove(job_id)
                        except ValueError:
                            pass
                    raise
        finally:
            self._acquirers.discard(job_id)
            self._cancelled.discard(job_id)
            self._event.set()

    def release(self, job_id: str) -> None:
        if self._running == job_id:
            self._running = None
        self._cancelled.discard(job_id)
        self._event.set()


# ── Shared resource gate ───────────────────────────────────────────────────


class PriorityGate:
    """Binary semaphore with a priority waiting line.

    Both priority and normal waiters are FIFO; priority waiters always go
    first.  Cancellation resolves the waiter future with
    :class:`LaneCancelled` so the caller can release whatever it already holds.
    """

    def __init__(self, name: str):
        self.name = name
        self._owner: str | None = None
        self._high: deque[str] = deque()
        self._normal: deque[str] = deque()
        self._waiters: dict[str, asyncio.Future] = {}
        self._cancelled: set[str] = set()

    @property
    def owner(self) -> str | None:
        return self._owner

    def is_busy(self) -> bool:
        return self._owner is not None or bool(self._high or self._normal)

    async def acquire(self, job_id: str, priority: bool = False) -> None:
        if self._owner == job_id:
            return
        if self._owner is None and not self._high and not self._normal:
            self._owner = job_id
            return

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._waiters[job_id] = fut
        (self._high if priority else self._normal).append(job_id)
        try:
            await fut
        except asyncio.CancelledError:
            self._remove_waiter(job_id)
            # release() may already have handed ownership to this future,
            # before its task gets a chance to resume and record the resource.
            self.release(job_id)
            raise
        finally:
            self._waiters.pop(job_id, None)

    def _remove_waiter(self, job_id: str) -> None:
        for queue in (self._high, self._normal):
            try:
                queue.remove(job_id)
            except ValueError:
                pass

    def cancel(self, job_id: str) -> None:
        if self._owner == job_id:
            # Running: caller must release normally.  Just remember so a
            # release → wake cycle does not resurrect it.
            self._cancelled.add(job_id)
            return
        fut = self._waiters.pop(job_id, None)
        self._remove_waiter(job_id)
        if fut is not None and not fut.done():
            fut.set_exception(LaneCancelled(job_id))

    def release(self, job_id: str) -> None:
        if self._owner != job_id:
            return
        self._owner = None
        self._cancelled.discard(job_id)
        self._wake_next()

    def _wake_next(self) -> None:
        while True:
            queue = self._high if self._high else self._normal
            if not queue:
                return
            nxt = queue.popleft()
            fut = self._waiters.pop(nxt, None)
            if nxt in self._cancelled:
                self._cancelled.discard(nxt)
                if fut is not None and not fut.done():
                    fut.set_exception(LaneCancelled(nxt))
                continue
            if fut is None or fut.done():
                continue
            self._owner = nxt
            fut.set_result(None)
            return


# ── Scheduler ──────────────────────────────────────────────────────────────


class PipelineScheduler:
    """Coordinates lane queues and shared resource gates."""

    def __init__(self):
        self.lanes: dict[str, LaneQueue] = {name: LaneQueue(name) for name in LANES}
        self.gates: dict[str, PriorityGate] = {
            name: PriorityGate(name) for name in RESOURCES
        }
        # job id -> lane name.  Kept so ``cancel(job_id)`` can find the queue
        # without knowing the job type.
        self._job_lanes: dict[str, str] = {}
        # job id -> resources currently held (release order is reversed).
        self._job_resources: dict[str, tuple[str, ...]] = {}

    # -- registration -----------------------------------------------------

    async def enqueue(self, job_id: str, job_type: str, priority: bool = False) -> None:
        lane_name = lane_for(job_type)
        self._job_lanes[job_id] = lane_name
        self.lanes[lane_name].enqueue(job_id, priority=priority)

    async def prioritize(self, job_id: str) -> bool:
        lane_name = self._job_lanes.get(job_id)
        moved = False
        if lane_name:
            moved = self.lanes[lane_name].prioritize(job_id)
        else:
            # Direct entries (delogo) are not registered in _job_lanes.
            for lane in self.lanes.values():
                if lane.prioritize(job_id):
                    moved = True
        for gate in self.gates.values():
            # Only waiting gates matter; running owners are never preempted.
            if job_id in gate._waiters:
                if job_id not in gate._high:
                    gate._remove_waiter(job_id)
                    gate._high.append(job_id)
                    moved = True
        return moved

    async def cancel(self, job_id: str) -> None:
        lane_name = self._job_lanes.get(job_id)
        if lane_name:
            lane = self.lanes[lane_name]
            if lane.running != job_id:
                # Queued job: it will never be picked up, so drop bookkeeping
                # now instead of leaking one mapping per cancelled job.
                self._job_lanes.pop(job_id, None)
                self._job_resources.pop(job_id, None)
            lane.cancel(job_id)
        else:
            # Direct entries (delogo) are not registered in _job_lanes.
            for lane in self.lanes.values():
                lane.cancel(job_id)
        for gate in self.gates.values():
            gate.cancel(job_id)

    async def cancel_video(self, video_id: str, job_type_for_key: str = "job") -> None:
        """Cancel every queued/running scheduler entry belonging to a video.

        ``job_id``s are opaque here, so callers also cancel the ``jobs`` dict.
        This covers direct entries registered under ``f"{prefix}:{video_id}"``
        plus per-request variants (``f"{prefix}:{video_id}:{hex}"`` used by
        Gemini guards so a double-click cannot run two calls at once).
        """
        prefixes = (f"delogo:{video_id}", f"voice-map:{video_id}")
        for prefix in prefixes:
            await self.cancel(prefix)
        for lane in self.lanes.values():
            for job_id in list(lane._queued):
                if any(job_id.startswith(prefix + ":") for prefix in prefixes):
                    await self.cancel(job_id)
        for gate in self.gates.values():
            for job_id in list(gate._waiters):
                if any(
                    job_id.startswith(prefix + ":") for prefix in prefixes
                ):
                    await self.cancel(job_id)

    # -- worker side ------------------------------------------------------

    async def acquire_next(self, lane_name: str) -> str:
        """Return the next runnable job id for ``lane_name`` (marks running)."""
        return await self.lanes[lane_name].next_job()

    async def acquire_resources(self, job_id: str, job_type: str, priority: bool = False) -> None:
        held: list[str] = []
        try:
            for resource in RESOURCES:
                if resource not in resources_for(job_type):
                    continue
                await self.gates[resource].acquire(job_id, priority=priority)
                held.append(resource)
        except BaseException:
            for resource in reversed(held):
                self.gates[resource].release(job_id)
            raise
        self._job_resources[job_id] = tuple(held)

    def release_resources(self, job_id: str) -> None:
        for resource in reversed(self._job_resources.pop(job_id, ())):
            self.gates[resource].release(job_id)

    def release_job(self, job_id: str) -> None:
        lane_name = self._job_lanes.pop(job_id, None)
        self.release_resources(job_id)
        if lane_name:
            self.lanes[lane_name].release(job_id)

    # -- direct (non-queued) work -----------------------------------------

    async def acquire_direct(
        self, job_id: str, job_type: str, priority: bool = False
    ) -> None:
        """Acquire ``lane -> resources`` for work that is not a queued job."""
        lane_name = lane_for(job_type)
        lane = self.lanes[lane_name]
        await lane.acquire(job_id, priority=priority)
        try:
            await self.acquire_resources(job_id, job_type, priority=priority)
        except BaseException:
            lane.release(job_id)
            raise

    def release_direct(self, job_id: str, job_type: str) -> None:
        self.release_resources(job_id)
        self.lanes[lane_for(job_type)].release(job_id)

    @asynccontextmanager
    async def direct(self, job_id: str, job_type: str, priority: bool = False) -> AsyncIterator[None]:
        """Context-manager wrapper around :meth:`acquire_direct`."""
        await self.acquire_direct(job_id, job_type, priority=priority)
        try:
            yield
        finally:
            self.release_direct(job_id, job_type)

    @asynccontextmanager
    async def guard(self, resource: str, job_id: str, priority: bool = False) -> AsyncIterator[None]:
        """Acquire a single shared resource (e.g. voice-map → gemini)."""
        gate = self.gates[resource]
        await gate.acquire(job_id, priority=priority)
        try:
            yield
        finally:
            gate.release(job_id)

    # -- introspection ----------------------------------------------------

    def lane_busy(self, lane_name: str) -> bool:
        return self.lanes[lane_name].is_busy()

    def snapshot(self) -> dict:
        lanes = {}
        for name, lane in self.lanes.items():
            lanes[name] = {
                "running": lane.running,
                "queued": lane.qsize(),
                "busy": lane.is_busy(),
            }
        gates = {
            name: {
                "owner": gate.owner,
                "waiting": len(gate._high) + len(gate._normal),
            }
            for name, gate in self.gates.items()
        }
        return {
            "lanes": lanes,
            "resources": gates,
            "queued": sum(lane.qsize() for lane in self.lanes.values()),
        }


# ── Queue façade ───────────────────────────────────────────────────────────


class JobQueueRouter:
    """Backwards-compatible ``asyncio.Queue`` façade.

    Existing routers call ``await queue.put(job_id)`` and never import the
    scheduler.  The router looks the job up to find its type and then puts it
    into the right lane.  ``telegram_auto`` goes to the ``auto`` lane, which has
    no resource guards, preserving its old sequential behaviour.
    """

    def __init__(self, jobs: dict, scheduler: PipelineScheduler):
        self.jobs = jobs
        self.scheduler = scheduler

    async def put(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            logger.warning("JobQueueRouter: put() for unknown job %s", job_id)
            return

        # Allow endpoints to request priority without a second HTTP call
        # (used by OCR / tests); graceful fallback when absent.
        priority = bool(
            job.get("priority")
            or job.get("priority_high")
            or job.get("resume")
        )
        await self.scheduler.enqueue(
            job_id, job.get("job_type", "ocr"), priority=priority
        )

    async def prioritize(self, job_id: str) -> bool:
        return await self.scheduler.prioritize(job_id)

    def qsize(self) -> int:
        return sum(lane.qsize() for lane in self.scheduler.lanes.values())

    def empty(self) -> bool:
        return self.qsize() == 0

    def task_done(self) -> None:  # pragma: no cover - compatibility no-op
        return None
