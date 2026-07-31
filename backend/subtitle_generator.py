from rapidfuzz import fuzz

from config import SIMILARITY_THRESHOLD
from ocr_engine import OCREngine


def sec_to_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(
    frames: list[tuple[str, float]],
    region: dict[str, int],
    ocr: OCREngine,
) -> str:
    entries = []
    prev_text = ""
    start_time = 0.0

    for i, (frame_path, timestamp) in enumerate(frames):
        text = ocr.ocr_region(frame_path, region)

        if i == 0:
            prev_text = text
            start_time = timestamp
            continue

        similarity = fuzz.ratio(text, prev_text) / 100.0

        if similarity < SIMILARITY_THRESHOLD:
            if prev_text.strip():
                entries.append((start_time, timestamp, prev_text.strip()))
            prev_text = text
            start_time = timestamp

    if prev_text.strip():
        entries.append((start_time, frames[-1][1], prev_text.strip()))

    srt_lines = []
    for idx, (start, end, text) in enumerate(entries, 1):
        srt_lines.append(str(idx))
        srt_lines.append(f"{sec_to_srt(start)} --> {sec_to_srt(end)}")
        srt_lines.append(text)
        srt_lines.append("")

    return "\n".join(srt_lines)
