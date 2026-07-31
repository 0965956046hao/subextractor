import logging
from collections.abc import Iterable

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
    frames: Iterable[tuple[object, float]],
    region: dict,
    ocr_engine,
    progress_callback=None,
    text_callback=None,
    total_frames: int | None = None,
) -> str:
    """Build SRT from a stream of (crop, timestamp) frames.

    A subtitle boundary is placed at the midpoint between the last frame that
    still showed the old text and the first frame that shows the new text,
    so timestamps stay accurate even at high sampling rates.
    """
    entries: list[tuple[float, float, str]] = []
    prev_text = ""
    prev_ts = 0.0
    start_time = 0.0
    stable_count = 0
    min_stable = 2

    pbar = tqdm(total=total_frames, desc="  ocr", unit="fr", leave=False)

    for i, (crop, timestamp) in enumerate(frames):
        text = ocr_engine.ocr_region_cached(crop)
        text = clean_text(text)
        pbar.update(1)

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

    if prev_text.strip():
        entries.append((start_time, prev_ts, prev_text.strip()))
        if text_callback:
            text_callback(start_time, prev_ts, prev_text.strip())
        logger.info(
            "  subtitle: %s --> %s  |  %s",
            sec_to_srt(start_time), sec_to_srt(prev_ts),
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
