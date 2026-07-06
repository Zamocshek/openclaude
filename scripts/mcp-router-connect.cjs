#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const net = require('node:net')
const { resolve } = require('node:path')

function hydrateEnvFromDotEnv() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const envText = readFileSync(envPath, 'utf8')
  const dockerRuntime = /^(1|true|yes|on)$/i.test(
    process.env.OPENCLAUDE_DOCKER_RUN_AS_ROOT || '',
  )
  const preferDotEnv = new Set(
    dockerRuntime
      ? ['MCPR_TOKEN', 'MCPR_PROJECT']
      : ['MCPR_TOKEN', 'MCPR_HOST', 'MCPR_PORT', 'MCPR_PROJECT'],
  )
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (
      process.env[key] &&
      process.env[key] !== `\${${key}}` &&
      !preferDotEnv.has(key)
    ) {
      continue
    }
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '')
  }
}

function canOpenTcp(host, port, timeoutMs) {
  return new Promise(resolve_ => {
    const socket = new net.Socket()
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve_(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(Number(port), host)
  })
}

async function main() {
  hydrateEnvFromDotEnv()

  const host = process.env.MCPR_HOST || '127.0.0.1'
  const port = process.env.MCPR_PORT || '3282'
  const timeoutMs = Number(process.env.MCPR_CONNECT_TIMEOUT_MS || 1500)
  const reachable = await canOpenTcp(host, port, Number.isFinite(timeoutMs) ? timeoutMs : 1500)
  if (!reachable) {
    process.stderr.write(
      `[mcp-router] ${host}:${port} is not reachable; skipping MCP Router startup.\n`,
    )
    process.exit(1)
  }

  const connectArgs = [
    '-y',
    '@mcp_router/cli@latest',
    'connect',
    ...process.argv.slice(2),
  ]
  const npxCommand = process.platform === 'win32' ? 'cmd.exe' : 'npx'
  const args = process.platform === 'win32'
    ? ['/c', 'npx', ...connectArgs]
    : connectArgs

  const child = spawn(npxCommand, args, {
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })

  child.on('error', error => {
    process.stderr.write(`Failed to start MCP Router CLI: ${error.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

main().catch(error => {
  process.stderr.write(`[mcp-router] ${error?.stack || error?.message || error}\n`)
  process.exit(1)
})
