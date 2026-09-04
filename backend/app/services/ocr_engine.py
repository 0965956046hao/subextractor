import logging
import threading
import time

import numpy as np
from rapidocr import RapidOCR

from app.config import settings
from app.services.video_processor import crops_visually_similar

logger = logging.getLogger(__name__)

SUPPORTED_LANGS = {"ch": "ch", "en": "en", "latin": "latin"}
LANG_LABELS = {"ch": "Tiếng Trung", "en": "Tiếng Anh", "latin": "Tiếng Việt"}


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

    def ocr_region_cached(self, crop: np.ndarray, color_filter=None) -> str:
        if crop.size == 0:
            return ""
        # Apply color mask before dHash/cache so filtered view is cached
        # — handle both dict (worker job) and pydantic object
        enabled = False
        color = "#FFFFFF"
        tolerance = 30
        if isinstance(color_filter, dict):
            enabled = bool(color_filter.get("enabled", False))
            color = color_filter.get("color", "#FFFFFF")
            tolerance = color_filter.get("tolerance", 30)
        elif color_filter is not None:
            enabled = bool(getattr(color_filter, "enabled", False))
            color = getattr(color_filter, "color", "#FFFFFF")
            tolerance = getattr(color_filter, "tolerance", 30)
        if enabled:
            try:
                from app.services.color_mask import apply_color_mask
                crop = apply_color_mask(crop, color, tolerance)
            except Exception:
                pass
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


class OCREngine(BaseOCREngine):
    name = "rapid"

    def __init__(self, intra_threads: int | None = None):
        logger.info(
            "  RapidOCR lang=%s box_thresh=%.2f text_score=%.2f intra_threads=%s",
            settings.ocr_lang, settings.det_db_thresh, settings.text_score,
            intra_threads or "auto",
        )
        self._intra_threads = intra_threads
        self._engines: dict[str, RapidOCR] = {}
        self._lang = settings.ocr_lang if settings.ocr_lang in SUPPORTED_LANGS else "ch"
        self._engine = self._get_engine(self._lang)
        super().__init__()
        self._warmup()
        logger.info("  RapidOCR engine ready")

    def _get_engine(self, lang: str) -> RapidOCR:
        if lang not in self._engines:
            logger.info("  Loading RapidOCR engine for lang=%s …", lang)
            params = {
                "Det.lang_type": lang,
                "Rec.lang_type": lang,
                "Det.box_thresh": settings.det_db_thresh,
                "Global.text_score": settings.text_score,
            }
            if self._intra_threads:
                # Chống oversubscription khi chạy pool song song: mỗi engine
                # chỉ dùng số core bằng phần của mình thay vì toàn bộ CPU.
                params["EngineConfig.onnxruntime.intra_op_num_threads"] = self._intra_threads
            engine = RapidOCR(params=params)
            self._engines[lang] = engine
        return self._engines[lang]

    def set_lang(self, lang: str) -> None:
        if lang not in SUPPORTED_LANGS:
            lang = "ch"
        self.reset_cache()
        self._lang = lang
        self._engine = self._get_engine(lang)

    def _warmup(self):
        logger.info("  Warming up OCR model (first inference)...")
        t0 = time.time()
        blank = np.zeros((48, 320, 3), dtype=np.uint8)
        self._engine(blank)
        elapsed = time.time() - t0
        logger.info("  Warm-up done in %.1fs", elapsed)

    def ocr_image(self, image: np.ndarray) -> str:
        if image.size == 0:
            return ""
        result = self._engine(image)
        texts: list[str] = []
        if result and result.txts:
            for text in result.txts:
                stripped = str(text).strip()
                if stripped:
                    texts.append(stripped)
        return " ".join(texts)
