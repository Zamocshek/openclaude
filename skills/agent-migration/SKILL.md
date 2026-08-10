---
name: agent-migration
description: Export, verify, and migrate NOVA or another OpenClaude agent's identity, memory, conversations, skills, MCP servers, provider routes, automations, tools, and workspace into OpenClaude, Hermes, OpenCode, OpenClaw, or Codex without copying credentials or editing source state.
compatibility: openclaude hermes opencode openclaw codex
metadata:
  category: agent-operations
  schema: openclaude.agent-bundle/v1
---

# Agent migration

Use the repository-owned `openclaude-migrate` CLI. Do not improvise migrations
by copying a target runtime's private SQLite database.

## Workflow

1. Inspect `agent-portability.json` and the requested source/target paths.
2. Export with `--history full` unless the user explicitly asks for a smaller
   bundle.
3. Run `verify` and stop on any checksum, unsafe-path, or schema failure.
4. Run `adapt` for the target runtime into a new directory.
5. Fill target credentials from its secret manager or interactive auth flow.
   Never put credential values into the bundle.
6. Run the target's native parser or doctor. For OpenCode, also execute its
   native `opencode import` against the generated session JSON.
7. Report the bundle id, message/session/skill/MCP counts, redaction count, and
   any target surface that could only be archived rather than activated.

## Commands

```bash
openclaude-migrate export --workspace . --history full --output nova.agent-bundle
openclaude-migrate verify --bundle nova.agent-bundle
openclaude-migrate adapt --bundle nova.agent-bundle --target hermes --output nova-hermes
```

Targets: `openclaude`, `hermes`, `opencode`, `openclaw`, `codex`.

## Invariants

- Source memory, history, personality, and workspace files are read-only.
- The canonical bundle is the source of truth; target summaries are views.
- Raw source history is retained in redacted form beside canonical JSONL.
- Skills stay in Agent Skills `SKILL.md` format.
- MCP is normalized before rendering target-native config.
- Provider routes migrate; credentials and OAuth sessions do not.
- Existing target files are not overwritten without explicit `--force`;
  forced replacement is atomic and restores the old target if materialization
  fails.
