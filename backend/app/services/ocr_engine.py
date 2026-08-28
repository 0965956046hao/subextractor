import logging
import threading
import time

import numpy as np

from app.config import settings
from app.services.video_processor import crops_visually_similar

logger = logging.getLogger(__name__)

SUPPORTED_LANGS = {"ch", "en", "latin"}


class BaseOCREngine:
    """Shared dHash-cache + stats logic for all OCR engines.

    Subclasses must implement :meth:`ocr_image` and may override
    :meth:`set_lang`. The worker calls :meth:`set_lang` per job and
    :meth:`log_stats` after each run.
    """

    name: str = "base"

    def __init__(self):
        self._lock = threading.Lock()
        self._prev_crop: np.ndarray | None = None
        self._prev_text: str = ""
        self._total_calls = 0
        self._cache_hits = 0
        self._hit_streak = 0

    def lock(self):
        """Lock tuần tự hoá các lần OCR trên engine này.

        Engine chia sẻ dHash cache + state ngôn ngữ nên KHÔNG thread-safe.
        Worker giữ lock này suốt `set_lang` + vòng lặp OCR để 2 job song song
        (job_workers > 1) không làm hỏng cache/language của nhau.
        """
        return self._lock

    def set_lang(self, lang: str) -> None:
        self.reset_cache()

    def ocr_image(self, image: np.ndarray) -> str:
        raise NotImplementedError

    def ocr_region_cached(self, crop: np.ndarray) -> str:
        if crop.size == 0:
            return ""
        if (
            self._prev_crop is not None
            and self._hit_streak < settings.ocr_cache_max_streak
            and crops_visually_similar(self._prev_crop, crop)
        ):
            self._cache_hits += 1
            self._hit_streak += 1
            return self._prev_text
        self._total_calls += 1
        self._hit_streak = 0
        text = self.ocr_image(crop)
        self._prev_crop = crop
        self._prev_text = text
        return text

    def reset_cache(self):
        if self._total_calls > 0 or self._cache_hits > 0:
            logger.info(
                "  OCR cache: %d calls, %d hits (%.1f%%)",
                self._total_calls, self._cache_hits,
                100 * self._cache_hits / (self._total_calls + self._cache_hits) if (self._total_calls + self._cache_hits) else 0,
            )
        self._prev_crop = None
        self._prev_text = ""
        self._total_calls = 0
        self._cache_hits = 0
        self._hit_streak = 0

    def log_stats(self):
        total = self._total_calls + self._cache_hits
        if total:
            logger.info(
                "  OCR stats: %d total, %d cache hits (%.1f%%), %d actual calls",
                total, self._cache_hits,
                100 * self._cache_hits / total if total else 0,
                self._total_calls,
            )
