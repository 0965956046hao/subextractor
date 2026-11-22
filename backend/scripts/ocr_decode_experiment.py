"""Experimental FFmpeg frame sources. Never selected by production workers.

NVDEC downloads selected frames back to RAM as BGR, matching the NumPy OCR
contract. This deliberately measures transfer/pipe costs, not just decoding.
Only constant-frame-rate inputs are supported by this experiment.
"""

import json
import subprocess
import tempfile

import cv2
import numpy as np


def probe(path):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,r_frame_rate,avg_frame_rate,pix_fmt", "-of", "json", str(path),
    ], capture_output=True, text=True, timeout=15, check=True)
    stream = json.loads(result.stdout)["streams"][0]
    if stream.get("r_frame_rate") != stream.get("avg_frame_rate"):
        raise ValueError("Decode experiment requires CFR video for frame-index parity")
    if stream["pix_fmt"] != "yuv420p":
        raise ValueError("Decode experiment currently supports 8-bit yuv420p only")
    return stream


def selected_indices(total, source_fps, target_fps, start_time=None, end_time=None):
    start = int(start_time * source_fps) if start_time and start_time > 0 else 0
    end = min(total, int(end_time * source_fps)) if end_time and end_time > 0 else total
    step = max(1, int(round(source_fps / target_fps))) if target_fps and target_fps > 0 else 1
    return range(start + (-start % step), end, step), start


def command(path, codec, mode, source_fps, start, step, count):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1"]
    if mode == "ffmpeg-gpu":
        decoders = {"h264": "h264_cuvid", "hevc": "hevc_cuvid", "av1": "av1_cuvid"}
        if codec not in decoders:
            raise ValueError(f"No experimental NVDEC decoder for {codec}")
        cmd += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-c:v", decoders[codec]]
    elif mode != "ffmpeg-cpu":
        raise ValueError(f"Invalid decode experiment mode: {mode}")
    if start:
        cmd += ["-ss", f"{start / source_fps:.9f}"]
    cmd += ["-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn"]
    filters = f"select='not(mod(n+{start},{step}))'"
    if mode == "ffmpeg-gpu":
        filters += ",hwdownload,format=nv12"
    else:
        # Match the hardware decoder's NV12 layout before BGR conversion so
        # the CPU control differs in decoding, not chroma conversion layout.
        filters += ",format=nv12"
    filters += ",format=bgr24"
    cmd += ["-vf", filters, "-frames:v", str(count), "-fps_mode", "passthrough",
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


def stream_frames(path, fps=None, start_time=None, end_time=None, *, mode="ffmpeg-gpu"):
    info = probe(path)
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
    args = command(path, info["codec_name"], mode, source_fps, start, indices.step, len(indices))
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            for index in indices:
                data = read_frame(proc.stdout, width * height * 3)
                if len(data) != width * height * 3:
                    errors.seek(0)
                    detail = errors.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"FFmpeg {mode}: incomplete frame {index}: {detail}")
                yield np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3), index / source_fps
            proc.stdout.close()
            code = proc.wait(timeout=15)
            if code:
                errors.seek(0)
                raise RuntimeError(errors.read().decode("utf-8", errors="replace"))
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=10)
            proc.stdout.close()
