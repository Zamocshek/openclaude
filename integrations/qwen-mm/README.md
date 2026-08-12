# Qwen-MM local capability

This integration packages the official Qwen-MM tool layer as two portable MCP
servers:

- `qwen-mm-core`: local media inspection, frame extraction, visualization,
  cropping, bounding boxes, and artifact views.
- `qwen-mm-local`: `vision_chat`, OCR, and grounding backed only by the local
  Ollama `qwen3-vl:2b-instruct` model.

The upstream source is pinned in `manifest.json`. The facade removes endpoint,
credential, and model arguments from the model-facing tool schemas and always
injects the configured local endpoint. It therefore cannot silently fall back
to DashScope.

## Runtime

Docker uses `http://openclaude-ollama:11434/v1`. Native installations use
`http://127.0.0.1:11434/v1`. Override either with `QWEN_MM_BASE_URL`.

```bash
ollama pull qwen3-vl:2b-instruct
node scripts/qwen-mm-launcher.cjs api
node scripts/qwen-mm-launcher.cjs core
```

The launchers use a preinstalled pinned tool environment in the production
image and fall back to `uv` on other hosts. No Qwen or DashScope API key is
required.

## Portability

`agent-portability.json` includes this complete directory, its skill, launcher,
MCP definitions, and manifest. Migration exports preserve environment
references but never model weights or credentials. The target host needs
Ollama, `uv`, `ffmpeg`, and the declared model.
