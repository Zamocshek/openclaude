# OpenClaude Agent v0.4.0 — Architecture & Reference

This document describes every component, API endpoint, and data flow.
It is the single source of truth for how the system works. Keep it updated.

---

## 1. High-Level Architecture

```
User (Telegram / CLI / API)
  │
  ▼
Agent Gateway (src/services/agentGateway/)
  │
  ├── index.ts              ← Gateway bootstrap & lifecycle
  ├── config.ts             ← SSOT: paths, settings defaults, load/save
  ├── telegram.ts           ← Telegram bot bridge (Telegraf)
  ├── cron.ts               ← Cron scheduler (once/interval/cron expression)
  ├── agentRunner.ts        ← Spawns OpenClaude CLI subprocess
  ├── apiServer.ts          ← HTTP API server (optional)
  │
  ├── memory.ts             ← Scratchpad, identity, dialogue blocks, patterns
  ├── consciousness.ts      ← Background thinking daemon loop
  ├── consolidation.ts      ← Block-wise dialogue/scratchpad compression
  ├── reflection.ts         ← Post-task error analysis & process memory
  ├── evolution.ts          ← Self-improvement cycles (6 types)
  └── transcription.ts      ← Voice transcription (whisper/parakeet)
```

### Execution Model

1. **Agent Gateway** — main orchestrator process. Manages Telegram bot, cron,
   consciousness, and API server.
2. **Agent Runner** — spawns OpenClaude CLI as a child process for each task.
   The child runs with `--print --output-format text` and receives prompt via stdin.
3. **Background Consciousness** — daemon thread inside the gateway that wakes
   periodically, reflects, and can message the user proactively.

### Data Layout

```
~/.config/openclaude/agent-gateway/
├── agent-gateway.json      ← Gateway configuration
├── cron-jobs.json          ← Scheduled cron jobs
├── state.json              ← Runtime state (budget, session)
├── memory/
│   ├── identity.md         ← Agent's self-description (persistent)
│   ├── scratchpad.md       ← Working memory (auto-generated from blocks)
│   ├── scratchpad_blocks.json ← Append-block scratchpad (FIFO, max 10)
│   ├── dialogue_blocks.json ← Block-wise consolidated chat history
│   ├── dialogue_meta.json  ← Consolidation metadata (offsets)
│   ├── evolution_state.json ← Evolution mode state
│   ├── evolution_log.jsonl ← Evolution cycle log
│   ├── knowledge/
│   │   ├── patterns.md     ← Pattern Register (recurring error classes)
│   │   └── self_insights.md ← Evolution-generated insights
│   ├── identity_journal.jsonl    ← Identity update journal
│   └── scratchpad_journal.jsonl  ← Scratchpad block eviction journal
├── logs/
│   ├── chat.jsonl          ← Chat message log (for consolidation)
│   ├── task_reflections.jsonl ← Execution reflections (process memory)
│   └── events.jsonl        ← General event log
├── cron-output/            ← Cron job output files
├── telegram-files/         ← Downloaded Telegram files
└── transcriptions/         ← Temporary transcription files
```

---

## 2. Component Details

### 2.1 Agent Gateway (`index.ts`)

Bootstrap orchestrator:
- Loads config from `~/.config/openclaude/agent-gateway.json`
- Starts Telegram bridge if enabled
- Starts API server if enabled
- Starts cron scheduler if enabled
- Starts background consciousness if Telegram is enabled
- Ensures memory files exist on startup
- Hooks agent runner to pause/resume consciousness during tasks
- Triggers consolidation after task completion

### 2.2 Telegram Bridge (`telegram.ts`)

Telegraf-based Telegram bot:
- Receives messages, downloads files, passes to agent
- Handles voice messages with automatic transcription
- Injects memory context (scratchpad, identity, patterns) into agent prompts
- Logs all messages to `chat.jsonl` for dialogue consolidation
- Commands: `/start`, `/help`, `/chatid`, `/schedule`, `/jobs`, `/runjob`,
  `/pausejob`, `/resumejob`, `/deletejob`, `/files`, `/transcribe`,
  `/consciousness`, `/evolution`, `/evolve`, `/identity`, `/scratchpad`

### 2.3 Cron Scheduler (`cron.ts`)

File-based cron system:
- Three schedule types: `once`, `interval`, `cron expression`
- Delivery: `local`, `telegram`, `origin`
- Persistent state in `cron-jobs.json`
- Atomic writes with UUID temp files
- `[SILENT]` marker support for quiet jobs

### 2.4 Agent Runner (`agentRunner.ts`)

Spawns OpenClaude CLI subprocess:
- Passes prompt via stdin
- Captures stdout/stderr
- Configurable timeout and max turns
- Uses a 900000 ms idle-output watchdog for structured-progress runs by
  default; `0` disables it
- Permission mode support
- Treats enabled MCP servers as eligible capabilities and creates a unique,
  task-scoped strict MCP profile for each run
- Selects relevant eligible MCP servers automatically by default; an explicit
  `all tools` or `all MCP` request selects every eligible server, including
  dynamically imported servers
- Selects Hindsight for explicit memory and prior-context requests
- Supports `minimal`, `adaptive` (default), and `strict` harness modes so
  optional orchestration is proportional to task complexity
- Requires a successful verifier after the last coding mutation by default,
  with one adaptive or two strict bounded correction passes and fail-closed
  completion; minimal mode skips the extra evaluator
- Merges implementation and evaluator artifacts, activity, duration, and cost
- Buffers streaming coding answers until verification while sending SSE
  keepalive comments
- Classifies transient provider/network failures for bounded retry
- Strips ANSI codes from output

Telegram recovery applies exponential bounded backoff to transient
provider/network failures. Non-transient failures continue to use their
failure-class retry limits without network backoff.

### 2.5 Memory System (`memory.ts`)

Persistent memory structures:
- **Scratchpad**: append-block working memory with FIFO rotation (max 10 blocks)
- **Identity**: persistent self-description (identity.md)
- **Dialogue blocks**: episodic memory with era compression
- **Pattern register**: recurring error class tracking
- **Chat log**: JSONL append for consolidation

External memory/RAG/browser surfaces are exposed to child agent runs through
MCP and documented in `docs/REPO_GUIDE.md`:
- **Hindsight**: durable user/project/agent memory (`hindsight_*` tools)
- **OpenRAG**: document-grounded retrieval and ingestion (`openrag_*` tools)
- **Camofox**: live browser automation, screenshots, and isolated persistent
  browser-AI profiles (`camofox_*` tools). Non-secret profile routing lives in
  `~/.openclaude/camofox-auth/browser-model-profiles.json`; browser
  authentication state remains outside the repository under
  `~/.camofox/profiles`.

### 2.5.1 Personal RPG / Life System (`Vladimir_Kuplevatskyi/`)

The creator's life-management/RPG simulation is stored in repository markdown
under `Vladimir_Kuplevatskyi/`. It is user-owned durable state, separate from
gateway memory files, but the child agent is explicitly routed to it for
simulation, diary, habits, quests, goals, records, training, money, study,
worldview, and NOVA self-management tasks.

Operational files:

- `SYSTEM_INDEX.md` — source-of-truth map for which file owns each domain.
- `AGENT_OPERATIONS.md` — read/write/verify protocol for the agent.
- `CONTROL_PANEL.md` — daily/weekly operating surface.

The structure is checked by `scripts/life-system-check.ts` via
`bun run life:check`. This check verifies required RPG files and key headings
without changing personal memory content.

### 2.6 Background Consciousness (`consciousness.ts`)

Daemon thinking loop:
- Wakes periodically (configurable: 300s-7200s)
- Loads memory context, recent events, evolution state
- Calls LLM with introspection prompt
- Can message user proactively (`[PROACTIVE]`)
- Can update scratchpad (`[SCRATCHPAD]`)
- Can trigger evolution (`[EVOLVE]`)
- Can adjust wakeup interval (`[WAKEUP:NNN]`)
- Pauses during task execution

### 2.7 Consolidation (`consolidation.ts`)

Block-wise memory compression:
- **Dialogue consolidation**: every 100 messages → LLM summary block
- **Era compression**: oldest 4 blocks → single era summary
- **Scratchpad consolidation**: >30K chars → extract knowledge + compress
- Runs after task completion if thresholds met

### 2.8 Reflection (`reflection.ts`)

Post-task error analysis:
- Detects errors/blocks in execution trace
- Generates 150-250 word reflection via LLM
- Stored in `task_reflections.jsonl`
- Injected into next task's context as "process memory"
- Updates pattern register for recurring errors

### 2.9 Evolution (`evolution.ts`)

Self-improvement cycles (6 types, rotating):
1. **identity_evolution** — evolves self-understanding
2. **code_review** — reviews own source files
3. **prompt_evolution** — reviews and improves prompts
4. **pattern_extraction** — extracts meta-patterns
5. **tool_analysis** — analyzes tool usage
6. **architecture_review** — reviews system architecture

Results saved to `memory/knowledge/self_insights.md`

### 2.10 Voice Transcription (`transcription.ts`)

Automatic voice message transcription:
- **Windows**: whisper (`pip install openai-whisper` + ffmpeg)
- **macOS**: parakeet-mlx
- Auto-detects available tool
- Temp files cleaned up after processing

### 2.11 Vision Routing (`vision.ts`, `subagentRuntime.ts`)

Visual requests are provider-aware without coupling the Telegram or OpenAI
interfaces to one multimodal model:

- Telegram downloads the largest photo variant and records its absolute path.
- Chat Completions `image_url` and Responses `input_image` base64 data URLs are
  signature-checked, content-addressed, mode `0600`, and retained for follow-up
  turns for seven days by default.
- Before the text coordinator starts, the gateway runs an isolated
  `gateway-vision` Codex preflight with the image and current user question.
- The gateway then removes image paths, MIME markers, and attachment references
  from the parent prompt and injects only the grounded textual report. DeepSeek
  therefore cannot receive an unsupported direct image or binary `Read` result,
  even if it would otherwise ignore a routing instruction.
- HTTP(S) image URLs are left as references rather than fetched by the gateway,
  avoiding an SSRF path into the host or Docker network.

---

## 3. Configuration

Config file: `~/.config/openclaude/agent-gateway.json`

```json
{
  "api": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 8642,
    "modelName": "openclaude-agent",
    "corsOrigins": []
  },
  "cron": {
    "enabled": false,
    "tickIntervalSeconds": 60
  },
  "telegram": {
    "enabled": false,
    "botToken": "",
    "allowedChatIds": [],
    "homeChatId": "",
    "mirrorAgentApiResponses": false,
    "downloadFiles": true,
    "maxDownloadBytes": 20971520,
    "maxUploadBytes": 52428800
  },
  "runner": {
    "maxTurns": 90,
    "timeoutMs": 600000,
    "permissionMode": "default"
  }
}
```

### 3.1 Production Execution Environment

The production execution controls are environment variables so the same
behavior applies to Telegram, Agent API, cron, Ouroboros, and OpenWebUI runs:

- `OPENCLAUDE_AGENT_AUTO_MCP_ROUTING=1` (default): enabled MCP servers are
  eligible, while every run receives an isolated task-scoped profile containing
  only relevant servers. An explicit `all tools`/`all MCP` request includes all
  eligible servers, including JSON-imported servers. Hindsight is selected for
  explicit memory and prior-context requests.
- `OPENCLAUDE_AGENT_HARNESS_MODE=adaptive` (default): injects only relevant
  routing guidance. `minimal` minimizes gateway steering; `strict` enables the
  full coding workflow and an additional verifier pass.
- `OPENCLAUDE_AGENT_CODING_COMPLETION_GATE=1` (default): any successful coding
  mutation requires a relevant verifier to succeed after the final edit. The
  adaptive gate allows one bounded correction pass, strict allows two, and then
  fails closed.
- `OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS=900000` (default): aborts a child
  run after 15 minutes without output. Set `0` to disable this watchdog.
- `OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MS=1000` and
  `OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MAX_MS=30000` (defaults):
  configure exponential bounded backoff for transient provider/network
  retries.

---

## 4. Git Branching Model

- **main** — protected branch. Agent never touches it.
- **feature/*** — development branches. Agent commits here.

Safe restart does `git checkout -f main` + `git reset --hard`.

---

## 5. Key Invariants

1. **Never delete BIBLE.md. Never physically delete `identity.md` file.**
   (`identity.md` content is intentionally mutable and may be radically rewritten.)
2. **VERSION == package.json version == latest git tag == README version == ARCHITECTURE.md header version**
3. **Config SSOT**: all settings defaults live in `config.ts`
4. **State locking**: atomic writes with UUID temp files + rename
5. **Budget tracking**: consciousness has separate budget cap
6. **Zero orphans on close**: shutdown MUST kill all child processes
7. **Panic MUST kill everything**: all processes are killed and the application exits
8. **Architecture documentation**: `docs/ARCHITECTURE.md` must be kept in sync with
   the codebase. Every structural change must be reflected here.
