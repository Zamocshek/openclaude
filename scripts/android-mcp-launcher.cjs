#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { delimiter, join } = require('node:path')

const ANDROID_MCP_VERSION = '0.2.0'

function readActiveProfile() {
  const stateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  if (!stateDir) return undefined
  const path = join(stateDir, 'android', 'devices.json')
  if (!existsSync(path)) return undefined
  try {
    const registry = JSON.parse(readFileSync(path, 'utf8'))
    const alias = String(registry.activeAlias || '').trim()
    const profile = registry.profiles?.[alias]
    if (!profile || profile.enabled === false) return undefined
    const serial = String(profile.serial || '').trim()
    const connection = String(profile.connection || 'auto').trim()
    if (!serial || !['auto', 'usb', 'wifi'].includes(connection)) return undefined
    return { alias, serial, connection }
  } catch {
    return undefined
  }
}

function executableExists(command) {
  if (!command) return false
  if (command.includes('/') || command.includes('\\')) return existsSync(command)
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT')
      .split(';')
      .filter(Boolean)
    : ['']
  return String(process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .some(directory =>
      extensions.some(extension =>
        existsSync(join(directory, `${command}${extension}`)),
      ),
    )
}

function resolveLaunch() {
  const override = String(process.env.ANDROID_MCP_BIN || '').trim()
  if (override) return { command: override, args: [] }
  const uvx = process.platform === 'win32' ? 'uvx.exe' : 'uvx'
  if (executableExists(uvx)) {
    return {
      command: uvx,
      args: [
        '--python',
        '3.13',
        '--from',
        `android-mcp==${ANDROID_MCP_VERSION}`,
        'android-mcp',
      ],
    }
  }
  return { command: 'android-mcp', args: [] }
}

function cleanEnvironment() {
  const env = { ...process.env }
  for (const key of [
    'ADB_SERVER_SOCKET',
    'ANDROID_MCP_DEVICE',
    'ANDROID_MCP_HOST',
    'ANDROID_MCP_CONNECTION',
  ]) {
    if (!String(env[key] || '').trim()) delete env[key]
  }
  return env
}

const launch = resolveLaunch()
const env = cleanEnvironment()
const active = readActiveProfile()
if (!env.ANDROID_MCP_DEVICE && active) {
  env.ANDROID_MCP_DEVICE = active.serial
  env.ANDROID_MCP_CONNECTION = active.connection
}
if (!env.SCREENSHOT_QUANTIZED) {
  env.SCREENSHOT_QUANTIZED = 'true'
}

const child = spawn(launch.command, [...launch.args, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  windowsHide: true,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.once('error', error => {
  console.error(
    `[android-mcp] Failed to start ${launch.command}: ${error.message}`,
  )
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
