"""SRT parsing & formatting utilities (shared by multiple services)."""

from rapidfuzz import fuzz

from app.models import SrtEntry

MERGE_THRESHOLD = 0.8


def _texts_similar(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return fuzz.ratio(a.strip(), b.strip()) / 100.0 >= MERGE_THRESHOLD


def _fmt(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _parse_time(t: str) -> float:
    h, m, rest = t.split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def parse_srt(content: str) -> list[SrtEntry]:
    entries: list[SrtEntry] = []
    for block in content.strip().split("\n\n"):
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue
        time_match = None
        for ln in lines:
            t = ln.strip()
            if "-->" in t:
                time_match = t
                break
        if not time_match:
            continue
        parts = time_match.split("-->")
        if len(parts) != 2:
            continue
        start_label = parts[0].strip()
        end_label = parts[1].strip()
        try:
            start = _parse_time(start_label)
            end = _parse_time(end_label)
        except Exception:
            continue
        text_lines = [l for l in lines if l.strip() and "-->" not in l and not l.strip().isdigit()]
        text = " ".join(text_lines)
        entries.append(SrtEntry(
            index=len(entries) + 1,
            start=start,
            end=end,
            startLabel=start_label,
            endLabel=end_label,
            text=text,
        ))
    return entries


def entries_to_srt(entries: list[SrtEntry]) -> str:
    blocks: list[str] = []
    for i, e in enumerate(entries):
        blocks.append(f"{i + 1}\n{e.startLabel} --> {e.endLabel}\n{e.text}")
    return "\n\n".join(blocks) + "\n"


MIN_SRT_DURATION = 0.6


def validate_timeline(entries: list[SrtEntry]) -> list[dict]:
    """Detect illogical timeline issues in parsed SRT entries.

    Checks three structural rules:
    - negative/zero duration (end <= start)
    - overlap between consecutive entries (next start before prev end)
    - out-of-order entries (next start before prev start)
    """
    issues: list[dict] = []
    prev: SrtEntry | None = None
    for e in entries:
        if e.end <= e.start:
            issues.append({
                "index": e.index,
                "type": "negative_duration",
                "message": (
                    f"Phụ đề #{e.index}: thời gian kết thúc ({e.endLabel}) "
                    f"không sau thời gian bắt đầu ({e.startLabel})"
                ),
                "start": e.start,
                "end": e.end,
            })
        if prev is not None and e.start < prev.end:
            issues.append({
                "index": e.index,
                "type": "overlap",
                "message": (
                    f"Phụ đề #{e.index} chồng lấn với phụ đề #{prev.index} "
                    f"(bắt đầu {e.startLabel} trước khi kết thúc {prev.endLabel})"
                ),
                "start": e.start,
                "end": e.end,
                "prev_index": prev.index,
            })
        if prev is not None and e.start < prev.start:
            issues.append({
                "index": e.index,
                "type": "out_of_order",
                "message": (
                    f"Phụ đề #{e.index} không theo thứ tự "
                    f"(bắt đầu {e.startLabel} trước phụ đề #{prev.index})"
                ),
                "start": e.start,
                "end": e.end,
                "prev_index": prev.index,
            })
        prev = e
    return issues


def shift_overlaps(entries: list[SrtEntry]) -> tuple[list[SrtEntry], list[dict]]:
    """Auto-fix overlapping timelines by code (no LLM).

    Scan the SRT in line order and fix both directions of an overlap:
    - if a line's END time is LATER than the following line's START time,
      clamp its end back to the following line's start (shorten the current
      line) so a subtitle never bleeds into the one after it;
    - if a line's START time is EARLIER than the previous line's END time,
      push its start forward to the previous line's end (delay the current
      line) so every line starts after the one before it ends.
    Returns (fixed_entries, fixes).
    """
    fixes: list[dict] = []
    fixed = [e.model_copy(deep=True) for e in entries]
    for i in range(len(fixed)):
        cur = fixed[i]
        # Clamp end to the following line's start (skip if it would give the
        # current line a zero/negative duration).
        if i + 1 < len(fixed):
            nxt = fixed[i + 1]
            if cur.end > nxt.start and nxt.start > cur.start:
                new_end = nxt.start
                fixes.append({
                    "index": cur.index,
                    "from": f"{cur.startLabel} --> {cur.endLabel}",
                    "to": f"{cur.startLabel} --> {_fmt(new_end)}",
                })
                cur.end = new_end
                cur.endLabel = _fmt(new_end)
        # Push start past the previous line's end.
        if i > 0:
            prev = fixed[i - 1]
            if cur.start < prev.end:
                new_start = prev.end
                fixes.append({
                    "index": cur.index,
                    "from": f"{cur.startLabel} --> {cur.endLabel}",
                    "to": f"{_fmt(new_start)} --> {cur.endLabel}",
                })
                cur.start = new_start
                cur.startLabel = _fmt(new_start)
    return fixed, fixes


def fix_timeline(entries: list[SrtEntry]) -> tuple[list[SrtEntry], list[dict]]:
    """Auto-fix illogical timelines.

    Pass 1: give every negative/zero-duration entry a minimum length.
    Pass 2: sort by start time; for overlaps:
      - if the two texts are similar (>= 80%) -> merge, keeping the longest
        text and the union span (same rule as sub merge),
      - otherwise -> trim the previous entry's end to the next entry's start
        so both subtitles survive.
    Returns (fixed_entries, list of fixes applied).
    """
    fixes: list[dict] = []
    fixed = [e.model_copy(deep=True) for e in entries]

    # Pass 1: fix negative/zero durations
    for i, e in enumerate(fixed):
        if e.end <= e.start:
            nxt_start = fixed[i + 1].start if i + 1 < len(fixed) else None
            if nxt_start is not None and nxt_start - e.start > 0.05:
                new_end = min(e.start + MIN_SRT_DURATION, nxt_start)
            else:
                new_end = e.start + MIN_SRT_DURATION
            fixes.append({
                "index": e.index,
                "type": "negative_duration",
                "from": f"{e.startLabel} --> {e.endLabel}",
                "to": f"{_fmt(e.start)} --> {_fmt(new_end)}",
            })
            e.end = new_end
            e.endLabel = _fmt(new_end)

    # Pass 2: sort by start, resolve overlaps
    fixed.sort(key=lambda e: (e.start, e.end))
    merged: list[SrtEntry] = []
    for e in fixed:
        if merged and e.start < merged[-1].end:
            prev = merged[-1]
            if _texts_similar(prev.text, e.text):
                # Same content -> merge, keep longest text + union span
                merged_end = max(prev.end, e.end)
                fixes.append({
                    "index": e.index,
                    "type": "overlap",
                    "from": f"#{prev.index} + #{e.index}",
                    "to": f"#{prev.index} --> {_fmt(prev.start)} --> {_fmt(merged_end)}",
                })
                if len(e.text) >= len(prev.text):
                    prev.text = e.text
                prev.end = merged_end
                prev.endLabel = _fmt(merged_end)
            else:
                # Different content -> trim prev end so both survive
                new_end = e.start
                if new_end <= prev.start:
                    new_end = min(prev.start + MIN_SRT_DURATION, e.end)
                fixes.append({
                    "index": prev.index,
                    "type": "overlap",
                    "from": f"#{prev.index} --> {_fmt(prev.end)}",
                    "to": f"#{prev.index} --> {_fmt(new_end)}",
                })
                prev.end = new_end
                prev.endLabel = _fmt(new_end)
        else:
            merged.append(e)

    out: list[SrtEntry] = []
    for i, e in enumerate(merged):
        out.append(SrtEntry(
            index=i + 1,
            start=e.start,
            end=e.end,
            startLabel=_fmt(e.start),
            endLabel=_fmt(e.end),
            text=e.text,
        ))
    return out, fixes
