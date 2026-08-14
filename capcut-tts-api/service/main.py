"""CapCut TTS Gen-Voice FastAPI service entrypoint.

Run with::

    python -m service.main          # uvicorn worker on CTTS_port (default 8100)
    uvicorn service.main:app --port 8100
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from capcut_tts_api import CapCutClient, DeviceConfig
from service.config import settings
from service.routers import audio, tts, voices
from service.worker import worker_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("service.main")


def _build_client() -> CapCutClient:
    if settings.device_json:
        device = DeviceConfig.from_json_file(settings.device_json)
        logger.info("Loading device identity from %s", settings.device_json)
        return CapCutClient(device=device)
    return CapCutClient()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("%s v%s starting...", settings.service_name, settings.version)

    client = _build_client()
    app.state.capcut_client = client
    app.state.jobs: dict = {}
    app.state.ws_clients: dict = {}
    app.state.job_queue: asyncio.Queue = asyncio.Queue()

    voice_count = len(client.list_voices())
    logger.info("Voice catalog loaded: %d voices", voice_count)
    logger.info("temp_dir: %s", settings.temp_dir)
    logger.info("default_voice: %s", settings.default_voice)

    worker = asyncio.create_task(
        worker_loop(client, app.state.jobs, app.state.ws_clients, app.state.job_queue)
    )
    logger.info("Server ready  >>>  http://localhost:%d", settings.port)
    logger.info("")
    yield

    worker.cancel()
    try:
        await worker
    except asyncio.CancelledError:
        pass
    from service.worker import shutdown_executor

    shutdown_executor()
    logger.info("Shutdown complete")


app = FastAPI(
    title=settings.service_name,
    version=settings.version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tts.router)
app.include_router(voices.router)
app.include_router(audio.router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": settings.service_name,
        "version": settings.version,
        "voices_loaded": len(app.state.capcut_client.list_voices()),
    }


def main():
    import uvicorn

    uvicorn.run("service.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()