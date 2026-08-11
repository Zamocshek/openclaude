#!/usr/bin/env node

const { existsSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const configuredEntry = String(process.env.CAPABILITY_ROUTER_ENTRY || '').trim()
const candidates = [
  configuredEntry && resolve(configuredEntry),
  '/app/packages/capability-router/src/mcp.mjs',
  resolve(__dirname, '..', 'packages', 'capability-router', 'src', 'mcp.mjs'),
  resolve(process.cwd(), 'packages', 'capability-router', 'src', 'mcp.mjs'),
].filter(Boolean)
const entrypoint = candidates.find(candidate => existsSync(candidate))

if (!entrypoint) {
  console.error('Capability Router MCP entrypoint was not found')
  process.exit(1)
}

import(pathToFileURL(entrypoint).href).catch(error => {
  console.error(`Unable to start Capability Router MCP: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
