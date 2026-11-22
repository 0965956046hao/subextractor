import io
import unittest

from scripts.ocr_decode_experiment import command, read_frame, selected_indices


class OCRDecodeExperimentTests(unittest.TestCase):
    def test_frame_selection_matches_opencv_global_frame_indices(self):
        indices, start = selected_indices(11831, 30, 15, 118, 242)
        self.assertEqual(start, 3540)
        self.assertEqual(len(indices), 1860)
        self.assertEqual(indices[0], 3540)
        self.assertEqual(indices[-1], 7258)
        odd, _ = selected_indices(100, 30, 15, 1 / 30, 0.2)
        self.assertEqual(list(odd), [2, 4])

    def test_full_video_and_tail_have_exact_frame_counts(self):
        full, _ = selected_indices(11831, 30, 15)
        self.assertEqual(len(full), 5916)
        tail, _ = selected_indices(11831, 30, 15, 358, 394.3666666666667)
        self.assertEqual(len(tail), 546)
        self.assertEqual(tail[-1], 11830)

    def test_gpu_forces_nvdec_and_cpu_control_uses_same_pixel_layout(self):
        gpu = command("video.mp4", "h264", "ffmpeg-gpu", 30, 3540, 2, 1860)
        cpu = command("video.mp4", "h264", "ffmpeg-cpu", 30, 3540, 2, 1860)
        self.assertIn("h264_cuvid", gpu)
        self.assertIn("cuda", gpu)
        self.assertNotIn("cuda", cpu)
        self.assertIn("hwdownload", gpu[gpu.index("-vf") + 1])
        self.assertTrue(cpu[cpu.index("-vf") + 1].endswith("format=nv12,format=bgr24"))
        self.assertEqual(gpu[gpu.index("-ss") + 1], "118.000000000")

    def test_unsupported_codec_never_falls_back_to_cpu_silently(self):
        with self.assertRaises(ValueError):
            command("video.mp4", "unknown", "ffmpeg-gpu", 30, 0, 2, 5)

    def test_raw_frame_reader_handles_short_reads_and_truncated_frames(self):
        class ShortReads(io.BytesIO):
            def read(self, size):
                return super().read(min(size, 2))

        self.assertEqual(read_frame(ShortReads(b"123456"), 6), b"123456")
        self.assertEqual(read_frame(ShortReads(b"123"), 6), b"123")


if __name__ == "__main__":
    unittest.main()
