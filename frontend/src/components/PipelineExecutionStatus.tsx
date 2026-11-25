"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { pipelineExecution, type ExecutionSnapshot } from "@/lib/pipeline-execution";
import { STEP_STAGE, type Pipeline } from "@/stores/pipeline-store";

const ExecutionContext = createContext<ExecutionSnapshot | null>(null);

/** One lightweight status poll for the entire page, not one request per row. */
export function PipelineExecutionProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch("/api/worker-status", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Worker status unavailable");
        const data = await response.json();
        if (mounted) setSnapshot(Array.isArray(data.execution_jobs)
          ? { receivedAt: Date.now(), jobs: data.execution_jobs,
              directWatermarkJob: data.lanes?.watermark?.running ?? null } : null);
      } catch {
        if (mounted) setSnapshot(null);
      } finally {
        clearTimeout(timeout);
        if (mounted) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { mounted = false; clearTimeout(timer); controller?.abort(); };
  }, []);
  return <ExecutionContext.Provider value={snapshot}>{children}</ExecutionContext.Provider>;
}

export function usePipelineExecution(p: Pipeline, now: number) {
  return pipelineExecution(p, p.status === "error" ? p.failedStep ?? null : STEP_STAGE[p.stage] ?? null,
    useContext(ExecutionContext), now);
}
