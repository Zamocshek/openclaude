#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

function importMcpSdk(relativePath, packageSpecifier) {
  const imagePath = resolve(
    '/app/node_modules/@modelcontextprotocol/sdk/dist/esm',
    relativePath,
  )
  return existsSync(imagePath)
    ? import(pathToFileURL(imagePath).href)
    : import(packageSpecifier)
}

function hydrateEnvFromDotEnv() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const envText = readFileSync(envPath, 'utf8')
  const preferDotEnv = new Set(['MCPR_TOKEN', 'MCPR_PROJECT'])
  if ((process.env.MCPR_HOST || '').trim().toLowerCase() !== 'host.docker.internal') {
    preferDotEnv.add('MCPR_HOST')
    preferDotEnv.add('MCPR_PORT')
  }
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] && process.env[key] !== `\${${key}}` && !preferDotEnv.has(key)) {
      continue
    }
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '')
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function createTimedFetch(timeoutMs) {
  return async (url, init = {}) => {
    const timeoutController = new AbortController()
    const signals = [init.signal, timeoutController.signal].filter(Boolean)
    const signal = signals.length > 1 && typeof AbortSignal.any === 'function'
      ? AbortSignal.any(signals)
      : timeoutController.signal
    const timer = setTimeout(
      () => timeoutController.abort(new Error(`MCP Router request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    try {
      return await fetch(url, { ...init, signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

async function main() {
  hydrateEnvFromDotEnv()

  const [
    { Client },
    { StreamableHTTPClientTransport },
    { Server },
    { StdioServerTransport },
    types,
  ] = await Promise.all([
    importMcpSdk('client/index.js', '@modelcontextprotocol/sdk/client/index.js'),
    importMcpSdk('client/streamableHttp.js', '@modelcontextprotocol/sdk/client/streamableHttp.js'),
    importMcpSdk('server/index.js', '@modelcontextprotocol/sdk/server/index.js'),
    importMcpSdk('server/stdio.js', '@modelcontextprotocol/sdk/server/stdio.js'),
    importMcpSdk('types.js', '@modelcontextprotocol/sdk/types.js'),
  ])

  const {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
  } = types

  const host = process.env.MCPR_HOST || '127.0.0.1'
  const port = process.env.MCPR_PORT || '3282'
  const token = process.env.MCPR_TOKEN
  const project = process.env.MCPR_PROJECT
  const connectTimeoutMs = Math.max(250, Number(process.env.MCPR_CONNECT_TIMEOUT_MS || 1000))
  const retryMs = Math.max(1000, Number(process.env.MCPR_RETRY_MS || 15000))
  const headers = {}
  if (token && token !== '${MCPR_TOKEN}') headers.authorization = `Bearer ${token}`
  if (project) headers['x-mcpr-project'] = project

  let httpClient = null
  let connecting = null
  let lastAttemptAt = 0
  let lastError = ''

  async function disconnect() {
    const current = httpClient
    httpClient = null
    if (current) await current.close().catch(() => {})
  }

  async function connectUpstream(force = false) {
    if (httpClient) return httpClient
    if (connecting) return connecting
    if (!force && Date.now() - lastAttemptAt < retryMs) return null

    lastAttemptAt = Date.now()
    connecting = (async () => {
      const client = new Client({
        name: 'openclaude-agent-mcp-router',
        version: '0.0.2',
      })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://${host}:${port}/mcp`),
        {
          fetch: createTimedFetch(connectTimeoutMs),
          requestInit: { headers },
        },
      )
      try {
        await withTimeout(
          client.connect(transport),
          connectTimeoutMs + 250,
          'MCP Router connect',
        )
        httpClient = client
        lastError = ''
        return client
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await withTimeout(client.close(), 250, 'MCP Router close').catch(() => {})
        return null
      } finally {
        connecting = null
      }
    })()
    return connecting
  }

  async function upstream(operation) {
    const client = await connectUpstream()
    if (!client) return null
    try {
      return await operation(client)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await disconnect()
      return null
    }
  }

  function statusTool() {
    return {
      name: 'mcp_router_status',
      description: 'Check whether the optional external MCP Router upstream is reachable. The base project MCP tools remain available independently.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }
  }

  const server = new Server(
    { name: 'mcp-router', version: '0.0.2' },
    { capabilities: { resources: {}, tools: {}, prompts: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await upstream(client => client.listTools())
    if (!listed) return { tools: [statusTool()] }
    const tools = listed.tools.some(tool => tool.name === 'mcp_router_status')
      ? listed.tools
      : [...listed.tools, statusTool()]
    return { ...listed, tools }
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === 'mcp_router_status') {
      const client = await connectUpstream(true)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: Boolean(client),
            endpoint: `http://${host}:${port}/mcp`,
            lastError: client ? undefined : lastError || 'upstream unavailable',
          }),
        }],
        isError: false,
      }
    }

    const result = await upstream(client => client.callTool(
      {
        name: request.params.name,
        arguments: request.params.arguments || {},
      },
      undefined,
      { timeout: 60 * 60 * 1000, resetTimeoutOnProgress: true },
    ))
    return result || {
      content: [{ type: 'text', text: `MCP Router upstream is unavailable: ${lastError || 'connection failed'}` }],
      isError: true,
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return await upstream(client => client.listResources()) || { resources: [] }
  })
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return await upstream(client => client.listResourceTemplates()) || { resourceTemplates: [] }
  })
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const result = await upstream(client => client.readResource({ uri: request.params.uri }))
    if (result) return result
    throw new Error(`MCP Router upstream is unavailable: ${lastError || 'connection failed'}`)
  })
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return await upstream(client => client.listPrompts()) || { prompts: [] }
  })
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    const result = await upstream(client => client.getPrompt({
      name: request.params.name,
      arguments: request.params.arguments || {},
    }))
    if (result) return result
    throw new Error(`MCP Router upstream is unavailable: ${lastError || 'connection failed'}`)
  })

  let closing = false
  const close = async code => {
    if (closing) return
    closing = true
    await Promise.allSettled([server.close(), disconnect()])
    process.exit(code)
  }

  process.once('SIGINT', () => void close(0))
  process.once('SIGTERM', () => void close(0))
  process.stdin.once('end', () => void close(0))
  process.stdin.once('close', () => void close(0))

  await server.connect(new StdioServerTransport())
}

main().catch(error => {
  console.error(`[mcp-router] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
