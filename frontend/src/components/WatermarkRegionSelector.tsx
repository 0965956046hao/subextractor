"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import type { Region } from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer";
import { useI18n } from "@/lib/i18n";

interface Props {
  videoId: string;
  onConfirm: (regions: Region[]) => void;
}

const REGION_COLORS = [
  { fill: "rgba(239,68,68,0.18)", stroke: "rgba(239,68,68,0.85)" },
  { fill: "rgba(59,130,246,0.18)", stroke: "rgba(59,130,246,0.85)" },
  { fill: "rgba(34,197,94,0.18)", stroke: "rgba(34,197,94,0.85)" },
  { fill: "rgba(249,115,22,0.18)", stroke: "rgba(249,115,22,0.85)" },
  { fill: "rgba(168,85,247,0.18)", stroke: "rgba(168,85,247,0.85)" },
];

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function denorm(r: Region, w: number, h: number) {
  return { x1: r.x1 * w, y1: r.y1 * h, x2: r.x2 * w, y2: r.y2 * h };
}

const HANDLE_RADIUS = 6;
type HandleId = "nw" | "ne" | "sw" | "se" | "n" | "s" | "w" | "e";
const ALL_HANDLES: HandleId[] = ["nw", "ne", "sw", "se", "n", "s", "w", "e"];
const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: "nwse-resize", ne: "nesw-resize",
  sw: "nesw-resize", se: "nwse-resize",
  n: "ns-resize", s: "ns-resize",
  w: "ew-resize", e: "ew-resize",
};

type DragState =
  | { type: "idle" }
  | { type: "draw"; startX: number; startY: number }
  | { type: "resize"; handle: HandleId; startX: number; startY: number; rect: Region };

export default function WatermarkRegionSelector({ videoId, onConfirm }: Props) {
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
  const [regions, setRegions] = useState<Region[]>([]);

  // ── Canvas rendering ──
  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);

    // Draw existing regions
    regions.forEach((r, i) => {
      const color = REGION_COLORS[i % REGION_COLORS.length];
      const p = denorm(r, c.width, c.height);
      ctx.fillStyle = color.fill;
      ctx.fillRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
      ctx.setLineDash([]);
      ctx.fillStyle = color.stroke;
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`${i + 1}`, p.x1 + 4, p.y1 + 14);
    });

    // Draw current selection (if any)
    const r = rectRef.current;
    if (!r) return;
    const p = denorm(r, c.width, c.height);

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.clearRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);

    ctx.strokeStyle = "rgba(59,130,246,0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);

    // Corner marks
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

    // Handles
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
  }, [regions]);

  const scheduleRedraw = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; redraw(); });
    }
  }, [redraw]);

  useEffect(() => { scheduleRedraw(); }, [size, scheduleRedraw]);

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
      // Don't start new draw if clicking inside existing rect
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

  const handleAddRegion = () => {
    if (rect && rect.x2 - rect.x1 >= 0.01 && rect.y2 - rect.y1 >= 0.01) {
      setRegions((prev) => [...prev, rect]);
      rectRef.current = null;
      setHasRect(false);
      setRect(null);
    }
  };

  const handleRemoveRegion = (index: number) => {
    setRegions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClearAll = () => {
    setRegions([]);
    rectRef.current = null;
    setHasRect(false);
    setRect(null);
  };

  const handleConfirm = () => {
    if (regions.length > 0) {
      onConfirm(regions);
    }
  };

  return (
    <div className="space-y-4">
      {/* Instructions header */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          {t("pipeline.removeWatermarkDrawHint")}
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">Space</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">{t("region.play" as string)}</span>
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">↵</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">{t("region.confirm" as string)}</span>
        </div>
      </div>

      {/* Video + canvas overlay */}
      <VideoPlayer
        videoId={videoId}
        videoRef={videoRef}
        containerRef={containerRef}
        onSizeChange={(w, h) => setSize({ w, h })}
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

      {/* Region info + add/confirm buttons */}
      {hasRect && rect && (
        <div className="glass-panel rounded-2xl p-4 sm:p-5" style={{ animation: "fade-in 0.9s cubic-bezier(0.32,0.72,0,1) forwards" }}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className="text-xs sm:text-sm text-ink-muted font-mono tracking-tight">
              x: {rect.x1.toFixed(3)} y: {rect.y1.toFixed(3)} &rarr; x: {rect.x2.toFixed(3)} y: {rect.y2.toFixed(3)}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => { rectRef.current = null; setHasRect(false); setRect(null); }}
                className="btn-island-secondary text-sm"
              >
                {t("pipeline.removeWatermarkRedraw")}
              </button>
              <button onClick={handleAddRegion} className="btn-island-primary group text-sm">
                {t("pipeline.removeWatermarkAdd")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Region list */}
      {regions.length > 0 && !hasRect && (
        <div className="glass-panel rounded-2xl p-4 sm:p-5">
          <div className="space-y-1.5 mb-4">
            {regions.map((r, i) => {
              const color = REGION_COLORS[i % REGION_COLORS.length];
              return (
                <div key={i} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-black/[0.02]">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-5 h-5 rounded text-[10px] font-bold text-white flex items-center justify-center"
                      style={{ backgroundColor: color.stroke }}
                    >
                      {i + 1}
                    </span>
                    <span className="text-[11px] font-mono text-ink-muted tracking-tight">
                      x:{(r.x1 * 100).toFixed(0)}%–{(r.x2 * 100).toFixed(0)}%
                      &nbsp;y:{(r.y1 * 100).toFixed(0)}%–{(r.y2 * 100).toFixed(0)}%
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveRegion(i)}
                    className="w-6 h-6 rounded-full bg-black/[0.04] text-ink-muted hover:bg-danger/10 hover:text-danger
                               flex items-center justify-center transition-colors cursor-pointer text-[10px]"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={handleClearAll}
              className="btn-island-secondary text-sm"
            >
              {t("pipeline.removeWatermarkClearAll")}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="btn-island-primary group text-sm"
            >
              {t("pipeline.removeWatermarkConfirm")} ({regions.length})
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
