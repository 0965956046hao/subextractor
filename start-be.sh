#!/bin/bash
# start-be.sh — Host Pinggy tunnel TRƯỚC, sau đó mới start uvicorn.
# Thứ tự này để backend đọc được STE_public_url (URL tunnel) lúc khởi động.
#
# Usage: ./start-be.sh          # tunnel + uvicorn --reload :8000
#        ./start-be.sh --prod   # không dùng --reload

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
LOG="/tmp/pinggy-be.log"
RELOAD="--reload"
[ "${1:-}" = "--prod" ] && RELOAD=""

BACKEND_PID=""
TUNNEL_MARKER="R0:localhost:8000 free.pinggy.io"

cleanup() {
  echo ""
  echo "→ Stopping backend (${BACKEND_PID:-?})..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  echo "→ Stopping pinggy tunnel..."
  pkill -f "$TUNNEL_MARKER" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "All stopped."
}
trap cleanup INT TERM EXIT

# ── 1. Tắt tunnel cũ nếu còn ────────────────────────────────────────────────
pkill -f "$TUNNEL_MARKER" 2>/dev/null || true
sleep 1

# ── 2. Start Pinggy tunnel và chờ URL ───────────────────────────────────────
echo "==> [1/2] Starting pinggy tunnel..."
rm -f "$LOG"
( nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 \
        -o ExitOnForwardFailure=yes -p 443 \
        -R0:localhost:8000 free.pinggy.io > "$LOG" 2>&1 & )

URL=""
for i in $(seq 1 15); do
  URL=$(grep -oE "https://[a-zA-Z0-9.-]+\.free\.pinggy\.net" "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "❌ Không lấy được URL pinggy — xem log: tail -20 $LOG"
  exit 1
fi

HTTP=$(curl -s --max-time 12 -o /dev/null -w "%{http_code}" "$URL/api/health" || echo 000)
echo "    Tunnel URL : $URL"
echo "    Health     : $HTTP (uvicorn cũ đang chạy thì 200, chưa thì 000)"

# ── 3. Ghi URL vào .env TRƯỚC khi start uvicorn ────────────────────────────
ENV_FILE="$BACKEND/.env"
touch "$ENV_FILE"
if grep -q "^STE_public_url=" "$ENV_FILE"; then
  sed -i '' "s|^STE_public_url=.*|STE_public_url=$URL|" "$ENV_FILE"
else
  echo "STE_public_url=$URL" >> "$ENV_FILE"
fi
echo "    Đã ghi STE_public_url vào .env"

# ── 4. Restart uvicorn sạch để nhận public_url mới ─────────────────────────
pkill -f "uvicorn app.main:app" 2>/dev/null || true
sleep 1

echo "==> [2/2] Starting backend  http://localhost:8000"
cd "$BACKEND"
.venv/bin/uvicorn app.main:app $RELOAD --port 8000 &
BACKEND_PID=$!

# Giữ caffeinate chống sleep như dev.sh
caffeinate -i -s -w "$BACKEND_PID" & CAFFEINATE_PID=$!

wait "$BACKEND_PID"
