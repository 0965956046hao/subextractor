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
        className="btn-island btn-island-primary"
        onClick={() => setOpen(true)}
      >
        {t("preset.save")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="btn-island flex-1"
        placeholder={t("preset.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="button"
        className="btn-island btn-island-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await createPipelinePreset(name, collectCurrentConfig(p));
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
      {err && <span className="text-red-500 text-xs">{err}</span>}
    </div>
  );
}
