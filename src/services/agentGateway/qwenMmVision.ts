import { readFile } from 'fs/promises'
import { extname } from 'path'

const DEFAULT_MODEL = 'qwen3-vl:2b-instruct'
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024

type FetchLike = typeof fetch

export type LocalQwenVisionOptions = {
  imagePaths: string[]
  prompt: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

export type OpenAiCompatibleVisionEndpoint = {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
}

export type OpenAiCompatibleVisionOptions = {
  imagePaths: string[]
  prompt: string
  endpoint: OpenAiCompatibleVisionEndpoint
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

function isTruthy(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return !/^(?:0|false|no|off)$/iu.test(value.trim())
}

export function isLocalQwenMmEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthy(env.OPENCLAUDE_QWEN_MM_ENABLED, true)
}

export function resolveLocalQwenMmEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; model: string; apiKey: string; timeoutMs: number } {
  const baseUrl = String(
    env.QWEN_MM_BASE_URL
    || env.OPENCLAUDE_QWEN_MM_BASE_URL
    || 'http://127.0.0.1:11434/v1',
  ).replace(/\/+$/u, '')
  const timeout = Number(env.QWEN_MM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  return {
    baseUrl,
    model: env.QWEN_MM_MODEL || DEFAULT_MODEL,
    apiKey: env.QWEN_MM_API_KEY || 'ollama-local',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }
}

function explicitBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'auto') {
    return undefined
  }
  return isTruthy(value, false)
}

const KNOWN_MULTIMODAL_MODEL_RE = /(?:gpt-(?:4o|5)|gemini|claude-(?:3|4)|deepseek-v4\.1-flash|qwen[^\s/]*(?:vl|vision)|(?:vision|multimodal))/iu

export function resolveActiveProviderVisionEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleVisionEndpoint | undefined {
  const provider = String(env.OPENCLAUDE_PROVIDER || '').trim().toLowerCase()
  const baseUrl = String(env.OPENCLAUDE_BASE_URL || env.OPENAI_BASE_URL || '')
    .trim()
    .replace(/\/+$/u, '')
  const model = String(env.OPENCLAUDE_MODEL || env.OPENAI_MODEL || '').trim()
  if (!provider || !baseUrl || !model || provider === 'codex') return undefined

  const explicit = explicitBoolean(env.OPENCLAUDE_ACTIVE_MODEL_MULTIMODAL)
  const supportsVision = explicit ?? KNOWN_MULTIMODAL_MODEL_RE.test(model)
  if (!supportsVision) return undefined

  const apiKey = String(
    provider === 'deepseek'
      ? env.DEEPSEEK_API_KEY || env.OPENCLAUDE_DEEPSEEK_API_KEY || env.OPENCLAUDE_API_KEY
      : provider === 'openrouter'
        ? env.OPENROUTER_API_KEY || env.OPENCLAUDE_API_KEY
        : provider === 'opencode-zen'
          ? env.OPENCODE_ZEN_API_KEY || env.OPENCLAUDE_API_KEY
          : provider === 'omniroute'
            ? env.OMNIROUTE_API_KEY || env.OPENCLAUDE_API_KEY
            : env.OPENAI_API_KEY || env.OPENCLAUDE_API_KEY || 'local-openai-compatible',
  ).trim()
  if (!apiKey) return undefined
  const timeout = Number(env.OPENCLAUDE_ACTIVE_VISION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  return {
    provider,
    baseUrl,
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    default: return 'image/jpeg'
  }
}

function extractResponseText(body: unknown): string {
  const content = (body as {
    choices?: Array<{ message?: { content?: unknown } }>
  })?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(item => typeof item === 'string'
        ? item
        : typeof item === 'object' && item && 'text' in item
          ? String((item as { text?: unknown }).text || '')
          : '')
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

export async function inspectImagesWithOpenAiCompatibleVision(
  options: OpenAiCompatibleVisionOptions,
): Promise<string> {
  if (options.imagePaths.length === 0) throw new Error('No image paths were provided')
  const endpoint = options.endpoint
  const content: Array<Record<string, unknown>> = []
  let totalBytes = 0

  for (const path of [...new Set(options.imagePaths)]) {
    const image = await readFile(path)
    if (image.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES}-byte vision limit: ${path}`)
    }
    totalBytes += image.byteLength
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(`Images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte vision limit`)
    }
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${mimeType(path)};base64,${image.toString('base64')}`,
      },
    })
  }
  content.push({
    type: 'text',
    text: [
      'Inspect every image using only observable visual evidence.',
      'Report exact visible text when relevant and state uncertainty explicitly.',
      options.prompt.trim() || 'Describe the visual content.',
    ].join('\n'),
  })

  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs)
  try {
    const response = await (options.fetchImpl || fetch)(
      `${endpoint.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          stream: false,
          temperature: 0,
          max_tokens: 4096,
          messages: [{ role: 'user', content }],
        }),
        signal: controller.signal,
      },
    )
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`${endpoint.provider} vision HTTP ${response.status}: ${raw.slice(0, 500)}`)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new Error(`${endpoint.provider} vision returned invalid JSON`)
    }
    const evidence = extractResponseText(body)
    if (!evidence) throw new Error(`${endpoint.provider} vision returned no visual evidence`)
    return evidence
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export async function inspectImagesWithLocalQwen(
  options: LocalQwenVisionOptions,
): Promise<string> {
  return inspectImagesWithOpenAiCompatibleVision({
    imagePaths: options.imagePaths,
    prompt: options.prompt,
    endpoint: {
      provider: 'local qwen-mm',
      ...resolveLocalQwenMmEndpoint(options.env),
    },
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })
}
