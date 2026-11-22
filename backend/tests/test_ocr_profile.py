import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("profile_ocr", Path(__file__).resolve().parents[1] / "scripts/profile_ocr.py")
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


class OCRProfileTests(unittest.TestCase):
    def test_frame_timer_excludes_time_spent_processing_yielded_frames(self):
        metrics = profile.Measurements()
        metrics.local.segment = {}
        clock = [0.0]

        def frames():
            for index in range(3):
                clock[0] += 2
                yield object(), index

        with patch.object(profile.time, "perf_counter", side_effect=lambda: clock[0]):
            for _ in metrics.frame_stream(frames)():
                clock[0] += 100  # model work must not be charged to decode
        self.assertEqual(metrics.local.segment["frame_stream_seconds"], 6)
        self.assertEqual(metrics.local.segment["sampled_frames"], 3)

    def test_segment_reports_even_when_ocr_fails(self):
        metrics = profile.Measurements()

        def fail(*args):
            metrics.add("model_calls", 1)
            raise RuntimeError("failure")

        with self.assertRaises(RuntimeError):
            metrics.segment(fail)("video", {}, 15, object(), "ch", 0, 120, None)
        self.assertEqual(len(metrics.segments), 1)
        self.assertEqual(metrics.segments[0]["model_calls"], 1)
        self.assertIsNone(metrics.local.segment)

    def test_model_and_cache_counts_survive_per_chunk_cache_resets(self):
        metrics = profile.Measurements()
        clock = [0.0]

        class Engine:
            _cache_hits = 0
            previous = False

            def set_lang(self, lang):
                self._cache_hits = 0
                self.previous = False

            def ocr_image(self, image):
                clock[0] += 3
                return "text"

            def ocr_region_cached(self, image):
                clock[0] += 1
                if self.previous:
                    self._cache_hits += 1
                    return "text"
                self.previous = True
                return self.ocr_image(image)

        engine = Engine()
        metrics.instrument_engine(engine)
        with patch.object(profile.time, "perf_counter", side_effect=lambda: clock[0]):
            for _ in range(2):
                metrics.local.segment = {}
                engine.set_lang("ch")
                engine.ocr_region_cached(object())
                engine.ocr_region_cached(object())
                self.assertEqual(metrics.local.segment["model_calls"], 1)
                self.assertEqual(metrics.local.segment["cache_hits"], 1)
                self.assertEqual(metrics.local.segment["model_seconds"], 3)
                self.assertEqual(metrics.local.segment["cache_and_model_seconds"], 5)


if __name__ == "__main__":
    unittest.main()
