# Production runbook

This runbook deploys the complete local agent stack: Telegram gateway,
OpenAI-compatible API, OpenWebUI, Tool Router, File Manager, OmniRoute,
SearXNG, Telegram MCP, skills, memory, cron, and model-driven subagents.

## Security model

- HTTP services bind to `127.0.0.1` by default.
- `OPENCLAUDE_AGENT_API_KEY` is the admin key.
- `OPENCLAUDE_AGENT_INFERENCE_API_KEY` is used by OpenWebUI and other
  OpenAI-compatible clients. Inference still starts the full agent runner and
  can use its configured files, tools, skills, and MCP servers. The key cannot
  call gateway administration endpoints directly.
- The production compose profile runs the agent as root inside its container
  so it can manage the mounted workspace, but disables Docker `privileged`
  mode. Enable wider host or Docker access only as an explicit operator choice.
- The admin key is never embedded in Router or File Manager HTML. Loopback
  pages receive a signed HttpOnly browser session; remote hosts ask for the key
  once and exchange it for the same short-lived session.
- Public access must go through an authenticated TLS reverse proxy. Do not set
  bind addresses to `0.0.0.0` unless `OPENCLAUDE_ALLOW_PUBLIC_BIND=1` is an
  intentional and reviewed change.

## First production deployment

From the repository root:

```powershell
bun run production:init-secrets
bun run production:preflight
bun run production:deploy
```

`production:deploy` performs preflight validation, creates a backup, builds an
image tagged with the Git revision, waits for health checks, and runs live
verification. The release identity is written to
`reports/production-release.json`.

## Verification

```powershell
bun run production:verify
docker compose -f docker-compose.agent-gateway.yml -f docker-compose.production.yml ps
```

Verification checks gateway readiness, the inference-only OpenAI API,
the protected File Manager API, OmniRoute, OpenWebUI, Telegram MCP, SearXNG, Ollama, Hindsight, OpenRAG,
Langflow, Docling, service state, and loopback-only published ports.

OpenRAG launchers pin the complete official `0.5.1` image family by default,
check out the matching upstream tag, route LLM and embedding traffic through
the configured local Ollama endpoint, and set `DO_NOT_TRACK=1`. Tracked local
changes in the OpenRAG checkout stop deployment instead of being overwritten.
The launcher atomically synchronizes the selected OpenRAG providers and models
into its persisted `config.yaml`, disables unused cloud providers in OpenRAG,
and restarts only the backend. This configuration is isolated from the
gateway's own provider credentials. Override the pin only through
`OPENCLAUDE_OPENRAG_VERSION` after testing all four OpenRAG images together.

The primary endpoints are:

- Gateway readiness: `http://127.0.0.1:8642/ready`
- OpenWebUI: `http://127.0.0.1:8080`
- Tool Router: `http://127.0.0.1:8642/router`
- File Manager: `http://127.0.0.1:8642/files`
- OmniRoute: `http://127.0.0.1:20128`
- Telegram MCP: `http://127.0.0.1:19765`
- Hindsight UI: `http://127.0.0.1:9999`
- OpenRAG: `http://127.0.0.1:3000`

## Backup

```powershell
bun run production:backup
```

Backups are stored under `backups/<timestamp>/`. The backup includes the
gateway configuration, MCP configuration, dotenv configuration, and every
named volume mounted by active compose containers. `manifest.json` records a
SHA-256 checksum for every archive.

Backups contain secrets. Keep the directory local and access-controlled.

## Rollback

1. Stop the stack without deleting volumes:

   ```powershell
   docker compose -f docker-compose.agent-gateway.yml -f docker-compose.production.yml down
   ```

2. Set `OPENCLAUDE_RELEASE_TAG` to the previously deployed image tag recorded
   in its release manifest.
3. Restore only the required volume archive from the matching backup.
4. Start and verify:

   ```powershell
   docker compose -f docker-compose.agent-gateway.yml -f docker-compose.production.yml up -d --wait
   bun run production:verify
   ```

Never use `down -v` during a normal rollback.

## Operating modes

The production profile is the default for unattended startup. The base compose
file retains the explicit unrestricted operator mode for maintenance tasks
that genuinely require Docker `privileged` access. Do not run both modes
against the same Telegram token at the same time.

Long-running requests have bounded process and network timeouts, while durable
memory storage remains unlimited when its `*_MAX_CHARS` variables are `0`.
Active prompt context is still constrained by the selected model's physical
context window.
