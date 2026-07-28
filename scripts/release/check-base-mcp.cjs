#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const REQUIRED_SERVERS = ['codegraph', 'searxng', 'context7', 'telegram-mcp']
const NETWORK_TIMEOUT_MS = 10_000
const SEARXNG_PREFLIGHT_ATTEMPTS = 5
const REQUIRED_TELEGRAM_TOOLS = [
  'list_accounts',
  'assistant_sync_memory',
  'assistant_get_chat_context',
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
  const signal = AbortSignal.timeout(NETWORK_TIMEOUT_MS)
  try {
    await client.connect(transport, { signal })
    const tools = await client.listTools({}, { signal })
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
  await checkTelegramMcp(config.mcpServers['telegram-mcp'])
  console.log(`BASE_MCP_PREFLIGHT_OK ${REQUIRED_SERVERS.join(',')}`)
}

main().catch(error => {
  console.error(`[base-mcp-preflight] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
