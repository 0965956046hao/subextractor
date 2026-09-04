"use client";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { Pipeline } from "@/stores/pipeline-store";
import { createPipelinePreset } from "@/lib/api";

function collectCurrentConfig(p: Pipeline): Record<string, unknown> {
  return {
    srcLang: p.srcLang,
    regionMode: p.regionMode,
    translateOn: p.translateOn,
    translateTarget: p.translateTarget,
    dubOn: p.dubOn,
    dubEngine: p.dubEngine,
    dubVoice: p.dubVoice,
    voiceLang: p.voiceLang,
    muteOriginal: p.muteOriginal,
    keepOriginalEnabled: p.keepOriginalEnabled,
    originalGainDb: p.originalGainDb,
    multiVoice: p.multiVoice,
    autoFitSubs: p.autoFit,
    watermarkOn: p.watermark,
    watermarkPreset: p.watermarkPreset,
    removeWatermarkEnabled: p.removeWatermarkEnabled,
    checkSubs: p.checkSubs,
    checkVoice: p.checkVoice,
    useFalThumbnail: p.useFalThumbnail,
    useGptThumbnail: p.useGptThumbnail,
    autoUploadYoutube: p.autoUploadYoutube,
    youtubeChannel: p.youtubeChannel,
    colorFilter: p.colorFilter,
    region: p.region,
    subtitleStyle: p.subtitleStyle,
    removeWatermarkRegions: p.removeWatermarkRegions,
  };
}

export default function PipelineSavePanel({
  p,
  onSaved,
}: {
  p: Pipeline;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        className="btn-island-primary group text-sm !px-5 !py-2.5"
        onClick={() => setOpen(true)}
      >
        <span className="tracking-tight">{t("preset.save")}</span>
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
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        className="flex-1 min-w-[160px] rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2 text-[12px] text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent/20"
        placeholder={t("preset.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setName("");
            setErr("");
          }
        }}
      />
      <button
        type="button"
        className="btn-island-primary btn-sm disabled:opacity-50"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await createPipelinePreset(name.trim(), collectCurrentConfig(p));
            setOpen(false);
            setName("");
            onSaved();
          } catch (e) {
            setErr(e instanceof Error ? e.message : "save failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("preset.confirm")}
      </button>
      <button
        type="button"
        className="btn-island-secondary btn-sm"
        onClick={() => {
          setOpen(false);
          setName("");
          setErr("");
        }}
      >
        {t("preset.cancel")}
      </button>
      {err && <span className="text-danger text-xs w-full">{err}</span>}
    </div>
  );
}
