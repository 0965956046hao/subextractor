"""Service configuration (pydantic-settings, env prefix ``CTTS_``)."""

from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    service_name: str = "CapCut TTS Gen-Voice Service"
    version: str = "1.0.0"

    base_dir: Path = Path(__file__).resolve().parent.parent
    temp_dir: Path = base_dir / "temp"

    host: str = "0.0.0.0"
    port: int = 8100

    default_voice: str = "BV074_streaming"
    default_rate: str = "1.0"
    poll_interval: float = 1.0
    job_timeout: int = 1800
    max_segments_per_job: int = 500

    device_json: Optional[Path] = None

    model_config = {"env_prefix": "CTTS_", "env_file": ".env"}


settings = Settings()
settings.temp_dir.mkdir(parents=True, exist_ok=True)
(settings.temp_dir / "jobs").mkdir(exist_ok=True)
