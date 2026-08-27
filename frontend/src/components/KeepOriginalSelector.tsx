"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import VideoPlayer from "@/components/VideoPlayer";
import type { TimeRange } from "@/stores/pipeline-store";

interface Props {
  videoId: string;
  onConfirm: (ranges: TimeRange[]) => void;
}

const HANDLE_HIT = 8; // px quanh biên đoạn để resize
const MIN_LEN = 0.3; // giây

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function fmt(t: number) {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

type DragState =
  | { type: "idle" }
  | { type: "draw"; startX: number }
  | { type: "move"; index: number; startX: number; range: TimeRange }
  | { type: "resize"; index: number; edge: "l" | "r"; startX: number; range: TimeRange };

export default function KeepOriginalSelector({ videoId, onConfirm }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState>({ type: "idle" });
  const drawIdxRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);

  const [width, setWidth] = useState(800);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ranges, setRanges] = useState<TimeRange[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  // ── Vẽ timeline ──
  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const H = c.height;
    const laneY = 18;
    const laneH = H - laneY - 14;
    ctx.clearRect(0, 0, c.width, H);

    // Track nền (vùng bị mute)
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.fillRect(0, laneY, c.width, laneH);

    // Tick mỗi phút
    if (duration > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.font = "10px ui-monospace, monospace";
      const stepSec = duration > 600 ? 120 : duration > 180 ? 60 : 15;
      for (let t = 0; t <= duration; t += stepSec) {
        const x = (t / duration) * c.width;
        ctx.fillRect(x, laneY, 1, 4);
        ctx.fillText(fmt(t), Math.min(x + 3, c.width - 26), laneY - 5);
      }
    }

    // Playhead
    if (duration > 0) {
      const px = (currentTime / duration) * c.width;
      ctx.strokeStyle = "rgba(23,23,23,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, laneY - 2);
      ctx.lineTo(px, laneY + laneH + 2);
      ctx.stroke();
    }

    // Các đoạn giữ (xanh lá)
    ranges.forEach((r, i) => {
      if (duration <= 0) return;
      const x1 = (r.start / duration) * c.width;
      const x2 = (r.end / duration) * c.width;
      const sel = selected === i;
      ctx.fillStyle = sel ? "rgba(34,197,94,0.45)" : "rgba(34,197,94,0.28)";
      ctx.fillRect(x1, laneY, Math.max(2, x2 - x1), laneH);
      ctx.strokeStyle = sel ? "rgba(22,163,74,0.95)" : "rgba(34,197,94,0.75)";
      ctx.lineWidth = sel ? 2 : 1.5;
      ctx.strokeRect(x1, laneY, Math.max(2, x2 - x1), laneH);
      ctx.fillStyle = "rgba(22,163,74,0.95)";
      ctx.font = "bold 10px ui-monospace, monospace";
      if (x2 - x1 > 46) ctx.fillText(`${i + 1}`, x1 + 5, laneY + 13);
    });
  }, [ranges, selected, duration, currentTime]);

  const scheduleRedraw = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        redraw();
      });
    }
  }, [redraw]);

  useEffect(() => {
    scheduleRedraw();
  }, [scheduleRedraw]);

  // Đo bề rộng + sync thời lượng/timeline với <video>
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.duration && Number.isFinite(v.duration)) setDuration(v.duration);
      setCurrentTime(v.currentTime);
      scheduleRedraw();
    }, 200);
    return () => clearInterval(iv);
  }, [scheduleRedraw]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  // ── Tương tác pointer trên timeline ──
  const secAt = (clientX: number) => {
    const b = canvasRef.current?.getBoundingClientRect();
    if (!b || duration <= 0) return 0;
    return clamp(((clientX - b.left) / b.width) * duration, 0, duration);
  };

  const hitEdge = (px: number, py: number): { index: number; edge: "l" | "r" } | null => {
    const c = canvasRef.current;
    if (!c || duration <= 0) return null;
    const laneY = 18;
    if (py < laneY || py > c.height - 8) return null;
    for (let i = 0; i < ranges.length; i++) {
      const x1 = (ranges[i].start / duration) * c.width;
      const x2 = (ranges[i].end / duration) * c.width;
      if (Math.abs(px - x1) <= HANDLE_HIT) return { index: i, edge: "l" };
      if (Math.abs(px - x2) <= HANDLE_HIT) return { index: i, edge: "r" };
    }
    return null;
  };

  const hitRange = (px: number, py: number): number => {
    const c = canvasRef.current;
    if (!c || duration <= 0) return -1;
    const laneY = 18;
    if (py < laneY || py > c.height - 8) return -1;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const x1 = (ranges[i].start / duration) * c.width;
      const x2 = (ranges[i].end / duration) * c.width;
      if (px >= x1 && px <= x2) return i;
    }
    return -1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const b = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;

    const edge = hitEdge(px, py);
    if (edge) {
      setSelected(edge.index);
      dragRef.current = {
        type: "resize",
        index: edge.index,
        edge: edge.edge,
        startX: px,
        range: { ...ranges[edge.index] },
      };
      return;
    }
    const ri = hitRange(px, py);
    if (ri >= 0) {
      setSelected(ri);
      dragRef.current = { type: "move", index: ri, startX: px, range: { ...ranges[ri] } };
      return;
    }
    // Kéo tạo đoạn mới + seek tới vị trí bấm
    setSelected(null);
    const t = secAt(e.clientX);
    if (videoRef.current) videoRef.current.currentTime = t;
    const nr: TimeRange = { start: t, end: Math.min(t + MIN_LEN, duration) };
    setRanges((prev) => {
      drawIdxRef.current = prev.length;
      return [...prev, nr];
    });
    dragRef.current = { type: "draw", startX: px };
    scheduleRedraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (d.type === "idle") {
      const b = canvasRef.current?.getBoundingClientRect();
      if (b) {
        const px = e.clientX - b.left;
        const py = e.clientY - b.top;
        canvasRef.current!.style.cursor = hitEdge(px, py)
          ? "ew-resize"
          : hitRange(px, py) >= 0
            ? "grab"
            : "crosshair";
      }
      return;
    }
    const b = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - b.left;
    if (d.type === "draw") {
      const en = secAt(e.clientX);
      const di = drawIdxRef.current;
      if (di != null) {
        setRanges((prev) =>
          prev.map((r, i) =>
            i === di
              ? { start: Math.min(r.start, en), end: Math.max(r.start + MIN_LEN, en) }
              : r,
          ),
        );
        setSelected(di);
      }
    } else if (d.type === "move") {
      const dt = ((px - d.startX) / b.width) * duration;
      const len = d.range.end - d.range.start;
      const ns = clamp(d.range.start + dt, 0, duration - len);
      setRanges((prev) =>
        prev.map((r, i) => (i === d.index ? { start: ns, end: ns + len } : r)),
      );
    } else if (d.type === "resize") {
      const dt = ((px - d.startX) / b.width) * duration;
      if (d.edge === "l") {
        const ns = clamp(d.range.start + dt, 0, d.range.end - MIN_LEN);
        setRanges((prev) =>
          prev.map((r, i) => (i === d.index ? { ...r, start: ns } : r)),
        );
      } else {
        const ne = clamp(d.range.end + dt, d.range.start + MIN_LEN, duration);
        setRanges((prev) =>
          prev.map((r, i) => (i === d.index ? { ...r, end: ne } : r)),
        );
      }
    }
    scheduleRedraw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    // Draw quá ngắn → xoá đoạn rác
    setRanges((prev) => prev.filter((r) => r.end - r.start >= MIN_LEN));
    dragRef.current = { type: "idle" };
    drawIdxRef.current = null;
    scheduleRedraw();
  };

  const handleAddAroundPlayhead = () => {
    if (duration <= 0) return;
    const s = clamp(currentTime - 2, 0, duration);
    const en = clamp(currentTime + 2, s + MIN_LEN, duration);
    setRanges((prev) => [...prev, { start: s, end: en }]);
    setSelected(ranges.length);
  };

  const handleDeleteSelected = () => {
    if (selected == null) return;
    setRanges((prev) => prev.filter((_, i) => i !== selected));
    setSelected(null);
  };

  // Keyboard: Space play/pause, Enter confirm, Delete xoá đoạn đang chọn
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === " ") {
        ev.preventDefault();
        togglePlay();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (ranges.length > 0) onConfirm(ranges);
      } else if ((ev.key === "Delete" || ev.key === "Backspace") && selected != null) {
        ev.preventDefault();
        handleDeleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges, selected, onConfirm]);

  return (
    <div className="space-y-4">
      {/* Hướng dẫn */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          Kéo trên thanh thời gian để chọn đoạn <b>giữ nguyên tiếng gốc</b>. Ngoài
          các đoạn này, pipeline sẽ thay bằng nhạc nền không lời (giọng TTS vẫn
          đọc bình thường).
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">Space</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">Phát</span>
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">↵</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">Xác nhận</span>
        </div>
      </div>

      {/* Video preview */}
      <VideoPlayer
        videoId={videoId}
        videoRef={videoRef}
        containerRef={containerRef}
      />

      {/* Timeline chọn đoạn */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 space-y-3">
        <canvas
          ref={canvasRef}
          width={Math.max(width, 320)}
          height={64}
          className="w-full touch-none cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />

        {/* Danh sách đoạn */}
        {ranges.length > 0 && (
          <div className="space-y-1.5">
            {ranges.map((r, i) => (
              <div
                key={`${r.start}-${r.end}-${i}`}
                onClick={() => setSelected(i)}
                className={`flex items-center justify-between py-1.5 px-3 rounded-lg cursor-pointer transition-colors ${
                  selected === i ? "bg-emerald-500/10 ring-1 ring-emerald-500/40" : "bg-black/[0.02]"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-5 h-5 rounded bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="text-[11px] font-mono text-ink-muted tracking-tight">
                    {fmt(r.start)} – {fmt(r.end)} ({(r.end - r.start).toFixed(1)}s)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setRanges((prev) => prev.filter((_, j) => j !== i));
                    if (selected === i) setSelected(null);
                  }}
                  className="w-6 h-6 rounded-full bg-black/[0.04] text-ink-muted hover:bg-danger/10 hover:text-danger flex items-center justify-center transition-colors cursor-pointer text-[10px]"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Nút hành động */}
        <div className="flex gap-2 justify-between flex-wrap pt-1">
          <div className="flex gap-2">
            <button type="button" onClick={handleAddAroundPlayhead} className="btn-island-secondary text-sm">
              + Thêm đoạn
            </button>
            {selected != null && (
              <button type="button" onClick={handleDeleteSelected} className="btn-island-secondary text-sm">
                Xoá đoạn #{selected + 1}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => onConfirm([])} className="btn-island-secondary text-sm">
              Bỏ qua (mute tất cả)
            </button>
            <button
              type="button"
              disabled={ranges.length === 0}
              onClick={() => onConfirm(ranges)}
              className="btn-island-primary group text-sm disabled:opacity-40 disabled:pointer-events-none"
            >
              Xác nhận ({ranges.length})
              <span className="btn-island-icon">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                </svg>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
