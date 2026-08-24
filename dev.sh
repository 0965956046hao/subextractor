#!/bin/bash
# Start capcut-tts-api service + backend (uvicorn) + frontend (Next.js dev) cùng lúc
# Usage:
#   ./dev.sh                 # backend chạy --reload (tiện dev)
#   STE_NO_RELOAD=1 ./dev.sh # backend KHÔNG --reload (job dài 2-4h: tránh reloader
#                            #   tự kill/restart worker giữa chừng & che mất traceback)

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
CAPCUT="$ROOT/capcut-tts-api"
DS2API="$ROOT/ds2api"
DS2API_PORT="${DS2API_PORT:-5001}"

# Kill tất cả process khi Ctrl+C
BACKEND_PID=""
CAPCUT_PID=""
CAFFEINATE_PID=""
DS2API_PID=""
cleanup() {
  echo ""
  echo "Stopping backend (${BACKEND_PID:-?})..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  echo "Stopping capcut service (${CAPCUT_PID:-?})..."
  [ -n "$CAPCUT_PID" ] && kill "$CAPCUT_PID" 2>/dev/null || true
  echo "Stopping ds2api (${DS2API_PID:-?})..."
  [ -n "$DS2API_PID" ] && kill "$DS2API_PID" 2>/dev/null || true
  echo "Stopping caffeinate (${CAFFEINATE_PID:-?})..."
  [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "All stopped."
}
trap cleanup INT TERM EXIT

echo "==> Starting capcut-tts-api service  http://localhost:8100"
(cd "$CAPCUT" && exec "$BACKEND/.venv/bin/python" -m service.main) &
CAPCUT_PID=$!

# Backend: mặc định --reload (tiện dev). Khi chạy job dài (OCR/dub 2-4h) đặt
# STE_NO_RELOAD=1 để reloader không tự kill/restart worker giữa chừng và không
# che mất traceback khi process crash. Đồng thời nâng giới hạn file descriptor
# (macOS mặc định chỉ 256) để pipeline hàng nghìn file TTS không bị lỗi FD.
if [ "${STE_NO_RELOAD:-0}" = "1" ]; then
  RELOAD_FLAG=""
  echo "==> Starting backend  http://localhost:8000  (KHÔNG --reload, chạy job dài)"
else
  RELOAD_FLAG="--reload"
  echo "==> Starting backend  http://localhost:8000"
fi
(
  cd "$BACKEND"
  ulimit -n 4096 2>/dev/null || true
  exec .venv/bin/uvicorn app.main:app $RELOAD_FLAG --port 8000
) &
BACKEND_PID=$!

echo "==> Starting ds2api  http://localhost:${DS2API_PORT}"
(cd "$DS2API" && {
  [ -x ./ds2api ] || go build -o ds2api ./cmd/ds2api
  exec env DS2API_ADMIN_KEY="${DS2API_ADMIN_KEY:-test-admin}" PORT="${DS2API_PORT}" ./ds2api
}) &
DS2API_PID=$!

# Chặn macOS ngủ hệ thống khi màn hình tắt, để job OCR/dub xử lý qua đêm không bị treo.
# -i: chặn idle system sleep (battery + AC), -s: chặn system sleep (AC),
# -w: tự thoát khi backend dừng. Display vẫn được phép tắt để tiết kiệm pin.
caffeinate -i -s -w "$BACKEND_PID" &
CAFFEINATE_PID=$!

echo "==> Starting frontend http://localhost:3000"
(cd "$FRONTEND" && exec npm run dev)
