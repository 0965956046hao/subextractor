import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import cv2
from pydantic import ValidationError

from app.config import settings
from app.models import ProcessRequest
from app.services import frame_decoder as decoder
from app.services.job_utils import JobCancelled


class FrameDecoderTests(unittest.TestCase):
    def test_schema_has_two_decoders_and_migrates_legacy_value(self):
        body = {"video_id": "test", "region": {"x1": 0, "y1": 0, "x2": 1, "y2": 1}}
        self.assertEqual(ProcessRequest(**body).decoder, "nvdec")
        self.assertEqual(ProcessRequest(**body, decoder="opencv").decoder, "ffmpeg_cpu")
        self.assertEqual(ProcessRequest.model_json_schema()["properties"]["decoder"]["enum"],
                         ["nvdec", "ffmpeg_cpu"])
        for value in ("nvdec", "ffmpeg_cpu"):
            self.assertEqual(ProcessRequest(**body, decoder=value).decoder, value)
        with self.assertRaises(ValidationError):
            ProcessRequest(**body, decoder="bad")

    def test_nvdec_preflight_success_and_explicit_fallback(self):
        log = MagicMock()

        def frames(*args, **kwargs):
            yield object(), 0

        with patch.object(decoder, "stream_ffmpeg_frames", side_effect=frames):
            self.assertEqual(decoder.resolve_decoder("video", "nvdec", log), "nvdec")
        def fallback_frames(*args, **kwargs):
            if kwargs["decoder"] == "nvdec":
                raise RuntimeError("driver unavailable")
            yield object(), 0

        with patch.object(decoder, "stream_ffmpeg_frames", side_effect=fallback_frames):
            self.assertEqual(decoder.resolve_decoder("video", "nvdec", log), "ffmpeg_cpu")
        self.assertTrue(any("fallback" in c.args[0] and "driver unavailable" in c.args[0]
                            for c in log.call_args_list))

    def test_failed_cpu_preflight_reports_error_without_retired_fallback(self):
        with patch.object(decoder, "stream_ffmpeg_frames", side_effect=RuntimeError("bad video")):
            with self.assertRaisesRegex(RuntimeError, "CPU"):
                decoder.resolve_decoder("video", "nvdec", MagicMock())

    def test_legacy_job_value_is_only_a_migration_to_ffmpeg_cpu(self):
        def frames(*args, **kwargs):
            self.assertEqual(kwargs["decoder"], "ffmpeg_cpu")
            yield object(), 0

        with patch.object(decoder, "stream_ffmpeg_frames", side_effect=frames) as source:
            self.assertEqual(decoder.resolve_decoder("video", "opencv", MagicMock()), "ffmpeg_cpu")
            self.assertEqual(source.call_count, 1)

    def test_cancelled_preflight_never_becomes_fallback(self):
        with patch.object(decoder, "stream_ffmpeg_frames", side_effect=JobCancelled):
            with self.assertRaises(JobCancelled):
                decoder.resolve_decoder("video", "nvdec", MagicMock())

    def test_vfr_is_rejected_and_cpu_accepts_high_bit_depth_metadata(self):
        stream = {"r_frame_rate": "30/1", "avg_frame_rate": "29/1", "pix_fmt": "yuv420p"}
        result = MagicMock(stdout=json.dumps({"streams": [stream]}))
        with patch.object(decoder.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError):
                decoder.probe_source("video")
        stream.update(avg_frame_rate="30/1", pix_fmt="yuv420p10le")
        result.stdout = json.dumps({"streams": [stream]})
        with patch.object(decoder.subprocess, "run", return_value=result):
            self.assertEqual(decoder.probe_source("video")["pix_fmt"], "yuv420p10le")
        with patch.object(decoder, "probe_source", return_value=stream):
            with self.assertRaises(ValueError):
                next(decoder.stream_ffmpeg_frames("video", decoder="nvdec"))

    def test_global_frame_indices_and_forced_gpu_command(self):
        indices, start = decoder.selected_indices(11831, 30, 15, 118, 242)
        self.assertEqual((start, len(indices), indices[0], indices[-1]), (3540, 1860, 3540, 7258))
        cmd = decoder.decoder_command("video", "h264", "nvdec", 30, start, 2, len(indices))
        self.assertIn("h264_cuvid", cmd)
        self.assertIn("cuda", cmd)
        self.assertIn("hwdownload", cmd[cmd.index("-vf") + 1])
        with self.assertRaises(ValueError):
            decoder.decoder_command("video", "unknown", "nvdec", 30, 0, 2, 5)

    def test_closing_stream_kills_decoder_and_releases_pipe(self):
        cap = MagicMock()
        cap.get.side_effect = lambda key: {
            cv2.CAP_PROP_FPS: 30, cv2.CAP_PROP_FRAME_COUNT: 2,
            cv2.CAP_PROP_FRAME_WIDTH: 2, cv2.CAP_PROP_FRAME_HEIGHT: 2,
        }[key]
        proc = MagicMock()
        proc.stdout = io.BytesIO(b"a" * 12)
        proc.poll.return_value = None
        with patch.object(decoder, "probe_source", return_value={"codec_name": "h264"}), patch.object(
            decoder.cv2, "VideoCapture", return_value=cap,
        ), patch.object(decoder.subprocess, "Popen", return_value=proc):
            stream = decoder.stream_ffmpeg_frames("video", 15)
            image, timestamp = next(stream)
            self.assertEqual(image.shape, (2, 2, 3))
            self.assertEqual(timestamp, 0)
            stream.close()
        proc.kill.assert_called_once()
        self.assertTrue(proc.stdout.closed)
        cap.release.assert_called_once()

    def test_pause_interrupts_a_blocked_ffmpeg_pipe(self):
        cap = MagicMock()
        cap.get.side_effect = lambda key: {
            cv2.CAP_PROP_FPS: 30, cv2.CAP_PROP_FRAME_COUNT: 2,
            cv2.CAP_PROP_FRAME_WIDTH: 2, cv2.CAP_PROP_FRAME_HEIGHT: 2,
        }[key]
        killed = threading.Event()
        paused = threading.Event()

        class BlockedPipe:
            def read(self, size):
                paused.set()  # Pause arrives while waiting for decoder output.
                if not killed.wait(2):
                    raise RuntimeError("watchdog failed to interrupt pipe")
                return b""

            def close(self):
                pass

        proc = MagicMock()
        proc.stdout = BlockedPipe()
        proc.poll.side_effect = lambda: 1 if killed.is_set() else None
        proc.kill.side_effect = killed.set
        with patch.object(decoder, "probe_source", return_value={"codec_name": "h264"}), patch.object(
            decoder.cv2, "VideoCapture", return_value=cap,
        ), patch.object(decoder.subprocess, "Popen", return_value=proc):
            with self.assertRaises(JobCancelled):
                next(decoder.stream_ffmpeg_frames("video", 15, cancelled_cb=paused.is_set))
        self.assertTrue(killed.is_set())


class DecoderCheckpointTests(unittest.TestCase):
    def test_actual_decoder_isolates_checkpoints_and_fallback_reuses_cpu_only(self):
        from app import worker

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "video.mp4"
            path.write_bytes(b"identity-only; frame stream is mocked")
            cap = MagicMock()
            cap.get.side_effect = lambda key: 120 if key == cv2.CAP_PROP_FRAME_COUNT else 30
            engine = MagicMock()
            actual = ["ffmpeg_cpu"]
            with patch.object(settings, "temp_dir", root), patch.object(worker, "job_log"), patch.object(
                worker, "_notify_sync",
            ), patch.object(cv2, "VideoCapture", return_value=cap), patch.object(
                decoder, "resolve_decoder", side_effect=lambda *a, **kw: actual[0],
            ), patch.object(worker, "_ocr_segment_entries", return_value=([(0, 4, "你好世界")], None)) as segment:
                def run(requested):
                    job = {"video_id": "test", "ocr_type": "paddle", "decoder": requested}
                    result = worker.process_job_sync(str(path), {"x1": 0, "y1": 0, "x2": 1, "y2": 1},
                                                     15, [engine], {}, "job", None, job, "ch")
                    self.assertEqual(job["decoder"], actual[0])
                    return result

                reference = run("ffmpeg_cpu")
                self.assertEqual(segment.call_count, 1)
                self.assertEqual(run("ffmpeg_cpu"), reference)
                self.assertEqual(segment.call_count, 1)
                actual[0] = "nvdec"
                run("nvdec")
                self.assertEqual(segment.call_count, 2)
                self.assertEqual(segment.call_args.kwargs["decoder"], "nvdec")
                actual[0] = "ffmpeg_cpu"
                run("ffmpeg_cpu")
                self.assertEqual(segment.call_count, 2)
                actual[0] = "nvdec"
                run("nvdec")
                self.assertEqual(segment.call_count, 2)
                actual[0] = "ffmpeg_cpu"  # NVDEC preflight failed on a resumed job
                run("nvdec")
                self.assertEqual(segment.call_count, 2)
            identities = [json.loads(p.read_text(encoding="utf-8"))["identity"]
                          for p in (root / "srt/test/ocr_checkpoints").rglob("*.json")]
            self.assertEqual({item["decoder"] for item in identities}, {"nvdec", "ffmpeg_cpu"})

    def test_checkpoint_without_decoder_identity_is_not_reused(self):
        from app import worker
        from app.services.ocr_checkpoint import OCRCheckpoint

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "video.mp4"
            path.write_bytes(b"video")
            cap = MagicMock()
            cap.get.side_effect = lambda key: 120 if key == cv2.CAP_PROP_FRAME_COUNT else 30
            job = {"video_id": "test", "ocr_type": "paddle", "decoder": "ffmpeg_cpu"}
            with patch.object(settings, "temp_dir", root), patch.object(worker, "job_log"), patch.object(
                worker, "_notify_sync",
            ), patch.object(cv2, "VideoCapture", return_value=cap), patch.object(
                decoder, "resolve_decoder", return_value="ffmpeg_cpu",
            ), patch.object(worker, "_ocr_segment_entries", return_value=([(0, 4, "正确")], None)) as segment:
                args = (str(path), {"x1": 0, "y1": 0, "x2": 1, "y2": 1}, 15,
                        [MagicMock()], {}, "job", None, job, "ch")
                worker.process_job_sync(*args)
                saved = next((root / "srt/test/ocr_checkpoints").rglob("*.json"))
                data = json.loads(saved.read_text(encoding="utf-8"))
                identity = {k: v for k, v in data["identity"].items() if k not in ("decoder", "decoder_version")}
                legacy = OCRCheckpoint(root / "srt/test/ocr_checkpoints", identity)
                legacy.save(0, (0, 4), [(0, 4, "错误")])
                saved.unlink()  # Remove only this test's new CPU checkpoint.
                result = worker.process_job_sync(*args)
                self.assertEqual(segment.call_count, 2)
                self.assertIn("正确", result)
                self.assertNotIn("错误", result)


if __name__ == "__main__":
    unittest.main()
