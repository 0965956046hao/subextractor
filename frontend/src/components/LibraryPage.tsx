"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { listVideos, getFrameUrl, deleteVideo, cancelJob } from "@/lib/api";
import type { VideoMeta } from "@/lib/api";
import { AnimatedBlock } from "@/lib/animation";

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

function SkeletonCard({ featured = false }: { featured?: boolean }) {
  return (
    <div className={`double-bezel ${featured ? "md:col-span-2" : ""}`}>
      <div className="double-bezel-inner p-2">
        <div className="aspect-video rounded-[calc(2rem-0.75rem)] bg-black/[0.04] animate-pulse" />
        <div className="px-3 py-4 space-y-2.5">
          <div className="h-3.5 w-2/3 rounded-full bg-black/[0.05] animate-pulse" />
          <div className="h-3 w-1/3 rounded-full bg-black/[0.04] animate-pulse" />
        </div>
      </div>
    </div>
  );
}

export default function LibraryPage() {
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
        setError(err instanceof Error ? err.message : "Failed to load library");
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
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  const handleCancel = useCallback(
    async (jobId: string) => {
      try {
        await cancelJob(jobId);
        refreshActive();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to cancel");
      }
    },
    [refreshActive],
  );

  const stats = useMemo(() => {
    if (!videos || videos.length === 0) return null;
    const totalEntries = videos.reduce((acc, v) => acc + v.entries, 0);
    const newest = videos.reduce((a, b) =>
      new Date(a.created_at) > new Date(b.created_at) ? a : b,
    );
    return { count: videos.length, totalEntries, newest: newest.created_at };
  }, [videos]);

  const [featured, ...rest] = videos ?? [];

  return (
    <main className="min-h-[100dvh] px-4 sm:px-6 pb-24">
      {/* ── Floating island nav ── */}
      <header className="sticky top-0 pt-4 sm:pt-5 z-40 pointer-events-none">
        <div className="mx-auto w-max glass-panel rounded-full pl-5 pr-2 py-2 flex items-center gap-6 pointer-events-auto shadow-[0_12px_40px_-16px_rgba(0,0,0,0.12)]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center">
              <svg
                className="w-3.5 h-3.5 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="4" width="20" height="16" rx="3" />
                <line x1="2" y1="9" x2="22" y2="9" />
              </svg>
            </div>
            <span className="text-sm font-semibold tracking-tight text-ink">
              SubTitle Extractor
            </span>
          </div>
          <Link
            href="/extract"
            className="btn-island-primary group !px-5 !py-2 text-[13px]"
          >
            <span className="tracking-tight">New Extractor</span>
            <span className="btn-island-icon !w-7 !h-7">
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </span>
          </Link>
          <Link
            href="/auto"
            className="btn-island-primary group !px-5 !py-2 text-[13px]"
          >
            <span className="tracking-tight">Auto Pipeline</span>
            <span className="btn-island-icon !w-7 !h-7">
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
              </svg>
            </span>
          </Link>

          <Link
            href="/settings"
            title="Cài đặt (API key, TTS, style phụ đề)"
            className="w-9 h-9 rounded-full bg-black/[0.04] ring-1 ring-black/[0.08] text-ink-muted hover:bg-black/[0.08] hover:text-ink transition-all duration-300 active:scale-[0.95] flex items-center justify-center cursor-pointer"
          >
            <svg
              className="w-[18px] h-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="pt-20 sm:pt-28 md:pt-36 pb-16 sm:pb-20 text-center">
        <AnimatedBlock delay={0}>
          <div className="eyebrow mx-auto mb-6 w-max">Extracted Library</div>
        </AnimatedBlock>
        <AnimatedBlock delay={100}>
          <h1 className="text-[clamp(2.6rem,8vw,6.5rem)] font-semibold tracking-tight leading-[0.92] text-balance text-ink">
            Your subtitles,
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-blue-500 to-blue-400/60">
              ready to relive
            </span>
          </h1>
        </AnimatedBlock>
        <AnimatedBlock delay={200}>
          <p className="mt-5 text-sm sm:text-base text-ink-muted max-w-md mx-auto leading-relaxed">
            Every video you&rsquo;ve extracted lives here — open one to watch,
            read the transcript, and download clean SRT text.
          </p>
        </AnimatedBlock>
        <AnimatedBlock delay={300}>
          <div className="mt-9 flex items-center justify-center">
            <Link
              href="/extract"
              className="btn-island-primary group text-[15px]"
            >
              <span className="tracking-tight">Start a new extractor</span>
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
        </AnimatedBlock>
        {stats && (
          <AnimatedBlock delay={400}>
            <div className="mt-12 flex items-center justify-center gap-2.5 flex-wrap">
              <div className="tag !px-4 !py-2">
                <span className="font-semibold text-ink tabular-nums">
                  {stats.count}
                </span>
                <span className="text-ink-light"> videos</span>
              </div>
              <div className="tag !px-4 !py-2">
                <span className="font-semibold text-ink tabular-nums">
                  {stats.totalEntries}
                </span>
                <span className="text-ink-light"> subtitle lines</span>
              </div>
              <div className="tag !px-4 !py-2">
                <span className="text-ink-light">latest&nbsp;</span>
                <span className="text-ink">{formatDate(stats.newest)}</span>
              </div>
            </div>
          </AnimatedBlock>
        )}
      </section>

      {/* ── Grid ── */}
      <section className="max-w-7xl mx-auto">
        {error && (
          <AnimatedBlock delay={0}>
            <div className="double-bezel">
              <div className="double-bezel-inner p-10 text-center">
                <svg
                  className="w-6 h-6 text-red-500 mx-auto mb-3"
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
                <p className="text-sm text-red-600/80">{error}</p>
                <button
                  onClick={() => load()}
                  className="btn-island-secondary group mt-5 text-sm"
                >
                  <span className="tracking-tight">Try again</span>
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 md:gap-8">
            <SkeletonCard featured />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {!error && videos && videos.length === 0 && (
          <AnimatedBlock delay={0}>
            <div className="double-bezel">
              <div className="double-bezel-inner p-14 sm:p-20 text-center">
                <div className="w-16 h-16 rounded-full bg-blue-600/10 ring-1 ring-blue-600/20 flex items-center justify-center mx-auto mb-6">
                  <svg
                    className="w-7 h-7 text-blue-500"
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
                  Nothing extracted yet
                </h2>
                <p className="text-sm text-ink-muted max-w-sm mx-auto mt-3 leading-relaxed">
                  Upload your first video, mark the subtitle region, and let OCR
                  do the rest. Your library appears here.
                </p>
                <Link href="/extract" className="btn-island-primary group mt-8">
                  <span className="tracking-tight">
                    Start your first extractor
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

        {!error && videos && videos.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-6">
              <span className="text-[13px] font-medium text-ink-muted tabular-nums">
                {videos.length} video{videos.length > 1 ? "s" : ""}
              </span>
              <ViewToggle value={view} onChange={changeView} />
            </div>

            {view === "grid" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 md:gap-8">
                {featured && (
                  <VideoCard
                    video={featured}
                    featured
                    index={0}
                    onDelete={handleDelete}
                    onCancel={handleCancel}
                  />
                )}
                {rest.map((v, i) => (
                  <VideoCard
                    key={v.video_id}
                    video={v}
                    index={i + 1}
                    onDelete={handleDelete}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {videos.map((v, i) => (
                  <VideoRow
                    key={v.video_id}
                    video={v}
                    index={i}
                    onDelete={handleDelete}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <footer className="max-w-7xl mx-auto mt-24 sm:mt-32 text-center">
        <p className="text-[11px] text-ink-light tracking-wide">
          SubTitle Extractor
        </p>
      </footer>
    </main>
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
  return (
    <div className="flex items-center gap-1 rounded-full bg-black/[0.03] p-1 ring-1 ring-black/[0.05]">
      <button
        onClick={() => onChange("grid")}
        aria-label="Xem dạng lưới"
        title="Xem dạng lưới"
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
          ${value === "grid" ? "bg-white text-blue-600 shadow-sm ring-1 ring-black/[0.06]" : "text-ink-muted hover:text-ink"}`}
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
        aria-label="Xem dạng danh sách"
        title="Xem dạng danh sách"
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
          ${value === "list" ? "bg-white text-blue-600 shadow-sm ring-1 ring-black/[0.06]" : "text-ink-muted hover:text-ink"}`}
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
  if (!video.status || video.status === "done") return null;

  if (video.status === "uploaded") {
    return (
      <div className="flex items-center gap-1.5 mt-2 w-max max-w-full">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 ring-1 ring-blue-500/20 text-[11px] font-medium text-blue-600/90 truncate">
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
          Đã upload — cần chọn vùng & extract
        </span>
      </div>
    );
  }

  if (video.status === "cancelled") {
    return (
      <div className="flex items-center gap-1.5 mt-2 w-max max-w-full">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 ring-1 ring-amber-500/20 text-[11px] font-medium text-amber-600/90 truncate">
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
          Đã hủy — xử lý lại
        </span>
      </div>
    );
  }

  if (video.status === "error") {
    return (
      <div className="flex items-center gap-1.5 mt-2 w-max max-w-full">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 ring-1 ring-red-500/20 text-[11px] font-medium text-red-600/90 truncate">
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
          {video.error ? video.error : "Có lỗi xử lý"}
        </span>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, video.progress ?? 0));
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 ring-1 ring-blue-500/20 text-[11px] font-medium text-blue-600/90">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          {video.status === "queued" ? "Đang chờ xử lý…" : "Đang xử lý…"}
        </span>
        <span className="text-[11px] font-mono text-blue-600 tabular-nums">
          {pct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 mt-2 rounded-full text-[11px] font-medium tracking-tight text-red-600 ring-1 ring-red-500/25 hover:bg-red-500/10 transition-colors duration-300 cursor-pointer active:scale-95"
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
          Hủy xử lý
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
}: {
  video: VideoMeta;
  index: number;
  onDelete: (videoId: string) => void;
  onCancel: (jobId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const { ref, style } = useReveal(index);
  const href =
    video.status === "uploaded"
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
                  className="w-7 h-7 text-blue-500/40"
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
                    className="w-5 h-5 text-blue-600 animate-spin"
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
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 text-[11px] font-medium text-emerald-600/90">
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
                  {video.entries} lines
                </span>
                <span className="text-[11px] text-ink-light tabular-nums">
                  {formatDate(video.created_at)}
                  {formatTime(video.created_at) &&
                    ` · ${formatTime(video.created_at)}`}
                </span>
                {!video.has_video && (
                  <span className="px-2.5 py-1 rounded-full bg-black/[0.05] text-[10px] font-medium text-ink-light uppercase tracking-wide">
                    Video unavailable
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
              aria-label={confirming ? "Confirm delete" : "Delete"}
              className={`flex items-center justify-center rounded-full transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
                ${
                  confirming
                    ? "bg-red-500 text-white w-10 h-10 shadow-[0_8px_24px_-8px_rgba(239,68,68,0.5)]"
                    : "w-10 h-10 bg-white/80 text-ink-muted hover:bg-red-500 hover:text-white shadow-sm ring-1 ring-black/[0.06]"
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
            <div className="hidden sm:flex w-9 h-9 rounded-full bg-black/[0.03] items-center justify-center text-ink-muted transition-colors duration-300 group-hover:text-blue-600">
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
  featured = false,
  index,
  onDelete,
  onCancel,
}: {
  video: VideoMeta;
  featured?: boolean;
  index: number;
  onDelete: (videoId: string) => void;
  onCancel: (jobId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const { ref, style } = useReveal(index, 40);
  const href =
    video.status === "uploaded"
      ? `/extract?video_id=${video.video_id}`
      : `/video/${video.video_id}`;

  return (
    <Link
      href={href}
      className={`group block focus:outline-none ${featured ? "md:col-span-2" : ""}`}
      style={style}
    >
      <div
        ref={ref}
        className="double-bezel transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-2 group-hover:shadow-[0_40px_80px_-32px_rgba(0,0,0,0.22)]"
      >
        <div className="double-bezel-inner p-2">
          <div className="relative aspect-video overflow-hidden rounded-[calc(2rem-0.75rem)] bg-black">
            {video.has_video ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={getFrameUrl(video.video_id)}
                alt={video.filename}
                loading="lazy"
                className="w-full h-full object-cover transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-[1.04] group-hover:opacity-90"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-blue-600/20 via-blue-500/10 to-transparent flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-blue-500/40"
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
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]" />
            {(video.status === "queued" || video.status === "processing") && (
              <div className="absolute inset-0 bg-black/35 flex items-center justify-center">
                <div className="w-11 h-11 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-blue-600 animate-spin"
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
            <div className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]">
              <svg
                className="w-4 h-4 text-ink"
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
            </div>
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirming) onDelete(video.video_id);
                else setConfirming(true);
              }}
              aria-label={confirming ? "Confirm delete" : "Delete"}
              className={`absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-full backdrop-blur-sm transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
                ${
                  confirming
                    ? "bg-red-500 text-white px-3 py-1.5 shadow-[0_8px_24px_-8px_rgba(239,68,68,0.5)]"
                    : "w-9 h-9 justify-center bg-white/90 text-ink-muted hover:bg-red-500 hover:text-white shadow-sm opacity-0 group-hover:opacity-100"
                }`}
            >
              {confirming ? (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span className="text-[11px] font-medium tracking-tight">
                    Delete?
                  </span>
                </>
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
            {!video.has_video && (
              <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-[10px] font-medium text-white/90 tracking-wide uppercase">
                Video unavailable
              </span>
            )}
          </div>

          <div
            className={`px-3 sm:px-4 py-4 ${featured ? "sm:flex sm:items-end sm:justify-between sm:gap-6" : ""}`}
          >
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold tracking-tight text-ink truncate">
                {video.filename}
              </h3>
              {video.status && video.status !== "done" ? (
                <JobStatusBlock video={video} onCancel={onCancel} />
              ) : (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 text-[11px] font-medium text-emerald-600/90">
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
                    {video.entries} lines
                  </span>
                  <span className="text-[11px] text-ink-light tabular-nums">
                    {formatDate(video.created_at)}
                    {formatTime(video.created_at) &&
                      ` · ${formatTime(video.created_at)}`}
                  </span>
                </div>
              )}
            </div>
            {featured && (
              <div className="hidden sm:block flex-shrink-0">
                <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black/[0.04] text-[11px] font-medium uppercase tracking-[0.15em] text-ink-muted">
                  Latest extraction
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
