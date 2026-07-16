#!/usr/bin/env node

const { existsSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const { spawn } = require('node:child_process')

const candidates = [
  resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npx-cli.js'),
  process.env.APPDATA
    ? resolve(process.env.APPDATA, 'npm/node_modules/npm/bin/npx-cli.js')
    : '',
].filter(Boolean)
const npxCli = candidates.find((candidate) => existsSync(candidate))

if (!npxCli) {
  console.error('Unable to locate npm/bin/npx-cli.js for the imported MCP server.')
  process.exit(1)
}

const child = spawn(process.execPath, [npxCli, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`Unable to start npx MCP server: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
