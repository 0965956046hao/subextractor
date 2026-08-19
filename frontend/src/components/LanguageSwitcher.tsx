"use client";

import { useI18n } from "@/lib/i18n";

export default function LanguageSwitcher() {
  const { lang, setLang } = useI18n();
  return (
    <select
      value={lang}
      onChange={(e) => setLang(e.target.value as "en" | "vi")}
      className="rounded-full border border-black/[0.08] bg-white/80 backdrop-blur px-3 py-1.5 text-[12px] font-medium text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20 cursor-pointer"
      aria-label="Language"
    >
      <option value="vi">Tiếng Việt</option>
      <option value="en">English</option>
    </select>
  );
}
