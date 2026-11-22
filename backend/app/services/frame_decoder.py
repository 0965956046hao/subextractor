"""Selectable FFmpeg frame decoding with explicit preflight/fallback.

Both decoders preserve global frame-index sampling and return BGR NumPy images,
including NVDEC's GPU-to-RAM transfer. OpenCV is used only for video metadata.
"""

import json
import subprocess
import tempfile
import threading
import time
from fractions import Fraction

import cv2
import numpy as np

from app.services.job_utils import JobCancelled

DECODER_LABELS = {"ffmpeg_cpu": "CPU — FFmpeg", "nvdec": "GPU — NVDEC"}
NVDEC_CODECS = {"h264": "h264_cuvid", "hevc": "hevc_cuvid", "av1": "av1_cuvid",
                "vp9": "vp9_cuvid", "mpeg2video": "mpeg2_cuvid", "vc1": "vc1_cuvid"}


def probe_source(path: str) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,r_frame_rate,avg_frame_rate,pix_fmt", "-of", "json", str(path),
    ], capture_output=True, text=True, timeout=15, check=True)
    info = json.loads(result.stdout)["streams"][0]
    rate = Fraction(info.get("r_frame_rate", "0/1"))
    if rate <= 0 or rate != Fraction(info.get("avg_frame_rate", "0/1")):
        raise ValueError("Chưa hỗ trợ video FPS biến thiên/không xác định trong luồng OCR FFmpeg")
    return info


def selected_indices(total, source_fps, target_fps, start_time=None, end_time=None):
    start = int(start_time * source_fps) if start_time and start_time > 0 else 0
    end = min(total, int(end_time * source_fps)) if end_time and end_time > 0 else total
    step = max(1, int(round(source_fps / target_fps))) if target_fps and target_fps > 0 else 1
    return range(start + (-start % step), end, step), start


def decoder_command(path, codec, decoder, source_fps, start, step, count):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1"]
    if decoder == "nvdec":
        if codec not in NVDEC_CODECS:
            raise ValueError(f"NVDEC chưa hỗ trợ codec {codec} trong ứng dụng")
        cmd += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-c:v", NVDEC_CODECS[codec]]
    elif decoder != "ffmpeg_cpu":
        raise ValueError(f"Invalid FFmpeg decoder: {decoder}")
    if start:
        cmd += ["-ss", f"{start / source_fps:.9f}"]
    cmd += ["-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn"]
    filters = f"select='not(mod(n+{start},{step}))'"
    filters += ",hwdownload,format=nv12" if decoder == "nvdec" else ",format=nv12"
    cmd += ["-vf", filters + ",format=bgr24", "-frames:v", str(count), "-fps_mode", "passthrough",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    return cmd


def read_frame(stream, size):
    parts = []
    remaining = size
    while remaining:
        part = stream.read(remaining)
        if not part:
            break
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def stream_ffmpeg_frames(path, fps=None, start_time=None, end_time=None, *, decoder="nvdec", cancelled_cb=None):
    info = probe_source(path)
    if decoder == "nvdec" and info.get("pix_fmt", "yuv420p") != "yuv420p":
        raise ValueError(f"Đường NVDEC hiện chỉ hỗ trợ yuv420p 8-bit (video: {info.get('pix_fmt')})")
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {path}")
        source_fps = cap.get(cv2.CAP_PROP_FPS)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    finally:
        cap.release()
    indices, start = selected_indices(total, source_fps, fps, start_time, end_time)
    if not indices:
        return
    args = decoder_command(path, info["codec_name"], decoder, source_fps, start, indices.step, len(indices))
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        stop = threading.Event()
        reading_since = [None]
        failure = []

        def watchdog():
            # A blocked pipe read must not prevent pause/cancel or hang forever.
            while not stop.wait(0.2):
                cancelled = cancelled_cb is not None and cancelled_cb()
                since = reading_since[0]
                if cancelled or (since is not None and time.monotonic() - since > 60):
                    failure.append("cancelled" if cancelled else "FFmpeg không trả frame trong 60 giây")
                    if proc.poll() is None:
                        try:
                            proc.kill()
                        except OSError:
                            pass  # Main-thread cleanup may have won the race.
                    return

        monitor = threading.Thread(target=watchdog, daemon=True)
        monitor.start()
        try:
            for index in indices:
                if cancelled_cb is not None and cancelled_cb():
                    raise JobCancelled()
                reading_since[0] = time.monotonic()
                try:
                    data = read_frame(proc.stdout, width * height * 3)
                finally:
                    reading_since[0] = None
                if cancelled_cb is not None and cancelled_cb():
                    raise JobCancelled()
                if len(data) != width * height * 3:
                    errors.seek(0)
                    detail = errors.read().decode("utf-8", errors="replace")[-4000:]
                    raise RuntimeError(f"{decoder}: thiếu frame {index}: {'; '.join(failure)} {detail}")
                yield np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3), index / source_fps
            proc.stdout.close()
            code = proc.wait(timeout=15)
            if code:
                errors.seek(0)
                raise RuntimeError(f"{decoder}: {errors.read().decode('utf-8', errors='replace')[-4000:]}")
        finally:
            stop.set()
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=10)
            monitor.join(timeout=2)
            proc.stdout.close()


def resolve_decoder(path: str, requested: str, log, cancelled_cb=None) -> str:
    if requested == "opencv":
        # Migration only: this value is no longer an available decoder.
        log("Cấu hình decoder cũ được chuyển sang CPU — FFmpeg")
        requested = "ffmpeg_cpu"
    if requested not in DECODER_LABELS:
        raise ValueError(f"Decoder không hợp lệ: {requested}")
    if cancelled_cb is not None and cancelled_cb():
        raise JobCancelled()
    try:
        # Decode just the first frame to verify driver/codec/filter availability.
        frames = stream_ffmpeg_frames(path, 1, 0, 1, decoder=requested, cancelled_cb=cancelled_cb)
        try:
            next(frames)
        finally:
            frames.close()
    except JobCancelled:
        raise
    except Exception as exc:
        if requested == "ffmpeg_cpu":
            raise RuntimeError(f"Không khởi tạo được CPU — FFmpeg: {exc}") from exc
        log(f"Decoder yêu cầu: {DECODER_LABELS[requested]}; fallback về CPU — FFmpeg: {exc}")
        return resolve_decoder(path, "ffmpeg_cpu", log, cancelled_cb=cancelled_cb)
    log(f"Decoder thực tế: {DECODER_LABELS[requested]} (đã kiểm tra khởi tạo)")
    return requested
