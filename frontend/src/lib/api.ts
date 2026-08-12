import axios from "axios";

const api = axios.create({
  baseURL: "/api",
  timeout: 30000,
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    const msg =
      error.response?.data?.detail ||
      error.message ||
      "An unexpected error occurred";
    return Promise.reject(new Error(msg));
  }
);

export async function uploadVideo(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await api.post<{ video_id: string }>("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
    },
    signal,
  });
  return res.data.video_id;
}

export function getVideoUrl(videoId: string): string {
  return `/api/video/${videoId}`;
}

export function getFrameUrl(videoId: string): string {
  return `/api/frame/${videoId}`;
}

export type VideoStatus = "uploaded" | "queued" | "processing" | "done" | "error" | "cancelled";

export interface VideoMeta {
  video_id: string;
  filename: string;
  has_video: boolean;
  entries: number;
  created_at: string;
  status?: VideoStatus;
  progress?: number;
  phase?: string;
  job_id?: string;
  error?: string | null;
}

export async function listVideos(): Promise<VideoMeta[]> {
  const res = await api.get<{ videos: VideoMeta[] }>("/videos");
  return res.data.videos;
}

export async function deleteVideo(videoId: string): Promise<void> {
  await api.delete(`/video/${videoId}`);
}

export interface Region {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LogEntry {
  message: string;
  ts: number;
  level: string;
}

export interface JobStatus {
  job_id: string;
  status: string;
  phase: string;
  progress: number;
  error: string | null;
  logs?: LogEntry[];
}

export type OcrLang = "ch" | "en" | "latin";

export const OCR_LANGS: { value: OcrLang; label: string; hint: string }[] = [
  { value: "ch", label: "Tiếng Trung", hint: "Chinese + English" },
  { value: "latin", label: "Tiếng Việt", hint: "Vietnamese / Latin" },
  { value: "en", label: "Tiếng Anh", hint: "English" },
];

export type OcrType = "rapid" | "apple";

export const OCR_TYPES: { value: OcrType; label: string; hint: string }[] = [
  { value: "apple", label: "Apple Vision", hint: "macOS, tối ưu cho chữ in" },
  { value: "rapid", label: "RapidOCR", hint: "Nhanh, chạy mọi nền tảng" },
];

export async function startProcess(
  videoId: string,
  region: Region,
  lang: OcrLang = "ch",
  ocrType: OcrType = "apple",
  signal?: AbortSignal
): Promise<JobStatus> {
  const res = await api.post<JobStatus>(
    "/process",
    { video_id: videoId, region, lang, ocr_type: ocrType },
    { signal }
  );
  return res.data;
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await api.get<JobStatus>(`/status/${jobId}`);
  return res.data;
}

export async function cancelJob(jobId: string): Promise<void> {
  await api.post(`/process/${jobId}/cancel`);
}

export function createWsUrl(jobId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/${jobId}`;
}

export function getDownloadUrl(videoId: string, format: "srt" | "txt" = "srt"): string {
  return `/api/download/${videoId}?format=${format}`;
}

export async function getSrtContent(videoId: string): Promise<string> {
  const res = await api.get<{ content: string }>(`/srt/${videoId}`);
  return res.data.content;
}

export interface SrtEntry {
  index: number;
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
  text: string;
}

export async function getSrtEntries(videoId: string): Promise<SrtEntry[]> {
  const res = await api.get<{ entries: SrtEntry[] }>(`/srt/${videoId}/entries`);
  return res.data.entries;
}

export async function updateSrt(videoId: string, content: string): Promise<void> {
  await api.put(`/srt/${videoId}`, { content });
}

export async function muxSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/mux/${videoId}`);
  return res.data;
}

export function getMuxedDownloadUrl(videoId: string): string {
  return `/api/download/muxed/${videoId}`;
}

export async function hardcodeSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/hardcode/${videoId}`);
  return res.data;
}

export function getHardcodedDownloadUrl(videoId: string): string {
  return `/api/download/hardcoded/${videoId}`;
}

export async function alignSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/align/${videoId}`);
  return res.data;
}

export async function translateSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/translate/${videoId}`);
  return res.data;
}

export function getTranslatedDownloadUrl(videoId: string): string {
  return `/api/download/translated/${videoId}`;
}

export async function ttsSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/tts/${videoId}`);
  return res.data;
}

export function getDubbedDownloadUrl(videoId: string): string {
  return `/api/download/dubbed/${videoId}`;
}
