"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import type { Region } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface Props {
  videoUrl: string;
  onRegion: (region: Region | null) => void;
}

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

export default function WatermarkRegionSelector({ videoUrl, onRegion }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 225 });
  const [drawing, setDrawing] = useState(false);
  const [startPt, setStartPt] = useState<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<Region | null>(null);

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

    if (preview) {
      const p = { x1: preview.x1 * c.width, y1: preview.y1 * c.height, x2: preview.x2 * c.width, y2: preview.y2 * c.height };
      // Dim outside
      ctx.fillStyle = "rgba(239,68,68,0.15)";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.clearRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
      // Border
      ctx.strokeStyle = "rgba(239,68,68,0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
      ctx.setLineDash([]);
      // Label
      ctx.fillStyle = "rgba(239,68,68,0.9)";
      ctx.font = "11px sans-serif";
      ctx.fillText("WATERMARK", p.x1 + 4, p.y1 + 14);
    }
  }, [preview]);

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
    setPreview(null);
  };

  const handleMove = (e: React.MouseEvent) => {
    if (!drawing || !startPt) return;
    const pt = toNorm(e);
    const r: Region = {
      x1: Math.min(startPt.x, pt.x),
      y1: Math.min(startPt.y, pt.y),
      x2: Math.max(startPt.x, pt.x),
      y2: Math.max(startPt.y, pt.y),
    };
    setPreview(r);
  };

  const handleUp = () => {
    if (!drawing) return;
    setDrawing(false);
    setStartPt(null);
  };

  const handleConfirm = () => {
    if (preview && preview.x2 - preview.x1 >= 0.01 && preview.y2 - preview.y1 >= 0.01) {
      onRegion(preview);
    }
  };

  const handleClear = () => {
    setPreview(null);
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
      {!preview && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="bg-black/50 text-white text-[11px] px-2 py-1 rounded">
            {t("pipeline.removeWatermarkDrawHint")}
          </span>
        </div>
      )}
      {preview && (
        <div className="absolute bottom-3 right-3 flex gap-2">
          <button
            type="button"
            onClick={handleClear}
            className="px-3 py-1.5 text-[11px] font-medium bg-white/90 text-gray-600 rounded-lg shadow hover:bg-white cursor-pointer"
          >
            {t("pipeline.removeWatermarkRedraw")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-3 py-1.5 text-[11px] font-medium bg-red-500 text-white rounded-lg shadow hover:bg-red-600 cursor-pointer"
          >
            {t("pipeline.removeWatermarkConfirm")}
          </button>
        </div>
      )}
    </div>
  );
}
