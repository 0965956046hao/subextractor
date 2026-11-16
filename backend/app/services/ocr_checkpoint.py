"""Durable, configuration-specific OCR chunks (no frame/video copies)."""

import hashlib
import json
import logging
import math
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.services.job_utils import JobCancelled

logger = logging.getLogger(__name__)
VERSION = 1


class OCRCheckpoint:
    def __init__(self, root: Path, identity: dict):
        self.identity = {"version": VERSION, **identity}
        digest = hashlib.sha256(
            json.dumps(self.identity, sort_keys=True, allow_nan=False).encode("utf-8")
        ).hexdigest()[:24]
        self.directory = root / digest

    def load(self, index: int, bounds: tuple[float, float]):
        path = self.directory / f"{index:06d}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data["identity"] != self.identity or data["bounds"] != list(bounds):
                return None
            entries = data["entries"]
            if not isinstance(entries, list):
                return None
            for start, end, text in entries:
                if (not isinstance(text, str) or not math.isfinite(start)
                        or not math.isfinite(end) or not bounds[0] <= start < end <= bounds[1]):
                    return None
            return [tuple(entry) for entry in entries]
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError, KeyError):
            logger.warning("Ignoring unreadable OCR checkpoint: %s", path)
            return None

    def save(self, index: int, bounds: tuple[float, float], entries: list):
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / f"{index:06d}.json"
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as stream:
                json.dump({"identity": self.identity, "bounds": bounds, "entries": entries},
                          stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def video_identity(video_path: str) -> dict:
    path = Path(video_path).resolve()
    stat = path.stat()
    return {"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def merge_chunk_entries(results: list, frame_interval: float) -> list:
    """Chunks own disjoint intervals; only join matching text at their seam."""
    from app.services.subtitle_generator import texts_similar

    merged = []
    for entries in results:
        for start, end, text in entries:
            if (merged and start - merged[-1][1] <= frame_interval * 1.5 + 1e-6
                    and texts_similar(merged[-1][2], text)):
                prev_start, prev_end, prev_text = merged[-1]
                merged[-1] = (prev_start, max(prev_end, end),
                              prev_text if len(prev_text) >= len(text) else text)
            else:
                merged.append((start, end, text))
    return merged


def run_checkpointed_ocr(
    *, checkpoint: OCRCheckpoint, start: float, end: float, chunk_seconds: float,
    overlap: float, frame_interval: float, engines: list, run_segment,
    cancelled, progress, log,
) -> list:
    """Use one engine per worker, saving only fully completed chunks atomically.

    Chunk boundaries do not depend on worker count, so a retry can use fewer
    engines without discarding progress. Partial chunks are deliberately rerun.
    """
    count = max(1, math.ceil((end - start) / chunk_seconds))
    bounds = [(start + i * chunk_seconds, min(end, start + (i + 1) * chunk_seconds))
              for i in range(count)]
    results = [checkpoint.load(i, bound) for i, bound in enumerate(bounds)]
    pending = iter(i for i, result in enumerate(results) if result is None)
    completed = sum(bound[1] - bound[0] for bound, result in zip(bounds, results)
                    if result is not None)
    cached = sum(result is not None for result in results)
    if cached:
        log(f"Tiếp tục OCR: đã khôi phục {cached}/{count} đoạn từ checkpoint; bỏ qua các đoạn đã lưu.")
    else:
        log(f"OCR tự lưu tiến độ sau mỗi đoạn {chunk_seconds:.0f} giây ({count} đoạn).")
    duration = end - start
    lock = threading.Lock()
    stopped = threading.Event()
    partial = {}

    def check_cancelled():
        if cancelled() or stopped.is_set():
            raise JobCancelled()

    def report():
        # Hold lock while notifying so progress updates cannot arrive out of order.
        progress(min(99, int((completed + sum(partial.values())) / duration * 100)))

    with lock:
        report()

    def worker(engine):
        nonlocal completed
        try:
            while True:
                check_cancelled()
                with lock:
                    index = next(pending, None)
                if index is None:
                    return
                core_start, core_end = bounds[index]
                read_start = max(start, core_start - overlap)
                read_end = min(end, core_end + overlap)

                def on_frame(idx, total):
                    check_cancelled()
                    with lock:
                        partial[index] = max(0.0, min(core_end - core_start,
                            (idx + 1) * frame_interval - (core_start - read_start)))
                        report()

                entries, _ = run_segment(engine, read_start, read_end, on_frame)
                check_cancelled()
                # Keep overlap only for recognition context, not duplicated output.
                entries = [(max(s, core_start), min(e, core_end), text)
                           for s, e, text in entries
                           if min(e, core_end) > max(s, core_start)]
                checkpoint.save(index, bounds[index], entries)
                with lock:
                    results[index] = entries
                    completed += core_end - core_start
                    partial.pop(index, None)
                    report()
                log(f"Đã lưu checkpoint OCR đoạn {index + 1}/{count} "
                    f"({core_start:.0f}–{core_end:.0f}s).")
        except BaseException:
            stopped.set()
            raise

    # Waiting for every worker before returning keeps an old cancelled attempt
    # from racing a newly resumed job on shared engines/checkpoints.
    with ThreadPoolExecutor(max_workers=len(engines)) as executor:
        futures = [executor.submit(worker, engine) for engine in engines]
        errors = []
        for future in futures:
            try:
                future.result()
            except Exception as exc:
                errors.append(exc)
        if errors:
            # Preserve the actual OOM/error, rather than a sibling's stop signal.
            raise next((exc for exc in errors if not isinstance(exc, JobCancelled)), errors[0])
    check_cancelled()
    progress(100)
    return merge_chunk_entries(results, frame_interval)
