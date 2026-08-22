"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import type { Region } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface Props {
  videoUrl: string;
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

export default function WatermarkRegionSelector({ videoUrl, onConfirm }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 225 });
  const [drawing, setDrawing] = useState(false);
  const [startPt, setStartPt] = useState<{ x: number; y: number } | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [drawingPreview, setDrawingPreview] = useState<Region | null>(null);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      setSize({ w: width, h: width * 0.5625 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw overlay
  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);

    regions.forEach((r, i) => {
      const color = REGION_COLORS[i % REGION_COLORS.length];
      const px = {
        x1: r.x1 * c.width, y1: r.y1 * c.height,
        x2: r.x2 * c.width, y2: r.y2 * c.height,
      };
      ctx.fillStyle = color.fill;
      ctx.fillRect(px.x1, px.y1, px.x2 - px.x1, px.y2 - px.y1);
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(px.x1, px.y1, px.x2 - px.x1, px.y2 - px.y1);
      ctx.setLineDash([]);
      ctx.fillStyle = color.stroke;
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`${i + 1}`, px.x1 + 4, px.y1 + 14);
    });

    if (drawingPreview) {
      const px = {
        x1: drawingPreview.x1 * c.width, y1: drawingPreview.y1 * c.height,
        x2: drawingPreview.x2 * c.width, y2: drawingPreview.y2 * c.height,
      };
      ctx.fillStyle = "rgba(239,68,68,0.12)";
      ctx.fillRect(px.x1, px.y1, px.x2 - px.x1, px.y2 - px.y1);
      ctx.strokeStyle = "rgba(239,68,68,0.6)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(px.x1, px.y1, px.x2 - px.x1, px.y2 - px.y1);
      ctx.setLineDash([]);
    }
  }, [regions, drawingPreview]);

  useEffect(() => { redraw(); }, [redraw, size]);

  const toNorm = (e: React.MouseEvent) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const handleDown = (e: React.MouseEvent) => {
    const pt = toNorm(e);
    setStartPt(pt);
    setDrawing(true);
    setDrawingPreview(null);
  };

  const handleMove = (e: React.MouseEvent) => {
    if (!drawing || !startPt) return;
    const pt = toNorm(e);
    setDrawingPreview({
      x1: Math.min(startPt.x, pt.x),
      y1: Math.min(startPt.y, pt.y),
      x2: Math.max(startPt.x, pt.x),
      y2: Math.max(startPt.y, pt.y),
    });
  };

  const handleUp = () => {
    if (!drawing) return;
    setDrawing(false);
    setStartPt(null);
  };

  // Add region to local list — does NOT call onConfirm
  const handleAddRegion = () => {
    if (drawingPreview && drawingPreview.x2 - drawingPreview.x1 >= 0.01 && drawingPreview.y2 - drawingPreview.y1 >= 0.01) {
      setRegions((prev) => [...prev, drawingPreview]);
      setDrawingPreview(null);
    }
  };

  const handleRemoveRegion = (index: number) => {
    setRegions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClearAll = () => {
    setRegions([]);
    setDrawingPreview(null);
  };

  // Confirm — sends all regions to parent
  const handleConfirm = () => {
    if (regions.length > 0) {
      onConfirm(regions);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <video
        ref={videoRef}
        src={videoUrl}
        className="w-full rounded-lg"
        style={{ height: size.h }}
        muted
        loop
        playsInline
        onMouseEnter={(e) => (e.target as HTMLVideoElement).play().catch(() => {})}
        onMouseLeave={(e) => { (e.target as HTMLVideoElement).pause(); }}
      />
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        className="absolute inset-0 w-full h-full cursor-crosshair"
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={handleUp}
      />

      {regions.length === 0 && !drawingPreview && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="bg-black/50 text-white text-[11px] px-2 py-1 rounded">
            {t("pipeline.removeWatermarkDrawHint")}
          </span>
        </div>
      )}

      {drawingPreview && (
        <div className="absolute bottom-3 right-3 flex gap-2">
          <button
            type="button"
            onClick={() => setDrawingPreview(null)}
            className="px-3 py-1.5 text-[11px] font-medium bg-white/90 text-gray-600 rounded-lg shadow hover:bg-white cursor-pointer"
          >
            {t("pipeline.removeWatermarkRedraw")}
          </button>
          <button
            type="button"
            onClick={handleAddRegion}
            className="px-3 py-1.5 text-[11px] font-medium bg-danger text-white rounded-lg shadow hover:bg-danger cursor-pointer"
          >
            {t("pipeline.removeWatermarkAdd")}
          </button>
        </div>
      )}

      {regions.length > 0 && !drawingPreview && (
        <div className="absolute bottom-3 left-3 right-3">
          <div className="bg-white/95 rounded-lg shadow-lg p-2 mb-2 max-h-32 overflow-y-auto">
            {regions.map((r, i) => {
              const color = REGION_COLORS[i % REGION_COLORS.length];
              return (
                <div key={i} className="flex items-center justify-between py-1 px-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-4 h-4 rounded text-[9px] font-bold text-white flex items-center justify-center"
                      style={{ backgroundColor: color.stroke }}
                    >
                      {i + 1}
                    </span>
                    <span className="text-[10px] font-mono text-gray-500">
                      x:{(r.x1 * 100).toFixed(0)}%–{(r.x2 * 100).toFixed(0)}%
                      &nbsp;y:{(r.y1 * 100).toFixed(0)}%–{(r.y2 * 100).toFixed(0)}%
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveRegion(i)}
                    className="text-[10px] text-danger hover:text-danger/80 cursor-pointer"
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
              className="px-3 py-1.5 text-[11px] font-medium bg-white/90 text-gray-600 rounded-lg shadow hover:bg-white cursor-pointer"
            >
              {t("pipeline.removeWatermarkClearAll")}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-3 py-1.5 text-[11px] font-medium bg-danger text-white rounded-lg shadow hover:bg-danger cursor-pointer"
            >
              {t("pipeline.removeWatermarkConfirm")} ({regions.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
