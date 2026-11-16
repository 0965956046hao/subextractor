import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.config import settings
from app.models import SrtEntry
from app.services import gemini_array, retry_utils, translation_service
from app.services.job_utils import JobCancelled
from app.services.srt_utils import entries_to_srt, parse_srt


class RateLimitError(Exception):
    code = 429


class GeminiGateTests(unittest.TestCase):
    def test_parallel_videos_and_fixed_key_calls_share_one_slot_and_spacing(self):
        gate = retry_utils._GeminiGate()
        barrier = threading.Barrier(4)
        starts = []
        active = 0
        maximum = 0
        lock = threading.Lock()

        def request():
            nonlocal active, maximum
            with lock:
                starts.append(time.monotonic())
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.01)
            with lock:
                active -= 1
            return "ok"

        def video(index):
            barrier.wait(timeout=5)
            if index % 2:
                return retry_utils.gemini_retry(request)()
            return retry_utils.gemini_call_rotating(lambda *a, **kw: request)

        with patch.object(retry_utils, "_gemini_gate", gate), \
                patch.object(retry_utils, "configured_gemini_keys", return_value=["key-a", "key-b"]), \
                patch.object(settings, "gemini_min_interval", 0.03):
            with ThreadPoolExecutor(max_workers=4) as pool:
                self.assertEqual(list(pool.map(video, range(4))), ["ok"] * 4)
        self.assertEqual(maximum, 1)
        self.assertTrue(all(b - a >= 0.025 for a, b in zip(starts, starts[1:])))

    def test_rate_limit_cooldown_survives_key_rotation_and_honors_server_hint(self):
        gate = retry_utils._GeminiGate()
        clock = [1000.0]
        starts = []
        error = RateLimitError("RESOURCE_EXHAUSTED")
        error.response = SimpleNamespace(headers={"Retry-After": "90"})

        def factory(key, **kwargs):
            def request():
                starts.append((key, clock[0]))
                if len(starts) == 1:
                    raise error
                return "ok"
            return request

        def wait(timeout):
            clock[0] += timeout

        with patch.object(retry_utils, "_gemini_gate", gate), \
                patch.object(retry_utils, "configured_gemini_keys", return_value=["key-a", "key-b"]), \
                patch.object(retry_utils, "_key_index", 0), \
                patch.object(retry_utils.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(retry_utils.random, "uniform", return_value=0), \
                patch.object(gate.condition, "wait", side_effect=wait):
            with self.assertRaises(RateLimitError):
                retry_utils.gemini_call_rotating(factory, _max_attempts=1)
            self.assertFalse(gate.busy)
            self.assertEqual(retry_utils.gemini_call_rotating(factory, _max_attempts=1), "ok")
        self.assertEqual([key for key, _ in starts], ["key-a", "key-b"])
        self.assertGreaterEqual(starts[1][1] - starts[0][1], 90)

    def test_waiting_job_can_cancel_without_releasing_another_jobs_slot(self):
        gate = retry_utils._GeminiGate()
        gate.busy = True
        cancelled = [False]
        with patch.object(gate.condition, "wait", side_effect=lambda **kw: cancelled.__setitem__(0, True)):
            with self.assertRaises(JobCancelled):
                with gate.slot(cancelled_cb=lambda: cancelled[0]):
                    self.fail("Cancelled job acquired a slot")
        self.assertTrue(gate.busy)

    def test_structured_retry_delay_is_recognized(self):
        error = RateLimitError("{'details': [{'retryDelay': '123.5s'}]}")
        self.assertEqual(retry_utils._retry_after_seconds(error), 123.5)

    def test_repeated_429_increases_shared_cooldown(self):
        gate = retry_utils._GeminiGate()
        with patch.object(retry_utils.time, "monotonic", return_value=1000), \
                patch.object(retry_utils.random, "uniform", return_value=0), \
                patch.object(settings, "gemini_rate_limit_cooldown", 30):
            for expected in (30, 60, 120):
                gate.next_at = 0
                with self.assertRaises(RateLimitError):
                    with gate.slot():
                        raise RateLimitError("RESOURCE_EXHAUSTED")
                self.assertEqual(gate.next_at, 1000 + expected)


class GeminiArrayTests(unittest.TestCase):
    def test_translation_transport_error_does_not_fall_back_to_source_or_retry_outer_loop(self):
        with patch.object(gemini_array, "gemini_call_rotating", side_effect=RateLimitError("quota")) as call:
            with self.assertRaises(RuntimeError):
                gemini_array.gemini_map_texts(["原文"], "translate", "translator", require_complete=True)
        self.assertEqual(call.call_count, 1)

    def test_partial_reply_cannot_be_saved_as_complete_translation(self):
        with patch.object(gemini_array, "gemini_call_rotating", return_value=SimpleNamespace(text="0|Hello")):
            with self.assertRaisesRegex(RuntimeError, "thiếu 1/2"):
                gemini_array.gemini_map_texts(["你好", "再见"], "translate", "translator", require_complete=True)

    def test_cancellation_is_not_swallowed(self):
        with patch.object(gemini_array, "gemini_call_rotating", side_effect=JobCancelled()):
            with self.assertRaises(JobCancelled):
                gemini_array.gemini_map_texts(["原文"], "translate", "translator")


class GeminiModelRotationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.models = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]
        self.stack.enter_context(patch.object(settings, "gemini_model", self.models[0]))
        self.stack.enter_context(patch.object(settings, "gemini_models", self.models))
        self.stack.enter_context(patch.object(retry_utils, "_key_model_index", 0))
        self.stack.enter_context(patch.object(retry_utils, "configured_gemini_keys", return_value=["key-a", "key-b"]))
        self.stack.enter_context(patch.object(retry_utils.random, "uniform", return_value=0))
        # Gate/cooldown is tested above; model tests need no real sleeping.
        self.stack.enter_context(patch.object(retry_utils, "_gemini_gate", SimpleNamespace(slot=lambda *a: nullcontext())))

    def test_successful_requests_visit_every_key_model_pair(self):
        calls = []

        def factory(key, timeout=None):
            def request(**kwargs):
                calls.append((key, kwargs["model"]))
                return "ok"
            return request

        for _ in range(5):
            self.assertEqual(retry_utils.gemini_call_rotating(factory, model=self.models[0]), "ok")
        self.assertEqual(calls, [
            ("key-a", self.models[0]), ("key-a", self.models[1]),
            ("key-b", self.models[0]), ("key-b", self.models[1]),
            ("key-a", self.models[0]),
        ])

    def test_retry_uses_next_model_after_429(self):
        calls = []

        def factory(key, timeout=None):
            def request(**kwargs):
                calls.append(kwargs["model"])
                if len(calls) == 1:
                    raise RateLimitError("RESOURCE_EXHAUSTED")
                return "translated"
            return request

        self.assertEqual(retry_utils.gemini_call_rotating(factory, model=self.models[0]), "translated")
        self.assertEqual(calls, self.models)

    def test_unavailable_model_falls_back_but_authentication_errors_do_not(self):
        class Unavailable(Exception):
            code = 404

        def factory(key, timeout=None):
            def request(**kwargs):
                if kwargs["model"] == self.models[0]:
                    raise Unavailable("model not found")
                return "ok"
            return request

        self.assertEqual(retry_utils.gemini_call_rotating(factory, model=self.models[0]), "ok")
        denied = Exception("access denied")
        denied.code = 403
        fn = Mock(side_effect=denied)
        with self.assertRaisesRegex(Exception, "access denied"):
            retry_utils.gemini_call_rotating(lambda *a, **kw: fn, model=self.models[0])
        fn.assert_called_once()

    def test_chat_rotates_models_without_changing_uploaded_file_key(self):
        client = Mock()
        chat = client.chats.create.return_value
        chat.send_message.side_effect = [RateLimitError("quota"), SimpleNamespace(text="context")]
        response = retry_utils.gemini_chat_rotating(
            ["uploaded-file", "prompt"], client=client, api_key="upload-key", _max_attempts=2,
        )
        self.assertEqual(response.text, "context")
        self.assertEqual([c.kwargs["model"] for c in client.chats.create.call_args_list], self.models)
        retry_utils.configured_gemini_keys.assert_not_called()

    def test_model_list_is_deduplicated(self):
        with patch.object(settings, "gemini_models", [self.models[0], self.models[1], "", self.models[1]]):
            self.assertEqual(retry_utils.configured_gemini_models(), self.models)


class TranslationCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(settings, "temp_dir", root))
        self.stack.enter_context(patch.object(translation_service, "configured_gemini_keys", return_value=["test"]))
        self.stack.enter_context(patch.object(translation_service, "load_translation_context", return_value=""))
        self.stack.enter_context(patch.object(translation_service, "_build_base_prompt", return_value="translate"))
        self.stack.enter_context(patch.object(translation_service, "_build_patch_context_note", return_value=""))
        self.source = root / "srt" / "video" / "subtitles.srt"
        self.source.parent.mkdir(parents=True)
        entries = [SrtEntry(index=i + 1, start=i, end=i + 0.9,
                            startLabel=f"00:00:{i:02},000", endLabel=f"00:00:{i:02},900", text=f"原文{i}")
                   for i in range(51)]
        self.content = entries_to_srt(entries)
        self.source.write_text(self.content, encoding="utf-8")
        self.output = root / "translated" / "video" / "subtitles_vi.srt"
        self.checkpoint = self.output.with_name("translation_vi.checkpoint.json")

    def test_failed_batch_preserves_completed_work_and_resume_keeps_timeline(self):
        progress = Mock()
        with patch.object(translation_service, "gemini_map_texts", side_effect=[
            [f"Đã dịch {i}" for i in range(50)], RuntimeError("quota exhausted"),
        ]):
            with self.assertRaisesRegex(RuntimeError, "quota"):
                translation_service.translate_srt("video", progress_callback=progress)
        self.assertFalse(self.output.exists())
        self.assertEqual(len(json.loads(self.checkpoint.read_text())["texts"]), 50)
        progress.assert_called_once_with(1, 2)

        with patch.object(translation_service, "gemini_map_texts", return_value=["Dòng cuối"]) as call:
            content = translation_service.translate_srt("video")
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.args[0], ["原文50"])
        self.assertTrue(call.call_args.kwargs["require_complete"])
        self.assertFalse(self.checkpoint.exists())
        self.assertEqual(len(parse_srt(content)), 51)
        self.assertEqual(self.source.read_text(), self.content)
        self.assertEqual([(e.start, e.end) for e in parse_srt(content)],
                         [(e.start, e.end) for e in parse_srt(self.content)])

    def test_checkpoint_is_not_reused_after_source_changes(self):
        with patch.object(translation_service, "gemini_map_texts", side_effect=[
            ["translated"] * 50, RuntimeError("quota"),
        ]):
            with self.assertRaises(RuntimeError):
                translation_service.translate_srt("video")
        self.source.write_text(self.content.replace("原文0", "Changed source"), encoding="utf-8")
        with patch.object(translation_service, "gemini_map_texts", side_effect=RuntimeError("quota")) as call:
            with self.assertRaises(RuntimeError):
                translation_service.translate_srt("video")
        self.assertEqual(len(call.call_args.args[0]), 50)
        self.assertEqual(call.call_args.args[0][0], "Changed source")

    def test_failed_retranslation_keeps_existing_complete_file(self):
        self.output.parent.mkdir(parents=True)
        self.output.write_text("existing completed translation", encoding="utf-8")
        with patch.object(translation_service, "gemini_map_texts", side_effect=RuntimeError("quota")):
            with self.assertRaises(RuntimeError):
                translation_service.translate_srt("video")
        self.assertEqual(self.output.read_text(), "existing completed translation")


if __name__ == "__main__":
    unittest.main()
