#!/usr/bin/env node

const { existsSync } = require('node:fs')
const { resolve } = require('node:path')
const { spawn } = require('node:child_process')

const [modulePath, ...args] = process.argv.slice(2)

if (!modulePath) {
  console.error('Usage: run-project-mcp.cjs <module-path> [...args]')
  process.exit(2)
}

const candidates = [
  resolve('/app/node_modules', modulePath),
  resolve(__dirname, '..', 'node_modules', modulePath),
  resolve(process.cwd(), 'node_modules', modulePath),
]
const entrypoint = candidates.find((candidate) => existsSync(candidate))

if (!entrypoint) {
  console.error(
    `MCP package entrypoint not found: ${modulePath}. Run the project dependency install first.`,
  )
  process.exit(1)
}

const child = spawn(process.execPath, [entrypoint, ...args], {
  env: process.env,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`Unable to start MCP server ${modulePath}: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
