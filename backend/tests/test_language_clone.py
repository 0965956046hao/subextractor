"""Language variants must survive deletion of every original source asset.

Run: .venv/bin/python -m unittest discover -s tests -v
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.routers.video import router
from app.services.media_utils import _merge_audio_path, _video_path


class LanguageCloneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.temp_patch = patch.object(settings, "temp_dir", self.root)
        self.temp_patch.start()
        self.addCleanup(self.temp_patch.stop)
        app = FastAPI()
        app.include_router(router)
        app.state.jobs = {}
        app.state.pipeline_states = {}
        self.app = app
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.video = self.root / "videos" / "original"
        self.video.mkdir(parents=True)
        merged = self.root / "merged"
        merged.mkdir()
        self.source = merged / "merge123_video.mp4"
        self.source.write_bytes(b"original video data")
        (merged / "merge123_audio.mp4").write_bytes(b"original audio data")
        (self.video / "video.mp4").symlink_to(self.source)
        (self.video / "meta.json").write_text(json.dumps({
            "filename": "Source.mp4", "source_merge_id": "merge123",
            "region": {"x1": 0, "y1": 0.8, "x2": 1, "y2": 1},
        }))
        srt = self.root / "srt" / "original"
        srt.mkdir(parents=True)
        self.ocr = "1\n00:00:00,000 --> 00:00:02,000\n原始字幕\n"
        (srt / "subtitles.srt").write_text(self.ocr, encoding="utf-8")
        translated = self.root / "translated" / "original"
        translated.mkdir(parents=True)
        (translated / "subtitles_vi.srt").write_text("Old translation")

    def clone(self, source="original", target="en"):
        return self.client.post(f"/api/video/{source}/clone-language", json={
            "target_lang": target, "source_lang": "zh",
        })

    def test_clone_survives_original_deletion_and_can_be_cloned_again(self):
        response = self.clone()
        self.assertEqual(response.status_code, 200, response.text)
        clone_id = response.json()["video_id"]
        copied = self.root / "videos" / clone_id
        self.assertFalse((copied / "video.mp4").is_symlink())
        self.assertNotEqual((copied / "video.mp4").stat().st_ino, self.source.stat().st_ino)
        self.assertFalse((self.root / "translated" / clone_id).exists())
        meta = json.loads((copied / "meta.json").read_text())
        self.assertNotIn("source_merge_id", meta)
        self.assertEqual(meta["cloned_from"], "original")
        self.assertEqual(self.client.delete("/api/video/original").status_code, 200)
        self.assertFalse(self.source.exists())
        self.assertEqual(_video_path(clone_id).read_bytes(), b"original video data")
        self.assertEqual(_merge_audio_path(clone_id).read_bytes(), b"original audio data")
        self.assertEqual((self.root / "srt" / clone_id / "subtitles.srt").read_text(), self.ocr)
        another = self.clone(clone_id, "vi")
        self.assertEqual(another.status_code, 200, another.text)
        another_id = another.json()["video_id"]
        self.client.delete(f"/api/video/{clone_id}")
        self.assertEqual(_merge_audio_path(another_id).read_bytes(), b"original audio data")

    def test_cleanup_keeps_inputs_for_future_variants(self):
        clone_id = self.clone().json()["video_id"]
        response = self.client.post(f"/api/video/{clone_id}/cleanup")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(_video_path(clone_id).is_file())
        self.assertTrue(_merge_audio_path(clone_id).is_file())
        self.assertEqual(self.clone(clone_id).status_code, 200)

    def test_rejects_active_or_missing_ocr(self):
        self.app.state.jobs["job"] = {"video_id": "original", "status": "processing"}
        self.assertEqual(self.clone().status_code, 409)
        self.app.state.jobs.clear()
        (self.root / "srt" / "original" / "subtitles.srt").unlink()
        self.assertEqual(self.clone().status_code, 409)

    def test_missing_source_does_not_use_burned_deliverable(self):
        self.source.unlink()
        final = self.root / "hardcoded" / "original"
        final.mkdir(parents=True)
        (final / "hardcoded.mp4").write_bytes(b"burned subtitles and dubbed audio")
        self.assertEqual(self.clone().status_code, 409)

    def test_failed_copy_rolls_back_new_directories(self):
        with patch("app.routers.video.shutil.copy2", side_effect=OSError("Disk full")):
            self.assertEqual(self.clone().status_code, 500)
        self.assertEqual([p.name for p in (self.root / "videos").iterdir()], ["original"])
        self.assertEqual([p.name for p in (self.root / "srt").iterdir()], ["original"])

    def test_rejects_unsupported_language_and_unsafe_id(self):
        self.assertEqual(self.clone(target="unsupported").status_code, 422)
        self.assertEqual(self.clone(source="bad..id").status_code, 400)


if __name__ == "__main__":
    unittest.main()
