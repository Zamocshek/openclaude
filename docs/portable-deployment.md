# Portable deployment

This guide turns a clean clone into the same production-oriented agent stack on
Windows, Linux, macOS, or a Docker-capable server.

## Included in the repository

The portable stack ships with:

- Agent Gateway, Telegram bridge, cron, queues, memory, background
  consciousness, evolution, OpenAI-compatible API, and model-driven subagents
- Tool Router, File Manager, Skill Store, and the bundled coding skills
- bundled Telegram MCP, Telegram operations, Maton, and VPromotions skills
- CodeGraph, SearXNG, Context7, authorized Pentest mode, OpenRAG, Hindsight,
  and custom MCP JSON import
- OpenWebUI, OmniRoute, two agent workers, and local Ollama

Provider credentials, Telegram sessions, Codex OAuth tokens, and personal
memory are runtime data. They are intentionally not committed.

## Requirements

- Git
- Docker Engine or Docker Desktop with Compose v2
- Node.js 22 or newer
- `uv` is installed automatically when the full OpenRAG profile is requested

All host ports bind to `127.0.0.1` by default. Hindsight, OpenRAG, Ollama,
workers, and the main agent communicate over the private
`openclaude_default` Docker network, including on native Linux servers.

## Windows

```powershell
git clone https://github.com/Zamocshek/openclaude.git
cd openclaude
.\openclaude.ps1 init
.\openclaude.ps1 doctor
.\openclaude.ps1 up
```

For the complete RAG and durable-memory stack:

```powershell
.\openclaude.ps1 up -Full
```

## Linux, macOS, and servers

```bash
git clone https://github.com/Zamocshek/openclaude.git
cd openclaude
./openclaude.sh init
./openclaude.sh doctor
./openclaude.sh up
```

For the complete stack:

```bash
./openclaude.sh up --full
```

The first start downloads the pinned images and the local chat and embedding
models. It can take several minutes.

## Persistent state

New portable deployments keep all mutable data under the ignored
`.openclaude-data/` directory:

| Directory | Contents |
| --- | --- |
| `config/` | gateway settings, memory, cron, custom MCP registry, custom skills |
| `codex/` | optional Codex OAuth and model cache |
| `telegram-mcp/` | Telegram sessions, SQLite memory, Maton settings |
| `hindsight/` | Hindsight durable-memory database |
| `openrag/` | pinned OpenRAG checkout and data |
| `pentest/` | authorized engagement scope, evidence state, and reports |

The generated `.env` is also ignored. Existing deployments with explicit
`OPENCLAUDE_HOST_*` paths keep using those paths.

## Provider and Telegram setup

The clean-clone default is local Ollama, so the agent works without a paid API.
To use another provider, edit `.env` or use the Telegram/Router provider UI.

To enable the Telegram bot, set:

```dotenv
OPENCLAUDE_DOCKER_TELEGRAM_ENABLED=1
OPENCLAUDE_DOCKER_TELEGRAM_BOT_TOKEN=replace-me
OPENCLAUDE_DOCKER_TELEGRAM_HOME_CHAT_ID=replace-me
OPENCLAUDE_DOCKER_TELEGRAM_ALLOWED_USER_IDS=replace-me
```

For personal Telegram MCP accounts, create
`.openclaude-data/telegram-mcp/.env` from
`integrations/telegram-mcp/.env.example` and authenticate that session.

## Codex subscription OAuth

Authenticate with Codex on the host, then import only its refreshable
credentials into portable state:

```powershell
.\openclaude.ps1 import-codex
```

```bash
./openclaude.sh import-codex
```

An alternative source directory can be passed to the Node command:

```bash
node scripts/release/portable-control.mjs import-codex /path/to/.codex
```

OAuth files remain ignored and are never built into an image.

## Operations

```bash
./openclaude.sh status
./openclaude.sh verify
./openclaude.sh down
./openclaude.sh down --full
```

Windows uses the same command names through `openclaude.ps1`.

Primary interfaces:

- OpenWebUI: `http://127.0.0.1:8080`
- Tool Router: `http://127.0.0.1:8642/router`
- File Manager: `http://127.0.0.1:8642/files`
- OmniRoute: `http://127.0.0.1:20128`
- Telegram MCP: `http://127.0.0.1:18765`
- Hindsight: `http://127.0.0.1:9999`
- OpenRAG: `http://127.0.0.1:3000`

## Public server deployment

Do not publish the root-capable gateway ports directly. Keep the default
loopback binds and expose selected interfaces through an authenticated HTTPS
reverse proxy. Set `OPENCLAUDE_ALLOW_PUBLIC_BIND=1` only after adding TLS,
authentication, firewall rules, and rotating every generated secret.
