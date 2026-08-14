#!/usr/bin/env bash
# Start the CapCut TTS gen-voice service.
# Env: CTTS_port, CTTS_host, CTTS_device_json, CTTS_temp_dir, CTTS_job_timeout
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if ! "$PYTHON" -c "import fastapi, uvicorn, pydantic_settings" 2>/dev/null; then
  echo "Missing service deps. Installing [service] extra..."
  "$PYTHON" -m pip install -e ".[service]"
fi

exec "$PYTHON" -m service.main