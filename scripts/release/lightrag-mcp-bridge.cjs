#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { basename, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

function runtimeRequire() {
  return existsSync('/app/package.json') ? createRequire('/app/package.json') : require
}

async function importRuntimeModule(specifier) {
  return import(pathToFileURL(runtimeRequire().resolve(specifier)).href)
}

function hydrateEnvFromDotEnv() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const match = rawLine.match(/^([A-Z0-9_]+)=(.*)$/u)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] && process.env[key] !== `\${${key}}`) continue
    process.env[key] = rawValue.trim().replace(/^"(.*)"$/u, '$1')
  }
}

function lightRAGConfig() {
  const timeoutSeconds = finiteNumber(process.env.LIGHTRAG_MCP_TIMEOUT, 180, 1, 3600)
  const maxRetries = finiteNumber(process.env.LIGHTRAG_MCP_MAX_RETRIES, 2, 0, 5)
  return {
    baseUrl: (process.env.LIGHTRAG_URL || 'http://localhost:9621').replace(/\/+$/u, ''),
    apiKey: String(process.env.LIGHTRAG_API_KEY || '').trim(),
    timeoutMs: timeoutSeconds * 1000,
    maxRetries,
  }
}

function finiteNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function baseUrlCandidates(baseUrl) {
  const candidates = [baseUrl]
  try {
    const parsed = new URL(baseUrl)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'host.docker.internal'
      candidates.push(parsed.toString().replace(/\/+$/u, ''))
    }
  } catch {
    // fetch() will report a useful validation error for the original value.
  }
  return [...new Set(candidates)]
}

function compactError(error) {
  const value = String(error?.message || error || 'unknown error').replace(/\s+/gu, ' ').trim()
  return value.length > 320 ? `${value.slice(0, 317)}...` : value
}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504
}

async function sleep(ms) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function lightRAGRequest(path, options = {}) {
  const { baseUrl, apiKey, timeoutMs, maxRetries } = lightRAGConfig()
  const retryable = options.retryable !== false
  const fetchOptions = { ...options }
  delete fetchOptions.retryable
  const attempts = retryable ? maxRetries + 1 : 1
  let lastError

  for (const candidate of baseUrlCandidates(baseUrl)) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${candidate}${path}`, {
          ...fetchOptions,
          headers: {
            ...(apiKey ? { 'X-API-Key': apiKey } : {}),
            ...(fetchOptions.headers || {}),
          },
          signal: controller.signal,
        })
        const body = await response.text()
        let data
        try {
          data = body ? JSON.parse(body) : null
        } catch {
          data = body
        }
        if (!response.ok) {
          const detail = data?.detail || data?.error || data?.message || body || response.statusText
          const error = new Error(`LightRAG ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
          error.status = response.status
          throw error
        }
        return data
      } catch (error) {
        lastError = error
        const canRetry = retryable && attempt + 1 < attempts && (!error.status || isTransientStatus(error.status))
        if (!canRetry) break
        await sleep(Math.min(4000, 400 * (2 ** attempt)))
      } finally {
        clearTimeout(timer)
      }
    }
  }
  throw lastError
}

function jsonRequest(value, retryable = true) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    retryable,
  }
}

function queryPayload(arguments_, onlyNeedContext) {
  const query = String(arguments_?.query || arguments_?.message || '').trim()
  if (query.length < 3) throw new Error('query must contain at least 3 characters')
  return {
    query,
    mode: arguments_?.mode || 'mix',
    only_need_context: onlyNeedContext,
    top_k: arguments_?.top_k || arguments_?.topK || undefined,
    chunk_top_k: arguments_?.chunk_top_k || arguments_?.chunkTopK || undefined,
    response_type: arguments_?.response_type || arguments_?.responseType || undefined,
    conversation_history: arguments_?.conversation_history || undefined,
    include_references: true,
    include_chunk_content: arguments_?.include_chunk_content ?? true,
    enable_rerank: arguments_?.enable_rerank,
  }
}

function formatQueryResponse(data, heading) {
  const response = String(data?.response || '').trim()
  const references = Array.isArray(data?.references) ? data.references : []
  const referenceLines = references.map((reference, index) => {
    const path = reference.file_path || reference.reference_id || `source-${index + 1}`
    const content = Array.isArray(reference.content)
      ? reference.content.filter(Boolean).join('\n')
      : ''
    return `${index + 1}. ${path}${content ? `\n${content}` : ''}`
  })
  return [
    heading,
    response || '(LightRAG returned no textual content.)',
    referenceLines.length > 0 ? `\nReferences:\n${referenceLines.join('\n\n')}` : '',
  ].filter(Boolean).join('\n')
}

async function search(arguments_) {
  const data = await lightRAGRequest('/query', jsonRequest(queryPayload(arguments_, true)))
  return formatQueryResponse(data, 'LightRAG grounded context:')
}

async function chat(arguments_) {
  const data = await lightRAGRequest('/query', jsonRequest(queryPayload(arguments_, false)))
  return formatQueryResponse(data, 'LightRAG answer:')
}

function generatedSource(text) {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return `mcp-text-${digest}.txt`
}

async function ingestText(arguments_) {
  const text = String(arguments_?.text || '').trim()
  if (!text) throw new Error('text is required')
  const fileSource = String(arguments_?.file_source || arguments_?.source || generatedSource(text)).trim()
  const data = await lightRAGRequest('/documents/text', jsonRequest({
    text,
    file_source: fileSource,
    chunking: arguments_?.chunking || undefined,
  }, false))
  return `Queued ${fileSource} for LightRAG indexing.\nTrack ID: ${data.track_id}\nStatus: ${data.status}`
}

async function ingestFile(arguments_) {
  const filePath = String(arguments_?.file_path || arguments_?.path || '').trim()
  if (!filePath) throw new Error('file_path is required')
  const resolvedPath = resolve(filePath)
  if (!existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`)

  const form = new FormData()
  form.append('file', new Blob([readFileSync(resolvedPath)]), basename(resolvedPath))
  const data = await lightRAGRequest('/documents/upload', {
    method: 'POST',
    body: form,
    retryable: false,
  })
  return `Queued ${basename(resolvedPath)} for LightRAG indexing.\nTrack ID: ${data.track_id}\nStatus: ${data.status}`
}

async function trackStatus(arguments_) {
  const trackId = String(arguments_?.track_id || arguments_?.trackId || '').trim()
  if (!trackId) throw new Error('track_id is required')
  const data = await lightRAGRequest(`/documents/track_status/${encodeURIComponent(trackId)}`)
  return JSON.stringify(data, null, 2)
}

async function listDocuments() {
  const data = await lightRAGRequest('/documents')
  return JSON.stringify(data, null, 2)
}

async function health() {
  const data = await lightRAGRequest('/health')
  return JSON.stringify(data, null, 2)
}

const queryProperties = {
  query: { type: 'string' },
  mode: { type: 'string', enum: ['local', 'global', 'hybrid', 'naive', 'mix'], default: 'mix' },
  top_k: { type: 'integer', minimum: 1 },
  chunk_top_k: { type: 'integer', minimum: 1 },
  include_chunk_content: { type: 'boolean', default: true },
  enable_rerank: { type: 'boolean' },
}

const tools = [
  {
    name: 'lightrag_search',
    description: 'Retrieve grounded context and source chunks from the LightRAG knowledge graph and vector index.',
    inputSchema: { type: 'object', properties: queryProperties, required: ['query'] },
  },
  {
    name: 'lightrag_chat',
    description: 'Ask LightRAG for a grounded answer with references and optional conversation history.',
    inputSchema: {
      type: 'object',
      properties: {
        ...queryProperties,
        conversation_history: {
          type: 'array',
          items: {
            type: 'object',
            properties: { role: { type: 'string' }, content: { type: 'string' } },
            required: ['role', 'content'],
          },
        },
        response_type: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lightrag_ingest_text',
    description: 'Index supplied text in LightRAG. Returns a track ID for asynchronous processing.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        file_source: { type: 'string', description: 'Unique source filename; generated deterministically when omitted.' },
        chunking: { type: 'object' },
      },
      required: ['text'],
    },
  },
  {
    name: 'lightrag_ingest_file',
    description: 'Upload and index a local document in LightRAG. Returns a track ID for asynchronous processing.',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'lightrag_track_status',
    description: 'Inspect asynchronous LightRAG ingestion status by track ID.',
    inputSchema: {
      type: 'object',
      properties: { track_id: { type: 'string' } },
      required: ['track_id'],
    },
  },
  {
    name: 'lightrag_list_documents',
    description: 'List LightRAG documents grouped by processing status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lightrag_health',
    description: 'Check LightRAG liveness and configured runtime state.',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function main() {
  hydrateEnvFromDotEnv()
  const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
    importRuntimeModule('@modelcontextprotocol/sdk/server/index.js'),
    importRuntimeModule('@modelcontextprotocol/sdk/server/stdio.js'),
    importRuntimeModule('@modelcontextprotocol/sdk/types.js'),
  ])
  const { CallToolRequestSchema, ListToolsRequestSchema } = types
  const server = new Server(
    { name: 'openclaude-lightrag', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const name = request.params.name
      const args = request.params.arguments || {}
      let text
      if (name === 'lightrag_search') text = await search(args)
      else if (name === 'lightrag_chat') text = await chat(args)
      else if (name === 'lightrag_ingest_text') text = await ingestText(args)
      else if (name === 'lightrag_ingest_file') text = await ingestFile(args)
      else if (name === 'lightrag_track_status') text = await trackStatus(args)
      else if (name === 'lightrag_list_documents') text = await listDocuments()
      else if (name === 'lightrag_health') text = await health()
      else throw new Error(`Unknown tool: ${name}`)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: compactError(error) }] }
    }
  })
  await server.connect(new StdioServerTransport())
}

main().catch(error => {
  console.error(`[lightrag-mcp-bridge] ${error?.stack || error?.message || error}`)
  process.exit(1)
})
