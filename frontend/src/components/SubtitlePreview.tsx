"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Region, SubtitleStyle } from "@/lib/api";

interface Props {
  videoId: string;
  region: Region;
  onConfirmed: (style: Partial<SubtitleStyle>) => void;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export default function SubtitlePreview({ videoId, region, onConfirmed }: Props) {
  const [fontSize, setFontSize] = useState(48);
  const [marginV, setMarginV] = useState(40);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = useCallback(
    async (fs: number, mv: number) => {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/preview/subtitle/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            region,
            style: { font_size: fs, margin_v: mv },
            text: "Phụ đề tiếng Việt",
          }),
        });
        if (!res.ok) throw new Error("preview failed");
        const blob = await res.blob();
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [videoId, region]
  );

  // Initial preview using the saved style, then re-render on slider changes (debounced).
  useEffect(() => {
    fetchPreview(fontSize, marginV);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFontSize = (v: number) => {
    const next = clamp(v, 16, 160);
    setFontSize(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPreview(next, marginV), 250);
  };

  const handleMarginV = (v: number) => {
    const next = clamp(v, 0, 400);
    setMarginV(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPreview(fontSize, next), 250);
  };

  const handleConfirm = () => {
    onConfirmed({ font_size: fontSize, margin_v: marginV });
  };

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          Xem trước phụ đề trên frame đầu tiên. Kéo thanh trượt để chỉnh cỡ chữ và vị
          trí (cách đáy video), nhấn <b>Xác nhận</b> để dùng cấu hình này khi nhúng phụ đề.
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <kbd className="px-2 py-0.5 rounded text-[10px] font-mono text-ink-muted bg-black/[0.03] ring-1 ring-black/[0.06]">↵</kbd>
          <span className="text-[10px] text-ink-light self-center hidden sm:inline">Confirm</span>
        </div>
      </div>

      <div className="double-bezel">
        <div className="double-bezel-inner overflow-hidden">
          <div className="relative bg-black select-none aspect-video w-full flex items-center justify-center">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Subtitle preview"
                className="w-full h-full object-contain"
                draggable={false}
              />
            ) : (
              <div className="text-[12px] text-ink-light">
                {loading ? "Đang tạo bản xem trước..." : "Chưa có preview"}
              </div>
            )}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 space-y-4">
        <label className="block">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
              Cỡ chữ
            </span>
            <span className="text-[12px] font-mono tabular-nums text-blue-600 font-semibold">
              {fontSize}px
            </span>
          </div>
          <input
            type="range"
            min={16}
            max={160}
            step={1}
            value={fontSize}
            onChange={(e) => handleFontSize(Number(e.target.value))}
            className="w-full accent-blue-600"
          />
        </label>

        <label className="block">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-ink-muted uppercase tracking-[0.12em]">
              Vị trí (cách đáy)
            </span>
            <span className="text-[12px] font-mono tabular-nums text-blue-600 font-semibold">
              {marginV}px
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={400}
            step={4}
            value={marginV}
            onChange={(e) => handleMarginV(Number(e.target.value))}
            className="w-full accent-blue-600"
          />
        </label>

        {error && (
          <p className="text-[11px] text-red-600">Không thể tạo bản xem trước. Kiểm tra video/srt.</p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={handleConfirm}
            disabled={!previewUrl}
            className="btn-island-primary group text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="tracking-tight">Xác nhận phụ đề</span>
            <span className="btn-island-icon">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
