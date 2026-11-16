# OCR checkpoints

OCR keeps the configured engine pool (default: two workers), but workers now
process small time ranges of the original video. No video copies or frame files
are created. Every fully completed chunk is written atomically to:

`backend/temp/srt/{video_id}/ocr_checkpoints/{configuration_hash}/{chunk}.json`

The default chunk length is 120 seconds, configurable with
`STE_ocr_checkpoint_seconds` (minimum effective value: 10 seconds). Adjacent
chunks read the configured `STE_ocr_parallel_overlap` for context. Output is
clipped to each chunk's owned interval, then matching captions at seams are
joined. Repeated captions separated by silence stay separate.

## Pause, crash, and retry

- Use the existing **Pause / Continue** buttons. Pause cancels active OCR without
  removing checkpoints. Continue submits a new job and reuses completed chunks.
- After OOM, backend restart, or a crash, retry OCR with the same settings.
  Completed chunks are loaded from disk. An interrupted chunk is rerun in full.
  With two workers, up to two in-flight chunks may need to be rerun.
- The checkpoint key includes source path/size/mtime, region, language, engine,
  sampling and recognition settings, time range, chunk length, and overlap.
  Changing these starts an independent checkpoint set. Worker count and device
  are excluded, so lowering parallelism after OOM preserves completed work.
- Progress includes work in the current chunks; after a crash it can fall back
  to the last *saved* chunks. The log reports restored and newly saved chunks.
- Retrying an incomplete OCR via `reset-from` preserves checkpoints. Rerunning
  a completed OCR deletes its SRT directory and checkpoints for a fresh run.
  To force a fresh run of an incomplete OCR, POST
  `/api/video/{video_id}/reset-from` with
  `{"from_step": 4, "discard_ocr_checkpoint": true}` after stopping the job.
- Deleting a video also removes its checkpoints. Existing runs that crashed
  before this feature was installed cannot be recovered retroactively.

Checkpointing does not guarantee lower OCR engine RAM usage or prevent OOM;
it limits lost work. If necessary, reduce `STE_ocr_parallel_parts` to 1.

## Verification

From `backend/`:

```powershell
python -m unittest discover -s tests -p test_ocr_checkpoint.py -v
```

Tests use temporary directories and fake OCR, not the user's videos or models.
