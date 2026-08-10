#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { CapabilityRouter } from './core.mjs'
import { createCapabilityMcpServer } from './server.mjs'

const router = new CapabilityRouter()
const server = createCapabilityMcpServer(router)
const transport = new StdioServerTransport()
let closing = false

const shutdown = async () => {
  if (closing) return
  closing = true
  await router.shutdown()
  await server.close().catch(() => {})
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))

await server.connect(transport)
const serverClose = transport.onclose
transport.onclose = () => {
  serverClose?.()
  void shutdown().finally(() => process.exit(0))
}
