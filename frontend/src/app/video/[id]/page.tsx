"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import TranscriptPlayer from "@/components/TranscriptPlayer";
import { AnimatedBlock } from "@/lib/animation";
import { listVideos } from "@/lib/api";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function VideoDetailPage() {
  const params = useParams<{ id: string }>();
  const videoId = params.id;

  const [filename, setFilename] = useState("");
  const [entries, setEntries] = useState<number | null>(null);
  const [createdAt, setCreatedAt] = useState("");

  useEffect(() => {
    let cancelled = false;
    listVideos()
      .then((videos) => {
        if (cancelled) return;
        const v = videos.find((item) => item.video_id === videoId);
        if (v) {
          setFilename(v.filename);
          setEntries(v.entries);
          setCreatedAt(v.created_at);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  return (
    <main className="min-h-[100dvh] max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <Link href="/" className="btn-island-secondary group !px-5 !py-2 text-[13px]">
          <span className="btn-island-icon !w-7 !h-7">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" /><path d="M11 18l-6-6 6-6" />
            </svg>
          </span>
          <span className="tracking-tight">Back to library</span>
        </Link>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mt-10 mb-10">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <div className="eyebrow mb-4">Extracted Video</div>
            <h1 className="text-[clamp(1.8rem,4.5vw,3.4rem)] font-semibold tracking-tight leading-[1.05] text-balance text-ink break-words">
              {filename || "Loading…"}
            </h1>
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              {entries !== null && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 text-[11px] font-medium text-emerald-600/90">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                    <path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
                  </svg>
                  {entries} subtitle lines
                </span>
              )}
              {createdAt && (
                <span className="text-[11px] text-ink-light tabular-nums">
                  Extracted {formatDate(createdAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </AnimatedBlock>

      <AnimatedBlock delay={200}>
        <TranscriptPlayer videoId={videoId} />
      </AnimatedBlock>
    </main>
  );
}
