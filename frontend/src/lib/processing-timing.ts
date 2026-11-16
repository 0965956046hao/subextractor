export interface ProcessingTiming {
  started_at: number | null;
  finished_at: number | null;
  elapsed_ms: number;
  running: boolean;
}

export interface StepProcessingTiming {
  jobId: string;
  started: boolean;
  elapsedMs: number;
  running: boolean;
  receivedAt: number;
}

export function processingElapsed(
  timing: StepProcessingTiming | null | undefined,
  now: number,
  canRun: boolean,
): number | null {
  if (!timing?.started) return null;
  return Math.max(0, timing.elapsedMs) +
    (timing.running && canRun ? Math.max(0, now - timing.receivedAt) : 0);
}

export function receivedTiming(jobId: string, timing: ProcessingTiming, now = Date.now()): StepProcessingTiming {
  return { jobId, started: timing.started_at != null, elapsedMs: timing.elapsed_ms,
    running: timing.running, receivedAt: now };
}
