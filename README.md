# OpenClaude

Clone-to-production setup for Windows, Linux, macOS, and servers is documented
in [`docs/portable-deployment.md`](docs/portable-deployment.md). Existing
instance operations are covered by
[`docs/production-runbook.md`](docs/production-runbook.md). Portable migration
of NOVA memory, history, skills, MCP, tools, and workspace into OpenClaude,
Hermes, OpenCode, OpenClaw, or Codex is covered by
[`docs/agent-migration.md`](docs/agent-migration.md). Persistent VPS/SSH access
is documented in [`docs/server-access.md`](docs/server-access.md).

OpenClaude is an open-source coding-agent CLI for cloud and local model providers.

Use OpenAI-compatible APIs, Gemini, GitHub Models, Codex OAuth, Codex, Ollama, Atomic Chat, and other supported backends while keeping one terminal-first workflow: prompts, tools, agents, MCP, slash commands, and streaming output.

[![PR Checks](https://github.com/Gitlawb/openclaude/actions/workflows/pr-checks.yml/badge.svg?branch=main)](https://github.com/Gitlawb/openclaude/actions/workflows/pr-checks.yml)
[![Release](https://img.shields.io/github/v/tag/Gitlawb/openclaude?label=release&color=0ea5e9)](https://github.com/Gitlawb/openclaude/tags)
[![Discussions](https://img.shields.io/badge/discussions-open-7c3aed)](https://github.com/Gitlawb/openclaude/discussions)
[![Security Policy](https://img.shields.io/badge/security-policy-0f766e)](SECURITY.md)
[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

OpenClaude is also mirrored to GitLawb:
[gitlawb.com/node/repos/z6MkqDnb/openclaude](https://gitlawb.com/node/repos/z6MkqDnb/openclaude)

[Quick Start](#quick-start) | [Setup Guides](#setup-guides) | [Providers](#supported-providers) | [Source Build](#source-build-and-local-development) | [VS Code Extension](#vs-code-extension) | [Community](#community)

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=gitlawb/openclaude&type=date&legend=top-left)](https://www.star-history.com/?repos=gitlawb%2Fopenclaude&type=date&legend=top-left)

## Why OpenClaude

- Use one CLI across cloud APIs and local model backends
- Save provider profiles inside the app with `/provider`
- Run with OpenAI-compatible services, Gemini, GitHub Models, Codex OAuth, Codex, Ollama, Atomic Chat, and other supported providers
- Keep coding-agent workflows in one place: bash, file tools, grep, glob, agents, tasks, MCP, and web tools
- Use the bundled VS Code extension for launch integration and theme support

## Quick Start

### Complete Docker agent

The portable profile keeps runtime data outside Git, generates production
secrets, downloads the local Ollama models, and starts the Agent Gateway,
OpenWebUI, Tool Router, File Manager, OmniRoute, SearXNG, Telegram MCP, skills,
MCP servers, and workers.

OpenWebUI image uploads and voice/video screen-share turns pass through the
same agent pipeline. Local faster-whisper transcribes speech and the bundled
Qwen-MM/Ollama layer supplies visual evidence even when the selected provider
is text-only. See [`docs/openwebui-multimodal.md`](docs/openwebui-multimodal.md).

Windows:

```powershell
git clone https://github.com/Zamocshek/openclaude.git
cd openclaude
.\openclaude.ps1 init
.\openclaude.ps1 up
```

Linux, macOS, or a server:

```bash
git clone https://github.com/Zamocshek/openclaude.git
cd openclaude
./openclaude.sh init
./openclaude.sh up
```

The Docker stack includes the pinned LightRAG service and its local Ollama
embedding/LLM defaults. Add `-Full` on PowerShell or `--full` on POSIX to include
the remaining optional companion services. See the
[portable deployment guide](docs/portable-deployment.md) for Telegram,
provider, Codex subscription, and public-server setup.

LightRAG WebUI is available at `http://localhost:9621/webui`. Existing OpenRAG
indexes can be exported, reconstructed, re-indexed, and verified without
deleting the source volume:

```bash
npm run release:lightrag:migrate
```

### Install

```bash
npm install -g @gitlawb/openclaude
```

If the install later reports `ripgrep not found`, install ripgrep system-wide and confirm `rg --version` works in the same terminal before starting OpenClaude.

### Start

```bash
openclaude
```

Inside OpenClaude:

- run `/provider` for guided provider setup and saved profiles
- run `/agent-gateway` for the cross-platform agent control center: Telegram,
  cron, OpenAI-compatible agent API, Open WebUI, and Ouroboros settings
- run `/onboard-github` for GitHub Models onboarding

### Telegram Inference

When the Agent Gateway Telegram bridge is enabled, the bot accepts normal
messages as agent prompts and supports these owner-control commands from
Telegram:

- `/help`, `/commands` - show Telegram help and refresh the command menu
- `/panel`, `/control` - open the button control panel for providers/models,
  MCP servers, runtime tools, cron jobs, memory, research modes, and repository
  actions
- `/mcp`, `/mcp add <json>`, `/mcp enable <name>`, `/mcp disable <name>`,
  `/mcp remove <name>` - import and manage MCP servers; a standalone JSON
  message with a top-level `mcpServers` object is imported automatically
- `/android`, `/android discover`,
  `/android add <alias> <usb|wifi|auto> <serial>`,
  `/android pair <host:port> <code>`, `/android connect <alias>`,
  `/android use <alias>`, and `/android check [alias]` - discover, pair,
  save, select, and validate multiple Android-MCP device profiles
- `/skills`, `/skill <name>`, `/skill create <name> | <description> |
  <instructions>`, `/skill delete <name>` - browse the button-driven Skill
  Store, inspect skills, and create or remove persistent user skills
- `/tools [on|off|list|enable NAME|disable NAME]` - inspect or toggle all
  model tools, or enable/disable one built-in tool for subsequent runs
- `/chatid` - show the current chat ID
- `/status` - show gateway, worker, cron, budget, and Ouroboros status
- `/provider`, `/models`, `/provider models`,
  `/provider set <provider> <model> [base_url] [api_key]` - inspect or switch
  the provider and model used by the next agent runs; `/provider` and
  `/models` include Telegram inline buttons for Codex, DeepSeek, OpenCode Zen,
  OpenRouter, OmniRoute, and LM Studio
- `/sol`, `/terra`, `/luna`, `/gpt55`, `/codex`, `/dsflash`, `/dspro`, `/zenflash`,
  `/gemma`, `/gemmacoder` - quick switches for Codex GPT-5.6 Sol/Terra/Luna,
  GPT-5.5, DeepSeek V4 Flash/Pro, OpenCode Zen DeepSeek V4 Flash Free, and the
  LM Studio Gemma profiles
- `/reasoning [low|medium|high|xhigh|max|ultra]` - open the Codex reasoning
  picker or set a supported level directly; the bot reads supported levels
  from the signed-in Codex model catalog. `max` uses the backend-safe `xhigh`
  effort, while `ultra` adds automatic Agent-tool delegation for substantial
  independent subtasks.
- `/provider set lmstudio-lan gemma-4-12b-obliterated` - switch Telegram
  inference to the host LM Studio server at `http://host.docker.internal:1234/v1`
  in full agent mode. Native OpenAI/Hugging Face function calling is used when
  the loaded model supports it; incompatible local GGUF templates automatically
  fall back to the text-tool adapter while keeping Bash, file, and MCP execution
  in the standard agent runtime.
- `/zenflash` - switch to OpenCode Zen at `https://opencode.ai/zen/v1` using
  the free `deepseek-v4-flash-free` model. Its credential is retained in the
  ignored `OPENCODE_ZEN_API_KEY` environment variable.
- `/model [model]`, `/baseurl <url>`, `/apikey <key>` - open model buttons or update the active
  OpenAI-compatible provider profile. OpenRouter keys are retained separately
  in `OPENROUTER_API_KEY` so switching away and back does not lose them.
- `/context`, `/context auto|1m|<tokens>` - inspect or override the effective
  context window for the active model; `unlimited` maps to the 1M client window
- `/stop`, `/retry` - abort or retry the current Telegram inference task
- `/files`, `/transcribe`, `/errors [n]` - inspect downloaded files,
  local transcription availability, and recent gateway errors. Voice messages
  become commands when STT succeeds and remain actionable file attachments when
  STT is unavailable.
- `/schedule every 1h | prompt`, `/cron [list|reload|chatid|path|examples]`,
  `/jobs`, `/runjob <id>`, `/pausejob <id>`, `/resumejob <id>`,
  `/deletejob <id>` - manage scheduled agent jobs
- `/restart`, `/panic`, `/bg [start|stop|now|status]`,
  `/consciousness [start|stop|now|status]`, `/evolution [on|off|status]`,
  `/evolve [on|off|now|status]`, `/review`,
  `/goal [status|clear|<objective>]`,
  `/loop [start|stop|status|<objective>]`, `/infinite <goal>` - control the
  long-running gateway/Ouroboros loops. `/infinite` remains a compatibility
  alias for `/loop <goal>`.
- `/identity`, `/scratchpad`, `/bible`, `/architecture`, `/git`,
  `/git status`, `/git log`, `/git diff [path]`, `/git commit <msg>`,
  `/undo` - inspect memory and repository state

The bridge also registers the same base commands with Telegram's command menu
through `setMyCommands` at startup.

See [docs/ouroboros-harness.md](docs/ouroboros-harness.md) for the mode's
completion contract, upstream attribution, and benchmark-reproduction limits.

Background consciousness persists its enabled state in both `.env` and the
gateway config. `start` restarts the gateway and schedules an immediate wakeup;
`now` requests another wakeup without restarting. A wakeup performs one short
round by default and continues only when the model emits `[CONTINUE]`, bounded
by `OPENCLAUDE_OUROBOROS_MAX_ROUNDS`. Enabling evolution schedules the first
cycle on the next background wakeup and later cycles no more often than
`OPENCLAUDE_EVOLUTION_INTERVAL_SECONDS` (default: six hours). `/evolve now` and
`/review` are one-off runs and do not silently enable autonomous evolution.

`/goal <objective>` persists one explicit objective per Telegram chat in the
gateway state volume without modifying durable memory, identity, or RPG files.
`/loop start` claims that objective and runs the adaptive Ouroboros loop. The
loop is unbounded by default; optional `OPENCLAUDE_OUROBOROS_LOOP_MAX_ITERATIONS`
and `OPENCLAUDE_OUROBOROS_LOOP_BUDGET_USD` set deliberate deployment limits.
`/stop` or `/loop stop` pauses the execution but preserves the goal, while
`/goal clear` removes only that goal. A gateway restart demotes any stale active
loop to `paused`, never silently creates a ghost worker. Three identical failed
iterations become a resumable `blocked` state rather than a blind retry storm.

### Release Scripts

For local production-style runs, use the cross-platform wrappers in
[`scripts/release`](scripts/release):

- macOS / Linux:
  - `./scripts/release/install-deps.sh`
  - `./scripts/release/start-ui.sh`
  - `./scripts/release/start-agent-gateway.sh`
  - `./scripts/release/install-open-webui.sh`
  - `./scripts/release/serve-open-webui.sh`
  - `./scripts/release/docker-up.sh`
  - `./scripts/release/docker-down.sh`
- Windows:
  - `scripts\\release\\install-deps.bat`
  - `scripts\\release\\start-ui.bat`
  - `scripts\\release\\start-agent-gateway.bat`
  - `scripts\\release\\install-open-webui.bat`
  - `scripts\\release\\serve-open-webui.bat`
  - `scripts\\release\\docker-up.bat`
  - `scripts\\release\\docker-down.bat`

### Browser model collaborators

The bundled `/qwen-collab` skill (aliases `/qwen`, `/browser-collab`,
`/browser-model`, and `/web-model`) uses isolated persistent Camofox profiles
for independent reviews by Qwen, ChatGPT, Claude, Gemini, DeepSeek,
Perplexity, or a custom browser AI. List the profile registry with:

```bash
bun run release:camofox:profiles
bun run release:camofox:auth -- status qwen
bun run release:camofox:auth -- login qwen
```

Complete login yourself in the visible Camoufox window. OpenClaude never reads
passwords, account choices, CAPTCHA, OAuth, or MFA responses. The helper stores
only browser cookies and localStorage under `~/.camofox/profiles`, outside Git.
Inspect or
explicitly finish the running helper with:

```bash
bun run release:camofox:auth -- status <profile>
bun run release:camofox:auth -- save <profile>
bun run release:camofox:auth -- verify <profile>
```

The old `release:camofox:qwen:*` commands remain compatible. NOVA can add or
edit non-secret routing profiles through MCP tools, select an explicitly
requested model, reuse a clearly matching conversation, and checkpoint the
session without closing a healthy browser. If login is required, it leaves the
session open and asks the user to complete the profile-specific command.
Profile metadata is stored in
`~/.openclaude/camofox-auth/browser-model-profiles.json`; authentication
material is never stored there or committed.

### Fastest OpenAI setup

macOS / Linux:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_MODEL=gpt-4o

openclaude
```

Windows PowerShell:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_MODEL="gpt-4o"

openclaude
```

### Fastest local Ollama setup

macOS / Linux:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:7b

openclaude
```

Windows PowerShell:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_BASE_URL="http://localhost:11434/v1"
$env:OPENAI_MODEL="qwen2.5-coder:7b"

openclaude
```

## Setup Guides

Beginner-friendly guides:

- [Non-Technical Setup](docs/non-technical-setup.md)
- [Windows Quick Start](docs/quick-start-windows.md)
- [macOS / Linux Quick Start](docs/quick-start-mac-linux.md)

Advanced and source-build guides:

- [Advanced Setup](docs/advanced-setup.md)
- [Android Install](ANDROID_INSTALL.md)

## Supported Providers

| Provider | Setup Path | Notes |
| --- | --- | --- |
| OpenAI-compatible | `/provider` or env vars | Works with OpenAI, OpenRouter, DeepSeek, Groq, Mistral, LM Studio, and other compatible `/v1` servers |
| Gemini | `/provider` or env vars | Supports API key, access token, or local ADC workflow on current `main` |
| GitHub Models | `/onboard-github` | Interactive onboarding with saved credentials |
| Codex OAuth | `/provider` | Opens ChatGPT sign-in in your browser and stores Codex credentials securely |
| Codex | `/provider` | Uses existing Codex CLI auth, OpenClaude secure storage, or env credentials |
| Ollama | `/provider` or env vars | Local inference with no API key |
| Atomic Chat | advanced setup | Local Apple Silicon backend |
| Bedrock / Vertex / Foundry | env vars | Additional provider integrations for supported environments |

## What Works

- **Tool-driven coding workflows**: Bash, file read/write/edit, grep, glob, agents, tasks, MCP, and slash commands
- **CodeGraph semantic code intelligence**: `codegraph_explore` returns relevant source, call paths, and change impact from a local auto-synced `.codegraph` SQLite index
- **Private web research**: SearXNG plus `mcp-searxng` provide metasearch, suggestions, instance diagnostics, and source-page reading
- **Current library documentation**: Context7 resolves packages and retrieves version-aware API and setup documentation
- **GitHub automation**: the official GitHub MCP handles authenticated repository, issue, pull request, Actions, and account operations
- **Semantic task routing**: a bounded model-router selects task type and capabilities by meaning; deterministic rules remain only as an availability fallback and for explicit server names
- **Streaming responses**: Real-time token output and tool progress
- **Tool calling**: Multi-step tool loops with model calls, tool execution, and follow-up responses
- **Images**: Telegram photos and OpenAI `image_url`/Responses `input_image`
  data URLs are saved as protected local files. The gateway runs a dedicated
  Codex `gateway-vision` preflight, strips visual paths from the parent request,
  and injects grounded text evidence. Text-only providers such as DeepSeek never
  receive direct image payloads or binary image tool results. Remote image URLs
  are not downloaded server-side to avoid SSRF.
- **Provider profiles**: Guided setup plus saved `.openclaude-profile.json` support
- **Local and remote model backends**: Cloud APIs, local servers, and Apple Silicon local inference

### CodeGraph

CodeGraph is installed as an exact project dependency and connected through
the project `.mcp.json`. Docker initializes `/workspace/.codegraph` on the first
start; later MCP sessions reconcile and watch source changes automatically.
The index is local and ignored by Git.

Useful commands inside the Docker agent:

```bash
codegraph status /workspace
codegraph explore "how does the Telegram request reach the model?"
codegraph impact TelegramAgentBridge
codegraph sync /workspace
```

For the same checks on the host, run `node scripts/codegraph-mcp.cjs status .`
or replace `status .` with another CodeGraph command.

Set `OPENCLAUDE_CODEGRAPH_AUTO_INIT=0` to disable first-start indexing or
`CODEGRAPH_TELEMETRY=1` to opt into CodeGraph's anonymous usage telemetry.

### Search And Documentation

The default Docker stack includes a private SearXNG instance and exposes it only
at `http://127.0.0.1:18088`. The agent receives both the native WebSearch adapter
and the `mcp-searxng` tools `searxng_web_search`, `searxng_search_suggestions`,
`searxng_instance_info`, and `web_url_read`. The SearXNG JSON API is enabled in
`config/searxng/settings.yml`.

Context7 is connected through the same project `.mcp.json`. The agent is directed
to use `resolve-library-id` and `query-docs` for current library/API documentation,
configuration, setup, and version-specific code. `CONTEXT7_API_KEY` is optional;
set one in `.env` for higher upstream rate limits.

### GitHub MCP

The tracked `.mcp.json` connects the official remote
[GitHub MCP Server](https://github.com/github/github-mcp-server) at
`https://api.githubcopilot.com/mcp/`. Put `GITHUB_MCP_PAT` in the ignored
`.env`; the token is expanded only in the protected runtime configuration and
is never committed. The default GitHub toolsets cover account context,
repositories, issues, pull requests, and users. NOVA routes GitHub work to this
server instead of assembling ad-hoc REST commands.

Task routing is semantic by default. A tools-disabled `gateway-explore` pass
returns a validated JSON decision before the main run. It has a 20-second
ceiling, cannot select an unavailable MCP server, and falls back without
blocking the task. Set `OPENCLAUDE_AGENT_SEMANTIC_ROUTING=0` only for diagnostic
comparison.

### Android Devices

The base tool set includes
[CursorTouch Android-MCP](https://github.com/CursorTouch/Android-MCP), pinned to
version `0.2.0`. Docker installs Android platform-tools, Python 3.13, and the MCP
package in the image. Host-native Windows runs use the existing `adb` and `uvx`
commands.

Use Telegram `/android` for the device panel. Each saved alias creates a
separate pinned MCP server named `android-<alias>`, so two different devices do
not share Android-MCP's process-local active-device state. The bundled
`android-device` skill resolves aliases through real Gateway control tools,
checks ADB state, snapshots the screen, prefers selector-based interaction, and
keeps retries bounded.

Examples:

```text
/android discover
/android add personal usb RFCN2013V8D
/android pair 192.168.1.8:37123 123456
/android add lab-phone wifi 192.168.1.8:5555
/android connect lab-phone
/android check lab-phone
```

Android 10+ and USB debugging or Wireless debugging are required. Accept the
debugging authorization prompt on the target device. On Docker Desktop for
Windows, direct WiFi ADB is the portable path. USB devices normally remain
owned by the Windows host; either run the Gateway natively or expose a
host-restricted ADB server and set
`OPENCLAUDE_ANDROID_ADB_SERVER_SOCKET=tcp:host.docker.internal:5037`.
Do not expose ADB port 5037 to an untrusted network.

The authenticated Gateway API provides:

- `GET /api/android/devices`
- `POST /api/android/discover`
- `POST /api/android/devices`
- `PATCH|DELETE /api/android/devices/:alias`
- `POST /api/android/devices/:alias/check`
- `POST /api/android/connect`, `/api/android/disconnect`, `/api/android/pair`

Run `bun run release:android:test` to verify the pinned package. With an
authorized device attached it also performs the MCP handshake and checks the
required tool inventory. Without a device it validates installation and reports
that live tools were skipped. A generic Android MCP server is not started:
upstream exits when no device is attached, so only registered aliases are added
to agent runs.

Additional MCP servers can be added at runtime from Telegram or the authenticated
Agent Gateway API without editing the tracked `.mcp.json`:

```json
{
  "mcpServers": {
    "searxng-extra": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "http://searxng:8080"
      }
    }
  }
}
```

Send that JSON directly to the owner-only Telegram bot, use `/mcp add <json>`,
or `POST /api/mcp/servers`. List servers with `GET /api/mcp/servers`, toggle one
with `PATCH /api/mcp/servers/:name` and `{ "enabled": false }`, or remove a
runtime server with `DELETE /api/mcp/servers/:name`. `/api/*` uses the existing
gateway bearer authentication. Runtime MCP definitions and their secrets are
stored under the private Agent Gateway state directory; Telegram and API replies
return only redacted targets and environment/header key names. Imported `npx`
servers are launched without a shell and changes apply to the next agent run.
The generated configuration is passed with `--strict-mcp-config`, so a disabled
server cannot be silently restored from the tracked project `.mcp.json`.

The Tool Router has three independent reduction layers: MCP server switches,
Skill Store switches, and per-tool switches under **Tools & Runtime**. The
global model-tools switch starts subsequent runs with an empty strict MCP
configuration and no built-in tool schemas. Capability-specific system guidance
is included only for MCP servers and skills that are enabled for that run.
Ouroboros is the single execution harness: it stays lightweight for direct
conversation and enables task contracts, acceptance checks, delegation, and
three bounded verifier passes for substantial or tool-driven work. Codex model
selection defaults to the highest reasoning level advertised by that model;
`/reasoning` remains available when an explicit lower level is wanted.

An enabled MCP server is **eligible**, not automatically loaded into every
request. With `OPENCLAUDE_AGENT_AUTO_MCP_ROUTING=1` (the production default),
each run receives its own isolated, task-scoped strict MCP profile containing
only the eligible servers relevant to the current request. Hindsight is selected
for explicit memory and prior-context requests instead of adding its tool
schemas to every conversational turn. A dynamically imported server is selected
when the request names it, and an explicit request to use `all tools` or `all
MCP` includes every eligible server for that run.
Set the variable to `0` only when every enabled MCP server must be exposed to
every normal run.

### Telegram MCP And Maton

The production stack runs the vendored Telegram MCP as one private
streamable-HTTP sidecar. It provides multi-account Telethon tools, local
Telegram memory/search, confirmed reply and publishing workflows, and optional
Maton-connected services. A single sidecar prevents parallel agent runs from
opening the same Telethon SQLite session files independently.

Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and optional provider keys such as
`MATON_API_KEY`, `VPROMOTIONS_API_KEY`, or `TWIBOOST_API_KEY` in the ignored
Telegram MCP deployment `.env` (under `OPENCLAUDE_HOST_TELEGRAM_MCP_DIR`).
Persistent sessions live at
`%USERPROFILE%/.openclaude/telegram-mcp/session` by default. The loopback-only
operator console is available at `http://localhost:19765`.

Interactive account login is continuation-aware. After `authorize_send_code`
succeeds, the bridge keeps a short-lived in-memory auth state for that Telegram
chat. The next confirmation code and optional 2FA password go directly to
`authorize_complete`; they are not sent through the main model, chat transcript,
recovery prompt, or durable memory. `/newchat` cancels the pending login.

This uses the general `openclaude.interaction/v1` protocol rather than a
Telegram phrase matcher. Any multi-step tool can declare its handler, stage,
expected input schema, safe state, source tool, and TTL. The gateway keeps the
workflow attached to the client session and routes the next turn with that
context. Protected input is accepted only by a registered trusted adapter and
is never forwarded to the model as a fallback.

The built-in `telegram-mcp-operations`, `maton-api-gateway`, `vpromotions`, and
`twiboost` skills appear in
the Skill Store and can be enabled or disabled independently. Provider-specific
Maton references are vendored under
`integrations/telegram-mcp/maton skills for telegram/references/`.

### Portable capability router

`packages/capability-router` is an agent-neutral MCP facade for the MCP Router,
Skill Store, workspace file manager, and task capability selection. A client
sees five stable tools instead of every downstream schema. For each task the
router uses OmniRoute (or another OpenAI-compatible endpoint) to select a
bounded set of capabilities, starts only those MCP servers, and returns only
their relevant tool schemas. A deterministic metadata scorer is available when
the semantic endpoint is offline.

The Docker UI is available at `http://localhost:19868`; its MCP endpoint is
`http://localhost:19868/mcp`. It uses `OPENCLAUDE_AGENT_API_KEY` by default, or
the separate `CAPABILITY_ROUTER_API_KEY` override. The package has no dependency
on NOVA or Agent Gateway and can be installed in Hermes, OpenCode, OpenClaw,
Codex, or another MCP client. Export a ready target bundle with:

```bash
bun run agent:migrate export --output ./nova-portable
bun run agent:migrate adapt ./nova-portable --target hermes --output ./nova-hermes
node ./nova-hermes/install-capabilities.mjs
```

Use `--exposure direct` only when a target must receive every downstream MCP
schema eagerly. See [`docs/agent-migration.md`](docs/agent-migration.md).

### Skill Store

The Skill Store is available from Telegram `/skills` and the authenticated
Agent Gateway API. It lists bundled, managed, project, and user file-based skills
while allowing only Store-created user skills to be removed. Create a native skill by
sending this owner-only Telegram JSON or by using `POST /api/skills`:

```json
{
  "skill": {
    "name": "verify-output",
    "description": "Use when a task needs explicit verification.",
    "instructions": "Run the narrowest relevant check before reporting success."
  }
}
```

List with `GET /api/skills`, inspect with `GET /api/skills/:name-or-id`, and
remove a Store-created skill with `DELETE /api/skills/:name-or-id`. Skills are
written atomically to `${CLAUDE_CONFIG_DIR}/skills/<name>/SKILL.md`, persist in
the existing Docker config volume, and become available to the native `Skill`
tool on the next agent run.

Every Agent Gateway run performs a private capability-routing pass before
execution. The model reviews available skill descriptions, connected MCP
servers, and built-in tools, invokes the most specific matching skill first,
and selects no specialized capability only when none adds value. This rule is
shared by Telegram, the Agent API, cron runs, and OpenWebUI inference.

Code implementation, debugging, review, deployment, and refactoring requests
route through the bundled `code` skill. It enforces repository discovery,
Read-before-Edit/Write, native file editing, TodoWrite checkpoints, targeted
verification, final diff review, and recovery from corrected tool calls. With
`OPENCLAUDE_AGENT_CODING_COMPLETION_GATE=1` (the production default), a
successful coding mutation is not considered complete until a relevant
verifier succeeds after the last edit. A test that ran before the final
mutation does not satisfy the gate. The default Ouroboros evaluator gets at
most three bounded correction passes and then fails closed instead of reporting
unverified work as complete. Artifacts, activity, duration, and cost from all
passes are retained.
For streaming OpenAI-compatible coding requests, the final answer is buffered
until the gate passes while SSE keepalives keep OpenWebUI connections alive.

Docker defaults allow up to 720 turns and 30 minutes for the main gateway run;
replica workers allow 240 turns and 20 minutes. An independent structured-progress
watchdog stops a stalled child after 900000 ms without output by default; configure it with
`OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS`, or set that variable to `0` to
disable the watchdog. Telegram Stop still aborts the active child process
immediately. Override the total run limits with
`OPENCLAUDE_AGENT_RUNNER_MAX_TURNS`, `OPENCLAUDE_AGENT_RUNNER_TIMEOUT_MS`,
`OPENCLAUDE_AGENT_WORKER_MAX_TURNS`, and `OPENCLAUDE_AGENT_WORKER_TIMEOUT_MS`.
After a structured terminal success event, the gateway waits 1000 ms for normal
CLI shutdown and then closes a lingering completed process; configure that grace
with `OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS`.

A live tool-loop watchdog also stops only the current execution branch after
three identical failed tool completions occur without new mutation,
verification, interaction, or artifact evidence. Successful calls and bounded
background-task polling have higher derived thresholds. Telegram recovery keeps
completed state, classifies the branch as `loop_detected`, asks one independent
reviewer for a changed route when subagents are available, and continues the
original request. The base failure threshold is exposed as
`OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT`, but normally requires no tuning.

Generated binary deliverables should be kept under the workspace and registered
with `openclaude-artifact --path <file> --kind image|audio|document`. The runner
captures this generic tool marker, preserves it across recovery attempts, and
returns the file through Telegram without trying to read binary bytes as text.

Telegram retries transient provider and network failures with exponential
bounded backoff. The initial and maximum delays default to 1000 ms and 30000 ms
and are configured with `OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MS` and
`OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MAX_MS`.

For verifier-driven terminal coding tasks, set
`OPENCLAUDE_TERMINAL_BENCH=1`. This enables a verifier-first execution profile
with bounded commands, explicit error classification, checkpoints, and final
artifact/diff verification. Run `bun run bench:terminal` for the fast local
UTF-8, exit-code, and timeout smoke. It is not an official benchmark score;
official Terminal-Bench evaluation uses
[Terminal-Bench](https://github.com/harbor-framework/terminal-bench) and the
[Harbor/TB2 harness](https://github.com/harbor-framework/terminal-bench-2).

### Authorized Pentest Mode

The bundled `pentest` skill and base `pentest` MCP provide an authorized
penetration-testing workflow inspired by
[PentestCode](https://github.com/s0ld13rr/pentestcode). In Telegram, send
`/pentest` to keep the mode active for the chat, `/pentest <task>` for one
request, or `/mode off` to leave it. Before active testing, record scope through
the trusted Telegram bridge:

```text
/pentest auth lab-1 | 10.10.10.0/24,app.lab.example | I own this isolated lab
```

The model cannot mint this production authorization itself. The same skill and
MCP state/report tools are available through OpenWebUI and the OpenAI-compatible
Agent API; trusted production scope creation remains a Gateway operation.

The mode records an explicit engagement scope before active testing and refuses
targets or action classes that do not match it. Its persistent state includes
hosts, services, findings, evidence, action history, and protected credential
references. Nmap XML is parsed with `pentest_nmap_parse`; reports are generated
with `pentest_report_generate`. Telegram pentest runs use a strict read-only
runtime: direct shell, PowerShell, general web fetch, and file editing tools are
removed, and only the Pentest and CodeGraph MCP servers are loaded.
Bounded network scans run through `pentest_nmap_run`, which verifies
`active_scan` scope before spawning Nmap without a shell and imports the XML
result automatically. Docker also includes `nmap`, `dig`, `whois`, `ping`,
`nc`, and `jq` for basic authorized assessment work. Engagement state defaults
to the ignored `.openclaude-data/pentest/` directory and is shared by the main
container and agent workers.

The implementation intentionally does not reproduce PentestCode's `free` mode:
active scans, vulnerability validation, credential tests, and post-exploitation
must pass `pentest_scope_check`. Raw credentials and session secrets are
excluded from tool responses, progress messages, durable memory, and generated
reports.

Start or refresh the stack with:

```bash
docker compose -f docker-compose.agent-gateway.yml up -d --build
```

Production containers run a strict base-MCP preflight after CodeGraph indexing
and before the gateway starts. It verifies the tracked `.mcp.json`, the pinned
CodeGraph/SearXNG/Context7 packages, the authenticated GitHub MCP contract, the
Pentest MCP contract, the CodeGraph database, and SearXNG health.
Run the same local check with `bun run check:base:mcp`; use
`OPENCLAUDE_MCP_PREFLIGHT_STRICT=0` only when intentionally accepting a degraded
startup. The full protocol smoke test is `bun run test:research:mcp` and also
checks CodeGraph plus the disconnected MCP Router fallback. Run the persistent
scope/state/report smoke test with `bun run test:pentest:mcp`.

For host-native MCP use, set `SEARXNG_URL=http://127.0.0.1:18088`. Docker uses
the internal `http://searxng:8080` service address automatically. Keep SearXNG
bound to loopback unless its authentication and reverse proxy are configured.

### OmniRoute model router

The Docker stack includes [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
as an internal OpenAI-compatible model router. Its API is available to gateway
and worker containers at `http://omniroute:20128/v1`; the dashboard and API are
published on loopback at `http://localhost:20128`. Persistent OmniRoute state
and Redis data live in named Docker volumes.

Telegram exposes OmniRoute in the provider button menu and adds these shortcuts:

- `/omni` selects `auto`
- `/omnicode` selects `auto/coding`
- `/omnifast` selects `auto/fast`
- `/omnicheap` selects `auto/cheap`
- `/omnismart` selects `auto/smart`
- `/omnioffline` selects `auto/offline`

Use `/provider models` or the model buttons to select any additional model
reported by OmniRoute. The same provider can be assigned to a subagent with
`/subagents set <role> omniroute auto/coding`.

The loopback-only single-user deployment defaults to OmniRoute's documented
`sk_omniroute` placeholder with `REQUIRE_API_KEY=false`. Before publishing the
endpoint through a reverse proxy, create a real key in OmniRoute's API Keys
screen, set `OMNIROUTE_REQUIRE_API_KEY=true`, and configure
`OMNIROUTE_API_KEY`. Keep the dashboard, agent API, and generated secrets off
public interfaces unless authentication and TLS are in place.

## Provider Notes

OpenClaude supports multiple providers, but behavior is not identical across all of them.

- Anthropic-specific features may not exist on other providers
- Tool quality depends heavily on the selected model
- Smaller local models can struggle with long multi-step tool flows
- Some providers impose lower output caps than the CLI defaults, and OpenClaude adapts where possible

For best results, use models with strong tool/function calling support.

## Agent Routing

OpenClaude can run subagents through different OpenAI-compatible APIs in the
same parent task. Routing uses stable provider profile IDs, so the same model
name can safely exist behind multiple endpoints. The parent model decides when
and how to decompose work; gateway delegation is available on every run rather
than being enabled by prompt keywords.

Add to `~/.claude/settings.json`:

```json
{
  "agentModels": {
    "deepseek-fast": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "base_url": "https://api.deepseek.com/v1",
      "api_key_env": "DEEPSEEK_API_KEY"
    },
    "codex-ultra": {
      "provider": "codex",
      "model": "gpt-5.6-sol?reasoning=ultra",
      "base_url": "https://chatgpt.com/backend-api/codex",
      "api_key_env": "CODEX_API_KEY"
    }
  },
  "agentRouting": {
    "Explore": "deepseek-fast",
    "Plan": "codex-ultra",
    "general-purpose": "codex-ultra",
    "default": "codex-ultra"
  },
  "agentMaxParallel": 3,
  "agentTimeoutMs": 1800000
}
```

Resolution priority is an explicit Agent `provider_profile`, teammate name,
`subagent_type`, then `default`. An explicit `model` can override the selected
profile's default model while retaining that profile's API and credentials.
Custom agent JSON/frontmatter can pin `providerProfile: codex-ultra`.

`agentMaxParallel` is a real FIFO runtime limit, not prompt advice. Queued
agents can be cancelled without leaking a slot. `agentTimeoutMs` bounds each
subagent's wall-clock lifetime, including queue wait time. When no routing
match exists, the parent/global provider remains the fallback.

Legacy model-keyed entries such as `"deepseek-chat": { "base_url": ..., "api_key": ... }`
remain valid: the profile key is used as the model when `model` is omitted.

Prefer `api_key_env` over a literal `api_key`. Literal keys remain supported
for backward compatibility, are stored in plaintext, and must never be
committed. Gateway-generated routing files are ephemeral and mode `0600`.

## Web Search and Fetch

By default, `WebSearch` works on non-Anthropic models using DuckDuckGo. This gives GPT-4o, DeepSeek, Gemini, Ollama, and other OpenAI-compatible providers a free web search path out of the box.

> **Note:** DuckDuckGo fallback works by scraping search results and may be rate-limited, blocked, or subject to DuckDuckGo's Terms of Service. If you want a more reliable supported option, configure Firecrawl.

For Anthropic-native backends and Codex responses, OpenClaude keeps the native provider web search behavior.

`WebFetch` works, but its basic HTTP plus HTML-to-markdown path can still fail on JavaScript-rendered sites or sites that block plain HTTP requests.

Set a [Firecrawl](https://firecrawl.dev) API key if you want Firecrawl-powered search/fetch behavior:

```bash
export FIRECRAWL_API_KEY=your-key-here
```

With Firecrawl enabled:

- `WebSearch` can use Firecrawl's search API while DuckDuckGo remains the default free path for non-Claude models
- `WebFetch` uses Firecrawl's scrape endpoint instead of raw HTTP, handling JS-rendered pages correctly

Free tier at [firecrawl.dev](https://firecrawl.dev) includes 500 credits. The key is optional.

---

## Headless gRPC Server

OpenClaude can be run as a headless gRPC service, allowing you to integrate its agentic capabilities (tools, bash, file editing) into other applications, CI/CD pipelines, or custom user interfaces. The server uses bidirectional streaming to send real-time text chunks, tool calls, and request permissions for sensitive commands.

### 1. Start the gRPC Server

Start the core engine as a gRPC service on `localhost:50051`:

```bash
npm run dev:grpc
```

#### Configuration

| Variable | Default | Description |
|-----------|-------------|------------------------------------------------|
| `GRPC_PORT` | `50051` | Port the gRPC server listens on |
| `GRPC_HOST` | `localhost` | Bind address. Use `0.0.0.0` to expose on all interfaces (not recommended without authentication) |

### 2. Run the Test CLI Client

We provide a lightweight CLI client that communicates exclusively over gRPC. It acts just like the main interactive CLI, rendering colors, streaming tokens, and prompting you for tool permissions (y/n) via the gRPC `action_required` event.

In a separate terminal, run:

```bash
npm run dev:grpc:cli
```

*Note: The gRPC definitions are located in `src/proto/openclaude.proto`. You can use this file to generate clients in Python, Go, Rust, or any other language.*

---

## Source Build And Local Development

```bash
bun install
bun run build
node dist/cli.mjs
```

Helpful commands:

- `bun run dev`
- `bun test`
- `bun run test:coverage`
- `bun run security:pr-scan -- --base origin/main`
- `bun run smoke`
- `bun run doctor:runtime`
- `bun run verify:privacy`
- focused `bun test ...` runs for the areas you touch

## Testing And Coverage

OpenClaude uses Bun's built-in test runner for unit tests.

Run the full unit suite:

```bash
bun test
```

Generate unit test coverage:

```bash
bun run test:coverage
```

Open the visual coverage report:

```bash
open coverage/index.html
```

If you already have `coverage/lcov.info` and only want to rebuild the UI:

```bash
bun run test:coverage:ui
```

Use focused test runs when you only touch one area:

- `bun run test:provider`
- `bun run test:provider-recommendation`
- `bun test path/to/file.test.ts`

Recommended contributor validation before opening a PR:

- `bun run build`
- `bun run smoke`
- `bun run test:coverage` for broader unit coverage when your change affects shared runtime or provider logic
- focused `bun test ...` runs for the files and flows you changed

Coverage output is written to `coverage/lcov.info`, and OpenClaude also generates a git-activity-style heatmap at `coverage/index.html`.
## Repository Structure

- `src/` - core CLI/runtime
- `scripts/` - build, verification, and maintenance scripts
- `docs/` - setup, contributor, and project documentation
- `python/` - standalone Python helpers and their tests
- `vscode-extension/openclaude-vscode/` - VS Code extension
- `.github/` - repo automation, templates, and CI configuration
- `bin/` - CLI launcher entrypoints

## VS Code Extension

The repo includes a VS Code extension in [`vscode-extension/openclaude-vscode`](vscode-extension/openclaude-vscode) for OpenClaude launch integration, provider-aware control-center UI, and theme support.

## Security

If you believe you found a security issue, see [SECURITY.md](SECURITY.md).

## Community

- Use [GitHub Discussions](https://github.com/Gitlawb/openclaude/discussions) for Q&A, ideas, and community conversation
- Use [GitHub Issues](https://github.com/Gitlawb/openclaude/issues) for confirmed bugs and actionable feature work

## Contributing

Contributions are welcome.

For larger changes, open an issue first so the scope is clear before implementation. Helpful validation commands include:

- `bun run build`
- `bun run test:coverage`
- `bun run smoke`
- focused `bun test ...` runs for touched areas

## Disclaimer

OpenClaude is an independent community project and is not affiliated with, endorsed by, or sponsored by Anthropic.

OpenClaude originated from the Claude Code codebase and has since been substantially modified to support multiple providers and open use. "Claude" and "Claude Code" are trademarks of Anthropic PBC. See [LICENSE](LICENSE) for details.

## License

See [LICENSE](LICENSE).
