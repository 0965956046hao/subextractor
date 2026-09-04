"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import type { Region } from "@/lib/api";
import { testOcrColor } from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer";
import { useI18n } from "@/lib/i18n";
import type { ColorFilter } from "@/stores/pipeline-store";
import { DEFAULT_COLOR_FILTER } from "@/stores/pipeline-store";

interface Props {
  videoId: string;
  onConfirmed: (region: Region, startTime?: number, colorFilter?: ColorFilter | null) => void;
  initialColorFilter?: ColorFilter | null;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return [255, 255, 255];
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
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

export default function RegionSelector({ videoId, onConfirmed, initialColorFilter }: Props) {
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
  const [colorFilter, setColorFilter] = useState<ColorFilter>(initialColorFilter ?? DEFAULT_COLOR_FILTER);
  const [eyedropper, setEyedropper] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [testText, setTestText] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

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

  // ── Eyedropper ──
  const handleEyedropperPick = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    const v = videoRef.current;
    if (!c || !v) return;
    // Draw current video frame to offscreen canvas to sample color
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(v, 0, 0, off.width, off.height);
      const rect = c.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * (off.width / rect.width));
      const y = Math.round((e.clientY - rect.top) * (off.height / rect.height));
      const data = ctx.getImageData(Math.max(0, Math.min(x, off.width - 1)), Math.max(0, Math.min(y, off.height - 1)), 1, 1).data;
      setColorFilter((prev) => ({ ...prev, color: rgbToHex(data[0], data[1], data[2]), enabled: true }));
    } catch {}
    setEyedropper(false);
  }, []);

  // ── Preview mask ──
  useEffect(() => {
    const c = previewRef.current;
    const v = videoRef.current;
    const r = rectRef.current;
    if (!c || !v || !r || !colorFilter.enabled) {
      if (c) {
        const ctx = c.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
      }
      return;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height;
    // Draw cropped region
    const vw = v.videoWidth || w;
    const vh = v.videoHeight || h;
    const sx = r.x1 * vw, sy = r.y1 * vh, sw = (r.x2 - r.x1) * vw, sh = (r.y2 - r.y1) * vh;
    if (sw <= 0 || sh <= 0) return;
    ctx.clearRect(0, 0, w, h);
    try {
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const [tr, tg, tb] = hexToRgb(colorFilter.color);
      const luma = 0.299 * tr + 0.587 * tg + 0.114 * tb;
      const bg = luma > 128 ? 0 : 255;
      const tol = colorFilter.tolerance;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist > tol) {
          d[i] = bg; d[i + 1] = bg; d[i + 2] = bg;
        }
      }
      ctx.putImageData(img, 0, 0);
    } catch {}
  }, [colorFilter, rect, currentTime, size]);

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
    if (eyedropper) {
      handleEyedropperPick(e);
      return;
    }
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
    else if (e.key === "Enter" && regionUsable(rectRef.current)) onConfirmed(rectRef.current, startTime ?? undefined, colorFilter.enabled ? colorFilter : null);
  }, [onConfirmed, startTime, colorFilter]);

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
            className={`absolute inset-0 touch-none ${eyedropper ? "cursor-crosshair" : ""}`}
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

      {/* Color filter panel */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">{t("region.colorFilter" as string)}</p>
            <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">{t("region.colorFilterHint" as string)}</p>
          </div>
          <button
            type="button"
            onClick={() => setColorFilter((p) => ({ ...p, enabled: !p.enabled }))}
            className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${colorFilter.enabled ? "bg-accent" : "bg-black/10"}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${colorFilter.enabled ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>
        {colorFilter.enabled && (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2">
                <span className="text-[11px] text-ink-muted">{t("region.color" as string)}</span>
                <input type="color" value={colorFilter.color} onChange={(e) => setColorFilter((p) => ({ ...p, color: e.target.value.toUpperCase() }))} className="w-10 h-8 rounded cursor-pointer bg-transparent" />
              </label>
              <input type="text" value={colorFilter.color} onChange={(e) => setColorFilter((p) => ({ ...p, color: e.target.value }))} placeholder="#FFFFFF" className="w-28 px-2 py-1.5 text-[12px] font-mono text-ink bg-white/[0.04] border border-white/[0.10] rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/30" />
              <button type="button" onClick={() => setEyedropper((v) => !v)} className={`px-3 py-1.5 text-[11px] font-medium rounded-lg transition-colors cursor-pointer ${eyedropper ? "bg-accent text-white" : "bg-white/[0.05] text-ink-muted hover:bg-white/[0.11]"}`}>
                {eyedropper ? t("region.eyedropperActive" as string) : t("region.eyedropper" as string)}
              </button>
              <span className="w-6 h-6 rounded-full ring-1 ring-white/20" style={{ background: colorFilter.color }} />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-ink-muted">{t("region.tolerance" as string)}</span>
              <input type="range" min={0} max={100} value={colorFilter.tolerance} onChange={(e) => setColorFilter((p) => ({ ...p, tolerance: Number(e.target.value) }))} className="flex-1 accent-accent" />
              <span className="text-[12px] font-mono tabular-nums text-accent font-semibold w-8">{colorFilter.tolerance}</span>
            </div>
            <div className="rounded-xl overflow-hidden ring-1 ring-white/[0.08] bg-black/20">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-muted bg-white/[0.04]">{t("region.previewMask" as string)}</div>
              <canvas ref={previewRef} width={320} height={100} className="w-full h-[100px] object-contain bg-black" />
              {!regionUsable(r) && <p className="px-3 py-2 text-[11px] text-ink-light text-center">{t("region.previewNeedRegion" as string)}</p>}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={!regionUsable(r) || testing}
                onClick={async () => {
                  if (!r) return;
                  setTesting(true);
                  setTestText(null);
                  try {
                    const res = await testOcrColor(videoId, r, colorFilter.enabled ? colorFilter : null, currentTime);
                    setTestText(res.text || t("region.testEmpty" as string));
                  } catch (e) {
                    setTestText(e instanceof Error ? e.message : String(e));
                  } finally {
                    setTesting(false);
                  }
                }}
                className="px-3 py-1.5 text-[11px] font-medium bg-accent text-white rounded-lg hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5 cursor-pointer"
              >
                {testing ? (
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
                {testing ? t("region.testing" as string) : t("region.testOcr" as string)}
              </button>
              {testText !== null && (
                <span className="text-[11px] text-ink px-2 py-1 rounded-lg bg-white/[0.06] ring-1 ring-white/[0.08] max-w-[60%] truncate" title={testText}>
                  {testText}
                </span>
              )}
              {testText !== null && (
                <button type="button" onClick={() => setTestText(null)} className="text-[11px] text-ink-light hover:text-ink cursor-pointer">✕</button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Confirm bar */}
      {regionUsable(r) && (
        <div className="glass-panel rounded-2xl p-4 sm:p-5" style={{ animation: "fade-in 0.9s cubic-bezier(0.32,0.72,0,1) forwards" }}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className="text-xs sm:text-sm text-ink-muted font-mono tracking-tight">
              x: {r.x1.toFixed(3)} y: {r.y1.toFixed(3)} &rarr; x: {r.x2.toFixed(3)} y: {r.y2.toFixed(3)}
            </span>
            <button onClick={() => onConfirmed(r, startTime ?? undefined, colorFilter.enabled ? colorFilter : null)} className="btn-island-primary group text-sm">
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
