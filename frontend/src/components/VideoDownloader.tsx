"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";

interface ResolveResult {
  url: string;
  title: string;
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

function IconLink({ className = "w-4 h-4" }) {
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
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </svg>
  );
}

function IconCopy({ className = "w-4 h-4" }) {
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
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
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

function extractUrl(text: string): string {
  const m = text.match(/https?:\/\/[^\s\u4e00-\u9fff]+/);
  if (!m) return "";
  return m[0].replace(/[，。！？,;.!?]+$/, "");
}

export default function VideoDownloader() {
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [openingLogin, setOpeningLogin] = useState(false);

  const handleOpenLogin = async () => {
    setOpeningLogin(true);
    try {
      await fetch("/api/video-download/login", { method: "POST" });
    } catch {
      // ignore
    }
    setOpeningLogin(false);
  };

  const handleResolve = async () => {
    if (!url.trim()) return;
    const cleaned = extractUrl(url);
    if (!cleaned) {
      setError("Không tìm thấy link (https://...) trong nội dung đã dán.");
      return;
    }
    if (cleaned !== url) setUrl(cleaned);
    setResolving(true);
    setError("");
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch("/api/video-download/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cleaned }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
      } else {
        setError(data.detail || "Không thể phân tích link.");
      }
    } catch {
      setError("Lỗi kết nối tới backend.");
    }
    setResolving(false);
  };

  const handleCopy = async () => {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <main className="min-h-[100dvh] max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <Link
          href="/"
          className="btn-island-secondary group !px-5 !py-2 text-[13px]"
        >
          <span className="btn-island-icon !w-7 !h-7">
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5" />
              <path d="M11 18l-6-6 6-6" />
            </svg>
          </span>
          <span className="tracking-tight">Back to library</span>
        </Link>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mt-10 mb-10">
        <div className="eyebrow mb-4">Video Downloader</div>
        <h1 className="text-[clamp(1.8rem,4.5vw,3.4rem)] font-semibold tracking-tight leading-[1.05] text-ink">
          Tải video từ Douyin / TikTok
        </h1>
        <p className="mt-4 text-sm text-ink-muted max-w-lg leading-relaxed">
          Dán link chia sẻ Douyin/TikTok để lấy URL video gốc trong URL trả về
          có chữ ký &amp; thời hạn — chỉ dùng tạm thời.
        </p>
        <button
          onClick={handleOpenLogin}
          disabled={openingLogin}
          className="mt-4 px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-all duration-300 active:scale-[0.97] cursor-pointer disabled:opacity-60"
        >
          {openingLogin ? "Đang mở…" : "Đăng nhập Douyin (lần đầu)"}
        </button>
      </AnimatedBlock>

      {/* Step 1: Resolve */}
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
                onKeyDown={(e) => e.key === "Enter" && handleResolve()}
                placeholder="Dán toàn bộ nội dung chia sẻ (hoặc chỉ link https://v.douyin.com/...)"
                className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={handleResolve}
                disabled={resolving || !url.trim()}
                className="btn-island-primary group text-sm !px-5 !py-2.5 flex-shrink-0"
              >
                {resolving ? (
                  <>
                    <IconSpinner className="w-3.5 h-3.5" />
                    <span className="tracking-tight">Đang phân tích…</span>
                  </>
                ) : (
                  <>
                    <IconLink className="w-3.5 h-3.5" />
                    <span className="tracking-tight">Phân tích</span>
                  </>
                )}
              </button>
            </div>

            {error && (
              <div className="mt-3 p-3 rounded-xl bg-red-500/8 ring-1 ring-red-500/15 text-[12px] text-red-600/80 whitespace-pre-wrap">
                {error}
              </div>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {/* Step 2: Result */}
      {result && (
        <AnimatedBlock delay={200}>
          <div className="double-bezel">
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                  2. URL video
                </p>
                {result.title && (
                  <span className="text-[11px] text-ink-light truncate ml-4">
                    {result.title}
                  </span>
                )}
              </div>

              <div className="flex items-stretch gap-2">
                <div className="flex-1 rounded-xl bg-black/[0.02] ring-1 ring-black/[0.06] px-3 py-3 text-[12px] font-mono text-ink break-all leading-relaxed">
                  {result.url}
                </div>
                <div className="flex flex-col gap-2 flex-shrink-0">
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-all duration-300 active:scale-[0.97] cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <IconCheck className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-emerald-700">Đã sao chép</span>
                      </>
                    ) : (
                      <>
                        <IconCopy className="w-3.5 h-3.5" />
                        <span>Sao chép</span>
                      </>
                    )}
                  </button>
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all duration-300 active:scale-[0.97]"
                  >
                    <IconLink className="w-3.5 h-3.5" />
                    Mở link
                  </a>
                </div>
              </div>

              <div className="mt-4">
                <iframe
                  src={result.url}
                  title="Video preview"
                  className="w-full aspect-video rounded-xl ring-1 ring-black/[0.06] bg-black"
                  allow="autoplay; fullscreen; encrypted-media"
                  allowFullScreen
                  referrerPolicy="no-referrer"
                />
                <p className="mt-2 text-[11px] text-ink-light">
                  Nếu khung trống, CDN đang chặn nhúng — dùng nút "Mở link" để xem trực tiếp.
                </p>
              </div>
            </div>
          </div>
        </AnimatedBlock>
      )}
    </main>
  );
}
