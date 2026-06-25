#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

REPO_DIR="${OPENCLAUDE_OPENRAG_REPO_DIR:-$HOME/.openclaude/openrag}"
DOCLING_PORT="${OPENCLAUDE_OPENRAG_DOCLING_PORT:-5001}"
: "${OPENSEARCH_PASSWORD:=${OPENCLAUDE_OPENRAG_OPENSEARCH_PASSWORD:-}}"
: "${LANGFLOW_SUPERUSER:=${OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER:-}}"
: "${LANGFLOW_SUPERUSER_PASSWORD:=${OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER_PASSWORD:-}}"
: "${FRONTEND_PORT:=${OPENCLAUDE_OPENRAG_FRONTEND_PORT:-}}"
: "${LANGFLOW_PORT:=${OPENCLAUDE_OPENRAG_LANGFLOW_PORT:-}}"
: "${LLM_PROVIDER:=${OPENCLAUDE_OPENRAG_LLM_PROVIDER:-}}"
: "${LLM_MODEL:=${OPENCLAUDE_OPENRAG_LLM_MODEL:-}}"
: "${EMBEDDING_PROVIDER:=${OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER:-}}"
: "${EMBEDDING_MODEL:=${OPENCLAUDE_OPENRAG_EMBEDDING_MODEL:-}}"
: "${OLLAMA_ENDPOINT:=${OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT:-}}"
export OPENSEARCH_PASSWORD LANGFLOW_SUPERUSER LANGFLOW_SUPERUSER_PASSWORD FRONTEND_PORT LANGFLOW_PORT
export LLM_PROVIDER LLM_MODEL EMBEDDING_PROVIDER EMBEDDING_MODEL OLLAMA_ENDPOINT
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export NO_COLOR=1
export RICH_NO_COLOR=1
export FORCE_COLOR=0
export TERM=dumb
if [ ! -d "$REPO_DIR/.git" ]; then
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 https://github.com/langflow-ai/openrag.git "$REPO_DIR"
fi

cd "$REPO_DIR"
uv sync --python 3.13
if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$DOCLING_PORT/docs" >/dev/null 2>&1; then
  echo "docling-serve already listening on port $DOCLING_PORT"
else
  uv run --python 3.13 python scripts/docling_ctl.py start --port "$DOCLING_PORT"
fi
cat > docker-compose.openclaude.override.yml <<'YAML'
services:
  opensearch:
    restart: unless-stopped
    environment:
      - OPENSEARCH_PASSWORD=${OPENSEARCH_PASSWORD}
  dashboards:
    restart: unless-stopped
  openrag-backend:
    restart: unless-stopped
  openrag-frontend:
    restart: unless-stopped
  langflow:
    restart: unless-stopped
YAML
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml up -d
