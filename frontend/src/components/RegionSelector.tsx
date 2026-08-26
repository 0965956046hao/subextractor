"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import type { Region } from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer";
import { useI18n } from "@/lib/i18n";

interface Props {
  videoId: string;
  onConfirmed: (region: Region, startTime?: number) => void;
}

const HANDLE_RADIUS = 6;
type HandleId = "nw" | "ne" | "sw" | "se" | "n" | "s" | "w" | "e";

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}
function denorm(r: Region, w: number, h: number) {
  return { x1: r.x1 * w, y1: r.y1 * h, x2: r.x2 * w, y2: r.y2 * h };
}
function regionUsable(r: Region | null): r is Region {
  return !!r && r.x2 - r.x1 >= 0.01 && r.y2 - r.y1 >= 0.01;
}

const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: "nwse-resize", ne: "nesw-resize",
  sw: "nesw-resize", se: "nwse-resize",
  n: "ns-resize", s: "ns-resize",
  w: "ew-resize", e: "ew-resize",
};
const ALL_HANDLES: HandleId[] = ["nw", "ne", "sw", "se", "n", "s", "w", "e"];

type DragState =
  | { type: "idle" }
  | { type: "draw"; startX: number; startY: number }
  | { type: "move"; startX: number; startY: number; rect: Region }
  | { type: "resize"; handle: HandleId; startX: number; startY: number; rect: Region };

export default function RegionSelector({ videoId, onConfirmed }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectRef = useRef<Region | null>(null);
  const dragRef = useRef<DragState>({ type: "idle" });
  const rafRef = useRef<number>(0);

  const [size, setSize] = useState({ w: 800, h: 450 });
  const [hasRect, setHasRect] = useState(false);
  const [rect, setRect] = useState<Region | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  // ── Canvas rendering ──
  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const r = rectRef.current;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!r) return;
    const p = denorm(r, c.width, c.height);

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.clearRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);

    ctx.strokeStyle = "rgba(59,130,246,0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);

    const a = 14;
    ctx.strokeStyle = "rgba(96,165,250,0.6)";
    ctx.lineWidth = 2.5;
    [
      [p.x1, p.y1, 1, 1], [p.x2, p.y1, -1, 1],
      [p.x1, p.y2, 1, -1], [p.x2, p.y2, -1, -1],
    ].forEach(([x, y, dx, dy]) => {
      ctx.beginPath(); ctx.moveTo(x, y + dy * a);
      ctx.lineTo(x, y); ctx.lineTo(x + dx * a, y); ctx.stroke();
    });

    for (const id of ALL_HANDLES) {
      let cx: number, cy: number;
      switch (id) {
        case "nw": cx = p.x1; cy = p.y1; break;
        case "ne": cx = p.x2; cy = p.y1; break;
        case "sw": cx = p.x1; cy = p.y2; break;
        case "se": cx = p.x2; cy = p.y2; break;
        case "n": cx = (p.x1 + p.x2) / 2; cy = p.y1; break;
        case "s": cx = (p.x1 + p.x2) / 2; cy = p.y2; break;
        case "w": cx = p.x1; cy = (p.y1 + p.y2) / 2; break;
        case "e": cx = p.x2; cy = (p.y1 + p.y2) / 2; break;
      }
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(96,165,250,0.6)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, HANDLE_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }, []);

  const scheduleRedraw = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; redraw(); });
    }
  }, [redraw]);

  // ── Video metadata ──
  useEffect(() => {
    if (size.w > 0 && size.h > 0) { scheduleRedraw(); }
  }, [size, scheduleRedraw]);

  // ── Pointer events ──
  const getPos = (cx: number, cy: number) => {
    const b = canvasRef.current?.getBoundingClientRect();
    return b ? { x: cx - b.left, y: cy - b.top } : { x: 0, y: 0 };
  };

  const hitHandle = (px: number, py: number) => {
    const r = rectRef.current, c = canvasRef.current;
    if (!r || !c) return null;
    const p = denorm(r, c.width, c.height);
    const hs = HANDLE_RADIUS + 4;
    for (const id of ALL_HANDLES) {
      let cx: number, cy: number;
      switch (id) {
        case "nw": cx = p.x1; cy = p.y1; break;
        case "ne": cx = p.x2; cy = p.y1; break;
        case "sw": cx = p.x1; cy = p.y2; break;
        case "se": cx = p.x2; cy = p.y2; break;
        case "n": cx = (p.x1 + p.x2) / 2; cy = p.y1; break;
        case "s": cx = (p.x1 + p.x2) / 2; cy = p.y2; break;
        case "w": cx = p.x1; cy = (p.y1 + p.y2) / 2; break;
        case "e": cx = p.x2; cy = (p.y1 + p.y2) / 2; break;
      }
      if (Math.abs(px - cx) <= hs && Math.abs(py - cy) <= hs) return id;
    }
    return null;
  };

  const hitRect = (px: number, py: number) => {
    const r = rectRef.current, c = canvasRef.current;
    if (!r || !c) return false;
    const p = denorm(r, c.width, c.height);
    return px >= p.x1 && px <= p.x2 && py >= p.y1 && py <= p.y2;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pos = getPos(e.clientX, e.clientY);
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const handle = hitHandle(pos.x, pos.y);
    if (handle && rectRef.current) {
      dragRef.current = { type: "resize", handle, startX: pos.x, startY: pos.y, rect: { ...rectRef.current } };
      return;
    }
    if (rectRef.current && hitRect(pos.x, pos.y)) {
      dragRef.current = { type: "move", startX: pos.x, startY: pos.y, rect: { ...rectRef.current } };
      return;
    }
    const n = { x: pos.x / size.w, y: pos.y / size.h };
    dragRef.current = { type: "draw", startX: pos.x, startY: pos.y };
    rectRef.current = { x1: n.x, y1: n.y, x2: n.x, y2: n.y };
    setHasRect(true);
    setRect(rectRef.current);
  };

  const syncRect = useCallback(() => {
    setRect(rectRef.current ? { ...rectRef.current } : null);
  }, []);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pos = getPos(e.clientX, e.clientY);
    const d = dragRef.current;
    if (d.type === "idle") {
      const c = canvasRef.current;
      if (c) { const h = hitHandle(pos.x, pos.y); c.style.cursor = h ? HANDLE_CURSOR[h] : hitRect(pos.x, pos.y) ? "move" : "crosshair"; }
      return;
    }
    if (d.type === "draw") {
      const n = { x: pos.x / size.w, y: pos.y / size.h };
      const s = { x: d.startX / size.w, y: d.startY / size.h };
      rectRef.current = { x1: clamp(Math.min(s.x, n.x)), y1: clamp(Math.min(s.y, n.y)), x2: clamp(Math.max(s.x, n.x)), y2: clamp(Math.max(s.y, n.y)) };
      setHasRect(true); syncRect(); scheduleRedraw(); return;
    }
    const c = canvasRef.current;
    if (!c) return;
    const dx = (pos.x - d.startX) / c.width, dy = (pos.y - d.startY) / c.height;
    const sr = d.rect;
    if (d.type === "move") {
      const x1 = clamp(sr.x1 + dx), y1 = clamp(sr.y1 + dy), x2 = clamp(sr.x2 + dx), y2 = clamp(sr.y2 + dy);
      if (x2 - x1 < 0.01 || y2 - y1 < 0.01) return;
      rectRef.current = { x1, y1, x2, y2 };
    } else if (d.type === "resize") {
      let { x1, y1, x2, y2 } = sr;
      switch (d.handle) {
        case "nw": x1 = clamp(sr.x1 + dx); y1 = clamp(sr.y1 + dy); break;
        case "ne": x2 = clamp(sr.x2 + dx); y1 = clamp(sr.y1 + dy); break;
        case "sw": x1 = clamp(sr.x1 + dx); y2 = clamp(sr.y2 + dy); break;
        case "se": x2 = clamp(sr.x2 + dx); y2 = clamp(sr.y2 + dy); break;
        case "n": y1 = clamp(sr.y1 + dy); break;
        case "s": y2 = clamp(sr.y2 + dy); break;
        case "w": x1 = clamp(sr.x1 + dx); break;
        case "e": x2 = clamp(sr.x2 + dx); break;
      }
      if (x2 - x1 < 0.01 || y2 - y1 < 0.01) return;
      rectRef.current = { x1, y1, x2, y2 };
    }
    setHasRect(true); syncRect(); scheduleRedraw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    if (dragRef.current.type === "draw") {
      const r = rectRef.current;
      if (r && (r.x2 - r.x1 < 0.01 || r.y2 - r.y1 < 0.01)) { rectRef.current = null; setHasRect(false); }
    }
    dragRef.current = { type: "idle" };
    syncRect();
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  };

  // ── Keyboard ──
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "Enter" && regionUsable(rectRef.current)) onConfirmed(rectRef.current, startTime ?? undefined);
  }, [onConfirmed, startTime]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const r = rect;

  return (
    <div className="space-y-5">
      {/* Instructions header */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          {t("region.instructions" as string)}
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-white/[0.04] ring-1 ring-white/[0.09]">Space</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">{t("region.play" as string)}</span>
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-white/[0.04] ring-1 ring-white/[0.09]">↵</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">{t("region.confirm" as string)}</span>
        </div>
      </div>

      {/* Video container with double-bezel + playback controls + timeline */}
      <VideoPlayer
        videoId={videoId}
        videoRef={videoRef}
        containerRef={containerRef}
        onSizeChange={(w, h) => setSize({ w, h })}
        onTimeUpdate={(t) => setCurrentTime(t)}
        onSeeked={() => scheduleRedraw()}
        extraControls={
          <button
            onClick={() => { videoRef.current?.pause(); }}
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium
                       bg-white/[0.04] text-ink-muted hover:bg-white/[0.08] hover:text-ink
                       transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]
                       active:scale-[0.97] cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><rect x="2" y="3" width="20" height="18" rx="2" ry="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
            {t("region.capture" as string)}
          </button>
        }
        overlay={
          <canvas
            ref={canvasRef}
            width={size.w}
            height={size.h}
            className="absolute inset-0 touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        }
      />

      {/* Start time selector */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">
            {t("region.startTime" as string)}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // Set start time to current video position
                const v = videoRef.current;
                if (v) setStartTime(v.currentTime);
              }}
              className="px-3 py-1.5 text-[11px] font-medium bg-white/[0.05] text-ink-muted rounded-lg
                         hover:bg-white/[0.11] transition-colors cursor-pointer"
            >
              {t("region.useCurrentTime" as string)}
            </button>
            <input
              type="number"
              min={0}
              step={0.5}
              value={startTime ?? ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setStartTime(isNaN(v) || v <= 0 ? null : v);
              }}
              placeholder="0"
              className="w-20 px-2 py-1.5 text-[12px] font-mono text-ink bg-white/[0.04] border border-white/[0.10]
                         rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50"
            />
            <span className="text-[11px] text-ink-light">{t("region.seconds" as string)}</span>
            {startTime != null && startTime > 0 && (
              <button
                type="button"
                onClick={() => setStartTime(null)}
                className="text-[11px] text-danger hover:text-danger/80 cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>
          {startTime != null && startTime > 0 && (
            <span className="text-[11px] text-ink-light">
              {t("region.ocrStartFrom" as string, { time: startTime.toFixed(1) })}
            </span>
          )}
        </div>
      </div>

      {/* Confirm bar */}
      {regionUsable(r) && (
        <div className="glass-panel rounded-2xl p-4 sm:p-5" style={{ animation: "fade-in 0.9s cubic-bezier(0.32,0.72,0,1) forwards" }}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className="text-xs sm:text-sm text-ink-muted font-mono tracking-tight">
              x: {r.x1.toFixed(3)} y: {r.y1.toFixed(3)} &rarr; x: {r.x2.toFixed(3)} y: {r.y2.toFixed(3)}
            </span>
            <button onClick={() => onConfirmed(r, startTime ?? undefined)} className="btn-island-primary group text-sm">
              {t("region.extract" as string)}
              <span className="btn-island-icon">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                </svg>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
