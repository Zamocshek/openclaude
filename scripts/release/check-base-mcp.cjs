#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { resolve } = require('node:path')

const REQUIRED_SERVERS = [
  'capability-router',
  'codegraph',
  'searxng',
  'context7',
  'github',
  'pentest',
  'telegram-mcp',
]
const NETWORK_TIMEOUT_MS = 10_000
const MCP_OPERATION_TIMEOUT_MS = 30_000
const SEARXNG_PREFLIGHT_ATTEMPTS = 5
const REQUIRED_TELEGRAM_TOOLS = [
  'list_accounts',
  'check_account',
  'authorize_send_code',
  'authorize_complete',
  'assistant_sync_memory',
  'assistant_get_chat_context',
  'assistant_confirm_action',
  'maton_config_status',
  'maton_connections',
  'maton_telegram_get_me',
  'maton_telegram_get_chat',
  'maton_telegram_prepare_send_message',
  'maton_telegram_prepare_send_animation',
]
const REQUIRED_TELEGRAM_TOOL_SCHEMAS = {
  maton_telegram_prepare_send_message: ['chat_id', 'text'],
  maton_telegram_prepare_send_animation: ['animation', 'chat_id'],
}
const REQUIRED_PENTEST_TOOLS = [
  'pentest_health',
  'pentest_engagement_create',
  'pentest_scope_check',
  'pentest_state_query',
  'pentest_state_update',
  'pentest_nmap_parse',
  'pentest_nmap_run',
  'pentest_report_generate',
]
const REQUIRED_GITHUB_TOOLS = [
  'get_me',
  'get_file_contents',
  'search_repositories',
]
const REQUIRED_CAPABILITY_ROUTER_TOOLS = [
  'capability_route',
  'capability_call',
  'capability_registry',
  'skill_store',
  'workspace_files',
]

function readConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? parsed
      : null
  } catch {
    return null
  }
}

function packageEntryExists(projectRoot, subpath) {
  return [
    resolve('/app/node_modules', subpath),
    resolve(projectRoot, 'node_modules', subpath),
  ].some(candidate => existsSync(candidate))
}

async function checkSearxng() {
  if (process.argv.includes('--offline')) return
  const base = process.env.SEARXNG_URL || 'http://127.0.0.1:18088'
  const healthUrl = new URL('/healthz', base.endsWith('/') ? base : `${base}/`)
  let lastError = new Error('unknown error')
  for (let attempt = 1; attempt <= SEARXNG_PREFLIGHT_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    try {
      const response = await fetch(healthUrl, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < SEARXNG_PREFLIGHT_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1_000))
      }
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`SearXNG health check failed at ${healthUrl.origin} after ${SEARXNG_PREFLIGHT_ATTEMPTS} attempts: ${lastError.message}`)
}

async function checkTelegramMcp(server) {
  if (process.argv.includes('--offline')) return
  const target = server && typeof server.url === 'string'
    ? server.url
    : 'http://telegram-mcp:8766/mcp'
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  const transport = new StreamableHTTPClientTransport(new URL(target))
  const client = new Client({
    name: 'openclaude-base-mcp-preflight',
    version: '1.0.0',
  })
  try {
    await client.connect(transport, {
      signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS),
    })
    const tools = await client.listTools(
      {},
      { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
    )
    const toolMap = new Map(tools.tools.map(tool => [tool.name, tool]))
    const names = new Set(toolMap.keys())
    const missing = REQUIRED_TELEGRAM_TOOLS.filter(name => !names.has(name))
    if (missing.length > 0) {
      throw new Error(`missing required tools: ${missing.join(', ')}`)
    }
    for (const [name, expected] of Object.entries(REQUIRED_TELEGRAM_TOOL_SCHEMAS)) {
      const actual = [...(toolMap.get(name)?.inputSchema?.required || [])].sort()
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `${name} required fields changed: expected ${expected.join(', ')}, got ${actual.join(', ') || 'none'}`,
        )
      }
    }
  } catch (error) {
    throw new Error(
      `Telegram MCP tool check failed at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await client.close().catch(() => {})
  }
}

async function checkCapabilityRouter(server, projectRoot) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const configuredEnv = Object.fromEntries(Object.entries(server?.env || {}).map(([name, value]) => {
    const text = String(value)
    const match = text.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u)
    return [name, match ? (process.env[match[1]] || '') : text]
  }))
  const transport = new StdioClientTransport({
    command: server?.command || process.execPath,
    args: Array.isArray(server?.args) ? server.args.map(String) : ['scripts/capability-router-launcher.cjs'],
    cwd: projectRoot,
    env: { ...process.env, ...configuredEnv },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'openclaude-capability-router-preflight', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) })
    const listed = await client.listTools({}, { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) })
    const names = new Set(listed.tools.map(tool => tool.name))
    const missing = REQUIRED_CAPABILITY_ROUTER_TOOLS.filter(name => !names.has(name))
    if (missing.length) throw new Error(`missing required tools: ${missing.join(', ')}`)
  } catch (error) {
    throw new Error(`Capability Router MCP check failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await client.close().catch(() => {})
  }
}

async function checkGithubMcp(server) {
  if (process.argv.includes('--offline')) return
  const target = server && typeof server.url === 'string'
    ? server.url
    : 'https://api.githubcopilot.com/mcp/'
  const token = process.env.GITHUB_MCP_PAT || ''
  if (!token.trim()) throw new Error('GITHUB_MCP_PAT is not configured')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  const transport = new StreamableHTTPClientTransport(new URL(target), {
    requestInit: {
      headers: { Authorization: `Bearer ${token.trim()}` },
    },
  })
  const client = new Client({
    name: 'openclaude-base-github-preflight',
    version: '1.0.0',
  })
  try {
    await client.connect(transport, {
      signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS),
    })
    const tools = await client.listTools(
      {},
      { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
    )
    const names = new Set(tools.tools.map(tool => tool.name))
    const missing = REQUIRED_GITHUB_TOOLS.filter(name => !names.has(name))
    if (missing.length > 0) {
      throw new Error(`missing required tools: ${missing.join(', ')}`)
    }
    const me = await client.callTool(
      { name: 'get_me', arguments: {} },
      undefined,
      { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
    )
    if (me.isError) throw new Error('get_me returned an error')
  } catch (error) {
    throw new Error(
      `GitHub MCP tool check failed at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await client.close().catch(() => {})
  }
}

async function checkPentestMcp(server, projectRoot) {
  const command = typeof server?.command === 'string' && server.command.trim()
    ? server.command.trim()
    : process.execPath
  const args = Array.isArray(server?.args)
    ? server.args.map(String)
    : ['scripts/pentest-mcp.cjs']
  const configuredScript = args[0] || 'scripts/pentest-mcp.cjs'
  if (
    (command === 'node' || command === process.execPath) &&
    ![
      resolve(projectRoot, configuredScript),
      resolve('/app', configuredScript),
    ].some(candidate => existsSync(candidate))
  ) {
    throw new Error(`Pentest MCP script is missing: ${configuredScript}`)
  }
  const stateDir = await mkdtemp(resolve(tmpdir(), 'openclaude-base-pentest-'))
  const configuredEnv = Object.fromEntries(
    Object.entries(server?.env || {}).map(([name, value]) => {
      const text = String(value)
      const match = text.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u)
      return [name, match ? (process.env[match[1]] || '') : text]
    }),
  )
  const transportEnv = {
    ...process.env,
    ...configuredEnv,
    PENTEST_STATE_DIR: stateDir,
  }
  const engagementId = `preflight-${Date.now()}`
  const engagement = {
    engagement_id: engagementId,
    name: 'Production preflight',
    authorized: true,
    authorization_statement: 'Local production preflight fixture.',
    targets: ['127.0.0.1'],
    allowed_actions: ['active_scan', 'reporting'],
  }
  if (transportEnv.PENTEST_GATEWAY_AUTH_TOKEN) {
    const authorized = spawnSync(command, [...args, 'authorize-json'], {
      cwd: projectRoot,
      env: transportEnv,
      input: JSON.stringify(engagement),
      encoding: 'utf8',
      timeout: MCP_OPERATION_TIMEOUT_MS,
      windowsHide: true,
    })
    if (authorized.status !== 0) {
      throw new Error(
        `trusted pentest authorization failed: ${authorized.stderr || authorized.error || authorized.status}`,
      )
    }
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: projectRoot,
    env: transportEnv,
    stderr: 'pipe',
  })
  const client = new Client({
    name: 'openclaude-base-mcp-preflight',
    version: '1.0.0',
  })
  try {
    await client.connect(transport, {
      signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS),
    })
    const tools = await client.listTools(
      {},
      { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
    )
    const names = new Set(tools.tools.map(tool => tool.name))
    const missing = REQUIRED_PENTEST_TOOLS.filter(name => !names.has(name))
    if (missing.length > 0) {
      throw new Error(`missing required tools: ${missing.join(', ')}`)
    }
    const health = await client.callTool(
      { name: 'pentest_health', arguments: {} },
      undefined,
      { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
    )
    if (health.isError) throw new Error('pentest_health returned an error')
    if (!transportEnv.PENTEST_GATEWAY_AUTH_TOKEN) {
      const created = await client.callTool(
        {
          name: 'pentest_engagement_create',
          arguments: engagement,
        },
        undefined,
        { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
      )
      if (created.isError) throw new Error('pentest_engagement_create returned an error')
    }
    const checked = await client.callTool(
      {
        name: 'pentest_scope_check',
        arguments: {
          engagement_id: engagementId,
          target: '127.0.0.1',
          action: 'active_scan',
        },
      },
      undefined,
      { signal: AbortSignal.timeout(MCP_OPERATION_TIMEOUT_MS) },
    )
    if (checked.isError) throw new Error('pentest_scope_check returned an error')
    const checkedText = checked.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n')
    if (!JSON.parse(checkedText).allowed) {
      throw new Error('pentest_scope_check denied its in-scope preflight fixture')
    }
  } catch (error) {
    throw new Error(
      `Pentest MCP tool check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await client.close().catch(() => {})
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function checkAndroidMcp(projectRoot) {
  const script = [
    resolve('/app/scripts/release/test-android-mcp.cjs'),
    resolve(projectRoot, 'scripts/release/test-android-mcp.cjs'),
  ].find(candidate => existsSync(candidate))
  if (!script) throw new Error('Android MCP preflight script is missing.')
  const result = spawnSync(process.execPath, [script, projectRoot], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(
      `Android MCP check failed: ${
        result.stderr || result.error?.message || result.status
      }`,
    )
  }
}

async function main() {
  const projectRoot = resolve(
    process.env.OPENCLAUDE_AGENT_RUNNER_CWD || process.cwd(),
  )
  const configPath = resolve(projectRoot, '.mcp.json')
  const config = readConfig(configPath)
  if (!config) throw new Error(`Base MCP config is missing or invalid: ${configPath}`)

  const missingServers = REQUIRED_SERVERS.filter(name => !config.mcpServers[name])
  if (missingServers.length > 0) {
    throw new Error(`Base MCP config is missing required servers: ${missingServers.join(', ')}`)
  }

  const requiredFiles = [
    ['CodeGraph package', '@colbymchenry/codegraph/npm-shim.js'],
    ['SearXNG MCP package', 'mcp-searxng/dist/cli.js'],
    ['Context7 MCP package', '@upstash/context7-mcp/dist/index.js'],
  ]
  const missingPackages = requiredFiles
    .filter(([, subpath]) => !packageEntryExists(projectRoot, subpath))
    .map(([label]) => label)
  if (missingPackages.length > 0) {
    throw new Error(`Required MCP dependencies are missing: ${missingPackages.join(', ')}`)
  }

  const codegraphDb = resolve(projectRoot, '.codegraph', 'codegraph.db')
  if (!existsSync(codegraphDb)) {
    throw new Error(`CodeGraph index is missing: ${codegraphDb}`)
  }

  await checkSearxng()
  await checkCapabilityRouter(config.mcpServers['capability-router'], projectRoot)
  await checkAndroidMcp(projectRoot)
  await checkPentestMcp(config.mcpServers.pentest, projectRoot)
  await checkGithubMcp(config.mcpServers.github)
  await checkTelegramMcp(config.mcpServers['telegram-mcp'])
  console.log(`BASE_MCP_PREFLIGHT_OK ${REQUIRED_SERVERS.join(',')}`)
}

main().catch(error => {
  console.error(`[base-mcp-preflight] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
