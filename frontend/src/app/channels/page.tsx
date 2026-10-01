"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
    origin_cover?: { url_list?: string[] };
    dynamic_cover?: { url_list?: string[] };
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

/** Douyin CDN URLs are signed (x-expires). Cached scans outlive them, so
 *  prefer a still-valid cover instead of showing an expired (broken) one. */
function coverAlive(u: string | undefined): boolean {
  if (!u) return false;
  const m = u.match(/[?&]x-expires=(\d+)/);
  if (!m) return true;
  return Number(m[1]) * 1000 > Date.now();
}

function videoCoverOf(v: AwemeVideo): string {
  const lists = [
    v.video?.cover?.url_list,
    v.video?.origin_cover?.url_list,
    v.video?.dynamic_cover?.url_list,
  ];
  for (const l of lists) {
    const u = (l || []).find(coverAlive);
    if (u) return u;
  }
  for (const l of lists) {
    if (l && l[0]) return l[0];
  }
  return "";
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
  const [mixesChannelUrl, setMixesChannelUrl] = useState("");
  const [mixScanning, setMixScanning] = useState<string | null>(null);
  const [mixVideosScanning, setMixVideosScanning] = useState<string | null>(null);
  const [videoPage, setVideoPage] = useState(0);
  /** Active playlist filter for the videos table: "all" | mix id. */
  const [activePlaylist, setActivePlaylist] = useState<string>("all");
  /** Known channel-level video count (for the Tác phẩm card). */
  const [tacPhamCount, setTacPhamCount] = useState<number | null>(null);
  /** What the results table shows: whole channel vs one collection. */
  const [scanLevel, setScanLevel] = useState<"channel" | "mix">("channel");
  /** Progress line for full channel rescans (per-playlist loop). */
  const [fullScanStatus, setFullScanStatus] = useState<string | null>(null);
  /** Monotonic scan request id — stale responses never overwrite newer UI. */
  const scanSeq = useRef(0);
  const [workerHist, setWorkerHist] = useState<WorkerChannel[]>([]);
  const [workerLoading, setWorkerLoading] = useState(false);
  const [workerLastRun, setWorkerLastRun] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [presets, setPresets] = useState<PipelinePreset[]>([]);
  const [batchPresetId, setBatchPresetId] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<"none" | "before" | "after">(
    "none",
  );
  const [merging, setMerging] = useState(false);
  /** Merge-before entry being watched: stay + show live progress, auto-enter
   *  /auto when the merged video is ready (or failed to inspect). */
  const [mergingId, setMergingId] = useState<string | null>(null);
  const mergeGoneRef = useRef(false);
  const mergeEntry = usePipelineStore((s) =>
    mergingId ? (s.pipelines.find((p) => p.id === mergingId) ?? null) : null,
  );

  useEffect(() => {
    mergeGoneRef.current = false;
    return () => {
      mergeGoneRef.current = true;
    };
  }, []);

  // Auto-enter /auto when the merge finishes (or fails to inspect).
  useEffect(() => {
    if (!mergingId || !mergeEntry || mergeGoneRef.current) return;
    const ready =
      mergeEntry.videoId && !["resolving", "merging"].includes(mergeEntry.stage);
    if (!ready && mergeEntry.status !== "error") return;
    const t = setTimeout(
      () => {
        if (!mergeGoneRef.current) {
          setMergingId(null);
          router.push("/auto");
        }
      },
      ready ? 1500 : 0,
    );
    return () => clearTimeout(t);
  }, [mergingId, mergeEntry, router]);
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
    const seq = ++scanSeq.current;
    setScanning(full ? `full-${ch.id}` : ch.id);
    setScanResult(null);
    setSelected(new Set());
    setVideoPage(0);
    setActivePlaylist("all");
    // Cross-clear: video scan replaces the playlists panel too.
    setMixes(null);
    setMixesChannelName("");
    setMixesChannelUrl("");
    setMixesMeta(null);
    setScanError(null);
    setFullScanStatus(null);
    setTacPhamCount(null);
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
        // Full = quét tất cả, bỏ filter ngày; thường = tôn trọng ngày đã chọn.
        body: JSON.stringify({ url: ch.url, since: full ? 0 : sinceTs, full }),
      });
      const data = await res.json();
      if (seq !== scanSeq.current) return; // stale — newer scan started
      if (!res.ok) {
        setScanError(data.detail || t("channel.scanError"));
        return;
      }
      setScanResult(data);
      setScanLevel("channel");
      setTacPhamCount(
        Array.isArray(data.videos) ? data.videos.length : null,
      );
      // The channel scan now also refreshes playlists (same seq; silent if
      // it fails — videos are already shown).
      const { detail: mixDetail, playlists } = await fetchMixesFor(ch, seq);
      if (seq !== scanSeq.current) return; // stale
      if (mixDetail) {
        if (full) setScanError(mixDetail);
      } else if (full && playlists.length > 0) {
        // True full scan: fetch every playlist's videos too, then refresh
        // the table so the union (date videos + all collections) shows.
        await scanAllMixVideos(ch, playlists, seq);
        if (seq !== scanSeq.current) return; // stale
        await refreshChannelTable(ch, seq);
      }
    } catch (e) {
      if (seq !== scanSeq.current) return;
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    } finally {
      if (seq === scanSeq.current) setScanning(null);
    }
  };

  /** Shared mixes fetch core (no clears, no spinner). Returns server detail
   *  on failure + playlists on success; callers decide error display. */
  const fetchMixesFor = async (
    ch: Channel,
    seq: number,
  ): Promise<{ detail: string | null; playlists: MixInfo[] }> => {
    try {
      const res = await fetch("/api/channels/mixes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: ch.url }),
      });
      const data = await res.json();
      if (seq !== scanSeq.current)
        return { detail: null, playlists: [] }; // stale
      if (!res.ok)
        return {
          detail: data.detail || t("channel.scanError"),
          playlists: [],
        };
      setMixes(Array.isArray(data.playlists) ? data.playlists : []);
      setMixesChannelName(data.channel_name || ch.name);
      setMixesChannelUrl(ch.url);
      // Tác phẩm count: instant read from the channel cache (no browser).
      fetch(`/api/channels/cached?url=${encodeURIComponent(ch.url)}`)
        .then((r) => r.json())
        .then((d) => {
          const n = Array.isArray(d?.scan?.videos)
            ? d.scan.videos.length
            : null;
          setTacPhamCount(n);
        })
        .catch(() => {});
      setMixesMeta({
        scanned_at: data.scanned_at,
        from_cache: data.from_cache,
      });
      return { detail: null, playlists: data.playlists };
    } catch {
      return { detail: t("channel.scanError"), playlists: [] };
    }
  };

  /** Phase 1 full scan: list the channel's collections only (no date filter). */
  const handleMixScan = async (ch: Channel) => {
    const seq = ++scanSeq.current;
    setMixScanning(ch.id);
    setMixes(null);
    setMixesChannelName("");
    setMixesChannelUrl("");
    setMixesMeta(null);
    // Cross-clear: playlist scan replaces the videos panel too.
    setScanResult(null);
    setSelected(new Set());
    setVideoPage(0);
    setActivePlaylist("all");
    setScanError(null);
    try {
      const { detail } = await fetchMixesFor(ch, seq);
      if (detail && seq === scanSeq.current) {
        setScanError(detail);
      }
    } catch (e) {
      if (seq !== scanSeq.current) return;
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    } finally {
      if (seq === scanSeq.current) setMixScanning(null);
    }
  };

  /** Full-rescan tail: fetch every playlist's videos sequentially with
   *  progress, then refresh the table. Incremental per playlist (first time
   *  is automatically a full walk). */
  const scanAllMixVideos = async (
    ch: Channel,
    playlists: MixInfo[],
    seq: number,
  ) => {
    for (let i = 0; i < playlists.length; i++) {
      if (seq !== scanSeq.current) return; // stale
      const m = playlists[i];
      setFullScanStatus(
        t("channel.fullScanning", { i: i + 1, n: playlists.length, name: m.title }),
      );
      try {
        const res = await fetch("/api/channels/mix-videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mix_id: m.id }),
        });
        await res.json();
      } catch {
        // per-playlist failure noted in count, loop continues
      }
    }
    if (seq === scanSeq.current) setFullScanStatus(null);
  };

  /** Re-read the channel cache into the table (after a full loop). */
  const refreshChannelTable = async (ch: Channel, seq: number) => {
    try {
      const res = await fetch(
        `/api/channels/cached?url=${encodeURIComponent(ch.url)}`,
      );
      const data = await res.json();
      if (seq !== scanSeq.current) return; // stale
      const videos: AwemeVideo[] = Array.isArray(data?.scan?.videos)
        ? data.scan.videos
        : [];
      if (videos.length === 0) return; // keep current table
      presentChannelVideos(
        ch.name,
        videos,
        Array.isArray(data?.scan?.playlists) ? data.scan.playlists : [],
        {
          cached: videos.length,
          added: 0,
          scanned_at: data?.scan?.scanned_at,
          from_cache: true,
        },
      );
    } catch {
      // keep current table on failure
    }
  };

  /** Card click: show cached videos instantly; live-scan only when the
   *  collection was never scanned. The Cập nhật/↻ buttons always scan. */
  const handleMixCardClick = async (mix: MixInfo) => {
    if (mixVideosScanning !== null) return;
    const seq = ++scanSeq.current;
    setScanError(null);
    try {
      const res = await fetch(
        `/api/channels/cached?mix_id=${encodeURIComponent(mix.id)}`,
      );
      const data = await res.json();
      if (seq !== scanSeq.current) return; // stale
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
      setActivePlaylist(mix.id);
      setScanLevel("mix");
    } catch (e) {
      if (seq !== scanSeq.current) return;
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    }
  };

  /** Phase 2 full scan: fetch all videos inside one collection, then reuse
   *  the standard results table + batch UI below. Incremental default. */
  const handleMixVideos = async (mix: MixInfo, full = false) => {
    if (mixVideosScanning !== null) return;
    const seq = ++scanSeq.current;
    setMixVideosScanning(full ? `full-${mix.id}` : mix.id);
    setScanError(null);
    try {
      const res = await fetch("/api/channels/mix-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mix_id: mix.id, full }),
      });
      const data = await res.json();
      if (seq !== scanSeq.current) return; // stale — newer scan started
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
      setActivePlaylist(mix.id);
      setScanLevel("mix");
    } catch (e) {
      if (seq !== scanSeq.current) return;
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
    } finally {
      if (seq === scanSeq.current) setMixVideosScanning(null);
    }
  };

  /** Present channel-level videos: regroup (saved → tag fallback),
   *  show table at channel level. Shared by cache-load and full-refresh. */
  const presentChannelVideos = (
    title: string,
    videos: AwemeVideo[],
    savedGroups: { id: string; title: string; ids: string[] }[],
    meta: { cached?: number; added?: number; scanned_at?: number; from_cache?: boolean },
  ) => {
    type Tagged = AwemeVideo & {
      mix_info?: { mix_id?: string; mix_name?: string };
    };
    const byId = new Map(videos.map((v) => [v.aweme_id, v]));
    const groups = new Map<string, PlaylistGroup>();
    for (const g of savedGroups) {
      const members = (g.ids || [])
        .map((id) => byId.get(id))
        .filter((v): v is AwemeVideo => !!v);
      if (members.length > 0)
        groups.set(g.id, { id: g.id, title: g.title, videos: members });
    }
    if (groups.size === 0) {
      for (const v of videos) {
        const tag = (v as Tagged).mix_info;
        const mid = tag?.mix_id ? String(tag.mix_id) : "";
        if (!mid) continue;
        if (!groups.has(mid)) {
          groups.set(mid, { id: mid, title: tag?.mix_name || mid, videos: [] });
        }
        groups.get(mid)!.videos.push(v);
      }
    }
    setScanResult({
      channel_name: title,
      total: videos.length,
      filtered: videos.length,
      videos,
      playlists: Array.from(groups.values()),
      cached: meta.cached ?? videos.length,
      added: meta.added ?? 0,
      scanned_at: meta.scanned_at,
      from_cache: meta.from_cache,
    });
    setActivePlaylist("all");
    setScanLevel("channel");
    setSelected(new Set());
    setVideoPage(0);
  };

  /** Load previously scanned data from the server cache (no browser).
   *  Clicking a channel name restores its last videos + playlists. */
  const handleLoadCached = async (ch: Channel): Promise<boolean> => {
    const seq = ++scanSeq.current;
    setScanError(null);
    try {
      const res = await fetch(
        `/api/channels/cached?url=${encodeURIComponent(ch.url)}`,
      );
      const data = await res.json();
      if (seq !== scanSeq.current) return false; // stale
      if (!res.ok) {
        setScanError(data.detail || t("channel.scanError"));
        return false;
      }
      const videos: AwemeVideo[] = Array.isArray(data?.scan?.videos)
        ? data.scan.videos
        : [];
      const mixes: MixInfo[] = Array.isArray(data?.mixes?.playlists)
        ? data.mixes.playlists
        : [];
      if (videos.length === 0 && mixes.length === 0) {
        setScanError(t("channel.noCache"));
        return false;
      }
      const savedGroups: { id: string; title: string; ids: string[] }[] =
        Array.isArray(data?.scan?.playlists) ? data.scan.playlists : [];
      if (videos.length > 0) {
        presentChannelVideos(ch.name, videos, savedGroups, {
          cached: videos.length,
          added: 0,
          scanned_at: data?.scan?.scanned_at,
          from_cache: true,
        });
      } else {
        setScanResult(null);
      }
      // Always replace (even empty) so the previous channel's data never lingers.
      setMixes(mixes);
      setMixesChannelName(ch.name);
      setMixesChannelUrl(ch.url);
      setTacPhamCount(videos.length > 0 ? videos.length : null);
      setMixesMeta(
        mixes.length > 0 || videos.length > 0
          ? {
              scanned_at: data?.mixes?.scanned_at ?? data?.scan?.scanned_at,
              from_cache: true,
            }
          : null,
      );
      setActivePlaylist("all");
      setSelected(new Set());
      setVideoPage(0);
      return true;
    } catch (e) {
      if (seq !== scanSeq.current) return false;
      setScanError(e instanceof Error ? e.message : t("channel.scanError"));
      return false;
    }
  };

  /** Tác phẩm card (mirrors Douyin tab 1): show the channel's videos. */
  const handleTacPham = async () => {
    if (mixVideosScanning !== null) return;
    if (scanResult && scanLevel === "channel") {
      setActivePlaylist("all");
      setVideoPage(0);
      return;
    }
    const ch = channels.find((c) => c.url === mixesChannelUrl);
    if (!ch) return;
    await handleLoadCached(ch);
  };

  const shareTextOf = (v: AwemeVideo): string =>
    v.share_link_desc ||
    v.share_url ||
    `https://www.douyin.com/video/${v.aweme_id}`;

  /** Canonical per-video URL for pipeline runs. Share/short links
   *  (iesdouyin/v.douyin) expire or abort in headless Chrome — verified live:
   *  net::ERR_ABORTED on an old share link. The /video/{id} form never rots. */
  const pipelineUrlOf = (v: AwemeVideo): string =>
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
    return addPipeline(
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
    // Single video: push directly, no merge question. Multiple: ask first.
    if (ids.length < 2) {
      setPendingMode("none");
      setPendingIds(ids);
      void handleBatchExecute(true, ids);
      return;
    }
    setPendingMode("none");
    setMergeOpen(true);
  };

  /** Merge popup confirm: validate preset for merge modes, then continue to
   *  the cross-collection check / direct execute. */
  const confirmMergeMode = () => {
    if (!scanResult) return;
    const ids = scanResult.videos
      .filter((v) => selected.has(v.aweme_id))
      .map((v) => v.aweme_id);
    if (pendingMode !== "none" && !batchPresetId) {
      alert(t("channel.mergeNeedsPreset"));
      return;
    }
    setMergeOpen(false);
    const groups = new Set(ids.map((id) => playlistIdOf(id) ?? "__none"));
    // Cross-collection popup still opens and decides shared preset vs manual.
    if (groups.size > 1) {
      setPendingIds(ids);
      setCrossOpen(true);
      return;
    }
    setPendingIds(ids);
    void handleBatchExecute(true, ids);
  };

  /** Merge-before: resolve + concat server-side, then ONE pipeline on the
   *  merged video. Cross-collection popup decides shared preset (cfg) vs
   *  per-video-manual (null = defaults, still a single merged pipeline). */
  const handleMergeBefore = async (shared: boolean, ids: string[]) => {
    if (!scanResult) return;
    const byId = new Map(scanResult.videos.map((v) => [v.aweme_id, v]));
    const urls: string[] = [];
    for (const id of ids) {
      const v = byId.get(id);
      if (v) urls.push(pipelineUrlOf(v));
    }
    const preset = presets.find((p) => p.id === batchPresetId);
    const cfg =
      shared && preset ? (preset.config as Record<string, unknown>) : null;
    const baseName = scanResult.channel_name || t("channel.uncategorized");
    const label = `${baseName} (merge ${urls.length})`;
    setMerging(true);
    try {
      // Entry is created instantly; the merge runs in background and streams
      // logs into it. Stay here and watch — auto-enter when ready (effect).
      const pid = await usePipelineStore.getState().addMergedPipeline(urls, cfg, label);
      setMergingId(pid);
      setPendingIds([]);
      setSelected(new Set());
    } finally {
      setMerging(false);
    }
  };

  const handleBatchExecute = (shared: boolean, ids: string[] = pendingIds) => {
    setCrossOpen(false);
    if (!scanResult || ids.length === 0) return;
    if (pendingMode === "before") {
      void handleMergeBefore(shared, ids);
      return;
    }
    const byId = new Map(scanResult.videos.map((v) => [v.aweme_id, v]));
    const existingUrls = new Set(
      usePipelineStore.getState().pipelines.map((p) => p.url),
    );
    const preset = presets.find((p) => p.id === batchPresetId);
    const sharedCfg =
      shared && preset ? (preset.config as Record<string, unknown>) : null;
    // Merge-after: tag every pipeline with one batchId (Task 4 consumes).
    const batchId =
      pendingMode === "after"
        ? `batch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        : null;
    let pushed = 0;
    let skipped = 0;
    for (const id of ids) {
      const v = byId.get(id);
      if (!v) continue;
      const url = pipelineUrlOf(v);
      if (existingUrls.has(url)) {
        skipped += 1;
        continue;
      }
      existingUrls.add(url);
      let pid = "";
      if (sharedCfg) {
        pid = enqueueWithPreset(url, sharedCfg);
      } else {
        pid = usePipelineStore.getState().addPipeline(url, "manual");
      }
      if (batchId && pid) {
        usePipelineStore.getState().updatePipeline(pid, { batchId });
      }
      pushed += 1;
    }
    setPendingIds([]);
    setSelected(new Set());
    if (skipped > 0) alert(t("channel.skippedDupes", { count: skipped }));
    if (pushed > 0) router.push("/auto");
  };

  const crossCount = new Set(pendingIds.map(playlistIdOf)).size;
  const batchPresetName =
    presets.find((p) => p.id === batchPresetId)?.name ?? "";

  // Videos follow the active playlist card (or all channel videos).
  const displayedVideos =
    !scanResult || activePlaylist === "all"
      ? (scanResult?.videos || [])
      : (scanResult.playlists.find((p) => p.id === activePlaylist)?.videos || []);
  const pageCount = Math.max(
    1,
    Math.ceil(displayedVideos.length / RESULTS_PAGE_SIZE),
  );
  const safePage = Math.min(videoPage, pageCount - 1);
  const pageVideos = displayedVideos.slice(
    safePage * RESULTS_PAGE_SIZE,
    (safePage + 1) * RESULTS_PAGE_SIZE,
  );

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

      {fullScanStatus && (
        <AnimatedBlock delay={0}>
          <div className="mb-6 rounded-xl bg-accent-muted ring-1 ring-accent/20 px-4 py-3 flex items-center gap-2">
            <IconSpinner className="w-4 h-4 text-accent flex-shrink-0" />
            <p className="text-[13px] font-medium text-accent">{fullScanStatus}</p>
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
                  {t("channel.playlistsCount", { count: mixes.length })}
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
                      className={`rounded-xl ring-1 p-3 flex items-center gap-3 cursor-pointer transition-colors ${
                        activePlaylist === m.id
                          ? "ring-accent/60 bg-accent-muted"
                          : "ring-white/[0.07] bg-white/[0.02] hover:bg-white/[0.05] hover:ring-white/[0.14]"
                      }`}
                    >
                      {m.cover && coverAlive(m.cover) ? (
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
                  {/* Tác phẩm: mirrors Douyin tab 1 (all channel videos). */}
                  <div
                    onClick={() => handleTacPham()}
                    title={t("channel.works")}
                    className={`rounded-xl ring-1 p-3 flex items-center gap-3 cursor-pointer transition-colors ${
                      scanResult && scanLevel === "channel"
                        ? "ring-accent/60 bg-accent-muted"
                        : "ring-white/[0.12] bg-transparent hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="w-12 h-16 rounded-lg bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-ink-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="4" width="20" height="16" rx="2" />
                        <path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-ink line-clamp-2 leading-snug">
                        {t("channel.works")}
                      </p>
                      <p className="text-[11px] text-ink-light mt-1 font-mono">
                        {tacPhamCount != null
                          ? t("channel.videoCount", { count: tacPhamCount })
                          : t("channel.tapToLoad")}
                      </p>
                    </div>
                  </div>
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
                  <p className="text-[12px] text-accent mt-1 font-medium">
                    {activePlaylist === "all"
                      ? t("channel.filterAll")
                      : t("channel.filterBy", {
                          name:
                            scanResult.playlists.find(
                              (p) => p.id === activePlaylist,
                            )?.title || activePlaylist,
                        })}
                  </p>
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
                        const cover = videoCoverOf(v);
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
                                {cover && (
                                  <img
                                    src={cover}
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
                                href={`/auto?url=${encodeURIComponent(pipelineUrlOf(v))}`}
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
                                href={`/auto?url=${encodeURIComponent(`https://www.douyin.com/video/${v.aweme_id}`)}`}
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
            >
              <option value="">{t("channel.noPresetOpt")}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void handleBatchRequest()}
              disabled={merging}
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

      {mergeEntry && (
        <div className="sticky bottom-4 z-30 double-bezel mt-4">
          <div className="double-bezel-inner px-4 py-3">
            <div className="flex items-center gap-3 flex-wrap">
              {mergeEntry.status === "error" ? (
                <span className="text-[13px] font-medium text-danger">
                  {mergeEntry.error || t("channel.scanError")}
                </span>
              ) : (
                <>
                  <IconSpinner className="w-4 h-4 text-accent flex-shrink-0" />
                  <span className="text-[13px] font-medium text-ink truncate">
                    {mergeEntry.title} —{" "}
                    {mergeEntry.stage === "merging"
                      ? `${t("channel.merging")} ${mergeEntry.stepProgress?.[1] ?? 0}%`
                      : t("channel.scanning")}
                  </span>
                </>
              )}
              <button
                onClick={() => {
                  setMergingId(null);
                  router.push("/auto");
                }}
                className="btn-island-secondary text-[12px] ml-auto"
              >
                {t("channel.viewPipeline")}
              </button>
            </div>
            {mergeEntry.logs.length > 0 && (
              <p className="mt-2 text-[11px] font-mono text-ink-muted truncate">
                {mergeEntry.logs[mergeEntry.logs.length - 1].message}
              </p>
            )}
          </div>
        </div>
      )}

      {mergeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setMergeOpen(false)}
        >
          <div
            className="double-bezel w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="double-bezel-inner p-5">
              <p className="text-[14px] font-semibold text-ink">
                {t("channel.mergeTitle", { count: selected.size })}
              </p>
              <p className="text-[13px] text-ink-muted mt-1">
                {t("channel.mergeDesc")}
              </p>
              <div className="mt-4 space-y-2">
                {(
                  [
                    { v: "none", label: t("channel.mergeNone"), desc: t("channel.mergeNoneDesc") },
                    { v: "before", label: t("channel.mergeBefore"), desc: t("channel.mergeBeforeDesc") },
                    { v: "after", label: t("channel.mergeAfter"), desc: t("channel.mergeAfterDesc") },
                  ] as const
                ).map((o) => {
                  const needPreset = o.v !== "none" && !batchPresetId;
                  const active = pendingMode === o.v;
                  return (
                    <button
                      key={o.v}
                      disabled={needPreset}
                      onClick={() => setPendingMode(o.v)}
                      className={`w-full text-left rounded-xl px-4 py-3 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        active
                          ? "bg-accent/15 ring-1 ring-accent/40"
                          : "bg-white/[0.03] ring-1 ring-white/[0.08] hover:bg-white/[0.06]"
                      }`}
                    >
                      <span className="text-[13px] font-medium text-ink">
                        {o.label}
                      </span>
                      <span className="block text-[11px] text-ink-muted mt-0.5">
                        {needPreset ? t("channel.mergeNeedsPreset") : o.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-4 flex gap-2 justify-end">
                <button
                  onClick={() => setMergeOpen(false)}
                  className="btn-island-secondary text-[12px]"
                >
                  {t("preset.cancel")}
                </button>
                <button
                  onClick={confirmMergeMode}
                  className="btn-island-primary text-[12px]"
                >
                  {t("channel.confirmMerge")}
                </button>
              </div>
            </div>
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
                  {batchPresetName ? ` (${batchPresetName})` : ""}
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
