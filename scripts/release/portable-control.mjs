#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  ensureProductionSecrets,
  parseEnv,
  validateProductionEnv,
  verify as verifyProduction,
} from './production-control.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const ENV_PATH = join(ROOT, '.env')
const DATA_DIR = join(ROOT, '.openclaude-data')
const COMPOSE_FILES = [
  join(ROOT, 'docker-compose.agent-gateway.yml'),
  join(ROOT, 'docker-compose.production.yml'),
  join(ROOT, 'docker-compose.portable.yml'),
]
const COMPOSE_ARGS = COMPOSE_FILES.flatMap(file => ['-f', file])
const COMPOSE_PROFILE_ARGS = [...COMPOSE_ARGS, '--profile', 'workers']
const DEFAULT_MODEL = 'qwen3:1.7b'
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text:latest'
const REQUIRED_TELEGRAM_REPOSITORY_FILES = [
  'integrations/telegram-mcp/Dockerfile',
  'integrations/telegram-mcp/main.py',
  'integrations/telegram-mcp/web_app.py',
  'integrations/telegram-mcp/skills/telegram-mcp-operations/SKILL.md',
  'integrations/telegram-mcp/skills/maton-api-gateway/SKILL.md',
  'integrations/telegram-mcp/skills/vpromotions/SKILL.md',
  'integrations/telegram-mcp/skills/twiboost/SKILL.md',
  'integrations/telegram-mcp/TWIBOOST.md',
  'integrations/telegram-mcp/maton skills for telegram/SKILL.md',
  'src/skills/bundled/telegramMcp.ts',
]

export function portableDirectories(root = ROOT) {
  const data = join(root, '.openclaude-data')
  return [
    data,
    join(data, 'config'),
    join(data, 'codex'),
    join(data, 'telegram-mcp'),
    join(data, 'camofox'),
    join(data, 'hindsight'),
    join(data, 'openrag'),
    join(data, 'openrag-workspace'),
  ]
}

export function hasRequiredTelegramRepositoryFiles(root = ROOT) {
  return REQUIRED_TELEGRAM_REPOSITORY_FILES.every(path =>
    existsSync(join(root, path)))
}

export function renderPortableDefaults() {
  return [
    '# Portable OpenClaude defaults. Secrets are appended during initialization.',
    'OPENCLAUDE_HOST_CONFIG_DIR=./.openclaude-data/config',
    'OPENCLAUDE_HOST_CODEX_DIR=./.openclaude-data/codex',
    'OPENCLAUDE_HOST_TELEGRAM_MCP_DIR=./.openclaude-data/telegram-mcp',
    'OPENCLAUDE_DOCKER_PROVIDER=ollama',
    'OPENCLAUDE_DOCKER_BASE_URL=http://openclaude-ollama:11434/v1',
    `OPENCLAUDE_DOCKER_MODEL=${DEFAULT_MODEL}`,
    `OPENCLAUDE_BOOTSTRAP_OLLAMA_MODEL=${DEFAULT_MODEL}`,
    `OPENCLAUDE_BOOTSTRAP_EMBEDDING_MODEL=${DEFAULT_EMBEDDING_MODEL}`,
    'OPENCLAUDE_OPENRAG_ENABLED=0',
    'OPENCLAUDE_OPENRAG_VERSION=0.5.1',
    'OPENCLAUDE_OPENRAG_REPO_DIR=./.openclaude-data/openrag',
    'OPENCLAUDE_OPENRAG_WORKSPACE_DIR=./.openclaude-data/openrag-workspace',
    'OPENCLAUDE_OPENRAG_LLM_PROVIDER=ollama',
    `OPENCLAUDE_OPENRAG_LLM_MODEL=${DEFAULT_MODEL}`,
    'OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER=ollama',
    `OPENCLAUDE_OPENRAG_EMBEDDING_MODEL=${DEFAULT_EMBEDDING_MODEL}`,
    'OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT=http://openclaude-ollama:11434',
    'OPENCLAUDE_DOCKER_OPENRAG_URL=http://openrag-frontend:3000',
    'OPENCLAUDE_DOCKER_HINDSIGHT_URL=http://openclaude-hindsight:8888',
    'OPENCLAUDE_SHARED_DOCKER_NETWORK=openclaude_default',
    'OPENCLAUDE_ROUTER_AUTO_AUTH=0',
    'OMNIROUTE_REQUIRE_API_KEY=false',
    'OPENCLAUDE_DOCKER_TELEGRAM_ENABLED=0',
    '',
  ].join('\n')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env || process.env,
    timeout: options.timeoutMs || 2 * 60 * 60 * 1000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture
      ? String(result.stderr || result.stdout || '').trim()
      : ''
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  return String(result.stdout || '').trim()
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: 15_000,
    windowsHide: true,
  })
  return result.status === 0
}

function composeSupportsOverride() {
  const result = spawnSync('docker', ['compose', 'version', '--short'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.status !== 0) return false
  const [major = 0, minor = 0, patch = 0] = String(result.stdout)
    .trim()
    .replace(/^v/iu, '')
    .split('.')
    .map(value => Number.parseInt(value, 10) || 0)
  return major > 2 ||
    (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)))
}

function dockerCompose(args, options = {}) {
  return run('docker', ['compose', ...COMPOSE_PROFILE_ARGS, ...args], options)
}

function readEnv() {
  return existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {}
}

export function upsertEnvValue(text, name, value) {
  const line = `${name}=${value}`
  const pattern = new RegExp(`^${name}=.*$`, 'mu')
  if (pattern.test(text)) return text.replace(pattern, line)
  return `${text.trimEnd()}\n${line}\n`
}

function setProjectEnvValue(name, value) {
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  writeFileSync(ENV_PATH, upsertEnvValue(current, name, value), { mode: 0o600 })
}

export function initializePortableLayout(root = ROOT) {
  for (const directory of portableDirectories(root)) {
    mkdirSync(directory, { recursive: true })
  }
  const envPath = join(root, '.env')
  const created = !existsSync(envPath)
  if (created) {
    writeFileSync(envPath, renderPortableDefaults(), { mode: 0o600 })
  }
  return { created, envPath }
}

function ensureOpenRagSecrets() {
  const env = readEnv()
  const additions = []
  if (!env.OPENCLAUDE_OPENRAG_OPENSEARCH_PASSWORD) {
    additions.push(['OPENCLAUDE_OPENRAG_OPENSEARCH_PASSWORD', cryptoSecret()])
  }
  if (!env.OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER) {
    additions.push(['OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER', 'openclaude'])
  }
  if (!env.OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER_PASSWORD) {
    additions.push(['OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER_PASSWORD', cryptoSecret()])
  }
  for (const [name, value] of additions) setProjectEnvValue(name, value)
}

function cryptoSecret() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
    .reduce((result, value) => result + value.toString(16).padStart(2, '0'), '')
}

export function initialize() {
  const result = initializePortableLayout()
  ensureProductionSecrets()
  ensureOpenRagSecrets()
  console.log(
    result.created
      ? `Portable state initialized in ${DATA_DIR}`
      : `Portable state already exists in ${DATA_DIR}; existing .env was preserved`,
  )
  return result
}

function runtimeEnv(overrides = {}) {
  const env = readEnv()
  const composeProject = env.OPENCLAUDE_COMPOSE_PROJECT_NAME || 'openclaude'
  const sharedNetwork =
    env.OPENCLAUDE_SHARED_DOCKER_NETWORK || `${composeProject}_default`
  return {
    ...process.env,
    ...env,
    OPENCLAUDE_HINDSIGHT_HOME: join(DATA_DIR, 'hindsight-source'),
    OPENCLAUDE_CAMOFOX_HOME: join(DATA_DIR, 'camofox'),
    HINDSIGHT_DATA_DIR: join(DATA_DIR, 'hindsight'),
    OPENCLAUDE_OPENRAG_REPO_DIR: join(DATA_DIR, 'openrag'),
    OPENCLAUDE_OPENRAG_WORKSPACE_DIR: join(DATA_DIR, 'openrag-workspace'),
    OPENCLAUDE_SHARED_DOCKER_NETWORK: sharedNetwork,
    OPENCLAUDE_OPENRAG_DOCKER_NETWORK: sharedNetwork,
    HINDSIGHT_DOCKER_NETWORK: sharedNetwork,
    OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT:
      env.OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT || 'http://openclaude-ollama:11434',
    OPENCLAUDE_DOCKER_OPENRAG_URL:
      env.OPENCLAUDE_DOCKER_OPENRAG_URL || 'http://openrag-frontend:3000',
    OPENCLAUDE_DOCKER_HINDSIGHT_URL:
      env.OPENCLAUDE_DOCKER_HINDSIGHT_URL || 'http://openclaude-hindsight:8888',
    ...overrides,
  }
}

function validatePortableEnvironment() {
  const env = readEnv()
  const errors = validateProductionEnv({ ...process.env, ...env })
  if (errors.length) {
    throw new Error(`Portable environment is invalid:\n- ${errors.join('\n- ')}`)
  }
  dockerCompose(['config', '--quiet'], { env: runtimeEnv() })
}

function startCore() {
  initialize()
  validatePortableEnvironment()
  dockerCompose(['up', '-d', '--build', '--remove-orphans', '--wait'], {
    env: runtimeEnv(),
  })
}

function runNodeScript(script, args, env = runtimeEnv()) {
  run(process.execPath, [join(ROOT, script), ...args], { env })
}

function startHindsight() {
  const env = runtimeEnv({
    HINDSIGHT_API_LLM_PROVIDER: 'ollama',
    HINDSIGHT_API_LLM_MODEL:
      readEnv().OPENCLAUDE_BOOTSTRAP_OLLAMA_MODEL || DEFAULT_MODEL,
    HINDSIGHT_API_LLM_BASE_URL: 'http://openclaude-ollama:11434',
  })
  runNodeScript('scripts/release/hindsight-control.mjs', ['docker-up'], env)
}

async function endpointReady(url, timeoutMs = 2_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForEndpoint(url, timeoutMs = 120_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await endpointReady(url, 5_000)) return
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`${url} did not become ready within ${timeoutMs}ms`)
}

async function startCamofox() {
  const url = 'http://127.0.0.1:9377'
  if (await endpointReady(`${url}/health`)) return
  const env = runtimeEnv({ CAMOFOX_URL: url, CAMOFOX_PORT: '9377' })
  runNodeScript('scripts/release/camofox-control.mjs', ['install'], env)
  const child = spawn(
    process.execPath,
    [join(ROOT, 'scripts/release/camofox-control.mjs'), 'start'],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    },
  )
  child.unref()
  writeFileSync(join(DATA_DIR, 'camofox.pid'), `${child.pid}\n`)
  await waitForEndpoint(`${url}/health`)
}

function startOpenRag() {
  if (!commandAvailable('git')) {
    throw new Error('Git is required to install the pinned OpenRAG source')
  }
  runNodeScript('scripts/release/run-platform-script.mjs', ['install-openrag'])
  setProjectEnvValue('OPENCLAUDE_OPENRAG_ENABLED', '1')
  runNodeScript('scripts/release/run-platform-script.mjs', ['openrag-docker-up'])
}

function verifyFullContainerConnectivity() {
  const script = [
    "const checks = [['Hindsight', process.env.HINDSIGHT_URL + '/docs'], ['OpenRAG', process.env.OPENRAG_URL + '/']];",
    'for (const [name, url] of checks) {',
    '  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });',
    "  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status} from ${url}`);",
    '}',
    "console.log('Full-stack container connectivity: OK');",
  ].join('\n')
  dockerCompose(
    ['exec', '-T', 'openclaude-agent', 'node', '--input-type=module', '-e', script],
    { env: runtimeEnv(), timeoutMs: 60_000 },
  )
}

export async function start(options = {}) {
  startCore()
  if (options.full) {
    startHindsight()
    await startCamofox()
    startOpenRag()
  }
  await verifyProduction({
    composeArgs: ['compose', ...COMPOSE_PROFILE_ARGS],
  })
  if (options.full) {
    runNodeScript('scripts/release/hindsight-control.mjs', ['test'])
    runNodeScript('scripts/release/camofox-control.mjs', ['test'])
    verifyFullContainerConnectivity()
  }
  printEndpoints()
}

function stopOpenRag() {
  if (!existsSync(join(DATA_DIR, 'openrag'))) return
  runNodeScript('scripts/release/run-platform-script.mjs', ['openrag-docker-down'])
}

function stopCamofox() {
  const pidPath = join(DATA_DIR, 'camofox.pid')
  if (!existsSync(pidPath)) return
  const pid = Number(readFileSync(pidPath, 'utf8').trim())
  if (Number.isInteger(pid) && pid > 0) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // The process may already be stopped.
      }
    }
  }
  rmSync(pidPath, { force: true })
}

export function stop(options = {}) {
  if (options.full) {
    stopOpenRag()
    setProjectEnvValue('OPENCLAUDE_OPENRAG_ENABLED', '0')
    runNodeScript('scripts/release/hindsight-control.mjs', ['docker-down'])
    stopCamofox()
  }
  dockerCompose(['down', '--remove-orphans'], { env: runtimeEnv() })
}

export function importCodex(source = join(homedir(), '.codex')) {
  initializePortableLayout()
  const target = join(DATA_DIR, 'codex')
  const copied = []
  for (const name of ['auth.json', 'models_cache.json']) {
    const from = join(resolve(source), name)
    if (!existsSync(from)) continue
    mkdirSync(dirname(join(target, name)), { recursive: true })
    copyFileSync(from, join(target, name))
    copied.push(name)
  }
  if (!copied.includes('auth.json')) {
    throw new Error(`Codex auth.json was not found in ${resolve(source)}`)
  }
  console.log(`Imported Codex credentials: ${copied.join(', ')}`)
}

export function doctor() {
  const checks = [
    ['Node.js 22+', Number(process.versions.node.split('.')[0]) >= 22, true],
    ['Docker', commandAvailable('docker'), true],
    ['Docker Compose 2.24.4+', composeSupportsOverride(), true],
    ['Git (required for full OpenRAG)', commandAvailable('git'), true],
    [
      'Bundled Telegram MCP and skills',
      hasRequiredTelegramRepositoryFiles(),
      true,
    ],
    ['uv (auto-installed for full OpenRAG)', commandAvailable('uv'), false],
  ]
  if (existsSync(ENV_PATH)) {
    checks.push(['Production secrets', validateProductionEnv({
      ...process.env,
      ...readEnv(),
    }).length === 0, true])
  }
  for (const [name, ok, required] of checks) {
    console.log(`${ok ? 'OK' : required ? 'MISSING' : 'OPTIONAL'}  ${name}`)
  }
  if (checks.some(([, ok, required]) => required && !ok)) process.exitCode = 1
}

function printEndpoints() {
  console.log(`
OpenClaude is ready:
  OpenWebUI:    http://127.0.0.1:8080
  Tool Router: http://127.0.0.1:8642/router
  File Manager:http://127.0.0.1:8642/files
  OmniRoute:   http://127.0.0.1:20128
  Telegram MCP:http://127.0.0.1:19765
  Hindsight:   http://127.0.0.1:9999
  OpenRAG:     http://127.0.0.1:3000
`)
}

function help() {
  console.log(`Portable OpenClaude

Usage:
  node scripts/release/portable-control.mjs init
  node scripts/release/portable-control.mjs doctor
  node scripts/release/portable-control.mjs import-codex [source-dir]
  node scripts/release/portable-control.mjs up [--full]
  node scripts/release/portable-control.mjs down [--full]
  node scripts/release/portable-control.mjs verify
  node scripts/release/portable-control.mjs status

The default up command starts the agent, OpenWebUI, Tool Router, File Manager,
OmniRoute, SearXNG, Telegram MCP, workers, and local Ollama. --full also starts
Hindsight and the pinned OpenRAG stack.`)
}

async function main() {
  const command = process.argv[2] || 'help'
  const full = process.argv.includes('--full')
  if (command === 'help' || command === '--help' || command === '-h') help()
  else if (command === 'init') initialize()
  else if (command === 'doctor') doctor()
  else if (command === 'import-codex') importCodex(process.argv[3])
  else if (command === 'up') await start({ full })
  else if (command === 'down') stop({ full })
  else if (command === 'verify') {
    await verifyProduction({
      composeArgs: ['compose', ...COMPOSE_PROFILE_ARGS],
    })
  }
  else if (command === 'status') {
    dockerCompose(['ps'], { env: runtimeEnv() })
    printEndpoints()
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)
if (isDirectRun) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
