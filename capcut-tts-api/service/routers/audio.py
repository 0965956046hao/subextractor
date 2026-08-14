"""Serve generated audio files for a job."""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response

from service.config import settings
from service.dependencies import get_jobs

router = APIRouter(prefix="/api", tags=["audio"])


@router.get("/tts/{job_id}/audio/{filename}")
async def get_audio(job_id: str, filename: str, jobs: dict = Depends(get_jobs)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    out_dir = Path(job.get("out_dir") or "")
    if not out_dir.exists():
        raise HTTPException(status_code=404, detail="Audio not generated yet")
    target = (out_dir / filename).resolve()
    if not target.is_file() or out_dir.resolve() not in target.parents:
        raise HTTPException(status_code=404, detail=f"File {filename} not found")
    return FileResponse(target, media_type="audio/mpeg")


@router.get("/tts/{job_id}/download")
async def download_all(job_id: str, jobs: dict = Depends(get_jobs)):
    """Download all generated audio for a job as a ZIP archive."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    out_dir = Path(job.get("out_dir") or "")
    if not out_dir.exists():
        raise HTTPException(status_code=404, detail="Audio not generated yet")

    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(out_dir.glob("*")):
            if p.is_file():
                zf.write(p, arcname=p.name)
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{job_id}.zip"'},
    )
