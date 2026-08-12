# LightRAG integration

NOVA runs the official LightRAG API and WebUI as its document-grounded RAG
service. Hindsight remains the durable user/agent memory layer; LightRAG owns
indexed documents, graph retrieval, and RAG answers.

## Start

```bash
npm run release:lightrag:up
```

Endpoints:

- WebUI: `http://127.0.0.1:9621/webui`
- health: `http://127.0.0.1:9621/health`
- API docs: `http://127.0.0.1:9621/docs`

The Docker service stores graph, vectors, document state, and uploaded inputs
in the named `lightrag-data` volume. Ollama models are pulled by the bootstrap
service. The default local profile uses the non-reasoning
`qwen3-lightrag:1.7b` extraction profile and `nomic-embed-text` (dimension
768). The extraction profile is derived locally from `qwen3:1.7b`; its 8K
indexing context, a non-reasoning native Ollama adapter, dedicated Ollama
runtime, and longer bounded timeout avoid model swapping and repeated load
failures on Docker Desktop. The internal adapter injects `think=false` and a
bounded keep-alive into LightRAG chat calls, while transparently forwarding
embedding and model-management requests. These settings do not limit NOVA's
conversation context or its separate multimodal Ollama runtime.

For the production profile, set `LIGHTRAG_LLM_BINDING=openai`, point
`LIGHTRAG_LLM_BINDING_HOST` at the existing DeepSeek-compatible endpoint, and
select `deepseek-v4-flash`. The compose service reuses `DEEPSEEK_API_KEY`
without copying it into project files. Embeddings remain local in the dedicated
Ollama volume.

## MCP tools

The project `.mcp.json` starts:

```json
{
  "command": "node",
  "args": ["scripts/release/lightrag-mcp-bridge.cjs"]
}
```

The bridge exposes:

- `lightrag_search` and `lightrag_chat` for grounded retrieval;
- `lightrag_ingest_text` and `lightrag_ingest_file` for indexing;
- `lightrag_track_status` and `lightrag_list_documents` for verification;
- `lightrag_health` for readiness diagnostics.

Verify the real MCP bridge against the running service:

```bash
npm run release:lightrag:test
```

Set `LIGHTRAG_SMOKE_QUERY` to include a retrieval call in the smoke test.

`LIGHTRAG_API_KEY` is optional for the loopback-only default deployment. When
set, both the bridge and migration utility send it as `X-API-Key`.

## Migrate OpenRAG data

First create an immutable export while the old OpenSearch container is still
available:

```bash
node scripts/release/migrate-openrag-to-lightrag.mjs --export-only
```

Start LightRAG, then migrate and verify:

```bash
npm run release:lightrag:up
npm run release:lightrag:migrate
```

Each run writes `openrag-export.json`, `lightrag-payload.json`, and
`report.json` under
`.openclaude-data/migrations/openrag-to-lightrag/<timestamp>/`. The utility
reconstructs source documents from OpenSearch chunks, indexes them through the
official LightRAG API, waits for terminal document status, and runs a retrieval
check. Only original document text enters the graph; complete OpenRAG metadata
remains in `lightrag-payload.json` and the immutable source export. The utility
never deletes the old OpenRAG volume.

Embeddings are intentionally regenerated. Do not change the embedding model or
dimension after indexing; create a new LightRAG workspace or re-index all
documents when that contract changes.

## Stop

```bash
npm run release:lightrag:down
```

Stopping containers does not remove `lightrag-data`.
