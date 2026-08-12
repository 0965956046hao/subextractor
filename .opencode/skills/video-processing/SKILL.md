---
name: video-processing
description: Use ONLY when working with FFmpeg, OpenCV, or frame extraction for SubTitleExtractor. Covers FFmpeg commands, frame extraction strategies, timestamp mapping, and efficient video handling.
---

# Video Processing — FFmpeg & OpenCV

## Frame Extraction Strategy

### FFmpeg (recommended)
```bash
# Extract 1 frame per second
ffmpeg -i input.mp4 -vf fps=1 frame_%04d.jpg

# Extract 2 frames per second
ffmpeg -i input.mp4 -vf fps=2 frame_%04d.jpg

# Extract at specific timestamps
ffmpeg -i input.mp4 -ss 00:01:00 -vframes 1 frame.jpg
```

### OpenCV fallback
```python
cap = cv2.VideoCapture(path)
fps = cap.get(cv2.CAP_PROP_FPS)
# Extract at target_fps (e.g. 2)
interval = int(fps / target_fps)
frames = []
while True:
    ret, frame = cap.read()
    if not ret: break
    if count % interval == 0:
        frames.append((frame, count / fps))
    count += 1
```

## Timestamp Mapping
Mỗi frame map với timestamp:
```
timestamp = frame_index / extraction_fps
```
Ví dụ: frame_0012.jpg @ 3fps → `00:00:04,000`

## Format for SRT Timecode
```python
def sec_to_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
```

## Optimization Tips
1. **Keyframe detection**: Skip frames có hash trùng (giảm OCR calls)
2. **Adaptive frame rate**: Extract thấp (0.5fps) nếu video > 30 phút
3. **Parallel OCR**: Dùng `ThreadPoolExecutor` cho multiple frames
4. **Cleanup**: Xóa frames tạm sau khi process xong

## FFmpeg Commands Cheatsheet
| Purpose | Command |
|---------|---------|
| Get video info | `ffprobe -v error -show_entries stream=width,height,r_frame_rate,duration -of default=noprint_wrappers=1` |
| Extract frames | `ffmpeg -i in.mp4 -vf fps=2 out/frame_%04d.jpg -hide_banner -loglevel error` |
| Get total frames | `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames` |
| Screenshot at time | `ffmpeg -ss 00:01:30 -i in.mp4 -vframes 1 frame.jpg` |
