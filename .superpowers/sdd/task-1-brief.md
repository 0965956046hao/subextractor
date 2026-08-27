### Task 1: Backend — helper chuẩn hoá ranges + hàm trộn `_mix_background_with_keep_ranges`

**Files:**
- Modify: `backend/app/services/dub_service.py` (thêm 2 hàm sau `_mix_background_with_voice`, kết thúc ~dòng 277)

**Interfaces:**
- Produces:
  - `_normalize_keep_ranges(ranges: list | None, duration: float) -> list[tuple[float, float]]` — sort, gộp overlap/gần kề (<0.05s), clamp `[0, duration]`, bỏ đoạn <0.05s, cap 200.
  - `_mix_background_with_keep_ranges(instrumental: Path, original_wav: Path, ranges: list[tuple[float,float]], out_path: Path) -> Path` — trả về path nền đã trộn; nếu `ranges` rỗng trả `instrumental`; nếu phủ ≥98% duration trả `original_wav`.

- [ ] **Step 1: Thêm 2 hàm vào `dub_service.py`**

Chèn ngay SAU hàm `_mix_background_with_voice` (sau dòng `return out_path` của nó, trước `def _db_to_volume`):

```python
def _normalize_keep_ranges(ranges, duration: float) -> list[tuple[float, float]]:
    """Sort + gộp overlap/gần kề, clamp theo duration, cap 200 đoạn."""
    cleaned: list[tuple[float, float]] = []
    for r in ranges or []:
        try:
            s = max(0.0, float(r.get("start", 0.0)))
            e = float(r.get("end", 0.0))
        except (AttributeError, TypeError, ValueError):
            continue
        if duration > 0:
            e = min(e, duration)
        if e - s < 0.05:
            continue
        cleaned.append((s, e))
    cleaned.sort()
    merged: list[tuple[float, float]] = []
    for s, e in cleaned:
        if merged and s <= merged[-1][1] + 0.05:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged[:200]


def _mix_background_with_keep_ranges(
    instrumental: Path,
    original_wav: Path,
    ranges: list[tuple[float, float]],
    out_path: Path,
) -> Path:
    """Nhạc nền Demucs + tiếng gốc chỉ bật trong `ranges` (volume-enable).

    Trả về path nền dùng cho bước mix với full_voice. ranges rỗng → dùng
    instrumental nguyên bản; phủ ≥98% video → dùng tiếng gốc nguyên bản.
    """
    if not ranges:
        return instrumental
    dur = _get_audio_duration(original_wav)
    covered = sum(e - s for s, e in ranges)
    if dur > 0 and covered >= dur * 0.98:
        return original_wav
    enable = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in ranges)
    fc = (
        f"[1:a]volume=0:enable='{enable}'[kept];"
        "[0:a][kept]amix=inputs=2:duration=first:normalize=0[out]"
    )
    cmd = [
        "ffmpeg", "-y",
        "-i", str(instrumental),
        "-i", str(original_wav),
        "-filter_complex", fc,
        "-map", "[out]",
        "-c:a", "aac", "-b:a", "192k",
        str(out_path),
    ]
    _run_ffmpeg(cmd)
    return out_path
```

- [ ] **Step 2: Verify syntax**

Run: `cd backend && .venv/bin/python -m py_compile app/services/dub_service.py`
Expected: exit 0, không output.

---

