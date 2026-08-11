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
