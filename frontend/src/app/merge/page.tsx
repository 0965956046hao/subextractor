"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatedBlock } from "@/lib/animation";
import PageHeader from "@/components/layout/PageHeader";
import { useI18n } from "@/lib/i18n";
import {
  listYoutubeChannels,
  listYoutubePlaylists,
  listYTMergeItems,
  listYTProjects,
  getYTProject,
  deleteYTProject,
  startYTMerge,
  getYTMergeStatus,
  cancelYTMerge,
  startYTPrepare,
  getYTPrepareStatus,
  cancelYTPrepare,
  uploadYTMergeFiles,
  deleteYTMergeUpload,
  uploadYTMergeThumbnail,
  pushYTMerged,
  getYoutubeUploadStatus,
  type YouTubeChannelInfo,
  type YouTubePlaylistInfo,
  type YTMergeItem,
  type YTPrepPart,
  type YTUploadItem,
  type YTProjectSummary,
} from "@/lib/api";

type OrderEntry = { videoId: string; order: number };

// Phiên làm việc tự lưu localStorage — reload trang sẽ khôi phục.
const SESSION_KEY = "ytmerge.session.v1";

interface MergeSession {
  channelId: string;
  playlistId: string;
  order: OrderEntry[];
  videos: YTMergeItem[];
  playlists: YouTubePlaylistInfo[];
  uploads: YTMergeItem[];
  metaJson: string;
  pushChannelId: string;
  pushPlaylistId: string;
  prepJobId: string | null;
  prepping: boolean;
  parts: YTPrepPart[];
  trims: Record<string, Trim>;
  thumbPath: string;
  thumbName: string;
  jobId: string | null;
  merging: boolean;
  mergeOutput: string | null;
  mergeSize: number;
  uploadJobId: string | null;
  uploading: boolean;
  uploadDone: boolean;
  savedAt: number;
}

/** Chuẩn hoá item upload thành YTMergeItem để tick/cắt chung luồng. */
function uploadToItem(u: YTUploadItem): YTMergeItem {
  return {
    video_id: u.video_id,
    title: u.title,
    position: -1,
    published_at: "",
    channel_title: "",
    thumbnail: "",
    duration: fmtDur(u.duration),
    description: "",
    tags: [],
    category_id: "",
  };
}

function IconSpinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function fmtBytes(n: number): string {
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

const DEFAULT_META_JSON = `{
  "title": "",
  "description": "",
  "tags": [],
  "hashtags": [],
  "privacyStatus": "private"
}`;

/** Parse nội dung meta.json do user nhập. */
function tryParseMeta(text: string): { ok: boolean; data?: Record<string, unknown>; error?: string } {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "JSON phải là 1 object." };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON không hợp lệ." };
  }
}

/** Điền title mặc định vào meta.json nếu đang trống (giữ nguyên format). */
function fillMetaTitle(text: string, title: string): string {
  const parsed = tryParseMeta(text);
  if (!parsed.ok || !parsed.data) return text;
  if (String(parsed.data.title || "").trim()) return text;
  return JSON.stringify({ ...parsed.data, title }, null, 2);
}

/** Giây → "1:23:45" / "12:34". */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

type Trim = { start: number; end: number };

/**
 * 1 dòng cắt video. Ô số dùng text state nội bộ (chỉ commit khi blur/Enter)
 * để gõ số không bị giật/reset giữa chừng; slider kéo trực tiếp.
 */
function TrimRow({
  part,
  index,
  trim,
  trimmedLabel,
  startLabel,
  endLabel,
  fullLabel,
  onCommit,
}: {
  part: YTPrepPart;
  index: number;
  trim: Trim;
  trimmedLabel: string;
  startLabel: string;
  endLabel: string;
  fullLabel: string;
  onCommit: (videoId: string, patch: Partial<Trim>) => void;
}) {
  const maxSec = Math.max(1, Math.round(part.duration));
  // null = đang theo props; chuỗi = user đang gõ dở.
  const [startText, setStartText] = useState<string | null>(null);
  const [endText, setEndText] = useState<string | null>(null);

  const commitStart = useCallback(
    (raw: string) => {
      const v = Number(raw);
      if (raw.trim() !== "" && Number.isFinite(v)) {
        onCommit(part.video_id, { start: Math.min(Math.max(0, v), part.duration) });
      }
      setStartText(null);
    },
    [onCommit, part.video_id, part.duration],
  );
  const commitEnd = useCallback(
    (raw: string) => {
      const v = Number(raw);
      if (raw.trim() !== "" && Number.isFinite(v)) {
        onCommit(part.video_id, { end: Math.min(Math.max(0, v), part.duration) });
      }
      setEndText(null);
    },
    [onCommit, part.video_id, part.duration],
  );

  const startShown = startText ?? String(Math.round(trim.start));
  const endShown = endText ?? String(Math.round(trim.end));

  return (
    <div className="flex items-center gap-3 p-2 rounded-xl bg-white/[0.03] ring-1 ring-white/[0.07] flex-wrap">
      <div className="w-7 h-7 rounded-lg bg-white/[0.06] text-ink-light flex items-center justify-center flex-shrink-0 text-[12px] font-semibold">
        {index + 1}
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-[13px] text-ink truncate">{part.title || part.video_id}</p>
        <p className="text-[11px] text-ink-light font-mono">{trimmedLabel}</p>
      </div>
      <div className="flex flex-col gap-1 w-36 flex-shrink-0">
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-muted whitespace-nowrap">{startLabel}</span>
          <input
            type="number"
            min={0}
            max={maxSec}
            step={1}
            value={startShown}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={(e) => commitStart(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="input-field !flex-1 !min-w-0 !px-2 !py-1.5 font-mono !text-[12px]"
          />
        </label>
        <input
          type="range"
          min={0}
          max={maxSec}
          step={1}
          value={Math.min(maxSec, Math.max(0, Math.round(trim.start)))}
          onChange={(e) => {
            setStartText(null);
            onCommit(part.video_id, { start: Number(e.target.value) });
          }}
          className="w-full accent-[var(--color-accent,#4f7cff)] cursor-pointer"
        />
      </div>
      <div className="flex flex-col gap-1 w-36 flex-shrink-0">
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-muted whitespace-nowrap">{endLabel}</span>
          <input
            type="number"
            min={0}
            max={maxSec}
            step={1}
            value={endShown}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={(e) => commitEnd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="input-field !flex-1 !min-w-0 !px-2 !py-1.5 font-mono !text-[12px]"
          />
        </label>
        <input
          type="range"
          min={0}
          max={maxSec}
          step={1}
          value={Math.min(maxSec, Math.max(0, Math.round(trim.end)))}
          onChange={(e) => {
            setEndText(null);
            onCommit(part.video_id, { end: Number(e.target.value) });
          }}
          className="w-full accent-[var(--color-accent,#4f7cff)] cursor-pointer"
        />
      </div>
      <button
        onClick={() => {
          setStartText(null);
          setEndText(null);
          onCommit(part.video_id, { start: 0, end: part.duration });
        }}
        className="btn-island-secondary text-[11px] !px-2.5 !py-1.5 cursor-pointer flex-shrink-0"
        title={fullLabel}
      >
        {fullLabel}
      </button>
    </div>
  );
}

/** 1 dòng video tick chọn (dùng chung cho video YT + file upload). */
function PickRow({
  v,
  badge,
  picked,
  orderSize,
  detailTitle,
  upTitle,
  downTitle,
  deleteTitle,
  onToggle,
  onDetail,
  onMove,
  onDelete,
}: {
  v: YTMergeItem;
  badge: number;
  picked: boolean;
  orderSize: number;
  detailTitle: string;
  upTitle: string;
  downTitle: string;
  deleteTitle: string;
  onToggle: () => void;
  onDetail: () => void;
  onMove: (dir: -1 | 1) => void;
  onDelete?: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className={`flex items-center gap-3 p-2 rounded-xl cursor-pointer transition-colors ring-1 ${
        picked
          ? "bg-accent-muted ring-accent/30"
          : "bg-white/[0.03] ring-white/[0.07] hover:bg-white/[0.05]"
      }`}
    >
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-[13px] font-semibold ${
          picked ? "bg-accent text-white" : "bg-white/[0.06] text-ink-light"
        }`}
      >
        {badge}
      </div>
      {v.thumbnail ? (
        <img src={v.thumbnail} alt="" className="w-20 h-11 object-cover rounded-md flex-shrink-0 bg-white/[0.06]" />
      ) : (
        <div className="w-20 h-11 rounded-md bg-white/[0.06] flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-ink-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="3" />
            <path d="M10 9l5 3-5 3V9z" />
          </svg>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink truncate">{v.title || "(no title)"}</p>
        <p className="text-[11px] text-ink-light font-mono truncate">
          {v.video_id}{v.duration ? ` · ${v.duration}` : ""}
        </p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDetail();
        }}
        className="icon-btn-ghost text-ink-light hover:text-accent-light flex-shrink-0"
        title={detailTitle}
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
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {picked && (
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onMove(-1)}
            disabled={badge === 1}
            className="icon-btn-ghost disabled:opacity-30"
            title={upTitle}
          >
            ↑
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={badge === orderSize}
            className="icon-btn-ghost disabled:opacity-30"
            title={downTitle}
          >
            ↓
          </button>
        </div>
      )}
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="icon-btn-ghost text-danger flex-shrink-0"
          title={deleteTitle}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default function MergePage() {
  return (
    <Suspense>
      <MergeRouter />
    </Suspense>
  );
}

/** /merge → danh sách; /merge?new=1 → editor mới; /merge?id=xxx → mở tiếp. */
function MergeRouter() {
  const sp = useSearchParams();
  const id = sp.get("id");
  const isNew = sp.get("new") !== null;
  if (!id && !isNew) return <MergeListView />;
  return <MergeEditor projectId={id} />;
}

function statusTagClass(status: string): string {
  if (status === "done") return "tag bg-success-muted text-success ring-success/20";
  if (status === "error") return "tag bg-danger-muted text-danger ring-danger/20";
  if (status === "cancelled") return "tag bg-warn-muted text-warn ring-warn/20";
  return "tag bg-accent-muted text-accent ring-accent/20";
}

function fmtDateTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Màn danh sách các merge đã tạo. */
function MergeListView() {
  const { t } = useI18n();
  const router = useRouter();
  const [projects, setProjects] = useState<YTProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listYTProjects());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(
    async (p: YTProjectSummary) => {
      if (!window.confirm(t("merge.confirmDelete", { name: p.name }))) return;
      setDeletingId(p.id);
      try {
        await deleteYTProject(p.id);
        setProjects((prev) => prev.filter((x) => x.id !== p.id));
      } catch {
        // ignore
      } finally {
        setDeletingId(null);
      }
    },
    [t],
  );

  return (
    <div>
      <PageHeader
        title={t("merge.title")}
        description={t("merge.desc")}
        actions={
          <button
            onClick={() => router.push("/merge?new=1")}
            className="btn-island-primary text-sm !px-5 !py-2.5"
          >
            + {t("merge.newMerge")}
          </button>
        }
      />
      <AnimatedBlock delay={80}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-ink-muted">
                <IconSpinner /> <span className="text-[13px]">{t("merge.loading")}</span>
              </div>
            ) : projects.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-[13px] text-ink-light mb-4">{t("merge.emptyProjects")}</p>
                <button
                  onClick={() => router.push("/merge?new=1")}
                  className="btn-island-primary text-sm !px-5 !py-2.5"
                >
                  + {t("merge.newMerge")}
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {projects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] ring-1 ring-white/[0.07] hover:bg-white/[0.05] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-ink truncate">{p.name}</p>
                      <p className="text-[11px] text-ink-light font-mono mt-0.5 truncate">
                        {t("merge.videosCount", { count: p.video_count })}
                        {p.total_trimmed > 0 ? ` · ${fmtDur(p.total_trimmed)}` : ""}
                        {p.updated_at ? ` · ${fmtDateTime(p.updated_at)}` : ""}
                      </p>
                      {p.status === "running" && (
                        <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden max-w-56">
                          <div className="h-full bg-accent transition-all" style={{ width: `${p.progress}%` }} />
                        </div>
                      )}
                      {p.status === "error" && p.error && (
                        <p className="text-[11px] text-danger truncate mt-0.5">{p.error.slice(0, 120)}</p>
                      )}
                    </div>
                    <span className={`${statusTagClass(p.status)} flex-shrink-0`}>
                      {t(`merge.status_${p.status}`)}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {p.output && (
                        <a
                          href={p.output}
                          download
                          className="btn-island-secondary text-[11px] !px-3 !py-1.5"
                        >
                          {t("merge.download")}
                        </a>
                      )}
                      <button
                        onClick={() => router.push(`/merge?id=${p.id}`)}
                        className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
                      >
                        {t("merge.open")}
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        disabled={deletingId === p.id}
                        className="icon-btn-ghost text-danger disabled:opacity-40 cursor-pointer"
                        title={t("merge.delete")}
                      >
                        {deletingId === p.id ? (
                          <IconSpinner className="w-4 h-4" />
                        ) : (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </AnimatedBlock>
    </div>
  );
}

function MergeEditor({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  // Session lưu theo scope để nhiều merge không đè nhau.
  const scopeId = projectId ?? "new";
  const sessionKey = `${SESSION_KEY}:${scopeId}`;
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectLoading, setProjectLoading] = useState(!!projectId);
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [channelId, setChannelId] = useState("");
  const [playlists, setPlaylists] = useState<YouTubePlaylistInfo[]>([]);
  const [playlistId, setPlaylistId] = useState("");
  const [videos, setVideos] = useState<YTMergeItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Video upload local (merge chung với video YouTube).
  const [uploads, setUploads] = useState<YTMergeItem[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [filesPct, setFilesPct] = useState(0);
  const [filesError, setFilesError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Thứ tự tick chọn: videoId → số thứ tự (1-based).
  const [order, setOrder] = useState<OrderEntry[]>([]);
  const orderMap = useMemo(() => new Map(order.map((o) => [o.videoId, o.order])), [order]);
  // Tất cả video chọn được: playlist YT + file upload local.
  const allVideos = useMemo(() => [...videos, ...uploads], [videos, uploads]);
  const orderedVideos = useMemo(
    () =>
      [...order]
        .sort((a, b) => a.order - b.order)
        .map((o) => allVideos.find((v) => v.video_id === o.videoId))
        .filter((v): v is YTMergeItem => !!v),
    [order, allVideos],
  );

  const [metaJson, setMetaJson] = useState(DEFAULT_META_JSON);
  const [metaError, setMetaError] = useState<string | null>(null);
  // Thumbnail upload tay để push kèm video.
  const [thumbPath, setThumbPath] = useState("");
  const [thumbName, setThumbName] = useState("");
  const [thumbPreviewUrl, setThumbPreviewUrl] = useState("");
  const [thumbUploading, setThumbUploading] = useState(false);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  // Kênh + playlist đích để push (mặc định theo kênh/playlist đang duyệt).
  const [pushChannelId, setPushChannelId] = useState("");
  const [pushPlaylists, setPushPlaylists] = useState<YouTubePlaylistInfo[]>([]);
  const [pushPlaylistId, setPushPlaylistId] = useState("");
  const pushTouchedRef = useRef(false);
  const pushPlaylistTouchedRef = useRef(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [cancellingMerge, setCancellingMerge] = useState(false);
  const [mergeStopped, setMergeStopped] = useState(false);
  const [mergeResumable, setMergeResumable] = useState(false);
  const [mergeStage, setMergeStage] = useState("");
  const [mergePct, setMergePct] = useState(0);
  const [mergeOutput, setMergeOutput] = useState<string | null>(null);
  const [mergeSize, setMergeSize] = useState(0);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Prepare: tải video về để cắt trên timeline trước khi ghép.
  const [prepJobId, setPrepJobId] = useState<string | null>(null);
  const [prepping, setPrepping] = useState(false);
  const [cancellingPrep, setCancellingPrep] = useState(false);
  const [prepStopped, setPrepStopped] = useState(false);
  const [prepResumable, setPrepResumable] = useState(false);
  const [prepStage, setPrepStage] = useState("");
  const [prepPct, setPrepPct] = useState(0);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [parts, setParts] = useState<YTPrepPart[]>([]);
  const [trims, setTrims] = useState<Record<string, Trim>>({});
  const prepPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [previewIdx, setPreviewIdx] = useState(0);
  const previewRef = useRef<HTMLVideoElement>(null);
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResumable, setUploadResumable] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Modal xem chi tiết video (title + mô tả + nội dung file meta).
  const [detailVideo, setDetailVideo] = useState<YTMergeItem | null>(null);
  const [metaCopied, setMetaCopied] = useState(false);

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  const stopUploadPoll = useCallback(() => {
    if (uploadRef.current) clearInterval(uploadRef.current);
    uploadRef.current = null;
  }, []);
  const stopPrepPoll = useCallback(() => {
    if (prepPollRef.current) clearInterval(prepPollRef.current);
    prepPollRef.current = null;
  }, []);

  useEffect(
    () => () => {
      stopPoll();
      stopUploadPoll();
      stopPrepPoll();
    },
    [stopPoll, stopUploadPoll, stopPrepPoll],
  );

  // Phiên đang khôi phục dở (playlist/order đợi list load xong mới áp).
  const restoreRef = useRef<{
    playlistId: string;
    order: OrderEntry[];
    pushPlaylistId: string;
  } | null>(null);
  // Playlist mà cache videos hiện tại thuộc về — khớp thì khỏi fetch ngầm.
  const videosCacheForRef = useRef<string>("");

  // Khôi phục phiên làm việc đã lưu (reload trang vẫn tiếp tục được).
  useEffect(() => {
    let s: MergeSession | null = null;
    try {
      const raw = localStorage.getItem(sessionKey);
      if (raw) {
        s = JSON.parse(raw) as MergeSession;
      } else if (scopeId === "new") {
        // Migrate phiên cũ (key chưa có scope).
        const legacy = localStorage.getItem(SESSION_KEY);
        if (legacy) s = JSON.parse(legacy) as MergeSession;
      }
    } catch {
      s = null;
    }
    if (!s) return;
    if (s.metaJson) setMetaJson(s.metaJson);
    if (s.trims) setTrims(s.trims);
    // Render ngay danh sách đã lưu, khỏi chờ API load lại.
    if (Array.isArray(s.playlists) && s.playlists.length > 0) setPlaylists(s.playlists);
    if (Array.isArray(s.videos) && s.videos.length > 0) {
      setVideos(s.videos);
      // Cache thuộc đúng playlist đã lưu → khỏi fetch ngầm khi mở trang.
      if (s.playlistId) videosCacheForRef.current = s.playlistId;
    }
    if (Array.isArray(s.uploads) && s.uploads.length > 0) setUploads(s.uploads);
    if (Array.isArray(s.order) && s.order.length > 0) {
      skipOrderResetRef.current = true;
      setOrder(
        s.order.map((o, i) => ({ videoId: o.videoId, order: typeof o.order === "number" ? o.order : i + 1 })),
      );
    }
    if (s.pushChannelId) {
      pushTouchedRef.current = true;
      setPushChannelId(s.pushChannelId);
    }
    if (s.thumbPath) {
      setThumbPath(s.thumbPath);
      setThumbName(s.thumbName || "");
      setThumbPreviewUrl(`/api/yt-merge/thumbnail?path=${encodeURIComponent(s.thumbPath)}`);
    }
    restoreRef.current = {
      playlistId: s.playlistId || "",
      order: Array.isArray(s.order) ? s.order : [],
      pushPlaylistId: s.pushPlaylistId || "",
    };
    if (s.pushPlaylistId) pushPlaylistTouchedRef.current = true;
    if (s.channelId) {
      skipChannelClearRef.current = true;
      setChannelId(s.channelId);
    }
    if (s.prepJobId) {
      // Không fetch/poll khi mới mở trang — khôi phục từ cache, bấm
      // Theo dõi tiếp / Tải video mới chạy API.
      setPrepJobId(s.prepJobId);
      if (Array.isArray(s.parts) && s.parts.length > 0) setParts(s.parts);
      if (s.prepping) setPrepResumable(true);
    }
    if (s.jobId && s.mergeOutput) {
      setJobId(s.jobId);
      setMergeOutput(s.mergeOutput);
      setMergeSize(s.mergeSize || 0);
    } else if (s.jobId) {
      setJobId(s.jobId);
      if (s.merging) setMergeResumable(true);
    }
    if (s.uploadJobId && !s.uploadDone) {
      setUploadJobId(s.uploadJobId);
      if (s.uploading) setUploadResumable(true);
    } else if (s.uploadJobId && s.uploadDone) {
      setUploadJobId(s.uploadJobId);
      setUploadDone(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save phiên làm việc mỗi khi đổi (bấm Tải video là đã lưu).
  useEffect(() => {
    try {
      const s: MergeSession = {
        channelId,
        playlistId,
        order,
        videos,
        playlists,
        uploads,
        metaJson,
        pushChannelId,
        pushPlaylistId,
        prepJobId,
        prepping,
        parts,
        trims,
        thumbPath,
        thumbName,
        jobId,
        merging,
        mergeOutput,
        mergeSize,
        uploadJobId,
        uploading,
        uploadDone,
        savedAt: Date.now(),
      };
      localStorage.setItem(sessionKey, JSON.stringify(s));
    } catch {
      // ignore (quota đầy...)
    }
  }, [
    sessionKey,
    channelId,
    playlistId,
    order,
    videos,
    playlists,
    uploads,
    metaJson,
    pushChannelId,
    pushPlaylistId,
    prepJobId,
    prepping,
    parts,
    trims,
    thumbPath,
    thumbName,
    jobId,
    merging,
    mergeOutput,
    mergeSize,
    uploadJobId,
    uploading,
    uploadDone,
  ]);

  // Load kênh YT đã cấu hình.
  useEffect(() => {
    listYoutubeChannels()
      .then((d) => {
        setChannels(d.channels || []);
        if (d.channels?.length === 1) {
          setChannelId(d.channels[0].id);
          setPushChannelId(d.channels[0].id);
        }
      })
      .catch(() => {});
  }, []);

  // Đổi kênh → load playlists. Bỏ qua lần xoá khi đang khôi phục phiên
  // (giữ danh sách đã lưu để render ngay, refresh ngầm bên dưới).
  const skipChannelClearRef = useRef(false);
  useEffect(() => {
    if (skipChannelClearRef.current) {
      skipChannelClearRef.current = false;
      if (!channelId) return;
      if (!pushTouchedRef.current) setPushChannelId(channelId);
      // Đã có cache playlists → khỏi fetch ngầm (bấm Tải lại khi cần).
      if (playlists.length === 0) {
        listYoutubePlaylists(channelId)
          .then(setPlaylists)
          .catch(() => {});
      }
      return;
    }
    setPlaylists([]);
    setPlaylistId("");
    setVideos([]);
    setOrder([]);
    if (!channelId) return;
    // Kênh push mặc định theo kênh đang duyệt (cho tới khi user đổi tay).
    if (!pushTouchedRef.current) setPushChannelId(channelId);
    listYoutubePlaylists(channelId)
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, [channelId]);

  // Đổi kênh push → load playlists đích; mặc định playlist đích theo
  // playlist đang duyệt khi cùng kênh.
  useEffect(() => {
    setPushPlaylists([]);
    setPushPlaylistId("");
    if (!pushChannelId) return;
    listYoutubePlaylists(pushChannelId)
      .then((ps) => {
        setPushPlaylists(ps);
        // Khôi phục playlist đích của phiên đã lưu.
        const pendingPush = restoreRef.current?.pushPlaylistId || "";
        if (pendingPush && ps.some((p) => p.id === pendingPush)) {
          setPushPlaylistId(pendingPush);
          if (restoreRef.current) restoreRef.current.pushPlaylistId = "";
        } else if (
          !pushPlaylistTouchedRef.current &&
          pushChannelId === channelId &&
          playlistId &&
          ps.some((p) => p.id === playlistId)
        ) {
          setPushPlaylistId(playlistId);
        }
      })
      .catch(() => setPushPlaylists([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushChannelId]);

  // Đổi playlist đang duyệt → playlist đích chạy theo (khi cùng kênh và
  // user chưa chọn tay playlist đích).
  useEffect(() => {
    if (
      !pushPlaylistTouchedRef.current &&
      pushChannelId &&
      pushChannelId === channelId &&
      playlistId &&
      pushPlaylists.some((p) => p.id === playlistId)
    ) {
      setPushPlaylistId(playlistId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId]);

  const loadVideos = useCallback(async () => {
    if (!playlistId) return;
    setLoadingList(true);
    setListError(null);
    try {
      const items = await listYTMergeItems(channelId, playlistId);
      setVideos(items);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Không tải được danh sách video.");
    } finally {
      setLoadingList(false);
    }
  }, [channelId, playlistId]);

  // Áp playlist/order của phiên đang khôi phục sau khi list load xong.
  useEffect(() => {
    const r = restoreRef.current;
    if (r?.playlistId && playlists.some((p) => p.id === r.playlistId)) {
      setPlaylistId(r.playlistId);
      r.playlistId = "";
    }
  }, [playlists]);

  useEffect(() => {
    const r = restoreRef.current;
    if (!r?.order?.length || videos.length === 0) return;
    const ids = new Set(videos.map((v) => v.video_id));
    const kept = r.order.filter((o) => ids.has(o.videoId));
    if (kept.length > 0) {
      skipOrderResetRef.current = true;
      setOrder(kept.map((o, i) => ({ videoId: o.videoId, order: i + 1 })));
    }
    r.order = [];
  }, [videos]);

  // Mở tiếp project (?id=): nạp snapshot đã lưu. Bỏ qua nếu đã có draft
  // mới hơn trong session (user sửa sau lần merge/push trước).
  useEffect(() => {
    if (!projectId) return;
    let hasDraft = false;
    try {
      hasDraft = !!localStorage.getItem(sessionKey);
    } catch {
      hasDraft = false;
    }
    if (hasDraft) {
      setProjectLoading(false);
      return;
    }
    getYTProject(projectId)
      .then((p) => {
        if (Array.isArray(p.items) && p.items.length > 0) {
          setVideos(p.items);
          setPlaylists([]);
        }
        if (Array.isArray(p.segments) && p.segments.length > 0) {
          skipOrderResetRef.current = true;
          setOrder(p.segments.map((s, i) => ({ videoId: s.video_id, order: i + 1 })));
          const tr: Record<string, Trim> = {};
          p.segments.forEach((s) => {
            const dur = s.duration > 0 ? s.duration : 0;
            tr[s.video_id] = {
              start: Math.max(0, s.start || 0),
              end: s.end != null && s.end > 0 ? s.end : dur,
            };
          });
          setTrims(tr);
        }
        if (p.meta && typeof p.meta === "object") {
          setMetaJson(JSON.stringify(p.meta, null, 2));
          setMetaError(null);
        }
        if (p.push_channel_id) {
          pushTouchedRef.current = true;
          setPushChannelId(p.push_channel_id);
        }
        if (p.push_playlist_id) {
          pushPlaylistTouchedRef.current = true;
          setPushPlaylistId(p.push_playlist_id);
        }
        if (p.thumb_path) {
          setThumbPath(p.thumb_path);
          setThumbName(p.thumb_path.split("/").pop() || "");
          setThumbPreviewUrl(`/api/yt-merge/thumbnail?path=${encodeURIComponent(p.thumb_path)}`);
        }
        if (p.status === "done" && p.output) {
          setJobId(p.id);
          setMergeOutput(p.output);
          setMergeSize(p.output_size || 0);
        }
        setProjectNotice(t("merge.openedProject"));
      })
      .catch(() => {})
      .finally(() => setProjectLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    // Cache khớp playlist đang mở (vừa khôi phục) → giữ nguyên, không fetch.
    if (videosCacheForRef.current && videosCacheForRef.current === playlistId) {
      videosCacheForRef.current = "";
      return;
    }
    setVideos([]);
    setOrder([]);
    if (playlistId) loadVideos();
  }, [playlistId, loadVideos]);

  const togglePick = useCallback((vid: string) => {
    restoreRef.current = null;
    setOrder((prev) => {
      if (prev.some((o) => o.videoId === vid)) {
        // Bỏ chọn → đánh lại số thứ tự cho liên tục.
        return prev
          .filter((o) => o.videoId !== vid)
          .sort((a, b) => a.order - b.order)
          .map((o, i) => ({ ...o, order: i + 1 }));
      }
      return [...prev, { videoId: vid, order: prev.length + 1 }];
    });
  }, []);

  const moveItem = useCallback((vid: string, dir: -1 | 1) => {
    restoreRef.current = null;
    setOrder((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const i = sorted.findIndex((o) => o.videoId === vid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return prev;
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      return sorted.map((o, k) => ({ ...o, order: k + 1 }));
    });
  }, []);

  // Key danh sách đã chọn — đổi tick chọn thì phải tải lại + ghép lại.
  const orderKey = useMemo(
    () => [...order].sort((a, b) => a.order - b.order).map((o) => o.videoId).join(","),
    [order],
  );

  // Đổi danh sách chọn → huỷ kết quả ghép cũ (giữ file đã tải + khoảng cắt).
  // Bỏ qua 1 lần khi order do khôi phục phiên áp (giữ nguyên job đang chạy).
  const skipOrderResetRef = useRef(false);
  useEffect(() => {
    if (skipOrderResetRef.current) {
      skipOrderResetRef.current = false;
      return;
    }
    stopPoll();
    setJobId(null);
    setMerging(false);
    setMergeStopped(false);
    setMergeOutput(null);
    setMergeError(null);
    setUploadJobId(null);
    setUploadDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // Part mới tải về → khởi tạo khoảng cắt full.
  useEffect(() => {
    setTrims((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const p of parts) {
        if (!next[p.video_id]) {
          next[p.video_id] = { start: 0, end: p.duration };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setPreviewIdx((i) => Math.min(i, Math.max(0, parts.length - 1)));
  }, [parts]);

  const trimOf = useCallback(
    (p: YTPrepPart): Trim => trims[p.video_id] || { start: 0, end: p.duration },
    [trims],
  );

  const trimmedDur = useCallback(
    (p: YTPrepPart): number => {
      const tr = trimOf(p);
      const s = Math.min(Math.max(0, tr.start), p.duration);
      const e = Math.min(Math.max(0, tr.end), p.duration);
      return Math.max(0, e - s);
    },
    [trimOf],
  );

  const totalTrimmed = useMemo(
    () => parts.reduce((acc, p) => acc + trimmedDur(p), 0),
    [parts, trimmedDur],
  );

  const prepMatches = useMemo(
    () =>
      parts.length > 0 &&
      parts.length === orderedVideos.length &&
      parts.every((p, i) => p.video_id === orderedVideos[i]?.video_id),
    [parts, orderedVideos],
  );

  const setTrim = useCallback((videoId: string, patch: Partial<Trim>) => {
    setTrims((prev) => ({
      ...prev,
      [videoId]: { ...(prev[videoId] || { start: 0, end: 0 }), ...patch },
    }));
  }, []);

  const pollPrepareStatus = useCallback(
    (id: string) => {
      stopPrepPoll();
      prepPollRef.current = setInterval(async () => {
        try {
          const s = await getYTPrepareStatus(id);
          setPrepStage(s.stage);
          setPrepPct(s.progress);
          setParts(s.parts || []);
          if (s.status === "done") {
            stopPrepPoll();
            setPrepping(false);
          } else if (s.status === "cancelled") {
            stopPrepPoll();
            setPrepping(false);
            setCancellingPrep(false);
            setPrepStopped(true);
          } else if (s.status === "error") {
            stopPrepPoll();
            setPrepping(false);
            setPrepError(s.error || "Tải thất bại.");
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Lỗi poll tiến trình tải.";
          stopPrepPoll();
          setPrepping(false);
          if (/not found/i.test(msg)) {
            // Job cũ không còn (backend restart) — cho tải lại từ đầu.
            setPrepJobId(null);
            setParts([]);
          } else {
            setPrepError(msg);
          }
        }
      }, 3000);
    },
    [stopPrepPoll],
  );

  const handlePrepare = useCallback(async () => {
    if (orderedVideos.length < 1 || prepping) return;
    setPrepping(true);
    setPrepError(null);
    setPrepStopped(false);
    setPrepResumable(false);
    setParts([]);
    setTrims({});
    setMergeOutput(null);
    setMergeStopped(false);
    try {
      const { job_id } = await startYTPrepare({
        video_ids: orderedVideos.map((v) => v.video_id),
        titles: orderedVideos.map((v) => v.title),
      });
      setPrepJobId(job_id);
      pollPrepareStatus(job_id);
    } catch (e) {
      setPrepping(false);
      setPrepError(e instanceof Error ? e.message : "Không bắt đầu tải được.");
    }
  }, [orderedVideos, prepping, pollPrepareStatus]);

  const handleCancelPrepare = useCallback(async () => {
    if (!prepJobId || !prepping || cancellingPrep) return;
    setCancellingPrep(true);
    try {
      await cancelYTPrepare(prepJobId);
    } catch {
      setCancellingPrep(false);
    }
  }, [prepJobId, prepping, cancellingPrep]);

  const handleCancelMerge = useCallback(async () => {
    if (!jobId || !merging || cancellingMerge) return;
    setCancellingMerge(true);
    try {
      await cancelYTMerge(jobId);
    } catch {
      setCancellingMerge(false);
    }
  }, [jobId, merging, cancellingMerge]);

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      const valid = files.filter(
        (f) =>
          f.type.startsWith("video/") ||
          /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f.name),
      );
      if (valid.length === 0) {
        if (files.length > 0) setFilesError(t("merge.uploadNoVideo"));
        return;
      }
      setUploadingFiles(true);
      setFilesError(null);
      setFilesPct(0);
      try {
        const { items, errors } = await uploadYTMergeFiles(valid, setFilesPct);
        if (items.length > 0) {
          setUploads((prev) => {
            const known = new Set(prev.map((u) => u.video_id));
            return [...prev, ...items.filter((it) => !known.has(it.video_id)).map(uploadToItem)];
          });
        }
        if (errors.length > 0) setFilesError(errors.join("\n"));
      } catch (e) {
        setFilesError(e instanceof Error ? e.message : t("merge.uploadFail"));
      } finally {
        setUploadingFiles(false);
        if (uploadInputRef.current) uploadInputRef.current.value = "";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleDeleteUpload = useCallback(async (uid: string) => {
    restoreRef.current = null;
    setUploads((prev) => prev.filter((u) => u.video_id !== uid));
    setOrder((prev) =>
      prev
        .filter((o) => o.videoId !== uid)
        .sort((a, b) => a.order - b.order)
        .map((o, i) => ({ ...o, order: i + 1 })),
    );
    try {
      await deleteYTMergeUpload(uid);
    } catch {
      // file tạm backend, lỗi xoá thì bỏ qua
    }
  }, []);

  const handleThumbSelect = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setThumbUploading(true);
    setThumbError(null);
    try {
      const { path } = await uploadYTMergeThumbnail(file);
      setThumbPath(path);
      setThumbName(file.name);
      setThumbPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
    } catch (e) {
      setThumbError(e instanceof Error ? e.message : t("merge.thumbnailFail"));
    } finally {
      setThumbUploading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearThumb = useCallback(() => {
    setThumbPath("");
    setThumbName("");
    setThumbPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    if (thumbInputRef.current) thumbInputRef.current.value = "";
  }, []);

  // ── Xem trước tổng: nối các đoạn đã cắt, phát tuần tự ──
  const playPreviewSeg = useCallback(
    (i: number) => {
      if (i < 0 || i >= parts.length) return;
      setPreviewIdx(i);
      // src đổi theo previewIdx; phần tử <video key> remount + autoPlay.
    },
    [parts.length],
  );

  const handlePreviewTimeUpdate = useCallback(() => {
    const v = previewRef.current;
    if (!v || v.paused) return;
    const p = parts[previewIdx];
    if (!p) return;
    const end = Math.min(trimOf(p).end, p.duration);
    if (v.currentTime >= end - 0.15) {
      if (previewIdx + 1 < parts.length) {
        setPreviewIdx(previewIdx + 1);
      } else {
        v.pause();
      }
    }
  }, [parts, previewIdx, trimOf]);

  const handlePreviewLoaded = useCallback(() => {
    const v = previewRef.current;
    const p = parts[previewIdx];
    if (!v || !p) return;
    const start = Math.min(Math.max(0, trimOf(p).start), p.duration);
    try {
      if (Math.abs(v.currentTime - start) > 0.3) v.currentTime = start;
    } catch {
      // seek chưa sẵn sàng — timeupdate sẽ xử lý tiếp
    }
    v.play().catch(() => {});
  }, [parts, previewIdx, trimOf]);

  const pollMergeStatus = useCallback(
    (id: string, count: number) => {
      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const s = await getYTMergeStatus(id);
          setMergeStage(s.stage);
          setMergePct(s.progress);
          if (s.status === "done") {
            stopPoll();
            setMerging(false);
            setMergeOutput(s.output);
            setMergeSize(s.output_size);
            // Tự điền title mặc định nếu meta.json đang để trống.
            setMetaJson((prev) =>
              fillMetaTitle(prev, `Ghép ${count} video — ${new Date().toLocaleDateString("vi-VN")}`),
            );
          } else if (s.status === "cancelled") {
            stopPoll();
            setMerging(false);
            setCancellingMerge(false);
            setMergeStopped(true);
          } else if (s.status === "error") {
            stopPoll();
            setMerging(false);
            setMergeError(s.error || "Ghép thất bại.");
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Lỗi poll tiến trình.";
          stopPoll();
          setMerging(false);
          if (/not found/i.test(msg)) setJobId(null);
          setMergeError(msg);
        }
      }, 3000);
    },
    [stopPoll],
  );

  const handleMerge = useCallback(async () => {
    if (orderedVideos.length < 2 || merging) return;
    if (!prepMatches || !prepJobId) {
      setMergeError(t("merge.needPrep"));
      return;
    }
    setMerging(true);
    setCancellingMerge(false);
    setMergeStopped(false);
    setMergeResumable(false);
    setMergeError(null);
    setMergeOutput(null);
    setUploadJobId(null);
    setUploadDone(false);
    try {
      const parsed = tryParseMeta(metaJson);
      const metaTitle = parsed.ok && parsed.data ? String(parsed.data.title || "").trim() : "";
      const { job_id } = await startYTMerge({
        channel_id: channelId,
        video_ids: orderedVideos.map((v) => v.video_id),
        titles: orderedVideos.map((v) => v.title),
        output_name: metaTitle || `Ghép ${orderedVideos.length} video`,
        prepare_job_id: prepJobId,
        project_id: projectId || "",
        items: orderedVideos,
        segments: parts.map((p) => {
          const tr = trimOf(p);
          return {
            video_id: p.video_id,
            start: Math.min(Math.max(0, tr.start), p.duration),
            end: Math.min(Math.max(0, tr.end), p.duration),
          };
        }),
      });
      setJobId(job_id);
      pollMergeStatus(job_id, orderedVideos.length);
    } catch (e) {
      setMerging(false);
      setMergeError(e instanceof Error ? e.message : "Không bắt đầu ghép được.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedVideos, merging, channelId, metaJson, prepMatches, prepJobId, parts, trimOf, pollMergeStatus, projectId]);

  const pollUploadStatus = useCallback(
    (id: string) => {
      stopUploadPoll();
      uploadRef.current = setInterval(async () => {
        try {
          const s = await getYoutubeUploadStatus(id);
          setUploadPct(s.progress);
          if (s.status === "done") {
            stopUploadPoll();
            setUploading(false);
            setUploadDone(true);
          } else if (s.status === "error") {
            stopUploadPoll();
            setUploading(false);
            setUploadError(s.error || (s.output_lines || []).slice(-3).join("\n") || "Upload thất bại.");
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Lỗi poll upload.";
          stopUploadPoll();
          setUploading(false);
          if (/not found/i.test(msg)) setUploadJobId(null);
          setUploadError(msg);
        }
      }, 3000);
    },
    [stopUploadPoll],
  );

  // Theo dõi tiếp job còn dở từ phiên trước (user bấm mới poll).
  const handleResumePrep = useCallback(() => {
    if (!prepJobId || prepping) return;
    setPrepResumable(false);
    setPrepStopped(false);
    setPrepError(null);
    setPrepping(true);
    pollPrepareStatus(prepJobId);
  }, [prepJobId, prepping, pollPrepareStatus]);

  const handleResumeMerge = useCallback(() => {
    if (!jobId || merging) return;
    setMergeResumable(false);
    setMergeStopped(false);
    setMergeError(null);
    setMerging(true);
    pollMergeStatus(jobId, orderedVideos.length);
  }, [jobId, merging, pollMergeStatus, orderedVideos.length]);

  const handleResumeUpload = useCallback(() => {
    if (!uploadJobId || uploading) return;
    setUploadResumable(false);
    setUploadError(null);
    setUploading(true);
    pollUploadStatus(uploadJobId);
  }, [uploadJobId, uploading, pollUploadStatus]);

  const handlePush = useCallback(async () => {
    if (!jobId || !mergeOutput || uploading) return;
    const parsed = tryParseMeta(metaJson);
    if (!parsed.ok || !parsed.data) {
      setUploadError(`meta.json không hợp lệ: ${parsed.error || ""}`);
      return;
    }
    const pushTitle = String(parsed.data.title || "").trim();
    if (!pushTitle) {
      setUploadError("meta.json cần có title.");
      return;
    }
    const rawPrivacy = String(parsed.data.privacyStatus || "private");
    const pushPrivacy = ["private", "unlisted", "public"].includes(rawPrivacy)
      ? rawPrivacy
      : "private";
    if (!pushChannelId) {
      setUploadError("Chọn kênh YouTube để push.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadResumable(false);
    setUploadPct(0);
    try {
      const { job_id } = await pushYTMerged(jobId, {
        title: pushTitle,
        description: String(parsed.data.description || ""),
        privacy: pushPrivacy,
        channel_id: pushChannelId,
        playlist_id: pushPlaylistId,
        thumbnail_path: thumbPath,
        meta: parsed.data,
      });
      setUploadJobId(job_id);
      pollUploadStatus(job_id);
    } catch (e) {
      setUploading(false);
      setUploadError(e instanceof Error ? e.message : "Không push được lên YouTube.");
    }
  }, [jobId, mergeOutput, uploading, metaJson, pushChannelId, pushPlaylistId, thumbPath, pollUploadStatus]);

  return (
    <div>
      <PageHeader
        title={t("merge.title")}
        description={t("merge.desc")}
        back={{ href: "/merge", label: t("merge.backToList") }}
      />
      {projectLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-ink-muted">
          <IconSpinner /> <span className="text-[13px]">{t("merge.loading")}</span>
        </div>
      ) : (
        <>
          {projectNotice && (
            <div className="mb-6 rounded-xl bg-accent-muted ring-1 ring-accent/20 px-4 py-3">
              <p className="text-[13px] text-accent-light">{projectNotice}</p>
            </div>
          )}

      {/* Bước 1: chọn kênh + playlist */}
      <AnimatedBlock delay={80}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink mb-3">
              {t("merge.step1")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[12px] text-ink-muted">{t("merge.channel")}</span>
                <select
                  value={channelId}
                  onChange={(e) => {
                    restoreRef.current = null;
                    setChannelId(e.target.value);
                  }}
                  className="input-field w-full mt-1 cursor-pointer"
                >
                  <option value="">{t("merge.pickChannel")}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.has_request_token ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] text-ink-muted">{t("merge.playlist")}</span>
                <select
                  value={playlistId}
                  onChange={(e) => {
                    restoreRef.current = null;
                    setPlaylistId(e.target.value);
                    setOrder([]);
                  }}
                  disabled={!channelId}
                  className="input-field w-full mt-1 cursor-pointer disabled:opacity-40"
                >
                  <option value="">{t("merge.pickPlaylist")}</option>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.item_count})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {channels.length === 0 && (
              <p className="mt-2 text-[12px] text-warn">{t("merge.noChannel")}</p>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {/* Bước 2: tick chọn video theo thứ tự */}
      <AnimatedBlock delay={140}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                {t("merge.step2")} {allVideos.length > 0 && <span className="tag ml-2">{order.length}/{allVideos.length} {t("merge.picked")}</span>}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="video/*,.mkv"
                  multiple
                  className="hidden"
                  onChange={(e) => handleUploadFiles(Array.from(e.target.files || []))}
                />
                <button
                  onClick={() => uploadInputRef.current?.click()}
                  disabled={uploadingFiles}
                  className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
                >
                  {uploadingFiles && <IconSpinner className="w-3.5 h-3.5" />}
                  {uploadingFiles ? t("merge.uploadingFiles", { pct: filesPct }) : t("merge.uploadBtn")}
                </button>
                <button
                  onClick={() => {
                    restoreRef.current = null;
                    setOrder(allVideos.map((v, i) => ({ videoId: v.video_id, order: i + 1 })));
                  }}
                  disabled={!allVideos.length}
                  className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-40"
                >
                  {t("merge.pickAll")}
                </button>
                <button
                  onClick={() => {
                    restoreRef.current = null;
                    setOrder([]);
                  }}
                  disabled={!order.length}
                  className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-40"
                >
                  {t("merge.clear")}
                </button>
                <button
                  onClick={loadVideos}
                  disabled={!playlistId || loadingList}
                  className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-40"
                >
                  {loadingList ? <IconSpinner className="w-3.5 h-3.5" /> : t("merge.reload")}
                </button>
              </div>
            </div>

            {listError && (
              <p className="mb-3 text-[12px] text-danger">{listError}</p>
            )}
            {filesError && (
              <p className="mb-3 text-[12px] text-danger whitespace-pre-line">{filesError}</p>
            )}
            {!playlistId && uploads.length === 0 ? (
              <p className="text-[13px] text-ink-light py-6 text-center">{t("merge.hintPick")}</p>
            ) : (
              <>
                {playlistId && (
                  loadingList && videos.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-ink-muted">
                      <IconSpinner /> <span className="text-[13px]">{t("merge.loading")}</span>
                    </div>
                  ) : videos.length === 0 ? (
                    <p className="text-[13px] text-ink-light py-6 text-center">{t("merge.empty")}</p>
                  ) : (
                    <div className="space-y-1.5 max-h-[480px] overflow-y-auto scrollbar-thin pr-1">
                      {videos.map((v, idx) => {
                        const n = orderMap.get(v.video_id);
                        const picked = n != null;
                        return (
                          <PickRow
                            key={v.video_id}
                            v={v}
                            badge={picked ? (n as number) : idx + 1}
                            picked={picked}
                            orderSize={order.length}
                            detailTitle={t("merge.viewDetail")}
                            upTitle={t("merge.moveUp")}
                            downTitle={t("merge.moveDown")}
                            deleteTitle=""
                            onToggle={() => togglePick(v.video_id)}
                            onDetail={() => {
                              setMetaCopied(false);
                              setDetailVideo(v);
                            }}
                            onMove={(dir) => moveItem(v.video_id, dir)}
                          />
                        );
                      })}
                    </div>
                  )
                )}
                {uploads.length > 0 && (
                  <div className={playlistId ? "mt-4" : ""}>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink mb-2">
                      {t("merge.uploadedTitle")}{" "}
                      <span className="tag ml-1">
                        {uploads.filter((u) => orderMap.has(u.video_id)).length}/{uploads.length}
                      </span>
                    </p>
                    <div className="space-y-1.5 max-h-[320px] overflow-y-auto scrollbar-thin pr-1">
                      {uploads.map((v, idx) => {
                        const n = orderMap.get(v.video_id);
                        const picked = n != null;
                        return (
                          <PickRow
                            key={v.video_id}
                            v={v}
                            badge={picked ? (n as number) : idx + 1}
                            picked={picked}
                            orderSize={order.length}
                            detailTitle={t("merge.viewDetail")}
                            upTitle={t("merge.moveUp")}
                            downTitle={t("merge.moveDown")}
                            deleteTitle={t("merge.deleteUpload")}
                            onToggle={() => togglePick(v.video_id)}
                            onDetail={() => {
                              setMetaCopied(false);
                              setDetailVideo(v);
                            }}
                            onMove={(dir) => moveItem(v.video_id, dir)}
                            onDelete={() => handleDeleteUpload(v.video_id)}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {/* Bước 3: tải, cắt, ghép + push */}
      <AnimatedBlock delay={200}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink mb-3">
              {t("merge.step3")}
            </p>
            {order.length > 0 && (
              <div className="mb-3 flex items-center gap-2 flex-wrap">
                <span className="text-[12px] text-ink-muted">{t("merge.order")}:</span>
                {orderedVideos.map((v, i) => (
                  <span key={v.video_id} className="tag">
                    {i + 1}. {(v.title || v.video_id).slice(0, 24)}
                  </span>
                ))}
              </div>
            )}

            {/* 3a. Tải các video đã chọn về server */}
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <button
                onClick={handlePrepare}
                disabled={orderedVideos.length < 1 || prepping}
                className="btn-island-secondary text-sm !px-5 !py-2.5 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {prepping && <IconSpinner className="w-4 h-4" />}
                {prepping ? `${prepStage} ${prepPct}%` : t("merge.btnDownload")}
              </button>
              {prepping && (
                <button
                  onClick={handleCancelPrepare}
                  disabled={cancellingPrep}
                  className="btn-island-secondary text-sm !px-5 !py-2.5 disabled:opacity-40 cursor-pointer"
                >
                  {cancellingPrep ? t("merge.stopping") : t("merge.btnStop")}
                </button>
              )}
              {prepResumable && !prepping && (
                <>
                  <button
                    onClick={handleResumePrep}
                    className="btn-island-secondary text-sm !px-5 !py-2.5 cursor-pointer"
                  >
                    {t("merge.resume")}
                  </button>
                  <span className="text-[12px] text-warn">{t("merge.interrupted")}</span>
                </>
              )}
              {prepMatches && !prepping && (
                <span className="tag bg-success-muted text-success ring-success/20">
                  {t("merge.prepDone", { count: parts.length })}
                </span>
              )}
            </div>
            {prepping && (
              <div className="mb-3 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${prepPct}%` }} />
              </div>
            )}
            {prepError && <p className="mb-3 text-[12px] text-danger">{prepError}</p>}
            {prepStopped && <p className="mb-3 text-[12px] text-warn">{t("merge.stopped")}</p>}
            {prepJobId && parts.length > 0 && !prepMatches && !prepping && (
              <p className="mb-3 text-[12px] text-warn">{t("merge.prepChanged")}</p>
            )}

            {/* 3b. Timeline: cắt ngắn từng tập */}
            {parts.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {t("merge.trimTitle")}
                  </p>
                  <span className="tag">
                    {t("merge.totalTrim")}: {fmtDur(totalTrimmed)}
                  </span>
                </div>
                <div className="space-y-1.5 max-h-[320px] overflow-y-auto scrollbar-thin pr-1">
                  {parts.map((p, i) => (
                    <TrimRow
                      key={p.video_id}
                      part={p}
                      index={i}
                      trim={trimOf(p)}
                      trimmedLabel={`${fmtDur(p.duration)} → ${fmtDur(trimmedDur(p))}`}
                      startLabel={t("merge.trimStart")}
                      endLabel={t("merge.trimEnd")}
                      fullLabel={t("merge.trimFull")}
                      onCommit={setTrim}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 3c. Màn xem video tổng (nối các đoạn đã cắt, phát tuần tự) */}
            {parts.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {t("merge.previewTitle")}
                  </p>
                  <span className="tag">
                    {t("merge.nowPlaying", { i: previewIdx + 1, n: parts.length })}
                    {" · "}{fmtDur(totalTrimmed)}
                  </span>
                </div>
                <div className="rounded-xl overflow-hidden bg-black ring-1 ring-white/10">
                  <video
                    key={previewIdx}
                    ref={previewRef}
                    src={parts[previewIdx]?.preview}
                    controls
                    playsInline
                    onLoadedMetadata={handlePreviewLoaded}
                    onTimeUpdate={handlePreviewTimeUpdate}
                    className="w-full max-h-[420px] object-contain"
                  />
                </div>
                {totalTrimmed > 0 && (
                  <div className="mt-2 flex h-9 rounded-lg overflow-hidden ring-1 ring-white/10">
                    {parts.map((p, i) => (
                      <button
                        key={p.video_id}
                        onClick={() => playPreviewSeg(i)}
                        style={{ width: `${Math.max(2, (trimmedDur(p) / totalTrimmed) * 100)}%` }}
                        title={`${i + 1}. ${p.title} (${fmtDur(trimmedDur(p))})`}
                        className={`flex items-center justify-center text-[11px] font-semibold cursor-pointer transition-colors ${
                          i === previewIdx
                            ? "bg-accent text-white"
                            : "bg-white/[0.06] text-ink-light hover:bg-white/[0.12]"
                        }`}
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <label className="block sm:col-span-2">
                <span className="text-[12px] text-ink-muted">{t("merge.metaJson")}</span>
                <textarea
                  value={metaJson}
                  onChange={(e) => {
                    setMetaJson(e.target.value);
                    const r = tryParseMeta(e.target.value);
                    setMetaError(r.ok ? null : (r.error || "JSON không hợp lệ."));
                  }}
                  rows={9}
                  spellCheck={false}
                  className="input-field w-full mt-1 font-mono !text-[12px] !leading-relaxed"
                />
                <span className="text-[11px] text-ink-light">{t("merge.metaJsonHint")}</span>
              </label>
              {metaError && (
                <p className="-mt-1 sm:col-span-2 text-[12px] text-danger">{metaError}</p>
              )}
              <label className="block">
                <span className="text-[12px] text-ink-muted">{t("merge.pushChannel")}</span>
                <select
                  value={pushChannelId}
                  onChange={(e) => {
                    pushTouchedRef.current = true;
                    setPushChannelId(e.target.value);
                  }}
                  className="input-field w-full mt-1 cursor-pointer"
                >
                  <option value="">{t("merge.pickChannel")}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.has_request_token ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] text-ink-muted">{t("merge.pushPlaylist")}</span>
                <select
                  value={pushPlaylistId}
                  onChange={(e) => {
                    pushPlaylistTouchedRef.current = true;
                    setPushPlaylistId(e.target.value);
                  }}
                  disabled={!pushChannelId}
                  className="input-field w-full mt-1 cursor-pointer disabled:opacity-40"
                >
                  <option value="">{t("merge.pushPlaylistNone")}</option>
                  {pushPlaylists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.item_count})
                    </option>
                  ))}
                </select>
              </label>
              <div className="block sm:col-span-2">
                <span className="text-[12px] text-ink-muted">{t("merge.thumbnail")}</span>
                <div className="mt-1 flex items-center gap-3 flex-wrap">
                  <input
                    ref={thumbInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    className="hidden"
                    onChange={(e) => handleThumbSelect(e.target.files?.[0])}
                  />
                  {thumbPreviewUrl ? (
                    <img
                      src={thumbPreviewUrl}
                      alt=""
                      onError={() => setThumbPreviewUrl("")}
                      className="w-40 h-[90px] object-cover rounded-lg ring-1 ring-white/10 bg-white/[0.06]"
                    />
                  ) : (
                    <div className="w-40 h-[90px] rounded-lg ring-1 ring-white/10 bg-white/[0.04] flex items-center justify-center text-[11px] text-ink-light">
                      1280×720
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {thumbName && (
                      <span className="text-[11px] font-mono text-ink-muted truncate max-w-56">
                        {thumbName}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => thumbInputRef.current?.click()}
                        disabled={thumbUploading}
                        className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
                      >
                        {thumbUploading && <IconSpinner className="w-3.5 h-3.5" />}
                        {thumbUploading
                          ? t("merge.thumbnailUploading")
                          : thumbPath ? t("merge.thumbnailChange") : t("merge.thumbnailPick")}
                      </button>
                      {thumbPath && (
                        <button
                          onClick={clearThumb}
                          className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
                        >
                          {t("merge.thumbnailRemove")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {thumbError && <p className="mt-1.5 text-[12px] text-danger">{thumbError}</p>}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleMerge}
                disabled={orderedVideos.length < 2 || merging || !prepMatches}
                title={!prepMatches ? t("merge.needPrep") : undefined}
                className="btn-island-primary text-sm !px-5 !py-2.5 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {merging && <IconSpinner className="w-4 h-4" />}
                {merging ? `${mergeStage} ${mergePct}%` : t("merge.btnMerge")}
              </button>
              {merging && (
                <button
                  onClick={handleCancelMerge}
                  disabled={cancellingMerge}
                  className="btn-island-secondary text-sm !px-5 !py-2.5 disabled:opacity-40 cursor-pointer"
                >
                  {cancellingMerge ? t("merge.stopping") : t("merge.btnStop")}
                </button>
              )}
              {mergeResumable && !merging && (
                <>
                  <button
                    onClick={handleResumeMerge}
                    className="btn-island-secondary text-sm !px-5 !py-2.5 cursor-pointer"
                  >
                    {t("merge.resume")}
                  </button>
                  <span className="text-[12px] text-warn">{t("merge.interrupted")}</span>
                </>
              )}
              {mergeOutput && (
                <>
                  <a
                    href={mergeOutput}
                    download
                    className="btn-island-secondary text-sm !px-5 !py-2.5"
                  >
                    {t("merge.download")}{mergeSize > 0 ? ` (${fmtBytes(mergeSize)})` : ""}
                  </a>
                  <button
                    onClick={handlePush}
                    disabled={uploading || uploadDone}
                    className="btn-island-primary text-sm !px-5 !py-2.5 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {uploading && <IconSpinner className="w-4 h-4" />}
                    {uploadDone ? t("merge.pushed") : uploading ? `${t("merge.pushing")} ${uploadPct}%` : t("merge.btnPush")}
                  </button>
                </>
              )}
            </div>
            {merging && (
              <div className="mt-3 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${mergePct}%` }} />
              </div>
            )}
            {mergeError && <p className="mt-2 text-[12px] text-danger">{mergeError}</p>}
            {mergeStopped && <p className="mt-2 text-[12px] text-warn">{t("merge.stopped")}</p>}
            {uploading && (
              <div className="mt-3 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full bg-success transition-all" style={{ width: `${uploadPct}%` }} />
              </div>
            )}
            {uploadError && <p className="mt-2 text-[12px] text-danger">{uploadError}</p>}
            {uploadDone && <p className="mt-2 text-[12px] text-success">{t("merge.pushDone")}</p>}
            {uploadResumable && !uploading && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <p className="text-[12px] text-warn">{t("merge.interrupted")}</p>
                <button
                  onClick={handleResumeUpload}
                  className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
                >
                  {t("merge.resume")}
                </button>
              </div>
            )}
            {uploadJobId && !uploadDone && !uploadError && (
              <p className="mt-2 text-[11px] font-mono text-ink-light">upload job: {uploadJobId}</p>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {/* Modal chi tiết video: title + mô tả + nội dung file meta */}
      {detailVideo && (() => {
        // Meta gốc của video trên YouTube (title/description/tags).
        const metaObj = {
          title: detailVideo.title,
          description: detailVideo.description,
          tags: detailVideo.tags || [],
          hashtags: [],
        };
        const metaText = JSON.stringify(metaObj, null, 2);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setDetailVideo(null)}
          >
            <div
              className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto scrollbar-thin rounded-2xl bg-surface ring-1 ring-white/10 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 flex items-start justify-between gap-3 px-5 pt-4 pb-3 bg-surface/95 backdrop-blur border-b border-white/[0.07]">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  {t("merge.detailTitle")}
                </p>
                <button
                  onClick={() => setDetailVideo(null)}
                  className="icon-btn-ghost -mt-1 -mr-2"
                  aria-label={t("btn.cancel")}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="px-5 py-4 space-y-4">
                <div className="flex items-start gap-3">
                  {detailVideo.thumbnail && (
                    <img
                      src={detailVideo.thumbnail}
                      alt=""
                      className="w-32 h-[72px] object-cover rounded-lg flex-shrink-0 bg-white/[0.06]"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-ink leading-snug">
                      {detailVideo.title || "(no title)"}
                    </p>
                    <p className="text-[11px] text-ink-light font-mono mt-1 break-all">
                      {detailVideo.video_id}
                      {detailVideo.duration ? ` · ${detailVideo.duration}` : ""}
                    </p>
                    {(detailVideo.channel_title || detailVideo.published_at) && (
                      <p className="text-[11px] text-ink-muted mt-1">
                        {[detailVideo.channel_title, detailVideo.published_at?.slice(0, 10)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted mb-1.5">
                    {t("merge.descLabel")}
                  </p>
                  {detailVideo.description ? (
                    <p className="text-[12px] text-ink-muted leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto scrollbar-thin rounded-lg bg-white/[0.03] ring-1 ring-white/[0.07] p-3">
                      {detailVideo.description}
                    </p>
                  ) : (
                    <p className="text-[12px] text-ink-light">{t("merge.noDesc")}</p>
                  )}
                </div>

                {(detailVideo.tags?.length > 0) && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted mb-1.5">
                      {t("merge.tagsLabel")}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {detailVideo.tags.map((tag) => (
                        <span key={tag} className="tag">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                      {t("merge.metaJson")}
                    </p>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(metaText);
                        setMetaCopied(true);
                        setTimeout(() => setMetaCopied(false), 1500);
                      }}
                      className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
                    >
                      {metaCopied ? t("merge.copied") : t("merge.copy")}
                    </button>
                  </div>
                  <pre className="text-[11px] font-mono text-ink-muted leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto scrollbar-thin rounded-lg bg-black/40 ring-1 ring-white/[0.07] p-3">
                    {metaText}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
        </>
      )}
    </div>
  );
}
