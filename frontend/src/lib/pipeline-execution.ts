import { receivedTiming, type ProcessingTiming, type StepProcessingTiming } from "./processing-timing";

export type ExecutionKind = "running" | "queued" | "waiting_resources" | "waiting_executor" |
  "checking" | "manual" | "preparing" | "paused" | "done" | "error";

export interface ExecutionJob {
  job_id: string;
  video_id: string;
  job_type: string;
  state: "running" | "queued" | "waiting_resources" | "waiting_executor" | "checking";
  queue_position: number | null;
  waiting_resources: string[];
  processing_timing?: ProcessingTiming;
}

export interface ExecutionSnapshot {
  receivedAt: number;
  jobs: ExecutionJob[];
  directWatermarkJob?: string | null;
}

export interface PipelineExecution {
  kind: ExecutionKind;
  step: number | null;
  jobId?: string;
  queuePosition?: number | null;
  resources?: string[];
  timing?: StepProcessingTiming;
  manual?: string;
}

interface ExecutionInput {
  status: string;
  stage: string;
  paused?: boolean;
  resumeStep?: number | null;
  videoId: string | null;
  timelineCheck?: { waiting: boolean } | null;
  voiceCheck?: { waiting: boolean } | null;
  stepTimings?: (StepProcessingTiming | null)[];
}

const STEP_JOBS: Record<number, string[]> = {
  4: ["ocr"], 5: ["watermark", "delogo"], 6: ["context"],
  7: ["translate", "align", "risk_check"], 8: ["dub", "tts", "bulk_switch"],
  9: ["hardcode", "export"],
};

export function pipelineExecution(
  p: ExecutionInput, step: number | null, snapshot: ExecutionSnapshot | null, now: number,
): PipelineExecution {
  if (p.status === "done" || p.status === "error") return { kind: p.status, step };
  if (p.paused) return { kind: "paused", step };
  if (p.timelineCheck?.waiting) return { kind: "manual", step: 7, manual: "timeline" };
  if (p.voiceCheck?.waiting) return { kind: "manual", step: 8, manual: "voice" };
  if (["region", "subtitle_preview", "watermark_region", "keep_original", "thumbnail_review"].includes(p.stage)) {
    return { kind: "manual", manual: p.stage,
      step: p.stage === "watermark_region" && (p.resumeStep ?? 4) <= 4 ? 4 : step };
  }
  if (step != null && step < 4) return { kind: "preparing", step };
  if (!snapshot || now - snapshot.receivedAt > 8000) return { kind: "checking", step };
  // Multiple jobs may exist for a video (old cancelled run / final repair).
  // Prefer the latest matching job, not a different step or a persisted flag.
  const job = [...snapshot.jobs].reverse().find((j) => j.video_id === p.videoId &&
    step != null && STEP_JOBS[step]?.includes(j.job_type));
  if (job) return { kind: job.state, step, jobId: job.job_id,
    queuePosition: job.queue_position, resources: job.waiting_resources,
    timing: job.processing_timing ? receivedTiming(job.job_id, job.processing_timing, snapshot.receivedAt) : undefined };
  // Watermark removal runs via SSE outside the jobs dict. Only a fresh,
  // actually-running backend timing event is positive execution evidence.
  const timing = step === 5 ? p.stepTimings?.[5] : null;
  if (timing && now - timing.receivedAt <= 8000) {
    return { kind: timing.running && snapshot.directWatermarkJob === timing.jobId
      ? "running" : timing.started ? "checking" : "queued",
      step, jobId: timing.jobId };
  }
  return { kind: "checking", step };
}
