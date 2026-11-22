"use client";

import { OCR_DECODERS, type OcrDecoder } from "@/lib/ocr-decoder";
import { useI18n } from "@/lib/i18n";

export default function OcrDecoderSelector({ value, onChange, disabled = false, hint = false }: {
  value: OcrDecoder;
  onChange: (value: OcrDecoder) => void;
  disabled?: boolean;
  hint?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">{t("ocr.decoder.label")}</span>
        <div role="group" aria-label={t("ocr.decoder.label")}
          className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] ring-1 ring-white/[0.08]">
          {OCR_DECODERS.map((decoder) => (
            <button key={decoder} type="button" disabled={disabled} aria-pressed={value === decoder}
              onClick={() => onChange(decoder)}
              className={`px-4 py-1.5 rounded-full text-[11px] font-medium tracking-tight transition-colors active:scale-[0.97] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${value === decoder
                ? "bg-accent text-white shadow-sm ring-1 ring-accent"
                : "text-ink-light hover:text-ink"
                }`}>
              {t(`ocr.decoder.${decoder}`)}
            </button>
          ))}
        </div>
      </div>
      {hint && <p className="text-[11px] text-ink-light leading-relaxed">{t("ocr.decoder.hint")}</p>}
    </div>
  );
}
