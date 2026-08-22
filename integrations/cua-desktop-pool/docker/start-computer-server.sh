#!/bin/bash
set -e

# Based on vendor/cua/libs/xfce/src/scripts/start-computer-server.sh at
# Cua commit a74430843663d3840dffbee04c2e112783ad238e (MIT).
echo "Waiting for X server to start..."
while ! xdpyinfo -display :1 >/dev/null 2>&1; do
    sleep 1
done
echo "X server is ready"

export DISPLAY=:1
exec python3 -m computer_server --host 0.0.0.0 --port "${API_PORT:-8000}"
