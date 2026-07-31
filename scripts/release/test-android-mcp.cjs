#!/usr/bin/env node
'use strict'

const { existsSync } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { resolve } = require('node:path')

const REQUIRED_TOOLS = [
  'ListDevices',
  'ConnectDevice',
  'Device',
  'Snapshot',
  'ClickBySelector',
  'Click',
  'Type',
  'Press',
  'Swipe',
  'WaitForElement',
]
const TIMEOUT_MS = Number(
  process.env.OPENCLAUDE_ANDROID_MCP_TEST_TIMEOUT_MS || 180_000,
)

async function main() {
  const projectRoot = resolve(process.argv[2] || process.cwd())
  const launcher = [
    resolve('/app/scripts/android-mcp-launcher.cjs'),
    resolve(projectRoot, 'scripts/android-mcp-launcher.cjs'),
  ].find(candidate => existsSync(candidate))
  if (!launcher) throw new Error('Android MCP launcher is missing.')
  const device = findAuthorizedDevice()
  if (!device) {
    const checked = spawnSync(process.execPath, [launcher, '--help'], {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
    })
    if (checked.status !== 0) {
      throw new Error(
        `Android MCP installation check failed: ${
          checked.stderr || checked.error?.message || checked.status
        }`,
      )
    }
    console.log(
      'ANDROID_MCP_PREFLIGHT_OK package=0.2.0 devices=none live-tools=skipped',
    )
    return
  }

  const stateDir = await mkdtemp(
    resolve(tmpdir(), 'openclaude-android-mcp-test-'),
  )
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: projectRoot,
    env: {
      ...process.env,
      OPENCLAUDE_AGENT_GATEWAY_STATE_DIR: stateDir,
      ANDROID_MCP_DEVICE: device,
      ANDROID_MCP_HOST: '',
      ANDROID_MCP_CONNECTION: 'auto',
    },
    stderr: 'pipe',
  })
  const client = new Client({
    name: 'openclaude-android-mcp-preflight',
    version: '1.0.0',
  })
  try {
    await client.connect(transport, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const listed = await client.listTools(
      {},
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    const names = new Set(listed.tools.map(tool => tool.name))
    const missing = REQUIRED_TOOLS.filter(name => !names.has(name))
    if (missing.length > 0) {
      throw new Error(`Android MCP is missing tools: ${missing.join(', ')}`)
    }
    let summary = 'discovery-skipped'
    if (process.env.OPENCLAUDE_ANDROID_MCP_TEST_DISCOVER === '1') {
      const devices = await client.callTool(
        { name: 'ListDevices', arguments: {} },
        undefined,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      )
      if (devices.isError) {
        throw new Error('Android MCP ListDevices returned an error.')
      }
      summary = devices.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500)
    }
    console.log(
      `ANDROID_MCP_PREFLIGHT_OK tools=${names.size} devices=${summary || 'none'}`,
    )
  } finally {
    await client.close().catch(() => {})
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  }
}

function findAuthorizedDevice() {
  const command = String(process.env.ANDROID_ADB_COMMAND || 'adb').trim()
  const adbEnv = { ...process.env }
  if (!String(adbEnv.ADB_SERVER_SOCKET || '').trim()) {
    delete adbEnv.ADB_SERVER_SOCKET
  }
  const result = spawnSync(command, ['devices', '-l'], {
    env: adbEnv,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(
      `ADB discovery failed: ${result.stderr || result.error?.message || result.status}`,
    )
  }
  for (const rawLine of String(result.stdout || '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || /^list of devices attached$/iu.test(line)) continue
    const [serial, state] = line.split(/\s+/u)
    if (serial && state === 'device') return serial
  }
  return ''
}

main().catch(error => {
  console.error(
    `[android-mcp-preflight] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
})
