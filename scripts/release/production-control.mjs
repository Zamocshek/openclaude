#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..', '..')
const BASE_COMPOSE = join(ROOT, 'docker-compose.agent-gateway.yml')
const PROD_COMPOSE = join(ROOT, 'docker-compose.production.yml')
const ENV_PATH = join(ROOT, '.env')
const REPORTS_DIR = join(ROOT, 'reports')
const BACKUPS_DIR = join(ROOT, 'backups')
const COMPOSE_ARGS = ['compose', '-f', BASE_COMPOSE, '-f', PROD_COMPOSE]
const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost'])
export const PRODUCTION_BUILD_SERVICES = ['openclaude-agent', 'telegram-mcp']
export const REQUIRED_TELEGRAM_SKILLS = [
  'telegram-mcp-operations',
  'maton-api-gateway',
  'vpromotions',
]

export function parseEnv(text) {
  const result = {}
  for (const rawLine of String(text || '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const name = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[name] = value
  }
  return result
}

export function validateProductionEnv(env) {
  const errors = []
  const weakValues = new Set([
    '',
    '123456',
    'CHANGEME',
    'change-me',
    'sk_omniroute',
    'replace-me',
  ])
  for (const name of [
    'OPENCLAUDE_AGENT_API_KEY',
    'OPENCLAUDE_AGENT_INFERENCE_API_KEY',
    'OPENCLAUDE_AGENT_WORKER_1_API_KEY',
    'OPENCLAUDE_AGENT_WORKER_2_API_KEY',
    'OMNIROUTE_API_KEY',
    'OMNIROUTE_INITIAL_PASSWORD',
    'OMNIROUTE_STORAGE_ENCRYPTION_KEY',
    'OMNIROUTE_JWT_SECRET',
    'OMNIROUTE_API_KEY_SECRET',
    'OMNIROUTE_WS_BRIDGE_SECRET',
    'SEARXNG_SECRET',
    'SESSION_SECRET',
    'JWT_SIGNING_KEY',
    'OPENRAG_ENCRYPTION_KEY',
  ]) {
    if (weakValues.has(String(env[name] || '').trim())) {
      errors.push(`${name} must contain a generated production secret`)
    }
  }
  if (env.OPENCLAUDE_ROUTER_AUTO_AUTH !== '0') {
    errors.push('OPENCLAUDE_ROUTER_AUTO_AUTH must be 0 in production')
  }
  if (truthy(env.OPENCLAUDE_DOCKER_TELEGRAM_ENABLED)) {
    if (!env.OPENCLAUDE_DOCKER_TELEGRAM_BOT_TOKEN) {
      errors.push('Telegram is enabled but its bot token is missing')
    }
    if (
      !env.OPENCLAUDE_DOCKER_TELEGRAM_ALLOWED_CHAT_IDS &&
      !env.OPENCLAUDE_DOCKER_TELEGRAM_ALLOWED_USER_IDS
    ) {
      errors.push('Telegram is enabled without a chat or user allowlist')
    }
  }
  if (!truthy(env.OPENCLAUDE_ALLOW_PUBLIC_BIND)) {
    for (const name of [
      'OPENCLAUDE_AGENT_API_BIND_ADDRESS',
      'OPENCLAUDE_AGENT_WEB_BIND_ADDRESS',
      'OPENCLAUDE_AGENT_WORKER_BIND_ADDRESS',
      'OPENCLAUDE_OPEN_WEBUI_BIND_ADDRESS',
      'OPENCLAUDE_OLLAMA_BIND_ADDRESS',
      'OMNIROUTE_BIND_ADDRESS',
      'TELEGRAM_MCP_WEB_BIND_ADDRESS',
    ]) {
      const value = env[name]
      if (value && !LOOPBACKS.has(value)) {
        errors.push(`${name}=${value} is public; set OPENCLAUDE_ALLOW_PUBLIC_BIND=1 explicitly`)
      }
    }
  }
  return errors
}

function truthy(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || '').trim())
}

function readProductionEnv() {
  if (!existsSync(ENV_PATH)) throw new Error(`Missing ${ENV_PATH}`)
  return { ...process.env, ...parseEnv(readFileSync(ENV_PATH, 'utf8')) }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env || process.env,
    timeout: options.timeoutMs || 30 * 60 * 1000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture
      ? String(result.stderr || result.stdout || '').trim()
      : ''
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

function docker(args, options) {
  return run('docker', args, options)
}

function releaseIdentity() {
  const revision = run('git', ['rev-parse', 'HEAD'], { capture: true })
  return {
    revision,
    tag: `production-${revision.slice(0, 12)}`,
  }
}

function assertReleaseTreeClean() {
  const status = run('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude)Vladimir_Kuplevatskyi/**',
    ':(exclude)output/**',
    ':(exclude)backups/**',
  ], { capture: true })
  if (status) {
    throw new Error(
      `Production source has uncommitted changes; commit them before deployment:\n${status}`,
    )
  }
}

function releaseEnv(baseEnv, identity) {
  return {
    ...baseEnv,
    OPENCLAUDE_RELEASE_REVISION: identity.revision,
    OPENCLAUDE_RELEASE_TAG: identity.tag,
  }
}

export function preflight() {
  const env = readProductionEnv()
  const errors = validateProductionEnv(env)
  if (errors.length) {
    throw new Error(`Production preflight failed:\n- ${errors.join('\n- ')}`)
  }
  assertReleaseTreeClean()
  const identity = releaseIdentity()
  docker([...COMPOSE_ARGS, 'config', '--quiet'], {
    env: releaseEnv(env, identity),
  })
  console.log(`Production preflight passed for ${identity.revision.slice(0, 12)}`)
  return { env, identity }
}

async function requestOk(url, options = {}) {
  const signal = AbortSignal.timeout(options.timeoutMs || 15_000)
  const response = await fetch(url, {
    headers: options.key ? { Authorization: `Bearer ${options.key}` } : {},
    signal,
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response
}

async function requestJson(url, options = {}) {
  const response = await requestOk(url, options)
  return response.json()
}

export function validateRequiredTelegramCapabilities(skills, servers) {
  const errors = []
  const skillMap = new Map(
    (Array.isArray(skills) ? skills : []).map(skill => [skill.name, skill]),
  )
  for (const name of REQUIRED_TELEGRAM_SKILLS) {
    const skill = skillMap.get(name)
    if (!skill) errors.push(`required Telegram skill is missing: ${name}`)
    else if (skill.enabled === false) {
      errors.push(`required Telegram skill is disabled: ${name}`)
    }
  }

  const telegramMcp = (Array.isArray(servers) ? servers : [])
    .find(server => server.name === 'telegram-mcp')
  if (!telegramMcp) errors.push('required MCP server is missing: telegram-mcp')
  else {
    if (telegramMcp.enabled === false) {
      errors.push('required MCP server is disabled: telegram-mcp')
    }
    if (telegramMcp.transport !== 'http') {
      errors.push('telegram-mcp must use the http transport')
    }
    if (telegramMcp.target !== 'http://telegram-mcp:8766/mcp') {
      errors.push('telegram-mcp must target http://telegram-mcp:8766/mcp')
    }
  }
  return errors
}

export async function verify(options = {}) {
  const env = readProductionEnv()
  const apiPort = env.OPENCLAUDE_AGENT_API_HOST_PORT || '8642'
  const omniPort = env.OMNIROUTE_HOST_PORT || '20128'
  const webUiPort = env.OPENCLAUDE_OPEN_WEBUI_HOST_PORT || '8080'
  const telegramMcpPort = env.TELEGRAM_MCP_WEB_HOST_PORT || '18765'
  const searxngPort = env.OPENCLAUDE_SEARXNG_HOST_PORT || '18088'
  const ollamaPort = env.OPENCLAUDE_OLLAMA_HOST_PORT || '11434'
  await requestOk(`http://127.0.0.1:${apiPort}/ready`)
  await requestOk(`http://127.0.0.1:${apiPort}/v1/models`, {
    key: env.OPENCLAUDE_AGENT_INFERENCE_API_KEY,
  })
  const [skillsPayload, serversPayload] = await Promise.all([
    requestJson(`http://127.0.0.1:${apiPort}/api/skills`, {
      key: env.OPENCLAUDE_AGENT_API_KEY,
    }),
    requestJson(`http://127.0.0.1:${apiPort}/api/mcp/servers`, {
      key: env.OPENCLAUDE_AGENT_API_KEY,
    }),
  ])
  const telegramErrors = validateRequiredTelegramCapabilities(
    skillsPayload.data,
    serversPayload.data,
  )
  if (telegramErrors.length > 0) {
    throw new Error(
      `Required Telegram capabilities failed verification:\n- ${telegramErrors.join('\n- ')}`,
    )
  }
  await requestOk(`http://127.0.0.1:${omniPort}/v1/models`, {
    key: env.OMNIROUTE_API_KEY,
  })
  await requestOk(`http://127.0.0.1:${webUiPort}/`)
  await requestOk(`http://127.0.0.1:${telegramMcpPort}/`)
  await requestOk(`http://127.0.0.1:${searxngPort}/healthz`)
  await requestOk(`http://127.0.0.1:${ollamaPort}/api/tags`)

  if (
    env.HINDSIGHT_URL ||
    env.HINDSIGHT_API_PORT ||
    env.HINDSIGHT_API_LLM_PROVIDER
  ) {
    const hindsightPort = env.HINDSIGHT_API_PORT || '8888'
    const hindsightUiPort = env.HINDSIGHT_UI_PORT || '9999'
    await requestOk(`http://127.0.0.1:${hindsightPort}/docs`)
    await requestOk(`http://127.0.0.1:${hindsightUiPort}/`)
  }

  if (truthy(env.OPENCLAUDE_OPENRAG_ENABLED)) {
    const openragPort = env.OPENCLAUDE_OPENRAG_FRONTEND_PORT || '3000'
    const langflowPort = env.OPENCLAUDE_OPENRAG_LANGFLOW_PORT || '7860'
    const doclingPort = env.OPENCLAUDE_OPENRAG_DOCLING_PORT || '5001'
    await requestOk(`http://127.0.0.1:${openragPort}/`)
    await requestOk(`http://127.0.0.1:${langflowPort}/health`)
    await requestOk(`http://127.0.0.1:${doclingPort}/docs`)
  }

  const composeArgs = options.composeArgs || COMPOSE_ARGS
  const published = docker(
    [...composeArgs, 'ps', '--format', 'json'],
    { capture: true },
  )
  for (const line of published.split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line)
    if (row.State !== 'running') throw new Error(`${row.Service} is not running`)
    const publishers = Array.isArray(row.Publishers) ? row.Publishers : []
    for (const publisher of publishers) {
      const bind = String(publisher.URL || '')
      if (bind && !LOOPBACKS.has(bind)) {
        throw new Error(`${row.Service} publishes ${bind}:${publisher.PublishedPort}`)
      }
    }
  }
  console.log('Production verification passed')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function backup() {
  const env = readProductionEnv()
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const destination = join(BACKUPS_DIR, timestamp)
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const files = []
  for (const source of [
    ENV_PATH,
    join(homedir(), '.openclaude', 'agent-gateway.json'),
    join(ROOT, '.mcp.json'),
  ]) {
    if (!existsSync(source)) continue
    const target = join(destination, basename(source))
    copyFileSync(source, target)
    files.push(target)
  }

  const containerIds = docker([...COMPOSE_ARGS, 'ps', '-q'], {
    capture: true,
    env,
  }).split(/\r?\n/u).filter(Boolean)
  const volumes = new Set()
  for (const containerId of containerIds) {
    const names = docker([
      'inspect',
      '-f',
      '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}',
      containerId,
    ], { capture: true }).split(/\r?\n/u).filter(Boolean)
    for (const name of names) volumes.add(name)
  }
  for (const volume of volumes) {
    const archive = `${volume}.tar.gz`
    docker([
      'run',
      '--rm',
      '-v',
      `${volume}:/source:ro`,
      '-v',
      `${destination}:/backup`,
      'redis:8.6.2-alpine@sha256:c5e375abb885e6b2021c0377879e4890bf76f9065b8922ffc113f2b226b9fc17',
      'sh',
      '-c',
      `tar -czf /backup/${archive} -C /source .`,
    ])
    files.push(join(destination, archive))
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    files: files.map(path => ({
      name: basename(path),
      sha256: sha256(path),
    })),
  }
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  console.log(`Backup created: ${destination}`)
  return destination
}

export async function deploy() {
  const { env, identity } = preflight()
  const nextEnv = releaseEnv(env, identity)
  if (!truthy(env.OPENCLAUDE_SKIP_DEPLOY_BACKUP)) backup()
  docker([...COMPOSE_ARGS, 'build', ...PRODUCTION_BUILD_SERVICES], {
    env: nextEnv,
  })
  docker([...COMPOSE_ARGS, 'up', '-d', '--remove-orphans', '--wait'], {
    env: nextEnv,
  })
  await verify()
  mkdirSync(REPORTS_DIR, { recursive: true })
  writeFileSync(
    join(REPORTS_DIR, 'production-release.json'),
    `${JSON.stringify({
      deployedAt: new Date().toISOString(),
      ...identity,
    }, null, 2)}\n`,
  )
  console.log(`Deployed ${identity.tag}`)
}

export function ensureProductionSecrets() {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const env = parseEnv(existing)
  const additions = []
  const secretGenerators = {
    OPENCLAUDE_AGENT_API_KEY: () => `ocag_${randomBytes(32).toString('hex')}`,
    OPENCLAUDE_AGENT_INFERENCE_API_KEY: () => `ocag_${randomBytes(32).toString('hex')}`,
    OPENCLAUDE_AGENT_WORKER_1_API_KEY: () => `ocag_${randomBytes(32).toString('hex')}`,
    OPENCLAUDE_AGENT_WORKER_2_API_KEY: () => `ocag_${randomBytes(32).toString('hex')}`,
    OMNIROUTE_API_KEY: () => `ocag_${randomBytes(32).toString('hex')}`,
    OMNIROUTE_INITIAL_PASSWORD: () => randomBytes(24).toString('base64url'),
    OMNIROUTE_STORAGE_ENCRYPTION_KEY: () => randomBytes(32).toString('hex'),
    OMNIROUTE_JWT_SECRET: () => randomBytes(48).toString('base64url'),
    OMNIROUTE_API_KEY_SECRET: () => randomBytes(32).toString('hex'),
    OMNIROUTE_WS_BRIDGE_SECRET: () => randomBytes(32).toString('hex'),
    SEARXNG_SECRET: () => randomBytes(32).toString('hex'),
    SESSION_SECRET: () => randomBytes(32).toString('hex'),
    JWT_SIGNING_KEY: () => randomBytes(32).toString('hex'),
    OPENRAG_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  }
  for (const [name, generate] of Object.entries(secretGenerators)) {
    if (
      !env[name] ||
      ['123456', 'CHANGEME', 'change-me', 'sk_omniroute', 'replace-me']
        .includes(env[name])
    ) {
      additions.push(`${name}=${generate()}`)
    }
  }
  if (env.OPENCLAUDE_ROUTER_AUTO_AUTH !== '0') {
    additions.push('OPENCLAUDE_ROUTER_AUTO_AUTH=0')
  }
  if (additions.length) {
    writeFileSync(
      ENV_PATH,
      `${existing.trimEnd()}\n\n# Production hardening\n${additions.join('\n')}\n`,
      { mode: 0o600 },
    )
  }
  console.log(`Production secrets ensured (${additions.length} settings added)`)
}

async function main() {
  const command = process.argv[2] || 'preflight'
  if (command === 'init-secrets') ensureProductionSecrets()
  else if (command === 'preflight') preflight()
  else if (command === 'backup') backup()
  else if (command === 'verify') await verify()
  else if (command === 'deploy') await deploy()
  else throw new Error(`Unknown command: ${command}`)
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)
if (isDirectRun) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
