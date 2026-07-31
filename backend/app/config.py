from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    base_dir: Path = Path(__file__).resolve().parent.parent
    temp_dir: Path = base_dir / "temp"

    extract_fps: int = 10
    ocr_lang: str = "ch"
    similarity_threshold: float = 0.85
    max_upload_size: int = 500 * 1024 * 1024
    job_timeout: int = 1800
    ocr_cache_max_streak: int = 15

    det_db_thresh: float = 0.3
    text_score: float = 0.5

    model_config = {"env_prefix": "STE_", "env_file": ".env"}


settings = Settings()
settings.temp_dir.mkdir(parents=True, exist_ok=True)
(settings.temp_dir / "videos").mkdir(exist_ok=True)
(settings.temp_dir / "frames").mkdir(exist_ok=True)
(settings.temp_dir / "srt").mkdir(exist_ok=True)
