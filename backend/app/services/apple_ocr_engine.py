import logging
import time

import numpy as np

from app.config import settings
from app.services.ocr_engine import BaseOCREngine

logger = logging.getLogger(__name__)

# Apple Vision recognition languages per app lang code.
APPLE_LANG_MAP = {"ch": "zh-Hans", "en": "en-US", "latin": "vi-VN"}
FALLBACK_APPLE_LANG = "en-US"


class AppleOCREngine(BaseOCREngine):
    """OCR via the macOS Vision framework (VNRecognizeTextRequest).

    Requires macOS with
    ``pip install pyobjc-framework-Vision pyobjc-framework-Cocoa pyobjc-framework-Quartz``.
    Frameworks are imported lazily so the app still boots (with RapidOCR)
    when pyobjc is missing — instantiation raises a clear error in that case.
    """

    name = "apple"

    def __init__(self):
        super().__init__()
        self._lang = settings.ocr_lang if settings.ocr_lang in APPLE_LANG_MAP else "ch"
        self._Foundation = None
        self._ImageIO = None
        self._Vision = None
        self._request = None
        self._ensure_vision()
        self._rebuild_request()
        self._warmup()
        logger.info("  Apple Vision engine ready (lang=%s)", self._lang)

    def _ensure_vision(self):
        try:
            import Foundation
            import Vision
        except ImportError as e:
            raise RuntimeError(
                "Apple Vision OCR requires macOS + pyobjc. Install with: "
                "pip install pyobjc-framework-Vision pyobjc-framework-Cocoa "
                "pyobjc-framework-Quartz"
            ) from e
        try:
            import ImageIO
        except ImportError:
            # pyobjc >= 11: ImageIO is exposed under the Quartz umbrella.
            from Quartz import ImageIO
        self._Foundation = Foundation
        self._ImageIO = ImageIO
        self._Vision = Vision

    def set_lang(self, lang: str) -> None:
        if lang not in APPLE_LANG_MAP:
            lang = "ch"
        if lang == self._lang:
            self.reset_cache()
            return
        self._lang = lang
        self.reset_cache()
        self._rebuild_request()

    def _rebuild_request(self):
        Vision = self._Vision
        request = Vision.VNRecognizeTextRequest.alloc().init()
        # Pin revision mới nhất mà máy hỗ trợ (3 > 2 > 1): model mới bắt
        # chữ tốt hơn mà gần như không chậm thêm. Không set = chạy
        # revision mặc định cũ.
        for rev in (
            Vision.VNRecognizeTextRequestRevision3,
            Vision.VNRecognizeTextRequestRevision2,
            Vision.VNRecognizeTextRequestRevision1,
        ):
            try:
                request.setRevision_(rev)
                if request.revision() == rev:
                    logger.info("  Apple Vision: using request revision %d", rev)
                    break
            except Exception:
                continue
        if settings.apple_ocr_accurate:
            request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        else:
            # Fast nhanh hơn Accurate ~2-3x; sub cỡ lớn/rõ vẫn đọc tốt.
            request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelFast)
        # Language correction sửa miss/sai theo từ điển — giữ bật ở cả 2 mode.
        request.setUsesLanguageCorrection_(True)
        request.setMinimumTextHeight_(0.0)
        langs = [APPLE_LANG_MAP[self._lang]]
        try:
            request.setRecognitionLanguages_(langs)
        except Exception:
            logger.warning(
                "  Apple Vision: lang %s unsupported, falling back to %s",
                langs[0], FALLBACK_APPLE_LANG,
            )
            request.setRecognitionLanguages_([FALLBACK_APPLE_LANG])
        self._request = request

    def _warmup(self):
        logger.info("  Warming up Apple Vision OCR…")
        t0 = time.time()
        blank = np.zeros((48, 320, 3), dtype=np.uint8)
        self.ocr_image(blank)
        logger.info("  Warm-up done in %.1fs", time.time() - t0)

    def ocr_image(self, image: np.ndarray) -> str:
        if image.size == 0:
            return ""
        import cv2

        # Upscale trước khi OCR: Fast miss chủ yếu ở chữ nhỏ, phóng to crop
        # giúp bắt lại phần lớn mà chi phí encode thêm không đáng kể.
        scale = settings.apple_upscale
        if scale and scale != 1.0:
            h, w = image.shape[:2]
            image = cv2.resize(
                image, (max(1, int(w * scale)), max(1, int(h * scale))),
                interpolation=cv2.INTER_CUBIC,
            )

        # Quality 80 (thay vì default 95): encode nhanh hơn + payload Vision
        # nhỏ hơn, chất lượng vẫn dư cho OCR chữ.
        ok, buf = cv2.imencode(
            ".jpg", image,
            [cv2.IMWRITE_JPEG_QUALITY, settings.apple_jpeg_quality],
        )
        if not ok:
            return ""
        data = self._Foundation.NSData.dataWithBytes_length_(
            buf.tobytes(), len(buf.tobytes())
        )
        source = self._ImageIO.CGImageSourceCreateWithData(data, None)
        cgimage = self._ImageIO.CGImageSourceCreateImageAtIndex(source, 0, None)
        handler = self._Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            cgimage, None
        )
        handler.performRequests_error_([self._request], None)

        texts: list[str] = []
        for obs in self._request.results() or []:
            candidates = obs.topCandidates_(1)
            if candidates and len(candidates):
                texts.append(str(candidates[0].string()))
        return " ".join(texts)
