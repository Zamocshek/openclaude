#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const configPath = process.env.OPENCLAUDE_AGENT_GATEWAY_CONFIG_PATH
const stateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR || '/tmp/openclaude-agent-gateway'
const roleNames = new Set([
  'gateway-explore',
  'gateway-plan',
  'gateway-implement',
  'gateway-review',
])
const providerDefaults = {
  codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', apiKeyEnv: 'CODEX_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  'lmstudio-lan': { baseUrl: 'http://192.168.187.1:1234/v1' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1' },
  ollama: { baseUrl: 'http://localhost:11434/v1' },
}
const defaultRoutes = {
  'gateway-explore': {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  'gateway-plan': {
    provider: 'codex',
    model: 'gpt-5.6-sol?reasoning=xhigh',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKeyEnv: 'CODEX_API_KEY',
  },
  'gateway-implement': {
    provider: 'codex',
    model: 'gpt-5.6-sol?reasoning=xhigh',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKeyEnv: 'CODEX_API_KEY',
  },
  'gateway-review': {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
}

const server = new Server(
  { name: 'openclaude-gateway-control', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_subagent_routing',
      description: 'Read the enabled state, concurrency limit, and provider/model routes for Gateway subagents. API keys are never returned.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'configure_subagent_route',
      description: 'Persist the provider/model route used by one Gateway subagent role. Use this when the user asks to assign a particular model/provider to planning, implementation, research, or review.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'gateway-explore, gateway-plan, gateway-implement, or gateway-review' },
          provider: { type: 'string', description: 'Provider identifier, for example codex, deepseek, openrouter, lmstudio-lan' },
          model: { type: 'string', description: 'Exact model id, optionally with ?reasoning=level for Codex' },
          base_url: { type: 'string', description: 'Required only for a provider without a known OpenAI-compatible endpoint' },
          api_key_env: { type: 'string', description: 'Optional existing environment variable containing the provider credential. Never pass literal API keys.' },
          enabled: { type: 'boolean', description: 'Optionally enable or disable all subagent delegation after saving the route' },
        },
        required: ['role', 'provider', 'model'],
        additionalProperties: false,
      },
    },
    {
      name: 'set_subagent_parallelism',
      description: 'Set the maximum number of independent read-only subagents that may run in parallel. Use 1 through 8. Writer tasks remain serialized.',
      inputSchema: {
        type: 'object',
        properties: { max_parallel: { type: 'integer', minimum: 1, maximum: 8 } },
        required: ['max_parallel'],
        additionalProperties: false,
      },
    },
    {
      name: 'set_subagents_enabled',
      description: 'Enable or disable Gateway subagent delegation without deleting routes.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const result = handleToolCall(params.name, params.arguments || {})
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    }
  }
})

function handleToolCall(name, args) {
  if (name === 'get_subagent_routing') return redactRouting(loadConfig().subagents)
  if (name === 'configure_subagent_route') return configureRoute(args)
  if (name === 'set_subagent_parallelism') return setParallelism(args)
  if (name === 'set_subagents_enabled') return setEnabled(args)
  throw new Error(`Unknown gateway-control tool: ${name}`)
}

function configureRoute(args) {
  const role = String(args.role || '').trim()
  const provider = String(args.provider || '').trim().toLowerCase()
  const model = String(args.model || '').trim()
  if (!roleNames.has(role)) throw new Error(`Unsupported subagent role: ${role}`)
  if (!provider || !model) throw new Error('provider and model are required')
  const config = loadConfig()
  const current = config.subagents.routes[role] || {}
  const defaults = providerDefaults[provider] || {}
  const baseUrl = String(args.base_url || (current.provider === provider ? current.baseUrl : '') || defaults.baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  if (!baseUrl) throw new Error(`base_url is required for provider ${provider}`)
  const apiKeyEnv = String(args.api_key_env || (current.provider === provider ? current.apiKeyEnv || '' : '') || defaults.apiKeyEnv || '').trim()
  config.subagents.routes[role] = {
    provider,
    model,
    baseUrl,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  }
  if (typeof args.enabled === 'boolean') config.subagents.enabled = args.enabled
  saveConfig(config)
  return redactRouting(config.subagents)
}

function setParallelism(args) {
  const maxParallel = Number(args.max_parallel)
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) {
    throw new Error('max_parallel must be an integer from 1 to 8')
  }
  const config = loadConfig()
  config.subagents.maxParallel = maxParallel
  saveConfig(config)
  return redactRouting(config.subagents)
}

function setEnabled(args) {
  if (typeof args.enabled !== 'boolean') throw new Error('enabled must be boolean')
  const config = loadConfig()
  config.subagents.enabled = args.enabled
  saveConfig(config)
  return redactRouting(config.subagents)
}

function loadConfig() {
  if (!configPath) throw new Error('Gateway control is missing OPENCLAUDE_AGENT_GATEWAY_CONFIG_PATH')
  let config = {}
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    // Saving a minimal config is safe: the Gateway normalizer fills all omitted defaults.
  }
  const hasRoutes = Boolean(
    config.subagents && Object.prototype.hasOwnProperty.call(config.subagents, 'routes'),
  )
  config.subagents ||= {}
  config.subagents.enabled ??= true
  config.subagents.maxParallel ??= 3
  if (!hasRoutes) config.subagents.routes = structuredClone(defaultRoutes)
  else config.subagents.routes ||= {}
  return config
}

function saveConfig(config) {
  if (!configPath) throw new Error('Gateway control is missing a config path')
  mkdirSync(dirname(configPath), { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const tempPath = join(dirname(configPath), `.agent-gateway.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tempPath, configPath)
  } finally {
    try { unlinkSync(tempPath) } catch {}
  }
}

function redactRouting(subagents) {
  const routes = Object.entries(subagents.routes || {}).map(([role, route]) => ({
    role,
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
    apiKeyConfigured: Boolean(route.apiKey || (route.apiKeyEnv && process.env[route.apiKeyEnv])),
    ...(route.apiKeyEnv ? { apiKeyEnv: route.apiKeyEnv } : {}),
  }))
  return { enabled: subagents.enabled !== false, maxParallel: subagents.maxParallel || 3, routes }
}

await server.connect(new StdioServerTransport())
