import os
import sys


def _ensure_data_dir() -> None:
    if os.environ.get("CTTS_TEMP_DIR"):
        return
    base = os.environ.get("CTTS_BASE_DIR")
    if not base:
        if sys.platform == "darwin":
            base = os.path.expanduser(
                "~/Library/Application Support/SubTitleExtractor"
            )
        else:
            base = os.path.expanduser("~/.subtitle-extractor")
    os.environ["CTTS_BASE_DIR"] = base
    os.environ["CTTS_TEMP_DIR"] = os.path.join(base, "capcut-temp")


def main() -> None:
    _ensure_data_dir()

    import uvicorn

    from service.main import app

    host = os.environ.get("CTTS_HOST", "127.0.0.1")
    port = int(os.environ.get("CTTS_PORT", "8100"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
