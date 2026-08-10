# Nova Capability Routing

Nova uses a request-scoped capability index before an agent run. The index is
deliberately short: it tells the model which Skill and MCP surface owns the
current task, while the normal Skill and MCP tools remain the source of truth
for complete schemas and safety contracts.

## Base Map

| Request class | Skill or built-in surface | MCP surface |
| --- | --- | --- |
| Code changes, review, tests | `code`, `TodoWrite`, `Agent` for substantial work | `codegraph`, `context7` |
| Current research | built-in web tools | `searxng` |
| Browser work, screenshots, browser models | `qwen-collab` when requested | `camofox` |
| Durable memory | Telegram `[MEMORY]` protocol when applicable | `hindsight` |
| Document-grounded answers | normal file tools | `openrag` |
| Telegram, Maton, VPromotions, TwiBoost | `telegram-mcp-operations`, `maton-api-gateway`, `vpromotions`, `twiboost` | `telegram-mcp` |
| MCP, provider, skill, or runtime control | gateway control tools | `mcp-router`, `gateway-control` |
| Android devices | `android-device` | pinned `android-<alias>` MCP server |
| Authorized security assessment | `pentest` | `pentest`, optionally `codegraph` |

Open WebUI, the file manager, OmniRoute, and the gateway API are control-plane
surfaces. They are not treated as ordinary task MCP servers; the model uses
their exposed gateway controls or provider configuration when the request
actually targets them.

## Context Rules

- Full skill text is loaded only when the selected Skill is invoked.
- MCP configuration is task-scoped when automatic routing is enabled. An
  explicit all-tools request remains available as an escape hatch.
- The context window follows the selected model's declared window. Durable
  memory storage is not capped by the conversation turn limit; only the
  materialized prompt is budgeted so the provider can accept it.
- Conversation history, Telegram reply context, and durable memory are kept as
  separate layers. A new chat context does not delete durable memory.
- Tool schemas and successful results are authoritative. Nova must not invent a
  tool name, repeat an identical failed call, or claim a write before evidence
  confirms it.

## Multi-step Tool Interactions

Multi-step tools do not rely on phrases in the next user message. A tool can
return a bounded `openclaude.interaction/v1` envelope containing a handler id,
stage, expected input schema, non-secret state, source tool, and expiration.
The gateway then owns that interaction until it completes, expires, or the
user starts a new chat.

The protocol has three layers:

1. The runner extracts and validates the envelope from a successful tool
   result. Legacy recognition remains only as a compatibility fallback.
2. A transport-scoped registry preserves the pending workflow and supplies its
   semantic context to the router and main agent. It does not persist secret
   values.
3. A trusted adapter resumes protected operations directly. OTPs, passwords,
   tokens, and other protected input are never sent to a model when no adapter
   is installed. Non-secret, open-ended continuations can be resolved by the
   semantic agent with the original handler and source-tool context.

New multi-step MCP integrations should emit the envelope and register an
adapter when they accept protected input or perform a privileged continuation.
This avoids adding provider-specific keyword branches to Telegram, OpenWebUI,
or another client transport.

## Extending The Map

When adding a new MCP-backed feature:

1. Add its server aliases and route in
   `src/services/agentGateway/capabilityRouting.ts`.
2. Add one compact catalog entry with real tool names and a short summary.
3. Register or update the corresponding Skill with aliases and `whenToUse`.
4. Add routing and prompt-builder tests before enabling the server in the base
   `.mcp.json`.

Do not paste complete provider or MCP reference documents into the gateway
system prompt. Keep detailed contracts in the Skill/reference files and load
them on demand.
