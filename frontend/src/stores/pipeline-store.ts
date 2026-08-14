"use client";

import { create } from "zustand";
import type { Region, SubtitleStyle } from "@/lib/api";

export const STEPS = [
  { label: "Phân tích link", detail: "Mở link Douyin lấy URL video" },
  { label: "Merge video + audio", detail: "Gộp 2 file nếu có audio riêng" },
  { label: "Chọn vùng quét sub", detail: "Kéo vùng trên video để lấy phụ đề" },
  { label: "Chỉnh kích thước & vị trí sub", detail: "Xem trước, chỉnh cỡ chữ và vị trí" },
  { label: "OCR trích phụ đề", detail: "Nhận dạng chữ trong vùng đã chọn" },
  { label: "Phân tích ngữ cảnh", detail: "Gemini Vision phân tích video" },
  { label: "Dịch Gemini", detail: "Dịch phụ đề sang tiếng Việt" },
  { label: "Lồng tiếng Việt", detail: "Tách giọng + TTS Việt + giữ nhạc nền" },
  { label: "Nhúng SRT vào video", detail: "FFmpeg gộp SRT mới vào MP4" },
];

export type Stage =
  | "idle"
  | "resolving"
  | "merging"
  | "region"
  | "subtitle_preview"
  | "processing"
  | "context"
  | "translating"
  | "saving"
  | "dub"
  | "muxing"
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
};

export const DEFAULT_REGION: Region = { x1: 0.114, y1: 0.748, x2: 0.863, y2: 0.972 };

export interface LogEntry {
  message: string;
  ts: number;
  level: string;
}

export interface Pipeline {
  id: string;
  url: string;
  title: string;
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
  ocrEngine: string;
  ocrLang: string;
  srcLang: string;
  contextOn: boolean;
  region: Region | null;
  regionMode: "manual" | "auto";
  subtitleStyle: Partial<SubtitleStyle> | null;
  dubEngine: "google" | "capcut";
  dubVoice: string;
  muteOriginal: boolean;
  originalGainDb: number;
  autoFit: boolean;
}

export interface DubOptions {
  engine: "google" | "capcut";
  voice: string;
  muteOriginal: boolean;
  originalGainDb: number;
}

const DEFAULT_DUB: DubOptions = {
  engine: "capcut",
  voice: "BV421_vivn_streaming",
  muteOriginal: true,
  originalGainDb: 0,
};

interface PipelineState {
  pipelines: Pipeline[];
  addPipeline: (url: string, regionMode?: "manual" | "auto", dub?: Partial<DubOptions>, autoFit?: boolean) => string;
  updatePipeline: (id: string, patch: Partial<Pipeline>) => void;
  removePipeline: (id: string) => void;
  clearFinished: () => void;
  rerunPipeline: (id: string, step: number) => void;
  confirmRegion: (id: string, region: Region) => void;
  confirmSubtitleStyle: (id: string, style: Partial<SubtitleStyle>) => void;
  cancelPipeline: (id: string) => void;
}

function emptySteps<T>(v: T): T[] {
  return STEPS.map(() => v);
}

function newPipeline(
  id: string,
  url: string,
  regionMode: "manual" | "auto" = "manual",
  dub: Partial<DubOptions> = {},
  autoFit = true,
): Pipeline {
  const d: DubOptions = { ...DEFAULT_DUB, ...dub };
  return {
    id,
    url,
    title: "",
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
    ocrEngine: "",
    ocrLang: "",
    srcLang: "",
    contextOn: false,
    region: null,
    regionMode,
    subtitleStyle: null,
    dubEngine: d.engine,
    dubVoice: d.voice,
    muteOriginal: d.muteOriginal,
    originalGainDb: d.originalGainDb,
    autoFit,
  };
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  pipelines: [],
  addPipeline: (url, regionMode = "manual", dub = {}, autoFit = true) => {
    const id = Math.random().toString(36).slice(2, 10);
    set((s) => ({ pipelines: [...s.pipelines, newPipeline(id, url, regionMode, dub, autoFit)] }));
    runPrep(id);
    return id;
  },
  updatePipeline: (id, patch) => {
    set((s) => ({
      pipelines: s.pipelines.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  },
  removePipeline: (id) => {
    set((s) => ({ pipelines: s.pipelines.filter((p) => p.id !== id) }));
  },
  clearFinished: () => {
    set((s) => ({
      pipelines: s.pipelines.filter((p) => p.status !== "done" && p.status !== "error"),
    }));
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
          ? { ...p, region, stage: p.autoFit ? "processing" : "subtitle_preview" }
          : p
      ),
    }));
    const resolve = regionWaiters.get(id);
    if (resolve) {
      regionWaiters.delete(id);
      resolve.resolve(region);
    }
  },
  confirmSubtitleStyle: (id, style) => {
    const s = get().pipelines.find((p) => p.id === id);
    if (!s) return;
    set((st) => ({
      pipelines: st.pipelines.map((p) =>
        p.id === id ? { ...p, subtitleStyle: style, stage: "processing" } : p
      ),
    }));
    const resolve = subtitleStyleWaiters.get(id);
    if (resolve) {
      subtitleStyleWaiters.delete(id);
      resolve.resolve(style);
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
    if (videoId) {
      try {
        await fetch(`/api/video/${videoId}/abort`, { method: "POST" });
      } catch {
        // ignore
      }
    }
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const JSON_HEADERS = { "Content-Type": "application/json" };

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
  if (code === "zh" || code === "ch") return "Tiếng Trung";
  if (code === "en") return "Tiếng Anh";
  if (code === "vi") return "Tiếng Việt";
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
  for (let i = 0; i < 1200; i++) {
    await sleep(1500);
    try {
      const r = await fetch(`/api/status/${jobId}`);
      if (!r.ok) continue;
      const d = await r.json();
      onTick({ progress: d.progress ?? 0, logs: d.logs });
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
      if (d.status === "cancelled") return { status: "error", error: "Đã hủy" };
    } catch {
      // ignore transient
    }
  }
  return { status: "error", error: "Quá thời gian chờ" };
}

async function pollMerge(jobId: string, onTick: (t: JobTick) => void) {
  for (let i = 0; i < 1200; i++) {
    await sleep(800);
    try {
      const r = await fetch(`/api/video-merge/${jobId}`);
      if (!r.ok) continue;
      const d = await r.json();
      onTick({ progress: d.progress ?? 0, logs: d.logs });
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
    } catch {
      // ignore transient
    }
  }
  return { status: "error", error: "Quá thời gian chờ" };
}

// ── Queue ──────────────────────────────────────────────────────────────────

let queue: { id: string; startStep: number }[] = [];
let processing = false;
const abortedPipelines = new Set<string>();
const regionWaiters = new Map<string, { resolve: (r: Region) => void; reject: () => void }>();
const subtitleStyleWaiters = new Map<string, { resolve: (s: Partial<SubtitleStyle>) => void; reject: () => void }>();

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

function enqueue(id: string, startStep = 0) {
  queue.push({ id, startStep });
  processQueue();
}

// After a video finishes, tell the backend to delete intermediate temp data,
// keeping only the final deliverables (hardcoded video, SRT, dubbed video,
// meta.json, project state) so the result stays reviewable.
function cleanupTempForVideo(videoId: string | null) {
  if (!videoId) return;
  fetch(`/api/video/${videoId}/cleanup`, { method: "POST" }).catch(() => {
    // best-effort; failure is non-fatal
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
  patch(id, { logs: [...cur.logs, entry] });
}

function appendBackendLogs(id: string, entries: LogEntry[]) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const seen = new Set(cur.logs.map((l) => `${Math.round(l.ts)}::${l.message}`));
  const fresh = entries.filter((e) => !seen.has(`${Math.round(e.ts)}::${e.message}`));
  if (fresh.length === 0) return;
  patch(id, { logs: [...cur.logs, ...fresh] });
}

function setStepProgress(id: string, i: number, p: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, { stepProgress: cur.stepProgress.map((v, idx) => (idx === i ? p : v)) });
}

function recalcOverall(id: string) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const total = cur.stepProgress.reduce((acc: number, v) => acc + (v ?? 0), 0);
  const overall = Math.round(total / STEPS.length);
  patch(id, { progress: overall });
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

  const stageForStart = ["resolving", "merging", "region", "subtitle_preview"][startStep] ?? "resolving";

  patch(id, {
    status: "running",
    stage: stageForStart as Stage,
    progress: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: "",
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

  try {
    if (abortedPipelines.has(id)) return;
    // 0. Resolve link
    if (startStep <= 0) {
      const cleaned = extractUrl(rawUrl);
      if (!cleaned) throw new Error("Không tìm thấy link (https://...) trong nội dung đã dán.");
      markStepStart(id, 0);
      appendLog(id, "Đang phân tích link...");
      const r = await fetch("/api/video-download/resolve", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ url: cleaned }),
      });
      const rd = await r.json();
      if (!r.ok) throw new Error(rd.detail || "Không thể phân tích link");
      videoUrl = rd.video_url ?? null;
      audioUrl = rd.audio_url ?? null;
      sourceLang = detectSourceLang(cleaned);
      ocrLang = detectOcrLang(sourceLang);
      patch(id, {
        videoUrl,
        audioUrl,
        title: rd.title || "",
        srcLang: sourceLang,
        ocrLang,
        ocrEngine: ocrType === "apple" ? "Apple Vision" : "RapidOCR",
      });
      appendLog(id, `Đã lấy URL video${audioUrl ? " + audio" : ""} · ngôn ngữ: ${sourceLang} · OCR: ${ocrType}`);
      markStepEnd(id, 0);
    }

    // 1. Merge + import (silent)
    if (startStep <= 1) {
      let mergeId = "";
      if (audioUrl && videoUrl) {
        patch(id, { stage: "merging" });
        markStepStart(id, 1);
        appendLog(id, "Phát hiện 2 file riêng (video + audio) → merge...");
        const mr = await fetch("/api/video-merge", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ video_url: videoUrl, audio_url: audioUrl }),
        });
        const md = await mr.json();
        if (!mr.ok) throw new Error(md.detail || "Merge thất bại");
        const ms = await pollMerge(md.job_id, tick(1));
        if (ms.status !== "done") throw new Error(ms.error || "Merge thất bại");
        mergeId = (ms.filename || "").replace(/\.mp4$/, "");
        appendLog(id, "Merge xong.");
        markStepEnd(id, 1);
      } else {
        markStepSkipped(id, 1);
        appendLog(id, "Chỉ 1 file video (đã có audio).");
      }

      appendLog(id, "Đăng ký video vào hệ thống...");
      const impBody = mergeId
        ? { merge_id: mergeId, filename: "douyin.mp4" }
        : { url: videoUrl, filename: "douyin.mp4" };
      const ir = await fetch("/api/import-video", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(impBody),
      });
      const idata = await ir.json();
      if (!ir.ok) throw new Error(idata.detail || "Import thất bại");
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
        patch(id, { stage: "region" });
        markStepStart(id, 2);
        appendLog(id, "Kéo vùng quét lấy phụ đề trên video, nhấn Enter để xác nhận...");
        region = cur.region ?? (await waitForRegion(id));
        patch(id, { region });
        appendLog(id, `Vùng quét: x ${region.x1}–${region.x2} · y ${region.y1}–${region.y2}`);
        markStepEnd(id, 2);
      }
    }

    // 3. Subtitle style preview: only when NOT auto-fit (manual adjust).
    if (startStep <= 3) {
      if (cur.autoFit) {
        markStepSkipped(id, 3);
        appendLog(id, "Tự động khớp vị trí — bỏ qua bước chỉnh tay.");
      } else {
        patch(id, { stage: "subtitle_preview" });
        markStepStart(id, 3);
        appendLog(id, "Chỉnh kích thước & vị trí phụ đề trên frame đầu tiên, nhấn Xác nhận để tiếp tục...");
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
    patch(id, {
      status: "error",
      stage: "error",
      error: e instanceof Error ? e.message : "Lỗi không xác định",
      finishedAt: Date.now(),
    });
  }
}

// ── Heavy runner (OCR → context → translate → dub → hardcode) ──────────────
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

  const stageForStart = ["processing", "context", "translating", "dub", "muxing"][startStep - 4] ?? "processing";

  patch(id, {
    status: "running",
    stage: stageForStart as Stage,
    progress: 0,
    startedAt: cur.startedAt ?? Date.now(),
    finishedAt: null,
    error: "",
    stepProgress: cur.stepProgress.map((v, i) => (i >= startStep ? null : v)),
    stepStarts: cur.stepStarts.map((v, i) => (i >= startStep ? null : v)),
    stepEnds: cur.stepEnds.map((v, i) => (i >= startStep ? null : v)),
    stepSkipped: cur.stepSkipped.map((v, i) => (i >= startStep ? false : v)),
  });

  try {
    if (abortedPipelines.has(id)) return;

    // 4. OCR
    if (startStep <= 4) {
      if (!region) {
        region = DEFAULT_REGION;
        patch(id, { region });
        markStepSkipped(id, 2);
      }
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
      const pd = await pr.json();
      if (!pr.ok) throw new Error(pd.detail || "Không thể bắt đầu OCR");
      const ps = await pollJob(pd.job_id, tick(4));
      if (ps.status !== "done") throw new Error(ps.error || "OCR thất bại");
      appendLog(id, "OCR xong, đã có phụ đề.");
      markStepEnd(id, 4);
    }

    // 5. Context
    if (startStep <= 5) {
      patch(id, { stage: "context" });
      markStepStart(id, 5);
      appendLog(id, "Phân tích ngữ cảnh video (Gemini Vision)...");
      try {
        const cr = await fetch(`/api/context/${videoId}/generate`, { method: "POST" });
        const cd = await cr.json();
        if (cr.ok && cd.job_id) {
          patch(id, { contextOn: true });
          const cs = await pollJob(cd.job_id, tick(5));
          appendLog(id, cs.status === "done" ? "Ngữ cảnh xong." : "Bỏ qua ngữ cảnh.");
        } else {
          appendLog(id, "Không thể sinh ngữ cảnh (thiếu Gemini key?) — tiếp tục.");
        }
      } catch {
        appendLog(id, "Bỏ qua ngữ cảnh.");
      }
      markStepEnd(id, 5);
    }

    // 6. Translate + save
    if (startStep <= 6) {
      patch(id, { stage: "translating" });
      markStepStart(id, 6);
      appendLog(id, `Dịch Gemini (${sourceLang} → vi)...`);
      const tr = await fetch(`/api/translate/${videoId}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ source_lang: sourceLang, target_lang: "vi" }),
      });
      const td = await tr.json();
      if (!tr.ok) throw new Error(td.detail || "Dịch thất bại");
      const ts = await pollJob(td.job_id, tick(6));
      if (ts.status !== "done") throw new Error(ts.error || "Dịch thất bại");
      appendLog(id, "Dịch xong.");

      patch(id, { stage: "saving" });
      appendLog(id, "Ghi đè phụ đề dịch lên file SRT hiện tại...");
      const srtRes = await fetch(`/api/download/translated/${videoId}`);
      const srtText = await srtRes.text();
      await fetch(`/api/srt/${videoId}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: srtText }),
      });
      markStepEnd(id, 6);
    }

    // 7. Dub
    if (startStep <= 7) {
      patch(id, { stage: "dub" });
      markStepStart(id, 7);
      const engine = cur.dubEngine === "capcut" ? "capcut" : "google";
      const voice = cur.dubVoice || (engine === "capcut" ? "BV421_vivn_streaming" : "vi-VN-Standard-B");
      appendLog(id, engine === "capcut"
        ? `Tách giọng & lồng tiếng Việt (CapCut voice: ${voice})...`
        : "Tách giọng & lồng tiếng Việt (Google TTS)...");
      try {
        const dr = await fetch(`/api/dub/${videoId}`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            voice,
            engine,
            mute_original: cur.muteOriginal,
            original_gain_db: cur.originalGainDb,
          }),
        });
        const dd = await dr.json();
        if (dr.ok && dd.job_id) {
          const ds = await pollJob(dd.job_id, tick(7));
          if (ds.status === "done") {
            patch(id, { dubbedUrl: `/api/download/dubbed/${videoId}` });
            appendLog(id, "Lồng tiếng Việt xong.");
          } else {
            appendLog(id, `Bỏ qua lồng tiếng: ${ds.error || "thất bại"}`);
          }
        } else {
          appendLog(id, `Bỏ qua lồng tiếng: ${dd.detail || "không thể bắt đầu"}`);
        }
      } catch {
        appendLog(id, "Bỏ qua lồng tiếng (lỗi).");
      }
      markStepEnd(id, 7);
    }

    // 8. Hardcode
    if (startStep <= 8) {
      patch(id, { stage: "muxing" });
      markStepStart(id, 8);
      appendLog(id, "FFmpeg nhúng SRT (ASS black box) vào video...");
      const hr = await fetch(`/api/hardcode/${videoId}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          auto_fit: cur.autoFit,
          region: cur.region ?? DEFAULT_REGION,
          style: cur.autoFit ? null : (cur.subtitleStyle ?? null),
        }),
      });
      const hd = await hr.json();
      if (!hr.ok) throw new Error(hd.detail || "Nhúng SRT thất bại");
      const hs = await pollJob(hd.job_id, tick(8));
      if (hs.status !== "done") throw new Error(hs.error || "Nhúng SRT thất bại");
      markStepEnd(id, 8);
    }

    patch(id, {
      status: "done",
      stage: "done",
      progress: 100,
      resultUrl: `/api/download/hardcoded/${videoId}`,
      finishedAt: Date.now(),
    });
    appendLog(id, "Hoàn tất!");
    cleanupTempForVideo(videoId);
  } catch (e) {
    patch(id, {
      status: "error",
      stage: "error",
      error: e instanceof Error ? e.message : "Lỗi không xác định",
      finishedAt: Date.now(),
    });
  }
}
