import unittest
from types import SimpleNamespace

from app.routers.health import execution_job_status, worker_status
from app.scheduler import PipelineScheduler
from app.services.processing_timing import start_processing, stop_processing


class ExecutionStatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_endpoint_exposes_lightweight_active_jobs_only(self):
        scheduler = PipelineScheduler()
        await scheduler.enqueue("first", "ocr")
        await scheduler.enqueue("second", "ocr")
        state = SimpleNamespace(jobs={
            "first": {"video_id": "one", "job_type": "ocr", "status": "queued"},
            "second": {"video_id": "two", "job_type": "ocr", "status": "queued"},
            "old": {"video_id": "old", "job_type": "ocr", "status": "done"},
        }, scheduler=scheduler, job_queue=SimpleNamespace(qsize=lambda: 2))
        result = await worker_status(SimpleNamespace(app=SimpleNamespace(state=state)))
        self.assertEqual([j["video_id"] for j in result["execution_jobs"]], ["one", "two"])
        self.assertEqual([j["queue_position"] for j in result["execution_jobs"]], [1, 2])
        self.assertEqual(result["active_jobs"], 2)

    async def test_queue_positions_and_real_execution_are_distinct(self):
        scheduler = PipelineScheduler()
        for name in ("first", "second", "third"):
            await scheduler.enqueue(name, "ocr")
        job = {"video_id": "video", "job_type": "ocr", "status": "queued"}
        self.assertEqual(execution_job_status("second", job, scheduler)["queue_position"], 2)
        await scheduler.acquire_next("ocr")
        self.assertEqual(execution_job_status("second", job, scheduler)["queue_position"], 1)
        self.assertEqual(execution_job_status("first", job, scheduler)["state"], "waiting_executor")
        start_processing(job)
        try:
            self.assertEqual(execution_job_status("first", job, scheduler)["state"], "running")
        finally:
            stop_processing(job)

    async def test_lane_owner_waiting_for_gemini_is_not_reported_running(self):
        scheduler = PipelineScheduler()
        await scheduler.gates["gemini"].acquire("context-job")
        await scheduler.enqueue("translation", "translate")
        await scheduler.acquire_next("translate")
        result = execution_job_status("translation", {"job_type": "translate"}, scheduler)
        self.assertEqual(result["state"], "waiting_resources")
        self.assertEqual(result["waiting_resources"], ["gemini"])
        self.assertIsNone(result["queue_position"])
        scheduler.gates["gemini"].release("context-job")

    async def test_job_in_lane_queue_is_queued_even_if_shared_resource_is_busy(self):
        scheduler = PipelineScheduler()
        await scheduler.gates["gpu"].acquire("export-job")
        await scheduler.enqueue("ocr", "ocr")
        result = execution_job_status("ocr", {"job_type": "ocr"}, scheduler)
        self.assertEqual(result["state"], "queued")
        self.assertEqual(result["queue_position"], 1)
        scheduler.gates["gpu"].release("export-job")

    async def test_pre_executor_processing_status_does_not_claim_execution(self):
        scheduler = PipelineScheduler()
        await scheduler.enqueue("dub", "dub")
        await scheduler.acquire_next("dub")
        result = execution_job_status("dub", {"job_type": "dub", "status": "processing"}, scheduler)
        self.assertEqual(result["state"], "waiting_executor")
        self.assertFalse(result["processing_timing"]["running"])
