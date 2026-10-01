#!/bin/bash
# Start Text2Speech web riêng: http://localhost:8200
# Phụ thuộc duy nhất: capcut-tts-api đang chạy ở :8100 + ffmpeg trong PATH.
# Usage:
#   ./start.sh                 # port 8200
#   TTS_PORT=8201 ./start.sh   # port khác
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${TTS_PORT:-8200}"
CAPCUT_URL="${CAPCUT_URL:-http://localhost:8100}"

echo "==> Text2Speech"
echo "    Web    : http://localhost:${PORT}"
echo "    CapCut : ${CAPCUT_URL}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "!! Không tìm thấy ffmpeg — bước gộp MP3 sẽ lỗi. Hãy: brew install ffmpeg"
fi

if ! curl -sf --max-time 3 "${CAPCUT_URL}/api/health" >/dev/null 2>&1; then
  echo "!! CapCut TTS chưa chạy ở ${CAPCUT_URL}."
  echo "   Hãy chạy trước:  cd capcut-tts-api && ../backend/.venv/bin/python -m service.main"
  echo "   (web vẫn mở được để nhập văn bản + tách câu, nhưng gen voice sẽ lỗi)"
else
  echo "    CapCut : OK"
fi

# Giải phóng port cũ nếu còn instance trước đó.
pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$pids" ]; then
  echo "  -> freeing port $PORT (pid: $pids)"
  kill $pids 2>/dev/null || true
  sleep 1
fi

VENV_PY="$ROOT/../backend/.venv/bin/python"
if [ -x "$VENV_PY" ]; then
  PY="$VENV_PY"
else
  PY="python3"
fi

cd "$ROOT"
exec env TTS_PORT="$PORT" CAPCUT_URL="$CAPCUT_URL" "$PY" server.py
