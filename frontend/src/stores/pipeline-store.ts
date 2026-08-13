"use client";

import { create } from "zustand";

export const STEPS = [
  { label: "Phân tích link", detail: "Mở link Douyin lấy URL video" },
  { label: "Merge video + audio", detail: "Gộp 2 file nếu có audio riêng" },
  { label: "OCR trích phụ đề", detail: "Nhận dạng chữ trong video" },
  { label: "Phân tích ngữ cảnh", detail: "Gemini Vision phân tích video" },
  { label: "Dịch Gemini", detail: "Dịch phụ đề sang tiếng Việt" },
  { label: "Lồng tiếng Việt", detail: "Tách giọng + TTS Việt + giữ nhạc nền" },
  { label: "Nhúng SRT vào video", detail: "FFmpeg gộp SRT mới vào MP4" },
];

export type Stage =
  | "idle"
  | "resolving"
  | "merging"
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
  processing: 2,
  context: 3,
  translating: 4,
  saving: 4,
  dub: 5,
  muxing: 6,
};

export interface Pipeline {
  id: string;
  url: string;
  title: string;
  status: "queued" | "running" | "done" | "error";
  stage: Stage;
  progress: number;
  logs: string[];
  error: string;
  resultUrl: string;
  dubbedUrl: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  stepStarts: (number | null)[];
  stepEnds: (number | null)[];
  stepSkipped: boolean[];
  ocrEngine: string;
  ocrLang: string;
  srcLang: string;
  contextOn: boolean;
}

interface PipelineState {
  pipelines: Pipeline[];
  addPipeline: (url: string) => string;
  updatePipeline: (id: string, patch: Partial<Pipeline>) => void;
  removePipeline: (id: string) => void;
  clearFinished: () => void;
}

function emptySteps<T>(v: T): T[] {
  return STEPS.map(() => v);
}

function newPipeline(id: string, url: string): Pipeline {
  return {
    id,
    url,
    title: "",
    status: "queued",
    stage: "idle",
    progress: 0,
    logs: [],
    error: "",
    resultUrl: "",
    dubbedUrl: null,
    startedAt: null,
    finishedAt: null,
    stepStarts: emptySteps(null),
    stepEnds: emptySteps(null),
    stepSkipped: emptySteps(false),
    ocrEngine: "",
    ocrLang: "",
    srcLang: "",
    contextOn: false,
  };
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  pipelines: [],
  addPipeline: (url) => {
    const id = Math.random().toString(36).slice(2, 10);
    set((s) => ({ pipelines: [...s.pipelines, newPipeline(id, url)] }));
    enqueue(id);
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

async function pollJob(jobId: string, onProgress: (p: number) => void) {
  for (let i = 0; i < 1200; i++) {
    await sleep(1500);
    try {
      const r = await fetch(`/api/status/${jobId}`);
      if (!r.ok) continue;
      const d = await r.json();
      onProgress(d.progress ?? 0);
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
      if (d.status === "cancelled") return { status: "error", error: "Đã hủy" };
    } catch {
      // ignore transient
    }
  }
  return { status: "error", error: "Quá thời gian chờ" };
}

async function pollMerge(jobId: string, onProgress: (p: number) => void) {
  for (let i = 0; i < 1200; i++) {
    await sleep(800);
    try {
      const r = await fetch(`/api/video-merge/${jobId}`);
      if (!r.ok) continue;
      const d = await r.json();
      onProgress(d.progress ?? 0);
      if (d.status === "done") return d;
      if (d.status === "error") return { status: "error", error: d.error };
    } catch {
      // ignore transient
    }
  }
  return { status: "error", error: "Quá thời gian chờ" };
}

// ── Queue ──────────────────────────────────────────────────────────────────

let queue: string[] = [];
let processing = false;

function enqueue(id: string) {
  queue.push(id);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  if (queue.length === 0) return;
  processing = true;
  const id = queue.shift()!;
  await runPipeline(id);
  processing = false;
  processQueue();
}

// ── Runner ─────────────────────────────────────────────────────────────────

function patch(id: string, p: Partial<Pipeline>) {
  usePipelineStore.getState().updatePipeline(id, p);
}

function appendLog(id: string, msg: string) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (cur) patch(id, { logs: [...cur.logs, msg] });
}

function markStepStart(id: string, i: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, {
    stepStarts: cur.stepStarts.map((v, idx) => (idx === i ? Date.now() : v)),
    stepEnds: cur.stepEnds.map((v, idx) => (idx === i ? null : v)),
    stepSkipped: cur.stepSkipped.map((v, idx) => (idx === i ? false : v)),
  });
}

function markStepEnd(id: string, i: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, { stepEnds: cur.stepEnds.map((v, idx) => (idx === i ? Date.now() : v)) });
}

function markStepSkipped(id: string, i: number) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  patch(id, { stepSkipped: cur.stepSkipped.map((v, idx) => (idx === i ? true : v)) });
}

async function runPipeline(id: string) {
  const cur = usePipelineStore.getState().pipelines.find((x) => x.id === id);
  if (!cur) return;
  const rawUrl = cur.url;

  patch(id, {
    status: "running",
    stage: "resolving",
    progress: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: "",
    logs: [],
    resultUrl: "",
    dubbedUrl: null,
  });

  try {
    // 1. Resolve link
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
    const { video_url, audio_url, title } = rd;
    const sourceLang = detectSourceLang(cleaned);
    const ocrLang = detectOcrLang(sourceLang);
    const ocrType = detectOcrType();
    patch(id, {
      title: title || "",
      srcLang: sourceLang,
      ocrLang,
      ocrEngine: ocrType === "apple" ? "Apple Vision" : "RapidOCR",
    });
    appendLog(id, `Đã lấy URL video${audio_url ? " + audio" : ""} · ngôn ngữ: ${sourceLang} · OCR: ${ocrType}`);
    markStepEnd(id, 0);

    // 2. Merge if audio track present
    let mergeId = "";
    if (audio_url && video_url) {
      patch(id, { stage: "merging" });
      markStepStart(id, 1);
      appendLog(id, "Phát hiện 2 file riêng (video + audio) → merge...");
      const mr = await fetch("/api/video-merge", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ video_url, audio_url }),
      });
      const md = await mr.json();
      if (!mr.ok) throw new Error(md.detail || "Merge thất bại");
      const ms = await pollMerge(md.job_id, (p) => patch(id, { progress: p }));
      if (ms.status !== "done") throw new Error(ms.error || "Merge thất bại");
      mergeId = (ms.filename || "").replace(/\.mp4$/, "");
      appendLog(id, "Merge xong.");
      markStepEnd(id, 1);
    } else {
      markStepSkipped(id, 1);
      appendLog(id, "Chỉ 1 file video (đã có audio).");
    }

    // 3. Import video (silent — file đã lưu sẵn trong hệ thống sau merge)
    appendLog(id, "Đăng ký video vào hệ thống...");
    const impBody = mergeId
      ? { merge_id: mergeId, filename: "douyin.mp4" }
      : { url: video_url, filename: "douyin.mp4" };
    const ir = await fetch("/api/import-video", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(impBody),
    });
    const idata = await ir.json();
    if (!ir.ok) throw new Error(idata.detail || "Import thất bại");
    const videoId = idata.video_id;
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

    // 4. OCR
    patch(id, { stage: "processing" });
    markStepStart(id, 2);
    appendLog(id, "Chạy OCR trích phụ đề...");
    const pr = await fetch("/api/process", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        video_id: videoId,
        region: { x1: 0.114, y1: 0.748, x2: 0.863, y2: 0.972 },
        lang: ocrLang,
        ocr_type: ocrType,
      }),
    });
    const pd = await pr.json();
    if (!pr.ok) throw new Error(pd.detail || "Không thể bắt đầu OCR");
    const ps = await pollJob(pd.job_id, (p) => patch(id, { progress: p }));
    if (ps.status !== "done") throw new Error(ps.error || "OCR thất bại");
    appendLog(id, "OCR xong, đã có phụ đề.");
    markStepEnd(id, 2);

    // 5. Context
    patch(id, { stage: "context" });
    markStepStart(id, 3);
    appendLog(id, "Phân tích ngữ cảnh video (Gemini Vision)...");
    try {
      const cr = await fetch(`/api/context/${videoId}/generate`, { method: "POST" });
      const cd = await cr.json();
      if (cr.ok && cd.job_id) {
        patch(id, { contextOn: true });
        const cs = await pollJob(cd.job_id, (p) => patch(id, { progress: p }));
        appendLog(id, cs.status === "done" ? "Ngữ cảnh xong." : "Bỏ qua ngữ cảnh.");
      } else {
        appendLog(id, "Không thể sinh ngữ cảnh (thiếu Gemini key?) — tiếp tục.");
      }
    } catch {
      appendLog(id, "Bỏ qua ngữ cảnh.");
    }
    markStepEnd(id, 3);

    // 6. Translate
    patch(id, { stage: "translating" });
    markStepStart(id, 4);
    appendLog(id, `Dịch Gemini (${sourceLang} → vi)...`);
    const tr = await fetch(`/api/translate/${videoId}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ source_lang: sourceLang, target_lang: "vi" }),
    });
    const td = await tr.json();
    if (!tr.ok) throw new Error(td.detail || "Dịch thất bại");
    const ts = await pollJob(td.job_id, (p) => patch(id, { progress: p }));
    if (ts.status !== "done") throw new Error(ts.error || "Dịch thất bại");
    appendLog(id, "Dịch xong.");

    // 7. Overwrite SRT
    patch(id, { stage: "saving" });
    appendLog(id, "Ghi đè phụ đề dịch lên file SRT hiện tại...");
    const srtRes = await fetch(`/api/download/translated/${videoId}`);
    const srtText = await srtRes.text();
    await fetch(`/api/srt/${videoId}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: srtText }),
    });
    markStepEnd(id, 4);

    // 8. Dub — separate vocals + Vietnamese TTS (non-fatal if demucs missing)
    patch(id, { stage: "dub" });
    markStepStart(id, 5);
    appendLog(id, "Tách giọng & lồng tiếng Việt (Demucs + TTS)...");
    try {
      const dr = await fetch(`/api/dub/${videoId}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ voice: "vi-VN-Standard-B" }),
      });
      const dd = await dr.json();
      if (dr.ok && dd.job_id) {
        const ds = await pollJob(dd.job_id, (p) => patch(id, { progress: p }));
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
    markStepEnd(id, 5);

    // 9. Hardcode — burn black-box ASS subtitle into video
    patch(id, { stage: "muxing" });
    markStepStart(id, 6);
    appendLog(id, "FFmpeg nhúng SRT (ASS black box) vào video...");
    const hr = await fetch(`/api/hardcode/${videoId}`, { method: "POST" });
    const hd = await hr.json();
    if (!hr.ok) throw new Error(hd.detail || "Nhúng SRT thất bại");
    const hs = await pollJob(hd.job_id, (p) => patch(id, { progress: p }));
    if (hs.status !== "done") throw new Error(hs.error || "Nhúng SRT thất bại");
    markStepEnd(id, 6);

    patch(id, {
      status: "done",
      stage: "done",
      progress: 100,
      resultUrl: `/api/download/hardcoded/${videoId}`,
      finishedAt: Date.now(),
    });
    appendLog(id, "Hoàn tất!");
  } catch (e) {
    patch(id, {
      status: "error",
      stage: "error",
      error: e instanceof Error ? e.message : "Lỗi không xác định",
      finishedAt: Date.now(),
    });
  }
}
