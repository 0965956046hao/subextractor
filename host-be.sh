#!/bin/bash
# host-be.sh — Expose backend (:8000) qua Cloudflare Named Tunnel với URL CỐ ĐỊNH.
#
# Yêu cầu (chỉ lần đầu):
#   1. Một domain đã trỏ nameserver về Cloudflare (free plan đủ).
#   2. `brew install cloudflared`.
#
# Cách chạy:
#   ./host-be.sh be.example.com          # dùng hostname chỉ định
#   ./host-be.sh                          # sẽ hỏi nhập hostname
#
# Kết quả: https://<hostname> luôn cố định qua restart/reboot.

set -euo pipefail

TUNNEL_NAME="subextractor-be"
PORT=8000
CF_DIR="$HOME/.cloudflared"
CONFIG="$CF_DIR/config.yml"
LOG="/tmp/cloudflared-be.log"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/backend/.env"

command -v cloudflared >/dev/null || { echo "❌ Chưa cài cloudflared: brew install cloudflared"; exit 1; }

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -rp " Nhập hostname cho backend (vd: be.example.com): " DOMAIN
fi
[ -z "$DOMAIN" ] && { echo "❌ Cần hostname."; exit 1; }

# ── 1. Login Cloudflare (mở browser lần đầu) ────────────────────────────────
if ! ls "$CF_DIR"/cert.pem >/dev/null 2>&1; then
  echo "→ Chưa login Cloudflare — mở trình duyệt để đăng nhập..."
  cloudflared tunnel login
fi

# ── 2. Tạo named tunnel nếu chưa tồn tại ────────────────────────────────────
if ! cloudflared tunnel list 2>/dev/null | grep -qw "$TUNNEL_NAME"; then
  echo "→ Tạo tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$TUNNEL_NAME'))")
CRED_FILE="$CF_DIR/$TUNNEL_ID.json"
echo "→ Tunnel ID: $TUNNEL_ID"

# ── 3. Ghi config ingress ───────────────────────────────────────────────────
cat > "$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CRED_FILE

ingress:
  - hostname: $DOMAIN
    service: http://localhost:$PORT
  - service: http_status:404
EOF
echo "→ Đã ghi config: $CONFIG"

# ── 4. Trỏ DNS (CNAME) hostname → tunnel (-f: overwrite nếu đã có) ──────────
echo "→ Route DNS $DOMAIN → tunnel..."
cloudflared tunnel route dns -f "$TUNNEL_NAME" "$DOMAIN"

# ── 5. Tắt quick-tunnel cũ đang chạy (tránh rối) ────────────────────────────
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
sleep 1

# ── 6. Chạy tunnel nền + verify ─────────────────────────────────────────────
if pgrep -f "cloudflared tunnel run $TUNNEL_NAME" >/dev/null; then
  pkill -f "cloudflared tunnel run $TUNNEL_NAME"; sleep 1
fi
echo "→ Khởi động tunnel: https://$DOMAIN"
( nohup cloudflared tunnel run "$TUNNEL_NAME" > "$LOG" 2>&1 & )
sleep 8

HTTP=$(curl -s --max-time 12 -o /dev/null -w "%{http_code}" "https://$DOMAIN/api/health" || echo 000)
if [ "$HTTP" = "200" ]; then
  echo "✅ Backend live tại: https://$DOMAIN  (health $HTTP)"
else
  echo "⚠️  Health trả $HTTP — xem log: tail -30 $LOG"
  echo "   (backend local phải đang chạy: uvicorn app.main:app --port $PORT)"
fi

# ── 7. Cập nhật STE_public_url vào backend/.env ─────────────────────────────
if [ -f "$ENV_FILE" ]; then
  if grep -q "^STE_public_url=" "$ENV_FILE"; then
    sed -i '' "s|^STE_public_url=.*|STE_public_url=https://$DOMAIN|" "$ENV_FILE"
  else
    echo "STE_public_url=https://$DOMAIN" >> "$ENV_FILE"
  fi
  echo "→ Đã cập nhật STE_public_url trong backend/.env"
fi
echo "   Lưu ý: restart uvicorn để nhận public_url mới."
