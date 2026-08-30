import logging
import os
import time

import numpy as np

from app.config import settings
from app.services.ocr_engine import BaseOCREngine

logger = logging.getLogger(__name__)

# PaddlePaddle 3.x on Windows: mkldnn run-mode crashes with
# "ConvertPirAttribute2RuntimeAttribute not supported" — force plain paddle mode.
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

SUPPORTED_LANGS = {"ch": "ch", "en": "en", "latin": "latin"}


class PaddleOCREngine(BaseOCREngine):
    """OCR via PaddleOCR (PaddlePaddle).

    Requires ``pip install paddlepaddle paddleocr``. The import is lazy so the
    app still boots when Paddle is missing — instantiation raises a clear
    error in that case.
    """

    name = "paddle"

    def __init__(self):
        logger.info(
            "  PaddleOCR lang=%s det_db_thresh=%.2f device=%s",
            settings.ocr_lang, settings.det_db_thresh, settings.ocr_device,
        )
        self._engines: dict[str, object] = {}
        self._lang = settings.ocr_lang if settings.ocr_lang in SUPPORTED_LANGS else "ch"
        self._PaddleOCR = self._ensure_paddle()
        self._engine = self._get_engine(self._lang)
        super().__init__()
        self._warmup()
        logger.info("  PaddleOCR engine ready")

    def _ensure_paddle(self):
        # PaddlePaddle and PyTorch ship conflicting DLLs on Windows; torch
        # must be loaded FIRST or its libs fail (WinError 127). demucs uses
        # torch lazily, so preload it here to fix the load order.
        try:
            import torch  # noqa: F401
        except Exception as e:
            logger.warning("  Preload torch failed (non-fatal): %s", e)
        try:
            from paddleocr import PaddleOCR
        except ImportError as e:
            raise RuntimeError(
                "PaddleOCR requires paddlepaddle + paddleocr. Install with: "
                "pip install paddlepaddle paddleocr"
            ) from e
        except Exception as e:
            raise RuntimeError(f"PaddleOCR import failed: {e}") from e
        return PaddleOCR

    def _get_engine(self, lang: str):
        if lang not in self._engines:
            logger.info("  Loading PaddleOCR engine for lang=%s …", lang)
            kwargs = {"lang": lang, "device": settings.ocr_device}
            try:
                # 3.x only — disable doc preprocessing for speed.
                engine = self._PaddleOCR(
                    **kwargs,
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
            except TypeError:
                kwargs.pop("device", None)
                engine = self._PaddleOCR(**kwargs)
            self._engines[lang] = engine
        return self._engines[lang]

    def set_lang(self, lang: str) -> None:
        if lang not in SUPPORTED_LANGS:
            lang = "ch"
        self.reset_cache()
        self._lang = lang
        self._engine = self._get_engine(lang)

    def _warmup(self):
        logger.info("  Warming up PaddleOCR model (first inference)...")
        t0 = time.time()
        try:
            blank = np.full((48, 320, 3), 255, dtype=np.uint8)
            self.ocr_image(blank)
        except Exception as e:
            logger.warning("  PaddleOCR warm-up failed: %s", e)
        logger.info("  Warm-up done in %.1fs", time.time() - t0)

    def ocr_image(self, image: np.ndarray) -> str:
        if image.size == 0:
            return ""
        result = self._engine.ocr(image)
        texts: list[str] = []
        if not result or not result[0]:
            return ""
        lines = result[0]
        # PaddleOCR 3.x returns a dict per image, 2.x returns [[box, (text, score)], ...]
        if isinstance(lines, dict):
            rec_texts = lines.get("rec_texts") or []
            for text in rec_texts:
                stripped = str(text).strip()
                if stripped:
                    texts.append(stripped)
        elif isinstance(lines, (list, tuple)):
            for line in lines:
                if not isinstance(line, (list, tuple)) or len(line) < 2:
                    continue
                text = line[1]
                if isinstance(text, (list, tuple)) and text:
                    text = text[0]
                stripped = str(text).strip()
                if stripped:
                    texts.append(stripped)
        return " ".join(texts)