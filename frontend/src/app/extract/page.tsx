"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import UploadPage from "@/components/UploadPage";
import RegionSelector from "@/components/RegionSelector";
import ResultPage from "@/components/ResultPage";
import { AnimatedBlock } from "@/lib/animation";
import { OCR_LANGS, OCR_TYPES } from "@/lib/api";
import type { Region, OcrLang, OcrType } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

type Step = "upload" | "select" | "result";

const STEP_KEYS = ["upload", "select", "result"] as const;

function BentoStepIndicator({ current }: { current: Step }) {
  const { t } = useI18n();
  const idx = STEP_KEYS.findIndex((s) => s === current);
  const STEPS = STEP_KEYS.map((k) => ({
    key: k,
    label: t(`extract.${k}`),
    desc: t(`extract.${k}.desc`),
  }));
  return (
    <div className="double-bezel mb-12">
      <div className="double-bezel-inner p-4 sm:p-5">
        <div className="flex items-center justify-center gap-0">
          {STEPS.map((step, i) => {
            const state = i < idx ? "done" : i === idx ? "active" : "pending";
            return (
              <div key={step.key} className="flex items-center">
                <div className="flex flex-col items-center gap-2.5">
                  <div
                    className={`relative transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                      state === "active" ? "scale-110" : ""
                    }`}
                  >
                    <div
                      className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold
                        transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
                        ${
                          state === "done"
                            ? "bg-success-muted text-success ring-1 ring-success/20"
                            : state === "active"
                              ? "bg-accent text-white shadow-[0_0_16px_rgba(59,130,246,0.2)]"
                              : "bg-black/[0.02] text-ink-muted/40 ring-1 ring-black/[0.06]"
                        }`}
                    >
                      {state === "done" ? (
                        <svg
                          className="w-5 h-5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      ) : (
                        <span className="tracking-tight">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-[11px] font-medium tracking-tight transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]
                      ${
                        state === "done"
                          ? "text-success/70"
                          : state === "active"
                            ? "text-accent"
                            : "text-ink-light"
                      }`}
                  >
                    {step.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={`w-12 sm:w-20 h-px mx-2 sm:mx-4 mb-7 transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
                      ${i < idx ? "bg-success/40" : "bg-black/[0.06]"}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LangSelector({
  value,
  onChange,
}: {
  value: OcrLang;
  onChange: (v: OcrLang) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="glass-panel rounded-2xl px-3 py-2.5 mb-6 flex items-center justify-center gap-2 flex-wrap">
      <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-ink-muted mr-1">
        {t("extract.ocrLang")}
      </span>
      <div className="flex items-center gap-1 rounded-full bg-black/[0.03] p-1 ring-1 ring-black/[0.05]">
        {OCR_LANGS.map((l) => (
          <button
            key={l.value}
            onClick={() => onChange(l.value)}
            className={`px-4 py-1.5 rounded-full text-[13px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
              ${
                value === l.value
                  ? "bg-accent text-white shadow-[0_6px_16px_-6px_rgba(59,130,246,0.5)]"
                  : "text-ink-muted hover:text-ink"
              }`}
          >
            {t(l.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

function EngineSelector({
  value,
  onChange,
}: {
  value: OcrType;
  onChange: (v: OcrType) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="glass-panel rounded-2xl px-3 py-2.5 mb-6 flex items-center justify-center gap-2 flex-wrap">
      <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-ink-muted mr-1">
        {t("extract.ocrEngine")}
      </span>
      <div className="flex items-center gap-1 rounded-full bg-black/[0.03] p-1 ring-1 ring-black/[0.05]">
        {OCR_TYPES.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            title={t(opt.hint)}
            className={`px-4 py-1.5 rounded-full text-[13px] font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] cursor-pointer active:scale-95
              ${
                value === opt.value
                  ? "bg-violet-600 text-white shadow-[0_6px_16px_-6px_rgba(139,92,246,0.5)]"
                  : "text-ink-muted hover:text-ink"
              }`}
          >
            {t(opt.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ExtractPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [step, setStep] = useState<Step>("upload");
  const [videoId, setVideoId] = useState<string>("");
  const [region, setRegion] = useState<Region | null>(null);
  const [lang, setLang] = useState<OcrLang>("ch");
  const [ocrType, setOcrType] = useState<OcrType>("apple");

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("video_id");
    if (v) {
      setVideoId(v);
      setRegion(null);
      setStep("select");
    }
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .catch(() => {});
  }, []);

  return (
    <main className="min-h-[100dvh] max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0} className="mb-10 sm:mb-14">
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
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="text-center mb-10 sm:mb-14">
        <div className="eyebrow mx-auto mb-5 w-max">{t("extract.eyebrow")}</div>
        <h1 className="text-[clamp(2rem,6vw,4.5rem)] font-semibold tracking-tight leading-[0.92] text-balance text-ink">
          {t("extract.title1")}
          <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-blue-500 to-blue-400/60">
            {t("extract.title2")}
          </span>
        </h1>
        <p className="mt-4 text-sm sm:text-base text-ink-muted max-w-md mx-auto leading-relaxed">
          {t("extract.desc")}
        </p>
      </AnimatedBlock>

      <AnimatedBlock delay={200}>
        <BentoStepIndicator current={step} />
      </AnimatedBlock>

      <AnimatedBlock delay={300} key={step}>
        <div className="w-full max-w-6xl mx-auto">
          {step === "upload" && (
            <UploadPage
              onUploaded={(id) => {
                setVideoId(id);
                setStep("select");
              }}
            />
          )}
          {step === "select" && (
            <>
              <EngineSelector value={ocrType} onChange={setOcrType} />
              <LangSelector value={lang} onChange={setLang} />

              <RegionSelector
                videoId={videoId}
                onConfirmed={(r) => {
                  setRegion(r);
                  setStep("result");
                }}
              />
            </>
          )}
          {step === "result" && videoId && region && (
            <ResultPage
              videoId={videoId}
              region={region}
              lang={lang}
              ocrType={ocrType}
              onReset={() => {
                setVideoId("");
                setRegion(null);
                setStep("upload");
              }}
              onDone={() => router.push(`/video/${videoId}`)}
              onViewLibrary={() => router.push("/")}
            />
          )}
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={500} className="mt-24 sm:mt-32 text-center">
        <p className="text-[11px] text-ink-light tracking-wide">
          {t("extract.footer")}
        </p>
      </AnimatedBlock>
    </main>
  );
}
