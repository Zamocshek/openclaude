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

The dark web interface manages MCP servers, every discovered downstream tool,
skills, routing, uploads, and downloads. `Probe all` refreshes live `tools/list`
inventories with bounded concurrency and reports `unprobed`, `blocked`, `ready`,
or `failed` per server. The number in the server header is the MCP server count;
the separate tool count is the complete administrative catalog. Live, cached,
and declaration-only counts are shown separately, so a stale schema is never
presented as a successful probe. Individual tool switches are transactionally
merged across the web and stdio router processes without exposing the full
catalog to the model prompt. Loopback reads need no key; state-changing web API
calls require the console's same-site session. A non-loopback bind is rejected
unless `CAPABILITY_ROUTER_API_KEY` is set. Live discovery is a protected
`POST /api/probe`; `GET /api/catalog` is passive and never starts MCP servers.

Docker and reverse-proxy deployments can keep that API key while enabling
`CAPABILITY_ROUTER_AUTO_SESSION=1`. Opening the UI through literal `localhost`,
`127.0.0.1`, or `::1` then issues a short-lived `HttpOnly`, `SameSite=Strict`
browser cookie. This session is enabled automatically for the default loopback,
no-key launch. Public hostnames and the `/mcp` endpoint still require the Bearer
key. Configure the lifetime with `CAPABILITY_ROUTER_SESSION_TTL_MS`.

Environment references use `${NAME}` for required values and `${NAME:-}` for
optional credentials. Missing required values fail before a server starts;
optional values stay compatible with public or local no-key modes.

The package is deliberately self-contained: its registry, MCP JSON, skill
directories, state file, and workspace root are all explicit environment
inputs. A migration bundle can therefore copy this directory into Hermes,
OpenCode, OpenClaw, Codex, or any other MCP host without importing NOVA runtime
code. Use `capability_registry import` for additional standard `mcpServers`
JSON; secrets must be environment references rather than literal values.
`capability_registry catalog` provides the same complete inventory through MCP,
while `capability_route` remains the bounded task-facing path. The state file
contains custom servers, server/skill/tool switches, and cached tool schemas, so
copying it preserves operator choices across agent runtimes.
