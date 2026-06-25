/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  type AgentGatewayConfig,
  type AgentGatewayPermissionMode,
  generateAgentGatewayApiKey,
  getAgentGatewayConfigPath,
  loadAgentGatewayConfig,
  maskSecret,
  saveAgentGatewayConfig,
} from '../../services/agentGateway/config.js'
import {
  addCuratedMemoryEntry,
  applyOrStageCuratedMemoryAction,
  approvePendingCuratedMemoryAction,
  getCuratedMemoryStatus,
  loadPendingCuratedMemoryActions,
  listCuratedMemoryEntries,
  removeCuratedMemoryEntry,
  removeCuratedMemoryText,
  rejectPendingCuratedMemoryAction,
  replaceCuratedMemoryEntry,
  replaceCuratedMemoryText,
  searchChatLog,
  searchCuratedMemory,
  CuratedMemoryError,
  type CuratedMemoryAction,
  type CuratedMemoryActionResult,
  type CuratedMemoryKind,
  type PendingCuratedMemoryAction,
} from '../../services/agentGateway/memory.js'
import {
  startAgentGatewayFromConfig,
  stopAgentGateway,
} from '../../services/agentGateway/index.js'
import { CodexOAuthService } from '../../services/api/codexOAuth.js'
import {
  DEFAULT_CODEX_BASE_URL,
  resolveCodexApiCredentials,
} from '../../services/api/providerConfig.js'
import { openBrowser } from '../../utils/browser.js'
import {
  clearCodexCredentials,
  readCodexCredentials,
  saveCodexCredentials,
} from '../../utils/codexCredentials.js'
import { errorMessage } from '../../utils/errors.js'
import {
  applySavedProfileToCurrentSession,
  buildCodexOAuthProfileEnv,
  clearPersistedCodexOAuthProfile,
  createProfileFile,
  loadProfileFile,
  saveProfileFile,
} from '../../utils/providerProfile.js'
import {
  addProviderProfile,
  deleteProviderProfile,
  getProviderProfiles,
  setActiveProviderProfile,
  updateProviderProfile,
} from '../../utils/providerProfiles.js'
import { cliError, cliOk } from '../exit.js'

type OutputOptions = {
  json?: boolean
}

export type GatewayAuthLoginOptions = OutputOptions & {
  apiKey?: string
  generate?: boolean
  showKey?: boolean
  host?: string
  port?: string
  model?: string
  cwd?: string
  permissionMode?: string
  maxTurns?: string
  timeoutMs?: string
  corsOrigins?: string
  disableApi?: boolean
}

export type GatewayConfigureOptions = OutputOptions & {
  enableApi?: boolean
  disableApi?: boolean
  host?: string
  port?: string
  model?: string
  apiKey?: string
  corsOrigins?: string
  cwd?: string
  permissionMode?: string
  maxTurns?: string
  timeoutMs?: string
  tools?: string
  disallowedTools?: string
  enableTelegram?: boolean
  disableTelegram?: boolean
  telegramBotToken?: string
  telegramHomeChatId?: string
  telegramAllowedChatIds?: string
  telegramAllowedUserIds?: string
  enableCron?: boolean
  disableCron?: boolean
  enableMemory?: boolean
  disableMemory?: boolean
  enableUserProfile?: boolean
  disableUserProfile?: boolean
  memoryApproval?: boolean
  noMemoryApproval?: boolean
}

export type GatewayRunOptions = OutputOptions & {
  url?: string
  apiKey?: string
  instructions?: string
  conversation?: string
  timeoutMs?: string
}

export type GatewayHealthOptions = OutputOptions & {
  url?: string
  apiKey?: string
  timeoutMs?: string
}

export type GatewayCodexLoginOptions = OutputOptions & {
  model?: string
  noBrowser?: boolean
  showKey?: boolean
  noActivate?: boolean
}

export type GatewayCodexStatusOptions = OutputOptions & {
  showKey?: boolean
}

export type GatewayCodexLogoutOptions = OutputOptions & {
  keepProfile?: boolean
}

export type GatewaySetupNewProviderApiOptions =
  GatewayCodexLoginOptions &
  GatewayAuthLoginOptions & {
    codex?: boolean
  }

export type GatewayMemoryOptions = OutputOptions & {
  kind?: string
  tags?: string
  source?: string
  sessions?: boolean
  limit?: string
  force?: boolean
  oldText?: string
}

export type GatewayMemoryToolOptions = GatewayMemoryOptions & {
  action?: string
  content?: string
}

type GatewayStatus = {
  configPath: string
  api: {
    enabled: boolean
    url: string
    modelName: string
    auth: 'configured' | 'not_configured'
    apiKey: string | undefined
    corsOrigins: string[]
  }
  telegram: {
    enabled: boolean
    botToken: string
    homeChatId: string | undefined
    allowedChatIds: number
    allowedUserIds: number
  }
  cron: {
    enabled: boolean
    tickIntervalSeconds: number
  }
  memory: {
    enabled: boolean
    userProfileEnabled: boolean
    writeApproval: boolean
  }
  ouroboros: {
    enabled: boolean
    consciousnessEnabled: boolean
  }
  runner: AgentGatewayConfig['runner']
}

export function getAgentGatewayBaseUrl(
  config: AgentGatewayConfig,
  overrideUrl?: string,
): string {
  const raw = (overrideUrl || `http://${config.api.host}:${config.api.port}`)
    .trim()
    .replace(/\/+$/u, '')
  if (!raw) return `http://${config.api.host}:${config.api.port}`
  return raw.endsWith('/v1') ? raw.slice(0, -3) : raw
}

export function getAgentGatewayApiUrl(
  config: AgentGatewayConfig,
  path: string,
  overrideUrl?: string,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getAgentGatewayBaseUrl(config, overrideUrl)}${normalizedPath}`
}

export function buildAgentGatewayHeaders(
  apiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

export function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) return ''
  const parts: string[] = []

  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const chunk of content) {
      if (!chunk || typeof chunk !== 'object') continue
      const text = (chunk as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }

  return parts.join('\n').trim()
}

export function buildAgentGatewayStatus(
  config: AgentGatewayConfig,
  options: { showKey?: boolean } = {},
): GatewayStatus {
  return {
    configPath: getAgentGatewayConfigPath(),
    api: {
      enabled: config.api.enabled,
      url: `${getAgentGatewayBaseUrl(config)}/v1`,
      modelName: config.api.modelName,
      auth: config.api.apiKey ? 'configured' : 'not_configured',
      apiKey: options.showKey ? config.api.apiKey : maskSecret(config.api.apiKey),
      corsOrigins: config.api.corsOrigins,
    },
    telegram: {
      enabled: config.telegram.enabled,
      botToken: maskSecret(config.telegram.botToken),
      homeChatId: config.telegram.homeChatId,
      allowedChatIds: config.telegram.allowedChatIds.length,
      allowedUserIds: config.telegram.allowedUserIds.length,
    },
    cron: {
      enabled: config.cron.enabled,
      tickIntervalSeconds: config.cron.tickIntervalSeconds,
    },
    memory: {
      enabled: config.memory.enabled,
      userProfileEnabled: config.memory.userProfileEnabled,
      writeApproval: config.memory.writeApproval,
    },
    ouroboros: {
      enabled: config.ouroboros.enabled,
      consciousnessEnabled: config.ouroboros.consciousnessEnabled,
    },
    runner: config.runner,
  }
}

export function formatAgentGatewayStatus(status: GatewayStatus): string {
  return [
    `Config: ${status.configPath}`,
    `API: ${status.api.enabled ? 'enabled' : 'disabled'} ${status.api.url}`,
    `API auth: ${status.api.auth} (${status.api.apiKey || 'not set'})`,
    `Model: ${status.api.modelName}`,
    `Telegram: ${status.telegram.enabled ? 'enabled' : 'disabled'} token=${status.telegram.botToken}`,
    `Telegram home chat: ${status.telegram.homeChatId || 'not set'}`,
    `Telegram allowlists: chats=${status.telegram.allowedChatIds} users=${status.telegram.allowedUserIds}`,
    `Cron: ${status.cron.enabled ? 'enabled' : 'disabled'} tick=${status.cron.tickIntervalSeconds}s`,
    `Memory: ${status.memory.enabled ? 'enabled' : 'disabled'} user=${status.memory.userProfileEnabled ? 'enabled' : 'disabled'} approval=${status.memory.writeApproval ? 'on' : 'off'}`,
    `Ouroboros: ${status.ouroboros.enabled ? 'enabled' : 'disabled'} consciousness=${status.ouroboros.consciousnessEnabled}`,
    `Runner cwd: ${status.runner.cwd || process.cwd()}`,
    `Runner permission mode: ${status.runner.permissionMode}`,
    `Runner max turns: ${status.runner.maxTurns}`,
    `Runner timeout: ${status.runner.timeoutMs}ms`,
  ].join('\n')
}

export function buildAgentGatewayAuthLoginConfig(
  config: AgentGatewayConfig,
  options: GatewayAuthLoginOptions,
  generatedApiKey = generateAgentGatewayApiKey(),
): AgentGatewayConfig {
  const apiKey = options.apiKey?.trim()
    || (options.generate || !config.api.apiKey ? generatedApiKey : config.api.apiKey)

  return buildAgentGatewayConfiguredConfig(
    {
      ...config,
      api: {
        ...config.api,
        enabled: !options.disableApi,
        apiKey,
      },
    },
    options,
  )
}

export function buildAgentGatewayConfiguredConfig(
  config: AgentGatewayConfig,
  options: GatewayConfigureOptions | GatewayAuthLoginOptions,
): AgentGatewayConfig {
  const next: AgentGatewayConfig = {
    ...config,
    api: { ...config.api },
    memory: { ...config.memory },
    telegram: { ...config.telegram },
    cron: { ...config.cron },
    runner: { ...config.runner },
  }

  if ('enableApi' in options && options.enableApi) next.api.enabled = true
  if ('disableApi' in options && options.disableApi) next.api.enabled = false
  if (options.host) next.api.host = options.host.trim()
  if (options.port) next.api.port = parsePort(options.port, 'port')
  if (options.model) next.api.modelName = options.model.trim()
  if (options.apiKey) next.api.apiKey = options.apiKey.trim()
  if (options.corsOrigins !== undefined) {
    next.api.corsOrigins = splitListOption(options.corsOrigins)
  }

  if (options.cwd) next.runner.cwd = options.cwd.trim()
  if (options.permissionMode) {
    next.runner.permissionMode = parseGatewayPermissionMode(options.permissionMode)
  }
  if (options.maxTurns) {
    next.runner.maxTurns = parsePositiveInteger(options.maxTurns, 'max turns')
  }
  if (options.timeoutMs) {
    next.runner.timeoutMs = parsePositiveInteger(options.timeoutMs, 'timeout')
  }

  if ('tools' in options && options.tools !== undefined) {
    next.runner.availableTools = splitListOption(options.tools)
  }
  if ('disallowedTools' in options && options.disallowedTools !== undefined) {
    next.runner.disallowedTools = splitListOption(options.disallowedTools)
  }

  if ('enableTelegram' in options && options.enableTelegram) {
    next.telegram.enabled = true
  }
  if ('disableTelegram' in options && options.disableTelegram) {
    next.telegram.enabled = false
  }
  if ('telegramBotToken' in options && options.telegramBotToken !== undefined) {
    next.telegram.botToken = options.telegramBotToken.trim() || undefined
  }
  if (
    'telegramHomeChatId' in options &&
    options.telegramHomeChatId !== undefined
  ) {
    next.telegram.homeChatId = options.telegramHomeChatId.trim() || undefined
  }
  if (
    'telegramAllowedChatIds' in options &&
    options.telegramAllowedChatIds !== undefined
  ) {
    next.telegram.allowedChatIds = splitListOption(options.telegramAllowedChatIds)
  }
  if (
    'telegramAllowedUserIds' in options &&
    options.telegramAllowedUserIds !== undefined
  ) {
    next.telegram.allowedUserIds = splitListOption(options.telegramAllowedUserIds)
  }

  if ('enableCron' in options && options.enableCron) next.cron.enabled = true
  if ('disableCron' in options && options.disableCron) next.cron.enabled = false

  if ('enableMemory' in options && options.enableMemory) next.memory.enabled = true
  if ('disableMemory' in options && options.disableMemory) next.memory.enabled = false
  if ('enableUserProfile' in options && options.enableUserProfile) {
    next.memory.userProfileEnabled = true
  }
  if ('disableUserProfile' in options && options.disableUserProfile) {
    next.memory.userProfileEnabled = false
  }
  if ('memoryApproval' in options && options.memoryApproval === true) {
    next.memory.writeApproval = true
  }
  if ('memoryApproval' in options && options.memoryApproval === false) {
    next.memory.writeApproval = false
  }
  if ('noMemoryApproval' in options && options.noMemoryApproval) {
    next.memory.writeApproval = false
  }

  return next
}

export function buildCodexGatewayProviderProfileInput(
  model = 'codexplan',
): {
  provider: 'openai'
  name: string
  baseUrl: string
  model: string
  apiKey: string
} {
  return {
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: DEFAULT_CODEX_BASE_URL,
    model: model.trim() || 'codexplan',
    apiKey: '',
  }
}

export function buildCodexGatewayProfileFile(
  tokens: {
    accessToken: string
    idToken?: string
    accountId?: string
  },
  model = 'codexplan',
) {
  const env = buildCodexOAuthProfileEnv(tokens)
  if (!env) return null
  return createProfileFile('codex', {
    ...env,
    OPENAI_MODEL: model.trim() || env.OPENAI_MODEL || 'codexplan',
  })
}

function findCodexOAuthProviderProfile(): ReturnType<typeof getProviderProfiles>[number] | undefined {
  return getProviderProfiles().find(
    profile =>
      profile.baseUrl.replace(/\/+$/u, '') === DEFAULT_CODEX_BASE_URL &&
      profile.name.toLowerCase().includes('codex'),
  )
}

function formatCodexGatewayStatus(status: Record<string, unknown>): string {
  return [
    `Codex auth: ${status.loggedIn ? 'configured' : 'not configured'}`,
    `Credential source: ${status.credentialSource || 'none'}`,
    `Account ID: ${status.accountId || 'not set'}`,
    `API key: ${status.apiKey || 'not set'}`,
    `Stored OAuth credentials: ${status.storedOAuth ? 'yes' : 'no'}`,
    `Provider profile: ${status.providerProfile || 'not set'}`,
    `Startup profile: ${status.startupProfile || 'not set'}`,
  ].join('\n')
}

function formatGatewayModelStatus(status: Record<string, unknown>): string {
  const codex = status.codex && typeof status.codex === 'object'
    ? status.codex as Record<string, unknown>
    : {}
  return [
    `Gateway model: ${status.modelName}`,
    `Gateway API URL: ${status.apiUrl}`,
    `Codex auth: ${codex.loggedIn ? 'configured' : 'not configured'}`,
    `Codex credential source: ${codex.credentialSource || 'none'}`,
    `Provider profile: ${codex.providerProfile || 'not set'}`,
    `Startup profile: ${codex.startupProfile || 'not set'}`,
  ].join('\n')
}

export async function agentGatewayStatusHandler(
  options: OutputOptions & { showKey?: boolean },
): Promise<void> {
  const config = await loadAgentGatewayConfig()
  const status = buildAgentGatewayStatus(config, options)
  if (options.json) {
    cliOk(JSON.stringify(status, null, 2))
  } else {
    cliOk(formatAgentGatewayStatus(status))
  }
}

export async function agentGatewayModelHandler(
  options: OutputOptions & { showKey?: boolean },
): Promise<void> {
  try {
    const config = await loadAgentGatewayConfig()
    const status = {
      modelName: config.api.modelName,
      apiUrl: `${getAgentGatewayBaseUrl(config)}/v1`,
      codex: buildCodexGatewayStatus(options),
    }
    if (options.json) {
      return cliOk(JSON.stringify(status, null, 2))
    }
    cliOk(formatGatewayModelStatus(status))
  } catch (error) {
    cliError(`Failed to read gateway model status: ${errorMessage(error)}`)
  }
}

export async function agentGatewayAuthLoginHandler(
  options: GatewayAuthLoginOptions,
): Promise<void> {
  try {
    const config = await loadAgentGatewayConfig()
    const apiKey = await resolveApiKeyOption(options.apiKey)
    const next = buildAgentGatewayAuthLoginConfig(config, {
      ...options,
      apiKey,
    })
    await saveAgentGatewayConfig(next)
    const status = buildAgentGatewayStatus(next, { showKey: options.showKey })

    if (options.json) {
      return cliOk(JSON.stringify(status, null, 2))
    }

    const lines = [
      'Agent gateway API auth configured.',
      `Config: ${status.configPath}`,
      `API: ${status.api.url}`,
      `API key: ${status.api.apiKey || 'not set'}`,
    ]
    if (!options.showKey) {
      lines.push('Use --show-key only when you explicitly need to reveal it.')
    }
    cliOk(lines.join('\n'))
  } catch (error) {
    cliError(`Failed to configure agent gateway auth: ${errorMessage(error)}`)
  }
}

export async function agentGatewaySetupNewProviderApiHandler(
  options: GatewaySetupNewProviderApiOptions,
): Promise<void> {
  if (options.codex !== false && !options.apiKey) {
    await agentGatewayCodexLoginHandler(options)
    return
  }
  await agentGatewayAuthLoginHandler({
    ...options,
    generate: options.generate || !options.apiKey,
  })
}

export async function agentGatewayAuthLogoutHandler(
  options: OutputOptions & { disableApi?: boolean },
): Promise<void> {
  try {
    const config = await loadAgentGatewayConfig()
    const next: AgentGatewayConfig = {
      ...config,
      api: {
        ...config.api,
        apiKey: undefined,
        enabled: options.disableApi ? false : config.api.enabled,
      },
    }
    await saveAgentGatewayConfig(next)
    if (options.json) {
      return cliOk(JSON.stringify(buildAgentGatewayStatus(next), null, 2))
    }
    cliOk('Agent gateway API auth cleared.')
  } catch (error) {
    cliError(`Failed to clear agent gateway auth: ${errorMessage(error)}`)
  }
}

export async function agentGatewayCodexLoginHandler(
  options: GatewayCodexLoginOptions,
): Promise<void> {
  const service = new CodexOAuthService()
  try {
    const model = options.model?.trim() || 'codexplan'
    process.stderr.write(
      'Starting Codex OAuth. Sign in with the ChatGPT/Codex account that has your subscription.\n',
    )
    const tokens = await service.startOAuthFlow(async authUrl => {
      const opened = options.noBrowser ? false : await openBrowser(authUrl)
      if (opened) {
        process.stderr.write(
          `Browser opened for Codex OAuth. If it did not appear, visit: ${authUrl}\n`,
        )
      } else {
        process.stderr.write(`Open this URL to sign in: ${authUrl}\n`)
      }
    })

    const existing = findCodexOAuthProviderProfile()
    const profileInput = buildCodexGatewayProviderProfileInput(model)
    const profile = existing
      ? updateProviderProfile(existing.id, profileInput)
      : addProviderProfile(profileInput, { makeActive: !options.noActivate })
    if (!profile) {
      throw new Error('Codex OAuth succeeded, but the provider profile could not be saved.')
    }
    if (!options.noActivate) {
      setActiveProviderProfile(profile.id)
    }

    const storageResult = saveCodexCredentials({
      apiKey: tokens.apiKey,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: tokens.accountId,
      profileId: profile.id,
    })
    if (!storageResult.success) {
      throw new Error(
        storageResult.warning ??
          'Codex OAuth succeeded, but credentials could not be saved securely.',
      )
    }

    const profileFile = buildCodexGatewayProfileFile(tokens, model)
    if (!profileFile) {
      throw new Error(
        'Codex OAuth succeeded, but the returned token did not include a ChatGPT account id.',
      )
    }
    saveProfileFile(profileFile)

    const activationWarning = options.noActivate
      ? null
      : await applySavedProfileToCurrentSession({ profileFile }).catch(error =>
        errorMessage(error),
      )
    const status = buildCodexGatewayStatus({ showKey: options.showKey })
    const output = {
      ...status,
      model,
      providerProfileId: profile.id,
      activated: !activationWarning && !options.noActivate,
      activationWarning,
    }

    if (options.json) {
      return cliOk(JSON.stringify(output, null, 2))
    }

    const lines = [
      'Codex OAuth configured for the agent gateway.',
      `Model: ${model}`,
      `Provider profile: ${profile.name} (${profile.id})`,
      `Credential source: ${status.credentialSource}`,
    ]
    if (activationWarning) {
      lines.push(`Activation warning: ${activationWarning}`)
    }
    if (!options.showKey) {
      lines.push('Use `openclaude gateway codex status --show-key` only when you need to reveal the token.')
    }
    cliOk(lines.join('\n'))
  } catch (error) {
    cliError(`Codex OAuth failed: ${errorMessage(error)}`)
  } finally {
    service.cleanup()
  }
}

export function buildCodexGatewayStatus(
  options: GatewayCodexStatusOptions = {},
): Record<string, unknown> {
  const credentials = resolveCodexApiCredentials()
  const stored = readCodexCredentials()
  const providerProfile = findCodexOAuthProviderProfile()
  const startupProfile = loadProfileFile()

  return {
    loggedIn: Boolean(credentials.apiKey),
    credentialSource: credentials.source,
    accountId: credentials.accountId ?? null,
    authPath: credentials.authPath ?? null,
    apiKey: options.showKey ? credentials.apiKey || null : maskSecret(credentials.apiKey),
    storedOAuth: Boolean(stored?.accessToken || stored?.refreshToken),
    storedProfileId: stored?.profileId ?? null,
    providerProfile: providerProfile
      ? `${providerProfile.name} (${providerProfile.id})`
      : null,
    startupProfile: startupProfile
      ? `${startupProfile.profile}:${startupProfile.env.OPENAI_MODEL || ''}`
      : null,
  }
}

export async function agentGatewayCodexStatusHandler(
  options: GatewayCodexStatusOptions,
): Promise<void> {
  const status = buildCodexGatewayStatus(options)
  if (options.json) {
    return cliOk(JSON.stringify(status, null, 2))
  }
  cliOk(formatCodexGatewayStatus(status))
}

export async function agentGatewayCodexLogoutHandler(
  options: GatewayCodexLogoutOptions,
): Promise<void> {
  try {
    const stored = readCodexCredentials()
    const cleared = clearCodexCredentials()
    if (!cleared.success) {
      throw new Error(cleared.warning ?? 'Could not clear Codex credentials.')
    }

    let removedProviderProfile = false
    let clearedStartupProfile: string | null = null
    if (!options.keepProfile) {
      clearedStartupProfile = clearPersistedCodexOAuthProfile()
      if (stored?.profileId) {
        removedProviderProfile = deleteProviderProfile(stored.profileId).removed
      }
    }

    const output = {
      loggedOut: true,
      removedProviderProfile,
      clearedStartupProfile: Boolean(clearedStartupProfile),
    }
    if (options.json) {
      return cliOk(JSON.stringify(output, null, 2))
    }
    cliOk(
      [
        'Codex OAuth credentials cleared.',
        removedProviderProfile ? 'Provider profile removed.' : null,
        clearedStartupProfile ? 'Startup Codex profile removed.' : null,
      ].filter(Boolean).join('\n'),
    )
  } catch (error) {
    cliError(`Failed to clear Codex OAuth: ${errorMessage(error)}`)
  }
}

export async function agentGatewayConfigureHandler(
  options: GatewayConfigureOptions,
): Promise<void> {
  try {
    const config = await loadAgentGatewayConfig()
    const apiKey = await resolveApiKeyOption(options.apiKey)
    const next = buildAgentGatewayConfiguredConfig(config, {
      ...options,
      apiKey,
    })
    await saveAgentGatewayConfig(next)
    const status = buildAgentGatewayStatus(next)

    if (options.json) {
      return cliOk(JSON.stringify(status, null, 2))
    }
    cliOk(formatAgentGatewayStatus(status))
  } catch (error) {
    cliError(`Failed to configure agent gateway: ${errorMessage(error)}`)
  }
}

export async function agentGatewayMemoryStatusHandler(
  options: OutputOptions,
): Promise<void> {
  try {
    const status = await getCuratedMemoryStatus()
    if (options.json) {
      return cliOk(JSON.stringify(status, null, 2))
    }
    cliOk(formatMemoryStatus(status))
  } catch (error) {
    cliError(`Failed to read memory status: ${errorMessage(error)}`)
  }
}

export async function agentGatewayMemoryListHandler(
  options: OutputOptions & { kind?: string },
): Promise<void> {
  try {
    const kind = parseCuratedMemoryKindOption(options.kind)
    const entries = await listCuratedMemoryEntries(kind)
    if (options.json) {
      return cliOk(JSON.stringify({ data: entries }, null, 2))
    }
    cliOk(formatMemoryEntries(entries))
  } catch (error) {
    cliError(formatMemoryCliError('Failed to list memory', error))
  }
}

export async function agentGatewayMemoryAddHandler(
  content: string | undefined,
  options: GatewayMemoryOptions,
): Promise<void> {
  try {
    const input = (content || (await readAllStdin())).trim()
    const result = await addCuratedMemoryEntry({
      kind: parseCuratedMemoryKindOption(options.kind) || 'memory',
      content: input,
      source: options.source || 'cli',
      tags: splitListOption(options.tags || ''),
    })
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(
      result.added
        ? `Memory saved: ${result.entry.id}`
        : `Memory already exists: ${result.entry.id}`,
    )
  } catch (error) {
    cliError(formatMemoryCliError('Failed to add memory', error))
  }
}

export async function agentGatewayMemoryToolHandler(
  options: GatewayMemoryToolOptions,
): Promise<void> {
  try {
    const action = parseMemoryActionOption(options.action)
    const content = options.content !== undefined
      ? options.content
      : action === 'remove'
        ? ''
        : await readAllStdin()
    const config = await loadAgentGatewayConfig()
    const result = await applyOrStageCuratedMemoryAction(
      {
        action,
        kind: parseCuratedMemoryKindOption(options.kind),
        content,
        oldText: options.oldText,
        source: options.source || 'cli-tool',
        tags: splitListOption(options.tags || ''),
      },
      {
        requireApproval: config.memory.writeApproval && !options.force,
      },
    )

    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(formatMemoryActionResult(result))
  } catch (error) {
    cliError(formatMemoryCliError('Failed to apply memory action', error))
  }
}

export async function agentGatewayMemoryReplaceHandler(
  id: string,
  content: string | undefined,
  options: GatewayMemoryOptions,
): Promise<void> {
  try {
    const input = (content || (await readAllStdin())).trim()
    const result = await replaceCuratedMemoryEntry({
      id,
      content: input,
      tags: options.tags !== undefined ? splitListOption(options.tags) : undefined,
    })
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(`Memory replaced: ${result.entry.id}`)
  } catch (error) {
    cliError(formatMemoryCliError('Failed to replace memory', error))
  }
}

export async function agentGatewayMemoryReplaceTextHandler(
  oldText: string,
  content: string | undefined,
  options: GatewayMemoryOptions,
): Promise<void> {
  try {
    const input = (content || (await readAllStdin())).trim()
    const result = await replaceCuratedMemoryText({
      kind: parseCuratedMemoryKindOption(options.kind),
      oldText,
      content: input,
      tags: options.tags !== undefined ? splitListOption(options.tags) : undefined,
    })
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(`Memory text replaced in: ${result.entry.id}`)
  } catch (error) {
    cliError(formatMemoryCliError('Failed to replace memory text', error))
  }
}

export async function agentGatewayMemoryRemoveHandler(
  id: string,
  options: OutputOptions,
): Promise<void> {
  try {
    const result = await removeCuratedMemoryEntry(id)
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(result.removed ? `Memory removed: ${id}` : `Memory not found: ${id}`)
  } catch (error) {
    cliError(formatMemoryCliError('Failed to remove memory', error))
  }
}

export async function agentGatewayMemoryRemoveTextHandler(
  oldText: string,
  options: GatewayMemoryOptions,
): Promise<void> {
  try {
    const result = await removeCuratedMemoryText({
      kind: parseCuratedMemoryKindOption(options.kind),
      oldText,
    })
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    const target = result.removedEntry?.id || result.entry?.id || oldText
    cliOk(result.removed ? `Memory text removed: ${target}` : 'Memory text not found.')
  } catch (error) {
    cliError(formatMemoryCliError('Failed to remove memory text', error))
  }
}

export async function agentGatewayMemorySearchHandler(
  query: string | undefined,
  options: GatewayMemoryOptions,
): Promise<void> {
  try {
    const input = (query || (await readAllStdin())).trim()
    const limit = options.limit
      ? parsePositiveInteger(options.limit, 'limit')
      : 20
    if (options.sessions) {
      const data = await searchChatLog({ query: input, limit })
      if (options.json) {
        return cliOk(JSON.stringify({ data }, null, 2))
      }
      return cliOk(formatSessionSearchResults(data))
    }

    const data = await searchCuratedMemory({
      query: input,
      kind: parseCuratedMemoryKindOption(options.kind),
      limit,
    })
    if (options.json) {
      return cliOk(JSON.stringify({ data }, null, 2))
    }
    cliOk(formatMemoryEntries(data))
  } catch (error) {
    cliError(formatMemoryCliError('Failed to search memory', error))
  }
}

export async function agentGatewayMemoryPendingHandler(
  options: OutputOptions,
): Promise<void> {
  try {
    const pending = await loadPendingCuratedMemoryActions()
    if (options.json) {
      return cliOk(JSON.stringify({ data: pending }, null, 2))
    }
    cliOk(formatPendingMemoryActions(pending))
  } catch (error) {
    cliError(formatMemoryCliError('Failed to list pending memory', error))
  }
}

export async function agentGatewayMemoryApproveHandler(
  id: string | undefined,
  options: OutputOptions,
): Promise<void> {
  try {
    const result = await approvePendingCuratedMemoryAction(id || 'all')
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(`Approved memory actions: ${result.approved.length}`)
  } catch (error) {
    cliError(formatMemoryCliError('Failed to approve memory action', error))
  }
}

export async function agentGatewayMemoryRejectHandler(
  id: string | undefined,
  options: OutputOptions,
): Promise<void> {
  try {
    const result = await rejectPendingCuratedMemoryAction(id || 'all')
    if (options.json) {
      return cliOk(JSON.stringify(result, null, 2))
    }
    cliOk(`Rejected memory actions: ${result.rejected.length}`)
  } catch (error) {
    cliError(formatMemoryCliError('Failed to reject memory action', error))
  }
}

export async function agentGatewayMemoryApprovalHandler(
  mode: string | undefined,
  options: OutputOptions,
): Promise<void> {
  try {
    const normalized = mode?.trim().toLowerCase() || 'status'
    if (normalized === 'status') {
      const config = await loadAgentGatewayConfig()
      const status = { writeApproval: config.memory.writeApproval }
      return options.json
        ? cliOk(JSON.stringify(status, null, 2))
        : cliOk(`Memory approval: ${status.writeApproval ? 'on' : 'off'}`)
    }
    if (normalized !== 'on' && normalized !== 'off') {
      throw new Error('approval mode must be one of: on, off, status')
    }

    const config = await loadAgentGatewayConfig()
    const next: AgentGatewayConfig = {
      ...config,
      memory: {
        ...config.memory,
        writeApproval: normalized === 'on',
      },
    }
    await saveAgentGatewayConfig(next)
    if (options.json) {
      return cliOk(JSON.stringify({ writeApproval: next.memory.writeApproval }, null, 2))
    }
    cliOk(`Memory approval: ${next.memory.writeApproval ? 'on' : 'off'}`)
  } catch (error) {
    cliError(`Failed to update memory approval: ${errorMessage(error)}`)
  }
}

export async function agentGatewayHealthHandler(
  options: GatewayHealthOptions,
): Promise<void> {
  let url = options.url || 'configured gateway'
  try {
    const config = await loadAgentGatewayConfig()
    url = getAgentGatewayApiUrl(config, '/health', options.url)
    const response = await fetch(url, {
      headers: buildAgentGatewayHeaders(options.apiKey || config.api.apiKey),
      signal: AbortSignal.timeout(
        parsePositiveInteger(options.timeoutMs || '5000', 'timeout'),
      ),
    })
    const payload = await readJsonResponse(response)
    if (!response.ok) {
      cliError(formatGatewayHttpError(response.status, payload))
    }
    if (options.json) {
      return cliOk(JSON.stringify(payload, null, 2))
    }
    const status = payload && typeof payload === 'object'
      ? String((payload as { status?: unknown }).status || 'unknown')
      : 'unknown'
    cliOk(`Agent gateway health: ${status}`)
  } catch (error) {
    cliError(
      `Agent gateway health check failed for ${url}: ${formatNetworkError(error)}`,
    )
  }
}

export async function agentGatewayRunHandler(
  prompt: string | undefined,
  options: GatewayRunOptions,
): Promise<void> {
  let url = options.url || 'configured gateway'
  try {
    const config = await loadAgentGatewayConfig()
    const input = (prompt || (await readAllStdin())).trim()
    if (!input) {
      cliError('Prompt is required. Pass it as an argument or pipe it on stdin.')
    }

    const body: Record<string, unknown> = {
      model: config.api.modelName,
      input,
    }
    if (options.instructions) body.instructions = options.instructions
    if (options.conversation) body.conversation = options.conversation

    url = getAgentGatewayApiUrl(config, '/v1/responses', options.url)
    const response = await fetch(url, {
      method: 'POST',
      headers: buildAgentGatewayHeaders(options.apiKey || config.api.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        parsePositiveInteger(
          options.timeoutMs || String(config.runner.timeoutMs + 5000),
          'timeout',
        ),
      ),
    })
    const payload = await readJsonResponse(response)
    if (!response.ok) {
      cliError(formatGatewayHttpError(response.status, payload))
    }

    if (options.json) {
      return cliOk(JSON.stringify(payload, null, 2))
    }

    const text = extractResponsesText(payload)
    cliOk(text || JSON.stringify(payload))
  } catch (error) {
    cliError(`Agent gateway run failed for ${url}: ${formatNetworkError(error)}`)
  }
}

export async function agentGatewayServeHandler(): Promise<void> {
  try {
    const runtime = await startAgentGatewayFromConfig()
    if (!runtime) {
      cliError(
        'Agent gateway is disabled. Run `openclaude gateway auth login --generate` or `openclaude gateway configure --enable-api` first.',
      )
    }

    process.stderr.write(
      `[agent-gateway] serving api=${runtime.api?.url ?? 'off'} telegram=${Boolean(runtime.telegram)} cron=${Boolean(runtime.cron)} consciousness=${Boolean(runtime.consciousness)}\n`,
    )

    const shutdown = async () => {
      await stopAgentGateway()
      process.exit(0)
    }
    process.once('SIGINT', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
    await new Promise(() => {})
  } catch (error) {
    cliError(`Failed to start agent gateway: ${errorMessage(error)}`)
  }
}

function parseGatewayPermissionMode(value: string): AgentGatewayPermissionMode {
  const normalized = value.trim()
  if (
    normalized === 'default' ||
    normalized === 'acceptEdits' ||
    normalized === 'bypassPermissions'
  ) {
    return normalized
  }
  throw new Error(
    'permission mode must be one of: default, acceptEdits, bypassPermissions',
  )
}

function parsePort(value: string, name: string): number {
  const port = parsePositiveInteger(value, name)
  if (port > 65535) throw new Error(`${name} must be <= 65535`)
  return port
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function splitListOption(value: string): string[] {
  return value
    .split(/[,\s]+/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseCuratedMemoryKindOption(
  value: string | undefined,
): CuratedMemoryKind | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (normalized === 'memory' || normalized === 'user') return normalized
  throw new Error('memory kind must be one of: memory, user')
}

function parseMemoryActionOption(value: string | undefined): CuratedMemoryAction {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === 'add' ||
    normalized === 'replace' ||
    normalized === 'remove'
  ) {
    return normalized
  }
  throw new Error('memory action must be one of: add, replace, remove')
}

function formatMemoryStatus(status: {
  usage: Record<string, { used: number; limit: number; count: number }>
  paths: Record<string, string>
  pending?: { count: number; path: string }
}): string {
  return [
    `MEMORY.md: ${status.usage.memory.used}/${status.usage.memory.limit} chars (${status.usage.memory.count} entries)`,
    `USER.md: ${status.usage.user.used}/${status.usage.user.limit} chars (${status.usage.user.count} entries)`,
    `Pending writes: ${status.pending?.count ?? 0}`,
    `Store: ${status.paths.store}`,
    `MEMORY.md path: ${status.paths.memory}`,
    `USER.md path: ${status.paths.user}`,
    status.pending?.path ? `Pending path: ${status.pending.path}` : '',
  ].filter(Boolean).join('\n')
}

function formatMemoryEntries(
  entries: Array<{
    id: string
    kind: string
    content: string
    source?: string
    tags?: string[]
    ts?: string
  }>,
): string {
  if (entries.length === 0) return 'No memories found.'
  return entries
    .map(entry => {
      const tags = entry.tags?.length ? ` tags=${entry.tags.join(',')}` : ''
      const ts = entry.ts ? ` ${entry.ts}` : ''
      return `[${entry.kind}] ${entry.id}${ts}${tags}\n${entry.content}`
    })
    .join('\n\n')
}

function formatSessionSearchResults(entries: Record<string, unknown>[]): string {
  if (entries.length === 0) return 'No session log entries found.'
  return entries
    .map(entry => {
      const ts = String(entry.ts || '')
      const direction = String(entry.direction || '?')
      const endpoint = String(entry.endpoint || entry.source || 'session')
      const text = String(entry.text || '').slice(0, 1000)
      return `[${ts}] ${direction} ${endpoint}\n${text}`
    })
    .join('\n\n')
}

function formatPendingMemoryActions(
  actions: PendingCuratedMemoryAction[],
): string {
  if (actions.length === 0) return 'No pending memory actions.'
  return actions
    .map(action => {
      const target = action.kind || 'memory'
      const tags = action.tags?.length ? ` tags=${action.tags.join(',')}` : ''
      const oldText = action.oldText ? ` old_text=${action.oldText}` : ''
      const content = action.content ? `\n${action.content}` : ''
      return `[${action.action}] ${action.id} ${target} ${action.ts}${tags}${oldText}${content}`
    })
    .join('\n\n')
}

function formatMemoryActionResult(result: CuratedMemoryActionResult): string {
  if (result.pending && result.staged) {
    return `Memory action staged for approval: ${result.staged.id}`
  }
  if (result.action === 'add') {
    const addResult = result.result as { entry?: { id?: string }; added?: boolean }
    return addResult.added === false
      ? `Memory already exists: ${addResult.entry?.id || 'unknown'}`
      : `Memory saved: ${addResult.entry?.id || 'unknown'}`
  }
  if (result.action === 'replace') {
    const replaceResult = result.result as { entry?: { id?: string } }
    return `Memory replaced: ${replaceResult.entry?.id || 'unknown'}`
  }
  const removeResult = result.result as {
    removed?: boolean
    entry?: { id?: string }
    removedEntry?: { id?: string }
  }
  const id = removeResult.removedEntry?.id || removeResult.entry?.id || 'unknown'
  return removeResult.removed ? `Memory removed: ${id}` : 'Memory not found.'
}

function formatMemoryCliError(prefix: string, error: unknown): string {
  if (error instanceof CuratedMemoryError) {
    return `${prefix}: ${error.message}`
  }
  return `${prefix}: ${errorMessage(error)}`
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  process.stdin.setEncoding('utf8')
  let data = ''
  for await (const chunk of process.stdin) data += String(chunk)
  return data
}

async function resolveApiKeyOption(
  apiKey: string | undefined,
): Promise<string | undefined> {
  if (apiKey !== '-') return apiKey
  const stdinApiKey = (await readAllStdin()).trim()
  if (!stdinApiKey) throw new Error('API key stdin was empty')
  return stdinApiKey
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatGatewayHttpError(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') {
      return `Agent gateway request failed (${status}): ${error.message}`
    }
  }
  return `Agent gateway request failed (${status}): ${String(payload)}`
}

function formatNetworkError(error: unknown): string {
  if (error instanceof Error && error.cause instanceof Error) {
    return `${error.message}: ${error.cause.message}`
  }
  return errorMessage(error)
}
