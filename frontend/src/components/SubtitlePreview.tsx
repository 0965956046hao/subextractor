"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Region, SubtitleStyle } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import VideoPlayer from "@/components/VideoPlayer";

interface Props {
  videoId: string;
  region: Region;
  onConfirmed: (style: Partial<SubtitleStyle>) => void;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export default function SubtitlePreview({ videoId, region, onConfirmed }: Props) {
  const { t } = useI18n();
  const [fontSize, setFontSize] = useState(48);
  const [marginV, setMarginV] = useState(40);
  const [marginH, setMarginH] = useState(0);
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTimeRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; mv: number; mh: number } | null>(null);

  const fetchOverlay = useCallback(
    async (fs: number, mv: number, mh: number, time: number, force?: boolean) => {
      if (!force && Math.abs(time - lastTimeRef.current) < 0.3) return;
      lastTimeRef.current = time;
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/preview/subtitle/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            region,
            style: { font_size: fs, margin_v: mv, margin_h: mh },
            text: t("preview.sampleText"),
            time,
            format: "overlay",
          }),
        });
        if (!res.ok) throw new Error("preview failed");
        const blob = await res.blob();
        setOverlayUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [videoId, region, t]
  );

  // Initial overlay at t=0, then re-render on slider changes (debounced).
  useEffect(() => {
    fetchOverlay(fontSize, marginV, marginH, 0, true);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(
    (fs: number, mv: number, mh: number) => {
      const t = videoRef.current?.currentTime ?? 0;
      // force=true: a style change must always re-render even if the video
      // hasn't moved (otherwise the time-throttle silently drops the update).
      fetchOverlay(fs, mv, mh, t, true);
    },
    [fetchOverlay]
  );

  const handleFontSize = (v: number) => {
    const next = clamp(v, 16, 160);
    setFontSize(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refresh(next, marginV, marginH), 250);
  };

  const handleMarginV = (v: number) => {
    const next = clamp(v, 0, 400);
    setMarginV(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refresh(fontSize, next, marginH), 250);
  };

  const handleMarginH = (v: number) => {
    const next = clamp(v, -600, 600);
    setMarginH(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refresh(fontSize, marginV, next), 250);
  };

  const handleTimeUpdate = () => {
    const t = videoRef.current?.currentTime ?? 0;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchOverlay(fontSize, marginV, marginH, t), 200);
  };

  const handleSeeked = () => {
    fetchOverlay(fontSize, marginV, marginH, videoRef.current?.currentTime ?? 0, true);
  };

  const handleConfirm = () => {
    onConfirmed({ font_size: fontSize, margin_v: marginV, margin_h: marginH });
  };

  // Drag the subtitle text directly on the video to reposition it.
  // Convert CSS-pixel deltas to the 1080p (v) / 1920px (h) reference units the
  // backend scales from, so the drag feels 1:1 regardless of container size.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { x: e.clientX, y: e.clientY, mv: marginV, mh: marginH };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const scaleV = 1080 / rect.height;
    const scaleH = 1920 / rect.width;
    const mv = clamp(drag.mv - dy * scaleV, 0, 400);
    const mh = clamp(drag.mh + dx * scaleH, -600, 600);
    setMarginV(mv);
    setMarginH(mh);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refresh(fontSize, mv, mh), 60);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    refresh(fontSize, marginV, marginH);
  };

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          {t("preview.helpDesc1")}{" "}
          <b>{t("preview.confirmAction")}</b>{" "}
          {t("preview.helpDesc2")}
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-white/[0.04] ring-1 ring-white/[0.09]">↵</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">{t("preview.confirmShort")}</span>
        </div>
      </div>

      <VideoPlayer
        videoId={videoId}
        videoRef={videoRef}
        containerRef={containerRef}
        onTimeUpdate={handleTimeUpdate}
        onSeeked={handleSeeked}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        cursorClass="cursor-grab active:cursor-grabbing"
        overlay={
          <>
            {overlayUrl && (
              <img
                src={overlayUrl}
                alt={t("preview.overlayAlt")}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                draggable={false}
              />
            )}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              </div>
            )}
          </>
        }
        badge={
          <>
            <div className="absolute bottom-2 left-2 px-2 py-1 rounded-md bg-black/40 text-white/80 text-[10px] pointer-events-none">
              {t("preview.dragHint")}
            </div>
            {error && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
                <p className="text-white/90 text-[12px] px-4 text-center">
                  {t("preview.previewFailed")}
                </p>
              </div>
            )}
          </>
        }
      />

      <div className="glass-panel rounded-2xl p-4 sm:p-5 space-y-4">
        <label className="block">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
              {t("preview.fontSize")}
            </span>
            <span className="text-[12px] font-mono tabular-nums text-accent font-semibold">
              {fontSize}px
            </span>
          </div>
          <input
            type="range"
            min={16}
            max={160}
            step={1}
            value={fontSize}
            onChange={(e) => handleFontSize(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </label>

        <label className="block">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
              {t("preview.marginV")}
            </span>
            <span className="text-[12px] font-mono tabular-nums text-accent font-semibold">
              {marginV}px
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={400}
            step={4}
            value={marginV}
            onChange={(e) => handleMarginV(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </label>

        <label className="block">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
              {t("preview.marginH")}
            </span>
            <span className="text-[12px] font-mono tabular-nums text-accent font-semibold">
              {marginH}px
            </span>
          </div>
          <input
            type="range"
            min={-600}
            max={600}
            step={4}
            value={marginH}
            onChange={(e) => handleMarginH(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={handleConfirm}
            disabled={!overlayUrl}
            className="btn-island-primary group text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="tracking-tight">{t("preview.confirm")}</span>
            <span className="btn-island-icon">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}