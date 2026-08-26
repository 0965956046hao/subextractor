"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { listVideos, getFrameUrl, deleteVideo, cancelJob } from "@/lib/api";
import type { VideoMeta } from "@/lib/api";
import { AnimatedBlock } from "@/lib/animation";
import { useI18n } from "@/lib/i18n";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function SkeletonCard() {
  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-1.5">
        <div className="aspect-square rounded-lg bg-white/[0.05] animate-pulse" />
        <div className="px-1.5 py-2.5 space-y-2">
          <div className="h-3 w-full rounded-full bg-white/[0.07] animate-pulse" />
          <div className="h-2.5 w-1/2 rounded-full bg-white/[0.05] animate-pulse" />
        </div>
      </div>
    </div>
  );
}

export default function LibraryPage({
  mode = "extract",
}: {
  mode?: "extract" | "pipeline";
}) {
  const { t } = useI18n();
  const [videos, setVideos] = useState<VideoMeta[] | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "grid";
    return (localStorage.getItem("libraryView") as ViewMode) || "grid";
  });

  const changeView = useCallback((v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem("libraryView", v);
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setError("");
      setVideos(null);
    }
    try {
      setVideos(await listVideos());
    } catch (err: unknown) {
      if (!opts?.silent)
        setError(
          err instanceof Error ? err.message : t("library.loadError" as string),
        );
    }
  }, []);

  const refreshActive = useCallback(() => {
    load({ silent: true }).catch(() => {});
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!videos) return;
    const hasActive = videos.some(
      (v) => v.status === "queued" || v.status === "processing",
    );
    if (!hasActive) return;
    const timer = setInterval(refreshActive, 4000);
    return () => clearInterval(timer);
  }, [videos, refreshActive]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteVideo(id);
      setVideos((prev) => prev?.filter((v) => v.video_id !== id) ?? prev);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("library.deleteError" as string),
      );
    }
  }, []);

  const handleCancel = useCallback(
    async (jobId: string) => {
      try {
        await cancelJob(jobId);
        refreshActive();
      } catch (err: unknown) {
        setError(
          err instanceof Error
            ? err.message
            : t("library.cancelError" as string),
        );
      }
    },
    [refreshActive],
  );

  const filtered = useMemo(() => {
    if (!videos) return null;
    return videos.filter((v) => (v.origin ?? "extract") === mode);
  }, [videos, mode]);

  const stats = useMemo(() => {
    if (!filtered || filtered.length === 0) return null;
    const totalEntries = filtered.reduce((acc, v) => acc + v.entries, 0);
    const newest = filtered.reduce((a, b) =>
      new Date(a.created_at) > new Date(b.created_at) ? a : b,
    );
    return { count: filtered.length, totalEntries, newest: newest.created_at };
  }, [filtered]);

  return (
    <div>
      {/* ── Workspace toolbar ── */}
      <div className="flex items-end justify-between gap-4 flex-wrap mb-7">
        <div className="min-w-0">
          <h1 className="text-xl lg:text-[1.35rem] font-semibold tracking-tight leading-tight text-ink">
            {mode === "pipeline"
              ? t("nav.library.pipeline" as string)
              : t("nav.library" as string)}
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted max-w-2xl leading-relaxed">
            {mode === "pipeline"
              ? t("library.desc.pipeline" as string)
              : t("library.heroDesc" as string)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
          {stats && (
            <>
              <div className="tag !px-3 !py-1.5 hidden sm:inline-flex">
                <span className="font-semibold text-ink tabular-nums">
                  {stats.count}
                </span>
                <span className="text-ink-light">
                  {" "}
                  {t("library.videos" as string)}
                </span>
              </div>
              <div className="tag !px-3 !py-1.5 hidden md:inline-flex">
                <span className="font-semibold text-ink tabular-nums">
                  {stats.totalEntries}
                </span>
                <span className="text-ink-light">
                  {" "}
                  {t("library.subtitleLines" as string)}
                </span>
              </div>
              <div className="tag !px-3 !py-1.5 hidden lg:inline-flex">
                <span className="text-ink-light">
                  {t("library.latest" as string)}&nbsp;
                </span>
                <span className="text-ink">{formatDate(stats.newest)}</span>
              </div>
            </>
          )}
          <Link
            href={mode === "pipeline" ? "/auto" : "/extract"}
            className="btn-island-primary group text-[13px]"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span className="tracking-tight">
              {mode === "pipeline"
                ? t("library.newPipeline" as string)
                : t("library.newExtractor" as string)}
            </span>
          </Link>
        </div>
      </div>

      {/* ── Grid ── */}
      <section>
        {error && (
          <AnimatedBlock delay={0}>
            <div className="double-bezel">
              <div className="double-bezel-inner p-10 text-center">
                <svg
                  className="w-6 h-6 text-danger mx-auto mb-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="text-sm text-danger/80">{error}</p>
                <button
                  onClick={() => load()}
                  className="btn-island-secondary group mt-5 text-sm"
                >
                  <span className="tracking-tight">
                    {t("library.tryAgain" as string)}
                  </span>
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
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>
          </AnimatedBlock>
        )}

        {!error && videos === null && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {!error && filtered && filtered.length === 0 && (
          <AnimatedBlock delay={0}>
            <div className="double-bezel">
              <div className="double-bezel-inner p-14 sm:p-20 text-center">
                <div className="w-16 h-16 rounded-full bg-accent-muted ring-1 ring-accent/15 flex items-center justify-center mx-auto mb-6">
                  <svg
                    className="w-7 h-7 text-accent"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="4" width="20" height="16" rx="3" />
                    <line x1="2" y1="9" x2="22" y2="9" />
                    <path d="M10 14l4-2-4-2v4" />
                  </svg>
                </div>
                <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
                  {mode === "pipeline"
                    ? t("library.emptyTitle.pipeline" as string)
                    : t("library.emptyTitle" as string)}
                </h2>
                <p className="text-sm text-ink-muted max-w-sm mx-auto mt-3 leading-relaxed">
                  {mode === "pipeline"
                    ? t("library.emptyDesc.pipeline" as string)
                    : t("library.emptyDesc" as string)}
                </p>
                <Link
                  href={mode === "pipeline" ? "/auto" : "/extract"}
                  className="btn-island-primary group mt-8"
                >
                  <span className="tracking-tight">
                    {mode === "pipeline"
                      ? t("library.newPipeline" as string)
                      : t("library.startFirstExtractor" as string)}
                  </span>
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
                      <path d="M5 12h14" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </Link>
              </div>
            </div>
          </AnimatedBlock>
        )}

        {!error && filtered && filtered.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-6">
              <span className="text-[13px] font-medium text-ink-muted tabular-nums">
                {t("library.videoCount" as string, {
                  count: filtered.length,
                })}
              </span>
              <ViewToggle value={view} onChange={changeView} />
            </div>

            {view === "grid" ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4 auto-rows-auto">
                {filtered.map((v, i) => (
                  <VideoCard
                    key={v.video_id}
                    video={v}
                    index={i}
                    mode={mode}
                    onDelete={handleDelete}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {filtered.map((v, i) => (
                  <VideoRow
                    key={v.video_id}
                    video={v}
                    index={i}
                    mode={mode}
                    onDelete={handleDelete}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

type ViewMode = "grid" | "list";

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1 rounded-lg bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
      <button
        onClick={() => onChange("grid")}
        aria-label={t("library.viewGrid" as string)}
        title={t("library.viewGrid" as string)}
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
          ${value === "grid" ? "bg-accent text-white shadow-sm" : "text-ink-muted hover:text-ink"}`}
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      </button>
      <button
        onClick={() => onChange("list")}
        aria-label={t("library.viewList" as string)}
        title={t("library.viewList" as string)}
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
          ${value === "list" ? "bg-accent text-white shadow-sm" : "text-ink-muted hover:text-ink"}`}
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <path d="M3 6h.01" />
          <path d="M3 12h.01" />
          <path d="M3 18h.01" />
        </svg>
      </button>
    </div>
  );
}

function useReveal(index: number, distance = 30) {
  const [visible, setVisible] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [el]);
  const style = useMemo(
    () => ({
      opacity: 0,
      transform: `translateY(${distance}px) scale(0.98)`,
      filter: "blur(8px)",
      transition: `all 0.85s cubic-bezier(0.32,0.72,0,1) ${Math.min(index * 70, 300)}ms`,
      ...(visible
        ? { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0)" }
        : {}),
    }),
    [visible, index, distance],
  );
  return { ref: (node: HTMLDivElement | null) => setEl(node), style };
}

function JobStatusBlock({
  video,
  onCancel,
}: {
  video: VideoMeta;
  onCancel?: (jobId: string) => void;
}) {
  const { t } = useI18n();
  if (!video.status || video.status === "done") return null;

  if (video.status === "uploaded") {
    return (
      <div className="flex items-center gap-1.5 mt-2 w-max max-w-full">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-muted ring-1 ring-accent/15 text-[11px] font-medium text-accent/90 truncate">
          <svg
            className="w-3 h-3 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          {t("library.statusUploaded" as string)}
        </span>
      </div>
    );
  }

  if (video.status === "cancelled") {
    return (
      <div className="flex items-center gap-1.5 mt-2 w-max max-w-full">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-warn-muted ring-1 ring-warn/15 text-[11px] font-medium text-warn/90 truncate">
          <svg
            className="w-3 h-3 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="5" y1="5" x2="19" y2="19" />
          </svg>
          {t("library.statusCancelled" as string)}
        </span>
      </div>
    );
  }

  if (video.status === "error") {
    return (
      <div className="flex items-center gap-1.5 mt-2 w-max max-w-full">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-danger-muted ring-1 ring-danger/15 text-[11px] font-medium text-danger/90 truncate">
          <svg
            className="w-3 h-3 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {video.error ? video.error : t("library.statusError" as string)}
        </span>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, video.progress ?? 0));
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-muted ring-1 ring-accent/15 text-[11px] font-medium text-accent/90">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          {video.status === "queued"
            ? t("library.statusQueued" as string)
            : t("library.statusProcessing" as string)}
        </span>
        <span className="text-[11px] font-mono text-accent tabular-nums">
          {pct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
          style={{ width: `${Math.max(pct, 3)}%` }}
        />
      </div>
      {onCancel && video.job_id && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCancel(video.job_id!);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 mt-2 rounded-full text-[11px] font-medium tracking-tight text-danger ring-1 ring-danger/20 hover:bg-danger-muted transition-colors duration-300 cursor-pointer active:scale-95"
        >
          <svg
            className="w-3 h-3"
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
          {t("library.cancelProcessing" as string)}
        </button>
      )}
    </div>
  );
}

function VideoRow({
  video,
  index,
  onDelete,
  onCancel,
  mode = "extract",
}: {
  video: VideoMeta;
  index: number;
  onDelete: (videoId: string) => void;
  onCancel: (jobId: string) => void;
  mode?: "extract" | "pipeline";
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const { ref, style } = useReveal(index);
  const href =
    mode === "pipeline"
      ? `/auto?video_id=${video.video_id}`
      : video.status === "uploaded"
        ? `/extract?video_id=${video.video_id}`
        : `/video/${video.video_id}`;

  return (
    <Link href={href} className="group block focus:outline-none" style={style}>
      <div
        ref={ref}
        className="double-bezel transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-1 group-hover:shadow-[0_30px_60px_-28px_rgba(0,0,0,0.2)]"
      >
        <div className="double-bezel-inner p-2 sm:p-3 flex items-center gap-3 sm:gap-5">
          <div className="relative w-28 sm:w-44 flex-shrink-0 aspect-video overflow-hidden rounded-xl bg-black">
            {video.has_video ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={getFrameUrl(video.video_id)}
                alt={video.filename}
                loading="lazy"
                className="w-full h-full object-cover transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-[1.06] group-hover:opacity-80"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-blue-600/20 via-blue-500/10 to-transparent flex items-center justify-center">
                <svg
                  className="w-7 h-7 text-accent/40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="4" width="20" height="16" rx="3" />
                  <line x1="2" y1="9" x2="22" y2="9" />
                  <path d="M10 14l4-2-4-2v4" />
                </svg>
              </div>
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-500" />
            {(video.status === "queued" || video.status === "processing") && (
              <div className="absolute inset-0 bg-black/35 flex items-center justify-center">
                <div className="w-10 h-10 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-accent animate-spin"
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
                </div>
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-500">
              <div className="w-10 h-10 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-ink ml-0.5"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  strokeWidth={0}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold tracking-tight text-ink truncate">
              {video.filename}
            </h3>
            {video.status && video.status !== "done" ? (
              <JobStatusBlock video={video} onCancel={onCancel} />
            ) : (
              <div className="flex items-center gap-2.5 mt-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success-muted ring-1 ring-success/15 text-[11px] font-medium text-success/90">
                  <svg
                    className="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  >
                    <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
                  </svg>
                  {t("library.linesCount" as string, { count: video.entries })}
                </span>
                <span className="text-[11px] text-ink-light tabular-nums">
                  {formatDate(video.created_at)}
                  {formatTime(video.created_at) &&
                    ` · ${formatTime(video.created_at)}`}
                </span>
                {!video.has_video && (
                  <span className="px-2.5 py-1 rounded-full bg-white/[0.06] text-[10px] font-medium text-ink-light uppercase tracking-wide">
                    {t("library.videoUnavailable" as string)}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirming) onDelete(video.video_id);
                else setConfirming(true);
              }}
              aria-label={
                confirming
                  ? t("library.confirmDelete" as string)
                  : t("library.delete" as string)
              }
              className={`flex items-center justify-center rounded-full transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
                ${
                  confirming
                    ? "bg-danger text-white w-10 h-10"
                    : "w-10 h-10 bg-white/[0.06] text-ink-muted hover:bg-danger hover:text-white shadow-sm ring-1 ring-white/[0.09]"
                }`}
            >
              {confirming ? (
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6L9 17l-5-5" />
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
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              )}
            </button>
            <div className="hidden sm:flex w-9 h-9 rounded-full bg-white/[0.05] items-center justify-center text-ink-muted transition-colors duration-300 group-hover:text-accent">
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function VideoCard({
  video,
  index,
  onDelete,
  onCancel,
  mode = "extract",
}: {
  video: VideoMeta;
  index: number;
  onDelete: (videoId: string) => void;
  onCancel: (jobId: string) => void;
  mode?: "extract" | "pipeline";
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  const { ref, style } = useReveal(index, 24);
  const href =
    mode === "pipeline"
      ? `/auto?video_id=${video.video_id}`
      : video.status === "uploaded"
        ? `/extract?video_id=${video.video_id}`
        : `/video/${video.video_id}`;

  return (
    <Link href={href} className="group block focus:outline-none" style={style}>
      <div
        ref={ref}
        className="double-bezel transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-1 group-hover:shadow-[0_20px_44px_-20px_rgba(0,0,0,0.55)]"
      >
        <div className="double-bezel-inner p-1.5">
          {/* Square thumbnail */}
          <div className="relative aspect-square overflow-hidden rounded-lg bg-black">
            {video.has_video ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={getFrameUrl(video.video_id)}
                alt={video.filename}
                loading="lazy"
                className="w-full h-full object-cover transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-[1.05]"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-blue-600/15 via-blue-500/5 to-transparent flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-accent/40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="4" width="20" height="16" rx="3" />
                  <line x1="2" y1="9" x2="22" y2="9" />
                  <path d="M10 14l4-2-4-2v4" />
                </svg>
              </div>
            )}
            {(video.status === "queued" || video.status === "processing") && (
              <div className="absolute inset-0 bg-black/45 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-accent animate-spin"
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
              </div>
            )}
            {!video.has_video && (
              <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[9px] font-medium text-white/80 tracking-wide uppercase">
                {t("library.videoUnavailable" as string)}
              </span>
            )}
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirming) onDelete(video.video_id);
                else setConfirming(true);
              }}
              aria-label={
                confirming
                  ? t("library.confirmDelete" as string)
                  : t("library.delete" as string)
              }
              className={`absolute top-2 right-2 z-10 flex items-center justify-center rounded-full backdrop-blur-sm transition-all duration-300 cursor-pointer active:scale-95
                ${
                  confirming
                    ? "bg-danger text-white w-auto px-2 h-6 gap-1"
                    : "w-6 h-6 bg-black/50 text-white/90 hover:bg-danger opacity-0 group-hover:opacity-100"
                }`}
            >
              {confirming ? (
                <>
                  <svg
                    className="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span className="text-[9px] font-semibold tracking-tight whitespace-nowrap">
                    {t("library.deleteQuestion" as string)}
                  </span>
                </>
              ) : (
                <svg
                  className="w-3 h-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              )}
            </button>
            <div className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-white/90 flex items-center justify-center opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]">
              <svg
                className="w-3.5 h-3.5 text-ink ml-px"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14" />
                <path d="M13 6l6 6-6 6" />
              </svg>
            </div>
          </div>

          {/* Meta */}
          <div className="px-1 pt-2 pb-1">
            <h3
              className="text-[12px] font-medium tracking-tight text-ink truncate"
              title={video.filename}
            >
              {video.filename}
            </h3>
            {video.status && video.status !== "done" ? (
              <JobStatusBlock video={video} onCancel={onCancel} />
            ) : (
              <p className="mt-1 text-[10px] text-ink-light tabular-nums truncate">
                {formatDate(video.created_at)}
                {formatTime(video.created_at) &&
                  ` · ${formatTime(video.created_at)}`}
                {" · "}
                {t("library.linesCount" as string, { count: video.entries })}
              </p>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
