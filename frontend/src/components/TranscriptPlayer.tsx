"use client";

import { useState, useEffect, useRef } from "react";
import { getVideoUrl, getDownloadUrl, getSrtContent } from "@/lib/api";

interface SrtEntry {
  index: number;
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
  text: string;
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function parseTime(t: string): number {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(",");
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms || "0") / 1000;
}

function parseSrt(content: string): SrtEntry[] {
  const blocks = content.trim().split(/\n\s*\n/);
  const entries: SrtEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeMatch = lines[1]?.match(/([\d:,]+)\s*-->\s*([\d:,]+)/);
    if (!timeMatch) continue;
    const start = parseTime(timeMatch[1]);
    const end = parseTime(timeMatch[2]);
    entries.push({
      index: entries.length + 1,
      start,
      end,
      startLabel: timeMatch[1],
      endLabel: timeMatch[2],
      text: lines.slice(2).join(" "),
    });
  }
  return entries;
}

export default function TranscriptPlayer({ videoId }: { videoId: string }) {
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getSrtContent(videoId)
      .then((content) => {
        if (cancelled) return;
        setEntries(parseSrt(content));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load SRT");
      });
    return () => { cancelled = true; };
  }, [videoId]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setCurrentTime(v.currentTime);
      let idx = -1;
      for (let i = 0; i < entries.length; i++) {
        if (v.currentTime >= entries[i].start && v.currentTime < entries[i].end) { idx = i; break; }
      }
      setActiveIndex(idx);
      if (idx >= 0) {
        const el = listRef.current?.querySelector(`[data-index="${idx}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, [entries]);

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    const bar = e.currentTarget;
    if (!v || !bar) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    v.currentTime = pct * (v.duration || 0);
    setCurrentTime(v.currentTime);
  };

  const seekEntry = (entry: SrtEntry) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = entry.start;
    setCurrentTime(entry.start);
    setActiveIndex(entry.index - 1);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const duration = videoRef.current?.duration || 0;
  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (loadError) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-6">
          <div className="flex items-start gap-3 p-4 rounded-2xl bg-red-500/10 ring-1 ring-red-500/15">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-sm text-red-600/80">{loadError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-10">
          <div className="flex flex-col items-center gap-3">
            <svg className="w-6 h-6 text-blue-500 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
              <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className="text-sm text-ink-muted">Loading transcript…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-5 sm:p-7">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-5">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
            <svg className="w-3.5 h-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span className="text-xs font-medium text-emerald-600/80">{entries.length} subtitles extracted</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={getDownloadUrl(videoId, "srt")}
              download="subtitles.srt"
              className="btn-island-primary group text-sm"
            >
              <span className="tracking-tight">Download .SRT</span>
              <span className="btn-island-icon">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </span>
            </a>
            <a
              href={getDownloadUrl(videoId, "txt")}
              download="subtitles.txt"
              className="btn-island-secondary group text-sm"
            >
              <span className="tracking-tight">Download .TXT</span>
              <span className="btn-island-icon">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </span>
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Video with subtitle mask ── */}
          <div className="space-y-3">
            <div className="relative bg-black rounded-2xl overflow-hidden aspect-video select-none">
              <video
                ref={videoRef}
                src={getVideoUrl(videoId)}
                className="w-full h-full object-contain"
                playsInline
                preload="auto"
              />
              {activeIndex >= 0 && entries[activeIndex] && (
                <div className="absolute inset-x-0 bottom-0 px-4 pb-4 sm:pb-5 pointer-events-none flex justify-center">
                  <div
                    className="max-w-[92%] text-center rounded-xl bg-black/70 backdrop-blur-sm px-3.5 py-1.5 shadow-lg"
                    style={{ animation: "fade-in 0.25s ease forwards" }}
                  >
                    <p className="text-white text-sm sm:text-base leading-snug tracking-wide">
                      {entries[activeIndex].text}
                    </p>
                  </div>
                </div>
              )}
              {!playing && activeIndex < 0 && (
                <button
                  onClick={togglePlay}
                  aria-label="Play"
                  className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm border border-white/15 flex items-center justify-center transition-all duration-300 active:scale-95 cursor-pointer"
                >
                  <svg className="w-6 h-6 text-white ml-1" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </button>
              )}
            </div>

            <div className="glass-panel rounded-2xl px-3 py-2.5 flex items-center gap-3">
              <button
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-500 shadow-sm active:scale-[0.95] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer flex-shrink-0"
              >
                {playing ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                ) : (
                  <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                )}
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-black/[0.08] overflow-hidden cursor-pointer group relative" onClick={seekTo}>
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-100"
                  style={{ width: `${playPct}%` }}
                />
              </div>
              <span className="text-[11px] font-mono text-ink-light tabular-nums tracking-tight flex-shrink-0">
                {Math.floor(currentTime / 60)}:{String(Math.floor(currentTime % 60)).padStart(2, "0")} / {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}
              </span>
            </div>
          </div>

          {/* ── SRT list ── */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between px-1 mb-2">
              <span className="text-xs font-medium text-ink-muted tracking-wide uppercase">Transcript</span>
              <span className="text-[10px] font-mono text-ink-light tabular-nums">{entries.length} lines</span>
            </div>
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto pr-1 space-y-1 rounded-xl max-h-[520px] lg:max-h-[560px] scroll-smooth"
            >
              {entries.map((entry, i) => (
                <button
                  key={entry.index}
                  data-index={i}
                  onClick={() => seekEntry(entry)}
                  className={`w-full text-left rounded-xl px-3 py-2 transition-all duration-200 cursor-pointer group
                    ${i === activeIndex
                      ? "bg-blue-600/10 ring-1 ring-blue-500/25"
                      : "hover:bg-black/[0.03] ring-1 ring-transparent"}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[10px] font-mono tabular-nums tracking-tight flex-shrink-0 ${i === activeIndex ? "text-blue-600" : "text-ink-light"}`}>
                      {entry.startLabel} → {entry.endLabel}
                    </span>
                  </div>
                  <p className={`text-[13px] leading-snug mt-0.5 ${i === activeIndex ? "text-ink font-medium" : "text-ink-muted"}`}>
                    {entry.text}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
