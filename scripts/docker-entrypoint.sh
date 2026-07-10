#!/bin/sh
set -e

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/home/node/.openclaude}"
CONFIG_FILE="$CONFIG_DIR/.claude.json"
LEGACY_CONFIG_FILE="${CLAUDE_LEGACY_CONFIG_FILE:-/home/node/.claude.json}"
mkdir -p "$CONFIG_DIR"
export CLAUDE_CONFIG_DIR="$CONFIG_DIR"

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

RUN_AS_ROOT="${OPENCLAUDE_DOCKER_RUN_AS_ROOT:-0}"
if ! is_truthy "$RUN_AS_ROOT"; then
  chown node:node "$CONFIG_DIR" 2>/dev/null || true
fi

unset_empty_env() {
  name="$1"
  eval "value=\${$name-}"
  if [ -z "$value" ]; then
    unset "$name"
  fi
}

export_if_missing() {
  name="$1"
  value="$2"
  eval "current=\${$name-}"
  if [ -n "$value" ] && [ -z "$current" ]; then
    export "$name=$value"
  fi
}

for env_name in \
  WEB_PROVIDER WEB_KEY WEB_SEARCH_API WEB_QUERY_PARAM WEB_METHOD WEB_PARAMS \
  WEB_URL_TEMPLATE WEB_BODY_TEMPLATE WEB_AUTH_HEADER WEB_AUTH_SCHEME WEB_HEADERS \
  WEB_JSON_PATH WEB_CUSTOM_TIMEOUT_SEC WEB_CUSTOM_MAX_BODY_KB \
  OPENAI_BASE_URL OPENAI_MODEL OPENAI_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
  ANTHROPIC_API_KEY GEMINI_BASE_URL GEMINI_MODEL GEMINI_API_KEY GOOGLE_API_KEY \
  MISTRAL_BASE_URL MISTRAL_MODEL MISTRAL_API_KEY CODEX_API_KEY CHATGPT_ACCOUNT_ID \
  CODEX_ACCOUNT_ID; do
  unset_empty_env "$env_name"
done

normalize_provider_env() {
  provider="$(printf '%s' "${OPENCLAUDE_PROVIDER:-}" | tr '[:upper:]' '[:lower:]')"

  case "$provider" in
    openai|openai-compatible|codex|onlysq|ollama|lmstudio|lm-studio|lmstudio-lan|openrouter|deepseek|groq|together|fireworks|nvidia-nim|minimax|atomic-chat)
      export CLAUDE_CODE_USE_OPENAI="${CLAUDE_CODE_USE_OPENAI:-1}"
      export_if_missing OPENAI_BASE_URL "${OPENCLAUDE_BASE_URL:-}"
      export_if_missing OPENAI_MODEL "${OPENCLAUDE_MODEL:-}"
      export_if_missing OPENAI_API_KEY "${OPENCLAUDE_API_KEY:-}"
      ;;
    gemini|google-gemini)
      export CLAUDE_CODE_USE_GEMINI="${CLAUDE_CODE_USE_GEMINI:-1}"
      export_if_missing GEMINI_BASE_URL "${OPENCLAUDE_BASE_URL:-}"
      export_if_missing GEMINI_MODEL "${OPENCLAUDE_MODEL:-}"
      export_if_missing GEMINI_API_KEY "${OPENCLAUDE_API_KEY:-}"
      ;;
    mistral)
      export CLAUDE_CODE_USE_MISTRAL="${CLAUDE_CODE_USE_MISTRAL:-1}"
      export_if_missing MISTRAL_BASE_URL "${OPENCLAUDE_BASE_URL:-}"
      export_if_missing MISTRAL_MODEL "${OPENCLAUDE_MODEL:-}"
      export_if_missing MISTRAL_API_KEY "${OPENCLAUDE_API_KEY:-}"
      ;;
    anthropic|claude|firstparty|first-party)
      export_if_missing ANTHROPIC_BASE_URL "${OPENCLAUDE_BASE_URL:-}"
      export_if_missing ANTHROPIC_MODEL "${OPENCLAUDE_MODEL:-}"
      export_if_missing ANTHROPIC_API_KEY "${OPENCLAUDE_API_KEY:-}"
      ;;
    github|copilot|github-copilot)
      export CLAUDE_CODE_USE_GITHUB="${CLAUDE_CODE_USE_GITHUB:-1}"
      export_if_missing OPENAI_MODEL "${OPENCLAUDE_MODEL:-}"
      ;;
  esac
}

normalize_provider_env

export OPENCLAUDE_AGENT_GATEWAY_COMMAND="${OPENCLAUDE_AGENT_GATEWAY_COMMAND:-node /app/dist/cli.mjs}"

bootstrap_codegraph() {
  if ! is_truthy "${OPENCLAUDE_CODEGRAPH_AUTO_INIT:-1}"; then
    return
  fi

  codegraph_shim="${OPENCLAUDE_CODEGRAPH_SHIM:-/app/node_modules/@colbymchenry/codegraph/npm-shim.js}"
  codegraph_project="${OPENCLAUDE_CODEGRAPH_PROJECT_PATH:-${OPENCLAUDE_AGENT_RUNNER_CWD:-/workspace}}"
  codegraph_db="$codegraph_project/.codegraph/codegraph.db"
  if [ ! -f "$codegraph_shim" ] || [ ! -d "$codegraph_project" ] || [ -f "$codegraph_db" ]; then
    return
  fi

  export CODEGRAPH_TELEMETRY="${CODEGRAPH_TELEMETRY:-0}"
  printf '[codegraph] initializing index for %s\n' "$codegraph_project" >&2
  if [ "$(id -u)" = "0" ] && ! is_truthy "$RUN_AS_ROOT"; then
    if ! HOME=/home/node gosu node node "$codegraph_shim" init "$codegraph_project" >&2; then
      printf '[codegraph] initial index failed; gateway will continue without it\n' >&2
    fi
  elif ! node "$codegraph_shim" init "$codegraph_project" >&2; then
    printf '[codegraph] initial index failed; gateway will continue without it\n' >&2
  fi
}

bootstrap_codegraph

latest_backup="$(ls -1t "$CONFIG_DIR"/backups/.claude.json.backup.* 2>/dev/null | head -n 1 || true)"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$latest_backup" ] && [ -f "$latest_backup" ]; then
    cp "$latest_backup" "$CONFIG_FILE"
  else
    printf '{}\n' > "$CONFIG_FILE"
  fi
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  if ! is_truthy "$RUN_AS_ROOT"; then
    chown node:node "$CONFIG_FILE" 2>/dev/null || true
  fi
fi

if [ ! -f "$LEGACY_CONFIG_FILE" ]; then
  if [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "$LEGACY_CONFIG_FILE"
  elif [ -n "$latest_backup" ] && [ -f "$latest_backup" ]; then
    cp "$latest_backup" "$LEGACY_CONFIG_FILE"
  else
    printf '{}\n' > "$LEGACY_CONFIG_FILE"
  fi
  chmod 600 "$LEGACY_CONFIG_FILE" 2>/dev/null || true
  if ! is_truthy "$RUN_AS_ROOT"; then
    chown node:node "$LEGACY_CONFIG_FILE" 2>/dev/null || true
  fi
fi

if [ "$(id -u)" = "0" ]; then
  if is_truthy "$RUN_AS_ROOT"; then
    export HOME="${HOME:-/root}"
    exec node /app/dist/cli.mjs "$@"
  fi
  exec gosu node node /app/dist/cli.mjs "$@"
fi

exec node /app/dist/cli.mjs "$@"
