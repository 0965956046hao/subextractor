# Per-step pipeline scheduling (no global video cap)

The frontend submits every ready pipeline, without the former 2/3-video limit.
`NEXT_PUBLIC_MAX_ACTIVE_PIPELINES` is no longer read; an existing value has no
effect. Reload restoration also handles all active/queued videos, not just three.

The backend remains the single scheduling authority:

- Each step has a capacity-one FIFO lane. Multiple videos may wait in that lane,
  but do not run the same step concurrently.
- Shared GPU/Gemini/CPU guards remain unchanged. An empty step may still wait
  for a resource owned by another step (for example OCR versus export on GPU,
  or context versus translation on Gemini).
- Resume keeps its existing backend priority without interrupting active work.
- Manual selections/reviews, explicit pause, completion, error and cancellation
  do not prevent unrelated videos from submitting work.
- Reload still attaches to existing jobs instead of submitting duplicate jobs.

For example, videos translating, dubbing and hardcoding no longer prevent a
fourth video from entering an idle OCR lane. Later videos can enter OCR as it
becomes available, even if earlier videos are waiting for translation.

This changes admission only, not worker counts, algorithms, checkpoints or
resource guards. More intermediate results and job followers can accumulate;
no throughput increase is guaranteed when an API or shared resource is busy.

## Execution labels in Auto Pipeline

The **Processing / waiting** tab includes both active work and queued videos.
Rows, the detail header and the current step distinguish:

- **Running**: executor timing confirms work has actually started (spinner).
- **Waiting for step, #N**: 1-based FIFO position, excluding the lane owner.
- **Waiting for resource**: the lane owner is blocked on GPU/Gemini/CPU.
- **Waiting for worker**: the lane owner is not executing yet and no shared
  resource is currently blocking it.
- **Waiting for your confirmation**: region/style/timeline/voice/manual gates.
- **Checking execution status**: missing, failed or stale backend observations;
  pipeline `status=running` alone is never presented as proof of execution.

One shared `/api/worker-status` poll every two seconds returns lightweight
`execution_jobs` (job/video/type, state, lane, queue position, blocking resources,
actual processing timing). This is read-only scheduler introspection, not a new
admission limit. Failed/stale observations stop reporting running; nothing is
persisted as execution truth. Direct watermark SSE requires both fresh timing
and matching backend lane ownership. Processing clocks freeze while waiting.

Deploy both backend and frontend for the execution labels. An old backend
without `execution_jobs` results in "Checking" rather than guessed running.

Verification from `frontend`:

```powershell
node scripts/test-pipeline-scheduler.cjs
node scripts/test-watermark-prep.cjs
node scripts/test-pipeline-resume.cjs
node scripts/test-processing-timing.cjs
node scripts/test-pipeline-execution.cjs
```
