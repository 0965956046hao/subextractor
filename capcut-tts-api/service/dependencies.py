"""FastAPI dependency providers for the gen-voice service."""

from typing import Dict, Set

from fastapi import Request, WebSocket


def get_jobs(request: Request) -> Dict:
    return request.app.state.jobs


def get_ws_clients(request: Request) -> Dict[str, Set]:
    return request.app.state.ws_clients


def get_job_queue(request: Request):
    return request.app.state.job_queue


def get_capcut_client(request: Request):
    return request.app.state.capcut_client
