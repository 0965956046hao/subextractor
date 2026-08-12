"use client";

import { useState, useEffect, useCallback } from "react";
import { getVideoUrl, getJobStatus } from "@/lib/api";

function IconSparkle({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
      <path d="M5 19l.5-2L7 17l-1.5-.5L5 16l-.5 2L3 18l2 .5L5 19z" />
    </svg>
  );
}

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
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconError({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

interface ContextPanelProps {
  videoId: string;
}

export default function ContextPanel({ videoId }: ContextPanelProps) {
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genJobId, setGenJobId] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState(0);
  const [genError, setGenError] = useState("");
  const [showFileStore, setShowFileStore] = useState(false);
  const [geminiFiles, setGeminiFiles] = useState<{ name: string; display_name: string; size_bytes: number }[]>([]);
  const [fileStoreLoading, setFileStoreLoading] = useState(false);

  // Load existing context
  const loadContext = useCallback(async () => {
    try {
      const res = await fetch(`/api/context/${videoId}`);
      const data = await res.json();
      setContext(data.context || "");
    } catch {
      // ignore
    }
    setLoading(false);
  }, [videoId]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  // Poll generation job
  useEffect(() => {
    if (!genJobId) return;
    const poll = async () => {
      try {
        const st = await getJobStatus(genJobId);
        setGenProgress(st.progress || 0);
        if (st.status === "done") {
          setGenerating(false);
          setGenJobId(null);
          loadContext();
        } else if (st.status === "error") {
          setGenerating(false);
          setGenJobId(null);
          setGenError(st.error || "Lỗi tạo ngữ cảnh");
        }
      } catch {
        // ignore
      }
    };
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, [genJobId, loadContext]);

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError("");
    try {
      const res = await fetch(`/api/context/${videoId}/generate`, { method: "POST" });
      const data = await res.json();
      if (data.job_id) {
        setGenJobId(data.job_id);
      } else {
        setGenerating(false);
        setGenError("Không thể tạo job");
      }
    } catch {
      setGenerating(false);
      setGenError("Lỗi kết nối");
    }
  };

  const loadGeminiFiles = async () => {
    setFileStoreLoading(true);
    try {
      const res = await fetch(`/api/gemini/files?video_id=${encodeURIComponent(videoId)}`);
      const data = await res.json();
      setGeminiFiles(data.files || []);
    } catch {
      // ignore
    }
    setFileStoreLoading(false);
  };

  const deleteGeminiFile = async (name: string) => {
    try {
      await fetch(`/api/gemini/files/${encodeURIComponent(name)}`, { method: "DELETE" });
      setGeminiFiles((prev) => prev.filter((f) => f.name !== name));
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-16 flex flex-col items-center justify-center gap-4">
          <IconSpinner className="w-6 h-6 text-blue-500" />
          <span className="text-sm text-ink-muted">Đang tải ngữ cảnh...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-5">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${context ? "bg-violet-500/10 ring-1 ring-violet-500/20" : "bg-black/[0.03]"}`}>
              <IconSparkle className={`w-4 h-4 ${context ? "text-violet-500" : "text-ink-light"}`} />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">Ngữ cảnh video</p>
              <p className="text-[11px] text-ink-light">
                {context ? "Gemini Vision đã phân tích video" : "Chưa có ngữ cảnh"}
              </p>
            </div>
          </div>

          <button
            onClick={handleGenerate}
            disabled={generating}
            className="btn-island-primary group text-sm !px-5 !py-2.5"
          >
            <IconSparkle className="w-3.5 h-3.5" />
            <span className="tracking-tight">
              {generating ? (genProgress > 0 ? `Đang phân tích ${genProgress}%` : "Đang phân tích...") : context ? "Phân tích lại" : "Phân tích video"}
            </span>
            {!generating && (
              <span className="btn-island-icon">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
                </svg>
              </span>
            )}
          </button>
        </div>

        {generating && (
          <div className="mb-5 p-4 rounded-2xl bg-violet-500/[0.04] ring-1 ring-violet-500/[0.1]">
            <div className="flex items-center gap-3">
              <IconSpinner className="w-4 h-4 text-violet-500 flex-shrink-0" />
              <span className="text-[12px] text-ink-muted flex-1">
                Đang upload ảnh snapshot lên Gemini và phân tích ngữ cảnh...
              </span>
              <div className="w-24 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
                  style={{ width: `${Math.max(3, genProgress)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {genError && (
          <div className="mb-5 flex items-start gap-3 p-4 rounded-2xl bg-red-500/8 ring-1 ring-red-500/15">
            <IconError className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-[12px] text-red-600/80">{genError}</p>
          </div>
        )}

        {context ? (
          <div className="rounded-2xl bg-violet-500/[0.03] ring-1 ring-violet-500/[0.1] p-5">
            <p className="text-[13px] leading-relaxed text-ink/85 whitespace-pre-wrap">
              {context}
            </p>
          </div>
        ) : !generating && !genError ? (
          <div className="rounded-2xl bg-black/[0.015] ring-1 ring-black/[0.04] p-8 text-center">
            <IconSparkle className="w-8 h-8 text-ink-light mx-auto mb-3 opacity-40" />
            <p className="text-sm text-ink-muted mb-1">Chưa có ngữ cảnh video</p>
            <p className="text-[12px] text-ink-light max-w-sm mx-auto">
              Nhấn &quot;Phân tích video&quot; để Gemini Vision phân tích các ảnh snapshot và tạo mô tả ngữ cảnh, giúp dịch phụ đề chính xác hơn.
            </p>
          </div>
        ) : null}

        {context && (
          <div className="mt-5 p-4 rounded-2xl bg-blue-500/[0.03] ring-1 ring-blue-500/[0.08]">
            <div className="flex items-center gap-2 mb-2">
              <IconCheck className="w-3.5 h-3.5 text-blue-500" />
              <span className="text-[11px] font-medium text-blue-600/80 uppercase tracking-wider">
                Dịch thông minh
              </span>
            </div>
            <p className="text-[12px] text-ink-muted leading-relaxed">
              Khi bạn dùng tính năng <span className="font-medium text-ink/70">Dịch (Gemini)</span> ở tab Timeline, ngữ cảnh này sẽ được gửi kèm để Gemini hiểu rõ bối cảnh video và dịch từ ngữ sát nghĩa hơn.
            </p>
          </div>
        )}

        {/* Gemini File Store */}
        <div className="mt-5">
          <button
            onClick={async () => {
              if (!showFileStore) {
                await loadGeminiFiles();
              }
              setShowFileStore(!showFileStore);
            }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/[0.06] ring-1 ring-amber-500/[0.12] text-[11px] font-medium text-amber-600/80 hover:bg-amber-500/[0.10] transition-all duration-300 cursor-pointer"
          >
            <svg className={`w-3 h-3 transition-transform duration-400 ${showFileStore ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Gemini File Store
            {geminiFiles.length > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-[9px]">{geminiFiles.length}</span>
            )}
          </button>

          {showFileStore && (
            <div className="mt-2 rounded-2xl bg-amber-500/[0.02] ring-1 ring-amber-500/[0.08] overflow-hidden" style={{ animation: "fade-up 0.2s ease forwards" }}>
              {fileStoreLoading ? (
                <div className="p-4 flex items-center gap-3">
                  <IconSpinner className="w-4 h-4 text-amber-500" />
                  <span className="text-[12px] text-ink-muted">Đang tải...</span>
                </div>
              ) : geminiFiles.length === 0 ? (
                <div className="p-4 text-center">
                  <p className="text-[12px] text-ink-light">Không có file nào trong Gemini File Store</p>
                </div>
              ) : (
                <div className="max-h-[300px] overflow-y-auto">
                  {geminiFiles.map((f) => (
                    <div key={f.name} className="flex items-center justify-between px-4 py-2.5 border-b border-amber-500/[0.06] last:border-b-0 hover:bg-amber-500/[0.03] transition-colors">
                      <div className="min-w-0 flex-1 mr-3">
                        <p className="text-[12px] font-medium text-ink/80 truncate">{f.display_name || f.name}</p>
                        <p className="text-[10px] text-ink-light font-mono">{(f.size_bytes / 1024).toFixed(1)} KB</p>
                      </div>
                      <button
                        onClick={() => deleteGeminiFile(f.name)}
                        className="w-6 h-6 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center hover:bg-red-500/20 transition-colors cursor-pointer flex-shrink-0"
                        title="Xoá file"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
