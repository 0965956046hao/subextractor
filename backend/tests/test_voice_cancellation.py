import asyncio
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI

from app import worker
from app.config import settings
from app.routers.video import router
from app.services import dub_service, tts_service
from app.services.job_utils import JobCancelled


class VoiceCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.addCleanup(self.executor.shutdown)
        self.lock = asyncio.Lock()
        self.stack.enter_context(patch.object(worker, "_voice_lock", self.lock))
        self.stack.enter_context(patch.object(worker, "_executor", self.executor))
        self.stack.enter_context(patch.object(worker, "_worker_heartbeats", {}))
        self.stack.enter_context(patch.object(worker, "_tg_notify", AsyncMock()))
        self.stack.enter_context(patch.object(settings, "job_timeout", 0))
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(settings, "temp_dir", self.root))
        self.jobs = {}
        app = FastAPI()
        app.include_router(router)
        app.state.jobs = self.jobs
        app.state.pipeline_states = {}
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    def job(self, job_id="voice", **extra):
        job = {"job_id": job_id, "video_id": job_id, "job_type": "dub", "status": "queued", "logs": [], **extra}
        self.jobs[job_id] = job
        return job

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)

        async def stop():
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        self.addAsyncCleanup(stop)
        return task

    async def until(self, predicate, timeout=1.5):
        async def check():
            while not predicate():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(check(), timeout)

    async def exercise_cancelled_waiter(self, action):
        await self.lock.acquire()  # Another video is actually using TTS.
        job = self.job()
        source = self.root / "videos" / job["video_id"] / "video.mp4"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"source video")
        ocr = self.job("ocr", job_type="ocr")
        queue = asyncio.Queue()
        await queue.put(job["job_id"])
        await queue.put(ocr["job_id"])

        async def run_ocr(jobs, ws, engines, job_id):
            jobs[job_id]["status"] = "done"

        synthesize = self.stack.enter_context(patch.object(dub_service, "run_dub_sync", Mock()))
        self.stack.enter_context(patch.object(worker, "run_job", side_effect=run_ocr))
        self.spawn(worker.worker_loop(self.jobs, {}, {}, queue, {}))
        await self.until(lambda: any("Đang chờ lượt TTS" in entry["message"] for entry in job["logs"]))
        if action == "delete":
            response = await self.client.delete("/api/video/voice")
        else:
            response = await self.client.post("/api/video/voice/pause")
        self.assertEqual(response.status_code, 200, response.text)
        await asyncio.wait_for(queue.join(), timeout=1.5)
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(ocr["status"], "done")
        synthesize.assert_not_called()
        self.assertTrue(self.lock.locked(), "Cancellation must not release another video's TTS lock")
        self.assertEqual(source.exists(), action == "pause")
        self.lock.release()

    async def test_pause_waiting_tts_frees_worker_for_ocr(self):
        await self.exercise_cancelled_waiter("pause")

    async def test_delete_waiting_tts_frees_worker_for_ocr(self):
        await self.exercise_cancelled_waiter("delete")

    async def test_cancelled_and_finished_queue_entries_never_start_again(self):
        queue = asyncio.Queue()
        for job in (self.job(cancelled=True, status="cancelled"), self.job("finished", status="done")):
            await queue.put(job["job_id"])
        handler = self.stack.enter_context(patch.object(worker, "run_dub_job", AsyncMock()))
        self.spawn(worker.worker_loop(self.jobs, {}, {}, queue, {}))
        await asyncio.wait_for(queue.join(), timeout=1)
        handler.assert_not_awaited()
        self.assertEqual(self.jobs["voice"]["status"], "cancelled")

    async def test_external_task_cancellation_does_not_release_other_owner(self):
        await self.lock.acquire()
        fn = Mock()
        job = self.job()
        task = self.spawn(worker._run_voice_sync(job, {}, fn))
        await self.until(lambda: bool(job["logs"]))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.lock.locked())
        fn.assert_not_called()
        self.lock.release()
        await asyncio.wait_for(self.lock.acquire(), timeout=1)
        self.lock.release()

    async def test_cancellation_at_acquisition_boundary_does_not_leak_lock(self):
        job = self.job()
        original = worker._wait_voice_future

        async def cancel_after_grant(job, future, timeout=None):
            await original(job, future, timeout)
            job["cancelled"] = True
            raise JobCancelled()

        fn = Mock()
        with patch.object(worker, "_wait_voice_future", side_effect=cancel_after_grant):
            with self.assertRaises(JobCancelled):
                await worker._run_voice_sync(job, {}, fn)
        self.assertFalse(self.lock.locked())
        fn.assert_not_called()

    async def test_active_cancel_frees_worker_but_retains_lock_until_thread_exits(self):
        started = threading.Event()
        finish = threading.Event()
        self.addCleanup(finish.set)

        def blocking_voice():
            started.set()
            finish.wait(timeout=5)

        job = self.job()
        task = self.spawn(worker._run_voice_sync(job, {}, blocking_voice))
        await self.until(started.is_set)
        job["cancelled"] = True
        with self.assertRaises(JobCancelled):
            await asyncio.wait_for(task, timeout=1)
        self.assertTrue(self.lock.locked())
        next_voice = Mock(return_value="next finished")
        next_task = self.spawn(worker._run_voice_sync(self.job("next"), {}, next_voice))
        await asyncio.sleep(0.05)
        next_voice.assert_not_called()
        finish.set()
        self.assertEqual(await asyncio.wait_for(next_task, timeout=1), "next finished")
        self.assertFalse(self.lock.locked())

    async def test_timeout_does_not_release_lock_while_thread_is_running(self):
        finish = threading.Event()
        self.addCleanup(finish.set)
        with patch.object(settings, "job_timeout", 0.05):
            with self.assertRaises(asyncio.TimeoutError):
                await worker._run_voice_sync(self.job(), {}, lambda: finish.wait(timeout=5))
        self.assertTrue(self.lock.locked())
        finish.set()
        await self.until(lambda: not self.lock.locked())

    async def test_removing_a_cancelled_waiter_preserves_fifo(self):
        await self.lock.acquire()
        order = []
        jobs = [self.job(name) for name in ("first", "cancelled", "last")]
        tasks = [self.spawn(worker._run_voice_sync(job, {}, lambda name=job["job_id"]: order.append(name))) for job in jobs]
        await self.until(lambda: all(job["logs"] for job in jobs))
        jobs[1]["cancelled"] = True
        with self.assertRaises(JobCancelled):
            await asyncio.wait_for(tasks[1], timeout=1)
        self.lock.release()
        await asyncio.wait_for(asyncio.gather(tasks[0], tasks[2]), timeout=1)
        self.assertEqual(order, ["first", "last"])


class VoiceResultCancellationTests(unittest.TestCase):
    def test_cancelled_dubbing_thread_never_reports_done_or_error(self):
        job = {"job_id": "job", "status": "queued"}

        def cancel(**kwargs):
            job["cancelled"] = True
            job["status"] = "cancelled"
            return Path("unused.m4a")

        with patch.object(dub_service, "dub_audio_only", side_effect=lambda *a, **kw: cancel(**kw)), \
                patch.object(dub_service, "job_log_sync"), \
                patch.object(dub_service, "notify_ws_sync") as notify:
            dub_service.run_dub_sync(None, "job", {"job": job}, {}, "video")
        self.assertEqual(job["status"], "cancelled")
        self.assertTrue(all(call.args[-1]["type"] not in ("done", "error") for call in notify.call_args_list))

    def test_cancelled_tts_thread_never_reports_done_or_error(self):
        job = {"job_id": "job", "status": "queued"}

        def cancel(*args, **kwargs):
            job["cancelled"] = True
            job["status"] = "cancelled"
            return []

        with patch.object(tts_service, "synthesize_srt", side_effect=cancel), \
                patch.object(tts_service, "job_log_sync"), \
                patch.object(tts_service, "notify_ws_sync") as notify:
            tts_service.run_tts_sync(None, "job", {"job": job}, {}, "video")
        self.assertEqual(job["status"], "cancelled")
        self.assertTrue(all(call.args[-1]["type"] not in ("done", "error") for call in notify.call_args_list))


if __name__ == "__main__":
    unittest.main()
