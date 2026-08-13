"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";
import {
  usePipelineStore,
  STEPS,
  STEP_STAGE,
  langLabel,
  fmtElapsed,
  type Pipeline,
} from "@/stores/pipeline-store";

function IconSpinner({ className = "w-4 h-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

const STATUS_META: Record<string, { label: string; cls: string; dot: string }> = {
  queued: { label: "Chờ", cls: "bg-amber-500/10 text-amber-700 ring-amber-500/20", dot: "bg-amber-500" },
  running: { label: "Đang chạy", cls: "bg-blue-500/10 text-blue-700 ring-blue-500/20", dot: "bg-blue-500 animate-pulse" },
  done: { label: "Xong", cls: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20", dot: "bg-emerald-500" },
  error: { label: "Lỗi", cls: "bg-red-500/10 text-red-700 ring-red-500/20", dot: "bg-red-500" },
};

function stepDetail(p: Pipeline): string {
  const idx = STEP_STAGE[p.stage] ?? -1;
  switch (idx) {
    case 0:
      return p.srcLang ? `Puppeteer mở link · ngôn ngữ: ${langLabel(p.srcLang)}` : "Puppeteer mở link Douyin lấy URL video";
    case 1:
      return "FFmpeg gộp 2 file (copy video + audio)";
    case 2:
      return p.ocrEngine
        ? `${p.ocrEngine} · ${langLabel(p.ocrLang)} · vùng 0.114,0.748→0.863,0.972`
        : "Nhận dạng chữ trong video";
    case 3:
      return `Gemini Vision · ${p.contextOn ? "đã bật" : "chưa bật"}`;
    case 4:
      return p.srcLang ? `Gemini · ${langLabel(p.srcLang)} → Tiếng Việt` : "Gemini dịch phụ đề sang tiếng Việt";
    case 5:
      return "Demucs tách giọng + TTS Việt (giữ nhạc nền)";
    case 6:
      return "FFmpeg nhúng SRT (ASS BlackBox) vào MP4";
    default:
      return "";
  }
}

function pipelineElapsed(p: Pipeline, now: number): string {
  if (p.status === "queued") return "—";
  if (!p.startedAt) return "—";
  const end = p.status === "done" || p.status === "error" ? p.finishedAt : now;
  if (!end) return "—";
  return fmtElapsed(end - p.startedAt);
}

export default function AutoPipeline() {
  const pipelines = usePipelineStore((s) => s.pipelines);
  const addPipeline = usePipelineStore((s) => s.addPipeline);
  const removePipeline = usePipelineStore((s) => s.removePipeline);
  const clearFinished = usePipelineStore((s) => s.clearFinished);

  const [url, setUrl] = useState("");
  const [tab, setTab] = useState<"detail" | "list">("detail");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const selected =
    pipelines.find((p) => p.id === selectedId) ??
    pipelines[pipelines.length - 1] ??
    null;

  const handleAdd = () => {
    const v = url.trim();
    if (!v) return;
    const id = addPipeline(v);
    setUrl("");
    setSelectedId(id);
    setTab("detail");
  };

  const activeCount = pipelines.filter((p) => p.status === "queued" || p.status === "running").length;
  const hasFinished = pipelines.some((p) => p.status === "done" || p.status === "error");

  return (
    <main className="min-h-[100dvh] max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Link href="/" className="btn-island-secondary group !px-5 !py-2 text-[13px]">
            <span className="btn-island-icon !w-7 !h-7">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5" /><path d="M11 18l-6-6 6-6" />
              </svg>
            </span>
            <span className="tracking-tight">Back to library</span>
          </Link>
          {hasFinished && (
            <button
              onClick={clearFinished}
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-all duration-300 active:scale-[0.97] cursor-pointer"
            >
              Xoá job đã xong
            </button>
          )}
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mt-10 mb-10">
        <div className="eyebrow mb-4">Auto Pipeline</div>
        <h1 className="text-[clamp(1.8rem,4.5vw,3.4rem)] font-semibold tracking-tight leading-[1.05] text-ink">
          Link Douyin → Video có phụ đề Việt
        </h1>
        <p className="mt-4 text-sm text-ink-muted max-w-lg leading-relaxed">
          Dán link, hệ thống tự động: tải → merge audio/video → OCR → ngữ cảnh → dịch Gemini →
          nhúng phụ đề mới vào video.
        </p>
      </AnimatedBlock>

      {/* Step 1: Input */}
      <AnimatedBlock delay={150}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-3">
              1. Dán link video
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="Dán toàn bộ nội dung chia sẻ (hoặc link https://v.douyin.com/...)"
                className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={handleAdd}
                disabled={!url.trim()}
                className="btn-island-primary group text-sm !px-5 !py-2.5 flex-shrink-0"
              >
                <span className="tracking-tight">Bắt đầu</span>
              </button>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      {/* Tabs */}
      <AnimatedBlock delay={200}>
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] w-max mb-6">
          <button
            onClick={() => setTab("detail")}
            className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
              tab === "detail"
                ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                : "text-ink-light hover:text-ink"
            }`}
          >
            Tiến trình
          </button>
          <button
            onClick={() => setTab("list")}
            className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
              tab === "list"
                ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                : "text-ink-light hover:text-ink"
            }`}
          >
            Danh sách đang xử lý
            {activeCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-[10px] text-blue-600">{activeCount}</span>
            )}
          </button>
        </div>
      </AnimatedBlock>

      {tab === "list" ? (
        <AnimatedBlock delay={250}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-5 sm:p-6">
              {pipelines.length === 0 ? (
                <p className="text-sm text-ink-muted text-center py-8">Chưa có job nào.</p>
              ) : (
                <div className="space-y-2">
                  {pipelines.map((p) => {
                    const meta = STATUS_META[p.status] ?? STATUS_META.queued;
                    return (
                      <div
                        key={p.id}
                        onClick={() => {
                          setSelectedId(p.id);
                          setTab("detail");
                        }}
                        className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] transition-colors cursor-pointer"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ${meta.cls}`}>
                              {meta.label}
                            </span>
                            <span className="ml-auto text-[10px] font-mono text-ink-light tabular-nums">
                              {pipelineElapsed(p, now)}
                            </span>
                          </div>
                          <p className="text-[12px] font-medium text-ink truncate">
                            {p.title || p.url || `Job ${p.id}`}
                          </p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex-1 h-1 rounded-full bg-black/[0.06] overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${
                                  p.status === "error" ? "bg-red-500" : p.status === "done" ? "bg-emerald-500" : "bg-blue-500"
                                }`}
                                style={{ width: `${p.status === "done" ? 100 : Math.max(p.status === "error" ? 0 : p.progress, 2)}%` }}
                              />
                            </div>
                            {(p.status === "running" || p.status === "done") && (
                              <span className="text-[10px] font-mono text-ink-light tabular-nums">{p.progress}%</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removePipeline(p.id);
                            if (selectedId === p.id) setSelectedId(null);
                          }}
                          title="Xoá"
                          className="w-7 h-7 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-500/20 transition-colors cursor-pointer flex-shrink-0"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </AnimatedBlock>
      ) : selected ? (
        <AnimatedBlock delay={250}>
          <DetailView pipeline={selected} now={now} onRemove={() => removePipeline(selected.id)} />
        </AnimatedBlock>
      ) : (
        <AnimatedBlock delay={250}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-16 text-center">
              <p className="text-sm text-ink-muted">Chưa có job nào. Dán link phía trên để bắt đầu.</p>
            </div>
          </div>
        </AnimatedBlock>
      )}
    </main>
  );
}

function DetailView({ pipeline: p, now, onRemove }: { pipeline: Pipeline; now: number; onRemove: () => void }) {
  const activeStep = p.status === "done" ? STEPS.length : STEP_STAGE[p.stage] ?? 0;
  const [previewKind, setPreviewKind] = useState<"subtitle" | "dub">("subtitle");

  const previewUrl =
    previewKind === "dub" && p.dubbedUrl
      ? p.dubbedUrl.replace("/api/download/", "/api/preview/")
      : p.resultUrl.replace("/api/download/", "/api/preview/");

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate">{p.title || "Đang phân tích..."}</p>
            <p className="text-[11px] text-ink-light font-mono truncate">{p.url}</p>
          </div>
          <button
            onClick={onRemove}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
          >
            Xoá
          </button>
        </div>

        <div className="space-y-2">
          {STEPS.map((s, i) => {
            const done = i < activeStep || p.status === "done";
            const active = i === activeStep && p.status !== "done";
            const start = p.stepStarts[i];
            const end = p.stepEnds[i];
            const skipped = p.stepSkipped[i];
            let stepTime: string | null = null;
            if (skipped) stepTime = "Bỏ qua";
            else if (start != null && end != null) stepTime = fmtElapsed(end - start);
            else if (start != null) stepTime = fmtElapsed(now - start);

            return (
              <div key={s.label} className="flex items-center gap-3">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                    skipped
                      ? "bg-black/[0.04] text-ink-light"
                      : done
                      ? "bg-emerald-500/15 text-emerald-600"
                      : active
                      ? "bg-blue-500/15 text-blue-600"
                      : "bg-black/[0.04] text-ink-light"
                  }`}
                >
                  {skipped ? (
                    <span className="text-[11px]">–</span>
                  ) : done ? (
                    <IconCheck className="w-3.5 h-3.5" />
                  ) : active ? (
                    <IconSpinner className="w-3.5 h-3.5" />
                  ) : (
                    <span className="text-[11px] font-mono">{i + 1}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-[13px] font-medium ${done || active ? "text-ink" : "text-ink-light"}`}>
                    {s.label}
                  </p>
                  <p className="text-[11px] text-ink-light">{stepDetail(p)}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {active && (
                    <span className="text-[11px] font-mono text-ink-light tabular-nums">{p.progress}%</span>
                  )}
                  {stepTime && (
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        skipped ? "text-ink-light" : active ? "text-blue-600" : "text-emerald-600"
                      }`}
                    >
                      {stepTime}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {p.logs.length > 0 && (
          <div className="mt-4 rounded-xl bg-black/[0.02] ring-1 ring-black/[0.05] overflow-hidden">
            <div className="px-4 py-2 border-b border-black/[0.05] bg-white/40 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-ink-muted">Nhật ký</span>
              <span className="text-[10px] font-mono text-ink-light tabular-nums">
                Tổng:{" "}
                {p.startedAt
                  ? fmtElapsed((p.status === "done" || p.status === "error" ? p.finishedAt ?? now : now) - p.startedAt)
                  : "—"}
              </span>
            </div>
            <div className="max-h-[220px] overflow-y-auto p-3 space-y-1">
              {p.logs.map((l, i) => (
                <p key={i} className="text-[12px] text-ink-muted font-mono leading-snug">
                  <span className="text-ink-light mr-2">{String(i + 1).padStart(2, "0")}</span>
                  {l}
                </p>
              ))}
            </div>
          </div>
        )}

        {p.error && (
          <div className="mt-4 p-3 rounded-xl bg-red-500/8 ring-1 ring-red-500/15 text-[12px] text-red-600/80 whitespace-pre-wrap">
            {p.error}
          </div>
        )}

        {p.status === "done" && p.resultUrl && (
          <div className="mt-4">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <a href={p.resultUrl} download className="btn-island-primary group text-sm !px-5 !py-2.5">
                <span className="tracking-tight">Tải video (phụ đề)</span>
                <span className="btn-island-icon">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </span>
              </a>
              {p.dubbedUrl && (
                <a href={p.dubbedUrl} download className="btn-island-primary group text-sm !px-5 !py-2.5">
                  <span className="tracking-tight">Tải video lồng tiếng</span>
                  <span className="btn-island-icon">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </span>
                </a>
              )}
            </div>

            {p.dubbedUrl && (
              <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] w-max mb-3">
                <button
                  onClick={() => setPreviewKind("subtitle")}
                  className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all cursor-pointer ${
                    previewKind === "subtitle" ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.06]" : "text-ink-light hover:text-ink"
                  }`}
                >
                  Phụ đề
                </button>
                <button
                  onClick={() => setPreviewKind("dub")}
                  className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all cursor-pointer ${
                    previewKind === "dub" ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.06]" : "text-ink-light hover:text-ink"
                  }`}
                >
                  Lồng tiếng
                </button>
              </div>
            )}

            <iframe
              src={previewUrl}
              title="Result video"
              className="w-full aspect-video rounded-xl ring-1 ring-black/[0.06] bg-black"
              allow="autoplay; fullscreen"
              allowFullScreen
            />
          </div>
        )}
      </div>
    </div>
  );
}
