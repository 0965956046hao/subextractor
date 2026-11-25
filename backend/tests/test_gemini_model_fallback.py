import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.config import settings
from app.services import retry_utils as retry
from app.services.job_utils import JobCancelled


PRIMARY = "gemini-3.5-flash-lite"
FALLBACK = "gemini-3.1-flash-lite"


class ApiError(Exception):
    def __init__(self, code, message, delay=None):
        super().__init__(message)
        self.code = code
        self.response_json = {"error": {"details": [{"retryDelay": f"{delay}s"}]}} if delay else {}


def quota(delay=16317):
    return ApiError(429, "RESOURCE_EXHAUSTED: Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier", delay)


class GeminiModelFallbackTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(retry, "configured_gemini_keys", return_value=["private-key-one"]))
        self.enterContext(patch.object(retry, "_key_index", 0))
        self.enterContext(patch.object(retry, "_quota_cooldowns", {}))
        self.sleep = self.enterContext(patch.object(retry.time, "sleep"))
        self.clock = self.enterContext(patch.object(retry.time, "monotonic", return_value=100.0))
        self.calls = []

    def factory(self, callback):
        def build(key, timeout=None):
            def call(**kwargs):
                self.calls.append((key, timeout, kwargs))
                return callback(key, kwargs)
            return call
        return build

    def test_daily_quota_switches_model_immediately_and_preserves_request(self):
        logs = []

        def request(key, kwargs):
            if kwargs["model"] == PRIMARY:
                raise quota()
            return SimpleNamespace(text="translated")

        result = retry.gemini_call_rotating(self.factory(request), model=PRIMARY, contents="payload",
                                            config={"temperature": 0.3}, _timeout=300,
                                            _log_fn=lambda message, **kw: logs.append(message))
        self.assertEqual(result.text, "translated")
        self.assertEqual([c[2]["model"] for c in self.calls], [PRIMARY, FALLBACK])
        self.assertEqual(self.calls[-1][2], {"model": FALLBACK, "contents": "payload", "config": {"temperature": 0.3}})
        self.assertEqual(self.calls[-1][1], 300)
        self.sleep.assert_not_called()
        self.assertAlmostEqual(retry._quota_cooldowns[(PRIMARY, "private-key-one")], 16417)
        self.assertTrue(any(PRIMARY in message and FALLBACK in message for message in logs))
        self.assertTrue(all("private-key-one" not in message for message in logs))

    def test_subsequent_batches_use_fallback_until_server_cooldown_expires(self):
        def request(key, kwargs):
            if kwargs["model"] == PRIMARY and self.clock.return_value == 100:
                raise quota(30)
            return kwargs["model"]

        factory = self.factory(request)
        self.assertEqual(retry.gemini_call_rotating(factory, model=PRIMARY), FALLBACK)
        self.assertEqual(retry.gemini_call_rotating(factory, model=PRIMARY), FALLBACK)
        self.assertEqual([c[2]["model"] for c in self.calls], [PRIMARY, FALLBACK, FALLBACK])
        self.clock.return_value = 131
        self.assertEqual(retry.gemini_call_rotating(factory, model=PRIMARY), PRIMARY)

    def test_another_available_key_can_keep_using_primary(self):
        def request(key, kwargs):
            if key == "private-key-one":
                raise quota()
            return kwargs["model"]

        with patch.object(retry, "configured_gemini_keys", return_value=["private-key-one", "other-project-key"]):
            result = retry.gemini_call_rotating(self.factory(request), model=PRIMARY)
        self.assertEqual(result, PRIMARY)
        self.assertEqual([c[0] for c in self.calls], ["private-key-one", "other-project-key"])

    def test_both_models_exhausted_are_bounded_and_not_hammered_again(self):
        def request(key, kwargs):
            raise quota()

        factory = self.factory(request)
        with self.assertRaises(ApiError):
            retry.gemini_call_rotating(factory, model=PRIMARY)
        self.assertEqual(len(self.calls), 2)
        with self.assertRaisesRegex(RuntimeError, "quota"):
            retry.gemini_call_rotating(factory, model=PRIMARY)
        self.assertEqual(len(self.calls), 2)
        self.sleep.assert_not_called()

    def test_all_available_keys_are_rotated_before_fallback(self):
        def request(key, kwargs):
            if kwargs["model"] == PRIMARY:
                raise quota()
            return "ok"

        with patch.object(retry, "configured_gemini_keys", return_value=["key-a", "key-b"]):
            self.assertEqual(retry.gemini_call_rotating(self.factory(request), model=PRIMARY), "ok")
        self.assertEqual([c[2]["model"] for c in self.calls], [PRIMARY, PRIMARY, FALLBACK])
        self.assertEqual({c[0] for c in self.calls[:2]}, {"key-a", "key-b"})

    def test_unavailable_fallback_model_surfaces_error_without_looping(self):
        def request(key, kwargs):
            if kwargs["model"] == PRIMARY:
                raise quota()
            raise ApiError(404, "Fallback model is not available in this project")

        with self.assertRaisesRegex(ApiError, "not available"):
            retry.gemini_call_rotating(self.factory(request), model=PRIMARY)
        self.assertEqual([c[2]["model"] for c in self.calls], [PRIMARY, FALLBACK])

    def test_overload_and_short_rate_limit_do_not_switch_models(self):
        for error in (ApiError(503, "Service overloaded"), ApiError(429, "Too many requests")):
            with self.subTest(error=error):
                self.calls.clear()

                def request(key, kwargs):
                    raise error

                with self.assertRaises(ApiError):
                    retry.gemini_call_rotating(self.factory(request), model=PRIMARY)
                self.assertEqual([c[2]["model"] for c in self.calls], [PRIMARY] * 5)
                self.assertEqual(retry._quota_cooldowns, {})

    def test_permission_and_invalid_model_errors_do_not_fallback(self):
        for code in (400, 401, 403, 404):
            self.calls.clear()

            def request(key, kwargs):
                raise ApiError(code, "Invalid configuration")

            with self.assertRaises(ApiError):
                retry.gemini_call_rotating(self.factory(request), model=PRIMARY)
            self.assertEqual(len(self.calls), 1)

    def test_pause_during_quota_error_never_calls_fallback(self):
        stopped = [False]

        def request(key, kwargs):
            stopped[0] = True
            raise quota()

        with self.assertRaises(JobCancelled):
            retry.gemini_call_rotating(self.factory(request), model=PRIMARY, _cancelled_cb=lambda: stopped[0])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(retry._quota_cooldowns, {})

    def test_other_configured_models_keep_existing_retry_behavior(self):
        def request(key, kwargs):
            raise quota()

        with self.assertRaises(ApiError):
            retry.gemini_call_rotating(self.factory(request), model="custom-model")
        self.assertEqual(len(self.calls), 5)
        self.assertEqual(retry._quota_cooldowns, {})

    def test_older_sdk_string_retry_info_is_supported(self):
        error = RuntimeError("429 RESOURCE_EXHAUSTED quota exceeded {'retryDelay': '16317s'}")
        self.assertTrue(retry._is_quota_exhausted(error))
        self.assertEqual(retry._quota_retry_seconds(error), 16317)
        self.assertEqual(retry._quota_retry_seconds(quota(delay=None)), 3600)

    def test_configured_model_is_not_mutated_by_fallback(self):
        def request(key, kwargs):
            if kwargs["model"] == PRIMARY:
                raise quota()
            return "ok"

        with patch.object(settings, "gemini_model", PRIMARY):
            retry.gemini_call_rotating(self.factory(request), model=settings.gemini_model)
            self.assertEqual(settings.gemini_model, PRIMARY)

    def test_fallback_can_run_even_on_last_primary_attempt(self):
        def request(key, kwargs):
            if kwargs["model"] == PRIMARY:
                raise quota()
            return "ok"

        self.assertEqual(retry.gemini_call_rotating(self.factory(request), model=PRIMARY, _max_attempts=1), "ok")
        self.assertEqual([c[2]["model"] for c in self.calls], [PRIMARY, FALLBACK])
