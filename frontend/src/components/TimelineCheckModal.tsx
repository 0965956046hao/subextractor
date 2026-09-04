"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getVideoUrl,
  getSrtEntries,
  updateSrt,
  getJobStatus,
  startSrtRiskCheck,
  getSrtRiskResult,
  validateSrtTimeline,
  reTranslateLine,
} from "@/lib/api";
import type {
  SrtEntry,
  TimelineIssue,
  SubtitleRisk,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const ROW_H = 52;
const MIN_DURATION = 0.5;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

function pickInterval(pps: number): number {
  for (const it of [5, 10, 15, 30, 60, 120]) {
    if (it * pps >= 60) return it;
  }
  return 300;
}

function IconSpinner({ className = "w-4 h-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconAlert({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconPlay({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function secToSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function entriesToSrt(entries: SrtEntry[]): string {
  return entries
    .map((e, i) => `${i + 1}\n${secToSrt(e.start)} --> ${secToSrt(e.end)}\n${e.text}\n`)
    .join("\n");
}

function parseSrtTime(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

const RISK_LABELS: Record<string, string> = {
  NOT_TRANSLATED: "timeline.risk.notTranslated",
  TIMELINE_OVERLAP: "timeline.risk.overlap",
  ADJACENT_SIMILAR: "timeline.risk.adjacentSimilar",
};

interface TimelineCheckModalProps {
  videoId: string;
  initialIssues: TimelineIssue[];
  onResolve: (action: "continue") => void;
  onClose: () => void;
  targetLang?: string;
  sourceLang?: string;
}

type DragMode = "move" | "resize-start" | "resize-end" | null;

interface DragState {
  index: number;
  mode: Exclude<DragMode, null>;
  origStart: number;
  origEnd: number;
  grabOffset: number;
}

function AddEntryModal({
  currentTime,
  onAdd,
  onClose,
}: {
  currentTime: number;
  onAdd: (start: number, end: number, text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [startStr, setStartStr] = useState(secToSrt(currentTime));
  const [endStr, setEndStr] = useState(secToSrt(currentTime + 2));
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    const start = parseSrtTime(startStr);
    const end = parseSrtTime(endStr);
    if (start == null || end == null) {
      setError(t("timeline.invalidTimeFormat" as string));
      return;
    }
    if (start >= end) {
      setError(t("timeline.startBeforeEnd" as string));
      return;
    }
    if (!text.trim()) {
      setError(t("timeline.textRequired" as string));
      return;
    }
    onAdd(start, end, text.trim());
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="double-bezel w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "scale-in 0.25s cubic-bezier(0.32,0.72,0,1) forwards" }}
      >
        <div className="double-bezel-inner p-5 space-y-4">
          <p className="text-sm font-semibold text-ink">{t("timeline.addEntryTitle" as string)}</p>

          {error && (
            <div className="rounded-xl bg-danger-muted ring-1 ring-danger/15 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}

          <label className="block">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em] mb-1 block">
              {t("timeline.startTime" as string)}
            </span>
            <input
              type="text"
              value={startStr}
              onChange={(e) => setStartStr(e.target.value)}
              placeholder="HH:MM:SS,ms"
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em] mb-1 block">
              {t("timeline.endTime" as string)}
            </span>
            <input
              type="text"
              value={endStr}
              onChange={(e) => setEndStr(e.target.value)}
              placeholder="HH:MM:SS,ms"
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em] mb-1 block">
              {t("timeline.text" as string)}
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/20 resize-none"
            />
          </label>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn-island-secondary btn-sm">
              {t("timeline.cancel" as string)}
            </button>
            <button onClick={handleSubmit} className="btn-island-primary btn-sm">
              {t("timeline.addEntry" as string)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function TimelineCheckModal({
  videoId,
  initialIssues,
  onResolve,
  onClose,
  targetLang = "vi",
  sourceLang = "zh",
}: TimelineCheckModalProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [duration, setDuration] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const [timelineIssues, setTimelineIssues] = useState<TimelineIssue[]>(initialIssues);
  const [risks, setRisks] = useState<SubtitleRisk[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(4);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [retranslatingIndex, setRetranslatingIndex] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSrtEntries(videoId)
      .then((es) => {
        if (cancelled) return;
        setEntries(es);
        setLoadError("");
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : t("timeline.loadError" as string));
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  const issueIndexes = useMemo(() => new Set(timelineIssues.map((i) => i.index)), [timelineIssues]);
  const riskIndexes = useMemo(() => new Set(risks.map((r) => r.index)), [risks]);
  const riskByIndex = useMemo(() => {
    const m = new Map<number, SubtitleRisk>();
    for (const r of risks) m.set(r.index, r);
    return m;
  }, [risks]);

  const effectiveDuration = useMemo(() => {
    if (duration > 0) return duration;
    if (entries.length === 0) return 0;
    return Math.max(...entries.map((e) => e.end), 1);
  }, [duration, entries]);

  // Assign lanes (rows) so overlapping entries go on separate rows.
  const lanes = useMemo(() => {
    const sorted = [...entries].sort((a, b) => a.start - b.start || a.end - b.end);
    const rows: number[][] = [];
    const laneOf = new Map<number, number>();
    for (const e of sorted) {
      let placed = false;
      for (let i = 0; i < rows.length; i++) {
        const lastIdx = rows[i][rows[i].length - 1];
        const last = entries[lastIdx];
        if (e.start >= last.end) {
          rows[i].push(e.index - 1);
          laneOf.set(e.index - 1, i);
          placed = true;
          break;
        }
      }
      if (!placed) {
        rows.push([e.index - 1]);
        laneOf.set(e.index - 1, rows.length - 1);
      }
    }
    return laneOf;
  }, [entries]);

  const basePps = useMemo(() => {
    if (!effectiveDuration) return 20;
    const width = trackRef.current?.clientWidth || 640;
    return Math.min(Math.max(width / effectiveDuration, 8), 80);
  }, [effectiveDuration]);

  const pps = basePps * zoom;
  const interval = pickInterval(pps);

  // Auto-scroll the timeline track to keep the red playhead in view while the
  // video is playing.
  const playheadX = currentTime * pps;
  useEffect(() => {
    if (!playing) return;
    const track = trackRef.current;
    if (!track) return;
    const left = track.scrollLeft;
    const right = left + track.clientWidth;
    if (playheadX < left + 20) {
      track.scrollTo({ left: Math.max(0, playheadX - 60), behavior: "smooth" });
    } else if (playheadX > right - 20) {
      track.scrollTo({ left: playheadX - track.clientWidth / 2, behavior: "smooth" });
    }
  }, [playheadX, playing]);

  const trackWidth = Math.max((effectiveDuration || 1) * pps, trackRef.current?.clientWidth || 0);

  const activeEntry = useMemo(() => {
    if (currentTime < 0) return undefined;
    return entries.find((e) => currentTime >= e.start && currentTime <= e.end);
  }, [entries, currentTime]);

  // Kim timeline chạy tới đâu thì danh sách SRT cuộn theo tới đó.
  const activeListIndex = activeEntry?.index;
  useEffect(() => {
    if (activeListIndex == null) return;
    const el = entryRefs.current.get(activeListIndex);
    const list = listRef.current;
    if (!el || !list) return;
    const lr = list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.top < lr.top + 8 || er.bottom > lr.bottom - 8) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeListIndex]);

  const seekTo = useCallback((sec: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = Math.max(0, Math.min(sec, v.duration || sec));
      v.play().catch(() => {});
    }
    setCurrentTime(sec);
  }, []);

  // Scrub (seek without autoplay) used by click-on-timeline.
  const scrubTo = useCallback(
    (sec: number) => {
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, Math.min(sec, v.duration || sec));
      setCurrentTime(Math.max(0, Math.min(sec, effectiveDuration || sec)));
    },
    [effectiveDuration]
  );

  const selectEntry = useCallback(
    (index: number, sec: number) => {
      setActiveIndex(index);
      seekTo(sec);
      const el = entryRefs.current.get(index);
      if (el && listRef.current) {
        const listRect = listRef.current.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (elRect.top < listRect.top || elRect.bottom > listRect.bottom) {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
      const track = trackRef.current;
      if (track) {
        const targetX = sec * pps;
        const viewport = track.clientWidth;
        const left = track.scrollLeft;
        const right = left + viewport;
        if (targetX < left + 40 || targetX > right - 40) {
          track.scrollTo({ left: Math.max(0, targetX - viewport / 2), behavior: "smooth" });
        }
      }
    },
    [seekTo, pps]
  );

  const patchEntry = useCallback((index: number, patch: Partial<SrtEntry>) => {
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, ...patch } : e))
    );
  }, []);

  const reTranslateEntry = useCallback(
    async (index: number) => {
      setRetranslatingIndex(index);
      setCheckError("");
      try {
        const newText = await reTranslateLine(videoId, index, sourceLang, targetLang);
        patchEntry(index, { text: newText });
        // Clear any risk marker tied to this line — the text changed.
        setRisks((prev) => prev.filter((r) => r.index !== index));
      } catch (e) {
        setCheckError(e instanceof Error ? e.message : t("timeline.reTranslateFailed" as string));
      } finally {
        setRetranslatingIndex(-1);
      }
    },
    [videoId, sourceLang, targetLang, patchEntry]
  );

  const deleteEntry = useCallback((index: number) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.index !== index);
      return next.map((e, i) => ({ ...e, index: i + 1 }));
    });
    setTimelineIssues((prev) =>
      prev
        .filter((i) => i.index !== index)
        .map((i) => (i.index > index ? { ...i, index: i.index - 1 } : i))
    );
    setRisks((prev) =>
      prev
        .filter((r) => r.index !== index)
        .map((r) => (r.index > index ? { ...r, index: r.index - 1 } : r))
    );
    setActiveIndex(-1);
  }, []);

  const addEntry = useCallback(
    (start: number, end: number, text: string) => {
      setEntries((prev) => {
        const newEntry: SrtEntry = {
          index: 0,
          start,
          end,
          startLabel: secToSrt(start),
          endLabel: secToSrt(end),
          text,
        };
        const next = [...prev, newEntry];
        next.sort((a, b) => a.start - b.start || a.end - b.end);
        return next.map((e, i) => ({ ...e, index: i + 1 }));
      });
      setShowAddModal(false);
    },
    [],
  );

  const handleBlockPointerDown = useCallback(
    (e: React.PointerEvent, index: number, mode: Exclude<DragMode, null>) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = entries.find((en) => en.index === index);
      if (!entry) return;
      const track = trackRef.current;
      const origScrollLeft = track?.scrollLeft ?? 0;
      const rect = track?.getBoundingClientRect();
      const grabX = rect ? e.clientX - rect.left + origScrollLeft : 0;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        index,
        mode,
        origStart: entry.start,
        origEnd: entry.end,
        // Time offset between the pointer grab point and the block's start so
        // the block keeps its grab point while dragging.
        grabOffset: mode === "move" ? entry.start - grabX / pps : 0,
      };
    },
    [entries, pps]
  );

  const handleBlockPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      // Auto-scroll horizontally when the pointer nears the visible edge of the
      // timeline track so you can drag a block beyond the viewport.
      const EDGE = 48;
      if (e.clientX > rect.right - EDGE) {
        track.scrollLeft += Math.max(8, (e.clientX - (rect.right - EDGE)) * 1.5);
      } else if (e.clientX < rect.left + EDGE) {
        track.scrollLeft -= Math.max(8, (rect.left + EDGE - e.clientX) * 1.5);
      }
      // Time currently under the cursor, mapped onto the (auto-scrolled)
      // content. Positioning the block from the cursor directly keeps it glued
      // to the pointer even while the track auto-scrolls.
      const timeAtCursor = (e.clientX - rect.left + track.scrollLeft) / pps;
      const entry = entries.find((en) => en.index === drag.index);
      if (!entry) return;
      const total = effectiveDuration || entry.end + 1;
      if (drag.mode === "move") {
        const newStart = Math.max(0, Math.min(timeAtCursor + drag.grabOffset, total - MIN_DURATION));
        const newEnd = Math.min(newStart + (drag.origEnd - drag.origStart), total);
        patchEntry(drag.index, { start: newStart, end: newEnd });
      } else if (drag.mode === "resize-start") {
        const newStart = Math.max(0, Math.min(timeAtCursor, drag.origEnd - MIN_DURATION));
        patchEntry(drag.index, { start: newStart });
      } else {
        const newEnd = Math.min(Math.max(timeAtCursor, drag.origStart + MIN_DURATION), total);
        patchEntry(drag.index, { end: newEnd });
      }
    },
    [entries, patchEntry, pps, effectiveDuration]
  );

  const handleBlockPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Click anywhere on the timeline (ruler / empty space) to move the playhead
  // there and seek the video, without starting playback.
  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const sec = (e.clientX - rect.left + track.scrollLeft) / pps;
      scrubTo(Math.max(0, Math.min(sec, effectiveDuration)));
    },
    [scrubTo, pps, effectiveDuration]
  );

  const performRiskCheck = useCallback(async () => {
    const { job_id } = await startSrtRiskCheck(videoId, targetLang);
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await getJobStatus(job_id);
      if (st.status === "done") break;
      if (st.status === "error") throw new Error(st.error || t("timeline.riskCheckFailed" as string));
      if (i === 599) throw new Error(t("timeline.riskCheckTimeout" as string));
    }
    const result = await getSrtRiskResult(videoId);
    setRisks(result.risks ?? []);
  }, [videoId, targetLang]);

  const runRiskCheck = useCallback(async () => {
    setChecking(true);
    setCheckError("");
    try {
      await performRiskCheck();
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : t("timeline.riskCheckFailed" as string));
    } finally {
      setChecking(false);
    }
  }, [performRiskCheck]);

  const saveAndRecheck = useCallback(async () => {
    setSaving(true);
    setCheckError("");
    try {
      await updateSrt(videoId, entriesToSrt(entries));
      await performRiskCheck();
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : t("timeline.saveRecheckFailed" as string));
    } finally {
      setSaving(false);
    }
  }, [videoId, entries, performRiskCheck]);

  const saveAndContinue = useCallback(async () => {
    setSaving(true);
    try {
      await updateSrt(videoId, entriesToSrt(entries));
    } catch {
      // Continue anyway; the pipeline can re-check later.
    } finally {
      setSaving(false);
      onResolve("continue");
    }
  }, [videoId, entries, onResolve]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  // Space toggles play/pause, unless focus is in a text field, on a button, on
  // the video (native controls), or on a timeline row (which uses Space itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) return;
        if (tag === "BUTTON" || tag === "VIDEO") return;
        if (el.getAttribute("role") === "button") return;
      }
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // Drop all unsaved edits: reload the saved SRT and re-validate the timeline.
  const resetEdits = useCallback(async () => {
    setEditingIndex(-1);
    setActiveIndex(-1);
    setCheckError("");
    setLoadError("");
    try {
      const es = await getSrtEntries(videoId);
      setEntries(es);
      setRisks([]);
      const v = await validateSrtTimeline(videoId);
      setTimelineIssues(v.issues ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t("timeline.restoreFailed" as string));
    }
  }, [videoId]);

  const activeRisk = riskByIndex.get(activeIndex);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-6">
      <div
        className="double-bezel w-[92vw] max-w-[92vw] max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
      >
        <div className="double-bezel-inner p-4 sm:p-5 flex flex-col gap-4 min-h-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-full bg-warn/15 flex items-center justify-center flex-shrink-0">
                <IconAlert className="w-5 h-5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{t("timeline.title" as string)}</p>
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  {timelineIssues.length > 0
                    ? t("timeline.issuesFound" as string, { count: timelineIssues.length })
                    : t("timeline.noIssues" as string)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddModal(true)}
                className="px-3.5 py-2 rounded-full text-[12px] font-medium bg-accent text-white hover:bg-accent/80 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                title={t("timeline.addEntry" as string)}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t("timeline.addEntry" as string)}
              </button>
              <button
                onClick={runRiskCheck}
                disabled={checking || entries.length === 0}
                className="px-3.5 py-2 rounded-full text-[12px] font-medium bg-warn text-white hover:bg-warn-light transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {checking ? <IconSpinner className="w-3.5 h-3.5" /> : <IconAlert className="w-3.5 h-3.5" />}
                {checking ? t("timeline.checking" as string) : t("timeline.checkRisk" as string)}
              </button>
              <button
                onClick={onClose}
                title={t("timeline.minimize" as string)}
                className="icon-btn"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {loadError && (
            <div className="rounded-xl bg-danger-muted ring-1 ring-danger/15 px-3.5 py-2.5 text-[12px] text-danger">
              {loadError}
            </div>
          )}

          {checkError && (
            <div className="rounded-xl bg-danger-muted ring-1 ring-danger/15 px-3.5 py-2.5 text-[12px] text-danger">
              {checkError}
            </div>
          )}

          {risks.length > 0 && (
            <div className="rounded-xl bg-warn-muted ring-1 ring-warn/20 px-3.5 py-2.5">
              <p className="text-[12px] font-semibold text-amber-800 mb-1.5">
                {t("timeline.risksFound" as string, { count: risks.length })}
              </p>
              <ul className="space-y-1 max-h-28 overflow-y-auto">
                {risks.map((r) => (
                  <li key={r.index}>
                    <button
                      onClick={() => {
                        const entry = entries.find((e) => e.index === r.index);
                        if (entry) selectEntry(entry.index, entry.start);
                      }}
                      className="w-full text-left text-[12px] text-warn/90 leading-snug hover:bg-warn/15 rounded-md px-1.5 py-0.5 cursor-pointer transition-colors"
                      title={t("timeline.jumpToLine" as string)}
                    >
                      <span className="font-mono text-warn">#{r.index}</span>{" "}
                      <span className="text-amber-900/80">{r.text}</span>
                      {r.problems.length > 0 && (
                        <span className="text-warn/80">
                          {" "}
                          · {r.problems.map((p) => t(RISK_LABELS[p] || p)).join(", ")}
                        </span>
                      )}
                      {r.note && <span className="text-warn/60"> — {r.note}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Body: video (left) + SRT list (right), timeline editor full-width below */}
          <div className="flex flex-col gap-4 min-h-0 flex-1">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0 flex-1">
            {/* Left: video */}
            <div className="rounded-xl overflow-hidden bg-black ring-1 ring-white/15 flex flex-col min-h-0">
              <div className="relative w-full flex-1 min-h-0">
                <video
                  ref={videoRef}
                  src={getVideoUrl(videoId)}
                  controls
                  className="absolute inset-0 w-full h-full object-contain bg-black"
                  onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onLoadedMetadata={(e) => {
                    const d = (e.target as HTMLVideoElement).duration;
                    if (Number.isFinite(d) && d > 0) setDuration(d);
                  }}
                />
              </div>
              <div className="h-11 flex items-center justify-center px-3 border-t border-white/10 bg-white/[0.04] flex-shrink-0">
                <p className="max-w-full text-center text-white text-xs sm:text-sm font-medium leading-snug line-clamp-2">
                  {activeEntry ? activeEntry.text : "—"}
                </p>
              </div>
            </div>


            {/* Right: SRT list */}
            <div className="flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
                  {t("timeline.subtitleLines" as string, { count: entries.length })}
                </p>
                {activeRisk && (
                  <p className="text-[10px] text-warn font-medium truncate max-w-[60%]">
                    ⚠ {activeRisk.problems.map((p) => t(RISK_LABELS[p] || p)).join(", ")}
                  </p>
                )}
              </div>
              <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08] divide-y divide-black/[0.04]">
                {entries.map((entry) => {
                  const isIssue = issueIndexes.has(entry.index);
                  const isRisk = riskIndexes.has(entry.index);
                  const active =
                    entry.index === activeIndex ||
                    entry.index === activeEntry?.index;
                  const risk = riskByIndex.get(entry.index);
                  return (
                    <div
                      key={entry.index}
                      ref={(el) => {
                        if (el) entryRefs.current.set(entry.index, el);
                        else entryRefs.current.delete(entry.index);
                      }}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectEntry(entry.index, entry.start)}
                      onKeyDown={(e) => {
                        // When editing this row's textarea, don't steal Space /
                        // Enter from the text field (it would prevent typing).
                        if (editingIndex === entry.index) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectEntry(entry.index, entry.start);
                        }
                      }}
                      className={`group w-full text-left px-3 py-2 cursor-pointer transition-colors relative border-l-2 ${
                        active
                          ? "bg-accent/20 ring-1 ring-inset ring-accent/60 border-accent"
                          : isIssue
                            ? "bg-danger-muted border-transparent"
                            : isRisk
                              ? "bg-warn-muted border-transparent"
                              : "hover:bg-white/[0.03] border-transparent"
                      }`}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteEntry(entry.index);
                        }}
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-danger/90 text-white text-[11px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-danger-light transition-opacity cursor-pointer shadow-sm"
                        title={t("timeline.deleteRow" as string)}
                      >
                        ×
                      </button>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                            isIssue
                              ? "bg-danger/15 text-danger"
                              : isRisk
                              ? "bg-warn/15 text-warn"
                              : active
                                ? "bg-accent/20 text-accent"
                                : "bg-white/[0.05] text-ink-light"
                          }`}
                        >
                          #{entry.index}
                        </span>
                        <span className="font-mono text-[10px] text-ink-light">
                          {secToSrt(entry.start).replace(",", ".").slice(0, 11)} → {secToSrt(entry.end).replace(",", ".").slice(0, 11)}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingIndex(entry.index);
                          }}
                          className="ml-auto text-[10px] font-medium text-ink-muted hover:text-accent transition-colors cursor-pointer opacity-0 group-hover:opacity-100 flex items-center gap-1"
                          title={t("timeline.editContent" as string)}
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                          {t("timeline.edit" as string)}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            reTranslateEntry(entry.index);
                          }}
                          disabled={retranslatingIndex === entry.index}
                          className="text-[10px] font-medium text-ink-muted hover:text-emerald-400 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 flex items-center gap-1 disabled:opacity-60 disabled:cursor-wait"
                          title={t("timeline.reTranslateTitle" as string)}
                        >
                          {retranslatingIndex === entry.index ? (
                            <IconSpinner className="w-3 h-3" />
                          ) : (
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 7h16M4 7l3-3M4 7l3 3M20 17H4M20 17l-3-3M20 17l-3 3" />
                            </svg>
                          )}
                          {retranslatingIndex === entry.index
                            ? t("timeline.reTranslating" as string)
                            : t("timeline.reTranslate" as string)}
                        </button>
                      </div>
                      {editingIndex === entry.index ? (
                        <div className="mt-1.5">
                          <textarea
                            value={entry.text}
                            onChange={(e) => patchEntry(entry.index, { text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                setEditingIndex(-1);
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                            rows={2}
                            className="textarea-field !text-[12px] leading-snug"
                            placeholder={t("timeline.enterSubtitle" as string)}
                          />
                          <div className="flex items-center justify-end gap-1.5 mt-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingIndex(-1);
                              }}
                              className="px-2 py-1 rounded-full text-[10px] font-medium text-ink-muted hover:bg-white/[0.05] transition-colors cursor-pointer"
                            >
                              {t("timeline.cancel" as string)}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingIndex(-1);
                              }}
                              className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-accent text-white hover:bg-accent transition-colors cursor-pointer"
                            >
                              {t("timeline.save" as string)}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p
                          className={`text-[12px] leading-snug mt-0.5 line-clamp-2 ${
                            isIssue
                              ? "text-danger"
                              : isRisk
                              ? "text-amber-800"
                              : active
                                ? "text-accent font-medium"
                                : "text-ink"
                          }`}
                        >
                          {entry.text}
                        </p>
                      )}
                      {risk?.note && (
                        <p className="text-[10px] text-warn/70 mt-0.5 truncate">{risk.note}</p>
                      )}
                    </div>
                  );
                })}
                {entries.length === 0 && !loadError && (
                  <p className="text-[12px] text-ink-light p-4">{t("timeline.loadingSubtitles" as string)}</p>
                )}
              </div>
            </div>
          </div>

            {/* Timeline editor */}
            <div className="rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08] p-3 flex-shrink-0">
              <div className="flex items-center justify-between mb-2 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
                    {t("timeline.timeline" as string)}
                  </p>
                  <div className="flex items-center gap-1 rounded-full bg-white/[0.05] ring-1 ring-white/[0.08] px-1.5 py-1">
                    <button
                      onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}
                      className="w-6 h-6 rounded-full hover:bg-white/[0.08] text-ink-muted flex items-center justify-center cursor-pointer transition-colors text-[13px] leading-none"
                      title={t("timeline.zoomOut" as string)}
                    >
                      −
                    </button>
                    <span className="text-[10px] font-mono text-ink-muted min-w-[3rem] text-center">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}
                      className="w-6 h-6 rounded-full hover:bg-white/[0.08] text-ink-muted flex items-center justify-center cursor-pointer transition-colors text-[13px] leading-none"
                      title={t("timeline.zoomIn" as string)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-ink-light font-mono">
                  {fmtClock(currentTime)} / {fmtClock(effectiveDuration)}
                </p>
              </div>
              <div className="overflow-x-auto overflow-y-hidden scrollbar-thin" ref={trackRef}>
                <div className="relative select-none" style={{ width: trackWidth, height: ROW_H * 3 + 12 }} onPointerDown={handleTrackPointerDown}>
                  {/* ruler — pointer-events-none so clicks fall through to scrub */}
                  <div className="absolute top-0 left-0 right-0 h-5 flex border-b border-white/[0.08] pointer-events-none">
                    {Array.from({ length: Math.ceil(effectiveDuration / interval) + 1 }).map((_, i) => (
                      <div
                        key={i}
                        className="absolute h-full flex items-start"
                        style={{ left: i * interval * pps }}
                      >
                        <span className="text-[9px] text-ink-light font-mono pl-1">
                          {fmtClock(i * interval)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {/* playhead — red marker tracking the video position */}
                  <div
                    className="absolute top-6 bottom-0 w-[2px] bg-danger z-10 pointer-events-none"
                    style={{ left: currentTime * pps }}
                  >
                    <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-danger rounded-full shadow ring-2 ring-white" />
                  </div>
                  {/* rows */}
                  {entries.map((entry, i) => {
                    const row = lanes.get(i) ?? 0;
                    const left = entry.start * pps;
                    const width = Math.max((entry.end - entry.start) * pps, 4);
                    const isIssue = issueIndexes.has(entry.index);
                    const isRisk = riskIndexes.has(entry.index);
                  const active =
                    entry.index === activeIndex ||
                    entry.index === activeEntry?.index;
                    return (
                      <div
                        key={entry.index}
                        onPointerDown={(e) => handleBlockPointerDown(e, entry.index, "move")}
                        onPointerMove={handleBlockPointerMove}
                        onPointerUp={handleBlockPointerUp}
                        onClick={() => selectEntry(entry.index, entry.start)}
                        className={`absolute rounded-md cursor-grab active:cursor-grabbing touch-none flex items-center justify-center px-2 ring-1 transition-colors group ${
                          isIssue
                            ? "bg-danger/85 ring-danger text-white"
                            : isRisk
                            ? "bg-warn/85 ring-warn text-white"
                            : active
                            ? "bg-accent/85 ring-accent text-white"
                            : "bg-accent/70 ring-accent/40 text-white"
                        }`}
                        style={{
                          top: 12 + ROW_H / 2 + row * ROW_H,
                          height: ROW_H - 10,
                          left,
                          width,
                          transform: "translateY(-50%)",
                        }}
                      >
                        {/* resize handles */}
                        <span
                          className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-black/20 rounded-l-md"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            handleBlockPointerDown(e, entry.index, "resize-start");
                          }}
                        />
                        <span className="text-[10px] font-medium truncate px-1 pointer-events-none">
                          #{entry.index}
                        </span>
                        <span
                          className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-black/20 rounded-r-md"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            handleBlockPointerDown(e, entry.index, "resize-end");
                          }}
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteEntry(entry.index);
                          }}
                          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-danger text-white text-[11px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-danger-light transition-opacity cursor-pointer shadow-md z-10"
                          title={t("timeline.deleteRow" as string)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-light">
                <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-accent/70 inline-block" /> {t("timeline.legendNormal" as string)}</span>
                <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-danger inline-block" /> {t("timeline.legendError" as string)}</span>
                <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-warn inline-block" /> {t("timeline.legendRisk" as string)}</span>
                <span className="ml-auto text-ink-light">{t("timeline.dragHint" as string)}</span>
              </div>
            </div>

          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={resetEdits}
              disabled={saving || checking || entries.length === 0}
              className="mr-auto px-3.5 py-2 rounded-full text-[12px] font-medium bg-danger-muted ring-1 ring-danger/15 text-danger hover:bg-danger-light/20 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              title={t("timeline.restoreTitle" as string)}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {t("timeline.restore" as string)}
            </button>
            <button
              onClick={() => onResolve("continue")}
              disabled={saving || checking}
              className="btn-island-secondary btn-sm disabled:opacity-50"
            >
              {t("timeline.keepAsIs" as string)}
            </button>
            <button
              onClick={saveAndRecheck}
              disabled={saving || checking || entries.length === 0}
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-warn text-white hover:bg-warn-light transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              title={t("timeline.saveRecheckTitle" as string)}
            >
              {saving || checking ? <IconSpinner className="w-3.5 h-3.5" /> : <IconAlert className="w-3.5 h-3.5" />}
              {saving ? t("timeline.saving" as string) : checking ? t("timeline.checking" as string) : t("timeline.saveRecheck" as string)}
            </button>
            <button
              onClick={saveAndContinue}
              disabled={saving || checking}
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-success text-white hover:bg-success transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {saving && <IconSpinner className="w-3.5 h-3.5" />}
              {saving ? t("timeline.saving" as string) : t("timeline.saveContinue" as string)}
            </button>
          </div>
        </div>
      </div>

      {showAddModal && (
        <AddEntryModal
          currentTime={currentTime}
          onAdd={addEntry}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>,
    document.body
  );
}