import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  DEFAULT_CODEX_BASE_URL,
  resolveRuntimeCodexCredentials,
} from '../api/providerConfig.js'
import { getAgentGatewayStateDir, type AgentGatewayConfig, type AgentGatewaySubagentRoute } from './config.js'

export type GatewaySubagentRuntime = {
  settingsPath: string
  agentsJson: string
  roles: Array<{
    name: string
    provider: string
    model: string
  }>
}

export type GatewaySubagentStatus = {
  enabled: boolean
  maxParallel: number
  routes: Array<{
    name: string
    provider: string
    model: string
    baseUrl: string
    apiKeyConfigured: boolean
    apiKeyEnv?: string
  }>
}

type RuntimeRoute = AgentGatewaySubagentRoute & {
  apiKey: string
}

const SETTINGS_FILE = 'subagent-routing.settings.json'

/**
 * Produces an ephemeral OpenClaude settings layer for each gateway child run.
 * Provider credentials remain in the protected gateway state directory rather
 * than appearing in command-line arguments or the Telegram activity feed.
 */
export function prepareGatewaySubagentRuntime(
  config: AgentGatewayConfig,
  env: NodeJS.ProcessEnv,
): GatewaySubagentRuntime | undefined {
  if (!config.subagents.enabled) return undefined

  const routes = Object.entries(config.subagents.routes)
    .map(([name, route]) => [name, resolveRoute(route, env)] as const)
    .filter((entry): entry is readonly [string, RuntimeRoute] => Boolean(entry[1]))

  if (routes.length === 0) return undefined

  const agentModels: Record<string, { base_url: string; api_key: string }> = {}
  const agentRouting: Record<string, string> = {}
  const roles: GatewaySubagentRuntime['roles'] = []

  for (const [name, route] of routes) {
    const existing = agentModels[route.model]
    if (existing && (existing.base_url !== route.baseUrl || existing.api_key !== route.apiKey)) {
      // The upstream agent-routing format keys providers by model ID. Refusing
      // an ambiguous duplicate is safer than silently sending a task to a
      // different API endpoint.
      continue
    }
    agentModels[route.model] = { base_url: route.baseUrl, api_key: route.apiKey }
    agentRouting[name] = route.model
    roles.push({ name, provider: route.provider, model: route.model })
  }

  if (roles.length === 0) return undefined

  const stateDir = getAgentGatewayStateDir()
  const settingsPath = join(stateDir, SETTINGS_FILE)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify({ agentModels, agentRouting }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  if (existsSync(settingsPath)) chmodSync(settingsPath, 0o600)

  return {
    settingsPath,
    agentsJson: JSON.stringify(buildGatewayAgentDefinitions(config, roles)),
    roles,
  }
}

export function buildGatewaySubagentAppendPrompt(
  runtime: GatewaySubagentRuntime | undefined,
  maxParallel: number,
): string | undefined {
  if (!runtime) return undefined
  const roleList = runtime.roles
    .map(role => `- ${role.name}: ${role.provider}/${role.model}`)
    .join('\n')
  return [
    'Gateway multi-agent orchestration is enabled.',
    'For substantial work, first decide whether independent research, planning, implementation, or review can improve the result.',
    'Use the Agent tool with the configured gateway subagent_type roles below. Their provider and model are selected by the gateway, not by the parent model.',
    roleList,
    `Launch at most ${maxParallel} independent read-only delegates in parallel in one tool message. Never run multiple writer/implementation agents against the same files concurrently.`,
    'Use gateway-explore for codebase or evidence discovery, gateway-plan for an implementation plan, gateway-implement for a bounded implementation, and gateway-review for independent verification. Integrate and verify their reports yourself before answering.',
    'Do not delegate trivial requests and do not claim a delegated action occurred unless the Agent tool result confirms it.',
  ].join('\n')
}

export function describeGatewaySubagents(
  config: AgentGatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
): GatewaySubagentStatus {
  return {
    enabled: config.subagents.enabled,
    maxParallel: config.subagents.maxParallel,
    routes: Object.entries(config.subagents.routes).map(([name, route]) => ({
      name,
      provider: route.provider,
      model: route.model,
      baseUrl: route.baseUrl,
      apiKeyConfigured: isRouteCredentialConfigured(route, env),
      ...(route.apiKeyEnv ? { apiKeyEnv: route.apiKeyEnv } : {}),
    })),
  }
}

function isRouteCredentialConfigured(
  route: AgentGatewaySubagentRoute,
  env: NodeJS.ProcessEnv,
): boolean {
  if (route.apiKey || (route.apiKeyEnv && env[route.apiKeyEnv])) return true
  const provider = route.provider.trim().toLowerCase()
  if (provider === 'codex') {
    return Boolean(env.CODEX_API_KEY || env.CODEX_AUTH_JSON_PATH || env.CODEX_HOME)
  }
  return Boolean(defaultProviderApiKeyFromEnvironment(provider, env))
}

function resolveRoute(
  route: AgentGatewaySubagentRoute,
  env: NodeJS.ProcessEnv,
): RuntimeRoute | undefined {
  const provider = route.provider.trim().toLowerCase()
  const baseUrl = (route.baseUrl || (provider === 'codex' ? DEFAULT_CODEX_BASE_URL : ''))
    .trim()
    .replace(/\/+$/, '')
  const model = route.model.trim()
  if (!provider || !baseUrl || !model) return undefined

  const apiKey = route.apiKey ||
    (route.apiKeyEnv ? env[route.apiKeyEnv] : '') ||
    defaultProviderApiKey(provider, env)
  if (!apiKey?.trim()) return undefined

  return { ...route, provider, baseUrl, model, apiKey: apiKey.trim() }
}

function defaultProviderApiKey(provider: string, env: NodeJS.ProcessEnv): string {
  if (provider === 'codex') return resolveRuntimeCodexCredentials({ env }).apiKey
  return defaultProviderApiKeyFromEnvironment(provider, env)
}

function defaultProviderApiKeyFromEnvironment(provider: string, env: NodeJS.ProcessEnv): string {
  if (provider === 'deepseek') {
    return env.DEEPSEEK_API_KEY || env.OPENCLAUDE_DEEPSEEK_API_KEY || env.OPENCLAUDE_API_KEY || ''
  }
  if (provider === 'openrouter') return env.OPENROUTER_API_KEY || env.OPENCLAUDE_API_KEY || ''
  return env.OPENCLAUDE_API_KEY || env.OPENAI_API_KEY || ''
}

function buildGatewayAgentDefinitions(
  config: AgentGatewayConfig,
  roles: GatewaySubagentRuntime['roles'],
): Record<string, { description: string; prompt: string; model: string; maxTurns: number; disallowedTools?: string[] }> {
  return Object.fromEntries(roles.map(role => [
    role.name,
    gatewayAgentDefinition(role.name, config.runner.maxTurns),
  ]))
}

function gatewayAgentDefinition(
  name: string,
  maxTurns: number,
): { description: string; prompt: string; model: string; maxTurns: number; disallowedTools?: string[] } {
  const readOnlyTools = ['Agent', 'Edit', 'Write', 'NotebookEdit']
  if (name === 'gateway-explore') {
    return {
      description: 'Fast read-only project and evidence exploration.',
      prompt: 'You are the Gateway Explore subagent. Investigate the assigned question thoroughly with read-only tools. Report concrete evidence, paths, commands, risks, and open questions. Do not modify files or spawn agents.',
      model: 'inherit',
      maxTurns,
      disallowedTools: readOnlyTools,
    }
  }
  if (name === 'gateway-plan') {
    return {
      description: 'Read-only implementation planning and task decomposition.',
      prompt: 'You are the Gateway Plan subagent. Inspect the relevant project state and produce an actionable, ordered implementation plan. Include affected files, dependencies, verification steps, and concurrency boundaries. Do not modify files or spawn agents.',
      model: 'inherit',
      maxTurns,
      disallowedTools: readOnlyTools,
    }
  }
  if (name === 'gateway-review') {
    return {
      description: 'Independent read-only code and runtime verification.',
      prompt: 'You are the Gateway Review subagent. Independently verify the assigned implementation or claim. Run relevant read-only inspection and tests, identify concrete defects or missing checks, and end with VERDICT: PASS, FAIL, or PARTIAL. Do not modify files or spawn agents.',
      model: 'inherit',
      maxTurns,
      disallowedTools: readOnlyTools,
    }
  }
  return {
    description: 'Bounded implementation task with verification responsibility.',
    prompt: 'You are the Gateway Implement subagent. Execute only the bounded task in the prompt, preserve unrelated changes, use the existing project patterns, and verify your work before reporting. Do not spawn further agents.',
    model: 'inherit',
    maxTurns,
    disallowedTools: ['Agent'],
  }
}
