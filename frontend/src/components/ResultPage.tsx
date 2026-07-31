"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { startProcess, getDownloadUrl, createWsUrl } from "@/lib/api";
import type { Region } from "@/lib/api";

interface Props {
  videoId: string;
  region: Region;
  onReset: () => void;
}

type Phase = "submitting" | "queued" | "frames" | "ocr" | "saving" | "done" | "error";

const STAGES: { phase: Phase; label: string }[] = [
  { phase: "submitting", label: "Submitting" },
  { phase: "queued", label: "Queued" },
  { phase: "frames", label: "Extracting frames" },
  { phase: "ocr", label: "Running OCR" },
  { phase: "saving", label: "Saving SRT" },
];

function StageRow({ phase, label, current, index }: { phase: Phase; label: string; current: Phase; index: number }) {
  const curIdx = STAGES.findIndex((s) => s.phase === current);
  const phaseIdx = STAGES.findIndex((s) => s.phase === phase);
  const isDone = phaseIdx < curIdx;
  const isActive = phase === current;

  return (
    <div
      className="flex items-center gap-4"
      style={{
        animation: `fade-in 0.7s cubic-bezier(0.32,0.72,0,1) ${index * 120}ms forwards`,
        opacity: 0, transform: "translateY(16px)",
      }}
    >
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
          ${isDone ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30" :
            isActive ? "bg-blue-600 text-white shadow-[0_0_16px_rgba(59,130,246,0.2)]" :
            "bg-black/[0.02] text-ink-light ring-1 ring-black/[0.06]"}`}
      >
        {isDone ? (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <span className="text-xs font-medium">{String(index + 1)}</span>
        )}
      </div>
      <span
        className={`text-sm transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]
          ${isDone ? "text-emerald-600/70" : isActive ? "text-ink font-medium" : "text-ink-light"}`}
      >
        {label}
      </span>
      {isActive && <svg className="w-3.5 h-3.5 text-blue-500 ml-auto animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" /><path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
      {isDone && <svg className="w-3.5 h-3.5 text-emerald-500/60 ml-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>}
    </div>
  );
}

function SuccessIcon() {
  return (
    <div
      className="w-16 h-16 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center mx-auto"
      style={{ animation: "scale-in 0.7s cubic-bezier(0.32,0.72,0,1) 0.3s forwards", opacity: 0, transform: "scale(0.8)" }}
    >
      <svg className="w-8 h-8 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  );
}

export default function ResultPage({ videoId, region, onReset }: Props) {
  const [phase, setPhase] = useState<Phase>("submitting");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const submittedVideoRef = useRef<string | null>(null);

  const connectWs = useCallback((id: string) => {
    wsRef.current?.close();
    const ws = new WebSocket(createWsUrl(id));
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        switch (data.type) {
          case "progress": setProgress(data.progress); setPhase(data.phase as Phase); break;
          case "done": setPhase("done"); setProgress(100); break;
          case "error": setPhase("error"); setError(data.message || "Processing failed"); break;
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (reconnectRef.current < 5) {
        reconnectRef.current += 1;
        setTimeout(() => connectWs(id), 2000);
      }
    };
    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    if (submittedVideoRef.current === videoId) return;
    submittedVideoRef.current = videoId;
    (async () => {
      try {
        const job = await startProcess(videoId, region);
        setJobId(job.job_id); setPhase("queued"); connectWs(job.job_id);
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        const msg = axiosErr.response?.data?.detail || (err instanceof Error ? err.message : "Failed to start");
        setPhase("error"); setError(msg);
      }
    })();
    return () => wsRef.current?.close();
  }, [videoId, region, connectWs]);

  const isProcessing = phase !== "done" && phase !== "error";

  return (
    <div className="space-y-6">
      <div className="double-bezel">
        <div className="double-bezel-inner p-6 sm:p-8">
          <div className="text-center mb-6">
            {phase === "done" ? <SuccessIcon /> : isProcessing ? (
              <svg className="w-6 h-6 text-blue-500 animate-spin mx-auto" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
                <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            ) : null}
            <p className="text-sm text-ink-muted mt-3">
              {isProcessing
                ? phase === "submitting" ? "Submitting job…" : phase === "queued" ? "Waiting in queue…"
                  : phase === "frames" ? "Extracting video frames…" : phase === "ocr" ? "Running OCR recognition…"
                  : phase === "saving" ? "Saving subtitle file…" : "Processing…"
                : phase === "done" ? "Extraction complete" : "Error"}
            </p>
          </div>

          <div className="max-w-sm mx-auto mb-8">
            <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
                  ${phase === "error" ? "bg-red-500" : phase === "done" ? "bg-gradient-to-r from-emerald-500 to-emerald-400" : "bg-gradient-to-r from-blue-600 to-blue-400"}`}
                style={{ width: `${Math.max(progress, 2)}%` }}
              />
            </div>
            <p className="text-center text-xs font-mono text-ink-light mt-2">{progress}%</p>
          </div>

          <div className="max-w-[240px] mx-auto space-y-4">
            {STAGES.map((s, i) => <StageRow key={s.phase} phase={s.phase} label={s.label} current={phase} index={i} />)}
          </div>

          {error && (
            <div className="mt-6 p-4 rounded-2xl bg-red-500/10 ring-1 ring-red-500/15" style={{ animation: "fade-in 0.7s cubic-bezier(0.32,0.72,0,1) forwards" }}>
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="text-sm text-red-600/80">{error}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {phase === "done" && (
        <div className="double-bezel" style={{ animation: "fade-in 0.9s cubic-bezier(0.32,0.72,0,1) 0.5s forwards", opacity: 0 }}>
          <div className="double-bezel-inner p-6 sm:p-8 text-center space-y-5">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
              <svg className="w-3.5 h-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span className="text-xs font-medium text-emerald-600/80">Success</span>
            </div>
            <a href={getDownloadUrl(jobId || videoId)} download="subtitles.srt" className="btn-island-primary group text-base px-10 py-4">
              <span className="tracking-tight">Download .SRT</span>
              <span className="btn-island-icon">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </span>
            </a>
            <p className="text-xs text-ink-light">Compatible with all video players</p>
          </div>
        </div>
      )}

      <div className="text-center">
        <button onClick={onReset} disabled={isProcessing} className="btn-island-secondary group text-xs">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          Process another video
        </button>
      </div>
    </div>
  );
}
