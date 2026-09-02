from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    base_dir: Path = Path(__file__).resolve().parent.parent
    temp_dir: Path = base_dir / "temp"

    extract_fps: int = 15
    ocr_lang: str = "ch"
    similarity_threshold: float = 0.85
    merge_similarity: float = 0.9
    subtitle_flash_seconds: float = 2.0
    max_upload_size: int = 0
    ocr_cache_max_streak: int = 15
    # Hardcode (Pillow burn) parallelism: 0 = auto (min(4, cpu_count)); 1 = single process.
    hardcode_workers: int = 0
    # TTS parallelism: số luồng gọi API gen voice đồng thời (Google TTS + CapCut).
    tts_workers: int = 3
    # Số worker loop xử lý job song song. Mặc định 1 (xử lý tuần tự). Tăng lên
    # >1 để chạy nhiều job cùng lúc — lưu ý OCR/Demucs/hardcode có thể không
    # thread-safe, chỉ tăng khi cần và hiểu rõ rủi ro.
    job_workers: int = 1

    det_db_thresh: float = 0.3
    text_score: float = 0.5
    ocr_device: str = "gpu"  # paddle: "gpu" | "cpu" (STE_ocr_device)
    job_timeout: int = 0  # giây; 0 = không giới hạn thời gian xử lý job

    # Parallel OCR: chia timeline video thành N đoạn và OCR đồng thời N đoạn.
    # 1 = tắt (xử lý tuần tự như cũ). N > 1 = chạy N luồng OCR song song.
    # Mỗi đoạn dùng 1 engine riêng (RapidOCR load N model vào RAM).
    ocr_parallel_parts: int = 6
    # Chồng lấn giữa 2 đoạn liền kề (giây) để sub nằm ngay biên không bị cắt đôi;
    # phần trùng được gộp lại khi merge kết quả.
    ocr_parallel_overlap: float = 2.0

    # ── Heatmap ROI optimization (PaddleOCR only, sequential mode) ──
    # Tự động tinh region phụ đề dựa trên phân bố OCR results trên toàn video.
    # - roi_heatmap_sample_fps: số frame mẫu mỗi giây (mặc định 5 ≈ mỗi 0.2s, tiết kiệm time).
    # - roi_heatmap_density_threshold: ngưỡng mật độ box (0-1). Vùng phải có density >= threshold
    #    (ví dụ 0.5 nghĩa là region cần có >= 50% so sánh với max_box_count mới được coi hot).
    # - roi_heatmap_min_box_ratio: kích thước vùng ROI tối thiểu so với kích thước frame (đơn vị tỷ lệ 0-1).
    # - roi_heatmap_min_box_ratio: kích thước vùng ROI tối thiểu so với kích thước frame (đơn vị tỷ lệ 0-1).
    #   Ví dụ 0.01 = 1% diện tích frame. Tránh chọn vùng quá nhỏ là nhiễu.
    # - roi_heatmap_enable: bật/tắt feature (mặc định True).
    roi_heatmap_sample_fps: int = 15
    roi_heatmap_density_threshold: float = 0.5
    roi_heatmap_min_box_ratio: float = 0.01
    roi_heatmap_enable: bool = True

# ── Contrast-based noise filter (cho Pass 2 OCR chính thức) ──
    # Mục tiêu: lọc box có độ tương kontra giữa chữ và viền/below thấp,
    # thường thấy ở phụ đề có chất lượng kém hoặc văn bản lấn vào texture nền.
    # - Sử dụng Otsu thresholding để tách 2 cụm màu, tínhcontrast = chênh lệch mean luminance.
    # - Ngưỡngcontrast tối thiểu (ocr_contrast_threshold) - box dưới ngưỡng coi là "cần kiểm tra".
    # - Không dùng làm pass/fail cứng - thay vào đó tạo confidence score kết hợp cùng heatmap mass (pass 1).
    # - ocr_contrast_threshold: ngưỡngcontrast tối thiểu (0-255, default 200). Dưới ngưỡng = cần lo lường.
    # - ocr_contrast_weight: trọng sốcontrast trong confidence tổng (0-1, default 0.8).
    ocr_contrast_threshold: int = 200
    ocr_contrast_weight: float = 0.8

    # Gemini translation
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"

    # Google Cloud TTS
    google_tts_credentials: str = ""
    # fal.ai (image-to-image thumbnail)
    fal_key: str = ""
    # CapCut TTS gen-voice service (capcut-tts-api, FastAPI :8100)
    capcut_tts_url: str = "http://127.0.0.1:8100"
    capcut_tts_default_voice: str = "BV074_streaming_dsp"
    capcut_tts_default_rate: str = "1.0"
    capcut_tts_timeout: int = 600

    # Parallel Range download (video/audio merge)
    parallel_download_enabled: bool = True
    parallel_download_min_size: int = 0  # 0 = luôn tách 4 luồng khi CDN hỗ trợ Range
    parallel_download_connections: int = 4

    # URL public của backend (vd: Cloudflare Tunnel) — dùng để tạo link
    # xem/tải video trong thông báo Telegram. Rỗng = không kèm link.
    public_url: str = "https://freight-loved-institutions-lance.trycloudflare.com"

    # URL frontend Next.js (resolve Douyin bằng Chrome/Puppeteer). Backend gọi
    # endpoint này để lấy video_url + audio_url cho link Douyin (giống luồng FE).
    frontend_url: str = "http://localhost:3000"

    # Telegram Mini App dùng cho chọn vùng OCR + vị trí hiển thị phụ đề
    # (annotator). Cùng app với watermark (subtitlewatermark.vercel.app), phân
    # biệt hành động qua tham số `mode` (region | style).
    annotation_web_app_url: str = "https://subtitlewatermark.vercel.app"

    model_config = {"env_prefix": "STE_", "env_file": ".env"}


settings = Settings()
settings.temp_dir.mkdir(parents=True, exist_ok=True)
(settings.temp_dir / "videos").mkdir(exist_ok=True)
(settings.temp_dir / "frames").mkdir(exist_ok=True)
(settings.temp_dir / "srt").mkdir(exist_ok=True)
(settings.temp_dir / "muxed").mkdir(exist_ok=True)
(settings.temp_dir / "hardcoded").mkdir(exist_ok=True)
(settings.temp_dir / "tts").mkdir(exist_ok=True)
(settings.temp_dir / "translated").mkdir(exist_ok=True)
(settings.temp_dir / "projects").mkdir(exist_ok=True)
(settings.temp_dir / "tts_preview").mkdir(exist_ok=True)
