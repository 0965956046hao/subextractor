import asyncio

from fastapi import Request, HTTPException

from app.services.paddle_ocr_engine import PaddleOCREngine


def get_ocr_engine(request: Request) -> PaddleOCREngine:
    engine: PaddleOCREngine | None = request.app.state.ocr_engine
    if engine is None:
        raise HTTPException(503, "OCR engine not initialized")
    return engine


def get_ocr_engines(request: Request) -> dict:
    return request.app.state.ocr_engines


def get_jobs(request: Request) -> dict:
    return request.app.state.jobs


def get_ws_clients(request: Request) -> dict:
    return request.app.state.ws_clients


def get_job_queue(request: Request) -> asyncio.Queue:
    return request.app.state.job_queue


def get_pipeline_states(request: Request) -> dict:
    return request.app.state.pipeline_states
