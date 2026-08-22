"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";
import { useI18n } from "@/lib/i18n";

interface Channel {
  id: string;
  url: string;
  name: string;
  avatar_url: string;
  added_at: string;
}

interface AwemeVideo {
  aweme_id: string;
  desc: string;
  create_time: number;
  share_url?: string;
  share_link_desc?: string;
  author?: { nickname?: string };
  video?: {
    cover?: { url_list?: string[] };
    duration?: number;
    play_addr?: { url_list?: string[] };
  };
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
  };
}

interface ScanResult {
  channel_name: string;
  total: number;
  filtered: number;
  videos: AwemeVideo[];
}

function IconSpinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      className={`${className} animate-spin`}
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
  );
}

function fmtNumber(n: number | undefined): string {
  if (n == null) return "\u2014";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtDuration(ms: number | undefined): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

export default function ChannelsPage() {
  const { t } = useI18n();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [scanDate, setScanDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [scanning, setScanning] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<AwemeVideo | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("pinned_channels");
        return saved ? new Set(JSON.parse(saved)) : new Set();
      } catch {
        return new Set();
      }
    }
    return new Set();
  });

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      localStorage.setItem("pinned_channels", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const sortedChannels = [...channels].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id);
    const bPinned = pinnedIds.has(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return 0;
  });

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/channels");
      const data = await res.json();
      setChannels(data.channels || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const handleAdd = async () => {
    const url = newUrl.trim();
    if (!url) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.detail || t("channel.addError"));
        return;
      }
      setChannels((prev) => [...prev, data.channel]);
      setNewUrl("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : t("channel.addError"));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/channels?id=${id}`, { method: "DELETE" });
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // ignore
    }
  };

  const handleScan = async (ch: Channel) => {
    setScanning(ch.id);
    setScanResult(null);
    setScanError(null);
    try {
      const sinceTs = scanDate
        ? Math.floor(new Date(scanDate + "T00:00:00").getTime() / 1000)
        : 0;
      const res = await fetch("/api/channels/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: ch.url, since: sinceTs }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScanError(data.detail || t("channel.scanError"));
        return;
      }
      setScanResult(data);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    } finally {
      setScanning(null);
    }
  };

  return (
    <main className="min-h-[100dvh] max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Link
            href="/"
            className="btn-island-secondary group !px-5 !py-2 text-[13px]"
          >
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
                <path d="M19 12H5" />
                <path d="M11 18l-6-6 6-6" />
              </svg>
            </span>
            <span className="tracking-tight">{t("channel.backLibrary")}</span>
          </Link>
          <Link
            href="/auto"
            className="btn-island-secondary group !px-5 !py-2 text-[13px]"
          >
            <span className="tracking-tight">{t("channel.autoPipeline")}</span>
          </Link>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mt-10 mb-10">
        <div className="eyebrow mb-4">{t("channel.eyebrow")}</div>
        <h1 className="text-[clamp(1.8rem,4.5vw,3.4rem)] font-semibold tracking-tight leading-[1.05] text-ink">
          {t("channel.title")}
        </h1>
        <p className="mt-4 text-sm text-ink-muted max-w-lg leading-relaxed">
          {t("channel.desc")}
        </p>
      </AnimatedBlock>

      <AnimatedBlock delay={150}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink mb-3">
              {t("channel.addTitle")}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="https://www.douyin.com/user/MS4wLjAB..."
                className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-accent/15"
                disabled={adding}
              />
              <button
                onClick={handleAdd}
                disabled={!newUrl.trim() || adding}
                className="btn-island-primary text-sm !px-5 !py-2.5 flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {adding ? (
                  <IconSpinner className="w-4 h-4" />
                ) : (
                  t("channel.addBtn")
                )}
              </button>
            </div>
            {addError && (
              <p className="mt-2 text-[12px] text-danger">{addError}</p>
            )}
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={200}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                {t("channel.dateFilter")}
              </p>
              <div className="flex items-center gap-2">
                <label className="text-[12px] text-ink-muted">
                  {t("channel.fromDate")}
                </label>
                <input
                  type="date"
                  value={scanDate}
                  onChange={(e) => setScanDate(e.target.value)}
                  className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-accent/15"
                />
              </div>
            </div>

            {channels.length === 0 ? (
              <p className="text-[13px] text-ink-light py-6 text-center">
                {t("channel.empty")}
              </p>
            ) : (
              <div className="space-y-2">
                {sortedChannels.map((ch) => {
                  const isPinned = pinnedIds.has(ch.id);
                  return (
                    <div
                      key={ch.id}
                      className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                        isPinned
                          ? "bg-amber-50/80 ring-1 ring-amber-200/60"
                          : "bg-black/[0.02] ring-1 ring-black/[0.05] hover:bg-black/[0.04]"
                      }`}
                    >
                      <button
                        onClick={() => togglePin(ch.id)}
                        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors ${
                          isPinned
                            ? "text-warn hover:text-warn"
                            : "text-ink-light hover:text-warn hover:bg-amber-50"
                        }`}
                        title={isPinned ? t("channel.unpin") : t("channel.pin")}
                      >
                        <svg
                          className="w-4 h-4"
                          viewBox="0 0 24 24"
                          fill={isPinned ? "currentColor" : "none"}
                          stroke="currentColor"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
                        </svg>
                      </button>
                      <div className="flex-1 min-w-0 flex items-center gap-3">
                        {ch.avatar_url ? (
                          <img
                            src={ch.avatar_url}
                            alt=""
                            className="w-10 h-10 rounded-full object-cover flex-shrink-0 bg-black/[0.04]"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-black/[0.06] flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-ink-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                              <circle cx="12" cy="7" r="4" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-ink truncate">
                            {ch.name}
                          </p>
                          <p className="text-[11px] text-ink-light font-mono truncate">
                            {ch.url}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleScan(ch)}
                        disabled={scanning !== null}
                        className="px-4 py-2 rounded-full text-[12px] font-medium bg-accent text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 flex-shrink-0 cursor-pointer"
                      >
                        {scanning === ch.id ? (
                          <>
                            <IconSpinner className="w-3.5 h-3.5" />
                            {t("channel.scanning")}
                          </>
                        ) : (
                          t("channel.scan")
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(ch.id)}
                        disabled={scanning === ch.id}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-ink-light hover:text-danger hover:bg-red-50 transition-colors disabled:opacity-40 cursor-pointer"
                      >
                        <svg
                          className="w-4 h-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                        >
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {scanError && (
        <AnimatedBlock delay={0}>
          <div className="mb-6 rounded-xl bg-danger-muted ring-1 ring-danger/15 px-4 py-3">
            <p className="text-[13px] font-medium text-danger">{scanError}</p>
          </div>
        </AnimatedBlock>
      )}

      {scanResult && (
        <AnimatedBlock delay={0}>
          <div className="double-bezel mb-6">
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {t("channel.resultsTitle")}
                  </p>
                  {scanResult.channel_name && (
                    <p className="text-[13px] text-ink mt-1">
                      {scanResult.channel_name}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="tag">
                    {t("channel.total", { count: scanResult.total })}
                  </span>
                  <span className="tag bg-accent-muted text-accent ring-accent/15">
                    {t("channel.filtered", { count: scanResult.filtered })}
                  </span>
                </div>
              </div>

              {scanResult.videos.length === 0 ? (
                <p className="text-[13px] text-ink-light py-6 text-center">
                  {t("channel.noResults")}
                </p>
              ) : (
                <div className="overflow-x-auto -mx-5 sm:-mx-6 px-5 sm:px-6">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-black/[0.06]">
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted w-12">
                          #
                        </th>
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                          {t("channel.colVideo")}
                        </th>
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted w-32">
                          {t("channel.colDate")}
                        </th>
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted w-20 text-right">
                          {t("channel.colLikes")}
                        </th>
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted w-12">
                          {t("channel.colWatch")}
                        </th>
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted w-12">
                          {t("channel.colShare")}
                        </th>
                        <th className="pb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted w-12">
                          {t("channel.colAutoPipeline")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanResult.videos.map((v, idx) => {
                        const shareText =
                          v.share_link_desc ||
                          v.share_url ||
                          `https://www.douyin.com/video/${v.aweme_id}`;
                        const isCopied = copiedId === v.aweme_id;
                        return (
                          <tr
                            key={v.aweme_id}
                            className="border-b border-black/[0.04] hover:bg-black/[0.02] transition-colors"
                          >
                            <td className="py-4 text-[13px] text-ink-light font-mono">
                              {idx + 1}
                            </td>
                            <td className="py-4">
                              <div className="flex items-start gap-4">
                                {v.video?.cover?.url_list?.[0] && (
                                  <img
                                    src={v.video.cover.url_list[0]}
                                    alt=""
                                    width={200}
                                    className=" h-30 object-cover rounded-xl flex-shrink-0 bg-black/[0.04]"
                                  />
                                )}
                                <div className="min-w-0">
                                  <p className="text-[16px] text-ink line-clamp-2 leading-snug">
                                    {truncateText(
                                      v.desc || t("channel.noTitle"),
                                      80,
                                    )}
                                  </p>
                                  <p className="text-[16px] text-ink-light mt-1.5">
                                    {v.author?.nickname || "\u2014"}
                                    {v.video?.duration
                                      ? ` \u00B7 ${fmtDuration(v.video.duration)}`
                                      : ""}
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="py-4 text-[13px] text-ink-muted whitespace-nowrap">
                              {fmtDate(v.create_time)}
                            </td>
                            <td className="py-4 text-[13px] text-ink-muted text-right font-mono tabular-nums">
                              {fmtNumber(v.statistics?.digg_count)}
                            </td>
                            <td className="py-4 text-center">
                              {v.video?.play_addr?.url_list?.[0] && (
                                <button
                                  onClick={() => setPlayingVideo(v)}
                                  className="w-8 h-8 rounded-full flex items-center justify-center text-ink-light hover:text-success hover:bg-emerald-50 transition-colors cursor-pointer"
                                  title={t("channel.colWatch")}
                                >
                                  <svg
                                    className="w-4 h-4"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                  >
                                    <path d="M8 5v14l11-7z" />
                                  </svg>
                                </button>
                              )}
                            </td>
                            <td className="py-4 text-center">
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(shareText);
                                  setCopiedId(v.aweme_id);
                                  setTimeout(() => setCopiedId(null), 1500);
                                }}
                                className="w-8 h-8 rounded-full flex items-center justify-center text-ink-light hover:text-accent hover:bg-blue-50 transition-colors cursor-pointer"
                                title="Copy share link"
                              >
                                {isCopied ? (
                                  <svg
                                    className="w-4 h-4 text-success"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                                    <polyline points="22 4 12 14.01 9 11.01" />
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
                                    <rect
                                      x="9"
                                      y="9"
                                      width="13"
                                      height="13"
                                      rx="2"
                                      ry="2"
                                    />
                                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                                  </svg>
                                )}
                              </button>
                            </td>
                            <td className="py-4 text-center">
                              <Link
                                href={`/auto?url=${encodeURIComponent(shareText)}`}
                                className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-light hover:text-accent hover:bg-blue-50 transition-colors"
                                title="Auto Pipeline"
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
                                  <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
                                </svg>
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </AnimatedBlock>
      )}

      {/* Video Player Modal */}
      {playingVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setPlayingVideo(null)}
        >
          <div
            className="relative w-full max-w-3xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="rounded-2xl overflow-hidden bg-black shadow-2xl">
              <video
                src={`/api/channels/proxy-video?url=${encodeURIComponent(playingVideo.video?.play_addr?.url_list?.[0] || "")}`}
                controls
                autoPlay
                className="w-full max-h-[80vh] object-contain"
              />
            </div>
            <div className="mt-3 px-1">
              <p className="text-[13px] text-white line-clamp-2">
                {playingVideo.desc || t("channel.noTitle")}
              </p>
              <p className="text-[11px] text-white/60 mt-1">
                {playingVideo.author?.nickname || "\u2014"}
                {playingVideo.video?.duration
                  ? ` \u00B7 ${fmtDuration(playingVideo.video.duration)}`
                  : ""}
              </p>
            </div>
            <button
              onClick={() => setPlayingVideo(null)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white/90 shadow-lg flex items-center justify-center text-gray-600 hover:text-gray-900 cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
