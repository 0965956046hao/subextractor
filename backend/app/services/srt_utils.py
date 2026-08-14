"""SRT parsing & formatting utilities (shared by multiple services)."""

from app.models import SrtEntry


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
