"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatedBlock } from "@/lib/animation";
import PageHeader from "@/components/layout/PageHeader";
import { useI18n } from "@/lib/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { getPipelinePresets, type PipelinePreset } from "@/lib/api";
import { usePipelineStore } from "@/stores/pipeline-store";

interface Channel {
  id: string;
  url: string;
  name: string;
  avatar_url: string;
  added_at: string;
  since_date?: string;
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

interface PlaylistGroup {
  id: string;
  title: string;
  videos: AwemeVideo[];
}

interface ScanResult {
  channel_name: string;
  total: number;
  filtered: number;
  videos: AwemeVideo[];
  playlists: PlaylistGroup[];
  cached?: number;
  added?: number;
  scanned_at?: number;
  from_cache?: boolean;
}

interface MixInfo {
  id: string;
  title: string;
  cover?: string;
  video_count?: number;
}

interface WorkerVideo {
  aweme_id: string;
  desc: string;
  create_time: number;
  share_url: string;
  cover: string;
  duration?: number;
  play_count?: number;
  digg_count?: number;
  channel_name: string;
}

interface WorkerChannel {
  id: string;
  name: string;
  url: string;
  video_count: number;
  scanned_at: number;
  videos: WorkerVideo[];
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

function truncateText(text: string | null | undefined, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/** Local pagination size for the scan results table (many videos → pages). */
const RESULTS_PAGE_SIZE = 20;

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
  const [mixes, setMixes] = useState<MixInfo[] | null>(null);
  const [mixesChannelName, setMixesChannelName] = useState("");
  const [mixesMeta, setMixesMeta] = useState<{
    scanned_at?: number;
    from_cache?: boolean;
  } | null>(null);
  const [mixScanning, setMixScanning] = useState<string | null>(null);
  const [mixVideosScanning, setMixVideosScanning] = useState<string | null>(null);
  const [videoPage, setVideoPage] = useState(0);
  const [workerHist, setWorkerHist] = useState<WorkerChannel[]>([]);
  const [workerLoading, setWorkerLoading] = useState(false);
  const [workerLastRun, setWorkerLastRun] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [presets, setPresets] = useState<PipelinePreset[]>([]);
  const [batchPresetId, setBatchPresetId] = useState("");
  const [crossOpen, setCrossOpen] = useState(false);
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

  const loadWorkerHist = useCallback(async () => {
    setWorkerLoading(true);
    try {
      const res = await fetch("http://localhost:8000/api/channel-watch");
      const data = await res.json();
      setWorkerHist(Array.isArray(data.channels) ? data.channels : []);
      setWorkerLastRun(data.last_run ?? null);
    } catch {
      // backend chưa chạy — bỏ qua
    } finally {
      setWorkerLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkerHist();
  }, [loadWorkerHist]);

  useEffect(() => {
    getPipelinePresets()
      .then((r) => {
        setPresets(r.presets || []);
        if (r.presets?.length) setBatchPresetId(r.presets[0].id);
      })
      .catch(() => setPresets([]));
  }, []);

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

  const handleScan = async (ch: Channel, full = false) => {
    setScanning(full ? `full-${ch.id}` : ch.id);
    setScanResult(null);
    setSelected(new Set());
    setVideoPage(0);
    setScanError(null);
    try {
      // Ngày riêng của kênh ưu tiên hơn ngày chung. Incremental mặc định:
      // server chỉ tải mới hơn video mới nhất đã lưu; full=true quét lại.
      const dateStr = ch.since_date || scanDate;
      const sinceTs = dateStr
        ? Math.floor(new Date(dateStr + "T00:00:00").getTime() / 1000)
        : 0;
      const res = await fetch("/api/channels/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: ch.url, since: sinceTs, full }),
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

  /** Phase 1 full scan: list the channel's collections only (no date filter). */
  const handleMixScan = async (ch: Channel) => {
    setMixScanning(ch.id);
    setMixes(null);
    setMixesChannelName("");
    setMixesMeta(null);
    setScanError(null);
    try {
      const res = await fetch("/api/channels/mixes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: ch.url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScanError(data.detail || t("channel.scanError"));
        return;
      }
      setMixes(Array.isArray(data.playlists) ? data.playlists : []);
      setMixesChannelName(data.channel_name || ch.name);
      setMixesMeta({
        scanned_at: data.scanned_at,
        from_cache: data.from_cache,
      });
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    } finally {
      setMixScanning(null);
    }
  };

  /** Card click: show cached videos instantly; live-scan only when the
   *  collection was never scanned. The Cập nhật/↻ buttons always scan. */
  const handleMixCardClick = async (mix: MixInfo) => {
    if (mixVideosScanning !== null) return;
    setScanError(null);
    try {
      const res = await fetch(
        `/api/channels/cached?mix_id=${encodeURIComponent(mix.id)}`,
      );
      const data = await res.json();
      const videos: AwemeVideo[] = Array.isArray(data?.mix_scan?.videos)
        ? data.mix_scan.videos
        : [];
      if (videos.length === 0) {
        await handleMixVideos(mix);
        return;
      }
      setScanResult({
        channel_name: mix.title,
        total: videos.length,
        filtered: videos.length,
        videos,
        playlists: [{ id: mix.id, title: mix.title, videos }],
        cached: videos.length,
        added: 0,
        scanned_at: data?.mix_scan?.scanned_at,
        from_cache: true,
      });
      setSelected(new Set());
      setVideoPage(0);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    }
  };

  /** Phase 2 full scan: fetch all videos inside one collection, then reuse
   *  the standard results table + batch UI below. Incremental default. */
  const handleMixVideos = async (mix: MixInfo, full = false) => {
    if (mixVideosScanning !== null) return;
    setMixVideosScanning(full ? `full-${mix.id}` : mix.id);
    setScanError(null);
    try {
      const res = await fetch("/api/channels/mix-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mix_id: mix.id, full }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScanError(data.detail || t("channel.scanError"));
        return;
      }
      const videos: AwemeVideo[] = Array.isArray(data.videos) ? data.videos : [];
      setScanResult({
        channel_name: data.playlist_title || mix.title,
        total: data.total ?? videos.length,
        filtered: videos.length,
        videos,
        playlists: [{ id: mix.id, title: mix.title, videos }],
      });
      setSelected(new Set());
      setVideoPage(0);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    } finally {
      setMixVideosScanning(null);
    }
  };

  /** Load previously scanned data from the server cache (no browser).
   *  Clicking a channel name restores its last videos + playlists. */
  const handleLoadCached = async (ch: Channel) => {
    setScanError(null);
    try {
      const res = await fetch(
        `/api/channels/cached?url=${encodeURIComponent(ch.url)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setScanError(data.detail || t("channel.scanError"));
        return;
      }
      const videos: AwemeVideo[] = Array.isArray(data?.scan?.videos)
        ? data.scan.videos
        : [];
      const mixes: MixInfo[] = Array.isArray(data?.mixes?.playlists)
        ? data.mixes.playlists
        : [];
      if (videos.length === 0 && mixes.length === 0) {
        setScanError(t("channel.noCache"));
        return;
      }
      // Rebuild playlist groups from embedded mix_info tags (best-effort).
      type Tagged = AwemeVideo & {
        mix_info?: { mix_id?: string; mix_name?: string };
      };
      const groups = new Map<string, PlaylistGroup>();
      for (const v of videos) {
        const tag = (v as Tagged).mix_info;
        const mid = tag?.mix_id ? String(tag.mix_id) : "";
        if (!mid) continue;
        if (!groups.has(mid)) {
          groups.set(mid, { id: mid, title: tag?.mix_name || mid, videos: [] });
        }
        groups.get(mid)!.videos.push(v);
      }
      if (videos.length > 0) {
        setScanResult({
          channel_name: ch.name,
          total: videos.length,
          filtered: videos.length,
          videos,
          playlists: Array.from(groups.values()),
          cached: videos.length,
          added: 0,
          scanned_at: data?.scan?.scanned_at,
          from_cache: true,
        });
      }
      if (mixes.length > 0) {
        setMixes(mixes);
        setMixesChannelName(ch.name);
        setMixesMeta({
          scanned_at: data?.mixes?.scanned_at,
          from_cache: true,
        });
      }
      setSelected(new Set());
      setVideoPage(0);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    }
  };

  const shareTextOf = (v: AwemeVideo): string =>
    v.share_link_desc ||
    v.share_url ||
    `https://www.douyin.com/video/${v.aweme_id}`;

  const playlistIdOf = (awemeId: string): string | null => {
    if (!scanResult) return null;
    for (const pl of scanResult.playlists || []) {
      if (pl.videos.some((x) => x.aweme_id === awemeId)) return pl.id;
    }
    return null;
  };

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const enqueueWithPreset = (url: string, cfg: Record<string, unknown>) => {
    const addPipeline = usePipelineStore.getState().addPipeline;
    addPipeline(
      url,
      (cfg.regionMode as "manual" | "auto") ?? "manual",
      {
        engine: (cfg.dubEngine as "google" | "capcut") ?? "capcut",
        voice: (cfg.dubVoice as string) ?? "BV421_vivn_streaming",
        muteOriginal: (cfg.muteOriginal as boolean) ?? false,
        originalGainDb: (cfg.originalGainDb as number) ?? 12,
        multiVoice: (cfg.multiVoice as boolean) ?? false,
        keepOriginalEnabled: (cfg.keepOriginalEnabled as boolean) ?? false,
      },
      (cfg.autoFitSubs as boolean) ?? false,
      (cfg.watermarkOn as boolean) ?? false,
      ((cfg.watermarkOn ? cfg.watermarkPreset : "") as string) ?? "",
      (cfg.removeWatermarkEnabled as boolean) ?? false,
      (cfg.removeWatermarkRegions as never[]) ?? [],
      (cfg.region as null) ?? null,
      (cfg.subtitleStyle as null) ?? null,
      (cfg.checkSubs as boolean) ?? false,
      (cfg.checkVoice as boolean) ?? false,
      (cfg.autoUploadYoutube as boolean) ?? false,
      (cfg.youtubeChannel as string) ?? "",
      (cfg.youtubePlaylist as string) ?? "",
      (cfg.useFalThumbnail as boolean) ?? false,
      (cfg.useGptThumbnail as boolean) ?? false,
      (cfg.srcLang as string) ?? "zh",
      (cfg.translateOn as boolean) ?? true,
      (cfg.translateTarget as string) ?? "vi",
      (cfg.dubOn as boolean) ?? true,
      (cfg.voiceLang as string) ?? "",
      (cfg.colorFilter as null) ?? null,
      (cfg.playbackSpeed as number) ?? 1.0,
      (cfg.useGeminiThumbnail as boolean) ?? false,
      (cfg.fillGaps as boolean) ?? false,
    );
  };

  const handleBatchRequest = () => {
    if (!scanResult || selected.size === 0) return;
    const ids = scanResult.videos
      .filter((v) => selected.has(v.aweme_id))
      .map((v) => v.aweme_id);
    const groups = new Set(ids.map((id) => playlistIdOf(id) ?? "__none"));
    if (groups.size > 1) {
      setPendingIds(ids);
      setCrossOpen(true);
      return;
    }
    setPendingIds(ids);
    void handleBatchExecute(true, ids);
  };

  const handleBatchExecute = (shared: boolean, ids: string[] = pendingIds) => {
    setCrossOpen(false);
    if (!scanResult || ids.length === 0) return;
    const byId = new Map(scanResult.videos.map((v) => [v.aweme_id, v]));
    const existingUrls = new Set(
      usePipelineStore.getState().pipelines.map((p) => p.url),
    );
    const preset = presets.find((p) => p.id === batchPresetId);
    const sharedCfg =
      shared && preset ? (preset.config as Record<string, unknown>) : null;
    let pushed = 0;
    let skipped = 0;
    for (const id of ids) {
      const v = byId.get(id);
      if (!v) continue;
      const url = shareTextOf(v);
      if (existingUrls.has(url)) {
        skipped += 1;
        continue;
      }
      existingUrls.add(url);
      if (sharedCfg) {
        enqueueWithPreset(url, sharedCfg);
      } else {
        usePipelineStore.getState().addPipeline(url, "manual");
      }
      pushed += 1;
    }
    setPendingIds([]);
    setSelected(new Set());
    if (skipped > 0) alert(t("channel.skippedDupes", { count: skipped }));
    if (pushed > 0) router.push("/auto");
  };

  const crossCount = new Set(pendingIds.map(playlistIdOf)).size;

  // Local pagination for the results table (selection stays global).
  const pageCount = scanResult
    ? Math.max(1, Math.ceil(scanResult.videos.length / RESULTS_PAGE_SIZE))
    : 1;
  const safePage = Math.min(videoPage, pageCount - 1);
  const pageVideos = scanResult
    ? scanResult.videos.slice(
        safePage * RESULTS_PAGE_SIZE,
        (safePage + 1) * RESULTS_PAGE_SIZE,
      )
    : [];

  return (
    <div>
      <PageHeader title={t("channel.title")} description={t("channel.desc")} />

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
                className="input-field flex-1 min-w-0 font-mono"
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
                  className="input-field font-mono cursor-pointer"
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
                          ? "bg-warn-muted ring-1 ring-warn/25"
                          : "bg-white/[0.03] ring-1 ring-white/[0.07] hover:bg-white/[0.05]"
                      }`}
                    >
                      <button
                        onClick={() => togglePin(ch.id)}
                        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors ${
                          isPinned
                            ? "text-warn hover:text-warn"
                            : "text-ink-light hover:text-warn hover:bg-warn-muted"
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
                            className="w-10 h-10 rounded-full object-cover flex-shrink-0 bg-white/[0.06]"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-ink-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                              <circle cx="12" cy="7" r="4" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0">
                          <button
                            onClick={() => handleLoadCached(ch)}
                            title={t("channel.loadCached")}
                            className="text-[13px] font-medium text-ink truncate hover:text-accent transition-colors cursor-pointer"
                          >
                            {ch.name}
                          </button>
                          <p className="text-[11px] text-ink-light font-mono truncate">
                            {ch.url}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleScan(ch)}
                        disabled={scanning !== null}
                        title={t("channel.scanTip")}
                        className="px-4 py-2 rounded-full text-[12px] font-medium bg-accent text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 flex-shrink-0 cursor-pointer"
                      >
                        {scanning === ch.id || scanning === `full-${ch.id}` ? (
                          <>
                            <IconSpinner className="w-3.5 h-3.5" />
                            {t("channel.scanning")}
                          </>
                        ) : (
                          t("channel.scan")
                        )}
                      </button>
                      <button
                        onClick={() => handleScan(ch, true)}
                        disabled={scanning !== null}
                        title={t("channel.fullScanTip")}
                        className="w-8 h-8 rounded-full bg-white/[0.06] ring-1 ring-white/[0.09] text-ink-muted hover:text-ink hover:bg-white/[0.1] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 cursor-pointer"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 12a9 9 0 11-2.64-6.36" />
                          <polyline points="21 3 21 9 15 9" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleMixScan(ch)}
                        disabled={scanning !== null || mixScanning !== null}
                        title={t("channel.playlistsTip")}
                        className="px-4 py-2 rounded-full text-[12px] font-medium bg-white/[0.06] ring-1 ring-white/[0.09] text-ink hover:bg-white/[0.1] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 flex-shrink-0 cursor-pointer"
                      >
                        {mixScanning === ch.id ? (
                          <>
                            <IconSpinner className="w-3.5 h-3.5" />
                            {t("channel.scanning")}
                          </>
                        ) : (
                          t("channel.playlistsBtn")
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(ch.id)}
                        disabled={scanning === ch.id}
                        className="icon-btn-ghost text-danger disabled:opacity-40 cursor-pointer"
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

      {mixes && (
        <AnimatedBlock delay={0}>
          <div className="double-bezel mb-6">
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {t("channel.fullscanTitle")}
                  </p>
                  {mixesChannelName && (
                    <p className="text-[13px] text-ink mt-1">
                      {mixesChannelName}
                    </p>
                  )}
                  {mixesMeta?.scanned_at != null && (
                    <p className="text-[11px] text-ink-light mt-1 font-mono">
                      {t("channel.scannedAt", { time: fmtDate(mixesMeta.scanned_at) })}
                      {mixesMeta.from_cache ? ` (${t("channel.fromCache")})` : ""}
                    </p>
                  )}
                </div>
                <span className="tag">
                  {t("channel.videoCount", { count: mixes.length })}
                </span>
              </div>
              {mixes.length === 0 ? (
                <p className="text-[13px] text-ink-light py-6 text-center">
                  {t("channel.noMixes")}
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {mixes.map((m) => (
                    <div
                      key={m.id}
                      onClick={() => handleMixCardClick(m)}
                      title={t("channel.loadCached")}
                      className="rounded-xl ring-1 ring-white/[0.07] bg-white/[0.02] hover:bg-white/[0.05] hover:ring-white/[0.14] transition-colors p-3 flex items-center gap-3 cursor-pointer"
                    >
                      {m.cover ? (
                        <img
                          src={m.cover}
                          alt=""
                          className="w-12 h-16 object-cover rounded-lg flex-shrink-0 bg-white/[0.06]"
                        />
                      ) : (
                        <div className="w-12 h-16 rounded-lg bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                          <svg className="w-5 h-5 text-ink-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" rx="1" />
                            <rect x="14" y="3" width="7" height="7" rx="1" />
                            <rect x="3" y="14" width="7" height="7" rx="1" />
                            <rect x="14" y="14" width="7" height="7" rx="1" />
                          </svg>
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-ink line-clamp-2 leading-snug">
                          {truncateText(m.title || m.id, 60)}
                        </p>
                        <p className="text-[11px] text-ink-light mt-1 font-mono">
                          {m.video_count != null
                            ? t("channel.videoCount", { count: m.video_count })
                            : `#${m.id}`}
                        </p>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMixVideos(m);
                        }}
                        disabled={mixVideosScanning !== null}
                        title={t("channel.scanVideosTip")}
                        className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-accent text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0 cursor-pointer"
                      >
                        {mixVideosScanning === m.id ||
                        mixVideosScanning === `full-${m.id}` ? (
                          <IconSpinner className="w-3 h-3" />
                        ) : null}
                        {t("channel.scanVideos")}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMixVideos(m, true);
                        }}
                        disabled={mixVideosScanning !== null}
                        title={t("channel.fullScanTip")}
                        className="w-7 h-7 rounded-full text-ink-light hover:text-ink hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 cursor-pointer"
                      >
                        <svg
                          className="w-3 h-3"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 12a9 9 0 11-2.64-6.36" />
                          <polyline points="21 3 21 9 15 9" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </AnimatedBlock>
      )}

      {mixVideosScanning !== null && (
        <AnimatedBlock delay={0}>
          <div className="double-bezel mb-6">
            <div className="double-bezel-inner p-5 sm:p-6 flex items-center gap-3">
              <IconSpinner className="w-4 h-4 text-accent" />
              <p className="text-[13px] text-ink-muted">
                {t("channel.scanning")} {t("channel.fullscanTitle")}...
              </p>
            </div>
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
                  {(scanResult.cached != null ||
                    scanResult.scanned_at != null) && (
                    <p className="text-[11px] text-ink-light mt-1 font-mono">
                      {t("channel.cacheStatus", {
                        cached: scanResult.cached ?? 0,
                        added: scanResult.added ?? 0,
                      })}
                      {scanResult.scanned_at
                        ? ` · ${t("channel.scannedAt", { time: fmtDate(scanResult.scanned_at) })}`
                        : ""}
                      {scanResult.from_cache ? ` (${t("channel.fromCache")})` : ""}
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
                      <tr className="border-b border-white/[0.07]">
                        <th className="pb-3 w-10">
                          <Checkbox
                            checked={
                              scanResult &&
                              scanResult.videos.length > 0 &&
                              selected.size === scanResult.videos.length
                                ? true
                                : selected.size > 0
                                  ? "indeterminate"
                                  : false
                            }
                            onCheckedChange={(c) =>
                              toggleMany(
                                scanResult?.videos.map((v) => v.aweme_id) || [],
                                c === true,
                              )
                            }
                            aria-label={t("channel.selectAll")}
                          />
                        </th>
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
                      {pageVideos.map((v, idx) => {
                        const shareText = shareTextOf(v);
                        const isCopied = copiedId === v.aweme_id;
                        return (
                          <tr
                            key={v.aweme_id}
                            className="border-b border-white/[0.05] hover:bg-white/[0.03] transition-colors"
                          >
                            <td className="py-4">
                              <Checkbox
                                checked={selected.has(v.aweme_id)}
                                onCheckedChange={() => toggleOne(v.aweme_id)}
                                aria-label={v.aweme_id}
                              />
                            </td>
                            <td className="py-4 text-[13px] text-ink-light font-mono">
                              {safePage * RESULTS_PAGE_SIZE + idx + 1}
                            </td>
                            <td className="py-4">
                              <div className="flex items-start gap-4">
                                {v.video?.cover?.url_list?.[0] && (
                                  <img
                                    src={v.video.cover.url_list[0]}
                                    alt=""
                                    width={200}
                                    className=" h-30 object-cover rounded-lg flex-shrink-0 bg-white/[0.06]"
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
                                  className="icon-btn-ghost text-success cursor-pointer"
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
                                className="icon-btn-ghost text-accent-light"
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
              {scanResult.videos.length > RESULTS_PAGE_SIZE && (
                <div className="mt-4 flex items-center justify-center gap-3">
                  <button
                    onClick={() => setVideoPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="px-4 py-1.5 rounded-full text-[12px] font-medium bg-white/[0.06] ring-1 ring-white/[0.09] text-ink hover:bg-white/[0.1] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {t("channel.prevPage")}
                  </button>
                  <span className="text-[12px] text-ink-muted font-mono">
                    {t("channel.pageOf", { page: safePage + 1, pages: pageCount })}
                  </span>
                  <button
                    onClick={() =>
                      setVideoPage((p) => Math.min(pageCount - 1, p + 1))
                    }
                    disabled={safePage >= pageCount - 1}
                    className="px-4 py-1.5 rounded-full text-[12px] font-medium bg-white/[0.06] ring-1 ring-white/[0.09] text-ink hover:bg-white/[0.1] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {t("channel.nextPage")}
                  </button>
                </div>
              )}
              {(scanResult.playlists || []).map((pl) => {
                const ids = pl.videos.map((x) => x.aweme_id);
                const n = ids.filter((id) => selected.has(id)).length;
                return (
                  <details
                    key={pl.id}
                    className="mt-3 rounded-xl ring-1 ring-white/[0.07] bg-white/[0.02]"
                  >
                    <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none">
                      <span onClick={(e) => e.preventDefault()}>
                        <Checkbox
                          checked={
                            n === ids.length && ids.length > 0
                              ? true
                              : n > 0
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(c) => toggleMany(ids, c === true)}
                          aria-label={pl.title}
                        />
                      </span>
                      <span className="text-[13px] font-medium text-ink truncate">
                        {pl.title}
                      </span>
                      <span className="tag">
                        {n}/{ids.length}
                      </span>
                    </summary>
                    <div className="px-4 pb-3 space-y-1.5">
                      {pl.videos.map((x) => (
                        <label
                          key={x.aweme_id}
                          className="flex items-center gap-2.5 cursor-pointer"
                        >
                          <Checkbox
                            checked={selected.has(x.aweme_id)}
                            onCheckedChange={() => toggleOne(x.aweme_id)}
                          />
                          <span className="text-[12px] text-ink truncate">
                            {truncateText(x.desc || t("channel.noTitle"), 60)}
                          </span>
                          <span className="text-[11px] text-ink-light font-mono ml-auto">
                            {fmtDate(x.create_time)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        </AnimatedBlock>
      )}

      {/* Lịch sử quét của worker nền — card riêng bên dưới */}
      <AnimatedBlock delay={50}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  Lịch sử quét worker
                </p>
                {workerLastRun ? (
                  <p className="text-[11px] text-ink-light mt-1 font-mono">
                    Quét gần nhất: {new Date(workerLastRun * 1000).toLocaleString()}
                  </p>
                ) : null}
              </div>
              <button
                onClick={loadWorkerHist}
                disabled={workerLoading}
                className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-50"
              >
                {workerLoading ? "Đang tải..." : "Tải lại"}
              </button>
            </div>
            {workerHist.length === 0 ? (
              <p className="text-[13px] text-ink-light py-4 text-center">
                Worker chưa quét được kênh nào. Bật worker ở Settings → Theo dõi kênh Douyin.
              </p>
            ) : (
              <div className="space-y-4">
                {workerHist.map((ch) => (
                  <div
                    key={ch.id}
                    className="rounded-xl ring-1 ring-white/[0.07] bg-white/[0.02] p-3"
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <p className="text-[13px] font-medium text-ink">
                        {ch.name || ch.url}
                      </p>
                      <span className="tag">{ch.video_count} video</span>
                      {ch.scanned_at > 0 && (
                        <span className="text-[11px] font-mono text-ink-light">
                          quét {new Date(ch.scanned_at * 1000).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {ch.videos.length === 0 ? (
                      <p className="text-[11px] text-ink-light">
                        {t("channel.noResults")}
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {ch.videos.map((v) => (
                          <div key={v.aweme_id} className="flex items-center gap-2.5">
                            {v.cover && (
                              <img
                                src={v.cover}
                                alt=""
                                className="w-10 h-14 object-cover rounded-md flex-shrink-0 bg-white/[0.06]"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-[12px] text-ink truncate">
                                {truncateText(v.desc || t("channel.noTitle"), 60)}
                              </p>
                              <p className="text-[11px] text-ink-light font-mono">
                                {fmtDate(v.create_time)}
                                {v.digg_count != null && ` · ♥ ${fmtNumber(v.digg_count)}`}
                              </p>
                            </div>
                            {v.share_url && (
                              <Link
                                href={`/auto?url=${encodeURIComponent(v.share_url)}`}
                                className="icon-btn-ghost text-accent-light flex-shrink-0"
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
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-30 double-bezel">
          <div className="double-bezel-inner px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="tag bg-accent-muted text-accent ring-accent/15">
              {t("channel.selectedCount", { count: selected.size })}
            </span>
            <label className="text-[12px] text-ink-muted">
              {t("channel.presetLabel")}
            </label>
            <select
              value={batchPresetId}
              onChange={(e) => setBatchPresetId(e.target.value)}
              className="input-field text-[12px] !py-1.5"
              disabled={presets.length === 0}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {presets.length === 0 && (
              <span className="text-[11px] text-warn">
                {t("channel.noPreset")}
              </span>
            )}
            <button
              onClick={() => void handleBatchRequest()}
              disabled={presets.length === 0}
              className="btn-island-primary text-sm !px-5 !py-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("channel.pushToPipeline")}
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="btn-island-secondary text-[12px]"
            >
              {t("channel.clearSelection")}
            </button>
          </div>
        </div>
      )}

      {crossOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setCrossOpen(false)}
        >
          <div
            className="double-bezel w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="double-bezel-inner p-5">
              <p className="text-[14px] font-semibold text-ink">
                {t("channel.crossTitle", { count: crossCount })}
              </p>
              <p className="text-[13px] text-ink-muted mt-1">
                {t("channel.crossDesc")}
              </p>
              <div className="mt-4 flex gap-2 justify-end">
                <button
                  onClick={() => void handleBatchExecute(false)}
                  className="btn-island-secondary text-[12px]"
                >
                  {t("channel.setSeparate")}
                </button>
                <button
                  onClick={() => void handleBatchExecute(true)}
                  className="btn-island-primary text-[12px]"
                >
                  {t("channel.useShared")}
                </button>
              </div>
            </div>
          </div>
        </div>
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
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-surface ring-1 ring-white/10 shadow-lg flex items-center justify-center text-ink-muted hover:text-ink cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
