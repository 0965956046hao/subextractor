"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getSrtEntries, updateSrt, getVideoUrl, getSrtContent } from "@/lib/api";
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

const DEFAULT_STYLE: SubtitleStyle = {
  x: 50,
  y: 90,
  maxWidth: 90,
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
  "Plus Jakarta Sans", "Arial", "Helvetica", "Times New Roman",
  "Georgia", "Courier New", "Verdana", "Tahoma",
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
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
  return entries.map((e, i) => `${i + 1}\n${secToSrt(e.start)} --> ${secToSrt(e.end)}\n${e.text}\n`).join("\n");
}

let _trackCounter = 0;
function newTrackId(): string { return `track_${++_trackCounter}_${Date.now()}`; }

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface TimelineEditorProps {
  videoId: string;
  duration?: number;
}

export default function TimelineEditor({ videoId, duration: initialDuration = 0 }: TimelineEditorProps) {
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
  const [editing, setEditing] = useState<{ trackId: string; index: number; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [applyAll, setApplyAll] = useState(false);
  const [showStylePanel, setShowStylePanel] = useState(false);
  const [confirmDeleteTrack, setConfirmDeleteTrack] = useState<string | null>(null);

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
        index: e.index, start: e.start, end: e.end,
        startLabel: e.startLabel, endLabel: e.endLabel, text: e.text,
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
            start: parseTime(timeMatch[1]), end: parseTime(timeMatch[2]),
            startLabel: timeMatch[1], endLabel: timeMatch[2],
            text: lines.slice(2).join(" "),
          });
        }
        setTracks([{ id: newTrackId(), name: "Subtitle 1", entries: parsed }]);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load subtitles");
        setLoading(false);
      }
    }
  }, [videoId]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  /* ---- video duration ---- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const updateDur = () => {
      if (v.duration && Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
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
        if (v.duration && Number.isFinite(v.duration) && v.duration > 0 && Math.abs(v.duration - duration) > 0.5) {
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

  /* ---- save SRT ---- */
  const saveSrt = useCallback(async () => {
    if (saved) return;
    try {
      const allEntries = tracks.flatMap((t) => t.entries);
      const content = entriesToSrt(allEntries);
      await updateSrt(videoId, content);
      setSaved(true);
    } catch { /* silent */ }
  }, [tracks, videoId, saved]);

  /* ---- helpers ---- */
  const getTrackEntries = (trackId: string): SrtEntry[] =>
    tracks.find((t) => t.id === trackId)?.entries ?? [];

  /* ---- actions ---- */
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play?.().catch(() => {}); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  };
  togglePlayRef.current = togglePlay;

  const seekTimeline = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    const t = Math.max(0, Math.min(duration, x / pixelsPerSec));
    const v = videoRef.current;
    if (v) { v.currentTime = t; setCurrentTime(t); }
  };

  /* ---- drag helpers ---- */
  const startDrag = useCallback(
    (trackId: string, index: number, mode: DragMode, clientX: number, clientY: number) => {
      const e = tracks.find((t) => t.id === trackId)?.entries[index];
      if (!e) return;
      setDragState({ trackId, index, mode, startX: clientX, startY: clientY, origStart: e.start, origEnd: e.end });
      setSelectedTrack(trackId);
      setSelectedIndex(index);
    },
    [tracks]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragState) return;

      // detect which track the mouse is over (for cross-track drag)
      if (dragState.mode === "move") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const row = el?.closest?.("[data-track-id]") as HTMLElement | null;
        const overId = row?.dataset.trackId ?? null;
        setDragOverTrackId(overId && overId !== dragState.trackId ? overId : null);
      }

      const dx = (e.clientX - dragState.startX) / pixelsPerSec;
      setTracks((prev) => prev.map((track) => {
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
          newStart = Math.max(0, Math.min(dragState.origStart + dx, entry.end - minDur));
        } else if (dragState.mode === "resize-end") {
          newEnd = Math.max(entry.start + minDur, dragState.origEnd + dx);
        }

        if (snapping && dragState.mode !== "move") {
          const snapThreshold = 0.3 / zoom;
          const targets: number[] = [0];
          if (dragState.mode === "resize-start") targets.push(entry.end);
          if (dragState.mode === "resize-end") targets.push(entry.start);
          next.forEach((o, i) => { if (i !== dragState.index) { targets.push(o.start, o.end); } });
          const target = dragState.mode === "resize-end" ? newEnd : newStart;
          for (const t of targets) {
            if (Math.abs(target - t) < snapThreshold) {
              if (dragState.mode === "resize-end") newEnd = t;
              else newStart = t;
              break;
            }
          }
        }

        entry.start = newStart; entry.end = newEnd;
        entry.startLabel = secToSrt(newStart); entry.endLabel = secToSrt(newEnd);
        next[dragState.index] = entry;
        return { ...track, entries: next };
      }));
    },
    [dragState, pixelsPerSec, snapping, zoom]
  );

  const endDrag = useCallback(() => {
    if (!dragState) return;
    // cross-track move
    if (dragState.mode === "move" && dragOverTrackId) {
      setTracks((prev) => {
        const srcTrack = prev.find((t) => t.id === dragState.trackId);
        const dstTrack = prev.find((t) => t.id === dragOverTrackId);
        if (!srcTrack || !dstTrack) return prev;
        const entry = srcTrack.entries[dragState.index];
        if (!entry) return prev;
        return prev.map((t) => {
          if (t.id === dragState.trackId) {
            return { ...t, entries: t.entries.filter((_, i) => i !== dragState.index).map((e, i) => ({ ...e, index: i + 1 })) };
          }
          if (t.id === dragOverTrackId) {
            const insertAt = t.entries.findIndex((e) => e.start > entry.start);
            const idx = insertAt === -1 ? t.entries.length : insertAt;
            const next = [...t.entries];
            next.splice(idx, 0, entry);
            return { ...t, entries: next.map((e, i) => ({ ...e, index: i + 1 })) };
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
    setTracks((prev) => [...prev, { id, name: `Subtitle ${num}`, entries: [] }]);
    setSaved(false);
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
    if (selectedTrack === trackId) { setSelectedTrack(null); setSelectedIndex(null); }
    setSaved(false);
    setConfirmDeleteTrack(null);
  };

  const renameTrack = (trackId: string, name: string) => {
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, name } : t)));
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
      index: track.entries.length + 1, start, end,
      startLabel: secToSrt(start), endLabel: secToSrt(end), text: "",
    };
    setTracks((prev) => prev.map((t) => {
      if (t.id !== selectedTrack) return t;
      const insertAt = t.entries.findIndex((e) => e.start > start);
      const idx = insertAt === -1 ? t.entries.length : insertAt;
      const next = [...t.entries];
      next.splice(idx, 0, newEntry);
      return { ...t, entries: next.map((e, i) => ({ ...e, index: i + 1 })) };
    }));
    setSaved(false);
  };

  const commitEdit = (text: string) => {
    if (!editing) return;
    setTracks((prev) => prev.map((t) => {
      if (t.id !== editing.trackId) return t;
      const next = [...t.entries];
      next[editing.index] = { ...next[editing.index], text };
      return { ...t, entries: next };
    }));
    setSaved(false);
    setEditing(null);
  };

  const deleteEntry = (trackId: string, index: number) => {
    setTracks((prev) => prev.map((t) => {
      if (t.id !== trackId) return t;
      return { ...t, entries: t.entries.filter((_, i) => i !== index) };
    }));
    setSaved(false);
    if (selectedTrack === trackId && selectedIndex === index) { setSelectedIndex(null); }
  };

  /* ---- style helpers ---- */
  const getEntryStyle = (trackId: string, index: number): SubtitleStyle => {
    return tracks.find((t) => t.id === trackId)?.entries[index]?.style ?? DEFAULT_STYLE;
  };

  const updateStyle = (key: keyof SubtitleStyle, value: string | number | boolean) => {
    if (selectedTrack === null || selectedIndex === null) return;
    setTracks((prev) => prev.map((track) => {
      if (track.id !== selectedTrack) return track;
      const next = [...track.entries];
      if (applyAll) {
        for (let i = 0; i < next.length; i++) {
          next[i] = { ...next[i], style: { ...getEntryStyle(track.id, i), [key]: value } };
        }
      } else {
        next[selectedIndex] = { ...next[selectedIndex], style: { ...getEntryStyle(track.id, selectedIndex), [key]: value } };
      }
      return { ...track, entries: next };
    }));
    setSaved(false);
  };

  const getCurrentStyle = (): SubtitleStyle => {
    if (selectedTrack !== null && selectedIndex !== null) {
      return getEntryStyle(selectedTrack, selectedIndex);
    }
    return DEFAULT_STYLE;
  };

  /* ---- all entries across all tracks (for video overlay) ---- */
  const allActive = tracks.flatMap((track) =>
    track.entries
      .filter((e) => currentTime >= e.start && currentTime < e.end)
      .map((e) => ({ ...e, _trackId: track.id }))
  );

  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  /* ---- all entries for waveform ---- */
  const allEntries = tracks.flatMap((t) => t.entries);

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
          <div className="flex items-center gap-2">
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
            <span className="text-xs font-mono tabular-nums text-ink-muted min-w-[90px]">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
            <button
              onClick={() => setSnapping(!snapping)}
              aria-label="Toggle snapping"
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300 cursor-pointer ${
                snapping ? "bg-blue-600/10 text-blue-600 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06]"
              }`}
              title="Bắt điểm (Snapping)"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3h4l2 7-2 7H6l2-7-2-7z" /><path d="M13 3l3 7-3 7" /><line x1="3" y1="21" x2="21" y2="21" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <button onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))} className="w-6 h-6 rounded-md bg-black/[0.03] text-ink-light hover:bg-black/[0.06] flex items-center justify-center text-xs font-bold transition-colors cursor-pointer">−</button>
              <input type="range" min={0.25} max={6} step={0.25} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="w-20 h-1 accent-blue-600 cursor-pointer" />
              <button onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))} className="w-6 h-6 rounded-md bg-black/[0.03] text-ink-light hover:bg-black/[0.06] flex items-center justify-center text-xs font-bold transition-colors cursor-pointer">+</button>
              <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-right">{zoom.toFixed(2)}x</span>
            </div>
            <button onClick={addTrack} className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-green-500/10 text-green-700 ring-1 ring-green-500/20 hover:bg-green-500/20 transition-colors cursor-pointer flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm track
            </button>
            <button
              onClick={addEntry}
              disabled={!selectedTrack}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm phụ đề
            </button>
            <button
              onClick={saveSrt}
              disabled={saved}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-colors cursor-pointer disabled:cursor-not-allowed ${
                saved ? "bg-black/[0.02] text-ink-light ring-1 ring-black/[0.04]" : "bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/25 hover:bg-blue-600/20"
              }`}
            >
              {saved ? "Đã lưu" : "Lưu thay đổi"}
            </button>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Video Preview + Subtitle Overlay                                */}
        {/* ================================================================ */}
        <div className="relative bg-black mx-4 mt-4 rounded-2xl overflow-hidden aspect-video max-h-[360px]">
          <video ref={videoRef} src={getVideoUrl(videoId)} className="w-full h-full object-contain" playsInline preload="auto" />
          {allActive.map((entry, i) => {
            const s = entry.style ?? DEFAULT_STYLE;
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
                    left: `${s.x}%`,
                    top: `${s.y}%`,
                    maxWidth: `${s.maxWidth}%`,
                    transform: `translate(-50%, -50%) translateY(${i * 60}px)`,
                    animation: "fade-in 0.25s ease forwards",
                    backgroundColor: s.showBg ? hexToRgba(s.bgColor, s.bgOpacity) : "transparent",
                    backdropFilter: s.showBg ? "blur(8px)" : "none",
                  }}
                  onPointerDown={(e) => {
                    const el = e.currentTarget as HTMLElement;
                    const relX = e.clientX - el.getBoundingClientRect().left;
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
                        const dxPct = (ev.clientX - e.clientX) / rect.width * 100;
                        const nw = Math.max(15, Math.min(95, origW + dxPct * 2));
                        setTracks((prev) => prev.map((t) => {
                          if (t.id !== entry._trackId) return t;
                          const next = [...t.entries];
                          if (applyAll) {
                            for (let i = 0; i < next.length; i++) {
                              next[i] = { ...next[i], style: { ...(next[i].style ?? DEFAULT_STYLE), maxWidth: Math.round(nw) } };
                            }
                          } else {
                            const idx = t.entries.findIndex((en) => en.index === entry.index);
                            if (idx < 0) return t;
                            next[idx] = { ...next[idx], style: { ...(next[idx].style ?? DEFAULT_STYLE), maxWidth: Math.round(nw) } };
                          }
                          return { ...t, entries: next };
                        }));
                        setSaved(false);
                      };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      if (applyAll) {
                        const count = tracks.find((t) => t.id === trackId)?.entries.length ?? 0;
                        setToast(`Đã cập nhật vị trí cho ${count} phụ đề`);
                        setTimeout(() => setToast(null), 2500);
                      }
                    };
                      window.addEventListener("pointermove", onMove);
                      window.addEventListener("pointerup", onUp);
                      return;
                    }
                    // position drag
                    e.preventDefault();
                    const parent = (e.currentTarget as HTMLElement).parentElement;
                    if (!parent) return;
                    const rect = parent.getBoundingClientRect();
                    const trackId = entry._trackId;
                    const entIdx = tracks.find((t) => t.id === trackId)?.entries.findIndex((en) => en.index === entry.index) ?? -1;
                    if (entIdx < 0) return;
                    const origX = s.x;
                    const origY = s.y;
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    const onMove = (ev: PointerEvent) => {
                      const dxPct = (ev.clientX - e.clientX) / rect.width * 100;
                      const dyPct = (ev.clientY - e.clientY) / rect.height * 100;
                      const nx = Math.max(5, Math.min(95, origX + dxPct));
                      const ny = Math.max(5, Math.min(95, origY + dyPct));
                      setTracks((prev) => prev.map((t) => {
                        if (t.id !== trackId) return t;
                        const next = [...t.entries];
                        if (applyAll) {
                          for (let i = 0; i < next.length; i++) {
                            next[i] = { ...next[i], style: { ...(next[i].style ?? DEFAULT_STYLE), x: Math.round(nx), y: Math.round(ny) } };
                          }
                        } else {
                          next[entIdx] = { ...next[entIdx], style: { ...(next[entIdx].style ?? DEFAULT_STYLE), x: Math.round(nx), y: Math.round(ny) } };
                        }
                        return { ...t, entries: next };
                      }));
                      setSaved(false);
                    };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      if (applyAll) {
                        const count = tracks.find((t) => t.id === trackId)?.entries.length ?? 0;
                        setToast(`Đã cập nhật vị trí cho ${count} phụ đề trong track`);
                        setTimeout(() => setToast(null), 2500);
                      }
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                >
                  {/* drag handle */}
                  <div className={`absolute -top-2 left-1/2 -translate-x-1/2 flex gap-[2px] ${s.showBg ? "opacity-40" : "opacity-70"}`}>
                    <div className={`w-1 h-1 rounded-full ${s.showBg ? "bg-white" : "bg-gray-400"}`} />
                    <div className={`w-1 h-1 rounded-full ${s.showBg ? "bg-white" : "bg-gray-400"}`} />
                    <div className={`w-1 h-1 rounded-full ${s.showBg ? "bg-white" : "bg-gray-400"}`} />
                  </div>
                  {/* center indicator */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-red-500/80 opacity-60 pointer-events-none" title="Tâm (X,Y)" />
                  {/* resize handle (right edge, only when bg visible) */}
                  {s.showBg && (
                    <div className="absolute right-0 top-0 bottom-0 w-[10px] cursor-ew-resize hover:bg-white/10 rounded-r-xl flex items-center justify-center opacity-0 group-hover/vidtext:opacity-100 transition-opacity">
                      <div className="flex gap-[1.5px]">
                        <div className="w-[1.5px] h-4 rounded-full bg-white/50" />
                        <div className="w-[1.5px] h-4 rounded-full bg-white/50" />
                      </div>
                    </div>
                  )}
                  <p style={{
                    color: s.textColor, fontFamily: s.fontFamily, fontSize: `${s.fontSize}px`,
                    fontWeight: s.bold ? 700 : 400, fontStyle: s.italic ? "italic" : "normal",
                    textAlign: s.textAlign,
                    lineHeight: 1.4, letterSpacing: "0.02em",
                    textShadow: s.showBg ? "none" : "0 1px 4px rgba(0,0,0,0.5)",
                  }}>{entry.text}</p>
                </div>
              </div>
            );
          })}
          {allActive.length === 0 && !playing && (
            <button onClick={togglePlay} aria-label="Play" className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm border border-white/15 flex items-center justify-center transition-all duration-300 active:scale-95 cursor-pointer">
              <svg className="w-6 h-6 text-white ml-1" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </button>
          )}
        </div>

        {/* ================================================================ */}
        {/*  Playback Control Bar                                            */}
        {/* ================================================================ */}
        <div className="mx-4 mt-2 glass-panel rounded-2xl px-3 py-2.5 flex items-center gap-3">
          <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-500 shadow-sm active:scale-[0.95] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer flex-shrink-0">
            {playing ? (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            ) : (
              <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          <div className="flex-1 h-1.5 rounded-full bg-black/[0.08] overflow-hidden cursor-pointer group relative" onClick={(e) => {
            const v = videoRef.current;
            const bar = e.currentTarget;
            if (!v || !bar) return;
            const rect = bar.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            v.currentTime = pct * (v.duration || 0);
            setCurrentTime(v.currentTime);
          }}>
            <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-100" style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
          <span className="text-[11px] font-mono text-ink-light tabular-nums tracking-tight flex-shrink-0">
            {Math.floor(currentTime / 60)}:{String(Math.floor(currentTime % 60)).padStart(2, "0")} / {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}
          </span>
        </div>

        {/* ================================================================ */}
        {/*  Style Panel                                                     */}
        {/* ================================================================ */}
        <div className="px-4 pt-3 border-b border-black/[0.06] bg-white/40">
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setShowStylePanel(!showStylePanel)} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors cursor-pointer">
              <svg className={`w-3.5 h-3.5 transition-transform duration-300 ${showStylePanel ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Định dạng phụ đề
            </button>
            {selectedIndex !== null && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} className="w-3.5 h-3.5 accent-blue-600 cursor-pointer" />
                <span className="text-[10px] font-medium text-ink-muted">Apply to all</span>
              </label>
            )}
          </div>
          {showStylePanel && (() => {
            const s = getCurrentStyle();
            return (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pb-3" style={{ animation: "fade-in 0.2s ease forwards" }}>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Vị trí X/Y</span>
                  <div className="flex gap-1 items-center"><span className="text-[8px] font-mono text-ink-light w-2.5">X</span><input type="range" min={5} max={95} value={s.x} onChange={(e) => updateStyle("x", parseInt(e.target.value))} disabled={selectedIndex === null} className="flex-1 h-1 accent-blue-600 cursor-pointer disabled:opacity-40" /><span className="text-[8px] font-mono text-ink-light tabular-nums w-6 text-right">{s.x}%</span></div>
                  <div className="flex gap-1 items-center"><span className="text-[8px] font-mono text-ink-light w-2.5">Y</span><input type="range" min={5} max={95} value={s.y} onChange={(e) => updateStyle("y", parseInt(e.target.value))} disabled={selectedIndex === null} className="flex-1 h-1 accent-blue-600 cursor-pointer disabled:opacity-40" /><span className="text-[8px] font-mono text-ink-light tabular-nums w-6 text-right">{s.y}%</span></div>
                  <div className="flex gap-0.5 mt-0.5">
                    {[
                      { label: "Dưới", x: 50, y: 90 },
                      { label: "Giữa", x: 50, y: 50 },
                      { label: "Trên", x: 50, y: 10 },
                    ].map((p) => (
                      <button
                        key={p.label}
                        onClick={() => { updateStyle("x", p.x); updateStyle("y", p.y); }}
                        disabled={selectedIndex === null}
                        className="flex-1 py-0.5 text-[9px] font-medium rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-black/[0.03] text-ink-light hover:bg-black/[0.06] hover:text-ink"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Font</span>
                  <select value={s.fontFamily} onChange={(e) => updateStyle("fontFamily", e.target.value)} disabled={selectedIndex === null} className="w-full rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-[10px] font-medium text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-40 cursor-pointer">
                    {FONT_OPTIONS.map((f) => (<option key={f} value={f}>{f}</option>))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Cỡ chữ</span>
                  <select value={s.fontSize} onChange={(e) => updateStyle("fontSize", parseInt(e.target.value))} disabled={selectedIndex === null} className="w-full rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-[10px] font-medium text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-40 cursor-pointer">
                    {[12, 14, 16, 18, 20, 24, 28, 32, 40].map((n) => (<option key={n} value={n}>{n}px</option>))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Chữ</span>
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={s.textColor} onChange={(e) => updateStyle("textColor", e.target.value)} disabled={selectedIndex === null} className="w-6 h-6 rounded-md border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-0" />
                    <span className="text-[9px] font-mono text-ink-light tabular-nums">{s.textColor}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Nền</span>
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={s.bgColor} onChange={(e) => updateStyle("bgColor", e.target.value)} disabled={selectedIndex === null} className="w-6 h-6 rounded-md border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-0" />
                    <input type="range" min={0} max={100} value={Math.round(s.bgOpacity * 100)} onChange={(e) => updateStyle("bgOpacity", parseInt(e.target.value) / 100)} disabled={selectedIndex === null} className="w-10 h-1 accent-blue-600 cursor-pointer disabled:opacity-40" />
                    <span className="text-[9px] font-mono text-ink-light tabular-nums">{Math.round(s.bgOpacity * 100)}%</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Align</span>
                  <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
                    {(["left", "center", "right"] as const).map((a) => (
                      <button
                        key={a}
                        onClick={() => updateStyle("textAlign", a)}
                        disabled={selectedIndex === null}
                        className={`flex-1 py-1 text-[10px] font-medium rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                          s.textAlign === a ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.06]" : "text-ink-light hover:text-ink"
                        }`}
                      >
                        {a === "left" ? "Trái" : a === "center" ? "Giữa" : "Phải"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Kiểu</span>
                  <div className="flex gap-1">
                    <button onClick={() => updateStyle("bold", !s.bold)} disabled={selectedIndex === null} className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${s.bold ? "bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06]"}`}>B</button>
                    <button onClick={() => updateStyle("italic", !s.italic)} disabled={selectedIndex === null} className={`flex-1 py-1 text-[10px] italic rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${s.italic ? "bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/25" : "bg-black/[0.03] text-ink-light hover:bg-black/[0.06]"}`}>I</button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Rộng</span>
                  <div className="flex gap-1 items-center">
                    <input type="range" min={15} max={95} value={s.maxWidth} onChange={(e) => updateStyle("maxWidth", parseInt(e.target.value))} disabled={selectedIndex === null} className="flex-1 h-1 accent-blue-600 cursor-pointer disabled:opacity-40" />
                    <span className="text-[8px] font-mono text-ink-light tabular-nums w-6 text-right">{s.maxWidth}%</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wider text-ink-light font-medium">Nền</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={s.showBg} onChange={(e) => updateStyle("showBg", e.target.checked)} disabled={selectedIndex === null} className="w-3.5 h-3.5 accent-blue-600 cursor-pointer disabled:opacity-40" />
                    <span className="text-[10px] font-medium text-ink-muted">Hiện khung nền</span>
                  </label>
                </div>
              </div>
            );
          })()}
        </div>

        {/* ================================================================ */}
        {/*  Track labels + Timeline area                                    */}
        {/* ================================================================ */}
        <div className="flex flex-1 min-h-0">
          <div className="w-[72px] flex-shrink-0 border-r border-black/[0.06] bg-white/40 flex flex-col">
            <div className="h-7 border-b border-black/[0.04]" />
            <div className="h-16 flex items-center px-2 border-b border-black/[0.04]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-600/70">Video</span>
            </div>
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`h-16 flex items-center px-2 border-b border-black/[0.04] cursor-pointer group relative ${
                  selectedTrack === track.id ? "bg-amber-500/[0.08] ring-1 ring-amber-500/20 ring-inset" : ""
                }`}
                onClick={() => setSelectedTrack(track.id)}
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-600/70 truncate">{track.name}</span>
                {tracks.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteTrack(track.id); }}
                    className="absolute right-1 w-4 h-4 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                )}
              </div>
            ))}
            <div className="flex-1 flex items-center px-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-600/70">Audio</span>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden" style={{ scrollBehavior: "auto" }}>
            <div className="relative" style={{ width: totalWidth, minHeight: "100%" }}>
              {/* ---- Timecode Ruler ---- */}
              <div className="h-7 border-b border-black/[0.04] bg-white/70 relative">
                {Array.from({ length: Math.ceil(duration / 5) + 1 }, (_, i) => {
                  const t = i * 5;
                  const x = t * pixelsPerSec;
                  if (x > totalWidth + 20) return null;
                  return (
                    <div key={i} className="absolute top-0 h-full" style={{ left: x }}>
                      <div className="absolute top-0 left-0 w-px h-2.5 bg-black/[0.12]" />
                      <span className="absolute top-2 left-1 text-[9px] font-mono tabular-nums text-ink-light select-none whitespace-nowrap">{fmtTimeShort(t)}</span>
                    </div>
                  );
                })}
                {zoom >= 1.5 && Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => {
                  if (i % 5 === 0) return null;
                  const x = i * pixelsPerSec;
                  if (x > totalWidth + 20) return null;
                  return (<div key={`s-${i}`} className="absolute top-0 w-px h-1.5 bg-black/[0.06]" style={{ left: x }} />);
                })}
              </div>

              {/* ---- Video Track ---- */}
              <div className="h-16 border-b border-black/[0.04] relative cursor-pointer" onClick={seekTimeline}>
                {Array.from({ length: Math.ceil(duration / 10) }, (_, i) => {
                  const segStart = i * 10;
                  const segEnd = Math.min(segStart + 10, duration);
                  const segWidth = (segEnd - segStart) * pixelsPerSec;
                  return (
                    <div key={i} className="absolute top-1.5 bottom-1.5 rounded-md flex items-center justify-center" style={{
                      left: segStart * pixelsPerSec, width: segWidth,
                      background: i % 2 === 0 ? "linear-gradient(180deg, rgba(59,130,246,0.08) 0%, rgba(59,130,246,0.04) 100%)" : "linear-gradient(180deg, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.06) 100%)",
                      border: "1px solid rgba(59,130,246,0.2)",
                    }}>
                      {segWidth > 40 && (<span className="text-[9px] font-mono text-blue-400/50 tabular-nums select-none">{fmtTimeShort(segStart)}</span>)}
                    </div>
                  );
                })}
              </div>

              {/* ---- Subtitle Tracks ---- */}
              {tracks.map((track) => (
                <div
                  key={track.id}
                  data-track-id={track.id}
                  className={`h-16 border-b border-black/[0.04] relative cursor-pointer transition-colors duration-200 ${
                    dragOverTrackId === track.id
                      ? "bg-amber-500/15 ring-2 ring-amber-500/40 ring-inset"
                      : "bg-amber-500/[0.02]"
                  }`}
                  onClick={seekTimeline}
                >
                  {track.entries.map((entry, i) => {
                    const left = entry.start * pixelsPerSec;
                    const width = Math.max((entry.end - entry.start) * pixelsPerSec, 4);
                    const isSelected = selectedTrack === track.id && selectedIndex === i;
                    const isDragging = dragState?.trackId === track.id && dragState?.index === i;
                    const showDetail = isSelected || isDragging;
                    return (
                      <div key={i} data-index={i}
                        className={`absolute top-1.5 bottom-1.5 rounded-lg flex items-center overflow-hidden select-none transition-shadow duration-150 group ${
                          isSelected || isDragging ? "bg-amber-500/30 ring-2 ring-amber-500/50 shadow-md z-10" : "bg-amber-500/20 ring-1 ring-amber-500/15 hover:bg-amber-500/25 cursor-grab"
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
                          startDrag(track.id, i, mode, e.clientX, e.clientY);
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
                          setEditing({ trackId: track.id, index: i, text: entry.text });
                        }}
                      >
                        <div className="absolute left-0 top-0 bottom-0 w-[10px] cursor-ew-resize flex items-center justify-center bg-amber-500/10 hover:bg-amber-500/30 rounded-l-lg transition-colors"
                          onPointerDown={(e) => { e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startDrag(track.id, i, "resize-start", e.clientX, e.clientY); }}>
                          <div className="flex gap-[1.5px]"><div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" /><div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" /></div>
                        </div>
                        <div className="absolute right-0 top-0 bottom-0 w-[10px] cursor-ew-resize flex items-center justify-center bg-amber-500/10 hover:bg-amber-500/30 rounded-r-lg transition-colors"
                          onPointerDown={(e) => { e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startDrag(track.id, i, "resize-end", e.clientX, e.clientY); }}>
                          <div className="flex gap-[1.5px]"><div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" /><div className="w-[1.5px] h-4 rounded-full bg-amber-500/50 group-hover:bg-amber-500/70" /></div>
                        </div>
                        {showDetail && (
                          <div className="absolute -top-4 left-0 right-0 flex items-center justify-between px-2">
                            <span className="text-[8px] font-mono tabular-nums text-amber-700/80 bg-amber-100/90 rounded px-1 leading-tight">{secToSrt(entry.start)}</span>
                            <span className="text-[8px] font-mono tabular-nums text-amber-700/80 bg-amber-100/90 rounded px-1 leading-tight">{secToSrt(entry.end)}</span>
                          </div>
                        )}
                        <span className="px-3 text-[10px] font-medium text-amber-800/80 truncate select-none leading-tight w-full">{entry.text}</span>
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* ---- Audio Track ---- */}
              <div className="h-16 relative bg-emerald-500/[0.02] cursor-pointer flex items-end" onClick={seekTimeline}>
                <div className="absolute inset-x-0 bottom-1 top-1 flex items-end">
                  {Array.from({ length: Math.ceil(duration * 2) }, (_, i) => {
                    const t = i / 2;
                    const x = t * pixelsPerSec;
                    if (x > totalWidth + 2) return null;
                    const nearSub = allEntries.some((e) => t >= e.start && t <= e.end);
                    const h = nearSub ? 0.6 + 0.3 * (Math.sin(i * 0.7) * 0.5 + 0.5) : 0.2 + 0.25 * (Math.sin(i * 0.3) * 0.5 + 0.5);
                    const barW = Math.max(1, pixelsPerSec / 2 - 0.5);
                    return (<div key={i} className="absolute rounded-t-[1px]" style={{ left: x, width: barW, height: `${Math.max(2, h * 54)}px`, background: nearSub ? "rgba(16,185,129,0.3)" : "rgba(16,185,129,0.15)" }} />);
                  })}
                </div>
              </div>

              {/* ---- Playhead ---- */}
              <div className="absolute top-0 bottom-0 z-30 pointer-events-none" style={{ left: currentTime * pixelsPerSec }}>
                <div className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]" />
                <div className="absolute -top-0.5 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full border-2 border-white shadow-md cursor-ew-resize pointer-events-auto"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const el = scrollRef.current;
                    if (!el) return;
                    const onMove = (ev: PointerEvent) => {
                      const rect = el.getBoundingClientRect();
                      const x = ev.clientX - rect.left + el.scrollLeft;
                      const t = Math.max(0, Math.min(duration, x / pixelsPerSec));
                      const v = videoRef.current;
                      if (v) { v.currentTime = t; setCurrentTime(t); }
                    };
                    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Delete track confirmation                                        */}
        {/* ================================================================ */}
        {confirmDeleteTrack && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
            <div className="glass-panel rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl text-center" style={{ animation: "scale-in 0.2s ease forwards" }}>
              <svg className="w-8 h-8 text-red-500 mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-sm font-semibold text-ink mb-1">Xoá track này?</p>
              <p className="text-[12px] text-ink-muted mb-5">
                Track này có {tracks.find((t) => t.id === confirmDeleteTrack)?.entries.length ?? 0} phụ đề. Sau khi xoá sẽ không khôi phục được.
              </p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={() => setConfirmDeleteTrack(null)} className="px-5 py-2 rounded-full text-[12px] font-medium text-ink-muted bg-black/[0.03] hover:bg-black/[0.06] transition-colors cursor-pointer">Huỷ</button>
                <button onClick={() => doDeleteTrack(confirmDeleteTrack)} className="px-5 py-2 rounded-full text-[12px] font-medium text-white bg-red-600 hover:bg-red-500 transition-colors cursor-pointer">Xoá</button>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/*  Text edit popup                                                 */}
        {/* ================================================================ */}
        {editing && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
            <div className="glass-panel rounded-2xl p-5 w-full max-w-lg mx-4 shadow-2xl" style={{ animation: "scale-in 0.2s ease forwards" }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Sửa phụ đề #{editing.index + 1}</span>
                <button onClick={() => setEditing(null)} className="w-6 h-6 rounded-full bg-black/[0.04] flex items-center justify-center hover:bg-black/[0.08] transition-colors cursor-pointer">
                  <svg className="w-3.5 h-3.5 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <textarea autoFocus className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/30 transition-all" rows={3} defaultValue={editing.text}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit((e.target as HTMLTextAreaElement).value);
                  if (e.key === "Escape") setEditing(null);
                }}
                ref={(el) => el?.focus()}
              />
              <div className="flex items-center justify-between mt-3">
                <button onClick={() => { deleteEntry(editing.trackId, editing.index); setEditing(null); }} className="px-3 py-1.5 rounded-full text-[11px] font-medium text-red-600 ring-1 ring-red-500/20 hover:bg-red-500/10 transition-colors cursor-pointer">Xoá</button>
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditing(null)} className="px-4 py-1.5 rounded-full text-[11px] font-medium text-ink-muted hover:bg-black/[0.04] transition-colors cursor-pointer">Huỷ</button>
                  <button onClick={() => { const ta = document.querySelector("textarea") as HTMLTextAreaElement; if (ta) commitEdit(ta.value); }} className="px-4 py-1.5 rounded-full text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer">Lưu <span className="opacity-60 ml-0.5">⌘↵</span></button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* toast notification */}
        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-ink/90 text-white text-xs font-medium shadow-lg" style={{ animation: "fade-in 0.2s ease forwards" }}>
            {toast}
          </div>
        )}

        {/* drag cursor overlay */}
        {dragState && (<div className="fixed inset-0 z-50 pointer-events-none" style={{ cursor: dragState.mode === "move" ? "grabbing" : "ew-resize" }} />)}
      </div>
    </div>
  );
}
