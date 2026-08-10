import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_CODEX_BASE_URL,
  resolveRuntimeCodexCredentials,
  type ReasoningEffort,
} from '../api/providerConfig.js'
import { refreshCodexAccessTokenIfNeeded } from '../../utils/codexCredentials.js'

export type ProviderModelProfile = {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
}

export type ProviderModelOption = {
  id: string
  label: string
  defaultReasoning?: ReasoningEffort
  reasoningLevels: ReasoningEffort[]
  contextWindow?: number
}

export type ProviderModelCatalog = {
  models: ProviderModelOption[]
  source: 'live' | 'cache' | 'built-in'
  warning?: string
}

type CodexModelRecord = {
  slug?: string
  display_name?: string
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{ effort?: string }>
  context_window?: number
  visibility?: string
  priority?: number
}

const CODEX_CLIENT_VERSION = '0.144.0'
const ALL_STANDARD_REASONING: ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]
const REASONING_PRIORITY: ReasoningEffort[] = [
  'ultra',
  'max',
  'xhigh',
  'high',
  'medium',
  'low',
]

const BUILT_IN_CODEX_MODELS: ProviderModelOption[] = [
  codexModel('gpt-5.6-sol', 'GPT-5.6 Sol', [...ALL_STANDARD_REASONING, 'max', 'ultra'], 372_000),
  codexModel('gpt-5.6-terra', 'GPT-5.6 Terra', [...ALL_STANDARD_REASONING, 'max', 'ultra'], 372_000),
  codexModel('gpt-5.6-luna', 'GPT-5.6 Luna', [...ALL_STANDARD_REASONING, 'max'], 372_000),
  codexModel('gpt-5.5', 'GPT-5.5', ALL_STANDARD_REASONING, 272_000),
  codexModel('gpt-5.4', 'GPT-5.4', ALL_STANDARD_REASONING, 272_000),
  codexModel('gpt-5.4-mini', 'GPT-5.4 Mini', ALL_STANDARD_REASONING, 272_000),
  { ...basicModel('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'), contextWindow: 128_000 },
]

const DEEPSEEK_MODELS: ProviderModelOption[] = [
  basicModel('deepseek-v4-flash', 'DeepSeek V4 Flash'),
  basicModel('deepseek-v4-pro', 'DeepSeek V4 Pro'),
]

const OPENCODE_ZEN_MODELS: ProviderModelOption[] = [
  basicModel('deepseek-v4-flash-free', 'DeepSeek V4 Flash Free'),
  basicModel('deepseek-v4-flash', 'DeepSeek V4 Flash'),
  basicModel('deepseek-v4-pro', 'DeepSeek V4 Pro'),
]

const OPENROUTER_MODELS: ProviderModelOption[] = [
  basicModel('openai/gpt-5.6-sol', 'GPT-5.6 Sol'),
  basicModel('openai/gpt-5.6-sol-pro', 'GPT-5.6 Sol Pro'),
  basicModel('openai/gpt-5.6-terra', 'GPT-5.6 Terra'),
  basicModel('openai/gpt-5.6-terra-pro', 'GPT-5.6 Terra Pro'),
  basicModel('openai/gpt-5.6-luna', 'GPT-5.6 Luna'),
  basicModel('openai/gpt-5.6-luna-pro', 'GPT-5.6 Luna Pro'),
  basicModel('openai/gpt-5.5', 'GPT-5.5'),
  basicModel('openai/gpt-5.5-pro', 'GPT-5.5 Pro'),
]

const OMNIROUTE_MODELS: ProviderModelOption[] = [
  basicModel('auto', 'Auto'),
  basicModel('auto/coding', 'Auto Coding'),
  basicModel('auto/fast', 'Auto Fast'),
  basicModel('auto/cheap', 'Auto Cheap'),
  basicModel('auto/smart', 'Auto Smart'),
  basicModel('auto/offline', 'Auto Offline'),
]

const LM_STUDIO_MODELS: ProviderModelOption[] = [
  basicModel('gemma-4-12b-obliterated', 'Gemma 4 12B'),
  basicModel(
    'huihui-gemma-4-12b-coder-fable5-composer2.5-v1-abliterated',
    'Gemma 4 Coder',
  ),
]

function basicModel(id: string, label = id): ProviderModelOption {
  return { id, label, reasoningLevels: [] }
}

function codexModel(
  id: string,
  label: string,
  reasoningLevels: ReasoningEffort[],
  contextWindow?: number,
): ProviderModelOption {
  return {
    id,
    label,
    defaultReasoning: getMaximumSupportedReasoning(reasoningLevels),
    reasoningLevels,
    contextWindow,
  }
}

export function getMaximumSupportedReasoning(
  levels: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  return REASONING_PRIORITY.find(level => levels.includes(level))
}

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
    ? value
    : undefined
}

export function parseCodexModelRecords(records: CodexModelRecord[]): ProviderModelOption[] {
  return records
    .filter(record => record.slug && record.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map(record => {
      const levels = (record.supported_reasoning_levels ?? [])
        .map(level => parseReasoningEffort(level.effort))
        .filter((level): level is ReasoningEffort => Boolean(level))
      const reasoningLevels = [...new Set(levels)]
      return {
        id: record.slug!,
        label: record.display_name || record.slug!,
        defaultReasoning:
          getMaximumSupportedReasoning(reasoningLevels)
          ?? parseReasoningEffort(record.default_reasoning_level),
        reasoningLevels,
        contextWindow:
          typeof record.context_window === 'number'
            ? record.context_window
            : undefined,
      }
    })
}

export function getBuiltInProviderModels(provider: string): ProviderModelOption[] {
  if (provider === 'codex') return BUILT_IN_CODEX_MODELS.map(model => ({ ...model }))
  if (provider === 'deepseek') return DEEPSEEK_MODELS.map(model => ({ ...model }))
  if (provider === 'opencode-zen') return OPENCODE_ZEN_MODELS.map(model => ({ ...model }))
  if (provider === 'openrouter') return OPENROUTER_MODELS.map(model => ({ ...model }))
  if (provider === 'omniroute') return OMNIROUTE_MODELS.map(model => ({ ...model }))
  if (provider === 'lmstudio' || provider === 'lmstudio-lan') {
    return LM_STUDIO_MODELS.map(model => ({ ...model }))
  }
  return []
}

export function getDefaultProviderModel(provider: string): ProviderModelOption | undefined {
  return getBuiltInProviderModels(provider)[0]
}

export function getModelBaseId(model: string): string {
  return model.trim().split('?', 1)[0] || model.trim()
}

export function withModelReasoning(model: string, effort: ReasoningEffort): string {
  const [base, query = ''] = model.trim().split('?', 2)
  const params = new URLSearchParams(query)
  params.set('reasoning', effort)
  return `${base}?${params.toString()}`
}

export async function loadProviderModelCatalog(
  profile: ProviderModelProfile,
): Promise<ProviderModelCatalog> {
  if (profile.provider === 'codex') return loadCodexModelCatalog()

  const fallback = getBuiltInProviderModels(profile.provider)
  try {
    const liveModels = await fetchOpenAICompatibleModels(profile)
    if (liveModels.length === 0) throw new Error('provider returned no models')
    const models = mergeProviderModels(fallback, liveModels)
    return { models, source: 'live' }
  } catch (error) {
    return {
      models: fallback,
      source: 'built-in',
      warning: safeError(error),
    }
  }
}

function mergeProviderModels(
  preferred: ProviderModelOption[],
  live: ProviderModelOption[],
): ProviderModelOption[] {
  const seen = new Set<string>()
  return [...preferred, ...live].filter(model => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

async function loadCodexModelCatalog(): Promise<ProviderModelCatalog> {
  let liveError = ''
  try {
    const refreshed = await refreshCodexAccessTokenIfNeeded()
    const credentials = resolveRuntimeCodexCredentials({
      storedCredentials: refreshed.credentials,
    })
    if (!credentials.apiKey) throw new Error('Codex subscription auth is not configured')

    const response = await fetch(
      `${DEFAULT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          originator: 'openclaude',
          ...(credentials.accountId
            ? { 'chatgpt-account-id': credentials.accountId }
            : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    const body = await response.text()
    if (!response.ok) throw new Error(`Codex models request failed (${response.status})`)
    const payload = JSON.parse(body) as { models?: CodexModelRecord[] }
    const models = parseCodexModelRecords(payload.models ?? [])
    if (models.length === 0) throw new Error('Codex returned no selectable models')
    return { models, source: 'live' }
  } catch (error) {
    liveError = safeError(error)
  }

  try {
    const cachePath = getCodexModelsCachePath()
    if (!cachePath) throw new Error('Codex models cache path is not configured')
    const payload = JSON.parse(await readFile(cachePath, 'utf8')) as {
      models?: CodexModelRecord[]
    }
    const models = parseCodexModelRecords(payload.models ?? [])
    if (models.length === 0) throw new Error('Codex models cache is empty')
    return { models, source: 'cache', warning: liveError }
  } catch (cacheError) {
    return {
      models: getBuiltInProviderModels('codex'),
      source: 'built-in',
      warning: [liveError, safeError(cacheError)].filter(Boolean).join('; '),
    }
  }
}

function getCodexModelsCachePath(): string | undefined {
  if (process.env.CODEX_MODELS_CACHE_PATH?.trim()) {
    return process.env.CODEX_MODELS_CACHE_PATH.trim()
  }
  if (process.env.CODEX_HOME?.trim()) {
    return join(process.env.CODEX_HOME.trim(), 'models_cache.json')
  }
  return undefined
}

async function fetchOpenAICompatibleModels(
  profile: ProviderModelProfile,
): Promise<ProviderModelOption[]> {
  const errors: string[] = []
  for (const url of providerModelUrls(profile.baseUrl)) {
    try {
      const response = await fetch(url, {
        headers: profile.apiKey
          ? { Authorization: `Bearer ${profile.apiKey}` }
          : {},
        signal: AbortSignal.timeout(10_000),
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`${response.status}: ${body.slice(0, 160)}`)
      const payload = JSON.parse(body) as { data?: Array<{ id?: string }> }
      return (payload.data ?? [])
        .map(item => item.id?.trim())
        .filter((id): id is string => Boolean(id))
        .sort()
        .map(id => basicModel(id))
    } catch (error) {
      errors.push(`${url}: ${safeError(error)}`)
    }
  }
  throw new Error(errors.join('; ') || 'provider base URL is not configured')
}

function providerModelUrls(baseUrl: string): string[] {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '')
  if (!trimmed) return []
  return trimmed.endsWith('/v1')
    ? [`${trimmed}/models`, `${trimmed.replace(/\/v1$/, '')}/models`]
    : [`${trimmed}/v1/models`, `${trimmed}/models`]
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
