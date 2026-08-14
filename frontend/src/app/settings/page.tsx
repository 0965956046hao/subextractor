"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";
import { getAppConfig, saveAppConfig, getPipelineHealth } from "@/lib/api";
import type { SubtitleStyle } from "@/lib/api";
import type { PipelineHealth } from "@/lib/api";

const FONT_OPTIONS = ["Arial", "Helvetica", "Verdana", "Times New Roman", "Courier New", "Georgia"];

const DEFAULTS: SubtitleStyle = {
  font_family: "Arial",
  font_size: 48,
  text_color: "#FFFFFF",
  outline_color: "#000000",
  outline_width: 0,
  bold: false,
  italic: false,
  box_enabled: true,
  box_color: "#000000",
  box_opacity: 210,
  box_radius: 12,
  box_border_color: "#000000",
  box_border_width: 0,
  margin_v: 40,
  margin_h: 0,
};

const STYLE_LABELS: Record<string, string> = {
  font_family: "Font chữ",
  font_size: "Kích thước chữ",
  text_color: "Màu chữ",
  outline_color: "Màu viền chữ",
  outline_width: "Độ dày viền chữ",
  bold: "In đậm",
  italic: "In nghiêng",
  box_enabled: "Nền chữ (background)",
  box_color: "Màu nền chữ",
  box_opacity: "Độ mờ nền chữ",
  box_radius: "Bo góc nền (border radius)",
  box_border_color: "Màu viền nền",
  box_border_width: "Độ dày viền nền",
  margin_v: "Vị trí từ đáy",
};

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-ink-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-8 rounded-lg border border-black/[0.08] bg-white cursor-pointer"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12px] font-mono text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </span>
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-ink-muted">{label}</span>
      <span className="flex items-center gap-2.5">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-36 accent-blue-600"
        />
        <span className="text-[12px] font-mono tabular-nums text-blue-600 font-semibold w-16 text-right">
          {value}
          {suffix}
        </span>
      </span>
    </label>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-[12px] text-ink-muted">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative w-11 h-6 rounded-full transition-colors duration-300 ${
          value ? "bg-blue-600" : "bg-black/10"
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-300 ${
            value ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

function PreviewBadge({ style }: { style: SubtitleStyle }) {
  const opacity = Math.min(1, style.box_opacity / 255);
  const radius = style.box_radius;
  const borderW = style.box_border_width;
  const weight = style.bold ? "font-bold" : "font-normal";
  const italic = style.italic ? "italic" : "";
  return (
    <div className="relative h-40 rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 overflow-hidden">
      <div className="absolute inset-0 opacity-30" style={{ background: "repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 2px, transparent 2px 24px)" }} />
      <div className="absolute inset-0 flex items-end justify-center pb-8 px-6">
        <span
          className={`px-4 py-2 text-2xl tracking-tight ${weight} ${italic}`}
          style={{
            color: style.text_color,
            backgroundColor: style.box_enabled
              ? `rgba(${hexToRgb(style.box_color)}, ${opacity})`
              : "transparent",
            borderRadius: radius,
            border: borderW > 0 ? `${borderW}px solid ${style.box_border_color}` : "none",
            WebkitTextStroke:
              style.outline_width > 0
                ? `${style.outline_width}px ${style.outline_color}`
                : undefined,
          }}
        >
          Xin chào
        </span>
      </div>
      <span className="absolute top-2 right-2 text-[10px] font-mono text-white/40">Preview</span>
    </div>
  );
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full.slice(0, 6), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export default function SettingsPage() {
  const [geminiKey, setGeminiKey] = useState("");
  const [ttsJson, setTtsJson] = useState("");
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULTS);
  const [hasGemini, setHasGemini] = useState(false);
  const [hasTts, setHasTts] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [ttsInfo, setTtsInfo] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [cfg, h] = await Promise.all([getAppConfig(), getPipelineHealth()]);
        setHasGemini(cfg.has_gemini_key);
        setHasTts(cfg.has_tts_credentials);
        setGeminiKey(cfg.gemini_api_key || "");
        setTtsJson(cfg.google_tts_credentials || "");
        setTtsInfo(cfg.tts_credentials_info || "");
        setStyle({ ...DEFAULTS, ...cfg.subtitle_style });
        setHealth(h);
      } catch {
        setError("Không kết nối được backend.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (patch: Partial<SubtitleStyle>) => setStyle((s) => ({ ...s, ...patch }));

  const handleSave = async () => {
    setStatus("Đang lưu...");
    setError("");
    try {
      const res = await saveAppConfig({
        gemini_api_key: geminiKey || undefined,
        google_tts_json: ttsJson || undefined,
        subtitle_style: style,
      });
      if (res.error) {
        setError(res.error);
        setStatus("");
        return;
      }
      setStatus("Đã lưu thành công!");
      const cfg = await getAppConfig();
      setHasGemini(cfg.has_gemini_key);
      setHasTts(cfg.has_tts_credentials);
      setGeminiKey(cfg.gemini_api_key || "");
      setTtsJson(cfg.google_tts_credentials || "");
      setTtsInfo(cfg.tts_credentials_info || "");
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi lưu cấu hình.");
      setStatus("");
    }
  };

  return (
    <main className="min-h-[100dvh] max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <div className="flex items-center justify-between gap-4 flex-wrap mb-10">
          <Link href="/" className="btn-island-secondary group !px-5 !py-2 text-[13px]">
            <span className="btn-island-icon !w-7 !h-7">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5" /><path d="M11 18l-6-6 6-6" />
              </svg>
            </span>
            <span className="tracking-tight">Back to library</span>
          </Link>
          {health && (
            <span className={`tag ${health.healthy ? "!bg-emerald-500/10 !text-emerald-700" : "!bg-amber-500/10 !text-amber-700"}`}>
              {health.healthy ? "Hệ thống sẵn sàng" : "Cần cấu hình"}
            </span>
          )}
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mb-10">
        <div className="eyebrow mb-4">Cấu hình</div>
        <h1 className="text-[clamp(1.8rem,4.5vw,3rem)] font-semibold tracking-tight leading-[1.05] text-ink">
          Cài đặt hệ thống
        </h1>
        <p className="mt-4 text-sm text-ink-muted max-w-lg leading-relaxed">
          Cấu hình API key, engine lồng tiếng và kiểu dáng phụ đề mẫu cho video output.
        </p>
      </AnimatedBlock>

      {error && (
        <div className="mb-6 rounded-xl bg-red-500/10 ring-1 ring-red-500/20 px-4 py-3 text-[12px] text-red-600">
          {error}
        </div>
      )}

      <AnimatedBlock delay={150}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              1. Gemini API key
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {hasGemini ? (
                <>
                  Đã cấu hình ✓ <span className="text-ink-light">(thay đổi key tại ô bên dưới rồi bấm Lưu)</span>
                </>
              ) : (
                "Chưa cấu hình"
              )}
            </p>
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="Paste Gemini API key..."
              className="w-full rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
            />
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={200}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              2. Google TTS Service Account
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {hasTts ? (
                <>
                  Đã cấu hình ✓{" "}
                  {ttsInfo && (
                    <span className="font-mono text-emerald-700">{ttsInfo}</span>
                  )}{" "}
                  <span className="text-ink-light">— thay đổi JSON tại ô bên dưới rồi bấm Lưu.</span>
                </>
              ) : (
                <>
                  Chưa cấu hình
                  <span className="ml-2">— dùng cho engine lồng tiếng "Google TTS".</span>
                </>
              )}
            </p>
            <textarea
              value={ttsJson}
              onChange={(e) => setTtsJson(e.target.value)}
              placeholder={'Dán JSON Service Account...'}
              rows={6}
              className="w-full rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-[12px] font-mono text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light resize-y"
            />
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={250}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              3. Kiểu dáng phụ đề
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              Áp dụng khi nhúng phụ đề cứng (hardcode) vào video output.
            </p>

            <div className="mb-5">
              <PreviewBadge style={style} />
            </div>

            <div className="space-y-5">
              <label className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-muted">{STYLE_LABELS.font_family}</span>
                <select
                  value={style.font_family}
                  onChange={(e) => set({ font_family: e.target.value })}
                  className="rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>

              <SliderField label={STYLE_LABELS.font_size} value={style.font_size} min={16} max={96} suffix="px" onChange={(v) => set({ font_size: v })} />
              <ColorField label={STYLE_LABELS.text_color} value={style.text_color} onChange={(v) => set({ text_color: v })} />
              <ColorField label={STYLE_LABELS.outline_color} value={style.outline_color} onChange={(v) => set({ outline_color: v })} />
              <SliderField label={STYLE_LABELS.outline_width} value={style.outline_width} min={0} max={8} suffix="px" onChange={(v) => set({ outline_width: v })} />
              <ToggleField label={STYLE_LABELS.bold} value={style.bold} onChange={(v) => set({ bold: v })} />
              <ToggleField label={STYLE_LABELS.italic} value={style.italic} onChange={(v) => set({ italic: v })} />

              <div className="border-t border-black/[0.05] pt-5 space-y-5">
                <ToggleField label={STYLE_LABELS.box_enabled} value={style.box_enabled} onChange={(v) => set({ box_enabled: v })} />
                {style.box_enabled && (
                  <div className="space-y-5">
                    <ColorField label={STYLE_LABELS.box_color} value={style.box_color} onChange={(v) => set({ box_color: v })} />
                    <SliderField label={STYLE_LABELS.box_opacity} value={style.box_opacity} min={0} max={255} suffix="" onChange={(v) => set({ box_opacity: v })} />
                    <SliderField label={STYLE_LABELS.box_radius} value={style.box_radius} min={0} max={60} suffix="px" onChange={(v) => set({ box_radius: v })} />
                    <ColorField label={STYLE_LABELS.box_border_color} value={style.box_border_color} onChange={(v) => set({ box_border_color: v })} />
                    <SliderField label={STYLE_LABELS.box_border_width} value={style.box_border_width} min={0} max={8} suffix="px" onChange={(v) => set({ box_border_width: v })} />
                  </div>
                )}
              </div>

              <div className="pt-2">
                <SliderField label={STYLE_LABELS.margin_v} value={style.margin_v} min={0} max={200} suffix="px" onChange={(v) => set({ margin_v: v })} />
              </div>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={300}>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="btn-island-primary group text-sm !px-6 !py-2.5"
          >
            <span className="tracking-tight">Lưu cấu hình</span>
          </button>
          {status && <span className="text-[12px] text-emerald-700 font-medium">{status}</span>}
          {loading && <span className="text-[12px] text-ink-light">Đang tải...</span>}
        </div>
      </AnimatedBlock>
    </main>
  );
}