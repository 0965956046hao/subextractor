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

export interface Region {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface JobStatus {
  job_id: string;
  status: string;
  phase: string;
  progress: number;
  error: string | null;
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

export function getDownloadUrl(videoId: string): string {
  return `/api/download/${videoId}`;
}
