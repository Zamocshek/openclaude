#!/bin/bash
# Run script for Internal 3DS Sandbox / Security Demo
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Optional safe Telegram notifications use masked sandbox fields only.
export BOT_TOKEN="${BOT_TOKEN:-}"
export ADMIN_IDS="${ADMIN_IDS:-}"
export PORT="${PORT:-5000}"

echo "Starting Internal 3DS Sandbox / Security Demo..."
echo "Port: $PORT"
echo "Telegram notifications: $([ -n "$BOT_TOKEN" ] && [ -n "$ADMIN_IDS" ] && echo enabled || echo disabled)"
echo ""

python3 app.py
