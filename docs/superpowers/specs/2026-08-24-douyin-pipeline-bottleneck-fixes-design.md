# Douyin Pipeline Bottleneck Fixes — Design

**Date:** 2026-08-24
**Status:** Approved by user

## Context

Traced the full Douyin pipeline (link → resolve → merge → import → OCR → context → translate → dub → hardcode → meta → thumbnail → YouTube upload) and identified bottlenecks, including file waste. This spec covers the agreed fixes.

## Fixes

### Backend

#### B1 — Remove `dubbed_video.mp4` from the dub step
- `backend/app/services/dub_service.py` — `dub_audio_only()`: remove the FFmpeg mux block (creates `tts/{id}/dubbed_video.mp4`). Just `return build_full_audio(...)` which yields `full_audio.m4a`.
- Remove now-unused imports (`_get_video_resolution`, `target_dims_min1080`).
- Unlink any stale `dubbed_video.mp4` left by previous runs.
- No endpoint serves `dubbed_video.mp4`; `GET /api/download/dubbed` and `preview/dubbed` already serve `full_audio.m4a`.

#### B2 — Delete `vocals.wav` + `audio.wav` after Demucs
- `separate_instrumental()`: after Demucs succeeds, delete the extracted input `audio.wav` (`wav_path.unlink`).
- `build_full_audio()`: at the end (after any `generate_voice_map` that prefers `vocals.wav`), delete `separated/htdemucs/audio/vocals.wav`.
- `generate_voice_map` falls back to merged audio if `vocals.wav` is gone.

#### B3 — Context images: only copy `thumbnail.jpg`
- `backend/app/routers/video_merge.py` `import_video()`: the `merge_id` branch currently copies **all** files from `merged/{merge_id}_context/` into `context/{video_id}/`. `_context_image_paths()` reads `context_images` directly from the merge dir, so copying `context_images` is redundant. Copy only `thumbnail.jpg`.

#### B4 — Delete `diarization_input.wav` after use
- `backend/app/services/translation_service.py` `generate_voice_map()`: after `delete_gemini_file(audio_uri)`, unlink the local `audio_path` (`diarization_input.wav`).

#### B5 — Remove dead dir `hardcode`
- `backend/app/config.py`: remove `(settings.temp_dir / "hardcode").mkdir(exist_ok=True)`. Keep `tts_preview` (used by google_tts.py / capcut.py).

#### B6 — `import-video` (no change)
- FastAPI runs sync endpoints in a threadpool → not event-loop-blocking. Documented; no refactor to avoid risk.

#### B7 — Add `STE_job_workers` config
- `config.py`: `job_workers: int = 1` (env `STE_JOB_WORKERS`).
- `worker.py`: `_executor = ThreadPoolExecutor(max_workers=max(1, settings.job_workers))`.
- `main.py` lifespan: spawn `settings.job_workers` `worker_loop` tasks (a single consumer loop is what serializes jobs; executor size alone is not enough). Cancel all on shutdown.
- Default 1 → unchanged behavior.

### Frontend

#### F1 — Merge resolve + thumbnail into one Chrome session
- `frontend/src/app/api/video-download/resolve/route.ts`: add a `page.on("response")` listener for `/aweme/v1/web/aweme/detail/` to extract `thumbnail` (prefer `lk3s`) and `bigThumbs` (same logic as the thumbnail route). After media URLs are captured, wait up to ~5s for the detail response. Return `{ urls, video_url, audio_url, title, thumbnail, bigThumbs }`.
- `frontend/src/stores/pipeline-store.ts` `runPrep()`: drop the separate `/api/video-download/thumbnail` call; use `rd.thumbnail` / `rd.bigThumbs` from the resolve response. Keep the thumbnail route file (other callers may exist).

#### F2 — Run Meta + Thumbnail steps in parallel
- `runPipeline()`: wrap step 9 (meta) and step 10 (thumbnail) bodies in local `doMeta()` / `doThumbnail()` async functions and `await Promise.all([doMeta(), doThumbnail()])`. Keep the per-step `markStepStart`/`markStepEnd`.

#### F3 — Drop second `runSrtAutoChecks`
- Remove the `runSrtAutoChecks(id, videoId)` call after translate in step 6. The original SRT is already deduped + overlap-fixed after OCR; translation preserves the 1:1 timeline.

#### F4 — Cache `ensureVoiceMap`
- Add a module-level `Set<string>` of video_ids already ensured in this session; skip the GET when present, add on success.

#### F5 — Merge double `GET /api/download/translated`
- In step 6, replace the existence-check fetch + content fetch with a single fetch: `ok` → exists (read text); `!ok` → treat as missing.

#### F6 — Thumbnail fal.ai deadline
- Bump the hard 100s poll deadline to 180s in the fal.ai thumbnail step.

#### F7 — Polling (no change)
- Kept as chosen.

## Verification
- `python -m py_compile` on changed backend files.
- `cd frontend && npm run typecheck` (tsc --noEmit).
- Manual smoke test of the Dub step (no `dubbed_video.mp4` created, `full_audio.m4a` intact).
