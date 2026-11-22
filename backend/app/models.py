from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Region(BaseModel):
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)
    x2: float = Field(ge=0, le=1)
    y2: float = Field(ge=0, le=1)


OcrType = Literal["paddle", "apple"]
OcrDecoder = Literal["nvdec", "ffmpeg_cpu"]


class ProcessRequest(BaseModel):
    video_id: str
    region: Region
    fps: int | None = None
    lang: str = "ch"
    ocr_type: OcrType = "paddle"
    decoder: OcrDecoder = "nvdec"
    start_time: float | None = None  # Skip frames before this timestamp (seconds)
    end_time: float | None = None    # Stop at this timestamp (seconds)
    # Pipeline có bước context riêng (bước 6) nên yêu cầu worker KHÔNG tự
    # sinh ngữ cảnh sau OCR — tránh gọi Gemini Vision 2 lần / video.
    # Extract flow (ResultPage) giữ mặc định False để vẫn auto như cũ.
    skip_auto_context: bool = False

    @field_validator("decoder", mode="before")
    @classmethod
    def migrate_legacy_decoder(cls, value):
        return "ffmpeg_cpu" if value == "opencv" else value


class LogEntry(BaseModel):
    message: str
    ts: float = 0
    level: str = "info"


class ProcessingTiming(BaseModel):
    started_at: float | None = None
    finished_at: float | None = None
    elapsed_ms: float = 0
    running: bool = False


class JobStatus(BaseModel):
    job_id: str
    status: str
    phase: str = ""
    progress: int = 0
    error: str | None = None
    logs: list[LogEntry] = []
    # Step-level scheduler info (None for jobs that never entered a lane,
    # e.g. telegram_auto internals inspected from the legacy path).
    lane: str | None = None
    queue_position: int | None = None
    processing_timing: ProcessingTiming | None = None


class SrtEntry(BaseModel):
    index: int
    start: float
    end: float
    startLabel: str
    endLabel: str
    text: str


class UpdateSrtRequest(BaseModel):
    content: str


class TimelineCheckState(BaseModel):
    """Timeline-review popup state for the "Kiểm tra dịch sub" step, reported so
    other tabs/browsers can show the same popup when they view the video."""
    waiting: bool = False            # pipeline is paused awaiting review
    open: bool = False               # big review modal shown (vs small prompt)
    issues: list[dict] = []
    fixing: bool = False
    decision: str | None = None      # "continue" | "fix" once someone resolves
    lang: str = "vi"
    source_lang: str = "zh"
    source_track: Literal["original", "vi"] = "original"


class TimelineAction(BaseModel):
    action: Literal["wait", "open", "close", "continue", "fix"]
    issues: list[dict] = []
    lang: str | None = None
    source_lang: str = "zh"
    source_track: Literal["original", "vi"] = "original"


class TelegramAutoRequest(BaseModel):
    """Request body for POST /api/telegram/auto — full Douyin pipeline config."""
    url: str
    chat_id: int
    src_lang: str = "zh"
    region_mode: str = "auto"
    dub_on: bool = True
    dub_engine: str = "capcut"
    dub_voice: str = "BV421_vivn_streaming"
    original_voice: str = "mute"
    original_gain_db: float = 0.0
    multi_voice: bool = False
    auto_fit: bool = True
    translate_on: bool = True
    translate_target: str = "vi"
    auto_dub: bool = True
    watermark: str = "none"
    watermark_preset: str = ""
    remove_watermark: bool = False
    check_subs: bool = True
    check_voice: bool = True
    thumbnail: str = "none"
    auto_upload_youtube: bool = False
    youtube_channel: str = ""
    playback_speed: float = 1.0


class PipelineState(BaseModel):
    """Frontend AutoPipeline progress reported for a video, so other tabs (and
    the video list) can mirror the exact step-by-step progress."""
    status: str = "running"          # queued | running | done | error
    stage: str = "processing"
    progress: float = 0
    step_progress: list[float | None] = []
    error: str = ""
    timeline_check: TimelineCheckState | None = None
