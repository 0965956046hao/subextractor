"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatedBlock } from "@/lib/animation";
import PageHeader from "@/components/layout/PageHeader";
import { useI18n, type Dict } from "@/lib/i18n";
import {
  getPipelineHealth,
  getProfilesCheck,
  clearTempData,
  getCapCutVoices,
  capCutPreview,
  getGoogleTtsVoices,
  googleTtsPreview,
  getFrameUrl,
  getVideoUrl,
  listVideos,
  deleteVideo,
  getAppConfig,
  uploadVideo,
  getDownloadUrl,
  getContextImages,
  type ContextImages,
  getDubbedDownloadUrl,
  listYoutubeChannels,
  setActiveWatermarkPreset,
  chatgptLogin,
  type PipelineHealth,
  type HealthCheckResult,
  type CapCutVoice,
  type VideoMeta,
  type WatermarkPreset,
  type Region,
  type YouTubeChannelInfo,
} from "@/lib/api";
import RegionSelector from "@/components/RegionSelector";
import WatermarkRegionSelector from "@/components/WatermarkRegionSelector";
import SubtitlePreview from "@/components/SubtitlePreview";
import TimelineCheckModal from "@/components/TimelineCheckModal";
import VoiceCheckModal from "@/components/VoiceCheckModal";
import PreviewModal from "@/components/PreviewModal";
import {
  usePipelineStore,
  STEPS,
  STEP_STAGE,
  DEFAULT_REGION,
  fmtElapsed,
  type Pipeline,
} from "@/stores/pipeline-store";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** Guard: snapshot-hydrate chỉ chạy 1 lần mỗi trang tải thật, không chạy lại
 *  khi điều hướng nội bộ làm AutoPipeline mount/unmount nhiều lần. */
let restoredSnapshotOnce = false;

function makeT(
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string,
): TFunc {
  return (key, vars) => t(key as keyof Dict, vars);
}

const STEP_LABEL_KEYS = [
  "pipeline.step.label.resolve",
  "pipeline.step.label.merge",
  "pipeline.step.label.region",
  "pipeline.step.label.style",
  "pipeline.step.label.ocr",
  "pipeline.step.label.watermark",
  "pipeline.step.label.context",
  "pipeline.step.label.translate",
  "pipeline.step.label.dub",
  "pipeline.step.label.mux",
  "pipeline.step.label.meta",
  "pipeline.step.label.thumbnail",
  "pipeline.step.label.youtube",
];

const STEP_DETAIL_KEYS = [
  "pipeline.step.detail.resolve",
  "pipeline.step.detail.merge",
  "pipeline.step.detail.region",
  "pipeline.step.detail.style",
  "pipeline.step.detail.ocr",
  "pipeline.step.detail.watermark",
  "pipeline.step.detail.context",
  "pipeline.step.detail.translate",
  "pipeline.step.detail.dub",
  "pipeline.step.detail.mux",
  "pipeline.step.detail.meta",
  "pipeline.step.detail.thumbnail",
  "pipeline.step.detail.youtube",
];

function localizedLangLabel(code: string, tr: TFunc): string {
  if (code === "zh" || code === "ch") return tr("pipeline.langZh");
  if (code === "en") return tr("pipeline.langEn");
  if (code === "vi") return tr("pipeline.langVi");
  return code || "—";
}

function IconSpinner({ className = "w-4 h-4" }) {
  return (
    <svg
      className={`${className} animate-spin`}
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
  );
}

function IconCheck({ className = "w-4 h-4" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

const STATUS_META: Record<
  string,
  { labelKey: string; cls: string; dot: string }
> = {
  queued: {
    labelKey: "pipeline.status.queued",
    cls: "bg-warn-muted text-warn ring-warn/20",
    dot: "bg-warn",
  },
  running: {
    labelKey: "pipeline.status.running",
    cls: "bg-accent-muted text-accent ring-accent/20",
    dot: "bg-accent animate-pulse",
  },
  done: {
    labelKey: "pipeline.status.done",
    cls: "bg-success-muted text-success ring-success/20",
    dot: "bg-success",
  },
  error: {
    labelKey: "pipeline.status.error",
    cls: "bg-danger-muted text-danger ring-danger/20",
    dot: "bg-danger",
  },
};

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function stepDetail(p: Pipeline, tr: TFunc): string {
  const idx =
    p.status === "error" && p.failedStep != null
      ? p.failedStep
      : (STEP_STAGE[p.stage] ?? -1);
  switch (idx) {
    case 0:
      return tr("pipeline.stepDetail.download", {
        lang: localizedLangLabel(p.srcLang || "zh", tr),
      });
    case 1:
      return tr("pipeline.stepDetail.merge");
    case 2:
      return p.region
        ? tr("pipeline.stepDetail.regionSelected", {
            x1: p.region.x1,
            x2: p.region.x2,
            y1: p.region.y1,
            y2: p.region.y2,
          })
        : tr("pipeline.stepDetail.regionPending");
    case 3:
      return p.subtitleStyle
        ? tr("pipeline.stepDetail.subtitleStyle", {
            size: p.subtitleStyle.font_size ?? 48,
            margin: p.subtitleStyle.margin_v ?? 40,
          })
        : p.autoFit
          ? tr("pipeline.stepDetail.subtitleAutoFit")
          : tr("pipeline.stepDetail.subtitlePreview");
    case 4:
      return p.ocrEngine
        ? tr("pipeline.stepDetail.ocrEngine", {
            engine: p.ocrEngine,
            lang: localizedLangLabel(p.ocrLang, tr),
          })
        : tr("pipeline.stepDetail.ocrPending");
    case 5:
      return tr("pipeline.stepDetail.context", {
        state: p.contextOn ? tr("pipeline.enabled") : tr("pipeline.disabled"),
      });
    case 6:
      return p.translateOn !== false
        ? p.srcLang
          ? tr("pipeline.stepDetail.translateFromTo", {
              from: localizedLangLabel(p.srcLang, tr),
              to: localizedLangLabel(p.translateTarget || "vi", tr),
            })
          : tr("pipeline.stepDetail.translateTo", {
              to: localizedLangLabel(p.translateTarget || "vi", tr),
            })
        : tr("pipeline.stepDetail.translateOff");
    case 7:
      return tr("pipeline.stepDetail.dub");
    case 8:
      return tr("pipeline.stepDetail.mux");
    case 9:
      return tr("pipeline.stepDetail.meta");
    case 10:
      return tr("pipeline.stepDetail.thumbnail");
    case 11:
      return tr("pipeline.stepDetail.youtube");
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

export default function AutoPipeline({ initialUrl }: { initialUrl?: string }) {
  const { t } = useI18n();
  const tr = makeT(t);
  const pipelines = usePipelineStore((s) => s.pipelines);
  const addPipeline = usePipelineStore((s) => s.addPipeline);
  const addPipelineFromUpload = usePipelineStore(
    (s) => s.addPipelineFromUpload,
  );
  const removePipeline = usePipelineStore((s) => s.removePipeline);
  const cancelPipeline = usePipelineStore((s) => s.cancelPipeline);
  const importDone = usePipelineStore((s) => s.importDone);

  const [url, setUrl] = useState(initialUrl || "");
  const [sourceType, setSourceType] = useState<"douyin" | "youtube" | "upload">(
    "douyin",
  );
  const [srcLang, setSrcLang] = useState<"zh" | "en" | "vi">("zh");
  const [translateOn, setTranslateOn] = useState(true);
  const [translateTarget, setTranslateTarget] = useState<"zh" | "en" | "vi">(
    "vi",
  );
  const [dubOn, setDubOn] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploaded, setUploaded] = useState<{
    videoId: string;
    name: string;
    size: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [regionMode, setRegionMode] = useState<"manual" | "auto">("manual");
  const [dubEngine, setDubEngine] = useState<"google" | "capcut">("capcut");
  const [voiceLang, setVoiceLang] = useState<"vi-VN" | "en-US">("vi-VN");
  const [dubVoice, setDubVoice] = useState("BV421_vivn_streaming");
  const [muteOriginal, setMuteOriginal] = useState(false);
  const [originalGainDb, setOriginalGainDb] = useState(12);
  const [multiVoice, setMultiVoice] = useState(false);
  const [autoFitSubs, setAutoFitSubs] = useState(false);
  const [watermarkOn, setWatermarkOn] = useState(true);
  const [useFalThumbnail, setUseFalThumbnail] = useState(false);
  const [useGptThumbnail, setUseGptThumbnail] = useState(false);
  const [autoUploadYoutube, setAutoUploadYoutube] = useState(false);
  const [ytChannels, setYtChannels] = useState<YouTubeChannelInfo[]>([]);
  const [ytChannel, setYtChannel] = useState("");
  const [watermarkPreset, setWatermarkPreset] = useState("");
  const [removeWmEnabled, setRemoveWmEnabled] = useState(false);
  const [removeWmRegions, setRemoveWmRegions] = useState<Region[]>([]);
  const [checkSubs, setCheckSubs] = useState(false);
  const [checkVoice, setCheckVoice] = useState(false);
  const [presets, setPresets] = useState<WatermarkPreset[]>([]);
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
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const focusNewVideo = useCallback(() => {
    urlInputRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    urlInputRef.current?.focus();
  }, []);

  const checkHealth = async () => {
    setHealthLoading(true);
    try {
      const [h, profiles] = await Promise.all([
        getPipelineHealth(),
        getProfilesCheck().catch(() => null),
      ]);
      const profileChecks: HealthCheckResult[] = [
        {
          service: "douyin",
          configured: !!profiles?.douyin.exists,
          healthy: !!profiles?.douyin.exists,
          message: profiles?.douyin.exists
            ? tr("pipeline.health.profileDouyinReady", {
                path: profiles.douyin.path,
              })
            : tr("pipeline.health.profileDouyinMissing"),
        },
        {
          service: "chatgpt",
          configured: !!profiles?.chatgpt.exists,
          healthy: !!profiles?.chatgpt.exists,
          message: profiles?.chatgpt.exists
            ? tr("pipeline.health.profileChatgptReady", {
                path: profiles.chatgpt.path,
              })
            : tr("pipeline.health.profileChatgptMissing"),
        },
      ];
      setHealth({ ...h, checks: [...h.checks, ...profileChecks] });
    } catch {
      setHealth({
        healthy: false,
        checks: [
          {
            service: "server",
            configured: false,
            healthy: false,
            message: tr("pipeline.health.backendDown"),
          },
        ],
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

  // Load watermark presets so the pipeline can pick which pair (text+logo) to use.
  useEffect(() => {
    let mounted = true;
    getAppConfig()
      .then((cfg) => {
        if (!mounted) return;
        setPresets(cfg.watermark_presets || []);
        setWatermarkPreset(cfg.active_watermark_preset || "");
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Load YouTube channels for the auto-upload selector.
  useEffect(() => {
    let mounted = true;
    listYoutubeChannels()
      .then((res) => {
        if (!mounted) return;
        setYtChannels(res.channels || []);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Load previously-completed videos from the backend so the "Đã xử lý" tab
  // survives page reloads (the pipeline store is in-memory only). Also re-attach
  // in-flight backend jobs so the "Đang xử lý" tab is visible from any device.
  useEffect(() => {
    let mounted = true;
    listVideos()
      .then((videos) => {
        if (mounted) setHistoryVideos(videos);
        const active = videos.filter(
          (v) =>
            (v.job_id &&
              (v.status === "queued" ||
                v.status === "processing" ||
                v.status === "error" ||
                v.status === "cancelled")) ||
            (v.pipeline &&
              (v.pipeline.status === "running" ||
                v.pipeline.status === "queued")),
        );
        for (const v of active) {
          usePipelineStore.getState().importActive(v);
        }
        // Resume pipelines persisted to localStorage (page reload): re-attach
        // in-flight backend jobs and re-register interactive waits.
        usePipelineStore.getState().restorePaused();
      })
      .catch(() => {
        // ignore — no history available
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Deep-link from the Pipeline library: /auto?video_id=xxx opens that video.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const vid = new URLSearchParams(window.location.search).get("video_id");
    if (!vid) return;
    const st = usePipelineStore.getState();
    const existing = st.pipelines.find((p) => p.videoId === vid);
    const meta = historyVideos.find((v) => v.video_id === vid);
    // Wait until the history list has loaded before deciding.
    if (!existing && !meta) return;
    deepLinkHandled.current = true;
    window.history.replaceState({}, "", "/auto");

    const open = (id: string | "") => {
      if (!id) return;
      setSelectedId(id);
      setTab("detail");
    };
    if (existing) {
      open(existing.id);
      return;
    }
    if (!meta) return;
    if (meta.status === "done") {
      open(
        importDone({
          videoId: meta.video_id,
          title: meta.filename || meta.video_id,
          hasDubbed: meta.has_dubbed ?? false,
        }),
      );
      return;
    }
    open(st.importActive(meta));
  }, [historyVideos, importDone]);

  // Khôi phục pipeline ĐÃ KẾT THÚC (done/error) từ snapshot backend — chỉ chạy
  // một lần mỗi lần tải trang thật (F5). Pipeline running/queued không bị đụng
  // tới: khi quay lại tab (SPA) nó vẫn sống trong store với progress realtime;
  // sau F5 thì importActive + restorePaused tự gắn lại tracker từ backend.
  useEffect(() => {
    if (restoredSnapshotOnce) return;
    restoredSnapshotOnce = true;
    fetch("/api/pipelines")
      .then((r) => r.json())
      .then((d) => {
        const finished = ((d.pipelines ?? []) as Pipeline[]).filter(
          (p) => p.status !== "running" && p.status !== "queued",
        );
        if (finished.length) {
          usePipelineStore.getState().hydrateFinished(finished);
        }
      })
      .catch(() => {
        // ignore — snapshot chỉ là lịch sử, không quan trọng nếu mất
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    if (dubEngine === "capcut") {
      setVoicesLoading(true);
      getCapCutVoices(voiceLang)
        .then((vs) => {
          if (mounted) {
            setCapcutVoices(vs);
            setDubVoice((v) =>
              vs.some((x) => x.voice_type === v) ? v : (vs[0]?.voice_type ?? v),
            );
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
      getGoogleTtsVoices(voiceLang)
        .then((vs) => {
          if (mounted) {
            setGoogleVoices(vs);
            setDubVoice((v) =>
              vs.some((x) => x.voice_type === v) ? v : (vs[0]?.voice_type ?? v),
            );
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
  }, [dubEngine, voiceLang]);

  const switchDubEngine = async (engine: "google" | "capcut") => {
    setDubEngine(engine);
    setPreviewUrl(null);
    setPreviewError(false);
    if (engine === "google") {
      if (googleVoices.length > 0) {
        setDubVoice((v) =>
          googleVoices.some((x) => x.voice_type === v)
            ? v
            : (googleVoices[0]?.voice_type ?? v),
        );
      } else {
        // Google voices differ from CapCut (BV/AV*) — reset so a CapCut voice is
        // never sent to Google TTS. Effect below will populate googleVoices.
        setDubVoice(
          voiceLang === "vi-VN" ? "vi-VN-Standard-B" : "en-US-Standard-B",
        );
      }
    } else if (capcutVoices.length === 0) {
      setVoicesLoading(true);
      try {
        const vs = await getCapCutVoices(voiceLang);
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
        const vs = await getGoogleTtsVoices(voiceLang);
        setGoogleVoices(vs);
        if (vs.length > 0) setDubVoice(vs[0].voice_type);
      } else {
        const vs = await getCapCutVoices(voiceLang);
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
    const id = addPipeline(
      v,
      regionMode,
      {
        engine: dubEngine,
        voice: dubVoice,
        muteOriginal,
        originalGainDb,
        multiVoice: multiVoice && dubEngine === "capcut",
      },
      autoFitSubs,
      watermarkOn,
      watermarkOn ? watermarkPreset : "",
      removeWmEnabled,
      removeWmRegions,
      checkSubs,
      checkVoice,
      autoUploadYoutube,
      ytChannel,
      useFalThumbnail,
      useGptThumbnail,
      srcLang,
      translateOn,
      translateTarget,
      dubOn,
    );
    setUrl("");
    setSelectedId(id);
    setTab("detail");
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    if (!health?.healthy) {
      checkHealth();
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    try {
      const videoId = await uploadVideo(file, setUploadProgress);
      setUploaded({ videoId, name: file.name, size: file.size });
    } catch (e) {
      setUploadError(
        e instanceof Error ? e.message : tr("pipeline.error.uploadFailed"),
      );
      setUploaded(null);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleStartUpload = () => {
    if (!uploaded) return;
    const id = addPipelineFromUpload({
      videoId: uploaded.videoId,
      filename: uploaded.name,
      srcLang,
      regionMode,
      dub: { engine: dubEngine, voice: dubVoice, muteOriginal, originalGainDb },
      autoFit: autoFitSubs,
      watermark: watermarkOn,
      watermarkPreset: watermarkOn ? watermarkPreset : "",
      removeWatermarkEnabled: removeWmEnabled,
      removeWatermarkRegions: removeWmRegions,
      checkSubs,
      checkVoice,
      autoUploadYoutube,
      youtubeChannel: ytChannel,
      translateOn,
      translateTarget,
      dubOn,
    });
    setUploaded(null);
    setSelectedId(id);
    setTab("detail");
  };

  const activeCount = pipelines.filter(
    (p) => p.status === "queued" || p.status === "running",
  ).length;
  const activePipelines = pipelines
    .filter((p) => p.status === "queued" || p.status === "running")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const donePipelines = pipelines
    .filter((p) => p.status === "done" || p.status === "error")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  // Persisted completed videos from the backend (survive page reloads), minus
  // any that are already represented by an in-memory pipeline (matched by videoId).
  const sessionVideoIds = new Set(
    pipelines.map((p) => p.videoId).filter(Boolean),
  );
  const historyVideosDone = historyVideos.filter(
    (v) => v.status === "done" && !sessionVideoIds.has(v.video_id),
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

  // Delete a pipeline row completely: for running/queued jobs abort the backend
  // first, and whenever the pipeline owns a video also delete the backend files
  // (SRT, frames, TTS, hardcoded…) and drop it from the persisted history list.
  // Otherwise the video reappears as a HistoryRow on the next listVideos().
  const removePipelineEntry = async (p: Pipeline) => {
    if (p.status === "running" || p.status === "queued") {
      await cancelPipeline(p.id);
    } else {
      removePipeline(p.id);
    }
    if (selectedId === p.id) setSelectedId(null);
    if (p.videoId) {
      try {
        await deleteVideo(p.videoId);
      } catch {
        // ignore
      }
      setHistoryVideos((prev) => prev.filter((v) => v.video_id !== p.videoId));
    }
  };

  // "Xoá job đã xong": same as removePipelineEntry, but for every finished
  // pipeline (and matching history rows) so nothing lingers on the backend.
  const handleClearFinished = async () => {
    for (const p of pipelines.filter(
      (x) => x.status === "done" || x.status === "error",
    )) {
      if (p.videoId) {
        try {
          await deleteVideo(p.videoId);
        } catch {
          // ignore
        }
      }
      removePipeline(p.id);
    }
    if (selectedId != null && !pipelines.some((x) => x.id === selectedId))
      setSelectedId(null);
    setHistoryVideos((prev) => prev.filter((v) => v.status !== "done"));
  };

  return (
    <>
      <div>
        <PageHeader
          title={tr("pipeline.title")}
          description={tr("pipeline.subtitle")}
          actions={
            <>
              {hasFinished && (
                <button
                  onClick={handleClearFinished}
                  className="btn-island-secondary !px-4 !py-2 text-[12px]"
                >
                  {tr("pipeline.clearFinished")}
                </button>
              )}
              <button
                onClick={() => setConfirmingClear(true)}
                className="btn-island-danger !px-4 !py-2 text-[12px]"
              >
                {tr("pipeline.clearTemp")}
              </button>
            </>
          }
        />

        {/* Step 1: Input */}
        <AnimatedBlock delay={150}>
          <div className="double-bezel mb-6">
            <div className="double-bezel-inner p-5 sm:p-6">
              {healthLoading ? (
                <div className="flex items-center gap-2 mb-4 rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] px-4 py-3">
                  <IconSpinner className="w-4 h-4 text-accent" />
                  <span className="text-[12px] text-ink-muted">
                    {tr("pipeline.health.checking")}
                  </span>
                </div>
              ) : health && !health.healthy ? (
                <div className="mb-4 rounded-xl bg-warn-muted ring-1 ring-warn/15 px-4 py-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-[12px] font-medium text-warn">
                      {tr("pipeline.health.warning")}
                    </p>
                    <button
                      onClick={checkHealth}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-warn-muted text-warn ring-1 ring-warn/25 hover:bg-warn/25 transition-colors cursor-pointer"
                    >
                      {tr("pipeline.retry")}
                    </button>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {health.checks.map((c) => (
                      <li
                        key={c.service}
                        className="flex items-start gap-2 text-[12px] text-warn/80"
                      >
                        <span
                          className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.healthy ? "bg-success" : "bg-warn"}`}
                        />
                        <span className="font-mono">{c.service}:</span>
                        <span className="flex-1">{c.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : health?.healthy ? (
                <div className="flex items-center gap-2 mb-4 rounded-xl bg-success-muted ring-1 ring-success/15 px-4 py-2.5">
                  <IconCheck className="w-4 h-4 text-success" />
                  <span className="text-[12px] text-success">
                    {tr("pipeline.health.readyPrefix")}{" "}
                    {health.dub_engines?.google ? "Google TTS" : ""}
                    {health.dub_engines?.google && health.dub_engines?.capcut
                      ? " + "
                      : ""}
                    {health.dub_engines?.capcut ? "CapCut" : ""}
                    {!health.dub_engines?.google && !health.dub_engines?.capcut
                      ? tr("pipeline.health.notReady")
                      : tr("pipeline.health.ready")}
                    .{" "}
                    {health.checks.find((c) => c.service === "douyin")?.healthy
                      ? tr("pipeline.health.profileDouyinOk")
                      : tr("pipeline.health.profileDouyinNo")}
                    ,{" "}
                    {health.checks.find((c) => c.service === "chatgpt")?.healthy
                      ? tr("pipeline.health.profileChatgptOk")
                      : tr("pipeline.health.profileChatgptNo")}
                    .
                  </span>
                  <button
                    onClick={checkHealth}
                    className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium bg-success-muted text-success ring-1 ring-success/25 hover:bg-success/25 transition-colors cursor-pointer"
                  >
                    {tr("pipeline.retry")}
                  </button>
                </div>
              ) : null}
              <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] mb-4 w-fit">
                {(["douyin", "youtube", "upload"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSourceType(t)}
                    className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] ${
                      sourceType === t
                        ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                        : "text-ink-light hover:text-ink"
                    } cursor-pointer`}
                  >
                    {t === "douyin"
                      ? tr("pipeline.sourceDouyin")
                      : t === "youtube"
                        ? tr("pipeline.sourceYoutube")
                        : tr("pipeline.sourceUpload")}
                  </button>
                ))}
              </div>
              {sourceType !== "upload" ? (
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
                        ? tr("pipeline.placeholder.checking")
                        : health?.healthy
                          ? sourceType === "youtube"
                            ? tr("pipeline.placeholder.youtube")
                            : tr("pipeline.placeholder.douyin")
                          : tr("pipeline.placeholder.notConfigured")
                    }
                    className="flex-1 rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2.5 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <button
                    onClick={handleAdd}
                    disabled={!url.trim() || !health?.healthy}
                    className="btn-island-primary group text-sm !px-5 !py-2.5 flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span className="tracking-tight">
                      {sourceType === "youtube"
                        ? tr("pipeline.btnDownloadProcess")
                        : tr("pipeline.btnStart")}
                    </span>
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
                    className="hidden"
                    onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                  />
                  {uploading ? (
                    <div className="w-full rounded-xl border border-dashed border-accent/20 bg-accent-muted px-4 py-6 text-[13px] text-ink-muted flex flex-col items-center gap-2">
                      <IconSpinner className="w-5 h-5 text-accent" />
                      <span>
                        {tr("pipeline.uploading", {
                          pct: uploadProgress,
                        })}
                      </span>
                    </div>
                  ) : uploaded ? (
                    <div className="w-full rounded-xl border border-success/20 bg-success-muted px-4 py-4">
                      <div className="flex items-center gap-2">
                        <IconCheck className="w-4 h-4 text-success flex-shrink-0" />
                        <p className="text-[13px] font-medium text-success truncate">
                          {tr("pipeline.uploadSuccess", {
                            name: uploaded.name,
                          })}
                        </p>
                      </div>
                      <p className="text-[11px] text-success/70 mt-1">
                        {tr("pipeline.uploadHint", {
                          size: fmtBytes(uploaded.size),
                        })}
                      </p>
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        <button
                          onClick={handleStartUpload}
                          className="btn-island-primary group text-sm !px-5 !py-2.5"
                        >
                          <span className="tracking-tight">
                            {tr("pipeline.btnStartProcess")}
                          </span>
                        </button>
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="btn-island-secondary btn-xs"
                        >
                          {tr("pipeline.changeVideo")}
                    </button>
                  </div>
                </div>
                  ) : uploadError ? (
                    <div className="w-full rounded-xl border border-danger/20 bg-danger-muted px-4 py-4">
                      <p className="text-[13px] font-medium text-danger">
                        {tr("pipeline.error.uploadFailed")}
                      </p>
                      <p className="text-[11px] text-danger/80 mt-1">
                        {uploadError}
                      </p>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="mt-3 btn-ghost-danger bg-danger-muted"
                      >
                        {tr("pipeline.retry")}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!health?.healthy}
                      className="w-full rounded-xl border border-dashed border-white/[0.14] bg-white/[0.03] px-4 py-6 text-[13px] text-ink-light hover:bg-white/[0.05] hover:text-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center gap-2 cursor-pointer"
                    >
                      <svg
                        className="w-5 h-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span>{tr("pipeline.chooseVideo")}</span>
                    </button>
                  )}
                </div>
              )}
              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  {tr("pipeline.sourceLang")}
                </span>
                <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08]">
                  {(["zh", "en", "vi"] as const).map((l) => (
                    <button
                      key={l}
                      onClick={() => setSrcLang(l)}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] ${
                        srcLang === l
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      } cursor-pointer`}
                    >
                      {l === "zh"
                        ? tr("pipeline.langZh")
                        : l === "en"
                          ? tr("pipeline.langEn")
                          : tr("pipeline.langVi")}
                    </button>
                  ))}
                </div>
                <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                  {tr("pipeline.sourceLangHint")}
                </p>
              </div>
              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                  {tr("pipeline.scanRegion")}
                </span>
                <div
                  className={`flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] `}
                >
                  <button
                    onClick={() => setRegionMode("auto")}
                    className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                      regionMode === "auto"
                        ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    {tr("pipeline.regionAuto")}
                  </button>
                  <button
                    onClick={() => setRegionMode("manual")}
                    className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                      regionMode === "manual"
                        ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                        : "text-ink-light hover:text-ink"
                    }`}
                  >
                    {tr("pipeline.regionManual")}
                  </button>
                </div>
                <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                  {regionMode === "auto"
                    ? tr("pipeline.regionAutoHint")
                    : tr("pipeline.regionManualHint")}
                </p>
              </div>
              <div className="mt-4 border-t border-white/[0.07] pt-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {tr("pipeline.dubTitle")}
                  </span>
                  <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08]">
                    {(["vi-VN", "en-US"] as const).map((l) => (
                      <button
                        key={l}
                        onClick={() => {
                          if (l === voiceLang) return;
                          setVoiceLang(l);
                          setPreviewUrl(null);
                          setPreviewError(false);
                          setDubVoice(
                            l === "vi-VN" ? "BV421_vivn_streaming" : "",
                          );
                        }}
                        className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] ${
                          voiceLang === l
                            ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                            : "text-ink-light hover:text-ink"
                        } cursor-pointer`}
                      >
                        {l === "vi-VN"
                          ? tr("pipeline.langVi")
                          : tr("pipeline.langEn")}
                      </button>
                    ))}
                  </div>
                  <div
                    className={`flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] `}
                  >
                    <button
                      onClick={() => switchDubEngine("google")}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                        dubEngine === "google"
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      }`}
                    >
                      Google TTS
                    </button>
                    <button
                      onClick={() => switchDubEngine("capcut")}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                        dubEngine === "capcut"
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      }`}
                    >
                      CapCut
                    </button>
                  </div>
                  {(dubEngine === "capcut"
                    ? capcutVoices.length > 0 && !voicesLoading
                    : googleVoices.length > 0 && !voicesLoading) && (
                    <>
                      <select
                        value={dubVoice}
                        onChange={(e) => {
                          setDubVoice(e.target.value);
                          setPreviewUrl(null);
                          setPreviewError(false);
                        }}
                        className="rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {(dubEngine === "capcut"
                          ? capcutVoices
                          : googleVoices
                        ).map((v) => (
                          <option key={v.voice_type} value={v.voice_type}>
                            {v.display_name} ({v.voice_type})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={handlePreviewVoice}
                        disabled={previewing}
                        className="btn-island-secondary btn-xs chip-active disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {previewing
                          ? tr("pipeline.creatingAudio")
                          : tr("pipeline.previewVoice")}
                      </button>
                      {previewUrl && (
                        <audio
                          key={previewUrl}
                          src={previewUrl}
                          controls
                          autoPlay
                          className="h-8"
                        />
                      )}
                      {previewError && (
                        <span className="text-[11px] text-danger flex items-center gap-1.5">
                          {tr("pipeline.voiceUnavailable")}
                        </span>
                      )}
                    </>
                  )}
                  {voicesLoading && (
                    <span className="text-[11px] text-ink-light flex items-center gap-1.5">
                      <IconSpinner className="w-3 h-3" />{" "}
                      {tr("pipeline.loadingVoices")}{" "}
                      {dubEngine === "google" ? "Google TTS" : "CapCut"}...
                    </span>
                  )}
                  {!voicesLoading &&
                    (dubEngine === "capcut"
                      ? capcutVoices.length === 0
                      : googleVoices.length === 0) && (
                      <span className="text-[11px] text-warn flex items-center gap-2">
                        {tr("pipeline.voicesFailed")}{" "}
                        {dubEngine === "google"
                          ? tr("pipeline.voicesFailedGoogle")
                          : tr("pipeline.voicesFailedCapcut")}
                        .
                        <button
                          onClick={refreshVoices}
                          className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-warn/15 text-warn/80 ring-1 ring-warn/15 hover:bg-warn/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {tr("pipeline.retry")}
                        </button>
                      </span>
                    )}
                </div>
                <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                  {dubEngine === "google"
                    ? tr("pipeline.dubGoogleHint")
                    : tr("pipeline.dubCapcutHint")}
                </p>

                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {tr("pipeline.originalVoice")}
                  </span>
                  <div
                    className={`flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] `}
                  >
                    <button
                      onClick={() => setMuteOriginal(true)}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                        muteOriginal
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      }`}
                    >
                      {tr("pipeline.originalVoiceMute")}
                    </button>
                    <button
                      onClick={() => setMuteOriginal(false)}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                        !muteOriginal
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      }`}
                    >
                      {tr("pipeline.originalVoiceKeep")}
                    </button>
                  </div>
                  {!muteOriginal && (
                    <label className="flex items-center gap-2.5">
                      <span className="text-[11px] text-ink-muted">
                        {tr("pipeline.reduceOriginalVoice")}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={30}
                        step={1}
                        value={originalGainDb}
                        onChange={(e) =>
                          setOriginalGainDb(Number(e.target.value))
                        }
                        className="w-40 accent-accent disabled:opacity-40"
                      />
                      <span className="text-[12px] font-mono tabular-nums text-accent font-semibold w-10">
                        -{originalGainDb} dB
                      </span>
                    </label>
                  )}
                </div>
                {!muteOriginal && (
                  <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                    {originalGainDb === 0
                      ? tr("pipeline.reduceOriginalHintZero")
                      : tr("pipeline.reduceOriginalHint", {
                          db: originalGainDb,
                        })}
                  </p>
                )}

                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.multiVoice")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {dubEngine === "capcut"
                          ? tr("pipeline.multiVoiceHint")
                          : tr("pipeline.multiVoiceCapcutOnly")}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={dubEngine !== "capcut"}
                      onClick={() => setMultiVoice(!multiVoice)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        multiVoice ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          multiVoice ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4 flex items-center gap-3 flex-wrap">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                    {tr("pipeline.alignSubs")}
                  </span>
                  <div
                    className={`flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] `}
                  >
                    <button
                      onClick={() => setAutoFitSubs(true)}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                        autoFitSubs
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      }`}
                    >
                      {tr("pipeline.alignSubsAutoFit")}
                    </button>
                    <button
                      onClick={() => setAutoFitSubs(false)}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer ${
                        !autoFitSubs
                          ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                          : "text-ink-light hover:text-ink"
                      }`}
                    >
                      {tr("pipeline.alignSubsManual")}
                    </button>
                  </div>
                  <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                    {autoFitSubs
                      ? tr("pipeline.alignSubsAutoFitHint")
                      : tr("pipeline.alignSubsManualHint")}
                  </p>
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.autoTranslate")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.autoTranslateHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTranslateOn(!translateOn)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        translateOn ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          translateOn ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  {translateOn && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.translateTo")}
                      </span>
                      <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08]">
                        {(["zh", "en", "vi"] as const).map((l) => (
                          <button
                            key={l}
                            onClick={() => setTranslateTarget(l)}
                            className={`px-4 py-1.5 rounded-md text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] ${
                              translateTarget === l
                                ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                                : "text-ink-light hover:text-ink"
                            } cursor-pointer`}
                          >
                            {l === "zh"
                              ? tr("pipeline.langZh")
                              : l === "en"
                                ? tr("pipeline.langEn")
                                : tr("pipeline.langVi")}
                          </button>
                        ))}
                      </div>
                      <p className="w-full text-[11px] text-ink-light leading-relaxed mt-1">
                        {tr("pipeline.translateToHint")}
                      </p>
                    </div>
                  )}
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.autoDub")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.autoDubHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDubOn(!dubOn)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        dubOn ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          dubOn ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  {dubOn && (
                    <p className="mt-3 text-[11px] text-ink-light leading-relaxed">
                      {tr("pipeline.autoDubHintDetail")}
                    </p>
                  )}
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.watermark")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.watermarkHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWatermarkOn(!watermarkOn)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        watermarkOn ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          watermarkOn ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  {watermarkOn && (
                    <div className="mt-3">
                      <label className="block">
                        <span className="text-[11px] text-ink-muted mb-1.5 block">
                          {tr("pipeline.watermarkSet")}
                        </span>
                        <select
                          value={watermarkPreset || presets[0]?.id || ""}
                          onChange={(e) => setWatermarkPreset(e.target.value)}
                          className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/20 cursor-pointer"
                        >
                          {presets.length === 0 ? (
                            <option value="">
                              {tr("pipeline.watermarkNone")}
                            </option>
                          ) : (
                            presets.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}{" "}
                                {p.has_logo
                                  ? tr("pipeline.watermarkWithLogo")
                                  : tr("pipeline.watermarkTextOnly")}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                    </div>
                  )}
                </div>

                {/* ── Remove Watermark (delogo) ── */}
                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.removeWatermark")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.removeWatermarkHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (removeWmEnabled) {
                          setRemoveWmEnabled(false);
                          setRemoveWmRegions([]);
                        } else {
                          setRemoveWmEnabled(true);
                        }
                      }}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        removeWmEnabled ? "bg-danger" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          removeWmEnabled ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  {removeWmEnabled && (
                    <p className="text-[11px] text-ink-light mt-2">
                      {tr("pipeline.removeWatermarkWillPrompt")}
                    </p>
                  )}
                  {removeWmRegions.length > 0 && (
                    <div className="mt-3 flex items-center gap-3">
                      <span className="text-[11px] text-green-600">
                        ✓ {tr("pipeline.removeWatermarkActive")}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoveWmRegions([]);
                          setRemoveWmEnabled(false);
                        }}
                        className="text-[11px] text-danger hover:text-danger cursor-pointer"
                      >
                        {tr("pipeline.removeWatermarkClear")}
                      </button>
                    </div>
                  )}
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.checkTimeline")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.checkTimelineHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCheckSubs(!checkSubs)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        checkSubs ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          checkSubs ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3 mt-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.checkVoice")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.checkVoiceHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCheckVoice(!checkVoice)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        checkVoice ? "bg-violet-600" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          checkVoice ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.falThumbnail")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.falThumbnailHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setUseFalThumbnail(!useFalThumbnail);
                        if (!useFalThumbnail) setUseGptThumbnail(false);
                      }}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        useFalThumbnail ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          useFalThumbnail ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.gptThumbnail")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.gptThumbnailHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setUseGptThumbnail(!useGptThumbnail);
                        if (!useGptThumbnail) setUseFalThumbnail(false);
                      }}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        useGptThumbnail ? "bg-accent" : "bg-black/10"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
                          useGptThumbnail ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="mt-4 border-t border-white/[0.07] pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                        {tr("pipeline.autoYoutube")}
                      </p>
                      <p className="text-[11px] text-ink-light leading-relaxed mt-0.5">
                        {tr("pipeline.autoYoutubeHint")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAutoUploadYoutube(!autoUploadYoutube)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-300 flex-shrink-0 cursor-pointer ${
                        autoUploadYoutube ? "bg-accent" : "bg-black/10"
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

                {autoUploadYoutube && (
                  <div className="mt-3 border-t border-white/[0.07] pt-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-[11px] text-ink-muted">
                        {tr("pipeline.youtubeChannel")}
                      </span>
                      <select
                        value={ytChannel}
                        onChange={(e) => setYtChannel(e.target.value)}
                        className="rounded-xl border border-white/[0.09] bg-black/25 px-3 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/20 max-w-[200px]"
                      >
                        <option value="">{tr("pipeline.youtubeChannelDefault")}</option>
                        {ytChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>
                            {ch.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {ytChannels.length === 0 && (
                      <p className="text-[10px] text-ink-light mt-1.5">
                        {tr("pipeline.youtubeChannelEmpty")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </AnimatedBlock>

        {/* Tabs */}
        <AnimatedBlock delay={200}>
          <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] w-max">
              <button
                onClick={() => setTab("detail")}
                className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
                  tab === "detail"
                    ? "bg-accent text-white shadow-sm"
                    : "text-ink-light hover:text-ink"
                }`}
              >
                {tr("pipeline.tabProgress")}
              </button>
              <button
                onClick={() => setTab("active")}
                className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
                  tab === "active"
                    ? "bg-accent text-white shadow-sm"
                    : "text-ink-light hover:text-ink"
                }`}
              >
                {tr("pipeline.tabActive")}
                {activeCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-accent-muted text-[10px] text-accent">
                    {activeCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => setTab("done")}
                className={`px-5 py-2 rounded-full text-[12px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-[0.97] ${
                  tab === "done"
                    ? "bg-accent text-white shadow-sm"
                    : "text-ink-light hover:text-ink"
                }`}
              >
                {tr("pipeline.tabDone")}
                {finishedCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-success/15 text-[10px] text-success">
                    {finishedCount}
                  </span>
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
                  <p className="text-sm text-ink-muted text-center py-8">
                    {tr("pipeline.emptyActive")}
                  </p>
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
                          removePipelineEntry(p);
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
                {donePipelines.length === 0 &&
                historyVideosDone.length === 0 ? (
                  <p className="text-sm text-ink-muted text-center py-8">
                    {tr("pipeline.emptyDone")}
                  </p>
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
                          removePipelineEntry(p);
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
                          setHistoryVideos((prev) =>
                            prev.filter((x) => x.video_id !== v.video_id),
                          );
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
              onRemove={() => removePipelineEntry(selected)}
              onStartNext={focusNewVideo}
              ytChannels={ytChannels}
              presets={presets}
            />
          </AnimatedBlock>
        ) : (
          <AnimatedBlock delay={250}>
            <div className="double-bezel">
              <div className="double-bezel-inner p-16 text-center">
                <p className="text-sm text-ink-muted">
                  {tr("pipeline.emptyJob")}
                </p>
              </div>
            </div>
          </AnimatedBlock>
        )}
      </div>

      {confirmingClear && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
          onClick={() => setConfirmingClear(false)}
        >
          <div
            className="double-bezel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            style={{
              animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <p className="text-sm font-semibold text-ink mb-1">
                {tr("pipeline.clearTempTitle")}
              </p>
              <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                {tr("pipeline.clearTempBody")}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingClear(false)}
                  className="btn-island-secondary btn-sm"
                >
                  {tr("pipeline.no")}
                </button>
                <button
                  onClick={handleClearTemp}
                  className="btn-island-danger btn-sm"
                >
                  {tr("pipeline.confirmClear")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PipelineRow({
  p,
  now,
  onOpen,
  onRemove,
}: {
  p: Pipeline;
  now: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const tr = makeT(t);
  const meta = STATUS_META[p.status] ?? STATUS_META.queued;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const stepLabel = (() => {
    if (p.status === "error" && p.failedStep != null) {
      return `${tr("pipeline.stepError")} ${p.failedStep + 1}/9 · ${
        STEP_LABEL_KEYS[p.failedStep]
          ? tr(STEP_LABEL_KEYS[p.failedStep])
          : p.stage
      }`;
    }
    if (p.status !== "running") return null;
    const idx = STEP_STAGE[p.stage];
    return idx != null
      ? `${tr("pipeline.stepProgress")} ${idx + 1}/12 · ${
          STEP_LABEL_KEYS[idx] ? tr(STEP_LABEL_KEYS[idx]) : p.stage
        }`
      : p.stage;
  })();

  return (
    <div
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-white/[0.09] bg-white/[0.03] hover:bg-white/[0.05] transition-colors cursor-pointer"
    >
      <div className="w-[104px] h-[58px] rounded-lg overflow-hidden bg-black flex-shrink-0 ring-1 ring-white/[0.11]">
        {p.videoId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={getFrameUrl(p.videoId)}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-light">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="5" width="14" height="14" rx="2" />
              <path d="M16 9l6-3v12l-6-3" />
            </svg>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ${meta.cls}`}
          >
            {tr(meta.labelKey)}
          </span>
          {p.status === "queued" && (
            <span className="text-[10px] text-warn/80 flex items-center gap-1">
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              {tr("pipeline.waiting")}
            </span>
          )}
          {p.status === "running" && (
            <span className="text-[10px] text-accent/80 flex items-center gap-1">
              <IconSpinner className="w-3 h-3" />
              {tr("pipeline.running")}
            </span>
          )}
          <span className="ml-auto text-[10px] font-mono text-ink-light tabular-nums">
            {pipelineElapsed(p, now)}
          </span>
        </div>
        <p className="text-[12px] font-medium text-ink truncate">
          {p.title || p.url || tr("pipeline.jobTitle", { id: p.id })}
        </p>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 h-1 rounded-full bg-white/[0.08] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                p.status === "error"
                  ? "bg-danger"
                  : p.status === "done"
                    ? "bg-success"
                    : "bg-accent"
              }`}
              style={{
                width: `${p.status === "done" ? 100 : Math.max(p.status === "error" ? 0 : p.progress, 2)}%`,
              }}
            />
          </div>
          {(p.status === "running" || p.status === "done") && (
            <span className="text-[10px] font-mono text-ink-light tabular-nums">
              {p.status === "done" ? 100 : p.progress}%
            </span>
          )}
        </div>
        {stepLabel && (
          <p
            className={`text-[11px] mt-1 truncate ${p.status === "error" ? "text-danger/80" : "text-accent/80"}`}
          >
            {stepLabel}
            {p.status === "running" ? ` · ${p.progress}%` : ""}
          </p>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        title={tr("pipeline.previewMedia")}
        className="px-2.5 h-7 rounded-full text-[11px] font-medium bg-white/[0.05] ring-1 ring-white/[0.09] text-ink-muted hover:bg-white/[0.11] hover:text-ink transition-colors cursor-pointer flex-shrink-0"
      >
        {tr("pipeline.previewMediaBtn")}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirmingRemove(true);
        }}
        title={
          p.status === "running" || p.status === "queued"
            ? tr("pipeline.cancelProcess")
            : tr("pipeline.delete")
        }
        className="w-7 h-7 rounded-lg bg-danger-muted text-danger flex items-center justify-center hover:bg-danger/20 transition-colors cursor-pointer flex-shrink-0"
      >
        {p.status === "running" || p.status === "queued" ? (
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
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
            style={{
              animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              {p.status === "running" || p.status === "queued" ? (
                <>
                  <p className="text-sm font-semibold text-ink mb-1">
                    {tr("pipeline.cancelProcessTitle")}
                  </p>
                  <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                    {tr("pipeline.cancelProcessBody")}
                  </p>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setConfirmingRemove(false)}
                      className="btn-island-secondary btn-sm"
                    >
                      {tr("pipeline.noContinue")}
                    </button>
                    <button
                      onClick={() => {
                        setConfirmingRemove(false);
                        onRemove();
                      }}
                      className="btn-island-danger btn-sm"
                    >
                      {tr("pipeline.confirmCancel")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-ink mb-1">
                    {tr("pipeline.deleteJobTitle")}
                  </p>
                  <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                    {tr("pipeline.deleteJobBody")}
                  </p>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setConfirmingRemove(false)}
                      className="btn-island-secondary btn-sm"
                    >
                      {tr("pipeline.noKeep")}
                    </button>
                    <button
                      onClick={() => {
                        setConfirmingRemove(false);
                        onRemove();
                      }}
                      className="btn-island-danger btn-sm"
                    >
                      {tr("pipeline.delete")}
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

function HistoryRow({
  v,
  onOpen,
  onDelete,
}: {
  v: VideoMeta;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const tr = makeT(t);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <div
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-white/[0.09] bg-white/[0.03] hover:bg-white/[0.05] transition-colors cursor-pointer"
    >
      <div className="w-[104px] h-[58px] rounded-lg overflow-hidden bg-black flex-shrink-0 ring-1 ring-white/[0.11]">
        {v.has_video ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={getFrameUrl(v.video_id)}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-light">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="5" width="14" height="14" rx="2" />
              <path d="M16 9l6-3v12l-6-3" />
            </svg>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-success" />
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 bg-success-muted text-success ring-success/15">
            {tr("pipeline.status.done")}
          </span>
          <span className="text-[10px] font-mono text-ink-light tabular-nums">
            {tr("pipeline.entries", { count: v.entries })}
          </span>
        </div>
        <p className="text-[12px] font-medium text-ink truncate">
          {v.filename || v.video_id}
        </p>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 h-1 rounded-full bg-success/80" />
          <span className="text-[10px] font-mono text-ink-light tabular-nums">
            100%
          </span>
        </div>
      </div>
      <span className="text-[10px] font-mono text-ink-light tabular-nums flex-shrink-0">
        {new Date(v.created_at).toLocaleDateString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
        })}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirmingDelete(true);
        }}
        title={tr("pipeline.deleteVideo")}
        className="w-7 h-7 rounded-lg bg-danger-muted text-danger flex items-center justify-center hover:bg-danger/20 transition-colors cursor-pointer flex-shrink-0"
      >
        <svg
          className="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
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
            style={{
              animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <p className="text-sm font-semibold text-ink mb-1">
                {tr("pipeline.deleteVideoTitle")}
              </p>
              <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                {tr("pipeline.deleteVideoBody")}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingDelete(false)}
                  className="btn-island-secondary btn-sm"
                >
                  {tr("pipeline.noKeep")}
                </button>
                <button
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                  className="btn-island-danger btn-sm"
                >
                  {tr("pipeline.deleteVideoConfirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ThumbnailReviewActions({
  onAccept,
  onSkip,
  onRegenerate,
}: {
  onAccept: () => void;
  onSkip: () => void;
  onRegenerate: (extra: string) => void;
}) {
  const [showRegen, setShowRegen] = useState(false);
  const [extra, setExtra] = useState("");

  return (
    <>
      <button
        onClick={onAccept}
        className="btn-island-primary btn-sm"
      >
        Chấp nhận
      </button>
      <button
        onClick={() => setShowRegen(!showRegen)}
        className="btn-warn"
      >
        Tạo lại
      </button>
      <button
        onClick={onSkip}
        className="btn-island-secondary btn-sm"
      >
        Bỏ qua
      </button>
      {showRegen && (
        <div className="flex gap-2 mt-1">
          <input
            type="text"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="Thêm yêu cầu (ví dụ: thêm chữ, đổi màu...)"
            className="flex-1 px-3 py-1.5 text-[11px] border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter" && extra.trim()) {
                onRegenerate(extra.trim());
                setExtra("");
                setShowRegen(false);
              }
            }}
          />
          <button
            onClick={() => {
              if (extra.trim()) {
                onRegenerate(extra.trim());
                setExtra("");
                setShowRegen(false);
              }
            }}
            className="px-3 py-1.5 text-[11px] font-medium bg-amber-500 text-white rounded-lg hover:opacity-90 transition-colors cursor-pointer"
          >
            Gửi
          </button>
        </div>
      )}
    </>
  );
}

function DetailView({
  pipeline: p,
  now,
  onRemove,
  onStartNext,
  ytChannels,
  presets,
}: {
  pipeline: Pipeline;
  now: number;
  onRemove: () => void;
  onStartNext?: () => void;
  ytChannels: YouTubeChannelInfo[];
  presets: WatermarkPreset[];
}) {
  const { t } = useI18n();
  const tr = makeT(t);
  const failedStep = p.status === "error" ? p.failedStep : null;
  const activeStep =
    p.status === "done"
      ? STEPS.length
      : failedStep != null
        ? failedStep
        : (STEP_STAGE[p.stage] ?? 0);
  const rerunPipeline = usePipelineStore((s) => s.rerunPipeline);
  const confirmRegion = usePipelineStore((s) => s.confirmRegion);
  const confirmSubtitleStyle = usePipelineStore((s) => s.confirmSubtitleStyle);
  const confirmWatermarkRegions = usePipelineStore((s) => s.confirmWatermarkRegions);
  const confirmThumbnailReview = usePipelineStore((s) => s.confirmThumbnailReview);
  const resolveThumbnailFallback = usePipelineStore((s) => s.resolveThumbnailFallback);
  const cancelPipeline = usePipelineStore((s) => s.cancelPipeline);
  const resolveTimelineCheck = usePipelineStore((s) => s.resolveTimelineCheck);
  const openTimelineCheck = usePipelineStore((s) => s.openTimelineCheck);
  const closeTimelineCheck = usePipelineStore((s) => s.closeTimelineCheck);
  const resolveVoiceCheck = usePipelineStore((s) => s.resolveVoiceCheck);
  const openVoiceCheck = usePipelineStore((s) => s.openVoiceCheck);
  const closeVoiceCheck = usePipelineStore((s) => s.closeVoiceCheck);
  const updatePipeline = usePipelineStore((s) => s.updatePipeline);
  const clearRemoveWmRegion = (id: string) => updatePipeline(id, { removeWatermarkRegions: [] });
  const logRef = useRef<HTMLDivElement>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

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
              <p className="text-sm font-semibold text-ink truncate">
                {p.title || tr("pipeline.analyzing")}
              </p>
              {p.status === "queued" && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-warn-muted ring-1 ring-warn/20 text-warn flex items-center gap-1">
                  <svg
                    className="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  {tr("pipeline.queuedInQueue")}
                </span>
              )}
              {p.status === "running" && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-accent-muted ring-1 ring-accent/20 text-accent flex items-center gap-1">
                  <IconSpinner className="w-3 h-3" />
                  {tr("pipeline.processing")}
                </span>
              )}
              {p.status === "error" && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-danger-muted ring-1 ring-danger/20 text-danger flex items-center gap-1">
                  <svg
                    className="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  {tr("pipeline.errorAtStep", {
                    step: failedStep != null ? failedStep + 1 : "?",
                  })}
                </span>
              )}
            </div>
            <p className="text-[11px] text-ink-light font-mono truncate">
              {p.url}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPreviewOpen(true)}
              title={tr("pipeline.previewMedia")}
              className="px-2.5 h-7 rounded-full text-[11px] font-medium bg-white/[0.05] ring-1 ring-white/[0.09] text-ink-muted hover:bg-white/[0.11] hover:text-ink transition-colors cursor-pointer"
            >
              {tr("pipeline.previewMediaBtn")}
            </button>
            {(p.status === "running" || p.status === "queued") && (
              <button
                onClick={() => setConfirmingCancel(true)}
                className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-danger-muted ring-1 ring-danger/15 text-danger hover:bg-danger/10 transition-colors cursor-pointer"
              >
                {tr("pipeline.cancelProcess")}
              </button>
            )}
            <button
              onClick={onRemove}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-white/[0.04] ring-1 ring-white/[0.09] text-ink-muted hover:bg-white/[0.08] hover:text-ink transition-colors cursor-pointer"
            >
              {tr("pipeline.delete")}
            </button>
          </div>
        </div>

        {p.stage === "region" && p.videoId && (
          <div className="mb-5">
            {p.removeWatermarkRegions.length > 0 && (
              <div className="mb-4 p-3 bg-red-50 rounded-lg border border-red-200">
                <p className="text-[11px] font-semibold text-danger mb-2">
                  {tr("pipeline.removeWatermark")} — {tr("pipeline.removeWatermarkActive")}
                </p>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-green-600">
                    ✓ {tr("pipeline.removeWatermarkRegionSet")}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearRemoveWmRegion(p.id)}
                    className="text-[11px] text-danger hover:text-danger cursor-pointer"
                  >
                    {tr("pipeline.removeWatermarkClear")}
                  </button>
                </div>
              </div>
            )}
            <RegionSelector
              videoId={p.videoId}
              onConfirmed={(r) => confirmRegion(p.id, r)}
            />
          </div>
        )}

        {p.stage === "watermark_region" && p.videoId && (
          <div className="mb-5">
            <WatermarkRegionSelector
              videoId={p.videoId}
              onConfirm={(regions) => {
                if (regions.length > 0) confirmWatermarkRegions(p.id, regions);
              }}
            />
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

        {p.thumbnailReview?.waiting && p.thumbnailReview.imageUrl && (
          <div className="mb-5 p-4 bg-white rounded-xl border border-stone-200 shadow-sm">
            <p className="text-[12px] font-semibold text-ink mb-3">
              Duyệt thumbnail ChatGPT
            </p>
            <div className="flex gap-4 items-start flex-wrap">
              <img
                src={p.thumbnailReview.imageUrl}
                alt="Thumbnail preview"
                className="w-48 h-auto rounded-lg border border-stone-200 object-cover"
              />
              <div className="flex flex-col gap-2 min-w-[180px]">
                <ThumbnailReviewActions
                  onAccept={() => confirmThumbnailReview(p.id, "accept")}
                  onSkip={() => confirmThumbnailReview(p.id, "skip")}
                  onRegenerate={(extra) =>
                    confirmThumbnailReview(p.id, "accept", extra)
                  }
                />
              </div>
            </div>
          </div>
        )}

        {p.thumbnailFallback?.waiting && (
          <div className="mb-5 p-4 bg-white rounded-xl border border-stone-200 shadow-sm flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-ink">
                ChatGPT không tạo được ảnh thumbnail
              </p>
              <p className="text-[11px] text-ink-muted mt-0.5">
                Đổi sang fal.ai để tạo thumbnail, hoặc bỏ qua bước này.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => resolveThumbnailFallback(p.id, "fal")}
                className="btn-island-primary text-[11px] !px-3 !py-1.5 cursor-pointer"
              >
                Đổi qua FAL
              </button>
              <button
                onClick={() => resolveThumbnailFallback(p.id, "skip")}
                className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
              >
                Bỏ qua
              </button>
            </div>
          </div>
        )}

        {p.needChatgptLogin && (
          <div className="mb-5 p-4 bg-amber-50 rounded-lg border border-amber-200 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-warn">
                {tr("pipeline.chatgptNeedLogin")}
              </p>
              <p className="text-[11px] text-warn mt-0.5">
                {tr("pipeline.chatgptNeedLoginHint")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => chatgptLogin()}
                className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
              >
                <span className="tracking-tight">{tr("pipeline.chatgptOpenProfile")}</span>
              </button>
              <button
                onClick={() => {
                  updatePipeline(p.id, { needChatgptLogin: false, status: "running", stage: "done" });
                  rerunPipeline(p.id, 12);
                }}
                className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer"
              >
                {tr("pipeline.skipStep")}
              </button>
              <button
                onClick={() => rerunPipeline(p.id, 11)}
                className="px-3 py-1.5 text-[11px] font-medium bg-warn text-white rounded-full hover:bg-warn transition-colors cursor-pointer"
              >
                {tr("pipeline.retryStep")}
              </button>
            </div>
          </div>
        )}

        {p.status !== "queued" && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
                {tr("pipeline.overallProgress")}
              </span>
              <span className="text-[12px] font-mono tabular-nums text-accent font-semibold">
                {p.status === "done"
                  ? 100
                  : p.status === "error"
                    ? 0
                    : p.progress}
                %
              </span>
            </div>
            <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  p.status === "error"
                    ? "bg-danger"
                    : p.status === "done"
                      ? "bg-success"
                      : "bg-accent"
                }`}
                style={{
                  width: `${p.status === "done" ? 100 : p.status === "error" ? 0 : Math.max(p.progress, 2)}%`,
                }}
              />
            </div>
          </div>
        )}

        <div className="relative">
          <div className="absolute left-[11px] top-6 bottom-6 w-[2px] bg-white/[0.08]" />
          <div className="space-y-1">
          {STEPS.map((s, i) => {
            const done = i < activeStep || p.status === "done";
            const isFailed =
              p.status === "error" && failedStep != null && i === failedStep;
            const active = i === activeStep && p.status !== "done" && !isFailed;
            const start = p.stepStarts[i];
            const end = p.stepEnds[i];
            const skipped = p.stepSkipped[i];
            const stepPct = p.stepProgress[i] ?? (done || isFailed ? 100 : 0);
            let stepTime: string | null = null;
            if (skipped) stepTime = tr("pipeline.skipped");
            else if (start != null && end != null)
              stepTime = fmtElapsed(end - start);
            else if (start != null) stepTime = fmtElapsed(now - start);

            return (
              <div key={s.label} className="flex items-center gap-3 relative">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                    skipped
                      ? "bg-white/[0.05] text-ink-light"
                      : isFailed
                        ? "bg-danger-muted text-danger"
                        : done
                          ? "bg-success/15 text-success"
                          : active
                            ? "bg-accent-muted text-accent"
                            : "bg-white/[0.05] text-ink-light"
                  }`}
                >
                  {skipped ? (
                    <span className="text-[11px]">–</span>
                  ) : isFailed ? (
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
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
                    <p
                      className={`text-[13px] font-medium ${isFailed ? "text-danger" : done || active ? "text-ink" : "text-ink-light"}`}
                    >
                      {STEP_LABEL_KEYS[i] ? tr(STEP_LABEL_KEYS[i]) : s.label}
                    </p>
                    <span
                      className={`text-[11px] font-mono tabular-nums flex-shrink-0 ${
                        skipped
                          ? "text-ink-light"
                          : isFailed
                            ? "text-danger"
                            : done
                              ? "text-success"
                              : active
                                ? "text-accent"
                                : "text-ink-light"
                      }`}
                    >
                      {skipped
                        ? "—"
                        : isFailed
                          ? tr("pipeline.errorLabel")
                          : `${stepPct}%`}
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-light">
                    {isFailed || active
                      ? stepDetail(p, tr)
                      : STEP_DETAIL_KEYS[i]
                        ? tr(STEP_DETAIL_KEYS[i])
                        : s.detail}
                  </p>
                  {i === 11 && p.autoUploadYoutube && (active || done) && (
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-ink-light flex-shrink-0">
                        {tr("pipeline.youtubeChannel")}
                      </span>
                      <select
                        value={p.youtubeChannel || ""}
                        onChange={(e) => updatePipeline(p.id, { youtubeChannel: e.target.value })}
                        className="input-field max-w-[200px] !py-1 !text-[12px]"
                      >
                        <option value="">{tr("pipeline.youtubeChannelDefault")}</option>
                        {ytChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>
                            {ch.name}
                          </option>
                        ))}
                      </select>
                      {p.watermark && (
                        <>
                          <span className="text-[11px] text-ink-light flex-shrink-0">
                            {tr("pipeline.watermarkSet")}
                          </span>
                          <select
                            value={p.watermarkPreset || ""}
                            onChange={async (e) => {
                              const presetId = e.target.value;
                              // Lưu active preset về backend trước (giống Settings),
                              // rồi mới cập nhật pipeline + tiếp tục luồng.
                              if (presetId) {
                                try {
                                  await setActiveWatermarkPreset(presetId);
                                } catch {
                                  // ignore — vẫn áp cho lần chạy hiện tại
                                }
                              }
                              updatePipeline(p.id, { watermarkPreset: presetId });
                            }}
                            className="input-field max-w-[200px] !py-1 !text-[12px]"
                          >
                            <option value="">{tr("pipeline.watermarkNone")}</option>
                            {presets.map((pr) => (
                              <option key={pr.id} value={pr.id}>
                                {pr.name}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>
                  )}
                  {(active || done) && !skipped && (
                    <div className="mt-1.5 h-1 rounded-full bg-white/[0.08] overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          done ? "bg-success" : "bg-accent"
                        }`}
                        style={{ width: `${stepPct}%` }}
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {active && (
                    <span className="text-[11px] font-mono text-ink-light tabular-nums">
                      {stepPct}%
                    </span>
                  )}
                  {stepTime && (
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        skipped
                          ? "text-ink-light"
                          : isFailed
                            ? "text-danger"
                            : active
                              ? "text-accent"
                              : "text-success"
                      }`}
                    >
                      {stepTime}
                    </span>
                  )}
                  {canRerun && (i >= 4 || Boolean(p.url)) && (
                    <button
                      onClick={() => rerunPipeline(p.id, i === 12 ? 9 : i)}
                      title={
                        i === 12
                          ? tr("pipeline.rerunFrom", {
                              label: tr("pipeline.step.label.mux"),
                            })
                          : tr("pipeline.rerunFrom", {
                              label: STEP_LABEL_KEYS[i]
                                ? tr(STEP_LABEL_KEYS[i])
                                : s.label,
                            })
                      }
                      className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-accent-muted text-accent ring-1 ring-accent/15 hover:bg-accent/15 transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-3 h-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                      {tr("pipeline.rerun")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          </div>
        </div>

        {p.logs.length > 0 && (
          <div className="mt-4 rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08] overflow-hidden">
            <div className="px-4 py-2 border-b border-white/[0.07] bg-white/[0.03] flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-ink-muted">
                {tr("pipeline.logHeader", { count: p.logs.length })}
              </span>
              <span className="text-[10px] font-mono text-ink-light tabular-nums">
                {tr("pipeline.logTime")}{" "}
                {p.startedAt
                  ? fmtElapsed(
                      (p.status === "done" || p.status === "error"
                        ? (p.finishedAt ?? now)
                        : now) - p.startedAt,
                    )
                  : "—"}
              </span>
            </div>
            <div
              ref={logRef}
              className="max-h-[240px] overflow-y-auto p-3 space-y-1"
            >
              {p.logs.map((l, i) => {
                const msg = typeof l === "string" ? l : l.message;
                const level = typeof l === "string" ? "info" : l.level;
                const ts = typeof l === "string" ? null : l.ts;
                const color =
                  level === "error"
                    ? "text-danger"
                    : level === "success"
                      ? "text-success"
                      : level === "warning"
                        ? "text-warn"
                        : "text-ink-muted";
                return (
                  <div key={i} className="flex items-start gap-2">
                    {ts != null && (
                      <span className="text-[10px] font-mono text-ink-light tabular-nums flex-shrink-0 mt-0.5">
                        {new Date(ts * 1000).toLocaleTimeString("vi-VN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    )}
                    <span
                      className={`text-[12px] font-mono leading-snug ${color}`}
                    >
                      {msg}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {p.error && (
          <div className="mt-4 p-3 rounded-xl bg-danger/8 ring-1 ring-danger/15 text-[12px] text-danger/80 whitespace-pre-wrap">
            {p.error}
          </div>
        )}

        {p.status === "done" && p.resultUrl && (
          <div className="mt-4">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <a
                href={p.resultUrl}
                download
                className="btn-island-primary group text-sm !px-5 !py-2.5"
              >
                <span className="tracking-tight">
                  {tr("pipeline.downloadFinalVideo")}
                </span>
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
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </span>
              </a>
              {p.dubbedUrl && p.videoId && (
                <a
                  href={getDubbedDownloadUrl(p.videoId)}
                  download
                  className="btn-island-primary group text-sm !px-5 !py-2.5"
                >
                  <span className="tracking-tight">
                    {tr("pipeline.downloadDubbedVoice")}
                  </span>
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
                      <path d="M11 5L6 9H2v6h4l5 4V5z" />
                      <path d="M15.54 8.46a5 5 0 010 7.07" />
                    </svg>
                  </span>
                </a>
              )}
              {p.videoId && (
                <a
                  href={getDownloadUrl(p.videoId, "srt")}
                  download
                  className="btn-island-primary group text-sm !px-5 !py-2.5"
                >
                  <span className="tracking-tight">
                    {tr("pipeline.downloadSrt")}
                  </span>
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
                      <path d="M4 4h16v16H4z" />
                      <path d="M9 8h6" />
                      <path d="M9 12h6" />
                      <path d="M9 16h4" />
                    </svg>
                  </span>
                </a>
              )}
              {p.videoId && (
                <ContextImagesButton videoId={p.videoId} />
              )}
              {p.updatedThumbnailUrl && (
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(p.updatedThumbnailUrl || "")
                  }
                  title={tr("pipeline.copyThumbnailTitle")}
                  className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-white/[0.04] ring-1 ring-white/[0.09] text-ink-muted hover:bg-white/[0.08] hover:text-ink transition-colors cursor-pointer"
                >
                  {tr("pipeline.copyThumbnail")}
                </button>
              )}
            </div>

            <iframe
              src={previewUrl}
              title={tr("pipeline.resultVideoTitle")}
              className="w-full aspect-video rounded-xl ring-1 ring-white/[0.09] bg-black"
              allow="autoplay; fullscreen"
              allowFullScreen
            />

            {onStartNext && (
              <div className="mt-5 pt-4 border-t border-white/[0.07] flex items-center justify-between gap-4 flex-wrap">
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  {tr("pipeline.donePrompt")}
                </p>
                <button
                  onClick={onStartNext}
                  className="btn-island-primary group text-sm !px-5 !py-2.5 flex-shrink-0"
                >
                  <span className="tracking-tight">
                    {tr("pipeline.processNextVideo")}
                  </span>
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
            style={{
              animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <p className="text-sm font-semibold text-ink mb-1">
                {tr("pipeline.cancelTitle")}
              </p>
              <p className="text-[12px] text-ink-muted leading-relaxed mb-5">
                {tr("pipeline.cancelBody")}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingCancel(false)}
                  className="btn-island-secondary btn-sm"
                >
                  {tr("pipeline.noContinue2")}
                </button>
                <button
                  onClick={() => {
                    setConfirmingCancel(false);
                    cancelPipeline(p.id);
                  }}
                  className="btn-island-danger btn-sm"
                >
                  {tr("pipeline.confirmCancelDelete")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {p.timelineCheck?.waiting && !p.timelineCheck.open && p.videoId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div
            className="double-bezel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            style={{
              animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-warn-muted flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-warn"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {tr("pipeline.timelineCheckTitle")}
                  </p>
                  <p className="text-[12px] text-ink-muted leading-relaxed mt-0.5">
                    {p.timelineCheck.issues.length > 0
                      ? tr("pipeline.timelineCheckIssues", {
                          count: p.timelineCheck.issues.length,
                        })
                      : tr("pipeline.timelineCheckOk")}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 mt-5">
                <button
                  onClick={() => resolveTimelineCheck(p.id, "continue")}
                  className="btn-island-secondary btn-sm"
                >
                  {tr("pipeline.timelineCheckContinue")}
                </button>
                <button
                  onClick={() => openTimelineCheck(p.id)}
                  className="btn-warn"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  {tr("pipeline.timelineCheckOpen")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {p.voiceCheck?.waiting && !p.voiceCheck.open && p.videoId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div
            className="double-bezel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            style={{
              animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-violet-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" />
                    <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {tr("pipeline.voiceCheckTitle")}
                  </p>
                  <p className="text-[12px] text-ink-muted leading-relaxed mt-0.5">
                    {tr("pipeline.voiceCheckHint")}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 mt-5">
                <button
                  onClick={() => resolveVoiceCheck(p.id, "continue")}
                  className="btn-island-secondary btn-sm"
                >
                  {tr("pipeline.voiceCheckSkip")}
                </button>
                <button
                  onClick={() => openVoiceCheck(p.id)}
                  className="btn-island-primary btn-sm"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" />
                    <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
                  </svg>
                  {tr("pipeline.voiceCheckOpen")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {p.timelineCheck?.waiting && p.timelineCheck.open && p.videoId && (
        <TimelineCheckModal
          videoId={p.videoId}
          initialIssues={p.timelineCheck.issues}
          targetLang={p.translateTarget || "vi"}
          sourceLang={p.srcLang || "zh"}
          onResolve={() => resolveTimelineCheck(p.id, "continue")}
          onClose={() => closeTimelineCheck(p.id)}
        />
      )}

      {p.voiceCheck?.waiting && p.voiceCheck.open && p.videoId && (
        <VoiceCheckModal
          videoId={p.videoId}
          targetLang={p.translateTarget || "vi"}
          dubbedAudioUrl={p.dubbedUrl}
          onResolve={() => resolveVoiceCheck(p.id, "continue")}
          onClose={() => closeVoiceCheck(p.id)}
        />
      )}

      <PreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={p.title || tr("pipeline.analyzing")}
        thumbnail={p.thumbnail}
        videoUrl={p.videoUrl}
        audioUrl={p.audioUrl}
        bigThumbs={p.bigThumbs}
      />
    </div>
  );
}


function ContextImagesButton({ videoId }: { videoId: string }) {
  const { t } = useI18n();
  const tr = makeT(t);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ContextImages | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!open || data || err) return;
    setLoading(true);
    getContextImages(videoId)
      .then(setData)
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, [open, data, err, videoId]);

  const hasAnything = !!(data && (data.thumbnail || data.images.length > 0));

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-island-primary group text-sm !px-5 !py-2.5"
      >
        <span className="tracking-tight">{tr("pipeline.imagesBtn")}</span>
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
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="double-bezel w-full max-w-3xl max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="double-bezel-inner flex flex-col min-h-0">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08] flex-shrink-0">
                <p className="text-sm font-semibold text-ink">
                  {tr("pipeline.imagesTitle")}
                </p>
                <button
                  onClick={() => setOpen(false)}
                  className="w-7 h-7 rounded-lg hover:bg-white/[0.08] text-ink-muted flex items-center justify-center cursor-pointer transition-colors"
                  aria-label={tr("btn.cancel")}
                >
                  ×
                </button>
              </div>

              <div className="overflow-y-auto scrollbar-thin p-5 space-y-5">
                {loading && (
                  <p className="text-[13px] text-ink-muted py-8 text-center">
                    {tr("status.loading")}
                  </p>
                )}
                {!loading && err && (
                  <p className="text-[13px] text-danger py-8 text-center">
                    {tr("result.failed")}
                  </p>
                )}
                {!loading && !err && !hasAnything && (
                  <p className="text-[13px] text-ink-light py-8 text-center">
                    {tr("pipeline.imagesEmpty")}
                  </p>
                )}
                {!loading && data?.thumbnail && (
                  <section>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-light mb-2">
                      {tr("pipeline.imagesCover")}
                    </p>
                    <a
                      href={data.thumbnail}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-xl overflow-hidden ring-1 ring-white/[0.12] hover:ring-accent/50 transition-colors"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={data.thumbnail}
                        alt={tr("pipeline.imagesCover")}
                        className="w-full max-h-[46vh] object-contain bg-black/40"
                      />
                    </a>
                  </section>
                )}
                {!loading && data && data.images.length > 0 && (
                  <section>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-light mb-2">
                      {tr("pipeline.imagesScenes")} ({data.images.length})
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {data.images.map((src) => (
                        <a
                          key={src}
                          href={src}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-lg overflow-hidden ring-1 ring-white/[0.1] hover:ring-accent/50 transition-colors aspect-video bg-black/40"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={src}
                            alt=""
                            loading="lazy"
                            className="w-full h-full object-cover hover:scale-[1.03] transition-transform duration-300"
                          />
                        </a>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
