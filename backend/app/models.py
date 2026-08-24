from typing import Literal

from pydantic import BaseModel, Field


class Region(BaseModel):
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)
    x2: float = Field(ge=0, le=1)
    y2: float = Field(ge=0, le=1)


OcrType = Literal["rapid", "apple"]


class ProcessRequest(BaseModel):
    video_id: str
    region: Region
    fps: int | None = None
    lang: str = "ch"
    ocr_type: OcrType = "apple"
    start_time: float | None = None  # Skip frames before this timestamp (seconds)
    end_time: float | None = None    # Stop at this timestamp (seconds)


class LogEntry(BaseModel):
    message: str
    ts: float = 0
    level: str = "info"


class JobStatus(BaseModel):
    job_id: str
    status: str
    phase: str = ""
    progress: int = 0
    error: str | None = None
    logs: list[LogEntry] = []


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


class TimelineAction(BaseModel):
    action: Literal["wait", "open", "close", "continue", "fix"]
    issues: list[dict] = []


class PipelineState(BaseModel):
    """Frontend AutoPipeline progress reported for a video, so other tabs (and
    the video list) can mirror the exact step-by-step progress."""
    status: str = "running"          # queued | running | done | error
    stage: str = "processing"
    progress: float = 0
    step_progress: list[float | None] = []
    error: str = ""
    timeline_check: TimelineCheckState | None = None
