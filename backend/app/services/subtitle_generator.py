import logging

from rapidfuzz import fuzz
from tqdm import tqdm

from app.config import settings

logger = logging.getLogger(__name__)


def sec_to_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def clean_text(text: str) -> str:
    return " ".join(text.strip().split())


def generate_srt(
    frames: list[tuple[str, float]],
    region: dict,
    ocr_engine,
    progress_callback=None,
) -> str:
    entries: list[tuple[float, float, str]] = []
    prev_text = ""
    start_time = 0.0
    stable_count = 0
    min_stable = 2

    total = len(frames)
    logger.info("  processing %d frames with OCR...", total)
    pbar = tqdm(total=total, desc="  ocr", unit="fr", leave=False)

    for i, (crop, timestamp) in enumerate(frames):
        text = ocr_engine.ocr_region_cached(crop)
        text = clean_text(text)
        pbar.update(1)

        if i == 0:
            prev_text = text
            start_time = timestamp
            stable_count = 1
            if text:
                logger.debug("  [%s] %s", sec_to_srt(timestamp), text[:80])
            if progress_callback:
                progress_callback(i, total)
            continue

        similarity = fuzz.ratio(text, prev_text) / 100.0

        if similarity < settings.similarity_threshold:
            if prev_text.strip() and stable_count >= min_stable:
                entries.append((start_time, timestamp, prev_text.strip()))
                logger.info(
                    "  subtitle: %s --> %s  |  %s",
                    sec_to_srt(start_time), sec_to_srt(timestamp),
                    prev_text.strip()[:80],
                )
            prev_text = text
            start_time = timestamp
            stable_count = 1
        else:
            stable_count += 1

        if progress_callback:
            progress_callback(i, total)

    pbar.close()
    ocr_engine.log_stats()

    if prev_text.strip():
        end_t = frames[-1][1] if frames else start_time
        entries.append((start_time, end_t, prev_text.strip()))
        logger.info(
            "  subtitle: %s --> %s  |  %s",
            sec_to_srt(start_time), sec_to_srt(end_t),
            prev_text.strip()[:80],
        )

    merged = []
    for start, end, text in entries:
        if merged and merged[-1][2] == text and abs(merged[-1][1] - end) < 2.0:
            merged[-1] = (merged[-1][0], end, text)
        else:
            merged.append((start, end, text))

    logger.info("  => %d subtitle entries generated", len(merged))

    srt_lines: list[str] = []
    for idx, (start, end, text) in enumerate(merged, 1):
        srt_lines.append(str(idx))
        srt_lines.append(f"{sec_to_srt(start)} --> {sec_to_srt(end)}")
        srt_lines.append(text)
        srt_lines.append("")

    return "\n".join(srt_lines)
