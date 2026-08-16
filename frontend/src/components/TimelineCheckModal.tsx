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
} from "@/lib/api";
import type { SrtEntry, TimelineIssue, SubtitleRisk } from "@/lib/api";

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

const RISK_LABELS: Record<string, string> = {
  NOT_TRANSLATED: "Chưa dịch sang tiếng Việt",
  TIMELINE_OVERLAP: "Timeline chồng lấn",
  ADJACENT_SIMILAR: "Nội dung liền kề còn giống nhau",
};

interface TimelineCheckModalProps {
  videoId: string;
  initialIssues: TimelineIssue[];
  onResolve: (action: "continue") => void;
}

type DragMode = "move" | "resize-start" | "resize-end" | null;

interface DragState {
  index: number;
  mode: Exclude<DragMode, null>;
  startX: number;
  origStart: number;
  origEnd: number;
}

export default function TimelineCheckModal({
  videoId,
  initialIssues,
  onResolve,
}: TimelineCheckModalProps) {
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [duration, setDuration] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
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
  const [mounted, setMounted] = useState(false);

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
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Lỗi tải phụ đề");
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

  const trackWidth = Math.max((effectiveDuration || 1) * pps, trackRef.current?.clientWidth || 0);

  const activeEntry = useMemo(() => {
    if (currentTime < 0) return undefined;
    return entries.find((e) => currentTime >= e.start && currentTime <= e.end);
  }, [entries, currentTime]);

  const seekTo = useCallback((sec: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = Math.max(0, Math.min(sec, v.duration || sec));
      v.play().catch(() => {});
    }
    setCurrentTime(sec);
  }, []);

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

  const handleBlockPointerDown = useCallback(
    (e: React.PointerEvent, index: number, mode: Exclude<DragMode, null>) => {
      e.preventDefault();
      const entry = entries.find((en) => en.index === index);
      if (!entry) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        index,
        mode,
        startX: e.clientX,
        origStart: entry.start,
        origEnd: entry.end,
      };
    },
    [entries]
  );

  const handleBlockPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dt = (e.clientX - drag.startX) / pps;
      const entry = entries.find((en) => en.index === drag.index);
      if (!entry) return;
      const total = effectiveDuration || entry.end + 1;
      if (drag.mode === "move") {
        const newStart = Math.max(0, Math.min(drag.origStart + dt, total - MIN_DURATION));
        const newEnd = Math.min(newStart + (drag.origEnd - drag.origStart), total);
        patchEntry(drag.index, { start: newStart, end: newEnd });
      } else if (drag.mode === "resize-start") {
        const newStart = Math.max(0, Math.min(drag.origStart + dt, drag.origEnd - MIN_DURATION));
        patchEntry(drag.index, { start: newStart });
      } else {
        const newEnd = Math.min(drag.origEnd + dt, total);
        if (newEnd - drag.origStart >= MIN_DURATION) {
          patchEntry(drag.index, { end: newEnd });
        }
      }
    },
    [entries, patchEntry, pps, effectiveDuration]
  );

  const handleBlockPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const runRiskCheck = useCallback(async () => {
    setChecking(true);
    setCheckError("");
    try {
      const { job_id } = await startSrtRiskCheck(videoId);
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await getJobStatus(job_id);
        if (st.status === "done") break;
        if (st.status === "error") throw new Error(st.error || "Kiểm tra rủi ro thất bại");
        if (i === 599) throw new Error("Quá thời gian chờ kiểm tra rủi ro");
      }
      const result = await getSrtRiskResult(videoId);
      setRisks(result.risks ?? []);
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : "Kiểm tra rủi ro thất bại");
    } finally {
      setChecking(false);
    }
  }, [videoId]);

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
              <div className="w-9 h-9 rounded-full bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                <IconAlert className="w-5 h-5 text-amber-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">Kiểm tra timeline phụ đề</p>
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  {timelineIssues.length > 0
                    ? `Phát hiện ${timelineIssues.length} lỗi timeline vô lý — dòng lỗi được tô đỏ.`
                    : "Không có lỗi timeline cơ bản. Bạn có thể kiểm tra rủi ro bằng Gemini."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={runRiskCheck}
                disabled={checking || entries.length === 0}
                className="px-3.5 py-2 rounded-full text-[12px] font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {checking ? <IconSpinner className="w-3.5 h-3.5" /> : <IconAlert className="w-3.5 h-3.5" />}
                {checking ? "Đang kiểm tra…" : "Kiểm tra rủi ro file sub"}
              </button>
            </div>
          </div>

          {loadError && (
            <div className="rounded-xl bg-red-500/10 ring-1 ring-red-500/20 px-3.5 py-2.5 text-[12px] text-red-700">
              {loadError}
            </div>
          )}

          {checkError && (
            <div className="rounded-xl bg-red-500/10 ring-1 ring-red-500/20 px-3.5 py-2.5 text-[12px] text-red-700">
              {checkError}
            </div>
          )}

          {risks.length > 0 && (
            <div className="rounded-xl bg-amber-500/10 ring-1 ring-amber-500/25 px-3.5 py-2.5">
              <p className="text-[12px] font-semibold text-amber-800 mb-1.5">
                Phát hiện {risks.length} dòng rủi ro (Gemini)
              </p>
              <ul className="space-y-1 max-h-28 overflow-y-auto">
                {risks.map((r) => (
                  <li key={r.index} className="text-[12px] text-amber-800/90 leading-snug">
                    <span className="font-mono text-amber-700">#{r.index}</span>{" "}
                    <span className="text-amber-900/80">{r.text}</span>
                    {r.problems.length > 0 && (
                      <span className="text-amber-700/80">
                        {" "}
                        · {r.problems.map((p) => RISK_LABELS[p] || p).join(", ")}
                      </span>
                    )}
                    {r.note && <span className="text-amber-700/60"> — {r.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Body: video + timeline (left), SRT list (right) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0 flex-1">
            {/* Left: video + timeline */}
            <div className="flex flex-col gap-3 min-h-0">
              <div className="relative rounded-xl overflow-hidden bg-black ring-1 ring-black/10">
                <video
                  ref={videoRef}
                  src={getVideoUrl(videoId)}
                  controls
                  className="w-full aspect-video object-contain bg-black"
                  onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
                  onLoadedMetadata={(e) => {
                    const d = (e.target as HTMLVideoElement).duration;
                    if (Number.isFinite(d) && d > 0) setDuration(d);
                  }}
                />
                {activeEntry && (
                  <div className="absolute inset-x-0 bottom-2 flex justify-center px-4 pointer-events-none">
                    <p className="max-w-[90%] text-center text-white text-xs sm:text-sm font-medium bg-black/70 backdrop-blur-sm rounded-lg px-3 py-1.5 leading-snug">
                      {activeEntry.text}
                    </p>
                  </div>
                )}
              </div>

              {/* Timeline editor */}
              <div className="rounded-xl bg-black/[0.02] ring-1 ring-black/[0.05] p-3 flex-1 min-h-0">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
                      Timeline
                    </p>
                    <div className="flex items-center gap-1 rounded-full bg-black/[0.04] ring-1 ring-black/[0.05] px-1.5 py-1">
                      <button
                        onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}
                        className="w-6 h-6 rounded-full hover:bg-black/[0.06] text-ink-muted flex items-center justify-center cursor-pointer transition-colors text-[13px] leading-none"
                        title="Thu nhỏ"
                      >
                        −
                      </button>
                      <span className="text-[10px] font-mono text-ink-muted min-w-[3rem] text-center">
                        {Math.round(zoom * 100)}%
                      </span>
                      <button
                        onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}
                        className="w-6 h-6 rounded-full hover:bg-black/[0.06] text-ink-muted flex items-center justify-center cursor-pointer transition-colors text-[13px] leading-none"
                        title="Phóng to"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-light font-mono">
                    {fmtClock(currentTime)} / {fmtClock(effectiveDuration)}
                  </p>
                </div>
                <div className="overflow-x-auto" ref={trackRef}>
                  <div className="relative select-none" style={{ width: trackWidth, height: ROW_H * 3 }}>
                    {/* ruler */}
                    <div className="absolute top-0 left-0 right-0 h-5 flex border-b border-black/[0.06]">
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
                    {/* rows */}
                    {entries.map((entry, i) => {
                      const row = lanes.get(i) ?? 0;
                      const left = entry.start * pps;
                      const width = Math.max((entry.end - entry.start) * pps, 4);
                      const isIssue = issueIndexes.has(entry.index);
                      const isRisk = riskIndexes.has(entry.index);
                      const active = entry.index === activeIndex;
                      return (
                        <div
                          key={entry.index}
                          onPointerDown={(e) => handleBlockPointerDown(e, entry.index, "move")}
                          onPointerMove={handleBlockPointerMove}
                          onPointerUp={handleBlockPointerUp}
                          onClick={() => selectEntry(entry.index, entry.start)}
                          className={`absolute rounded-md cursor-grab active:cursor-grabbing touch-none flex items-center justify-center px-2 ring-1 transition-colors group ${
                            isIssue
                              ? "bg-red-500/85 ring-red-600 text-white"
                              : isRisk
                              ? "bg-amber-500/85 ring-amber-600 text-white"
                              : active
                              ? "bg-blue-600/85 ring-blue-700 text-white"
                              : "bg-blue-500/70 ring-blue-600/50 text-white"
                          }`}
                          style={{
                            top: 5 + ROW_H / 2 + row * ROW_H,
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
                            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-600 text-white text-[11px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500 transition-opacity cursor-pointer shadow-md z-10"
                            title="Xóa dòng này"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-light">
                  <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500/70 inline-block" /> Bình thường</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" /> Lỗi timeline</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" /> Rủi ro (Gemini)</span>
                  <span className="ml-auto text-ink-light">Kéo để di chuyển · Kéo mép để đổi độ dài</span>
                </div>
              </div>
            </div>

            {/* Right: SRT list */}
            <div className="flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
                  Phụ đề ({entries.length} dòng)
                </p>
                {activeRisk && (
                  <p className="text-[10px] text-amber-700 font-medium truncate max-w-[60%]">
                    ⚠ {activeRisk.problems.map((p) => RISK_LABELS[p] || p).join(", ")}
                  </p>
                )}
              </div>
              <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto rounded-xl bg-black/[0.02] ring-1 ring-black/[0.05] divide-y divide-black/[0.04]">
                {entries.map((entry) => {
                  const isIssue = issueIndexes.has(entry.index);
                  const isRisk = riskIndexes.has(entry.index);
                  const active = entry.index === activeIndex;
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
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectEntry(entry.index, entry.start);
                        }
                      }}
                      className={`group w-full text-left px-3 py-2 cursor-pointer transition-colors relative ${
                        active ? "bg-blue-500/10" : isIssue ? "bg-red-500/10" : isRisk ? "bg-amber-500/10" : "hover:bg-black/[0.02]"
                      } ${(isIssue || isRisk || active) ? "" : ""}`}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteEntry(entry.index);
                        }}
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-red-600/90 text-white text-[11px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500 transition-opacity cursor-pointer shadow-sm"
                        title="Xóa dòng này"
                      >
                        ×
                      </button>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                            isIssue
                              ? "bg-red-500/15 text-red-700"
                              : isRisk
                              ? "bg-amber-500/15 text-amber-700"
                              : "bg-black/[0.04] text-ink-light"
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
                          className="ml-auto text-[10px] font-medium text-ink-muted hover:text-blue-600 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 flex items-center gap-1"
                          title="Chỉnh sửa nội dung"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                          Sửa
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
                            className="w-full rounded-lg bg-white ring-1 ring-blue-500/40 focus:ring-2 focus:ring-blue-500 px-2.5 py-1.5 text-[12px] leading-snug text-ink outline-none resize-y"
                            placeholder="Nhập nội dung phụ đề..."
                          />
                          <div className="flex items-center justify-end gap-1.5 mt-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingIndex(-1);
                              }}
                              className="px-2 py-1 rounded-full text-[10px] font-medium text-ink-muted hover:bg-black/[0.04] transition-colors cursor-pointer"
                            >
                              Hủy
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingIndex(-1);
                              }}
                              className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                            >
                              Lưu
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p
                          className={`text-[12px] leading-snug mt-0.5 line-clamp-2 ${
                            isIssue ? "text-red-700" : isRisk ? "text-amber-800" : "text-ink"
                          }`}
                        >
                          {entry.text}
                        </p>
                      )}
                      {risk?.note && (
                        <p className="text-[10px] text-amber-700/70 mt-0.5 truncate">{risk.note}</p>
                      )}
                    </div>
                  );
                })}
                {entries.length === 0 && !loadError && (
                  <p className="text-[12px] text-ink-light p-4">Đang tải phụ đề...</p>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => onResolve("continue")}
              disabled={saving}
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer disabled:opacity-50"
            >
              Tiếp tục giữ nguyên
            </button>
            <button
              onClick={saveAndContinue}
              disabled={saving}
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {saving && <IconSpinner className="w-3.5 h-3.5" />}
              {saving ? "Đang lưu…" : "Lưu chỉnh sửa & tiếp tục"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}