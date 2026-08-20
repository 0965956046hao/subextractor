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

    det_db_thresh: float = 0.3
    text_score: float = 0.5
    job_timeout: int = 0  # giây; 0 = không giới hạn thời gian xử lý job

    # Gemini translation
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"

    # Google Cloud TTS
    google_tts_credentials: str = ""
    # fal.ai (image-to-image thumbnail)
    fal_key: str = ""
    # CapCut TTS gen-voice service (capcut-tts-api, FastAPI :8100)
    capcut_tts_url: str = "http://127.0.0.1:8100"
    capcut_tts_default_voice: str = "BV421_vivn_streaming"
    capcut_tts_default_rate: str = "1.0"
    capcut_tts_timeout: int = 600

    # Parallel Range download (video/audio merge)
    parallel_download_enabled: bool = True
    parallel_download_min_size: int = 0  # 0 = luôn tách 4 luồng khi CDN hỗ trợ Range
    parallel_download_connections: int = 4

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
(settings.temp_dir / "hardcode").mkdir(exist_ok=True)
