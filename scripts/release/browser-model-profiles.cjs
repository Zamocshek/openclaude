const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REGISTRY_VERSION = 1
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/

const BUILTIN_BROWSER_MODEL_PROFILES = Object.freeze([
  Object.freeze({
    id: 'qwen',
    label: 'Qwen Chat',
    url: 'https://chat.qwen.ai/',
    userId: 'nova-qwen-max',
    sessionKey: 'qwen-collaboration',
    defaultModel: 'Qwen3.8-Max-Preview',
    enabled: true,
  }),
  Object.freeze({
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    userId: 'nova-browser-chatgpt',
    sessionKey: 'browser-model-chatgpt',
    defaultModel: '',
    enabled: true,
  }),
  Object.freeze({
    id: 'claude',
    label: 'Claude',
    url: 'https://claude.ai/new',
    userId: 'nova-browser-claude',
    sessionKey: 'browser-model-claude',
    defaultModel: '',
    enabled: true,
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    userId: 'nova-browser-gemini',
    sessionKey: 'browser-model-gemini',
    defaultModel: '',
    enabled: true,
  }),
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek Chat',
    url: 'https://chat.deepseek.com/',
    userId: 'nova-browser-deepseek',
    sessionKey: 'browser-model-deepseek',
    defaultModel: '',
    enabled: true,
  }),
  Object.freeze({
    id: 'perplexity',
    label: 'Perplexity',
    url: 'https://www.perplexity.ai/',
    userId: 'nova-browser-perplexity',
    sessionKey: 'browser-model-perplexity',
    defaultModel: '',
    enabled: true,
  }),
])

function resolveBrowserModelPaths(
  env = process.env,
  homeDir = os.homedir(),
) {
  const authDir =
    env.OPENCLAUDE_CAMOFOX_AUTH_DIR ||
    path.join(homeDir, '.openclaude', 'camofox-auth')
  return {
    authDir,
    registryPath:
      env.OPENCLAUDE_BROWSER_MODEL_REGISTRY ||
      path.join(authDir, 'browser-model-profiles.json'),
  }
}

function assertSafeIdentifier(value, fieldName) {
  const normalized = String(value || '').trim()
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(
      `${fieldName} must use 1-96 letters, numbers, dots, underscores, or hyphens.`,
    )
  }
  return normalized
}

function normalizeProfileId(value) {
  const id = String(value || '').trim().toLowerCase()
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new Error(
      'profile id must use 1-48 lowercase letters, numbers, or hyphens.',
    )
  }
  return id
}

function normalizeProfileUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value || '').trim())
  } catch {
    throw new Error('profile url must be a valid absolute URL.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('profile url must not contain credentials.')
  }
  const localHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    'host.docker.internal',
  ])
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && localHosts.has(parsed.hostname))
  ) {
    throw new Error(
      'profile url must use HTTPS; HTTP is allowed only for a local service.',
    )
  }
  parsed.hash = ''
  return parsed.toString()
}

function normalizeProfile(input, fallback = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('profile must be a JSON object.')
  }
  const id = normalizeProfileId(input.id || fallback.id)
  const label = String(input.label ?? fallback.label ?? id).trim()
  if (!label || label.length > 80) {
    throw new Error('profile label must use 1-80 characters.')
  }
  const defaultUserId = `nova-browser-${id}`
  const defaultSessionKey = `browser-model-${id}`
  const defaultModel = String(
    input.defaultModel ?? input.model ?? fallback.defaultModel ?? '',
  ).trim()
  if (defaultModel.length > 160) {
    throw new Error('defaultModel must not exceed 160 characters.')
  }
  const enabled = input.enabled ?? fallback.enabled ?? true
  if (typeof enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.')
  }
  return {
    id,
    label,
    url: normalizeProfileUrl(input.url ?? fallback.url),
    userId: assertSafeIdentifier(
      input.userId ?? fallback.userId ?? defaultUserId,
      'userId',
    ),
    sessionKey: assertSafeIdentifier(
      input.sessionKey ?? fallback.sessionKey ?? defaultSessionKey,
      'sessionKey',
    ),
    defaultModel,
    enabled,
  }
}

function readRegistry(paths = resolveBrowserModelPaths()) {
  if (!existsSync(paths.registryPath)) {
    return { version: REGISTRY_VERSION, profiles: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(paths.registryPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Browser model registry is invalid JSON: ${error.message}`,
    )
  }
  if (
    parsed?.version !== REGISTRY_VERSION ||
    !Array.isArray(parsed?.profiles)
  ) {
    throw new Error(
      `Browser model registry must contain version ${REGISTRY_VERSION} and a profiles array.`,
    )
  }
  return parsed
}

function writeRegistry(paths, registry) {
  mkdirSync(path.dirname(paths.registryPath), { recursive: true })
  const temporaryPath = `${paths.registryPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  renameSync(temporaryPath, paths.registryPath)
  try {
    chmodSync(paths.registryPath, 0o600)
  } catch {
    // Windows ACLs, rather than POSIX mode bits, protect this file.
  }
}

function readProfileStatus(profileId, paths = resolveBrowserModelPaths()) {
  const statusPath = path.join(paths.authDir, `${profileId}-status.json`)
  if (!existsSync(statusPath)) return { phase: 'not-started' }
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8'))
    const phase = String(status?.phase || 'unknown').slice(0, 40)
    return {
      phase,
      authenticated:
        status?.authenticated === true || phase === 'authenticated',
      updatedAt:
        typeof status?.updatedAt === 'string'
          ? status.updatedAt
          : undefined,
      model:
        typeof status?.model === 'string'
          ? status.model.slice(0, 160)
          : undefined,
      message:
        typeof status?.message === 'string'
          ? status.message.slice(0, 300)
          : undefined,
    }
  } catch {
    return { phase: 'invalid-status' }
  }
}

function listBrowserModelProfiles(options = {}) {
  const paths =
    options.paths ||
    resolveBrowserModelPaths(options.env, options.homeDir)
  const builtins = new Map(
    BUILTIN_BROWSER_MODEL_PROFILES.map(profile => [
      profile.id,
      { ...profile, builtIn: true },
    ]),
  )
  const customProfiles = readRegistry(paths).profiles
  for (const input of customProfiles) {
    const id = normalizeProfileId(input?.id)
    const existing = builtins.get(id)
    builtins.set(id, {
      ...normalizeProfile(input, existing),
      builtIn: Boolean(existing?.builtIn),
      customized: true,
    })
  }
  return [...builtins.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map(profile => ({
      ...profile,
      status: readProfileStatus(profile.id, paths),
      loginCommand: `bun run release:camofox:auth -- login ${profile.id}`,
    }))
}

function getBrowserModelProfile(id, options = {}) {
  const normalizedId = normalizeProfileId(id)
  const profile = listBrowserModelProfiles(options).find(
    candidate => candidate.id === normalizedId,
  )
  if (!profile) {
    throw new Error(`Unknown browser model profile: ${normalizedId}`)
  }
  return profile
}

function upsertBrowserModelProfile(input, options = {}) {
  const paths =
    options.paths ||
    resolveBrowserModelPaths(options.env, options.homeDir)
  const id = normalizeProfileId(input?.id)
  const current = listBrowserModelProfiles({ paths }).find(
    profile => profile.id === id,
  )
  const profile = normalizeProfile(input, current)
  const registry = readRegistry(paths)
  const index = registry.profiles.findIndex(item => item?.id === id)
  if (index >= 0) registry.profiles[index] = profile
  else registry.profiles.push(profile)
  registry.profiles.sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  )
  writeRegistry(paths, registry)
  return getBrowserModelProfile(id, { paths })
}

function removeBrowserModelProfile(id, options = {}) {
  const paths =
    options.paths ||
    resolveBrowserModelPaths(options.env, options.homeDir)
  const normalizedId = normalizeProfileId(id)
  const registry = readRegistry(paths)
  const nextProfiles = registry.profiles.filter(
    profile => profile?.id !== normalizedId,
  )
  const removed = nextProfiles.length !== registry.profiles.length
  if (removed) {
    writeRegistry(paths, {
      version: REGISTRY_VERSION,
      profiles: nextProfiles,
    })
  }
  const builtin = BUILTIN_BROWSER_MODEL_PROFILES.some(
    profile => profile.id === normalizedId,
  )
  return {
    id: normalizedId,
    removed,
    restoredBuiltin: removed && builtin,
  }
}

function removeBrowserModelStatus(id, options = {}) {
  const paths =
    options.paths ||
    resolveBrowserModelPaths(options.env, options.homeDir)
  const normalizedId = normalizeProfileId(id)
  for (const suffix of ['status.json', 'control.json']) {
    const filePath = path.join(paths.authDir, `${normalizedId}-${suffix}`)
    if (existsSync(filePath)) unlinkSync(filePath)
  }
}

module.exports = {
  BUILTIN_BROWSER_MODEL_PROFILES,
  REGISTRY_VERSION,
  getBrowserModelProfile,
  listBrowserModelProfiles,
  normalizeProfile,
  normalizeProfileId,
  readProfileStatus,
  removeBrowserModelProfile,
  removeBrowserModelStatus,
  resolveBrowserModelPaths,
  upsertBrowserModelProfile,
}
