#!/bin/bash
# cf-watch.sh — Thu tu dong Cloudflare quick tunnel den khi song lai.
# Khi health = 200: cap nhat backend/.env + frontend/.env.local roi thoat.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/cf-watch.log"
BACKEND_ENV="$ROOT/backend/.env"
FRONTEND_ENV="$ROOT/frontend/.env.local"

echo "[$(date '+%H:%M:%S')] Bat dau giam sat Cloudflare..." >> "$LOG"

while true; do
  pkill -f "cloudflared tunnel --url" 2>/dev/null
  sleep 1
  rm -f /tmp/cf-try.log
  screen -dmS cf bash -c '/opt/homebrew/bin/cloudflared tunnel --url http://localhost:8000 > /tmp/cf-try.log 2>&1'
  sleep 20

  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cf-try.log | head -1)
  if [ -n "$URL" ]; then
    CODE=$(curl -s --max-time 12 -o /dev/null -w "%{http_code}" "$URL/api/health" || echo 000)
    echo "[$(date '+%H:%M:%S')] $URL -> $CODE" >> "$LOG"
    if [ "$CODE" = "200" ]; then
      # Cap nhat .env BE
      if grep -q "^STE_public_url=" "$BACKEND_ENV"; then
        sed -i '' "s|^STE_public_url=.*|STE_public_url=$URL|" "$BACKEND_ENV"
      else
        echo "STE_public_url=$URL" >> "$BACKEND_ENV"
      fi
      # Cap nhat .env FE
      if grep -q "^BACKEND_ORIGIN=" "$FRONTEND_ENV"; then
        sed -i '' "s|^BACKEND_ORIGIN=.*|BACKEND_ORIGIN=$URL|" "$FRONTEND_ENV"
      else
        echo "BACKEND_ORIGIN=$URL" >> "$FRONTEND_ENV"
      fi
      echo "[$(date '+%H:%M:%S')] ✅ CF SONG: $URL — da update .env ca 2 phia. Restart uvicorn + redeploy Vercel de ap dung." >> "$LOG"
      exit 0
    fi
  else
    echo "[$(date '+%H:%M:%S')] khong lay duoc URL, thu lai..." >> "$LOG"
  fi

  sleep 60 # nghi 1 phut giua cac lan thu
done
