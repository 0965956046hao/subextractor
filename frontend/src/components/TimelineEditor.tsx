"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  getSrtEntries, updateSrt, getVideoUrl,
  muxSubtitles, hardcodeSubtitles, alignSubtitles,
  getMuxedDownloadUrl, getHardcodedDownloadUrl, getJobStatus,
  getSrtContent,
} from "@/lib/api";
import type { SrtEntry as ApiSrtEntry } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface SubtitleStyle {
  x: number;
  y: number;
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

const DEFAULT_STYLE: SubtitleStyle = {
  x: 50,
  y: 90,
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

type ToolJob = "mux" | "hardcode" | "align" | null;

interface JobState {
  type: ToolJob;
  jobId: string;
  status: "queued" | "processing" | "done" | "error";
  progress: number;
  error: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const PIXELS_PER_SECOND = 60;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const TIMELINE_PADDING = 30; // seconds after video duration for extending subtitles

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
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
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms || "0") / 1000;
}

function entriesToSrt(entries: SrtEntry[]): string {
  return entries
    .map(
      (e, i) =>
        `${i + 1}\n${secToSrt(e.start)} --> ${secToSrt(e.end)}\n${e.text}\n`
    )
    .join("\n");
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface TimelineEditorProps {
  videoId: string;
  duration: number;
}

export default function TimelineEditor({ videoId, duration: initialDuration }: TimelineEditorProps) {
  /* ---- state ---- */
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(initialDuration || 60);

  const [zoom, setZoom] = useState(1.5);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [saved, setSaved] = useState(true);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dragState, setDragState] = useState<{
    index: number;
    mode: DragMode;
    startX: number;
    origStart: number;
    origEnd: number;
  } | null>(null);

  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);

  const [job, setJob] = useState<JobState | null>(null);
  const [applyAll, setApplyAll] = useState(false);
  const [showStylePanel, setShowStylePanel] = useState(false);

  /* open style panel when an entry gets selected */
  useEffect(() => {
    if (selectedIndex !== null) setShowStylePanel(true);
  }, [selectedIndex]);

  /* ---- refs ---- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  /* ---- derived ---- */
  const pixelsPerSec = PIXELS_PER_SECOND * zoom;
  const paddedDuration = duration + TIMELINE_PADDING;
  const totalWidth = Math.max(paddedDuration * pixelsPerSec, 800);

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
      setEntries(mapped);
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
        setEntries(parsed);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load subtitles");
        setLoading(false);
      }
    }
  }, [videoId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  /* ---- video duration ---- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      if (v.duration && Number.isFinite(v.duration) && v.duration > 0) {
        setDuration(v.duration);
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, []);

  /* ---- requestAnimationFrame for playhead ---- */
  useEffect(() => {
    const loop = () => {
      const v = videoRef.current;
      if (v) {
        setCurrentTime(v.currentTime);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

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

  /* ---- poll tool job status ---- */
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "processing")) return;
    const timer = setInterval(async () => {
      try {
        const st = await getJobStatus(job.jobId);
        setJob((prev) =>
          prev
            ? { ...prev, status: st.status as JobState["status"], progress: st.progress, error: st.error || "" }
            : prev
        );
        if (st.status === "done" || st.status === "error") {
          clearInterval(timer);
          if (st.status === "done" && job.type === "align") {
            loadEntries();
          }
        }
      } catch {
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job, loadEntries]);

  /* ---- save SRT ---- */
  const saveSrt = useCallback(async () => {
    if (saved) return;
    try {
      const content = entriesToSrt(entries);
      await updateSrt(videoId, content);
      setSaved(true);
    } catch {
      // silent
    }
  }, [entries, videoId, saved]);

  /* ---- actions ---- */
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play?.().catch(() => {});
    else v.pause();
  };

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
    (index: number, mode: DragMode, clientX: number) => {
      const e = entries[index];
      if (!e) return;
      setDragState({ index, mode, startX: clientX, origStart: e.start, origEnd: e.end });
      setSelectedIndex(index);
    },
    [entries]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragState) return;
      const dx = (e.clientX - dragState.startX) / pixelsPerSec;
      setEntries((prev) => {
        const next = [...prev];
        const entry = { ...next[dragState.index] };
        if (!entry) return prev;

        let newStart = entry.start;
        let newEnd = entry.end;
        const minDur = 0.1;

        if (dragState.mode === "move") {
          const dur = dragState.origEnd - dragState.origStart;
          newStart = Math.max(0, dragState.origStart + dx);
          newEnd = newStart + dur;
        } else if (dragState.mode === "resize-start") {
          newStart = Math.max(0, Math.min(dragState.origStart + dx, entry.end - minDur));
        } else if (dragState.mode === "resize-end") {
          newEnd = Math.max(entry.start + minDur, dragState.origEnd + dx);
        }

        if (snapping && dragState.mode !== "move") {
          const snapThreshold = 0.3 / zoom;
          const targets: number[] = [0];

          if (dragState.mode === "resize-start") targets.push(entry.end);
          if (dragState.mode === "resize-end") targets.push(entry.start);

          prev.forEach((o, i) => {
            if (i === dragState.index) return;
            targets.push(o.start, o.end);
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
        return next;
      });
    },
    [dragState, pixelsPerSec, snapping, zoom]
  );

  const endDrag = useCallback(() => {
    if (dragState) {
      setSaved(false);
    }
    setDragState(null);
  }, [dragState]);

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

  /* ---- tool jobs ---- */
  const runToolJob = async (type: ToolJob) => {
    try {
      let result;
      if (type === "mux") result = await muxSubtitles(videoId);
      else if (type === "hardcode") result = await hardcodeSubtitles(videoId);
      else if (type === "align") result = await alignSubtitles(videoId);
      else return;
      setJob({
        type,
        jobId: result.job_id,
        status: result.status as JobState["status"],
        progress: result.progress,
        error: result.error || "",
      });
    } catch (err) {
      // handled by state
    }
  };

  const dismissJob = () => setJob(null);

  /* ---- entry edit ---- */
  const commitEdit = (text: string) => {
    if (!editing) return;
    setEntries((prev) => {
      const next = [...prev];
      next[editing.index] = { ...next[editing.index], text };
      return next;
    });
    setSaved(false);
    setEditing(null);
  };

  /* ---- entry delete ---- */
  const deleteEntry = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
    setSaved(false);
    setSelectedIndex(null);
  };

  /* ---- add entry ---- */
  const addEntry = () => {
    const start = currentTime;
    const end = Math.min(start + 3, duration);
    const newEntry: SrtEntry = {
      index: entries.length + 1,
      start,
      end,
      startLabel: secToSrt(start),
      endLabel: secToSrt(end),
      text: "",
    };
    const insertAt = entries.findIndex((e) => e.start > start);
    const idx = insertAt === -1 ? entries.length : insertAt;
    setEntries((prev) => {
      const next = [...prev];
      next.splice(idx, 0, newEntry);
      return next.map((e, i) => ({ ...e, index: i + 1 }));
    });
    setSaved(false);
    setSelectedIndex(idx);
    setEditing({ index: idx, text: "" });
  };

  /* ---- style helpers ---- */
  const getEntryStyle = (index: number): SubtitleStyle => {
    return entries[index]?.style ?? DEFAULT_STYLE;
  };

  const updateStyle = (key: keyof SubtitleStyle, value: string | number | boolean) => {
    const idx = selectedIndex;
    if (idx === null) return;
    setEntries((prev) => {
      const next = [...prev];
      if (applyAll) {
        for (let i = 0; i < next.length; i++) {
          next[i] = { ...next[i], style: { ...getEntryStyle(i), [key]: value } };
        }
      } else {
        next[idx] = { ...next[idx], style: { ...getEntryStyle(idx), [key]: value } };
      }
      return next;
    });
    setSaved(false);
  };

  const getCurrentStyle = (): SubtitleStyle => {
    if (selectedIndex !== null) {
      return entries[selectedIndex]?.style ?? DEFAULT_STYLE;
    }
    return DEFAULT_STYLE;
  };

  /* ---- waveforms ---- */
  const waveformBars = 200;
  const waveform = Array.from({ length: waveformBars }, (_, i) => {
    const t = (i / waveformBars) * duration;
    const active = entries.some((e) => t >= e.start && t <= e.end);
    return active ? 0.6 + Math.random() * 0.4 : 0.15 + Math.random() * 0.3;
  });

  /* ---- render ---- */
  if (loading) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-10 flex items-center justify-center">
          <svg className="w-6 h-6 text-blue-500 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
            <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="ml-3 text-sm text-ink-muted">Loading timeline…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-6">
          <div className="flex items-start gap-3 p-4 rounded-2xl bg-red-500/10 ring-1 ring-red-500/15">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
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
        {/*  Toolbar                                                         */}
        {/* ================================================================ */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-black/[0.06] bg-white/60 flex-wrap">
          {/* left */}
          <div className="flex items-center gap-2">
            {/* play/pause */}
            <button
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-500 shadow-sm active:scale-[0.95] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer flex-shrink-0"
            >
              {playing ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg className="w-3.5 h-3.5 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>

            {/* time display */}
            <span className="text-xs font-mono tabular-nums text-ink-muted min-w-[90px]">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>

            {/* snapping */}
            <button
              onClick={() => setSnapping(!snapping)}
              aria-label="Toggle snapping"
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300 cursor-pointer ${
                snapping
                  ? "bg-blue-600/10 text-blue-600 ring-1 ring-blue-500/25"
                  : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06]"
              }`}
              title="Bắt điểm (Snapping)"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3h4l2 7-2 7H6l2-7-2-7z" />
                <path d="M13 3l3 7-3 7" />
                <line x1="3" y1="21" x2="21" y2="21" />
              </svg>
            </button>
          </div>

          {/* right */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* zoom */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}
                className="w-6 h-6 rounded-md bg-black/[0.03] text-ink-light hover:bg-black/[0.06] flex items-center justify-center text-xs font-bold transition-colors cursor-pointer"
              >
                −
              </button>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.25}
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="w-20 h-1 accent-blue-600 cursor-pointer"
              />
              <button
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))}
                className="w-6 h-6 rounded-md bg-black/[0.03] text-ink-light hover:bg-black/[0.06] flex items-center justify-center text-xs font-bold transition-colors cursor-pointer"
              >
                +
              </button>
              <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-right">
                {zoom.toFixed(2)}x
              </span>
            </div>

            {/* tool actions */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => runToolJob("align")}
                disabled={!!job}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Căn chỉnh (Align)
              </button>
              <button
                onClick={() => runToolJob("mux")}
                disabled={!!job}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/20 hover:bg-violet-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Ghép phụ đề (Mux)
              </button>
              <button
                onClick={() => runToolJob("hardcode")}
                disabled={!!job}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-rose-500/10 text-rose-700 ring-1 ring-rose-500/20 hover:bg-rose-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Gắn phụ đề cứng (Hardcode)
              </button>
            </div>

            {/* add subtitle */}
            <button
              onClick={addEntry}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-pointer flex items-center gap-1"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm phụ đề
            </button>

            {/* save */}
            <button
              onClick={saveSrt}
              disabled={saved}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-colors cursor-pointer disabled:cursor-not-allowed ${
                saved
                  ? "bg-black/[0.02] text-ink-light ring-1 ring-black/[0.04]"
                  : "bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/25 hover:bg-blue-600/20"
              }`}
            >
              {saved ? "Đã lưu" : "Lưu thay đổi"}
            </button>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Job progress banner                                             */}
        {/* ================================================================ */}
        {job && (
          <div className="px-4 py-2 border-b border-black/[0.06] bg-gradient-to-r from-blue-500/[0.04] to-blue-500/[0.01]">
            <div className="flex items-center gap-3">
              {job.status === "queued" || job.status === "processing" ? (
                <>
                  <svg className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
                    <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <span className="text-[11px] font-medium text-ink-muted flex-1">
                    {job.type === "mux" ? "Đang ghép phụ đề (mux)…" : job.type === "hardcode" ? "Đang gắn phụ đề cứng…" : "Đang căn chỉnh phụ đề…"}
                  </span>
                  <div className="w-32 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-700"
                      style={{ width: `${Math.max(3, job.progress)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-right">{job.progress}%</span>
                </>
              ) : job.status === "done" ? (
                <>
                  <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span className="text-[11px] font-medium text-emerald-700 flex-1">
                    {job.type === "mux" ? "Ghép phụ đề hoàn tất" : job.type === "hardcode" ? "Gắn phụ đề cứng hoàn tất" : "Căn chỉnh phụ đề hoàn tất"}
                  </span>
                  {job.type === "mux" && (
                    <a href={getMuxedDownloadUrl(videoId)} download className="px-3 py-1 rounded-full text-[11px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer">
                      Tải MP4 (Softsub)
                    </a>
                  )}
                  {job.type === "hardcode" && (
                    <a href={getHardcodedDownloadUrl(videoId)} download className="px-3 py-1 rounded-full text-[11px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer">
                      Tải MP4 (Hardsub)
                    </a>
                  )}
                </>
              ) : job.status === "error" ? (
                <>
                  <svg className="w-4 h-4 text-red-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <span className="text-[11px] font-medium text-red-600/80 flex-1">{job.error || "Thất bại"}</span>
                </>
              ) : null}
              {/* dismiss when done/error */}
              {(job.status === "done" || job.status === "error") && (
                <button onClick={dismissJob} className="text-[10px] text-ink-light hover:text-ink transition-colors cursor-pointer">
                  ✕
                </button>
              )}
              {job.status !== "done" && job.status !== "error" && (
                <button onClick={dismissJob} className="text-[10px] text-ink-light hover:text-ink transition-colors cursor-pointer">
                  Ẩn
                </button>
              )}
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/*  Video Preview + Subtitle Overlay                                */}
        {/* ================================================================ */}
        <div className="relative bg-black mx-4 mt-4 rounded-2xl overflow-hidden aspect-video max-h-[360px]">
          <video
            ref={videoRef}
            src={getVideoUrl(videoId)}
            className="w-full h-full object-contain"
            playsInline
            preload="auto"
          />
          {/* active subtitle overlay */}
          {(() => {
            let activeIdx = -1;
            const active = entries.find((e, i) => {
              if (currentTime >= e.start && currentTime < e.end) { activeIdx = i; return true; }
              return false;
            });
            if (active) {
              const s = active.style ?? DEFAULT_STYLE;
              const posClass = s.position === "top" ? "top-0 pt-4" : s.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-0 pb-4";
              const hexToRgba = (hex: string, alpha: number) => {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                return `rgba(${r},${g},${b},${alpha})`;
              };
              return (
                <div className={`absolute inset-x-0 px-4 sm:px-5 flex justify-center pointer-events-none ${posClass}`}>
                  <div
                    className="max-w-[92%] text-center rounded-xl px-3.5 py-1.5 shadow-lg"
                    style={{
                      animation: "fade-in 0.25s ease forwards",
                      backgroundColor: hexToRgba(s.bgColor, s.bgOpacity),
                      backdropFilter: "blur(8px)",
                    }}
                  >
                    <p
                      style={{
                        color: s.textColor,
                        fontFamily: s.fontFamily,
                        fontSize: `${s.fontSize}px`,
                        fontWeight: s.bold ? 700 : 400,
                        fontStyle: s.italic ? "italic" : "normal",
                        lineHeight: 1.4,
                        letterSpacing: "0.02em",
                      }}
                    >
                      {active.text}
                    </p>
                  </div>
                </div>
              );
            }
            if (!playing) {
              return (
                <button
                  onClick={togglePlay}
                  aria-label="Play"
                  className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm border border-white/15 flex items-center justify-center transition-all duration-300 active:scale-95 cursor-pointer"
                >
                  <svg className="w-6 h-6 text-white ml-1" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </button>
              );
            }
            return null;
          })()}
        </div>

        {/* ================================================================ */}
        {/*  Style Panel                                                     */}
        {/* ================================================================ */}
        <div className="px-4 pt-3 border-b border-black/[0.06] bg-white/40">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setShowStylePanel(!showStylePanel)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors cursor-pointer"
            >
              <svg className={`w-3.5 h-3.5 transition-transform duration-300 ${showStylePanel ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Định dạng phụ đề
            </button>
            {selectedIndex !== null && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={applyAll}
                  onChange={(e) => setApplyAll(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
                />
                <span className="text-[10px] font-medium text-ink-muted">Apply to all</span>
              </label>
            )}
          </div>

          {showStylePanel && (() => {
            const s = getCurrentStyle();
            return (
              <div
                className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pb-3"
                style={{ animation: "fade-in 0.2s ease forwards" }}
              >
                {/* position */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Vị trí</span>
                  <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
                    {(["top", "center", "bottom"] as const).map((pos) => (
                      <button
                        key={pos}
                        onClick={() => updateStyle("position", pos)}
                        disabled={selectedIndex === null}
                        className={`flex-1 py-1 text-[10px] font-medium rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                          s.position === pos ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.06]" : "text-ink-light hover:text-ink"
                        }`}
                      >
                        {pos === "top" ? "Trên" : pos === "center" ? "Giữa" : "Dưới"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* font */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Font</span>
                  <select
                    value={s.fontFamily}
                    onChange={(e) => updateStyle("fontFamily", e.target.value)}
                    disabled={selectedIndex === null}
                    className="w-full rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-[10px] font-medium text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-40 cursor-pointer"
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>

                {/* font size */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Cỡ chữ</span>
                  <select
                    value={s.fontSize}
                    onChange={(e) => updateStyle("fontSize", parseInt(e.target.value))}
                    disabled={selectedIndex === null}
                    className="w-full rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-[10px] font-medium text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-40 cursor-pointer"
                  >
                    {[12, 14, 16, 18, 20, 24, 28, 32, 40].map((n) => (
                      <option key={n} value={n}>{n}px</option>
                    ))}
                  </select>
                </div>

                {/* text color */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Chữ</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={s.textColor}
                      onChange={(e) => updateStyle("textColor", e.target.value)}
                      disabled={selectedIndex === null}
                      className="w-6 h-6 rounded-md border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-0"
                    />
                    <span className="text-[9px] font-mono text-ink-light tabular-nums">{s.textColor}</span>
                  </div>
                </div>

                {/* bg color */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Nền</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={s.bgColor}
                      onChange={(e) => updateStyle("bgColor", e.target.value)}
                      disabled={selectedIndex === null}
                      className="w-6 h-6 rounded-md border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-0"
                    />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(s.bgOpacity * 100)}
                      onChange={(e) => updateStyle("bgOpacity", parseInt(e.target.value) / 100)}
                      disabled={selectedIndex === null}
                      className="w-10 h-1 accent-blue-600 cursor-pointer disabled:opacity-40"
                    />
                    <span className="text-[9px] font-mono text-ink-light tabular-nums">{Math.round(s.bgOpacity * 100)}%</span>
                  </div>
                </div>

                {/* bold/italic */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Kiểu</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => updateStyle("bold", !s.bold)}
                      disabled={selectedIndex === null}
                      className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        s.bold ? "bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06]"
                      }`}
                    >
                      B
                    </button>
                    <button
                      onClick={() => updateStyle("italic", !s.italic)}
                      disabled={selectedIndex === null}
                      className={`flex-1 py-1 text-[10px] italic rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        s.italic ? "bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06]"
                      }`}
                    >
                      I
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* ================================================================ */}
        {/*  Track labels + Timeline area                                    */}
        {/* ================================================================ */}
        <div className="flex flex-1 min-h-0">
          {/* track labels column */}
          <div className="w-[72px] flex-shrink-0 border-r border-black/[0.06] bg-white/40 flex flex-col">
            {/* timecode header spacer */}
            <div className="h-7 border-b border-black/[0.04]" />
            {/* video label */}
            <div className="h-12 flex items-center px-2 border-b border-black/[0.04]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-600/70">Video</span>
            </div>
            {/* subtitle label */}
            <div className="h-14 flex items-center px-2 border-b border-black/[0.04]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-600/70">Subtitle</span>
            </div>
            {/* audio label */}
            <div className="flex-1 flex items-center px-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-600/70">Audio</span>
            </div>
          </div>

          {/* scrollable timeline */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden"
            style={{ scrollBehavior: "auto" }}
          >
            <div className="relative" style={{ width: totalWidth, minHeight: "100%" }}>
              {/* ---- Timecode Ruler ---- */}
              <div className="h-7 border-b border-black/[0.04] bg-white/70 relative">
                {Array.from({ length: Math.ceil(paddedDuration / 5) + 1 }, (_, i) => {
                  const t = i * 5;
                  const x = t * pixelsPerSec;
                  if (x > totalWidth + 20) return null;
                  return (
                    <div key={i} className="absolute top-0 h-full" style={{ left: x }}>
                      <div className="absolute top-0 left-0 w-px h-2.5 bg-black/[0.12]" />
                      <span className="absolute top-2 left-1 text-[9px] font-mono tabular-nums text-ink-light select-none whitespace-nowrap">
                        {fmtTimeShort(t)}
                      </span>
                    </div>
                  );
                })}
                {/* minor ticks every 1 second */}
                {zoom >= 1.5 &&
                  Array.from({ length: Math.ceil(paddedDuration) + 1 }, (_, i) => {
                    if (i % 5 === 0) return null;
                    const x = i * pixelsPerSec;
                    if (x > totalWidth + 20) return null;
                    return (
                      <div
                        key={`s-${i}`}
                        className="absolute top-0 w-px h-1.5 bg-black/[0.06]"
                        style={{ left: x }}
                      />
                    );
                  })}
              </div>

              {/* ---- Video Track ---- */}
              <div
                className="h-12 border-b border-black/[0.04] relative cursor-pointer"
                onClick={seekTimeline}
              >
                {/* video segment */}
                <div
                  className="absolute top-1 bottom-1 rounded-md bg-blue-500/[0.1] ring-1 ring-blue-500/[0.08]"
                  style={{ left: 0, width: duration * pixelsPerSec }}
                >
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-[10px] font-medium text-blue-500/50 select-none">Video ({fmtTimeShort(duration)})</span>
                  </div>
                </div>
                {/* padding zone */}
                {TIMELINE_PADDING > 0 && (
                  <div
                    className="absolute top-1 bottom-1 rounded-md bg-black/[0.02] ring-1 ring-black/[0.04]"
                    style={{ left: duration * pixelsPerSec, width: TIMELINE_PADDING * pixelsPerSec }}
                  >
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-[9px] text-ink-light/50 select-none">+{TIMELINE_PADDING}s padding</span>
                    </div>
                  </div>
                )}
              </div>

              {/* ---- Subtitle Track ---- */}
              <div
                className="h-14 border-b border-black/[0.04] relative bg-amber-500/[0.02] cursor-pointer"
                onClick={seekTimeline}
              >
                {entries.map((entry, i) => {
                  const left = entry.start * pixelsPerSec;
                  const width = Math.max((entry.end - entry.start) * pixelsPerSec, 4);
                  const isSelected = selectedIndex === i;
                  const isDragging = dragState?.index === i;
                  const showDetail = isSelected || isDragging;
                  return (
                    <div
                      key={i}
                      data-index={i}
                      className={`absolute top-1.5 bottom-1.5 rounded-lg flex items-center overflow-hidden select-none transition-shadow duration-150 group ${
                        isSelected || isDragging
                          ? "bg-amber-500/30 ring-2 ring-amber-500/50 shadow-md z-10"
                          : "bg-amber-500/20 ring-1 ring-amber-500/15 hover:bg-amber-500/25 cursor-grab"
                      }`}
                      style={{ left, width }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                        const relX = e.clientX - rect.left;
                        const edge = 10;
                        let mode: DragMode = "move";
                        if (relX < edge) mode = "resize-start";
                        else if (relX > width - edge) mode = "resize-end";
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                        startDrag(i, mode, e.clientX);
                      }}
                      onPointerMove={(e) => {
                        if (!dragState) {
                          const rect = (e.target as HTMLElement).getBoundingClientRect();
                          const relX = e.clientX - rect.left;
                          const edge = 10;
                          const el = e.target as HTMLElement;
                          if (relX < edge) el.style.cursor = "ew-resize";
                          else if (relX > rect.width - edge) el.style.cursor = "ew-resize";
                          else el.style.cursor = "grab";
                        }
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditing({ index: i, text: entry.text });
                      }}
                    >
                      {/* resize handle LEFT — with grip dots */}
                      <div
                        className="absolute left-0 top-0 bottom-0 w-[10px] cursor-ew-resize flex items-center justify-center bg-amber-500/10 hover:bg-amber-500/30 rounded-l-lg transition-colors"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          (e.target as HTMLElement).setPointerCapture(e.pointerId);
                          startDrag(i, "resize-start", e.clientX);
                        }}
                      >
                        <div className="flex gap-[1.5px]">
                          <div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" />
                          <div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" />
                        </div>
                      </div>

                      {/* resize handle RIGHT — with grip dots */}
                      <div
                        className="absolute right-0 top-0 bottom-0 w-[10px] cursor-ew-resize flex items-center justify-center bg-amber-500/10 hover:bg-amber-500/30 rounded-r-lg transition-colors"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          (e.target as HTMLElement).setPointerCapture(e.pointerId);
                          startDrag(i, "resize-end", e.clientX);
                        }}
                      >
                        <div className="flex gap-[1.5px]">
                          <div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" />
                          <div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" />
                        </div>
                      </div>

                      {/* time label (visible when selected or dragging) */}
                      {showDetail && (
                        <div className="absolute -top-4 left-0 right-0 flex items-center justify-between px-2">
                          <span className="text-[8px] font-mono tabular-nums text-amber-700/80 bg-amber-100/90 rounded px-1 leading-tight">
                            {secToSrt(entry.start)}
                          </span>
                          <span className="text-[8px] font-mono tabular-nums text-amber-700/80 bg-amber-100/90 rounded px-1 leading-tight">
                            {secToSrt(entry.end)}
                          </span>
                        </div>
                      )}

                      {/* label */}
                      <span className="px-3 text-[10px] font-medium text-amber-800/80 truncate select-none leading-tight w-full">
                        {entry.text}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* ---- Audio Track ---- */}
              <div
                className="h-12 relative bg-emerald-500/[0.02] cursor-pointer flex items-end"
                onClick={seekTimeline}
              >
                {waveform.map((h, i) => {
                  const x = (i / waveformBars) * totalWidth;
                  const barW = Math.max(1, totalWidth / waveformBars - 0.5);
                  return (
                    <div
                      key={i}
                      className="absolute bottom-1 rounded-t-[1px] bg-emerald-500/20"
                      style={{
                        left: x,
                        width: barW,
                        height: `${Math.max(3, h * 40)}px`,
                      }}
                    />
                  );
                })}
              </div>

              {/* ---- Playhead ---- */}
              <div
                className="absolute top-0 bottom-0 z-30 pointer-events-none"
                style={{ left: currentTime * pixelsPerSec }}
              >
                {/* line */}
                <div className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]" />
                {/* handle at top */}
                <div
                  className="absolute -top-0.5 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full border-2 border-white shadow-md cursor-ew-resize pointer-events-auto"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const el = scrollRef.current;
                    if (!el) return;
                    const onMove = (ev: PointerEvent) => {
                      const rect = el.getBoundingClientRect();
                      const x = ev.clientX - rect.left + el.scrollLeft;
                      const t = Math.max(0, Math.min(duration, x / pixelsPerSec));
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
        {/*  Text edit popup                                                 */}
        {/* ================================================================ */}
        {editing && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
            <div
              className="glass-panel rounded-2xl p-5 w-full max-w-lg mx-4 shadow-2xl"
              style={{ animation: "scale-in 0.2s ease forwards" }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                  Sửa phụ đề #{editing.index + 1}
                </span>
                <button
                  onClick={() => setEditing(null)}
                  className="w-6 h-6 rounded-full bg-black/[0.04] flex items-center justify-center hover:bg-black/[0.08] transition-colors cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] font-mono text-ink-light tabular-nums">
                  {secToSrt(entries[editing.index]?.start || 0)} → {secToSrt(entries[editing.index]?.end || 0)}
                </span>
              </div>
              <textarea
                autoFocus
                className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/30 transition-all"
                rows={3}
                defaultValue={editing.text}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    commitEdit((e.target as HTMLTextAreaElement).value);
                  }
                  if (e.key === "Escape") setEditing(null);
                }}
                ref={(el) => el?.focus()}
              />
              <div className="flex items-center justify-between mt-3">
                <button
                  onClick={() => {
                    deleteEntry(editing.index);
                    setEditing(null);
                  }}
                  className="px-3 py-1.5 rounded-full text-[11px] font-medium text-red-600 ring-1 ring-red-500/20 hover:bg-red-500/10 transition-colors cursor-pointer"
                >
                  Xoá
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditing(null)}
                    className="px-4 py-1.5 rounded-full text-[11px] font-medium text-ink-muted hover:bg-black/[0.04] transition-colors cursor-pointer"
                  >
                    Huỷ
                  </button>
                  <button
                    onClick={() => {
                      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
                      if (textarea) commitEdit(textarea.value);
                    }}
                    className="px-4 py-1.5 rounded-full text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Lưu <span className="opacity-60 ml-0.5">⌘↵</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* drag cursor overlay */}
      {dragState && (
        <div
          className="fixed inset-0 z-50"
          style={{ cursor: dragState.mode === "move" ? "grabbing" : "ew-resize" }}
        />
      )}
    </div>
  );
}
