from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    base_dir: Path = Path(__file__).resolve().parent.parent
    temp_dir: Path = base_dir / "temp"

    extract_fps: int = 0
    ocr_lang: str = "ch"
    similarity_threshold: float = 0.85
    merge_similarity: float = 0.9
    subtitle_flash_seconds: float = 2.0
    max_upload_size: int = 0
    ocr_cache_max_streak: int = 15

    det_db_thresh: float = 0.3
    text_score: float = 0.5
    job_timeout: int = 1800

    # Gemini translation
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"

    # Google Cloud TTS
    google_tts_credentials: str = ""

    # fal.ai (image-to-image thumbnail)
    fal_key: str = ""

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
