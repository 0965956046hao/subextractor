#!/bin/bash
# host-pinggy.sh — Expose backend (:8000) qua Pinggy tunnel.
# Free tier: mỗi phiên 60 phút — chạy lại script này khi hết/hỏng.
set -euo pipefail

LOG="/tmp/pinggy-be.log"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/backend/.env"

# Tắt tunnel cũ
pkill -f "R0:localhost:8000 free.pinggy.io" 2>/dev/null || true
sleep 1

echo "→ Khởi động Pinggy tunnel → localhost:8000 ..."
( nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 \
        -o ExitOnForwardFailure=yes -p 443 \
        -R0:localhost:8000 free.pinggy.io > "$LOG" 2>&1 & )
sleep 10

URL=$(grep -oE "https://[a-zA-Z0-9.-]+\.free\.pinggy\.net" "$LOG" | head -1)
if [ -z "$URL" ]; then
  echo "❌ Không lấy được URL — xem log: tail -20 $LOG"
  exit 1
fi

HTTP=$(curl -s --max-time 12 -o /dev/null -w "%{http_code}" "$URL/api/health" || echo 000)
[ "$HTTP" = "200" ] && echo "✅ Backend live: $URL  (hết hạn sau 60 phút — chạy lại script để gia hạn)" \
                    || echo "⚠️ Health trả $HTTP — kiểm tra uvicorn :8000 và log $LOG"

# Cập nhật .env
if grep -q "^STE_public_url=" "$ENV_FILE"; then
  sed -i '' "s|^STE_public_url=.*|STE_public_url=$URL|" "$ENV_FILE"
else
  echo "STE_public_url=$URL" >> "$ENV_FILE"
fi
echo "→ Đã cập nhật STE_public_url trong backend/.env (nhớ restart uvicorn)"
echo "   ⚠️ Nhớ sửa cả URL hardcode trong frontend/src/stores/pipeline-store.ts nếu cần nút Telegram."
