import type { SettingsJson } from '../../utils/settings/types.js'

/**
 * Provider override resolved from agent routing config.
 * When present, the API client should use these instead of global env vars.
 */
export interface ProviderOverride {
  /** Stable provider profile identifier used for diagnostics and resume. */
  profile: string
  /** Human-readable provider identifier when configured. */
  provider?: string
  /** Model name to send to the API (e.g. "deepseek-chat", "gpt-4o") */
  model: string
  /** OpenAI-compatible base URL */
  baseURL: string
  /** API key for this provider */
  apiKey: string
}

/**
 * Normalize an agent identifier for case-insensitive, hyphen/underscore-agnostic matching.
 */
function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

/** A provider profile owns its model unless the caller names a real override. */
export function hasExplicitAgentModelOverride(
  model: string | undefined,
): model is string {
  return Boolean(model && model !== 'inherit')
}

/**
 * Look up agent.routing by name or subagent_type, then resolve via agent.models.
 *
 * Priority: name > subagentType > "default" > null (use global provider)
 */
export function resolveAgentProvider(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
  explicitProfile?: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderOverride | null {
  if (!settings) return null

  const routing = settings.agentRouting
  const models = settings.agentModels
  if (!models) {
    if (explicitProfile) {
      throw new Error(
        `Agent provider profile "${explicitProfile}" was requested, but agentModels is not configured`,
      )
    }
    return null
  }

  // Build normalized lookup from routing config.
  // Warn on duplicate normalized keys (e.g. "explore-agent" and "explore_agent"
  // both normalize to "exploreagent") to prevent silent shadowing.
  const normalizedRouting = new Map<string, string>()
  for (const [key, value] of Object.entries(routing ?? {})) {
    const nk = normalize(key)
    if (normalizedRouting.has(nk)) {
      console.error(`[agentRouting] Warning: routing key "${key}" collides with an existing key after normalization (both map to "${nk}"). First entry wins.`)
    }
    if (!normalizedRouting.has(nk)) {
      normalizedRouting.set(nk, value)
    }
  }

  // Explicit profile is a first-class launch contract. Otherwise route by
  // teammate name, agent type, then the optional default profile.
  const candidates = [name, subagentType, 'default'].filter(Boolean) as string[]
  let profileId = explicitProfile?.trim() || undefined

  if (!profileId) {
    for (const candidate of candidates) {
      const match = normalizedRouting.get(normalize(candidate))
      if (match) {
        profileId = match
        break
      }
    }
  }

  if (!profileId) return null

  const modelConfig = models[profileId]
  if (!modelConfig) {
    if (explicitProfile) {
      throw new Error(`Agent provider profile "${profileId}" does not exist in agentModels`)
    }
    console.error(
      `[agentRouting] Warning: route references missing provider profile "${profileId}"`,
    )
    return null
  }

  const apiKeyEnv = modelConfig.api_key_env?.trim()
  const apiKey = modelConfig.api_key ?? (apiKeyEnv ? env[apiKeyEnv] : '') ?? ''
  if (explicitProfile && apiKeyEnv && !apiKey) {
    throw new Error(
      `Agent provider profile "${profileId}" requires environment variable ${apiKeyEnv}`,
    )
  }

  return {
    profile: profileId,
    ...(modelConfig.provider ? { provider: modelConfig.provider } : {}),
    model: modelConfig.model?.trim() || profileId,
    baseURL: modelConfig.base_url,
    apiKey,
  }
}
