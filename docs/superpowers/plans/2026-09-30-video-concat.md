# Video Concat (Merge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge videos at push time (before pipeline) or after pipelines finish (plus ad-hoc merge/upload of done videos).

**Architecture:** New backend `video_concat` router (thread job like `video_merge.py`: POST start → GET status → download; output registered as a real `videos/{id}/` entry). Frontend: batch-bar merge-mode select, `addMergedPipeline` reusing the existing FE resolve→merge→import trio per URL, `batchId` + completion watcher + group UI for merge-after, checkboxes on done lists for ad-hoc merge/YouTube upload.

**Tech Stack:** FastAPI + threading (mirror `video_merge.py`), FFmpeg concat (scale/pad to max W×H, fps 30, AAC), Next.js + zustand (`pipeline-store.ts`, `AutoPipeline.tsx`), existing i18n dicts.

**Spec:** approved in chat 2026-09-30 (3 modes at push: no/before/after + ad-hoc merge/upload on done lists; merge modes require a preset; failures skip with note; no commits).

## Global Constraints

- KHÔNG tự động commit (repo rule — tasks end at verify, no commit steps).
- Repo has no tests/linters/formatters/CI. Verify with: backend `python -m py_compile` (or import check) + frontend `npm run typecheck` in `frontend/` + manual end-to-end (note: 3 pre-existing `DubRetryModal.tsx` type errors on BASE are out of scope, do not touch).
- New UI copy goes through `frontend/src/lib/i18n.tsx` BOTH dicts (`Dict` derives from `vi`).
- Reuse design-system classes (`double-bezel`, `btn-island-*`, `tag`); no ad-hoc styling.
- Never break existing flows: single resolve→merge→import, OCR worker, pipeline runner, YouTube upload.

---

### Task 1: Backend `POST /api/video-concat` job + download

**Files:**
- Create: `backend/app/routers/video_concat.py`
- Modify: `backend/app/main.py` (add `include_router` next to `video_merge`, ~line 130)

**Interfaces:**
- Consumes: `settings.temp_dir`, `media_utils` resolvers (read `download_hardcoded`/`download_exported` in `routers/tools.py:1709-1725,2503-2515` + `media_utils._hardcoded_is_complete` to reuse canonical artifact lookup — hardcoded `*_hardcoded.mp4` preferred, else `exported/exported.mp4`; raw = `_original_video_path`), job pattern from `routers/video_merge.py:26,542-593` (`_merge_jobs` dict, POST→thread→GET status→FileResponse download).
- Produces:
  - `POST /api/video-concat {video_ids: string[], artifact: "raw"|"result", name?: string}` → `{concat_id}`
  - `GET /api/video-concat/{concat_id}` → `{concat_id, status, stage, progress, url, filename, video_id, error, logs}`
  - `GET /api/video-concat/{concat_id}/download` → FileResponse merged mp4
  - New registered entry `videos/{new_id}/video.mp4` + `meta.json {filename, origin: "concat"}` so it appears in library; status done also returns `video_id`.

- [ ] **Step 1: Write `video_concat.py`**

```python
import logging, shutil, subprocess, threading, time, uuid
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from app.config import settings
from app.services import media_utils

logger = logging.getLogger(__name__)
router = APIRouter()
_concat_jobs: dict[str, dict] = {}


class ConcatRequest(BaseModel):
    video_ids: list[str]
    artifact: str = "raw"  # "raw" | "result"
    name: str = ""


def _resolve_input(video_id: str, artifact: str) -> Path:
    if artifact == "result":
        hd_dir = settings.temp_dir / "hardcoded" / video_id
        hds = sorted(hd_dir.glob("*_hardcoded.mp4")) if hd_dir.exists() else []
        if hds and media_utils._hardcoded_is_complete(video_id):
            return hds[0]
        exp = settings.temp_dir / "exported" / video_id / "exported.mp4"
        # NOTE: verify exact exported path against routers/tools.py download_exported before finalizing
        if exp.exists():
            return exp
        raise FileNotFoundError(f"No finished result for {video_id}")
    p = media_utils._original_video_path(video_id)
    if not p.exists():
        raise FileNotFoundError(f"No source video for {video_id}")
    return p
```

  Then: `_run_concat(concat_id, video_ids, artifact, name)` in a daemon thread — per input ffprobe W×H + fps (`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate`), target = max W×H (even), fps 30; ffmpeg with N inputs + `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p` per input + `concat=n=N:v=1:a=1` + `aac 192k` + `+faststart`; progress = done_inputs/N*90 → 100; on done register `videos/{new_id}/` (`video.mp4` copy + `meta.json`), set `job["video_id"]`, `job["url"] = f"/api/video-concat/{concat_id}/download"`. On error set status error + message, cleanup partials. Cap: `len(video_ids)` 2..50, else 400.
  - Verified Task 1 findings (do NOT re-derive): exported path is singular `temp/export/{video_id}/exported.mp4`; `_original_video_path()` RAISES FileNotFoundError (wrap try/except); mixed-audio inputs (some without audio) go video-only + job-log note (deliberate: `a=1` hard-fails otherwise); new entry lists under library bucket `extract` — do not filter `GET /api/videos` on `origin=="concat"`.

- [ ] **Step 2: Register router in `main.py`** next to `video_merge.router`.

- [ ] **Step 3: Verify**

Run: `python -m py_compile backend/app/routers/video_concat.py` from repo root.
Expected: no output (compiles). Then manual: start backend, POST 2 small `videos/*` ids artifact raw, poll GET till done, GET download returns mp4, new id appears in `GET /api/videos`.

---

### Task 2: Frontend API helpers + store batch fields

**Files:**
- Modify: `frontend/src/lib/api.ts` (append helpers), `frontend/src/stores/pipeline-store.ts` (Pipeline.batchId?, BatchMerge state)

**Interfaces:**
- Consumes: Task 1 endpoints; existing `addPipeline`/`addPipelineFromUpload` signatures (read them first — `pipeline-store.ts` `addPipeline` ~line 503, `addPipelineFromUpload` ~line 570); zustand `persist` `partialize` (~line 1256, currently `{ pipelines }`).
- Produces:
  - `startConcat(videoIds: string[], artifact: "raw"|"result", name?: string): Promise<{concat_id: string}>`
  - `getConcatStatus(id): Promise<{status, stage, progress, url, video_id, error, logs}>`
  - `pollConcatJob(id, onTick)` mirroring `pollJob` (~line 1328)
  - `Pipeline.batchId?: string | null`
  - `BatchMerge {id, batchId, name, videoIds, status: "running"|"done"|"error", progress, resultUrl, videoId, error}`
  - store: `batchMerges: BatchMerge[]`, `addBatchMerge`, `updateBatchMerge`, persist includes `batchMerges`.

- [ ] **Step 1: api.ts helpers** (copy `pollJob` shape, endpoint `/api/video-concat`, download URL passthrough `/api/video-concat/{id}/download`).

- [ ] **Step 2: store fields** — add `batchId: null` default in `newPipeline` (~line 412), `BatchMerge` interface + state + updaters, extend persist `partialize` to `{ pipelines, batchMerges }`. Do NOT change persist `name`/`version`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck` in `frontend/`.
Expected: PASS except the 3 known pre-existing `DubRetryModal.tsx` errors.

---

### Task 3: Merge-before (gộp trước) end-to-end

**Files:**
- Modify: `frontend/src/stores/pipeline-store.ts` (`addMergedPipeline`), `frontend/src/app/channels/page.tsx` (batch-bar mode select), `frontend/src/lib/i18n.tsx` (both dicts)

**Interfaces:**
- Consumes: Task 2 helpers; the FE resolve→merge→import trio — read `runPrep` (`pipeline-store.ts` ~1590-1910) and extract its per-URL resolve/merge/import calls into a local `resolveUrlToVideoId(url): Promise<videoId>` used by the new flow (do NOT alter `runPrep` itself); `addPipelineFromUpload`-style start-at-region (new video already registered → start at step 2 like `addPipelineFromUpload` ~line 570 does with `runPrep(id, 2)`).
- Produces: `addMergedPipeline(urls: string[], presetConfig: Record<string, unknown> | null, label: string)` — resolves each URL sequentially (skip failures with counted note), requires ≥2 successes else error entry, `startConcat(ids, "raw")` + poll, then creates ONE pipeline on the merged `video_id` (title = label, preset applied or manual defaults), `router.push("/auto")` left to caller. Batch bar: mode select Không gộp/Gộp trước/Gộp sau (merge modes disabled unless a preset is chosen — except explicit "no preset" is NOT allowed for merge: show hint `channel.mergeNeedsPreset`).

- [ ] **Step 1: `addMergedPipeline` + shared `resolveUrlToVideoId`** in pipeline-store.

- [ ] **Step 2: batch-bar UI** — replace/augment preset row with mode select (radio or select, your call — keep `btn-island` styling), wire: mode after → existing `addPipeline` loop + `batchId` (Task 4 consumes); mode before → `addMergedPipeline`; mode none → current behavior. Cross-collection popup stays for none/after; for before, same popup decides shared preset vs per-video-manual (manual = defaults, single merged pipeline still).

- [ ] **Step 3: i18n** (`channel.mergeMode`, `channel.mergeNone/Before/After`, `channel.mergeNeedsPreset`, `channel.mergeFailedCount`) en+vi.

- [ ] **Step 4: Verify** — typecheck + manual: select 2 same-playlist videos + preset, Gộp trước → one pipeline runs on merged video; failures skip with note.

---

### Task 4: Merge-after (gộp sau) + ad-hoc done-list merge/upload

**Files:**
- Modify: `frontend/src/stores/pipeline-store.ts` (batch watcher), `frontend/src/components/AutoPipeline.tsx` (batch group UI + done-list selection), `frontend/src/lib/i18n.tsx`

**Interfaces:**
- Consumes: Task 2–3 (`batchId`, `BatchMerge`, `pollConcatJob`, existing `uploadYoutubeNow` ~line 1206 + `pollYoutubeUpload` ~1547 + `POST /api/youtube/upload/{videoId}` query shape from `uploadYoutubeNow` ~1218-1228); `runPipeline` completion point (~line 2535 `finishedAt`) — hook `checkBatchComplete(batchId)` right after a pipeline reaches done/error.
- Produces:
  - `checkBatchComplete(batchId)`: if no sibling with status queued/running/paused → collect done siblings' `videoId`s (skip failures, note count) → if ≥2 create `BatchMerge running` → `startConcat(ids, "result")` + poll → update done (resultUrl = concat download, videoId) or error. Runs once (guard flag per batchId).
  - AutoPipeline: group active+done pipelines by `batchId` (collapsible header: name, counts, merged result link when done, per-child rows reused); done lists (pipelines + `historyVideosDone`) get checkboxes (`selectedDone: Set<videoId>` local state) + action row: **Gộp** (concat result → new BatchMerge shown in a "File gộp" section with download) and **Up YouTube** (sequential per-video upload reusing the `/api/youtube/upload/{id}` + poll flow, per-item ok/fail summary; skip videos already uploading).
  - i18n: `channel.mergeSelected`, `channel.uploadSelected`, `channel.mergedFiles`, `channel.batchGroup`, `channel.mergeSkipped`, `pipeline.batchDone` etc. en+vi.

- [ ] **Step 1: watcher + BatchMerge lifecycle** in pipeline-store.

- [ ] **Step 2: AutoPipeline UI** — batch groups + done checkboxes + merge/upload actions.

- [ ] **Step 3: i18n + verify** — typecheck + manual: (a) push 2 videos mode Gộp sau → both finish → merged file appears; (b) tick 2 done videos → Gộp → download works; (c) tick 1 done video → Up YouTube → uploads with summary; (d) single-video flows untouched.

---

## Self-Review

- [x] Spec coverage: 3 push modes (§A) → Tasks 2–4; ad-hoc merge/upload (§B) → Task 4; shared endpoint → Task 1; preset-required-for-merge → Tasks 3–4 UI; skip-failures + persist + no-break-existing → Global Constraints + Task 4/2.
- [x] Placeholder scan: every step names exact files/lines/values; the two honest unknowns are flagged inline (exported path must be verified against `tools.py`; `resolveUrlToVideoId` extraction points at `runPrep` lines to read).
- [x] Type consistency: `BatchMerge`/`batchId`/`artifact` names fixed in Task 2 and reused verbatim in 3–4; endpoint shapes fixed in Task 1 and consumed verbatim in 2–4.
