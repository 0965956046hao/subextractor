"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";
import {
  getAppConfig,
  saveAppConfig,
  getPipelineHealth,
  getProfilesConfig,
  douyinLogin,
  chatgptLogin,
  createWatermarkPreset,
  updateWatermarkPreset,
  deleteWatermarkPreset,
  setActiveWatermarkPreset,
  uploadPresetLogo,
  deletePresetLogo,
  presetLogoUrl,
  getYoutubeConfig,
  saveYoutubeSecrets,
} from "@/lib/api";
import type { SubtitleStyle, WatermarkPreset, ProfilesCheck } from "@/lib/api";
import type { PipelineHealth, YoutubeConfig } from "@/lib/api";
import { useI18n, type Dict } from "@/lib/i18n";

const FONT_OPTIONS = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Times New Roman",
  "Courier New",
  "Georgia",
];

const STYLE_KEYS: Record<string, keyof Dict> = {
  font_family: "style.fontFamily",
  font_size: "style.fontSize",
  text_color: "style.textColor",
  outline_color: "style.outlineColor",
  outline_width: "style.outlineWidth",
  bold: "style.bold",
  italic: "style.italic",
  box_enabled: "style.boxEnabled",
  box_color: "style.boxColor",
  box_opacity: "style.boxOpacity",
  box_radius: "style.boxRadius",
  box_border_color: "style.boxBorderColor",
  box_border_width: "style.boxBorderWidth",
  margin_v: "style.marginV",
};

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
  const { t } = useI18n();
  const opacity = Math.min(1, style.box_opacity / 255);
  const radius = style.box_radius;
  const borderW = style.box_border_width;
  const weight = style.bold ? "font-bold" : "font-normal";
  const italic = style.italic ? "italic" : "";
  return (
    <div className="relative h-40 rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 overflow-hidden">
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background:
            "repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 2px, transparent 2px 24px)",
        }}
      />
      <div className="absolute inset-0 flex items-end justify-center pb-8 px-6">
        <span
          className={`px-4 py-2 text-2xl tracking-tight ${weight} ${italic}`}
          style={{
            color: style.text_color,
            backgroundColor: style.box_enabled
              ? `rgba(${hexToRgb(style.box_color)}, ${opacity})`
              : "transparent",
            borderRadius: radius,
            border:
              borderW > 0
                ? `${borderW}px solid ${style.box_border_color}`
                : "none",
            WebkitTextStroke:
              style.outline_width > 0
                ? `${style.outline_width}px ${style.outline_color}`
                : undefined,
          }}
        >
          {t("settings.style.hello")}
        </span>
      </div>
      <span className="absolute top-2 right-2 text-[10px] font-mono text-white/40">
        {t("settings.style.preview")}
      </span>
    </div>
  );
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full.slice(0, 6), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export default function SettingsPage() {
  const { t } = useI18n();
  const [geminiKeys, setGeminiKeys] = useState<string[]>([]);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [ttsJson, setTtsJson] = useState("");
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULTS);
  const [hasGemini, setHasGemini] = useState(false);
  const [hasTts, setHasTts] = useState(false);
  const [falKey, setFalKey] = useState("");
  const [hasFal, setHasFal] = useState(false);
  const [profileStatus, setProfileStatus] = useState<ProfilesCheck | null>(
    null,
  );
  const [profileBusy, setProfileBusy] = useState<"douyin" | "chatgpt" | null>(
    null,
  );
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [ttsInfo, setTtsInfo] = useState("");
  const [watermarkText, setWatermarkText] = useState("");
  const [presets, setPresets] = useState<WatermarkPreset[]>([]);
  const [activePreset, setActivePreset] = useState("");
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetText, setNewPresetText] = useState("");
  const [editingPreset, setEditingPreset] = useState<string | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [youtube, setYoutube] = useState<YoutubeConfig | null>(null);
  const [youtubeSecrets, setYoutubeSecrets] = useState("");
  const [youtubeBusy, setYoutubeBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [cfg, h, pc, yt] = await Promise.all([
          getAppConfig(),
          getPipelineHealth(),
          getProfilesConfig().catch(() => null),
          getYoutubeConfig().catch(() => null),
        ]);
        setHasGemini(cfg.has_gemini_key);
        setHasTts(cfg.has_tts_credentials);
        setGeminiKeys(
          cfg.gemini_api_keys?.length
            ? cfg.gemini_api_keys
            : cfg.gemini_api_key
              ? [cfg.gemini_api_key]
              : [],
        );
        setTtsJson(cfg.google_tts_credentials || "");
        setTtsInfo(cfg.tts_credentials_info || "");
        setFalKey(cfg.fal_key || "");
        setHasFal(cfg.has_fal_key);
        if (pc) {
          setProfileStatus(pc.resolved);
        }
        setStyle({ ...DEFAULTS, ...cfg.subtitle_style });
        setWatermarkText(cfg.watermark_text || "");
        setPresets(cfg.watermark_presets || []);
        setActivePreset(cfg.active_watermark_preset || "");
        setYoutube(yt);
        setHealth(h);
      } catch {
        setError(t("error.backend"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (patch: Partial<SubtitleStyle>) =>
    setStyle((s) => ({ ...s, ...patch }));

  const handleSave = async () => {
    setStatus(t("btn.saving"));
    setError("");
    try {
      const res = await saveAppConfig({
        gemini_api_keys: geminiKeys,
        google_tts_json: ttsJson || undefined,
        fal_key: falKey,
        subtitle_style: style,
        watermark_text: watermarkText,
      });
      if (res.error) {
        setError(res.error);
        setStatus("");
        return;
      }
      setStatus(t("status.saved"));
      const [cfg, pc] = await Promise.all([
        getAppConfig(),
        getProfilesConfig().catch(() => null),
      ]);
      setHasGemini(cfg.has_gemini_key);
      setHasTts(cfg.has_tts_credentials);
      setGeminiKeys(
        cfg.gemini_api_keys?.length
          ? cfg.gemini_api_keys
          : cfg.gemini_api_key
            ? [cfg.gemini_api_key]
            : [],
      );
      setTtsJson(cfg.google_tts_credentials || "");
      setTtsInfo(cfg.tts_credentials_info || "");
      setFalKey(cfg.fal_key || "");
      setHasFal(cfg.has_fal_key);
      setWatermarkText(cfg.watermark_text || "");
      setPresets(cfg.watermark_presets || []);
      setActivePreset(cfg.active_watermark_preset || "");
      if (pc) {
        setProfileStatus(pc.resolved);
      }
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error.saveConfig"));
      setStatus("");
    }
  };

  const reloadPresets = async () => {
    const cfg = await getAppConfig();
    setPresets(cfg.watermark_presets || []);
    setActivePreset(cfg.active_watermark_preset || "");
    setWatermarkText(cfg.watermark_text || "");
  };

  const handleProfileLogin = async (svc: "douyin" | "chatgpt") => {
    setError("");
    setProfileBusy(svc);
    try {
      if (svc === "douyin") {
        await douyinLogin();
      } else {
        await chatgptLogin();
      }
      const pc = await getProfilesConfig();
      setProfileStatus(pc.resolved);
      setStatus(
        svc === "douyin"
          ? t("settings.profile.openedDouyin")
          : t("settings.profile.openedChatgpt"),
      );
      setTimeout(() => setStatus(""), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.profile.errOpen"));
    } finally {
      setProfileBusy(null);
    }
  };

  const handleSaveFal = async () => {
    setError("");
    setStatus(t("btn.saving"));
    try {
      await saveAppConfig({ fal_key: falKey });
      setHasFal(!!falKey.trim());
      setStatus(t("settings.fal.saved"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.fal.errSave"));
      setStatus("");
    }
  };

  const handleSaveYoutube = async () => {
    setError("");
    if (!youtubeSecrets.trim()) {
      setError(t("settings.youtube.needSecrets"));
      return;
    }
    setYoutubeBusy(true);
    try {
      const res = await saveYoutubeSecrets(youtubeSecrets.trim());
      if (res.status === "ok") {
        setStatus(t("settings.youtube.saved"));
        setYoutubeSecrets("");
        setYoutube(await getYoutubeConfig());
        setTimeout(() => setStatus(""), 2500);
      } else {
        setError(t("settings.youtube.saveFail"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.youtube.errSave"));
    } finally {
      setYoutubeBusy(false);
    }
  };

  const handleAddPreset = async () => {
    setError("");
    setPresetBusy(true);
    try {
      await createWatermarkPreset({
        name: newPresetName.trim() || t("settings.wm.newDefault"),
        text: newPresetText.trim(),
      });
      setNewPresetName("");
      setNewPresetText("");
      await reloadPresets();
      setStatus(t("settings.wm.added"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.wm.errAdd"));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleRenamePreset = async (id: string, name: string, text: string) => {
    setError("");
    try {
      await updateWatermarkPreset(id, {
        name: name.trim() || undefined,
        text: text.trim(),
      });
      setEditingPreset(null);
      await reloadPresets();
      setStatus(t("settings.wm.updated"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.wm.errUpdate"));
    }
  };

  const handleRemovePreset = async (id: string) => {
    setError("");
    if (presets.length <= 1) {
      setError(t("settings.wm.errLast"));
      return;
    }
    try {
      await deleteWatermarkPreset(id);
      await reloadPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.wm.errRemove"));
    }
  };

  const handleSetActive = async (id: string) => {
    setError("");
    try {
      await setActiveWatermarkPreset(id);
      await reloadPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.wm.errDefault"));
    }
  };

  const handlePresetLogoUpload = async (id: string, file: File) => {
    setError("");
    setPresetBusy(true);
    try {
      await uploadPresetLogo(id, file);
      await reloadPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.wm.errLogo"));
    } finally {
      setPresetBusy(false);
    }
  };

  const handlePresetLogoDelete = async (id: string) => {
    setError("");
    try {
      await deletePresetLogo(id);
      await reloadPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.wm.errLogoDel"));
    }
  };

  return (
    <main className="min-h-[100dvh] max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <div className="flex items-center justify-between gap-4 flex-wrap mb-10">
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
            <span className="tracking-tight">{t("back.library")}</span>
          </Link>
          {health && (
            <span
              className={`tag ${health.healthy ? "!bg-emerald-500/10 !text-emerald-700" : "!bg-amber-500/10 !text-amber-700"}`}
            >
              {health.healthy
                ? t("settings.health.ready")
                : t("settings.health.needConfig")}
            </span>
          )}
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mb-10">
        <div className="eyebrow mb-4">{t("settings.eyebrow")}</div>
        <h1 className="text-[clamp(1.8rem,4.5vw,3rem)] font-semibold tracking-tight leading-[1.05] text-ink">
          {t("settings.title")}
        </h1>
        <p className="mt-4 text-sm text-ink-muted max-w-lg leading-relaxed">
          {t("settings.desc")}
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
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                {t("settings.gemini.title")}
              </p>
              <span className="tag">
                {geminiKeys.length > 0
                  ? t("settings.gemini.count", { count: geminiKeys.length })
                  : t("status.noKey")}
              </span>
            </div>
            <p className="text-[11px] text-ink-light mb-4">
              {hasGemini ? (
                <>{t("settings.gemini.configured")}</>
              ) : (
                t("settings.gemini.notConfigured")
              )}{" "}
              <span className="text-ink-light">
                {t("settings.gemini.addHint")}{" "}
                <a
                  href="https://aistudio.google.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
                >
                  {t("settings.gemini.getKey")}
                </a>
              </span>
            </p>

            {geminiKeys.length > 0 && (
              <div className="mb-3 space-y-1.5">
                {geminiKeys.map((k, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] bg-black/[0.02] px-3 py-2"
                  >
                    <span className="font-mono text-[12px] text-ink-light truncate">
                      {k.length > 32 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setGeminiKeys(geminiKeys.filter((_, j) => j !== i));
                        setStatus("");
                      }}
                      className="text-[11px] text-red-500 hover:text-red-600 flex-shrink-0 cursor-pointer"
                    >
                      {t("btn.delete")}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="password"
                value={geminiKeyInput}
                onChange={(e) => setGeminiKeyInput(e.target.value)}
                placeholder={t("settings.gemini.paste")}
                className="w-full rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
              />
              <button
                type="button"
                onClick={() => {
                  const k = geminiKeyInput.trim();
                  if (!k) return;
                  if (!geminiKeys.includes(k)) {
                    setGeminiKeys([...geminiKeys, k]);
                  }
                  setGeminiKeyInput("");
                }}
                className="btn-island-secondary whitespace-nowrap cursor-pointer"
              >
                {t("settings.gemini.add")}
              </button>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={200}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              {t("settings.tts.title")}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {hasTts ? (
                <>
                  {t("status.configured")}{" "}
                  {ttsInfo && (
                    <span className="font-mono text-emerald-700">
                      {ttsInfo}
                    </span>
                  )}{" "}
                  <span className="text-ink-light">
                    {t("settings.tts.editHint")}
                  </span>
                </>
              ) : (
                <>
                  {t("status.notConfigured")}
                  <span className="ml-2">{t("settings.tts.forEngine")}</span>
                </>
              )}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.tts.howto")}{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
              >
                {t("settings.tts.console")}
              </a>{" "}
              {t("settings.tts.steps")}
            </p>
            <textarea
              value={ttsJson}
              onChange={(e) => setTtsJson(e.target.value)}
              placeholder={t("settings.tts.paste")}
              rows={6}
              className="w-full rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-[12px] font-mono text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light resize-y"
            />
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={230}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                {t("settings.fal.title")}
              </p>
              <span className="tag">
                {hasFal ? t("status.configured") : t("status.noKey")}
              </span>
            </div>
            <p className="text-[11px] text-ink-light mb-4">
              {hasFal ? (
                <>{t("status.configured")}</>
              ) : (
                t("status.notConfigured")
              )}{" "}
              <span className="text-ink-light">
                {t("settings.fal.hint")}{" "}
                <a
                  href="https://fal.ai/dashboard/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
                >
                  {t("settings.fal.getKey")}
                </a>
              </span>
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={falKey}
                onChange={(e) => setFalKey(e.target.value)}
                placeholder={
                  hasFal ? t("settings.fal.pasteNew") : t("settings.fal.paste")
                }
                className="w-full rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
              />
              <button
                type="button"
                onClick={handleSaveFal}
                className="btn-island-secondary whitespace-nowrap cursor-pointer"
              >
                {t("settings.fal.saveKey")}
              </button>
              {hasFal && (
                <button
                  type="button"
                  onClick={() => {
                    setFalKey("");
                    setHasFal(false);
                    saveAppConfig({ fal_key: "" }).catch(() => {});
                    setStatus(t("settings.fal.deleted"));
                    setTimeout(() => setStatus(""), 2500);
                  }}
                  className="btn-island-secondary whitespace-nowrap cursor-pointer"
                >
                  {t("btn.delete")}
                </button>
              )}
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={250}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              {t("settings.profile.title")}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.profile.desc")}
            </p>

            <div className="space-y-4">
              {(["douyin", "chatgpt"] as const).map((svc) => {
                const label = svc === "douyin" ? "Douyin" : "ChatGPT";
                const status = profileStatus?.[svc];
                const busy = profileBusy === svc;
                return (
                  <div
                    key={svc}
                    className="flex items-center justify-between gap-3 rounded-xl border border-black/[0.06] bg-black/[0.02] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ink">
                          {label}
                        </span>
                        {status && (
                          <span
                            className={`text-[11px] font-medium ${status.exists ? "text-emerald-700" : "text-amber-700"}`}
                          >
                            {status.exists
                              ? t("settings.profile.exists")
                              : t("settings.profile.missing")}
                          </span>
                        )}
                      </div>
                      {status?.path && (
                        <p className="text-[10px] font-mono text-ink-light truncate mt-0.5">
                          {status.path}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleProfileLogin(svc)}
                      className="btn-island-primary group text-[12px] !px-4 !py-2 whitespace-nowrap disabled:opacity-50"
                    >
                      <span className="tracking-tight">
                        {busy
                          ? t("settings.profile.opening")
                          : t("settings.profile.open", { label })}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={280}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              {t("settings.youtube.title")}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.youtube.desc")}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.youtube.howto")}{" "}
              <a
                href="https://console.developers.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
              >
                {t("settings.youtube.console")}
              </a>{" "}
              {t("settings.youtube.steps")}
              <span className="font-mono text-ink">
                http://localhost:8080/oauth2callback
              </span>
            </p>

            <div className="mb-4 space-y-1.5">
              {(
                [
                  ["client_secrets.json", youtube?.has_client_secrets],
                  ["request.token (OAuth)", youtube?.has_request_token],
                  ["youtubeuploader binary", youtube?.has_binary],
                ] as const
              ).map(([label, ok]) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-xl border border-black/[0.06] bg-black/[0.02] px-4 py-2.5"
                >
                  <span className="text-[12px] text-ink-muted">{label}</span>
                  <span
                    className={`text-[11px] font-medium ${ok ? "text-emerald-700" : "text-amber-700"}`}
                  >
                    {ok
                      ? t("settings.youtube.ready")
                      : t("settings.youtube.missing")}
                  </span>
                </div>
              ))}
              {youtube?.has_client_secrets && youtube.secrets_path && (
                <p className="text-[10px] font-mono text-ink-light px-1 truncate">
                  {youtube.secrets_path}
                </p>
              )}
            </div>

            <textarea
              value={youtubeSecrets}
              onChange={(e) => setYoutubeSecrets(e.target.value)}
              placeholder={t("settings.youtube.paste")}
              rows={6}
              className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[11px] font-mono text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light resize-y"
            />

            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={handleSaveYoutube}
                disabled={youtubeBusy}
                className="btn-island-primary group text-[12px] !px-5 !py-2 disabled:opacity-50"
              >
                <span className="tracking-tight">
                  {youtubeBusy ? t("btn.saving") : t("settings.youtube.save")}
                </span>
              </button>
              {youtube?.has_client_secrets && !youtube.has_request_token && (
                <span className="text-[11px] text-ink-light">
                  {t("settings.youtube.haveSecrets")}
                </span>
              )}
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={280}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              {t("settings.style.title")}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.style.desc")}
            </p>

            <div className="mb-5">
              <PreviewBadge style={style} />
            </div>

            <div className="space-y-5">
              <label className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-muted">
                  {t("style.fontFamily")}
                </span>
                <select
                  value={style.font_family}
                  onChange={(e) => set({ font_family: e.target.value })}
                  className="rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>

              <SliderField
                label={t("style.fontSize")}
                value={style.font_size}
                min={16}
                max={96}
                suffix="px"
                onChange={(v) => set({ font_size: v })}
              />
              <ColorField
                label={t("style.textColor")}
                value={style.text_color}
                onChange={(v) => set({ text_color: v })}
              />
              <ColorField
                label={t("style.outlineColor")}
                value={style.outline_color}
                onChange={(v) => set({ outline_color: v })}
              />
              <SliderField
                label={t("style.outlineWidth")}
                value={style.outline_width}
                min={0}
                max={8}
                suffix="px"
                onChange={(v) => set({ outline_width: v })}
              />
              <ToggleField
                label={t("style.bold")}
                value={style.bold}
                onChange={(v) => set({ bold: v })}
              />
              <ToggleField
                label={t("style.italic")}
                value={style.italic}
                onChange={(v) => set({ italic: v })}
              />

              <div className="border-t border-black/[0.05] pt-5 space-y-5">
                <ToggleField
                  label={t("style.boxEnabled")}
                  value={style.box_enabled}
                  onChange={(v) => set({ box_enabled: v })}
                />
                {style.box_enabled && (
                  <div className="space-y-5">
                    <ColorField
                      label={t("style.boxColor")}
                      value={style.box_color}
                      onChange={(v) => set({ box_color: v })}
                    />
                    <SliderField
                      label={t("style.boxOpacity")}
                      value={style.box_opacity}
                      min={0}
                      max={255}
                      suffix=""
                      onChange={(v) => set({ box_opacity: v })}
                    />
                    <SliderField
                      label={t("style.boxRadius")}
                      value={style.box_radius}
                      min={0}
                      max={60}
                      suffix="px"
                      onChange={(v) => set({ box_radius: v })}
                    />
                    <ColorField
                      label={t("style.boxBorderColor")}
                      value={style.box_border_color}
                      onChange={(v) => set({ box_border_color: v })}
                    />
                    <SliderField
                      label={t("style.boxBorderWidth")}
                      value={style.box_border_width}
                      min={0}
                      max={8}
                      suffix="px"
                      onChange={(v) => set({ box_border_width: v })}
                    />
                  </div>
                )}
              </div>

              <div className="pt-2">
                <SliderField
                  label={t("style.marginV")}
                  value={style.margin_v}
                  min={0}
                  max={200}
                  suffix="px"
                  onChange={(v) => set({ margin_v: v })}
                />
              </div>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={320}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              {t("settings.wm.title")}
            </p>
            <p className="text-[11px] text-ink-light mb-5">
              {t("settings.wm.desc")}
            </p>

            {presets.map((p) => {
              const isActive = p.id === activePreset;
              return (
                <div
                  key={p.id}
                  className={`mb-4 rounded-xl p-4 ring-1 ${isActive ? "ring-blue-500/40 bg-blue-500/[0.03]" : "ring-black/[0.06] bg-white/50"}`}
                >
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {isActive && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-600 text-white shrink-0">
                          {t("settings.wm.active")}
                        </span>
                      )}
                      <span className="text-[13px] font-medium text-ink truncate">
                        {p.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() =>
                          setEditingPreset(editingPreset === p.id ? null : p.id)
                        }
                        className="text-[11px] px-2 py-1 rounded-full ring-1 ring-black/[0.08] text-ink-muted hover:text-ink hover:ring-black/20 transition-colors cursor-pointer"
                      >
                        {editingPreset === p.id
                          ? t("settings.wm.close")
                          : t("settings.wm.edit")}
                      </button>
                      {!isActive && (
                        <button
                          onClick={() => handleSetActive(p.id)}
                          className="text-[11px] px-2 py-1 rounded-full ring-1 ring-black/[0.08] text-ink-muted hover:text-ink hover:ring-black/20 transition-colors cursor-pointer"
                        >
                          {t("settings.wm.useThis")}
                        </button>
                      )}
                      <button
                        onClick={() => handleRemovePreset(p.id)}
                        disabled={presets.length <= 1}
                        className="text-[11px] px-2 py-1 rounded-full ring-1 ring-red-500/15 text-red-600 hover:bg-red-500/5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {t("settings.wm.delete")}
                      </button>
                    </div>
                  </div>

                  {editingPreset === p.id && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                      <div>
                        <p className="text-[11px] text-ink-muted mb-1.5">
                          {t("settings.wm.name")}
                        </p>
                        <input
                          type="text"
                          defaultValue={p.name}
                          id={`preset-name-${p.id}`}
                          placeholder={t("settings.wm.namePh")}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
                        />
                      </div>
                      <div>
                        <p className="text-[11px] text-ink-muted mb-1.5">
                          {t("settings.wm.text")}
                        </p>
                        <input
                          type="text"
                          defaultValue={p.text}
                          id={`preset-text-${p.id}`}
                          placeholder={t("settings.wm.textPh")}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-4">
                    {p.has_logo ? (
                      <div className="relative w-16 h-16 rounded-lg overflow-hidden border border-black/[0.08] bg-white flex items-center justify-center shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`${presetLogoUrl(p.id)}?t=${Date.now()}`}
                          alt="Logo"
                          className="max-w-full max-h-full object-contain"
                        />
                      </div>
                    ) : (
                      <div className="w-16 h-16 rounded-lg border border-dashed border-black/15 bg-white/60 flex items-center justify-center shrink-0">
                        <span className="text-[9px] text-ink-light px-2 text-center leading-tight">
                          {t("settings.wm.noLogo")}
                        </span>
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <label className="btn-island-secondary group !px-3 !py-1.5 text-[11px] cursor-pointer">
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          disabled={presetBusy}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handlePresetLogoUpload(p.id, f);
                            e.target.value = "";
                          }}
                        />
                        <span className="tracking-tight">
                          {p.has_logo
                            ? t("settings.wm.replaceLogo")
                            : t("settings.wm.uploadLogo")}
                        </span>
                      </label>
                      {p.has_logo && (
                        <button
                          onClick={() => handlePresetLogoDelete(p.id)}
                          className="text-[11px] text-red-600 hover:text-red-700 text-left px-2 py-0.5 cursor-pointer"
                        >
                          {t("settings.wm.deleteLogo")}
                        </button>
                      )}
                    </div>
                    {editingPreset === p.id && (
                      <button
                        onClick={() => {
                          const nameEl = document.getElementById(
                            `preset-name-${p.id}`,
                          ) as HTMLInputElement | null;
                          const textEl = document.getElementById(
                            `preset-text-${p.id}`,
                          ) as HTMLInputElement | null;
                          handleRenamePreset(
                            p.id,
                            nameEl?.value ?? p.name,
                            textEl?.value ?? p.text,
                          );
                        }}
                        className="btn-island-primary group !px-4 !py-1.5 text-[12px] ml-auto"
                      >
                        <span className="tracking-tight">{t("btn.save")}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="mt-5 pt-4 border-t border-black/[0.06]">
              <p className="text-[12px] text-ink-muted mb-2">
                {t("settings.wm.addNew")}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder={t("settings.wm.nameExample")}
                  className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
                />
                <input
                  type="text"
                  value={newPresetText}
                  onChange={(e) => setNewPresetText(e.target.value)}
                  placeholder={t("settings.wm.textExample")}
                  className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-ink-light"
                />
              </div>
              <button
                onClick={handleAddPreset}
                disabled={presetBusy}
                className="btn-island-primary group text-[12px] !px-5 !py-2 mt-3 disabled:opacity-50"
              >
                <span className="tracking-tight">
                  {presetBusy ? t("btn.saving") : t("settings.wm.add")}
                </span>
              </button>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={350}>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="btn-island-primary group text-sm !px-6 !py-2.5"
          >
            <span className="tracking-tight">{t("settings.save")}</span>
          </button>
          {status && (
            <span className="text-[12px] text-emerald-700 font-medium">
              {status}
            </span>
          )}
          {loading && (
            <span className="text-[12px] text-ink-light">
              {t("status.loading")}
            </span>
          )}
        </div>
      </AnimatedBlock>
    </main>
  );
}
