#!/usr/bin/env node

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  getBrowserModelProfile,
  listBrowserModelProfiles,
  removeBrowserModelProfile,
  upsertBrowserModelProfile,
} = require('./browser-model-profiles.cjs')

function runtimeRequire() {
  return existsSync('/app/package.json') ? createRequire('/app/package.json') : require
}

async function importRuntimeModule(specifier) {
  return import(pathToFileURL(runtimeRequire().resolve(specifier)).href)
}

function hydrateEnvFromDotEnv() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const envText = readFileSync(envPath, 'utf8')
  for (const rawLine of envText.split(/\r?\n/)) {
    const match = rawLine.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] && process.env[key] !== `\${${key}}`) continue
    process.env[key] = rawValue.trim().replace(/^"(.*)"$/, '$1')
  }
}

function config() {
  const envValue = name => {
    const value = process.env[name] || ''
    return /^\$\{[A-Z0-9_]+\}$/i.test(value) ? '' : value
  }
  return {
    baseUrl: (envValue('CAMOFOX_URL') || 'http://localhost:9377').replace(/\/+$/, ''),
    userId: envValue('CAMOFOX_MCP_USER_ID') || 'openclaude-agent',
    sessionKey: envValue('CAMOFOX_MCP_SESSION_KEY') || 'default',
    timeoutMs: Number(envValue('CAMOFOX_MCP_TIMEOUT') || 60) * 1000,
    accessKey: envValue('CAMOFOX_ACCESS_KEY'),
    apiKey: envValue('CAMOFOX_API_KEY') || envValue('CAMOFOX_ACCESS_KEY'),
  }
}

function baseUrlCandidates(baseUrl) {
  const candidates = [baseUrl]
  try {
    const parsed = new URL(baseUrl)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'host.docker.internal'
      candidates.push(parsed.toString().replace(/\/+$/, ''))
    }
  } catch {
    // Let fetch report the malformed URL.
  }
  return [...new Set(candidates)]
}

async function camofoxRequest(path, options = {}) {
  const cfg = config()
  const headers = { ...(options.headers || {}) }
  const bearer = options.sensitive ? cfg.apiKey : cfg.accessKey
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  let lastError
  for (const baseUrl of baseUrlCandidates(cfg.baseUrl)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      })
      const contentType = response.headers.get('content-type') || ''
      const text = await response.text()
      let data = text
      if (contentType.includes('application/json') && text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
      if (!response.ok) {
        const message = data?.error || data?.message || data?.detail || text || response.statusText
        throw new Error(`Camofox ${response.status}: ${message}`)
      }
      return data
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

function jsonBody(value) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  }
}

function compactJson(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function parseCompactJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function tabPayload(args = {}) {
  const cfg = config()
  return {
    userId: String(args.userId || args.user_id || cfg.userId),
    sessionKey: String(args.sessionKey || args.session_key || cfg.sessionKey),
  }
}

async function createTab(args) {
  const payload = {
    ...tabPayload(args),
    url: args?.url || undefined,
    trace: args?.trace === true,
  }
  try {
    return compactJson(await camofoxRequest('/tabs', jsonBody(payload)))
  } catch (error) {
    if (!/target page, context or browser has been closed/i.test(String(error))) {
      throw error
    }
    const userId = encodeURIComponent(payload.userId)
    await camofoxRequest(`/sessions/${userId}`, {
      method: 'DELETE',
    }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 1_000))
    return compactJson(await camofoxRequest('/tabs', jsonBody(payload)))
  }
}

async function listTabs(args) {
  const userId = encodeURIComponent(tabPayload(args).userId)
  return compactJson(await camofoxRequest(`/tabs?userId=${userId}`))
}

async function navigate(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  const body = {
    ...tabPayload(args),
    url: args?.url || undefined,
    macro: args?.macro || undefined,
    query: args?.query || undefined,
  }
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}/navigate`, jsonBody(body)))
}

async function snapshot(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  const params = new URLSearchParams({
    userId: tabPayload(args).userId,
    format: args?.format || 'text',
  })
  if (args?.offset !== undefined) params.set('offset', String(args.offset))
  if (args?.includeScreenshot !== undefined || args?.include_screenshot !== undefined) {
    params.set('includeScreenshot', String(Boolean(args.includeScreenshot ?? args.include_screenshot)))
  }
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}/snapshot?${params}`))
}

async function click(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  const body = {
    ...tabPayload(args),
    ref: args?.ref || undefined,
    selector: args?.selector || undefined,
    doubleClick: args?.doubleClick === true || args?.double_click === true,
    coordinates: args?.coordinates || undefined,
  }
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}/click`, jsonBody(body)))
}

async function typeText(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  if (args?.text === undefined) throw new Error('text is required')
  const body = {
    ...tabPayload(args),
    ref: args?.ref || undefined,
    selector: args?.selector || undefined,
    text: String(args.text),
    clear: args?.clear === true,
    submit: args?.submit === true,
  }
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}/type`, jsonBody(body)))
}

async function press(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  if (!args?.key) throw new Error('key is required')
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}/press`, jsonBody({
    ...tabPayload(args),
    key: String(args.key),
  })))
}

async function scroll(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}/scroll`, jsonBody({
    ...tabPayload(args),
    direction: args?.direction || 'down',
    amount: Number(args?.amount || 800),
  })))
}

async function screenshot(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  const params = new URLSearchParams({ userId: tabPayload(args).userId })
  const savePath = resolve(String(args?.save_path || args?.savePath || `output/camofox/${tabId}.png`))
  mkdirSync(dirname(savePath), { recursive: true })

  const cfg = config()
  const headers = {}
  if (cfg.accessKey) headers.Authorization = `Bearer ${cfg.accessKey}`
  let lastError
  for (const baseUrl of baseUrlCandidates(cfg.baseUrl)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const response = await fetch(`${baseUrl}/tabs/${encodeURIComponent(tabId)}/screenshot?${params}`, {
        headers,
        signal: controller.signal,
      })
      const contentType = response.headers.get('content-type') || ''
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Camofox ${response.status}: ${text || response.statusText}`)
      }
      if (contentType.includes('application/json')) {
        const data = await response.json()
        const image = data?.screenshot?.data || data?.data || data?.screenshot
        if (!image || typeof image !== 'string') return compactJson(data)
        writeFileSync(savePath, Buffer.from(image, 'base64'))
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        writeFileSync(savePath, bytes)
      }
      return `Saved Camofox screenshot: ${savePath}`
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

async function closeTab(args) {
  const tabId = String(args?.tabId || args?.tab_id || '').trim()
  if (!tabId) throw new Error('tabId is required')
  return compactJson(await camofoxRequest(`/tabs/${encodeURIComponent(tabId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tabPayload(args)),
  }))
}

async function closeSession(args) {
  const userId = encodeURIComponent(tabPayload(args).userId)
  return compactJson(await camofoxRequest(`/sessions/${userId}`, {
    method: 'DELETE',
  }))
}

async function checkpointSession(args) {
  const userId = encodeURIComponent(tabPayload(args).userId)
  return compactJson(await camofoxRequest(
    `/sessions/${userId}/checkpoint`,
    { method: 'POST' },
  ))
}

async function health() {
  return compactJson(await camofoxRequest('/health'))
}

function listModelProfiles() {
  return compactJson({
    version: 1,
    profiles: listBrowserModelProfiles(),
    security:
      'Credentials, cookies, and browser storage are never returned by this tool.',
  })
}

function setModelProfile(args) {
  return compactJson(
    upsertBrowserModelProfile({
      id: args?.id,
      label: args?.label,
      url: args?.url,
      userId: args?.userId || args?.user_id,
      sessionKey: args?.sessionKey || args?.session_key,
      defaultModel: args?.defaultModel || args?.default_model,
      enabled: args?.enabled,
    }),
  )
}

function removeModelProfile(args) {
  return compactJson(removeBrowserModelProfile(args?.id))
}

async function openModelProfile(args) {
  const profile = getBrowserModelProfile(args?.id)
  if (!profile.enabled) {
    throw new Error(`Browser model profile is disabled: ${profile.id}`)
  }
  const tab = await createTab({
    url: profile.url,
    userId: profile.userId,
    sessionKey: profile.sessionKey,
    trace: args?.trace,
  })
  return compactJson({
    profile: {
      id: profile.id,
      label: profile.label,
      url: profile.url,
      userId: profile.userId,
      sessionKey: profile.sessionKey,
      requestedModel: String(
        args?.model || args?.requestedModel || profile.defaultModel || '',
      ).trim(),
      status: profile.status,
      loginCommand: profile.loginCommand,
    },
    tab: parseCompactJson(tab),
    note:
      'If the page requests authentication, leave the tab open and ask the user to run the login command. Never enter or inspect credentials.',
  })
}

async function checkpointModelProfile(args) {
  const profile = getBrowserModelProfile(args?.id)
  const result = await checkpointSession({ userId: profile.userId })
  return compactJson({
    profile: profile.id,
    checkpoint: parseCompactJson(result),
  })
}

const tools = [
  {
    name: 'camofox_health',
    description: 'Check the local Camofox browser REST server health.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'camofox_create_tab',
    description: 'Create a Camofox tab, optionally opening a URL. Returns tabId.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        userId: { type: 'string' },
        sessionKey: { type: 'string' },
        trace: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'camofox_list_tabs',
    description: 'List open Camofox tabs for the configured user/session.',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
  },
  {
    name: 'camofox_navigate',
    description: 'Navigate a Camofox tab to a URL or search macro such as @google_search.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        url: { type: 'string' },
        macro: { type: 'string' },
        query: { type: 'string' },
        userId: { type: 'string' },
        sessionKey: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_snapshot',
    description: 'Read the accessibility snapshot with stable element refs from a Camofox tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        userId: { type: 'string' },
        format: { type: 'string', enum: ['text', 'json'], default: 'text' },
        offset: { type: 'number' },
        includeScreenshot: { type: 'boolean', default: false },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_click',
    description: 'Click a Camofox element by snapshot ref, selector, or coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        coordinates: { type: 'object' },
        doubleClick: { type: 'boolean', default: false },
        userId: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_type',
    description: 'Type text into a Camofox page element by ref/selector, or into the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', default: false },
        submit: { type: 'boolean', default: false },
        userId: { type: 'string' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'camofox_press',
    description: 'Press a keyboard key in a Camofox tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        key: { type: 'string' },
        userId: { type: 'string' },
      },
      required: ['tabId', 'key'],
    },
  },
  {
    name: 'camofox_scroll',
    description: 'Scroll a Camofox tab up or down.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
        amount: { type: 'number', default: 800 },
        userId: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_screenshot',
    description: 'Take a Camofox screenshot and save it to a local PNG file.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        save_path: { type: 'string' },
        userId: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_close_tab',
    description: 'Close a Camofox tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        userId: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_checkpoint_session',
    description: 'Persist refreshed Camofox cookies and localStorage without closing the browser session or its tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'camofox_close_session',
    description: 'Close a Camofox user session after an unrecoverable page or authentication failure.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'camofox_list_model_profiles',
    description:
      'List configured browser AI profiles, persistent Camofox identities, non-secret authentication status, and the command the user can run to log in.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'camofox_set_model_profile',
    description:
      'Create or update a browser AI profile. Stores only routing metadata; credentials and cookies are never accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,47}$' },
        label: { type: 'string' },
        url: { type: 'string' },
        userId: { type: 'string' },
        sessionKey: { type: 'string' },
        defaultModel: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'url'],
    },
  },
  {
    name: 'camofox_remove_model_profile',
    description:
      'Remove a custom browser AI profile override. Built-in profiles revert to their defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'camofox_open_model_profile',
    description:
      'Open a browser AI service with its isolated persistent Camofox identity. Returns the tab and login handoff instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        model: { type: 'string' },
        trace: { type: 'boolean', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'camofox_checkpoint_model_profile',
    description:
      'Persist refreshed cookies and localStorage for a browser AI profile without exposing or closing its session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
]

async function main() {
  hydrateEnvFromDotEnv()

  const [
    { Server },
    { StdioServerTransport },
    types,
  ] = await Promise.all([
    importRuntimeModule('@modelcontextprotocol/sdk/server/index.js'),
    importRuntimeModule('@modelcontextprotocol/sdk/server/stdio.js'),
    importRuntimeModule('@modelcontextprotocol/sdk/types.js'),
  ])

  const { CallToolRequestSchema, ListToolsRequestSchema } = types
  const server = new Server(
    { name: 'openclaude-camofox', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const name = request.params.name
      const args = request.params.arguments || {}
      let text
      if (name === 'camofox_health') text = await health()
      else if (name === 'camofox_create_tab') text = await createTab(args)
      else if (name === 'camofox_list_tabs') text = await listTabs(args)
      else if (name === 'camofox_navigate') text = await navigate(args)
      else if (name === 'camofox_snapshot') text = await snapshot(args)
      else if (name === 'camofox_click') text = await click(args)
      else if (name === 'camofox_type') text = await typeText(args)
      else if (name === 'camofox_press') text = await press(args)
      else if (name === 'camofox_scroll') text = await scroll(args)
      else if (name === 'camofox_screenshot') text = await screenshot(args)
      else if (name === 'camofox_close_tab') text = await closeTab(args)
      else if (name === 'camofox_checkpoint_session') text = await checkpointSession(args)
      else if (name === 'camofox_close_session') text = await closeSession(args)
      else if (name === 'camofox_list_model_profiles') text = listModelProfiles()
      else if (name === 'camofox_set_model_profile') text = setModelProfile(args)
      else if (name === 'camofox_remove_model_profile') text = removeModelProfile(args)
      else if (name === 'camofox_open_model_profile') text = await openModelProfile(args)
      else if (name === 'camofox_checkpoint_model_profile') text = await checkpointModelProfile(args)
      else throw new Error(`Unknown tool: ${name}`)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(error?.stack || error?.message || error) }],
      }
    }
  })

  await server.connect(new StdioServerTransport())
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[camofox-mcp-bridge] ${error?.stack || error?.message || error}`)
    process.exit(1)
  })
}

module.exports = {
  checkpointModelProfile,
  listModelProfiles,
  openModelProfile,
  removeModelProfile,
  setModelProfile,
  tools,
}
