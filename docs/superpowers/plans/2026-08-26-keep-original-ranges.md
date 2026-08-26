# Keep Original Ranges (Chọn đoạn giữ tiếng gốc) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khi bật "Tắt tiếng gốc" + toggle opt-in mới, pipeline dừng trước bước Demucs để người dùng kéo chọn các đoạn thời gian giữ nguyên tiếng gốc trên timeline video; backend trộn nhạc nền Demucs + tiếng gốc chỉ trong các đoạn đó, TTS vẫn đọc đè lên bình thường.

**Architecture:** Frontend tạm dừng trong bước dub của `runPipeline` bằng waiter pattern y hệt `waitForWatermarkRegion`; component mới `KeepOriginalSelector` vẽ các đoạn trên canvas-timeline dưới `VideoPlayer`. Backend nhận `keep_ranges` trong `POST /api/dub/{id}`, build filter FFmpeg `[1:a]volume=0:enable='between(t,s,e)+...'` để unmute tiếng gốc chỉ trong đoạn chọn rồi amix với instrumental Demucs; sau đó mix với `full_voice.mp3` như cũ.

**Tech Stack:** Next.js 14 + TypeScript + Tailwind (frontend), FastAPI + FFmpeg subprocess (backend).

## Global Constraints

- Repo **không có test/linter/formatter** — verify frontend bằng `npm run typecheck`, backend bằng `python -m py_compile`.
- **KHÔNG tự động commit** (AGENTS.md Workflow Preferences) — các task không có bước commit; user tự review và commit.
- Text UI tiếng Việt viết inline trong JSX (codebase đã mixed style này, vd `button_text: "🎙 Kiểm tra giọng đọc"`).
- Dùng design system có sẵn: `glass-panel`, `btn-island-primary`, `btn-island-secondary`, màu `ink/ink-muted/accent`.
- Đơn vị thời gian: giây (float). Kiểu dữ liệu chia sẻ: `{ start: number; end: number }`.
- Không thêm step mới vào mảng `STEPS` — chỉ thêm giá trị `"keep_original"` vào union `Stage`, map về step dub (index 8).

Spec: `docs/superpowers/specs/2026-08-26-keep-original-ranges-design.md`

---

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

### Task 2: Backend — `build_full_audio` nhận `keep_ranges`, wire qua `run_dub_sync`

**Files:**
- Modify: `backend/app/services/dub_service.py` — `build_full_audio` (signature ~dòng 313, khối `mute_original` ~dòng 390, khối mix cuối ~dòng 529), `run_dub_sync` (~dòng 630)

**Interfaces:**
- Consumes: `_normalize_keep_ranges`, `_mix_background_with_keep_ranges` (Task 1), `extract_audio` (có sẵn).
- Produces: `build_full_audio(video_id, voice_name="vi-VN-Standard-B", tts_engine="google", mute_original=True, original_gain_db=0.0, multi_voice=False, progress_callback=None, log_fn=None, keep_ranges=None) -> Path`. `run_dub_sync` truyền `keep_ranges=job.get("keep_ranges")`.

- [ ] **Step 1: Thêm param vào signature `build_full_audio`**

```python
def build_full_audio(
    video_id: str,
    voice_name: str = "vi-VN-Standard-B",
    tts_engine: str = "google",
    mute_original: bool = True,
    original_gain_db: float = 0.0,
    multi_voice: bool = False,
    progress_callback=None,
    log_fn=None,
    keep_ranges=None,
) -> Path:
```

Và cập nhật docstring: thêm dòng `` `keep_ranges` = [{start,end}] (giây) — khi `mute_original`, giữ tiếng gốc trong các đoạn này (TTS vẫn đọc đè).``

- [ ] **Step 2: Trong nhánh `mute_original` (sau khi có `instrumental`), trộn ranges vào nền**

Hiện tại sau khối `if mute_original:` biến `instrumental` + `background_volume = 1.0` sẵn sàng. Chèn ngay TRƯỚC dòng `cb(40)`:

```python
    norm_ranges: list[tuple[float, float]] = []
    orig_wav = None
    if mute_original and keep_ranges:
        if log_fn:
            log_fn(f"Giữ tiếng gốc trong {len(keep_ranges)} đoạn đã chọn...")
        # separate_instrumental đã xoá audio.wav sau Demucs → trích lại tiếng gốc.
        orig_wav = extract_audio(audio_source, out_dir)
        norm_ranges = _normalize_keep_ranges(keep_ranges, _get_audio_duration(orig_wav))
    if norm_ranges and orig_wav is not None:
        background = _mix_background_with_keep_ranges(
            instrumental, orig_wav, norm_ranges, out_dir / "background.m4a"
        )
        if log_fn:
            log_fn(f"Nền đã trộn: giữ tiếng gốc trong {len(norm_ranges)} đoạn.")
        orig_wav.unlink(missing_ok=True)  # dọn file tạm (~50MB/phút)
    else:
        background = instrumental
```

- [ ] **Step 3: Khối mix cuối dùng `background` thay vì `instrumental`**

Trong khối `else:` của reuse-check `full_audio.exists() ...` (~dòng 529-534), đổi:

```python
        _mix_background_with_voice(background, full_voice, background_volume, full_audio)
```

(ví trị cũ `instrumental`). Lưu ý mtime-reuse check phía trên vẫn so với `full_voice`/`instrumental` — giữ nguyên để tránh re-mix thừa; `background.m4a` mới hơn sẽ khiến lần chạy đầu đi nhánh else.

- [ ] **Step 4: `run_dub_sync` truyền `keep_ranges`**

Trong `run_dub_sync`, gọi `dub_audio_only(...)` — thêm kwarg:

```python
        out = dub_audio_only(
            video_id,
            voice_name=job.get("tts_voice", "vi-VN-Standard-B"),
            tts_engine=job.get("tts_engine", "google"),
            mute_original=job.get("mute_original", True),
            original_gain_db=job.get("original_gain_db", 0.0),
            multi_voice=job.get("multi_voice", False),
            progress_callback=progress,
            log_fn=_log,
            keep_ranges=job.get("keep_ranges"),
        )
```

Và `dub_audio_only` thêm param `keep_ranges=None`, forward `keep_ranges=keep_ranges` vào `build_full_audio`.

- [ ] **Step 5: Verify syntax**

Run: `cd backend && .venv/bin/python -m py_compile app/services/dub_service.py`
Expected: exit 0.

---

### Task 3: Backend — routes: `/api/dub` nhận `keep_ranges`, route xác nhận Mini App

**Files:**
- Modify: `backend/app/routers/tools.py` — `dub_subtitles` (~dòng 2120-2197), `update_pipeline_state` (~dòng 2533), thêm route mới sau `update_voice_check` (~dòng 2640)

**Interfaces:**
- Produces:
  - Job dict key `keep_ranges`: `list[dict]` ({start, end}) — worker đọc ở Task 2 Step 4.
  - `POST /api/pipeline/{video_id}/keep-original` body `{"confirmed": bool, "ranges": [{"start": number, "end": number}]}` → lưu `pipeline_states[video_id]["keep_original_confirm"]`.
  - `GET /api/pipeline/{video_id}` trả kèm field đó (qua preserve logic).

- [ ] **Step 1: Parse `keep_ranges` trong `dub_subtitles`**

Sau dòng `multi_voice = bool(body.get("multi_voice", False))` thêm:

```python
    keep_ranges = body.get("keep_ranges") or []
    if not isinstance(keep_ranges, list):
        keep_ranges = []
```

Và thêm vào job dict (sau `"multi_voice": multi_voice,`):

```python
        "keep_ranges": keep_ranges,
```

Cập nhật log: `(engine=%s, voice=%s, mute_original=%s, gain_db=%s, keep_ranges=%d)` + đối số `len(keep_ranges)`.

- [ ] **Step 2: Preserve `keep_original_confirm` trong `update_pipeline_state`**

Sau khối `if prev.get("watermark_confirm"):` thêm:

```python
    if prev.get("keep_original_confirm"):
        new_state["keep_original_confirm"] = prev["keep_original_confirm"]
```

- [ ] **Step 3: Route mới — chèn cuối file `tools.py`**

```python
# ── POST /api/pipeline/{video_id}/keep-original ──

@router.post("/api/pipeline/{video_id}/keep-original")
async def update_keep_original(
    video_id: str,
    body: dict,
    pipeline_states: dict = Depends(get_pipeline_states),
):
    """Xác nhận các đoạn giữ tiếng gốc từ tab khác / Telegram Mini App.
    Body: {"confirmed": true, "ranges": [{"start": 1.2, "end": 5.0}, ...]}."""
    if not video_id or "/" in video_id or "\\" in video_id or ".." in video_id:
        raise HTTPException(400, "Invalid video_id")
    ps = pipeline_states.get(video_id) or {}
    ps["keep_original_confirm"] = {
        "confirmed": bool(body.get("confirmed")),
        "ranges": body.get("ranges") or [],
    }
    pipeline_states[video_id] = ps
    return {"ok": True, "video_id": video_id}
```

- [ ] **Step 4: Verify syntax**

Run: `cd backend && .venv/bin/python -m py_compile app/routers/tools.py`
Expected: exit 0.

---

### Task 4: Frontend — store: kiểu dữ liệu, waiter, stage, tạm dừng trong dub step

**Files:**
- Modify: `frontend/src/stores/pipeline-store.ts`

**Interfaces:**
- Produces:
  - `export interface TimeRange { start: number; end: number }`
  - `Pipeline.keepOriginalEnabled: boolean`, `Pipeline.keepOriginalRanges: TimeRange[] | null`
  - `DubOptions.keepOriginalEnabled: boolean` (DEFAULT_DUB `false`)
  - `waitForKeepOriginal(id): Promise<TimeRange[]>` (poll backend `keep_original_confirm`)
  - Store action `confirmKeepOriginal(id: string, ranges: TimeRange[]): void` — patch ranges + resolve waiter (`[]` = bỏ qua/mute hết)
  - `rejectKeepOriginal(id)` — gọi cùng chỗ các reject khác khi cancel

- [ ] **Step 1: Thêm kiểu + trường state**

1. Sau `export interface LogEntry {...}` (~dòng 112) thêm:

```typescript
export interface TimeRange {
  start: number;
  end: number;
}
```

2. Trong `Pipeline` interface, sau `originalGainDb: number;` (~dòng 153):

```typescript
  keepOriginalEnabled: boolean;
  keepOriginalRanges: TimeRange[] | null;
```

3. Trong `DubOptions` (~dòng 192) thêm `keepOriginalEnabled: boolean;`; trong `DEFAULT_DUB` (~dòng 206) thêm `keepOriginalEnabled: false,`.
4. Trong `newPipeline` return object, sau `originalGainDb: d.originalGainDb,`:

```typescript
    keepOriginalEnabled: d.keepOriginalEnabled ?? false,
    keepOriginalRanges: null,
```

5. Union `Stage` (~dòng 61): thêm `| "keep_original"` sau `| "dub"`; `STEP_STAGE` (~dòng 82) thêm `keep_original: 8,`.
6. Interface `PipelineState`: thêm `confirmKeepOriginal: (id: string, ranges: TimeRange[]) => void;` cạnh `confirmWatermarkRegions`.

- [ ] **Step 2: Waiter + poll backend (đặt cạnh `waitForWatermarkRegion`, ~dòng 1209)**

```typescript
const keepOriginalWaiters = new Map<
  string,
  { resolve: (r: TimeRange[]) => void; reject: () => void }
>();

function waitForKeepOriginal(id: string): Promise<TimeRange[]> {
  return new Promise<TimeRange[]>((resolve, reject) => {
    keepOriginalWaiters.set(id, { resolve, reject });

    // Poll backend cho xác nhận từ tab khác / Telegram Mini App.
    const poll = async () => {
      while (keepOriginalWaiters.has(id)) {
        await sleep(2000);
        const cur = usePipelineStore.getState().pipelines.find((p) => p.id === id);
        if (!cur?.videoId) continue;
        try {
          const st = await getPipelineState(cur.videoId);
          const kc = st?.keep_original_confirm;
          if (kc?.confirmed) {
            keepOriginalWaiters.delete(id);
            resolve((kc.ranges || []) as TimeRange[]);
            return;
          }
        } catch {
          // ignore transient
        }
      }
    };
    void poll();
  });
}

function confirmKeepOriginalAction(id: string, ranges: TimeRange[]) {
  const w = keepOriginalWaiters.get(id);
  if (w) {
    keepOriginalWaiters.delete(id);
    w.resolve(ranges);
  }
}

function rejectKeepOriginal(id: string) {
  const w = keepOriginalWaiters.get(id);
  if (w) {
    keepOriginalWaiters.delete(id);
    w.reject();
  }
}
```

- [ ] **Step 3: Store action trong `create(...)`**

Cạnh `confirmWatermarkRegions: (id, regions) => {...}` (~dòng 649) thêm:

```typescript
      confirmKeepOriginal: (id, ranges) => {
        patch(id, { keepOriginalRanges: ranges });
        confirmKeepOriginalAction(id, ranges);
      },
```

- [ ] **Step 4: Tạm dừng trong dub step của `runPipeline` (~dòng 2499-2554)**

Ngay TRƯỚC `appendLog(id, engine === "capcut" ? ...)`, chèn:

```typescript
          // Opt-in: chọn đoạn giữ tiếng gốc trước khi chạy Demucs.
          let keepRanges = cur.keepOriginalRanges;
          if (
            cur.muteOriginal &&
            cur.keepOriginalEnabled &&
            (!keepRanges || keepRanges.length === 0)
          ) {
            patch(id, { stage: "keep_original" });
            appendLog(
              id,
              "Kéo chọn các đoạn giữ tiếng gốc trên timeline, nhấn Xác nhận để tiếp tục...",
            );
            keepRanges = await waitForKeepOriginal(id);
            patch(id, { keepOriginalRanges: keepRanges });
            appendLog(
              id,
              keepRanges.length > 0
                ? `Sẽ giữ tiếng gốc trong ${keepRanges.length} đoạn.`
                : "Không chọn đoạn nào — mute tiếng gốc toàn bộ.",
            );
            patch(id, { stage: "dub" });
          }
```

Và thêm vào body của `fetch(\`/api/dub/${videoId}\`)`:

```typescript
                keep_ranges: keepRanges && keepRanges.length > 0 ? keepRanges : undefined,
```

- [ ] **Step 5: Reject khi cancel**

Tìm chỗ các `rejectRegion(`/`rejectWatermarkRegion(` được gọi khi huỷ pipeline (grep `rejectWatermarkRegion(` trong file). Thêm `rejectKeepOriginal(id);` ngay cạnh mỗi lời gọi đó.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

---

### Task 5: Frontend — component `KeepOriginalSelector`

**Files:**
- Create: `frontend/src/components/KeepOriginalSelector.tsx`

**Interfaces:**
- Consumes: `VideoPlayer` (props: `videoId`, `videoRef`, `containerRef`, `onSizeChange?`, `onTimeUpdate?`, `overlay?`, `extraControls?` — như cách `RegionSelector`/`WatermarkRegionSelector` dùng), `TimeRange` (Task 4).
- Produces: default export `KeepOriginalSelector({ videoId, durationHint?, onConfirm }: { videoId: string; durationHint?: number; onConfirm: (ranges: TimeRange[]) => void })`. `onConfirm([])` = bỏ qua.

- [ ] **Step 1: Tạo file với nội dung đầy đủ**

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import VideoPlayer from "@/components/VideoPlayer";
import type { TimeRange } from "@/stores/pipeline-store";

interface Props {
  videoId: string;
  onConfirm: (ranges: TimeRange[]) => void;
}

const HANDLE_HIT = 8; // px quanh biên đoạn để resize
const MIN_LEN = 0.3; // giây

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function fmt(t: number) {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

type DragState =
  | { type: "idle" }
  | { type: "draw"; startX: number }
  | { type: "move"; index: number; startX: number; range: TimeRange }
  | { type: "resize"; index: number; edge: "l" | "r"; startX: number; range: TimeRange };

export default function KeepOriginalSelector({ videoId, onConfirm }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState>({ type: "idle" });
  const drawIdxRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);

  const [width, setWidth] = useState(800);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ranges, setRanges] = useState<TimeRange[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  // ── Vẽ timeline ──
  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const H = c.height;
    const laneY = 18;
    const laneH = H - laneY - 14;
    ctx.clearRect(0, 0, c.width, H);

    // Track nền (vùng bị mute)
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.fillRect(0, laneY, c.width, laneH);

    // Tick mỗi phút
    if (duration > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.font = "10px ui-monospace, monospace";
      const stepSec = duration > 600 ? 120 : duration > 180 ? 60 : 15;
      for (let t = 0; t <= duration; t += stepSec) {
        const x = (t / duration) * c.width;
        ctx.fillRect(x, laneY, 1, 4);
        ctx.fillText(fmt(t), Math.min(x + 3, c.width - 26), laneY - 5);
      }
    }

    // Playhead
    if (duration > 0) {
      const px = (currentTime / duration) * c.width;
      ctx.strokeStyle = "rgba(23,23,23,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, laneY - 2);
      ctx.lineTo(px, laneY + laneH + 2);
      ctx.stroke();
    }

    // Các đoạn giữ (xanh lá)
    ranges.forEach((r, i) => {
      if (duration <= 0) return;
      const x1 = (r.start / duration) * c.width;
      const x2 = (r.end / duration) * c.width;
      const sel = selected === i;
      ctx.fillStyle = sel ? "rgba(34,197,94,0.45)" : "rgba(34,197,94,0.28)";
      ctx.fillRect(x1, laneY, Math.max(2, x2 - x1), laneH);
      ctx.strokeStyle = sel ? "rgba(22,163,74,0.95)" : "rgba(34,197,94,0.75)";
      ctx.lineWidth = sel ? 2 : 1.5;
      ctx.strokeRect(x1, laneY, Math.max(2, x2 - x1), laneH);
      ctx.fillStyle = "rgba(22,163,74,0.95)";
      ctx.font = "bold 10px ui-monospace, monospace";
      if (x2 - x1 > 46) ctx.fillText(`${i + 1}`, x1 + 5, laneY + 13);
    });
  }, [ranges, selected, duration, currentTime]);

  const scheduleRedraw = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        redraw();
      });
    }
  }, [redraw]);

  useEffect(() => {
    scheduleRedraw();
  }, [scheduleRedraw]);

  // Đo bề rộng + sync thời lượng/timeline với <video>
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.duration && Number.isFinite(v.duration)) setDuration(v.duration);
      setCurrentTime(v.currentTime);
      scheduleRedraw();
    }, 200);
    return () => clearInterval(iv);
  }, [scheduleRedraw]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  // ── Tương tác pointer trên timeline ──
  const secAt = (clientX: number) => {
    const b = canvasRef.current?.getBoundingClientRect();
    if (!b || duration <= 0) return 0;
    return clamp(((clientX - b.left) / b.width) * duration, 0, duration);
  };

  const hitEdge = (px: number, py: number): { index: number; edge: "l" | "r" } | null => {
    const c = canvasRef.current;
    if (!c || duration <= 0) return null;
    const laneY = 18;
    if (py < laneY || py > c.height - 8) return null;
    for (let i = 0; i < ranges.length; i++) {
      const x1 = (ranges[i].start / duration) * c.width;
      const x2 = (ranges[i].end / duration) * c.width;
      if (Math.abs(px - x1) <= HANDLE_HIT) return { index: i, edge: "l" };
      if (Math.abs(px - x2) <= HANDLE_HIT) return { index: i, edge: "r" };
    }
    return null;
  };

  const hitRange = (px: number, py: number): number => {
    const c = canvasRef.current;
    if (!c || duration <= 0) return -1;
    const laneY = 18;
    if (py < laneY || py > c.height - 8) return -1;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const x1 = (ranges[i].start / duration) * c.width;
      const x2 = (ranges[i].end / duration) * c.width;
      if (px >= x1 && px <= x2) return i;
    }
    return -1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const b = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;

    const edge = hitEdge(px, py);
    if (edge) {
      setSelected(edge.index);
      dragRef.current = {
        type: "resize",
        index: edge.index,
        edge: edge.edge,
        startX: px,
        range: { ...ranges[edge.index] },
      };
      return;
    }
    const ri = hitRange(px, py);
    if (ri >= 0) {
      setSelected(ri);
      dragRef.current = { type: "move", index: ri, startX: px, range: { ...ranges[ri] } };
      return;
    }
    // Kéo tạo đoạn mới + seek tới vị trí bấm
    setSelected(null);
    const t = secAt(e.clientX);
    if (videoRef.current) videoRef.current.currentTime = t;
    const nr: TimeRange = { start: t, end: Math.min(t + MIN_LEN, duration) };
    setRanges((prev) => {
      drawIdxRef.current = prev.length;
      return [...prev, nr];
    });
    dragRef.current = { type: "draw", startX: px };
    scheduleRedraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (d.type === "idle") {
      const b = canvasRef.current?.getBoundingClientRect();
      if (b) {
        const px = e.clientX - b.left;
        const py = e.clientY - b.top;
        canvasRef.current!.style.cursor = hitEdge(px, py)
          ? "ew-resize"
          : hitRange(px, py) >= 0
            ? "grab"
            : "crosshair";
      }
      return;
    }
    const b = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - b.left;
    if (d.type === "draw") {
      const en = secAt(e.clientX);
      const di = drawIdxRef.current;
      if (di != null) {
        setRanges((prev) =>
          prev.map((r, i) =>
            i === di
              ? { start: Math.min(r.start, en), end: Math.max(r.start + MIN_LEN, en) }
              : r,
          ),
        );
        setSelected(di);
      }
    } else if (d.type === "move") {
      const dt = ((px - d.startX) / b.width) * duration;
      const len = d.range.end - d.range.start;
      const ns = clamp(d.range.start + dt, 0, duration - len);
      setRanges((prev) =>
        prev.map((r, i) => (i === d.index ? { start: ns, end: ns + len } : r)),
      );
    } else if (d.type === "resize") {
      const dt = ((px - d.startX) / b.width) * duration;
      if (d.edge === "l") {
        const ns = clamp(d.range.start + dt, 0, d.range.end - MIN_LEN);
        setRanges((prev) =>
          prev.map((r, i) => (i === d.index ? { ...r, start: ns } : r)),
        );
      } else {
        const ne = clamp(d.range.end + dt, d.range.start + MIN_LEN, duration);
        setRanges((prev) =>
          prev.map((r, i) => (i === d.index ? { ...r, end: ne } : r)),
        );
      }
    }
    scheduleRedraw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    // Draw quá ngắn → xoá đoạn rác
    setRanges((prev) => prev.filter((r) => r.end - r.start >= MIN_LEN));
    dragRef.current = { type: "idle" };
    drawIdxRef.current = null;
    scheduleRedraw();
  };

  const handleAddAroundPlayhead = () => {
    if (duration <= 0) return;
    const s = clamp(currentTime - 2, 0, duration);
    const en = clamp(currentTime + 2, s + MIN_LEN, duration);
    setRanges((prev) => [...prev, { start: s, end: en }]);
    setSelected(ranges.length);
  };

  const handleDeleteSelected = () => {
    if (selected == null) return;
    setRanges((prev) => prev.filter((_, i) => i !== selected));
    setSelected(null);
  };

  // Keyboard: Space play/pause, Enter confirm, Delete xoá đoạn đang chọn
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === " ") {
        ev.preventDefault();
        togglePlay();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (ranges.length > 0) onConfirm(ranges);
      } else if ((ev.key === "Delete" || ev.key === "Backspace") && selected != null) {
        ev.preventDefault();
        handleDeleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges, selected, onConfirm]);

  return (
    <div className="space-y-4">
      {/* Hướng dẫn */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          Kéo trên thanh thời gian để chọn đoạn <b>giữ nguyên tiếng gốc</b>. Ngoài
          các đoạn này, pipeline sẽ thay bằng nhạc nền không lời (giọng TTS vẫn
          đọc bình thường).
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">Space</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">Phát</span>
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">↵</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">Xác nhận</span>
        </div>
      </div>

      {/* Video preview */}
      <VideoPlayer
        videoId={videoId}
        videoRef={videoRef}
        containerRef={containerRef}
      />

      {/* Timeline chọn đoạn */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 space-y-3">
        <canvas
          ref={canvasRef}
          width={Math.max(width, 320)}
          height={64}
          className="w-full touch-none cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />

        {/* Danh sách đoạn */}
        {ranges.length > 0 && (
          <div className="space-y-1.5">
            {ranges.map((r, i) => (
              <div
                key={`${r.start}-${r.end}-${i}`}
                onClick={() => setSelected(i)}
                className={`flex items-center justify-between py-1.5 px-3 rounded-lg cursor-pointer transition-colors ${
                  selected === i ? "bg-emerald-500/10 ring-1 ring-emerald-500/40" : "bg-black/[0.02]"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-5 h-5 rounded bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="text-[11px] font-mono text-ink-muted tracking-tight">
                    {fmt(r.start)} – {fmt(r.end)} ({(r.end - r.start).toFixed(1)}s)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setRanges((prev) => prev.filter((_, j) => j !== i));
                    if (selected === i) setSelected(null);
                  }}
                  className="w-6 h-6 rounded-full bg-black/[0.04] text-ink-muted hover:bg-danger/10 hover:text-danger flex items-center justify-center transition-colors cursor-pointer text-[10px]"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Nút hành động */}
        <div className="flex gap-2 justify-between flex-wrap pt-1">
          <div className="flex gap-2">
            <button type="button" onClick={handleAddAroundPlayhead} className="btn-island-secondary text-sm">
              + Thêm đoạn
            </button>
            {selected != null && (
              <button type="button" onClick={handleDeleteSelected} className="btn-island-secondary text-sm">
                Xoá đoạn #{selected + 1}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => onConfirm([])} className="btn-island-secondary text-sm">
              Bỏ qua (mute tất cả)
            </button>
            <button
              type="button"
              disabled={ranges.length === 0}
              onClick={() => onConfirm(ranges)}
              className="btn-island-primary group text-sm disabled:opacity-40 disabled:pointer-events-none"
            >
              Xác nhận ({ranges.length})
              <span className="btn-island-icon">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                </svg>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (component chưa được dùng nên chỉ kiểm syntax/types riêng lẻ).

---

### Task 6: Frontend — AutoPipeline: toggle opt-in + render modal

**Files:**
- Modify: `frontend/src/components/AutoPipeline.tsx`

**Interfaces:**
- Consumes: `KeepOriginalSelector` (Task 5), `confirmKeepOriginal` store action (Task 4), state `keepOriginalEnabled` gửi qua `dub: {...}` của `addPipeline`.

- [ ] **Step 1: Import + state**

Thêm cạnh `import WatermarkRegionSelector` (~dòng 36):

```typescript
import KeepOriginalSelector from "@/components/KeepOriginalSelector";
```

Cạnh `const [muteOriginal, setMuteOriginal] = useState(true);` (~dòng 282):

```typescript
  const [keepOriginalEnabled, setKeepOriginalEnabled] = useState(false);
```

Trong store-selector khu DetailView (~dòng 2381, cạnh `confirmWatermarkRegions`):

```typescript
  const confirmKeepOriginal = usePipelineStore((s) => s.confirmKeepOriginal);
```

- [ ] **Step 2: Gửi option khi tạo pipeline**

Ở object `dub: { engine: dubEngine, voice: dubVoice, muteOriginal, originalGainDb },` (~dòng 647) thêm field:

```typescript
        dub: { engine: dubEngine, voice: dubVoice, muteOriginal, originalGainDb, keepOriginalEnabled },
```

- [ ] **Step 3: Toggle UI trong nhóm Âm thanh gốc**

Chèn NGAY SAU khối `{!muteOriginal && (... reduceOriginalHint ...)}` kết thúc ở ~dòng 1272 (chỉ hiện khi `muteOriginal` đúng):

```tsx
                 {muteOriginal && (
                   <label className="mt-2 flex items-center gap-2.5 cursor-pointer w-fit">
                     <input
                       type="checkbox"
                       checked={keepOriginalEnabled}
                       onChange={(e) => setKeepOriginalEnabled(e.target.checked)}
                       className="accent-accent"
                     />
                     <span className="text-[11px] text-ink-muted">
                       Chọn đoạn giữ tiếng gốc (pipeline sẽ dừng để bạn chọn trên timeline)
                     </span>
                   </label>
                 )}
```

- [ ] **Step 4: Render modal khi `stage === "keep_original"`**

Tìm block render `<WatermarkRegionSelector ... />` (~dòng 2516). Chèn block anh em NGAY SAU thẻ đóng của block đó, cùng cấp điều kiện:

```tsx
            {p.videoId && p.stage === "keep_original" && (
              <KeepOriginalSelector
                videoId={p.videoId}
                onConfirm={(ranges) => confirmKeepOriginal(p.id, ranges)}
              />
            )}
```

(Lấy điều kiện bao ngoài y hệt block watermark — thường là `p.stage === "watermark_region" && !p.videoId?.startsWith("remote-")` hoặc tương tự; copy nguyên dạng điều kiện của block watermark và thay stage.)

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

---

### Task 7: Verify thủ công end-to-end

**Files:** không sửa code — chỉ chạy thử.

- [ ] **Step 1: Khởi động services**

Run: `./dev.sh` (backend :8000 + frontend :3000 + capcut-tts :8100)

- [ ] **Step 2: Chạy pipeline với toggle bật**

1. Dán link Douyin ngắn (<2 phút), bật Lồng tiếng + "Tắt tiếng gốc" + tick "Chọn đoạn giữ tiếng gốc".
2. Pipeline phải dừng ở stage `keep_original`, hiện video + timeline; kéo tạo 1-2 đoạn, Xác nhận.
3. Log phải thấy `Sẽ giữ tiếng gốc trong N đoạn.` → `Giữ tiếng gốc trong N đoạn đã chọn...` → `Audio lồng tiếng Việt xong.`

- [ ] **Step 3: Kiểm chứng âm thanh bằng ffmpeg**

Với videoId vừa chạy:

```bash
cd backend/temp/tts/<video_id>
ffprobe -v error -show_entries format=duration -of csv=p=0 full_audio.m4a   # đủ dài
ffmpeg -ss <start_trong_doan> -t 3 -i full_audio.m4a -af volumedetect -f null - 2>&1 | grep max_volume   # KHÔNG phải -91dB (có tiếng gốc)
ffmpeg -ss <ngoai_doan> -t 3 -i full_audio.m4a -af volumedetect -f null - 2>&1 | grep max_volume         # tùy nhạc nền, không được nghe thấy thoại gốc
```

Expected: trong đoạn giữ có năng lượng cao (tiếng gốc + TTS); ngoài đoạn chỉ nhạc nền/TTS.

- [ ] **Step 4: Edge cases**

- Bấm "Bỏ qua (mute tất cả)" → log `Không chọn đoạn nào — mute tiếng gốc toàn bộ.` → output giống luồng cũ.
- Toggle tắt → pipeline không dừng.
- Range phủ gần hết video → log nền dùng tiếng gốc nguyên bản (không còn thoại bị mất).
