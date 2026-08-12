# Agent migration

OpenClaude stores portable agent state in a versioned directory bundle instead
of treating one runtime's private database as the source of truth. The same
bundle can restore OpenClaude or materialize a ready-to-use Hermes, OpenCode,
OpenClaw, or Codex profile.

## Invariants

- Export never mutates source memory, transcripts, skills, or workspace files.
- Every bundle file is listed in `manifest.json` with its size and SHA-256.
- Adaptation stops before writing when verification fails.
- API keys, OAuth tokens, passwords, cookies, private keys, and Telegram bot
  tokens are replaced by environment-variable references. The target receives
  `secrets.required.env` with empty values.
- `SKILL.md` directories are preserved as the common capability format.
- MCP definitions are normalized once and rendered into each target's native
  config shape.
- Portable components are copied with their own manifests and dependencies;
  they do not import NOVA or Gateway internals.
- Telegram MCP and local transcription are declared components, so account
  automation and file-first voice handling move without the NOVA runtime.
- Target agents receive one lazy `capability-router` MCP by default, so a task
  sees five facade tools instead of every downstream schema.
- Full history remains in canonical JSONL even when a target has no stable
  public API for importing an internal chat database.

Hindsight and OpenRAG indexes are derived state, not portable memory. Their MCP
definitions move with the bundle, while the target rebuilds indexes from
`identity/`, `state/memory/`, `conversations/`, and `workspace/`. This preserves
logical memory without coupling migration to a private vector-store schema or
copying provider credentials. OAuth sessions and API credentials are restored
separately on the target.

## Export NOVA

From the repository root:

```bash
npm run agent:migrate -- export \
  --source-home ~/.openclaude \
  --workspace . \
  --history full \
  --output ./nova.agent-bundle
```

On PowerShell, use `$HOME/.openclaude` or omit `--source-home`; the default is
the current user's `.openclaude` directory.

`agent-portability.json` declares NOVA's workspace records, tool runtimes, MCP
config, and skill roots. This keeps export policy in version control and avoids
hard-coding one person's paths into the migrator.

History modes:

The default is `gateway`. Exporting every unrelated OpenClaude project requires
an explicit `--history full` flag.

| Mode | Contents |
| --- | --- |
| `none` | Identity, memory, skills, MCP, providers, automations, workspace |
| `gateway` | Above plus Gateway/Telegram conversation history |
| `full` | Above plus all OpenClaude project-session JSONL files |

Verify and inspect before using the bundle:

```bash
npm run agent:migrate -- verify --bundle ./nova.agent-bundle
npm run agent:migrate -- inspect --bundle ./nova.agent-bundle
```

## Target adapters

```bash
npm run agent:migrate -- adapt \
  --bundle ./nova.agent-bundle \
  --target hermes \
  --output ./nova-hermes
```

Replace `hermes` with `openclaude`, `opencode`, `openclaw`, or `codex`.
`install` is an alias for `adapt` when the output path is the target's actual
home or workspace.

Install the self-contained router dependency once inside the generated pack:

```bash
node ./nova-hermes/install-capabilities.mjs
```

The default `--exposure routed` mode connects only `capability-router` to the
target. `--exposure direct` renders every MCP server natively, while
`--exposure both` keeps both surfaces for runtimes that need a transition
period. Routed mode keeps downstream credentials in the target environment and
starts each server only when `capability_route` selects it.

| Target | Native mapping | Conversation mapping |
| --- | --- | --- |
| OpenClaude | Exact Gateway memory/state, skills, MCP registry, cron archive | Exact sanitized raw JSONL plus canonical archive |
| Hermes | `SOUL.md`, `memories/`, `skills/`, `config.yaml:mcp_servers` | Recent continuation in `AGENTS.md`; full archive under `imports/` |
| OpenCode | `.opencode/agents/nova.md`, `.opencode/skills/`, current `mcp.servers` config | Native `opencode import` JSON plus full archive |
| OpenClaw | Workspace bootstrap files, skills, `openclaw.json:mcp.servers` | Native transcript JSONL and `sessions.json` plus full archive |
| Codex | `AGENTS.md`, `.codex/skills`, `.codex/config.toml:mcp_servers` | Continuation context plus canonical archive; no private SQLite writes |

OpenCode example:

```bash
opencode import ./nova-opencode/imports/opencode-sessions/nova.json
```

Codex example: open the generated `nova-codex` directory as the workspace.
Codex loads `AGENTS.md`, project skills, and project MCP config from that tree.

## Bundle layout

```text
manifest.json                     checksums and compatibility
bundle-descriptor.json            declarative export policy
identity/                         SOUL, USER, MEMORY, scratchpad
state/                            Gateway memory, config, cron, router state
conversations/messages.jsonl      canonical complete message stream
conversations/raw/                sanitized source-native JSONL
capabilities/mcp.json             normalized MCP registry
capabilities/registry.json        routing metadata, components, and tool filters
capabilities/components/          self-contained router/tool applications
capabilities/components.json      portable component index
capabilities/skills/              portable Agent Skills directories
capabilities/providers.json       provider/model routes without credentials
workspace/                        descriptor-selected agent workspace
secrets.required.env              empty credential slots
redaction.json                    redaction counts and policy
skipped.json                      explicit export omissions
```

Canonical history does not flatten tool activity into plain chat. Each message
can contain `text`, `reasoning`, `tool_call`, and `tool_result` parts, source
runtime metadata, session id, parent id, and timestamp. Raw source JSONL is kept
alongside it for lossless future adapters.

## Adding another agent

Add a renderer in `scripts/agent-migration/adapters.mjs` that consumes only the
canonical bundle. Do not add source-specific parsing to a target adapter. A new
adapter must:

1. Run `verifyBundle` before materialization.
2. Keep credentials as environment references.
3. Preserve the complete canonical archive.
4. Emit a target-native context, skills, MCP config, and an explicit fidelity
   note for surfaces the target cannot import safely.
5. Add a round-trip fixture to `agent-migration.test.mjs`.

This boundary is what makes future migration independent of NOVA's current
runtime and independent of changes to any target's private databases.

## Agent-neutral capability fabric

`packages/capability-router` can be copied or installed without the rest of
OpenClaude. It exposes the same five MCP tools over stdio and Streamable HTTP:

- `capability_route` selects a bounded server/tool/skill set for a complete task.
- `capability_call` invokes one selected downstream MCP tool.
- `capability_registry` imports standard MCP JSON and controls enabled state.
- `skill_store` installs and reads self-contained Agent Skills.
- `workspace_files` provides the portable file-manager surface.

Selection uses an OpenAI-compatible semantic classifier when
`CAPABILITY_ROUTER_LLM_BASE_URL` and `CAPABILITY_ROUTER_LLM_MODEL` are set.
OmniRoute can provide that endpoint. A metadata scorer is the bounded fallback,
not the primary policy. Per-server `allowedTools` and `blockedTools`, plus
`CAPABILITY_ROUTER_MAX_SERVERS` and `CAPABILITY_ROUTER_MAX_TOOLS`, cap context
cost without disabling capabilities globally.

The same package serves a dark control center on port `8768`, including MCP
switches/import, Skill Store, task routing, and a workspace-scoped file manager.
OmniRoute remains a separate, migratable provider-router component because it
already has a stable container boundary and persistent `/app/data` volume.

Each adapted target also contains `portable-services.compose.yml`. After
running `install-capabilities.mjs`, start it from the target directory to expose
the router UI/MCP endpoint on `127.0.0.1:19868` and OmniRoute on
`127.0.0.1:20128`:

```bash
docker compose -f portable-services.compose.yml up -d --build
```

The generated target-native MCP config connects only to `capability-router` in
the default `routed` mode. The complete downstream registry remains in
`capability-router/mcp.json`, so enabling a new server does not enlarge an
agent's prompt until routing selects it. Skills keep their own `SKILL.md` and
references; components keep their package manifests and persistent state paths.

## Local Qwen-MM after migration

The `qwen-mm-local` component is exported with its pinned upstream revision,
portable MCP declarations, launcher, and `qwen-mm-local` skill. It never
exports model weights or provider credentials. On the target machine, install
Ollama and run:

```bash
ollama pull qwen3-vl:2b-instruct
export QWEN_MM_BASE_URL=http://127.0.0.1:11434/v1
node ./scripts/qwen-mm-launcher.cjs api --check-system
```

For Docker targets, `portable-services.compose.yml` uses the internal Ollama
address and boots the model into a persistent volume. The standard MCP tool
surface remains `qwen-mm-core` for local media operations and `qwen-mm-local`
for vision chat, OCR, and grounding. No DashScope key is required: visual
evidence is returned as text to the coordinating agent, preserving compatibility
with text-only providers such as DeepSeek.
