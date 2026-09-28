# Channel Batch Select → Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang `/channels` quét kênh Douyin nhóm video theo playlist (合集), tick chọn nhiều video, đẩy hàng loạt vào pipeline với preset có sẵn.

**Architecture:** Frontend-only (hướng A). Mở rộng `scan/route.ts` để bắt thêm thông tin collection từ response Douyin (fallback flat list nếu không có). `channels/page.tsx` thêm checkbox + batch bar + popup cross-collection, tái dùng `getPipelinePresets()` và `usePipelineStore.addPipeline()` có sẵn. Không đụng backend, không API mới.

**Tech Stack:** Next.js 14 App Router, TypeScript, Radix Checkbox (`@/components/ui/checkbox`), zustand `usePipelineStore`, Puppeteer response-intercept trong `scan/route.ts`.

**Spec:** `docs/superpowers/specs/2026-09-28-douyin-channel-batch-design.md`

## Global Constraints

- KHÔNG tự động commit (quy định repo trong AGENTS.md — chỉ commit khi user yêu cầu rõ ràng). Các task kết thúc ở verify, không có bước commit.
- Repo không có tests/linters/formatters/CI. Verify bằng `npm run typecheck` trong `frontend/` + test tay với kênh Douyin thật.
- Copy UI mới phải qua i18n (`frontend/src/lib/i18n.tsx`, cả 2 dict `en` + `vi` vì `Dict` suy từ dict `vi`).
- Dùng class design system sẵn có (`double-bezel`, `btn-island-primary`, `tag`, ...), không style ad-hoc.
- Giữ nguyên mọi cột/hành vi hiện tại của bảng kết quả (Watch, Share, Auto Pipeline đơn lẻ).

---

### Task 1: Scan route trả về playlists (có fallback)

**Files:**
- Modify: `frontend/src/app/api/channels/scan/route.ts`

**Interfaces:**
- Consumes: response JSON của Douyin (`aweme/post/` items có thể chứa `mix_info: { mix_id, mix_name }`; response URL chứa `mix` có thể chứa `mix_list: [{ mix_id, mix_name }]`).
- Produces: `ScanResult` mở rộng thêm `playlists: PlaylistGroup[]` với `PlaylistGroup = { id: string; title: string; videos: AwemeItem[] }`. Khi không bắt được mix → `playlists: []`.

- [ ] **Step 1: Thêm type + thu thập mix trong response handler**

  Trong `scan/route.ts`, thêm sau `capturedAwemeLists` (dòng ~70):

```ts
const capturedMixLists: Array<Array<{ mix_id: string; mix_name: string }>> = [];
```

  Trong `page.on("response", ...)` hiện tại, thêm block thứ hai (không sửa block `aweme/post/`):

```ts
page.on("response", async (resp) => {
  const u = resp.url();
  if (!u.includes("mix")) return;
  try {
    const data = await resp.json();
    const mixList = data?.mix_list ?? [];
    if (Array.isArray(mixList) && mixList.length > 0) {
      capturedMixLists.push(
        mixList
          .filter((m: any) => m?.mix_id)
          .map((m: any) => ({ mix_id: String(m.mix_id), mix_name: String(m.mix_name || m.mix_id) })),
      );
    }
  } catch {
    // non-JSON response, skip
  }
});
```

  Mở rộng interface `AwemeItem` (dòng ~14) với field optional:

```ts
mix_info?: { mix_id?: string; mix_name?: string };
```

  Mở rộng interface `ScanResult` (dòng ~34):

```ts
interface PlaylistGroup {
  id: string;
  title: string;
  videos: AwemeItem[];
}

interface ScanResult {
  channel_name: string;
  total: number;
  filtered: number;
  videos: AwemeItem[];
  playlists: PlaylistGroup[];
}
```

- [ ] **Step 2: Build playlists sau khi merge/dedupe, trước `return NextResponse.json(result)`**

  Thay block tạo `result` (dòng ~157) bằng:

```ts
const mixIdToName = new Map<string, string>();
for (const list of capturedMixLists) {
  for (const m of list) {
    if (!mixIdToName.has(m.mix_id)) mixIdToName.set(m.mix_id, m.mix_name);
  }
}

const groups = new Map<string, PlaylistGroup>();
for (const v of filtered) {
  const mid = v.mix_info?.mix_id ? String(v.mix_info.mix_id) : "";
  if (!mid) continue;
  if (!groups.has(mid)) {
    groups.set(mid, {
      id: mid,
      title: v.mix_info?.mix_name || mixIdToName.get(mid) || mid,
      videos: [],
    });
  }
  groups.get(mid)!.videos.push(v);
}

const result: ScanResult = {
  channel_name: channelName,
  total: allVideos.length,
  filtered: filtered.length,
  videos: filtered,
  playlists: Array.from(groups.values()),
};
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck` trong `frontend/`
Expected: PASS (không lỗi type mới).

---

### Task 2: Thêm i18n keys cho batch UI (en + vi)

**Files:**
- Modify: `frontend/src/lib/i18n.tsx` (dict `en` quanh dòng 962-996, dict `vi` quanh dòng 1933-1966)

**Interfaces:**
- Consumes: không có.
- Produces: 10 keys mới dùng ở Task 3, có mặt ở **cả 2 dict** (vì `export type Dict = (typeof dictionaries)["vi"]` — thiếu ở `vi` là vỡ type).

- [ ] **Step 1: Thêm keys vào cả 2 dict, ngay sau `"channel.colAutoPipeline"`**

  Dict `en`:

```ts
"channel.colSelect": "Select",
"channel.selectAll": "Select all",
"channel.clearSelection": "Clear",
"channel.selectedCount": "Selected {count}",
"channel.pushToPipeline": "Push to pipeline",
"channel.presetLabel": "Preset",
"channel.noPreset": "Create a preset in /auto first",
"channel.skippedDupes": "Skipped {count} duplicate(s)",
"channel.crossTitle": "Videos from {count} collections",
"channel.crossDesc": "Use one shared config for all, or configure each video separately?",
"channel.useShared": "Use shared preset",
"channel.setSeparate": "Configure separately",
"channel.uncategorized": "Uncategorized",
```

  Dict `vi`:

```ts
"channel.colSelect": "Chọn",
"channel.selectAll": "Chọn tất cả",
"channel.clearSelection": "Bỏ chọn",
"channel.selectedCount": "Đã chọn {count}",
"channel.pushToPipeline": "Đẩy vào pipeline",
"channel.presetLabel": "Preset",
"channel.noPreset": "Hãy tạo preset ở /auto trước",
"channel.skippedDupes": "Đã bỏ qua {count} video trùng",
"channel.crossTitle": "Video thuộc {count} bộ sưu tập",
"channel.crossDesc": "Dùng chung 1 cấu hình cho tất cả, hay chỉnh riêng từng video?",
"channel.useShared": "Dùng chung preset",
"channel.setSeparate": "Chỉnh riêng",
"channel.uncategorized": "Chưa phân loại",
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck` trong `frontend/`
Expected: PASS.

---

### Task 3: Checkbox + batch bar + popup + batch handler trong channels/page.tsx

**Files:**
- Modify: `frontend/src/app/channels/page.tsx`

**Interfaces:**
- Consumes: `ScanResult.playlists` (Task 1), i18n keys (Task 2), `getPipelinePresets()` + type `PipelinePreset` từ `@/lib/api`, `usePipelineStore` (`.pipelines`, `.addPipeline`) từ `@/stores/pipeline-store`, `Checkbox` từ `@/components/ui/checkbox`, `useRouter` từ `next/navigation`.
- Produces: UI chọn nhiều + `handleBatch(shared: boolean)` đẩy N video vào store rồi sang `/auto`. Không export gì mới.

- [ ] **Step 1: Imports, types, state mới**

  Thêm imports:

```tsx
import { useRouter } from "next/navigation";
import { Checkbox } from "@/components/ui/checkbox";
import { getPipelinePresets, type PipelinePreset } from "@/lib/api";
import { usePipelineStore } from "@/stores/pipeline-store";
```

  Mở rộng interface `ScanResult` trong file (dòng ~38) thêm:

```tsx
interface PlaylistGroup {
  id: string;
  title: string;
  videos: AwemeVideo[];
}
```

  và field `playlists: PlaylistGroup[];`.

  Thêm state trong `ChannelsPage` (sau `copiedId`, dòng ~139):

```tsx
const router = useRouter();
const [selected, setSelected] = useState<Set<string>>(new Set());
const [presets, setPresets] = useState<PipelinePreset[]>([]);
const [batchPresetId, setBatchPresetId] = useState("");
const [crossOpen, setCrossOpen] = useState(false);
```

  Load presets 1 lần khi mount (đặt cạnh `loadWorkerHist` effect):

```tsx
useEffect(() => {
  getPipelinePresets()
    .then((r) => {
      setPresets(r.presets || []);
      if (r.presets?.length) setBatchPresetId(r.presets[0].id);
    })
    .catch(() => setPresets([]));
}, []);
```

  Reset selection mỗi lần quét mới: trong `handleScan`, sau `setScanResult(null)` thêm `setSelected(new Set());`.

- [ ] **Step 2: Helpers chọn + share URL (đặt trước `return`)**

```tsx
const shareTextOf = (v: AwemeVideo): string =>
  v.share_link_desc ||
  v.share_url ||
  `https://www.douyin.com/video/${v.aweme_id}`;

const playlistIdOf = (awemeId: string): string | null => {
  if (!scanResult) return null;
  for (const pl of scanResult.playlists || []) {
    if (pl.videos.some((x) => x.aweme_id === awemeId)) return pl.id;
  }
  return null;
};

const toggleOne = (id: string) =>
  setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

const toggleMany = (ids: string[], on: boolean) =>
  setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  });
```

  Lưu ý: cột Share và nút Auto Pipeline đơn lẻ hiện dùng inline `shareText` — refactor chúng sang `shareTextOf(v)` để 1 nguồn duy nhất (sửa 2 chỗ: `const shareText = ...` trong map và `href={...shareText}`).

- [ ] **Step 3: Cột checkbox ở bảng flat + header chọn tất cả**

  Thêm `<th>` đầu tiên (trước cột `#`):

```tsx
<th className="pb-3 w-10">
  <Checkbox
    checked={
      scanResult && scanResult.videos.length > 0 && selected.size === scanResult.videos.length
        ? true
        : selected.size > 0
          ? "indeterminate"
          : false
    }
    onCheckedChange={(c) =>
      toggleMany(scanResult?.videos.map((v) => v.aweme_id) || [], c === true)
    }
    aria-label={t("channel.selectAll")}
  />
</th>
```

  Thêm `<td>` đầu mỗi dòng (trước `<td>` số thứ tự):

```tsx
<td className="py-4">
  <Checkbox
    checked={selected.has(v.aweme_id)}
    onCheckedChange={() => toggleOne(v.aweme_id)}
    aria-label={v.aweme_id}
  />
</td>
```

- [ ] **Step 4: Sections playlist collapsible + sticky batch bar + popup**

  Render sau block kết quả flat (sau `</table>`, trước khi đóng `double-bezel-inner` của results): với mỗi `scanResult.playlists` 1 `<details>` (dùng native `<details>/<summary>` để khỏi thêm state đóng/mở):

```tsx
{(scanResult.playlists || []).map((pl) => {
  const ids = pl.videos.map((x) => x.aweme_id);
  const n = ids.filter((id) => selected.has(id)).length;
  return (
    <details key={pl.id} className="mt-3 rounded-xl ring-1 ring-white/[0.07] bg-white/[0.02]">
      <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none">
        <span onClick={(e) => e.preventDefault()}>
          <Checkbox
            checked={n === ids.length && ids.length > 0 ? true : n > 0 ? "indeterminate" : false}
            onCheckedChange={(c) => toggleMany(ids, c === true)}
            aria-label={pl.title}
          />
        </span>
        <span className="text-[13px] font-medium text-ink truncate">{pl.title}</span>
        <span className="tag">{n}/{ids.length}</span>
      </summary>
      <div className="px-4 pb-3 space-y-1.5">
        {pl.videos.map((x) => (
          <label key={x.aweme_id} className="flex items-center gap-2.5 cursor-pointer">
            <Checkbox checked={selected.has(x.aweme_id)} onCheckedChange={() => toggleOne(x.aweme_id)} />
            <span className="text-[12px] text-ink truncate">{truncateText(x.desc || t("channel.noTitle"), 60)}</span>
            <span className="text-[11px] text-ink-light font-mono ml-auto">{fmtDate(x.create_time)}</span>
          </label>
        ))}
      </div>
    </details>
  );
})}
```

  Sticky batch bar (cuối trang, sau block worker history, chỉ hiện khi `selected.size > 0`):

```tsx
{selected.size > 0 && (
  <div className="sticky bottom-4 z-30 double-bezel">
    <div className="double-bezel-inner px-4 py-3 flex items-center gap-3 flex-wrap">
      <span className="tag bg-accent-muted text-accent ring-accent/15">
        {t("channel.selectedCount", { count: selected.size })}
      </span>
      <label className="text-[12px] text-ink-muted">{t("channel.presetLabel")}</label>
      <select
        value={batchPresetId}
        onChange={(e) => setBatchPresetId(e.target.value)}
        className="input-field text-[12px] !py-1.5"
        disabled={presets.length === 0}
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {presets.length === 0 && (
        <span className="text-[11px] text-warn">{t("channel.noPreset")}</span>
      )}
      <button
        onClick={() => void handleBatchRequest()}
        disabled={presets.length === 0}
        className="btn-island-primary text-sm !px-5 !py-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {t("channel.pushToPipeline")}
      </button>
      <button onClick={() => setSelected(new Set())} className="btn-island-secondary text-[12px]">
        {t("channel.clearSelection")}
      </button>
    </div>
  </div>
)}
```

  Popup cross-collection (cuối `return`, cạnh modal `playingVideo`, pattern fixed-overlay có sẵn):

```tsx
{crossOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setCrossOpen(false)}>
    <div className="double-bezel w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
      <div className="double-bezel-inner p-5">
        <p className="text-[14px] font-semibold text-ink">{t("channel.crossTitle", { count: crossCount })}</p>
        <p className="text-[13px] text-ink-muted mt-1">{t("channel.crossDesc")}</p>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={() => void handleBatchExecute(false)} className="btn-island-secondary text-[12px]">
            {t("channel.setSeparate")}
          </button>
          <button onClick={() => void handleBatchExecute(true)} className="btn-island-primary text-[12px]">
            {t("channel.useShared")}
          </button>
        </div>
      </div>
    </div>
  </div>
)}
```

  với `const crossCount = new Set(pendingIds.map(playlistIdOf)).size;` — cần state `pendingIds: string[]` (thêm vào Step 1: `const [pendingIds, setPendingIds] = useState<string[]>([]);`).

- [ ] **Step 5: Batch handlers (đặt cạnh `handleScan`)**

```tsx
const presetToAddArgs = (cfg: Record<string, unknown>): Parameters<typeof addPipeline>["length"] extends never ? never : any[] => {
  void 0;
  return [
    "", // url — caller ghi đè từng video
    (cfg.regionMode as "manual" | "auto") ?? "manual",
    {
      engine: (cfg.dubEngine as "google" | "capcut") ?? "capcut",
      voice: (cfg.dubVoice as string) ?? "BV421_vivn_streaming",
      muteOriginal: (cfg.muteOriginal as boolean) ?? false,
      originalGainDb: (cfg.originalGainDb as number) ?? 12,
      multiVoice: (cfg.multiVoice as boolean) ?? false,
      keepOriginalEnabled: (cfg.keepOriginalEnabled as boolean) ?? false,
    },
    (cfg.autoFitSubs as boolean) ?? false,
    (cfg.watermarkOn as boolean) ?? false,
    (cfg.watermarkOn ? (cfg.watermarkPreset as string) : "") ?? "",
    (cfg.removeWatermarkEnabled as boolean) ?? false,
    (cfg.removeWatermarkRegions as any) ?? [],
    (cfg.region as any) ?? null,
    (cfg.subtitleStyle as any) ?? null,
    (cfg.checkSubs as boolean) ?? false,
    (cfg.checkVoice as boolean) ?? false,
    (cfg.autoUploadYoutube as boolean) ?? false,
    (cfg.youtubeChannel as string) ?? "",
    (cfg.youtubePlaylist as string) ?? "",
    (cfg.useFalThumbnail as boolean) ?? false,
    (cfg.useGptThumbnail as boolean) ?? false,
    (cfg.srcLang as string) ?? "zh",
    (cfg.translateOn as boolean) ?? true,
    (cfg.translateTarget as string) ?? "vi",
    (cfg.dubOn as boolean) ?? true,
    (cfg.voiceLang as string) ?? "",
    (cfg.colorFilter as any) ?? null,
    (cfg.playbackSpeed as number) ?? 1.0,
    (cfg.useGeminiThumbnail as boolean) ?? false,
    (cfg.fillGaps as boolean) ?? false,
  ];
};
```

  Lưu ý: thứ tự tham số phải khớp `addPipeline` trong `pipeline-store.ts` dòng 503-529 (url, regionMode, dub, autoFit, watermark, watermarkPreset, removeWatermarkEnabled, removeWatermarkRegions, region, subtitleStyle, checkSubs, checkVoice, autoUploadYoutube, youtubeChannel, youtubePlaylist, useFalThumbnail, useGptThumbnail, srcLang, translateOn, translateTarget, dubOn, voiceLang, colorFilter, playbackSpeed, useGeminiThumbnail, fillGaps). Đối chiếu lúc code, sai thứ tự là bug.

```tsx
const handleBatchRequest = () => {
  if (!scanResult || selected.size === 0) return;
  const ids = scanResult.videos.filter((v) => selected.has(v.aweme_id)).map((v) => v.aweme_id);
  const groups = new Set(ids.map((id) => playlistIdOf(id) ?? "__none"));
  if (groups.size > 1) {
    setPendingIds(ids);
    setCrossOpen(true);
    return;
  }
  setPendingIds(ids);
  void handleBatchExecute(true);
};

const handleBatchExecute = (shared: boolean) => {
  setCrossOpen(false);
  if (!scanResult || pendingIds.length === 0) return;
  const byId = new Map(scanResult.videos.map((v) => [v.aweme_id, v]));
  const existingUrls = new Set(usePipelineStore.getState().pipelines.map((p) => p.url));
  const addPipeline = usePipelineStore.getState().addPipeline;
  const preset = presets.find((p) => p.id === batchPresetId);
  const sharedArgs = shared && preset ? presetToAddArgs(preset.config as Record<string, unknown>) : null;
  let pushed = 0;
  let skipped = 0;
  for (const id of pendingIds) {
    const v = byId.get(id);
    if (!v) continue;
    const url = shareTextOf(v);
    if (existingUrls.has(url)) {
      skipped += 1;
      continue;
    }
    existingUrls.add(url);
    if (sharedArgs) {
      addPipeline(url, ...(sharedArgs.slice(1) as any));
    } else {
      addPipeline(url, "manual");
    }
    pushed += 1;
  }
  setPendingIds([]);
  setSelected(new Set());
  if (skipped > 0) alert(t("channel.skippedDupes", { count: skipped }));
  if (pushed > 0) router.push("/auto");
};
```

- [ ] **Step 6: Verify typecheck + test tay**

Run: `npm run typecheck` trong `frontend/`
Expected: PASS.

  Test tay (theo spec §6): quét 1 kênh thật có 合集 → tick lẻ / cả bộ / tất cả → batch cùng-collection đi thẳng `/auto` → batch cross-collection hiện popup → kiểm tra preset apply đúng → quét lại và tick video trùng (báo skip).

---

## Self-Review

- [x] Spec coverage: scan playlists (§4.1 spec) → Task 1; selection + batch + popup (§4.2) → Task 3; preset/shared-config luật → Task 3 Step 5; i18n → Task 2; typecheck/manual test (§6) → Task 3 Step 6.
- [x] Placeholder scan: không có TBD/TODO; mọi step có code copy-paste được. Thứ tự `addPipeline` được dẫn chiếu tới dòng định nghĩa chính xác để đối chiếu.
- [x] Type consistency: `PlaylistGroup` định nghĩa giống nhau ở route và page; `presetToAddArgs` trả về đúng thứ tự tham số `addPipeline`; `pendingIds`/`crossCount` dùng nhất quán trong Task 3.
