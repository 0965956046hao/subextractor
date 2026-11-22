import asyncio
import shutil
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.config import settings
from app.models import TimelineAction, UpdateSrtRequest
from app.routers import tools
from app.services import context_service, media_utils, translation_service as tr
from app.services.hardcode_service import (
    _scale_srt_speed, bilingual_ass, english_subtitle_style,
)
from app.services.srt_utils import parse_srt


SOURCE = "1\n00:00:02,000 --> 00:00:04,000\n原始字幕\n\n"


class BilingualSubtitleTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(settings, "temp_dir", self.root))
        self.source = self.root / "srt/video/subtitles.srt"
        self.source.parent.mkdir(parents=True)
        self.source.write_text(SOURCE, encoding="utf-8")

    def test_language_lookup_never_substitutes_english_for_vietnamese(self):
        en = self.root / "translated/video/subtitles_en.srt"
        en.parent.mkdir(parents=True)
        en.write_text(SOURCE.replace("原始字幕", "English"), encoding="utf-8")
        self.assertIsNone(media_utils._srt_translated_path("video", "vi"))
        self.assertEqual(media_utils._srt_best_path("video"), self.source)
        self.assertEqual(media_utils._srt_best_path("video", "en"), en)
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(tools.download_translated("video", "vi"))
        self.assertEqual(caught.exception.status_code, 404)

    def test_context_is_separate_per_language(self):
        context_service.append_translation_context("video", "Vietnamese context")
        context_service.append_translation_context("video", "English context", "en")
        self.assertEqual(context_service.load_translation_context("video"), "Vietnamese context")
        self.assertEqual(context_service.load_translation_context("video", "en"), "English context")

    def test_preview_composites_numpy_layers_for_png_and_jpeg(self):
        import cv2
        import numpy as np

        cap = MagicMock()
        cap.isOpened.return_value = True
        cap.read.side_effect = lambda: (True, np.zeros((360, 640, 3), dtype=np.uint8))
        style = {"font_size": 72, "margin_v": 80, "box_enabled": True,
                 "box_color": "#FFFFFF", "text_color": "#000000",
                 "english_style": {"font_size": 60, "margin_v": 350}}
        with patch.object(cv2, "VideoCapture", return_value=cap):
            for overlay_only in (True, False):
                for bilingual in (True, False):
                    with self.subTest(overlay_only=overlay_only, bilingual=bilingual):
                        response = tools._render_preview_image(
                            Path("video.mp4"), 0, None, style, "Vietnamese", overlay_only, bilingual,
                        )
                        image = cv2.imdecode(np.frombuffer(response.body, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
                        self.assertIsNotNone(image)
                        self.assertEqual(image.shape, (360, 640, 4 if overlay_only else 3))
                        self.assertEqual(response.media_type, "image/png" if overlay_only else "image/jpeg")
                        self.assertGreater(int(image[300:340].max()), 100, "Vietnamese must remain visible")
                        if bilingual:
                            self.assertGreater(int(image[210:245].max()), 100, "English must be visible")
                        else:
                            self.assertEqual(int(image[210:245].max()), 0, "Single-language preview must not add English")

    def test_retranslation_updates_only_the_requested_language(self):
        tracks = self.root / "translated/video"
        tracks.mkdir(parents=True)
        vi = tracks / "subtitles_vi.srt"
        en = tracks / "subtitles_en.srt"
        vi.write_text(SOURCE.replace("原始字幕", "Bản Việt"), encoding="utf-8")
        en.write_text(SOURCE, encoding="utf-8")
        updated = SOURCE.replace("原始字幕", "English fixed")

        @asynccontextmanager
        async def guard(*args):
            yield

        request = SimpleNamespace(json=AsyncMock(return_value={
            "content": SOURCE, "source_lang": "zh", "target_lang": "en",
        }))
        with patch.object(tools, "get_scheduler", return_value=SimpleNamespace(guard=guard)), patch.object(
            tr, "retranslate_untranslated", return_value=updated,
        ):
            asyncio.run(tools.retranslate_srt("video", request))
        self.assertEqual(en.read_text(encoding="utf-8"), updated)
        self.assertIn("Bản Việt", vi.read_text(encoding="utf-8"))
        self.assertEqual(self.source.read_text(encoding="utf-8"), SOURCE)

    def test_translation_reads_original_and_keeps_both_outputs_and_checkpoints(self):
        self.enterContext(patch.object(tr, "configured_gemini_keys", return_value=["fake"]))
        self.enterContext(patch.object(tr, "_build_base_prompt", return_value="prompt"))
        self.enterContext(patch.object(tr, "_build_patch_context_note", return_value="context"))
        with patch.object(tr, "gemini_map_texts", side_effect=[["Bản Việt"], ["English subtitle"]]) as call:
            vi = tr.translate_srt("video", target_lang="vi")
            en = tr.translate_srt("video", target_lang="en")
        self.assertEqual([c.args[0] for c in call.call_args_list], [["原始字幕"], ["原始字幕"]])
        self.assertEqual(self.source.read_text(encoding="utf-8"), SOURCE)
        self.assertEqual((self.root / "translated/video/subtitles_vi.srt").read_text(encoding="utf-8"), vi)
        self.assertEqual((self.root / "translated/video/subtitles_en.srt").read_text(encoding="utf-8"), en)
        self.assertEqual(len(list((self.root / "translated/video/checkpoints").iterdir())), 2)
        with patch.object(tr, "gemini_map_texts", side_effect=AssertionError("must resume cached batches")):
            self.assertEqual(tr.translate_srt("video", target_lang="en"), en)
            self.assertEqual(tr.translate_srt("video", target_lang="vi"), vi)

    def test_reviewed_vietnamese_is_english_source_and_invalidates_old_cache(self):
        tracks = self.root / "translated/video"
        tracks.mkdir(parents=True)
        vi_path = tracks / "subtitles_vi.srt"
        # The original has two cues; the reviewed Vietnamese retains only the second.
        original = SOURCE + "2\n00:00:06,000 --> 00:00:08,000\n第二句\n\n"
        self.source.write_text(original, encoding="utf-8")
        reviewed = "1\n00:00:06,000 --> 00:00:08,000\nCâu Việt đã sửa\n\n"
        vi_path.write_text(reviewed, encoding="utf-8")
        self.enterContext(patch.object(tr, "configured_gemini_keys", return_value=["fake"]))
        self.enterContext(patch.object(tr, "_build_base_prompt", return_value="prompt"))
        self.enterContext(patch.object(tr, "_build_patch_context_note", return_value="context"))
        with patch.object(tr, "gemini_map_texts", return_value=["Reviewed English"]) as call:
            en = tr.translate_srt("video", source_lang="vi", target_lang="en", source_track="vi")
        self.assertEqual(call.call_args.args[0], ["Câu Việt đã sửa"])
        self.assertEqual([(e.start, e.end) for e in parse_srt(en)], [(6, 8)])
        self.assertEqual(self.source.read_text(encoding="utf-8"), original)
        self.assertTrue(tr.translation_cache_matches("video", "en", "vi", "vi"))
        self.assertFalse(tr.translation_cache_matches("video", "en", "original", "zh"))
        vi_path.write_text(reviewed.replace("Câu Việt đã sửa", "Nội dung mới"), encoding="utf-8")
        self.assertFalse(tr.translation_cache_matches("video", "en", "vi", "vi"))
        with patch.object(tr, "gemini_map_texts", return_value=["New English"]) as call:
            tr.translate_srt("video", source_lang="vi", target_lang="en", source_track="vi")
        self.assertEqual(call.call_args.args[0], ["Nội dung mới"])

    def test_english_edit_and_compare_do_not_touch_vietnamese_or_original(self):
        tracks = self.root / "translated/video"
        tracks.mkdir(parents=True)
        vi_path = tracks / "subtitles_vi.srt"
        en_path = tracks / "subtitles_en.srt"
        vi = SOURCE.replace("原始字幕", "Bản Việt")
        vi_path.write_text(vi, encoding="utf-8")
        en_path.write_text(SOURCE, encoding="utf-8")
        updated = SOURCE.replace("原始字幕", "Edited English")
        asyncio.run(tools.update_srt("video", UpdateSrtRequest(content=updated), "en"))
        self.assertEqual(en_path.read_text(encoding="utf-8"), updated)
        self.assertEqual(vi_path.read_text(encoding="utf-8"), vi)
        self.assertEqual(self.source.read_text(encoding="utf-8"), SOURCE)
        request = SimpleNamespace(json=AsyncMock(return_value={"content": vi, "source_track": "vi"}))
        result = asyncio.run(tools.compare_srt("video", request))
        self.assertEqual(result["untranslated"][0]["text"], "Bản Việt")

    def test_english_from_reviewed_vietnamese_resumes_only_missing_batches(self):
        tracks = self.root / "translated/video"
        tracks.mkdir(parents=True)
        reviewed = "\n".join(f"{i + 1}\n00:00:02,000 --> 00:00:04,000\nCâu Việt {i}\n" for i in range(51))
        (tracks / "subtitles_vi.srt").write_text(reviewed, encoding="utf-8")
        self.enterContext(patch.object(tr, "configured_gemini_keys", return_value=["fake"]))
        self.enterContext(patch.object(tr, "_build_base_prompt", return_value="prompt"))
        self.enterContext(patch.object(tr, "_build_patch_context_note", return_value="context"))
        with patch.object(tr, "gemini_map_texts", side_effect=[[f"English {i}" for i in range(50)], RuntimeError("network")]):
            with self.assertRaises(RuntimeError):
                tr.translate_srt("video", source_lang="vi", target_lang="en", source_track="vi")
        self.assertFalse((tracks / "subtitles_en.srt").exists())
        with patch.object(tr, "gemini_map_texts", return_value=["Last English"]) as call:
            result = tr.translate_srt("video", source_lang="vi", target_lang="en", source_track="vi")
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.args[0], ["Câu Việt 50"])
        self.assertEqual(len(parse_srt(result)), 51)

    def test_reviews_wait_for_each_language_and_reject_previous_language_decision(self):
        states = {}
        asyncio.run(tools.update_timeline_check("video", TimelineAction(action="wait", lang="vi"), states))
        asyncio.run(tools.update_timeline_check("video", TimelineAction(action="continue", lang="vi"), states))
        asyncio.run(tools.update_timeline_check("video", TimelineAction(
            action="wait", lang="en", source_lang="vi", source_track="vi",
        ), states))
        review = states["video"]["timeline_check"]
        self.assertTrue(review["waiting"])
        self.assertIsNone(review["decision"])
        self.assertEqual(review["lang"], "en")
        self.assertEqual(review["source_track"], "vi")
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(tools.update_timeline_check("video", TimelineAction(action="continue", lang="vi"), states))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertTrue(review["waiting"])
        asyncio.run(tools.update_timeline_check("video", TimelineAction(action="continue", lang="en"), states))
        self.assertFalse(states["video"]["timeline_check"]["waiting"])

    def test_risk_check_uses_the_requested_language(self):
        from app.services import risk_check_service as risk

        tracks = self.root / "translated/video"
        tracks.mkdir(parents=True)
        (tracks / "subtitles_vi.srt").write_text(SOURCE.replace("原始字幕", "Bản Việt"), encoding="utf-8")
        (tracks / "subtitles_en.srt").write_text(SOURCE.replace("原始字幕", "English text"), encoding="utf-8")
        with patch.object(risk, "configured_gemini_keys", return_value=["fake"]), patch.object(
            risk, "gemini_call_rotating", return_value=SimpleNamespace(text="[]"),
        ) as call:
            risk.check_subtitle_risks("video", lang="en")
        self.assertIn("English text", call.call_args.kwargs["contents"])
        self.assertNotIn("Bản Việt", call.call_args.kwargs["contents"])

    def test_source_language_track_is_copied_without_gemini(self):
        with patch.object(tr, "gemini_map_texts", side_effect=AssertionError("no translation required")):
            result = tr.translate_srt("video", source_lang="en", target_lang="en")
        self.assertEqual(result, SOURCE)
        self.assertEqual((self.root / "translated/video/subtitles_en.srt").read_text(encoding="utf-8"), SOURCE)

    def test_render_cache_changes_with_language_mode_and_english_style(self):
        from app import worker

        video = self.root / "videos/video/video.mp4"
        video.parent.mkdir(parents=True)
        video.write_bytes(b"source video")
        tracks = self.root / "translated/video"
        tracks.mkdir(parents=True)
        for lang in ("vi", "en"):
            (tracks / f"subtitles_{lang}.srt").write_text(SOURCE, encoding="utf-8")

        def encode(video_path, srt_path, out_path, *args):
            Path(out_path).write_bytes(b"encoded")

        self.enterContext(patch.object(worker, "_duration_covers", return_value=True))
        self.enterContext(patch.object(worker, "_get_duration", return_value=4))
        self.enterContext(patch.object(worker, "_tg_notify_video", new=AsyncMock(return_value=True)))
        self.enterContext(patch.object(worker, "timed_job_call", side_effect=lambda job, fn: fn()))
        with patch.object(worker, "run_hardcode_sync", side_effect=encode) as call:
            def run(bilingual, style=None):
                job = {"job_id": "test", "video_id": "video", "video_path": str(video),
                       "bilingual_subs": bilingual, "style": style}
                asyncio.run(worker.run_hardcode_job({"test": job}, {}, "test"))
                self.assertEqual(job["status"], "done", job.get("error"))

            run(False)
            run(False)
            self.assertEqual(call.call_count, 1)
            run(True)
            run(True)
            self.assertEqual(call.call_count, 2)
            run(True, {"english_style": {"font_size": 30}})
            self.assertEqual(call.call_count, 3)
            run(False)
            self.assertEqual(call.call_count, 4)

    def test_two_ass_layers_have_independent_positions_and_english_has_no_box(self):
        vi = SOURCE.replace("原始字幕", "Phụ đề Việt")
        en = SOURCE.replace("原始字幕", "English subtitle")
        style = {"font_size": 48, "margin_v": 40, "margin_h": 0,
                 "box_enabled": True, "box_color": "#FFFFFF"}
        en_override = {"font_size": 32, "margin_v": 180, "margin_h": 120, "box_enabled": True}
        en_style = english_subtitle_style(style, en_override)
        self.assertFalse(en_style["box_enabled"])
        self.assertEqual(en_style["font_size"], 32)
        result = bilingual_ass(_scale_srt_speed(vi, 2), _scale_srt_speed(en, 2),
                               1920, 1080, style, en_override)
        self.assertEqual(result.count("[Events]"), 1)
        self.assertIn("Style: EnglishSubStyle,", result)
        events = [line for line in result.splitlines() if line.startswith("Dialogue:")]
        english = [line for line in events if "English" in line]
        self.assertEqual(len(english), 1, "English emits text only, never a background")
        self.assertIn("Dialogue: 3,0:00:01.00,0:00:02.00,EnglishSubStyle", english[0])
        self.assertIn("\\fs32", english[0])
        self.assertTrue(any(",BoxStyle," in line for line in events))
        self.assertIn("Phụ đề Việt", result)
        self.assertEqual([(e.start, e.end) for e in parse_srt(vi)], [(2, 4)])

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is not installed")
    def test_ffmpeg_renders_both_layers_in_the_same_frame(self):
        import numpy as np

        content = SOURCE.replace("00:00:02,000", "00:00:00,000")
        style = {"font_size": 72, "margin_v": 80, "box_enabled": True,
                 "box_color": "#FFFFFF", "text_color": "#000000"}
        ass = bilingual_ass(content.replace("原始字幕", "Vietnamese"),
                            content.replace("原始字幕", "English"), 640, 360, style,
                            {"font_size": 60, "margin_v": 350})
        (self.root / "bilingual.ass").write_text(ass, encoding="utf-8")
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=640x360:d=1",
             "-vf", "subtitles=bilingual.ass", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
            cwd=self.root, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        frame = np.frombuffer(result.stdout, dtype=np.uint8).reshape(360, 640, 3)
        self.assertGreater(int(frame[210:245].max()), 100, "English text must be visible above Vietnamese")
        self.assertGreater(int(frame[300:340].max()), 100, "Vietnamese background/text must be visible")


if __name__ == "__main__":
    unittest.main()
