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
      <label className="flex items-center gap-3 flex-wrap text-[11px] text-ink-muted">
        <span className="font-semibold uppercase tracking-[0.12em]">{t("ocr.decoder.label")}</span>
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as OcrDecoder)}
          className="input-field text-[12px] w-auto disabled:opacity-50">
          {OCR_DECODERS.map((decoder) => <option key={decoder} value={decoder}>{t(`ocr.decoder.${decoder}`)}</option>)}
        </select>
      </label>
      {hint && <p className="text-[11px] text-ink-light leading-relaxed">{t("ocr.decoder.hint")}</p>}
    </div>
  );
}
