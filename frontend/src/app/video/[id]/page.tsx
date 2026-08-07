"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import TranscriptPlayer from "@/components/TranscriptPlayer";
import { AnimatedBlock } from "@/lib/animation";
import { listVideos, getJobStatus } from "@/lib/api";
import type { VideoMeta, LogEntry } from "@/lib/api";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const PHASE_LABELS: Record<string, string> = {
  submitting: "Đang gửi yêu cầu xử lý…",
  queued: "Đang xếp hàng chờ xử lý…",
  frames: "Đang đọc các khung hình của video…",
  ocr: "Đang nhận dạng chữ viết trong video…",
  saving: "Đang lưu file phụ đề…",
};

function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const LOG_LEVEL_STYLE: Record<string, string> = {
  info: "text-blue-600",
  success: "text-emerald-600",
  warn: "text-amber-600",
  error: "text-red-600",
  text: "text-violet-700 font-medium",
};

function JobProgress({
  jobId,
  onCompleted,
}: {
  jobId: string;
  onCompleted: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("queued");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (!mountedRef.current) return;
      try {
        const st = await getJobStatus(jobId);
        if (!mountedRef.current) return;
        setProgress(st.progress ?? 0);
        setPhase(st.phase || "queued");
        if (st.logs) {
          setLogs((prev) =>
            st.logs!.length === prev.length ? prev : st.logs!.slice(-80)
          );
        }
        if (st.status === "done") {
          onCompleted();
          return;
        }
        if (st.status === "error") {
          setError(st.error || "Xử lý thất bại");
          return;
        }
      } catch {
        // job may disappear (server restart) — stop and let onCompleted re-check
      }
      if (mountedRef.current) timer = setTimeout(poll, 1500);
    };

    poll();
    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, onCompleted]);

  const pct = Math.max(0, Math.min(100, progress));
  const statusText = error ? "Có lỗi xảy ra" : phase
    ? (PHASE_LABELS[phase] ?? "Đang xử lý…")
    : "Đang xử lý…";

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-6 sm:p-10">
        <div className="text-center mb-8">
          {error ? (
            <svg className="w-6 h-6 text-red-500 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          ) : (
            <svg className="w-6 h-6 text-blue-500 animate-spin mx-auto" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
              <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          <p className="text-sm text-ink mt-3 font-medium">{statusText}</p>
          {error && (
            <p className="text-[13px] text-red-600/80 mt-2">{error}</p>
          )}
        </div>

        <div className="max-w-sm mx-auto">
          <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                error ? "bg-red-500" : "bg-gradient-to-r from-blue-600 to-blue-400"
              }`}
              style={{ width: `${Math.max(error ? 100 : progress, 3)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[11px] text-ink-light">Tiến trình xử lý</p>
            <p className="text-xs font-mono text-ink-light tabular-nums">{error ? "0" : progress}%</p>
          </div>
        </div>

        {logs.length > 0 && (
          <div className="rounded-2xl bg-black/[0.02] ring-1 ring-black/[0.05] overflow-hidden mt-8">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.05] bg-white/40">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-ink-muted">
                Nhật ký xử lý
              </span>
            </div>
            <div className="max-h-[300px] overflow-y-auto p-3 space-y-1.5">
              {logs.map((log, i) => (
                <div key={`${log.ts}-${i}`} className="flex items-start gap-2 px-3 py-1.5 rounded-xl bg-white/60 ring-1 ring-black/[0.03]">
                  <p className={`text-[13px] leading-snug flex-1 ${LOG_LEVEL_STYLE[log.level] as string ?? "text-ink"}`}>
                    {log.message}
                  </p>
                  <span className="text-[10px] font-mono text-ink-light tabular-nums flex-shrink-0 mt-0.5">
                    {fmtTime(log.ts)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VideoDetailPage() {
  const params = useParams<{ id: string }>();
  const videoId = params.id;

  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const loadMeta = useCallback(async () => {
    try {
      const videos = await listVideos();
      const v = videos.find((item) => item.video_id === videoId);
      setMeta(v ?? null);
      setLoading(false);
    } catch {
      setMeta(null);
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    setLoading(true);
    loadMeta();
  }, [loadMeta, reloadKey]);

  const isActive =
    (meta?.status === "queued" || meta?.status === "processing") && !!meta.job_id;

  const handleCompleted = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const entries = meta && meta.status === "done" ? meta.entries : null;
  const filename = meta?.filename ?? "";

  return (
    <main className="min-h-[100dvh] max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <Link href="/" className="btn-island-secondary group !px-5 !py-2 text-[13px]">
          <span className="btn-island-icon !w-7 !h-7">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" /><path d="M11 18l-6-6 6-6" />
            </svg>
          </span>
          <span className="tracking-tight">Back to library</span>
        </Link>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mt-10 mb-10">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <div className="eyebrow mb-4">Extracted Video</div>
            <h1 className="text-[clamp(1.8rem,4.5vw,3.4rem)] font-semibold tracking-tight leading-[1.05] text-balance text-ink break-words">
              {loading ? "Loading…" : filename || videoId}
            </h1>
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              {isActive && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 ring-1 ring-blue-500/20 text-[11px] font-medium text-blue-600/90">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  Đang xử lý… {meta?.progress ?? 0}%
                </span>
              )}
              {entries !== null && !isActive && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 text-[11px] font-medium text-emerald-600/90">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
                  </svg>
                  {entries} subtitle lines
                </span>
              )}
              {meta?.created_at && (
                <span className="text-[11px] text-ink-light tabular-nums">
                  Extracted {formatDate(meta.created_at)}
                </span>
              )}
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="text-[11px] font-medium text-blue-600/80 hover:text-blue-700 transition-colors cursor-pointer"
              >
                Làm mới trạng thái
              </button>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      {isActive && meta?.job_id ? (
        <AnimatedBlock delay={200}>
          <JobProgress key={meta.job_id} jobId={meta.job_id} onCompleted={handleCompleted} />
        </AnimatedBlock>
      ) : meta && meta.status === "done" ? (
        <AnimatedBlock delay={200}>
          <TranscriptPlayer videoId={videoId} />
        </AnimatedBlock>
      ) : (
        <AnimatedBlock delay={200}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-6 sm:p-10 text-center">
              <p className="text-sm text-ink-light">Đang tải thông tin video…</p>
            </div>
          </div>
        </AnimatedBlock>
      )}
    </main>
  );
}