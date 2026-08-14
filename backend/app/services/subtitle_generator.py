import logging
import re
from collections.abc import Iterable
from pathlib import Path

from rapidfuzz import fuzz
from tqdm import tqdm

from app.config import settings

logger = logging.getLogger(__name__)


def _save_crop(crop, save_dir: Path, index: int, timestamp: float):
    """Save cropped frame image to disk."""
    import cv2
    ts_str = f"{timestamp:.2f}".replace(".", "_")
    filename = f"{index:04d}_{ts_str}s.jpg"
    filepath = save_dir / filename
    cv2.imwrite(str(filepath), crop)
    logger.debug("  saved crop: %s", filename)


# Chars often left behind by OCR (leading/trailing noise).
ARTIFACT_CHARS = " \u3000-—–−|·•.,，。;；:：!！?？~～`'\"“”‘’()（）[]【】«»‹›"

# Leading digit/dash artifacts like "1-", "1 ", "- " before CJK text.
# Negative lookahead protects 3+ digit runs (e.g. "2024年").
LEADING_ARTIFACT_RE = re.compile(
    r"^(?![0-9０-９]{3})[0-9０-９]{1,2}\s*[-—–−]?\s*(?=[\u4e00-\u9fff])"
)

# Any real letter/CJK char (a text made of digits/punct only is OCR junk).
HAS_LETTER_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ\u00c0-\u024f\u4e00-\u9fff]")


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
    return fuzz.ratio(a, b) / 100.0 >= settings.merge_similarity


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
        if merged and _mergeable(merged[-1][2], text):
            prev_start, _prev_end, prev_text = merged[-1]
            merged[-1] = (prev_start, end, prev_text if len(prev_text) >= len(text) else text)
            continue
        if (
            len(merged) >= 2
            and end - merged[-1][0] < settings.subtitle_flash_seconds
            and _mergeable(merged[-2][2], text)
        ):
            # A-B-A with a short middle: absorb the blip and merge A's.
            prev_start, _prev_end, prev_text = merged[-2]
            merged = merged[:-1]
            merged[-1] = (prev_start, end, prev_text if len(prev_text) >= len(text) else text)
            continue
        merged.append((start, end, text))
    return merged


def generate_srt(
    frames: Iterable[tuple[object, float]],
    region: dict,
    ocr_engine,
    progress_callback=None,
    text_callback=None,
    total_frames: int | None = None,
    save_crops_dir: Path | None = None,
) -> str:
    """Build SRT from a stream of (crop, full_frame, timestamp) frames.

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

    # Save up to 20 snapshot frames evenly spread across the video timeline
    # (target 10–20 frames: at least 10 for good context coverage).
    snapshot_step = 1
    if save_crops_dir and total_frames:
        snapshot_step = max(1, (total_frames + 19) // 20)

    for i, (crop, full_frame, timestamp) in enumerate(frames):
        if save_crops_dir and i % snapshot_step == 0:
            _save_crop(full_frame, save_crops_dir, i // snapshot_step, timestamp)

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
                flash_duration = boundary - start_time
                if (
                    text.strip()
                    and entries
                    and flash_duration < settings.subtitle_flash_seconds
                    and texts_similar(text, entries[-1][2])
                ):
                    # Short flash (e.g. OCR blip) between two identical
                    # segments — absorb it back into the open entry.
                    entries[-1] = (entries[-1][0], boundary, entries[-1][2])
                    if text_callback:
                        text_callback(entries[-1][0], boundary, entries[-1][2])
                    prev_text = text
                    prev_ts = timestamp
                    stable_count = 1
                    if progress_callback:
                        progress_callback(i, total_frames or i + 1)
                    continue
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
        if entries and texts_similar(prev_text, entries[-1][2]):
            entries[-1] = (entries[-1][0], prev_ts, entries[-1][2])
        else:
            entries.append((start_time, prev_ts, prev_text.strip()))
        if text_callback:
            text_callback(entries[-1][0], entries[-1][1], entries[-1][2])
        logger.info(
            "  subtitle: %s --> %s  |  %s",
            sec_to_srt(entries[-1][0]), sec_to_srt(entries[-1][1]),
            entries[-1][2][:80],
        )

    merged = []
    for start, end, text in entries:
        if merged and texts_similar(merged[-1][2], text):
            merged[-1] = (merged[-1][0], end, merged[-1][2])
        else:
            merged.append((start, end, text))

    final = postprocess_entries(merged)
    logger.info("  => %d subtitle entries generated", len(final))

    srt_lines: list[str] = []
    for idx, (start, end, text) in enumerate(final, 1):
        srt_lines.append(str(idx))
        srt_lines.append(f"{sec_to_srt(start)} --> {sec_to_srt(end)}")
        srt_lines.append(text)
        srt_lines.append("")

    return "\n".join(srt_lines)
