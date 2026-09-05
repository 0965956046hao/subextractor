"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getSrtEntries,
  getVoiceMapDetail,
  generateVoiceMap,
  updateVoiceMapLine,
  regenerateTtsLine,
  rebuildFullAudio,
  bulkSwitchVoice,
  getCapCutVoices,
  checkTtsAlignment,
  setTtsSpeed,
  getTtsAudioUrl,
  rewriteSrtLine,
  capCutPreview,
  getVideoUrl,
} from "@/lib/api";
import type { SrtEntry, VoiceMapDetail, CapCutVoice, AlignmentIssue } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function IconSpinner({ className = "w-4 h-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconSpeaker({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
    </svg>
  );
}

function secToSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

interface VoiceCheckModalProps {
  videoId: string;
  targetLang?: string;
  dubbedAudioUrl?: string | null;
  onResolve: (action: "continue") => void;
  onClose: () => void;
}

export default function VoiceCheckModal({
  videoId,
  targetLang = "vi",
  dubbedAudioUrl,
  onResolve,
  onClose,
}: VoiceCheckModalProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [voiceMap, setVoiceMap] = useState<VoiceMapDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [previewingIndex, setPreviewingIndex] = useState(-1);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [videoDuration, setVideoDuration] = useState(0);
  const [switchingIndex, setSwitchingIndex] = useState<number | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [bulkFrom, setBulkFrom] = useState("");
  const [bulkTo, setBulkTo] = useState("");
  const [bulkApplying, setBulkApplying] = useState(false);
  const [allVoices, setAllVoices] = useState<CapCutVoice[]>([]);
  const [bulkFromOpen, setBulkFromOpen] = useState(false);
  const [bulkToOpen, setBulkToOpen] = useState(false);
  const [bulkPreviewing, setBulkPreviewing] = useState<string | null>(null);
  const [alignmentIssues, setAlignmentIssues] = useState<AlignmentIssue[]>([]);
  const [checkingAlignment, setCheckingAlignment] = useState(false);
  const [showAlignment, setShowAlignment] = useState(false);
  const [speedingIndex, setSpeedingIndex] = useState<number | null>(null);
  const [speedValues, setSpeedValues] = useState<Record<number, number>>({});
  const [previewSpeedIndex, setPreviewSpeedIndex] = useState<number | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [rewritingIndex, setRewritingIndex] = useState<number | null>(null);
  const [regenAudioIndex, setRegenAudioIndex] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const langMap: Record<string, string> = {
    vi: "vi-VN", en: "en-US", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR",
  };

  // Fetch all CapCut voices for the target language
  useEffect(() => {
    let cancelled = false;
    getCapCutVoices(langMap[targetLang] || "vi-VN")
      .then((voices) => { if (!cancelled) setAllVoices(voices); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [targetLang]);

  const handlePreviewSpeed = useCallback((index: number, speed: number) => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    if (previewSpeedIndex === index) {
      setPreviewSpeedIndex(null);
      return;
    }
    const audio = new Audio(getTtsAudioUrl(videoId, index));
    audio.playbackRate = speed;
    audio.onended = () => { setPreviewSpeedIndex(null); };
    audio.onerror = () => { setPreviewSpeedIndex(null); };
    previewAudioRef.current = audio;
    setPreviewSpeedIndex(index);
    audio.play().catch(() => setPreviewSpeedIndex(null));
  }, [videoId, previewSpeedIndex]);

  const handleSetSpeed = useCallback(async (index: number, speed: number) => {
    setSpeedingIndex(index);
    setError("");
    try {
      const res = await setTtsSpeed(videoId, index, speed);
      // Update the issue with new duration, remove if no longer an issue
      setAlignmentIssues((prev) =>
        prev.map((issue) =>
          issue.index === index
            ? { ...issue, audio_duration: res.new_duration, overshoot: Math.max(0, res.new_duration - issue.srt_duration) }
            : issue
        ).filter((issue) => issue.overshoot > 0.1)
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.speedFailed" as string));
    } finally {
      setSpeedingIndex(null);
    }
  }, [videoId, t]);

  const handleRewrite = useCallback(async (index: number, mode: "shorter" | "manual", manualText?: string) => {
    setRewritingIndex(index);
    setError("");
    try {
      const currentEntry = entries.find(e => e.index === index);
      const res = await rewriteSrtLine(videoId, index, mode, currentEntry?.text, manualText);
      setEntries(prev => prev.map(e => e.index === index ? { ...e, text: res.text } : e));
      setEditingIndex(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.rewriteFailed" as string));
    } finally {
      setRewritingIndex(null);
    }
  }, [videoId, entries, t]);

  const handleRegenAudio = useCallback(async (index: number) => {
    setRegenAudioIndex(index);
    setError("");
    try {
      const voiceType = voiceMap?.map?.[String(index)]?.voice_type || "";
      await regenerateTtsLine(videoId, index, voiceType);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.rebuildFailed" as string));
    } finally {
      setRegenAudioIndex(null);
    }
  }, [videoId, voiceMap, t]);

  const handleCheckAlignment = useCallback(async () => {
    setCheckingAlignment(true);
    setError("");
    try {
      const res = await checkTtsAlignment(videoId, targetLang);
      setAlignmentIssues(res.issues);
      setShowAlignment(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.alignmentCheckFailed" as string));
    } finally {
      setCheckingAlignment(false);
    }
  }, [videoId, targetLang, t]);

  // Close bulk dropdowns on outside click
  useEffect(() => {
    if (!bulkFromOpen && !bulkToOpen) return;
    const handler = () => { setBulkFromOpen(false); setBulkToOpen(false); };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [bulkFromOpen, bulkToOpen]);

  // Sync video play/pause with dubbed audio
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || !dubbedAudioUrl) return;

    // Mute video — audio comes from the <audio> element
    video.muted = true;

    const syncPlay = () => { audio.play().catch(() => {}); };
    const syncPause = () => { audio.pause(); };
    const syncSeek = () => { audio.currentTime = video.currentTime; };

    video.addEventListener("play", syncPlay);
    video.addEventListener("pause", syncPause);
    video.addEventListener("seeking", syncSeek);

    return () => {
      video.removeEventListener("play", syncPlay);
      video.removeEventListener("pause", syncPause);
      video.removeEventListener("seeking", syncSeek);
    };
  }, [dubbedAudioUrl, mounted]);

  // Track audio time for SRT line highlighting
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    audio.addEventListener("timeupdate", onTimeUpdate);
    return () => audio.removeEventListener("timeupdate", onTimeUpdate);
  }, [mounted]);

  // Compute which line is currently playing based on currentTime
  const playingIndex = useMemo(() => {
    if (currentTime <= 0 || entries.length === 0) return -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (currentTime >= entries[i].start && currentTime <= entries[i].end) {
        return entries[i].index;
      }
    }
    return -1;
  }, [currentTime, entries]);

  // Load entries + voice map
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [es, vm] = await Promise.all([
          getSrtEntries(videoId),
          getVoiceMapDetail(videoId, targetLang),
        ]);
        if (cancelled) return;
        setEntries(es);
        setVoiceMap(vm);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t("voice.loadFailed" as string));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [videoId, targetLang]);

  // Unique voices used in the map (sorted by display_name)
  const uniqueVoices = useMemo(() => {
    if (!voiceMap?.map) return [];
    const seen = new Map<string, { voice_type: string; display_name: string }>();
    for (const v of Object.values(voiceMap.map)) {
      if (!seen.has(v.voice_type)) {
        seen.set(v.voice_type, v);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [voiceMap]);

  const handlePreview = useCallback(async (index: number, text: string, overrideVoiceType?: string) => {
    const voiceType = overrideVoiceType ?? voiceMap?.map?.[String(index)]?.voice_type;
    if (!voiceType) return;
    setPreviewingIndex(index);
    try {
      const blob = await capCutPreview(voiceType, text);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewingIndex(-1); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPreviewingIndex(-1); };
      await audio.play();
    } catch {
      setPreviewingIndex(-1);
    }
  }, [voiceMap]);

  const handleRegenerate = useCallback(async () => {
    setGenerating(true);
    setError("");
    try {
      await generateVoiceMap(videoId, targetLang);
      const vm = await getVoiceMapDetail(videoId, targetLang);
      setVoiceMap(vm);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.genFailed" as string));
    } finally {
      setGenerating(false);
    }
  }, [videoId, targetLang]);

  const handleSwitchVoice = useCallback(async (index: number, newVoiceType: string) => {
    setSwitchingIndex(index);
    try {
      // Update voice_map.json
      await updateVoiceMapLine(videoId, index, newVoiceType);
      // Regenerate TTS for this line with new voice
      await regenerateTtsLine(videoId, index, newVoiceType);
      // Update local state
      const newVoice = uniqueVoices.find((v) => v.voice_type === newVoiceType);
      const newDisplayName = newVoice?.display_name ?? newVoiceType;
      setVoiceMap((prev) => {
        if (!prev?.map) return prev;
        return {
          ...prev,
          map: {
            ...prev.map,
            [String(index)]: {
              voice_type: newVoiceType,
              display_name: newDisplayName,
            },
          },
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.switchFailed" as string));
    } finally {
      setSwitchingIndex(null);
    }
  }, [videoId, t, uniqueVoices]);

  const handleRebuildFullAudio = useCallback(async () => {
    setRebuilding(true);
    setError("");
    try {
      const res = await rebuildFullAudio(videoId);
      // Update the audio source to the new full audio
      if (audioRef.current) {
        audioRef.current.src = `/api/download/dubbed/${videoId}?t=${Date.now()}`;
        audioRef.current.load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.rebuildFailed" as string));
    } finally {
      setRebuilding(false);
    }
  }, [videoId, t]);

  const handleBulkSwitch = useCallback(async () => {
    if (!bulkFrom || !bulkTo || bulkFrom === bulkTo) return;
    setBulkApplying(true);
    setError("");
    try {
      // 1. Start background job
      const res = await bulkSwitchVoice(videoId, bulkFrom, bulkTo);
      const jobId = res.job_id;
      // 2. Poll job until done
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const statusRes = await fetch(`/api/status/${jobId}`);
          const statusData = await statusRes.json();
          if (statusData.status === "done") {
            done = true;
          } else if (statusData.status === "error") {
            throw new Error(statusData.error || "Job failed");
          } else if (statusData.status === "cancelled") {
            throw new Error("Job cancelled");
          }
        } catch (e) {
          if (e instanceof Error && e.message !== "Job failed" && e.message !== "Job cancelled") {
            // Network error, retry
            continue;
          }
          throw e;
        }
      }
      // 3. Reload voice map
      const vm = await getVoiceMapDetail(videoId, targetLang);
      setVoiceMap(vm);
      setBulkFrom("");
      setBulkTo("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.bulkFailed" as string));
    } finally {
      setBulkApplying(false);
    }
  }, [videoId, bulkFrom, bulkTo, targetLang, t]);

  const handleBulkPreview = useCallback(async (voiceType: string) => {
    setBulkPreviewing(voiceType);
    try {
      const blob = await capCutPreview(voiceType, t("voice.previewText" as string), langMap[targetLang] || "vi-VN");
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); setBulkPreviewing(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setBulkPreviewing(null); };
      await audio.play();
    } catch {
      setBulkPreviewing(null);
    }
  }, [t, targetLang, langMap]);

  const scrollToEntry = useCallback((index: number) => {
    const el = entryRefs.current.get(index);
    if (el && listRef.current) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, []);

  // Auto-scroll to the playing line
  useEffect(() => {
    if (playingIndex > 0) {
      scrollToEntry(playingIndex);
    }
  }, [playingIndex, scrollToEntry]);

  if (!mounted) return null;

  const lines = entries.map((e) => ({
    ...e,
    voice: voiceMap?.map?.[String(e.index)] ?? null,
  }));

  const assignedCount = lines.filter((l) => l.voice).length;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-6">
      <div
        className="double-bezel w-[90vw] max-w-[90vw] max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards" }}
      >
        <div className="double-bezel-inner p-4 sm:p-5 flex flex-col gap-4 min-h-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-full bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                <IconSpeaker className="w-5 h-5 text-violet-300" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{t("voice.title" as string)}</p>
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  {voiceMap?.exists
                    ? t("voice.assignedCount" as string, { assigned: assignedCount, total: entries.length })
                    : t("voice.noMap" as string)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCheckAlignment}
                disabled={generating || loading || checkingAlignment}
                className="px-3.5 py-2 rounded-full text-[12px] font-medium bg-accent text-white hover:bg-accent transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                title={t("voice.checkAlignment" as string)}
              >
                {checkingAlignment ? <IconSpinner className="w-3.5 h-3.5" /> : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                  </svg>
                )}
                {checkingAlignment ? t("voice.checking" as string) : t("voice.checkAlignment" as string)}
              </button>
              <button
                onClick={handleRebuildFullAudio}
                disabled={generating || loading || rebuilding}
                className="px-3.5 py-2 rounded-full text-[12px] font-medium bg-warn text-white hover:bg-warn-light transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                title={t("voice.rebuildFullAudio" as string)}
              >
                {rebuilding ? <IconSpinner className="w-3.5 h-3.5" /> : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 11-6.219-8.56" />
                    <path d="M21 3v6h-6" />
                  </svg>
                )}
                {rebuilding ? t("voice.rebuilding" as string) : t("voice.rebuildFullAudio" as string)}
              </button>
              <button
                onClick={handleRegenerate}
                disabled={generating || loading}
                className="px-3.5 py-2 rounded-full text-[12px] font-medium bg-violet-600 text-white hover:bg-violet-500 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {generating ? <IconSpinner className="w-3.5 h-3.5" /> : <IconSpeaker className="w-3.5 h-3.5" />}
                {generating ? t("voice.generating" as string) : t("voice.regenerate" as string)}
              </button>
              <button
                onClick={onClose}
                className="icon-btn"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl bg-danger-muted ring-1 ring-danger/15 px-3.5 py-2.5 text-[12px] text-danger">
              {error}
            </div>
          )}

          {/* Alignment issues panel */}
          {showAlignment && (
            <div className="rounded-xl bg-accent/5 ring-1 ring-accent/10 p-3.5 max-h-48 overflow-y-auto flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-semibold text-blue-800">
                  {alignmentIssues.length > 0
                    ? t("voice.alignmentIssuesFound" as string, { count: alignmentIssues.length })
                    : t("voice.alignmentOk" as string)}
                </p>
                <button
                  onClick={() => setShowAlignment(false)}
                  className="text-[10px] text-accent hover:text-accent cursor-pointer"
                >
                  {t("voice.close" as string)}
                </button>
              </div>
              {alignmentIssues.length > 0 && (
                <div className="divide-y divide-accent/10">
                  {alignmentIssues.map((issue) => {
                    const isSpeeding = speedingIndex === issue.index;
                    const suggestedSpeed = Math.min(issue.audio_duration / issue.srt_duration, 3.0);
                    const targetSpeed = speedValues[issue.index] ?? Math.ceil(suggestedSpeed * 10) / 10;
                    const newDur = (issue.audio_duration / targetSpeed).toFixed(1);
                    return (
                      <div
                        key={issue.index}
                        className="flex flex-col gap-1.5 py-2.5 px-1"
                      >
                        {/* Row 1: index + text + times + overshoot */}
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-accent-muted text-accent flex-shrink-0 cursor-pointer hover:bg-accent/20"
                            onClick={() => {
                              if (videoRef.current) videoRef.current.currentTime = issue.start;
                            }}
                          >
                            #{issue.index}
                          </span>
                          <span className="text-[11px] text-ink flex-1 line-clamp-1">{issue.text}</span>
                          <span className="text-[10px] text-accent font-mono flex-shrink-0">
                            {issue.srt_duration.toFixed(1)}s → {issue.audio_duration.toFixed(1)}s
                          </span>
                          <span className="text-[10px] font-medium text-danger bg-danger-muted px-1.5 py-0.5 rounded-full flex-shrink-0">
                            +{issue.overshoot.toFixed(1)}s
                          </span>
                        </div>
                        {/* Row 2: speed icon + slider + preview + save */}
                        <div className="flex items-center gap-2 ml-7">
                          {/* Speed icon */}
                          <svg className="w-3 h-3 text-ink-muted flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                          </svg>
                          <input
                            type="range"
                            min={1.0}
                            max={3.0}
                            step={0.05}
                            value={targetSpeed}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value);
                              setSpeedValues((prev) => ({ ...prev, [issue.index]: v }));
                            }}
                            disabled={isSpeeding}
                            className="flex-1 h-1.5 accent-accent cursor-pointer disabled:opacity-50"
                          />
                          <span className="text-[10px] font-mono text-accent bg-accent-muted px-1.5 py-0.5 rounded flex-shrink-0 min-w-[55px] text-center">
                            {targetSpeed.toFixed(2)}x → {newDur}s
                          </span>
                          <button
                            onClick={() => handleSetSpeed(issue.index, targetSpeed)}
                            disabled={isSpeeding || targetSpeed <= 1.0}
                            className="text-[10px] font-medium px-2 py-1 rounded-md bg-accent text-white hover:bg-accent transition-colors cursor-pointer disabled:opacity-40 flex-shrink-0 inline-flex items-center gap-1"
                          >
                            {isSpeeding ? <IconSpinner className="w-3 h-3" /> : (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                                <polyline points="17 21 17 13 7 13 7 21" />
                                <polyline points="7 3 7 8 15 8" />
                              </svg>
                            )}
                            {t("voice.save" as string)}
                          </button>
                          <button
                            onClick={() => handlePreviewSpeed(issue.index, targetSpeed)}
                            disabled={isSpeeding}
                            className={`w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors disabled:opacity-40 flex-shrink-0 ${
                              previewSpeedIndex === issue.index
                                ? "bg-accent text-white"
                                : "bg-accent/10 text-accent hover:bg-accent/20"
                            }`}
                            title={t("voice.preview" as string)}
                          >
                            {previewSpeedIndex === issue.index ? (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="4" width="4" height="16" rx="1" />
                                <rect x="14" y="4" width="4" height="16" rx="1" />
                              </svg>
                            ) : (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Body: video + voice list */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0 flex-1">
            {/* Left: video */}
            <div className="rounded-xl overflow-hidden bg-black ring-1 ring-white/15 flex flex-col min-h-0">
              <div className="relative w-full flex-1 min-h-0">
                <video
                  ref={videoRef}
                  src={getVideoUrl(videoId)}
                  controls
                  className="absolute inset-0 w-full h-full object-contain bg-black"
                  onLoadedMetadata={(e) => {
                    const d = (e.target as HTMLVideoElement).duration;
                    if (Number.isFinite(d) && d > 0) setVideoDuration(d);
                  }}
                />
                {dubbedAudioUrl && (
                  <audio ref={audioRef} src={dubbedAudioUrl} preload="auto" />
                )}
              </div>
              <div className="h-11 flex items-center justify-center px-3 border-t border-white/10 bg-white/[0.04] flex-shrink-0">
                <p className="max-w-full text-center text-white text-xs sm:text-sm font-medium leading-snug line-clamp-2">
                  {activeIndex > 0 ? entries.find((e) => e.index === activeIndex)?.text : "—"}
                </p>
              </div>
            </div>

            {/* Right: voice list */}
            <div className="flex flex-col min-h-0">
              {/* Bulk voice switch */}
              {uniqueVoices.length > 1 && (
                <div className="flex items-center gap-2 mb-2 p-2 rounded-lg bg-white/[0.04] ring-1 ring-white/[0.09]">
                  {/* From voice dropdown — only voices used in this video */}
                  <div className="relative flex-1 min-w-0">
                    <button
                      onClick={() => { setBulkFromOpen(!bulkFromOpen); setBulkToOpen(false); }}
                      className="w-full text-left text-[11px] font-medium px-2 py-1.5 rounded-md bg-white ring-1 ring-white/[0.11] text-ink cursor-pointer flex items-center justify-between gap-1"
                    >
                      <span className="truncate">{bulkFrom ? uniqueVoices.find((v) => v.voice_type === bulkFrom)?.display_name : t("voice.bulkFrom" as string)}</span>
                      <svg className="w-3 h-3 flex-shrink-0 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {bulkFromOpen && (
                      <div className="absolute z-50 top-full left-0 mt-1 w-full max-h-48 overflow-y-auto rounded-lg bg-white ring-1 ring-white/15 shadow-lg">
                        {uniqueVoices.map((v) => (
                          <div key={v.voice_type} className="flex items-center gap-1 px-2 py-1 hover:bg-white/[0.05] cursor-pointer">
                            <button
                              onClick={(e) => { e.stopPropagation(); setBulkFrom(v.voice_type); setBulkFromOpen(false); }}
                              className="flex-1 text-left text-[11px] text-ink truncate"
                            >
                              {v.display_name}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleBulkPreview(v.voice_type); }}
                              disabled={bulkPreviewing === v.voice_type}
                              className="w-5 h-5 rounded flex items-center justify-center text-violet-300 hover:bg-violet-500/10 cursor-pointer disabled:opacity-50 flex-shrink-0"
                            >
                              {bulkPreviewing === v.voice_type ? (
                                <IconSpinner className="w-3 h-3" />
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              )}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <svg className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  {/* To voice dropdown */}
                  <div className="relative flex-1 min-w-0">
                    <button
                      onClick={() => { setBulkToOpen(!bulkToOpen); setBulkFromOpen(false); }}
                      className="w-full text-left text-[11px] font-medium px-2 py-1.5 rounded-md bg-white ring-1 ring-white/[0.11] text-ink cursor-pointer flex items-center justify-between gap-1"
                    >
                      <span className="truncate">{bulkTo ? allVoices.find((v) => v.voice_type === bulkTo)?.display_name : t("voice.bulkTo" as string)}</span>
                      <svg className="w-3 h-3 flex-shrink-0 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {bulkToOpen && (
                      <div className="absolute z-50 top-full left-0 mt-1 w-full max-h-48 overflow-y-auto rounded-lg bg-white ring-1 ring-white/15 shadow-lg">
                        {allVoices.filter((v) => v.voice_type !== bulkFrom).map((v) => (
                          <div key={v.voice_type} className="flex items-center gap-1 px-2 py-1 hover:bg-white/[0.05] cursor-pointer">
                            <button
                              onClick={(e) => { e.stopPropagation(); setBulkTo(v.voice_type); setBulkToOpen(false); }}
                              className="flex-1 text-left text-[11px] text-ink truncate"
                            >
                              {v.display_name}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleBulkPreview(v.voice_type); }}
                              disabled={bulkPreviewing === v.voice_type}
                              className="w-5 h-5 rounded flex items-center justify-center text-violet-300 hover:bg-violet-500/10 cursor-pointer disabled:opacity-50 flex-shrink-0"
                            >
                              {bulkPreviewing === v.voice_type ? (
                                <IconSpinner className="w-3 h-3" />
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              )}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleBulkSwitch}
                    disabled={!bulkFrom || !bulkTo || bulkFrom === bulkTo || bulkApplying}
                    className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-warn text-white hover:bg-warn-light transition-colors cursor-pointer disabled:opacity-40 flex-shrink-0 inline-flex items-center gap-1"
                  >
                    {bulkApplying ? <IconSpinner className="w-3 h-3" /> : (
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    )}
                    {t("voice.bulkApply" as string)}
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
                  {t("voice.lineCount" as string, { count: entries.length })}
                </p>
                {uniqueVoices.length > 1 && (
                  <p className="text-[10px] text-ink-light">
                    {t("voice.clickToSwitch" as string)}
                  </p>
                )}
              </div>
              <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08] divide-y divide-black/[0.04]">
                {loading && (
                  <div className="flex items-center justify-center gap-2 p-6 text-[12px] text-ink-muted">
                    <IconSpinner className="w-4 h-4" /> {t("voice.loading" as string)}
                  </div>
                )}
                {!loading && lines.map((line) => {
                  const isPlaying = line.index === playingIndex;
                  const isActive = line.index === activeIndex || isPlaying;
                  const hasVoice = !!line.voice;
                  const isSwitching = switchingIndex === line.index;
                  return (
                    <div
                      key={line.index}
                      ref={(el) => {
                        if (el) entryRefs.current.set(line.index, el);
                        else entryRefs.current.delete(line.index);
                      }}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setActiveIndex(line.index);
                        // Seek video to this line's start time
                        if (videoRef.current && line.start > 0) {
                          videoRef.current.currentTime = line.start;
                        }
                        scrollToEntry(line.index);
                      }}
                      className={`group w-full text-left px-3 py-2.5 cursor-pointer transition-colors ${
                        isPlaying
                          ? "bg-violet-500/20 ring-1 ring-violet-500/30"
                          : isActive
                            ? "bg-violet-500/10"
                            : "hover:bg-white/[0.03]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">
                          #{line.index}
                        </span>
                        <span className="font-mono text-[10px] text-ink-light">
                          {secToSrt(line.start).replace(",", ".").slice(0, 11)} → {secToSrt(line.end).replace(",", ".").slice(0, 11)}
                        </span>
                        {/* Voice badge — click to expand voice selector */}
                        {hasVoice && uniqueVoices.length > 1 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedIndex(expandedIndex === line.index ? null : line.index);
                            }}
                            disabled={isSwitching}
                            className={`ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1 cursor-pointer transition-colors ${
                              expandedIndex === line.index
                                ? "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/30"
                                : "bg-success/15 text-success hover:bg-success/20"
                            }`}
                          >
                            {isSwitching ? (
                              <IconSpinner className="w-3 h-3" />
                            ) : (
                              <IconSpeaker className="w-3 h-3" />
                            )}
                            {line.voice!.display_name}
                            <svg className={`w-2.5 h-2.5 opacity-50 transition-transform ${expandedIndex === line.index ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        ) : (
                          <span
                            className={`ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                              hasVoice
                                ? "bg-success/15 text-success"
                                : "bg-danger-muted text-danger"
                            }`}
                          >
                            <IconSpeaker className="w-3 h-3" />
                            {hasVoice ? line.voice!.display_name : t("voice.missing" as string)}
                          </span>
                        )}
                      </div>
                      {editingIndex === line.index ? (
                        <div className="mt-1 flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={2}
                            className="text-[12px] leading-snug p-2 rounded-lg bg-white ring-1 ring-violet-400 text-ink resize-none focus:outline-none focus:ring-2 focus:ring-violet-500"
                            autoFocus
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRewrite(line.index, "manual", editText); }}
                              disabled={rewritingIndex === line.index || !editText.trim()}
                              className="text-[10px] font-medium px-2.5 py-1 rounded-md bg-violet-600 text-white hover:bg-violet-700 cursor-pointer disabled:opacity-40"
                            >
                              {rewritingIndex === line.index ? t("voice.rewriting" as string) : t("voice.saveEdit" as string)}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setEditingIndex(null); }}
                              className="text-[10px] px-2 py-1 rounded-md bg-white/[0.05] text-ink-muted hover:bg-white/[0.11] cursor-pointer"
                            >
                              {t("voice.cancel" as string)}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-1.5 mt-1 group">
                          <p className="text-[12px] leading-snug line-clamp-2 text-ink flex-1">{line.text}</p>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingIndex(line.index);
                              setEditText(line.text);
                            }}
                            className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center text-ink-light hover:text-violet-300 hover:bg-violet-500/10 cursor-pointer transition-all flex-shrink-0 mt-0.5"
                            title={t("voice.editText" as string)}
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRewrite(line.index, "shorter");
                            }}
                            disabled={rewritingIndex === line.index}
                            className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center text-ink-light hover:text-success hover:bg-success/10 cursor-pointer transition-all flex-shrink-0 mt-0.5 disabled:opacity-40"
                            title={t("voice.genShorter" as string)}
                          >
                            {rewritingIndex === line.index ? (
                              <IconSpinner className="w-3 h-3" />
                            ) : (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                                <path d="M21 3v5h-5" />
                              </svg>
                            )}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRegenAudio(line.index);
                            }}
                            disabled={regenAudioIndex === line.index}
                            className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center text-ink-light hover:text-accent hover:bg-accent-muted cursor-pointer transition-all flex-shrink-0 mt-0.5 disabled:opacity-40"
                            title={t("voice.regenAudio" as string)}
                          >
                            {regenAudioIndex === line.index ? (
                              <IconSpinner className="w-3 h-3" />
                            ) : (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" x2="12" y1="19" y2="22" />
                              </svg>
                            )}
                          </button>
                        </div>
                      )}
                      {/* Expanded voice selector */}
                      {expandedIndex === line.index && hasVoice && uniqueVoices.length > 1 && (
                        <div className="mt-2 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {uniqueVoices.map((uv) => {
                            const isCurrent = uv.voice_type === line.voice?.voice_type;
                            return (
                              <div
                                key={uv.voice_type}
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors ${
                                  isCurrent
                                    ? "bg-violet-600 text-white"
                                    : "bg-white/[0.05] text-ink-muted hover:bg-violet-500/15 hover:text-violet-300"
                                }`}
                              >
                                <span>{uv.display_name}</span>
                                {/* Preview this voice */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handlePreview(line.index, line.text, uv.voice_type);
                                  }}
                                  disabled={previewingIndex === line.index}
                                  className={`w-4 h-4 rounded-full flex items-center justify-center cursor-pointer disabled:opacity-50 ${
                                    isCurrent ? "hover:bg-white/20" : "hover:bg-white/[0.08]"
                                  }`}
                                  title={t("voice.preview" as string)}
                                >
                                  {previewingIndex === line.index ? (
                                    <IconSpinner className="w-2.5 h-2.5" />
                                  ) : (
                                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                                      <path d="M8 5v14l11-7z" />
                                    </svg>
                                  )}
                                </button>
                                {/* Select this voice */}
                                {!isCurrent && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSwitchVoice(line.index, uv.voice_type);
                                      setExpandedIndex(null);
                                    }}
                                    disabled={isSwitching}
                                    className="w-4 h-4 rounded-full flex items-center justify-center cursor-pointer hover:bg-white/[0.08] disabled:opacity-50"
                                    title={t("voice.selectVoice" as string)}
                                  >
                                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M5 12l5 5L20 7" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex items-center justify-between mt-1 gap-2">
                        <p className="text-[10px] text-ink-light font-mono truncate">{line.voice?.voice_type ?? "—"}</p>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {/* Preview button */}
                          {hasVoice && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePreview(line.index, line.text);
                              }}
                              disabled={previewingIndex === line.index}
                              className="text-[10px] font-medium text-violet-300 hover:text-violet-500 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-60"
                            >
                              {previewingIndex === line.index ? (
                                <IconSpinner className="w-3 h-3" />
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M8 5v14l11-7z" />
                                </svg>
                              )}
                              {t("voice.preview" as string)}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!loading && lines.length === 0 && !error && (
                  <p className="text-[12px] text-ink-light p-4">{t("voice.noSubtitles" as string)}</p>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onClose}
              className="mr-auto btn-island-secondary btn-sm"
            >
              {t("voice.close" as string)}
            </button>
            <button
              onClick={() => onResolve("continue")}
              disabled={generating}
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-success text-white hover:bg-success-light transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {generating && <IconSpinner className="w-3.5 h-3.5" />}
              {t("voice.continue" as string)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
