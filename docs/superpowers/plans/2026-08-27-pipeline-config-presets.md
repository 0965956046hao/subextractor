# Pipeline Config Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users save a finished pipeline's full configuration under a name, then reload that preset before starting a new pipeline (prefilling all option fields and seeding OCR-region / subtitle-style / watermark-region so the matching interactive steps are skipped).

**Architecture:** Presets are stored in `temp/user_config.json` (`pipeline_presets` array) via new endpoints in `config_router.py`. The frontend loads them into a `<select>` in the config section and (after a run completes) exposes a save panel next to the download buttons. Seeding works for free: `runPipeline`/`runPrep` already skip the region, subtitle-preview, and watermark-region steps when `p.region` / `p.subtitleStyle` / `p.removeWatermarkRegions` are already populated (see `??` at pipeline-store.ts:1890, `if (!style)` at :1913, `if (length === 0)` at :2142). So the plan only threads the seeded values through `newPipeline` — no `runPipeline` control-flow edits are needed.

**Tech Stack:** FastAPI (pydantic-settings backend), Next.js 14 + TypeScript + Tailwind; axios instance in `frontend/src/lib/api.ts`; Zustand store `frontend/src/stores/pipeline-store.ts`.

## Global Constraints

- **No test framework, no linter, no CI** in this repo (AGENTS.md). Verification = `py_compile` for backend and `tsc --noEmit` for frontend; plus a manual smoke test described per task. Do NOT write unit tests.
- **No git commits / no git commands** (AGENTS.md + explicit user instruction). Leave all changes in the working tree.
- **`ocrType` is intentionally EXCLUDED** from presets: the auto-pipeline has no `ocrType` UI control and `detectOcrType()` auto-selects the engine. There is no stored field to restore, so saving/loading it is dead config. The `PresetConfig` shape, `applyPreset`, and `collectCurrentConfig` must NOT reference `ocrType`.
- Backend config file: `temp/user_config.json`, read/written via existing `_read_config()` / `_write_config()` in `config_router.py`. New key `pipeline_presets` (array).
- Backend route prefix: `API_CONFIG_PREFIX = "/api/config"` (registered in worker.py). Frontend axios baseURL is `/api`, so frontend paths are `/config/...`.
- Copy/UI strings follow existing bilingual (en/vi) i18n; add keys under `preset.*` in both locale files.
- Do NOT touch the stale prototype files at `backend/` root (backend/main.py, etc.). Only edit under `backend/app/`.

---

## File Structure

- `backend/app/routers/config_router.py` — add `PipelinePresetCreate` model + `GET/POST/DELETE /api/config/pipeline-presets` + include `pipeline_presets` in `GET /api/config`.
- `frontend/src/lib/api.ts` — add `PipelinePreset` type + `getPipelinePresets` / `createPipelinePreset` / `deletePipelinePreset` wrappers.
- `frontend/src/stores/pipeline-store.ts` — extend `addPipeline` / `addPipelineFromUpload` input interfaces + `newPipeline` to accept & store seeded `region`, `subtitleStyle`, `removeWatermarkRegions`, `removeWatermarkEnabled`. (No `runPipeline` edits.)
- `frontend/src/components/AutoPipeline.tsx` — preset `<select>` + delete button + `applyPreset` + `presetSeed` state; thread seeded values into `handleAdd` / `handleStartUpload`; mount `PipelineSavePanel` in the done/result area.
- `frontend/src/components/PipelineSavePanel.tsx` (new) — `collectCurrentConfig(p)` + save UI (name input) + `createPipelinePreset` call.
- `frontend/src/i18n/*.json` (or current i18n source) — add `preset.*` strings (en + vi).

---

### Task 1: Backend — pipeline_presets endpoints

**Files:**
- Modify: `backend/app/routers/config_router.py`

**Interfaces:**
- Produces: `GET /api/config/pipeline-presets` → `{presets: [...]}`; `POST /api/config/pipeline-presets` (body `{name, config}`) → `{id, name}`; `DELETE /api/config/pipeline-presets/{id}` → `{status, removed}`; `GET /api/config` now includes `pipeline_presets`.
- Consumes: existing `_read_config()`, `_write_config()`, `uuid` (already imported), `HTTPException` (already imported).

- [ ] **Step 1: Add `datetime` import**

At the top of `config_router.py`, alongside `import uuid`, add:
```python
from datetime import datetime
```

- [ ] **Step 2: Add the preset model + endpoints**

Append near the other config models/routers (after the `SubtitleStyleUpdate` / config GET block):
```python
class PipelinePresetCreate(BaseModel):
    name: str = ""
    config: dict = {}

@router.get("/api/config/pipeline-presets")
async def list_pipeline_presets():
    cfg = _read_config()
    return {"presets": cfg.get("pipeline_presets") or []}

@router.post("/api/config/pipeline-presets")
async def create_pipeline_preset(body: PipelinePresetCreate):
    cfg = _read_config()
    presets = cfg.setdefault("pipeline_presets", [])
    preset_id = f"pp_{uuid.uuid4().hex[:8]}"
    name = (body.name or "").strip() or f"Preset {len(presets) + 1}"
    preset = {
        "id": preset_id,
        "name": name,
        "config": body.config if isinstance(body.config, dict) else {},
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    presets.append(preset)
    _write_config(cfg)
    return {"id": preset_id, "name": name}

@router.delete("/api/config/pipeline-presets/{preset_id}")
async def delete_pipeline_preset(preset_id: str):
    cfg = _read_config()
    presets = cfg.get("pipeline_presets") or []
    new = [p for p in presets if p.get("id") != preset_id]
    if len(new) == len(presets):
        raise HTTPException(status_code=404, detail="Preset not found")
    cfg["pipeline_presets"] = new
    _write_config(cfg)
    return {"status": "ok", "removed": True}
```

- [ ] **Step 3: Include `pipeline_presets` in `GET /api/config`**

In the `get_config` function (the `return` dict near line 211 that already includes `"subtitle_style": ...`), add this key:
```python
        "pipeline_presets": cfg.get("pipeline_presets") or [],
```

- [ ] **Step 4: Verify compile**
Run: `cd backend && .venv/bin/python -m py_compile app/routers/config_router.py`
Expected: no output, exit 0.

- [ ] **Step 5: Smoke test (manual, no git)**
Start backend (`uvicorn app.main:app --reload --port 8000`), then:
```bash
curl -X POST localhost:8000/api/config/pipeline-presets -H 'content-type: application/json' -d '{"name":"Test","config":{"srcLang":"zh","translateOn":true}}'
curl localhost:8000/api/config/pipeline-presets
```
Expected: first returns `{"id":"pp_...","name":"Test"}`; second returns `{"presets":[{"id":"pp_...","name":"Test","config":{"srcLang":"zh","translateOn":true},"created_at":"..."}]}`. Then delete it:
```bash
curl -X DELETE localhost:8000/api/config/pipeline-presets/pp_XXXX
```

---

### Task 2: Frontend api.ts — wrappers + type

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: axios instance `api` (already exported).
- Produces: `PipelinePreset` type; `getPipelinePresets()`, `createPipelinePreset()`, `deletePipelinePreset()`.

- [ ] **Step 1: Add type + wrappers**

Append after the existing `getConfig`/`updateConfig` helpers (mirror their `/config` path style):
```ts
export interface PipelinePreset {
  id: string;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
}

export async function getPipelinePresets(): Promise<{ presets: PipelinePreset[] }> {
  const res = await api.get<{ presets: PipelinePreset[] }>("/config/pipeline-presets");
  return res.data;
}

export async function createPipelinePreset(
  name: string,
  config: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await api.post<{ id: string; name: string }>("/config/pipeline-presets", {
    name,
    config,
  });
  return res.data;
}

export async function deletePipelinePreset(id: string): Promise<{ status: string }> {
  const res = await api.delete<{ status: string }>(`/config/pipeline-presets/${id}`);
  return res.data;
}
```

- [ ] **Step 2: Verify typecheck**
Run: `cd frontend && npx tsc --noEmit`
Expected: no errors referencing the new symbols.

---

### Task 3: Store — seed region / subtitleStyle / watermark regions through `newPipeline`

**Files:**
- Modify: `frontend/src/stores/pipeline-store.ts`

**Interfaces:**
- Consumes: existing `Region`, `SubtitleStyle` types (already imported into the store).
- Produces: `addPipeline(...)` and `addPipelineFromUpload(...)` now accept optional `region`, `subtitleStyle`, `removeWatermarkRegions`, `removeWatermarkEnabled`; `newPipeline` stores them. `runPipeline`/`runPrep` already skip the matching interactive steps when these are set, so no further store edits are required.

- [ ] **Step 1: Extend the `addPipeline` input interface**

Find the `addPipeline: (` interface block (around line 226). Add four optional fields (keep them grouped after the existing `removeWatermarkRegions?`/`removeWatermarkEnabled?` already present):
```ts
    region?: Region | null;
    subtitleStyle?: SubtitleStyle | null;
    removeWatermarkRegions?: Region[];
    removeWatermarkEnabled?: boolean;
```

- [ ] **Step 2: Extend the `addPipelineFromUpload` input interface**

Find the `addPipelineFromUpload: (` interface block (around line 248). Add the same four optional fields in the same position:
```ts
    region?: Region | null;
    subtitleStyle?: SubtitleStyle | null;
    removeWatermarkRegions?: Region[];
    removeWatermarkEnabled?: boolean;
```

- [ ] **Step 3: Extend `newPipeline` signature + body**

In `newPipeline` (signature around line 396), add two params after the existing `removeWatermark*` params:
```ts
  region: Region | null = null,
  subtitleStyle: SubtitleStyle | null = null,
```
(leave the existing `removeWatermarkRegions: Region[] = []` and `removeWatermarkEnabled = false` as-is).

In the returned `Pipeline` object, change the two hardcoded `null`s to use the params:
- `region: null,` → `region,`
- `subtitleStyle: null,` → `subtitleStyle,`

(`removeWatermarkRegions: removeWatermarkRegions` and `removeWatermarkEnabled` are already wired to the params.)

- [ ] **Step 4: Verify typecheck**
Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (the new params are optional, so existing callers compile).

---

### Task 4: AutoPipeline — preset select, applyPreset, delete, and seed wiring

**Files:**
- Modify: `frontend/src/components/AutoPipeline.tsx`

**Interfaces:**
- Consumes: `getPipelinePresets`, `deletePipelinePreset`, `PipelinePreset` (Task 2); the store's `addPipeline`/`addPipelineFromUpload` extended in Task 3; the existing setters `setSrcLang, setTranslateOn, setTranslateTarget, setDubOn, setDubEngine, setVoiceLang, setDubVoice, setMuteOriginal, setKeepOriginalEnabled, setOriginalGainDb, setMultiVoice, setAutoFitSubs, setWatermarkOn, setWatermarkPreset, setRemoveWmEnabled, setCheckSubs, setCheckVoice, setUseFalThumbnail, setUseGptThumbnail, setAutoUploadYoutube, setRegionMode` (all confirmed present at lines 271-317).
- Produces: `presetId`/`presets`/`presetSeed` state; `applyPreset(cfg)`; preset `<select>` + delete button in the config section; `handleAdd`/`handleStartUpload` pass seeded values.

- [ ] **Step 1: Add state + load presets on mount**

Near the other `useState` declarations (after line ~317, the `ocrType`/lang states), add:
```ts
  const [presetId, setPresetId] = useState<string>("");
  const [presets, setPresets] = useState<PipelinePreset[]>([]);
  const [presetSeed, setPresetSeed] = useState<{
    region: Region | null;
    subtitleStyle: SubtitleStyle | null;
    removeWatermarkRegions: Region[];
    removeWatermarkEnabled: boolean;
  } | null>(null);

  useEffect(() => {
    getPipelinePresets()
      .then((r) => setPresets(r.presets))
      .catch(() => setPresets([]));
  }, []);
```
Ensure `useEffect`, `Region`, `SubtitleStyle`, `PipelinePreset` are imported (`Region`/`SubtitleStyle` come from `pipeline-store` or `@/lib/api` — use the same imports already present in the file).

- [ ] **Step 2: Add `applyPreset`**

Define inside the component (near `handleAdd`):
```ts
  const applyPreset = (cfg: Record<string, unknown>) => {
    if (typeof cfg.srcLang === "string") setSrcLang(cfg.srcLang);
    if (typeof cfg.regionMode === "string") setRegionMode(cfg.regionMode as "manual" | "auto");
    if (typeof cfg.translateOn === "boolean") setTranslateOn(cfg.translateOn);
    if (typeof cfg.translateTarget === "string") setTranslateTarget(cfg.translateTarget);
    if (typeof cfg.dubOn === "boolean") setDubOn(cfg.dubOn);
    if (typeof cfg.dubEngine === "string") setDubEngine(cfg.dubEngine as any);
    if (typeof cfg.voiceLang === "string") setVoiceLang(cfg.voiceLang);
    if (typeof cfg.dubVoice === "string") setDubVoice(cfg.dubVoice);
    if (typeof cfg.muteOriginal === "boolean") setMuteOriginal(cfg.muteOriginal);
    if (typeof cfg.keepOriginalEnabled === "boolean") setKeepOriginalEnabled(cfg.keepOriginalEnabled);
    if (typeof cfg.originalGainDb === "number") setOriginalGainDb(cfg.originalGainDb);
    if (typeof cfg.multiVoice === "boolean") setMultiVoice(cfg.multiVoice);
    if (typeof cfg.autoFitSubs === "boolean") setAutoFitSubs(cfg.autoFitSubs);
    if (typeof cfg.watermarkOn === "boolean") setWatermarkOn(cfg.watermarkOn);
    if (typeof cfg.watermarkPreset === "string") setWatermarkPreset(cfg.watermarkPreset as any);
    if (typeof cfg.removeWatermarkEnabled === "boolean") setRemoveWmEnabled(cfg.removeWatermarkEnabled);
    if (typeof cfg.checkSubs === "boolean") setCheckSubs(cfg.checkSubs);
    if (typeof cfg.checkVoice === "boolean") setCheckVoice(cfg.checkVoice);
    if (typeof cfg.useFalThumbnail === "boolean") setUseFalThumbnail(cfg.useFalThumbnail);
    if (typeof cfg.useGptThumbnail === "boolean") setUseGptThumbnail(cfg.useGptThumbnail);
    if (typeof cfg.autoUploadYoutube === "boolean") setAutoUploadYoutube(cfg.autoUploadYoutube);
    // Positional (seeded) — consumed by handleAdd/handleStartUpload, NOT by UI controls.
    setPresetSeed({
      region: (cfg.region as Region | null) ?? null,
      subtitleStyle: (cfg.subtitleStyle as SubtitleStyle | null) ?? null,
      removeWatermarkRegions: (cfg.removeWatermarkRegions as Region[]) ?? [],
      removeWatermarkEnabled:
        typeof cfg.removeWatermarkEnabled === "boolean"
          ? cfg.removeWatermarkEnabled
          : Array.isArray(cfg.removeWatermarkRegions) && cfg.removeWatermarkRegions.length > 0,
    });
  };
```

- [ ] **Step 3: Add the preset `<select>` + delete button in the config section**

In the config UI section (alongside the source-language / translate / dub controls, e.g. after the `regionMode` toggle block near line 1079), insert:
```tsx
                  <div className="flex items-center gap-2">
                    <select
                      className="btn-island flex-1"
                      value={presetId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setPresetId(id);
                        const p = presets.find((x) => x.id === id);
                        if (p) applyPreset(p.config);
                      }}
                    >
                      <option value="">{t("preset.select")}</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    {presetId && (
                      <button
                        type="button"
                        className="btn-island btn-island-icon"
                        title={t("preset.delete")}
                        onClick={async () => {
                          await deletePipelinePreset(presetId);
                          setPresets((prev) => prev.filter((x) => x.id !== presetId));
                          setPresetId("");
                          setPresetSeed(null);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
```
(The `t()` helper must already exist in the file; if the file uses a different i18n accessor, substitute it. Add keys `preset.select`, `preset.delete`.)

- [ ] **Step 4: Thread seeded values into `handleAdd` and `handleStartUpload`**

In `handleAdd` (around line 633) and `handleStartUpload` (around line 693) — the calls to `addPipeline` / `addPipelineFromUpload`. Add/override these four fields in the passed object:
```ts
        region: presetSeed?.region ?? null,
        subtitleStyle: presetSeed?.subtitleStyle ?? null,
        removeWatermarkRegions: presetSeed?.removeWatermarkRegions ?? [],
        removeWatermarkEnabled: presetSeed?.removeWatermarkEnabled ?? false,
```
For `handleStartUpload` the `removeWatermarkRegions`/`removeWatermarkEnabled` lines already exist — replace them with the `presetSeed`-aware versions above. (`region`/`subtitleStyle` are new.)

- [ ] **Step 5: Verify typecheck**
Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

---

### Task 5: PipelineSavePanel component

**Files:**
- Create: `frontend/src/components/PipelineSavePanel.tsx`

**Interfaces:**
- Consumes: `Pipeline` type (from `@/stores/pipeline-store`), `createPipelinePreset` (Task 2), i18n accessor used by the app.
- Produces: a component `PipelineSavePanel({ p, onSaved })` that renders a "Lưu cấu hình" button → name input → save; calls `createPipelinePreset` with `collectCurrentConfig(p)`.

- [ ] **Step 1: Implement the component**

```tsx
"use client";
import { useState } from "react";
import type { Pipeline } from "@/stores/pipeline-store";
import { createPipelinePreset } from "@/lib/api";

function collectCurrentConfig(p: Pipeline): Record<string, unknown> {
  return {
    srcLang: p.srcLang,
    regionMode: p.regionMode,
    translateOn: p.translateOn,
    translateTarget: p.translateTarget,
    dubOn: p.dubOn,
    dubEngine: p.dubEngine,
    voiceLang: p.voiceLang,
    dubVoice: p.dubVoice,
    muteOriginal: p.muteOriginal,
    keepOriginalEnabled: p.keepOriginalEnabled,
    originalGainDb: p.originalGainDb,
    multiVoice: p.multiVoice,
    autoFitSubs: p.autoFitSubs,
    watermarkOn: p.watermarkOn,
    watermarkPreset: p.watermarkPreset,
    removeWatermarkEnabled: p.removeWatermarkEnabled,
    checkSubs: p.checkSubs,
    checkVoice: p.checkVoice,
    useFalThumbnail: p.useFalThumbnail,
    useGptThumbnail: p.useGptThumbnail,
    autoUploadYoutube: p.autoUploadYoutube,
    region: p.region,
    subtitleStyle: p.subtitleStyle,
    removeWatermarkRegions: p.removeWatermarkRegions,
  };
}

export default function PipelineSavePanel({
  p,
  onSaved,
}: {
  p: Pipeline;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const t = (k: string) => k; // replace with real i18n accessor if the app uses one here

  if (!open) {
    return (
      <button
        type="button"
        className="btn-island btn-island-primary"
        onClick={() => setOpen(true)}
      >
        {t("preset.save")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="btn-island flex-1"
        placeholder={t("preset.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="button"
        className="btn-island btn-island-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await createPipelinePreset(name, collectCurrentConfig(p));
            setOpen(false);
            setName("");
            onSaved();
          } catch (e) {
            setErr(e instanceof Error ? e.message : "save failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("preset.confirm")}
      </button>
      {err && <span className="text-red-500 text-xs">{err}</span>}
    </div>
  );
}
```
If the app's i18n accessor differs from the `t` stub above, replace the stub with the project's real hook/function. Add keys `preset.save`, `preset.namePlaceholder`, `preset.confirm`.

- [ ] **Step 2: Verify typecheck**
Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (note: `t` stub returns the key string; replace with real accessor if present).

---

### Task 6: Wire PipelineSavePanel into the done/result area

**Files:**
- Modify: `frontend/src/components/AutoPipeline.tsx`

**Interfaces:**
- Consumes: `PipelineSavePanel` (Task 5), `getPipelinePresets` (Task 2), the `presets`/`setPresets` state from Task 4.
- Produces: save panel rendered next to the existing download buttons when a pipeline is `done`.

- [ ] **Step 1: Import + render**

Add import at top of `AutoPipeline.tsx`:
```ts
import PipelineSavePanel from "@/components/PipelineSavePanel";
```
In the result/done section — wherever the download buttons (`getMuxedDownloadUrl`/hardcoded/dubbed links) are rendered for a finished pipeline — add the save panel beside them:
```tsx
                  <PipelineSavePanel
                    p={p}
                    onSaved={() =>
                      getPipelinePresets()
                        .then((r) => setPresets(r.presets))
                        .catch(() => {})
                    }
                  />
```
Place it in the same flex/grid row as the download buttons so it reads as "save this config" next to "download results".

- [ ] **Step 2: Verify typecheck + manual smoke**
Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.
Manual smoke (run `./dev.sh`, open `localhost:3000/project/auto`):
1. Run a full pipeline to completion (or reuse an existing finished pipeline).
2. In the done area, click "Lưu cấu hình", enter a name, save. Confirm no error and the network call `POST /api/config/pipeline-presets` returns `{id,name}`.
3. Start a NEW pipeline. In the config `<select>`, pick the saved preset. Confirm all option fields (translate target, dub engine/voice, mute, watermark, etc.) become prefilled.
4. If the preset included a saved `region`/`subtitleStyle`/`removeWatermarkRegions`, confirm the run skips the Region selector / Subtitle preview / Watermark-region steps (the pipeline proceeds without those interactive waits).
5. Re-select the preset and click the ✕ delete button; confirm it disappears from the list and backend `DELETE` returns ok.

---

## Self-Review

**1. Spec coverage**
- Save after completion with name → Task 5 + Task 6 (PipelineSavePanel calling createPipelinePreset with collectCurrentConfig). ✓
- Backend storage in user_config.json, load list/delete → Task 1. ✓
- Select in config section before start → Task 4 (`<select>` + applyPreset). ✓
- All config fields + positional (region OCR, subtitleStyle, removeWatermarkRegions) → `applyPreset` + `collectCurrentConfig` (Task 4/5) include every field. ✓
- Seeded positional makes manual steps skipped → Task 3 (seed through newPipeline) + confirmation that runPipeline/runPrep already skip when set. ✓

**2. Placeholder scan**
- No "TBD"/"TODO". The only stub is the `t` i18n accessor in `PipelineSavePanel`, explicitly flagged to replace with the app's real accessor (the file's i18n mechanism is known-clean; this is a documented substitution, not a missing implementation). ✓
- `setDubEngine(cfg.dubEngine as any)` / `setWatermarkPreset(... as any)` — `as any` is acceptable because the preset stores the raw string value the UI produced; a stricter cast to the exact union type may be used if desired. Not a placeholder. ✓

**3. Type consistency**
- `PresetConfig` shape implied by `applyPreset`/`collectCurrentConfig` is symmetric (every field `collectCurrentConfig` writes is one `applyPreset` reads). `region`/`subtitleStyle` are `Region | null`; `removeWatermarkRegions` is `Region[]`. Matches `newPipeline` params and `Pipeline` fields. ✓
- `presetSeed` type in Task 4 matches what `handleAdd`/`handleStartUpload` read. ✓
- `ocrType` deliberately omitted everywhere (no stored field, auto-detected) — consistent across Tasks 4/5. ✓
