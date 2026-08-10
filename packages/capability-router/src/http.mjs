#!/usr/bin/env node

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

function sendText(response, status, value, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(value))
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store' })
  response.end(body)
}

function authorized(request) {
  if (!apiKey) return true
  const authorization = request.headers.authorization || ''
  return authorization === `Bearer ${apiKey}`
    || request.headers['x-capability-router-key'] === apiKey
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
      sendText(response, 200, buildUi(), 'text/html; charset=utf-8')
      return
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, service: 'capability-router', version: '1.0.0' })
      return
    }
    if ((url.pathname.startsWith('/api/') || url.pathname === '/mcp') && !authorized(request)) {
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
      sendJson(response, 200, router.setEnabled(input.kind, input.name, input.enabled === true))
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
