# Agent Gateway Control Center

Use the browser-based Control Center when you want a normal cross-platform
form app for setup:

```powershell
scripts\release\control-center.bat
```

On macOS/Linux:

```bash
./scripts/release/control-center.sh
```

Or through the package script:

```bash
bun run control-center
```

It opens `http://127.0.0.1:8799`, saves values into `.env` and
`~/.openclaude/agent-gateway.json`, and can start/test the local Agent API,
Open WebUI, and Docker compose stack. It starts Open WebUI with auth disabled
(`WEBUI_AUTH=False`, isolated data dir) so stale local login state does not
block first-run usage.

Run `/agent-gateway` inside OpenClaude when you prefer the terminal UI. The
terminal UI works on Windows, macOS, Linux, WSL, and Docker because it uses the
same Ink console surface as the main CLI.

For headless setup and automation, use the non-interactive CLI:

```bash
openclaude gateway auth login --generate
openclaude gateway codex login
openclaude gateway model
openclaude gateway setup new provider api --codex
openclaude gateway memory add --kind user "User prefers concise Russian engineering updates."
openclaude gateway status
openclaude gateway serve
openclaude gateway run "Inspect the current workspace and summarize it."
```

Useful CLI commands:

- `openclaude gateway auth login --generate` enables the Agent API and stores a
  generated Bearer key in `agent-gateway.json`.
- `openclaude gateway auth login --api-key -` reads the key from stdin.
- `openclaude gateway configure --enable-telegram --telegram-bot-token ...`
  updates Telegram settings without opening the UI.
- `openclaude gateway health` checks a running gateway server.
- `openclaude gateway run ...` sends a prompt to the running gateway through the
  Responses API and uses the stored Bearer key automatically.
- `openclaude gateway model` shows the active gateway model plus Codex provider
  credential/profile status.
- `openclaude gateway setup new provider api --codex` runs the Hermes-style
  setup path for Codex subscription auth. Pass `--api-key ...` for manual Agent
  API auth instead.
- `openclaude gateway auth logout --disable-api` removes the stored Agent API
  key and disables the local API.

Codex subscription auth is separate from the Agent API Bearer key:

- `openclaude gateway codex login` starts the Codex OAuth flow, opens ChatGPT
  sign-in, stores Codex credentials in secure storage, and saves a Codex startup
  provider profile for gateway child runs.
- `openclaude gateway codex login --no-browser` prints the OAuth URL for
  headless or remote shells.
- `openclaude gateway codex status` shows whether Codex credentials resolve
  from secure storage, `CODEX_API_KEY`, or `~/.codex/auth.json`.
- `openclaude gateway codex logout` clears stored Codex OAuth credentials and
  removes the Codex startup profile unless `--keep-profile` is passed.

Hermes-style bounded memory is available through CLI and the protected API. It
keeps two curated files under the gateway state directory:

- `MEMORY.md`: project decisions, durable operating procedures, recurring
  fixes, and long-term lessons. Limit: 2200 characters.
- `USER.md`: user profile, preferences, communication style, and collaboration
  habits. Limit: 1375 characters.

Memory commands:

```bash
openclaude gateway memory status
openclaude gateway memory add --kind memory --tags api "Gateway responses must stay OpenAI-compatible."
openclaude gateway memory add --kind user "User wants short Russian status updates."
openclaude gateway memory search gateway
openclaude gateway memory search --sessions "previous task"
openclaude gateway memory replace <memory-id> "Updated memory text"
openclaude gateway memory remove <memory-id>
openclaude gateway memory replace-text "exact old substring" "replacement text"
openclaude gateway memory remove-text "exact old substring"
openclaude gateway memory approval on
openclaude gateway memory pending
openclaude gateway memory approve <pending-id>
openclaude gateway memory tool --action add --kind memory --content "Durable fact"
```

The gateway injects curated memory into `/v1/chat/completions`,
`/v1/responses`, `/v1/runs`, and Telegram prompts. API chat sessions using
`X-Hermes-Session-Id` and Responses API named/continued conversations keep a
frozen memory snapshot for the conversation, matching Hermes' "memory snapshot
at session start" behavior. API conversations are also appended to the gateway
JSONL log so `memory search --sessions` can recover prior work.

The child agent can request memory changes by emitting standalone hidden control
lines. The gateway strips them from visible API/Telegram responses:

```text
[MEMORY action="add" target="memory" content="short durable fact" tags="api"]
[MEMORY action="replace" target="user" old_text="exact old substring" content="replacement"]
[MEMORY action="remove" target="memory" old_text="exact old substring"]
```

When memory approval is enabled, agent-requested writes are staged until
`gateway memory approve`; otherwise valid writes are applied immediately. Memory
content is bounded, duplicate-checked, and rejected when it looks like a secret,
prompt injection, or exfiltration instruction.

Memory write routes are protected by the same Agent API Bearer key:
`GET/POST /api/memory`, `PATCH/DELETE /api/memory/:id`,
`POST /api/memory/tool`, `GET /api/memory/pending`,
`POST /api/memory/approve`, `POST /api/memory/reject`,
`GET /api/memory/search?q=...`, and
`GET /api/memory/sessions/search?q=...`.

## What It Configures

- Model provider profile: provider, base URL, model, and API key.
- Agent API: host, port, CORS, and generated Bearer API key.
- Telegram bridge: bot token, home chat, allowed chat IDs, allowed user IDs,
  file downloads, audio transcription, and API response mirroring.
- Cron scheduler. Release launchers default it on because scheduler jobs are
  part of the agent runtime.
- Ouroboros: consciousness loop, infinite task command, wakeup interval, and
  full-tool-access mode for gateway runs.
- Open WebUI: Python command, data directory, port, install, and serve.
- Runner: working directory, max turns, timeout, and permission mode for API,
  Telegram, cron, and Ouroboros tasks.

Values are saved in `~/.openclaude/agent-gateway.json`. Provider profiles are
saved in OpenClaude global settings and applied to the process environment when
selected. Environment variables can override gateway settings at startup; see
`.env.example`.

## OnlySQ Provider

OnlySQ works as an OpenAI-compatible provider with this base URL:

```bash
CLAUDE_CODE_USE_OPENAI=1
OPENAI_BASE_URL=https://api.onlysq.ru/ai/openai
OPENAI_MODEL=gemini-3-flash
OPENAI_API_KEY=sq-your-key
```

Do not append `/v1` to the OnlySQ base URL. The `/agent-gateway` provider picker
includes an OnlySQ preset with this URL.

## Telegram Access

If `allowedChatIds`, `allowedUserIds`, and `homeChatId` are all empty, the bot
accepts messages from any Telegram chat/user. This matches the full-access agent
default.

Once any chat or user allowlist is configured, messages are accepted only when:

- the chat ID is in `allowedChatIds`;
- the chat ID is `homeChatId`; or
- the sender account ID is in `allowedUserIds`.

Use `/chatid` in Telegram to see the current chat ID. Telegram user IDs can be
added through `/agent-gateway`.

## Telegram Inference Commands

The Telegram bridge treats normal messages as prompts for the agent and exposes
owner-control commands directly in the chat. `/help` returns the authoritative
runtime help text, and the bridge also registers base commands with Telegram's
command menu through `setMyCommands` on startup.

Basics:

- `/help` - show Telegram help and refresh the command menu.
- `/commands` - show the same Telegram command reference.
- `/chatid` - show the current chat ID.
- `/status` - show gateway, workers, cron, budget, and Ouroboros status.
- `/transcribe` - check voice/audio transcription availability.

Inference and providers:

- `/provider` - show active provider, model, and API endpoint.
- `/provider models` - load models from the active OpenAI-compatible endpoint.
- `/provider set <provider> <model> [base_url] [api_key]` - switch
  provider/model for next agent runs.
- `/gpt55`, `/codex`, `/dsflash`, `/dspro`, `/gemma`, `/gemmacoder` - quick
  switches for Codex GPT-5.5, DeepSeek V4 Flash/Pro, and the LM Studio Gemma
  profiles.
- `/provider set lmstudio-lan gemma-4-12b-obliterated` - switch to the LAN
  LM Studio preset at `http://192.168.187.1:1234/v1` and enable no-tools
  runner mode for models whose LM Studio template rejects OpenAI tool schemas.
- `/model <model>` - switch model for next agent runs.
- `/baseurl <url>` - switch OpenAI-compatible base URL.
- `/apikey <key>` - store provider API key for next runs.
- `/context` - show effective context window for the active model.
- `/context auto|1m|<tokens>` - set a manual context window or return to
  model/provider auto mode; `unlimited` maps to the 1M client window.

Gateway subagents:

- `/subagents [on|off|list|set|remove]` - inspect or control provider/model
  routing for `gateway-explore`, `gateway-plan`, `gateway-implement`, and
  `gateway-review`.
- `/subagents set gateway-review deepseek deepseek-v4-pro` - route a role to a
  separate API/model. The coordinator parallelizes only independent read-only
  delegates and serializes conflicting edits.
- `/subagents parallel 1` through `/subagents parallel 8` - set the maximum
  number of independent read-only delegates.
- `/delegate <plan|code|review|explore> <task>` - force one named role for the
  current task. The parent agent invokes that role through its configured
  provider/model and integrates the result.

Every normal Gateway agent run also receives the built-in `gateway-control` MCP
server. Its tools are `get_subagent_routing`, `configure_subagent_route`,
`set_subagent_parallelism`, and `set_subagents_enabled`. The model uses those
tools when a user describes a routing change in ordinary dialogue, then calls
the native `Agent` tool for the relevant role. This is the authoritative path;
Telegram commands are optional operator shortcuts, not phrase-based routing.

The protected Gateway API also provides `GET` and `PATCH /api/subagents` for
automation. It never returns API keys; routes can use an existing environment
variable such as `DEEPSEEK_API_KEY` through `apiKeyEnv`.

Tasks and files:

- `/stop` - abort the current running task.
- `/retry` - retry the last task with the same prompt.
- `/files` - list recent files downloaded from this chat.
- `/errors [n]` - show recent Telegram/gateway errors.

Cron and scheduling:

- `/schedule every 1h | prompt` - create a cron job that replies here.
- `/cron [list|reload|chatid|path|examples]` - manage cron jobs.
- `/jobs` - list jobs created for this chat.
- `/runjob <id>` - trigger a scheduled job now.
- `/pausejob <id>` - pause a scheduled job.
- `/resumejob <id>` - resume a paused job.
- `/deletejob <id>` - delete a job permanently.

Runtime control:

- `/restart` - soft-restart the gateway runtime.
- `/panic` - abort active tasks and stop the gateway runtime.
- `/bg [start|stop]` - show or control background consciousness.
- `/consciousness [start|stop]` - show, resume, or pause consciousness loop.
- `/evolution [on|off]` - show or toggle self-improvement cycles.
- `/evolve [now|stop|status]` - control autonomous evolution mode.
- `/review` - run a deep architecture review cycle.
- `/infinite <goal>` - run an opt-in persistent task loop.

Memory and repository:

- `/identity` - show current identity.
- `/scratchpad` - show working memory.
- `/bible` - show Constitution (`BIBLE.md`).
- `/architecture` - show architecture doc.
- `/git` - show git command help.
- `/git status` - show git status.
- `/git log` - show recent commits.
- `/git diff [path]` - show uncommitted changes.
- `/git commit <msg>` - stage and commit all changes.
- `/undo` - revert the last git commit with a hard reset.

## Open WebUI

The control center can install Open WebUI with:

```bash
python3.11 -m pip install open-webui
```

On Windows, use:

```powershell
py -3.11 -m pip install open-webui
```

Then start it with:

```bash
open-webui serve --host localhost --port 8080
```

Open WebUI runs at `http://localhost:8080` by default. The control center starts
it with `OPENAI_API_BASE_URLS` pointing at the local OpenClaude agent API and
`OPENAI_API_KEYS` set to the generated gateway API key.

## Docker

Use the Docker Compose file for a local two-container setup:

```bash
OPENCLAUDE_AGENT_API_KEY=ocag_change_me docker compose -f docker-compose.agent-gateway.yml up --build
```

It starts:

- `openclaude-agent` on host port `8642`;
- `open-webui` on host port `8080`;
- persistent volumes for OpenClaude config and Open WebUI data.

If those host ports are already used, override only the published host ports:

```bash
OPENCLAUDE_AGENT_API_HOST_PORT=18642 \
OPENCLAUDE_OPEN_WEBUI_HOST_PORT=18080 \
OPENCLAUDE_AGENT_API_KEY=ocag_change_me \
docker compose -f docker-compose.agent-gateway.yml up --build
```

Inside Docker, Open WebUI still talks to `http://openclaude-agent:8642/v1`.

Docker can inherit the local provider/API settings or use a separate provider
profile. In the Control Center Docker section, disable "Reuse local
provider/API" and set Docker provider, base URL, model, and API key when the
container should use another account, model, or OpenAI-compatible endpoint.

For direct compose starts, use Docker-specific provider variables:

```bash
OPENCLAUDE_DOCKER_PROVIDER=openai \
OPENCLAUDE_DOCKER_BASE_URL=https://api.onlysq.ru/ai/openai \
OPENCLAUDE_DOCKER_MODEL=gemini-3-flash \
OPENCLAUDE_DOCKER_API_KEY=sq-your-docker-key \
docker compose -f docker-compose.agent-gateway.yml up --build
```

Docker Telegram is intentionally disabled by default, even when the local
Telegram gateway is enabled. This prevents the local and Docker instances from
polling the same bot token and replying twice. In the Control Center Docker
section, either set a dedicated Docker bot token or explicitly enable
"Reuse local Telegram settings" when you really want both surfaces on the same
bot.

For direct compose starts, use the Docker-specific variables:

```bash
OPENCLAUDE_DOCKER_TELEGRAM_ENABLED=1 \
OPENCLAUDE_DOCKER_TELEGRAM_BOT_TOKEN=123456:docker-bot-token \
OPENCLAUDE_DOCKER_TELEGRAM_HOME_CHAT_ID=123456789 \
docker compose -f docker-compose.agent-gateway.yml up --build
```

To start fixed local worker replicas as well:

```bash
docker compose -f docker-compose.agent-gateway.yml --profile workers up --build
```

Workers expose agent APIs on `8741` and `8742` with Telegram, cron, and
Ouroboros disabled by default. Enable them only with dedicated worker bot
tokens, for example `OPENCLAUDE_WORKER_TELEGRAM_ENABLED=1` plus
`OPENCLAUDE_WORKER_TELEGRAM_BOT_TOKEN`. Compose also passes through cron tick
settings, Ouroboros wakeup/max-round/budget settings, model provider settings,
and WebSearch provider settings (`WEB_SEARCH_PROVIDER`, provider API keys, and
custom `WEB_*` settings). By default the gateway does not block WebSearch; set
`OPENCLAUDE_AGENT_RUNNER_DISALLOWED_TOOLS` only when a container should deny
specific tools. Set `OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS=1` when a local
OpenAI-compatible model rejects structured tool calls.

Docker starts accept either provider-native env (`CLAUDE_CODE_USE_OPENAI=1`,
`OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`) or UI-style env
(`OPENCLAUDE_PROVIDER`, `OPENCLAUDE_BASE_URL`, `OPENCLAUDE_MODEL`,
`OPENCLAUDE_API_KEY`). One-off replica scripts preserve provider values from
the env file and only let non-empty shell variables override them.

For arbitrary one-off workers, use:

```bash
scripts/release/start-docker-replica.sh 8750 worker-8750-key
```

On Windows:

```bat
scripts\release\start-docker-replica.bat 8750 worker-8750-key
```

Pass a fourth env-file argument for a separate Telegram bot:

```bat
set OPENCLAUDE_REPLICA_TELEGRAM_ENABLED=1
scripts\release\start-docker-replica.bat 8752 worker-8752-key openclaude-agent-bot-8752 .env.bot
```

See `docs/docker-replicas.md` for API checks and stop commands.

## MCP Router

The project includes `.mcp.json` for MCP Router:

```json
{
  "mcpServers": {
    "mcp-router": {
      "type": "http",
      "url": "http://${MCPR_HOST:-127.0.0.1}:${MCPR_PORT:-3282}/mcp",
      "headers": {
        "Authorization": "Bearer ${MCPR_TOKEN}"
      },
      "headersHelper": "node scripts/mcp-router-headers.cjs"
    }
  }
}
```

Set `MCPR_TOKEN` in `.env` or the shell before starting local or Docker
instances. Local runs connect to `127.0.0.1:3282` by default. Docker scripts set
`MCPR_HOST=host.docker.internal` so containers can reach the host MCP Router
app.

The headers helper prefers `.env` for local desktop runs, which avoids stale
machine-level `MCPR_TOKEN` values. In Docker it keeps container env precedence
when `MCPR_HOST=host.docker.internal`.

`scripts/mcp-router-launcher.cjs` remains available as a stdio bridge fallback
for older MCP clients.

For a local source run, use:

```bash
bun run build
OPENCLAUDE_AGENT_API_ENABLED=1 bun run start:agent-gateway
```

Use the interactive CLI (`node dist/cli.mjs`) when you want to open
`/agent-gateway`.

## Camofox Browser

Camofox is integrated as an optional browser MCP server. It runs separately on
`http://localhost:9377`; OpenClaude connects through
`scripts/release/camofox-mcp-bridge.cjs`.

Windows:

```bat
scripts\release\install-camofox.bat
scripts\release\start-camofox.bat
scripts\release\test-camofox.bat
```

macOS/Linux:

```bash
scripts/release/install-camofox.sh
scripts/release/start-camofox.sh
scripts/release/test-camofox.sh
```

In Docker, point the agent at the host browser server:

```bash
CAMOFOX_URL=http://host.docker.internal:9377
```

## Hindsight Memory

Hindsight is integrated as optional durable memory MCP. It runs separately on
`http://localhost:8888` with UI on `http://localhost:9999`; OpenClaude connects
through `scripts/release/hindsight-mcp-bridge.cjs`.

Windows:

```bat
scripts\release\install-hindsight.bat
scripts\release\hindsight-docker-up.bat
scripts\release\test-hindsight.bat
```

macOS/Linux:

```bash
scripts/release/install-hindsight.sh
scripts/release/hindsight-docker-up.sh
scripts/release/test-hindsight.sh
```

Core env:

```bash
HINDSIGHT_URL=http://localhost:8888
HINDSIGHT_BANK_ID=openclaude-agent
HINDSIGHT_MCP_TIMEOUT=60
OPENCLAUDE_DOCKER_HINDSIGHT_URL=http://host.docker.internal:8888
```

The agent prompt teaches the child runner to use OpenRAG for document RAG,
Camofox for browser automation, and Hindsight for durable memory.

For the product-style launcher, use `scripts/release/control-center.bat` on
Windows or `scripts/release/control-center.sh` on macOS/Linux, then press the
buttons in this order:

1. Save settings.
2. Start API.
3. Install Open WebUI if it is not installed yet.
4. Start Open WebUI.
5. Start Docker if you need the containerized instance.
6. Run the local/Docker smoke tests from the same form.
