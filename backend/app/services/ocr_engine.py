import logging
import time

import numpy as np
from rapidocr import RapidOCR

from app.config import settings
from app.services.video_processor import crops_visually_similar

logger = logging.getLogger(__name__)


class OCREngine:
    def __init__(self):
        logger.info(
            "  RapidOCR lang=%s box_thresh=%.2f text_score=%.2f",
            settings.ocr_lang, settings.det_db_thresh, settings.text_score,
        )
        self.ocr = RapidOCR(
            params={
                "Det.box_thresh": settings.det_db_thresh,
                "Global.text_score": settings.text_score,
            }
        )
        self._prev_crop: np.ndarray | None = None
        self._prev_text: str = ""
        self._total_calls = 0
        self._cache_hits = 0
        self._hit_streak = 0
        self._warmup()
        logger.info("  OCR engine ready")

    def _warmup(self):
        logger.info("  Warming up OCR model (first inference)...")
        t0 = time.time()
        blank = np.zeros((48, 320, 3), dtype=np.uint8)
        self.ocr(blank)
        elapsed = time.time() - t0
        logger.info("  Warm-up done in %.1fs", elapsed)

    def ocr_image(self, image: np.ndarray) -> str:
        if image.size == 0:
            return ""
        result = self.ocr(image)
        texts: list[str] = []
        if result and result.txts:
            for text in result.txts:
                stripped = str(text).strip()
                if stripped:
                    texts.append(stripped)
        return " ".join(texts)

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
