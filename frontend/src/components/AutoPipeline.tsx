"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";
import { getPipelineHealth, clearTempData, getCapCutVoices, capCutPreview, getGoogleTtsVoices, googleTtsPreview, getFrameUrl, listVideos, deleteVideo, type PipelineHealth, type CapCutVoice, type VideoMeta } from "@/lib/api";
import RegionSelector from "@/components/RegionSelector";
import SubtitlePreview from "@/components/SubtitlePreview";
import {
  usePipelineStore,
  STEPS,
  STEP_STAGE,
  DEFAULT_REGION,
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
      return p.region
        ? `Đã chọn vùng x ${p.region.x1}–${p.region.x2} · y ${p.region.y1}–${p.region.y2}`
        : "Kéo vùng quét lấy phụ đề trên video";
    case 3:
      return p.subtitleStyle
        ? `Cỡ chữ ${p.subtitleStyle.font_size ?? 48}px · cách đáy ${p.subtitleStyle.margin_v ?? 40}px`
        : p.autoFit
        ? "Tự động khớp vị trí sub gốc"
        : "Xem trước, chỉnh cỡ chữ và vị trí phụ đề";
    case 4:
      return p.ocrEngine ? `${p.ocrEngine} · ${langLabel(p.ocrLang)}` : "Nhận dạng chữ trong vùng đã chọn";
    case 5:
      return `Gemini Vision · ${p.contextOn ? "đã bật" : "chưa bật"}`;
    case 6:
      return p.srcLang ? `Gemini · ${langLabel(p.srcLang)} → Tiếng Việt` : "Gemini dịch phụ đề sang tiếng Việt";
    case 7:
      return "Demucs tách giọng + TTS Việt (giữ nhạc nền)";
    case 8:
      return "FFmpeg nhúng SRT (ASS BlackBox) vào MP4";
    case 9:
      return "Gemini tạo tiêu đề/mô tả/tags từ ngữ cảnh";
    case 10:
      return "fal.ai chỉnh lại thumbnail 16:9 + tiêu đề";
    case 11:
      return "Đăng video lên YouTube kèm meta";
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
  const importDone = usePipelineStore((s) => s.importDone);

  const [url, setUrl] = useState("");
  const [regionMode, setRegionMode] = useState<"manual" | "auto">("manual");
  const [dubEngine, setDubEngine] = useState<"google" | "capcut">("capcut");
  const [dubVoice, setDubVoice] = useState("BV421_vivn_streaming");
  const [muteOriginal, setMuteOriginal] = useState(true);
  const [originalGainDb, setOriginalGainDb] = useState(6);
  const [autoFitSubs, setAutoFitSubs] = useState(true);
  const [watermarkOn, setWatermarkOn] = useState(false);
  const [autoUploadYoutube, setAutoUploadYoutube] = useState(false);
  const [capcutVoices, setCapcutVoices] = useState<CapCutVoice[]>([]);
  const [googleVoices, setGoogleVoices] = useState<CapCutVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [tab, setTab] = useState<"detail" | "active" | "done">("detail");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [historyVideos, setHistoryVideos] = useState<VideoMeta[]>([]);
  const [showFalModal, setShowFalModal] = useState(false);
  const [falKeyInput, setFalKeyInput] = useState("");
  const [falSaveStatus, setFalSaveStatus] = useState("");
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  const focusNewVideo = useCallback(() => {
    urlInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    urlInputRef.current?.focus();
  }, []);

  const openFalModal = async () => {
    setShowFalModal(true);
    setFalSaveStatus("");
    try {
      const d = await fetch("/api/config").then((r) => r.json());
      setFalKeyInput(d.has_fal_key ? "••••••••" : "");
    } catch {
      // ignore
    }
  };

  const saveFalKey = async () => {
    setFalSaveStatus("Đang lưu...");
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fal_key: falKeyInput && falKeyInput !== "••••••••" ? falKeyInput : "",
        }),
      });
      const d = await res.json();
      if (d.error) {
        setFalSaveStatus(d.error);
      } else {
        setFalSaveStatus("Đã lưu!");
        setTimeout(() => {
          setShowFalModal(false);
          setFalSaveStatus("");
        }, 1200);
        checkHealth();
      }
    } catch {
      setFalSaveStatus("Lỗi kết nối");
    }
  };

  const checkHealth = async () => {
    setHealthLoading(true);
    try {
      const h = await getPipelineHealth();
      setHealth(h);
    } catch {
      setHealth({
        healthy: false,
        checks: [{ service: "server", configured: false, healthy: false, message: "Không kết nối được backend" }],
      });
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Load previously-completed videos from the backend so the "Đã xử lý" tab
  // survives page reloads (the pipeline store is in-memory only).
  useEffect(() => {
    let mounted = true;
    listVideos()
      .then((videos) => {
        if (mounted) setHistoryVideos(videos);
      })
      .catch(() => {
        // ignore — no history available
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Khôi phục danh sách pipeline đã lưu khi F5 trang (running/queued → error)
  useEffect(() => {
    fetch("/api/pipelines")
      .then((r) => r.json())
      .then((d) => {
        if (d.pipelines?.length) {
          const restored = d.pipelines.map((p: Pipeline) =>
            p.status === "running" || p.status === "queued"
              ? {
                  ...p,
                  status: "error" as const,
                  stage: "error" as const,
                  error: p.error || "Đã bị gián đoạn do tải lại trang",
                }
              : p,
          );
          usePipelineStore.getState().hydrate(restored);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    if (dubEngine === "capcut") {
      setVoicesLoading(true);
      getCapCutVoices("vi-VN")
        .then((vs) => {
          if (mounted) {
            setCapcutVoices(vs);
            setDubVoice((v) => (vs.some((x) => x.voice_type === v) ? v : vs[0]?.voice_type ?? v));
          }
        })
        .catch(() => {
          if (mounted) setCapcutVoices([]);
        })
        .finally(() => {
          if (mounted) setVoicesLoading(false);
        });
    } else {
      setVoicesLoading(true);
      getGoogleTtsVoices("vi-VN")
        .then((vs) => {
          if (mounted) {
            setGoogleVoices(vs);
            setDubVoice((v) => (vs.some((x) => x.voice_type === v) ? v : vs[0]?.voice_type ?? v));
          }
        })
        .catch(() => {
          if (mounted) setGoogleVoices([]);
        })
        .finally(() => {
          if (mounted) setVoicesLoading(false);
        });
    }
    return () => {
      mounted = false;
    };
  }, [dubEngine]);

  const switchDubEngine = async (engine: "google" | "capcut") => {
    setDubEngine(engine);
    setPreviewUrl(null);
    setPreviewError(false);
    if (engine === "google") {
      if (googleVoices.length > 0) {
        setDubVoice((v) => (googleVoices.some((x) => x.voice_type === v) ? v : googleVoices[0]?.voice_type ?? "vi-VN-Standard-B"));
      } else {
        // Google voices differ from CapCut (BV/AV*) — reset so a CapCut voice is
        // never sent to Google TTS. Effect below will populate googleVoices.
        setDubVoice("vi-VN-Standard-B");
      }
    } else if (capcutVoices.length === 0) {
      setVoicesLoading(true);
      try {
        const vs = await getCapCutVoices("vi-VN");
        setCapcutVoices(vs);
        if (vs.length > 0) setDubVoice(vs[0].voice_type);
      } catch {
        setCapcutVoices([]);
      } finally {
        setVoicesLoading(false);
      }
    }
  };

  const handlePreviewVoice = async () => {
    if (!dubVoice || previewing) return;
    setPreviewing(true);
    setPreviewUrl(null);
    setPreviewError(false);
    try {
      const blob =
        dubEngine === "google"
          ? await googleTtsPreview(dubVoice)
          : await capCutPreview(dubVoice);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch {
      setPreviewUrl(null);
      setPreviewError(true);
    } finally {
      setPreviewing(false);
    }
  };

  const refreshVoices = async () => {
    setVoicesLoading(true);
    try {
      if (dubEngine === "google") {
        const vs = await getGoogleTtsVoices("vi-VN");
        setGoogleVoices(vs);
        if (vs.length > 0) setDubVoice(vs[0].voice_type);
      } else {
        const vs = await getCapCutVoices("vi-VN");
        setCapcutVoices(vs);
        if (vs.length > 0) setDubVoice(vs[0].voice_type);
      }
    } catch {
      if (dubEngine === "google") setGoogleVoices([]);
      else setCapcutVoices([]);
    } finally {
      setVoicesLoading(false);
    }
  };

  const selected =
    pipelines.find((p) => p.id === selectedId) ??
    pipelines[pipelines.length - 1] ??
    null;

  const handleAdd = () => {
    const v = url.trim();
    if (!v) return;
    if (!health?.healthy) {
      checkHealth();
      return;
    }
    const id = addPipeline(v, regionMode, {
      engine: dubEngine,
      voice: dubVoice,
      muteOriginal,
      originalGainDb,
    }, autoFitSubs, watermarkOn, autoUploadYoutube);
    setUrl("");
    setSelectedId(id);
    setTab("detail");
  };

  const activeCount = pipelines.filter((p) => p.status === "queued" || p.status === "running").length;
  const activePipelines = pipelines.filter((p) => p.status === "queued" || p.status === "running");
  const donePipelines = pipelines.filter((p) => p.status === "done" || p.status === "error");
  // Persisted completed videos from the backend (survive page reloads), minus
  // any that are already represented by an in-memory pipeline (matched by videoId).
  const sessionVideoIds = new Set(pipelines.map((p) => p.videoId).filter(Boolean));
  const historyVideosDone = historyVideos.filter(
    (v) => v.status === "done" && !sessionVideoIds.has(v.video_id)
  );
  const finishedCount = donePipelines.length + historyVideosDone.length;
  const hasFinished = finishedCount > 0;
  const falCheck = health?.checks?.find((c) => c.service === "fal");

  const handleClearTemp = async () => {
    setConfirmingClear(false);
    try {
      await clearTempData();
    } catch {
      // ignore
    }
    for (const p of pipelines) {
      usePipelineStore.getState().cancelPipeline(p.id);
    }
  };

  return (
    <>
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
          <button
            onClick={() => setConfirmingClear(true)}
            className="px-4 py-2 rounded-full text-[12px] font-medium bg-red-500/10 ring-1 ring-red-500/20 text-red-600 hover:bg-red-500/20 transition-all duration-300 active:scale-[0.97] cursor-pointer"
          >
            Dọn sạch dữ liệu tạm
          </button>
          <Link
            href="/settings"
            title="Cài đặt (API key, TTS, style phụ đề)"
            className="w-9 h-9 rounded-full bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-all duration-300 active:scale-[0.95] flex items-center justify-center cursor-pointer"
          >
            <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
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
            {healthLoading ? (
              <div className="flex items-center gap-2 mb-4 rounded-xl bg-black/[0.03] ring-1 ring-black/[0.05] px-4 py-3">
                <IconSpinner className="w-4 h-4 text-blue-600" />
                <span className="text-[12px] text-ink-muted">Đang kiểm tra Gemini API + engine lồng tiếng...</span>
              </div>
            ) : health && !health.healthy ? (
              <div className="mb-4 rounded-xl bg-amber-500/10 ring-1 ring-amber-500/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[12px] font-medium text-amber-800">
                    ⚠️ Cần cấu hình trước khi xử lý: Gemini API phải hoạt động và cần ít nhất 1 engine lồng tiếng (Google TTS hoặc CapCut service).
                  </p>
                  <button
                    onClick={checkHealth}
                    className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-amber-600/15 text-amber-800 ring-1 ring-amber-500/20 hover:bg-amber-600/25 transition-colors cursor-pointer"
                  >
                    Kiểm tra lại
                  </button>
                </div>
                <ul className="mt-2 space-y-1">
                  {health.checks.map((c) => (
                    <li key={c.service} className="flex items-start gap-2 text-[12px] text-amber-800/80">
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.healthy ? "bg-emerald-500" : "bg-amber-500"}`} />
                      <span className="font-mono">{c.service}:</span>
                      <span className="flex-1">{c.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : health?.healthy ? (
              <div className="flex items-center gap-2 mb-4 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/20 px-4 py-2.5">
                <IconCheck className="w-4 h-4 text-emerald-600" />
                <span className="text-[12px] text-emerald-800">Gemini API đã sẵn sàng. Engine lồng tiếng: {health.dub_engines?.google ? "Google TTS" : ""}{health.dub_engines?.google && health.dub_engines?.capcut ? " + " : ""}{health.dub_engines?.capcut ? "CapCut" : ""}{!health.dub_engines?.google && !health.dub_engines?.capcut ? "chưa sẵn sàng" : " sẵn sàng"}.</span>
                <button
                  onClick={checkHealth}
                  className="ml-auto px-2.5 py-1 rounded-full text-[10px] font-medium bg-emerald-600/15 text-emerald-800 ring-1 ring-emerald-500/20 hover:bg-emerald-600/25 transition-colors cursor-pointer"
                >
                  Kiểm tra lại
                </button>
              </div>
            ) : null}
            {falCheck && (
              <div className="flex items-center gap-2 mb-4 rounded-xl bg-black/[0.03] ring-1 ring-black/[0.05] px-4 py-2">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${falCheck.healthy ? "bg-emerald-500" : "bg-amber-500"}`} />
                <span className="text-[12px] text-ink-muted">
                  <span className="font-mono">fal.ai:</span>{" "}
                  {falCheck.message}
                </span>
                <button
                  onClick={openFalModal}
                  className="ml-auto px-2.5 py-1 rounded-full text-[10px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer"
                >
                  Cập nhật
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                ref={urlInputRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                disabled={!health?.healthy}
                placeholder={
                  healthLoading
                    ? "Đang kiểm tra kết nối..."
                    : health?.healthy
                    ? "Dán toàn bộ nội dung chia sẻ (hoặc link https://v.douyin.com/...)"
                    : "Vào Settings (⚙️) nhập Gemini API key (và Google TTS Service Account nếu chọn Google)"
                }
                className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                onClick={handleAdd}
                disabled={!url.trim() || !health?.healthy}
                className="btn-island-primary group text-sm !px-5 !py-2.5 flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="tracking-tight">Bắt đầu</span>
              </button>
            </div>
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                Vùng quét phụ đề:
              </span>
              <div className={`flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] `}>
                <button
                  onClick={() => setRegionMode("auto")}
                  className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                    regionMode === "auto"
                      ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                      : "text-ink-light hover:text-ink"
                  }`}
                >
                  Tự động (vùng mặc định)
                </button>
                <button
                  onClick={() => setRegionMode("manual")}
                  className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                    regionMode === "manual"
                      ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                      : "text-ink-light hover:text-ink"
                  }`}
                >
                  Chọn vùng thủ công
                </button>
              </div>
              <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                {regionMode === "auto"
                  ? "Hệ thống tự dùng tọa độ mặc định, không cần kéo vùng trên video."
                  : "Pipeline sẽ dừng lại ở bước Chọn vùng quét để bạn kéo vùng lấy phụ đề."}
              </p>
            </div>
            <div className="mt-4 border-t border-black/[0.05] pt-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  Lồng tiếng:
                </span>
                <div className={`flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] `}>
                  <button
                    onClick={() => switchDubEngine("google")}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                      dubEngine === "google"
                        ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    Google TTS
                  </button>
                  <button
                    onClick={() => switchDubEngine("capcut")}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                      dubEngine === "capcut"
                        ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    CapCut
                  </button>
                </div>
                {(dubEngine === "capcut" ? (capcutVoices.length > 0 && !voicesLoading) : (googleVoices.length > 0 && !voicesLoading)) && (
                  <>
                    <select
                      value={dubVoice}
                      onChange={(e) => {
                        setDubVoice(e.target.value);
                        setPreviewUrl(null);
                        setPreviewError(false);
                      }}
                      className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {(dubEngine === "capcut" ? capcutVoices : googleVoices).map((v) => (
                        <option key={v.voice_type} value={v.voice_type}>
                          {v.display_name} ({v.voice_type})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handlePreviewVoice}
                      disabled={previewing}
                      className="px-4 py-2 rounded-full text-[11px] font-medium bg-blue-500/10 ring-1 ring-blue-500/20 text-blue-700 hover:bg-blue-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {previewing ? "Đang tạo audio..." : "Nghe thử"}
                    </button>
                    {previewUrl && (
                      <audio key={previewUrl} src={previewUrl} controls autoPlay className="h-8" />
                    )}
                    {previewError && (
                      <span className="text-[11px] text-red-600 flex items-center gap-1.5">
                        Giọng không khả dụng
                      </span>
                    )}
                  </>
                )}
                {voicesLoading && (
                  <span className="text-[11px] text-ink-light flex items-center gap-1.5">
                    <IconSpinner className="w-3 h-3" /> Đang tải giọng {dubEngine === "google" ? "Google TTS" : "CapCut"}...
                  </span>
                )}
                {!voicesLoading && (dubEngine === "capcut" ? capcutVoices.length === 0 : googleVoices.length === 0) && (
                  <span className="text-[11px] text-amber-700 flex items-center gap-2">
                    Không tải được danh sách giọng {dubEngine === "google" ? "Google TTS (kiểm tra Service Account trong Settings ⚙️)" : "CapCut (service :8100)"}.
                    <button
                      onClick={refreshVoices}
                      className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-amber-600/15 text-amber-800 ring-1 ring-amber-500/20 hover:bg-amber-600/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Thử lại
                    </button>
                  </span>
                )}
              </div>
              <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                {dubEngine === "google"
                  ? "Dùng Google Cloud TTS (cần Service Account trong Settings ⚙️). Chọn giọng và bấm Nghe thử để nghe trước."
                  : "Dùng giọng CapCut (yêu cầu service capcut-tts-api chạy ở port 8100)."}
              </p>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  Voice gốc:
                </span>
                <div className={`flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] `}>
                  <button
                    onClick={() => setMuteOriginal(true)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                      muteOriginal
                        ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    Tắt (tách bằng Demucs)
                  </button>
                  <button
                    onClick={() => setMuteOriginal(false)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                      !muteOriginal
                        ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    Giữ lại (giảm âm lượng)
                  </button>
                </div>
                {!muteOriginal && (
                  <label className="flex items-center gap-2.5">
                    <span className="text-[11px] text-ink-muted">Giảm giọng gốc:</span>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      step={1}
                      value={originalGainDb}
                      onChange={(e) => setOriginalGainDb(Number(e.target.value))}
                      className="w-40 accent-blue-600 disabled:opacity-40"
                    />
                    <span className="text-[12px] font-mono tabular-nums text-blue-600 font-semibold w-10">
                      -{originalGainDb} dB
                    </span>
                  </label>
                )}
              </div>
              {!muteOriginal && (
                <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                  {originalGainDb === 0
                    ? "Giữ nguyên âm lượng giọng gốc (0 dB)."
                    : `Giọng nói và nhạc nền gốc sẽ giảm ${originalGainDb} dB để giọng đọc Việt nổi bật hơn.`}
                </p>
              )}

              <div className="mt-4 border-t border-black/[0.05] pt-4 flex items-center gap-3 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  Căn chỉnh phụ đề:
                </span>
                <div className={`flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] `}>
                  <button
                    onClick={() => setAutoFitSubs(true)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                      autoFitSubs
                        ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    Tự động khớp vị trí sub gốc
                  </button>
                  <button
                    onClick={() => setAutoFitSubs(false)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-all active:scale-[0.97] cursor-pointer ${
                      !autoFitSubs
                        ? "bg-blue-600 text-white shadow-sm ring-1 ring-blue-600"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    Tự chỉnh kích thước & vị trí
                  </button>
                </div>
                <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                  {autoFitSubs
                    ? "Tự động tính kích thước chữ và vị trí để phụ đề mới nằm đúng chỗ phụ đề gốc trên video."
                    : "Thêm bước xem trước trong pipeline để bạn chỉnh cỡ chữ và vị trí phụ đề trước khi nhúng."}
                </p>
              </div>

              <div className="mt-4 border-t border-black/[0.05] pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                      Logo + Watermark
                    </p>
                    <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                      Logo nhỏ ở góc trên trái + chữ chạy quanh viền clip (dùng logo & nội dung trong Settings ⚙️).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setWatermarkOn(!watermarkOn)}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                      watermarkOn ? "bg-blue-600" : "bg-black/10"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                        watermarkOn ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="mt-4 border-t border-black/[0.05] pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                      Tự động up YouTube
                    </p>
                    <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                      Sau khi xong, đăng video lên YouTube kèm meta (tiêu đề/mô tả/tags) + thumbnail.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAutoUploadYoutube(!autoUploadYoutube)}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                      autoUploadYoutube ? "bg-blue-600" : "bg-black/10"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                        autoUploadYoutube ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      {/* Tabs */}
      <AnimatedBlock delay={200}>
        <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] ring-1 ring-black/[0.05] w-max">
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
              onClick={() => setTab("active")}
              className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
                tab === "active"
                  ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                  : "text-ink-light hover:text-ink"
              }`}
            >
              Đang xử lý
              {activeCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-[10px] text-blue-600">{activeCount}</span>
              )}
            </button>
            <button
              onClick={() => setTab("done")}
              className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
                tab === "done"
                  ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]"
                  : "text-ink-light hover:text-ink"
              }`}
            >
              Đã xử lý
              {finishedCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-[10px] text-emerald-600">{finishedCount}</span>
              )}
            </button>
          </div>
        </div>
      </AnimatedBlock>

      {tab === "active" ? (
        <AnimatedBlock delay={250}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-5 sm:p-6">
              {activePipelines.length === 0 ? (
                <p className="text-sm text-ink-muted text-center py-8">Không có video nào đang xử lý.</p>
              ) : (
                <div className="space-y-2">
                  {activePipelines.map((p) => (
                    <PipelineRow
                      key={p.id}
                      p={p}
                      now={now}
                      onOpen={() => {
                        setSelectedId(p.id);
                        setTab("detail");
                      }}
                      onRemove={() => {
                        removePipeline(p.id);
                        if (selectedId === p.id) setSelectedId(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </AnimatedBlock>
      ) : tab === "done" ? (
        <AnimatedBlock delay={250}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-5 sm:p-6">
              {donePipelines.length === 0 && historyVideosDone.length === 0 ? (
                <p className="text-sm text-ink-muted text-center py-8">Chưa có video nào hoàn tất.</p>
              ) : (
                <div className="space-y-2">
                  {donePipelines.map((p) => (
                    <PipelineRow
                      key={p.id}
                      p={p}
                      now={now}
                      onOpen={() => {
                        setSelectedId(p.id);
                        setTab("detail");
                      }}
                      onRemove={() => {
                        removePipeline(p.id);
                        if (selectedId === p.id) setSelectedId(null);
                      }}
                    />
                  ))}
                  {historyVideosDone.map((v) => (
                    <HistoryRow
                      key={v.video_id}
                      v={v}
                      onOpen={() => {
                        const id = importDone({
                          videoId: v.video_id,
                          title: v.filename || v.video_id,
                          hasDubbed: v.has_dubbed ?? false,
                        });
                        setSelectedId(id);
                        setTab("detail");
                      }}
                      onDelete={async () => {
                        try {
                          await deleteVideo(v.video_id);
                        } catch {
                          // ignore
                        }
                        setHistoryVideos((prev) => prev.filter((x) => x.video_id !== v.video_id));
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </AnimatedBlock>
      ) : selected ? (
        <AnimatedBlock delay={250}>
          <DetailView
            pipeline={selected}
            now={now}
            onRemove={() => removePipeline(selected.id)}
            onStartNext={focusNewVideo}
          />
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

    {confirmingClear && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
        onClick={() => setConfirmingClear(false)}
      >
        <div
          className="double-bezel w-full max-w-md"
          onClick={(e) => e.stopPropagation()}
          style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
        >
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-sm font-semibold text-ink mb-1">Dọn sạch dữ liệu tạm?</p>
            <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
              Hành động này sẽ xóa toàn bộ dữ liệu trong thư mục temp
              (video, khung hình, phụ đề, file lồng tiếng, file merge, dự án...)
              và hủy mọi quá trình đang chạy. Cấu hình (Gemini key, TTS) được giữ nguyên.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmingClear(false)}
                className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
              >
                Không
              </button>
              <button
                onClick={handleClearTemp}
                className="px-4 py-2 rounded-full text-[12px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer"
              >
                Xác nhận dọn sạch
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {showFalModal && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
        onClick={() => setShowFalModal(false)}
      >
        <div
          className="double-bezel w-full max-w-md"
          onClick={(e) => e.stopPropagation()}
          style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
        >
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-sm font-semibold text-ink mb-1">Cập nhật fal.ai Key</p>
            <p className="text-[12px] text-ink-muted leading-relaxed mb-4">
              Key dùng để chỉnh thumbnail (image-to-image). Nếu không có,
              pipeline sẽ bỏ qua bước cập nhật thumbnail.
            </p>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1 block">
              fal.ai Key
            </label>
            <input
              type="password"
              value={falKeyInput}
              onChange={(e) => setFalKeyInput(e.target.value)}
              placeholder="Nhập FAL key..."
              className="w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="text-[9px] text-ink-light mt-1">
              Lấy tại{" "}
              <a
                href="https://fal.ai/dashboard/keys"
                target="_blank"
                className="text-blue-500 underline"
              >
                fal.ai/dashboard/keys
              </a>
            </p>
            <div className="flex items-center justify-between mt-4">
              <span
                className={`text-[11px] ${
                  falSaveStatus.includes("Đã lưu")
                    ? "text-emerald-600"
                    : falSaveStatus.includes("Lỗi")
                      ? "text-red-500"
                      : "text-ink-light"
                }`}
              >
                {falSaveStatus || ""}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowFalModal(false)}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
                >
                  Đóng
                </button>
                <button
                  onClick={saveFalKey}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                >
                  Lưu
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function PipelineRow({ p, now, onOpen, onRemove }: { p: Pipeline; now: number; onOpen: () => void; onRemove: () => void }) {
  const meta = STATUS_META[p.status] ?? STATUS_META.queued;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const stepLabel = (() => {
    if (p.status !== "running") return null;
    const idx = STEP_STAGE[p.stage];
    return idx != null ? `Bước ${idx + 1}/12 · ${STEPS[idx]?.label ?? p.stage}` : p.stage;
  })();

  return (
    <div
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] transition-colors cursor-pointer"
    >
      <div className="w-[104px] h-[58px] rounded-lg overflow-hidden bg-black flex-shrink-0 ring-1 ring-black/[0.08]">
        {p.videoId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={getFrameUrl(p.videoId)} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-light">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="14" height="14" rx="2" />
              <path d="M16 9l6-3v12l-6-3" />
            </svg>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ${meta.cls}`}>
            {meta.label}
          </span>
          {p.status === "queued" && (
            <span className="text-[10px] text-amber-700/80 flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Đang chờ
            </span>
          )}
          {p.status === "running" && (
            <span className="text-[10px] text-blue-700/80 flex items-center gap-1">
              <IconSpinner className="w-3 h-3" />
              Đang chạy
            </span>
          )}
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
            <span className="text-[10px] font-mono text-ink-light tabular-nums">
              {p.status === "done" ? 100 : p.progress}%
            </span>
          )}
        </div>
        {stepLabel && (
          <p className="text-[11px] text-blue-600/80 mt-1 truncate">
            {stepLabel} · {p.progress}%
          </p>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirmingRemove(true);
        }}
        title={p.status === "running" || p.status === "queued" ? "Hủy xử lý" : "Xoá"}
        className="w-7 h-7 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-500/20 transition-colors cursor-pointer flex-shrink-0"
      >
        {p.status === "running" || p.status === "queued" ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        )}
      </button>

      {confirmingRemove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
          onClick={() => setConfirmingRemove(false)}
        >
          <div
            className="double-bezel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              {p.status === "running" || p.status === "queued" ? (
                <>
                  <p className="text-sm font-semibold text-ink mb-1">Hủy xử lý?</p>
                  <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                    Nếu hủy sẽ mất hết tiến độ hiện tại và xóa toàn bộ file tạm của video này
                    (video, khung hình, phụ đề). Quá trình sẽ phải làm lại từ đầu.
                  </p>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setConfirmingRemove(false)}
                      className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
                    >
                      Không, tiếp tục
                    </button>
                    <button
                      onClick={() => {
                        setConfirmingRemove(false);
                        onRemove();
                      }}
                      className="px-4 py-2 rounded-full text-[12px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer"
                    >
                      Xác nhận hủy
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-ink mb-1">Xoá job này?</p>
                  <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                    Sẽ xóa job khỏi danh sách xử lý.
                  </p>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setConfirmingRemove(false)}
                      className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
                    >
                      Không, giữ lại
                    </button>
                    <button
                      onClick={() => {
                        setConfirmingRemove(false);
                        onRemove();
                      }}
                      className="px-4 py-2 rounded-full text-[12px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer"
                    >
                      Xoá
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ v, onOpen, onDelete }: { v: VideoMeta; onOpen: () => void; onDelete: () => void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <div
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] transition-colors cursor-pointer"
    >
      <div className="w-[104px] h-[58px] rounded-lg overflow-hidden bg-black flex-shrink-0 ring-1 ring-black/[0.08]">
        {v.has_video ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={getFrameUrl(v.video_id)} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-light">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="14" height="14" rx="2" />
              <path d="M16 9l6-3v12l-6-3" />
            </svg>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-emerald-500" />
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 bg-emerald-500/10 text-emerald-700 ring-emerald-500/20">
            Xong
          </span>
          <span className="text-[10px] font-mono text-ink-light tabular-nums">
            {v.entries} phụ đề
          </span>
        </div>
        <p className="text-[12px] font-medium text-ink truncate">
          {v.filename || v.video_id}
        </p>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 h-1 rounded-full bg-emerald-500/80" />
          <span className="text-[10px] font-mono text-ink-light tabular-nums">100%</span>
        </div>
      </div>
      <span className="text-[10px] font-mono text-ink-light tabular-nums flex-shrink-0">
        {new Date(v.created_at).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirmingDelete(true);
        }}
        title="Xoá toàn bộ video"
        className="w-7 h-7 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-500/20 transition-colors cursor-pointer flex-shrink-0"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>

      {confirmingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
          onClick={() => setConfirmingDelete(false)}
        >
          <div
            className="double-bezel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <p className="text-sm font-semibold text-ink mb-1">Xoá toàn bộ video?</p>
              <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                Sẽ xóa toàn bộ file của video này (video gốc, phụ đề, video lồng tiếng,
                phụ đề cứng và file đã gộp). Không thể khôi phục.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingDelete(false)}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
                >
                  Không, giữ lại
                </button>
                <button
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer"
                >
                  Xoá toàn bộ
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailView({ pipeline: p, now, onRemove, onStartNext }: { pipeline: Pipeline; now: number; onRemove: () => void; onStartNext?: () => void }) {
  const activeStep = p.status === "done" ? STEPS.length : STEP_STAGE[p.stage] ?? 0;
  const rerunPipeline = usePipelineStore((s) => s.rerunPipeline);
  const confirmRegion = usePipelineStore((s) => s.confirmRegion);
  const confirmSubtitleStyle = usePipelineStore((s) => s.confirmSubtitleStyle);
  const cancelPipeline = usePipelineStore((s) => s.cancelPipeline);
  const logRef = useRef<HTMLDivElement>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.logs.length]);

  const canRerun = p.status === "done" || p.status === "error";

  const previewUrl = p.resultUrl.replace("/api/download/", "/api/preview/");

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <p className="text-sm font-semibold text-ink truncate">{p.title || "Đang phân tích..."}</p>
              {p.status === "queued" && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 ring-1 ring-amber-500/25 text-amber-700 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  Đang chờ trong hàng đợi
                </span>
              )}
              {p.status === "running" && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 ring-1 ring-blue-500/25 text-blue-700 flex items-center gap-1">
                  <IconSpinner className="w-3 h-3" />
                  Đang xử lý
                </span>
              )}
            </div>
            <p className="text-[11px] text-ink-light font-mono truncate">{p.url}</p>
          </div>
          <div className="flex items-center gap-2">
            {(p.status === "running" || p.status === "queued") && (
              <button
                onClick={() => setConfirmingCancel(true)}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-red-500/10 ring-1 ring-red-500/20 text-red-600 hover:bg-red-500/20 transition-colors cursor-pointer"
              >
                Hủy xử lý
              </button>
            )}
            <button
              onClick={onRemove}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
            >
              Xoá
            </button>
          </div>
        </div>

        {p.stage === "region" && p.videoId && (
          <div className="mb-5">
            <RegionSelector videoId={p.videoId} onConfirmed={(r) => confirmRegion(p.id, r)} />
          </div>
        )}

        {p.stage === "subtitle_preview" && p.videoId && (
          <div className="mb-5">
            <SubtitlePreview
              videoId={p.videoId}
              region={p.region ?? DEFAULT_REGION}
              onConfirmed={(s) => confirmSubtitleStyle(p.id, s)}
            />
          </div>
        )}

        {p.status !== "queued" && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
                Tổng tiến độ
              </span>
              <span className="text-[12px] font-mono tabular-nums text-blue-600 font-semibold">
                {p.status === "done" ? 100 : p.status === "error" ? 0 : p.progress}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-black/[0.06] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  p.status === "error" ? "bg-red-500" : p.status === "done" ? "bg-emerald-500" : "bg-blue-500"
                }`}
                style={{ width: `${p.status === "done" ? 100 : p.status === "error" ? 0 : Math.max(p.progress, 2)}%` }}
              />
            </div>
          </div>
        )}

        <div className="space-y-2">
          {STEPS.map((s, i) => {
            const done = i < activeStep || p.status === "done";
            const active = i === activeStep && p.status !== "done";
            const start = p.stepStarts[i];
            const end = p.stepEnds[i];
            const skipped = p.stepSkipped[i];
            const stepPct = p.stepProgress[i] ?? (done ? 100 : 0);
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
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-[13px] font-medium ${done || active ? "text-ink" : "text-ink-light"}`}>
                      {s.label}
                    </p>
                    <span
                      className={`text-[11px] font-mono tabular-nums flex-shrink-0 ${
                        skipped ? "text-ink-light" : done ? "text-emerald-600" : active ? "text-blue-600" : "text-ink-light"
                      }`}
                    >
                      {skipped ? "—" : `${stepPct}%`}
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-light">{stepDetail(p)}</p>
                  {(active || done) && !skipped && (
                    <div className="mt-1.5 h-1 rounded-full bg-black/[0.06] overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          done ? "bg-emerald-500" : "bg-blue-500"
                        }`}
                        style={{ width: `${stepPct}%` }}
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {active && (
                    <span className="text-[11px] font-mono text-ink-light tabular-nums">{stepPct}%</span>
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
                  {canRerun && (
                    <button
                      onClick={() => rerunPipeline(p.id, i)}
                      title={`Chạy lại từ "${s.label}"`}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                      Chạy lại
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {p.logs.length > 0 && (
          <div className="mt-4 rounded-xl bg-black/[0.02] ring-1 ring-black/[0.05] overflow-hidden">
            <div className="px-4 py-2 border-b border-black/[0.05] bg-white/40 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-ink-muted">
                Nhật ký chi tiết · {p.logs.length} dòng
              </span>
              <span className="text-[10px] font-mono text-ink-light tabular-nums">
                Thời gian:{" "}
                {p.startedAt
                  ? fmtElapsed((p.status === "done" || p.status === "error" ? p.finishedAt ?? now : now) - p.startedAt)
                  : "—"}
              </span>
            </div>
            <div ref={logRef} className="max-h-[240px] overflow-y-auto p-3 space-y-1">
              {p.logs.map((l, i) => {
                const msg = typeof l === "string" ? l : l.message;
                const level = typeof l === "string" ? "info" : l.level;
                const ts = typeof l === "string" ? null : l.ts;
                const color =
                  level === "error"
                    ? "text-red-600"
                    : level === "success"
                    ? "text-emerald-600"
                    : level === "warning"
                    ? "text-amber-600"
                    : "text-ink-muted";
                return (
                  <div key={i} className="flex items-start gap-2">
                    {ts != null && (
                      <span className="text-[10px] font-mono text-ink-light tabular-nums flex-shrink-0 mt-0.5">
                        {new Date(ts * 1000).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    )}
                    <span className={`text-[12px] font-mono leading-snug ${color}`}>{msg}</span>
                  </div>
                );
              })}
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
                <span className="tracking-tight">{p.dubbedUrl ? "Tải video (phụ đề + lồng tiếng)" : "Tải video (phụ đề)"}</span>
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
              {p.updatedThumbnailUrl && (
                <button
                  onClick={() => navigator.clipboard.writeText(p.updatedThumbnailUrl || "")}
                  title="Sao chép URL ảnh thumbnail"
                  className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
                >
                  Sao chép URL ảnh
                </button>
              )}
            </div>

            <iframe
              src={previewUrl}
              title="Result video"
              className="w-full aspect-video rounded-xl ring-1 ring-black/[0.06] bg-black"
              allow="autoplay; fullscreen"
              allowFullScreen
            />

            {onStartNext && (
              <div className="mt-5 pt-4 border-t border-black/[0.05] flex items-center justify-between gap-4 flex-wrap">
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  Video này đã xử lý xong. Dán link tiếp theo để chạy job mới ngay trong trang này.
                </p>
                <button
                  onClick={onStartNext}
                  className="btn-island-primary group text-sm !px-5 !py-2.5 flex-shrink-0"
                >
                  <span className="tracking-tight">Xử lý video tiếp theo</span>
                  <span className="btn-island-icon">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {confirmingCancel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
          onClick={() => setConfirmingCancel(false)}
        >
          <div
            className="double-bezel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <p className="text-sm font-semibold text-ink mb-1">Hủy xử lý?</p>
              <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                Nếu hủy sẽ mất hết tiến độ hiện tại và xóa toàn bộ file tạm của video này
                (video, khung hình, phụ đề). Quá trình sẽ phải làm lại từ đầu.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingCancel(false)}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
                >
                  Không, tiếp tục
                </button>
                <button
                  onClick={() => {
                    setConfirmingCancel(false);
                    cancelPipeline(p.id);
                  }}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer"
                >
                  Xác nhận hủy & xóa file
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
