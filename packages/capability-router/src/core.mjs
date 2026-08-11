import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DEFAULT_STATE = {
  schemaVersion: 1,
  disabledServers: [],
  disabledSkills: [],
  customServers: {},
}

const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)/iu
const ENV_REFERENCE_RE = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/u
const ROUTING_STOP_WORDS = new Set([
  'and', 'are', 'for', 'from', 'into', 'its', 'the', 'this', 'that', 'use', 'using', 'with',
  'или', 'для', 'как', 'это', 'этот', 'эта', 'эти', 'из', 'на', 'по', 'при', 'с', 'со', 'и', 'в', 'во',
])

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function replaceFileAtomic(temporary, target) {
  try {
    renameSync(temporary, target)
  } catch (error) {
    if (process.platform !== 'win32' || !existsSync(target)) {
      rmSync(temporary, { force: true })
      throw error
    }
    rmSync(target)
    renameSync(temporary, target)
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  replaceFileAtomic(temporary, path)
}

function normalizeName(value, label = 'name') {
  const name = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) {
    throw new Error(`${label} must match ^[a-z0-9][a-z0-9._-]{0,127}$`)
  }
  return name
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : []
}

function tokenize(value) {
  return new Set(
    String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu)
      ?.filter(token => token.length > 1 && !ROUTING_STOP_WORDS.has(token)) || [],
  )
}

function overlapScore(task, item) {
  const taskText = String(task || '').normalize('NFKC').toLocaleLowerCase()
  const taskTokens = tokenize(taskText)
  const weighted = [
    [item.name, 10],
    [item.description, 3],
    [stringArray(item.tags).join(' '), 6],
    [stringArray(item.intents).join(' '), 7],
  ]
  let score = 0
  for (const [text, weight] of weighted) {
    const normalized = String(text || '').normalize('NFKC').toLocaleLowerCase()
    if (normalized && taskText.includes(normalized)) score += weight * 2
    for (const token of tokenize(normalized)) if (taskTokens.has(token)) score += weight
  }
  return score
}

function envReferences(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) envReferences(item, output)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) envReferences(item, output)
  } else if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/gu)) output.add(match[1])
  }
  return output
}

function expandEnvironment(value, environment, missing) {
  if (Array.isArray(value)) return value.map(item => expandEnvironment(item, environment, missing))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvironment(item, environment, missing)]))
  }
  if (typeof value !== 'string') return value
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/gu, (match, name) => {
    const resolved = environment[name]
    if (resolved === undefined || resolved === '') {
      missing.add(name)
      return match
    }
    return resolved
  })
}

function metadataByName(raw) {
  const entries = Array.isArray(raw?.servers)
    ? raw.servers.map(server => [server.name, server])
    : Object.entries(raw?.servers || {})
  return new Map(entries.filter(([name]) => name).map(([name, value]) => [String(name), value || {}]))
}

function serverEntries(raw) {
  if (Array.isArray(raw?.servers)) return raw.servers.map(server => [server.name, server])
  const candidates = raw?.mcpServers || raw?.mcp?.servers || raw?.mcp || raw?.servers || {}
  return Array.isArray(candidates)
    ? candidates.map(server => [server.name, server])
    : Object.entries(candidates)
}

function normalizeServer(nameValue, raw, metadata = {}) {
  const name = normalizeName(nameValue, 'server name')
  if (!raw || typeof raw !== 'object') throw new Error(`MCP server ${name} must be an object`)
  const commandArray = Array.isArray(raw.command) ? raw.command.map(String) : undefined
  const command = commandArray?.[0] || (typeof raw.command === 'string' ? raw.command : undefined)
  const args = commandArray?.slice(1) || stringArray(raw.args)
  const url = typeof raw.url === 'string' ? raw.url.trim() : undefined
  if (!command && !url) throw new Error(`MCP server ${name} requires command or url`)
  const allowedTools = stringArray(raw.allowedTools || metadata.allowedTools)
  const blockedTools = stringArray(raw.blockedTools || metadata.blockedTools)
  return {
    name,
    transport: command ? 'stdio' : 'http',
    enabled: raw.enabled !== false && raw.disabled !== true && metadata.enabled !== false,
    description: String(raw.description || metadata.description || `${name} MCP server`),
    tags: stringArray(raw.tags || metadata.tags),
    intents: stringArray(raw.intents || metadata.intents),
    ...(command ? { command, args } : { url }),
    ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
    ...(raw.env || raw.environment ? { env: { ...(raw.env || raw.environment) } } : {}),
    ...(raw.headers || raw.http_headers ? { headers: { ...(raw.headers || raw.http_headers) } } : {}),
    ...(allowedTools.length ? { allowedTools } : {}),
    ...(blockedTools.length ? { blockedTools } : {}),
  }
}

function assertPortableSecrets(server) {
  for (const [scope, values] of [['env', server.env], ['headers', server.headers]]) {
    for (const [key, value] of Object.entries(values || {})) {
      if (!SECRET_KEY_RE.test(key) || typeof value !== 'string' || !value.trim()) continue
      const exactReference = ENV_REFERENCE_RE.test(value.trim())
      const embeddedReference = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}/u.test(value)
      if (!exactReference && !embeddedReference) {
        throw new Error(`${server.name}.${scope}.${key} must use an environment reference such as \${${key}}`)
      }
    }
  }
}

function skillMetadata(directory) {
  const path = join(directory, 'SKILL.md')
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] || ''
  const readField = field => frontmatter.match(new RegExp(`^${field}:\\s*["']?([^\\r\\n"']+)`, 'mu'))?.[1]?.trim()
  let name
  try {
    name = normalizeName(readField('name') || basename(directory), 'skill name').replaceAll('.', '-')
  } catch {
    return undefined
  }
  return {
    name,
    description: readField('description') || `Instructions from ${name}`,
    path: directory,
    tags: stringArray(readField('tags')?.split(',').map(tag => tag.trim())),
  }
}

function discoverSkills(roots, maxDepth = 7) {
  const found = new Map()
  const visit = (directory, depth) => {
    if (depth > maxDepth || !existsSync(directory)) return
    const skill = skillMetadata(directory)
    if (skill) {
      if (!found.has(skill.name)) found.set(skill.name, skill)
      return
    }
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) visit(join(directory, entry.name), depth + 1)
    }
  }
  for (const root of roots) visit(root, 0)
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function inside(root, requested, allowMissing = true) {
  const rootPath = resolve(root)
  const candidate = resolve(rootPath, String(requested || '.'))
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Path escapes workspace: ${requested}`)
  }
  if (!allowMissing && !existsSync(candidate)) throw new Error(`Path does not exist: ${requested}`)
  let existing = candidate
  while (!existsSync(existing) && existing !== rootPath) existing = dirname(existing)
  const realRoot = realpathSync(rootPath)
  const realExisting = realpathSync(existing)
  if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`Path resolves outside workspace: ${requested}`)
  }
  return candidate
}

function resultText(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last < first) throw new Error('Semantic router returned no JSON object')
  return JSON.parse(cleaned.slice(first, last + 1))
}

export class CapabilityRouter {
  constructor(options = {}) {
    this.environment = options.environment || process.env
    this.workspaceRoot = resolve(options.workspaceRoot || this.environment.CAPABILITY_ROUTER_WORKSPACE_ROOT || process.cwd())
    this.registryPath = resolve(options.registryPath || this.environment.CAPABILITY_ROUTER_REGISTRY || join(this.workspaceRoot, 'capability-registry.json'))
    this.mcpConfigPath = resolve(options.mcpConfigPath || this.environment.CAPABILITY_ROUTER_MCP_CONFIG || join(this.workspaceRoot, '.mcp.json'))
    this.statePath = resolve(options.statePath || this.environment.CAPABILITY_ROUTER_STATE || join(homedir(), '.capability-router', 'state.json'))
    this.skillStoreRoot = resolve(options.skillStoreRoot || this.environment.CAPABILITY_ROUTER_SKILL_STORE || join(dirname(this.statePath), 'skills'))
    this.maxServers = Number(options.maxServers || this.environment.CAPABILITY_ROUTER_MAX_SERVERS || 4)
    this.maxTools = Number(options.maxTools || this.environment.CAPABILITY_ROUTER_MAX_TOOLS || 20)
    this.timeoutMs = Number(options.timeoutMs || this.environment.CAPABILITY_ROUTER_TIMEOUT_MS || 30_000)
    this.toolCacheTtlMs = Number(options.toolCacheTtlMs || this.environment.CAPABILITY_ROUTER_TOOL_CACHE_TTL_MS || 300_000)
    this.fetch = options.fetch || globalThis.fetch
    this.clients = new Map()
    this.connectionAttempts = new Map()
    this.serverSignatures = new Map()
    this.toolCache = new Map()
    this.skills = []
    this.skillRoots = []
    this.skillsLoaded = false
    this.reload({ skills: options.deferSkillDiscovery !== true })
  }

  reload(options = {}) {
    const registry = readJson(this.registryPath, { schemaVersion: 1, servers: {}, skillRoots: [] })
    const config = readJson(this.mcpConfigPath, { mcpServers: {} })
    this.state = { ...DEFAULT_STATE, ...readJson(this.statePath, DEFAULT_STATE) }
    const metadata = metadataByName(registry)
    const disabled = new Set(stringArray(this.state.disabledServers))
    const merged = new Map()
    for (const [name, raw] of [...serverEntries(config), ...Object.entries(this.state.customServers || {})]) {
      if (!name || name === 'capability-router') continue
      const server = normalizeServer(name, raw, metadata.get(String(name)) || {})
      assertPortableSecrets(server)
      server.enabled = server.enabled && !disabled.has(server.name)
      merged.set(server.name, server)
    }
    const signatures = new Map(
      [...merged].map(([name, server]) => [name, JSON.stringify(server)]),
    )
    const staleConnections = [...this.clients.keys()].filter(name =>
      !merged.get(name)?.enabled
      || this.serverSignatures.get(name) !== signatures.get(name))
    this.servers = merged
    this.serverSignatures = signatures
    for (const name of staleConnections) void this.disconnect(name)
    this.components = Array.isArray(registry.components) ? registry.components : []
    this.skillRoots = [...new Set([
      this.skillStoreRoot,
      ...stringArray(registry.skillRoots).map(path => resolve(this.workspaceRoot, path)),
      ...String(this.environment.CAPABILITY_ROUTER_SKILL_ROOTS || '')
        .split(process.platform === 'win32' ? ';' : ':')
        .filter(Boolean)
        .map(path => resolve(path)),
    ])]
    if (options.skills !== false) {
      this.reloadSkills()
    } else if (this.skillsLoaded) {
      const disabledSkills = new Set(stringArray(this.state.disabledSkills))
      for (const skill of this.skills) skill.enabled = !disabledSkills.has(skill.name)
    }
    return this.snapshot()
  }

  reloadSkills() {
    const disabledSkills = new Set(stringArray(this.state.disabledSkills))
    this.skills = discoverSkills(this.skillRoots).map(skill => ({
      ...skill,
      enabled: !disabledSkills.has(skill.name),
    }))
    this.skillsLoaded = true
    return this.skills
  }

  ensureSkillsLoaded() {
    if (!this.skillsLoaded) this.reloadSkills()
    return this.skills
  }

  snapshot() {
    return {
      schemaVersion: 1,
      workspaceRoot: this.workspaceRoot,
      policy: { maxServers: this.maxServers, maxTools: this.maxTools, lazyConnections: true },
      servers: [...this.servers.values()].map(server => ({
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        description: server.description,
        tags: server.tags,
        intents: server.intents,
        requiredEnvironment: [...envReferences(server)].sort(),
        connected: this.clients.has(server.name),
      })),
      skills: this.skills.map(({ path, ...skill }) => skill),
      skillsLoaded: this.skillsLoaded,
      components: this.components,
    }
  }

  persistState() {
    writeJsonAtomic(this.statePath, this.state)
  }

  setEnabled(kind, nameValue, enabled) {
    const name = normalizeName(nameValue)
    if (kind !== 'server' && kind !== 'skill') throw new Error('kind must be server or skill')
    const key = kind === 'server' ? 'disabledServers' : 'disabledSkills'
    const disabled = new Set(stringArray(this.state[key]))
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    this.state[key] = [...disabled].sort()
    this.persistState()
    if (kind === 'server' && !enabled) void this.disconnect(name)
    if (kind === 'server') {
      this.reload({ skills: false })
    } else if (this.skillsLoaded) {
      for (const skill of this.skills) skill.enabled = !disabled.has(skill.name)
    }
    return { kind, name, enabled }
  }

  importMcp(raw) {
    const entries = serverEntries(raw)
    if (!entries.length) throw new Error('Expected an object containing mcpServers, mcp.servers, or servers')
    const validated = []
    for (const [name, value] of entries) {
      const server = normalizeServer(name, value)
      assertPortableSecrets(server)
      validated.push([server.name, value])
    }
    this.state = {
      ...this.state,
      customServers: {
        ...this.state.customServers,
        ...Object.fromEntries(validated),
      },
    }
    this.persistState()
    this.reload({ skills: false })
    return { imported: validated.map(([name]) => name).sort() }
  }

  exportRegistry() {
    this.ensureSkillsLoaded()
    return {
      schemaVersion: 1,
      mcpServers: Object.fromEntries([...this.servers.values()].map(server => [server.name, {
        ...(server.transport === 'stdio'
          ? { command: server.command, args: server.args || [], ...(server.cwd ? { cwd: server.cwd } : {}) }
          : { type: 'http', url: server.url }),
        ...(server.env ? { env: server.env } : {}),
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
        ...(server.blockedTools ? { blockedTools: server.blockedTools } : {}),
        enabled: server.enabled,
      }])),
      skills: this.skills.map(skill => ({ name: skill.name, description: skill.description, enabled: skill.enabled })),
      components: this.components,
    }
  }

  async semanticSelect(task, candidates, limit) {
    const baseUrl = String(this.environment.CAPABILITY_ROUTER_LLM_BASE_URL || '').replace(/\/$/u, '')
    const model = this.environment.CAPABILITY_ROUTER_LLM_MODEL
    if (!baseUrl || !model || !this.fetch) return undefined
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 20_000))
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.environment.CAPABILITY_ROUTER_LLM_API_KEY
            ? { authorization: `Bearer ${this.environment.CAPABILITY_ROUTER_LLM_API_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0,
          max_tokens: 500,
          messages: [
            {
              role: 'system',
              content: 'Select only capabilities that materially help the task. Return strict JSON: {"selected":["exact candidate id"],"reason":"short"}. Never invent ids.',
            },
            { role: 'user', content: JSON.stringify({ task, limit, candidates }) },
          ],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`semantic router HTTP ${response.status}`)
      const body = await response.json()
      const parsed = extractJson(body?.choices?.[0]?.message?.content)
      const allowed = new Set(candidates.map(candidate => candidate.id))
      return {
        selected: stringArray(parsed.selected).filter(id => allowed.has(id)).slice(0, limit),
        reason: String(parsed.reason || 'semantic selection'),
      }
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  async connect(nameValue) {
    const name = normalizeName(nameValue)
    if (this.clients.has(name)) return this.clients.get(name)
    const existingAttempt = this.connectionAttempts.get(name)
    if (existingAttempt) return existingAttempt

    const attempt = this.connectServer(name)
    this.connectionAttempts.set(name, attempt)
    try {
      return await attempt
    } finally {
      if (this.connectionAttempts.get(name) === attempt) {
        this.connectionAttempts.delete(name)
      }
    }
  }

  async connectServer(name) {
    const server = this.servers.get(name)
    if (!server || !server.enabled) throw new Error(`MCP server is unavailable or disabled: ${name}`)
    const missing = new Set()
    const resolvedServer = expandEnvironment(server, this.environment, missing)
    if (missing.size) throw new Error(`MCP server ${name} requires environment: ${[...missing].sort().join(', ')}`)
    let transport
    if (resolvedServer.transport === 'stdio') {
      const inherited = Object.fromEntries(Object.entries(this.environment).filter(([, value]) => typeof value === 'string'))
      transport = new StdioClientTransport({
        command: resolvedServer.command,
        args: resolvedServer.args || [],
        cwd: resolve(this.workspaceRoot, resolvedServer.cwd || '.'),
        env: { ...inherited, ...(resolvedServer.env || {}) },
        stderr: 'pipe',
      })
      transport.stderr?.on('data', () => {})
    } else {
      transport = new StreamableHTTPClientTransport(new URL(resolvedServer.url), {
        requestInit: { headers: resolvedServer.headers || {} },
      })
    }
    const client = new Client({ name: 'portable-capability-router', version: '1.0.0' }, { capabilities: {} })
    try {
      await withTimeout(client.connect(transport), this.timeoutMs, `Connect ${name}`)
      const connection = { client, transport }
      this.clients.set(name, connection)
      return connection
    } catch (error) {
      await transport.close().catch(() => {})
      throw error
    }
  }

  async disconnect(nameValue) {
    const name = normalizeName(nameValue)
    const pending = this.connectionAttempts.get(name)
    if (pending) await pending.catch(() => {})
    const connection = this.clients.get(name)
    this.clients.delete(name)
    this.toolCache.delete(name)
    if (connection) await connection.transport.close().catch(() => {})
  }

  async listServerTools(nameValue, refresh = false) {
    const name = normalizeName(nameValue)
    const cached = this.toolCache.get(name)
    if (!refresh && cached && Date.now() - cached.at < this.toolCacheTtlMs) return cached.tools
    try {
      const { client } = await this.connect(name)
      const response = await withTimeout(client.listTools(), this.timeoutMs, `List tools from ${name}`)
      const server = this.servers.get(name)
      const allowed = server.allowedTools?.length ? new Set(server.allowedTools) : undefined
      const blocked = new Set(server.blockedTools || [])
      const tools = (response.tools || []).filter(tool => (!allowed || allowed.has(tool.name)) && !blocked.has(tool.name))
      this.toolCache.set(name, { at: Date.now(), tools })
      return tools
    } catch (error) {
      await this.disconnect(name)
      throw error
    }
  }

  async call(serverName, toolName, args = {}) {
    const server = normalizeName(serverName, 'server')
    const tool = String(toolName || '').trim()
    if (!tool) throw new Error('tool is required')
    const tools = await this.listServerTools(server)
    if (!tools.some(candidate => candidate.name === tool)) throw new Error(`Tool ${tool} is not exposed by ${server}`)
    try {
      const { client } = await this.connect(server)
      return await withTimeout(client.callTool({ name: tool, arguments: args || {} }), this.timeoutMs, `${server}.${tool}`)
    } catch (error) {
      await this.disconnect(server)
      throw error
    }
  }

  async route(taskValue, options = {}) {
    const task = String(taskValue || '').trim()
    if (!task) throw new Error('task is required')
    this.ensureSkillsLoaded()
    const excluded = new Set(stringArray(options.excluded))
    const preferred = stringArray(options.preferred)
      .map(name => name.toLowerCase())
      .filter(name => this.servers.get(name)?.enabled && !excluded.has(name))
    const serverLimit = Math.max(1, Math.min(12, Number(options.maxServers || this.maxServers)))
    const toolLimit = Math.max(1, Math.min(100, Number(options.maxTools || this.maxTools)))
    const candidates = [...this.servers.values()]
      .filter(server => server.enabled && !excluded.has(server.name))
      .map(server => ({ id: server.name, description: server.description, tags: server.tags, intents: server.intents }))
    const skillCandidates = this.skills
      .filter(skill => skill.enabled)
      .map(skill => ({ id: skill.name, description: skill.description, tags: skill.tags }))
    const semantic = await this.semanticSelect(task, [
      ...candidates.map(candidate => ({ ...candidate, id: `server:${candidate.id}` })),
      ...skillCandidates.map(candidate => ({ ...candidate, id: `skill:${candidate.id}` })),
    ], serverLimit + Math.min(5, serverLimit))
    const semanticServers = (semantic?.selected || [])
      .filter(id => id.startsWith('server:'))
      .map(id => id.slice('server:'.length))
    const semanticSkills = (semantic?.selected || [])
      .filter(id => id.startsWith('skill:'))
      .map(id => id.slice('skill:'.length))
    const ranked = candidates
      .map(candidate => ({ ...candidate, score: overlapScore(task, { name: candidate.id, ...candidate }) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    const serverThreshold = Math.max(8, (ranked[0]?.score || 0) * 0.5)
    const selectedNames = [...new Set([
      ...preferred,
      ...(semanticServers.length
        ? semanticServers
        : ranked.filter(item => item.score >= serverThreshold).map(item => item.id)),
    ])].slice(0, serverLimit)
    const toolGroups = await Promise.all(selectedNames.map(async server => {
      try {
        const tools = await this.listServerTools(server, options.refresh === true)
        return { server, tools, error: undefined }
      } catch (error) {
        return { server, tools: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    const toolCandidates = toolGroups.flatMap(group => group.tools.map(tool => ({
      id: `${group.server}::${tool.name}`,
      description: tool.description || tool.name,
    })))
    const semanticTools = await this.semanticSelect(task, toolCandidates, toolLimit)
    const semanticToolSet = new Set(semanticTools?.selected || [])
    const rankedTools = toolCandidates
      .map(candidate => ({ ...candidate, score: overlapScore(task, { name: candidate.id, description: candidate.description }) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    const toolThreshold = Math.max(3, (rankedTools[0]?.score || 0) * 0.35)
    const fallbackToolIds = rankedTools.filter(item => item.score >= toolThreshold).map(item => item.id)
    const boundedDefaultToolIds = toolGroups
      .flatMap(group => group.tools.slice(0, 1).map(tool => `${group.server}::${tool.name}`))
    const selectedToolIds = [...new Set(semanticToolSet.size
      ? [...semanticToolSet]
      : fallbackToolIds.length
        ? fallbackToolIds
        : boundedDefaultToolIds)].slice(0, toolLimit)
    const selectedToolSet = new Set(selectedToolIds)
    const tools = toolGroups.flatMap(group => group.tools
      .filter(tool => selectedToolSet.has(`${group.server}::${tool.name}`))
      .map(tool => ({
        server: group.server,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })))
    const skillNames = semanticSkills.length
      ? semanticSkills
      : skillCandidates
          .map(skill => ({ ...skill, score: overlapScore(task, { name: skill.id, ...skill }) }))
          .filter(skill => skill.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(skill => skill.id)
    return {
      task,
      method: semantic ? 'semantic-with-lexical-fallback' : 'lexical-fallback',
      selectedServers: selectedNames.map(name => ({
        name,
        description: this.servers.get(name)?.description,
        error: toolGroups.find(group => group.server === name)?.error,
      })),
      tools,
      skills: this.skills
        .filter(skill => skillNames.includes(skill.name))
        .map(({ path, ...skill }) => ({ ...skill, readWith: { tool: 'skill_store', action: 'read' } })),
      instructions: tools.length
        ? 'Call a selected tool through capability_call using its server and name.'
        : 'No downstream tool matched. Refine the task, enable a capability, or import another MCP server.',
    }
  }

  listSkills() {
    this.ensureSkillsLoaded()
    return this.skills.map(({ path, ...skill }) => skill)
  }

  readSkill(nameValue) {
    this.ensureSkillsLoaded()
    const name = normalizeName(nameValue, 'skill').replaceAll('.', '-')
    const skill = this.skills.find(item => item.name === name)
    if (!skill || !skill.enabled) throw new Error(`Skill is unavailable or disabled: ${name}`)
    return { name, description: skill.description, instructions: readFileSync(join(skill.path, 'SKILL.md'), 'utf8') }
  }

  installSkill(input) {
    const name = normalizeName(input.name, 'skill').replaceAll('.', '-')
    const description = String(input.description || '').trim()
    const instructions = String(input.instructions || '').trim()
    if (!description || !instructions) throw new Error('description and instructions are required')
    for (const path of Object.keys(input.files || {})) {
      if (String(path).replaceAll('\\', '/').toLowerCase() === 'skill.md') {
        throw new Error('files cannot replace the generated SKILL.md manifest')
      }
    }
    mkdirSync(this.skillStoreRoot, { recursive: true })
    const directory = inside(this.skillStoreRoot, name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${description.replace(/[\r\n]+/gu, ' ')}`,
      '---',
      '',
      instructions,
      '',
    ].join('\n'), 'utf8')
    for (const [path, content] of Object.entries(input.files || {})) {
      const target = inside(directory, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, String(content), 'utf8')
    }
    this.reloadSkills()
    return this.readSkill(name)
  }

  listFiles(path = '.', options = {}) {
    const target = inside(this.workspaceRoot, path, false)
    const info = statSync(target)
    if (!info.isDirectory()) throw new Error(`Not a directory: ${path}`)
    const entries = readdirSync(target, { withFileTypes: true })
      .slice(0, Math.min(10_000, Number(options.limit || 2_000)))
      .map(entry => {
        const entryPath = join(target, entry.name)
        const stats = lstatSync(entryPath)
        return {
          name: entry.name,
          path: relative(this.workspaceRoot, entryPath).split(sep).join('/'),
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          bytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        }
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
    return { path: relative(this.workspaceRoot, target).split(sep).join('/') || '.', entries }
  }

  readFile(path, options = {}) {
    const target = inside(this.workspaceRoot, path, false)
    const stats = statSync(target)
    if (!stats.isFile()) throw new Error(`Not a file: ${path}`)
    const maxBytes = Math.min(256 * 1024 * 1024, Number(options.maxBytes || 16 * 1024 * 1024))
    if (stats.size > maxBytes) throw new Error(`File is ${stats.size} bytes; maxBytes is ${maxBytes}`)
    const encoding = options.encoding === 'base64' ? 'base64' : 'utf8'
    return { path, bytes: stats.size, encoding, content: readFileSync(target).toString(encoding) }
  }

  writeFile(path, content, options = {}) {
    const target = inside(this.workspaceRoot, path)
    mkdirSync(dirname(target), { recursive: true })
    const data = options.encoding === 'base64' ? Buffer.from(String(content || ''), 'base64') : Buffer.from(String(content || ''), 'utf8')
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temporary, data)
    replaceFileAtomic(temporary, target)
    return { path: relative(this.workspaceRoot, target).split(sep).join('/'), bytes: data.length }
  }

  deleteFile(path, recursive = false) {
    const target = inside(this.workspaceRoot, path, false)
    if (target === this.workspaceRoot) throw new Error('Workspace root cannot be deleted')
    rmSync(target, { recursive: recursive === true, force: false })
    return { path, deleted: true }
  }

  async shutdown() {
    const names = new Set([
      ...this.clients.keys(),
      ...this.connectionAttempts.keys(),
    ])
    await Promise.all([...names].map(name => this.disconnect(name)))
  }
}

export { resultText }
