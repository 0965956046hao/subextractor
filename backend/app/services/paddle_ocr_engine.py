import logging
import os
import time

import numpy as np

from app.config import settings
from app.services.ocr_engine import BaseOCREngine

logger = logging.getLogger(__name__)

# PaddleOCR result format helpers
# PaddleOCR 3.x returns [[box, (text, score)], ...] per image
# Box là [x1, y1, x2, y2] pixel coordinates (relative to input image size)
# Text info: (text_str, confidence_score)


def _paddle_box_to_normalized(box_px: list[float], w: int, h: int) -> tuple[float, float, float, float] | None:
    """Chuyển box pixel (x1,y1,x2,y2) sang normalized (0-1) theo width/height frame.
    Trả None nếu box không hợp lệ.
    """
    if not isinstance(box_px, (list, tuple)) or len(box_px) < 4:
        return None
    try:
        x1 = max(0.0, min(1.0, float(box_px[0]) / max(1, w)))
        y1 = max(0.0, min(1.0, float(box_px[1]) / max(1, h)))
        x2 = max(0.0, min(1.0, float(box_px[2]) / max(1, w)))
        y2 = max(0.0, min(1.0, float(box_px[3]) / max(1, h)))
        # Đảm bảo x2 > x1 và y2 > y1
        if x2 <= x1 or y2 <= y1:
            return None
        return (x1, y1, x2, y2)
    except (ValueError, TypeError, ZeroDivisionError):
        return None

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

    def ocr_image(self, image: np.ndarray) -> tuple[str, tuple[float, float, float, float] | None]:
        """Trả về (text, box_ normalized) trong đó box là (x1, y1, x2, y2) normalized 0-1
        hoặc None nếu không extract dc box."""
        if image.size == 0:
            return "", None
        result = self._engine.ocr(image)
        texts: list[str] = []
        boxes: list[tuple[float, float, float, float]] = []

        if not result or not result[0]:
            return "", None

        lines = result[0]
        # PaddleOCR 3.x returns a dict per image, 2.x returns [[box, (text, score)], ...]
        if isinstance(lines, dict):
            # Dict format có thể chứa rec_texts - extract text nhưng box khó chính xác
            # nên trả về None box ở format dict (chịu lỗi nhỏ hơn là sai logic sau)
            rec_texts = lines.get("rec_texts") or []
            for text_entry in rec_texts:
                stripped = str(text_entry).strip()
                if stripped:
                    texts.append(stripped)
            # Trả về text nhưng box = None (dict format không đảm bảo box chính xác)
            return " ".join(texts), None
        elif isinstance(lines, (list, tuple)):
            for line in lines:
                if not isinstance(line, (list, tuple)) or len(line) < 2:
                    continue
                # Extract text
                text_val = line[1]
                if isinstance(text_val, (list, tuple)) and text_val:
                    text_val = text_val[0]
                stripped = str(text_val).strip()
                if stripped:
                    texts.append(stripped)
                # Extract box
                box_px = line[0]
                if isinstance(box_px, (list, tuple)) and len(box_px) >= 4:
                    normalized = _paddle_box_to_normalized(box_px, image.shape[1], image.shape[0])
                    if normalized is not None:
                        boxes.append(normalized)
        # Nếu có ít nhất 1 box hợp lệ, trả box đầu tiên (box 'chính' nhất)
        # Nếu không có box hợp lệ nào, trả None (người gọi có thể ignore)
        final_box = boxes[0] if boxes else None
        joined_text = " ".join(texts) if texts else ""
        return joined_text, final_box