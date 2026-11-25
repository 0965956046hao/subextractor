import asyncio
import tempfile
import threading
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.config import settings
from app.routers import tools
from app.services import translation_service as tr
from app.services.job_utils import JobCancelled
from app.services.srt_utils import parse_srt


def subtitles(count):
    return "\n\n".join(f"{i+1}\n00:{i // 30:02d}:{i * 2 % 60:02d},000 --> "
                       f"00:{i // 30:02d}:{i * 2 % 60 + 1:02d},000\n原文{i}" for i in range(count)) + "\n"


class RetranslationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(settings, "temp_dir", self.root))
        self.source = self.root / "source.srt"
        self.source.write_text(subtitles(121), encoding="utf-8")
        self.enterContext(patch.object(tr, "translation_source_path", return_value=self.source))
        self.enterContext(patch.object(tr, "_build_base_prompt", return_value="translate"))
        self.enterContext(patch.object(tr, "load_translation_context", return_value="context"))

    def test_repairs_are_bounded_to_50_lines_and_preserve_timeline(self):
        progress = []
        with patch.object(tr, "gemini_map_texts", side_effect=lambda texts, **kw: ["Fixed " + t for t in texts]) as call:
            output = tr.retranslate_untranslated("video", subtitles(121), target_lang="en",
                                                progress_callback=lambda done, total: progress.append((done, total)))
        self.assertEqual([len(c.args[0]) for c in call.call_args_list], [50, 50, 21])
        self.assertEqual(progress, [(1, 3), (2, 3), (3, 3)])
        self.assertEqual([(e.index, e.start, e.end) for e in parse_srt(output)],
                         [(e.index, e.start, e.end) for e in parse_srt(subtitles(121))])
        self.assertTrue(all(e.text.startswith("Fixed") for e in parse_srt(output)))

    def test_pause_prevents_next_repair_batch(self):
        cancelled = [False]

        def repair(texts, **kwargs):
            cancelled[0] = True
            return ["Fixed " + t for t in texts]

        with patch.object(tr, "gemini_map_texts", side_effect=repair) as call:
            with self.assertRaises(JobCancelled):
                tr.retranslate_untranslated("video", subtitles(121), cancelled_cb=lambda: cancelled[0])
        self.assertEqual(call.call_count, 1)

    def test_background_worker_publishes_only_requested_track(self):
        vi = self.root / "translated/video/subtitles_vi.srt"
        en = vi.with_name("subtitles_en.srt")
        vi.parent.mkdir(parents=True)
        vi.write_text("approved Vietnamese", encoding="utf-8")
        en.write_text(subtitles(121), encoding="utf-8")
        jobs = {"job": {"job_id": "job", "video_id": "video", "operation": "retranslate",
                        "retranslate_content": subtitles(121), "target_lang": "en"}}
        with patch.object(tr, "gemini_map_texts", side_effect=lambda texts, **kw: ["Fixed " + t for t in texts]), patch.object(
            tr, "job_log_sync",
        ), patch.object(tr, "notify_ws_sync"):
            tr.run_translate_sync(None, "job", jobs, {}, "video")
        self.assertEqual(jobs["job"]["status"], "done")
        self.assertTrue(jobs["job"]["updated"])
        self.assertTrue(all(e.text.startswith("Fixed") for e in parse_srt(en.read_text(encoding="utf-8"))))
        self.assertEqual(vi.read_text(encoding="utf-8"), "approved Vietnamese")

    def test_cancelled_worker_does_not_overwrite_previous_translation(self):
        target = self.root / "translated/video/subtitles_vi.srt"
        target.parent.mkdir(parents=True)
        target.write_text("previous translation", encoding="utf-8")
        job = {"job_id": "job", "video_id": "video", "operation": "retranslate",
               "retranslate_content": subtitles(121)}

        def repair(*args, **kwargs):
            job["cancelled"] = True
            return "new translation"

        with patch.object(tr, "retranslate_untranslated", side_effect=repair), patch.object(
            tr, "job_log_sync",
        ), patch.object(tr, "notify_ws_sync"):
            tr.run_translate_sync(None, "job", {"job": job}, {}, "video")
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(target.read_text(encoding="utf-8"), "previous translation")


class RetranslationRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_worker_runs_repair_in_executor_not_http_event_loop(self):
        from app import worker

        entered = threading.Event()
        release = threading.Event()
        thread_ids = []
        content = subtitles(1)

        def slow_repair(*args, **kwargs):
            thread_ids.append(threading.get_ident())
            entered.set()
            release.wait(2)
            return content

        job = {"job_id": "repair", "video_id": "video", "job_type": "translate",
               "operation": "retranslate", "retranslate_content": content}
        with patch.object(tr, "retranslate_untranslated", side_effect=slow_repair), patch.object(
            tr, "job_log_sync",
        ), patch.object(tr, "notify_ws_sync"), patch.object(worker, "notify_ws", new=AsyncMock()), patch.object(
            worker, "job_log_async", new=AsyncMock(),
        ), patch.object(worker, "_tg_notify", new=AsyncMock()) as telegram:
            task = asyncio.create_task(worker.run_translate_job({"repair": job}, {}, "repair"))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.005)
                self.assertTrue(entered.is_set())
                self.assertFalse(task.done())
                self.assertNotEqual(thread_ids, [threading.get_ident()])
            finally:
                release.set()
                await task
            telegram.assert_not_awaited()
        self.assertEqual(job["status"], "done")

    async def test_background_submission_returns_before_gemini_and_uses_translate_lane(self):
        jobs = {}
        queue = SimpleNamespace(put=AsyncMock())
        request = SimpleNamespace(json=AsyncMock(return_value={"content": subtitles(1), "background": True,
                                                              "source_lang": "vi", "target_lang": "en", "source_track": "vi"}))
        with patch.object(tools, "translation_source_path", return_value=Path("source.srt")), patch.object(
            tools, "get_jobs", return_value=jobs,
        ), patch.object(tools, "get_job_queue", return_value=queue), patch.object(tr, "retranslate_untranslated") as repair:
            result = await tools.retranslate_srt("video", request)
        repair.assert_not_called()
        job = jobs[result["job_id"]]
        self.assertEqual(job["job_type"], "translate")
        self.assertEqual(job["operation"], "retranslate")
        self.assertEqual(job["source_track"], "vi")
        queue.put.assert_awaited_once_with(result["job_id"])

    async def test_legacy_request_does_not_block_event_loop(self):
        entered = threading.Event()
        release = threading.Event()

        def slow_repair(*args, **kwargs):
            entered.set()
            release.wait(2)
            return subtitles(1)

        @asynccontextmanager
        async def guard(*args):
            yield

        request = SimpleNamespace(json=AsyncMock(return_value={"content": subtitles(1)}))
        with patch.object(tools, "get_scheduler", return_value=SimpleNamespace(guard=guard)), patch.object(
            tr, "retranslate_untranslated", side_effect=slow_repair,
        ):
            task = asyncio.create_task(tools.retranslate_srt("video", request))
            try:
                # A blocking Gemini call here would stop this coroutine too.
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.005)
                self.assertTrue(entered.is_set())
                self.assertFalse(task.done(), "the event loop remains responsive during Gemini work")
            finally:
                release.set()
                await task

    async def test_legacy_failure_is_an_http_error_not_raw_internal_server_text(self):
        @asynccontextmanager
        async def guard(*args):
            yield

        request = SimpleNamespace(json=AsyncMock(return_value={"content": subtitles(1)}))
        with patch.object(tools, "get_scheduler", return_value=SimpleNamespace(guard=guard)), patch.object(
            tr, "retranslate_untranslated", side_effect=RuntimeError("Gemini unavailable"),
        ), self.assertLogs(tools.logger, level="ERROR"):
            with self.assertRaises(HTTPException) as error:
                await tools.retranslate_srt("video", request)
        self.assertEqual(error.exception.status_code, 502)
        self.assertIn("Gemini unavailable", error.exception.detail)
