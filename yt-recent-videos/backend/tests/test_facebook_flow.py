"""Focused offline checks: real FFmpeg cut, mocked Meta upload, config persistence."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.models import FacebookFlowIn
from app.routers import config_router, facebook
from app.services import facebook_flow, store
from app.services.facebook_client import FacebookClient, build_caption
from app.services.quiet_cut import cut_video, find_cut, probe_video, quiet_intervals


class QuietCutTests(unittest.TestCase):
    def test_parse_silence_including_trailing_interval(self):
        self.assertEqual(quiet_intervals(
            "silence_start: -0.01\nsilence_end: 0.7\nsilence_start: 2.5", 3,
        ), [(0, 0.7), (2.5, 3)])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
    def test_real_audio_silence_cut_and_no_silence(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / "source.mp4", Path(temp) / "cut.mp4"
            # A six-second tone, with a one-second silence at 2.5–3.5s.
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=6",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                "-af", "volume=0:enable='between(t,2.5,3.5)'",
                "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(source),
            ], check=True, capture_output=True, timeout=30)
            cut = find_cut(source, 3, 1, -35, 0.5)
            self.assertAlmostEqual(cut["seconds"], 3, delta=0.1)
            cut_video(source, output, cut["seconds"])
            self.assertAlmostEqual(probe_video(output)["duration"], cut["seconds"], delta=0.1)
            with self.assertRaisesRegex(RuntimeError, "Không tìm được khoảng lặng"):
                find_cut(source, 1, 0.4, -35, 0.3)
            self.assertAlmostEqual(find_cut(source, 30, 1, -35, 0.5)["seconds"], 6, delta=0.1)


class FacebookClientTests(unittest.TestCase):
    def test_hashtags_preserve_description_and_deduplicate(self):
        self.assertEqual(
            build_caption("Tiêu đề video\n\nMô tả gốc #TiếngViệt", ["Tiếng Việt", "học tập", "học-tập", "!!!"],
                          title="Tiêu đề video", video_id="dQw4w9WgXcQ"),
            "Tiêu đề video\n\nXem full tại : https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n"
            "Mô tả gốc #TiếngViệt\n\n#họctập",
        )

    def test_resumable_upload_is_unpublished_and_streams_chunks(self):
        calls = []
        def handle(request):
            body = request.read()
            calls.append((request.url.path, body))
            if b"upload_phase=start" in body:
                return httpx.Response(200, json={"video_id": "123", "upload_session_id": "session", "start_offset": "0", "end_offset": "4"})
            if b"video_file_chunk" in body:
                chunk_number = sum(b"video_file_chunk" in item[1] for item in calls)
                return httpx.Response(200, json={"start_offset": str(chunk_number * 4), "end_offset": "8"})
            return httpx.Response(200, json={"success": True})
        with tempfile.TemporaryDirectory() as temp, FacebookClient({
            "facebook_page_id": "456", "facebook_page_token": "test-token",
        }) as client:
            client.http.close()
            client.http = httpx.Client(transport=httpx.MockTransport(handle))
            path = Path(temp) / "video.mp4"
            path.write_bytes(b"abcdefgh")
            updates = []
            video_id = client.upload(path, "Title", "Description #tag", lambda **fields: updates.append(fields))
            self.assertEqual(video_id, "123")
            self.assertEqual(len(calls), 4)
            self.assertIn(b"published=false", calls[-1][1])
            self.assertIn(b"abcd", calls[1][1])
            self.assertIn(b"efgh", calls[2][1])
            self.assertTrue(updates[-1]["upload_finished"])
            self.assertEqual(updates[0]["facebook_video_id"], "123")

    def test_page_token_mismatch_and_secret_redaction(self):
        with FacebookClient({"facebook_page_id": "456", "facebook_page_token": "sensitive"}) as client:
            client.http.close()
            client.http = httpx.Client(transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"id": "wrong-page"}),
            ))
            with self.assertRaisesRegex(RuntimeError, "đúng Page"):
                client.check_page()
            client.http.close()
            client.http = httpx.Client(transport=httpx.MockTransport(
                lambda _: httpx.Response(400, json={"error": {"code": 190, "message": "bad sensitive"}}),
            ))
            with self.assertRaisesRegex(RuntimeError, r"bad \[hidden\]"):
                client.check_page()


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        temp_path = Path(self.temp.name)
        self.settings_patch = patch.object(settings, "temp_dir", temp_path)
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.tasks_patch = patch.dict(facebook_flow._tasks, clear=True)
        self.tasks_patch.start()
        self.addCleanup(self.tasks_patch.stop)
        self.config_patch = patch.object(store, "CONFIG_PATH", temp_path / "config.json")
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)

    def test_partial_config_retains_other_settings_and_hides_token(self):
        store.save_config({"youtube_client_id": "client", "facebook_page_id": "456", "facebook_page_token": "secret"})
        app = FastAPI()
        app.include_router(config_router.router)
        client = TestClient(app)
        self.assertEqual(client.post("/config", json={"post_template": "New template"}).status_code, 200)
        config = store.load_config()
        self.assertEqual(config["facebook_page_token"], "secret")
        self.assertEqual(config["facebook_page_id"], "456")
        self.assertEqual(config["youtube_client_id"], "client")
        output = client.get("/config").json()
        self.assertTrue(output["has_facebook_token"])
        self.assertNotIn("facebook_page_token", output)

    def _task(self):
        task_id = "abcdef123456"
        path = settings.temp_dir / "facebook_flows" / task_id
        path.mkdir(parents=True)
        task = {"task_id": task_id, "status": "processing", "progress": 90, "created_at": 1,
                "video_id": "dQw4w9WgXcQ", "title": "Test", "page_id": "456", "api_version": "v25.0",
                "facebook_video_id": "123", "upload_finished": True, "clip_ready": False,
                "thumbnail_ready": False, "request": {}}
        facebook_flow._tasks[task_id] = task
        facebook_flow._save(task)
        return task_id

    def test_publish_orders_thumbnail_before_publish_and_confirms(self):
        task_id = self._task()
        calls = []
        class FakeFacebook:
            def wait_ready(self, _):
                return {"published": False, "status": {"video_status": "ready"}}
            def set_thumbnail(self, *_):
                calls.append("thumbnail")
            def publish(self, _):
                calls.append("publish")
            def video_status(self, _):
                calls.append("confirm")
                return {"published": True, "status": {"video_status": "ready"}, "permalink_url": "/video/123"}
        facebook_flow._complete_publish(task_id, FakeFacebook())
        self.assertEqual(calls, ["thumbnail", "publish", "confirm"])
        self.assertEqual(facebook_flow.get_task(task_id)["status"], "done")
        self.assertEqual(facebook_flow.get_task(task_id)["facebook_url"], "https://www.facebook.com/video/123")

    def test_restart_preserves_id_without_automatically_republishing(self):
        task_id = self._task()
        facebook_flow._tasks.clear()
        facebook_flow.restore_tasks()
        restored = facebook_flow.get_task(task_id)
        self.assertEqual(restored["status"], "error")
        self.assertEqual(restored["facebook_video_id"], "123")
        self.assertTrue(restored["can_resume"])
        self.assertNotIn("request", restored)

    def test_invalid_video_id_and_missing_config_fail_before_work(self):
        app = FastAPI()
        app.include_router(facebook.router)
        client = TestClient(app)
        self.assertEqual(client.post("/facebook/flows", json={"video_id": "../escape"}).status_code, 422)
        self.assertEqual(client.post("/facebook/flows", json={"video_id": "dQw4w9WgXcQ"}).status_code, 400)
        self.assertEqual(client.post("/facebook/flows/batch", json={"items": []}).status_code, 422)
        self.assertEqual(facebook_flow.list_tasks(), [])

    def test_batch_queue_positions_dedupe_and_list_split(self):
        store.save_config({"facebook_page_id": "456", "facebook_page_token": "secret"})
        bodies = [
            FacebookFlowIn(video_id="dQw4w9WgXcQ"),
            FacebookFlowIn(video_id="9bZkp7q19f0"),
            FacebookFlowIn(video_id="dQw4w9WgXcQ"),
        ]
        with patch.object(facebook_flow._pool, "submit", return_value=None):
            result = facebook_flow.create_tasks(bodies, page_id="456")
        self.assertEqual(result["count"], 2)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(sorted(t["queue_position"] for t in result["tasks"]), [1, 2])
        # Đánh dấu 1 task đã xong → endpoint tách hàng đợi / đã upload.
        done_id = result["tasks"][0]["task_id"]
        with facebook_flow._lock:
            facebook_flow._tasks[done_id]["status"] = "done"
        app = FastAPI()
        app.include_router(facebook.router)
        client = TestClient(app)
        payload = client.get("/facebook/flows").json()
        self.assertEqual(payload["active_count"], 1)
        self.assertEqual(payload["uploaded_count"], 1)
        self.assertEqual(len(payload["active"]), 1)
        self.assertEqual(len(payload["uploaded"]), 1)
        self.assertEqual(payload["uploaded"][0]["task_id"], done_id)


if __name__ == "__main__":
    unittest.main()
