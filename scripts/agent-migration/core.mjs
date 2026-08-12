import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

export const BUNDLE_SCHEMA = 'openclaude.agent-bundle/v1'
export const BUNDLE_VERSION = 1

const DEFAULT_DESCRIPTOR = {
  schemaVersion: 1,
  agent: { id: 'openclaude-agent', name: 'OpenClaude Agent' },
  workspace: { include: [], exclude: [] },
  capabilities: {
    skillRoots: [],
    mcpConfigs: ['.mcp.json'],
    registry: 'capability-registry.json',
    components: [],
  },
}

const ALWAYS_EXCLUDED_NAMES = new Set([
  '.git',
  '.env',
  '.venv',
  'node_modules',
  'dist',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
])

const SENSITIVE_FILE_RE = /(?:^|[._-])(?:auth|credentials?|cookies?|secrets?|tokens?|private[-_]?key)(?:[._-]|$)/iu
const TEXT_EXTENSIONS = new Set([
  '', '.c', '.cjs', '.conf', '.cpp', '.css', '.csv', '.env.example', '.go',
  '.h', '.html', '.ini', '.java', '.js', '.json', '.json5', '.jsonl', '.jsx',
  '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx',
  '.txt', '.xml', '.yaml', '.yml',
])

const SECRET_PATTERNS = [
  { name: 'openai-style-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu },
  { name: 'telegram-bot-token', regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/gu },
  { name: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/giu },
  { name: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu },
]

function toPosix(path) {
  return path.split(sep).join('/')
}

function safeRelative(path) {
  const normalized = toPosix(path).replace(/^\.\//u, '')
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe bundle path: ${path}`)
  }
  return normalized
}

function ensureInside(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes root: ${candidate}`)
  }
  return resolvedCandidate
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sha256File(path) {
  const hash = createHash('sha256')
  const descriptor = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

function stableId(prefix, value) {
  return `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`
}

function createRedactionState() {
  return {
    total: 0,
    byType: {},
    requiredSecrets: new Set(),
    literalSecrets: new Map(),
  }
}

function recordRedaction(state, type, count = 1) {
  state.total += count
  state.byType[type] = (state.byType[type] || 0) + count
}

export function redactText(input, state = createRedactionState()) {
  let text = String(input ?? '')
  for (const [secret, replacement] of [...(state.literalSecrets || new Map())]
    .sort(([left], [right]) => right.length - left.length)) {
    if (!secret || !text.includes(secret)) continue
    const count = text.split(secret).length - 1
    text = text.split(secret).join(replacement)
    recordRedaction(state, 'known-structured-secret', count)
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern.regex, match => {
      recordRedaction(state, pattern.name)
      return `[REDACTED_${pattern.name.toUpperCase().replaceAll('-', '_')}]`
    })
  }
  return text
}

function envNameForPath(path) {
  return `MIGRATED_${path.join('_').replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toUpperCase()}`
}

function isSecretProperty(name) {
  if (/env$/iu.test(name) || /(?:timeout|max|limit|enabled)$/iu.test(name)) return false
  return /(?:api[_-]?key|token|secret|password|credential|authorization|cookie|private[_-]?key)/iu.test(name)
}

function secretValuePath(path) {
  const leaf = String(path.at(-1) || '')
  if (isSecretProperty(leaf)) return true
  return /^(?:default|value)$/iu.test(leaf)
    && path.slice(0, -1).some(part => isSecretProperty(String(part)))
}

function collectStructuredSecrets(value, state, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStructuredSecrets(item, state, [...path, String(index)]))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    const itemPath = [...path, key]
    if (typeof item === 'string' && item.trim() && secretValuePath(itemPath)) {
      const envMatch = item.match(/^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/u)
      const insideEnvMap = /^(?:env|environment)$/iu.test(path.at(-1) || '')
      const envName = envMatch?.[1] || (insideEnvMap && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
        ? key
        : envNameForPath(itemPath))
      state.requiredSecrets.add(envName)
      if (!envMatch) state.literalSecrets.set(item, `\${${envName}}`)
    }
    collectStructuredSecrets(item, state, itemPath)
  }
}

function sanitizeStructuredValue(value, state, path = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeStructuredValue(item, state, [...path, String(index)]))
  }
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (/(?:apiKeyEnv|tokenEnv|passwordEnv|secretEnv)$/u.test(key) && typeof item === 'string' && item.trim()) {
        state.requiredSecrets.add(item.trim())
        output[key] = item
      } else if (secretValuePath([...path, key]) && typeof item === 'string' && item.trim()) {
        const envMatch = item.match(/^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/u)
        const insideEnvMap = /^(?:env|environment)$/iu.test(path.at(-1) || '')
        const envName = envMatch?.[1] || (insideEnvMap && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
          ? key
          : envNameForPath([...path, key]))
        state.requiredSecrets.add(envName)
        output[key] = `\${${envName}}`
        if (!envMatch) recordRedaction(state, 'structured-secret')
      } else {
        output[key] = sanitizeStructuredValue(item, state, [...path, key])
      }
    }
    return output
  }
  return typeof value === 'string' ? redactText(value, state) : value
}

export function sanitizeStructured(value, state, path = []) {
  collectStructuredSecrets(value, state, path)
  return sanitizeStructuredValue(value, state, path)
}

function looksText(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.env.example')) return true
  return TEXT_EXTENSIONS.has(extname(lower))
}

function shouldExcludePath(path, extraExcludes = []) {
  const rel = toPosix(path)
  const parts = rel.split('/').filter(Boolean)
  if (parts.some(part => ALWAYS_EXCLUDED_NAMES.has(part))) return true
  if (parts.some(part =>
    SENSITIVE_FILE_RE.test(part) &&
    !/\.example$/iu.test(part) &&
    part !== 'secrets.required.env'
  )) return true
  return extraExcludes.some(pattern => {
    const normalized = toPosix(pattern).replace(/^\.\//u, '').replace(/\*\*?$/u, '')
    return normalized && (rel === normalized || rel.startsWith(`${normalized}/`))
  })
}

function copyPortableFile(source, destination, state, options = {}) {
  mkdirSync(dirname(destination), { recursive: true })
  if (looksText(source)) {
    const text = redactText(readFileSync(source, 'utf8'), state)
    writeFileSync(destination, text, 'utf8')
  } else {
    copyFileSync(source, destination)
  }
  options.onFile?.(source, destination)
}

export function copyPortableTree(source, destination, state, options = {}) {
  if (!existsSync(source)) return 0
  const sourceRoot = resolve(source)
  let copied = 0
  const visit = (current, relativePath = '') => {
    const info = lstatSync(current)
    if (info.isSymbolicLink()) return
    if (relativePath && shouldExcludePath(relativePath, options.exclude || [])) return
    if (info.isDirectory()) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        visit(join(current, entry.name), relativePath ? join(relativePath, entry.name) : entry.name)
      }
      return
    }
    if (!info.isFile()) return
    if (options.maxFileBytes && info.size > options.maxFileBytes) {
      options.onSkipped?.(current, `larger than ${options.maxFileBytes} bytes`)
      return
    }
    const target = ensureInside(destination, join(destination, relativePath))
    copyPortableFile(current, target, state, options)
    copied += 1
  }
  visit(sourceRoot)
  return copied
}

function copySanitizedJson(source, destination, state, pathPrefix = []) {
  if (!existsSync(source)) return false
  const raw = readJson(source)
  writeJson(destination, sanitizeStructured(raw, state, pathPrefix))
  return true
}

function loadDescriptor(workspace, descriptorPath) {
  const path = descriptorPath
    ? resolve(descriptorPath)
    : join(workspace, 'agent-portability.json')
  const loaded = existsSync(path) ? readJson(path) : {}
  return {
    ...DEFAULT_DESCRIPTOR,
    ...loaded,
    agent: { ...DEFAULT_DESCRIPTOR.agent, ...(loaded.agent || {}) },
    workspace: { ...DEFAULT_DESCRIPTOR.workspace, ...(loaded.workspace || {}) },
    capabilities: { ...DEFAULT_DESCRIPTOR.capabilities, ...(loaded.capabilities || {}) },
  }
}

function normalizeMcpServer(name, raw, source, state, metadata = {}) {
  if (!raw || typeof raw !== 'object') return undefined
  const commandArray = Array.isArray(raw.command) ? raw.command.map(String) : undefined
  const command = commandArray?.[0] || (typeof raw.command === 'string' ? raw.command : undefined)
  const commandArgs = commandArray?.slice(1) || (Array.isArray(raw.args) ? raw.args.map(String) : [])
  const url = typeof raw.url === 'string' ? raw.url : undefined
  if (!command && !url) return undefined
  const env = sanitizeStructured(raw.env || raw.environment || {}, state, ['mcp', name, 'env'])
  const headers = sanitizeStructured(raw.headers || raw.http_headers || {}, state, ['mcp', name, 'headers'])
  return {
    name,
    transport: command ? 'stdio' : 'http',
    enabled: raw.enabled !== false && raw.disabled !== true && metadata.enabled !== false,
    description: String(raw.description || metadata.description || `${name} MCP server`),
    tags: Array.isArray(raw.tags || metadata.tags) ? (raw.tags || metadata.tags).map(String) : [],
    intents: Array.isArray(raw.intents || metadata.intents) ? (raw.intents || metadata.intents).map(String) : [],
    ...(command ? { command, args: commandArgs } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Array.isArray(raw.allowedTools || metadata.allowedTools)
      ? { allowedTools: (raw.allowedTools || metadata.allowedTools).map(String) }
      : {}),
    ...(Array.isArray(raw.blockedTools || metadata.blockedTools)
      ? { blockedTools: (raw.blockedTools || metadata.blockedTools).map(String) }
      : {}),
    source,
  }
}

function extractMcpServers(raw, source, state, metadata = new Map()) {
  const candidates = raw?.mcpServers || raw?.mcp?.servers || raw?.mcp || raw?.servers
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) return []
  return Object.entries(candidates)
    .map(([name, server]) => normalizeMcpServer(name, server, source, state, metadata.get(name) || {}))
    .filter(Boolean)
}

function registryServerMetadata(registry) {
  const entries = Array.isArray(registry?.servers)
    ? registry.servers.map(server => [server.name, server])
    : Object.entries(registry?.servers || {})
  return new Map(entries.filter(([name]) => name))
}

function discoverSkillDirectories(root, maxDepth = 8) {
  if (!existsSync(root)) return []
  const results = []
  const visit = (current, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
      results.push(current)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ALWAYS_EXCLUDED_NAMES.has(entry.name)) continue
      visit(join(current, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  return results
}

function parseSkillName(skillDirectory) {
  const path = join(skillDirectory, 'SKILL.md')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const match = text.match(/^---[\s\S]*?^name:\s*["']?([^\r\n"']+)/mu)
  const raw = (match?.[1] || basename(skillDirectory)).trim().toLowerCase()
  return raw.replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'skill'
}

function extractTextParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input })
    } else if (block.type === 'tool_result') {
      parts.push({ type: 'tool_result', toolCallId: block.tool_use_id, content: block.content })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push({ type: 'reasoning', text: block.thinking })
    }
  }
  return parts
}

function canonicalFromGateway(entry, sourcePath, state) {
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string') return undefined
  const direction = String(entry.direction || '').toLowerCase()
  const role = direction === 'inbound' || direction === 'incoming' || direction === 'user'
    ? 'user'
    : direction === 'outbound' || direction === 'outgoing' || direction === 'assistant'
      ? 'assistant'
      : 'event'
  return sanitizeStructured({
    id: String(entry.messageId || stableId('msg', `${entry.ts}:${entry.chatId}:${entry.text}`)),
    sessionId: `telegram:${entry.chatId || 'unknown'}`,
    timestamp: entry.ts || new Date(0).toISOString(),
    role,
    parts: [{ type: 'text', text: entry.text }],
    source: { runtime: 'openclaude-gateway', path: sourcePath },
    metadata: {
      chatId: entry.chatId,
      username: entry.username,
      exitCode: entry.exitCode,
    },
  }, state, ['conversation'])
}

function canonicalFromProject(entry, sourcePath, state) {
  const role = entry?.message?.role || (entry?.type === 'user' || entry?.type === 'assistant' ? entry.type : undefined)
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return undefined
  const parts = extractTextParts(entry.message?.content)
  if (!parts.length) return undefined
  return sanitizeStructured({
    id: String(entry.uuid || stableId('msg', `${sourcePath}:${entry.timestamp}:${JSON.stringify(parts)}`)),
    parentId: entry.parentUuid || undefined,
    sessionId: String(entry.sessionId || basename(sourcePath, '.jsonl')),
    timestamp: entry.timestamp || new Date(0).toISOString(),
    role,
    parts,
    source: { runtime: 'openclaude-project', path: sourcePath },
    metadata: {
      cwd: entry.cwd,
      gitBranch: entry.gitBranch,
      isSidechain: entry.isSidechain,
    },
  }, state, ['conversation'])
}

async function appendCanonicalFile(inputPath, sourcePath, output, stats, state, kind) {
  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    if (!line.trim()) continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      stats.invalidLines += 1
      continue
    }
    const message = kind === 'gateway'
      ? canonicalFromGateway(raw, sourcePath, state)
      : canonicalFromProject(raw, sourcePath, state)
    if (!message) continue
    if (!output.write(`${JSON.stringify(message)}\n`)) await once(output, 'drain')
    stats.messages += 1
    stats.sessions[message.sessionId] = (stats.sessions[message.sessionId] || 0) + 1
  }
}

async function sanitizeJsonlFile(source, destination, state) {
  mkdirSync(dirname(destination), { recursive: true })
  const output = createWriteStream(destination, { encoding: 'utf8' })
  const reader = createInterface({ input: createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of reader) {
    if (!line.trim()) continue
    try {
      const value = sanitizeStructured(JSON.parse(line), state, ['raw-history'])
      if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain')
    } catch {
      if (!output.write(`${JSON.stringify({ type: 'migration-unparsed-line', text: redactText(line, state) })}\n`)) {
        await once(output, 'drain')
      }
    }
  }
  output.end()
  await once(output, 'finish')
}

function collectFiles(root) {
  const files = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name !== 'manifest.json') files.push(path)
    }
  }
  visit(root)
  return files.sort((a, b) => a.localeCompare(b))
}

function finalizeManifest(root, manifest) {
  const files = collectFiles(root).map(path => ({
    path: safeRelative(relative(root, path)),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }))
  const finalManifest = { ...manifest, files }
  writeJson(join(root, 'manifest.json'), finalManifest)
  return finalManifest
}

function renderSecretTemplate(requiredSecrets) {
  const names = [...requiredSecrets].sort()
  return [
    '# Values are intentionally absent from the migration bundle.',
    '# Fill these in on the target machine or its secret manager.',
    ...names.map(name => `${name}=`),
    '',
  ].join('\n')
}

function readEnvSecretNames(path, state) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u)
    if (match && isSecretProperty(match[1])) state.requiredSecrets.add(match[1])
  }
}

function copyDeclaredWorkspace(workspace, root, descriptor, state, skipped) {
  const includes = Array.isArray(descriptor.workspace.include) ? descriptor.workspace.include : []
  const excludes = Array.isArray(descriptor.workspace.exclude) ? descriptor.workspace.exclude : []
  const maxFileBytes = Number(descriptor.workspace.maxFileBytes || 512 * 1024 * 1024)
  for (const requested of includes) {
    const relativePath = safeRelative(String(requested))
    const source = ensureInside(workspace, join(workspace, relativePath))
    if (!existsSync(source)) {
      skipped.push({ path: relativePath, reason: 'workspace include not found' })
      continue
    }
    const target = join(root, 'workspace', relativePath)
    if (lstatSync(source).isDirectory()) {
      copyPortableTree(source, target, state, {
        exclude: excludes,
        maxFileBytes,
        onSkipped: (path, reason) => skipped.push({ path: relative(workspace, path), reason }),
      })
    } else if (!shouldExcludePath(relativePath, excludes)) {
      copyPortableFile(source, target, state)
    }
  }
}

export async function exportOpenClaudeBundle(options = {}) {
  const sourceHome = resolve(options.sourceHome || process.env.OPENCLAUDE_HOME || join(homedir(), '.openclaude'))
  const workspace = resolve(options.workspace || process.cwd())
  const requestedOutput = resolve(options.output || join(process.cwd(), `${options.name || 'openclaude-agent'}.agent-bundle`))
  const history = options.history || 'gateway'
  if (!['none', 'gateway', 'full'].includes(history)) throw new Error(`Unsupported history mode: ${history}`)
  if (!existsSync(sourceHome)) throw new Error(`OpenClaude home not found: ${sourceHome}`)
  const transaction = prepareAtomicOutput(requestedOutput, options.force)
  const { target: output, partial } = transaction

  const descriptor = loadDescriptor(workspace, options.descriptor)
  const redaction = createRedactionState()
  const skipped = []
  const stateDir = join(sourceHome, 'agent-gateway')

  try {
    writeJson(join(partial, 'bundle-descriptor.json'), descriptor)
    copySanitizedJson(join(sourceHome, 'agent-gateway.json'), join(partial, 'state', 'agent-gateway.json'), redaction, ['agent-gateway'])
    readEnvSecretNames(join(workspace, '.env'), redaction)

    const memorySource = join(stateDir, 'memory')
    copyPortableTree(memorySource, join(partial, 'state', 'memory'), redaction)
    const identityMappings = [
      ['identity.md', 'SOUL.md'],
      ['USER.md', 'USER.md'],
      ['MEMORY.md', 'MEMORY.md'],
      ['scratchpad.md', 'SCRATCHPAD.md'],
    ]
    for (const [sourceName, targetName] of identityMappings) {
      const source = join(memorySource, sourceName)
      if (existsSync(source)) copyPortableFile(source, join(partial, 'identity', targetName), redaction)
    }

    for (const name of [
      'cron-jobs.json',
      'telegram-conversation-sessions.json',
      'tool-router-audit.json',
    ]) {
      copySanitizedJson(join(stateDir, name), join(partial, 'state', name), redaction, ['state', name])
    }
    const routerStateCandidates = [
      options.capabilityRouterState,
      process.env.CAPABILITY_ROUTER_STATE,
      join(sourceHome, 'capability-router'),
      join(stateDir, 'capability-router'),
    ].filter(Boolean).map(path => resolve(path))
    const routerStateSource = routerStateCandidates.find(path => existsSync(path))
    let routerStateRoot
    let routerState
    if (routerStateSource) {
      if (lstatSync(routerStateSource).isDirectory()) {
        routerStateRoot = routerStateSource
        const stateFile = join(routerStateSource, 'state.json')
        copyPortableTree(
          routerStateSource,
          join(partial, 'state', 'capability-router'),
          redaction,
          { exclude: ['state.json'] },
        )
        if (existsSync(stateFile)) {
          routerState = readJson(stateFile)
          copySanitizedJson(
            stateFile,
            join(partial, 'state', 'capability-router', 'state.json'),
            redaction,
            ['state', 'capability-router'],
          )
        }
      } else {
        routerStateRoot = dirname(routerStateSource)
        copySanitizedJson(
          routerStateSource,
          join(partial, 'state', 'capability-router', 'state.json'),
          redaction,
          ['state', 'capability-router'],
        )
        routerState = readJson(routerStateSource)
        copyPortableTree(
          join(routerStateRoot, 'skills'),
          join(partial, 'state', 'capability-router', 'skills'),
          redaction,
        )
      }
    }
    for (const name of ['goals', 'semantic-router']) {
      copyPortableTree(
        join(stateDir, name),
        join(partial, 'state', 'runtime', name),
        redaction,
      )
    }
    for (const name of ['subagent-routing.settings.json', 'telegram-research-modes.json']) {
      copySanitizedJson(
        join(stateDir, name),
        join(partial, 'state', 'runtime', name),
        redaction,
        ['state', 'runtime', name],
      )
    }
    if (history !== 'none') {
      for (const name of ['cron-output', 'telegram-files', 'transcriptions', 'vision-inputs', 'api-responses']) {
        copyPortableTree(
          join(stateDir, name),
          join(partial, 'contexts', name),
          redaction,
          { maxFileBytes: Number(descriptor.workspace.maxFileBytes || 512 * 1024 * 1024) },
        )
      }
      for (const name of ['task_reflections.jsonl', 'telegram-errors.jsonl', 'events.jsonl']) {
        const source = join(stateDir, 'logs', name)
        if (existsSync(source)) copyPortableFile(source, join(partial, 'contexts', 'logs', name), redaction)
      }
    }

    const mcpServers = new Map()
    const configuredRegistry = descriptor.capabilities.registry
    const capabilityRegistryPath = configuredRegistry
      ? ensureInside(workspace, join(workspace, configuredRegistry))
      : undefined
    const capabilityRegistry = capabilityRegistryPath && existsSync(capabilityRegistryPath)
      ? readJson(capabilityRegistryPath)
      : { schemaVersion: 1, servers: {}, components: [] }
    const mcpMetadata = registryServerMetadata(capabilityRegistry)
    writeJson(
      join(partial, 'capabilities', 'registry.json'),
      sanitizeStructured(capabilityRegistry, redaction, ['capability-registry']),
    )
    const mcpPaths = Array.isArray(descriptor.capabilities.mcpConfigs)
      ? descriptor.capabilities.mcpConfigs
      : ['.mcp.json']
    for (const configured of mcpPaths) {
      const source = ensureInside(workspace, join(workspace, configured))
      if (!existsSync(source)) continue
      const raw = readJson(source)
      for (const server of extractMcpServers(raw, toPosix(relative(workspace, source)), redaction, mcpMetadata)) {
        mcpServers.set(server.name, server)
      }
    }
    const gatewayMcpDir = join(stateDir, 'mcp')
    if (existsSync(gatewayMcpDir)) {
      for (const file of readdirSync(gatewayMcpDir).filter(name => name.endsWith('.json'))) {
        const source = join(gatewayMcpDir, file)
        try {
          for (const server of extractMcpServers(readJson(source), `agent-gateway/mcp/${file}`, redaction, mcpMetadata)) {
            mcpServers.set(server.name, server)
          }
        } catch (error) {
          skipped.push({ path: source, reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    writeJson(join(partial, 'capabilities', 'mcp.json'), {
      schemaVersion: 1,
      servers: [...mcpServers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    })
    writeJson(join(partial, 'capabilities', 'tools.json'), sanitizeStructured({
      schemaVersion: 1,
      source: routerState ? 'capability-router-state' : 'mcp-config',
      inventories: routerState?.toolInventory || {},
      inventoryMetadata: routerState?.toolInventoryMeta || {},
      disabledTools: routerState?.disabledTools || {},
      note: 'Downstream schemas are cached for inspection; MCP definitions remain the executable source of truth.',
    }, redaction, ['capabilities', 'tools']))

    const skillRoots = new Set([
      join(sourceHome, 'skills'),
      join(sourceHome, 'capability-router', 'skills'),
      join(stateDir, 'capability-router', 'skills'),
      ...(routerStateRoot ? [join(routerStateRoot, 'skills')] : []),
      ...(descriptor.capabilities.skillRoots || []).map(path => ensureInside(workspace, join(workspace, path))),
    ])
    const skillDirectories = new Set()
    for (const root of skillRoots) {
      for (const directory of discoverSkillDirectories(root)) skillDirectories.add(directory)
    }
    const skillIndex = []
    const usedNames = new Set()
    for (const directory of [...skillDirectories].sort()) {
      const baseName = parseSkillName(directory)
      let name = baseName
      let suffix = 2
      while (usedNames.has(name)) name = `${baseName}-${suffix++}`
      usedNames.add(name)
      copyPortableTree(directory, join(partial, 'capabilities', 'skills', name), redaction)
      skillIndex.push({ name, source: toPosix(relative(workspace, directory)) })
    }
    writeJson(join(partial, 'capabilities', 'skills.json'), { schemaVersion: 1, skills: skillIndex })

    const componentIndex = []
    const declaredComponents = Array.isArray(descriptor.capabilities.components)
      ? descriptor.capabilities.components
      : []
    for (const component of declaredComponents) {
      const id = String(component.id || '').trim().toLowerCase()
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) {
        skipped.push({ path: String(component.root || ''), reason: `invalid component id: ${component.id}` })
        continue
      }
      const source = ensureInside(workspace, join(workspace, safeRelative(String(component.root))))
      if (!existsSync(source)) {
        skipped.push({ path: String(component.root), reason: 'component root not found' })
        continue
      }
      const files = copyPortableTree(source, join(partial, 'capabilities', 'components', id), redaction, {
        maxFileBytes: Number(descriptor.workspace.maxFileBytes || 512 * 1024 * 1024),
      })
      componentIndex.push({ id, root: `components/${id}`, files })
    }
    for (const component of capabilityRegistry.components || []) {
      if (!componentIndex.some(item => item.id === component.id)) {
        componentIndex.push({ ...sanitizeStructured(component, redaction, ['component']), external: true })
      }
    }
    writeJson(join(partial, 'capabilities', 'components.json'), {
      schemaVersion: 1,
      components: componentIndex,
    })

    const gatewayConfig = readJson(join(sourceHome, 'agent-gateway.json'), {})
    writeJson(join(partial, 'capabilities', 'native-tools.json'), sanitizeStructured({
      schemaVersion: 1,
      sourceRuntime: 'openclaude',
      runner: {
        disableTools: Boolean(gatewayConfig?.runner?.disableTools),
        availableTools: Array.isArray(gatewayConfig?.runner?.availableTools)
          ? gatewayConfig.runner.availableTools.map(String)
          : [],
        disallowedTools: Array.isArray(gatewayConfig?.runner?.disallowedTools)
          ? gatewayConfig.runner.disallowedTools.map(String)
          : [],
      },
      note: 'Harness-native tools are policy metadata. Target runtimes map equivalent file, shell, browser, and subagent capabilities instead of copying executable internals.',
    }, redaction, ['capabilities', 'native-tools']))
    writeJson(join(partial, 'capabilities', 'providers.json'), sanitizeStructured({
      schemaVersion: 1,
      apiModelName: gatewayConfig?.api?.modelName,
      subagentRoutes: gatewayConfig?.subagents?.routes || {},
      note: 'Credentials are represented only by environment-variable references.',
    }, redaction, ['providers']))

    copyDeclaredWorkspace(workspace, partial, descriptor, redaction, skipped)

    const conversationStats = { messages: 0, invalidLines: 0, sessions: {} }
    if (history !== 'none') {
      const canonicalPath = join(partial, 'conversations', 'messages.jsonl')
      mkdirSync(dirname(canonicalPath), { recursive: true })
      const outputStream = createWriteStream(canonicalPath, { encoding: 'utf8' })
      const gatewayChat = join(stateDir, 'logs', 'chat.jsonl')
      if (existsSync(gatewayChat)) {
        await appendCanonicalFile(gatewayChat, 'agent-gateway/logs/chat.jsonl', outputStream, conversationStats, redaction, 'gateway')
        await sanitizeJsonlFile(gatewayChat, join(partial, 'conversations', 'raw', 'gateway', 'chat.jsonl'), redaction)
      }
      if (history === 'full') {
        const projectsRoot = join(sourceHome, 'projects')
        if (existsSync(projectsRoot)) {
          const projectFiles = []
          const collect = directory => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const path = join(directory, entry.name)
              if (entry.isDirectory()) collect(path)
              else if (entry.isFile() && entry.name.endsWith('.jsonl')) projectFiles.push(path)
            }
          }
          collect(projectsRoot)
          for (const source of projectFiles.sort()) {
            const rel = safeRelative(relative(projectsRoot, source))
            await appendCanonicalFile(source, `projects/${toPosix(rel)}`, outputStream, conversationStats, redaction, 'project')
            await sanitizeJsonlFile(source, join(partial, 'conversations', 'raw', 'projects', rel), redaction)
          }
        }
      }
      outputStream.end()
      await once(outputStream, 'finish')
    }
    writeJson(join(partial, 'conversations', 'index.json'), {
      schemaVersion: 1,
      messages: conversationStats.messages,
      invalidLines: conversationStats.invalidLines,
      sessions: Object.entries(conversationStats.sessions)
        .map(([id, messages]) => ({ id, messages }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })

    writeFileSync(join(partial, 'secrets.required.env'), renderSecretTemplate(redaction.requiredSecrets), 'utf8')
    writeJson(join(partial, 'redaction.json'), {
      schemaVersion: 1,
      total: redaction.total,
      byType: redaction.byType,
      policy: 'Credential values are never exported. Source data remains unchanged.',
    })
    writeJson(join(partial, 'skipped.json'), { schemaVersion: 1, entries: skipped })

    const manifest = finalizeManifest(partial, {
      schema: BUNDLE_SCHEMA,
      version: BUNDLE_VERSION,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      agent: descriptor.agent,
      source: { runtime: 'openclaude', homeName: basename(sourceHome), workspaceName: basename(workspace) },
      options: { history },
      statistics: {
        conversations: conversationStats.messages,
        sessions: Object.keys(conversationStats.sessions).length,
        skills: skillIndex.length,
        mcpServers: mcpServers.size,
        components: componentIndex.length,
        redactions: redaction.total,
        skipped: skipped.length,
      },
      compatibility: ['openclaude', 'hermes', 'opencode', 'openclaw', 'codex'],
    })
    commitAtomicOutput(transaction)
    return { output, manifest }
  } catch (error) {
    abortAtomicOutput(transaction)
    throw error
  }
}

export function verifyBundle(bundlePath) {
  const root = resolve(bundlePath)
  const manifest = readJson(join(root, 'manifest.json'))
  const errors = []
  if (!manifest || manifest.schema !== BUNDLE_SCHEMA || manifest.version !== BUNDLE_VERSION) {
    errors.push(`Unsupported bundle schema: ${manifest?.schema || 'missing'} v${manifest?.version || 'missing'}`)
  }
  const seen = new Set()
  for (const entry of manifest?.files || []) {
    let rel
    try {
      rel = safeRelative(entry.path)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    if (seen.has(rel)) errors.push(`Duplicate manifest path: ${rel}`)
    seen.add(rel)
    const path = ensureInside(root, join(root, rel))
    if (!existsSync(path)) {
      errors.push(`Missing file: ${rel}`)
      continue
    }
    const info = statSync(path)
    if (info.size !== entry.bytes) errors.push(`Size mismatch: ${rel}`)
    if (sha256File(path) !== entry.sha256) errors.push(`Checksum mismatch: ${rel}`)
    if (shouldExcludePath(rel)) errors.push(`Sensitive path is not allowed in a bundle: ${rel}`)
  }
  const actual = collectFiles(root).map(path => safeRelative(relative(root, path)))
  for (const rel of actual) if (!seen.has(rel)) errors.push(`Unmanifested file: ${rel}`)
  return { ok: errors.length === 0, errors, manifest }
}

export function inspectBundle(bundlePath) {
  const verification = verifyBundle(bundlePath)
  const manifest = verification.manifest || {}
  return {
    ok: verification.ok,
    schema: manifest.schema,
    version: manifest.version,
    id: manifest.id,
    agent: manifest.agent,
    createdAt: manifest.createdAt,
    compatibility: manifest.compatibility || [],
    statistics: manifest.statistics || {},
    totalBytes: (manifest.files || []).reduce((sum, entry) => sum + Number(entry.bytes || 0), 0),
    errors: verification.errors,
  }
}

export async function loadRecentCanonicalMessages(bundlePath, limit = 400) {
  const path = join(resolve(bundlePath), 'conversations', 'messages.jsonl')
  if (!existsSync(path)) return []
  const messages = []
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of reader) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line))
      if (messages.length > limit) messages.shift()
    } catch {
      // Invalid source lines were already counted during export.
    }
  }
  return messages
}

export function readBundleText(bundlePath, relativePath, fallback = '') {
  const root = resolve(bundlePath)
  const path = ensureInside(root, join(root, safeRelative(relativePath)))
  return existsSync(path) ? readFileSync(path, 'utf8') : fallback
}

export function copyBundleSubtree(bundlePath, relativePath, destination, state = createRedactionState()) {
  const root = resolve(bundlePath)
  const source = ensureInside(root, join(root, safeRelative(relativePath)))
  return copyPortableTree(source, destination, state)
}

export function bundlePath(bundleRoot, relativePath) {
  return ensureInside(resolve(bundleRoot), join(resolve(bundleRoot), safeRelative(relativePath)))
}

export function prepareAtomicOutput(output, force = false) {
  const target = resolve(output)
  const replace = existsSync(target)
  if (replace && !force) throw new Error(`Output already exists: ${target}. Use --force to replace it.`)
  const partial = `${target}.partial-${process.pid}-${Date.now()}`
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })
  return { target, partial, replace }
}

export function commitAtomicOutput(transaction) {
  const { target, partial, replace } = transaction
  const backup = `${target}.backup-${process.pid}-${Date.now()}`
  if (replace && existsSync(target)) renameSync(target, backup)
  try {
    renameSync(partial, target)
    rmSync(backup, { recursive: true, force: true })
    return target
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target)
    throw error
  }
}

export function abortAtomicOutput(transaction) {
  rmSync(transaction.partial, { recursive: true, force: true })
}

export function copyTreeRaw(source, destination) {
  if (!existsSync(source)) return
  const visit = (current, rel = '') => {
    const info = lstatSync(current)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        visit(join(current, entry.name), rel ? join(rel, entry.name) : entry.name)
      }
      return
    }
    if (!info.isFile()) return
    const target = join(destination, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(current, target)
  }
  visit(resolve(source))
}

export function appendText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, text, 'utf8')
}

export { stableId }
