"use client";

import { useEffect, useRef, useState } from "react";
import RegionSelector from "@/components/RegionSelector";
import SubtitlePreview from "@/components/SubtitlePreview";
import WatermarkRegionSelector from "@/components/WatermarkRegionSelector";
import {
  createPipelinePreset,
  uploadVideo,
  type PipelinePreset,
  type Region,
  type SubtitleStyle,
  type VideoMeta,
} from "@/lib/api";
import { findDuplicatePreset } from "@/lib/preset-utils";
import { useI18n } from "@/lib/i18n";
import type { ColorFilter } from "@/stores/pipeline-store";
import { DEFAULT_REGION } from "@/stores/pipeline-store";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Cấu hình form /auto hiện tại (giọng, dịch, watermark on/off...). */
  formConfig: Record<string, unknown>;
  /** Video đã có để làm mẫu chọn vùng (không chạy pipeline). */
  sampleVideos: VideoMeta[];
  /** Preset đã có — để báo trùng nội dung. */
  existingPresets: PipelinePreset[];
  onSaved: (preset: PipelinePreset) => void;
}

const STEPS = [0, 1, 2, 3, 4] as const;

export default function PresetBuilderModal({
  open,
  onClose,
  formConfig,
  sampleVideos,
  existingPresets,
  onSaved,
}: Props) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [videoId, setVideoId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [region, setRegion] = useState<Region | null>(null);
  const [colorFilter, setColorFilter] = useState<ColorFilter | null>(null);
  const [style, setStyle] = useState<Partial<SubtitleStyle> | null>(null);
  const [wmRegions, setWmRegions] = useState<Region[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Reset mỗi lần mở.
  useEffect(() => {
    if (open) {
      setStep(0);
      setVideoId("");
      setUploadError("");
      setRegion(null);
      setColorFilter(null);
      setStyle(null);
      setWmRegions([]);
      setName("");
      setSaveError("");
    }
  }, [open ]);

  if (!open) return null;

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setUploadError("");
    try {
      const id = await uploadVideo(file, undefined, undefined, "pipeline");
      setVideoId(id);
      setStep(1);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleSave = async () => {
    const n = name.trim();
    if (!n || !region || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const config: Record<string, unknown> = {
        ...formConfig,
        region,
        subtitleStyle: style,
        removeWatermarkRegions: wmRegions,
        removeWatermarkEnabled: wmRegions.length > 0,
        colorFilter,
      };
      const dupe = findDuplicatePreset(existingPresets, config);
      if (dupe) {
        setSaveError(t("preset.duplicate", { name: dupe.name }));
        return;
      }
      const r = await createPipelinePreset(n, config);
      onSaved({ id: r.id, name: r.name, config });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const stepLabel = (s: number) => {
    switch (s) {
      case 0:
        return t("preset.builderStepSample");
      case 1:
        return t("preset.builderStepRegion");
      case 2:
        return t("preset.builderStepStyle");
      case 3:
        return t("preset.builderStepWatermark");
      default:
        return t("preset.builderStepSave");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="double-bezel w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="double-bezel-inner p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
              {t("preset.builderTitle")}
            </p>
            <button
              onClick={onClose}
              className="icon-btn-ghost text-ink-muted cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mb-5">
            {STEPS.map((s) => (
              <span
                key={s}
                className={`px-3 py-1 rounded-full text-[11px] font-medium ${
                  s === step
                    ? "bg-accent text-white"
                    : s < step
                      ? "bg-success-muted text-success"
                      : "bg-white/[0.05] text-ink-light"
                }`}
              >
                {s + 1}. {stepLabel(s)}
              </span>
            ))}
          </div>

          {step === 0 && (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="w-full rounded-xl border border-dashed border-white/[0.14] bg-white/[0.03] px-4 py-6 text-[13px] text-ink-light hover:bg-white/[0.05] hover:text-ink transition-all disabled:opacity-40 flex flex-col items-center gap-2 cursor-pointer"
              >
                <span>
                  {uploading
                    ? t("preset.builderUploading")
                    : t("preset.builderUpload")}
                </span>
              </button>
              {uploadError && (
                <p className="mt-2 text-[12px] text-danger">{uploadError}</p>
              )}
              {sampleVideos.length > 0 && (
                <div className="mt-4">
                  <p className="text-[11px] text-ink-muted mb-2">
                    {t("preset.builderOrPick")}
                  </p>
                  <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                    {sampleVideos.map((v) => (
                      <button
                        key={v.video_id}
                        onClick={() => {
                          setVideoId(v.video_id);
                          setStep(1);
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl bg-white/[0.03] ring-1 ring-white/[0.07] hover:bg-white/[0.06] transition-colors cursor-pointer"
                      >
                        <p className="text-[12px] text-ink truncate">
                          {v.filename || v.video_id}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 1 && videoId && (
            <div>
              <RegionSelector
                videoId={videoId}
                onConfirmed={(r, _st, cf) => {
                  setRegion(r);
                  setColorFilter(cf ?? null);
                  setStep(2);
                }}
              />
              <button
                onClick={() => setStep(0)}
                className="mt-3 btn-island-secondary btn-xs"
              >
                {t("preset.builderBack")}
              </button>
            </div>
          )}

          {step === 2 && videoId && (
            <div>
              <SubtitlePreview
                videoId={videoId}
                region={region ?? DEFAULT_REGION}
                onConfirmed={(s) => {
                  setStyle(s);
                  setStep(3);
                }}
              />
              <button
                onClick={() => setStep(1)}
                className="mt-3 btn-island-secondary btn-xs"
              >
                {t("preset.builderBack")}
              </button>
            </div>
          )}

          {step === 3 && videoId && (
            <div>
              <WatermarkRegionSelector
                videoId={videoId}
                onConfirm={(rs) => {
                  setWmRegions(rs);
                  setStep(4);
                }}
              />
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => setStep(2)}
                  className="btn-island-secondary btn-xs"
                >
                  {t("preset.builderBack")}
                </button>
                <button
                  onClick={() => {
                    setWmRegions([]);
                    setStep(4);
                  }}
                  className="btn-island-secondary btn-xs"
                >
                  {t("preset.builderSkip")}
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <p className="text-[12px] text-ink-muted mb-2">
                {t("preset.builderDoneHint")}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  placeholder={t("preset.namePlaceholder")}
                  className="input-field flex-1 min-w-0"
                />
                <button
                  onClick={handleSave}
                  disabled={!name.trim() || !region || saving}
                  className="btn-island-primary text-sm !px-5 !py-2.5 flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t("preset.confirm")}
                </button>
              </div>
              {saveError && (
                <p className="mt-2 text-[12px] text-danger">{saveError}</p>
              )}
              <button
                onClick={() => setStep(3)}
                className="mt-3 btn-island-secondary btn-xs"
              >
                {t("preset.builderBack")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
