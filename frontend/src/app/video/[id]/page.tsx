"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import TranscriptPlayer from "@/components/TranscriptPlayer";
import PageHeader from "@/components/layout/PageHeader";
import { AnimatedBlock } from "@/lib/animation";
import { listVideos, getJobStatus, cancelJob } from "@/lib/api";
import type { VideoMeta, LogEntry } from "@/lib/api";
import { useI18n, type Dict } from "@/lib/i18n";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const PHASE_KEY: Record<string, string> = {
  submitting: "video.phase.submitting",
  queued: "video.phase.queued",
  frames: "video.phase.frames",
  ocr: "video.phase.ocr",
  saving: "video.phase.saving",
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
  info: "text-accent-light",
  success: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-danger",
  text: "text-violet-300 font-medium",
};

function JobProgress({
  jobId,
  videoId,
  onCompleted,
  onCancelled,
}: {
  jobId: string;
  videoId: string;
  onCompleted: () => void;
  onCancelled?: () => void;
}) {
  const { t } = useI18n();
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("queued");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [cancelling, setCancelling] = useState(false);
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
            st.logs!.length === prev.length ? prev : st.logs!.slice(-80),
          );
        }
        if (st.status === "done") {
          onCompleted();
          return;
        }
        if (st.status === "cancelled") {
          setCancelled(true);
          onCancelled?.();
          return;
        }
        if (st.status === "error") {
          setError(st.error || t("video.error.default"));
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
  }, [jobId, onCompleted, onCancelled]);

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelJob(jobId);
      setCancelled(true);
      onCancelled?.();
    } catch {
      setCancelling(false);
    }
  }, [jobId, cancelling, onCancelled]);

  const pct = Math.max(0, Math.min(100, progress));
  const statusText = error
    ? t("video.error.title")
    : phase
      ? t((PHASE_KEY[phase] ?? "video.processing") as keyof Dict)
      : t("video.processing");

  if (cancelled) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-6 sm:p-10 text-center">
          <svg
            className="w-6 h-6 text-warn mx-auto"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="5" y1="5" x2="19" y2="19" />
          </svg>
          <p className="text-sm text-ink mt-3 font-medium">
            {t("video.cancelled.title")}
          </p>
          <p className="text-[13px] text-ink-light mt-1.5 max-w-sm mx-auto">
            {t("video.cancelled.desc")}
          </p>
          <Link
            href={`/extract?video_id=${videoId}`}
            className="btn-island-primary group mt-6 text-sm inline-flex"
          >
            <span className="tracking-tight">{t("video.retry")}</span>
            <span className="btn-island-icon">
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </span>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-6 sm:p-10">
        <div className="text-center mb-8">
          {error ? (
            <svg
              className="w-6 h-6 text-danger mx-auto"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          ) : (
            <svg
              className="w-6 h-6 text-accent animate-spin mx-auto"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="1.5"
                opacity="0.15"
              />
              <path
                d="M12 2a10 10 0 019.95 9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          )}
          <p className="text-sm text-ink mt-3 font-medium">{statusText}</p>
          {error && <p className="text-[13px] text-danger/80 mt-2">{error}</p>}
        </div>

        <div className="max-w-sm mx-auto">
          <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                error
                  ? "bg-danger"
                  : "bg-gradient-to-r from-blue-600 to-blue-400"
              }`}
              style={{ width: `${Math.max(error ? 100 : progress, 3)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[11px] text-ink-light">{t("video.progress")}</p>
            <p className="text-xs font-mono text-ink-light tabular-nums">
              {error ? "0" : progress}%
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center mt-6">
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium tracking-tight text-danger ring-1 ring-danger/20 hover:bg-danger-muted transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {cancelling ? (
              <svg
                className="w-4 h-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  opacity="0.15"
                />
                <path
                  d="M12 2a10 10 0 019.95 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="5" y1="5" x2="19" y2="19" />
              </svg>
            )}
            <span>{cancelling ? t("video.cancelling") : t("video.cancel")}</span>
          </button>
        </div>

        {logs.length > 0 && (
          <div className="rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.08] overflow-hidden mt-8">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.07] bg-white/[0.03]">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-ink-muted">
                {t("video.logs")}
              </span>
            </div>
            <div className="max-h-[300px] overflow-y-auto p-3 space-y-1.5">
              {logs.map((log, i) => (
                <div
                  key={`${log.ts}-${i}`}
                  className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08]"
                >
                  <p
                    className={`text-[13px] leading-snug flex-1 ${(LOG_LEVEL_STYLE[log.level] as string) ?? "text-ink"}`}
                  >
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

type ViewMode = "transcript" | "context";

export default function VideoDetailPage() {
  const params = useParams<{ id: string }>();
  const videoId = params.id;
  const { t } = useI18n();

  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("transcript");

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
    (meta?.status === "queued" || meta?.status === "processing") &&
    !!meta.job_id;
  const isCancelled = meta?.status === "cancelled";

  const handleCompleted = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const entries = meta && meta.status === "done" ? meta.entries : null;
  const filename = meta?.filename ?? "";

  return (
    <div>
      <PageHeader
        back={{ href: "/", label: t("back.library") }}
        title={loading ? t("video.loading") : filename || videoId}
        badge={
          isActive ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-muted ring-1 ring-accent/20 text-[11px] font-medium text-accent-light">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {t("video.processingBadge", { progress: meta?.progress ?? 0 })}
            </span>
          ) : undefined
        }
        actions={
          <>
            {meta?.created_at && (
              <span className="text-[12px] text-ink-light tabular-nums mr-1">
                {t("video.extracted", { date: formatDate(meta.created_at) })}
              </span>
            )}
            {entries !== null && (
              <Link
                href={`/extract?video_id=${videoId}`}
                className="btn-island-secondary !px-4 !py-2 text-[12px]"
              >
                {t("video.retryLink")}
              </Link>
            )}
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="btn-island-secondary !px-4 !py-2 text-[12px]"
            >
              {t("video.refresh")}
            </button>
          </>
        }
      />

      {isActive && meta?.job_id ? (
        <AnimatedBlock delay={200}>
          <JobProgress
            key={meta.job_id}
            jobId={meta.job_id}
            videoId={videoId}
            onCompleted={handleCompleted}
            onCancelled={handleCompleted}
          />
        </AnimatedBlock>
      ) : isCancelled ? (
        <AnimatedBlock delay={200}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-6 sm:p-10 text-center">
              <svg
                className="w-6 h-6 text-warn mx-auto"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="5" y1="5" x2="19" y2="19" />
              </svg>
              <p className="text-sm text-ink mt-3 font-medium">
                {t("video.cancelled.title")}
              </p>
              <p className="text-[13px] text-ink-light mt-1.5 max-w-sm mx-auto">
                {t("video.cancelled.desc")}
              </p>
              <Link
                href={`/extract?video_id=${videoId}`}
                className="btn-island-primary group mt-6 text-sm inline-flex"
              >
                <span className="tracking-tight">{t("video.retry")}</span>
                <span className="btn-island-icon">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </span>
              </Link>
            </div>
          </div>
        </AnimatedBlock>
      ) : meta && meta.status === "done" ? (
        <AnimatedBlock delay={200}>
          {/* View mode toggle — Floating glass island */}
          <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
              <button
                onClick={() => setViewMode("transcript")}
                className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
                  viewMode === "transcript"
                    ? "bg-accent text-white shadow-sm"
                    : "text-ink-light hover:text-ink"
                }`}
              >
                {t("video.transcript")}
              </button>
            </div>
          </div>
          <TranscriptPlayer videoId={videoId} />
        </AnimatedBlock>
      ) : (
        <AnimatedBlock delay={200}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-6 sm:p-10 text-center">
              <p className="text-sm text-ink-light">
                {t("video.loadingInfo")}
              </p>
            </div>
          </div>
        </AnimatedBlock>
      )}
    </div>
  );
}
