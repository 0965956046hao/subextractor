import unittest

from app.routers.tools import SSE_HEADERS


class SseStreamTests(unittest.TestCase):
    def test_progress_stream_is_not_buffered_by_compression(self):
        self.assertIn("no-transform", SSE_HEADERS["Cache-Control"])
        self.assertEqual(SSE_HEADERS["X-Accel-Buffering"], "no")


if __name__ == "__main__":
    unittest.main()
