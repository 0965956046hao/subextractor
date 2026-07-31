---
name: ocr-setup
description: Use ONLY when setting up, configuring, or debugging PaddleOCR for Simplified Chinese text extraction. Covers installation, model download, GPU setup (CUDA / MPS), and OCR tuning.
---

# OCR Setup — PaddleOCR cho tiếng Trung Giản Thể (GPU)

## Installation

### macOS Apple Silicon (MPS backend)
```bash
pip install paddlepaddle paddleocr
```
PaddlePaddle ≥ 2.6 tự động dùng MPS (Metal Performance Shaders) khi `use_gpu=True`.

### NVIDIA GPU (CUDA)
```bash
pip install paddlepaddle-gpu paddleocr
```
Yêu cầu CUDA Toolkit + cuDNN. Xem [paddlepaddle.org](https://www.paddlepaddle.org.cn/install/quick?docurl=/documentation/docs/en/install/pip/macos-pip_en.html).

## Model
- PaddleOCR tự động download `ch_ppocr_mobile_v2.0` lần đầu chạy với `lang='ch'`
- Cache models tại `~/.paddleocr/`
- Nếu cần accuracy cao hơn: dùng server model (`ocr_version='PP-OCRv4'`)

## Configuration
```python
from paddleocr import PaddleOCR

ocr = PaddleOCR(
    use_angle_cls=True,    # Tự động xoay ảnh lệch
    lang='ch',              # Simplified Chinese
    use_gpu=True,           # GPU mode (MPS trên Apple Silicon / CUDA trên NVIDIA)
    ocr_version='PP-OCRv4', # Mobile model (nhanh + đủ chính xác)
    det_db_thresh=0.3,      # Detection threshold (lower = detect more)
    rec_batch_num=6,        # Batch size cho recognition
)
```

## Best Practices
1. **Crop trước khi OCR**: Crop vùng subtitle trước khi gọi OCR — giảm noise, tăng accuracy
2. **Pre-processing**: Resize crop về height ~32-64px (PaddleOCR optimal)
3. **Detection threshold**: `det_db_thresh=0.3` cho subtitle (chữ rõ, ít noise)
4. **Grayscale**: Chuyển crop sang grayscale nếu subtitle có contrast cao
5. **GPU batch**: GPU hỗ trợ batch processing — tăng `rec_batch_num` lên 8-16 nếu memory cho phép

## Troubleshooting

### GPU not detected / falls back to CPU
```python
import paddle
print(paddle.is_compiled_with_cuda())  # CUDA?
print(paddle.is_compiled_with_mps())    # MPS?
print(paddle.device.get_device())       # Current device
```
- MPS: cần PaddlePaddle ≥ 2.6 + macOS 12.3+
- CUDA: cần `nvidia-smi` hoạt động + CUDA toolkit khớp version

### ImportError / lib not found
```bash
# macOS: install dependencies
brew install opencv
```

### Model download chậm / fail
- Cache path: `~/.paddleocr/whl/det/...`
- Download manual: copy từ máy khác vào cache

### Memory
- GPU ~300-600MB VRAM tùy batch size
- Nếu OOM: giảm `rec_batch_num` (default 6 → 2-3)

## Performance (GPU)
| Platform | Model | ms/frame (crop) | Accuracy |
|----------|-------|----------------|----------|
| M1/M2 MPS | mobile (PP-OCRv4) | ~8-15ms | 85-90% |
| M1/M2 MPS | server | ~25-50ms | 90-95% |
| NVIDIA T4 CUDA | mobile | ~5-10ms | 85-90% |

GPU tăng tốc 2-4x so với CPU. Recommend: mobile model + GPU với ~5-10fps.
