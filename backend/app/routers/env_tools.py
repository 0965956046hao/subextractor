import shutil
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

TOOLS_DIR = Path.home() / "Library" / "Application Support" / "com.subextractor.desktop" / "tools"
ARCHIVE_DIR = Path(__file__).resolve().parent.parent.parent.parent / "tools-dist"

TOOL_SPECS = [
    {"name": "ffmpeg",          "archive": "ffmpeg.tar.gz",          "display": "FFmpeg"},
    {"name": "demucs",          "archive": "demucs.tar.gz",          "display": "Demucs"},
    {"name": "youtubeuploader", "archive": "youtubeuploader.tar.gz", "display": "YouTube Uploader"},
]


def _is_installed(spec: dict) -> bool:
    name = spec["name"]
    marker = TOOLS_DIR / f".{name}.installed"
    in_dir = TOOLS_DIR.joinpath(name).is_file()
    in_dir_demucs = (name == "demucs" and TOOLS_DIR.joinpath("demucs").is_dir())
    in_path = shutil.which(name) is not None
    return marker.exists() or in_dir or in_dir_demucs or in_path


@router.get("/api/tools/check")
async def check_tools():
    return {
        "tools": [
            {"name": s["name"], "display": s["display"], "installed": _is_installed(s)}
            for s in TOOL_SPECS
        ]
    }


@router.post("/api/tools/install")
async def install_tools():
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    logs = []

    for spec in TOOL_SPECS:
        name = spec["name"]
        display = spec["display"]

        logs.append({"tool": name, "status": "checking", "message": f"Kiểm tra {display}..."})

        if _is_installed(spec):
            marker = TOOLS_DIR / f".{name}.installed"
            marker.write_text("1")
            logs.append({"tool": name, "status": "exists", "message": f"{display} đã có sẵn"})
            continue

        archive = ARCHIVE_DIR / spec["archive"]
        if not archive.is_file():
            logs.append({"tool": name, "status": "error", "message": f"{display}: không tìm thấy archive {spec['archive']}"})
            continue

        logs.append({"tool": name, "status": "extracting", "message": f"Đang giải nén {display}..."})

        try:
            result = subprocess.run(
                ["tar", "-xzf", str(archive)],
                cwd=str(TOOLS_DIR),
                capture_output=True,
                timeout=120,
            )
            if result.returncode == 0:
                marker = TOOLS_DIR / f".{name}.installed"
                marker.write_text("1")
                logs.append({"tool": name, "status": "done", "message": f"{display} cài xong"})
            else:
                logs.append({"tool": name, "status": "error", "message": f"{display}: giải nén thất bại"})
        except Exception as e:
            logs.append({"tool": name, "status": "error", "message": f"{display}: {e}"})

        time.sleep(0.1)

    return {"logs": logs}
