# Portable Capability Router

Agent-neutral capability fabric exposed as one compact MCP server. It lazily
connects downstream MCP servers, selects only task-relevant tool schemas, hosts
self-contained Agent Skills, and exposes a workspace-scoped file manager.

It has no dependency on NOVA or OpenClaude. Any MCP client can use either:

```json
{
  "mcpServers": {
    "capability-router": {
      "command": "node",
      "args": ["/absolute/path/capability-router/src/mcp.mjs"],
      "env": {
        "CAPABILITY_ROUTER_WORKSPACE_ROOT": "/workspace",
        "CAPABILITY_ROUTER_MCP_CONFIG": "/workspace/.mcp.json",
        "CAPABILITY_ROUTER_REGISTRY": "/workspace/capability-registry.json"
      }
    }
  }
}
```

or the Streamable HTTP endpoint at `http://127.0.0.1:8768/mcp`.

## Token-efficient flow

1. The client sees five stable tools instead of every downstream schema.
2. Call `capability_route` with the complete task.
3. The router chooses a bounded server set, connects it lazily, and returns only
   relevant tool schemas and skill summaries.
4. Call one selected tool through `capability_call`; read a selected skill
   through `skill_store` only when needed.

Set `CAPABILITY_ROUTER_LLM_BASE_URL`, `CAPABILITY_ROUTER_LLM_MODEL`, and
optionally `CAPABILITY_ROUTER_LLM_API_KEY` to use an OpenAI-compatible semantic
selector. Without them, routing uses a deterministic metadata scorer. OmniRoute
can be used as the selector endpoint.

## Standalone web control center

```bash
npm install
npm start
```

The dark web interface manages MCP servers, skills, routing, uploads, and
downloads. Loopback binding needs no key. A non-loopback bind is rejected unless
`CAPABILITY_ROUTER_API_KEY` is set.

The package is deliberately self-contained: its registry, MCP JSON, skill
directories, state file, and workspace root are all explicit environment
inputs. A migration bundle can therefore copy this directory into Hermes,
OpenCode, OpenClaw, Codex, or any other MCP host without importing NOVA runtime
code. Use `capability_registry import` for additional standard `mcpServers`
JSON; secrets must be environment references rather than literal values.
