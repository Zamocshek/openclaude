#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const action = process.argv[2] || 'help'
const root = process.env.OPENCLAUDE_CAMOFOX_HOME || path.join(os.homedir(), '.openclaude', 'camofox-browser')
const pkgDir = path.join(root, 'node_modules', '@askjo', 'camofox-browser')
const serverJs = path.join(pkgDir, 'server.js')
const port = process.env.CAMOFOX_PORT || '9377'
const url = (process.env.CAMOFOX_URL || `http://localhost:${port}`).replace(/\/+$/, '')
const version = process.env.OPENCLAUDE_CAMOFOX_VERSION || '1.13.0'
const profileDir = process.env.CAMOFOX_PROFILE_DIR || path.join(os.homedir(), '.camofox', 'profiles')
const logsDir = path.join(root, 'logs')
const pidPath = path.join(root, 'camofox.pid')
const keepAliveMs =
  process.env.OPENCLAUDE_CAMOFOX_KEEPALIVE_MS ||
  String(7 * 24 * 60 * 60 * 1_000)

if (action === 'help' || action === '-h' || action === '--help') {
  console.log(`OpenClaude Camofox helper

Usage:
  node scripts/release/camofox-control.mjs install
  node scripts/release/camofox-control.mjs start
  node scripts/release/camofox-control.mjs start-daemon
  node scripts/release/camofox-control.mjs test

Environment:
  OPENCLAUDE_CAMOFOX_HOME=${root}
  CAMOFOX_PORT=${port}
  CAMOFOX_URL=${url}
  CAMOFOX_PROFILE_DIR=${profileDir}
  OPENCLAUDE_CAMOFOX_KEEPALIVE_MS=${keepAliveMs}
  CAMOFOX_ACCESS_KEY=optional-bearer-token
  OPENCLAUDE_CAMOFOX_VERSION=${version}
`)
  process.exit(0)
}

if (action === 'install') {
  await install()
} else if (action === 'start') {
  await start()
} else if (action === 'start-daemon') {
  await startDaemon()
} else if (action === 'test') {
  await test()
} else {
  console.error(`Unknown action: ${action}`)
  process.exit(2)
}

async function install() {
  await mkdir(root, { recursive: true })
  const packageJson = path.join(root, 'package.json')
  if (!existsSync(packageJson)) {
    await writeFile(packageJson, '{"private":true,"type":"commonjs"}\n', 'utf8')
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npmCmd, ['install', `@askjo/camofox-browser@${version}`], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status || 1)
  await ensureCamofoxRuntimePatches()
  await writeFile(path.join(root, '.installed-version'), `${version}\n`, 'utf8')
  console.log(`Camofox installed in ${root}`)
}

async function start() {
  if (!existsSync(serverJs)) {
    console.error(`Camofox is not installed in ${root}. Run install first.`)
    process.exit(1)
  }
  await ensureCamofoxRuntimePatches()

  const child = spawn(process.execPath, [serverJs], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAMOFOX_PORT: port,
      CAMOFOX_PROFILE_DIR: profileDir,
      SESSION_TIMEOUT_MS:
        process.env.SESSION_TIMEOUT_MS || keepAliveMs,
      TAB_INACTIVITY_MS:
        process.env.TAB_INACTIVITY_MS || keepAliveMs,
      BROWSER_IDLE_TIMEOUT_MS:
        process.env.BROWSER_IDLE_TIMEOUT_MS || keepAliveMs,
    },
  })

  child.on('exit', code => process.exit(code || 0))
}

async function startDaemon() {
  if (!existsSync(serverJs)) {
    console.error(`Camofox is not installed in ${root}. Run install first.`)
    process.exit(1)
  }
  await ensureCamofoxRuntimePatches()
  try {
    const health = await fetchJson('/health')
    if (health?.ok) {
      console.log(`Camofox is already running at ${url}.`)
      return
    }
  } catch {
    // Expected when the daemon is not running.
  }

  await mkdir(logsDir, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  const stdoutFd = openSync(path.join(logsDir, 'camofox.out.log'), 'a')
  const stderrFd = openSync(path.join(logsDir, 'camofox.err.log'), 'a')
  const child = spawn(process.execPath, [serverJs], {
    cwd: pkgDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: {
      ...process.env,
      CAMOFOX_PORT: port,
      CAMOFOX_PROFILE_DIR: profileDir,
      SESSION_TIMEOUT_MS:
        process.env.SESSION_TIMEOUT_MS || keepAliveMs,
      TAB_INACTIVITY_MS:
        process.env.TAB_INACTIVITY_MS || keepAliveMs,
      BROWSER_IDLE_TIMEOUT_MS:
        process.env.BROWSER_IDLE_TIMEOUT_MS || keepAliveMs,
    },
  })
  child.unref()
  closeSync(stdoutFd)
  closeSync(stderrFd)
  await writeFile(pidPath, `${child.pid}\n`, 'utf8')

  let lastError
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    try {
      const health = await fetchJson('/health')
      if (health?.ok) {
        console.log(`Camofox daemon started at ${url} (pid ${child.pid}).`)
        return
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Camofox daemon did not become healthy.')
}

async function test() {
  const headers = {}
  const bearer = process.env.CAMOFOX_ACCESS_KEY || process.env.CAMOFOX_API_KEY
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  const health = await fetchJson('/health', { headers })
  console.log(`health: ${JSON.stringify(health)}`)

  const created = await fetchJson('/tabs', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'openclaude-smoke',
      sessionKey: 'smoke',
      url: 'https://example.com',
    }),
  })
  console.log(`tab: ${JSON.stringify(created)}`)

  const tabId = created.tabId
  if (!tabId) throw new Error('Camofox did not return tabId')

  const params = new URLSearchParams({ userId: 'openclaude-smoke', format: 'text' })
  const snap = await fetchJson(`/tabs/${encodeURIComponent(tabId)}/snapshot?${params}`, { headers })
  const snapshot = String(snap.snapshot || snap).slice(0, 500)
  console.log(`snapshot: ${snapshot}`)

  await fetchJson(`/tabs/${encodeURIComponent(tabId)}`, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'openclaude-smoke' }),
  })
  await fetchJson('/sessions/openclaude-smoke', {
    method: 'DELETE',
    headers,
  })
  const safeUserDir = createHash('sha256')
    .update('openclaude-smoke')
    .digest('hex')
    .slice(0, 32)
  const storageStatePath = path.join(
    profileDir,
    safeUserDir,
    'storage-state.json',
  )
  const storageState = JSON.parse(await readFile(storageStatePath, 'utf8'))
  if (!Array.isArray(storageState.cookies)) {
    throw new Error(
      `Camofox persistence smoke test failed at ${storageStatePath}.`,
    )
  }
  console.log(`Camofox persistence verified at ${storageStatePath}.`)
}

async function ensureWindowsPluginLoader() {
  if (process.platform !== 'win32') return
  const loaderPath = path.join(pkgDir, 'lib', 'plugins.js')
  const source = await readFile(loaderPath, 'utf8')
  if (source.includes('import(pathToFileURL(indexPath).href)')) return

  const importBefore = "import { fileURLToPath } from 'url';"
  const importAfter =
    "import { fileURLToPath, pathToFileURL } from 'url';"
  const loadBefore = 'const mod = await import(indexPath);'
  const loadAfter =
    'const mod = await import(pathToFileURL(indexPath).href);'
  if (
    !source.includes(importBefore) ||
    !source.includes(loadBefore)
  ) {
    throw new Error(
      `Unsupported Camofox plugin loader at ${loaderPath}; refusing an unverified patch.`,
    )
  }

  await writeFile(
    loaderPath,
    source
      .replace(importBefore, importAfter)
      .replace(loadBefore, loadAfter),
    'utf8',
  )
  console.log('Patched the Camofox ESM plugin loader for Windows file URLs.')
}

async function ensureCamofoxRuntimePatches() {
  await ensureWindowsPluginLoader()
  await ensurePersistenceCheckpointEndpoint()
}

async function ensurePersistenceCheckpointEndpoint() {
  const pluginPath = path.join(pkgDir, 'plugins', 'persistence', 'index.js')
  const source = await readFile(pluginPath, 'utf8')
  if (source.includes("app.post('/sessions/:userId/checkpoint'")) return

  const contextBefore =
    'const { events, config, log } = ctx;'
  const contextAfter =
    'const { events, config, log, sessions, auth } = ctx;'
  const activeSessionsLine =
    'const activeSessions = new Map(); // userId -> context'
  const checkpointRoute = `${activeSessionsLine}

  // Persist refreshed cookies/localStorage without closing the browser session.
  app.post('/sessions/:userId/checkpoint', auth(), async (req, res) => {
    const userId = String(req.params.userId);
    const context =
      activeSessions.get(userId) || sessions.get(userId)?.context;
    if (!context) {
      return res.status(404).json({
        error: \`No active session for userId="\${userId}"\`,
      });
    }
    const result = await checkpoint(userId, context, 'api_checkpoint');
    if (!result?.persisted) {
      return res.status(500).json({ error: 'Storage checkpoint failed' });
    }
    return res.json({ ok: true, userId });
  });`
  if (
    !source.includes(contextBefore) ||
    !source.includes(activeSessionsLine)
  ) {
    throw new Error(
      `Unsupported Camofox persistence plugin at ${pluginPath}; refusing an unverified patch.`,
    )
  }

  await writeFile(
    pluginPath,
    source
      .replace(contextBefore, contextAfter)
      .replace(activeSessionsLine, checkpointRoute),
    'utf8',
  )
  console.log('Added non-closing Camofox session checkpoints.')
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${url}${pathname}`, options)
  const text = await response.text()
  let data = text
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = text
  }
  if (!response.ok) {
    const message = data?.error || data?.message || text || response.statusText
    throw new Error(`Camofox ${response.status}: ${message}`)
  }
  return data
}
