import logging
import re
from collections.abc import Iterable
from pathlib import Path

import numpy as np

from rapidfuzz import fuzz
from tqdm import tqdm

from app.config import settings

logger = logging.getLogger(__name__)


# Chars often left behind by OCR (leading/trailing noise).
ARTIFACT_CHARS = " \u3000-—–−|·•.,，。;；:：!！?？~～`'\"“”‘’()（）[]【】«»‹›"

# Leading digit/dash artifacts like "1-", "1 ", "- " before CJK text.
# Negative lookahead protects 3+ digit runs (e.g. "2024年").
LEADING_ARTIFACT_RE = re.compile(
    r"^(?![0-9０-９]{3})[0-9０-９]{1,2}\s*[-—–−]?\s*(?=[\u4e00-\u9fff])"
)

# Any real letter/CJK char (a text made of digits/punct only is OCR junk).
HAS_LETTER_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ\u00c0-\u024f\u4e00-\u9fff]")

# Ngưỡng gộp sub liền kề (hardcode): 2 sub giống nhau ≥ 80% thì gộp lại.
MERGE_THRESHOLD = 0.8


def compute_contrast_score(crop_image: np.ndarray) -> float:
    """
    Tính độ tương contraste của 1 box chữ détectected.
    
    Cách hoạt động:
    1. Chuyển đổi crop sang grayscale.
    2. Dùng Otsu thresholding để tách pixel thành 2 nhóm: trên ngưỡng và dưới ngưỡng.
    3. Tính mean luminance của 2 nhóm đó.
    4. Contrast = |mean_above - mean_below|.
    
    Kết quả:
    - Giá trị cao (ví dụ > 30) = chữ có tương контраст tốt (trắng trên đen, hoặc ngược).
    - Giá trị thấp (ví dụ < 10) = chữ trộn với nền, contraste kém (thường là nhiễu).
    
    Note: Sử dụng Otsu tự động tìm ngưỡng phù hợp cho phân phối pixel của box đó,
    không giả định prior về cụm nào là chữ.
    """
    import cv2
    
    # Chuyển sang grayscale nếu chưa phải
    if len(crop_image.shape) == 3:
        gray = cv2.cvtColor(crop_image, cv2.COLOR_BGR2GRAY)
    else:
        gray = crop_image
    
    # Áp dụng Otsu thresholding
    # return_value: ngưỡng Otsu tự động tính
    # binary: ảnh nhị phân sau khi ngưỡng
    return_value, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    # Tính mean luminance cho 2 nhóm: pixel above threshold và below threshold
    # Pixel above (value > return_value) vs below (value <= return_value)
    above_mean = float(gray[gray > return_value].mean()) if (gray > return_value).any() else 0.0
    below_mean = float(gray[gray <= return_value].mean()) if (gray <= return_value).any() else 0.0
    
    contrast = abs(above_mean - below_mean)
    
    return float(contrast)


def sec_to_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def clean_text(text: str) -> str:
    if not text:
        return ""
    cleaned = " ".join(text.split())
    cleaned = cleaned.strip(ARTIFACT_CHARS)
    cleaned = LEADING_ARTIFACT_RE.sub("", cleaned).strip(ARTIFACT_CHARS)
    if not HAS_LETTER_RE.search(cleaned):
        return ""
    return cleaned


def texts_similar(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return fuzz.ratio(a, b) / 100.0 >= MERGE_THRESHOLD


def _adjacent(prev_end: float, start: float, tol: float = 0.05) -> bool:
    """True when `start` follows `prev_end` immediately (no gap in the timeline).

    Only adjacent subtitles may be merged; identical text that reappears at a
    later point must stay as a separate entry.
    """
    return abs(start - prev_end) <= tol


# ── Post-processing (hậu kiểm): strip stray chars, then merge once more ──

# Standalone digit tokens like "1" sprinkled by OCR ("不过 1 一 1").
DIGIT_TOKEN_RE = re.compile(r"(?<!\S)\d+(?!\S)")
# ASCII run glued to CJK, e.g. "Y垫" (misread) — but NOT "K仔" (real name).
# A glued token is treated as noise only if it is rare across the whole file.
GLUED_TOKEN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,3}[\u4e00-\u9fff]")
# Trailing ASCII glued after CJK: "你喝多了N" -> "你喝多了".
TRAILING_GLUED_RE = re.compile(r"(?<=[\u4e00-\u9fff])[A-Za-z0-9]{1,3}$")
# Pure short latin/digit/underscore tokens at line edges (V, X, C, IN, OK, _).
NOISE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_]{1,4}$")
# Entry left as pure short latin/digit after cleaning ("A", "IAN", "MNA").
PURE_NOISE_RE = re.compile(r"^[A-Za-z0-9_]{1,4}$")


def _strip_noise_tokens(text: str) -> str:
    tokens = [t for t in text.split() if not NOISE_TOKEN_RE.match(t)]
    return " ".join(tokens)


def clean_entry_text(text: str, glued_noise: set[str] | None = None) -> str:
    if not text:
        return ""
    text = clean_text(text)
    if not text:
        return ""
    text = DIGIT_TOKEN_RE.sub(" ", text)
    if glued_noise:
        tokens = text.split()
        stripped = []
        for tok in tokens:
            m = GLUED_TOKEN_RE.match(tok)
            if m and tok[: m.end()] in glued_noise:
                stripped.append(tok[m.end():])
            else:
                stripped.append(tok)
        text = " ".join(stripped)
    text = TRAILING_GLUED_RE.sub("", text)
    text = _strip_noise_tokens(text)
    text = clean_text(text)
    if PURE_NOISE_RE.match(text):
        return ""
    return text


def _no_space(s: str) -> str:
    return "".join(s.split())


def _mergeable(a: str, b: str) -> bool:
    if texts_similar(a, b):
        return True
    sa, sb = _no_space(a), _no_space(b)
    return len(sa) >= 2 and len(sb) >= 2 and (sa in sb or sb in sa)


def postprocess_entries(
    entries: list[tuple[float, float, str]],
) -> list[tuple[float, float, str]]:
    """Hậu kiểm: filter out OCR noise, drop empty lines, merge again."""
    from collections import Counter

    # Glued tokens like "K仔" that repeat are real names — keep them.
    glued_counts: Counter = Counter()
    for _start, _end, text in entries:
        for tok in text.split():
            m = GLUED_TOKEN_RE.match(tok)
            if m:
                glued_counts[tok[: m.end()]] += 1
    glued_noise = {t for t, c in glued_counts.items() if c <= 2}

    cleaned: list[tuple[float, float, str]] = []
    for start, end, text in entries:
        t = clean_entry_text(text, glued_noise)
        if t:
            cleaned.append((start, end, t))

    merged: list[tuple[float, float, str]] = []
    for start, end, text in cleaned:
        if (
            merged
            and _adjacent(merged[-1][1], start)
            and _mergeable(merged[-1][2], text)
        ):
            prev_start, _prev_end, prev_text = merged[-1]
            merged[-1] = (prev_start, end, prev_text if len(prev_text) >= len(text) else text)
            continue
        merged.append((start, end, text))
    return merged


def expand_subtitle_timings(
    entries: list[tuple[float, float, str]],
    expand_start: float = 0.3,
    expand_end: float = 0.3,
) -> list[tuple[float, float, str]]:
    """Mở rộng thời gian hiển thị phụ đề: trừ `expand_start` từ start, cộng `expand_end` vào end.

    Giới hạn mở rộng để không chồng lấn với phụ đề liền kề:
    - start không được < end của phụ đề trước
    - end không được > start của phụ đề sau
    """
    if not entries:
        return entries

    expanded = []
    for i, (start, end, text) in enumerate(entries):
        new_start = max(0.0, start - expand_start)
        new_end = end + expand_end

        # Không chồng lấn với phụ đề trước
        if i > 0:
            prev_end = expanded[i - 1][1]
            if new_start < prev_end:
                new_start = prev_end

        # Không chồng lấn với phụ đề sau (cần peek phía trước)
        if i < len(entries) - 1:
            next_start = entries[i + 1][0]
            if new_end > next_start:
                new_end = next_start

        # Đảm bảo start < end (ít nhất 0.05s)
        if new_end - new_start < 0.05:
            new_end = new_start + 0.05

        expanded.append((new_start, new_end, text))

    return expanded


def generate_srt_entries(
    frames: Iterable[tuple[object, float]],
    ocr_engine,
    progress_callback=None,
    text_callback=None,
    total_frames: int | None = None,
    collect_boxes: bool = False,
) -> tuple[list[tuple[float, float, str]], list[tuple[float, float, float, float]] | None]:
    """Build subtitle entries from a stream of (crop, timestamp) frames.

    A subtitle boundary is placed at the midpoint between the last frame that
    still showed the old text and the first frame that shows the new text,
    so timestamps stay accurate even at high sampling rates.

    Returns:
        ``(entries, boxes)`` where ``entries`` là list ``(start, end, text)``
        và ``boxes`` là list ``(x1, y1, x2, y2)`` normalized 0-1 (nếu
        ``collect_boxes=True``), hoặc ``None`` nếu ``collect_boxes=False``.

    Callers that only need the text use :func:`generate_srt`; parallel workers
    use this to merge segment results.
    """
    entries: list[tuple[float, float, str]] = []
    # Collect boxes when requested; stored per-frame then merged later.
    boxes_accum: list[tuple[float, float, float, float]] | None = (
        [] if collect_boxes else None
    )

    prev_text = ""
    prev_ts = 0.0
    start_time = 0.0
    stable_count = 0
    min_stable = 2

    pbar = tqdm(total=total_frames, desc="  ocr", unit="fr", leave=False)

    for i, (crop, timestamp) in enumerate(frames):
        text, box = ocr_engine.ocr_region_cached(crop)
        text = clean_text(text)

        # ---- Fix 3: Compute contrast-based noise score (Pass 2) ----
        # Mỗi box detect được tính score contrast bằng Otsu thresholding.
        # Kết quả không dùng làm pass/fail cứng, mà là 1 tín hiệu bổ trợ
        # sẽ được kết hợp cùng heatmap mass (pass 1) qua confidence score tổng hợp.
        contrast_score = 0.0
        if collect_boxes and box is not None and settings.ocr_contrast_threshold > 0:
            # Compute contrast score using Otsu thresholding on the crop image.
            # crop là numpy array đã crop region từ frame, kích thước phù hợp với engine OCR.
            # Không cần dùng box normalized - contrast tính trên pixel intensity trực tiếp.
            contrast_score = compute_contrast_score(crop)
            # Log contrast score cho debug - không dùng để reject box ngay lập tức.
            # Giá trị này sẽ được lưu và có thể kết hợp với heatmap mass (pass 1) ở process_job_sync.
            if contrast_score < settings.ocr_contrast_threshold:
                logger.debug(
                    "Low contrast box (score=%.2f < %d): text='%s'",
                    contrast_score, settings.ocr_contrast_threshold,
                    text[:30] if text else "(empty)",
                )
            else:
                logger.debug(
                    "Good contrast box (score=%.2f >= %d): text='%s'",
                    contrast_score, settings.ocr_contrast_threshold,
                    text[:30] if text else "(empty)",
                )

        pbar.update(1)

        # Nếu collect_boxes và engine trả về box hợp lệ -> accumulate
        if collect_boxes and box is not None:
            # box normalized (x1,y1,x2,y2) 0-1; store với timestamp/dòng text
            # Ta chỉ cầncollect box thô, sau này merge theo cùng logic entries.
            boxes_accum.append(box)

        if i == 0:
            prev_text = text
            prev_ts = timestamp
            start_time = timestamp
            stable_count = 1
            if text:
                logger.debug("  [%s] %s", sec_to_srt(timestamp), text[:80])
            if progress_callback:
                progress_callback(i, total_frames or i + 1)
            continue

        similarity = fuzz.ratio(text, prev_text) / 100.0

        if similarity < settings.similarity_threshold:
            if prev_text.strip() and stable_count >= min_stable:
                boundary = (prev_ts + timestamp) / 2.0
                entries.append((start_time, boundary, prev_text.strip()))
                if text_callback:
                    text_callback(start_time, boundary, prev_text.strip())
                logger.info(
                    "  subtitle: %s --> %s  |  %s",
                    sec_to_srt(start_time), sec_to_srt(boundary),
                    prev_text.strip()[:80],
                )
                start_time = boundary
            else:
                start_time = timestamp
            prev_text = text
            prev_ts = timestamp
            stable_count = 1
        else:
            prev_ts = timestamp
            stable_count += 1

        if progress_callback:
            progress_callback(i, total_frames or i + 1)

    pbar.close()
    ocr_engine.log_stats()

    # Nếu collect_boxes, boxes_accum chứa tất cả box thu thập được (chể nhiều trùng lặp
    # vì các frame lân cận). Chúng ta return list thô; caller (worker) có thể merge/
    # lọc nếu muốn. Ở bản MVP chúng ta chỉ trả về None boxes nhưng đã truyền cấu trúc sẵn.
    # Để tương thích ngược: nếu collect_boxes=False (mặc định) trả về (entries, None).

    merged: list[tuple[float, float, str]] = []
    for start, end, text in entries:
        if (
            merged
            and _adjacent(merged[-1][1], start)
            and texts_similar(merged[-1][2], text)
        ):
            prev = merged[-1][2]
            merged[-1] = (merged[-1][0], end, prev if len(prev) >= len(text) else text)
        else:
            merged.append((start, end, text))

    final = postprocess_entries(merged)
    logger.info("  => %d subtitle entries generated", len(final))

    # Trả về (entries, boxes); boxes có thể là None nếu khôngcollect
    return final, boxes_accum if collect_boxes else None


def merge_parallel_entries(segment_results: list) -> list[tuple[float, float, str]]:
    """Merge OCR results from parallel segments.

    Each segment result is (entries, boxes) where entries is a list of
    (start, end, text) tuples. This function flattens all entries, sorts by
    start time, and collapses similar/adjacent entries.
    """
    from rapidfuzz import fuzz

    all_entries: list[tuple[float, float, str]] = []
    for segment_entries, _boxes in segment_results:
        all_entries.extend(segment_entries)

    if not all_entries:
        return []

    # Sort by start time
    all_entries.sort(key=lambda e: e[0])

    # Collapse similar adjacent entries
    merged: list[tuple[float, float, str]] = [all_entries[0]]
    for start, end, text in all_entries[1:]:
        last = merged[-1]
        # If texts are similar or one contains the other, merge them
        if texts_similar(last[2], text):
            merged[-1] = (last[0], end, last[2] if len(last[2]) >= len(text) else text)
        elif last[2] in text or text in last[2]:
            merged[-1] = (last[0], end, last[2] if len(last[2]) >= len(text) else text)
        else:
            merged.append((start, end, text))

    return merged


def format_srt(entries: list[tuple[float, float, str]]) -> str:
    """Convert subtitle entries to SRT format string."""
    lines: list[str] = []
    for i, (start, end, text) in enumerate(entries, start=1):
        lines.append(str(i))
        lines.append(f"{sec_to_srt(start)} --> {sec_to_srt(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)

