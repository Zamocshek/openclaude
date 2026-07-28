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
LLM_PROVIDER="${OPENCLAUDE_OPENRAG_LLM_PROVIDER:-${LLM_PROVIDER:-ollama}}"
LLM_MODEL="${OPENCLAUDE_OPENRAG_LLM_MODEL:-${LLM_MODEL:-qwen3:1.7b}}"
EMBEDDING_PROVIDER="${OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER:-${EMBEDDING_PROVIDER:-ollama}}"
EMBEDDING_MODEL="${OPENCLAUDE_OPENRAG_EMBEDDING_MODEL:-${EMBEDDING_MODEL:-nomic-embed-text:latest}}"
OLLAMA_ENDPOINT="${OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT:-${OLLAMA_ENDPOINT:-http://host.docker.internal:11434}}"
OPENRAG_VERSION="${OPENCLAUDE_OPENRAG_VERSION:-${OPENRAG_VERSION:-0.5.1}}"
if [ "${LLM_PROVIDER,,}" = "ollama" ]; then
  OPENAI_API_KEY=""
fi
export OPENSEARCH_PASSWORD LANGFLOW_SUPERUSER LANGFLOW_SUPERUSER_PASSWORD FRONTEND_PORT LANGFLOW_PORT
export LLM_PROVIDER LLM_MODEL EMBEDDING_PROVIDER EMBEDDING_MODEL OLLAMA_ENDPOINT OPENRAG_VERSION
export OPENAI_API_KEY
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export NO_COLOR=1
export RICH_NO_COLOR=1
export FORCE_COLOR=0
export TERM=dumb
if [ ! -d "$REPO_DIR/.git" ]; then
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 --branch "v$OPENRAG_VERSION" https://github.com/langflow-ai/openrag.git "$REPO_DIR"
fi
if ! git -C "$REPO_DIR" diff --quiet || ! git -C "$REPO_DIR" diff --cached --quiet; then
  echo "OpenRAG has tracked local changes. Commit or restore them before production deployment." >&2
  exit 1
fi
if ! git -C "$REPO_DIR" rev-parse --verify --quiet "refs/tags/v$OPENRAG_VERSION" >/dev/null; then
  git -C "$REPO_DIR" fetch --depth 1 origin tag "v$OPENRAG_VERSION"
fi
git -C "$REPO_DIR" checkout --detach "v$OPENRAG_VERSION"

cd "$REPO_DIR"
uv sync --python 3.13
uv run --python 3.13 python "$ROOT_DIR/scripts/release/sync-openrag-config.py" \
  "$REPO_DIR/config/config.yaml"
if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$DOCLING_PORT/docs" >/dev/null 2>&1; then
  echo "docling-serve already listening on port $DOCLING_PORT"
else
  uv run --python 3.13 python scripts/docling_ctl.py start --port "$DOCLING_PORT"
fi
cat > docker-compose.openclaude.override.yml <<'YAML'
services:
  opensearch:
    restart: unless-stopped
    ports: !override
      - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:9200:9200"
      - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:9600:9600"
    environment:
      - OPENSEARCH_PASSWORD=${OPENSEARCH_PASSWORD}
  dashboards:
    restart: unless-stopped
    ports: !override
      - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:5601:5601"
  openrag-backend:
    restart: unless-stopped
    environment:
      DO_NOT_TRACK: "1"
      LLM_PROVIDER: "${LLM_PROVIDER}"
      LLM_MODEL: "${LLM_MODEL}"
      EMBEDDING_PROVIDER: "${EMBEDDING_PROVIDER}"
      EMBEDDING_MODEL: "${EMBEDDING_MODEL}"
      OLLAMA_ENDPOINT: "${OLLAMA_ENDPOINT}"
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
  openrag-frontend:
    restart: unless-stopped
    ports: !override
      - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:${FRONTEND_PORT:-3000}:3000"
  langflow:
    restart: unless-stopped
    environment:
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
      OLLAMA_BASE_URL: "${OLLAMA_ENDPOINT}"
      SELECTED_EMBEDDING_MODEL: "${EMBEDDING_MODEL}"
    ports: !override
      - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:${LANGFLOW_PORT:-7860}:7860"
YAML
if [ "${OPENCLAUDE_OPENRAG_BUILD_LANGFLOW:-0}" = "1" ]; then
  docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml build langflow
fi
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml \
  pull opensearch openrag-backend openrag-frontend langflow
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml restart openrag-backend
