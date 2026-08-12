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
  'gateway-vision',
])
const providerDefaults = {
  codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', apiKeyEnv: 'CODEX_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1', apiKeyEnv: 'OPENCODE_ZEN_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  'lmstudio-lan': { baseUrl: 'http://host.docker.internal:1234/v1' },
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
  'gateway-vision': {
    provider: 'codex',
    model: 'gpt-5.6-sol?reasoning=medium',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKeyEnv: 'CODEX_API_KEY',
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
          role: { type: 'string', description: 'gateway-explore, gateway-plan, gateway-implement, gateway-review, or gateway-vision' },
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
    {
      name: 'android_list_devices',
      description: 'List saved Android device profiles and optionally discover devices currently visible to ADB. Use this before routing Android work to a device alias.',
      inputSchema: {
        type: 'object',
        properties: {
          discover: { type: 'boolean', description: 'Also run adb devices -l without connecting to new devices.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'android_register_device',
      description: 'Save an Android device alias and create a pinned Android-MCP server for subsequent agent runs.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Stable lowercase alias, for example personal or lab-phone.' },
          serial: { type: 'string', description: 'ADB USB serial or WiFi host[:port].' },
          connection: { type: 'string', enum: ['auto', 'usb', 'wifi'] },
          make_active: { type: 'boolean' },
        },
        required: ['alias', 'serial'],
        additionalProperties: false,
      },
    },
    {
      name: 'android_select_device',
      description: 'Select the saved Android alias used by the base android-mcp server on the next agent run.',
      inputSchema: {
        type: 'object',
        properties: { alias: { type: 'string' } },
        required: ['alias'],
        additionalProperties: false,
      },
    },
    {
      name: 'android_connect_device',
      description: 'Connect or validate a saved Android alias or explicit ADB serial. For WiFi this runs adb connect; for USB it validates authorization.',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Saved alias, USB serial, or WiFi host:port.' },
          make_active: { type: 'boolean' },
        },
        required: ['identifier'],
        additionalProperties: false,
      },
    },
    {
      name: 'android_check_device',
      description: 'Check ADB state and basic Android device properties for a saved alias or serial without performing UI actions.',
      inputSchema: {
        type: 'object',
        properties: { identifier: { type: 'string' } },
        required: ['identifier'],
        additionalProperties: false,
      },
    },
    {
      name: 'android_pair_device',
      description: 'Pair a WiFi ADB target with a short-lived pairing code supplied by the user. Pairing codes are never persisted.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'WiFi pairing host:port shown by Android.' },
          code: { type: 'string', description: '4-12 digit pairing code.' },
        },
        required: ['target', 'code'],
        additionalProperties: false,
      },
    },
    {
      name: 'android_set_device_enabled',
      description: 'Enable or disable a saved Android device profile and its pinned MCP server.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['alias', 'enabled'],
        additionalProperties: false,
      },
    },
    {
      name: 'android_remove_device',
      description: 'Remove a saved Android profile and its generated MCP server. This does not modify the device itself.',
      inputSchema: {
        type: 'object',
        properties: { alias: { type: 'string' } },
        required: ['alias'],
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const result = await handleToolCall(params.name, params.arguments || {})
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    }
  }
})

async function handleToolCall(name, args) {
  if (name === 'get_subagent_routing') return redactRouting(loadConfig().subagents)
  if (name === 'configure_subagent_route') return configureRoute(args)
  if (name === 'set_subagent_parallelism') return setParallelism(args)
  if (name === 'set_subagents_enabled') return setEnabled(args)
  if (name === 'android_list_devices') return listAndroidDevices(args)
  if (name === 'android_register_device') {
    return gatewayRequest('/api/android/devices', {
      method: 'POST',
      body: {
        alias: args.alias,
        serial: args.serial,
        connection: args.connection || 'auto',
        make_active: args.make_active !== false,
      },
    })
  }
  if (name === 'android_select_device') {
    return gatewayRequest(
      `/api/android/devices/${encodeURIComponent(String(args.alias || ''))}`,
      { method: 'PATCH', body: { active: true } },
    )
  }
  if (name === 'android_connect_device') {
    return gatewayRequest('/api/android/connect', {
      method: 'POST',
      body: {
        alias: args.identifier,
        make_active: args.make_active !== false,
      },
    })
  }
  if (name === 'android_check_device') {
    return gatewayRequest(
      `/api/android/devices/${encodeURIComponent(String(args.identifier || ''))}/check`,
      { method: 'POST' },
    )
  }
  if (name === 'android_pair_device') {
    return gatewayRequest('/api/android/pair', {
      method: 'POST',
      body: { target: args.target, code: args.code },
    })
  }
  if (name === 'android_set_device_enabled') {
    return gatewayRequest(
      `/api/android/devices/${encodeURIComponent(String(args.alias || ''))}`,
      { method: 'PATCH', body: { enabled: args.enabled } },
    )
  }
  if (name === 'android_remove_device') {
    return gatewayRequest(
      `/api/android/devices/${encodeURIComponent(String(args.alias || ''))}`,
      { method: 'DELETE' },
    )
  }
  throw new Error(`Unknown gateway-control tool: ${name}`)
}

async function listAndroidDevices(args) {
  const registry = await gatewayRequest('/api/android/devices')
  if (args.discover !== true) return registry
  const discovered = await gatewayRequest('/api/android/discover', {
    method: 'POST',
  })
  return {
    ...registry,
    discovered: discovered.data || [],
  }
}

async function gatewayRequest(path, options = {}) {
  const baseUrl = String(
    process.env.OPENCLAUDE_AGENT_GATEWAY_URL || 'http://127.0.0.1:8642',
  ).replace(/\/+$/, '')
  const headers = {}
  const apiKey = String(process.env.OPENCLAUDE_AGENT_API_KEY || '').trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      body?.error?.message
      || body?.message
      || `Gateway Android API returned HTTP ${response.status}`,
    )
  }
  return body
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
