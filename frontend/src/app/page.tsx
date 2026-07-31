"use client";

import { useState, useEffect, useRef } from "react";
import UploadPage from "@/components/UploadPage";
import RegionSelector from "@/components/RegionSelector";
import ResultPage from "@/components/ResultPage";
import type { Region } from "@/lib/api";

type Step = "upload" | "select" | "result";

const STEPS: { key: Step; label: string; desc: string }[] = [
  { key: "upload", label: "Upload", desc: "Choose your video file" },
  { key: "select", label: "Select Region", desc: "Mark the subtitle area" },
  { key: "result", label: "Extract", desc: "Process & download SRT" },
];

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function AnimatedBlock({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: 0,
        transform: "translateY(32px) scale(0.98)",
        filter: "blur(6px)",
        transition: `all 0.9s cubic-bezier(0.32,0.72,0,1) ${delay}ms`,
        ...(inView
          ? { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0)" }
          : {}),
      }}
    >
      {children}
    </div>
  );
}

function BentoStepIndicator({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="double-bezel mb-12">
      <div className="double-bezel-inner p-4 sm:p-5">
        <div className="flex items-center justify-center gap-0">
          {STEPS.map((step, i) => {
            const state = i < idx ? "done" : i === idx ? "active" : "pending";
            return (
              <div key={step.key} className="flex items-center">
                <div className="flex flex-col items-center gap-2.5">
                  <div className={`relative transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)] ${state === "active" ? "scale-110" : ""}`}>
                    <div
                      className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold
                        transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
                        ${state === "done" ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30"
                          : state === "active" ? "bg-blue-600 text-white shadow-[0_0_16px_rgba(59,130,246,0.2)]"
                          : "bg-black/[0.02] text-ink-muted/40 ring-1 ring-black/[0.06]"}`}
                    >
                      {state === "done" ? (
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      ) : (
                        <span className="tracking-tight">{String(i + 1).padStart(2, "0")}</span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-[11px] font-medium tracking-tight transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]
                      ${state === "done" ? "text-emerald-600/70"
                        : state === "active" ? "text-blue-600"
                        : "text-ink-light"}`}
                  >
                    {step.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={`w-12 sm:w-20 h-px mx-2 sm:mx-4 mb-7 transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
                      ${i < idx ? "bg-emerald-500/40" : "bg-black/[0.06]"}`}
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

export default function Home() {
  const [step, setStep] = useState<Step>("upload");
  const [videoId, setVideoId] = useState<string>("");
  const [region, setRegion] = useState<Region | null>(null);

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-16 md:py-24">
      <AnimatedBlock delay={0} className="text-center mb-10 sm:mb-14">
        <div className="eyebrow mx-auto mb-5 w-max">Video OCR Pipeline</div>
        <h1 className="text-[clamp(2rem,6vw,4.5rem)] font-semibold tracking-tight leading-[0.92] text-balance text-ink">
          SubTitle
          <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-blue-500 to-blue-400/60">
            Extractor
          </span>
        </h1>
        <p className="mt-4 text-sm sm:text-base text-ink-muted max-w-md mx-auto leading-relaxed">
          Upload a video, select the subtitle region, and extract clean SRT text
          with AI-powered OCR.
        </p>
      </AnimatedBlock>

      <AnimatedBlock delay={150}>
        <BentoStepIndicator current={step} />
      </AnimatedBlock>

      <AnimatedBlock delay={300} key={step}>
        <div className="w-full max-w-4xl mx-auto">
          {step === "upload" && (
            <UploadPage onUploaded={(id) => { setVideoId(id); setStep("select"); }} />
          )}
          {step === "select" && (
            <RegionSelector videoId={videoId} onConfirmed={(r) => { setRegion(r); setStep("result"); }} />
          )}
          {step === "result" && videoId && region && (
            <ResultPage videoId={videoId} region={region} onReset={() => { setVideoId(""); setRegion(null); setStep("upload"); }} />
          )}
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={500} className="mt-24 sm:mt-32 text-center">
        <p className="text-[11px] text-ink-light tracking-wide">
          SubTitle Extractor &mdash; built with FastAPI &amp; Next.js
        </p>
      </AnimatedBlock>
    </main>
  );
}
