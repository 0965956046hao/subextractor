#!/bin/bash
# Start backend (uvicorn) + frontend (Next.js dev) cùng lúc
# Usage: ./dev.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

# Kill cả 2 process khi Ctrl+C
BACKEND_PID=""
cleanup() {
  echo ""
  echo "Stopping backend (${BACKEND_PID:-?})..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "All stopped."
}
trap cleanup INT TERM EXIT

echo "==> Starting backend  http://localhost:8000"
(cd "$BACKEND" && exec .venv/bin/uvicorn app.main:app --reload --port 8000) &
BACKEND_PID=$!

echo "==> Starting frontend http://localhost:3000"
(cd "$FRONTEND" && exec npm run dev)
