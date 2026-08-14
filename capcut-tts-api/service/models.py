"""Pydantic v2 schemas for the gen-voice service."""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class VoiceSegment(BaseModel):
    """A single text block to synthesize (one SRT entry)."""

    text: str = Field(..., min_length=1)
    start: float = 0.0
    end: float = 0.0


class TTSRequest(BaseModel):
    """Body for submitting a voice-generation job."""

    segments: List[VoiceSegment] = Field(default_factory=list, min_length=1)
    voice: str = "BV074_streaming"
    rate: str = "1.0"
    filename_prefix: str = "segment"


class TTSJobCreated(BaseModel):
    job_id: str


class LogEntry(BaseModel):
    message: str
    ts: float = 0.0
    level: str = "info"


class TTSJobStatus(BaseModel):
    job_id: str
    status: str
    phase: str = ""
    progress: int = 0
    error: Optional[str] = None
    logs: List[LogEntry] = Field(default_factory=list)
    audio_files: List[str] = Field(default_factory=list)
    out_dir: Optional[str] = None


class VoiceInfoOut(BaseModel):
    voice_type: str
    display_name: str
    resource_id: str
    lang: str
    lan: str


class HealthOut(BaseModel):
    status: str
    service: str
    version: str
    voices_loaded: int
