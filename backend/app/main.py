import asyncio
import logging
import sys
from contextlib import asynccontextmanager

import os
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.services.ocr_engine import OCREngine
from app.services.apple_ocr_engine import AppleOCREngine
from app.routers import upload, video, process, download, tools, config_router, youtube, video_merge, health, pipeline, meta, thumbnail, capcut, google_tts;
from app.worker import worker_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("SubTitle Extractor v2 starting...")
    logger.info("")
    logger.info("  temp_dir: %s", settings.temp_dir)
    logger.info(
        "  extract_fps: %d (%s)", settings.extract_fps,
        "every frame" if settings.extract_fps <= 0 else f"~{settings.extract_fps} fps",
    )
    logger.info("  ocr_lang: %s", settings.ocr_lang)
    logger.info("")
    logger.info("Initializing OCR engines...")
    ocr_engine = OCREngine()
    app.state.ocr_engine = ocr_engine
    ocr_engines: dict = {"rapid": ocr_engine}
    try:
        apple_engine = AppleOCREngine()
        ocr_engines["apple"] = apple_engine
        app.state.apple_ocr_engine = apple_engine
    except Exception as e:
        logger.warning("Apple Vision OCR disabled: %s", e)
    app.state.ocr_engines = ocr_engines
    app.state.jobs: dict = {}
    app.state.ws_clients: dict = {}
    app.state.job_queue: asyncio.Queue = asyncio.Queue()
    # Frontend AutoPipeline step progress, keyed by video_id. Tab 1 (the one
    # driving the pipeline) reports its step_progress here; list_videos merges
    # it into rows so any other tab mirrors the exact same stage/%/steps.
    app.state.pipeline_states: dict = {}

    worker = asyncio.create_task(
        worker_loop(app.state.jobs, app.state.ws_clients, ocr_engines, app.state.job_queue)
    )
    logger.info("")
    logger.info("Server ready  >>>  http://localhost:8000")
    logger.info("")

    yield

    worker.cancel()
    try:
        await worker
    except asyncio.CancelledError:
        pass
    logger.info("Shutdown complete")


app = FastAPI(
    title="SubTitleExtractor",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router)
app.include_router(video.router)
app.include_router(process.router)
app.include_router(download.router)
app.include_router(tools.router)
app.include_router(config_router.router)
app.include_router(youtube.router)
app.include_router(video_merge.router)
app.include_router(health.router)
app.include_router(pipeline.router)
app.include_router(meta.router)
app.include_router(thumbnail.router)
app.include_router(capcut.router)
app.include_router(google_tts.router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "2.0.0"}
