#!/bin/bash
# start-be.sh — Host Cloudflare tunnel TRƯỚC, sau đó mới start uvicorn.
# Thứ tự này để backend đọc được STE_public_url (URL tunnel) lúc khởi động.
#
# Usage: ./start-be.sh          # tunnel + uvicorn --reload :8000
#        ./start-be.sh --prod   # không dùng --reload

set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
LOG="/tmp/cf-be.log"
RELOAD="--reload"
[ "${1:-}" = "--prod" ] && RELOAD=""

BACKEND_PID=""
CF_MARKER="cloudflared tunnel --url http://localhost:8000"

cleanup() {
  echo ""
  echo "→ Stopping backend (${BACKEND_PID:-?})..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  echo "→ Stopping cloudflare tunnel..."
  pkill -f "$CF_MARKER" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "All stopped."
}
trap cleanup INT TERM EXIT

# ── 1. Tắt tunnel cũ nếu còn ────────────────────────────────────────────────
pkill -f "$CF_MARKER" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
sleep 1

# ── 2. Start Cloudflare tunnel và chờ URL ───────────────────────────────────
echo "==> [1/2] Starting cloudflare tunnel..."
rm -f "$LOG"
( nohup /opt/homebrew/bin/cloudflared tunnel --url http://localhost:8000 > "$LOG" 2>&1 & )

URL=""
for i in $(seq 1 25); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "❌ Không lấy được URL cloudflare — xem log: tail -30 $LOG"
  exit 1
fi

HTTP=$(curl -s --max-time 12 -o /dev/null -w "%{http_code}" "$URL/api/health" || echo 000)
echo "    Tunnel URL : $URL"
echo "    Health     : $HTTP (404/000 ngay lúc đầu có thể tự thông sau — CF đôi khi trễ route)"

# ── 3. Ghi URL vào .env TRƯỚC khi start uvicorn ────────────────────────────
ENV_FILE="$BACKEND/.env"
touch "$ENV_FILE"
if grep -q "^STE_public_url=" "$ENV_FILE"; then
  sed -i '' "s|^STE_public_url=.*|STE_public_url=$URL|" "$ENV_FILE"
else
  echo "STE_public_url=$URL" >> "$ENV_FILE"
fi

FE_ENV="$FRONTEND/.env.local"
touch "$FE_ENV"
if grep -q "^NEXT_PUBLIC_TUNNEL_URL=" "$FE_ENV"; then
  sed -i '' "s|^NEXT_PUBLIC_TUNNEL_URL=.*|NEXT_PUBLIC_TUNNEL_URL=$URL|" "$FE_ENV"
else
  echo "NEXT_PUBLIC_TUNNEL_URL=$URL" >> "$FE_ENV"
fi
if grep -q "^BACKEND_ORIGIN=" "$FE_ENV"; then
  sed -i '' "s|^BACKEND_ORIGIN=.*|BACKEND_ORIGIN=$URL|" "$FE_ENV"
else
  echo "BACKEND_ORIGIN=$URL" >> "$FE_ENV"
fi
echo "    Đã ghi URL vào backend/.env + frontend/.env.local"

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
