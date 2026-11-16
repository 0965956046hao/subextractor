# Per-step processing time

The Auto Pipeline shows processing duration only, not a waiting-time counter.
The overall pipeline elapsed time remains wall-clock time (including waits).

For OCR, context, Gemini translation, dubbing and hardcode/export, backend
`timed_job_call` starts the clock **inside the executor thread**. Lane waits,
shared resource waits and waiting for an executor worker are excluded. Work
inside the call, including Gemini/TTS network latency and retries, is included.
The clock stops on return/error, before Telegram notification or frontend review.
Frontend post-checks and manual dialogs do not extend that backend duration.

Delogo SSE sends its execution clock after acquiring its lane and starting
FFmpeg. Selecting a watermark region does not start this clock. Region/style
selection steps are manual and do not display a processing duration.

`GET /api/status/{job_id}` exposes `processing_timing` with backend monotonic
`elapsed_ms`, a running flag and wall-clock start/end timestamps. Frontend uses
the elapsed value, not a subtraction between browser and server clocks. It may
interpolate the live display between polls; the final backend value is exact
and never includes polling delay.

Explicit pause freezes the clock, with the final cancelled measurement fetched
from backend. A rerun clears the current/subsequent step measurements; each new
job is a separate attempt. Existing outputs show “Đã có kết quả”, not a made-up
processing time.

Measurements/job ids are saved with the frontend pipeline. On F5,
`GET /api/timings/{video_id}` recovers the latest matching attempts, including a
job that finished while the page reloaded. It must not mistake a historical
completed job for a freshly reset/rerun step. Backend restart still clears the
in-memory job queue; only already-saved frontend measurements survive that.
Jobs started before this instrumentation cannot be measured retrospectively;
their old queue-inclusive frontend timestamps are not shown as processing time.

Checks:

```text
backend:  .venv\Scripts\python.exe -m unittest discover -s tests -v
frontend: node scripts/test-processing-timing.cjs
frontend: node scripts/test-pipeline-scheduler.cjs
frontend: npx tsc --noEmit --incremental false
```

For an end-to-end check, queue multiple OCR/translation/dub jobs: waiting steps
must not tick, processing starts only after admission, review dialogs must not
increase finished times, and F5/pause/resume must not add queue or idle time.
