"use client";

import { useI18n } from "@/lib/i18n";

export default function LanguageSwitcher({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { lang, setLang } = useI18n();
  return (
    <select
      value={lang}
      onChange={(e) => setLang(e.target.value as "en" | "vi")}
      className={`rounded-lg border border-white/[0.09] bg-black/25 backdrop-blur px-2.5 py-1.5 text-[12px] font-medium text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent/30 cursor-pointer ${
        compact ? "w-11 text-center !px-1" : ""
      }`}
      aria-label="Language"
      title="Language"
    >
      <option value="vi">{compact ? "VI" : "Tiếng Việt"}</option>
      <option value="en">{compact ? "EN" : "English"}</option>
    </select>
  );
}
