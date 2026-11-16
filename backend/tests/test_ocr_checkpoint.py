import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from app.services.ocr_checkpoint import (
    OCRCheckpoint, merge_chunk_entries, run_checkpointed_ocr, video_identity,
)
from app.services.job_utils import JobCancelled


class OCRCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.identity = {"video": "test", "region": {"x1": 0.1}, "lang": "ch"}
        self.store = OCRCheckpoint(self.root, self.identity)
        self.progress = []
        self.logs = []

    def run_ocr(self, runner, **kwargs):
        options = dict(
            checkpoint=self.store, start=0.0, end=30.0, chunk_seconds=10.0,
            overlap=2.0, frame_interval=1.0, engines=[object()],
            run_segment=runner, cancelled=lambda: False,
            progress=self.progress.append, log=self.logs.append,
        )
        options.update(kwargs)
        return run_checkpointed_ocr(**options)

    @staticmethod
    def segment(engine, start, end, callback):
        for index in range(int(end - start)):
            callback(index, 0)
        return [(start, end, f"字幕{start}")], None

    def test_restart_reuses_all_completed_chunks(self):
        expected = self.run_ocr(self.segment)
        calls = []
        restarted = OCRCheckpoint(self.root, self.identity)
        actual = self.run_ocr(lambda *args: calls.append(args), checkpoint=restarted)
        self.assertEqual(calls, [])
        self.assertEqual(actual, expected)
        self.assertEqual(self.progress[-1], 100)
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_oom_keeps_completed_chunk_and_retries_only_missing(self):
        def fail(engine, start, end, callback):
            if start > 0:
                raise MemoryError("OOM")
            return self.segment(engine, start, end, callback)

        with self.assertRaises(MemoryError):
            self.run_ocr(fail)
        self.assertIsNotNone(self.store.load(0, (0.0, 10.0)))
        self.assertIsNone(self.store.load(1, (10.0, 20.0)))
        calls = []

        def retry(*args):
            calls.append(args[1:3])
            return self.segment(*args)

        self.run_ocr(retry)
        self.assertEqual(calls, [(8.0, 22.0), (18.0, 30.0)])

    def test_pause_preserves_previous_chunk_not_partial_chunk(self):
        paused = False

        def runner(engine, start, end, callback):
            nonlocal paused
            if start > 0:
                paused = True
                callback(0, 0)
            return self.segment(engine, start, end, callback)

        with self.assertRaises(JobCancelled):
            self.run_ocr(runner, cancelled=lambda: paused)
        self.assertIsNotNone(self.store.load(0, (0.0, 10.0)))
        self.assertIsNone(self.store.load(1, (10.0, 20.0)))
        self.run_ocr(self.segment)

    def test_empty_subtitle_chunk_is_completed(self):
        self.store.save(0, (0.0, 10.0), [])
        result = self.run_ocr(lambda *args: self.fail("Should not OCR silence again"), end=10.0)
        self.assertEqual(result, [])

    def test_settings_or_bounds_change_never_reuses_stale_data(self):
        self.store.save(0, (0.0, 10.0), [(0.0, 8.0, "你好")])
        self.assertIsNone(self.store.load(0, (0.0, 9.0)))
        for key, value in [("lang", "en"), ("region", {"x1": 0.2}), ("video", "changed")]:
            other = OCRCheckpoint(self.root, {**self.identity, key: value})
            self.assertIsNone(other.load(0, (0.0, 10.0)))

    def test_corrupt_or_invalid_checkpoint_is_recomputed(self):
        self.store.directory.mkdir(parents=True)
        path = self.store.directory / "000000.json"
        path.write_text('{"entries":', encoding="utf-8")
        self.assertIsNone(self.store.load(0, (0.0, 10.0)))
        self.store.save(0, (0.0, 10.0), [(0.0, 8.0, "你好")])
        data = json.loads(path.read_text(encoding="utf-8"))
        data["entries"][0][1] = 50
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertIsNone(self.store.load(0, (0.0, 10.0)))

    def test_failed_atomic_replace_keeps_previous_checkpoint(self):
        original = [(0.0, 8.0, "原文")]
        self.store.save(0, (0.0, 10.0), original)
        with patch("app.services.ocr_checkpoint.os.replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                self.store.save(0, (0.0, 10.0), [(0.0, 8.0, "changed")])
        self.assertEqual(self.store.load(0, (0.0, 10.0)), original)
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_overlap_is_clipped_and_same_caption_joins_at_seam(self):
        result = self.run_ocr(lambda engine, start, end, cb: ([(start, end, "你好世界")], None))
        self.assertEqual(result, [(0.0, 30.0, "你好世界")])

    def test_identical_captions_across_silence_are_not_joined(self):
        result = merge_chunk_entries([[(0, 2, "你好世界")], [(20, 22, "你好世界")]], 0.1)
        self.assertEqual(len(result), 2)

    def test_parallel_failure_preserves_original_error_and_allows_fewer_workers(self):
        first_saved = threading.Event()
        save = self.store.save

        def save_signal(index, bounds, entries):
            save(index, bounds, entries)
            first_saved.set()

        def runner(engine, start, end, callback):
            if start > 0:
                if not first_saved.wait(3):
                    raise RuntimeError("test timeout")
                raise MemoryError("original OOM")
            return self.segment(engine, start, end, callback)

        with patch.object(self.store, "save", side_effect=save_signal):
            with self.assertRaisesRegex(MemoryError, "original OOM"):
                self.run_ocr(runner, engines=[object(), object()])
        calls = []

        def retry(*args):
            calls.append(args[1])
            return self.segment(*args)

        self.run_ocr(retry, engines=[object()])
        self.assertNotIn(0.0, calls)
        self.assertEqual(len(calls), 2)

    def test_nonzero_start_and_short_final_chunk(self):
        result = self.run_ocr(self.segment, start=7.0, end=30.0)
        self.assertTrue(all(7 <= s < e <= 30 for s, e, _ in result))
        self.assertIsNotNone(self.store.load(2, (27.0, 30.0)))

    def test_video_replacement_changes_identity(self):
        path = self.root / "video.mp4"
        path.write_bytes(b"one")
        before = video_identity(str(path))
        path.write_bytes(b"longer replacement")
        self.assertNotEqual(before, video_identity(str(path)))


class OCRChunkBoundaryTests(unittest.TestCase):
    def test_frame_reader_stops_at_end_instead_of_decoding_rest_of_video(self):
        from app.services.video_processor import stream_frames_generator

        cap = MagicMock()
        cap.isOpened.return_value = True
        import cv2
        cap.get.side_effect = lambda prop: 10 if prop == cv2.CAP_PROP_FPS else 1000
        cap.read.return_value = (True, object())
        with patch("app.services.video_processor.cv2.VideoCapture", return_value=cap):
            frames = list(stream_frames_generator("test.mp4", 10, start_time=3, end_time=4))
        self.assertEqual(len(frames), 10)
        self.assertEqual(cap.read.call_count, 10)
        cap.release.assert_called_once()

    def test_stable_subtitle_at_chunk_tail_is_not_dropped(self):
        from app.services.subtitle_generator import generate_srt_entries

        engine = MagicMock()
        engine.ocr_region_cached.return_value = ("你好世界", None)
        entries, _ = generate_srt_entries([(object(), float(i)) for i in range(10)], engine)
        self.assertEqual(entries, [(0.0, 9.0, "你好世界")])

    def test_early_decode_error_is_not_treated_as_completed_chunk(self):
        from app.services.video_processor import stream_frames_generator

        cap = MagicMock()
        cap.isOpened.return_value = True
        import cv2
        cap.get.side_effect = lambda prop: 10 if prop == cv2.CAP_PROP_FPS else 1000
        cap.read.return_value = (False, None)
        with patch("app.services.video_processor.cv2.VideoCapture", return_value=cap):
            with self.assertRaisesRegex(RuntimeError, "Cannot decode"):
                list(stream_frames_generator("test.mp4", 10, end_time=4))
        cap.release.assert_called_once()


class OCRCheckpointIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def reset(self, *, completed=False, discard=False):
        from app.routers.video import reset_video_from_step
        from app.config import settings

        (self.root / "videos" / "test").mkdir(parents=True)
        output = self.root / "srt" / "test"
        checkpoint = output / "ocr_checkpoints" / "hash" / "000000.json"
        checkpoint.parent.mkdir(parents=True)
        checkpoint.write_text("{}", encoding="utf-8")
        if completed:
            (output / "subtitles.srt").write_text("complete", encoding="utf-8")
        (output / "other.txt").write_text("old", encoding="utf-8")
        with patch.object(settings, "temp_dir", self.root):
            asyncio.run(reset_video_from_step("test", {
                "from_step": 4, "discard_ocr_checkpoint": discard,
            }))
        self.assertFalse((output / "other.txt").exists())
        return checkpoint.exists()

    def test_retry_route_preserves_incomplete_ocr_checkpoints(self):
        self.assertTrue(self.reset())

    def test_rerun_completed_ocr_discards_checkpoints(self):
        self.assertFalse(self.reset(completed=True))

    def test_explicit_fresh_run_discards_incomplete_checkpoints(self):
        self.assertFalse(self.reset(discard=True))

    def test_worker_with_real_frame_stream_resumes_without_ocr_calls(self):
        import cv2
        import numpy as np
        from app import worker
        from app.config import settings

        path = self.root / "video.avi"
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 5, (64, 64))
        if not writer.isOpened():
            self.skipTest("MJPG VideoWriter unavailable")
        try:
            for _ in range(155):  # 31s, four checkpoint chunks including a short tail
                writer.write(np.zeros((64, 64, 3), dtype=np.uint8))
        finally:
            writer.release()
        engine = MagicMock()
        engine.lock.side_effect = lambda: threading.Lock()
        engine.ocr_region_cached.return_value = ("你好世界", None)
        kwargs = dict(
            video_path=str(path), region={"x1": 0, "y1": 0, "x2": 1, "y2": 1},
            target_fps=5, engine_pool=[engine], ws_clients={}, job_id="first",
            loop=None, job={"video_id": "test", "ocr_type": "fake"}, lang="ch",
        )
        with (patch.object(settings, "temp_dir", self.root),
              patch.object(settings, "ocr_checkpoint_seconds", 10.0),
              patch.object(worker, "job_log"), patch.object(worker, "_notify_sync")):
            original = worker.process_job_sync(**kwargs)
            self.assertIn("你好世界", original)
            self.assertEqual(len(list(self.root.rglob("*.json"))), 4)
            engine.ocr_region_cached.reset_mock()
            resumed = worker.process_job_sync(**{**kwargs, "job_id": "retry"})
            engine.ocr_region_cached.assert_not_called()
            self.assertEqual(resumed, original)


if __name__ == "__main__":
    unittest.main()
