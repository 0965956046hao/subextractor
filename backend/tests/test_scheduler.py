"""Scheduler regressions. Run: python -m unittest discover -s tests -v."""

import asyncio
import unittest

from app.scheduler import LaneQueue, PipelineScheduler, PriorityGate


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_does_not_consume_direct_sse_entry(self):
        scheduler = PipelineScheduler()
        await scheduler.acquire_direct("first", "delogo")
        worker = asyncio.create_task(scheduler.acquire_next("watermark"))
        await asyncio.sleep(0)
        direct = asyncio.create_task(scheduler.acquire_direct("second", "delogo"))
        await asyncio.sleep(0)
        scheduler.release_direct("first", "delogo")
        await asyncio.wait_for(direct, 1)
        self.assertFalse(worker.done())
        self.assertEqual(scheduler.lanes["watermark"].running, "second")
        self.assertIsNone(scheduler.gates["gpu"].owner)
        self.assertIsNone(scheduler.gates["cpu"].owner)
        scheduler.release_direct("second", "delogo")
        await scheduler.enqueue("queued-job", "watermark")
        self.assertEqual(await asyncio.wait_for(worker, 1), "queued-job")
        scheduler.release_job("queued-job")

    async def test_cancel_during_resource_handoff_releases_owner(self):
        gate = PriorityGate("gpu")
        await gate.acquire("first")
        second = asyncio.create_task(gate.acquire("second"))
        await asyncio.sleep(0)
        third = asyncio.create_task(gate.acquire("third"))
        await asyncio.sleep(0)
        gate.release("first")
        second.cancel()  # ownership granted, coroutine not yet resumed
        with self.assertRaises(asyncio.CancelledError):
            await second
        await asyncio.wait_for(third, 1)
        self.assertEqual(gate.owner, "third")
        gate.release("third")
        self.assertIsNone(gate.owner)

    async def test_cancel_direct_head_wakes_worker(self):
        lane = LaneQueue("watermark")
        await lane.acquire("first")
        direct = asyncio.create_task(lane.acquire("second"))
        await asyncio.sleep(0)
        lane.enqueue("third")
        worker = asyncio.create_task(lane.next_job())
        lane.release("first")
        direct.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await direct
        self.assertEqual(await asyncio.wait_for(worker, 1), "third")
        lane.release("third")

    async def test_priority_is_fifo_and_never_preempts(self):
        scheduler = PipelineScheduler()
        async with scheduler.guard("gemini", "first"):
            tasks = [asyncio.create_task(scheduler.gates["gemini"].acquire(j))
                     for j in ("normal", "resume-a", "resume-b")]
            await asyncio.sleep(0)
            await scheduler.prioritize("resume-a")
            await scheduler.prioritize("resume-b")
            await scheduler.prioritize("resume-a")
            self.assertEqual(scheduler.gates["gemini"].owner, "first")
        for job_id, task in (("resume-a", tasks[1]), ("resume-b", tasks[2]),
                             ("normal", tasks[0])):
            await asyncio.wait_for(task, 1)
            self.assertEqual(scheduler.gates["gemini"].owner, job_id)
            scheduler.gates["gemini"].release(job_id)

    async def test_telegram_auto_bypasses_resource_guards(self):
        scheduler = PipelineScheduler()
        await scheduler.acquire_resources("busy", "export")
        await scheduler.enqueue("telegram", "telegram_auto")
        self.assertEqual(await scheduler.acquire_next("auto"), "telegram")
        await asyncio.wait_for(scheduler.acquire_resources("telegram", "telegram_auto"), 1)
        self.assertEqual(scheduler.gates["gpu"].owner, "busy")
        scheduler.release_job("telegram")
        scheduler.release_resources("busy")

    async def test_hardcode_bypasses_resources_but_keeps_single_lane(self):
        scheduler = PipelineScheduler()
        await scheduler.acquire_resources("ocr", "ocr")
        await scheduler.acquire_resources("dub", "dub")
        await scheduler.enqueue("embed-a", "hardcode")
        await scheduler.enqueue("embed-b", "hardcode")
        self.assertEqual(await scheduler.acquire_next("hardcode"), "embed-a")
        await asyncio.wait_for(scheduler.acquire_resources("embed-a", "hardcode"), 1)
        self.assertEqual(scheduler.gates["gpu"].owner, "ocr")
        self.assertEqual(scheduler.gates["cpu"].owner, "dub")
        second = asyncio.create_task(scheduler.acquire_next("hardcode"))
        await asyncio.sleep(0)
        self.assertFalse(second.done())
        scheduler.release_job("embed-a")
        self.assertEqual(await asyncio.wait_for(second, 1), "embed-b")
        scheduler.release_job("embed-b")
        scheduler.release_resources("ocr")
        scheduler.release_resources("dub")

    async def test_cancel_video_removes_unique_delogo_waiters(self):
        from app.scheduler import LaneCancelled

        scheduler = PipelineScheduler()
        await scheduler.acquire_direct("delogo:other:one", "delogo")
        waiter = asyncio.create_task(scheduler.acquire_direct("delogo:video:two", "delogo"))
        await asyncio.sleep(0)
        await scheduler.cancel_video("video")
        with self.assertRaises(LaneCancelled):
            await asyncio.wait_for(waiter, 1)
        self.assertEqual(scheduler.lanes["watermark"].running, "delogo:other:one")
        self.assertEqual(scheduler.lanes["watermark"].qsize(), 0)
        scheduler.release_direct("delogo:other:one", "delogo")

    async def test_watermark_bypasses_resources_but_keeps_single_lane(self):
        scheduler = PipelineScheduler()
        await scheduler.acquire_resources("ocr", "ocr")
        await scheduler.acquire_resources("dub", "dub")
        await asyncio.wait_for(scheduler.acquire_direct("remove-a", "delogo"), 1)
        second = asyncio.create_task(scheduler.acquire_direct("remove-b", "watermark"))
        await asyncio.sleep(0)
        self.assertFalse(second.done())
        self.assertEqual(scheduler.lanes["watermark"].running, "remove-a")
        self.assertEqual(scheduler.gates["gpu"].owner, "ocr")
        self.assertEqual(scheduler.gates["cpu"].owner, "dub")
        scheduler.release_direct("remove-a", "delogo")
        await asyncio.wait_for(second, 1)
        self.assertEqual(scheduler.lanes["watermark"].running, "remove-b")
        scheduler.release_direct("remove-b", "watermark")
        self.assertEqual(scheduler.gates["gpu"].owner, "ocr")
        self.assertEqual(scheduler.gates["cpu"].owner, "dub")
        scheduler.release_resources("ocr")
        scheduler.release_resources("dub")


if __name__ == "__main__":
    unittest.main()
