# NOVA Capability Playbook

This is the portable operating map for NOVA and compatible agent harnesses. It
describes selection and acceptance rules. The live Skill and MCP schemas remain
authoritative for names, arguments, and availability.

## Decision Loop

1. Restate the literal objective, outputs, constraints, and acceptance evidence.
2. Use the Compact Nova capability map or `capability_route` to select the
   smallest useful capability set.
3. Invoke the matching Skill when one exists; it owns workflow knowledge.
4. Prefer typed MCP tools over raw HTTP, shell wrappers, database edits, or
   filesystem discovery of credentials and sessions.
5. Perform mutations once. On an ambiguous result, reconcile state instead of
   repeating the mutation.
6. Accept completion only from the domain verifier, provider receipt, or
   readback. A model statement, local file, pending action, or zero exit code
   from a masked pipeline is not evidence by itself.

## Capability Index

| Outcome | Primary capability | Normal sequence |
|---|---|---|
| Code change | `Skill(code)`, CodeGraph, Context7 | inspect symbols and impact, read versioned docs, edit, test, diff |
| Current research | SearXNG and web reader | discover sources, open primary sources, cross-check dates |
| Browser action | Camofox | list/create tab, snapshot, act by stable refs, final snapshot/screenshot |
| Image/video understanding | Qwen-MM local/core | media metadata, local vision/OCR/grounding, derived artifact verification |
| Durable personal fact | Hindsight | recall, retain/forget only when requested, verify result |
| Document corpus | LightRAG | health, ingest, track, search, cite retrieved evidence |
| Telegram account/content | Telegram MCP Skill | list account, typed workflow, pending action, confirm once, readback |
| GitHub state | official GitHub MCP | inspect repository/PR/issue/action through authenticated tools |
| Tool selection/configuration | Capability Router and MCP Router | registry, route, lazy call, explicit enable/disable/import |
| Authorized security assessment | `Skill(pentest)`, Pentest MCP, CodeGraph | establish scope, collect state/evidence, run scoped checks, report |
| Android device | `Skill(android-device)`, gateway control | resolve alias, health/snapshot, action, verify device state |
| Browser-model collaboration | `Skill(qwen-collab)`, Camofox | reuse persistent profile, submit task, inspect result, verify independently |

## Runtime Addressing

- Tools call MCP servers through their configured transport. Do not infer that a
  service is down because `localhost` failed inside another container.
- Docker service checks use service DNS such as `http://lightrag:9621` and
  `http://telegram-mcp:8766/mcp`.
- Host UI links such as `http://localhost:9621` are for the human browser, not
  for container-to-container calls.
- Use `capability_registry` when a capability is known but its current tool set
  is unclear. Use `capability_call` for lazy portable invocation.

## LightRAG

OpenRAG is retired. Do not write to `~/.openclaude/openrag-documents`, run the
legacy bridge, or report RAG unavailable from a localhost probe.

Required ingestion workflow:

1. `lightrag_health` must report healthy.
2. Use `lightrag_ingest_text` for supplied text or `lightrag_ingest_file` for a
   real workspace document.
3. Preserve the returned track ID.
4. Poll `lightrag_track_status` with bounded waits until terminal success or a
   concrete failure.
5. Query a distinctive fact with `lightrag_search` and inspect returned sources.

Retrieval starts with `lightrag_search`; `lightrag_chat` is for a grounded answer
after retrieval semantics are appropriate. Never invent a source or indexing
status.

## Telegram Content Campaigns

Managed network publishing is a transactional campaign, not a loop of generic
send calls.

1. `list_accounts`; select an ID returned by the live tool.
2. Capture each reused donor message with `content_capture_source_post` so links
   and Telegram entities retain provenance.
3. Call `content_campaign_plan` with the literal target allowlist and literal
   exclusions. The allowlist must be exact. `publishing_enabled=false` cannot be
   overridden.
4. For every target, build `content_channel_post_brief`, produce a unique draft,
   run `content_quality_review`, then `content_create_draft` with source ID.
   Use `standard` depth by default for a network wave; use `short` only when the
   request explicitly asks for it or compression is the editorial objective.
5. Call `content_prepare_publish_batch` once with `campaign_id`. Preflight must
   finish before the first pending action.
6. Confirm each exact action once with `assistant_confirm_action`. Never retry a
   timeout blindly; inspect `assistant_action_status_batch`.
7. Finish with `content_campaign_status`. Complete means every required target
   has a unique draft, expected peer, Telegram message ID, and matching readback.

Do not use raw MCP HTTP, temporary `publish_*.py`, direct `send_message`, or the
legacy local `pipeline.py publish` for a managed campaign. Local SQLite rows are
editorial metadata, not delivery receipts.

## Memory And Knowledge

- Hindsight stores durable facts, preferences, decisions, and explicit forget
  requests.
- LightRAG indexes documents and supports grounded corpus retrieval.
- Workspace Markdown is the human-auditable source of truth when the user asks
  for a file update.
- For a request to "remember and index", update only the requested workspace
  source, retain the durable fact in Hindsight, ingest the document into
  LightRAG, and verify all three independently.

## Recovery Rules

- Schema/validation error: correct arguments from the live schema; do not search
  implementation files for a workaround.
- Transient provider/network error: bounded backoff and resume from durable
  checkpoints; do not repeat completed mutations.
- Permission/path error: verify the runtime path and ownership once. Use the
  typed service API when direct file access is not the service contract.
- Timeout after external mutation: inspect durable action/status and target
  history before any retry.
- Tool unavailable: query Capability Router, then choose a semantically
  equivalent advertised route. State a blocker only after live discovery fails.
- Repeated identical failure: stop the strategy, preserve completed work, and
  select a different route. Activity without new evidence is not progress.

## Portability

Capabilities are represented in `capability-registry.json`, MCP transports in
`.mcp.json`, portable components in `agent-portability.json`, and adapters in
`scripts/agent-migration/`. Export/import those contracts rather than copying a
NOVA-specific process, secret, session ID, or container path into another
harness.
