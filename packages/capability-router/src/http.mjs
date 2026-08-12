#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { CapabilityRouter } from './core.mjs'
import { createCapabilityMcpServer } from './server.mjs'
import { buildUi } from './ui.mjs'

const router = new CapabilityRouter()
const host = process.env.CAPABILITY_ROUTER_HOST || '127.0.0.1'
const port = Number(process.env.CAPABILITY_ROUTER_PORT || 8768)
const apiKey = process.env.CAPABILITY_ROUTER_API_KEY || ''
const maxBodyBytes = Number(process.env.CAPABILITY_ROUTER_MAX_BODY_BYTES || 268_435_456)
const configuredAutoSession = process.env.CAPABILITY_ROUTER_AUTO_SESSION
const autoSession = configuredAutoSession === undefined
  ? ['127.0.0.1', 'localhost', '::1'].includes(host)
  : /^(?:1|true|yes|on)$/iu.test(configuredAutoSession)
const configuredSessionTtlMs = Number(process.env.CAPABILITY_ROUTER_SESSION_TTL_MS || 43_200_000)
const sessionTtlMs = Number.isFinite(configuredSessionTtlMs) && configuredSessionTtlMs >= 60_000
  ? configuredSessionTtlMs
  : 43_200_000
const consoleSessions = new Map()
const consoleCookieName = 'capability_router_session'

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !apiKey) {
  throw new Error('CAPABILITY_ROUTER_API_KEY is required when binding outside loopback')
}

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendText(response, status, value, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const body = Buffer.from(String(value))
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

function requestHostname(request) {
  const rawHost = String(request.headers.host || '').trim()
  try {
    return new URL(`http://${rawHost}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isLoopbackConsoleRequest(request) {
  return autoSession && ['127.0.0.1', 'localhost', '::1'].includes(requestHostname(request))
}

function pruneConsoleSessions(now = Date.now()) {
  for (const [token, expiresAt] of consoleSessions) {
    if (expiresAt <= now) consoleSessions.delete(token)
  }
}

function issueConsoleSession() {
  const now = Date.now()
  pruneConsoleSessions(now)
  const token = randomBytes(32).toString('base64url')
  consoleSessions.set(token, now + sessionTtlMs)
  return `${consoleCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}`
}

function requestCookie(request, name) {
  for (const part of String(request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return ''
}

function hasConsoleSession(request) {
  if (!isLoopbackConsoleRequest(request)) return false
  const token = requestCookie(request, consoleCookieName)
  if (!token) return false
  const expiresAt = consoleSessions.get(token)
  if (!expiresAt || expiresAt <= Date.now()) {
    consoleSessions.delete(token)
    return false
  }
  return true
}

function authorized(request, { allowConsoleSession = false, requireExplicit = false } = {}) {
  const authorization = request.headers.authorization || ''
  const keyAccepted = Boolean(apiKey) && (
    authorization === `Bearer ${apiKey}`
    || request.headers['x-capability-router-key'] === apiKey
  )
  const sessionAccepted = allowConsoleSession && hasConsoleSession(request)
  if (apiKey) return keyAccepted || sessionAccepted
  return requireExplicit ? sessionAccepted : true
}

async function bodyBuffer(request, limit = maxBodyBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > limit) throw Object.assign(new Error(`Request exceeds ${limit} bytes`), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function jsonBody(request, limit = 4 * 1024 * 1024) {
  const body = await bodyBuffer(request, limit)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 })
  }
}

async function handleMcp(request, response, parsedBody) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
    return
  }
  const server = createCapabilityMcpServer(router)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  try {
    await server.connect(transport)
    await transport.handleRequest(request, response, parsedBody)
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, id: null })
    }
  } finally {
    response.once('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`)
  try {
    if (url.pathname === '/' && request.method === 'GET') {
      const localConsole = isLoopbackConsoleRequest(request)
      sendText(response, 200, buildUi(), 'text/html; charset=utf-8', {
        ...(localConsole ? { 'set-cookie': issueConsoleSession() } : {}),
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      })
      return
    }
    if (url.pathname === '/favicon.ico' && request.method === 'GET') {
      response.writeHead(204, { 'cache-control': 'public, max-age=86400' })
      response.end()
      return
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, service: 'capability-router', version: '1.0.0' })
      return
    }
    const apiRequest = url.pathname.startsWith('/api/')
    const mutatingApiRequest = apiRequest && !['GET', 'HEAD'].includes(request.method || 'GET')
    if ((apiRequest || url.pathname === '/mcp') && !authorized(request, {
      allowConsoleSession: apiRequest,
      requireExplicit: mutatingApiRequest,
    })) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    if (url.pathname === '/mcp') {
      const parsedBody = request.method === 'POST' ? await jsonBody(request) : undefined
      await handleMcp(request, response, parsedBody)
      return
    }
    if (url.pathname === '/api/state' && request.method === 'GET') {
      sendJson(response, 200, router.snapshot())
      return
    }
    if (url.pathname === '/api/catalog' && request.method === 'GET') {
      sendJson(response, 200, await router.catalog())
      return
    }
    if (url.pathname === '/api/probe' && request.method === 'POST') {
      const input = await jsonBody(request)
      sendJson(response, 200, await router.catalog({
        probe: true,
        concurrency: Number(input.concurrency || 4),
      }))
      return
    }
    if (url.pathname === '/api/export' && request.method === 'GET') {
      sendJson(response, 200, router.exportRegistry())
      return
    }
    if (url.pathname === '/api/reload' && request.method === 'POST') {
      sendJson(response, 200, router.reload())
      return
    }
    if (url.pathname === '/api/route' && request.method === 'POST') {
      const input = await jsonBody(request)
      sendJson(response, 200, await router.route(input.task, input))
      return
    }
    if (url.pathname === '/api/toggle' && request.method === 'POST') {
      const input = await jsonBody(request)
      sendJson(response, 200, router.setEnabled(input.kind, input.name, input.enabled === true, input.server))
      return
    }
    if (url.pathname === '/api/mcp/import' && request.method === 'POST') {
      sendJson(response, 200, router.importMcp(await jsonBody(request)))
      return
    }
    if (url.pathname === '/api/skills' && request.method === 'POST') {
      sendJson(response, 201, router.installSkill(await jsonBody(request)))
      return
    }
    if (url.pathname.startsWith('/api/skills/') && request.method === 'GET') {
      sendJson(response, 200, router.readSkill(decodeURIComponent(url.pathname.slice('/api/skills/'.length))))
      return
    }
    if (url.pathname === '/api/files' && request.method === 'GET') {
      sendJson(response, 200, router.listFiles(url.searchParams.get('path') || '.'))
      return
    }
    if (url.pathname === '/api/files/download' && request.method === 'GET') {
      const file = router.readFile(url.searchParams.get('path'), { encoding: 'base64', maxBytes: maxBodyBytes })
      const data = Buffer.from(file.content, 'base64')
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'content-disposition': `attachment; filename="${encodeURIComponent(String(file.path).split('/').at(-1) || 'download')}"`,
        'cache-control': 'no-store',
      })
      response.end(data)
      return
    }
    if (url.pathname === '/api/files/upload' && request.method === 'POST') {
      const data = await bodyBuffer(request)
      sendJson(response, 201, router.writeFile(url.searchParams.get('path'), data.toString('base64'), { encoding: 'base64' }))
      return
    }
    sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(response, Number(error?.statusCode || 400), { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, host, () => {
  process.stderr.write(`Capability Router: http://${host}:${port} (MCP: /mcp)\n`)
})

const shutdown = async () => {
  await router.shutdown()
  await new Promise(resolve => server.close(resolve))
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
