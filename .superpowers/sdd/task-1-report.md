# Task 1 Report: Helper chuẩn hoá ranges + `_mix_background_with_keep_ranges`

**Status:** DONE

## What changed

Modified **only** `backend/app/services/dub_service.py`, adding two pure helper functions verbatim from `.superpowers/sdd/task-1-brief.md`:

1. `_normalize_keep_ranges(ranges, duration: float) -> list[tuple[float, float]]`
   - Accepts dicts with `"start"`/`"end"` keys (or None), coerces to float, skips malformed entries (`AttributeError/TypeError/ValueError`).
   - Clamps start ≥ 0, clamps end ≤ duration (when duration > 0), drops segments < 0.05s.
   - Sorts and merges overlapping / near-adjacent segments (gap < 0.05s).
   - Caps result at 200 ranges.

2. `_mix_background_with_keep_ranges(instrumental, original_wav, ranges, out_path) -> Path`
   - Empty `ranges` → returns `instrumental` unchanged.
   - Coverage ≥ 98% of audio duration → returns `original_wav` unchanged.
   - Otherwise runs FFmpeg: mutes the original wav (`volume=0`) except inside `between(t,start,end)` enable windows, then `amix` with the Demucs instrumental (`duration=first`, `normalize=0`), AAC 192k → `out_path`.
   - FFmpeg invocation goes through the existing module-level helper `_run_ffmpeg` (no re-import); duration via existing imported `_get_audio_duration`.

## Exact insertion location

Inserted between `_mix_background_with_voice` and `_db_to_volume`:
- Before edit: `_mix_background_with_voice` ended at line 292 (`return out_path`); `def _db_to_volume` started at line 295.
- After edit: new functions occupy lines **295–352** (`_normalize_keep_ranges` at 295–315, `_mix_background_with_keep_ranges` at 318–352); `def _db_to_volume` now starts at line **356**.
- Diff stat: `@@ -292,6 +292,65 @@` — 59 added lines, 0 removed lines.

No other files were modified. (Working tree also contains pre-existing unrelated diffs — `.superpowers/sdd/task-1-brief.md`, `frontend/.env.local`, dirty `youtubeuploader` submodule — untouched by this task.) No test files created, no git commit performed, per repo rules.

## Verification

Command:
```
cd backend && .venv/bin/python -m py_compile app/services/dub_service.py
```

Output: *(none)* — exit code **0**, as expected.

## Self-review vs brief

Re-read `git diff backend/app/services/dub_service.py` line-by-line against the brief's code block:
- Function names, parameter lists/order, type hints, return types: identical.
- Logic (clamp/merge/cap thresholds 0.05s & cap 200; empty-ranges and ≥98% short-circuits; `volume=0:enable='...'` filter graph; amix params; aac 192k): identical.
- Uses existing helpers only — no new imports or redefinitions added.
