#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { resolve } = require('node:path')

const REQUIRED_SERVERS = [
  'codegraph',
  'searxng',
  'context7',
  'pentest',
  'telegram-mcp',
]
const NETWORK_TIMEOUT_MS = 10_000
const MCP_OPERATION_TIMEOUT_MS = 30_000
const SEARXNG_PREFLIGHT_ATTEMPTS = 5
const REQUIRED_TELEGRAM_TOOLS = [
  'list_accounts',
  'assistant_sync_memory',
  'assistant_get_chat_context',
]
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
    const names = new Set(tools.tools.map(tool => tool.name))
    const missing = REQUIRED_TELEGRAM_TOOLS.filter(name => !names.has(name))
    if (missing.length > 0) {
      throw new Error(`missing required tools: ${missing.join(', ')}`)
    }
  } catch (error) {
    throw new Error(
      `Telegram MCP tool check failed at ${target}: ${error instanceof Error ? error.message : String(error)}`,
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
  await checkPentestMcp(config.mcpServers.pentest, projectRoot)
  await checkTelegramMcp(config.mcpServers['telegram-mcp'])
  console.log(`BASE_MCP_PREFLIGHT_OK ${REQUIRED_SERVERS.join(',')}`)
}

main().catch(error => {
  console.error(`[base-mcp-preflight] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
