"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { startProcess, getJobStatus, createWsUrl, cancelJob } from "@/lib/api";
import type { Region, LogEntry, OcrLang, OcrType } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import TranscriptPlayer from "./TranscriptPlayer";

interface Props {
  videoId: string;
  region: Region;
  lang?: OcrLang;
  ocrType?: OcrType;
  startTime?: number;
  onReset: () => void;
  onDone?: () => void;
  onViewLibrary?: () => void;
}

type Phase =
  | "submitting"
  | "queued"
  | "frames"
  | "ocr"
  | "saving"
  | "done"
  | "error"
  | "cancelled";

const STATUS_LABEL_KEYS = {
  submitting: "result.phaseSubmitting",
  queued: "result.phaseQueued",
  frames: "result.phaseFrames",
  ocr: "result.phaseOcr",
  saving: "result.phaseSaving",
  done: "result.phaseDone",
  error: "result.phaseError",
  cancelled: "result.phaseCancelled",
} as const;

function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const LOG_STYLE: Record<
  string,
  { icon: React.ReactNode; fg: string; bg: string }
> = {
  info: {
    fg: "text-accent",
    bg: "bg-accent-muted ring-accent/15",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="0.5" fill="currentColor" />
        <path d="M12 11v5" />
      </svg>
    ),
  },
  success: {
    fg: "text-success",
    bg: "bg-success-muted ring-success/15",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="8 12.5 11 15.5 16 9.5" />
      </svg>
    ),
  },
  warn: {
    fg: "text-warn",
    bg: "bg-warn-muted ring-warn/15",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  text: {
    fg: "text-violet-600",
    bg: "bg-violet-500/10 ring-violet-500/20",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
  },
  error: {
    fg: "text-danger",
    bg: "bg-danger-muted ring-danger/15",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
  },
};

function LogRow({ log, index }: { log: LogEntry; index: number }) {
  const style = LOG_STYLE[log.level] ?? LOG_STYLE.info;
  return (
    <div
      className="flex items-start gap-3 px-3 py-2 rounded-xl bg-white/60 ring-1 ring-black/[0.03]"
      style={{
        animation: `fade-in-right 0.5s cubic-bezier(0.32,0.72,0,1) ${Math.min(index * 40, 300)}ms forwards`,
        opacity: 0,
      }}
    >
      <span
        className={`w-6 h-6 rounded-full ring-1 flex items-center justify-center flex-shrink-0 mt-0.5 ${style.bg} ${style.fg}`}
      >
        {style.icon}
      </span>
      <p
        className={`text-[13px] leading-snug flex-1 pt-0.5 ${log.level === "text" ? "font-medium text-violet-700" : "text-ink"}`}
      >
        {log.message}
      </p>
      <span className="text-[10px] font-mono text-ink-light tabular-nums flex-shrink-0 mt-1">
        {fmtTime(log.ts)}
      </span>
    </div>
  );
}

function LogFeed({ logs, active }: { logs: LogEntry[]; active: boolean }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [logs]);

  return (
    <div className="rounded-2xl bg-black/[0.02] ring-1 ring-black/[0.05] overflow-hidden mt-8">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.05] bg-white/40">
        <span
          className={`w-2 h-2 rounded-full transition-colors duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] ${
            active ? "bg-accent animate-pulse" : "bg-success"
          }`}
        />
        <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-ink-muted">
          {t("result.logsTitle")}
        </span>
        <span className="ml-auto text-[10px] font-mono text-ink-light tabular-nums">
          {t("result.logCount", { count: logs.length })}
        </span>
      </div>
      <div
        ref={containerRef}
        className="max-h-[380px] overflow-y-auto p-3 space-y-1.5"
      >
        {logs.map((log, i) => (
          <LogRow key={`${log.ts}-${i}`} log={log} index={i} />
        ))}
        {logs.length === 0 && (
          <div className="flex items-center gap-2.5 px-3 py-3">
            <svg
              className="w-4 h-4 text-accent animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="1.5"
                opacity="0.15"
              />
              <path
                d="M12 2a10 10 0 019.95 9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <p className="text-[13px] text-ink-light">
              {t("result.waitingServer")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SuccessIcon() {
  return (
    <div
      className="w-16 h-16 rounded-full bg-success-muted ring-1 ring-success/20 flex items-center justify-center mx-auto"
      style={{
        animation: "scale-in 0.7s cubic-bezier(0.32,0.72,0,1) 0.3s forwards",
        opacity: 0,
        transform: "scale(0.8)",
      }}
    >
      <svg
        className="w-8 h-8 text-success"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  );
}

export default function ResultPage({
  videoId,
  region,
  lang = "ch",
  ocrType = "apple",
  startTime,
  onReset,
  onDone,
  onViewLibrary,
}: Props) {
  const [phase, setPhase] = useState<Phase>("submitting");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const seenRef = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const submittedVideoRef = useRef<string | null>(null);
  const doneNotifiedRef = useRef(false);
  const jobIdRef = useRef<string | null>(null);
  const router = useRouter();
  const { t } = useI18n();

  const appendLog = useCallback(
    (message: string, level = "info", ts?: number) => {
      const key = `${ts ?? 0}-${message}`;
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      setLogs((prev) => [
        ...prev,
        { message, level, ts: ts ?? Date.now() / 1000 },
      ]);
    },
    [],
  );

  const connectWs = useCallback(
    (id: string) => {
      wsRef.current?.close();
      const ws = new WebSocket(createWsUrl(id));
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          switch (data.type) {
            case "progress":
              setProgress(data.progress);
              setPhase((data.phase as Phase) || "queued");
              break;
            case "log":
              appendLog(data.message, data.level || "info", data.ts);
              break;
            case "done":
              setPhase("done");
              setProgress(100);
              break;
            case "cancelled":
              setPhase("cancelled");
              setProgress(0);
              break;
            case "error":
              setPhase("error");
              setError(data.message || t("result.failed"));
              break;
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (reconnectRef.current < 5) {
          reconnectRef.current += 1;
          appendLog(t("result.reconnecting"), "warn");
          setTimeout(() => connectWs(id), 2000);
        }
      };
      ws.onerror = () => ws.close();
    },
    [appendLog, t],
  );

  useEffect(() => {
    if (submittedVideoRef.current === videoId) return;
    submittedVideoRef.current = videoId;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      try {
        appendLog(t("result.sendingRequest"));
        const job = await startProcess(videoId, region, lang, ocrType, undefined, startTime);
        jobIdRef.current = job.job_id;
        setPhase("queued");
        connectWs(job.job_id);
        pollTimer = setInterval(async () => {
          try {
            const st = await getJobStatus(job.job_id);
            if (st.logs)
              st.logs.forEach((l) =>
                appendLog(l.message, l.level || "info", l.ts),
              );
            if (st.status === "done") {
              setPhase("done");
              setProgress(100);
              stopPolling();
            } else if (st.status === "cancelled") {
              setPhase("cancelled");
              setProgress(0);
              stopPolling();
            } else if (st.status === "error") {
              setPhase("error");
              setError(st.error || t("result.failed"));
              stopPolling();
            } else {
              setProgress(st.progress);
              setPhase((st.phase as Phase) || "queued");
            }
          } catch (err: unknown) {
            const axiosErr = err as {
              response?: { status?: number; data?: { detail?: string } };
            };
            if (axiosErr.response?.status === 404) {
              stopPolling();
              setPhase("error");
              setError(t("result.jobGone"));
            }
          }
        }, 4000);
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        const msg =
          axiosErr.response?.data?.detail ||
          (err instanceof Error ? err.message : t("result.failedToStart"));
        setPhase("error");
        setError(msg);
        appendLog(t("result.cantStart", { msg }), "error");
      }
    })();
    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
    return () => {
      wsRef.current?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [videoId, region, lang, ocrType, connectWs, appendLog, t]);

  useEffect(() => {
    if (phase === "done" && !doneNotifiedRef.current) {
      doneNotifiedRef.current = true;
      onDone?.();
    }
  }, [phase, onDone]);

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      if (jobIdRef.current) await cancelJob(jobIdRef.current);
      setPhase("cancelled");
      setProgress(0);
      wsRef.current?.close();
    } catch {
      setCancelling(false);
    }
  }, [cancelling]);

  const isProcessing =
    phase !== "done" && phase !== "error" && phase !== "cancelled";

  const reprocessUrl = `/extract?video_id=${videoId}`;

  return (
    <div className="space-y-6">
      {phase === "cancelled" ? (
        <div className="double-bezel">
          <div className="double-bezel-inner p-6 sm:p-10 text-center">
            <svg
              className="w-6 h-6 text-warn mx-auto"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="5" y1="5" x2="19" y2="19" />
            </svg>
            <p className="text-sm text-ink mt-3 font-medium">
              {t("result.cancelledTitle")}
            </p>
            <p className="text-[13px] text-ink-light mt-1.5 max-w-sm mx-auto">
              {t("result.cancelledDesc")}
            </p>
            <div className="flex items-center justify-center gap-3 mt-6">
              <button
                onClick={() => router.push(reprocessUrl)}
                className="btn-island-primary group text-sm"
              >
                <span className="tracking-tight">{t("result.retry")}</span>
                <span className="btn-island-icon">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </span>
              </button>
              {onViewLibrary && (
                <button
                  onClick={onViewLibrary}
                  className="btn-island-secondary group text-sm"
                >
                  <span className="tracking-tight">{t("result.backToLibrary")}</span>
                  <span className="btn-island-icon">
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      ) : isProcessing || phase === "error" ? (
        <div className="double-bezel">
          <div className="double-bezel-inner p-6 sm:p-8">
            <div className="text-center mb-6">
              {phase === "error" ? (
                <svg
                  className="w-6 h-6 text-danger mx-auto"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              ) : (
                <svg
                  className="w-6 h-6 text-accent animate-spin mx-auto"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    opacity="0.15"
                  />
                  <path
                    d="M12 2a10 10 0 019.95 9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              <p className="text-sm text-ink mt-3 font-medium">
                {t(STATUS_LABEL_KEYS[phase])}
              </p>
            </div>

            <div className="max-w-sm mx-auto">
              <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
                    ${phase === "error" ? "bg-danger" : "bg-gradient-to-r from-blue-600 to-blue-400"}`}
                  style={{ width: `${Math.max(progress, 2)}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <p className="text-[11px] text-ink-light">{t("result.progress")}</p>
                <p className="text-xs font-mono text-ink-light tabular-nums">
                  {progress}%
                </p>
              </div>
            </div>

            <div className="flex items-center justify-center mt-6">
              <button
                onClick={handleCancel}
                disabled={cancelling || phase === "error"}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium tracking-tight text-danger ring-1 ring-danger/20 hover:bg-danger-muted transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {cancelling ? (
                  <svg
                    className="w-4 h-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      opacity="0.15"
                    />
                    <path
                      d="M12 2a10 10 0 019.95 9"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="5" y1="5" x2="19" y2="19" />
                  </svg>
                )}
                <span>
                  {cancelling ? t("result.cancelling") : t("result.cancel")}
                </span>
              </button>
            </div>

            <LogFeed logs={logs} active={isProcessing} />

            {error && (
              <div
                className="mt-6 p-4 rounded-2xl bg-danger-muted ring-1 ring-danger/15"
                style={{
                  animation:
                    "fade-in 0.7s cubic-bezier(0.32,0.72,0,1) forwards",
                }}
              >
                <div className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-danger flex-shrink-0 mt-0.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <p className="text-sm text-danger/80">{error}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div
            className="text-center"
            style={{
              animation: "scale-in 0.7s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <SuccessIcon />
            <p className="text-sm text-ink-muted mt-3">{t("result.doneTitle")}</p>
          </div>

          <div
            style={{
              animation:
                "fade-in 0.9s cubic-bezier(0.32,0.72,0,1) 0.3s forwards",
              opacity: 0,
            }}
          >
            <TranscriptPlayer videoId={videoId} />
          </div>

          <div className="flex items-center justify-center gap-3">
            {onViewLibrary && (
              <button
                onClick={onViewLibrary}
                className="btn-island-primary group text-sm"
              >
                <span className="tracking-tight">{t("result.viewLibrary")}</span>
                <span className="btn-island-icon">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="M13 6l6 6-6 6" />
                  </svg>
                </span>
              </button>
            )}
            <button
              onClick={onReset}
              className="btn-island-secondary group text-sm"
            >
              <span className="tracking-tight">{t("result.extractAnother")}</span>
              <span className="btn-island-icon">
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
