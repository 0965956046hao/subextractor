"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatedBlock } from "@/lib/animation";
import PageHeader from "@/components/layout/PageHeader";
import CollapsibleSection from "@/components/layout/CollapsibleSection";
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
  listYoutubeChannels,
  createYoutubeChannel,
  updateYoutubeChannel,
  deleteYoutubeChannel,
  getYoutubeChannelDetail,
  activateYoutubeChannel,
  getTelegramConfig,
  saveTelegramToken,
  deleteTelegramConfig,
  getTelegramQR,
  disconnectTelegramChat,
  sendTelegramTest,
} from "@/lib/api";
import type { SubtitleStyle, WatermarkPreset, ProfilesCheck } from "@/lib/api";
import type {
  PipelineHealth,
  YoutubeConfig,
  YouTubeChannelInfo,
  TelegramConfig,
  TelegramQR,
} from "@/lib/api";
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
          className="w-8 h-8 rounded-lg border border-white/[0.09] bg-black/25 cursor-pointer"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded-lg input-field text-[12px] font-mono"
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
          className="w-36 accent-accent"
        />
        <span className="text-[12px] font-mono tabular-nums text-accent font-semibold w-16 text-right">
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
          value ? "bg-accent" : "bg-black/10"
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
  const [ytChannels, setYtChannels] = useState<YouTubeChannelInfo[]>([]);
  const [ytActiveChannel, setYtActiveChannel] = useState("");
  const [ytEditingChannel, setYtEditingChannel] = useState<string | null>(null);
  const [ytEditName, setYtEditName] = useState("");
  const [ytEditSecrets, setYtEditSecrets] = useState("");
  const [ytAdding, setYtAdding] = useState(false);
  const [ytNewName, setYtNewName] = useState("");
  const [ytNewSecrets, setYtNewSecrets] = useState("");
  const [tgConfig, setTgConfig] = useState<TelegramConfig | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgQR, setTgQR] = useState<TelegramQR | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgCountdown, setTgCountdown] = useState(0);
  const tgQrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [toolsStatus, setToolsStatus] = useState<Array<{name: string, display: string, installed: boolean}>>([]);
  const [toolsInstalling, setToolsInstalling] = useState(false);
  const [toolsLogs, setToolsLogs] = useState<Array<{tool: string, status: string, message: string}>>([]);
  const [showToolsModal, setShowToolsModal] = useState(false);
  const [fbAppId, setFbAppId] = useState("");
  const [fbAppSecret, setFbAppSecret] = useState("");
  const [fbPageId, setFbPageId] = useState("");
  const [fbPageToken, setFbPageToken] = useState("");
  const [fbApiVersion, setFbApiVersion] = useState("");
  const [fbDefaultPublish, setFbDefaultPublish] = useState(false);
  const [hasFacebook, setHasFacebook] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [cfg, h, pc, yt, ytCh, tg] = await Promise.all([
          getAppConfig(),
          getPipelineHealth(),
          getProfilesConfig().catch(() => null),
          getYoutubeConfig().catch(() => null),
          listYoutubeChannels().catch(() => ({ channels: [] })),
          getTelegramConfig().catch(() => null),
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
        setYtChannels(ytCh.channels || []);
        setTgConfig(tg);
        setHealth(h);
        setFbAppId(cfg.facebook_app_id || "");
        setFbAppSecret(cfg.facebook_app_secret || "");
        setFbPageId(cfg.facebook_page_id || "");
        setFbPageToken(cfg.facebook_page_access_token || "");
        setFbApiVersion(cfg.facebook_graph_api_version || "");
        setFbDefaultPublish(!!cfg.facebook_default_publish);
        setHasFacebook(!!cfg.has_facebook_config);
      } catch {
        setError(t("error.backend"));
      } finally {
        setLoading(false);
      }
    })();
    // Check tools status on load
    checkTools();
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

  const handleSaveFacebook = async () => {
    setError("");
    setFbBusy(true);
    try {
      const res = await saveAppConfig({
        facebook_app_id: fbAppId,
        facebook_app_secret: fbAppSecret,
        facebook_page_id: fbPageId,
        facebook_page_access_token: fbPageToken,
        facebook_graph_api_version: fbApiVersion,
        facebook_default_publish: fbDefaultPublish,
      });
      if (res.error) {
        setError(res.error);
        setFbBusy(false);
        return;
      }
      setHasFacebook(!!(fbAppId.trim() || fbPageToken.trim()));
      setStatus(t("settings.facebook.saved"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.facebook.saved"));
    } finally {
      setFbBusy(false);
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

  const reloadYtChannels = async () => {
    const ytCh = await listYoutubeChannels().catch(() => ({ channels: [] }));
    setYtChannels(ytCh.channels || []);
  };

  const handleAddChannel = async () => {
    setError("");
    setYoutubeBusy(true);
    try {
      await createYoutubeChannel(ytNewName.trim(), ytNewSecrets.trim());
      setYtNewName("");
      setYtNewSecrets("");
      setYtAdding(false);
      await reloadYtChannels();
      setStatus(t("settings.youtube.saved"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.youtube.errSave"));
    } finally {
      setYoutubeBusy(false);
    }
  };

  const handleUpdateChannel = async (id: string) => {
    setError("");
    setYoutubeBusy(true);
    try {
      await updateYoutubeChannel(id, {
        name: ytEditName.trim() || undefined,
        client_secrets: ytEditSecrets.trim() || undefined,
      });
      setYtEditingChannel(null);
      await reloadYtChannels();
      setStatus(t("settings.youtube.saved"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.youtube.errSave"));
    } finally {
      setYoutubeBusy(false);
    }
  };

  const handleDeleteChannel = async (id: string) => {
    setError("");
    try {
      await deleteYoutubeChannel(id);
      await reloadYtChannels();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.youtube.errSave"));
    }
  };

  const handleActivateChannel = async (id: string) => {
    setError("");
    try {
      await activateYoutubeChannel(id);
      setYtActiveChannel(id);
      await reloadYtChannels();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.youtube.errSave"));
    }
  };

  const handleStartEditChannel = async (id: string) => {
    setError("");
    try {
      const detail = await getYoutubeChannelDetail(id);
      setYtEditingChannel(id);
      setYtEditName(detail.name);
      setYtEditSecrets(detail.client_secrets);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.youtube.errSave"));
    }
  };

  // ── Telegram handlers ──

  const handleSaveTelegramToken = async () => {
    setError("");
    if (!tgToken.trim()) return;
    setTgBusy(true);
    try {
      const res = await saveTelegramToken(tgToken.trim());
      setTgConfig(await getTelegramConfig());
      setTgToken("");
      setStatus(t("settings.telegram.saved"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("settings.telegram.invalidToken"),
      );
    } finally {
      setTgBusy(false);
    }
  };

  const handleDeleteTelegram = async () => {
    setError("");
    setTgBusy(true);
    try {
      await deleteTelegramConfig();
      setTgConfig(await getTelegramConfig());
      setTgQR(null);
      setTgCountdown(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error.saveConfig"));
    } finally {
      setTgBusy(false);
    }
  };

  const handleConnectDevice = async () => {
    setError("");
    setTgBusy(true);
    try {
      const qr = await getTelegramQR();
      setTgQR(qr);
      setTgCountdown(qr.expires_in);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error.saveConfig"));
    } finally {
      setTgBusy(false);
    }
  };

  const handleDisconnectChat = async (chatId: number) => {
    setError("");
    try {
      await disconnectTelegramChat(chatId);
      setTgConfig(await getTelegramConfig());
      setStatus(t("settings.telegram.disconnectSuccess"));
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error.saveConfig"));
    }
  };

  const handleTestMessage = async () => {
    setError("");
    setTgBusy(true);
    try {
      const res = await sendTelegramTest();
      setStatus(t("settings.telegram.testSent"));
      setTimeout(() => setStatus(""), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error.saveConfig"));
    } finally {
      setTgBusy(false);
    }
  };

  // Environment tools check/install
  const checkTools = async () => {
    try {
      const res = await fetch("/api/tools/check");
      const data = await res.json();
      setToolsStatus(data.tools || []);
    } catch (e) {
      console.error("[tools] check error:", e);
    }
  };

  const handleInstallTools = async () => {
    setToolsInstalling(true);
    setToolsLogs([]);
    setShowToolsModal(true);
    try {
      const res = await fetch("/api/tools/install", { method: "POST" });
      const data = await res.json();
      setToolsLogs(data.logs || []);
      await checkTools();
    } catch (e) {
      console.error("[tools] install error:", e);
      setToolsLogs(prev => [...prev, {tool: "error", status: "error", message: String(e)}]);
    } finally {
      setToolsInstalling(false);
    }
  };

  const allToolsInstalled = toolsStatus.length > 0 && toolsStatus.every(t => t.installed);

  // Poll for Telegram connection when QR is showing
  useEffect(() => {
    if (!tgQR) return;
    const prevCount = tgConfig?.connected_chats?.length ?? 0;
    console.log("[TG] Poll started, prevCount:", prevCount);
    const interval = setInterval(async () => {
      try {
        const cfg = await getTelegramConfig();
        const now = cfg.connected_chats?.length ?? 0;
        console.log("[TG] poll:", now, ">", prevCount);
        if (now > prevCount) {
          setTgConfig(cfg);
          setTgQR(null);
          setTgCountdown(0);
          setStatus(t("settings.telegram.connectSuccess"));
          setTimeout(() => setStatus(""), 3000);
          clearInterval(interval);
        }
      } catch (e) {
        console.error("[TG] poll err:", e);
      }
    }, 2000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgQR?.registration_token]);

  // Countdown timer for QR expiry
  useEffect(() => {
    if (tgCountdown <= 0) return;
    const timer = setInterval(() => {
      setTgCountdown((prev) => {
        if (prev <= 1) {
          setTgQR(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [tgCountdown]);

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Generate QR code on canvas when tgQR changes
  useEffect(() => {
    if (!tgQR?.qr_data || !tgQrCanvasRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const canvas = tgQrCanvasRef.current;
        if (!canvas || cancelled) return;
        await QRCode.toCanvas(canvas, tgQR.qr_data, {
          width: 220,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
      } catch (e) {
        console.error("QR generation failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [tgQR?.qr_data]);

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
    <div>
      <PageHeader
        title={t("settings.title")}
        description={t("settings.desc")}
        badge={
          health ? (
            <span
              className={`tag ${health.healthy ? "!bg-success-muted !text-success" : "!bg-warn-muted !text-warn"}`}
            >
              {health.healthy
                ? t("settings.health.ready")
                : t("settings.health.needConfig")}
            </span>
          ) : undefined
        }
        actions={
          <>
            <button
              onClick={handleSave}
              disabled={loading}
              className="btn-island-primary text-[13px] !px-5 !py-2 disabled:opacity-50"
            >
              {t("settings.save")}
            </button>
            {status && (
              <span className="text-[12px] text-success font-medium">{status}</span>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-xl bg-danger-muted ring-1 ring-danger/15 px-4 py-3 text-[12px] text-danger">
          {error}
        </div>
      )}

      {/* -- Group: API Keys & Services -- */}
      <CollapsibleSection title={t("settings.group.apis")} hint={t("settings.group.apis.hint")} defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <AnimatedBlock delay={150} className="md:col-span-2">
        <div className="double-bezel">
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
                  className="text-accent hover:text-accent-light underline underline-offset-2"
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
                    className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2"
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
                      className="text-[11px] text-danger hover:text-danger/80 flex-shrink-0 cursor-pointer"
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
                className="w-full input-field"
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
        <div className="double-bezel">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-1">
              {t("settings.tts.title")}
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              {hasTts ? (
                <>
                  {t("status.configured")}{" "}
                  {ttsInfo && (
                    <span className="font-mono text-success">
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
                className="text-accent hover:text-accent-light underline underline-offset-2"
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
              className="w-full rounded-xl textarea-field"
            />
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={230}>
        <div className="double-bezel">
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
                  className="text-accent hover:text-accent-light underline underline-offset-2"
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
                className="w-full input-field"
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

      </div>
      </CollapsibleSection>

      {/* -- Group: Accounts & Integration -- */}
      <CollapsibleSection title={t("settings.group.accounts")}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <AnimatedBlock delay={250} className="md:col-span-2">
        <div className="double-bezel">
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
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ink">
                          {label}
                        </span>
                        {status && (
                          <span
                            className={`text-[11px] font-medium ${status.exists ? "text-success" : "text-warn"}`}
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
        <div className="double-bezel">
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
                className="text-accent hover:text-accent-light underline underline-offset-2"
              >
                {t("settings.youtube.console")}
              </a>{" "}
              {t("settings.youtube.steps")}
              <span className="font-mono text-ink">
                http://localhost:8080/oauth2callback
              </span>
            </p>

            {/* System status */}
            <div className="mb-4 space-y-1.5">
              {(
                [
                  ["youtubeuploader binary", youtube?.has_binary],
                ] as const
              ).map(([label, ok]) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5"
                >
                  <span className="text-[12px] text-ink-muted">{label}</span>
                  <span
                    className={`text-[11px] font-medium ${ok ? "text-success" : "text-warn"}`}
                  >
                    {ok
                      ? t("settings.youtube.ready")
                      : t("settings.youtube.missing")}
                  </span>
                </div>
              ))}
            </div>

            {/* Channel list */}
            {ytChannels.length === 0 && !ytAdding && (
              <p className="text-[12px] text-ink-light mb-4">
                {t("settings.youtube.noChannels")}
              </p>
            )}

            <div className="space-y-3 mb-4">
              {ytChannels.map((ch) => {
                const isEditing = ytEditingChannel === ch.id;
                return (
                  <div
                    key={ch.id}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-4"
                  >
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-medium text-ink truncate">
                          {ch.name}
                        </span>
                        {ch.has_request_token && (
                          <span className="text-[10px] font-medium text-success">
                            {t("settings.youtube.tokenReady")}
                          </span>
                        )}
                        {!ch.has_request_token && ch.has_client_secrets && (
                          <span className="text-[10px] font-medium text-warn">
                            {t("settings.youtube.tokenMissing")}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!isEditing && (
                          <>
                            <button
                              onClick={() => handleStartEditChannel(ch.id)}
                              className="btn-island-secondary btn-xs"
                            >
                              {t("settings.youtube.edit")}
                            </button>
                            <button
                              onClick={() => handleDeleteChannel(ch.id)}
                              className="btn-ghost-danger"
                            >
                              {t("settings.youtube.delete")}
                            </button>
                          </>
                        )}
                        {isEditing && (
                          <button
                            onClick={() => setYtEditingChannel(null)}
                            className="btn-island-secondary btn-xs"
                          >
                            {t("settings.youtube.close")}
                          </button>
                        )}
                      </div>
                    </div>

                    {isEditing && (
                      <div className="space-y-3 mt-3">
                        <div>
                          <label className="text-[11px] text-ink-muted mb-1 block">
                            {t("settings.youtube.channelName")}
                          </label>
                          <input
                            type="text"
                            value={ytEditName}
                            onChange={(e) => setYtEditName(e.target.value)}
                            placeholder={t("settings.youtube.channelNamePh")}
                            className="w-full input-field text-[12px]"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-ink-muted mb-1 block">
                            client_secrets.json
                          </label>
                          <textarea
                            value={ytEditSecrets}
                            onChange={(e) => setYtEditSecrets(e.target.value)}
                            placeholder={t("settings.youtube.editSecrets")}
                            rows={5}
                            className="w-full rounded-xl textarea-field text-[11px]"
                          />
                        </div>
                        <button
                          onClick={() => handleUpdateChannel(ch.id)}
                          disabled={youtubeBusy}
                          className="btn-island-primary group text-[12px] !px-5 !py-2 disabled:opacity-50"
                        >
                          <span className="tracking-tight">
                            {youtubeBusy ? t("btn.saving") : t("settings.youtube.save")}
                          </span>
                        </button>
                      </div>
                    )}

                    {!isEditing && (
                      <div className="flex items-center gap-4 mt-1">
                        <span
                          className={`tag ${ch.has_client_secrets ? "!bg-success-muted !text-success" : "!bg-warn-muted !text-warn"}`}
                        >
                          {ch.has_client_secrets
                            ? t("settings.youtube.ready")
                            : t("settings.youtube.missing")}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add new channel */}
            {ytAdding ? (
              <div className="rounded-xl border border-accent/15 bg-accent-muted p-4 space-y-3">
                <div>
                  <label className="text-[11px] text-ink-muted mb-1 block">
                    {t("settings.youtube.channelName")}
                  </label>
                  <input
                    type="text"
                    value={ytNewName}
                    onChange={(e) => setYtNewName(e.target.value)}
                    placeholder={t("settings.youtube.channelNamePh")}
                    className="w-full input-field text-[12px]"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink-muted mb-1 block">
                    client_secrets.json
                  </label>
                  <textarea
                    value={ytNewSecrets}
                    onChange={(e) => setYtNewSecrets(e.target.value)}
                    placeholder={t("settings.youtube.paste")}
                    rows={6}
                    className="w-full rounded-xl textarea-field text-[11px]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAddChannel}
                    disabled={youtubeBusy}
                    className="btn-island-primary group text-[12px] !px-5 !py-2 disabled:opacity-50"
                  >
                    <span className="tracking-tight">
                      {youtubeBusy ? t("btn.saving") : t("settings.youtube.save")}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setYtAdding(false);
                      setYtNewName("");
                      setYtNewSecrets("");
                    }}
                    className="btn-island-secondary text-[12px] !px-4 !py-2"
                  >
                    <span className="tracking-tight">{t("settings.youtube.close")}</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setYtAdding(true)}
                className="btn-island-secondary text-[12px] !px-4 !py-2"
              >
                <span className="tracking-tight">{t("settings.youtube.addChannel")}</span>
              </button>
            )}
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={340} className="md:col-span-2">
        <div className="double-bezel">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                {t("settings.telegram.title")}
              </p>
              <span className="tag">
                {tgConfig?.connected_chats?.length
                  ? t("settings.telegram.connected")
                  : t("settings.telegram.notConnected")}
              </span>
            </div>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.telegram.desc")}
            </p>

            {/* No bot token yet */}
            {!tgConfig?.has_bot_token && (
              <>
                <p className="text-[11px] text-ink-light mb-4">
                  {t("settings.telegram.howto")}{" "}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:text-accent-light underline underline-offset-2"
                  >
                    {t("settings.telegram.botFather")}
                  </a>{" "}
                  {t("settings.telegram.steps")}
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={tgToken}
                    onChange={(e) => setTgToken(e.target.value)}
                    placeholder={t("settings.telegram.tokenPh")}
                    className="w-full input-field"
                  />
                  <button
                    type="button"
                    onClick={handleSaveTelegramToken}
                    disabled={tgBusy || !tgToken.trim()}
                    className="btn-island-secondary whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    {tgBusy ? t("btn.saving") : t("settings.telegram.save")}
                  </button>
                </div>
              </>
            )}

            {/* Bot token configured */}
            {tgConfig?.has_bot_token && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[12px] text-ink">
                    {t("settings.telegram.botName", {
                      name: tgConfig.bot_name,
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={handleDeleteTelegram}
                    disabled={tgBusy}
                    className="text-[11px] text-danger hover:text-danger/80 cursor-pointer"
                  >
                    {t("settings.telegram.deleteToken")}
                  </button>
                </div>

                {/* QR Code area */}
                {!tgQR && (
                  <div className="flex items-center gap-2 mb-4">
                    <button
                      type="button"
                      onClick={handleConnectDevice}
                      disabled={tgBusy}
                      className="btn-island-primary group text-[12px] !px-5 !py-2 disabled:opacity-50"
                    >
                      <span className="tracking-tight">
                        {tgBusy
                          ? t("btn.saving")
                          : t("settings.telegram.connectDevice")}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setTgBusy(true);
                        try {
                          setTgConfig(await getTelegramConfig());
                        } finally {
                          setTgBusy(false);
                        }
                      }}
                      className="btn-island-secondary text-[12px] !px-3 !py-2 cursor-pointer"
                    >
                      ↻
                    </button>
                  </div>
                )}

                {tgQR && (
                  <div className="mb-4 p-4 rounded-xl border border-accent/15 bg-accent/5 flex flex-col items-center gap-3">
                    <canvas
                      ref={tgQrCanvasRef}
                      className="rounded-lg"
                    />
                    <p className="text-[12px] text-ink font-medium">
                      {t("settings.telegram.scanQR")}
                    </p>

                    {/* Manual fallback: copy /start command */}
                    <div className="w-full rounded-xl border border-white/[0.09] bg-white/[0.04] px-4 py-3">
                      <p className="text-[11px] text-ink-muted mb-2">
                        {t("settings.telegram.manualFallback")}
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-[12px] font-mono text-ink bg-white/[0.06] rounded-lg px-3 py-2 truncate select-all">
                          /start {tgQR.registration_token}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(`/start ${tgQR.registration_token}`);
                            setStatus(t("settings.telegram.copied"));
                            setTimeout(() => setStatus(""), 2000);
                          }}
                          className="btn-island-secondary !px-3 !py-1.5 text-[11px] whitespace-nowrap cursor-pointer"
                        >
                          {t("btn.copy")}
                        </button>
                      </div>
                    </div>

                    <a
                      href={tgQR.qr_data}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-accent hover:text-accent-light underline underline-offset-2 break-all text-center"
                    >
                      {tgQR.qr_data}
                    </a>
                    {tgCountdown > 0 ? (
                      <p className="text-[11px] text-ink-light">
                        {t("settings.telegram.expiresIn", {
                          time: formatCountdown(tgCountdown),
                        })}
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={handleConnectDevice}
                        className="text-[11px] text-accent hover:text-accent-light cursor-pointer"
                      >
                        {t("settings.telegram.qrNew")}
                      </button>
                    )}
                  </div>
                )}

                {/* Connected devices list */}
                <div className="mt-4">
                  <p className="text-[11px] text-ink-muted mb-2">
                    {t("settings.telegram.connectedDevices")} (
                    {tgConfig.connected_chats.length})
                  </p>
                  {tgConfig.connected_chats.length === 0 ? (
                    <p className="text-[11px] text-ink-light">
                      {t("settings.telegram.noDevices")}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {tgConfig.connected_chats.map((ch) => (
                        <div
                          key={ch.chat_id}
                          className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5"
                        >
                          <div className="min-w-0">
                            <span className="text-[12px] text-ink">
                              {ch.name}
                            </span>
                            <span className="text-[10px] text-ink-light ml-2">
                              {new Date(ch.connected_at).toLocaleDateString()}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDisconnectChat(ch.chat_id)}
                            className="text-[11px] text-danger hover:text-danger/80 flex-shrink-0 cursor-pointer"
                          >
                            {t("settings.telegram.disconnect")}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Test message button */}
                {tgConfig.connected_chats.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-white/[0.08]">
                    <button
                      type="button"
                      onClick={handleTestMessage}
                      disabled={tgBusy}
                      className="btn-island-secondary text-[12px] !px-4 !py-2 cursor-pointer disabled:opacity-50"
                    >
                      <span className="tracking-tight">
                        {tgBusy ? t("btn.saving") : t("settings.telegram.testMsg")}
                      </span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={460} className="md:col-span-2">
        <div className="double-bezel">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                {t("settings.facebook.title")}
              </p>
              <span className="tag">
                {hasFacebook
                  ? t("settings.facebook.configured")
                  : t("settings.facebook.notConfigured")}
              </span>
            </div>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.facebook.desc")}{" "}
              <span className="text-ink-light">
                {t("settings.facebook.howto")}{" "}
                <a
                  href="https://developers.facebook.com/apps/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-accent-light underline underline-offset-2"
                >
                  {t("settings.facebook.console")}
                </a>{" "}
                {t("settings.facebook.steps")}
              </span>
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="text-[11px] text-ink-muted mb-1 block">
                  {t("settings.facebook.appId")}
                </label>
                <input
                  type="text"
                  value={fbAppId}
                  onChange={(e) => setFbAppId(e.target.value)}
                  placeholder={t("settings.facebook.pasteAppId")}
                  className="w-full input-field text-[12px] font-mono"
                />
              </div>
              <div>
                <label className="text-[11px] text-ink-muted mb-1 block">
                  {t("settings.facebook.appSecret")}
                </label>
                <input
                  type="password"
                  value={fbAppSecret}
                  onChange={(e) => setFbAppSecret(e.target.value)}
                  placeholder={t("settings.facebook.pasteAppSecret")}
                  className="w-full input-field text-[12px] font-mono"
                />
              </div>
              <div>
                <label className="text-[11px] text-ink-muted mb-1 block">
                  {t("settings.facebook.pageId")}
                </label>
                <input
                  type="text"
                  value={fbPageId}
                  onChange={(e) => setFbPageId(e.target.value)}
                  placeholder={t("settings.facebook.pastePageId")}
                  className="w-full input-field text-[12px] font-mono"
                />
              </div>
              <div>
                <label className="text-[11px] text-ink-muted mb-1 block">
                  {t("settings.facebook.apiVersion")}
                </label>
                <input
                  type="text"
                  value={fbApiVersion}
                  onChange={(e) => setFbApiVersion(e.target.value)}
                  placeholder={t("settings.facebook.pasteVersion")}
                  className="w-full input-field text-[12px] font-mono"
                />
              </div>
            </div>

            <div className="mb-4">
              <label className="text-[11px] text-ink-muted mb-1 block">
                {t("settings.facebook.pageToken")}
              </label>
              <input
                type="password"
                value={fbPageToken}
                onChange={(e) => setFbPageToken(e.target.value)}
                placeholder={t("settings.facebook.pasteToken")}
                className="w-full input-field text-[12px] font-mono"
              />
              <p className="text-[10px] text-ink-light mt-1">
                {t("settings.facebook.serviceHint")}
              </p>
            </div>

            <div className="mb-4">
              <ToggleField
                label={t("settings.facebook.publish")}
                value={fbDefaultPublish}
                onChange={setFbDefaultPublish}
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSaveFacebook}
                disabled={fbBusy}
                className="btn-island-primary text-[12px] !px-5 !py-2 disabled:opacity-50"
              >
                {fbBusy ? t("btn.saving") : t("settings.facebook.save")}
              </button>
            </div>

            {/* Setup guide */}
            <div className="mt-6 pt-4 border-t border-white/[0.08]">
              <p className="text-[12px] font-semibold text-ink mb-3">
                {t("settings.facebook.guide.title")}
              </p>
              <ol className="space-y-2.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <li
                    key={n}
                    className="flex items-start gap-3 text-[11px] text-ink-light leading-relaxed"
                  >
                    <span className="shrink-0 w-5 h-5 rounded-full bg-accent/15 text-accent text-[10px] font-semibold flex items-center justify-center mt-0.5">
                      {n}
                    </span>
                    <span>
                      {t(`settings.facebook.guide.step${n}` as keyof Dict)}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="text-[10px] text-ink-light mt-3 italic">
                {t("settings.facebook.guide.note")}
              </p>
            </div>
          </div>
        </div>
      </AnimatedBlock>

      </div>
      </CollapsibleSection>

      {/* -- Group: Output Presets -- */}
      <CollapsibleSection title={t("settings.group.output")}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <AnimatedBlock delay={280}>
        <div className="double-bezel">
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
                  className="input-field text-[12px] w-auto"
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

              <div className="border-t border-white/[0.08] pt-5 space-y-5">
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
        <div className="double-bezel">
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
                  className={`mb-4 rounded-xl p-4 ring-1 ${isActive ? "ring-accent/40 bg-accent-muted" : "ring-white/[0.09] bg-white/[0.03]"}`}
                >
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {isActive && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent text-white shrink-0">
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
                        className="btn-island-secondary btn-xs"
                      >
                        {editingPreset === p.id
                          ? t("settings.wm.close")
                          : t("settings.wm.edit")}
                      </button>
                      {!isActive && (
                        <button
                          onClick={() => handleSetActive(p.id)}
                          className="btn-island-secondary btn-xs"
                        >
                          {t("settings.wm.useThis")}
                        </button>
                      )}
                      <button
                        onClick={() => handleRemovePreset(p.id)}
                        disabled={presets.length <= 1}
                        className="btn-ghost-danger disabled:opacity-40 disabled:cursor-not-allowed"
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
                          className="w-full input-field text-[12px]"
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
                          className="w-full input-field text-[12px]"
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-4">
                    {p.has_logo ? (
                      <div className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 bg-white flex items-center justify-center shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`${presetLogoUrl(p.id)}?t=${Date.now()}`}
                          alt="Logo"
                          className="max-w-full max-h-full object-contain"
                        />
                      </div>
                    ) : (
                      <div className="w-16 h-16 rounded-lg border border-dashed border-white/15 bg-white/[0.04] flex items-center justify-center shrink-0">
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
                          className="text-[11px] text-danger hover:text-danger/80 text-left px-2 py-0.5 cursor-pointer"
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

            <div className="mt-5 pt-4 border-t border-white/[0.08]">
              <p className="text-[12px] text-ink-muted mb-2">
                {t("settings.wm.addNew")}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder={t("settings.wm.nameExample")}
                  className="w-full input-field text-[12px]"
                />
                <input
                  type="text"
                  value={newPresetText}
                  onChange={(e) => setNewPresetText(e.target.value)}
                  placeholder={t("settings.wm.textExample")}
                  className="w-full input-field text-[12px]"
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

      </div>
      </CollapsibleSection>

      {/* -- Group: Environment Tools -- */}
      <CollapsibleSection title={t("settings.group.devtools")}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Environment tools section */}
      <AnimatedBlock delay={320}>
        <div className="double-bezel">
          <div className="double-bezel-inner p-5 sm:p-6">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                {t("settings.env.title")}
              </p>
              <span className="tag">
                {toolsStatus.length === 0
                  ? "—"
                  : allToolsInstalled
                    ? t("settings.env.toolsInstalled")
                    : t("settings.env.toolsMissing")}
              </span>
            </div>
            <p className="text-[11px] text-ink-light mb-4">
              {t("settings.env.desc")}
            </p>

            {toolsStatus.length > 0 && (
              <div className="mb-3 space-y-1.5">
                {toolsStatus.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2"
                  >
                    <span className="text-[12px] text-ink">
                      {tool.display}
                    </span>
                    <span className={`text-[11px] ${tool.installed ? "text-success" : "text-ink-light"}`}>
                      {tool.installed ? "✓" : "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={checkTools}
                disabled={toolsInstalling}
                className="btn-island-secondary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-50"
              >
                <span className="tracking-tight">{t("settings.env.refreshStatus")}</span>
              </button>
              <button
                type="button"
                onClick={handleInstallTools}
                disabled={toolsInstalling || allToolsInstalled}
                className="btn-island-primary text-[11px] !px-3 !py-1.5 cursor-pointer disabled:opacity-50"
              >
                <span className="tracking-tight">
                  {toolsInstalling ? t("settings.env.installing") : t("settings.env.install")}
                </span>
              </button>
            </div>
          </div>
        </div>
      </AnimatedBlock>
      </div>
      </CollapsibleSection>

      {/* Tools install modal */}
      {showToolsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="double-bezel w-full max-w-md mx-4">
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted">
                  {t("settings.env.install")}
                </p>
                <button
                  type="button"
                  onClick={() => setShowToolsModal(false)}
                  className="text-ink-light hover:text-ink text-lg cursor-pointer"
                >
                  ×
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1.5 mb-4">
                {toolsLogs.length === 0 && !toolsInstalling && (
                  <p className="text-[11px] text-ink-light">Chưa có log...</p>
                )}
                {toolsLogs.map((log, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2"
                  >
                    <span className={`text-[11px] ${
                      log.status === "done" ? "text-success" :
                      log.status === "error" ? "text-danger" :
                      log.status === "exists" ? "text-success" :
                      "text-ink"
                    }`}>
                      {log.status === "done" || log.status === "exists" ? "✓ " :
                       log.status === "error" ? "✗ " :
                       log.status === "extracting" ? "⏳ " : "🔍 "}
                      {log.message}
                    </span>
                  </div>
                ))}
                {toolsInstalling && toolsLogs.length === 0 && (
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2">
                    <span className="text-[11px] text-ink animate-pulse">Đang kiểm tra...</span>
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowToolsModal(false)}
                  className="btn-island-secondary text-[11px] !px-4 !py-1.5 cursor-pointer"
                >
                  <span className="tracking-tight">{t("settings.env.close")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
