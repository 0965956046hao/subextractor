"""Profile the real OCR worker in an isolated process/output directory.

No production jobs, models, FPS, subtitles or checkpoints are changed. Timings
are host wall times, NOT CUDA kernel timings. Worker-seconds must not be added
to or confused with overall elapsed time when workers run concurrently.
"""

import argparse
import asyncio
import json
import logging
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings
from app.services.paddle_ocr_engine import PaddleOCREngine
from app.services.video_processor import resolve_video_path
from app import worker


class Measurements:
    def __init__(self):
        self.local = threading.local()
        self.segments = []
        self.lock = threading.Lock()

    def add(self, key, value):
        segment = getattr(self.local, "segment", None)
        if segment is not None:
            segment[key] = segment.get(key, 0) + value

    def timed(self, fn, key):
        def call(*args, **kwargs):
            start = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                self.add(key, time.perf_counter() - start)
        return call

    def frame_stream(self, original):
        def stream(*args, **kwargs):
            frames = original(*args, **kwargs)
            try:
                while True:
                    started = time.perf_counter()
                    try:
                        item = next(frames)
                    except StopIteration:
                        self.add("frame_stream_seconds", time.perf_counter() - started)
                        return
                    self.add("frame_stream_seconds", time.perf_counter() - started)
                    self.add("sampled_frames", 1)
                    yield item
            finally:
                frames.close()
        return stream

    def segment(self, original):
        def run(*args, **kwargs):
            data = {"start": args[5], "end": args[6], "thread": threading.get_ident()}
            self.local.segment = data
            started = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                data["wall_seconds"] = time.perf_counter() - started
                with self.lock:
                    self.segments.append(data)
                self.local.segment = None
        return run

    def instrument_engine(self, engine):
        original = engine.ocr_region_cached

        def cached(crop):
            hits = engine._cache_hits
            started = time.perf_counter()
            try:
                return original(crop)
            finally:
                self.add("cache_and_model_seconds", time.perf_counter() - started)
                self.add("cache_hits", engine._cache_hits - hits)

        engine.ocr_region_cached = cached
        engine.ocr_image = self.timed(engine.ocr_image, "model_seconds")
        original_image = engine.ocr_image

        def infer(image):
            self.add("model_calls", 1)
            return original_image(image)

        engine.ocr_image = infer
        engine.set_lang = self.timed(engine.set_lang, "language_setup_seconds")


def engine_device(engine):
    pipeline = engine._engine.paddlex_pipeline
    result = {}
    for name, obj in (("pipeline", pipeline),
                      ("detector", getattr(pipeline, "text_det_model", None)),
                      ("recognizer", getattr(pipeline, "text_rec_model", None))):
        if obj is None:
            continue
        result[name] = {attr: str(getattr(obj, attr)) for attr in
                        ("device", "_device", "model_name", "_model_name") if hasattr(obj, attr)}
    return result


def summarize(values):
    return {"mean": statistics.mean(values), "min": min(values), "max": max(values)} if values else None


def sample_resources(stop, samples, errors):
    import psutil

    process = psutil.Process()
    process.cpu_percent()
    psutil.cpu_percent()
    start = time.perf_counter()
    while not stop.is_set():
        sample = {"elapsed_seconds": time.perf_counter() - start,
                  "process_cpu_percent": process.cpu_percent(),
                  "system_cpu_percent": psutil.cpu_percent(),
                  "ram_mb": process.memory_info().rss / 1024**2}
        try:
            query = subprocess.run([
                "nvidia-smi", "--query-gpu=utilization.gpu,utilization.memory,memory.used,power.draw,utilization.decoder",
                "--format=csv,noheader,nounits", "--id=0",
            ], capture_output=True, text=True, timeout=4, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if query.returncode:
                raise RuntimeError(query.stderr.strip())
            for key, value in zip(("gpu_percent", "memory_controller_percent", "vram_mb", "power_w", "decoder_percent"),
                                  query.stdout.strip().split(",")):
                sample[key] = float(value.strip())
        except Exception as exc:
            errors.append(str(exc))
        if len(samples) % 10 == 0:
            try:
                with urllib.request.urlopen("http://localhost:8002/api/videos", timeout=2) as response:
                    videos = json.load(response).get("videos", [])
                sample["other_active_jobs"] = [
                    {"video_id": v.get("video_id"), "type": v.get("job_type"), "status": v.get("status")}
                    for v in videos if v.get("status") in ("queued", "processing")
                ]
            except Exception as exc:
                sample["server_check_error"] = str(exc)
        samples.append(sample)
        stop.wait(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video_id")
    parser.add_argument("--output", type=Path, required=True, help="New diagnostic directory (must not exist)")
    parser.add_argument("--decode", choices=("ffmpeg-cpu", "ffmpeg-gpu"), default="ffmpeg-gpu")
    args = parser.parse_args()
    if not args.video_id.isalnum():
        parser.error("Invalid video id")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    metadata = json.loads((settings.temp_dir / "videos" / args.video_id / "meta.json").read_text(encoding="utf-8"))
    saved = metadata.get("pipeline_settings", {})
    region = saved.get("region")
    if not region:
        parser.error("No saved OCR region; select the subtitle region first")
    video_path = resolve_video_path(args.video_id)
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    # Change only this diagnostic process's output root, never production data.
    settings.temp_dir = args.output / "work"
    settings.temp_dir.mkdir()
    import cv2

    capture = cv2.VideoCapture(video_path)
    fps = capture.get(cv2.CAP_PROP_FPS)
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    dimensions = [int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))]
    capture.release()
    pool = [PaddleOCREngine() for _ in range(max(1, settings.ocr_parallel_parts))]
    import paddle

    report = {"video_id": args.video_id, "video_path": video_path, "dimensions": dimensions,
              "source_fps": fps, "source_frames": count, "duration_seconds": count / fps,
              "target_fps": settings.extract_fps, "workers": len(pool), "region": region,
              "device_setting": settings.ocr_device, "paddle_device": paddle.device.get_device(),
              "cuda_build": paddle.is_compiled_with_cuda(), "engines": [engine_device(e) for e in pool],
              "fresh_checkpoints": True,
              "decode_backend": args.decode,
              "timing_note": "Host wall time per stage; sums are worker-seconds, not end-to-end time or CUDA kernel time."}
    metrics = Measurements()
    for engine in pool:
        metrics.instrument_engine(engine)
    samples, errors = [], []
    stop = threading.Event()
    sampler = threading.Thread(target=sample_resources, args=(stop, samples, errors), daemon=True)
    loop = asyncio.new_event_loop()
    loop_thread = threading.Thread(target=loop.run_forever, daemon=True)
    loop_thread.start()
    job = {"job_id": "diagnostic", "video_id": args.video_id, "ocr_type": "paddle", "cancelled": False,
           "decoder": "nvdec" if args.decode == "ffmpeg-gpu" else "ffmpeg_cpu"}
    sampler.start()
    started = time.perf_counter()
    try:
        with patch.object(worker, "stream_ffmpeg_frames", metrics.frame_stream(worker.stream_ffmpeg_frames)), \
             patch.object(worker, "crop_region", metrics.timed(worker.crop_region, "crop_seconds")), \
             patch.object(worker, "_ocr_segment_entries", metrics.segment(worker._ocr_segment_entries)):
            content = worker.process_job_sync(
                video_path, region, settings.extract_fps or None, pool, {}, "diagnostic", loop,
                job, saved.get("ocrLang", settings.ocr_lang),
            )
        (args.output / "subtitles.srt").write_text(content, encoding="utf-8")
        report["status"] = "done"
    except BaseException as exc:
        report.update(status="error", error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        report["wall_seconds"] = time.perf_counter() - started
        report["actual_decoder"] = job.get("decoder")
        stop.set()
        sampler.join(timeout=8)
        loop.call_soon_threadsafe(loop.stop)
        loop_thread.join(timeout=3)
        loop.close()
        report["segments"] = sorted(metrics.segments, key=lambda s: s["start"])
        keys = ("wall_seconds", "frame_stream_seconds", "crop_seconds", "cache_and_model_seconds",
                "model_seconds", "language_setup_seconds", "sampled_frames", "model_calls", "cache_hits")
        totals = {key: sum(s.get(key, 0) for s in metrics.segments) for key in keys}
        totals["cache_check_seconds"] = totals["cache_and_model_seconds"] - totals["model_seconds"]
        totals["other_seconds"] = (totals["wall_seconds"] - totals["frame_stream_seconds"] - totals["crop_seconds"]
                                   - totals["cache_and_model_seconds"] - totals["language_setup_seconds"])
        report["worker_totals"] = totals
        report["resource_samples"] = samples
        report["resource_summary"] = {key: summarize([s[key] for s in samples if key in s]) for key in
                                      ("gpu_percent", "decoder_percent", "vram_mb", "power_w", "process_cpu_percent", "system_cpu_percent")}
        report["sampling_errors"] = errors
        (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in report.items() if key not in ("segments", "resource_samples")},
                         ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
