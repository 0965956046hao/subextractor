import cv2

from paddleocr import PaddleOCR
from config import OCR_LANG


class OCREngine:
    def __init__(self):
        self.ocr = PaddleOCR(
            lang=OCR_LANG,
            det_db_thresh=0.3,
            rec_batch_num=6,
        )

    def ocr_region(self, image_path: str, bbox: dict[str, int]) -> str:
        x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]
        img = cv2.imread(image_path)
        if img is None:
            return ""
        h, w = img.shape[:2]

        crop = img[int(y1 * h):int(y2 * h), int(x1 * w):int(x2 * w)]
        if crop.size == 0:
            return ""

        result = self.ocr.ocr(crop)
        texts = []
        if result and result[0]:
            for line in result[0]:
                text = line[1][0].strip()
                if text:
                    texts.append(text)
        return " ".join(texts)
