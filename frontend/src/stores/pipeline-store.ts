"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Region,
  SubtitleStyle,
  VideoMeta,
  TimelineIssue,
} from "@/lib/api";
import {
  listVideos,
  reportPipelineState,
  getPipelineState,
  reportTimelineAction,
} from "@/lib/api";
import { translate } from "@/lib/i18n";

function sanitizeFilename(name: string): string {
  return (name || "")
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export const STEPS = [
  {
    label: "Phân tích link",
    detail: "Lấy URL / tải video theo nguồn (Douyin/YouTube)",
  },
  { label: "Tải video", detail: "Tải video (gộp audio riêng nếu nguồn có)" },
  { label: "Chọn vùng quét sub", detail: "Kéo vùng trên video để lấy phụ đề" },
  {
    label: "Chỉnh kích thước & vị trí sub",
    detail: "Xem trước, chỉnh cỡ chữ và vị trí",
  },
  { label: "OCR trích phụ đề", detail: "Nhận dạng chữ trong vùng đã chọn" },
  { label: "Phân tích ngữ cảnh", detail: "Gemini Vision phân tích video" },
  {
    label: "Dịch Gemini",
    detail: "Dịch tự động sang Trung / Anh / Việt (có thể tắt)",
  },
  {
    label: "Lồng tiếng Việt",
    detail: "Tách giọng + TTS Việt + giữ nhạc nền (có thể tắt)",
  },
  { label: "Nhúng SRT vào video", detail: "FFmpeg gộp SRT mới vào MP4" },
  { label: "Tạo meta", detail: "Gemini tạo tiêu đề/mô tả/tags từ ngữ cảnh" },
  {
    label: "Cập nhật thumbnail",
    detail: "fal.ai / ChatGPT chỉnh lại thumbnail 16:9 + tiêu đề",
  },
  { label: "Upload YouTube", detail: "Đăng video lên YouTube kèm meta" },
];

export type Stage =
  | "idle"
  | "resolving"
  | "merging"
  | "region"
  | "watermark_region"
  | "subtitle_preview"
  | "processing"
  | "context"
  | "translating"
  | "saving"
  | "dub"
  | "muxing"
  | "meta"
  | "thumbnail"
  | "thumbnail_review"
  | "youtube"
  | "done"
  | "error";

export const STEP_STAGE: Record<string, number> = {
  resolving: 0,
  merging: 1,
  region: 2,
  subtitle_preview: 3,
  processing: 4,
  context: 5,
  translating: 6,
  saving: 6,
  dub: 7,
  muxing: 8,
  meta: 9,
  thumbnail: 10,
  thumbnail_review: 10,
  youtube: 11,
};

export const DEFAULT_REGION: Region = {
  x1: 0.114,
  y1: 0.748,
  x2: 0.863,
  y2: 0.972,
};

export interface LogEntry {
  message: string;
  ts: number;
  level: string;
}

export interface Pipeline {
  id: string;
  url: string;
  title: string;
  originalName: string;
  thumbnail: string | null;
  bigThumbs: string[];
  updatedThumbnailUrl: string | null;
  status: "queued" | "running" | "done" | "error";
  stage: Stage;
  progress: number;
  stepProgress: (number | null)[];
  logs: LogEntry[];
  error: string;
  resultUrl: string;
  dubbedUrl: string | null;
  videoUrl: string | null;
  audioUrl: string | null;
  videoId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  stepStarts: (number | null)[];
  stepEnds: (number | null)[];
  stepSkipped: boolean[];
  failedStep: number | null;
  ocrEngine: string;
  ocrLang: string;
  srcLang: string;
  translateOn: boolean;
  translateTarget: string;
  dubOn: boolean;
  contextOn: boolean;
  meta: Record<string, unknown> | null;
  region: Region | null;
  regionMode: "manual" | "auto";
  subtitleStyle: Partial<SubtitleStyle> | null;
  dubEngine: "google" | "capcut";
  dubVoice: string;
  muteOriginal: boolean;
  originalGainDb: number;
  multiVoice: boolean;
  autoFit: boolean;
  watermark: boolean;
  useFalThumbnail: boolean;
  useGptThumbnail: boolean;
  autoUploadYoutube: boolean;
  youtubeChannel: string;
  watermarkPreset: string;
  removeWatermarkEnabled: boolean;
  removeWatermarkRegions: Region[];
  checkSubs: boolean;
  checkVoice: boolean;
  timelineCheck: TimelineCheck | null;
  voiceCheck: VoiceCheck | null;
  resumeStep: number | null;
  needChatgptLogin: boolean;
  thumbnailReview: {
    waiting: boolean;
    imageUrl: string | null;
    extraInstructions: string;
  } | null;
  thumbnailFallback: {
    waiting: boolean;
  } | null;
}

export interface TimelineCheck {
  waiting: boolean;
  open: boolean;
  issues: TimelineIssue[];
  fixing: boolean;
}

export interface VoiceCheck {
  waiting: boolean;
  open: boolean;
}

export interface DubOptions {
  engine: "google" | "capcut";
  voice: string;
  muteOriginal: boolean;
  originalGainDb: number;
  multiVoice: boolean;
}

export interface ImportedDone {
  videoId: string;
  title: string;
  hasDubbed: boolean;
}

const DEFAULT_DUB: DubOptions = {
  engine: "capcut",
  voice: "BV421_vivn_streaming",
  muteOriginal: true,
  originalGainDb: 0,
  multiVoice: false,
};

interface PipelineState {
  pipelines: Pipeline[];
  addPipeline: (
    url: string,
    regionMode?: "manual" | "auto",
    dub?: Partial<DubOptions>,
    autoFit?: boolean,
    watermark?: boolean,
    watermarkPreset?: string,
    removeWatermarkEnabled?: boolean,
    removeWatermarkRegions?: Region[],
    checkSubs?: boolean,
    checkVoice?: boolean,
    autoUploadYoutube?: boolean,
    youtubeChannel?: string,
    useFalThumbnail?: boolean,
    useGptThumbnail?: boolean,
    srcLang?: string,
    translateOn?: boolean,
    translateTarget?: string,
    dubOn?: boolean,
  ) => string;
  addPipelineFromUpload: (input: {
    videoId: string;
    filename: string;
    srcLang?: string;
    regionMode?: "manual" | "auto";
    dub?: Partial<DubOptions>;
    autoFit?: boolean;
    watermark?: boolean;
    watermarkPreset?: string;
    removeWatermarkEnabled?: boolean;
    removeWatermarkRegions?: Region[] | null;
    checkSubs?: boolean;
    checkVoice?: boolean;
    youtubeChannel?: string;
    useFalThumbnail?: boolean;
    useGptThumbnail?: boolean;
    translateOn?: boolean;
    translateTarget?: string;
    dubOn?: boolean;
  }) => string;
  importActive: (v: VideoMeta) => string;
  importDone: (v: ImportedDone) => string;
  updatePipeline: (id: string, patch: Partial<Pipeline>) => void;
  removePipeline: (id: string) => void;
  clearFinished: () => void;
  rerunPipeline: (id: string, step: number) => void;
  confirmRegion: (id: string, region: Region) => void;
  confirmSubtitleStyle: (id: string, style: Partial<SubtitleStyle>) => void;
  cancelPipeline: (id: string) => void;
  hydrate: (pipelines: Pipeline[]) => void;
  resolveTimelineCheck: (id: string, action: "fix" | "continue") => void;
  openTimelineCheck: (id: string) => void;
  closeTimelineCheck: (id: string) => void;
  resolveVoiceCheck: (id: string, action: string) => void;
  openVoiceCheck: (id: string) => void;
  closeVoiceCheck: (id: string) => void;
  confirmWatermarkRegions: (id: string, regions: Region[]) => void;
  confirmThumbnailReview: (
    id: string,
    action: "accept" | "skip",
    extraInstructions?: string,
  ) => void;
  resolveThumbnailFallback: (id: string, choice: "fal" | "skip") => void;
  restorePaused: () => void;
}

function emptySteps<T>(v: T): T[] {
  return STEPS.map(() => v);
}

function newPipeline(
  id: string,
  url: string,
  regionMode: "manual" | "auto" = "manual",
  dub: Partial<DubOptions> = {},
  autoFit = false,
  watermark = false,
  watermarkPreset = "",
  removeWatermarkEnabled = false,
  removeWatermarkRegions: Region[] = [],
  checkSubs = false,
  checkVoice = false,
  autoUploadYoutube = false,
  youtubeChannel = "",
  useFalThumbnail = true,
  useGptThumbnail = false,
  srcLang = "",
  translateOn = true,
  translateTarget = "vi",
  dubOn = true,
): Pipeline {
  const d: DubOptions = { ...DEFAULT_DUB, ...dub };
  return {
    id,
    url,
    title: "",
    originalName: "",
    thumbnail: null,
    bigThumbs: [],
    updatedThumbnailUrl: null,
    status: "queued",
    stage: "idle",
    progress: 0,
    stepProgress: emptySteps(null),
    logs: [],
    error: "",
    resultUrl: "",
    dubbedUrl: null,
    videoUrl: null,
    audioUrl: null,
    videoId: null,
    startedAt: null,
    finishedAt: null,
    stepStarts: emptySteps(null),
    stepEnds: emptySteps(null),
    stepSkipped: emptySteps(false),
    failedStep: null,
    ocrEngine: "",
    ocrLang: srcLang ? detectOcrLang(srcLang) : "",
    srcLang,
    translateOn,
    translateTarget,
    dubOn,
    contextOn: false,
    meta: null,
    region: null,
    regionMode,
    subtitleStyle: null,
    dubEngine: d.engine,
    dubVoice: d.voice,
    muteOriginal: d.muteOriginal,
    originalGainDb: d.originalGainDb,
    multiVoice: d.multiVoice,
    autoFit,
    watermark,
    watermarkPreset,
    removeWatermarkEnabled,
    removeWatermarkRegions,
    checkSubs,
    checkVoice,
    timelineCheck: null,
    voiceCheck: null,
    resumeStep: null,
    needChatgptLogin: false,
    thumbnailReview: null,
    thumbnailFallback: null,
    useFalThumbnail,
    useGptThumbnail,
    autoUploadYoutube,
    youtubeChannel,
  };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { pipelines } = usePipelineStore.getState();
    fetch("/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipelines }),
    }).catch(() => {});
  }, 800);
}

export const usePipelineStore = create<PipelineState>()(
  persist(
    (set, get) => ({
      pipelines: [],
      addPipeline: (
        url,
        regionMode = "manual",
        dub = {},
        autoFit = true,
        watermark = false,
        watermarkPreset = "",
        removeWatermarkEnabled = false,
        removeWatermarkRegions = [],
        checkSubs = false,
        checkVoice = false,
        autoUploadYoutube = false,
        youtubeChannel = "",
        useFalThumbnail = true,
        useGptThumbnail = false,
        srcLang = "",
        translateOn = true,
        translateTarget = "vi",
        dubOn = true,
      ) => {
        const id = Math.random().toString(36).slice(2, 10);
        set((s) => ({
          pipelines: [
            ...s.pipelines,
            newPipeline(
              id,
              url,
              regionMode,
              dub,
              autoFit,
              watermark,
              watermarkPreset,
              removeWatermarkEnabled,
              removeWatermarkRegions,
              checkSubs,
              checkVoice,
              autoUploadYoutube,
              youtubeChannel,
              useFalThumbnail,
              useGptThumbnail,
              srcLang,
              translateOn,
              translateTarget,
              dubOn,
            ),
          ],
        }));
        runPrep(id);
        schedulePersist();
        return id;
      },
      addPipelineFromUpload: (input) => {
        const id = Math.random().toString(36).slice(2, 10);
        const p = newPipeline(
          id,
          input.filename,
          input.regionMode ?? "auto",
          input.dub ?? {},
          input.autoFit ?? true,
          input.watermark ?? false,
          input.watermarkPreset ?? "",
          input.removeWatermarkEnabled ?? false,
          input.removeWatermarkRegions ?? [],
          input.checkSubs ?? false,
          input.checkVoice ?? false,
          false,
          input.youtubeChannel ?? "",
          input.useFalThumbnail ?? true,
          input.useGptThumbnail ?? false,
          input.srcLang ?? "zh",
          input.translateOn ?? true,
          input.translateTarget ?? "vi",
          input.dubOn ?? true,
        );
        // Uploaded file is already registered on the backend: skip resolve + merge
        // and start directly at region selection (step 2).
        set((s) => ({
          pipelines: [
            ...s.pipelines,
            {
              ...p,
              videoId: input.videoId,
              title: input.filename,
              originalName: sanitizeFilename(input.filename) || "video",
            },
          ],
        }));
        runPrep(id, 2);
        return id;
      },
      importActive: (v) => {
        const videoId = v.video_id;
        if (get().pipelines.some((p) => p.videoId === videoId)) return "";
        const ps = v.pipeline;
        const isPipelineRunning =
          !!ps && (ps.status === "running" || ps.status === "queued");
        if (!v.job_id && !isPipelineRunning) return "";
        const id = v.job_id ? `remote-${v.job_id}` : `remote-${videoId}`;
        if (get().pipelines.some((p) => p.id === id)) return "";
        const stage =
          (ps?.stage as Stage) ?? stageForJobType(v.job_type, v.phase);
        const idx = STEP_STAGE[stage];
        const started = Date.now();
        const progress = ps?.progress ?? v.progress ?? 0;
        const stepProgress =
          Array.isArray(ps?.step_progress) &&
          ps!.step_progress.length === STEPS.length
            ? (ps!.step_progress as (number | null)[])
            : stepProgressFor(stage, progress);
        const status: Pipeline["status"] =
          ps?.status === "error" || v.status === "error"
            ? "error"
            : ps?.status === "done" || v.status === "done"
              ? "done"
              : v.status === "queued" || ps?.status === "queued"
                ? "queued"
                : "running";
        const p: Pipeline = {
          ...newPipeline(id, "", "auto", {}, true),
          status,
          stage,
          progress,
          title: v.filename || `Job ${v.job_id}`,
          originalName: v.filename || "",
          videoId,
          startedAt: started,
          error: ps?.error ?? v.error ?? "",
          failedStep: status === "error" ? (idx ?? 4) : null,
          stepProgress,
          stepStarts: STEPS.map((_, i) =>
            idx != null && i < idx
              ? started - 1000
              : i === idx
                ? started
                : null,
          ),
          stepEnds: STEPS.map((_, i) =>
            idx != null && i < idx ? started - 1000 : null,
          ),
          logs: [
            {
              message: "Đang theo dõi tiến trình từ máy chủ...",
              ts: started / 1000,
              level: "info",
            },
          ],
        };
        const tc = v.pipeline?.timeline_check;
        if (tc?.waiting) {
          p.timelineCheck = {
            waiting: true,
            open: !!tc.open,
            issues: tc.issues ?? [],
            fixing: !!tc.fixing,
          };
        }
        set((s) => ({ pipelines: [...s.pipelines, p] }));
        if (v.logs && Array.isArray(v.logs)) {
          appendBackendLogs(id, v.logs as LogEntry[]);
        }
        pollRemoteVideo(id, videoId);
        return id;
      },
      importDone: (v) => {
        const id = Math.random().toString(36).slice(2, 10);
        const p: Pipeline = {
          ...newPipeline(id, "", "manual", {}, true),
          status: "done",
          stage: "done",
          progress: 100,
          title: v.title,
          originalName: v.title,
          videoId: v.videoId,
          resultUrl: `/api/download/hardcoded/${v.videoId}`,
          dubbedUrl: v.hasDubbed ? `/api/download/dubbed/${v.videoId}` : null,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          stepProgress: STEPS.map(() => 100),
          stepStarts: STEPS.map(() => Date.now() - 1000),
          stepEnds: STEPS.map(() => Date.now()),
          logs: [
            {
              message: "Đã nhập lại video đã xử lý trước đó.",
              ts: Date.now() / 1000,
              level: "info",
            },
          ],
        };
        set((s) => ({ pipelines: [...s.pipelines, p] }));
        return id;
      },
      updatePipeline: (id, patch) => {
        set((s) => ({
          pipelines: s.pipelines.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        }));
        schedulePersist();
      },
      removePipeline: (id) => {
        set((s) => ({ pipelines: s.pipelines.filter((p) => p.id !== id) }));
        schedulePersist();
      },
      clearFinished: () => {
        set((s) => ({
          pipelines: s.pipelines.filter(
            (p) => p.status !== "done" && p.status !== "error",
          ),
        }));
        schedulePersist();
      },
      rerunPipeline: (id, step) => {
        if (step <= 3) {
          runPrep(id, step);
        } else {
          enqueue(id, step);
        }
      },
      confirmRegion: (id, region) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s) return;
        set((st) => ({
          pipelines: st.pipelines.map((p) =>
            p.id === id
              ? {
                  ...p,
                  region,
                  stage: p.autoFit ? "processing" : "subtitle_preview",
                }
              : p,
          ),
        }));
        const resolve = regionWaiters.get(id);
        if (resolve) {
          regionWaiters.delete(id);
          resolve.resolve(region);
        }
        // Restored pipeline (page reload): no live runner → resume prep from where it waited.
        if (!liveRunners.has(id)) {
          runPrep(id, s.resumeStep ?? 3);
        }
      },
      confirmSubtitleStyle: (id, style) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s) return;
        set((st) => ({
          pipelines: st.pipelines.map((p) =>
            p.id === id
              ? { ...p, subtitleStyle: style, stage: "processing" }
              : p,
          ),
        }));
        const resolve = subtitleStyleWaiters.get(id);
        if (resolve) {
          subtitleStyleWaiters.delete(id);
          resolve.resolve(style);
        }
        // Restored pipeline: resume heavy processing from step 4.
        if (!liveRunners.has(id)) {
          enqueue(id, s.resumeStep ?? 4);
        }
      },
      confirmWatermarkRegions: (id, regions) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s) return;
        set((st) => ({
          pipelines: st.pipelines.map((p) =>
            p.id === id
              ? { ...p, removeWatermarkRegions: regions, stage: "processing" }
              : p,
          ),
        }));
        confirmWatermarkRegionAction(id, regions);
      },
      confirmThumbnailReview: (id, action, extraInstructions) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s) return;
        if (action === "skip") {
          set((st) => ({
            pipelines: st.pipelines.map((p) =>
              p.id === id
                ? {
                    ...p,
                    updatedThumbnailUrl: null,
                    thumbnailReview: null,
                    stage: "thumbnail",
                  }
                : p,
            ),
          }));
        } else {
          set((st) => ({
            pipelines: st.pipelines.map((p) =>
              p.id === id
                ? { ...p, thumbnailReview: null, stage: "thumbnail" }
                : p,
            ),
          }));
        }
        const w = thumbnailReviewWaiters.get(id);
        if (w) {
          thumbnailReviewWaiters.delete(id);
          w.resolve({ action, extra: extraInstructions });
        }
        if (!liveRunners.has(id)) {
          runPipeline(id, s.resumeStep ?? 10);
        }
      },
      resolveThumbnailFallback: (id, choice) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s) return;
        set((st) => ({
          pipelines: st.pipelines.map((p) =>
            p.id === id
              ? { ...p, thumbnailFallback: null, stage: "thumbnail" }
              : p,
          ),
        }));
        const w = thumbnailFallbackWaiters.get(id);
        if (w) {
          thumbnailFallbackWaiters.delete(id);
          w.resolve(choice);
        }
        if (!liveRunners.has(id)) {
          runPipeline(id, s.resumeStep ?? 10);
        }
      },
      cancelPipeline: async (id) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s) return;
        const videoId = s.videoId;
        abortedPipelines.add(id);
        set((st) => ({ pipelines: st.pipelines.filter((p) => p.id !== id) }));
        rejectRegion(id);
        rejectSubtitleStyle(id);
        rejectWatermarkRegion(id);
        rejectTimelineCheck(id);
        rejectThumbnailReview(id);
        rejectThumbnailFallback(id);
        if (videoId) {
          try {
            await fetch(`/api/video/${videoId}/abort`, { method: "POST" });
          } catch {
            // ignore
          }
        }
      },
      hydrate: (pipelines) => set({ pipelines }),
      resolveTimelineCheck: async (id, action) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s || !s.timelineCheck?.waiting) return;
        if (action === "fix") {
          patch(id, { timelineCheck: { ...s.timelineCheck, fixing: true } });
          try {
            const videoId = s.videoId;
            if (!videoId) throw new Error("Chưa có video");
            const res = await fetch(`/api/srt/${videoId}/fix-timeline`, {
              method: "POST",
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.detail || "Sửa timeline thất bại");
            patch(id, {
              timelineCheck: {
                ...s.timelineCheck,
                waiting: false,
                fixing: false,
              },
            });
            if (videoId) reportTimelineAction(videoId, "fix").catch(() => {});
          } catch (e) {
            patch(id, { timelineCheck: { ...s.timelineCheck, fixing: false } });
            const resolve = timelineCheckWaiters.get(id);
            if (resolve) {
              timelineCheckWaiters.delete(id);
              resolve.reject(
                e instanceof Error ? e : new Error("Sửa timeline thất bại"),
              );
            }
            return;
          }
        } else {
          patch(id, {
            timelineCheck: {
              ...s.timelineCheck,
              waiting: false,
              fixing: false,
            },
          });
          if (s.videoId)
            reportTimelineAction(s.videoId, "continue").catch(() => {});
        }
        const resolve = timelineCheckWaiters.get(id);
        if (resolve) {
          timelineCheckWaiters.delete(id);
          resolve.resolve(action);
        }
        // Restored pipeline (page reload): no live runner → finish step 6 and resume dub.
        if (!liveRunners.has(id)) {
          markStepEnd(id, 6);
          patch(id, { timelineCheck: null });
          enqueue(id, s.resumeStep ?? 7);
        }
      },
      openTimelineCheck: (id) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s || !s.timelineCheck?.waiting || s.timelineCheck.open) return;
        patch(id, { timelineCheck: { ...s.timelineCheck, open: true } });
        if (s.videoId) reportTimelineAction(s.videoId, "open").catch(() => {});
      },
      // Collapse the big review modal back to the small waiting prompt. The
      // pipeline stays paused for review; no resolution is sent.
      closeTimelineCheck: (id) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s || !s.timelineCheck?.waiting || !s.timelineCheck.open) return;
        patch(id, { timelineCheck: { ...s.timelineCheck, open: false } });
        if (s.videoId) reportTimelineAction(s.videoId, "close").catch(() => {});
      },
      resolveVoiceCheck: (id, action) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s || !s.voiceCheck?.waiting) return;
        patch(id, {
          voiceCheck: { ...s.voiceCheck, waiting: false, open: false },
        });
        const w = voiceCheckWaiters.get(id);
        if (w) {
          voiceCheckWaiters.delete(id);
          w.resolve(action);
        }
        if (!liveRunners.has(id)) {
          markStepEnd(id, 6);
          patch(id, { voiceCheck: null });
          enqueue(id, s.resumeStep ?? 7);
        }
      },
      openVoiceCheck: (id) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s || !s.voiceCheck?.waiting || s.voiceCheck.open) return;
        patch(id, { voiceCheck: { ...s.voiceCheck, open: true } });
      },
      closeVoiceCheck: (id) => {
        const s = get().pipelines.find((p) => p.id === id);
        if (!s || !s.voiceCheck?.waiting || !s.voiceCheck.open) return;
        patch(id, { voiceCheck: { ...s.voiceCheck, open: false } });
      },
      restorePaused: () => {
        runRestorePaused();
      },
    }),
    {
      name: "ste-pipelines",
      partialize: (s) => ({ pipelines: s.pipelines }),
      version: 1,
    },
  ),
);

// ── Helpers ────────────────────────────────────────────────────────────────

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "SubtitleExtractor/1.0",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractUrl(text: string): string {
  const m = text.match(/https?:\/\/[^\s\u4e00-\u9fff]+/);
  if (!m) return "";
  return m[0].replace(/[，。！？,;.!?]+$/, "");
}

function detectSourceLang(url: string): string {
  if (/douyin\.com/i.test(url)) return "zh";
  if (/tiktok\.com/i.test(url)) return "en";
  return "zh";
}

function isYouTubeUrl(url: string): boolean {
  return /(^|\.)youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url);
}

function detectOcrLang(sourceLang: string): string {
  if (sourceLang === "zh") return "ch";
  if (sourceLang === "en") return "en";
  return "latin";
}

function detectOcrType(): "apple" | "rapid" {
  if (typeof navigator !== "undefined") {
    const ua = navigator.platform || navigator.userAgent || "";
    if (/Mac|iPhone|iPad/i.test(ua)) return "apple";
  }
  return "rapid";
}

export function langLabel(code: string): string {
  if (code === "zh" || code === "ch") return translate("lang.zh");
  if (code === "en") return translate("lang.en");
  if (code === "vi") return translate("lang.vi");
  return code || "—";
}

export function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface JobTick {
  progress: number;
  logs?: LogEntry[];
}

async function pollJob(jobId: string, onTick: (t: JobTick) => void) {
  let fails = 0;
  while (true) {
    await sleep(1500);
    try {
      const r = await fetch(`/api/status/${jobId}`);
      if (r.status === 404) {
        return {
          status: "error",
          error: "Job không tồn tại (backend đã restart?)",
        };
      }
      if (!r.ok) continue;
      fails = 0;
      const d = await r.json();
      onTick({ progress: d.progress ?? 0, logs: d.logs });
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
      if (d.status === "cancelled") return { status: "error", error: "Đã hủy" };
    } catch {
      // Backend không phản hồi (đã tắt / treo) → sau 10 lần thất bại liên tiếp
      // dừng polling và báo lỗi rõ ràng thay vì treo vô hạn.
      fails += 1;
      if (fails >= 40) {
        return {
          status: "error",
          error:
            "Backend không phản hồi / đã tắt. Vui lòng khởi động lại backend (uvicorn :8000).",
        };
      }
    }
  }
}

async function pollMerge(jobId: string, onTick: (t: JobTick) => void) {
  let fails = 0;
  while (true) {
    await sleep(800);
    try {
      const r = await fetch(`/api/video-merge/${jobId}`);
      if (r.status === 404) {
        return {
          status: "error",
          error: "Merge job không tồn tại (backend đã restart?).",
        };
      }
      if (!r.ok) continue;
      fails = 0;
      const d = await r.json();
      onTick({ progress: d.progress ?? 0, logs: d.logs });
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
    } catch {
      fails += 1;
      if (fails >= 40) {
        return {
          status: "error",
          error:
            "Backend không phản hồi / đã tắt. Vui lòng khởi động lại backend (uvicorn :8000).",
        };
      }
    }
  }
}

// ── Remote job tracking ─────────────────────────────────────────────────────
// Maps a backend job_type/phase to the nearest pipeline stage. Used to re-attach
// in-flight jobs (e.g. from another device / after a page reload) to the UI.
function stageForJobType(jobType?: string, phase?: string): Stage {
  const p = phase ?? "";
  if (p === "context") return "context";
  if (
    ["translate", "translating", "align", "extract_audio", "whisper"].includes(
      p,
    )
  )
    return "translating";
  if (["tts", "dub"].includes(p)) return "dub";
  if (["hardcode", "export"].includes(p)) return "muxing";
  if (["frames", "ocr", "saving", "processing"].includes(p))
    return "processing";
  const t = jobType ?? "";
  if (t === "context") return "context";
  if (t === "translate" || t === "align") return "translating";
  if (t === "tts" || t === "dub") return "dub";
  if (t === "hardcode" || t === "export") return "muxing";
  if (t === "ocr") return "processing";
  if (t === "merge") return "merging";
  return "processing";
}

function stepProgressFor(stage: Stage, progress: number): (number | null)[] {
  const idx = STEP_STAGE[stage];
  return STEPS.map((_, i) => {
    if (idx == null) return null;
    if (i < idx) return 100;
    if (i === idx) return progress;
    return 0;
  });
}

// Polls /api/videos for the given video and mirrors its latest state into the
// remote pipeline entry. Follows the newest active job for the video (the
// backend dedupes to one row per video), so it keeps tracking across job
// transitions (ocr → translate → dub → hardcode) and marks done/error when the
// video finishes. Best-effort; silently stops if the pipeline is removed.
async function pollRemoteVideo(id: string, videoId: string) {
  liveRunners.add(id);
  while (true) {
    await sleep(1500);
    const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
    if (!cur) {
      liveRunners.delete(id);
      return;
    }
    try {
      const videos = await listVideos();
      const row = videos.find((v) => v.video_id === videoId);
      if (!row) {
        usePipelineStore.getState().removePipeline(id);
        liveRunners.delete(id);
        return;
      }
      if (row.status === "done") {
        patch(id, {
          status: "done",
          stage: "done",
          progress: 100,
          finishedAt: Date.now(),
          stepProgress: STEPS.map(() => 100),
          stepEnds: STEPS.map(() => Date.now()),
          stepStarts: cur.stepStarts.map((s) => s ?? Date.now()),
          resultUrl: `/api/download/hardcoded/${videoId}`,
          dubbedUrl: row.has_dubbed ? `/api/download/dubbed/${videoId}` : null,
          title: row.filename || cur.title,
        });
        liveRunners.delete(id);
        return;
      }
      if (row.status === "error") {
        const stage = stageForJobType(row.job_type, row.phase);
        patch(id, {
          status: "error",
          stage: "error",
          error: row.error ?? "Lỗi xử lý",
          finishedAt: Date.now(),
          failedStep: STEP_STAGE[stage] ?? 4,
          title: row.filename || cur.title,
        });
        liveRunners.delete(id);
        return;
      }
      if (row.status === "cancelled") {
        patch(id, {
          status: "error",
          stage: "error",
          error: "Đã hủy",
          finishedAt: Date.now(),
          title: row.filename || cur.title,
        });
        liveRunners.delete(id);
        return;
      }
      // still active — mirror progress + logs. Prefer the frontend-reported
      // pipeline state (exact stage / overall % / per-step progress) when the
      // video carries one; fall back to the single-job mapping otherwise.
      const ps = row.pipeline;
      const stage =
        (ps?.stage as Stage) ?? stageForJobType(row.job_type, row.phase);
      const progress = ps?.progress ?? row.progress ?? 0;
      const stepProgress =
        Array.isArray(ps?.step_progress) &&
        ps!.step_progress.length === STEPS.length
          ? (ps!.step_progress as (number | null)[])
          : stepProgressFor(stage, progress);
      if (row.logs && Array.isArray(row.logs)) {
        appendBackendLogs(id, row.logs as LogEntry[]);
      }
      patch(id, {
        status: "running",
        stage,
        progress,
        title: row.filename || cur.title,
        stepProgress,
      });
      const tc = row.pipeline?.timeline_check;
      if (tc?.waiting) {
        patch(id, {
          timelineCheck: {
            waiting: true,
            open: !!tc.open,
            issues: tc.issues ?? [],
            fixing: !!tc.fixing,
          },
        });
      } else if (cur.timelineCheck) {
        patch(id, { timelineCheck: null });
      }
    } catch {
      // ignore transient
    }
  }
}

async function pollYoutubeUpload(jobId: string, onTick: (t: JobTick) => void) {
  for (let i = 0; i < 2400; i++) {
    await sleep(1500);
    try {
      const r = await fetch(`/api/youtube/upload/${jobId}`);
      if (!r.ok) continue;
      const d = await r.json();
      const lines: string[] = Array.isArray(d.output_lines)
        ? d.output_lines
        : [];
      const logs: LogEntry[] = lines.map((m: string) => ({
        message: m,
        ts: 0,
        level: "info",
      }));
      onTick({ progress: d.progress ?? 0, logs });
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
    } catch {
      // ignore transient
    }
  }
  return { status: "error", error: "Quá thời gian chờ upload" };
}

// ── Queue ──────────────────────────────────────────────────────────────────

let queue: { id: string; startStep: number }[] = [];
let processing = false;
const abortedPipelines = new Set<string>();
// Pipelines currently driven by a live runner coroutine (runPrep/runPipeline).
// After a page reload these are empty, so restored interactive waits must
// resume the runner from resumeStep instead of relying on the (dead) coroutine.
const liveRunners = new Set<string>();
const regionWaiters = new Map<
  string,
  { resolve: (r: Region) => void; reject: () => void }
>();
const subtitleStyleWaiters = new Map<
  string,
  { resolve: (s: Partial<SubtitleStyle>) => void; reject: () => void }
>();
const timelineCheckWaiters = new Map<
  string,
  { resolve: (a: "fix" | "continue") => void; reject: (e: Error) => void }
>();
const voiceCheckWaiters = new Map<
  string,
  { resolve: (action: string) => void }
>();
const watermarkRegionWaiters = new Map<
  string,
  { resolve: (r: Region[]) => void; reject: () => void }
>();
const thumbnailReviewWaiters = new Map<
  string,
  {
    resolve: (result: { action: "accept" | "skip"; extra?: string }) => void;
    reject: () => void;
  }
>();
const thumbnailFallbackWaiters = new Map<
  string,
  { resolve: (choice: "fal" | "skip") => void; reject: () => void }
>();

function waitForRegion(id: string): Promise<Region> {
  return new Promise<Region>((resolve, reject) => {
    regionWaiters.set(id, { resolve, reject });
  });
}

function rejectRegion(id: string) {
  const w = regionWaiters.get(id);
  if (w) {
    regionWaiters.delete(id);
    w.reject();
  }
}

function waitForSubtitleStyle(id: string): Promise<Partial<SubtitleStyle>> {
  return new Promise<Partial<SubtitleStyle>>((resolve, reject) => {
    subtitleStyleWaiters.set(id, { resolve, reject });
  });
}

function rejectSubtitleStyle(id: string) {
  const w = subtitleStyleWaiters.get(id);
  if (w) {
    subtitleStyleWaiters.delete(id);
    w.reject();
  }
}

function waitForWatermarkRegion(id: string): Promise<Region[]> {
  return new Promise<Region[]>((resolve, reject) => {
    watermarkRegionWaiters.set(id, { resolve, reject });

    // Also poll backend for confirmation from Mini App
    const poll = async () => {
      while (watermarkRegionWaiters.has(id)) {
        await sleep(2000);
        try {
          const res = await fetch(`/api/pipeline/${videoId}`);
          if (res.ok) {
            const ps = await res.json();
            const confirm = ps?.watermark_confirm;
            if (confirm?.confirmed && confirm.regions) {
              // Mini App confirmed — resolve with regions
              watermarkRegionWaiters.delete(id);
              resolve(confirm.regions as Region[]);
              return;
            }
          }
        } catch {
          // ignore transient
        }
      }
    };
    // Get videoId from pipeline
    const cur = usePipelineStore.getState().pipelines.find((p) => p.id === id);
    const videoId = cur?.videoId;
    if (videoId) poll();
  });
}

function confirmWatermarkRegionAction(id: string, regions: Region[]) {
  const w = watermarkRegionWaiters.get(id);
  if (w) {
    watermarkRegionWaiters.delete(id);
    w.resolve(regions);
  }
}

function rejectWatermarkRegion(id: string) {
  const w = watermarkRegionWaiters.get(id);
  if (w) {
    watermarkRegionWaiters.delete(id);
    w.reject();
  }
}

function waitForThumbnailReview(
  id: string,
): Promise<{ action: "accept" | "skip"; extra?: string }> {
  return new Promise<{ action: "accept" | "skip"; extra?: string }>(
    (resolve, reject) => {
      thumbnailReviewWaiters.set(id, { resolve, reject });
    },
  );
}

function rejectThumbnailReview(id: string) {
  const w = thumbnailReviewWaiters.get(id);
  if (w) {
    thumbnailReviewWaiters.delete(id);
    w.reject();
  }
}

function waitForThumbnailFallback(id: string): Promise<"fal" | "skip"> {
  return new Promise<"fal" | "skip">((resolve, reject) => {
    thumbnailFallbackWaiters.set(id, { resolve, reject });
  });
}

function rejectThumbnailFallback(id: string) {
  const w = thumbnailFallbackWaiters.get(id);
  if (w) {
    thumbnailFallbackWaiters.delete(id);
    w.reject();
  }
}

function waitForTimelineCheck(id: string): Promise<"fix" | "continue"> {
  return new Promise<"fix" | "continue">((resolve, reject) => {
    timelineCheckWaiters.set(id, { resolve, reject });
  });
}

function waitForVoiceCheck(id: string): Promise<string> {
  return new Promise<string>((resolve) => {
    voiceCheckWaiters.set(id, { resolve });
  });
}

function rejectTimelineCheck(id: string) {
  const w = timelineCheckWaiters.get(id);
  if (w) {
    timelineCheckWaiters.delete(id);
    w.reject(new Error("Đã hủy kiểm tra timeline"));
  }
}

// Watches the backend for a timeline-review decision made from another
// tab/browser, so a remote "Tiếp tục xử lý" / "Sửa timeline" can unblock the
// driving tab's runner. Also mirrors "open" so the big modal expands everywhere.
function pollBackendTimelineDecision(
  videoId: string,
  id: string,
  signal: AbortSignal,
): Promise<"fix" | "continue"> {
  return new Promise((resolve) => {
    const step = async () => {
      if (signal.aborted) return;
      try {
        const st = await getPipelineState(videoId);
        const tc = st?.timeline_check;
        if (tc?.decision === "continue" || tc?.decision === "fix") {
          resolve(tc.decision);
          return;
        }
        if (tc?.open) {
          const cur = usePipelineStore
            .getState()
            .pipelines.find((x) => x.id === id);
          if (cur?.timelineCheck && !cur.timelineCheck.open) {
            patch(id, { timelineCheck: { ...cur.timelineCheck, open: true } });
          }
        }
      } catch {
        // ignore transient
      }
      if (!signal.aborted) setTimeout(step, 1000);
    };
    setTimeout(step, 1000);
  });
}

function enqueue(id: string, startStep = 0) {
  queue.push({ id, startStep });
  processQueue();
}

// Watches the backend for a voice-review decision made from another tab or the
// Telegram Mini App (POST /api/pipeline/{id}/voice {action:"continue"}).
function pollBackendVoiceDecision(
  videoId: string,
  id: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const step = async () => {
      if (signal.aborted) return;
      try {
        const st = await getPipelineState(videoId);
        if (st?.voice_check?.decision === "continue") {
          resolve("continue");
          return;
        }
      } catch {
        // ignore transient
      }
      if (!signal.aborted) setTimeout(step, 1000);
    };
    setTimeout(step, 1000);
  });
}

async function processQueue() {
  if (processing) return;
  if (queue.length === 0) return;
  processing = true;
  const { id, startStep } = queue.shift()!;
  await runPipeline(id, startStep);
  processing = false;
  processQueue();
}

// ── Runner ─────────────────────────────────────────────────────────────────

function patch(id: string, p: Partial<Pipeline>) {
  usePipelineStore.getState().updatePipeline(id, p);
}

function appendLog(id: string, msg: string, level = "info") {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const entry: LogEntry = { message: msg, ts: Date.now() / 1000, level };
  const next = [...cur.logs, entry];
  patch(id, { logs: next.length > 500 ? next.slice(next.length - 500) : next });
}

// Đảm bảo voice_map.json tồn tại (multi-voice CapCut) và CHỜ tạo xong rồi mới tiếp tục.
// Cache kết quả theo video_id trong session để tránh GET/POST lặp lại (ensure
// được gọi 2 lần: bước dịch và bước lồng tiếng).
const voiceMapEnsuredIds = new Set<string>();

async function ensureVoiceMap(
  videoId: string,
  id: string,
  targetLang: string = "vi",
): Promise<boolean> {
  if (voiceMapEnsuredIds.has(videoId)) return true;
  try {
    const vmCheck = await fetch(`/api/voice-map/${videoId}`);
    const vmData = await vmCheck.json();
    if (vmData.exists) {
      voiceMapEnsuredIds.add(videoId);
      appendLog(
        id,
        `voice_map.json đã có sẵn (${vmData.voices} dòng có giọng riêng).`,
      );
      return true;
    }
    appendLog(
      id,
      "Đang tạo voice_map.json (chọn giọng CapCut cho từng dòng bằng Gemini)...",
    );
    const vmRes = await fetch(`/api/voice-map/${videoId}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ target_lang: targetLang }),
    });
    const vmd = await vmRes.json();
    if (vmRes.ok && vmd.status === "done") {
      voiceMapEnsuredIds.add(videoId);
      appendLog(
        id,
        `Đã tạo voice_map.json: ${vmd.voices} dòng có giọng riêng.`,
      );
      return true;
    }
    appendLog(id, `Không tạo được voice_map.json: ${vmd.detail || "lỗi"}`);
    return false;
  } catch {
    appendLog(id, "Bỏ qua tạo voice_map.json (lỗi).");
    return false;
  }
}

function appendBackendLogs(id: string, entries: LogEntry[]) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const seen = new Set(
    cur.logs.map((l) => `${Math.round(l.ts)}::${l.message}`),
  );
  const fresh = entries.filter(
    (e) => !seen.has(`${Math.round(e.ts)}::${e.message}`),
  );
  if (fresh.length === 0) return;
  const next = [...cur.logs, ...fresh];
  patch(id, { logs: next.length > 500 ? next.slice(next.length - 500) : next });
}

function setStepProgress(id: string, i: number, p: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, {
    stepProgress: cur.stepProgress.map((v, idx) => (idx === i ? p : v)),
  });
}

// ── Cross-tab pipeline sync ─────────────────────────────────────────────────
// The tab that DRIVES a pipeline reports its step progress to the backend
// (POST /api/pipeline/{video_id}); list_videos merges it into rows so every
// other tab mirrors the exact same stage / overall % / per-step progress via
// pollRemoteVideo. Remote `remote-*` pipelines never report back (they only
// follow), avoiding feedback loops. Throttled to avoid spamming on progress
// ticks; terminal done/error states are always flushed immediately.
const lastPipelineReport = new Map<string, number>();

function reportPipeline(id: string, force = false) {
  const p = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!p || !p.videoId) return;
  if (id.startsWith("remote-")) return;
  const now = Date.now();
  const last = lastPipelineReport.get(id) ?? 0;
  if (!force && now - last < 800) return;
  lastPipelineReport.set(id, now);
  reportPipelineState(p.videoId, {
    status: p.status,
    stage: p.stage,
    progress: p.progress,
    step_progress: p.stepProgress,
    error: p.error || "",
  }).catch(() => {
    /* best-effort */
  });
}

function recalcOverall(id: string) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const total = cur.stepProgress.reduce((acc: number, v) => acc + (v ?? 0), 0);
  const overall = Math.round(total / STEPS.length);
  patch(id, { progress: overall });
  reportPipeline(id);
}

function markStepStart(id: string, i: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, {
    stepStarts: cur.stepStarts.map((v, idx) => (idx === i ? Date.now() : v)),
    stepEnds: cur.stepEnds.map((v, idx) => (idx === i ? null : v)),
    stepSkipped: cur.stepSkipped.map((v, idx) => (idx === i ? false : v)),
    stepProgress: cur.stepProgress.map((v, idx) => (idx === i ? 0 : v)),
  });
  reportPipeline(id);
}

function markStepEnd(id: string, i: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, {
    stepEnds: cur.stepEnds.map((v, idx) => (idx === i ? Date.now() : v)),
    stepProgress: cur.stepProgress.map((v, idx) => (idx === i ? 100 : v)),
  });
  recalcOverall(id);
}

function markStepSkipped(id: string, i: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, {
    stepSkipped: cur.stepSkipped.map((v, idx) => (idx === i ? true : v)),
    stepProgress: cur.stepProgress.map((v, idx) => (idx === i ? 100 : v)),
  });
  recalcOverall(id);
}

// ── Prep runner (interactive: resolve → merge → region → subtitle style) ──
// Runs immediately when a video is added, so the user can select region and
// subtitle position/size while other videos are still being processed in the
// queue. Only the heavy steps (OCR → hardcode) are enqueued sequentially.
async function runPrep(id: string, startStep = 0) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const rawUrl = cur.url;

  const tick = (i: number) => (t: JobTick) => {
    setStepProgress(id, i, t.progress);
    recalcOverall(id);
    if (t.logs) appendBackendLogs(id, t.logs);
  };

  let videoUrl = cur.videoUrl;
  let audioUrl = cur.audioUrl;
  let videoId = cur.videoId;
  let sourceLang = cur.srcLang || "zh";
  let ocrLang = cur.ocrLang || "ch";
  const ocrType = detectOcrType();
  let region = cur.region;
  let thumbUrl = cur.thumbnail;
  let bigThumbsUrls: string[] = cur.bigThumbs || [];
  let originalName = cur.originalName || "";

  const stageForStart =
    ["resolving", "merging", "region", "subtitle_preview"][startStep] ??
    "resolving";

  patch(id, {
    status: "running",
    stage: stageForStart as Stage,
    progress: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: "",
    failedStep: null,
    logs: [],
    resultUrl: "",
    dubbedUrl: null,
    stepProgress: cur.stepProgress.map((v, i) => (i >= startStep ? null : v)),
    stepStarts: cur.stepStarts.map((v, i) => (i >= startStep ? null : v)),
    stepEnds: cur.stepEnds.map((v, i) => (i >= startStep ? null : v)),
    stepSkipped: cur.stepSkipped.map((v, i) => (i >= startStep ? false : v)),
    region: startStep === 2 ? null : cur.region,
    subtitleStyle: startStep <= 3 ? null : cur.subtitleStyle,
  });

  liveRunners.add(id);
  try {
    if (abortedPipelines.has(id)) return;
    appendLog(id, `Bắt đầu pipeline (từ bước ${startStep})…`);
    // 0. Resolve link
    if (startStep <= 0) {
      const cleaned = extractUrl(rawUrl);
      if (!cleaned)
        throw new Error(
          "Không tìm thấy link (https://...) trong nội dung đã dán.",
        );
      markStepStart(id, 0);
      if (isYouTubeUrl(cleaned)) {
        // YouTube: yt-dlp downloads + merges server-side → import directly.
        appendLog(id, "Đang tải video từ YouTube (yt-dlp)...");
        const yr = await fetch("/api/video-download/yt-import", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ url: cleaned }),
        });
        const yd = await yr.json();
        if (!yr.ok) {
          appendLog(
            id,
            `YouTube import HTTP ${yr.status}: ${yd.detail || "lỗi"}`,
          );
          throw new Error(yd.detail || "Không thể tải video YouTube");
        }
        videoId = yd.video_id;
        sourceLang = cur.srcLang || detectSourceLang(cleaned);
        ocrLang = detectOcrLang(sourceLang);
        originalName =
          sanitizeFilename(yd.title || yd.filename || "") || "youtube";
        patch(id, {
          videoId,
          videoUrl: null,
          audioUrl: null,
          title: yd.title || yd.filename || "",
          originalName,
          srcLang: sourceLang,
          ocrLang,
          ocrEngine: ocrType === "apple" ? "Apple Vision" : "RapidOCR",
        });
        appendLog(
          id,
          `Đã tải video YouTube: ${yd.title || yd.filename || videoId} · ngôn ngữ: ${sourceLang} · OCR: ${ocrType}`,
        );
        markStepEnd(id, 0);
      } else {
        appendLog(id, "Đang phân tích link...");
        const r = await fetch("/api/video-download/resolve", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ url: cleaned }),
        });
        const rd = await r.json();
        if (!r.ok) {
          appendLog(id, `Resolve HTTP ${r.status}: ${rd.detail || "lỗi"}`);
          throw new Error(rd.detail || "Không thể phân tích link");
        }
        videoUrl = rd.video_url ?? null;
        audioUrl = rd.audio_url ?? null;
        sourceLang = detectSourceLang(cleaned);
        ocrLang = detectOcrLang(sourceLang);
        originalName = sanitizeFilename(rd.title || "") || "video";
        patch(id, {
          videoUrl,
          audioUrl,
          title: rd.title || "",
          originalName,
          srcLang: sourceLang,
          ocrLang,
          ocrEngine: ocrType === "apple" ? "Apple Vision" : "RapidOCR",
        });
        appendLog(
          id,
          `Đã lấy URL video${audioUrl ? " + audio" : ""} · ngôn ngữ: ${sourceLang} · OCR: ${ocrType}`,
        );
        markStepEnd(id, 0);

        // Thumbnail + big_thumbs giờ được resolve trả về ngay trong cùng 1
        // Chrome session (gộp từ /api/video-download/thumbnail). Resolve đã chờ
        // đủ 15s cho response detail nên không cần fallback mở Chrome lần 2.
        if (rd.thumbnail) {
          thumbUrl = rd.thumbnail;
          patch(id, { thumbnail: rd.thumbnail });
          appendLog(id, `Thumbnail: ${rd.thumbnail}`);
        } else {
          appendLog(id, "Thumbnail: không lấy được");
        }
        if (Array.isArray(rd.bigThumbs) && rd.bigThumbs.length) {
          bigThumbsUrls = rd.bigThumbs;
          patch(id, { bigThumbs: rd.bigThumbs });
        }
      }
    }

    // 1. Merge + import (silent)
    if (startStep <= 1) {
      if (videoId) {
        // Already imported (YouTube): yt-dlp đã merge sẵn video + audio.
        markStepSkipped(id, 1);
        appendLog(id, "Video YouTube đã có sẵn (yt-dlp đã tải video + audio).");
      } else {
        let mergeId = "";
        if (audioUrl && videoUrl) {
          patch(id, { stage: "merging" });
          markStepStart(id, 1);
          appendLog(
            id,
            "Phát hiện 2 file riêng (video + audio) → tải 2 file rồi gộp...",
          );
          appendLog(id, "Gửi yêu cầu merge video + audio…");
          const mr = await fetch("/api/video-merge", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              video_url: videoUrl,
              audio_url: audioUrl,
              thumbnail_url: thumbUrl || "",
              big_thumbs: bigThumbsUrls,
            }),
          });
          const md = await mr.json();
          if (!mr.ok) {
            appendLog(id, `Merge HTTP ${mr.status}: ${md.detail || "lỗi"}`);
            throw new Error(md.detail || "Merge thất bại");
          }
          const ms = await pollMerge(md.job_id, tick(1));
          if (ms.status !== "done")
            throw new Error(ms.error || "Merge thất bại");
          mergeId = (ms.filename || "").replace(/\.mp4$/, "");
          appendLog(id, "Đã tải 2 file và gộp xong.");
          markStepEnd(id, 1);
        } else {
          markStepSkipped(id, 1);
          appendLog(id, "Chỉ 1 file video (đã có audio).");
        }

        appendLog(id, "Đăng ký video vào hệ thống...");
        const impName = `${originalName || "video"}.mp4`;
        appendLog(id, `Gửi import-video (filename: ${impName})…`);
        const impBody = mergeId
          ? {
              // merge_id branch: backend copy thumbnail từ merged context,
              // bỏ qua thumbnail_url/big_thumbs (đã tải trong bước merge).
              merge_id: mergeId,
              filename: impName,
            }
          : {
              url: videoUrl,
              filename: impName,
              thumbnail_url: thumbUrl || "",
              big_thumbs: bigThumbsUrls,
            };
        const ir = await fetch("/api/import-video", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(impBody),
        });
        const idata = await ir.json();
        if (!ir.ok) {
          appendLog(id, `Import HTTP ${ir.status}: ${idata.detail || "lỗi"}`);
          throw new Error(idata.detail || "Import thất bại");
        }
        videoId = idata.video_id;
        patch(id, { videoId });
        appendLog(id, `Video ID: ${videoId}`);
        try {
          await fetch(`/api/context/${videoId}/share-text`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ text: rawUrl }),
          });
        } catch {
          // ignore
        }
      }
    }

    if (!videoId) {
      throw new Error("Chưa có video — chạy lại từ bước Phân tích link.");
    }

    // 2. Region: manual (wait for user) or auto (default coords)
    if (startStep <= 2) {
      if (cur.regionMode === "auto") {
        region = DEFAULT_REGION;
        patch(id, { region });
        appendLog(id, "Vùng quét mặc định (tự động) — bỏ qua bước chọn vùng.");
        markStepSkipped(id, 2);
      } else {
        patch(id, { stage: "region", resumeStep: 3 });
        markStepStart(id, 2);
        appendLog(
          id,
          "Kéo vùng quét lấy phụ đề trên video, nhấn Enter để xác nhận...",
        );
        region = cur.region ?? (await waitForRegion(id));
        patch(id, { region });
        appendLog(
          id,
          `Vùng quét: x ${region.x1}–${region.x2} · y ${region.y1}–${region.y2}`,
        );
        markStepEnd(id, 2);
      }
    }

    // 3. Subtitle style preview: only when NOT auto-fit (manual adjust).
    if (startStep <= 3) {
      if (cur.autoFit) {
        markStepSkipped(id, 3);
        appendLog(id, "Tự động khớp vị trí — bỏ qua bước chỉnh tay.");
      } else {
        patch(id, { stage: "subtitle_preview", resumeStep: 4 });
        markStepStart(id, 3);
        appendLog(
          id,
          "Chỉnh kích thước & vị trí phụ đề trên frame đầu tiên, nhấn Xác nhận để tiếp tục...",
        );
        let style = cur.subtitleStyle;
        if (!style) {
          style = await waitForSubtitleStyle(id);
        }
        patch(id, { subtitleStyle: style });
        appendLog(
          id,
          `Cỡ chữ ${style.font_size ?? 48}px · cách đáy ${style.margin_v ?? 40}px`,
        );
        markStepEnd(id, 3);
      }
    }

    // Prep done → enqueue the heavy processing into the sequential queue.
    enqueue(id, 4);
  } catch (e) {
    const stage = usePipelineStore
      .getState()
      .pipelines.find((x) => x.id === id)?.stage;
    patch(id, {
      status: "error",
      stage: "error",
      failedStep: stage != null ? (STEP_STAGE[stage] ?? null) : null,
      error: e instanceof Error ? e.message : "Lỗi không xác định",
      finishedAt: Date.now(),
    });
    reportPipeline(id, true);
  } finally {
    liveRunners.delete(id);
  }
}

// ── Auto checks (dedup + timeline overlap) ─────────────────────────────────
// Chạy sau OCR (trên SRT gốc) và lại sau dịch (trên SRT dịch). Backend dùng
// _srt_best_path nên tự chọn đúng file: bản dịch nếu có, ngược lại bản gốc.
async function runSrtAutoChecks(id: string, videoId: string | null) {
  if (!videoId) return;
  // 1) Nội dung trùng: gộp các dòng liền kề giống nhau >=80% (dedup).
  appendLog(id, "Kiểm tra phụ đề trùng nội dung liền kề...");
  try {
    const dedupRes = await fetch(`/api/srt/${videoId}/dedup`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
    const dedupData = await dedupRes.json();
    if (!dedupRes.ok)
      throw new Error(dedupData.detail || "Gộp phụ đề trùng thất bại");
    const changes: {
      index: number;
      merged_into: number;
      from: string;
      to: string;
    }[] = dedupData.changes ?? [];
    if (changes.length > 0) {
      appendLog(
        id,
        `Đã gộp ${changes.length} dòng phụ đề trùng (nội dung giống dòng trước ≥80%):`,
      );
      for (const c of changes) {
        appendLog(
          id,
          `  #${c.index} → gộp vào #${c.merged_into}: ${c.from}  →  ${c.to}`,
        );
      }
    } else {
      appendLog(id, "Không có dòng phụ đề trùng — nội dung hợp lệ.");
    }
  } catch (e) {
    appendLog(
      id,
      `Bỏ qua kiểm tra trùng: ${e instanceof Error ? e.message : "lỗi"}`,
    );
  }

  // 2) Timeline chồng lấn: cân chỉnh start/end để không dòng nào đè lên nhau.
  appendLog(id, "Kiểm tra & sửa overlap timeline phụ đề...");
  try {
    const fixRes = await fetch(`/api/srt/${videoId}/auto-fix-overlaps`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
    const fixData = await fixRes.json();
    if (!fixRes.ok)
      throw new Error(fixData.detail || "Tự động sửa overlap thất bại");
    const fixes: { index: number; from: string; to: string }[] =
      fixData.fixes ?? [];
    if (fixes.length > 0) {
      appendLog(
        id,
        `Đã sửa ${fixes.length} dòng chồng lấn (cân chỉnh start/end):`,
      );
      for (const f of fixes) {
        appendLog(id, `  #${f.index}: ${f.from}  →  ${f.to}`);
      }
    } else {
      appendLog(id, "Không phát hiện dòng nào chồng lấn — SRT hợp lệ.");
    }
  } catch (e) {
    appendLog(
      id,
      `Bỏ qua tự động sửa overlap: ${e instanceof Error ? e.message : "lỗi"}`,
    );
  }
}

// ── Heavy runner (OCR → context → translate → dub → hardcode → meta → thumb → youtube) ──
// Executed one video at a time via the sequential queue.
async function runPipeline(id: string, startStep = 4) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const videoId = cur.videoId;
  let sourceLang = cur.srcLang || "zh";
  let ocrLang = cur.ocrLang || "ch";
  const ocrType = detectOcrType();
  let region = cur.region;

  const tick = (i: number) => (t: JobTick) => {
    setStepProgress(id, i, t.progress);
    recalcOverall(id);
    if (t.logs) appendBackendLogs(id, t.logs);
  };

  const stageForStart =
    [
      "processing",
      "context",
      "translating",
      "dub",
      "muxing",
      "meta",
      "thumbnail",
      "youtube",
    ][startStep - 4] ?? "processing";

  patch(id, {
    status: "running",
    stage: stageForStart as Stage,
    progress: 0,
    startedAt: cur.startedAt ?? Date.now(),
    finishedAt: null,
    error: "",
    failedStep: null,
    stepProgress: cur.stepProgress.map((v, i) => (i >= startStep ? null : v)),
    stepStarts: cur.stepStarts.map((v, i) => (i >= startStep ? null : v)),
    stepEnds: cur.stepEnds.map((v, i) => (i >= startStep ? null : v)),
    stepSkipped: cur.stepSkipped.map((v, i) => (i >= startStep ? false : v)),
  });

  liveRunners.add(id);
  try {
    if (abortedPipelines.has(id)) return;

    // 4. OCR
    if (startStep <= 4) {
      if (!region) {
        region = DEFAULT_REGION;
        patch(id, { region });
        markStepSkipped(id, 2);
        appendLog(id, "Không có vùng quét — dùng mặc định.");
      }
      // Resume: nếu SRT đã tồn tại thì bỏ qua OCR, dùng thẳng phụ đề hiện có.
      appendLog(id, "Kiểm tra SRT đã có chưa…");
      let srtExists = false;
      try {
        const srtCheck = await fetch(`/api/srt/${videoId}`);
        if (srtCheck.ok) {
          try {
            const srtData = await srtCheck.json();
            srtExists = Boolean(srtData?.content?.trim());
          } catch {
            // Response is not JSON — SRT check failed, continue to OCR
          }
        }
      } catch {
        // ignore — chạy OCR bình thường
      }
      if (srtExists) {
        appendLog(id, "Phụ đề đã có sẵn — bỏ qua OCR.");
        markStepSkipped(id, 4);
        patch(id, { stage: "context" });
      } else {
        patch(id, { stage: "processing" });
        markStepStart(id, 4);
        appendLog(id, "Chạy OCR trích phụ đề...");
        const pr = await fetch("/api/process", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            video_id: videoId,
            region,
            lang: ocrLang,
            ocr_type: ocrType,
          }),
        });
        let pd: Record<string, unknown> = {};
        try {
          pd = await pr.json();
        } catch {
          const text = await pr.text().catch(() => "");
          appendLog(id, `OCR HTTP ${pr.status}: ${text.slice(0, 500)}`);
          throw new Error(
            `OCR server error ${pr.status}: ${text.slice(0, 200)}`,
          );
        }
        if (!pr.ok) {
          appendLog(
            id,
            `OCR HTTP ${pr.status}: ${(pd as any).detail || "lỗi"}`,
          );
          throw new Error((pd as any).detail || "Không thể bắt đầu OCR");
        }
        const jobId = (pd as any).job_id as string;
        const ps = await pollJob(jobId, tick(4));
        if (ps.status !== "done") throw new Error(ps.error || "OCR thất bại");
        appendLog(id, "OCR xong, đã có phụ đề.");
        // Double-check #1: chạy ngay trên SRT gốc (OCR) trước khi dịch.
        await runSrtAutoChecks(id, videoId);
        markStepEnd(id, 4);
      }
    }

    // 3.5 Watermark region selection — sau OCR (trước delogo)
    if (
      startStep <= 4 &&
      cur.removeWatermarkEnabled &&
      cur.removeWatermarkRegions.length === 0
    ) {
      patch(id, { stage: "watermark_region", resumeStep: 4 });
      markStepStart(id, 4);
      appendLog(id, "Kéo vùng watermark cần xoá trên video...");

      // Send Telegram Mini App button for watermark selection.
      // Domain lấy từ NEXT_PUBLIC_TUNNEL_URL (frontend/.env.local).
      if (videoId) {
        try {
          const videoUrl = `${process.env.NEXT_PUBLIC_TUNNEL_URL ?? ""}/api/video/${videoId}/video.mp4?duration=10`;
          const tgRes = await fetch(`/api/telegram/web-app/${videoId}`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              video_url: videoUrl,
              button_text: "🖼️ Chọn vùng watermark",
              mode: "watermark",
            }),
          });
          if (tgRes.ok) {
            appendLog(id, "Đã gửi Telegram Mini App để chọn vùng watermark.");
          }
        } catch {
          // ignore — Telegram not configured or failed
        }
      }

      const wmRegions = await waitForWatermarkRegion(id);
      patch(id, { removeWatermarkRegions: wmRegions });
      appendLog(id, `Đã chọn ${wmRegions.length} vùng watermark`);
    }

    // Re-read from store after patch to get updated removeWatermarkRegions
    const curAfterWm = usePipelineStore
      .getState()
      .pipelines.find((x) => x.id === id);
    const wmRegionsNow = curAfterWm?.removeWatermarkRegions ?? [];

    // 3.6 Delogo (remove watermark) — sau OCR
    let delogoFailed = false;
    if (startStep <= 4 && wmRegionsNow.length > 0) {
      // Check if delogo.mp4 already exists and is valid
      let skipDelogo = false;
      try {
        const statusRes = await fetch(`/api/delogo/${videoId}/status`);
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (statusData.exists && statusData.valid) {
            skipDelogo = true;
            appendLog(id, "Delogo.mp4 đã tồn tại — bỏ qua bước xoá watermark.");
            patch(id, {
              progress: 100,
              stepProgress: stepProgressFor("processing", 100),
            });
          }
        }
      } catch {
        // ignore — will run delogo
      }

      if (!skipDelogo) {
        patch(id, { stage: "processing" });
        appendLog(id, "Đang xoá watermark khỏi video...");
        appendLog(id, `Regions: ${JSON.stringify(wmRegionsNow)}`);
        try {
          const delogoRes = await fetch(`/api/delogo/${videoId}`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ regions: wmRegionsNow }),
          });

          if (!delogoRes.ok) {
            // Non-streaming error response
            let errMsg = `HTTP ${delogoRes.status}`;
            try {
              const errBody = await delogoRes.json();
              errMsg = (errBody as any).detail || errMsg;
            } catch {
              const text = await delogoRes.text().catch(() => "");
              errMsg = text.slice(0, 500) || errMsg;
            }
            appendLog(id, `Delogo HTTP error ${delogoRes.status}: ${errMsg}`);
            delogoFailed = true;
          } else {
            // SSE stream — read line by line
            const reader = delogoRes.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let delogoDone = false;

            if (reader) {
              while (!delogoDone) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  try {
                    const evt = JSON.parse(line.slice(6));
                    if (evt.type === "log") {
                      appendLog(id, `[delogo] ${evt.message}`);
                    } else if (evt.type === "progress") {
                      // Update pipeline progress AND step progress for delogo
                      const newStepProgress = stepProgressFor(
                        "processing",
                        evt.pct,
                      );
                      patch(id, {
                        progress: evt.pct,
                        stepProgress: newStepProgress,
                      });
                    } else if (evt.type === "error") {
                      appendLog(id, `[delogo] ERROR: ${evt.message}`);
                      delogoFailed = true;
                      delogoDone = true;
                    } else if (evt.type === "done") {
                      const elapsed =
                        evt.elapsed != null ? ` trong ${evt.elapsed}s` : "";
                      appendLog(
                        id,
                        `[delogo] Xoá watermark xong${elapsed} — output: ${evt.path} (${((evt.output_size || 0) / 1024 / 1024).toFixed(1)} MB)`,
                      );
                      patch(id, {
                        progress: 100,
                        stepProgress: stepProgressFor("processing", 100),
                      });
                      delogoDone = true;
                    }
                  } catch {
                    // skip malformed lines
                  }
                }
              }
            }
          }
        } catch (e) {
          appendLog(
            id,
            `Xoá watermark lỗi: ${e instanceof Error ? e.message : e}`,
          );
          delogoFailed = true;
        }
      }

      // Nếu delogo thất bại → dừng pipeline (OCR đã chạy xong).
      if (delogoFailed) {
        patch(id, { status: "error", stage: "error" });
        appendLog(
          id,
          "Xoá watermark thất bại — dừng pipeline. Vui lòng chọn lại vùng và thử lại.",
        );
        return;
      }

      if (wmRegionsNow.length > 0) {
        appendLog(id, "Delogo hoàn tất.");
      }
    }

    // 5. Context
    if (startStep <= 5) {
      const translateSkipped =
        cur.translateOn === false ||
        sourceLang === (cur.translateTarget || "vi");
      if (translateSkipped) {
        appendLog(id, "Bỏ qua phân tích ngữ cảnh (không dùng dịch tự động).");
        markStepSkipped(id, 5);
      } else {
        patch(id, { stage: "context" });
        markStepStart(id, 5);
        // Resume: nếu ngữ cảnh đã có sẵn thì bỏ qua (không tốn Gemini).
        appendLog(id, "Kiểm tra ngữ cảnh đã có chưa…");
        let ctxExists = false;
        try {
          const ctxCheck = await fetch(`/api/context/${videoId}`);
          if (ctxCheck.ok) {
            const ctxData = await ctxCheck.json();
            ctxExists = Boolean(ctxData?.context?.trim());
          }
        } catch {
          // ignore
        }
        if (ctxExists) {
          appendLog(id, "Ngữ cảnh đã có sẵn — bỏ qua.");
          markStepSkipped(id, 5);
        } else {
          appendLog(id, "Phân tích ngữ cảnh video (Gemini Vision)...");
          try {
            const cr = await fetch(`/api/context/${videoId}/generate`, {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({
                target_lang: cur.translateTarget || "vi",
              }),
            });
            const cd = await cr.json();
            if (cr.ok && cd.job_id) {
              patch(id, { contextOn: true });
              const cs = await pollJob(cd.job_id, tick(5));
              appendLog(
                id,
                cs.status === "done" ? "Ngữ cảnh xong." : "Bỏ qua ngữ cảnh.",
              );
            } else {
              appendLog(
                id,
                "Không thể sinh ngữ cảnh (thiếu Gemini key?) — tiếp tục.",
              );
            }
          } catch {
            appendLog(id, "Bỏ qua ngữ cảnh.");
          }
        }
        markStepEnd(id, 5);
      }
    }

    // 6. Translate + save
    if (startStep <= 6) {
      patch(id, { stage: "translating" });
      markStepStart(id, 6);
      const translateTarget = cur.translateTarget || "vi";

      let translateSkipped = false;
      if (cur.translateOn === false) {
        appendLog(id, "Đã tắt dịch tự động — giữ nguyên phụ đề gốc.");
        translateSkipped = true;
      } else if (sourceLang === translateTarget) {
        appendLog(
          id,
          `Ngôn ngữ đích (${langLabel(translateTarget)}) trùng ngôn ngữ gốc — giữ nguyên phụ đề gốc.`,
        );
        translateSkipped = true;
      } else {
        // Resume: fetch 1 lần — nếu bản dịch đúng ngôn ngữ đích đã tồn tại thì
        // dùng thẳng kết quả (tránh fetch 2 lần cùng URL).
        let translatedExists = false;
        let srtText = "";
        try {
          const srtRes = await fetch(
            `/api/download/translated/${videoId}?lang=${translateTarget}`,
          );
          translatedExists = srtRes.ok;
          if (translatedExists) srtText = await srtRes.text();
        } catch {
          // ignore
        }
        if (!translatedExists) {
          appendLog(
            id,
            `Dịch Gemini (${langLabel(sourceLang)} → ${langLabel(translateTarget)})...`,
          );
          const tr = await fetch(`/api/translate/${videoId}`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              source_lang: sourceLang,
              target_lang: translateTarget,
              multi_voice: cur.multiVoice,
            }),
          });
          const td = await tr.json();
          if (!tr.ok) throw new Error(td.detail || "Dịch thất bại");
          const ts = await pollJob(td.job_id, tick(6));
          if (ts.status !== "done")
            throw new Error(ts.error || "Dịch thất bại");
          appendLog(id, "Dịch xong.");
        } else {
          appendLog(id, "Bản dịch đã có sẵn — dùng lại, bỏ qua dịch.");
        }

        patch(id, { stage: "saving" });
        appendLog(id, "Ghi đè phụ đề dịch lên file SRT hiện tại...");
        if (!translatedExists || !srtText) {
          const srtRes = await fetch(
            `/api/download/translated/${videoId}?lang=${translateTarget}`,
          );
          if (!srtRes.ok) {
            throw new Error(
              "Không tải được bản dịch phụ đề (máy chủ trả lỗi). Vui lòng chạy lại bước dịch.",
            );
          }
          srtText = await srtRes.text();
        }

        // Đối chiếu với file gốc TRƯỚC khi ghi đè: phát hiện khoảng thời gian
        // trong bản gốc mà bản dịch không phủ (dòng bị rơi mất) và dòng chưa
        // được dịch. Chỉ báo log, không chặn pipeline.
        appendLog(id, "Đối chiếu phụ đề dịch với file gốc...");
        try {
          const cmpRes = await fetch(`/api/srt/${videoId}/compare`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ content: srtText }),
          });
          const cmpData = await cmpRes.json();
          if (!cmpRes.ok)
            throw new Error(cmpData.detail || "Đối chiếu thất bại");
          const missing: { from: string; to: string; duration: number }[] =
            cmpData.missing_ranges ?? [];
          if (missing.length > 0) {
            appendLog(
              id,
              `Cảnh báo: ${missing.length} khoảng thời gian ở bản gốc không có trong bản dịch:`,
            );
            for (const g of missing) {
              appendLog(id, `  ${g.from} --> ${g.to} (${g.duration}s)`);
            }
          } else {
            appendLog(id, "Timeline bản dịch phủ đầy đủ file gốc.");
          }
          const untranslated: { index: number; text: string }[] =
            cmpData.untranslated ?? [];
          if (untranslated.length > 0) {
            appendLog(
              id,
              `Cảnh báo: ${untranslated.length} dòng chưa được dịch (còn giữ nguyên bản gốc):`,
            );
            for (const u of untranslated) {
              appendLog(id, `  #${u.index}: ${u.text}`);
            }
            // Tự động dịch lại các dòng chưa được dịch rồi dùng bản đã vá.
            appendLog(id, "Tự động dịch lại các dòng chưa dịch...");
            try {
              const retRes = await fetch(`/api/srt/${videoId}/retranslate`, {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({
                  content: srtText,
                  source_lang: sourceLang,
                  target_lang: translateTarget,
                }),
              });
              const retData = await retRes.json();
              if (!retRes.ok)
                throw new Error(retData.detail || "Dịch lại thất bại");
              if (retData.updated && retData.content) {
                srtText = retData.content;
                appendLog(id, "Đã dịch lại xong các dòng chưa dịch.");
              } else {
                appendLog(id, "Không có dòng nào được cập nhật thêm.");
              }
            } catch (e) {
              appendLog(
                id,
                `Dịch lại thất bại: ${e instanceof Error ? e.message : "lỗi"}`,
              );
            }
          } else {
            appendLog(
              id,
              "Đã dịch hết — không còn dòng nào giữ nguyên bản gốc.",
            );
          }
        } catch (e) {
          appendLog(
            id,
            `Bỏ qua đối chiếu bản gốc: ${e instanceof Error ? e.message : "lỗi"}`,
          );
        }

        // Chạy dedup + fix overlap trên BẢN DỊCH (endpoint dùng _srt_best_path
        // nên khi đã có bản dịch sẽ thao tác trên file dịch) để ra file SRT cuối,
        // rồi mới tới bước kiểm tra timeline thủ công.
        await runSrtAutoChecks(id, videoId);

        // (Optional) pause for the user to review the translated SRT in the
        // timeline-check popup (only when checkSubs is on). No auto-skip.
        if (cur.checkSubs && videoId) {
          appendLog(id, "Kiểm tra timeline phụ đề đã dịch...");
          try {
            const checkRes = await fetch(`/api/srt/${videoId}/validate`);
            const checkData = await checkRes.json();
            const issues: TimelineIssue[] = checkData.issues ?? [];
            patch(id, {
              timelineCheck: {
                waiting: true,
                open: false,
                issues,
                fixing: false,
              },
            });
            // Report the pause so other tabs/browsers can show the same popup,
            // and let a remote "Tiếp tục xử lý" / "Sửa timeline" unblock us.
            reportTimelineAction(videoId, "wait", issues).catch(() => {});
            // Telegram Mini App button — duyệt timeline từ điện thoại.
            try {
              await fetch(`/api/telegram/web-app/${videoId}`, {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({
                  button_text: "📝 Kiểm tra phụ đề",
                  mode: "timeline",
                }),
              });
              appendLog(id, "Đã gửi nút Mini App kiểm tra sub qua Telegram.");
            } catch {
              /* ignore */
            }
            appendLog(
              id,
              issues.length > 0
                ? `Phát hiện ${issues.length} lỗi timeline — chờ bạn duyệt.`
                : "Timeline hợp lệ — hiển thị popup để bạn duyệt.",
            );
            patch(id, { resumeStep: 7 });
            const decisionAbort = new AbortController();
            let choice: "fix" | "continue";
            try {
              choice = await Promise.race([
                waitForTimelineCheck(id),
                pollBackendTimelineDecision(videoId, id, decisionAbort.signal),
              ]);
            } finally {
              decisionAbort.abort();
            }
            if (choice === "fix") {
              appendLog(id, "Đã tự sửa timeline phụ đề (giữ sub dài nhất).");
            } else {
              appendLog(id, "Bỏ qua — giữ nguyên timeline hiện tại.");
            }
          } catch (e) {
            appendLog(
              id,
              `Bỏ qua kiểm tra timeline: ${e instanceof Error ? e.message : "lỗi"}`,
            );
          } finally {
            patch(id, { timelineCheck: null });
          }
        }
      }

      // Multi-voice: đảm bảo voice_map.json tồn tại — kể cả khi dịch bị bỏ qua.
      // Chờ tạo xong (Gemini) rồi mới chuyển sang bước lồng tiếng.
      if (cur.multiVoice && videoId) {
        await ensureVoiceMap(videoId, id, translateTarget);
      }

      if (translateSkipped) markStepSkipped(id, 6);
      else markStepEnd(id, 6);
    }

    // 7. Dub
    if (startStep <= 7) {
      patch(id, { stage: "dub" });
      markStepStart(id, 7);
      if (cur.dubOn === false) {
        appendLog(id, "Đã tắt lồng tiếng tự động — bỏ qua bước lồng tiếng.");
        markStepSkipped(id, 7);
      } else {
        // Resume: nếu audio lồng tiếng đã tồn tại thì bỏ qua.
        let dubbedExists = false;
        try {
          const dubbedCheck = await fetch(`/api/download/dubbed/${videoId}`);
          dubbedExists = dubbedCheck.ok;
        } catch {
          // ignore
        }
        if (dubbedExists) {
          patch(id, { dubbedUrl: `/api/download/dubbed/${videoId}` });
          appendLog(id, "Audio lồng tiếng đã có sẵn — bỏ qua.");
          markStepSkipped(id, 7);
        } else {
          const engine = cur.dubEngine === "capcut" ? "capcut" : "google";
          // Voice must match the engine: CapCut voices (BV*/AV*...) are rejected by
          // Google TTS with 400 "Voice does not exist". Only send dubVoice when the
          // engine is CapCut; Google always uses a Google voice.
          const voice =
            engine === "capcut"
              ? cur.dubVoice || "BV421_vivn_streaming"
              : cur.dubVoice &&
                  !cur.dubVoice.startsWith("BV") &&
                  !cur.dubVoice.startsWith("AV")
                ? cur.dubVoice
                : "vi-VN-Standard-B";
          appendLog(
            id,
            engine === "capcut"
              ? `Tách giọng & lồng tiếng Việt (CapCut voice: ${voice})...`
              : "Tách giọng & lồng tiếng Việt (Google TTS)...",
          );
          // Multi-voice: phải chờ tạo xong voice_map.json rồi mới được lồng tiếng
          // (kể cả khi chạy lại/resume từ bước này mà voice_map chưa có).
          if (cur.multiVoice && engine === "capcut" && videoId) {
            await ensureVoiceMap(videoId, id, cur.translateTarget || "vi");
          }
          try {
            const dr = await fetch(`/api/dub/${videoId}`, {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({
                voice,
                engine,
                mute_original: cur.muteOriginal,
                original_gain_db: cur.originalGainDb,
                multi_voice: cur.multiVoice && engine === "capcut",
              }),
            });
            const dd = await dr.json();
            if (dr.ok && dd.job_id) {
              const ds = await pollJob(dd.job_id, tick(7));
              if (ds.status === "done") {
                patch(id, { dubbedUrl: `/api/download/dubbed/${videoId}` });
                appendLog(id, "Audio lồng tiếng Việt xong.");
              } else {
                appendLog(id, `Bỏ qua lồng tiếng: ${ds.error || "thất bại"}`);
              }
            } else {
              appendLog(
                id,
                `Bỏ qua lồng tiếng: ${dd.detail || "không thể bắt đầu"}`,
              );
            }
          } catch {
            appendLog(id, "Bỏ qua lồng tiếng (lỗi).");
          }
          markStepEnd(id, 7);
        }
      }

      // Voice check: pause for user to review per-line voice assignment AFTER dub
      if (cur.checkVoice && videoId) {
        appendLog(id, "Kiểm tra giọng đọc từng dòng...");
        patch(id, {
          voiceCheck: { waiting: true, open: false },
        });
        patch(id, { resumeStep: 8 });
        // Report pause + Telegram Mini App button — duyệt voice từ điện thoại.
        fetch(`/api/pipeline/${videoId}/voice`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ action: "wait" }),
        }).catch(() => {});
        try {
          await fetch(`/api/telegram/web-app/${videoId}`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              button_text: "🎙 Kiểm tra giọng đọc",
              mode: "voice",
            }),
          });
          appendLog(id, "Đã gửi nút Mini App kiểm tra voice qua Telegram.");
        } catch {
          /* ignore */
        }
        try {
          const voiceAbort = new AbortController();
          await Promise.race([
            waitForVoiceCheck(id),
            pollBackendVoiceDecision(videoId, id, voiceAbort.signal),
          ]);
          voiceAbort.abort();
          appendLog(id, "Đã xác nhận giọng đọc.");
        } catch (e) {
          appendLog(
            id,
            `Bỏ qua kiểm tra giọng: ${e instanceof Error ? e.message : "lỗi"}`,
          );
        } finally {
          patch(id, { voiceCheck: null });
        }
      }
    }

    // 8. Hardcode
    if (startStep <= 8) {
      patch(id, { stage: "muxing" });
      markStepStart(id, 8);
      // Resume: nếu video đã có phụ đề cứng thì bỏ qua — nhưng PHẢI encode lại
      // khi bật watermark (video cũ chưa có watermark) để chữ/logo xuất hiện.
      let hardcodedExists = false;
      try {
        const hcCheck = await fetch(`/api/download/hardcoded/${videoId}`);
        hardcodedExists = hcCheck.ok;
      } catch {
        // ignore
      }
      if (hardcodedExists && !cur.watermark) {
        appendLog(id, "Video đã có phụ đề cứng — bỏ qua encode.");
        markStepSkipped(id, 8);
      } else {
        if (hardcodedExists) {
          appendLog(
            id,
            "Đã có phụ đề cứng nhưng bật watermark — encode lại để chèn watermark.",
          );
        }
        appendLog(id, "FFmpeg nhúng SRT (ASS black box) vào video...");
        const hr = await fetch(`/api/hardcode/${videoId}`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            auto_fit: cur.autoFit,
            region: cur.region ?? DEFAULT_REGION,
            style: cur.autoFit ? null : (cur.subtitleStyle ?? null),
            watermark: cur.watermark,
            watermark_preset: cur.watermark
              ? cur.watermarkPreset || null
              : null,
          }),
        });
        const hd = await hr.json();
        if (!hr.ok) throw new Error(hd.detail || "Nhúng SRT thất bại");
        const hs = await pollJob(hd.job_id, tick(8));
        if (hs.status !== "done")
          throw new Error(hs.error || "Nhúng SRT thất bại");
        markStepEnd(id, 8);
      }
    }

    // 9 + 10. Meta (Gemini) và Thumbnail (fal.ai/ChatGPT) KHÔNG phụ thuộc nhau:
    // chạy song song để tiết kiệm thời gian chờ (trước đây chạy tuần tự).
    let abortAfterThumbnail = false;

    const doMeta = async () => {
      if (startStep > 9) return;
      patch(id, { stage: "meta" });
      markStepStart(id, 9);
      appendLog(id, "Tạo meta (tiêu đề/mô tả/tags) từ ngữ cảnh...");
      try {
        const mr = await fetch(`/api/meta/${videoId}`, { method: "POST" });
        const md = await mr.json();
        if (mr.ok && md.meta) {
          patch(id, { meta: md.meta });
          appendLog(id, `Meta: ${md.meta.title || "(không có tiêu đề)"}`);
        } else {
          appendLog(id, `Không tạo được meta: ${md.detail || "lỗi"}`);
        }
      } catch {
        appendLog(id, "Bỏ qua tạo meta (lỗi).");
      }
      markStepEnd(id, 9);
    };

    const doThumbnail = async () => {
      if (startStep > 10) return;
      // Skip if thumbnail already exists (from previous run or already generated)
      if (cur.updatedThumbnailUrl) {
        appendLog(id, `Thumbnail đã có sẵn: ${cur.updatedThumbnailUrl}`);
        markStepSkipped(id, 10);
        return;
      }
      patch(id, { stage: "thumbnail" });
      markStepStart(id, 10);

      let hasFalKey = false;
      try {
        const cfg = await fetch("/api/config").then((r) => r.json());
        hasFalKey = !!cfg.has_fal_key;
      } catch {
        // ignore
      }

      // FAL flow, tách riêng để dùng lại khi ChatGPT không trả ảnh.
      const runFalThumbnail = async () => {
        appendLog(id, "Cập nhật thumbnail (fal.ai)...");
        try {
          await fetch(`/api/thumbnail/${videoId}`, { method: "POST" });

          const deadline = Date.now() + 180_000;
          let thumbUrl: string | null = null;
          let errorMsg: string | null = null;
          let done = false;

          while (!done && Date.now() < deadline) {
            try {
              const st = await fetch(`/api/thumbnail/${videoId}/status`).then(
                (r) => r.json(),
              );
              if (st.status === "done" && st.thumbnail_url) {
                thumbUrl = st.thumbnail_url;
                done = true;
              } else if (st.status === "error") {
                errorMsg = st.error || "lỗi";
                done = true;
              }
            } catch {
              // ignore transient poll errors
            }
            if (!done) await new Promise((r) => setTimeout(r, 2000));
          }

          if (thumbUrl) {
            patch(id, { updatedThumbnailUrl: thumbUrl });
            appendLog(id, `Thumbnail mới: ${thumbUrl}`);
          } else if (errorMsg) {
            appendLog(id, `Không cập nhật được thumbnail: ${errorMsg}`);
          } else {
            appendLog(id, "Hết thời gian chờ thumbnail (180s).");
          }
        } catch (e) {
          appendLog(
            id,
            `Bỏ qua cập nhật thumbnail (lỗi): ${(e as Error)?.message || e}`,
          );
        }
        markStepEnd(id, 10);
      };

      if (cur.useGptThumbnail) {
        appendLog(id, "Cập nhật thumbnail (ChatGPT)...");
        let thumbUrl: string | null = null;
        let loginNeeded = false;
        let gptNoImage = false;
        try {
          const body: Record<string, unknown> = { video_id: videoId };
          if (cur.thumbnailReview?.extraInstructions) {
            body.extra_instructions = cur.thumbnailReview.extraInstructions;
          }
          const r = await fetch("/api/chatgpt-thumbnail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const d = await r.json();
          if (d.status === "done" && d.thumbnail_url) {
            thumbUrl = d.thumbnail_url;
          } else if (d.status === "need_login") {
            loginNeeded = true;
          } else {
            gptNoImage = true;
            appendLog(id, `ChatGPT không trả về ảnh: ${d.detail || "lỗi"}`);
          }
        } catch (e) {
          gptNoImage = true;
          appendLog(
            id,
            `Bỏ qua cập nhật thumbnail ChatGPT (lỗi): ${(e as Error)?.message || e}`,
          );
        }

        if (loginNeeded) {
          patch(id, {
            needChatgptLogin: true,
            status: "error",
            stage: "thumbnail",
          });
          appendLog(
            id,
            `Cần đăng nhập ChatGPT: Mở profile ChatGPT, đăng nhập, rồi nhấn Thử lại.`,
          );
          markStepEnd(id, 10);
          abortAfterThumbnail = true;
          return;
        }

        if (gptNoImage) {
          // ChatGPT không trả ảnh → cho user chọn: đổi qua fal.ai hoặc bỏ qua.
          patch(id, { thumbnailFallback: { waiting: true }, resumeStep: 10 });
          appendLog(
            id,
            "ChatGPT không tạo được ảnh — chọn đổi qua fal.ai hoặc bỏ qua.",
          );
          const choice = await waitForThumbnailFallback(id);
          if (choice === "skip") {
            appendLog(id, "Bỏ qua cập nhật thumbnail.");
            markStepSkipped(id, 10);
            return;
          }
          // "fal" → chạy FAL (nếu có key, ngược lại bỏ qua).
          if (hasFalKey) {
            await runFalThumbnail();
          } else {
            appendLog(id, "Không có FAL key — bỏ qua cập nhật thumbnail.");
            markStepSkipped(id, 10);
          }
          return;
        }

        if (thumbUrl) {
          patch(id, { updatedThumbnailUrl: thumbUrl, needChatgptLogin: false });
          appendLog(id, `Thumbnail mới (ChatGPT): ${thumbUrl}`);

          // Pause for user review
          patch(id, {
            stage: "thumbnail_review",
            thumbnailReview: {
              waiting: true,
              imageUrl: thumbUrl,
              extraInstructions: "",
            },
            resumeStep: 10,
          });
          appendLog(id, "Duyệt thumbnail: Chấp nhận hoặc Tạo lại...");
          const reviewResult = await waitForThumbnailReview(id);

          if (reviewResult.action === "skip") {
            patch(id, { updatedThumbnailUrl: null });
            appendLog(id, "Bỏ qua thumbnail ChatGPT.");
          } else if (reviewResult.extra) {
            // Regenerate with extra instructions — loop back
            patch(id, {
              stage: "thumbnail",
              thumbnailReview: {
                waiting: false,
                imageUrl: null,
                extraInstructions: reviewResult.extra,
              },
            });
            appendLog(
              id,
              `Tạo lại thumbnail với hướng dẫn: ${reviewResult.extra}`,
            );
            // Re-run step 10 from the top (will use the extra_instructions in the body)
            markStepEnd(id, 10);
            // Use setTimeout to avoid deep recursion; enqueue will pick up from step 10
            enqueue(id, 10);
            abortAfterThumbnail = true;
            return;
          }
          // "accept" → keep updatedThumbnailUrl, continue
        }
        markStepEnd(id, 10);
      } else if (!cur.useFalThumbnail) {
        appendLog(id, "Bỏ qua cập nhật thumbnail (tắt fal.ai edit thumbnail).");
        markStepSkipped(id, 10);
      } else if (!hasFalKey) {
        appendLog(id, "Bỏ qua cập nhật thumbnail (chưa có FAL key).");
        markStepSkipped(id, 10);
      } else {
        await runFalThumbnail();
      }
    };

    await Promise.all([doMeta(), doThumbnail()]);
    if (abortAfterThumbnail) return;

    // 11. Upload YouTube (chỉ khi bật auto upload)
    if (startStep <= 11) {
      if (!cur.autoUploadYoutube) {
        appendLog(id, "Bỏ qua upload YouTube (tự động up tắt).");
        markStepSkipped(id, 11);
      } else {
        patch(id, { stage: "youtube" });
        markStepStart(id, 11);
        appendLog(id, "Upload YouTube (kèm meta)...");
        try {
          const channelId = cur.youtubeChannel || "";
          const ur = await fetch(
            `/api/youtube/upload/${videoId}${channelId ? `?channel_id=${encodeURIComponent(channelId)}` : ""}`,
            { method: "POST" },
          );
          const ud = await ur.json();
          if (ur.ok && ud.job_id) {
            const us = await pollYoutubeUpload(ud.job_id, tick(11));
            if (us.status === "done") {
              appendLog(id, "Upload YouTube hoàn tất!");
            } else {
              appendLog(id, `Upload YouTube thất bại: ${us.error || "lỗi"}`);
            }
          } else {
            appendLog(
              id,
              `Bỏ qua upload YouTube: ${ud.detail || "chưa cấu hình"}`,
            );
          }
        } catch {
          appendLog(id, "Bỏ qua upload YouTube (lỗi).");
        }
        markStepEnd(id, 11);
      }
    }

    patch(id, {
      status: "done",
      stage: "done",
      progress: 100,
      resultUrl: `/api/download/hardcoded/${videoId}`,
      finishedAt: Date.now(),
    });
    appendLog(id, "Hoàn tất!");
    reportPipeline(id, true);
  } catch (e) {
    const stage = usePipelineStore
      .getState()
      .pipelines.find((x) => x.id === id)?.stage;
    patch(id, {
      status: "error",
      stage: "error",
      failedStep: stage != null ? (STEP_STAGE[stage] ?? null) : null,
      error: e instanceof Error ? e.message : "Lỗi không xác định",
      finishedAt: Date.now(),
    });
    reportPipeline(id, true);
  } finally {
    liveRunners.delete(id);
  }
}

// ── Persisted-state resume ─────────────────────────────────────────────────
// After a page reload, the store is rehydrated from localStorage but all runner
// coroutines are dead and the waiter maps are empty. This walks every pipeline
// that was mid-flight and resumes it:
//   • Interactive waits (region / subtitle style / timeline check) → left alone;
//     the confirm handlers re-start the runner via resumeStep when the user acts.
//   • Heavy steps → re-attaches to the still-running backend job (if any) so it
//     doesn't start a duplicate, then continues the chain from the next step.
//   • Prep steps → restarts the prep runner from the current step (or skips to
//     region if the video was already imported).
let restoreRunning = false;

async function runRestorePaused() {
  if (restoreRunning) return;
  restoreRunning = true;
  try {
    const pipes = usePipelineStore.getState().pipelines;
    for (const p of pipes) {
      if (p.status !== "running" && p.status !== "queued") continue;
      if (liveRunners.has(p.id)) continue;

      // Interactive waits: nothing to do — the confirm/resolve handlers resume.
      if (p.stage === "region" || p.stage === "subtitle_preview") continue;
      if (p.stage === "thumbnail_review") continue;
      if (p.timelineCheck?.waiting) continue;

      const stepIdx = STEP_STAGE[p.stage];
      if (stepIdx == null) {
        // Freshly-added pipeline that hadn't started prep yet (stage idle).
        if (p.stage === "idle") runPrep(p.id, 0);
        continue;
      }

      // Remote job-tracker pipelines (importActive) follow the backend directly;
      // restart their poller instead of re-running the heavy chain.
      if (p.id.startsWith("remote-")) {
        if (p.videoId) pollRemoteVideo(p.id, p.videoId);
        continue;
      }

      // Prep steps (0-3)
      if (stepIdx <= 3) {
        const resumeFrom = p.videoId && stepIdx < 2 ? 2 : stepIdx;
        runPrep(p.id, resumeFrom);
        continue;
      }

      // Heavy steps (4-8)
      await resumeHeavy(p.id, p.videoId, stepIdx, p.stage);
    }
  } finally {
    restoreRunning = false;
  }
}

// Re-attach a heavy step to the backend. If a job is still queued/processing for
// this video, follow it to completion (mirroring progress) and continue the chain
// from the next step. Otherwise resume the runner at the current step — the
// idempotent skip checks (SRT / context / translated / dubbed / hardcoded) make
// re-running cheap and safe.
async function resumeHeavy(
  id: string,
  videoId: string | null,
  stepIdx: number,
  stage: Stage,
) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;

  if (!videoId) {
    enqueue(id, stepIdx);
    return;
  }

  let activeRow: VideoMeta | null = null;
  try {
    const videos = await listVideos();
    const row = videos.find(
      (v) =>
        v.video_id === videoId &&
        v.job_id &&
        (v.status === "queued" || v.status === "processing"),
    );
    activeRow = row ?? null;
  } catch {
    // ignore — treat as no active job
  }

  if (activeRow) {
    const jobStage = stageForJobType(activeRow.job_type, activeRow.phase);
    const jobIdx = STEP_STAGE[jobStage] ?? stepIdx;
    patch(id, {
      status: "running",
      stage: jobStage,
      progress: activeRow.progress ?? 0,
      startedAt: cur.startedAt ?? Date.now(),
      error: "",
      failedStep: null,
      stepProgress: stepProgressFor(jobStage, activeRow.progress ?? 0),
    });
    const tick = (t: JobTick) => {
      setStepProgress(id, jobIdx, t.progress);
      recalcOverall(id);
      if (t.logs) appendBackendLogs(id, t.logs);
    };
    const st = await pollJob(activeRow.job_id as string, tick);
    if (st.status === "error") {
      patch(id, {
        status: "error",
        stage: "error",
        failedStep: jobIdx,
        error: st.error ?? "Lỗi xử lý",
        finishedAt: Date.now(),
      });
      return;
    }
    // The backend may have advanced past where the UI left off (e.g. reload
    // during OCR but translate already running) — mark the skipped steps done.
    for (let i = Math.min(stepIdx, jobIdx); i <= jobIdx; i++) {
      markStepEnd(id, i);
    }
    enqueue(id, jobIdx + 1);
  } else {
    enqueue(id, stepIdx);
  }
}
