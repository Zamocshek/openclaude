#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Install it from https://nodejs.org/ and retry." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- up
fi

exec node scripts/release/portable-control.mjs "$@"
