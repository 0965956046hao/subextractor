"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getSrtEntries, getVideoUrl, getJobStatus, getTranslatedDownloadUrl } from "@/lib/api";
import type { SrtEntry } from "@/lib/api";

const Editor = dynamic(() => import("@/components/editor/editor"), {
  ssr: false,
  loading: () => (
    <div className="double-bezel">
      <div className="double-bezel-inner p-10 flex items-center justify-center">
        <span className="text-sm text-ink-muted">Đang tải editor…</span>
      </div>
    </div>
  ),
});

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

export default function OpenVideoEditor({ videoId }: { videoId: string }) {
  const [entries, setEntries] = useState<SrtEntry[]>([]);
  const [design, setDesign] = useState<any | null>(null);
  const [error, setError] = useState("");
  const [toolJob, setToolJob] = useState<ToolJob | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [transSrcLang, setTransSrcLang] = useState("zh");
  const [transDstLang, setTransDstLang] = useState("vi");
  const [ttsVoice, setTtsVoice] = useState("vi-VN-Standard-A");

  // Load subtitle data and build project
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSrtEntries(videoId);
        if (cancelled) return;
        setEntries(data);

        // Detect video dimensions via a hidden video element
        const vw = await new Promise<number>((resolve) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          v.onloadedmetadata = () => resolve(v.videoWidth || 1920);
          v.onerror = () => resolve(1920);
          v.src = getVideoUrl(videoId);
          setTimeout(() => resolve(1920), 3000);
        });
        const vh = Math.round(vw * (576 / 1024)); // 16:9 fallback; overwritten below
        const videoWidth = vw;
        const videoHeight = await new Promise<number>((resolve) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          v.onloadedmetadata = () => resolve(v.videoHeight || 1080);
          v.onerror = () => resolve(Math.round(videoWidth * 9 / 16));
          v.src = getVideoUrl(videoId);
          setTimeout(() => resolve(Math.round(videoWidth * 9 / 16)), 3000);
        });

        const W = videoWidth || 1280;
        const H = videoHeight || 720;
        const durationUs = (Math.max(...data.map((e) => e.end), 10) + 5) * 1e6;

        const tracks: any[] = [];
        const clips: Record<string, any> = {};

        const vidId = "video-main";
        clips[vidId] = {
          id: vidId, type: "Video", name: "Video", src: getVideoUrl(videoId),
          timing: {
            display: { from: 0, to: durationUs },
            trim: { from: 0, to: durationUs },
            duration: durationUs,
            playbackRate: 1,
          },
          transform: { x: 0, y: 0, width: W, height: H, angle: 0, zIndex: 0 },
        };
        tracks.push({ id: "track-video", name: "Video", type: "video", clipIds: [vidId], accepts: ["Video", "Image"] });

        const subIds: string[] = [];
        data.forEach((e, i) => {
          const id = `sub-${i}`;
          const startUs = e.start * 1e6;
          const endUs = e.end * 1e6;
          const durUs = Math.max(0.1 * 1e6, endUs - startUs);
          clips[id] = {
            id, type: "Text", name: `Subtitle ${i + 1}`, text: e.text,
            timing: {
              display: { from: startUs, to: endUs },
              trim: { from: 0, to: durUs },
              duration: durUs,
              playbackRate: 1,
            },
            transform: { x: W / 2, y: H - 60, width: W * 0.8, height: 80, angle: 0, zIndex: 10 },
            style: { fontSize: Math.round(H * 0.06), fontFamily: "Arial", color: "#FFFFFF", align: "center" },
          };
          subIds.push(id);
        });
        tracks.push({ id: "track-sub", name: "Subtitle", type: "text", clipIds: subIds, accepts: ["Text", "Caption"] });

        setDesign({ settings: { width: W, height: H, fps: 30, duration: durationUs, backgroundColor: "#111111" }, tracks, clips });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      }
    })();
    return () => { cancelled = true; };
  }, [videoId]);

  // Poll tool job
  useEffect(() => {
    if (!toolJob || (toolJob.status !== "queued" && toolJob.status !== "processing")) return;
    const timer = setInterval(async () => {
      try {
        const st = await getJobStatus(toolJob.jobId);
        setToolJob((prev) => (prev ? { ...prev, status: st.status, progress: st.progress, error: st.error || "" } : prev));
        if (st.status === "done") {
          clearInterval(timer);
          setToolJob((prev) => (prev ? { ...prev, status: "done", progress: 100 } : prev));
          setToast("Hoàn tất!");
          setTimeout(() => setToast(null), 2500);
        } else if (st.status === "error") {
          clearInterval(timer);
        }
      } catch {
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [toolJob]);

  const runToolJob = async (type: "translate" | "tts") => {
    try {
      const srtContent = entriesToSrt(entries);
      if (type === "tts") {
        const res = await fetch(`/api/tts/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ srt_content: srtContent, track_name: "Subtitle", voice: ttsVoice }),
        });
        const data = await res.json();
        setToolJob({ type, jobId: data.job_id, status: data.status, progress: data.progress, error: data.error || "" });
      } else {
        const res = await fetch(`/api/translate/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ srt_content: srtContent, track_name: "Subtitle", source_lang: transSrcLang, target_lang: transDstLang }),
        });
        const data = await res.json();
        setToolJob({ type, jobId: data.job_id, status: data.status, progress: data.progress, error: data.error || "" });
      }
    } catch { /* handled by state */ }
  };

  if (error) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-6">
          <p className="text-sm text-red-600/80">{error}</p>
        </div>
      </div>
    );
  }

  if (!design) {
    return (
      <div className="double-bezel">
        <div className="double-bezel-inner p-10 flex items-center justify-center">
          <span className="text-sm text-ink-muted">Đang tải dữ liệu…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="double-bezel">
      <div className="double-bezel-inner flex flex-col overflow-hidden">
        {/* Toolbar — Gemini/TTS kept */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-black/[0.06] bg-white/60 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <select value={transSrcLang} onChange={(e) => setTransSrcLang(e.target.value)} className="rounded-lg border border-black/[0.08] bg-white px-1.5 py-0.5 text-[10px] text-ink cursor-pointer">
              <option value="zh">Trung</option><option value="en">Anh</option><option value="ja">Nhật</option><option value="ko">Hàn</option>
            </select>
            <span className="text-[10px] text-ink-light">→</span>
            <select value={transDstLang} onChange={(e) => setTransDstLang(e.target.value)} className="rounded-lg border border-black/[0.08] bg-white px-1.5 py-0.5 text-[10px] text-ink cursor-pointer">
              <option value="vi">Việt</option><option value="en">Anh</option><option value="zh">Trung</option>
            </select>
            <button
              onClick={() => runToolJob("translate")}
              disabled={!!toolJob}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/20 hover:bg-violet-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Dịch (Gemini)
            </button>
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-ink-light">Giọng:</span>
              <select value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} className="rounded-lg border border-black/[0.08] bg-white px-1.5 py-0.5 text-[10px] text-ink cursor-pointer">
                <option value="vi-VN-Standard-A">Nữ A</option>
                <option value="vi-VN-Standard-B">Nam B</option>
                <option value="vi-VN-Standard-C">Nữ C</option>
                <option value="vi-VN-Standard-D">Nam D</option>
                <option value="vi-VN-Wavenet-A">WaveNet Nữ A</option>
                <option value="vi-VN-Wavenet-B">WaveNet Nam B</option>
              </select>
            </div>
            <button
              onClick={() => runToolJob("tts")}
              disabled={!!toolJob}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium tracking-tight bg-cyan-500/10 text-cyan-700 ring-1 ring-cyan-500/20 hover:bg-cyan-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Lồng tiếng (TTS)
            </button>
          </div>
        </div>

        {/* Job progress banner */}
        {toolJob && (
          <div className="px-4 py-2 border-b border-black/[0.06] bg-gradient-to-r from-blue-500/[0.04] to-blue-500/[0.01]">
            <div className="flex items-center gap-3">
              {toolJob.status === "queued" || toolJob.status === "processing" ? (
                <>
                  <svg className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15"/><path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  <span className="text-[11px] font-medium text-ink-muted flex-1">{toolJob.type === "translate" ? "Đang dịch..." : toolJob.type === "tts" ? "Đang tổng hợp giọng nói..." : "Đang xuất..."}</span>
                  <div className="w-32 h-1.5 rounded-full bg-black/[0.06] overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${Math.max(3, toolJob.progress)}%` }}/></div>
                  <span className="text-[10px] font-mono text-ink-light tabular-nums w-8 text-right">{toolJob.progress}%</span>
                </>
              ) : toolJob.status === "done" ? (
                <>
                  <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  <span className="text-[11px] font-medium text-emerald-700 flex-1">{toolJob.type === "translate" ? "Dịch hoàn tất" : "Hoàn tất"}</span>
                  {toolJob.type === "translate" && (
                    <a href={getTranslatedDownloadUrl(videoId)} download className="px-3 py-1 rounded-full text-[11px] font-medium bg-blue-600/10 text-blue-700 ring-1 ring-blue-500/20 hover:bg-blue-600/20 transition-colors cursor-pointer">Tải SRT Việt</a>
                  )}
                </>
              ) : (
                <span className="text-[11px] font-medium text-red-600/80 flex-1">{toolJob.error || "Thất bại"}</span>
              )}
              <button onClick={() => setToolJob(null)} className="text-[10px] text-ink-light hover:text-ink transition-colors cursor-pointer">✕</button>
            </div>
          </div>
        )}

        {/* OpenVideo Editor (canvas + timeline) */}
        <div className="flex-1 min-h-0 overflow-hidden" style={{ height: "70vh" }}>
          <Editor initialDesign={design} />
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-ink/90 text-white text-xs font-medium shadow-lg" style={{ animation: "fade-in 0.2s ease forwards" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
