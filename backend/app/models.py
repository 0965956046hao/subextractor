from pydantic import BaseModel, Field


class Region(BaseModel):
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)
    x2: float = Field(ge=0, le=1)
    y2: float = Field(ge=0, le=1)


class ProcessRequest(BaseModel):
    video_id: str
    region: Region
    fps: int | None = None


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
