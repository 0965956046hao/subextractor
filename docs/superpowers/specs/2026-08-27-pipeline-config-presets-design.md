# Pipeline Config Presets — Design

Save the full set of pipeline options (plus positional params) used to process a
video into a named preset, then let the user load that preset from the config
section before starting a new pipeline.

## Goals

- After a pipeline finishes, the user can save its entire configuration under a
  name.
- In the pre-start config section, a `<select>` lists saved presets; choosing one
  prefills every option and seeds the positional params (OCR region, subtitle
  style, watermark-removal regions) so the manual selection steps are skipped.
- Presets persist on the backend (`user_config.json`) and are shared across tabs
  (same pattern as the keep-original feature).

## Non-goals

- No editing / renaming of an existing preset (delete + recreate instead).
- No cross-user sharing; presets live in the single `user_config.json`.

## Data model

`user_config.json` gains:

```json
{
  "pipeline_presets": [
    {
      "id": "pp_<random8>",
      "name": "Tiếng Trung → Việt (CapCut)",
      "config": { "<all pipeline options + positional params>" },
      "created_at": "2026-08-27T10:00:00"
    }
  ]
}
```

`config` is a generic JSON object. The backend stores/returns it verbatim and
performs no schema validation — the frontend owns the shape.

### `config` shape (frontend-owned)

Options (pre-start UI):

- `srcLang` ("zh" | "en" | "vi")
- `translateOn` (bool)
- `translateTarget` ("zh" | "en" | "vi")
- `dubOn` (bool)
- `dubEngine` ("google" | "capcut")
- `voiceLang` ("vi-VN" | "en-US")
- `dubVoice` (string)
- `muteOriginal` (bool)
- `keepOriginalEnabled` (bool)
- `originalGainDb` (number)
- `multiVoice` (bool)
- `autoFitSubs` (bool)
- `watermarkOn` (bool)
- `watermarkPreset` (string id)
- `removeWatermarkEnabled` (bool)
- `checkSubs` (bool)
- `checkVoice` (bool)
- `useFalThumbnail` (bool)
- `useGptThumbnail` (bool)
- `autoUploadYoutube` (bool)
- `regionMode` ("manual" | "auto")
- `ocrType` ("rapid" | "apple")

Positional (captured from the finished pipeline `p`, only if present):

- `region` (OCR scan region `{x1,y1,x2,y2}`) — "vị trí OCR"
- `subtitleStyle` (`Partial<SubtitleStyle>`) — "vị trí/cỡ/màu sub"
- `removeWatermarkRegions` (`Region[]`) — "toạ độ xoá watermark"
- `removeWatermarkEnabled` (bool)

Missing keys are tolerated: `applyPreset` merges onto defaults.

## Backend changes (`backend/app/routers/config_router.py`)

- `GET /api/config/pipeline-presets` → `{ presets: PipelinePreset[] }`
- `POST /api/config/pipeline-presets`
  - body: `{ name: str, config: dict }`
  - generates `id = f"pp_{uuid4().hex[:8]}"`, appends to
    `cfg["pipeline_presets"]`, writes config, returns `{ id }`.
  - `name` trimmed; if empty, default to `f"Preset {len+1}"`.
- `DELETE /api/config/pipeline-presets/{id}` → removes matching id.
- `GET /api/config` response gains `"pipeline_presets": [...]`.
- Reuse existing `_read_config` / `_write_config` helpers.

No new Pydantic model needed for the list/get; for POST use a small
`PipelinePresetCreate` model (`name: str = "", config: dict`).

## Frontend — `lib/api.ts`

Add wrappers:

- `getPipelinePresets(): Promise<{presets: PipelinePreset[]}>`
- `createPipelinePreset(name: string, config: object): Promise<{id: string}>`
- `deletePipelinePreset(id: string): Promise<void>`
- Export a `PipelinePreset` type `{ id, name, config, created_at }`.

## Frontend — AutoPipeline config section

Add near the top of the config panel:

- State: `pipelinePresets: PipelinePreset[]`, `selectedPresetId: string`,
  `showSavePanel: boolean`, `presetName: string`.
- Load presets on mount (alongside existing config load), or read from the
  augmented `GET /api/config` payload.
- A `<select>` "Cấu hình đã lưu" with a placeholder option
  ("— Tuỳ chỉnh —") + one option per preset. `onChange` → `applyPreset(config)`.
- A small delete (🗑) button enabled when a preset is selected.
- `applyPreset(config)`:
  - Sets every option state (srcLang, translateOn, …) with `?? default`.
  - Stashes `region`, `subtitleStyle`, `removeWatermarkRegions`,
    `removeWatermarkEnabled` into a "seed" object passed into pipeline creation.
  - Resets `selectedPresetId` to placeholder so later manual edits don't fight
    the select.

## Frontend — collect current config

`collectCurrentConfig()` builds the `config` blob:

- All option states listed above (read directly from AutoPipeline state).
- Positional from the **current pipeline `p`** (the finished one): `p.region`,
  `p.subtitleStyle`, `p.removeWatermarkRegions`, `p.removeWatermarkEnabled`.
  These live on the pipeline, not on AutoPipeline local state, so the save
  handler must have access to `p` (it does — the result/done view is rendered
  for a selected pipeline).

## Frontend — save panel (after completion)

In the result/done area, beside the download buttons, add a
"💾 Lưu cấu hình" button. Click → toggles `showSavePanel` → renders a name
`<input>` + "Lưu" / "Huỷ". On "Lưu":

- `const config = collectCurrentConfig();`
- `await createPipelinePreset(presetName.trim() || defaultName, config);`
- Refresh `pipelinePresets`, close panel, brief confirmation.

## Seed → skip interactive steps (core behavior)

Extend `addPipeline` / `addPipelineFromUpload` + `newPipeline` to accept and
store: `region`, `subtitleStyle`, `removeWatermarkRegions`,
`removeWatermarkEnabled` (seeded). In `runPipeline`:

- **Region step:** if `p.region` is already set (seeded), skip `waitForRegion`
  and proceed to the next step.
- **Subtitle step:** if `p.subtitleStyle` is already set, skip
  `waitForSubtitleStyle` and proceed.
- **Watermark-removal step:** if `p.removeWatermarkRegions` is set and
  `removeWatermarkEnabled`, use them directly instead of opening
  `WatermarkRegionSelector`.

This makes a loaded preset genuinely reuse the saved OCR/sub/watermark
positions — no manual re-selection.

## Error handling

- Backend: missing/invalid `config` still stored as-is (generic); unknown id on
  DELETE → 404.
- Frontend: save failure → keep panel open, show inline error. Load failure →
  presets list empty, rest of UI unaffected. Apply preset never throws on
  missing keys (defaults).

## Testing

- `cd backend && .venv/bin/python -m py_compile app/routers/config_router.py`
- `cd frontend && npx tsc --noEmit`
- Manual: run a pipeline to completion → "Lưu cấu hình" → name it → start a new
  pipeline → pick the preset in the select → confirm all options prefilled AND
  that OCR/subtitle/watermark selection steps are skipped (region/subtitleStyle
  /regions already present).

## Files touched

- `backend/app/routers/config_router.py` (presets endpoints + main GET)
- `frontend/src/lib/api.ts` (wrappers + type)
- `frontend/src/components/AutoPipeline.tsx` (select in config, save panel,
  collect/apply helpers, seed into creation)
- `frontend/src/stores/pipeline-store.ts` (`addPipeline`/`addPipelineFromUpload`
  + `newPipeline` accept seeded positional params; `runPipeline` skip logic)
