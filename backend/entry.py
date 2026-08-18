import os
import sys


def _ensure_data_dir() -> None:
    if os.environ.get("STE_TEMP_DIR"):
        return
    base = os.environ.get("STE_BASE_DIR")
    if not base:
        if sys.platform == "darwin":
            base = os.path.expanduser(
                "~/Library/Application Support/SubTitleExtractor"
            )
        else:
            base = os.path.expanduser("~/.subtitle-extractor")
    os.environ["STE_BASE_DIR"] = base
    os.environ["STE_TEMP_DIR"] = os.path.join(base, "temp")


def main() -> None:
    _ensure_data_dir()

    import uvicorn

    from app.main import app

    host = os.environ.get("STE_HOST", "127.0.0.1")
    port = int(os.environ.get("STE_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
