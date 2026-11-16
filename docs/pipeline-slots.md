# Processing slots (single shared scheduler)

The frontend admits **3 pipelines** to OCR and later steps by default. There is
still only one backend lane per step, one OCR engine pool, and unchanged shared
GPU/Gemini/CPU guards. Increasing slots does not permit two videos to run the
same step together or guarantee higher throughput.

Steps 1–4 run without consuming a processing slot. Later manual gates retain
their slot; explicit pause releases it. Completion, error and cancellation also
release slots. Resume has priority over regular waiting pipelines without
preempting a running video. The existing reload restoration uses the same limit.

## Return to 2 slots

Set in `frontend/.env.local` (not `backend/.env`):

```dotenv
NEXT_PUBLIC_MAX_ACTIVE_PIPELINES=2
```

Restart the frontend dev server. For production, rebuild and restart the
frontend: `NEXT_PUBLIC_*` values are embedded at build time. Remove the variable
or set it to `3` for the default. Only 2 and 3 slots are supported; any other
value uses the safe default of 3.

Change limits after draining active work, especially when decreasing from 3 to
2. Backend scheduler resources and Gemini key rotation are not changed. No A/B
groups or separate key pools are introduced.

Verification: `node scripts/test-pipeline-scheduler.cjs` from `frontend` exercises
admission, extra prep, gates, pause/resume and FIFO under both slot counts.
