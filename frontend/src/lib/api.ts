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

export interface VideoMeta {
  video_id: string;
  filename: string;
  has_video: boolean;
  entries: number;
  created_at: string;
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

export async function startProcess(
  videoId: string,
  region: Region,
  signal?: AbortSignal
): Promise<JobStatus> {
  const res = await api.post<JobStatus>(
    "/process",
    { video_id: videoId, region },
    { signal }
  );
  return res.data;
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await api.get<JobStatus>(`/status/${jobId}`);
  return res.data;
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
