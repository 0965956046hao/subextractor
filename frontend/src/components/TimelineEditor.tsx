"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  getSrtEntries,
  updateSrt,
  getVideoUrl,
  getSrtContent,
  getTranslatedDownloadUrl,
  getDubbedDownloadUrl,
  getJobStatus,
} from "@/lib/api";
import type { SrtEntry as ApiSrtEntry } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface SubtitleStyle {
  x: number;
  y: number;
  maxWidth: number;
  showBg: boolean;
  textAlign: "left" | "center" | "right";
  fontFamily: string;
  fontSize: number;
  textColor: string;
  bgColor: string;
  bgOpacity: number;
  bold: boolean;
  italic: boolean;
}

interface SrtEntry {
  index: number;
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
  text: string;
  style?: SubtitleStyle;
}

interface SubtitleTrack {
  id: string;
  name: string;
  entries: SrtEntry[];
}

const ASPECT_RATIOS: { label: string; value: string | null; ratio: number }[] =
  [
    { label: "Gốc", value: null, ratio: 0 },
    { label: "16:9", value: "16/9", ratio: 16 / 9 },
    { label: "9:16", value: "9/16", ratio: 9 / 16 },
    { label: "4:3", value: "4/3", ratio: 4 / 3 },
    { label: "1:1", value: "1/1", ratio: 1 },
    { label: "21:9", value: "21/9", ratio: 21 / 9 },
  ];

const DEFAULT_STYLE: SubtitleStyle = {
  x: 50,
  y: 93,
  maxWidth: 92,
  showBg: true,
  textAlign: "center",
  fontFamily: "Plus Jakarta Sans",
  fontSize: 16,
  textColor: "#ffffff",
  bgColor: "#000000",
  bgOpacity: 0.7,
  bold: false,
  italic: false,
};

const FONT_OPTIONS = [
  "Plus Jakarta Sans",
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "Verdana",
  "Tahoma",
];

type DragMode = "move" | "resize-start" | "resize-end" | null;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const PIXELS_PER_SECOND = 60;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  if (h > 0)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function fmtTimeShort(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function secToSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function parseTime(t: string): number {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(",");
  return (
    parseInt(h) * 3600 +
    parseInt(m) * 60 +
    parseInt(s) +
    parseInt(ms || "0") / 1000
  );
}

function entriesToSrt(entries: SrtEntry[]): string {
  return entries
    .map(
      (e, i) =>
        `${i + 1}\n${secToSrt(e.start)} --> ${secToSrt(e.end)}\n${e.text}\n`,
    )
    .join("\n");
}

let _trackCounter = 0;
function newTrackId(): string {
  return `track_${++_trackCounter}_${Date.now()}`;
}

function refStyleToPx(ref: SubtitleStyle, vw: number, vh: number): SubtitleStyle {
  return {
    ...ref,
    x: Math.round((ref.x / 100) * vw),
    y: Math.round((ref.y / 100) * vh),
  };
}

/* ------------------------------------------------------------------ */
/*  Inline SVG icons (thin-stroke, Phosphor-style)                    */
/* ------------------------------------------------------------------ */

function IconPlay({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconPause({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function IconAdd({ className = "w-3 h-3" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconChevronRight({ className = "w-3.5 h-3.5", open = false }) {
  return (
    <svg
      className={className}
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.4s cubic-bezier(0.32,0.72,0,1)",
      }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconClose({ className = "w-3.5 h-3.5" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconSpeaker({ className = "w-3.5 h-3.5", muted = false }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {muted ? (
        <>
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : (
        <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
      )}
    </svg>
  );
}

function IconSnap({ className = "w-3.5 h-3.5" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3h4l2 7-2 7H6l2-7-2-7z" />
      <path d="M13 3l3 7-3 7" />
      <line x1="3" y1="21" x2="21" y2="21" />
    </svg>
  );
}

function IconSettings({ className = "w-3.5 h-3.5" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function IconSpinner({ className = "w-4 h-4" }) {
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

function IconCheck({ className = "w-4 h-4" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconError({ className = "w-4 h-4" }) {
  return (
    <svg
      className={className}
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
  );
}

function IconDownload({ className = "w-4 h-4" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Mini helper components                                            */
/* ------------------------------------------------------------------ */

function PillButton({
  children,
  active = false,
  disabled = false,
  color = "blue",
  onClick,
  className = "",
  title,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  color?:
    | "blue"
    | "green"
    | "amber"
    | "cyan"
    | "violet"
    | "rose"
    | "red"
    | "slate";
  onClick?: () => void;
  className?: string;
  title?: string;
}) {
  const colors: Record<string, string> = {
    blue: active
      ? "bg-blue-600/10 text-blue-700 ring-blue-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    green: active
      ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    amber: active
      ? "bg-amber-500/10 text-amber-700 ring-amber-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    cyan: active
      ? "bg-cyan-500/10 text-cyan-700 ring-cyan-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    violet: active
      ? "bg-violet-500/10 text-violet-700 ring-violet-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    rose: active
      ? "bg-rose-500/10 text-rose-700 ring-rose-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    red: active
      ? "bg-red-500/10 text-red-700 ring-red-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
    slate: active
      ? "bg-slate-500/10 text-slate-700 ring-slate-500/25"
      : "bg-black/[0.02] text-ink-muted ring-black/[0.06] hover:bg-black/[0.04] hover:text-ink",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight ring-1 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${colors[color] || colors.blue} ${className}`}
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick,
  active = false,
  color = "slate",
  title,
  children,
  className = "",
}: {
  onClick?: () => void;
  active?: boolean;
  color?: "blue" | "red" | "slate" | "green" | "amber";
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const colors: Record<string, string> = {
    blue: active
      ? "bg-blue-500/10 text-blue-600 ring-1 ring-blue-500/25"
      : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06] hover:text-ink",
    red: active
      ? "bg-red-500/10 text-red-600 ring-1 ring-red-500/25"
      : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06] hover:text-ink",
    green: active
      ? "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/25"
      : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06] hover:text-ink",
    amber: active
      ? "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/25"
      : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06] hover:text-ink",
    slate:
      "bg-black/[0.03] text-ink-light hover:bg-black/[0.06] hover:text-ink",
  };
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.95] cursor-pointer ${colors[color] || colors.slate} ${className}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface TimelineEditorProps {
  videoId: string;
  duration?: number;
}

export default function TimelineEditor({
  videoId,
  duration: initialDuration = 0,
}: TimelineEditorProps) {
  /* ---- state ---- */
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(initialDuration || 0);

  const [zoom, setZoom] = useState(1.5);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [saved, setSaved] = useState(true);

  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dragState, setDragState] = useState<{
    trackId: string;
    index: number;
    mode: DragMode;
    startX: number;
    startY: number;
    origStart: number;
    origEnd: number;
  } | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    trackId: string;
    index: number;
    text: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [availableSrtFiles, setAvailableSrtFiles] = useState<
    { id: string; name: string }[]
  >([]);
  const [availableTtsFiles, setAvailableTtsFiles] = useState<
    { id: string; name: string }[]
  >([]);

  const [applyAll, setApplyAll] = useState(false);
  const [showStylePanel, setShowStylePanel] = useState(false);
  const [confirmDeleteTrack, setConfirmDeleteTrack] = useState<string | null>(
    null,
  );
  const [toolJob, setToolJob] = useState<{
    type: string;
    jobId: string;
    status: string;
    progress: number;
    error: string;
  } | null>(null);
  const [ttsClips, setTtsClips] = useState<
    { url: string; start: number; end: number; speed: number }[]
  >([]);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoVolume, setVideoVolume] = useState(1.0);
  const [ttsVoice, setTtsVoice] = useState("vi-VN-Standard-A");
  const [transSrcLang, setTransSrcLang] = useState("zh");
  const [transDstLang, setTransDstLang] = useState("vi");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsGeminiKey, setSettingsGeminiKey] = useState("");
  const [settingsTtsJson, setSettingsTtsJson] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [hasApiKeys, setHasApiKeys] = useState(false);
  const [ttsApplyAll, setTtsApplyAll] = useState(false);
  const [editingClipSpeed, setEditingClipSpeed] = useState<number | null>(null);
  const [ttsSpeedApplyAll, setTtsSpeedApplyAll] = useState(false);
  const [exportAspect, setExportAspect] = useState<string | null>(null);
  const [videoDims, setVideoDims] = useState({ w: 1920, h: 1080 });

  useEffect(() => {
    if (selectedIndex !== null) setShowStylePanel(true);
  }, [selectedIndex]);

  /* ---- refs ---- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  /* ---- derived ---- */
  const pixelsPerSec = PIXELS_PER_SECOND * zoom;
  const totalWidth = Math.max(duration * pixelsPerSec, 800);

  /* ---- load SRT entries ---- */
  const loadEntries = useCallback(async () => {
    try {
      const data = await getSrtEntries(videoId);
      const mapped: SrtEntry[] = data.map((e: ApiSrtEntry) => ({
        index: e.index,
        start: e.start,
        end: e.end,
        startLabel: e.startLabel,
        endLabel: e.endLabel,
        text: e.text,
      }));
      setTracks([{ id: newTrackId(), name: "Subtitle 1", entries: mapped }]);
      setLoading(false);
    } catch {
      try {
        const content = await getSrtContent(videoId);
        const blocks = content.trim().split(/\n\s*\n/);
        const parsed: SrtEntry[] = [];
        for (const block of blocks) {
          const lines = block.split("\n");
          const timeMatch = lines[1]?.match(/([\d:,]+)\s*-->\s*([\d:,]+)/);
          if (!timeMatch) continue;
          parsed.push({
            index: parsed.length + 1,
            start: parseTime(timeMatch[1]),
            end: parseTime(timeMatch[2]),
            startLabel: timeMatch[1],
            endLabel: timeMatch[2],
            text: lines.slice(2).join(" "),
          });
        }
        setTracks([{ id: newTrackId(), name: "Subtitle 1", entries: parsed }]);
        setLoading(false);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load subtitles",
        );
        setLoading(false);
      }
    }
  }, [videoId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  /* ---- load project state ---- */
  useEffect(() => {
    if (loading) return;
    fetch(`/api/project/${videoId}/load`)
      .then((r) => r.json())
      .then((d) => {
        let loaded = false;
        if (d.tracks?.length > 0) {
          setTracks(d.tracks);
          setSaved(true);
          loaded = true;
        }
        if (d.ttsClips?.length > 0) {
          console.log("Restoring ttsClips:", d.ttsClips);
          setTtsClips(d.ttsClips);
          loaded = true;
        }
        if (d.videoMuted !== undefined) {
          setVideoMuted(d.videoMuted);
          const v = videoRef.current;
          if (v) v.muted = d.videoMuted;
        }
        if (d.videoVolume !== undefined) {
          setVideoVolume(d.videoVolume);
          const v = videoRef.current;
          if (v) v.volume = d.videoVolume;
        }
        if (d.ttsVoice) setTtsVoice(d.ttsVoice);
        if (d.snapping !== undefined) setSnapping(d.snapping);
        if (d.zoom) setZoom(d.zoom);
        if (d.exportAspect !== undefined) setExportAspect(d.exportAspect);
        if (loaded) {
          setToast("Đã khôi phục cấu hình đã lưu");
          setTimeout(() => setToast(null), 2000);
        }
      })
      .catch(() => {});
  }, [loading, videoId]);

  /* ---- fetch available SRT files ---- */
  useEffect(() => {
    fetch(`/api/srt/${videoId}/available`)
      .then((r) => r.json())
      .then((d) => {
        if (d.files?.length > 1) setAvailableSrtFiles(d.files);
      })
      .catch(() => {});
  }, [videoId]);

  /* ---- check API config ---- */
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        setHasApiKeys(d.has_gemini_key && d.has_tts_credentials);
      })
      .catch(() => {});
  }, []);

  const openSettings = async () => {
    setShowSettings(true);
    setSettingsStatus("");
    try {
      const res = await fetch("/api/config");
      const d = await res.json();
      setSettingsGeminiKey(d.has_gemini_key ? "••••••••" : "");
    } catch {
      /* ignore */
    }
  };

  const saveSettings = async () => {
    setSettingsStatus("Đang lưu...");
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_api_key:
            settingsGeminiKey && settingsGeminiKey !== "••••••••"
              ? settingsGeminiKey
              : "",
          google_tts_json: settingsTtsJson || "",
        }),
      });
      const d = await res.json();
      if (d.error) {
        setSettingsStatus(d.error);
      } else {
        setSettingsStatus("Đã lưu!");
        setTimeout(() => {
          setShowSettings(false);
          setSettingsStatus("");
        }, 1500);
        setHasApiKeys(true);
      }
    } catch {
      setSettingsStatus("Lỗi kết nối");
    }
  };

  useEffect(() => {
    fetch(`/api/tts/${videoId}/available`)
      .then((r) => r.json())
      .then((d) => {
        if (d.files?.length) setAvailableTtsFiles(d.files);
      })
      .catch(() => {});
  }, [videoId]);

  const loadSrtFile = async (fileId: string, fileName: string) => {
    try {
      const res = await fetch(`/api/srt/${videoId}/load/${fileId}`);
      const data = await res.json();
      const parsed: SrtEntry[] = (data.entries as ApiSrtEntry[]).map(
        (e: ApiSrtEntry) => ({
          index: e.index,
          start: e.start,
          end: e.end,
          startLabel: e.startLabel,
          endLabel: e.endLabel,
          text: e.text,
        }),
      );
      if (parsed.length > 0) {
        const tid = newTrackId();
        setTracks((prev) => [
          ...prev,
          { id: tid, name: fileName, entries: parsed },
        ]);
        setSaved(false);
        setToast(`Đã tải ${parsed.length} phụ đề từ "${fileName}"`);
        setTimeout(() => setToast(null), 3000);
      }
    } catch {
      /* ignore */
    }
  };

  /* ---- video duration ---- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const updateDur = () => {
      if (v.duration && Number.isFinite(v.duration) && v.duration > 0)
        setDuration(v.duration);
      if (v.videoWidth && v.videoHeight)
        setVideoDims({ w: v.videoWidth, h: v.videoHeight });
    };
    if (v.readyState >= 1) updateDur();
    v.addEventListener("loadedmetadata", updateDur);
    v.addEventListener("durationchange", updateDur);
    return () => {
      v.removeEventListener("loadedmetadata", updateDur);
      v.removeEventListener("durationchange", updateDur);
    };
  }, []);

  /* ---- requestAnimationFrame for playhead ---- */
  useEffect(() => {
    const loop = () => {
      const v = videoRef.current;
      if (v) {
        setCurrentTime(v.currentTime);
        if (
          v.duration &&
          Number.isFinite(v.duration) &&
          v.duration > 0 &&
          Math.abs(v.duration - duration) > 0.5
        ) {
          setDuration(v.duration);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [duration]);

  /* ---- video event listeners ---- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, []);

  /* ---- TTS audio sync ---- */
  const ttsAudioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
  const [ttsActiveIndex, setTtsActiveIndex] = useState<number | null>(null);
  useEffect(() => {
    if (ttsClips.length === 0) return;
    setTtsActiveIndex(null);
    const check = () => {
      const v = videoRef.current;
      if (!v) return;
      const t = v.currentTime;
      const isPlaying = !v.paused;
      let found = false;
      ttsClips.forEach((clip, i) => {
        const active = t >= clip.start && t < clip.end;
        if (active && isPlaying) {
          found = true;
          setTtsActiveIndex(i);
          if (!ttsAudioRefs.current.has(i)) {
            const audio = new Audio(clip.url);
            audio.playbackRate = clip.speed;
            audio.currentTime = Math.max(0, t - clip.start);
            audio.play().catch(() => {});
            ttsAudioRefs.current.set(i, audio);
          }
        } else if (!isPlaying || !active) {
          const audio = ttsAudioRefs.current.get(i);
          if (audio) {
            audio.pause();
            ttsAudioRefs.current.delete(i);
          }
        }
      });
      if (!found) setTtsActiveIndex(null);
    };
    const interval = setInterval(check, 100);
    return () => {
      clearInterval(interval);
      ttsAudioRefs.current.forEach((a) => {
        a.pause();
      });
      ttsAudioRefs.current.clear();
      setTtsActiveIndex(null);
    };
  }, [ttsClips]);

  useEffect(() => {
    ttsAudioRefs.current.forEach((a, i) => {
      const clip = ttsClips[i];
      if (clip) a.playbackRate = clip.speed;
    });
  }, [ttsClips]);

  /* ---- keyboard shortcuts ---- */
  const togglePlayRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlayRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- poll tool job status ---- */
  useEffect(() => {
    if (
      !toolJob ||
      (toolJob.status !== "queued" && toolJob.status !== "processing")
    )
      return;
    const timer = setInterval(async () => {
      try {
        const st = await getJobStatus(toolJob.jobId);
        setToolJob((prev) =>
          prev
            ? {
                ...prev,
                status: st.status,
                progress: st.progress,
                error: st.error || "",
              }
            : prev,
        );
        if (st.status === "done") {
          clearInterval(timer);
          if (toolJob.type === "translate") {
            setToolJob((prev) =>
              prev ? { ...prev, status: "done", progress: 100 } : prev,
            );
            try {
              const res = await fetch(`/api/download/translated/${videoId}`);
              if (res.ok) {
                const text = await res.text();
                const blocks = text.trim().split(/\n\s*\n/);
                const parsed: SrtEntry[] = [];
                for (const block of blocks) {
                  const lines = block.split("\n");
                  const timeMatch = lines[1]?.match(
                    /([\d:,]+)\s*-->\s*([\d:,]+)/,
                  );
                  if (!timeMatch) continue;
                  parsed.push({
                    index: parsed.length + 1,
                    start: parseTime(timeMatch[1]),
                    end: parseTime(timeMatch[2]),
                    startLabel: timeMatch[1],
                    endLabel: timeMatch[2],
                    text: lines.slice(2).join(" "),
                  });
                }
                if (parsed.length > 0) {
                  const tid = newTrackId();
                  setTracks((prev) => [
                    ...prev,
                    { id: tid, name: `Việt (Gemini)`, entries: parsed },
                  ]);
                  setSaved(false);
                  setToast(`Đã tải ${parsed.length} phụ đề đã dịch`);
                  setTimeout(() => setToast(null), 3000);
                }
              }
            } catch {
              /* ignore */
            }
          }
          if (toolJob.type === "export") {
            setToolJob((prev) =>
              prev ? { ...prev, status: "done", progress: 100 } : prev,
            );
          }
          if (toolJob.type === "tts") {
            setToolJob((prev) =>
              prev ? { ...prev, status: "done", progress: 100 } : prev,
            );
            const track = selectedTrack
              ? tracks.find((t) => t.id === selectedTrack)
              : tracks[0];
            if (track) {
              const voiceKey = ttsVoice.replace(/-/g, "_");
              const clips = track.entries.map((entry, i) => ({
                url: `/api/tts-audio/${videoId}/${voiceKey}/${String(i + 1).padStart(4, "0")}.mp3`,
                start: entry.start,
                end: entry.end,
                speed: 1.0,
              }));
              setTtsClips(clips);
              setToast(
                `Đã tải ${clips.length} audio clip vào timeline. Click để chỉnh tốc độ.`,
              );
              setTimeout(() => setToast(null), 3000);
            }
          }
        }
        if (st.status === "error") {
          clearInterval(timer);
        }
      } catch {
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [toolJob, videoId, tracks.length]);

  /* ---- save SRT ---- */
  const saveSrt = useCallback(async () => {
    if (saved) return;
    try {
      const allEntries = tracks.flatMap((t) => t.entries);
      await updateSrt(videoId, entriesToSrt(allEntries));
      await fetch(`/api/project/${videoId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks,
          ttsClips: ttsClips.map((c) => ({
            url: c.url,
            start: c.start,
            end: c.end,
            speed: c.speed,
          })),
          videoMuted,
          videoVolume,
          ttsVoice,
          snapping,
          zoom,
          applyAll,
          exportAspect,
        }),
      });
      console.log("Saved project with ttsClips:", ttsClips.length);
      setSaved(true);
    } catch {
      /* silent */
    }
  }, [
    tracks,
    videoId,
    saved,
    ttsClips,
    videoMuted,
    ttsVoice,
    snapping,
    zoom,
    applyAll,
    exportAspect,
  ]);

  /* ---- helpers ---- */
  const getTrackEntries = (trackId: string): SrtEntry[] =>
    tracks.find((t) => t.id === trackId)?.entries ?? [];

  /* ---- actions ---- */
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play?.().catch(() => {});
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };
  togglePlayRef.current = togglePlay;

  const seekTimeline = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    const t = Math.max(0, Math.min(duration, x / pixelsPerSec));
    const v = videoRef.current;
    if (v) {
      v.currentTime = t;
      setCurrentTime(t);
    }
  };

  /* ---- drag helpers ---- */
  const startDrag = useCallback(
    (
      trackId: string,
      index: number,
      mode: DragMode,
      clientX: number,
      clientY: number,
    ) => {
      const e = tracks.find((t) => t.id === trackId)?.entries[index];
      if (!e) return;
      setDragState({
        trackId,
        index,
        mode,
        startX: clientX,
        startY: clientY,
        origStart: e.start,
        origEnd: e.end,
      });
      setSelectedTrack(trackId);
      setSelectedIndex(index);
    },
    [tracks],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragState) return;

      if (dragState.mode === "move") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const row = el?.closest?.("[data-track-id]") as HTMLElement | null;
        const overId = row?.dataset.trackId ?? null;
        setDragOverTrackId(
          overId && overId !== dragState.trackId ? overId : null,
        );
      }

      const dx = (e.clientX - dragState.startX) / pixelsPerSec;
      setTracks((prev) =>
        prev.map((track) => {
          if (track.id !== dragState.trackId) return track;
          const next = [...track.entries];
          const entry = { ...next[dragState.index] };
          if (!entry) return track;

          let newStart = entry.start;
          let newEnd = entry.end;
          const minDur = 0.1;

          if (dragState.mode === "move") {
            const dur = dragState.origEnd - dragState.origStart;
            newStart = Math.max(0, dragState.origStart + dx);
            newEnd = newStart + dur;
          } else if (dragState.mode === "resize-start") {
            newStart = Math.max(
              0,
              Math.min(dragState.origStart + dx, entry.end - minDur),
            );
          } else if (dragState.mode === "resize-end") {
            newEnd = Math.max(entry.start + minDur, dragState.origEnd + dx);
          }

          if (snapping && dragState.mode !== "move") {
            const snapThreshold = 0.3 / zoom;
            const targets: number[] = [0];
            if (dragState.mode === "resize-start") targets.push(entry.end);
            if (dragState.mode === "resize-end") targets.push(entry.start);
            next.forEach((o, i) => {
              if (i !== dragState.index) {
                targets.push(o.start, o.end);
              }
            });
            const target = dragState.mode === "resize-end" ? newEnd : newStart;
            for (const t of targets) {
              if (Math.abs(target - t) < snapThreshold) {
                if (dragState.mode === "resize-end") newEnd = t;
                else newStart = t;
                break;
              }
            }
          }

          entry.start = newStart;
          entry.end = newEnd;
          entry.startLabel = secToSrt(newStart);
          entry.endLabel = secToSrt(newEnd);
          next[dragState.index] = entry;
          return { ...track, entries: next };
        }),
      );
    },
    [dragState, pixelsPerSec, snapping, zoom],
  );

  const endDrag = useCallback(() => {
    if (!dragState) return;
    if (dragState.mode === "move" && dragOverTrackId) {
      setTracks((prev) => {
        const srcTrack = prev.find((t) => t.id === dragState.trackId);
        const dstTrack = prev.find((t) => t.id === dragOverTrackId);
        if (!srcTrack || !dstTrack) return prev;
        const entry = srcTrack.entries[dragState.index];
        if (!entry) return prev;
        return prev.map((t) => {
          if (t.id === dragState.trackId) {
            return {
              ...t,
              entries: t.entries
                .filter((_, i) => i !== dragState.index)
                .map((e, i) => ({ ...e, index: i + 1 })),
            };
          }
          if (t.id === dragOverTrackId) {
            const insertAt = t.entries.findIndex((e) => e.start > entry.start);
            const idx = insertAt === -1 ? t.entries.length : insertAt;
            const next = [...t.entries];
            next.splice(idx, 0, entry);
            return {
              ...t,
              entries: next.map((e, i) => ({ ...e, index: i + 1 })),
            };
          }
          return t;
        });
      });
      setSelectedTrack(dragOverTrackId);
      setSelectedIndex(null);
    }
    setSaved(false);
    setDragState(null);
    setDragOverTrackId(null);
  }, [dragState, dragOverTrackId]);

  useEffect(() => {
    if (!dragState) return;
    const onUp = () => endDrag();
    const onMove = (e: PointerEvent) => onPointerMove(e);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragState, endDrag, onPointerMove]);

  /* ---- track management ---- */
  const addTrack = () => {
    const id = newTrackId();
    const num = tracks.length + 1;
    setTracks((prev) => [
      ...prev,
      { id, name: `Subtitle ${num}`, entries: [] },
    ]);
    setSaved(false);
  };

  const runToolJob = async (type: "translate" | "tts" | "export") => {
    try {
      if (type === "export") {
        const res = await fetch(`/api/export/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks, ttsClips: ttsClips }),
        });
        const data = await res.json();
        setToolJob({
          type,
          jobId: data.job_id,
          status: data.status,
          progress: data.progress,
          error: data.error || "",
        });
        return;
      }
      const track = selectedTrack
        ? tracks.find((t) => t.id === selectedTrack)
        : tracks[0] || null;
      if (!track || track.entries.length === 0) {
        setToast("Hãy chọn 1 track có phụ đề trước khi thực hiện.");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      const srtContent = entriesToSrt(track.entries);
      const trackName = track.name;

      if (type === "tts") {
        const res = await fetch(`/api/tts/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            srt_content: srtContent,
            track_name: trackName,
            voice: ttsVoice,
          }),
        });
        const data = await res.json();
        setToolJob({
          type,
          jobId: data.job_id,
          status: data.status,
          progress: data.progress,
          error: data.error || "",
        });
      } else if (type === "translate") {
        const res = await fetch(`/api/translate/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            srt_content: srtContent,
            track_name: trackName,
            source_lang: transSrcLang,
            target_lang: transDstLang,
          }),
        });
        const data = await res.json();
        setToolJob({
          type,
          jobId: data.job_id,
          status: data.status,
          progress: data.progress,
          error: data.error || "",
        });
      }
    } catch {
      /* handled by state */
    }
  };

  const deleteTrack = (trackId: string) => {
    if (tracks.length <= 1) return;
    const track = tracks.find((t) => t.id === trackId);
    const hasEntries = track && track.entries.length > 0;
    if (hasEntries) {
      setConfirmDeleteTrack(trackId);
      return;
    }
    doDeleteTrack(trackId);
  };

  const doDeleteTrack = (trackId: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
    if (selectedTrack === trackId) {
      setSelectedTrack(null);
      setSelectedIndex(null);
    }
    setSaved(false);
    setConfirmDeleteTrack(null);
  };

  const renameTrack = (trackId: string, name: string) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, name } : t)),
    );
    setSaved(false);
  };

  /* ---- entry management ---- */
  const addEntry = () => {
    if (!selectedTrack) return;
    const track = tracks.find((t) => t.id === selectedTrack);
    if (!track) return;
    const start = currentTime;
    const end = Math.min(start + 3, duration);
    const newEntry: SrtEntry = {
      index: track.entries.length + 1,
      start,
      end,
      startLabel: secToSrt(start),
      endLabel: secToSrt(end),
      text: "",
    };
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== selectedTrack) return t;
        const insertAt = t.entries.findIndex((e) => e.start > start);
        const idx = insertAt === -1 ? t.entries.length : insertAt;
        const next = [...t.entries];
        next.splice(idx, 0, newEntry);
        return { ...t, entries: next.map((e, i) => ({ ...e, index: i + 1 })) };
      }),
    );
    setSaved(false);
  };

  const commitEdit = (text: string) => {
    if (!editing) return;
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== editing.trackId) return t;
        const next = [...t.entries];
        next[editing.index] = { ...next[editing.index], text };
        return { ...t, entries: next };
      }),
    );
    setSaved(false);
    setEditing(null);
  };

  const deleteEntry = (trackId: string, index: number) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        return { ...t, entries: t.entries.filter((_, i) => i !== index) };
      }),
    );
    setSaved(false);
    if (selectedTrack === trackId && selectedIndex === index) {
      setSelectedIndex(null);
    }
  };

  /* ---- style helpers ---- */
  const getEntryStyle = (trackId: string, index: number): SubtitleStyle => {
    return (
      tracks.find((t) => t.id === trackId)?.entries[index]?.style ??
      refStyleToPx(DEFAULT_STYLE, videoDims.w, videoDims.h)
    );
  };

  const updateStyle = (
    key: keyof SubtitleStyle,
    value: string | number | boolean,
  ) => {
    if (selectedTrack === null || selectedIndex === null) return;
    setTracks((prev) =>
      prev.map((track) => {
        if (track.id !== selectedTrack) return track;
        const next = [...track.entries];
        if (applyAll) {
          for (let i = 0; i < next.length; i++) {
            next[i] = {
              ...next[i],
              style: { ...getEntryStyle(track.id, i), [key]: value },
            };
          }
        } else {
          next[selectedIndex] = {
            ...next[selectedIndex],
            style: { ...getEntryStyle(track.id, selectedIndex), [key]: value },
          };
        }
        return { ...track, entries: next };
      }),
    );
    setSaved(false);
  };

  const getCurrentStyle = (): SubtitleStyle => {
    if (selectedTrack !== null && selectedIndex !== null) {
      return getEntryStyle(selectedTrack, selectedIndex);
    }
    return refStyleToPx(DEFAULT_STYLE, videoDims.w, videoDims.h);
  };

  /* ---- all entries across all tracks (for video overlay) ---- */
  const allActive = tracks.flatMap((track) =>
    track.entries
      .filter((e) => currentTime >= e.start && currentTime < e.end)
      .map((e) => ({ ...e, _trackId: track.id })),
  );

  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  const pxToPctX = (px: number) => `${((px / videoDims.w) * 100).toFixed(4)}%`;
  const pxToPctY = (px: number) => `${((px / videoDims.h) * 100).toFixed(4)}%`;
  const pxToPctValX = (px: number) => (px / videoDims.w) * 100;
  const pxToPctValY = (px: number) => (px / videoDims.h) * 100;

  /* ---- render ---- */
  if (loading) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-16 flex flex-col items-center justify-center gap-4">
          <IconSpinner className="w-6 h-6 text-blue-500" />
          <span className="text-sm text-ink-muted">Đang tải timeline...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-10 flex flex-col items-center gap-4">
          <div className="flex items-start gap-3 p-5 rounded-2xl bg-red-500/8 ring-1 ring-red-500/15 max-w-md">
            <IconError className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-600/80">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner flex flex-col overflow-hidden relative">
        {/* ================================================================ */}
        {/*  Toolbar — Two-row professional layout                          */}
        {/* ================================================================ */}

        {/* Row 1 — Transport Bar: playback, zoom, save */}
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2 flex-wrap select-none">
          {/* Left cluster: Transport controls */}
          <div className="flex items-center gap-1 p-1 rounded-full bg-black/[0.03] ring-1 ring-black/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
            <button
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="group relative w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-500 shadow-sm active:scale-[0.95] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer flex-shrink-0"
            >
              {playing ? (
                <IconPause className="w-3.5 h-3.5" />
              ) : (
                <IconPlay className="w-3.5 h-3.5 ml-0.5" />
              )}
            </button>
            <div className="w-px h-5 bg-black/[0.06]" />
            <IconButton
              onClick={() => {
                const v = videoRef.current;
                if (v) {
                  v.muted = !v.muted;
                  setVideoMuted(v.muted);
                }
              }}
              active={videoMuted}
              color={videoMuted ? "red" : "slate"}
              title={videoMuted ? "Bật tiếng" : "Tắt tiếng video gốc"}
            >
              <IconSpeaker muted={videoMuted} className="w-3.5 h-3.5" />
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={videoVolume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setVideoVolume(v);
                const vid = videoRef.current;
                if (vid) {
                  vid.volume = v;
                  vid.muted = false;
                  setVideoMuted(false);
                }
              }}
              className="w-12 h-1 accent-blue-600 cursor-pointer mx-1"
              title={`Âm lượng: ${Math.round(videoVolume * 100)}%`}
            />
            <span className="text-[11px] font-mono tabular-nums text-ink-muted min-w-[100px] tracking-tight">
              {fmtTime(currentTime)}{" "}
              <span className="text-ink-light/50 mx-0.5">/</span>{" "}
              {fmtTime(duration)}
            </span>
            <div className="w-px h-5 bg-black/[0.06]" />
            <IconButton
              onClick={() => setSnapping(!snapping)}
              active={snapping}
              color={snapping ? "blue" : "slate"}
              title="Bắt điểm (Snapping)"
            >
              <IconSnap className="w-3.5 h-3.5" />
            </IconButton>
          </div>

          {/* Right cluster: Zoom + Save + Settings */}
          <div className="flex items-center gap-2">
            {/* Zoom */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.02] ring-1 ring-black/[0.04]">
              <button
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs text-ink-muted hover:bg-black/[0.04] hover:text-ink transition-all duration-300 cursor-pointer"
              >
                −
              </button>
              <input
                type="range"
                min={0.25}
                max={6}
                step={0.25}
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="w-14 h-1 accent-blue-600 cursor-pointer"
              />
              <button
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))}
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs text-ink-muted hover:bg-black/[0.04] hover:text-ink transition-all duration-300 cursor-pointer"
              >
                +
              </button>
              <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-center">
                {zoom.toFixed(1)}x
              </span>
            </div>

            <div className="w-px h-5 bg-black/[0.08]" />

            <IconButton
              onClick={openSettings}
              active={hasApiKeys}
              color={hasApiKeys ? "green" : "amber"}
              title="Cấu hình API Keys"
            >
              <IconSettings className="w-3.5 h-3.5" />
            </IconButton>

            {/* Save — Primary CTA with Button-in-Button */}
            <button
              onClick={saveSrt}
              disabled={saved}
              className={`group inline-flex items-center gap-2.5 pl-5 pr-2 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                saved
                  ? "bg-black/[0.02] text-ink-light ring-1 ring-black/[0.04]"
                  : "bg-blue-600 text-white hover:bg-blue-500 shadow-sm"
              }`}
            >
              <span>{saved ? "Đã lưu" : "Lưu thay đổi"}</span>
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:scale-105 ${
                  saved
                    ? "bg-black/[0.05] text-ink-light"
                    : "bg-white/20 text-white group-hover:bg-white/30"
                }`}
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
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
              </span>
            </button>
          </div>
        </div>

        {/* Row 2 — Tools Palette */}
        <div className="flex items-center justify-between gap-3 px-5 pb-3 flex-wrap select-none">
          {/* Left: Track + Subtitle management */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <PillButton onClick={addTrack} color="green">
              <IconAdd /> Thêm track
            </PillButton>
            <PillButton
              onClick={addEntry}
              disabled={!selectedTrack}
              color="amber"
            >
              <IconAdd /> Thêm phụ đề
            </PillButton>
            {availableSrtFiles.length > 0 && (
              <select
                onChange={(e) => {
                  const file = availableSrtFiles.find(
                    (f) => f.id === e.target.value,
                  );
                  if (file) loadSrtFile(file.id, file.name);
                  e.target.value = "";
                }}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-indigo-500/8 text-indigo-700 ring-1 ring-indigo-500/20 hover:bg-indigo-500/15 transition-all duration-300 cursor-pointer appearance-none pr-7"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234338ca' opacity='0.5'/%3E%3C/svg%3E\")",
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 8px center",
                }}
              >
                <option value="">📂 Tải file SRT...</option>
                {availableSrtFiles.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
            {availableTtsFiles.length > 0 && (
              <select
                onChange={async (e) => {
                  const file = availableTtsFiles.find(
                    (f) => f.id === e.target.value,
                  );
                  e.target.value = "";
                  if (!file) return;
                  const track = selectedTrack
                    ? tracks.find((t) => t.id === selectedTrack)
                    : tracks[0];
                  if (track) {
                    const subdir = file.id === "legacy" ? "" : file.id + "/";
                    const clips = track.entries.map((entry, i) => ({
                      url: `/api/tts-audio/${videoId}/${subdir}${String(i + 1).padStart(4, "0")}.mp3`,
                      start: entry.start,
                      end: entry.end,
                      speed: 1.0,
                    }));
                    setTtsClips(clips);
                    setToast(`Đã tải ${clips.length} audio clip vào timeline`);
                    setTimeout(() => setToast(null), 3000);
                  }
                }}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-cyan-500/8 text-cyan-700 ring-1 ring-cyan-500/20 hover:bg-cyan-500/15 transition-all duration-300 cursor-pointer appearance-none pr-7"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%230895b0' opacity='0.5'/%3E%3C/svg%3E\")",
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 8px center",
                }}
              >
                <option value="">🎙️ Tải TTS...</option>
                {availableTtsFiles.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Right: AI tools — Translate, TTS, Export */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Translation cluster */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-violet-500/[0.05] ring-1 ring-violet-500/[0.12]">
              <select
                value={transSrcLang}
                onChange={(e) => setTransSrcLang(e.target.value)}
                className="rounded-full bg-transparent px-2 py-1 text-[10px] text-violet-600/70 font-medium cursor-pointer outline-none"
              >
                <option value="zh">Trung</option>
                <option value="en">Anh</option>
                <option value="ja">Nhật</option>
                <option value="ko">Hàn</option>
              </select>
              <span className="text-[10px] text-violet-400">→</span>
              <select
                value={transDstLang}
                onChange={(e) => setTransDstLang(e.target.value)}
                className="rounded-full bg-transparent px-2 py-1 text-[10px] text-violet-600/70 font-medium cursor-pointer outline-none"
              >
                <option value="vi">Việt</option>
                <option value="en">Anh</option>
                <option value="zh">Trung</option>
              </select>
            </div>
            <PillButton
              onClick={() => runToolJob("translate")}
              disabled={!!toolJob}
              color="violet"
            >
              Dịch (Gemini)
            </PillButton>

            <div className="w-px h-4 bg-black/[0.06] mx-0.5" />

            {/* TTS cluster */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-cyan-500/[0.05] ring-1 ring-cyan-500/[0.12]">
              <span className="text-[9px] text-cyan-600/60 ml-1 font-medium">
                Giọng
              </span>
              <select
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                className="rounded-full bg-transparent px-1.5 py-1 text-[10px] text-cyan-600/70 font-medium cursor-pointer outline-none"
              >
                <option value="vi-VN-Standard-A">Nữ A</option>
                <option value="vi-VN-Standard-B">Nam B</option>
                <option value="vi-VN-Standard-C">Nữ C</option>
                <option value="vi-VN-Standard-D">Nam D</option>
                <option value="vi-VN-Wavenet-A">WaveNet Nữ A</option>
                <option value="vi-VN-Wavenet-B">WaveNet Nam B</option>
                <option value="vi-VN-Wavenet-C">WaveNet Nữ C</option>
                <option value="vi-VN-Wavenet-D">WaveNet Nam D</option>
              </select>
            </div>
            <PillButton
              onClick={() => runToolJob("tts")}
              disabled={!!toolJob}
              color="cyan"
            >
              Lồng tiếng
            </PillButton>

            <div className="w-px h-4 bg-black/[0.06] mx-0.5" />

            <PillButton
              onClick={() => runToolJob("export")}
              disabled={!!toolJob}
              color="rose"
            >
              Xuất video
            </PillButton>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Job progress banner                                             */}
        {/* ================================================================ */}
        {toolJob && (
          <div className="mx-5 mb-3 p-3 rounded-2xl bg-gradient-to-r from-blue-500/[0.05] to-transparent ring-1 ring-blue-500/[0.08] flex items-center gap-3">
            {toolJob.status === "queued" || toolJob.status === "processing" ? (
              <>
                <IconSpinner className="w-4 h-4 text-blue-500 flex-shrink-0" />
                <span className="text-[11px] font-medium text-ink-muted flex-1">
                  {toolJob.type === "translate"
                    ? "Đang dịch với Gemini..."
                    : toolJob.type === "tts"
                      ? "Đang tổng hợp giọng nói..."
                      : "Đang xuất video..."}
                </span>
                <div className="w-28 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
                    style={{ width: `${Math.max(3, toolJob.progress)}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-right">
                  {toolJob.progress}%
                </span>
              </>
            ) : toolJob.status === "done" ? (
              <>
                <IconCheck className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                <span className="text-[11px] font-medium text-emerald-700 flex-1">
                  {toolJob.type === "translate"
                    ? "Dịch hoàn tất"
                    : toolJob.type === "tts"
                      ? "Lồng tiếng hoàn tất"
                      : "Xuất video hoàn tất"}
                </span>
                {toolJob.type === "translate" ? (
                  <a
                    href={getTranslatedDownloadUrl(videoId)}
                    download
                    className="px-3 py-1 rounded-full text-[11px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer"
                  >
                    Tải SRT Việt
                  </a>
                ) : toolJob.type === "export" ? (
                  <a
                    href={`/api/download/exported/${videoId}`}
                    download
                    className="px-3 py-1 rounded-full text-[11px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer"
                  >
                    Tải Video
                  </a>
                ) : (
                  <span className="text-[10px] text-cyan-600/70">
                    Click 🎙️ trên TTS track để nghe
                  </span>
                )}
              </>
            ) : (
              <>
                <IconError className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span className="text-[11px] font-medium text-red-600/80 flex-1">
                  {toolJob.error || "Thất bại"}
                </span>
              </>
            )}
            <button
              onClick={() => setToolJob(null)}
              className="w-5 h-5 rounded-full bg-black/[0.04] flex items-center justify-center hover:bg-black/[0.08] transition-colors cursor-pointer"
            >
              <IconClose className="w-2.5 h-2.5 text-ink-muted" />
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/*  Video Preview — Nested Double-Bezel + Aspect Ratio              */}
        {/* ================================================================ */}
        <div className="mx-5 mt-1">
          <div className="p-1.5 rounded-[1.5rem] bg-black/[0.04] ring-1 ring-black/[0.05]">
            <div
              className="relative bg-black rounded-[calc(1.5rem-0.375rem)] overflow-hidden max-h-[400px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
              style={{
                aspectRatio: exportAspect || undefined,
                maxWidth: exportAspect
                  ? `${400 * (ASPECT_RATIOS.find((r) => r.value === exportAspect)?.ratio ?? 16 / 9)}px`
                  : undefined,
                margin: exportAspect ? "0 auto" : undefined,
              }}
            >
              <video
                ref={videoRef}
                src={getVideoUrl(videoId)}
                className={`w-full h-full ${exportAspect ? "object-cover" : "object-contain"}`}
                playsInline
                preload="auto"
              />
              {allActive.map((entry, i) => {
                const s = entry.style ?? refStyleToPx(DEFAULT_STYLE, videoDims.w, videoDims.h);
                return (
                  <div
                    key={`${entry._trackId}-${i}`}
                    className="absolute inset-0 pointer-events-none"
                  >
                    <div
                      className={`absolute text-center rounded-xl px-3.5 py-1.5 pointer-events-auto cursor-grab active:cursor-grabbing group/vidtext ${
                        s.showBg ? "shadow-lg" : ""
                      }`}
                      style={{
                        left: pxToPctX(s.x),
                        top: pxToPctY(s.y),
                        maxWidth: `${s.maxWidth}%`,
                        transform: `translate(-50%, -50%) translateY(${i * 60}px)`,
                        animation: "fade-in 0.25s ease forwards",
                        backgroundColor: s.showBg
                          ? hexToRgba(s.bgColor, s.bgOpacity)
                          : "transparent",
                        backdropFilter: s.showBg ? "blur(8px)" : "none",
                      }}
                      onPointerDown={(e) => {
                        const el = e.currentTarget as HTMLElement;
                        const relX =
                          e.clientX - el.getBoundingClientRect().left;
                        const isResize = relX > el.offsetWidth - 12 && s.showBg;
                        if (isResize) {
                          e.preventDefault();
                          e.stopPropagation();
                          const origW = s.maxWidth;
                          const parent = el.parentElement;
                          if (!parent) return;
                          const rect = parent.getBoundingClientRect();
                          el.setPointerCapture(e.pointerId);
                          const onMove = (ev: PointerEvent) => {
                            const dxPct =
                              ((ev.clientX - e.clientX) / rect.width) * 100;
                            const nw = Math.max(
                              15,
                              Math.min(95, origW + dxPct * 2),
                            );
                            setTracks((prev) =>
                              prev.map((t) => {
                                if (t.id !== entry._trackId) return t;
                                const next = [...t.entries];
                                if (applyAll) {
                                  for (let i = 0; i < next.length; i++) {
                                    next[i] = {
                                      ...next[i],
                                      style: {
                                        ...(next[i].style ?? DEFAULT_STYLE),
                                        maxWidth: Math.round(nw),
                                      },
                                    };
                                  }
                                } else {
                                  const idx = t.entries.findIndex(
                                    (en) => en.index === entry.index,
                                  );
                                  if (idx < 0) return t;
                                  next[idx] = {
                                    ...next[idx],
                                    style: {
                                      ...(next[idx].style ?? DEFAULT_STYLE),
                                      maxWidth: Math.round(nw),
                                    },
                                  };
                                }
                                return { ...t, entries: next };
                              }),
                            );
                            setSaved(false);
                          };
                          const onUp = () => {
                            window.removeEventListener("pointermove", onMove);
                            window.removeEventListener("pointerup", onUp);
                            if (applyAll) {
                              const count =
                                tracks.find((t) => t.id === entry._trackId)
                                  ?.entries.length ?? 0;
                              setToast(
                                `Đã cập nhật vị trí cho ${count} phụ đề`,
                              );
                              setTimeout(() => setToast(null), 2500);
                            }
                          };
                          window.addEventListener("pointermove", onMove);
                          window.addEventListener("pointerup", onUp);
                          return;
                        }
                        e.preventDefault();
                        const parent = (e.currentTarget as HTMLElement)
                          .parentElement;
                        if (!parent) return;
                        const rect = parent.getBoundingClientRect();
                        const trackId = entry._trackId;
                        const entIdx =
                          tracks
                            .find((t) => t.id === trackId)
                            ?.entries.findIndex(
                              (en) => en.index === entry.index,
                            ) ?? -1;
                        if (entIdx < 0) return;
                        const origX = s.x;
                        const origY = s.y;
                        (e.currentTarget as HTMLElement).setPointerCapture(
                          e.pointerId,
                        );
                        const onMove = (ev: PointerEvent) => {
                          const dxPx =
                            ((ev.clientX - e.clientX) / rect.width) * videoDims.w;
                          const dyPx =
                            ((ev.clientY - e.clientY) / rect.height) * videoDims.h;
                          const nx = Math.round(
                            Math.max(0, Math.min(videoDims.w, origX + dxPx)),
                          );
                          const ny = Math.round(
                            Math.max(0, Math.min(videoDims.h, origY + dyPx)),
                          );
                          setTracks((prev) =>
                            prev.map((t) => {
                              if (t.id !== trackId) return t;
                              const next = [...t.entries];
                              if (applyAll) {
                                for (let i = 0; i < next.length; i++) {
                                  next[i] = {
                                    ...next[i],
                                    style: {
                                      ...(next[i].style ?? DEFAULT_STYLE),
                                      x: Math.round(nx),
                                      y: Math.round(ny),
                                    },
                                  };
                                }
                              } else {
                                next[entIdx] = {
                                  ...next[entIdx],
                                  style: {
                                    ...(next[entIdx].style ?? DEFAULT_STYLE),
                                    x: Math.round(nx),
                                    y: Math.round(ny),
                                  },
                                };
                              }
                              return { ...t, entries: next };
                            }),
                          );
                          setSaved(false);
                        };
                        const onUp = () => {
                          window.removeEventListener("pointermove", onMove);
                          window.removeEventListener("pointerup", onUp);
                          if (applyAll) {
                            const count =
                              tracks.find((t) => t.id === trackId)?.entries
                                .length ?? 0;
                            setToast(
                              `Đã cập nhật vị trí cho ${count} phụ đề trong track`,
                            );
                            setTimeout(() => setToast(null), 2500);
                          }
                        };
                        window.addEventListener("pointermove", onMove);
                        window.addEventListener("pointerup", onUp);
                      }}
                    >
                      <div
                        className={`absolute -top-2 left-1/2 -translate-x-1/2 flex gap-[2px] ${s.showBg ? "opacity-40" : "opacity-70"}`}
                      >
                        <div
                          className={`w-1 h-1 rounded-full ${s.showBg ? "bg-white" : "bg-gray-400"}`}
                        />
                        <div
                          className={`w-1 h-1 rounded-full ${s.showBg ? "bg-white" : "bg-gray-400"}`}
                        />
                        <div
                          className={`w-1 h-1 rounded-full ${s.showBg ? "bg-white" : "bg-gray-400"}`}
                        />
                      </div>

                      {s.showBg && (
                        <div className="absolute right-0 top-0 bottom-0 w-[10px] cursor-ew-resize hover:bg-white/10 rounded-r-xl flex items-center justify-center opacity-0 group-hover/vidtext:opacity-100 transition-opacity">
                          <div className="flex gap-[1.5px]">
                            <div className="w-[1.5px] h-4 rounded-full bg-white/50" />
                            <div className="w-[1.5px] h-4 rounded-full bg-white/50" />
                          </div>
                        </div>
                      )}
                      <p
                        style={{
                          color: s.textColor,
                          fontFamily: s.fontFamily,
                          fontSize: `${s.fontSize}px`,
                          fontWeight: s.bold ? 700 : 400,
                          fontStyle: s.italic ? "italic" : "normal",
                          textAlign: s.textAlign,
                          lineHeight: 1.4,
                          letterSpacing: "0.02em",
                          textShadow: s.showBg
                            ? "none"
                            : "0 1px 4px rgba(0,0,0,0.5)",
                        }}
                      >
                        {entry.text}
                      </p>
                    </div>
                  </div>
                );
              })}
              {allActive.length === 0 && !playing && (
                <button
                  onClick={togglePlay}
                  aria-label="Play"
                  className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm border border-white/15 flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-95 cursor-pointer"
                >
                  <IconPlay className="w-6 h-6 text-white ml-1" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Aspect Ratio selector */}
        <div className="mx-5 mt-2 flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-[0.15em] text-ink-light font-medium">
            Tỷ lệ
          </span>
          <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.02] ring-1 ring-black/[0.04]">
            {ASPECT_RATIOS.map((ar) => (
              <button
                key={ar.label}
                onClick={() => {
                  setExportAspect(ar.value);
                  setSaved(false);
                }}
                className={`px-3 py-1 rounded-full text-[10px] font-medium tracking-tight transition-all duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.95] cursor-pointer whitespace-nowrap ${
                  exportAspect === ar.value
                    ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                    : "text-ink-light hover:text-ink hover:bg-black/[0.03]"
                }`}
              >
                {ar.label}
              </button>
            ))}
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Playback Seek Bar — Glass Island                                */}
        {/* ================================================================ */}
        <div className="mx-5 mt-3 rounded-2xl bg-white/80 ring-1 ring-black/[0.05] shadow-[0_2px_12px_rgba(0,0,0,0.03)] px-4 py-3 flex items-center gap-3">
          <button
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="group w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-500 shadow-sm active:scale-[0.95] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer flex-shrink-0"
          >
            {playing ? (
              <IconPause className="w-3.5 h-3.5" />
            ) : (
              <IconPlay className="w-3.5 h-3.5 ml-0.5" />
            )}
          </button>
          <div
            className="flex-1 h-1.5 rounded-full bg-black/[0.06] overflow-hidden cursor-pointer group relative"
            onClick={(e) => {
              const v = videoRef.current;
              const bar = e.currentTarget;
              if (!v || !bar) return;
              const rect = bar.getBoundingClientRect();
              const pct = Math.max(
                0,
                Math.min(1, (e.clientX - rect.left) / rect.width),
              );
              v.currentTime = pct * (v.duration || 0);
              setCurrentTime(v.currentTime);
            }}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-150"
              style={{
                width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
              }}
            />
            {/* subtle playhead indicator */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white ring-2 ring-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.3)] pointer-events-none transition-all duration-150"
              style={{
                left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 7px)`,
              }}
            />
          </div>
          <span className="text-[11px] font-mono text-ink-light tabular-nums tracking-tight flex-shrink-0">
            {fmtTimeShort(currentTime)} / {fmtTimeShort(duration)}
          </span>
        </div>

        {/* ================================================================ */}
        {/*  Style Panel — Collapsible Bento Card                            */}
        {/* ================================================================ */}
        <div className="mx-5 mt-3">
          <button
            onClick={() => setShowStylePanel(!showStylePanel)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/[0.02] ring-1 ring-black/[0.04] text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer"
          >
            <IconChevronRight open={showStylePanel} className="w-3 h-3" />
            Định dạng phụ đề
            {selectedIndex !== null && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-blue-500/10 text-[9px] text-blue-600">
                #{selectedIndex + 1}
              </span>
            )}
          </button>
          {selectedIndex !== null && showStylePanel && (
            <label className="inline-flex items-center gap-1.5 ml-3 cursor-pointer select-none mt-1">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)}
                className="w-3 h-3 accent-blue-600 cursor-pointer"
              />
              <span className="text-[10px] text-ink-muted">
                Áp dụng cho tất cả
              </span>
            </label>
          )}
          {showStylePanel &&
            (() => {
              const s = getCurrentStyle();
              return (
                <div
                  className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 p-3 rounded-2xl bg-black/[0.015] ring-1 ring-black/[0.04]"
                  style={{
                    animation:
                      "fade-up 0.35s ease-[cubic-bezier(0.32,0.72,0,1)] forwards",
                  }}
                >
                  {/* Position X/Y */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase tracking-[0.15em] text-ink-light font-medium">
                      Vị trí (px)
                    </span>
                    <div className="flex gap-1 items-center">
                      <span className="text-[8px] font-mono text-ink-light w-2.5">
                        X
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={videoDims.w}
                        value={s.x}
                        onChange={(e) =>
                          updateStyle("x", parseInt(e.target.value))
                        }
                        disabled={selectedIndex === null}
                        className="flex-1 h-1 accent-blue-600 cursor-pointer disabled:opacity-40"
                      />
                      <span className="text-[8px] font-mono text-ink-light tabular-nums w-8 text-right">
                        {s.x}px
                      </span>
                    </div>
                    <div className="flex gap-1 items-center">
                      <span className="text-[8px] font-mono text-ink-light w-2.5">
                        Y
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={videoDims.h}
                        value={s.y}
                        onChange={(e) =>
                          updateStyle("y", parseInt(e.target.value))
                        }
                        disabled={selectedIndex === null}
                        className="flex-1 h-1 accent-blue-600 cursor-pointer disabled:opacity-40"
                      />
                      <span className="text-[8px] font-mono text-ink-light tabular-nums w-8 text-right">
                        {s.y}px
                      </span>
                    </div>
                    <div className="flex gap-0.5 mt-0.5">
                      {[
                        { label: "Dưới", x: Math.round(videoDims.w / 2), y: Math.round(videoDims.h * 0.93) },
                        { label: "Giữa", x: Math.round(videoDims.w / 2), y: Math.round(videoDims.h / 2) },
                        { label: "Trên", x: Math.round(videoDims.w / 2), y: Math.round(videoDims.h * 0.1) },
                      ].map((p) => (
                        <button
                          key={p.label}
                          onClick={() => {
                            updateStyle("x", p.x);
                            updateStyle("y", p.y);
                          }}
                          disabled={selectedIndex === null}
                          className="flex-1 py-0.5 text-[9px] font-medium rounded-md transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-black/[0.02] text-ink-light hover:bg-black/[0.05] hover:text-ink"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Font */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase tracking-[0.15em] text-ink-light font-medium">
                      Font
                    </span>
                    <select
                      value={s.fontFamily}
                      onChange={(e) =>
                        updateStyle("fontFamily", e.target.value)
                      }
                      disabled={selectedIndex === null}
                      className="w-full rounded-lg border border-black/[0.06] bg-white px-2 py-1 text-[10px] font-medium text-ink focus:outline-none focus:ring-1 focus:ring-blue-500/30 disabled:opacity-40 cursor-pointer"
                    >
                      {FONT_OPTIONS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Font Size */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase tracking-[0.15em] text-ink-light font-medium">
                      Cỡ chữ
                    </span>
                    <select
                      value={s.fontSize}
                      onChange={(e) =>
                        updateStyle("fontSize", parseInt(e.target.value))
                      }
                      disabled={selectedIndex === null}
                      className="w-full rounded-lg border border-black/[0.06] bg-white px-2 py-1 text-[10px] font-medium text-ink focus:outline-none focus:ring-1 focus:ring-blue-500/30 disabled:opacity-40 cursor-pointer"
                    >
                      {[12, 14, 16, 18, 20, 24, 28, 32, 40].map((n) => (
                        <option key={n} value={n}>
                          {n}px
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Color & Bg */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase tracking-[0.15em] text-ink-light font-medium">
                      Chữ / Nền
                    </span>
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        value={s.textColor}
                        onChange={(e) =>
                          updateStyle("textColor", e.target.value)
                        }
                        disabled={selectedIndex === null}
                        className="w-5 h-5 rounded border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-0"
                      />
                      <input
                        type="color"
                        value={s.bgColor}
                        onChange={(e) => updateStyle("bgColor", e.target.value)}
                        disabled={selectedIndex === null}
                        className="w-5 h-5 rounded border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-0"
                      />
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(s.bgOpacity * 100)}
                        onChange={(e) =>
                          updateStyle(
                            "bgOpacity",
                            parseInt(e.target.value) / 100,
                          )
                        }
                        disabled={selectedIndex === null}
                        className="w-10 h-1 accent-blue-600 cursor-pointer disabled:opacity-40"
                      />
                      <span className="text-[8px] font-mono text-ink-light tabular-nums">
                        {Math.round(s.bgOpacity * 100)}%
                      </span>
                    </div>
                  </div>
                  {/* Align + Style */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase tracking-[0.15em] text-ink-light font-medium">
                      Align / Kiểu / Rộng
                    </span>
                    <div className="flex items-center gap-1">
                      <div className="flex gap-0.5 rounded-lg bg-black/[0.03] p-0.5">
                        {(["left", "center", "right"] as const).map((a) => (
                          <button
                            key={a}
                            onClick={() => updateStyle("textAlign", a)}
                            disabled={selectedIndex === null}
                            className={`px-1.5 py-0.5 text-[9px] font-medium rounded transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${s.textAlign === a ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.06]" : "text-ink-light hover:text-ink"}`}
                          >
                            {a === "left"
                              ? "Trái"
                              : a === "center"
                                ? "Giữa"
                                : "Phải"}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => updateStyle("bold", !s.bold)}
                        disabled={selectedIndex === null}
                        className={`px-1.5 py-0.5 text-[10px] font-bold rounded transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${s.bold ? "bg-blue-500/10 text-blue-700 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.05]"}`}
                      >
                        B
                      </button>
                      <button
                        onClick={() => updateStyle("italic", !s.italic)}
                        disabled={selectedIndex === null}
                        className={`px-1.5 py-0.5 text-[10px] italic rounded transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${s.italic ? "bg-blue-500/10 text-blue-700 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.05]"}`}
                      >
                        I
                      </button>
                      <div className="flex gap-1 items-center ml-0.5">
                        <input
                          type="range"
                          min={15}
                          max={95}
                          value={s.maxWidth}
                          onChange={(e) =>
                            updateStyle("maxWidth", parseInt(e.target.value))
                          }
                          disabled={selectedIndex === null}
                          className="w-10 h-1 accent-blue-600 cursor-pointer disabled:opacity-40"
                        />
                        <span className="text-[8px] font-mono text-ink-light tabular-nums w-5">
                          {s.maxWidth}%
                        </span>
                      </div>
                    </div>
                    <label className="flex items-center gap-1 cursor-pointer select-none mt-0.5">
                      <input
                        type="checkbox"
                        checked={s.showBg}
                        onChange={(e) =>
                          updateStyle("showBg", e.target.checked)
                        }
                        disabled={selectedIndex === null}
                        className="w-3 h-3 accent-blue-600 cursor-pointer disabled:opacity-40"
                      />
                      <span className="text-[9px] text-ink-muted">
                        Hiện khung nền
                      </span>
                    </label>
                  </div>
                </div>
              );
            })()}
        </div>

        {/* ================================================================ */}
        {/*  Timeline — Track Sidebar + Tracks Area                          */}
        {/* ================================================================ */}
        <div className="flex flex-1 min-h-0 mx-5 mt-3 mb-5 rounded-2xl overflow-hidden ring-1 ring-black/[0.05] bg-gradient-to-b from-white/90 to-white/50">
          {/* --- Track Labels Sidebar --- */}
          <div className="w-[80px] flex-shrink-0 border-r border-black/[0.06] bg-gradient-to-b from-white/80 to-white/30 flex flex-col select-none">
            <div className="h-7 border-b border-black/[0.03] bg-white/50" />
            <div className="h-14 flex items-center px-3 border-b border-black/[0.03] bg-blue-500/[0.02]">
              <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-blue-500/50">
                Video
              </span>
            </div>
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`h-14 flex items-center px-3 border-b border-black/[0.03] cursor-pointer group relative transition-all duration-300 ${
                  selectedTrack === track.id
                    ? "bg-amber-500/[0.12] ring-1 ring-amber-400/30 ring-inset shadow-[inset_2px_0_0_rgba(245,158,11,0.5)]"
                    : "hover:bg-black/[0.015]"
                }`}
                onClick={() => setSelectedTrack(track.id)}
              >
                <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-600/60 truncate">
                  {track.name}
                </span>
                {tracks.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteTrack(track.id);
                    }}
                    className="absolute right-1 w-4 h-4 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 cursor-pointer"
                  >
                    <IconClose className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            ))}
            {ttsClips.length > 0 && (
              <div className="h-14 flex items-center px-3 border-t border-black/[0.03] bg-cyan-500/[0.02]">
                <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-cyan-500/50">
                  TTS Voice
                </span>
              </div>
            )}
          </div>

          {/* --- Timeline Canvas --- */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden"
            style={{ scrollBehavior: "auto" }}
          >
            <div
              className="relative"
              style={{ width: totalWidth, minHeight: "100%" }}
            >
              {/* ---- Timecode Ruler ---- */}
              <div className="h-7 border-b border-black/[0.03] bg-white/60 relative">
                {Array.from({ length: Math.ceil(duration / 5) + 1 }, (_, i) => {
                  const t = i * 5;
                  const x = t * pixelsPerSec;
                  if (x > totalWidth + 20) return null;
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-full"
                      style={{ left: x }}
                    >
                      <div className="absolute top-0 left-0 w-px h-2.5 bg-black/[0.10]" />
                      <span className="absolute top-2 left-1.5 text-[9px] font-mono tabular-nums text-ink-light select-none whitespace-nowrap">
                        {fmtTimeShort(t)}
                      </span>
                    </div>
                  );
                })}
                {zoom >= 1.5 &&
                  Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => {
                    if (i % 5 === 0) return null;
                    const x = i * pixelsPerSec;
                    if (x > totalWidth + 20) return null;
                    return (
                      <div
                        key={`s-${i}`}
                        className="absolute top-0 w-px h-1.5 bg-black/[0.05]"
                        style={{ left: x }}
                      />
                    );
                  })}
              </div>

              {/* ---- Video Track ---- */}
              <div
                className="h-14 border-b border-black/[0.04] relative cursor-pointer bg-blue-500/[0.02]"
                onClick={seekTimeline}
              >
                {Array.from({ length: Math.ceil(duration / 10) }, (_, i) => {
                  const segStart = i * 10;
                  const segEnd = Math.min(segStart + 10, duration);
                  const segWidth = (segEnd - segStart) * pixelsPerSec;
                  return (
                    <div
                      key={i}
                      className="absolute top-1 bottom-1 rounded-lg flex items-center justify-center"
                      style={{
                        left: segStart * pixelsPerSec,
                        width: segWidth,
                        background:
                          i % 2 === 0
                            ? "linear-gradient(180deg, rgba(59,130,246,0.06) 0%, rgba(59,130,246,0.02) 100%)"
                            : "linear-gradient(180deg, rgba(59,130,246,0.10) 0%, rgba(59,130,246,0.04) 100%)",
                        border: "1px solid rgba(59,130,246,0.15)",
                      }}
                    >
                      {segWidth > 40 && (
                        <span className="text-[9px] font-mono text-blue-400/40 tabular-nums select-none">
                          {fmtTimeShort(segStart)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ---- Subtitle Tracks ---- */}
              {tracks.map((track) => (
                <div
                  key={track.id}
                  data-track-id={track.id}
                  className={`h-14 border-b border-black/[0.04] relative cursor-pointer transition-all duration-300 ${
                    dragOverTrackId === track.id
                      ? "bg-amber-500/15 ring-2 ring-amber-500/40 ring-inset"
                      : "bg-amber-500/[0.02]"
                  }`}
                  onClick={seekTimeline}
                >
                  {track.entries.map((entry, i) => {
                    const left = entry.start * pixelsPerSec;
                    const width = Math.max(
                      (entry.end - entry.start) * pixelsPerSec,
                      4,
                    );
                    const isSelected =
                      selectedTrack === track.id && selectedIndex === i;
                    const isDragging =
                      dragState?.trackId === track.id && dragState?.index === i;
                    const showDetail = isSelected || isDragging;
                    return (
                      <div
                        key={i}
                        data-index={i}
                        className={`absolute top-1 bottom-1 rounded-lg flex items-center overflow-hidden select-none transition-all duration-200 group ${
                          isSelected || isDragging
                            ? "bg-amber-500/35 ring-2 ring-amber-500/50 shadow-[0_2px_8px_rgba(245,158,11,0.15)] z-10"
                            : "bg-amber-500/20 ring-1 ring-amber-500/15 hover:bg-amber-500/28 cursor-grab"
                        }`}
                        style={{ left, width }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const rect = (
                            e.target as HTMLElement
                          ).getBoundingClientRect();
                          const relX = e.clientX - rect.left;
                          const edge = 10;
                          let mode: DragMode = "move";
                          if (relX < edge) mode = "resize-start";
                          else if (relX > width - edge) mode = "resize-end";
                          (e.target as HTMLElement).setPointerCapture(
                            e.pointerId,
                          );
                          startDrag(track.id, i, mode, e.clientX, e.clientY);
                        }}
                        onPointerMove={(e) => {
                          if (!dragState) {
                            const rect = (
                              e.target as HTMLElement
                            ).getBoundingClientRect();
                            const relX = e.clientX - rect.left;
                            const edge = 10;
                            const el = e.target as HTMLElement;
                            if (relX < edge) el.style.cursor = "ew-resize";
                            else if (relX > rect.width - edge)
                              el.style.cursor = "ew-resize";
                            else el.style.cursor = "grab";
                          }
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditing({
                            trackId: track.id,
                            index: i,
                            text: entry.text,
                          });
                        }}
                      >
                        {/* Resize handle left */}
                        <div
                          className="absolute left-0 top-0 bottom-0 w-[10px] cursor-ew-resize flex items-center justify-center bg-amber-500/8 hover:bg-amber-500/30 rounded-l-lg transition-colors duration-200 z-10"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            (e.target as HTMLElement).setPointerCapture(
                              e.pointerId,
                            );
                            startDrag(
                              track.id,
                              i,
                              "resize-start",
                              e.clientX,
                              e.clientY,
                            );
                          }}
                        >
                          <div className="flex gap-[1.5px]">
                            <div className="w-[1.5px] h-4 rounded-full bg-amber-500/40 group-hover:bg-amber-500/60 transition-colors" />
                            <div className="w-[1.5px] h-4 rounded-full bg-amber-500/40 group-hover:bg-amber-500/60 transition-colors" />
                          </div>
                        </div>
                        {/* Resize handle right */}
                        <div
                          className="absolute right-0 top-0 bottom-0 w-[10px] cursor-ew-resize flex items-center justify-center bg-amber-500/8 hover:bg-amber-500/30 rounded-r-lg transition-colors duration-200 z-10"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            (e.target as HTMLElement).setPointerCapture(
                              e.pointerId,
                            );
                            startDrag(
                              track.id,
                              i,
                              "resize-end",
                              e.clientX,
                              e.clientY,
                            );
                          }}
                        >
                          <div className="flex gap-[1.5px]">
                            <div className="w-[1.5px] h-4 rounded-full bg-amber-500/40 group-hover:bg-amber-500/60 transition-colors" />
                            <div className="w-[1.5px] h-4 rounded-full bg-amber-500/40 group-hover:bg-amber-500/60 transition-colors" />
                          </div>
                        </div>
                        {showDetail && (
                          <div className="absolute -top-3.5 left-0 right-0 flex items-center justify-between px-2">
                            <span className="text-[8px] font-mono tabular-nums text-amber-700/80 bg-amber-100/90 rounded px-1 leading-tight">
                              {secToSrt(entry.start)}
                            </span>
                            <span className="text-[8px] font-mono tabular-nums text-amber-700/80 bg-amber-100/90 rounded px-1 leading-tight">
                              {secToSrt(entry.end)}
                            </span>
                          </div>
                        )}
                        <span className="px-3 text-[10px] font-medium text-amber-800/80 truncate select-none leading-tight w-full">
                          {entry.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* ---- TTS Voice Track ---- */}
              {ttsClips.length > 0 && (
                <div
                  className="h-14 relative bg-cyan-500/[0.015] cursor-pointer"
                  onClick={seekTimeline}
                >
                  <div className="absolute inset-x-0 bottom-2 top-2 flex items-center opacity-25 pointer-events-none">
                    {Array.from({ length: Math.ceil(duration * 2) }, (_, i) => {
                      const x = (i / 2) * pixelsPerSec;
                      if (x > totalWidth + 2) return null;
                      const barW = Math.max(1, pixelsPerSec / 2 - 0.5);
                      return (
                        <div
                          key={i}
                          className="absolute rounded-t-[1px]"
                          style={{
                            left: x,
                            width: barW,
                            height: `${Math.max(2, 20)}px`,
                            background: "rgba(6,182,212,0.18)",
                          }}
                        />
                      );
                    })}
                  </div>
                  {ttsClips.map((clip, i) => {
                    const left = clip.start * pixelsPerSec;
                    const width = Math.max(
                      (clip.end - clip.start) * pixelsPerSec,
                      4,
                    );
                    const isActive = ttsActiveIndex === i;
                    return (
                      <div
                        key={i}
                        className={`absolute top-1 bottom-1 rounded-lg flex items-center justify-center z-10 transition-all duration-300 ${
                          isActive
                            ? "bg-cyan-500/60 ring-2 ring-cyan-500/60 shadow-[0_2px_8px_rgba(6,182,212,0.2)]"
                            : "bg-cyan-500/20 ring-1 ring-cyan-500/30 hover:bg-cyan-500/40 cursor-pointer"
                        }`}
                        style={{ left, width }}
                        onClick={(e) => {
                          e.stopPropagation();
                          ttsAudioRefs.current.forEach((a) => a.pause());
                          ttsAudioRefs.current.clear();
                          setTtsActiveIndex(null);
                          const v = videoRef.current;
                          if (v) {
                            v.currentTime = clip.start;
                            setCurrentTime(clip.start);
                            v.play?.().catch(() => {});
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingClipSpeed(i);
                        }}
                        title={`🎙️ ${fmtTime(clip.start)} - ${fmtTime(clip.end)} | Chuột phải: chỉnh tốc độ (${clip.speed}x)`}
                      >
                        <span
                          className={`text-[8px] font-medium select-none pointer-events-none ${isActive ? "text-cyan-900" : "text-cyan-700/70"}`}
                        >
                          🎙️ {i + 1} {isActive ? "▶" : ""}
                        </span>
                        {clip.speed !== 1.0 && (
                          <span className="absolute -top-1 -right-1 bg-cyan-600 text-white text-[7px] rounded px-1 font-bold select-none pointer-events-none">
                            {clip.speed}x
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {/* Speed editor popup */}
                  {editingClipSpeed !== null &&
                    ttsClips[editingClipSpeed] &&
                    (() => {
                      const clip = ttsClips[editingClipSpeed];
                      const i = editingClipSpeed;
                      const popLeft = clip.start * pixelsPerSec;
                      return (
                        <div
                          className="absolute -top-16 bg-white rounded-xl shadow-2xl ring-1 ring-black/[0.08] px-3 py-2 flex items-center gap-2 whitespace-nowrap"
                          style={{
                            left: Math.max(0, popLeft - 60),
                            zIndex: 30,
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="text-[9px] font-medium text-ink-muted">
                            Tốc độ:
                          </span>
                          <input
                            type="number"
                            min={0.25}
                            max={4}
                            step={0.05}
                            value={clip.speed}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value) || 1;
                              setTtsClips((prev) =>
                                prev.map((c, j) => {
                                  if (ttsSpeedApplyAll || j === i)
                                    return {
                                      ...c,
                                      speed: Math.max(0.25, Math.min(4, v)),
                                    };
                                  return c;
                                }),
                              );
                            }}
                            className="w-14 rounded-lg border border-black/[0.08] bg-white px-1.5 py-0.5 text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                          />
                          <label className="flex items-center gap-1 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={ttsSpeedApplyAll}
                              onChange={(e) =>
                                setTtsSpeedApplyAll(e.target.checked)
                              }
                              className="w-3 h-3 accent-cyan-600"
                            />
                            <span className="text-[8px] text-ink-muted">
                              All
                            </span>
                          </label>
                          <button
                            onClick={() => {
                              setTtsClips((prev) =>
                                prev.filter((_, j) => j !== i),
                              );
                              setEditingClipSpeed(null);
                              ttsAudioRefs.current.get(i)?.pause();
                              ttsAudioRefs.current.delete(i);
                            }}
                            className="text-[10px] text-red-500 hover:text-red-600 font-medium cursor-pointer"
                          >
                            Xoá
                          </button>
                          <button
                            onClick={() => setEditingClipSpeed(null)}
                            className="text-[10px] text-ink-light hover:text-ink cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })()}
                </div>
              )}

              {/* ---- Playhead ---- */}
              <div
                className="absolute top-0 bottom-0 z-20 pointer-events-none"
                style={{ left: currentTime * pixelsPerSec }}
              >
                <div className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.35)]" />
                <div
                  className="absolute -top-0.5 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full border-2 border-white shadow-[0_0_10px_rgba(239,68,68,0.25)] cursor-ew-resize pointer-events-auto transition-transform duration-150 hover:scale-125 active:scale-110"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const el = scrollRef.current;
                    if (!el) return;
                    const onMove = (ev: PointerEvent) => {
                      const rect = el.getBoundingClientRect();
                      const x = ev.clientX - rect.left + el.scrollLeft;
                      const t = Math.max(
                        0,
                        Math.min(duration, x / pixelsPerSec),
                      );
                      const v = videoRef.current;
                      if (v) {
                        v.currentTime = t;
                        setCurrentTime(t);
                      }
                    };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Delete Track Confirmation                                       */}
        {/* ================================================================ */}
        {confirmDeleteTrack && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/[0.15] backdrop-blur-sm">
            <div
              className="double-bezel !rounded-2xl w-full max-w-sm mx-4"
              style={{
                animation:
                  "scale-in 0.3s ease-[cubic-bezier(0.32,0.72,0,1)] forwards",
              }}
            >
              <div className="double-bezel-inner !rounded-[calc(1rem-1px)] p-6 text-center">
                <svg
                  className="w-8 h-8 text-red-500 mx-auto mb-3"
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
                <p className="text-sm font-semibold text-ink mb-1">
                  Xoá track này?
                </p>
                <p className="text-[12px] text-ink-muted mb-5">
                  Track này có{" "}
                  {tracks.find((t) => t.id === confirmDeleteTrack)?.entries
                    .length ?? 0}{" "}
                  phụ đề. Sau khi xoá sẽ không khôi phục được.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={() => setConfirmDeleteTrack(null)}
                    className="px-5 py-2 rounded-full text-[12px] font-medium text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06] hover:bg-black/[0.06] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97]"
                  >
                    Huỷ
                  </button>
                  <button
                    onClick={() => doDeleteTrack(confirmDeleteTrack)}
                    className="px-5 py-2 rounded-full text-[12px] font-medium text-white bg-red-600 hover:bg-red-500 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97]"
                  >
                    Xoá
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/*  Text Edit Modal                                                 */}
        {/* ================================================================ */}
        {editing && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/[0.15] backdrop-blur-sm">
            <div
              className="double-bezel !rounded-2xl w-full max-w-lg mx-4"
              style={{
                animation:
                  "scale-in 0.3s ease-[cubic-bezier(0.32,0.72,0,1)] forwards",
              }}
            >
              <div className="double-bezel-inner !rounded-[calc(1rem-1px)] p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                    Sửa phụ đề #{editing.index + 1}
                  </span>
                  <button
                    onClick={() => setEditing(null)}
                    className="w-6 h-6 rounded-full bg-black/[0.04] flex items-center justify-center hover:bg-black/[0.08] transition-all duration-300 cursor-pointer"
                  >
                    <IconClose className="w-3.5 h-3.5 text-ink-muted" />
                  </button>
                </div>
                <textarea
                  autoFocus
                  className="w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-[13px] text-ink resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/30 transition-all duration-300"
                  rows={3}
                  defaultValue={editing.text}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                      commitEdit((e.target as HTMLTextAreaElement).value);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  ref={(el) => el?.focus()}
                />
                <div className="flex items-center justify-between mt-3">
                  <button
                    onClick={() => {
                      deleteEntry(editing.trackId, editing.index);
                      setEditing(null);
                    }}
                    className="px-3 py-1.5 rounded-full text-[11px] font-medium text-red-600 ring-1 ring-red-500/20 hover:bg-red-500/10 transition-all duration-300 cursor-pointer active:scale-[0.97]"
                  >
                    Xoá
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditing(null)}
                      className="px-4 py-1.5 rounded-full text-[11px] font-medium text-ink-muted hover:bg-black/[0.04] transition-all duration-300 cursor-pointer active:scale-[0.97]"
                    >
                      Huỷ
                    </button>
                    <button
                      onClick={() => {
                        const ta = document.querySelector(
                          "textarea",
                        ) as HTMLTextAreaElement;
                        if (ta) commitEdit(ta.value);
                      }}
                      className="px-4 py-1.5 rounded-full text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all duration-300 cursor-pointer active:scale-[0.97]"
                    >
                      Lưu <span className="opacity-60 ml-0.5">⌘↵</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/*  Settings Modal                                                  */}
        {/* ================================================================ */}
        {showSettings && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/[0.15] backdrop-blur-sm">
            <div
              className="double-bezel !rounded-2xl w-full max-w-md mx-4"
              style={{
                animation:
                  "scale-in 0.3s ease-[cubic-bezier(0.32,0.72,0,1)] forwards",
              }}
            >
              <div className="double-bezel-inner !rounded-[calc(1rem-1px)] p-6">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm font-semibold text-ink">
                    ⚙️ Cấu hình API
                  </span>
                  <button
                    onClick={() => {
                      setShowSettings(false);
                      setSettingsStatus("");
                    }}
                    className="w-6 h-6 rounded-full bg-black/[0.04] flex items-center justify-center hover:bg-black/[0.08] transition-all duration-300 cursor-pointer"
                  >
                    <IconClose className="w-3.5 h-3.5 text-ink-muted" />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1 block">
                      Gemini API Key
                    </label>
                    <input
                      type="password"
                      value={settingsGeminiKey}
                      onChange={(e) => setSettingsGeminiKey(e.target.value)}
                      placeholder="AIzaSy..."
                      className="w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                    <p className="text-[9px] text-ink-light mt-1">
                      Lấy tại{" "}
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        className="text-blue-500 underline"
                      >
                        aistudio.google.com/apikey
                      </a>
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1 block">
                      Google Cloud TTS (Service Account JSON)
                    </label>
                    <textarea
                      value={settingsTtsJson}
                      onChange={(e) => setSettingsTtsJson(e.target.value)}
                      placeholder='{"type": "service_account", "project_id": "..."}'
                      rows={4}
                      className="w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-[11px] text-ink font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                    <p className="text-[9px] text-ink-light mt-1">
                      Google Cloud → IAM → Service Accounts → Create Key → JSON
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-4">
                  <span
                    className={`text-[11px] ${settingsStatus.includes("Đã lưu") ? "text-emerald-600" : settingsStatus.includes("Lỗi") || settingsStatus.includes("không") ? "text-red-500" : "text-ink-light"}`}
                  >
                    {settingsStatus || ""}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setShowSettings(false);
                        setSettingsStatus("");
                      }}
                      className="px-4 py-1.5 rounded-full text-[11px] font-medium text-ink-muted hover:bg-black/[0.04] transition-all duration-300 cursor-pointer active:scale-[0.97]"
                    >
                      Đóng
                    </button>
                    <button
                      onClick={saveSettings}
                      className="px-4 py-1.5 rounded-full text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all duration-300 cursor-pointer active:scale-[0.97]"
                    >
                      Lưu
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/*  Drag cursor overlay                                             */}
        {/* ================================================================ */}
        {dragState && (
          <div
            className="fixed inset-0 z-40 pointer-events-none"
            style={{
              cursor: dragState.mode === "move" ? "grabbing" : "ew-resize",
            }}
          />
        )}

        {/* ================================================================ */}
        {/*  Toast Notification                                              */}
        {/* ================================================================ */}
        {toast && (
          <div
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full bg-ink/90 backdrop-blur-md text-white text-xs font-medium shadow-2xl ring-1 ring-white/10"
            style={{
              animation:
                "fade-up 0.4s ease-[cubic-bezier(0.32,0.72,0,1)] forwards",
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
