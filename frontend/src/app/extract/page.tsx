"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import UploadPage from "@/components/UploadPage";
import RegionSelector from "@/components/RegionSelector";
import ResultPage from "@/components/ResultPage";
import PageHeader from "@/components/layout/PageHeader";
import { OCR_LANGS, OCR_TYPES } from "@/lib/api";
import type { Region, OcrLang, OcrType } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

type Step = "upload" | "select" | "result";

const STEP_KEYS = ["upload", "select", "result"] as const;

function StepTabs({ current }: { current: Step }) {
  const { t } = useI18n();
  const idx = STEP_KEYS.findIndex((s) => s === current);
  const STEPS = STEP_KEYS.map((k) => ({
    key: k,
    label: t(`extract.${k}`),
    desc: t(`extract.${k}.desc`),
  }));
  return (
    <div className="double-bezel mb-6">
      <div className="double-bezel-inner p-1.5 flex items-stretch">
        {STEPS.map((step, i) => {
          const state = i < idx ? "done" : i === idx ? "active" : "pending";
          return (
            <div key={step.key} className="flex items-center flex-1">
              <div
                className={`flex items-center gap-2.5 w-full rounded-lg px-3 py-2 transition-colors duration-300 ${
                  state === "active" ? "bg-accent-muted" : ""
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 transition-colors duration-300
                    ${
                      state === "done"
                        ? "bg-success-muted text-success ring-1 ring-success/25"
                        : state === "active"
                          ? "bg-accent text-white"
                          : "bg-white/[0.05] text-ink-light ring-1 ring-white/[0.08]"
                    }`}
                >
                  {state === "done" ? (
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p
                    className={`text-[12px] font-medium tracking-tight truncate ${
                      state === "active"
                        ? "text-accent-light"
                        : state === "done"
                          ? "text-success/80"
                          : "text-ink-light"
                    }`}
                  >
                    {step.label}
                  </p>
                  <p className="hidden sm:block text-[10px] text-ink-light truncate">
                    {step.desc}
                  </p>
                </div>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`h-px flex-1 mx-1 transition-colors duration-500 ${
                    i < idx ? "bg-success/40" : "bg-white/[0.08]"
                  }`}
                />
              )}
            </div>
          );
        })}
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
    <div className="flex items-center gap-2.5 mb-4 flex-wrap">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-light">
        {t("extract.ocrLang")}
      </span>
      <div className="flex items-center gap-1 rounded-lg bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
        {OCR_LANGS.map((l) => (
          <button
            key={l.value}
            onClick={() => onChange(l.value)}
            className={`px-3.5 py-1.5 rounded-md text-[12px] font-medium tracking-tight transition-all duration-200 cursor-pointer active:scale-95 ${
              value === l.value
                ? "bg-accent text-white"
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
    <div className="flex items-center gap-2.5 mb-4 flex-wrap">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-light">
        {t("extract.ocrEngine")}
      </span>
      <div className="flex items-center gap-1 rounded-lg bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
        {OCR_TYPES.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            title={t(opt.hint)}
            className={`px-3.5 py-1.5 rounded-md text-[12px] font-medium tracking-tight transition-all duration-200 cursor-pointer active:scale-95 ${
              value === opt.value
                ? "bg-violet-600 text-white"
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
  const [startTime, setStartTime] = useState<number | undefined>(undefined);

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
    <div>
      <PageHeader
        title={
          <>
            {t("extract.title1")}{" "}
            <span className="text-accent-light">{t("extract.title2")}</span>
          </>
        }
        description={t("extract.desc")}
      />

      <StepTabs current={step} />

      <div key={step}>
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
              onConfirmed={(r, st) => {
                setRegion(r);
                setStartTime(st);
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
            startTime={startTime}
            onReset={() => {
              setVideoId("");
              setRegion(null);
              setStartTime(undefined);
              setStep("upload");
            }}
            onDone={() => router.push(`/video/${videoId}`)}
            onViewLibrary={() => router.push("/")}
          />
        )}
      </div>
    </div>
  );
}
