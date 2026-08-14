"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getVideoUrl } from "@/lib/api";

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

interface Props {
  videoId: string;
  videoRef?: React.RefObject<HTMLVideoElement>;
  containerRef?: React.RefObject<HTMLDivElement>;
  overlay?: React.ReactNode;
  badge?: React.ReactNode;
  extraControls?: React.ReactNode;
  onSizeChange?: (w: number, h: number) => void;
  onTimeUpdate?: (t: number) => void;
  onSeeked?: (t: number) => void;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>;
  onPointerUp?: React.PointerEventHandler<HTMLDivElement>;
  cursorClass?: string;
}

export default function VideoPlayer({
  videoId,
  videoRef,
  containerRef,
  overlay,
  badge,
  extraControls,
  onSizeChange,
  onTimeUpdate,
  onSeeked,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  cursorClass = "",
}: Props) {
  const containerEl = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 800, h: 450 });

  const [size, setSize] = useState({ w: 800, h: 450 });
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);

  const container = containerRef ?? containerEl;
  const video = videoRef ?? videoEl;

  const redrawSeek = useCallback(() => {
    const v = video.current;
    if (v) setCurrentTime(v.currentTime);
  }, [video]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onMeta = () => {
      const cw = container.current?.clientWidth || 800;
      const r = v.videoWidth / v.videoHeight || 16 / 9;
      const w = Math.min(cw, 800);
      const h = w / r;
      sizeRef.current = { w, h };
      setSize({ w, h });
      setDuration(v.duration || 0);
      onSizeChange?.(w, h);
    };
    const onPause = () => { setPlaying(false); redrawSeek(); };
    const onPlay = () => setPlaying(true);
    const onTime = () => { if (!seeking) setCurrentTime(v.currentTime); };
    const onSeek = () => { setCurrentTime(v.currentTime); onSeeked?.(v.currentTime); };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("pause", onPause);
    v.addEventListener("play", onPlay);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onSeek);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onSeek);
    };
  }, [video, container, redrawSeek, onSeeked, onSizeChange, seeking]);

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  };

  const handleTimelineClick = (e: React.MouseEvent) => {
    const v = video.current;
    const bar = timelineRef.current;
    if (!v || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = clamp((e.clientX - rect.left) / rect.width);
    v.currentTime = pct * duration;
    setCurrentTime(v.currentTime);
    onTimeUpdate?.(v.currentTime);
  };

  const handleTimelineDrag = (e: React.MouseEvent) => {
    if (e.buttons !== 1) return;
    handleTimelineClick(e);
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="double-bezel">
        <div className="double-bezel-inner overflow-hidden">
          <div
            ref={container}
            className={`relative bg-black select-none mx-auto touch-none ${cursorClass}`}
            style={{ width: size.w, height: size.h, maxWidth: "100%" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <video
              ref={video}
              src={getVideoUrl(videoId)}
              className="absolute inset-0 w-full h-full object-contain"
              controls={false}
              playsInline
              preload="auto"
            />
            {overlay}
            {badge}
          </div>
        </div>
      </div>

      <div className="glass-panel rounded-2xl px-3 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center
                       hover:bg-blue-500 shadow-sm active:scale-[0.95] transition-all duration-300
                       ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer"
          >
            {playing ? (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            ) : (
              <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>
          {extraControls}
        </div>
        <span className="text-[11px] font-mono text-ink-light tabular-nums tracking-tight">
          {fmtTime(currentTime)} <span className="opacity-40">/</span> {fmtTime(duration)}
        </span>
      </div>

      <div
        ref={timelineRef}
        className="relative h-8 flex items-center cursor-pointer group select-none"
        onPointerDown={() => setSeeking(true)}
        onPointerUp={() => setSeeking(false)}
        onMouseDown={handleTimelineClick}
        onMouseMove={handleTimelineDrag}
        onMouseLeave={() => setSeeking(false)}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-black/[0.06] overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 border-blue-500 shadow-sm transition-opacity duration-200 opacity-0 group-hover:opacity-100 pointer-events-none"
          style={{ left: `calc(${pct}% - 7px)` }}
        />
        <div className="absolute -bottom-5 inset-x-0 flex justify-between text-[10px] font-mono text-ink-light pointer-events-none">
          <span>{fmtTime(currentTime)}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}