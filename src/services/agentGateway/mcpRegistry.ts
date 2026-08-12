import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import {
  McpJsonConfigSchema,
  type McpJsonConfig,
  type McpServerConfig,
} from '../mcp/types.js'
import { getAgentGatewayStateDir } from './config.js'

const MCP_IMPORT_MAX_CHARS = 64 * 1024
const MCP_IMPORT_MAX_SERVERS = 20
const MCP_SERVER_NAME = /^[A-Za-z0-9._-]{1,40}$/u
const STDIO_KEYS = new Set(['type', 'command', 'args', 'env'])
const REMOTE_KEYS = new Set(['type', 'url', 'headers', 'headersHelper', 'oauth'])
const OAUTH_KEYS = new Set(['clientId', 'callbackPort', 'authServerMetadataUrl', 'xaa'])

export type ManagedMcpServerOrigin = 'base' | 'custom' | 'override'

type ManagedMcpStateEntry = {
  enabled: boolean
  origin: ManagedMcpServerOrigin
  config: McpServerConfig
}

type ManagedMcpState = {
  version: 1
  projectRoot: string
  servers: Record<string, ManagedMcpStateEntry>
}

export type ManagedMcpServer = ManagedMcpStateEntry & {
  name: string
  managed: boolean
}

export type McpConfigImportResult =
  | { ok: true; config: McpJsonConfig; normalizedNpxServers: string[] }
  | { ok: false; error: string }

export class McpRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpRegistryError'
  }
}

let registryMutationTail: Promise<void> = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function statePaths(projectRoot: string) {
  const root = resolve(projectRoot)
  const projectId = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const stateDir = join(getAgentGatewayStateDir(), 'mcp', projectId)
  return {
    root,
    basePath: join(root, '.mcp.json'),
    stateDir,
    statePath: join(stateDir, 'registry.json'),
    effectivePath: join(stateDir, 'effective.json'),
  }
}

function emptyState(projectRoot: string): ManagedMcpState {
  return { version: 1, projectRoot: resolve(projectRoot), servers: {} }
}

function parseConfigObject(value: unknown): McpJsonConfig {
  const result = McpJsonConfigSchema().safeParse(value)
  return result.success ? result.data : { mcpServers: {} }
}

function readJsonSync(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function parseState(value: unknown, projectRoot: string): ManagedMcpState {
  if (!isRecord(value) || !isRecord(value.servers)) return emptyState(projectRoot)
  const servers: Record<string, ManagedMcpStateEntry> = {}
  for (const [name, rawEntry] of Object.entries(value.servers)) {
    if (!MCP_SERVER_NAME.test(name) || !isRecord(rawEntry)) continue
    const origin = rawEntry.origin
    if (origin !== 'base' && origin !== 'custom' && origin !== 'override') continue
    const parsed = McpJsonConfigSchema().safeParse({
      mcpServers: { [name]: rawEntry.config },
    })
    if (!parsed.success) continue
    servers[name] = {
      enabled: rawEntry.enabled !== false,
      origin,
      config: parsed.data.mcpServers[name]!,
    }
  }
  return { version: 1, projectRoot: resolve(projectRoot), servers }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = registryMutationTail
  let release!: () => void
  registryMutationTail = new Promise<void>(resolveLock => {
    release = resolveLock
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  return (match?.[1] || trimmed).trim()
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) {
    throw new McpRegistryError(`${label} contains unsupported fields: ${unknown.join(', ')}`)
  }
}

function assertStringRecord(value: unknown, label: string): void {
  if (!isRecord(value)) throw new McpRegistryError(`${label} must be a string map`)
  const entries = Object.entries(value)
  if (entries.length > 64) throw new McpRegistryError(`${label} has too many entries`)
  for (const [key, entry] of entries) {
    if (!key || typeof entry !== 'string' || entry.length > 8192) {
      throw new McpRegistryError(`${label} must contain non-empty keys and string values`)
    }
  }
}

function validateServerConfig(name: string, raw: unknown): McpServerConfig {
  if (!isRecord(raw)) throw new McpRegistryError(`mcpServers.${name} must be an object`)
  const type = raw.type === undefined ? 'stdio' : raw.type

  if (type === 'stdio') {
    assertOnlyKeys(raw, STDIO_KEYS, `mcpServers.${name}`)
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      throw new McpRegistryError(`mcpServers.${name}.command must be a non-empty string`)
    }
    if (/[\0\r\n]/u.test(raw.command)) {
      throw new McpRegistryError(`mcpServers.${name}.command contains invalid characters`)
    }
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some(
        arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'),
      )) {
        throw new McpRegistryError(`mcpServers.${name}.args must be an array of safe strings`)
      }
    }
    if (raw.env !== undefined) assertStringRecord(raw.env, `mcpServers.${name}.env`)
  } else if (type === 'sse' || type === 'http' || type === 'ws') {
    assertOnlyKeys(raw, REMOTE_KEYS, `mcpServers.${name}`)
    if (typeof raw.url !== 'string') {
      throw new McpRegistryError(`mcpServers.${name}.url must be a URL string`)
    }
    let url: URL
    try {
      url = new URL(raw.url)
    } catch {
      throw new McpRegistryError(`mcpServers.${name}.url is invalid`)
    }
    const allowedProtocols = type === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:']
    if (!allowedProtocols.includes(url.protocol)) {
      throw new McpRegistryError(`mcpServers.${name}.url uses an invalid protocol`)
    }
    if (raw.headers !== undefined) assertStringRecord(raw.headers, `mcpServers.${name}.headers`)
    if (raw.headersHelper !== undefined && typeof raw.headersHelper !== 'string') {
      throw new McpRegistryError(`mcpServers.${name}.headersHelper must be a string`)
    }
    if (raw.oauth !== undefined) {
      if (!isRecord(raw.oauth)) throw new McpRegistryError(`mcpServers.${name}.oauth must be an object`)
      assertOnlyKeys(raw.oauth, OAUTH_KEYS, `mcpServers.${name}.oauth`)
    }
  } else {
    throw new McpRegistryError(
      `mcpServers.${name}.type must be stdio, sse, http, or ws`,
    )
  }

  const parsed = McpJsonConfigSchema().safeParse({ mcpServers: { [name]: raw } })
  if (!parsed.success) {
    throw new McpRegistryError(`mcpServers.${name} does not match the MCP schema`)
  }
  return parsed.data.mcpServers[name]!
}

function normalizeNpxConfig(config: McpServerConfig): {
  config: McpServerConfig
  normalized: boolean
} {
  if (!('command' in config) || !/^npx(?:\.cmd)?$/iu.test(config.command)) {
    return { config, normalized: false }
  }
  return {
    config: {
      ...config,
      command: 'node',
      args: ['scripts/run-npx-mcp.cjs', ...(config.args || [])],
    },
    normalized: true,
  }
}

export function parseMcpConfigImport(text: string): McpConfigImportResult | undefined {
  const jsonText = stripJsonFence(text)
  if (!jsonText.startsWith('{') || !/"mcpServers"\s*:/u.test(jsonText)) return undefined
  if (jsonText.length > MCP_IMPORT_MAX_CHARS) {
    return { ok: false, error: `MCP JSON exceeds ${MCP_IMPORT_MAX_CHARS} characters` }
  }

  try {
    const raw = JSON.parse(jsonText)
    if (!isRecord(raw)) throw new McpRegistryError('MCP JSON root must be an object')
    assertOnlyKeys(raw, new Set(['mcpServers']), 'MCP JSON root')
    if (!isRecord(raw.mcpServers)) {
      throw new McpRegistryError('mcpServers must be an object')
    }
    const entries = Object.entries(raw.mcpServers)
    if (entries.length === 0) throw new McpRegistryError('mcpServers cannot be empty')
    if (entries.length > MCP_IMPORT_MAX_SERVERS) {
      throw new McpRegistryError(`A single import can contain at most ${MCP_IMPORT_MAX_SERVERS} servers`)
    }

    const mcpServers: Record<string, McpServerConfig> = {}
    const normalizedNpxServers: string[] = []
    for (const [name, rawConfig] of entries) {
      if (!MCP_SERVER_NAME.test(name)) {
        throw new McpRegistryError(
          `Invalid server name "${name}"; use 1-40 letters, digits, dots, dashes, or underscores`,
        )
      }
      const normalized = normalizeNpxConfig(validateServerConfig(name, rawConfig))
      mcpServers[name] = normalized.config
      if (normalized.normalized) normalizedNpxServers.push(name)
    }
    return { ok: true, config: { mcpServers }, normalizedNpxServers }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function loadBaseConfig(projectRoot: string): Promise<McpJsonConfig> {
  return parseConfigObject(await readJson(statePaths(projectRoot).basePath))
}

async function loadState(projectRoot: string): Promise<ManagedMcpState> {
  const paths = statePaths(projectRoot)
  return parseState(await readJson(paths.statePath), paths.root)
}

export async function listManagedMcpServers(projectRoot: string): Promise<ManagedMcpServer[]> {
  const base = await loadBaseConfig(projectRoot)
  const state = await loadState(projectRoot)
  const names = new Set([...Object.keys(base.mcpServers), ...Object.keys(state.servers)])
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map(name => {
      const stateEntry = state.servers[name]
      if (stateEntry) return { name, managed: true, ...stateEntry }
      return {
        name,
        managed: false,
        enabled: true,
        origin: 'base' as const,
        config: base.mcpServers[name]!,
      }
    })
}

export async function importManagedMcpServers(
  projectRoot: string,
  config: McpJsonConfig,
): Promise<ManagedMcpServer[]> {
  return withRegistryLock(async () => {
    const paths = statePaths(projectRoot)
    const base = await loadBaseConfig(paths.root)
    const state = await loadState(paths.root)
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      state.servers[name] = {
        enabled: true,
        origin: base.mcpServers[name] ? 'override' : 'custom',
        config: serverConfig,
      }
    }
    await writeJsonAtomic(paths.statePath, state)
    return listManagedMcpServers(paths.root)
  })
}

export async function setManagedMcpServerEnabled(
  projectRoot: string,
  name: string,
  enabled: boolean,
): Promise<ManagedMcpServer[]> {
  return setManagedMcpServerGroupEnabled(projectRoot, [name], enabled)
}

export async function setManagedMcpServerGroupEnabled(
  projectRoot: string,
  names: readonly string[],
  enabled: boolean,
): Promise<ManagedMcpServer[]> {
  return withRegistryLock(async () => {
    const paths = statePaths(projectRoot)
    const base = await loadBaseConfig(paths.root)
    const state = await loadState(paths.root)
    const uniqueNames = [...new Set(names)]
    if (uniqueNames.length === 0) {
      throw new McpRegistryError('At least one MCP server name is required')
    }
    for (const name of uniqueNames) {
      if (!state.servers[name] && !base.mcpServers[name]) {
        throw new McpRegistryError(`MCP server not found: ${name}`)
      }
    }

    for (const name of uniqueNames) {
      const existing = state.servers[name]
      const baseConfig = base.mcpServers[name]
      if (existing) {
        if (existing.origin === 'base' && enabled) delete state.servers[name]
        else existing.enabled = enabled
      } else if (!enabled && baseConfig) {
        state.servers[name] = {
          enabled: false,
          origin: 'base',
          config: baseConfig,
        }
      }
    }
    await writeJsonAtomic(paths.statePath, state)
    return listManagedMcpServers(paths.root)
  })
}

export async function removeManagedMcpServer(
  projectRoot: string,
  name: string,
): Promise<ManagedMcpServer[]> {
  return withRegistryLock(async () => {
    const paths = statePaths(projectRoot)
    const base = await loadBaseConfig(paths.root)
    const state = await loadState(paths.root)
    const existing = state.servers[name]
    if (!existing) {
      if (base.mcpServers[name]) {
        throw new McpRegistryError(`Base MCP server ${name} can be disabled but not removed`)
      }
      throw new McpRegistryError(`MCP server not found: ${name}`)
    }
    if (existing.origin === 'base') {
      throw new McpRegistryError(`Base MCP server ${name} can be enabled but not removed`)
    }
    delete state.servers[name]
    await writeJsonAtomic(paths.statePath, state)
    return listManagedMcpServers(paths.root)
  })
}

export function resolveEffectiveMcpConfigPath(projectRoot: string): string | undefined {
  const paths = statePaths(projectRoot)
  const base = parseConfigObject(readJsonSync(paths.basePath))
  const state = parseState(readJsonSync(paths.statePath), paths.root)
  const hasState = Object.keys(state.servers).length > 0
  if (!hasState) return existsSync(paths.basePath) ? paths.basePath : undefined

  const mcpServers: Record<string, McpServerConfig> = { ...base.mcpServers }
  for (const [name, entry] of Object.entries(state.servers)) {
    if (!entry.enabled) {
      delete mcpServers[name]
    } else if (entry.origin !== 'base') {
      mcpServers[name] = entry.config
    }
  }

  mkdirSync(paths.stateDir, { recursive: true })
  const temporary = `${paths.effectivePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(temporary, paths.effectivePath)
  return paths.effectivePath
}

export function describeManagedMcpServer(server: ManagedMcpServer): {
  name: string
  enabled: boolean
  origin: ManagedMcpServerOrigin
  transport: string
  target: string
  envKeys: string[]
  headerKeys: string[]
} {
  const config = server.config as Record<string, unknown>
  const transport = typeof config.type === 'string' ? config.type : 'stdio'
  const args = Array.isArray(config.args) ? config.args.filter(arg => typeof arg === 'string') : []
  const target = transport === 'stdio'
    ? [String(config.command || ''), ...args.slice(0, 3).map(redactPotentialSecret)].join(' ')
    : redactUrl(String(config.url || ''))
  return {
    name: server.name,
    enabled: server.enabled,
    origin: server.origin,
    transport,
    target,
    envKeys: isRecord(config.env) ? Object.keys(config.env).sort() : [],
    headerKeys: isRecord(config.headers) ? Object.keys(config.headers).sort() : [],
  }
}

function redactPotentialSecret(value: string): string {
  return /(?:key|token|secret|password|bearer|sk-)/iu.test(value) ? '[REDACTED]' : value
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}
