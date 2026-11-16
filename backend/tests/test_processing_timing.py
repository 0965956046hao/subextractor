import asyncio
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from app.services import processing_timing as timing
from app.services.job_utils import JobCancelled


class Clock:
    def __init__(self):
        self.now = 100.0
        self.wall = 1000.0

    def monotonic(self):
        return self.now

    def time(self):
        return self.wall


class ProcessingTimingTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.enterContext(patch.object(timing, "time", self.clock))

    def test_waiting_has_no_processing_time(self):
        job = {"status": "queued"}
        self.clock.now += 300
        snapshot = timing.timing_snapshot(job)
        self.assertEqual(snapshot["elapsed_ms"], 0)
        self.assertIsNone(snapshot["started_at"])
        self.assertFalse(snapshot["running"])

    def test_executor_wait_is_excluded_and_final_time_does_not_grow(self):
        occupied = threading.Event()
        release = threading.Event()
        job = {"status": "processing"}

        def blocker():
            occupied.set()
            release.wait(2)

        def work():
            self.clock.now += 40
            return "result"

        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(blocker)
            self.assertTrue(occupied.wait(1))
            future = executor.submit(timing.timed_job_call, job, work)
            try:
                self.clock.now += 180  # sitting in the executor queue
                self.assertIsNone(timing.timing_snapshot(job)["started_at"])
            finally:
                release.set()
            self.assertEqual(future.result(timeout=2), "result")
        self.assertEqual(timing.timing_snapshot(job)["elapsed_ms"], 40000)
        self.clock.now += 3600  # polling delay / manual gate / F5
        self.assertEqual(timing.timing_snapshot(job)["elapsed_ms"], 40000)
        self.assertFalse(timing.timing_snapshot(job)["running"])

    def test_uses_monotonic_time_and_freezes_on_pause(self):
        job = {"status": "processing"}
        timing.start_processing(job)
        self.clock.now += 12
        self.clock.wall -= 600  # system clock correction must not affect duration
        self.assertEqual(timing.timing_snapshot(job)["elapsed_ms"], 12000)
        job.update(cancelled=True, status="cancelled")
        timing.stop_processing(job)
        self.clock.now += 100
        self.assertEqual(timing.timing_snapshot(job)["elapsed_ms"], 12000)
        with self.assertRaises(JobCancelled):
            timing.timed_job_call(job, lambda: None)

    def test_failure_stops_clock_and_new_attempt_has_its_own_duration(self):
        job = {"status": "processing"}

        def fail():
            self.clock.now += 7
            raise RuntimeError("failure")

        with self.assertRaises(RuntimeError):
            timing.timed_job_call(job, fail)
        self.assertEqual(timing.timing_snapshot(job)["elapsed_ms"], 7000)
        new_attempt = {"status": "processing"}
        timing.timed_job_call(new_attempt, lambda: setattr(self.clock, "now", self.clock.now + 3))
        self.assertEqual(timing.timing_snapshot(new_attempt)["elapsed_ms"], 3000)

    def test_status_and_reload_endpoint_return_actual_timings(self):
        from app.routers.process import get_status, get_video_timings
        from app.scheduler import PipelineScheduler

        job = {"status": "processing", "job_type": "translate", "video_id": "video"}
        jobs = {"translation": job}
        timing.start_processing(job)
        self.clock.now += 9
        job["status"] = "done"  # service reports done before executor cleanup
        status = asyncio.run(get_status("translation", jobs, PipelineScheduler()))
        self.assertEqual(status.status, "processing")
        timing.stop_processing(job)
        self.clock.now += 200
        status = asyncio.run(get_status("translation", jobs, PipelineScheduler()))
        self.assertEqual(status.status, "done")
        self.assertEqual(status.processing_timing.elapsed_ms, 9000)
        restored = asyncio.run(get_video_timings("video", jobs))["jobs"]
        self.assertEqual(restored[0]["processing_timing"]["elapsed_ms"], 9000)
        jobs["new-attempt"] = {"status": "queued", "job_type": "translate", "video_id": "video"}
        latest = asyncio.run(get_video_timings("video", jobs))["jobs"]
        self.assertEqual(len(latest), 1)
        self.assertEqual(latest[0]["job_id"], "new-attempt")
        self.assertEqual(latest[0]["processing_timing"]["elapsed_ms"], 0)


if __name__ == "__main__":
    unittest.main()
