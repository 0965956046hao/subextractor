"use client";

import { useEffect, useState } from "react";
import {
  getSrtEntries,
  getJobStatus,
  getTranslatedDownloadUrl,
  getMuxedDownloadUrl,
  updateSrt,
} from "@/lib/api";
import type { SrtEntry } from "@/lib/api";

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

function secToSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function entriesToSrt(entries: SrtEntry[]): string {
  return entries
    .map((e, i) => `${i + 1}\n${secToSrt(e.start)} --> ${secToSrt(e.end)}\n${e.text}\n`)
    .join("\n");
}

interface ToolJob {
  type: string;
  jobId: string;
  status: string;
  progress: number;
  error: string;
}

export default function TranslateTtsPanel({ videoId }: { videoId: string }) {
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [toolJob, setToolJob] = useState<ToolJob | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [transSrcLang, setTransSrcLang] = useState("zh");
  const [transDstLang, setTransDstLang] = useState("vi");
  const [ttsVoice, setTtsVoice] = useState("vi-VN-Standard-A");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [muxJob, setMuxJob] = useState<ToolJob | null>(null);
  const [muxedUrl, setMuxedUrl] = useState<string | null>(null);
  const [availableSrtFiles, setAvailableSrtFiles] = useState<{ id: string; name: string }[]>([]);
  const [availableTtsFiles, setAvailableTtsFiles] = useState<{ id: string; name: string; count?: number }[]>([]);
  const [dubbedUrl, setDubbedUrl] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsGeminiKey, setSettingsGeminiKey] = useState("");
  const [settingsTtsJson, setSettingsTtsJson] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [hasApiKeys, setHasApiKeys] = useState(false);
  const [selectedSrt, setSelectedSrt] = useState<{ id: string; name: string } | null>(null);
  const [selectedTts, setSelectedTts] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    getSrtEntries(videoId).then(setEntries).catch(() => {});
  }, [videoId]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => setHasApiKeys(d.has_gemini_key && d.has_tts_credentials))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/srt/${videoId}/available`)
      .then((r) => r.json())
      .then((d) => {
        if (d.files?.length) setAvailableSrtFiles(d.files);
      })
      .catch(() => {});
    fetch(`/api/tts/${videoId}/available`)
      .then((r) => r.json())
      .then((d) => {
        if (d.files?.length) setAvailableTtsFiles(d.files);
      })
      .catch(() => {});
  }, [videoId]);

  useEffect(() => {
    if (!toolJob || (toolJob.status !== "queued" && toolJob.status !== "processing")) return;
    const timer = setInterval(async () => {
      try {
        const st = await getJobStatus(toolJob.jobId);
        setToolJob((prev) => (prev ? { ...prev, status: st.status, progress: st.progress ?? 0, error: st.error || "" } : prev));
        if (st.status === "done" || st.status === "error") clearInterval(timer);
      } catch {
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [toolJob]);

  useEffect(() => {
    if (!muxJob || (muxJob.status !== "queued" && muxJob.status !== "processing")) return;
    const timer = setInterval(async () => {
      try {
        const st = await getJobStatus(muxJob.jobId);
        setMuxJob((prev) => (prev ? { ...prev, status: st.status, progress: st.progress ?? 0, error: st.error || "" } : prev));
        if (st.status === "done") {
          clearInterval(timer);
          setMuxedUrl(getMuxedDownloadUrl(videoId));
        } else if (st.status === "error") {
          clearInterval(timer);
        }
      } catch {
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [muxJob, videoId]);

  const loadSrtFile = async (fileId: string, fileName: string) => {
    try {
      const res = await fetch(`/api/srt/${videoId}/load/${fileId}`);
      const data = await res.json();
      const parsed = data.entries as SrtEntry[];
      if (parsed.length > 0) {
        setEntries(parsed);
        setSelectedSrt({ id: fileId, name: fileName });
        setSaved(false);
        setMuxedUrl(null);
        setToast(`Đã chọn "${fileName}" (${parsed.length} phụ đề)`);
        setTimeout(() => setToast(null), 2500);
      }
    } catch {
      // ignore
    }
  };

  const handleTtsSelect = (fileId: string, fileName: string) => {
    setSelectedTts({ id: fileId, name: fileName });
    setToast(`Đã chọn "${fileName}"`);
    setTimeout(() => setToast(null), 2500);
  };

  const handleApply = async () => {
    const msgs: string[] = [];
    if (selectedSrt) {
      try {
        await updateSrt(videoId, entriesToSrt(entries));
        setSaved(true);
        msgs.push(`Đã lưu phụ đề "${selectedSrt.name}"`);
      } catch {
        msgs.push("Lưu phụ đề thất bại");
      }
    }
    if (selectedTts) {
      if (selectedTts.id === "dubbed") {
        setDubbedUrl(`/api/download/dubbed/${videoId}`);
        msgs.push(`Đã áp dụng "${selectedTts.name}"`);
      } else {
        msgs.push(`Đã áp dụng "${selectedTts.name}"`);
      }
    }
    if (!msgs.length) {
      setToast("Chưa chọn SRT hoặc TTS để lưu");
    } else {
      setToast(msgs.join(" • "));
    }
    setTimeout(() => setToast(null), 2500);
  };

  const openSettings = async () => {
    setShowSettings(true);
    setSettingsStatus("");
    try {
      const res = await fetch("/api/config");
      const d = await res.json();
      setSettingsGeminiKey(d.has_gemini_key ? "••••••••" : "");
    } catch {
      // ignore
    }
  };

  const saveSettings = async () => {
    setSettingsStatus("Đang lưu...");
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_api_key:
            settingsGeminiKey && settingsGeminiKey !== "••••••••"
              ? settingsGeminiKey
              : "",
          google_tts_json: settingsTtsJson || "",
        }),
      });
      const d = await res.json();
      if (d.error) {
        setSettingsStatus(d.error);
      } else {
        setSettingsStatus("Đã lưu!");
        setTimeout(() => {
          setShowSettings(false);
          setSettingsStatus("");
        }, 1500);
        setHasApiKeys(true);
      }
    } catch {
      setSettingsStatus("Lỗi kết nối");
    }
  };

  const runToolJob = async (type: "translate" | "tts") => {
    const srtContent = entriesToSrt(entries);
    const endpoint = type === "tts" ? `/api/tts/${videoId}` : `/api/translate/${videoId}`;
    const body =
      type === "tts"
        ? { srt_content: srtContent, track_name: "Subtitle", voice: ttsVoice }
        : { srt_content: srtContent, source_lang: transSrcLang, target_lang: transDstLang };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setToolJob({ type, jobId: data.job_id, status: data.status, progress: data.progress || 0, error: data.error || "" });
      setSaved(false);
      setMuxedUrl(null);
    } catch {
      // ignore
    }
  };

  const fetchTranslatedText = async (): Promise<string> => {
    const res = await fetch(getTranslatedDownloadUrl(videoId));
    return res.text();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const text = await fetchTranslatedText();
      await updateSrt(videoId, text);
      setSaved(true);
      setToast("Đã lưu phụ đề dịch");
    } catch {
      setToast("Lưu thất bại");
    }
    setSaving(false);
    setTimeout(() => setToast(null), 2500);
  };

  const handleApplySrt = async () => {
    setMuxedUrl(null);
    try {
      const text = await fetchTranslatedText();
      await updateSrt(videoId, text);
      setSaved(true);
      const res = await fetch(`/api/mux/${videoId}`, { method: "POST" });
      const data = await res.json();
      setMuxJob({ type: "mux", jobId: data.job_id, status: data.status, progress: data.progress || 0, error: data.error || "" });
    } catch {
      setToast("Áp dụng thất bại");
      setTimeout(() => setToast(null), 2500);
    }
  };

  const translateDone = toolJob?.type === "translate" && toolJob.status === "done";

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-5 sm:p-6">
        {/* Toolbar — Dịch (Gemini) + Lồng tiếng (TTS) */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={transSrcLang}
              onChange={(e) => setTransSrcLang(e.target.value)}
              className="rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12px] text-ink cursor-pointer"
            >
              <option value="zh">Trung</option>
              <option value="en">Anh</option>
              <option value="ja">Nhật</option>
              <option value="ko">Hàn</option>
            </select>
            <span className="text-[12px] text-ink-light">→</span>
            <select
              value={transDstLang}
              onChange={(e) => setTransDstLang(e.target.value)}
              className="rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12px] text-ink cursor-pointer"
            >
              <option value="vi">Việt</option>
              <option value="en">Anh</option>
              <option value="zh">Trung</option>
            </select>
            <button
              onClick={() => runToolJob("translate")}
              disabled={!!toolJob && toolJob.status !== "done" && toolJob.status !== "error"}
              className="btn-island-primary group !px-4 !py-2 text-[12px]"
            >
              <span className="tracking-tight">Dịch (Gemini)</span>
            </button>

            <span className="text-[11px] text-ink-light ml-1">Giọng:</span>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              className="rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12px] text-ink cursor-pointer"
            >
              <option value="vi-VN-Standard-A">Nữ A</option>
              <option value="vi-VN-Standard-B">Nam B</option>
              <option value="vi-VN-Standard-C">Nữ C</option>
              <option value="vi-VN-Standard-D">Nam D</option>
              <option value="vi-VN-Wavenet-A">WaveNet Nữ A</option>
              <option value="vi-VN-Wavenet-B">WaveNet Nam B</option>
            </select>
            <button
              onClick={() => runToolJob("tts")}
              disabled={!!toolJob && toolJob.status !== "done" && toolJob.status !== "error"}
              className="px-3 py-2 rounded-full text-[12px] font-medium tracking-tight bg-cyan-500/10 text-cyan-700 ring-1 ring-cyan-500/20 hover:bg-cyan-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Lồng tiếng (TTS)
            </button>

            {availableSrtFiles.length > 0 && (
              <select
                onChange={(e) => {
                  const file = availableSrtFiles.find((f) => f.id === e.target.value);
                  if (file) loadSrtFile(file.id, file.name);
                  e.target.value = "";
                }}
                defaultValue=""
                className="rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-2 py-1.5 text-[12px] text-indigo-700 cursor-pointer"
              >
                <option value="" disabled>📂 Tải file SRT...</option>
                {availableSrtFiles.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            )}

            {availableTtsFiles.length > 0 && (
              <select
                onChange={(e) => {
                  const file = availableTtsFiles.find((f) => f.id === e.target.value);
                  if (file) handleTtsSelect(file.id, file.name);
                  e.target.value = "";
                }}
                defaultValue=""
                className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.06] px-2 py-1.5 text-[12px] text-cyan-700 cursor-pointer"
              >
                <option value="" disabled>🎙️ TTS...</option>
                {availableTtsFiles.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            )}

            <button
              onClick={openSettings}
              className={`px-3 py-2 rounded-full text-[12px] font-medium tracking-tight ring-1 transition-colors cursor-pointer ${
                hasApiKeys
                  ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 hover:bg-emerald-500/20"
                  : "bg-amber-500/10 text-amber-700 ring-amber-500/20 hover:bg-amber-500/20"
              }`}
            >
              ⚙️ Cấu hình API
            </button>

            <button
              onClick={handleApply}
              className="btn-island-primary group !px-4 !py-2 text-[12px]"
            >
              <IconCheck className="w-3.5 h-3.5" />
              <span className="tracking-tight">Lưu</span>
            </button>
          </div>
        </div>

        {/* Video lồng tiếng (dubbed) download */}
        {dubbedUrl && (
          <div className="mt-4 p-4 rounded-2xl bg-cyan-500/[0.04] ring-1 ring-cyan-500/[0.12] flex items-center gap-3">
            <IconCheck className="w-4 h-4 text-cyan-500 flex-shrink-0" />
            <a
              href={dubbedUrl}
              download
              className="px-4 py-2 rounded-full text-[12px] font-medium bg-cyan-600 text-white hover:bg-cyan-500 transition-colors cursor-pointer"
            >
              Tải video lồng tiếng
            </a>
          </div>
        )}

        {/* Job progress banner */}
        {toolJob && (
          <div className="mt-4 p-4 rounded-2xl bg-blue-500/[0.03] ring-1 ring-blue-500/[0.08]">
            <div className="flex items-center gap-3">
              {toolJob.status === "queued" || toolJob.status === "processing" ? (
                <>
                  <IconSpinner className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <span className="text-[12px] font-medium text-ink-muted flex-1">
                    {toolJob.type === "translate" ? "Đang dịch..." : "Đang tổng hợp giọng nói..."}
                  </span>
                  <div className="w-32 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${Math.max(3, toolJob.progress)}%` }} />
                  </div>
                  <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-right">{toolJob.progress}%</span>
                </>
              ) : toolJob.status === "done" ? (
                <>
                  <IconCheck className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                  <span className="text-[12px] font-medium text-emerald-700 flex-1">
                    {toolJob.type === "translate" ? "Dịch hoàn tất" : "Hoàn tất"}
                  </span>
                </>
              ) : (
                <span className="text-[12px] font-medium text-red-600/80 flex-1">{toolJob.error || "Thất bại"}</span>
              )}
              <button onClick={() => setToolJob(null)} className="text-[11px] text-ink-light hover:text-ink transition-colors cursor-pointer">✕</button>
            </div>
          </div>
        )}

        {/* Sau khi dịch xong → Lưu + Apply SRT */}
        {translateDone && (
          <div className="mt-4 p-4 rounded-2xl bg-emerald-500/[0.04] ring-1 ring-emerald-500/[0.12]">
            <div className="flex items-center gap-2 mb-3">
              <IconCheck className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-[11px] font-medium text-emerald-700 uppercase tracking-wider">
                Phụ đề đã dịch xong
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-island-primary group !px-4 !py-2 text-[12px]"
              >
                {saving ? <IconSpinner className="w-3.5 h-3.5" /> : <IconCheck className="w-3.5 h-3.5" />}
                <span className="tracking-tight">{saved ? "Đã lưu" : "Lưu"}</span>
              </button>
              <button
                onClick={handleApplySrt}
                className="px-4 py-2 rounded-full text-[12px] font-medium tracking-tight bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer"
              >
                Apply SRT
              </button>
              <a
                href={getTranslatedDownloadUrl(videoId)}
                download
                className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-colors cursor-pointer"
              >
                Tải SRT Việt
              </a>
            </div>

            {muxJob && (
              <div className="mt-3 flex items-center gap-3">
                {muxJob.status === "queued" || muxJob.status === "processing" ? (
                  <>
                    <IconSpinner className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <span className="text-[12px] text-ink-muted">Đang nhúng phụ đề vào video...</span>
                    <span className="text-[10px] font-mono text-ink-light tabular-nums">{muxJob.progress}%</span>
                  </>
                ) : muxJob.status === "done" ? (
                  <a
                    href={muxedUrl || getMuxedDownloadUrl(videoId)}
                    download
                    className="px-4 py-2 rounded-full text-[12px] font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors cursor-pointer"
                  >
                    Tải video đã nhúng phụ đề
                  </a>
                ) : (
                  <span className="text-[12px] font-medium text-red-600/80">{muxJob.error || "Nhúng thất bại"}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/[0.15] backdrop-blur-sm"
          onClick={() => {
            setShowSettings(false);
            setSettingsStatus("");
          }}
        >
          <div
            className="double-bezel !rounded-2xl w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "scale-in 0.3s ease-[cubic-bezier(0.32,0.72,0,1)] forwards" }}
          >
            <div className="double-bezel-inner !rounded-[calc(1rem-1px)] p-6">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-semibold text-ink">⚙️ Cấu hình API</span>
                <button
                  onClick={() => {
                    setShowSettings(false);
                    setSettingsStatus("");
                  }}
                  className="w-6 h-6 rounded-full bg-black/[0.04] flex items-center justify-center hover:bg-black/[0.08] transition-all duration-300 cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1 block">
                    Gemini API Key
                  </label>
                  <input
                    type="password"
                    value={settingsGeminiKey}
                    onChange={(e) => setSettingsGeminiKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <p className="text-[9px] text-ink-light mt-1">
                    Lấy tại{" "}
                    <a href="https://aistudio.google.com/apikey" target="_blank" className="text-blue-500 underline">
                      aistudio.google.com/apikey
                    </a>
                  </p>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1 block">
                    Google Cloud TTS (Service Account JSON)
                  </label>
                  <textarea
                    value={settingsTtsJson}
                    onChange={(e) => setSettingsTtsJson(e.target.value)}
                    placeholder='{"type": "service_account", "project_id": "..."}'
                    rows={4}
                    className="w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-[11px] text-ink font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <p className="text-[9px] text-ink-light mt-1">
                    Google Cloud → IAM → Service Accounts → Create Key → JSON
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between mt-4">
                <span
                  className={`text-[11px] ${
                    settingsStatus.includes("Đã lưu")
                      ? "text-emerald-600"
                      : settingsStatus.includes("Lỗi") || settingsStatus.includes("không")
                      ? "text-red-500"
                      : "text-ink-light"
                  }`}
                >
                  {settingsStatus || ""}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowSettings(false);
                      setSettingsStatus("");
                    }}
                    className="px-4 py-1.5 rounded-full text-[11px] font-medium text-ink-muted hover:bg-black/[0.04] transition-all duration-300 cursor-pointer active:scale-[0.97]"
                  >
                    Đóng
                  </button>
                  <button
                    onClick={saveSettings}
                    className="px-4 py-1.5 rounded-full text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all duration-300 cursor-pointer active:scale-[0.97]"
                  >
                    Lưu
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-ink/90 text-white text-xs font-medium shadow-lg" style={{ animation: "fade-in 0.2s ease forwards" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
