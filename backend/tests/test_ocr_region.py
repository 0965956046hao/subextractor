"""OCR keeps the selected region without heatmap refinement."""

import unittest
from unittest.mock import MagicMock, patch

from app import worker
from app.config import Settings


class OCRRegionTests(unittest.TestCase):
    def test_heatmap_setting_removed(self):
        self.assertNotIn("roi_heatmap_enable", Settings.model_fields)

    def test_sequential_and_short_video_keep_selected_region(self):
        import cv2

        region = {"x1": 0.1, "y1": 0.7, "x2": 0.9, "y2": 0.95}
        for pool_size in (1, 2):
            with self.subTest(pool_size=pool_size):
                cap = MagicMock()
                cap.get.side_effect = lambda prop: 60 if prop == cv2.CAP_PROP_FRAME_COUNT else 30
                job = {}
                with (
                    patch("cv2.VideoCapture", return_value=cap),
                    patch.object(worker, "_ocr_segment_entries", return_value=([(0.5, 1.0, "字幕")], None)) as ocr,
                    patch.object(worker, "job_log"),
                    patch.object(worker, "_notify_sync"),
                ):
                    result = worker.process_job_sync(
                        "video.mp4", region, 15, [object() for _ in range(pool_size)],
                        {}, "test", None, job, "ch",
                    )
                ocr.assert_called_once()
                self.assertEqual(ocr.call_args.args[1], region)
                self.assertFalse(ocr.call_args.kwargs.get("collect_boxes", False))
                self.assertNotIn("refined_region", job)
                self.assertIn("字幕", result)
                self.assertEqual(job["progress"], 100)
                cap.release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
