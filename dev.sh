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

# Giải phóng các port cũ TRƯỚC KHI START.
# Nếu còn instance dev.sh cũ (uvicorn :8000 / next :3000 / capcut :8100 /
# ds2api :5001) chưa tắt hẳn, instance mới sẽ bị "Address already in use" →
# backend crash ngay khi vừa reload, và frontend (next dev) tranh port 3000 /
# dùng chung cache .next hỏng → mất CSS. Việc kill trước giúp re-run sạch.
free_port() {
  local port="$1"
  local pids
  # `|| true` bắt buộc: lsof trả exit 1 khi KHÔNG có listener → với `set -e`
  # của dev.sh sẽ làm script thoát ngay (chính là lỗi "chạy xong Freeing
  # ports rồi dừng, không start service nào"). Luôn trả 0 để tiếp tục.
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "  -> freeing port $port (pid: $pids)"
    kill $pids 2>/dev/null || true
    sleep 1
    # fallback: force kill nếu vẫn còn giữ port
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
}
echo "==> Freeing old dev ports (8000, 3000, 8100, ${DS2API_PORT})"
free_port 8000
free_port 3000
free_port 8100
free_port "${DS2API_PORT}"

# Kill tất cả process khi Ctrl+C
BACKEND_PID=""
CAPCUT_PID=""
CAFFEINATE_PID=""
DS2API_PID=""
FRONTEND_PID=""
STOP_PIDS=()
collect_process_tree() {
  local pid="$1" child
  STOP_PIDS+=("$pid")
  while read -r child; do
    [ -n "$child" ] && collect_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

cleanup() {
  # Cleanup runs once, even when Ctrl+C is followed by the EXIT trap.
  trap - EXIT
  trap '' INT TERM
  local pid attempt running
  STOP_PIDS=()
  # Snapshot descendants before TERM: reloaders/npm can exit before their
  # children, leaving those children reparented and otherwise hard to find.
  for pid in "$BACKEND_PID" "$CAPCUT_PID" "$DS2API_PID" "$CAFFEINATE_PID" "$FRONTEND_PID"; do
    [ -n "$pid" ] && collect_process_tree "$pid"
  done
  echo ""
  echo "Stopping backend (${BACKEND_PID:-?})..."
  echo "Stopping capcut service (${CAPCUT_PID:-?})..."
  echo "Stopping ds2api (${DS2API_PID:-?})..."
  echo "Stopping caffeinate (${CAFFEINATE_PID:-?})..."
  echo "Stopping frontend (${FRONTEND_PID:-?})..."
  for pid in "${STOP_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # Blocking SDK calls/threads may ignore graceful shutdown. Bound the wait.
  for ((attempt=0; attempt<50; attempt++)); do
    running=0
    for pid in "${STOP_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        running=1
        break
      fi
    done
    [ "$running" -eq 0 ] && break
    sleep 0.1
  done
  for pid in "${STOP_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force stopping process $pid (shutdown timed out)."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "All stopped."
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

# Đảm bảo .next của frontend là bản DEV, không phải bản production.
# `npm run build` ghi artifact production (output: standalone) vào frontend/.next
# rồi copy sang .next-prod (dùng bởi `npm run start`). Nếu .next còn standalone,
# `next dev` sẽ chạy trên .next bẩn → HTML reference đường dẫn CSS production
# (/_next/static/css/app/layout.css?v=...) mà dev server không phục vụ → 404,
# giao diện mất CSS. Xoá .next để next dev build lại sạch.
if [ -d "$FRONTEND/.next/standalone" ]; then
  echo "==> Removing polluted production .next (standalone) so next dev serves CSS correctly"
  rm -rf "$FRONTEND/.next"
fi

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
(cd "$FRONTEND" && exec npm run dev) &
FRONTEND_PID=$!
wait "$FRONTEND_PID"
