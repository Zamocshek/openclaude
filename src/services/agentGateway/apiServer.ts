import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { parseHumanLimit } from '../../utils/limitParsing.js'
import {
  normalizeAgentGatewayHarnessMode,
  updateAgentGatewayConfig,
  type AgentGatewayConfig,
  type AgentGatewayHarnessMode,
} from './config.js'
import {
  buildPromptFromChatMessages,
  hasCodingMutationIntent,
  normalizeMessageContent,
  runOpenClaudeAgent,
  type AgentRunOptions,
  type AgentRunResult,
} from './agentRunner.js'
import {
  createCronJob,
  deleteCronJob,
  getCronJob,
  listCronJobs,
  pauseCronJob,
  resumeCronJob,
  runCronJobNow,
  updateCronJob,
} from './cron.js'
import {
  addCuratedMemoryEntry,
  applyCuratedMemoryDirectives,
  applyOrStageCuratedMemoryAction,
  appendChatLog,
  buildMemoryContextSection,
  buildCuratedMemorySystemInstructions,
  approvePendingCuratedMemoryAction,
  extractCuratedMemoryDirectives,
  getCuratedMemoryStatus,
  loadPendingCuratedMemoryActions,
  listCuratedMemoryEntries,
  removeCuratedMemoryEntry,
  rejectPendingCuratedMemoryAction,
  replaceCuratedMemoryEntry,
  loadChatLogTranscript,
  searchChatLog,
  searchCuratedMemory,
  CuratedMemoryError,
  type CuratedMemoryKind,
} from './memory.js'
import {
  extractCurrentUserRequest,
  frameCurrentUserRequest,
} from './capabilityRouting.js'
import {
  getConversationContextMaxChars,
  getConversationContextTurnLimit,
  getMemoryContextMaxChars,
  trimConversationMessagesWithinCharBudget,
} from './conversationContext.js'
import {
  describeManagedMcpServer,
  importManagedMcpServers,
  listManagedMcpServers,
  parseMcpConfigImport,
  removeManagedMcpServer,
  setManagedMcpServerEnabled,
} from './mcpRegistry.js'
import type { SkillStoreOptions } from './skillStore.js'
import {
  deleteStoredApiResponse,
  loadLatestConversationResponseId,
  loadStoredApiResponse,
  saveStoredApiResponse,
} from './responseStore.js'
import { listToolRouterAudit, recordToolRouterAudit } from './routerAudit.js'
import {
  createFileManagerDirectory,
  FileManagerError,
  listFileManagerDirectory,
  removeFileManagerEntry,
  renameFileManagerEntry,
  streamFileManagerDownload,
  streamFileManagerUpload,
} from './fileManager.js'
import { buildFileManagerHtml } from './fileManagerUi.js'
import { buildToolRouterHtml } from './routerUi.js'
import { getAgentGatewayWebLinks } from './webLinks.js'
import { describeGatewaySubagents } from './subagentRuntime.js'
import {
  checkAndroidDevice,
  connectAndroidDevice,
  discoverAndroidDevices,
  disconnectAndroidDevice,
  listAndroidDeviceProfiles,
  pairAndroidDevice,
  registerAndroidDeviceProfile,
  removeAndroidDeviceProfile,
  setActiveAndroidDeviceProfile,
  setAndroidDeviceProfileEnabled,
} from './androidDevices.js'
import {
  describeRouterBuiltinTools,
  isRouterBuiltinToolName,
  updateRouterBuiltinToolState,
} from './toolRouterTools.js'
import {
  runOpenClaudeAgentWithCompletionGate,
} from './taskQuality.js'
import { materializeVisionInput } from './vision.js'
import {
  buildWebSessionCookie,
  clearWebSessionCookie,
  constantTimeSecretEqual,
  getWebSessionTtlMs,
  isLoopbackWebRequest,
  isSecureWebRequest,
  isWebSessionAutoAuthEnabled,
  issueWebSession,
  validateWebSessionMutation,
  webSessionFromRequest,
} from './webSessionAuth.js'

type AgentApiServerOptions = {
  config: AgentGatewayConfig
  onAgentResponse?: (text: string, source: 'api' | 'run') => void | Promise<void>
  getRuntimeStatus?: () => Record<string, unknown>
  skillStoreRoot?: string
}

type ApiAgentQueueItem = {
  id: string
  label: string
  enqueuedAt: number
  startedAt?: number
}

function createAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

type ApiAgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback
}

async function runApiAgentWithRecovery(
  runner: ApiAgentRunner,
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const maxRecoveryAttempts = parseBoundedInteger(
    process.env.OPENCLAUDE_API_AGENT_RECOVERY_ATTEMPTS,
    2,
    0,
    5,
  )
  const baseBackoffMs = parseBoundedInteger(
    process.env.OPENCLAUDE_API_AGENT_RECOVERY_BACKOFF_MS,
    1_000,
    0,
    30_000,
  )
  const originalPrompt = options.prompt
  const currentRequest = extractCurrentUserRequest(originalPrompt)
  let currentPrompt = originalPrompt
  let taskRoute = options.taskRoute
  let recoveryAttempt = 0

  while (true) {
    const result = await runner({
      ...options,
      prompt: currentPrompt,
      taskRoute,
    })
    taskRoute ||= result.taskRoute
    if (
      result.exitCode === 0
      || result.failureKind !== 'transient_network'
      || recoveryAttempt >= maxRecoveryAttempts
      || options.signal?.aborted
    ) {
      return result
    }

    recoveryAttempt += 1
    const backoffMs = Math.min(30_000, baseBackoffMs * (2 ** (recoveryAttempt - 1)))
    if (backoffMs > 0) {
      await new Promise(resolve => setTimeout(resolve, backoffMs))
      if (options.signal?.aborted) return result
    }
    const recentActivity = (result.activity || []).slice(-12).join('\n- ')
    currentPrompt = [
      `API recovery attempt ${recoveryAttempt}/${maxRecoveryAttempts} after a transient provider/network failure.`,
      'Continue the original task. Preserve completed work and change strategy only where the failed step requires it.',
      'Before any external write, inspect pending/action status and target history. Never repeat an already claimed or completed external action.',
      '',
      'Original task:',
      originalPrompt,
      '',
      'Previous run diagnostic:',
      result.diagnostic || result.stderr || 'transient network failure',
      ...(recentActivity ? ['', 'Recent activity:', `- ${recentActivity}`] : []),
      '',
      frameCurrentUserRequest(currentRequest),
    ].join('\n')
  }
}

type QueuedApiAgentExecution<T> = {
  id: string
  position: number
  promise: Promise<T>
}

type SkillStoreErrorLike = Error & {
  code?: string
}

class AgentApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly errorType = 'invalid_request_error',
  ) {
    super(message)
    this.name = 'AgentApiHttpError'
  }
}

function isAgentApiHttpError(error: unknown): error is AgentApiHttpError {
  return error instanceof AgentApiHttpError
}

function shouldUseJsonKeepalive(
  request: IncomingMessage,
  body: Record<string, any>,
): boolean {
  const header = request.headers['x-hermes-keepalive-json']
  const headerValue = Array.isArray(header) ? header[0] : header
  if (typeof headerValue === 'string') {
    const normalized = headerValue.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  }
  return body.hermes_keepalive === true || body.keepalive_json === true
}

type SseEvent = Record<string, unknown> | null

type BufferedSseEvent = {
  id: number
  event: SseEvent
}

class SseEventLog {
  private readonly events: BufferedSseEvent[] = []
  private readonly waiters = new Set<() => void>()
  private nextId = 1

  push(event: SseEvent): void {
    if (this.events.length >= getApiRunMaxBufferedEvents()) {
      this.events.shift()
    }
    this.events.push({ id: this.nextId++, event })
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }

  next(
    afterId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BufferedSseEvent | 'timeout' | 'aborted'> {
    const event = this.events.find(candidate => candidate.id > afterId)
    if (event) return Promise.resolve(event)
    if (signal?.aborted) return Promise.resolve('aborted')

    return new Promise(resolve => {
      let settled = false
      const finish = (value: BufferedSseEvent | 'timeout' | 'aborted') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(waiter)
        resolve(value)
      }
      const timer = setTimeout(() => {
        finish('timeout')
      }, timeoutMs)
      const waiter = () => {
        const nextEvent = this.events.find(candidate => candidate.id > afterId)
        if (nextEvent) finish(nextEvent)
      }
      const onAbort = () => finish('aborted')
      this.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

type ManagedRun = {
  queue: SseEventLog
  controller: AbortController
  cleanupTimer?: ReturnType<typeof setTimeout>
}

type FrontmatterStreamStripper = {
  push: (chunk: string) => string
  flush: () => string
}

type LineStreamStripper = {
  push: (chunk: string) => string
  flush: () => string
}

export class AgentApiServer {
  private readonly config: AgentGatewayConfig
  private readonly onAgentResponse?: AgentApiServerOptions['onAgentResponse']
  private readonly getRuntimeStatus?: AgentApiServerOptions['getRuntimeStatus']
  private readonly skillStoreOptions: SkillStoreOptions
  private server: Server | undefined
  private readonly responseStore = new Map<string, Record<string, unknown>>()
  private readonly responseOrder: string[] = []
  private readonly conversationLatest = new Map<string, string>()
  private readonly chatSessions = new Map<string, ConversationMessage[]>()
  private readonly chatSessionOrder: string[] = []
  private readonly runs = new Map<string, ManagedRun>()
  private apiAgentQueueTail: Promise<unknown> = Promise.resolve()
  private apiAgentQueueActive: ApiAgentQueueItem | undefined
  private apiAgentQueueWaiting = 0
  private apiAgentQueueSequence = 0
  private apiAgentQueueCompleted = 0
  private apiAgentQueueCancelled = 0
  private apiQueueShutdownController = new AbortController()

  constructor(options: AgentApiServerOptions) {
    this.config = options.config
    this.onAgentResponse = options.onAgentResponse
    this.getRuntimeStatus = options.getRuntimeStatus
    this.skillStoreOptions = options.skillStoreRoot
      ? { skillsRoot: options.skillStoreRoot }
      : {}
  }

  async start(): Promise<void> {
    if (this.server) return
    if (this.apiQueueShutdownController.signal.aborted) {
      this.apiQueueShutdownController = new AbortController()
    }
    this.validateExposure()

    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        if (response.headersSent) {
          response.end()
          return
        }
        if (isAgentApiHttpError(error)) {
          this.writeJson(
            response,
            error.statusCode,
            openAiError(error.message, error.errorType),
          )
          return
        }
        this.writeJson(response, 500, openAiError(String(error), 'server_error'))
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.config.api.port, this.config.api.host, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.apiQueueShutdownController.abort()
    for (const run of this.runs.values()) {
      if (run.cleanupTimer) clearTimeout(run.cleanupTimer)
      run.controller.abort()
      run.queue.push(null)
    }
    this.runs.clear()
    if (!this.server) return
    const server = this.server
    this.server = undefined
    const closeableServer = server as Server & {
      closeAllConnections?: () => void
      closeIdleConnections?: () => void
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(forceCloseTimer)
        if (error) reject(error)
        else resolve()
      }
      const forceCloseTimer = setTimeout(() => {
        closeableServer.closeAllConnections?.()
        finish()
      }, 2_000)
      forceCloseTimer.unref?.()

      server.close(error => finish(error || undefined))
      closeableServer.closeIdleConnections?.()
    })
  }

  get url(): string {
    const address = this.server?.address()
    if (address && typeof address !== 'string') {
      const host =
        address.address === '::' || address.address === '0.0.0.0'
          ? '127.0.0.1'
          : address.address
      return `http://${host}:${(address as AddressInfo).port}`
    }
    return `http://${this.config.api.host}:${this.config.api.port}`
  }

  private validateExposure(): void {
    const host = this.config.api.host
    const isLocalhost =
      host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!isLocalhost && !this.config.api.apiKey) {
      throw new Error(
        'Agent API refuses to bind outside localhost without an API key',
      )
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method || 'GET'
    const url = new URL(request.url || '/', this.url)

    if (method === 'OPTIONS') {
      this.writeCors(response, 204)
      return
    }

    if (url.pathname === '/health' || url.pathname === '/v1/health') {
      const runtime = this.getRuntimeStatus?.()
      this.writeJson(response, 200, {
        status: 'ok',
        platform: 'openclaude-agent',
        api: this.config.api.enabled,
        cron: this.config.cron.enabled,
        telegram: this.config.telegram.enabled,
        ...(runtime ? { runtime } : {}),
      })
      return
    }

    if (url.pathname === '/ready' || url.pathname === '/v1/ready') {
      const runtime = this.getRuntimeStatus?.() || {}
      const telegram = runtime.telegram as {
        stopped?: boolean
        polling?: boolean
      } | undefined
      const telegramReady = !this.config.telegram.enabled
        || Boolean(telegram && !telegram.stopped && telegram.polling)
      const ready = this.config.api.enabled && telegramReady
      this.writeJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        checks: {
          api: this.config.api.enabled,
          telegram: telegramReady,
          cron: this.config.cron.enabled,
        },
      }, {
        'Cache-Control': 'no-store',
      })
      return
    }

    if ((url.pathname === '/router' || url.pathname === '/router/') && method === 'GET') {
      this.writeHtml(
        response,
        200,
        buildToolRouterHtml(getAgentGatewayWebLinks(this.config), {
          embeddedApiKey: getRouterAutoAuthKey(this.config),
        }),
        this.webSessionPageHeaders(request),
      )
      return
    }

    if ((url.pathname === '/files' || url.pathname === '/files/') && method === 'GET') {
      this.writeHtml(
        response,
        200,
        buildFileManagerHtml({ embeddedApiKey: getRouterAutoAuthKey(this.config) }),
        this.webSessionPageHeaders(request),
      )
      return
    }

    if (url.pathname === '/api/ui/session') {
      await this.handleWebSession(request, response)
      return
    }

    if (isProtectedApiPath(url.pathname)) {
      if (!this.checkAuth(request, response, url.pathname)) return
    }

    const apiPath = normalizeOpenAiPath(url.pathname)

    if (method === 'GET' && apiPath === '/models') {
      this.writeJson(response, 200, {
        object: 'list',
        data: [this.modelPayload()],
      })
      return
    }

    const modelMatch = apiPath.match(/^\/models\/([^/]+)$/)
    if (modelMatch && method === 'GET') {
      const requestedModel = decodeURIComponent(modelMatch[1] || '')
      if (requestedModel && requestedModel !== this.config.api.modelName) {
        this.writeJson(response, 404, openAiError('Model not found'))
        return
      }
      this.writeJson(response, 200, this.modelPayload())
      return
    }

    if (method === 'POST' && apiPath === '/chat/completions') {
      await this.handleChatCompletions(request, response)
      return
    }

    if (method === 'POST' && apiPath === '/responses') {
      await this.handleResponses(request, response)
      return
    }

    const responseMatch = apiPath.match(/^\/responses\/([^/]+)$/)
    if (responseMatch && method === 'GET') {
      const stored = await this.getStoredResponse(responseMatch[1]!)
      if (!stored) {
        this.writeJson(response, 404, openAiError('Response not found'))
        return
      }
      this.writeJson(response, 200, stored.response)
      return
    }
    if (responseMatch && method === 'DELETE') {
      const responseId = responseMatch[1]!
      const deleted = await deleteStoredApiResponse(responseId)
        || this.responseStore.delete(responseId)
      if (deleted) this.forgetStoredResponse(responseId)
      this.writeJson(response, deleted ? 200 : 404, {
        id: responseId,
        object: 'response',
        deleted,
      })
      return
    }

    if (method === 'POST' && apiPath === '/runs') {
      await this.handleRuns(request, response)
      return
    }

    const runMatch = apiPath.match(/^\/runs\/([^/]+)\/events$/)
    if (runMatch && method === 'GET') {
      await this.handleRunEvents(runMatch[1]!, request, response)
      return
    }

    if (url.pathname === '/api/queue/status' && method === 'GET') {
      this.writeJson(response, 200, this.getApiQueueStatusPayload())
      return
    }

    if (url.pathname === '/api/files/download' && method === 'GET') {
      try {
        await streamFileManagerDownload(
          this.config.runner.cwd || process.cwd(),
          url.searchParams.get('path') || '',
          response,
        )
      } catch (error) {
        this.writeFileManagerError(response, error)
      }
      return
    }

    if (url.pathname === '/api/files/upload' && method === 'POST') {
      try {
        const result = await streamFileManagerUpload(
          this.config.runner.cwd || process.cwd(),
          url.searchParams.get('path') || '',
          url.searchParams.get('name') || '',
          request,
        )
        await recordToolRouterAudit({ action: 'files.uploaded', target: result.path })
        this.writeJson(response, 201, { data: result })
      } catch (error) {
        this.writeFileManagerError(response, error)
      }
      return
    }

    if (url.pathname === '/api/files/folder' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const path = String(body.path || '')
        await createFileManagerDirectory(this.config.runner.cwd || process.cwd(), path)
        await recordToolRouterAudit({ action: 'files.folder_created', target: path })
        this.writeJson(response, 201, { created: path })
      } catch (error) {
        this.writeFileManagerError(response, error)
      }
      return
    }

    if (url.pathname === '/api/files/rename' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const from = String(body.from || '')
        const to = String(body.to || '')
        await renameFileManagerEntry(this.config.runner.cwd || process.cwd(), from, to)
        await recordToolRouterAudit({ action: 'files.renamed', target: `${from} -> ${to}` })
        this.writeJson(response, 200, { renamed: true })
      } catch (error) {
        this.writeFileManagerError(response, error)
      }
      return
    }

    if (url.pathname === '/api/files') {
      const path = url.searchParams.get('path') || ''
      try {
        if (method === 'GET') {
          this.writeJson(response, 200, {
            data: await listFileManagerDirectory(
              this.config.runner.cwd || process.cwd(),
              path,
            ),
          })
          return
        }
        if (method === 'DELETE') {
          await removeFileManagerEntry(this.config.runner.cwd || process.cwd(), path)
          await recordToolRouterAudit({ action: 'files.deleted', target: path })
          this.writeJson(response, 200, { deleted: path })
          return
        }
      } catch (error) {
        this.writeFileManagerError(response, error)
        return
      }
    }

    if (url.pathname === '/api/router/overview' && method === 'GET') {
      const projectRoot = this.config.runner.cwd || process.cwd()
      try {
        const [servers, skills] = await Promise.all([
          listManagedMcpServers(projectRoot),
          this.loadSkillStore().then(skillStore =>
            skillStore.listSkillStore(projectRoot, this.skillStoreOptions),
          ),
        ])
        this.writeJson(response, 200, {
          data: {
            tools: {
              enabled: !this.config.runner.disableTools,
              available: this.config.runner.availableTools,
              disallowed: this.config.runner.disallowedTools,
              catalog: this.describeRouterTools(),
            },
            harness: { mode: this.config.runner.harnessMode },
            mcp: {
              total: servers.length,
              enabled: servers.filter(server => server.enabled).length,
            },
            skills: { total: skills.length },
            subagents: describeGatewaySubagents(this.config),
            runtime: this.getRuntimeStatus?.() || {},
          },
        })
      } catch (error) {
        this.writeSkillStoreError(response, error)
      }
      return
    }

    if (url.pathname === '/api/subagents') {
      if (method === 'GET') {
        this.writeJson(response, 200, { data: describeGatewaySubagents(this.config) })
        return
      }
      if (method === 'PATCH') {
        try {
          const body = await this.readJson(request)
          const next = await updateAgentGatewayConfig(current => ({
            ...current,
            subagents: {
              ...current.subagents,
              ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
              ...(body.maxParallel === undefined ? {} : { maxParallel: body.maxParallel }),
              ...(body.routes === undefined ? {} : { routes: body.routes }),
            },
          }))
          Object.assign(this.config.subagents, next.subagents)
          await recordToolRouterAudit({
            action: 'subagents.updated',
            target: `${next.subagents.enabled ? 'enabled' : 'disabled'}; ${Object.keys(next.subagents.routes).length} routes`,
          })
          this.writeJson(response, 200, { data: describeGatewaySubagents(this.config) })
        } catch (error) {
          this.writeApiError(response, error)
        }
        return
      }
    }

    if (url.pathname === '/api/router/activity' && method === 'GET') {
      this.writeJson(response, 200, {
        data: await listToolRouterAudit(parseLimit(url.searchParams.get('limit'), 50)),
      })
      return
    }

    if (url.pathname === '/api/router/harness') {
      if (method === 'GET') {
        this.writeJson(response, 200, {
          data: { mode: this.config.runner.harnessMode },
        })
        return
      }
      if (method === 'PATCH') {
        try {
          const body = await this.readJson(request)
          if (!isAgentGatewayHarnessMode(body.mode)) {
            this.writeJson(
              response,
              400,
              openAiError("The gateway uses the fixed 'ouroboros' harness"),
            )
            return
          }
          await this.setHarnessMode(body.mode)
          await recordToolRouterAudit({
            action: 'harness.updated',
            target: body.mode,
          })
          this.writeJson(response, 200, { data: { mode: body.mode } })
        } catch (error) {
          this.writeApiError(response, error)
        }
        return
      }
    }

    if (url.pathname === '/api/router/tools') {
      if (method === 'GET') {
        this.writeJson(response, 200, {
          data: {
            enabled: !this.config.runner.disableTools,
            available: this.config.runner.availableTools,
            disallowed: this.config.runner.disallowedTools,
            catalog: this.describeRouterTools(),
          },
        })
        return
      }
      if (method === 'PATCH') {
        try {
          const body = await this.readJson(request)
          if (typeof body.tool === 'string') {
            if (
              typeof body.enabled !== 'boolean'
              || !isRouterBuiltinToolName(body.tool)
            ) {
              this.writeJson(
                response,
                400,
                openAiError('Expected a known built-in tool and boolean enabled'),
              )
              return
            }
            await this.setBuiltinToolEnabled(body.tool, body.enabled)
            await recordToolRouterAudit({
              action: body.enabled ? 'tool.enabled' : 'tool.disabled',
              target: body.tool,
            })
            this.writeJson(response, 200, {
              data: {
                enabled: !this.config.runner.disableTools,
                available: this.config.runner.availableTools,
                disallowed: this.config.runner.disallowedTools,
                catalog: this.describeRouterTools(),
              },
            })
            return
          }
          if (typeof body.enabled !== 'boolean') {
            this.writeJson(response, 400, openAiError("Missing boolean 'enabled'"))
            return
          }
          await this.setToolsEnabled(body.enabled)
          await recordToolRouterAudit({
            action: body.enabled ? 'tools.enabled' : 'tools.disabled',
            target: 'model-tool-calls',
          })
          this.writeJson(response, 200, {
            data: { enabled: body.enabled },
          })
        } catch (error) {
          this.writeApiError(response, error)
        }
        return
      }
    }

    if (url.pathname === '/api/mcp/servers') {
      if (method === 'GET') {
        const servers = await listManagedMcpServers(
          this.config.runner.cwd || process.cwd(),
        )
        this.writeJson(response, 200, {
          data: servers.map(describeManagedMcpServer),
        })
        return
      }
      if (method === 'POST') {
        const body = await this.readJson(request)
        const parsed = parseMcpConfigImport(JSON.stringify(body))
        if (parsed === undefined) {
          this.writeJson(
            response,
            400,
            openAiError("Missing 'mcpServers' object"),
          )
          return
        }
        if (parsed.ok === false) {
          this.writeJson(
            response,
            400,
            openAiError(parsed.error),
          )
          return
        }
        const servers = await importManagedMcpServers(
          this.config.runner.cwd || process.cwd(),
          parsed.config,
        )
        await recordToolRouterAudit({
          action: 'mcp.imported',
          target: Object.keys(parsed.config.mcpServers).join(', '),
        })
        this.writeJson(response, 201, {
          imported: Object.keys(parsed.config.mcpServers),
          normalized_npx: parsed.normalizedNpxServers,
          data: servers.map(describeManagedMcpServer),
        })
        return
      }
    }

    const mcpServerMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/u)
    if (mcpServerMatch) {
      const name = decodeURIComponent(mcpServerMatch[1]!)
      try {
        if (method === 'PATCH') {
          const body = await this.readJson(request)
          if (typeof body.enabled !== 'boolean') {
            this.writeJson(response, 400, openAiError("Missing boolean 'enabled'"))
            return
          }
          const servers = await setManagedMcpServerEnabled(
            this.config.runner.cwd || process.cwd(),
            name,
            body.enabled,
          )
          await recordToolRouterAudit({
            action: body.enabled ? 'mcp.enabled' : 'mcp.disabled',
            target: name,
          })
          this.writeJson(response, 200, {
            data: servers.map(describeManagedMcpServer),
          })
          return
        }
        if (method === 'DELETE') {
          const servers = await removeManagedMcpServer(
            this.config.runner.cwd || process.cwd(),
            name,
          )
          await recordToolRouterAudit({ action: 'mcp.deleted', target: name })
          this.writeJson(response, 200, {
            deleted: name,
            data: servers.map(describeManagedMcpServer),
          })
          return
        }
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
        return
      }
    }

    if (url.pathname === '/api/android/devices') {
      try {
        if (method === 'GET') {
          const registry = await listAndroidDeviceProfiles()
          this.writeJson(response, 200, {
            data: {
              active_alias: registry.activeAlias || null,
              profiles: Object.values(registry.profiles),
            },
          })
          return
        }
        if (method === 'POST') {
          const body = await this.readJson(request)
          const registry = await registerAndroidDeviceProfile({
            projectRoot: this.config.runner.cwd || process.cwd(),
            alias: String(body.alias || ''),
            serial: String(body.serial || body.target || ''),
            connection: String(body.connection || 'auto'),
            enabled: body.enabled !== false,
            makeActive: body.make_active !== false,
          })
          await recordToolRouterAudit({
            action: 'android.profile.registered',
            target: String(body.alias || ''),
          })
          this.writeJson(response, 201, {
            data: {
              active_alias: registry.activeAlias || null,
              profiles: Object.values(registry.profiles),
            },
          })
          return
        }
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
        return
      }
    }

    if (url.pathname === '/api/android/discover' && method === 'POST') {
      try {
        const devices = await discoverAndroidDevices()
        await recordToolRouterAudit({
          action: 'android.devices.discovered',
          target: `${devices.length}`,
        })
        this.writeJson(response, 200, { data: devices })
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
      }
      return
    }

    if (url.pathname === '/api/android/connect' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const identifier = String(body.alias || body.serial || body.target || '')
        const result = await connectAndroidDevice(identifier)
        if (body.make_active !== false && result.alias) {
          await setActiveAndroidDeviceProfile(result.alias)
        }
        await recordToolRouterAudit({
          action: 'android.device.connected',
          target: result.alias || result.serial,
        })
        this.writeJson(response, 200, { data: result })
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
      }
      return
    }

    if (url.pathname === '/api/android/disconnect' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const identifier = String(body.alias || body.serial || body.target || '')
        const result = await disconnectAndroidDevice(identifier)
        await recordToolRouterAudit({
          action: 'android.device.disconnected',
          target: result.serial,
        })
        this.writeJson(response, 200, { data: result })
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
      }
      return
    }

    if (url.pathname === '/api/android/pair' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const result = await pairAndroidDevice(
          String(body.target || body.serial || ''),
          String(body.code || ''),
        )
        await recordToolRouterAudit({
          action: 'android.device.paired',
          target: result.target,
        })
        this.writeJson(response, 200, { data: result })
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
      }
      return
    }

    const androidCheckMatch = url.pathname.match(
      /^\/api\/android\/devices\/([^/]+)\/check$/u,
    )
    if (androidCheckMatch && method === 'POST') {
      try {
        const identifier = decodeURIComponent(androidCheckMatch[1]!)
        const result = await checkAndroidDevice(identifier)
        await recordToolRouterAudit({
          action: 'android.device.checked',
          target: result.alias || result.serial,
        })
        this.writeJson(response, 200, { data: result })
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
      }
      return
    }

    const androidProfileMatch = url.pathname.match(
      /^\/api\/android\/devices\/([^/]+)$/u,
    )
    if (androidProfileMatch) {
      const alias = decodeURIComponent(androidProfileMatch[1]!)
      try {
        if (method === 'PATCH') {
          const body = await this.readJson(request)
          let registry
          if (typeof body.enabled === 'boolean') {
            registry = await setAndroidDeviceProfileEnabled(
              this.config.runner.cwd || process.cwd(),
              alias,
              body.enabled,
            )
          }
          if (body.active === true) {
            registry = await setActiveAndroidDeviceProfile(alias)
          }
          if (!registry) {
            this.writeJson(
              response,
              400,
              openAiError("Expected boolean 'enabled' or active=true"),
            )
            return
          }
          await recordToolRouterAudit({
            action: body.active === true
              ? 'android.profile.selected'
              : body.enabled
                ? 'android.profile.enabled'
                : 'android.profile.disabled',
            target: alias,
          })
          this.writeJson(response, 200, {
            data: {
              active_alias: registry.activeAlias || null,
              profiles: Object.values(registry.profiles),
            },
          })
          return
        }
        if (method === 'DELETE') {
          const registry = await removeAndroidDeviceProfile(
            this.config.runner.cwd || process.cwd(),
            alias,
          )
          await recordToolRouterAudit({
            action: 'android.profile.removed',
            target: alias,
          })
          this.writeJson(response, 200, {
            deleted: alias,
            data: {
              active_alias: registry.activeAlias || null,
              profiles: Object.values(registry.profiles),
            },
          })
          return
        }
      } catch (error) {
        this.writeJson(
          response,
          400,
          openAiError(error instanceof Error ? error.message : String(error)),
        )
        return
      }
    }

    if (url.pathname === '/api/skills') {
      const projectRoot = this.config.runner.cwd || process.cwd()
      try {
        const skillStore = await this.loadSkillStore()
        if (method === 'GET') {
          this.writeJson(response, 200, {
            data: await skillStore.listSkillStore(
              projectRoot,
              this.skillStoreOptions,
            ),
          })
          return
        }
        if (method === 'POST') {
          const body = await this.readJson(request)
          const created = await skillStore.createManagedSkill(
            projectRoot,
            body.skill ?? body,
            this.skillStoreOptions,
          )
          await recordToolRouterAudit({
            action: 'skill.created',
            target: created.name,
          })
          this.writeJson(response, 201, { data: created })
          return
        }
      } catch (error) {
        this.writeSkillStoreError(response, error)
        return
      }
    }

    const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/u)
    if (skillMatch) {
      const selector = decodeURIComponent(skillMatch[1]!)
      const projectRoot = this.config.runner.cwd || process.cwd()
      try {
        const skillStore = await this.loadSkillStore()
        if (method === 'GET') {
          const skill = await skillStore.getSkillStoreItemDetails(
            projectRoot,
            selector,
            this.skillStoreOptions,
          )
          if (!skill) {
            throw new skillStore.SkillStoreError(
              'not_found',
              `Skill not found: ${selector}`,
            )
          }
          this.writeJson(response, 200, { data: skill })
          return
        }
        if (method === 'PATCH') {
          const body = await this.readJson(request)
          if (typeof body.enabled !== 'boolean') {
            this.writeJson(response, 400, openAiError("Missing boolean 'enabled'"))
            return
          }
          const skill = await skillStore.getSkillStoreItemDetails(
            projectRoot,
            selector,
            this.skillStoreOptions,
          )
          if (!skill) {
            throw new skillStore.SkillStoreError(
              'not_found',
              `Skill not found: ${selector}`,
            )
          }
          const disabled = await skillStore.getDisabledSkillNames(projectRoot)
          if (body.enabled) disabled.delete(skill.name)
          else disabled.add(skill.name)
          await this.setDisabledSkills(projectRoot, disabled)
          const skills = await skillStore.listSkillStore(
            projectRoot,
            this.skillStoreOptions,
          )
          await recordToolRouterAudit({
            action: body.enabled ? 'skill.enabled' : 'skill.disabled',
            target: skill.name,
          })
          this.writeJson(response, 200, { data: skills })
          return
        }
        if (method === 'DELETE') {
          const skills = await skillStore.deleteManagedSkill(
            projectRoot,
            selector,
            this.skillStoreOptions,
          )
          await recordToolRouterAudit({ action: 'skill.deleted', target: selector })
          this.writeJson(response, 200, {
            deleted: selector,
            data: skills,
          })
          return
        }
      } catch (error) {
        this.writeSkillStoreError(response, error)
        return
      }
    }

    if (url.pathname === '/api/memory' || url.pathname === '/api/memory/') {
      await this.handleMemoryCollection(method, url, request, response)
      return
    }

    if (url.pathname === '/api/memory/status' && method === 'GET') {
      this.writeJson(response, 200, await getCuratedMemoryStatus())
      return
    }

    if (url.pathname === '/api/memory/search' && method === 'GET') {
      const query = url.searchParams.get('q') || ''
      const kind = parseMemoryKind(url.searchParams.get('kind'))
      const limit = parseLimit(url.searchParams.get('limit'), 20)
      const memories = await searchCuratedMemory({ query, kind, limit })
      this.writeJson(response, 200, { data: memories })
      return
    }

    if (url.pathname === '/api/memory/sessions/search' && method === 'GET') {
      const query = url.searchParams.get('q') || ''
      const limit = parseLimit(url.searchParams.get('limit'), 20)
      const data = await searchChatLog({ query, limit })
      this.writeJson(response, 200, { data })
      return
    }

    if (url.pathname === '/api/memory/tool' && method === 'POST') {
      await this.handleMemoryTool(request, response)
      return
    }

    if (url.pathname === '/api/memory/pending' && method === 'GET') {
      this.writeJson(response, 200, {
        data: await loadPendingCuratedMemoryActions(),
      })
      return
    }

    if (url.pathname === '/api/memory/approve' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const result = await approvePendingCuratedMemoryAction(
          String(body.id || 'all'),
        )
        this.writeJson(response, 200, result)
      } catch (error) {
        this.writeMemoryError(response, error)
      }
      return
    }

    if (url.pathname === '/api/memory/reject' && method === 'POST') {
      try {
        const body = await this.readJson(request)
        const result = await rejectPendingCuratedMemoryAction(
          String(body.id || 'all'),
        )
        this.writeJson(response, 200, result)
      } catch (error) {
        this.writeMemoryError(response, error)
      }
      return
    }

    const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/)
    if (memoryMatch) {
      await this.handleMemoryEntryRoute(
        method,
        decodeURIComponent(memoryMatch[1]!),
        request,
        response,
      )
      return
    }

    if (url.pathname === '/api/jobs') {
      if (method === 'GET') {
        this.writeJson(response, 200, { jobs: await listCronJobs(true) })
        return
      }
      if (method === 'POST') {
        const body = await this.readJson(request)
        const job = await createCronJob(body as Record<string, unknown>)
        this.writeJson(response, 201, { job })
        return
      }
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?$/)
    if (jobMatch) {
      await this.handleJobRoute(method, jobMatch[1]!, jobMatch[2], request, response)
      return
    }

    this.writeJson(response, 404, openAiError('Not found'))
  }

  private async handleChatCompletions(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestAbort = this.trackRequestAbort(request, response)
    const body = await this.readJson(request)
    const messages = Array.isArray(body.messages) ? body.messages : null
    if (!messages) {
      this.writeJson(response, 400, openAiError("Missing or invalid 'messages'"))
      return
    }

    const materializedMessages = await materializeVisionInput(messages)
    const chatInput = buildChatCompletionInput(
      Array.isArray(materializedMessages.value)
        ? materializedMessages.value
        : messages,
    )
    if (!chatInput.currentUser.content.trim()) {
      this.writeJson(response, 400, openAiError('No user message found'))
      return
    }
    const requestedSessionId = resolveApiChatSessionId(request, body)
    const sessionId = requestedSessionId || randomUUID()
    const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
    const model = String(body.model || this.config.api.modelName)
    const contextModel = resolveApiContextModel(model, this.config)
    const jsonKeepalive = shouldUseJsonKeepalive(request, body)

    if (body.stream) {
      await this.streamChatCompletion(response, id, model, {
        includeUsage: shouldIncludeStreamUsage(body),
        sessionId,
        requestedSessionId,
        contextModel,
        chatInput,
        currentUser: chatInput.currentUser,
      })
      return
    }

    const queued = this.enqueueAgentExecution(
      `chat.completions:${sessionId}`,
      async signal => {
        if (signal.aborted) {
          return {
            result: buildClientDisconnectedAgentResult(
              'Client disconnected before queued API run started.',
            ),
            responseText: '',
            history: [],
          }
        }
        const { runnerPrompt, history } = await this.buildChatCompletionRun({
          sessionId,
          requestedSessionId,
          contextModel,
          chatInput,
        })
        recordApiChatLog({
          direction: 'in',
          source: 'api',
          endpoint: 'chat.completions',
          sessionId,
          text: chatInput.currentUser.content,
        })
        const result = await runApiAgentWithRecovery(
          runOpenClaudeAgentWithCompletionGate,
          {
            prompt: runnerPrompt,
            config: this.config,
            signal,
          },
        )
        if (result.exitCode !== 0) {
          return { result, responseText: '', history }
        }

        const responseText = await this.prepareAgentResponseText(result.text, 'api')
        recordApiChatLog({
          direction: 'out',
          source: 'api',
          endpoint: 'chat.completions',
          sessionId,
          text: responseText,
        })

        this.storeChatSession(sessionId, [
          ...history,
          chatInput.currentUser,
          { role: 'assistant', content: responseText },
        ])
        await this.onAgentResponse?.(responseText, 'api')
        return { result, responseText, history }
      },
      requestAbort.signal,
    )
    const responseHeaders = {
      'X-Hermes-Session-Id': sessionId,
      ...this.apiQueueHeaders(queued),
    }
    const keepaliveResponse = jsonKeepalive
      ? this.startJsonKeepaliveResponse(response, responseHeaders)
      : undefined
    const { result, responseText } = await queued.promise
    if (requestAbort.signal.aborted && response.destroyed) {
      requestAbort.complete()
      return
    }
    if (result.exitCode !== 0) {
      requestAbort.complete()
      const payload = openAiError(formatAgentFailureForApi(result), 'server_error')
      if (keepaliveResponse) {
        keepaliveResponse.end(payload)
      } else {
        this.writeJson(response, 500, payload, this.apiQueueHeaders(queued))
      }
      return
    }

    requestAbort.complete()
    const payload = {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      openclaude_status: result.completionStatus || 'completed',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        },
      ],
      usage: emptyUsage(),
    }
    if (keepaliveResponse) {
      keepaliveResponse.end(payload)
    } else {
      this.writeJson(response, 200, payload, responseHeaders)
    }
  }

  private async buildChatCompletionRun(input: {
    sessionId: string
    requestedSessionId: string
    contextModel: string
    chatInput: {
      systemMessages: string[]
      history: ConversationMessage[]
      currentUser: ConversationMessage
    }
  }): Promise<{
    runnerPrompt: string
    history: ConversationMessage[]
  }> {
    const sessionHistory = input.requestedSessionId
      ? this.chatSessions.get(input.sessionId)
      : undefined
    const history = sessionHistory || input.chatInput.history
    const maxContextChars = getApiConversationMaxChars(input.contextModel)
    const conversationHistory = history.length > 0 || !input.requestedSessionId
      ? history
      : await loadApiSessionTranscript(input.sessionId, maxContextChars)
    const promptHistory = trimConversationMessagesWithinCharBudget(
      conversationHistory,
      maxContextChars,
    )
    const promptMessages = buildChatPromptMessages({
      systemMessages: input.chatInput.systemMessages,
      history: promptHistory,
      currentUser: input.chatInput.currentUser,
    })
    const { prompt: baseRunnerPrompt } = buildPromptFromChatMessages(promptMessages)
    const runnerPrompt = await this.buildRunnerPromptWithMemory(
      baseRunnerPrompt,
      input.contextModel,
      input.chatInput.currentUser.content,
    )
    if (!runnerPrompt.trim()) {
      throw new AgentApiHttpError(400, 'No user message found')
    }
    return { runnerPrompt, history: conversationHistory }
  }

  private async streamChatCompletion(
    response: ServerResponse,
    id: string,
    model: string,
    options: {
      includeUsage?: boolean
      sessionId?: string
      requestedSessionId?: string
      contextModel?: string
      chatInput?: {
        systemMessages: string[]
        history: ConversationMessage[]
        currentUser: ConversationMessage
      }
      currentUser?: ConversationMessage
    } = {},
  ): Promise<void> {
    const abortController = new AbortController()
    let completed = false
    response.on('close', () => {
      if (!completed) abortController.abort()
    })
    const created = Math.floor(Date.now() / 1000)
    const writeChunk = (delta: Record<string, unknown>) => {
      response.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      )
    }
    let fullText = ''
    const frontmatterStripper = createFrontmatterStreamStripper()
    const memoryDirectiveStripper = createMemoryDirectiveStreamStripper()
    const queued = this.enqueueAgentExecution(
      `chat.completions.stream:${options.sessionId || id}`,
      async signal => {
        if (signal.aborted) {
          return {
            text: '',
            stderr: 'Client disconnected before queued API run started.',
            exitCode: 1,
            timedOut: false,
            durationMs: 0,
          } satisfies AgentRunResult
        }

        const run = options.sessionId && options.chatInput
          ? await this.buildChatCompletionRun({
              sessionId: options.sessionId,
              requestedSessionId: options.requestedSessionId || '',
              contextModel: options.contextModel || model,
              chatInput: options.chatInput,
            })
          : { runnerPrompt: '', history: [] }
        if (options.sessionId && options.currentUser) {
          await appendChatLog({
            direction: 'in',
            source: 'api',
            endpoint: 'chat.completions',
            sessionId: options.sessionId,
            text: options.currentUser.content,
          }).catch(() => {})
        }
        const runner = hasCodingMutationIntent(run.runnerPrompt)
          ? runOpenClaudeAgentWithCompletionGate
          : runOpenClaudeAgent
        const result = await runner({
          prompt: run.runnerPrompt,
          config: this.config,
          signal,
          onStdout: chunk => {
            fullText += chunk
            if (response.destroyed) return
            const visibleChunk = memoryDirectiveStripper.push(
              frontmatterStripper.push(chunk),
            )
            if (visibleChunk) {
              writeChunk({ content: visibleChunk })
            }
          },
        })
        if (result.exitCode !== 0 || response.destroyed) {
          return { ...result, history: run.history, responseText: '' }
        }

        const responseText = await this.prepareAgentResponseText(
          fullText || result.text,
          'api',
        )
        await appendChatLog({
          direction: 'out',
          source: 'api',
          endpoint: 'chat.completions',
          sessionId: options.sessionId,
          text: responseText,
        }).catch(() => {})
        if (options.sessionId && options.currentUser) {
          this.storeChatSession(options.sessionId, [
            ...run.history,
            options.currentUser,
            { role: 'assistant', content: responseText },
          ])
        }
        await this.onAgentResponse?.(responseText, 'api')
        return { ...result, history: run.history, responseText }
      },
      abortController.signal,
    )

    response.writeHead(200, {
      ...this.corsHeaders(),
      ...(options.sessionId ? { 'X-Hermes-Session-Id': options.sessionId } : {}),
      ...this.apiQueueHeaders(queued),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    if (queued.position > 1) {
      response.write(`: queued position ${queued.position}\n\n`)
    }
    writeChunk({ role: 'assistant' })
    const keepalive = setInterval(() => {
      if (!response.destroyed) response.write(': agent working\n\n')
    }, 15_000)
    let result: AgentRunResult & {
      history?: ConversationMessage[]
      responseText?: string
    }
    try {
      result = await queued.promise
    } finally {
      clearInterval(keepalive)
    }

    if (response.destroyed) return

    if (result.exitCode !== 0) {
      response.write(
        `event: error\ndata: ${JSON.stringify(
          openAiError(formatAgentFailureForApi(result), 'server_error'),
        )}\n\n`,
      )
      response.write('data: [DONE]\n\n')
      completed = true
      response.end()
      return
    }

    const trailingVisibleChunk = fullText
      ? [
          memoryDirectiveStripper.push(frontmatterStripper.flush()),
          memoryDirectiveStripper.flush(),
        ].join('')
      : result.responseText || result.text
    if (trailingVisibleChunk && !response.destroyed) {
      writeChunk({ content: trailingVisibleChunk })
    }

    const finishChunk: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    if (options.includeUsage) {
      finishChunk.usage = emptyUsage()
    }
    response.write(`data: ${JSON.stringify(finishChunk)}\n\n`)
    response.write('data: [DONE]\n\n')
    completed = true
    response.end()
  }

  private async handleResponses(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestAbort = this.trackRequestAbort(request, response)
    const body = await this.readJson(request)
    if (body.stream === true) {
      this.writeJson(
        response,
        400,
        openAiError(
          'Streaming is not supported by /v1/responses; use /v1/chat/completions or stream=false.',
          'invalid_request_error',
        ),
      )
      return
    }
    const input = body.input
    if (input === undefined || input === null) {
      this.writeJson(response, 400, openAiError("Missing 'input'"))
      return
    }

    const materializedInput = await materializeVisionInput(input)
    const prompt = normalizeResponsesInput(materializedInput.value)
    if (!prompt.trim()) {
      this.writeJson(response, 400, openAiError('No user message found'))
      return
    }

    const instructions =
      typeof body.instructions === 'string' ? body.instructions.trim() : ''
    const conversation =
      typeof body.conversation === 'string' ? body.conversation.trim() : ''
    const explicitHistory = normalizeConversationHistory(body.conversation_history)
    const model = String(body.model || this.config.api.modelName)
    const contextModel = resolveApiContextModel(model, this.config)
    const queued = this.enqueueAgentExecution(
      `responses:${conversation || 'default'}`,
      async signal => {
        if (signal.aborted) {
          return {
            result: buildClientDisconnectedAgentResult(
              'Client disconnected before queued API run started.',
            ),
            data: undefined,
          }
        }
        const previousResponseId = await this.resolvePreviousResponseId(body)
        const previous = previousResponseId
          ? await this.getStoredResponse(previousResponseId)
          : undefined
        if (previousResponseId && !previous) {
          throw new AgentApiHttpError(404, 'Previous response not found')
        }

        const previousHistory = explicitHistory.length
          ? explicitHistory
          : previous
            ? normalizeConversationHistory(previous.conversation_history)
            : conversation
              ? await loadApiConversationTranscript(
                  conversation,
                  getApiConversationMaxChars(contextModel),
                )
              : []
        const promptHistory = trimConversationMessagesWithinCharBudget(
          previousHistory,
          getApiConversationMaxChars(contextModel),
        )
        const baseRunnerPrompt = buildResponsesRunnerPrompt({
          instructions,
          previousHistory: promptHistory,
          prompt,
        })
        const runnerPrompt = await this.buildRunnerPromptWithMemory(
          baseRunnerPrompt,
          contextModel,
          instructions ? `${instructions}\n\n${prompt}` : prompt,
        )
        recordApiChatLog({
          direction: 'in',
          source: 'api',
          endpoint: 'responses',
          conversation,
          previousResponseId: previousResponseId || undefined,
          text: prompt,
        })
        const result = await runApiAgentWithRecovery(
          runOpenClaudeAgentWithCompletionGate,
          {
            prompt: runnerPrompt,
            config: this.config,
            signal,
          },
        )
        if (result.exitCode !== 0) {
          return { result, data: undefined }
        }

        const responseText = await this.prepareAgentResponseText(result.text, 'api')
        recordApiChatLog({
          direction: 'out',
          source: 'api',
          endpoint: 'responses',
          conversation,
          text: responseText,
        })

        const responseId = `resp_${randomUUID().replace(/-/g, '')}`
        const blocked = result.completionStatus === 'blocked'
        const data = {
          id: responseId,
          object: 'response',
          status: blocked ? 'incomplete' : 'completed',
          ...(blocked
            ? {
                incomplete_details: {
                  reason: 'required_input_or_access',
                },
                openclaude_status: 'blocked',
              }
            : { openclaude_status: 'completed' }),
          created_at: Math.floor(Date.now() / 1000),
          model,
          previous_response_id: previousResponseId || null,
          ...(conversation ? { conversation } : {}),
          output: [
            {
              id: `msg_${randomUUID().replace(/-/g, '')}`,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: responseText }],
            },
          ],
          usage: emptyUsage(),
        }

        if (body.store !== false) {
          await this.storeResponse(responseId, {
            response: data,
            conversation_history: [
              ...previousHistory,
              { role: 'user', content: prompt },
              { role: 'assistant', content: responseText },
            ],
            instructions,
            previous_response_id: previousResponseId || undefined,
            conversation: conversation || undefined,
          })
        }

        await this.onAgentResponse?.(responseText, 'api')
        return { result, data }
      },
      requestAbort.signal,
    )
    const { result, data } = await queued.promise
    if (requestAbort.signal.aborted && response.destroyed) {
      requestAbort.complete()
      return
    }
    if (result.exitCode !== 0 || !data) {
      requestAbort.complete()
      this.writeJson(
        response,
        500,
        openAiError(formatAgentFailureForApi(result), 'server_error'),
        this.apiQueueHeaders(queued),
      )
      return
    }

    requestAbort.complete()
    this.writeJson(response, 200, data, this.apiQueueHeaders(queued))
  }

  private async handleRuns(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readJson(request)
    const input = body.input
    if (input === undefined || input === null) {
      this.writeJson(response, 400, openAiError("Missing 'input'"))
      return
    }

    const runId = `run_${randomUUID().replace(/-/g, '')}`
    const queue = new SseEventLog()
    const runController = new AbortController()
    this.runs.set(runId, { queue, controller: runController })
    const materializedInput = await materializeVisionInput(input)
    const prompt = normalizeResponsesInput(materializedInput.value)
    const instructions =
      typeof body.instructions === 'string' ? body.instructions.trim() : ''
    const model = String(body.model || this.config.api.modelName)
    const contextModel = resolveApiContextModel(model, this.config)
    const runnerPrompt = await this.buildRunnerPromptWithMemory(
      instructions ? `${instructions}\n\n${prompt}` : prompt,
      contextModel,
    )
    recordApiChatLog({
      direction: 'in',
      source: 'api',
      endpoint: 'runs',
      runId,
      text: prompt,
    })

    const queued = this.enqueueAgentExecution(`runs:${runId}`, async signal => {
      queue.push({
        event: 'run.started',
        run_id: runId,
        timestamp: Date.now() / 1000,
        queue_id: queued.id,
        queue_position: queued.position,
      })
      const runner = hasCodingMutationIntent(runnerPrompt)
        ? runOpenClaudeAgentWithCompletionGate
        : runOpenClaudeAgent
      return runner({
        prompt: runnerPrompt,
        config: this.config,
        signal,
        onStdout: chunk => {
          queue.push({
            event: 'message.delta',
            run_id: runId,
            timestamp: Date.now() / 1000,
            delta: chunk,
          })
        },
      })
    }, runController.signal)
    if (queued.position > 1) {
      queue.push({
        event: 'run.queued',
        run_id: runId,
        timestamp: Date.now() / 1000,
        queue_id: queued.id,
        queue_position: queued.position,
        waiting: Math.max(0, queued.position - 1),
      })
    }

    void queued.promise
      .then(async result => {
        if (result.exitCode === 0) {
          const responseText = await this.prepareAgentResponseText(result.text, 'run')
          recordApiChatLog({
            direction: 'out',
            source: 'api',
            endpoint: 'runs',
            runId,
            text: responseText,
          })
          const terminalEvent = {
            event: 'run.completed',
            run_id: runId,
            timestamp: Date.now() / 1000,
            output: responseText,
            usage: emptyUsage(),
          }
          queue.push(terminalEvent)
          try {
            await this.onAgentResponse?.(responseText, 'run')
          } catch (error) {
            queue.push({
              event: 'run.warning',
              run_id: runId,
              timestamp: Date.now() / 1000,
              warning: `Response delivery hook failed: ${String(error)}`,
            })
          }
        } else {
          const terminalEvent = {
            event: 'run.failed',
            run_id: runId,
            timestamp: Date.now() / 1000,
            error: formatAgentFailureForApi(result),
          }
          queue.push(terminalEvent)
        }
      })
      .catch(error => {
        const terminalEvent = {
          event: 'run.failed',
          run_id: runId,
          timestamp: Date.now() / 1000,
          error: String(error),
        }
        queue.push(terminalEvent)
      })
      .finally(() => {
        queue.push(null)
        this.scheduleRunCleanup(runId, queue)
      })

    this.writeJson(response, 202, {
      run_id: runId,
      status: queued.position > 1 ? 'queued' : 'started',
      queue_id: queued.id,
      queue_position: queued.position,
    })
  }

  private async handleRunEvents(
    runId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) {
      this.writeJson(response, 404, openAiError('Run not found'))
      return
    }
    const queue = run.queue

    response.writeHead(200, {
      ...this.corsHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const disconnected = new AbortController()
    response.once('close', () => disconnected.abort())
    const rawLastEventId = Array.isArray(request.headers['last-event-id'])
      ? request.headers['last-event-id'][0]
      : request.headers['last-event-id']
    let lastEventId = Math.max(0, Number.parseInt(String(rawLastEventId || '0'), 10) || 0)
    while (!response.destroyed) {
      const buffered = await queue.next(lastEventId, 30_000, disconnected.signal)
      if (buffered === 'aborted') break
      if (buffered === 'timeout') {
        response.write(': keepalive\n\n')
        continue
      }
      lastEventId = buffered.id
      if (buffered.event === null) {
        response.write(': stream closed\n\n')
        break
      }
      response.write(`id: ${buffered.id}\n`)
      response.write(`data: ${JSON.stringify(buffered.event)}\n\n`)
    }

    if (!response.destroyed) response.end()
  }

  private scheduleRunCleanup(runId: string, queue: SseEventLog): void {
    const run = this.runs.get(runId)
    if (!run || run.queue !== queue) return
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer)
    run.cleanupTimer = setTimeout(() => {
      if (this.runs.get(runId)?.queue === queue) {
        this.runs.delete(runId)
      }
    }, getApiRunRetentionMs())
    run.cleanupTimer.unref?.()
  }

  private async handleMemoryCollection(
    method: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (method === 'GET') {
        const kind = parseMemoryKind(url.searchParams.get('kind'))
        const data = await listCuratedMemoryEntries(kind)
        this.writeJson(response, 200, { data })
        return
      }

      if (method === 'POST') {
        const body = await this.readJson(request)
        const content = String(body.content || '').trim()
        const kind = parseMemoryKind(body.kind) || 'memory'
        const tags = Array.isArray(body.tags)
          ? body.tags.map(String)
          : splitMemoryTags(body.tags)
        const result = await addCuratedMemoryEntry({
          kind,
          content,
          source: String(body.source || 'api'),
          tags,
        })
        this.writeJson(response, result.added ? 201 : 200, result)
        return
      }
    } catch (error) {
      this.writeMemoryError(response, error)
      return
    }

    this.writeJson(response, 405, openAiError('Method not allowed'))
  }

  private async handleMemoryTool(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readJson(request)
      const result = await applyOrStageCuratedMemoryAction(
        {
          action: body.action,
          kind: parseMemoryKind(body.kind ?? body.target),
          content: body.content ?? body.new_text ?? body.newText,
          oldText: body.old_text ?? body.oldText,
          id: typeof body.id === 'string' ? body.id : undefined,
          source: String(body.source || 'api-tool'),
          tags: Array.isArray(body.tags)
            ? body.tags.map(String)
            : splitMemoryTags(body.tags),
        },
        {
          requireApproval:
            this.config.memory.writeApproval && body.force !== true,
        },
      )
      this.writeJson(response, result.pending ? 202 : 200, result)
    } catch (error) {
      this.writeMemoryError(response, error)
    }
  }

  private async handleMemoryEntryRoute(
    method: string,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (method === 'PATCH') {
        const body = await this.readJson(request)
        const tags = body.tags === undefined
          ? undefined
          : Array.isArray(body.tags)
            ? body.tags.map(String)
            : splitMemoryTags(body.tags)
        const result = await replaceCuratedMemoryEntry({
          id,
          content: String(body.content || ''),
          tags,
        })
        this.writeJson(response, 200, result)
        return
      }

      if (method === 'DELETE') {
        const result = await removeCuratedMemoryEntry(id)
        this.writeJson(
          response,
          result.removed ? 200 : 404,
          result.removed ? result : openAiError('Memory entry not found'),
        )
        return
      }
    } catch (error) {
      this.writeMemoryError(response, error)
      return
    }

    this.writeJson(response, 405, openAiError('Method not allowed'))
  }

  private writeMemoryError(response: ServerResponse, error: unknown): void {
    if (error instanceof CuratedMemoryError) {
      this.writeJson(
        response,
        error.code === 'not_found'
          ? 404
          : error.code === 'ambiguous_match'
            ? 409
            : 400,
        {
          error: {
            message: error.message,
            type: error.code,
            details: error.details ?? null,
          },
        },
      )
      return
    }

    this.writeJson(
      response,
      500,
      openAiError(error instanceof Error ? error.message : String(error)),
    )
  }

  private writeSkillStoreError(response: ServerResponse, error: unknown): void {
    if (!(error instanceof Error)) {
      this.writeJson(response, 500, openAiError(String(error), 'server_error'))
      return
    }
    const skillStoreError = error as SkillStoreErrorLike
    if (
      !['invalid', 'not_found', 'conflict', 'forbidden'].includes(
        skillStoreError.code || '',
      )
    ) {
      this.writeJson(response, 500, openAiError(error.message, 'server_error'))
      return
    }
    const statusCode = skillStoreError.code === 'not_found'
      ? 404
      : skillStoreError.code === 'conflict'
        ? 409
        : skillStoreError.code === 'forbidden'
          ? 403
          : 400
    this.writeJson(response, statusCode, openAiError(error.message))
  }

  private writeFileManagerError(response: ServerResponse, error: unknown): void {
    if (error instanceof FileManagerError) {
      const statusCode = error.code === 'not_found'
        ? 404
        : error.code === 'too_large'
          ? 413
        : error.code === 'conflict'
          ? 409
          : error.code === 'forbidden'
            ? 403
            : 400
      this.writeJson(response, statusCode, openAiError(error.message))
      return
    }
    this.writeJson(
      response,
      500,
      openAiError(error instanceof Error ? error.message : String(error), 'server_error'),
    )
  }

  private writeApiError(response: ServerResponse, error: unknown): void {
    if (isAgentApiHttpError(error)) {
      this.writeJson(response, error.statusCode, openAiError(error.message, error.errorType))
      return
    }
    this.writeJson(
      response,
      500,
      openAiError(error instanceof Error ? error.message : String(error), 'server_error'),
    )
  }

  private async setToolsEnabled(enabled: boolean): Promise<void> {
    const updates = {
      OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS: enabled ? '0' : '1',
    }
    await updateProjectEnvFile(this.config.runner.cwd || process.cwd(), updates)
    applyRuntimeEnvUpdates(updates)
    await updateAgentGatewayConfig(current => ({
      ...current,
      runner: { ...current.runner, disableTools: !enabled },
    }))
    this.config.runner.disableTools = !enabled
  }

  private async setHarnessMode(mode: AgentGatewayHarnessMode): Promise<void> {
    const normalized = normalizeAgentGatewayHarnessMode(mode)
    const updates = { OPENCLAUDE_AGENT_HARNESS_MODE: normalized }
    await updateProjectEnvFile(this.config.runner.cwd || process.cwd(), updates)
    applyRuntimeEnvUpdates(updates)
    await updateAgentGatewayConfig(current => ({
      ...current,
      runner: { ...current.runner, harnessMode: normalized },
    }))
    this.config.runner.harnessMode = normalized
  }

  private describeRouterTools(): Array<{
    name: string
    group: string
    enabled: boolean
  }> {
    return describeRouterBuiltinTools(this.config.runner)
  }

  private async setBuiltinToolEnabled(
    name: string,
    enabled: boolean,
  ): Promise<void> {
    const {
      availableTools: nextAvailable,
      disallowedTools: nextDisallowed,
    } = updateRouterBuiltinToolState(this.config.runner, name, enabled)
    const updates = {
      OPENCLAUDE_AGENT_RUNNER_TOOLS: nextAvailable.join(','),
      OPENCLAUDE_AGENT_RUNNER_DISALLOWED_TOOLS: nextDisallowed.join(','),
    }
    await updateProjectEnvFile(this.config.runner.cwd || process.cwd(), updates)
    applyRuntimeEnvUpdates(updates)
    await updateAgentGatewayConfig(current => ({
      ...current,
      runner: {
        ...current.runner,
        availableTools: nextAvailable,
        disallowedTools: nextDisallowed,
      },
    }))
    this.config.runner.availableTools = nextAvailable
    this.config.runner.disallowedTools = nextDisallowed
  }

  private async setDisabledSkills(
    projectRoot: string,
    disabled: Set<string>,
  ): Promise<void> {
    const updates = {
      OPENCLAUDE_DISABLED_SKILLS: [...disabled].sort().join(','),
    }
    await updateProjectEnvFile(projectRoot, updates)
    applyRuntimeEnvUpdates(updates)
  }

  private async handleJobRoute(
    method: string,
    jobId: string,
    action: string | undefined,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!action && method === 'GET') {
      const job = await getCronJob(jobId)
      this.writeJson(response, job ? 200 : 404, job ? { job } : openAiError('Job not found'))
      return
    }
    if (!action && method === 'PATCH') {
      const body = await this.readJson(request)
      const job = await updateCronJob(jobId, body as Record<string, unknown>)
      this.writeJson(response, job ? 200 : 404, job ? { job } : openAiError('Job not found'))
      return
    }
    if (!action && method === 'DELETE') {
      const deleted = await deleteCronJob(jobId)
      this.writeJson(response, deleted ? 200 : 404, { deleted })
      return
    }
    if (action === 'pause' && method === 'POST') {
      const job = await pauseCronJob(jobId)
      this.writeJson(response, job ? 200 : 404, job ? { job } : openAiError('Job not found'))
      return
    }
    if (action === 'resume' && method === 'POST') {
      const job = await resumeCronJob(jobId)
      this.writeJson(response, job ? 200 : 404, job ? { job } : openAiError('Job not found'))
      return
    }
    if ((action === 'run' || action === 'trigger') && method === 'POST') {
      const job = await runCronJobNow(jobId, this.config)
      this.writeJson(response, job ? 200 : 404, job ? { job, ran: true } : openAiError('Job not found'))
      return
    }

    this.writeJson(response, 404, openAiError('Not found'))
  }

  private modelPayload(): Record<string, unknown> {
    return {
      id: this.config.api.modelName,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'openclaude',
      root: this.config.api.modelName,
      parent: null,
    }
  }

  private async buildRunnerPromptWithMemory(
    prompt: string,
    model?: string,
    currentRequest = prompt,
  ): Promise<string> {
    const memory = await this.loadMemoryContext(model)
    const instructions = buildCuratedMemorySystemInstructions({
      memoryEnabled: this.config.memory.enabled,
      userProfileEnabled: this.config.memory.userProfileEnabled,
      writeApproval: this.config.memory.writeApproval,
    })
    const framedCurrentRequest = frameCurrentUserRequest(currentRequest)
    const requestContext = prompt === currentRequest
      ? ''
      : `Request context:\n${prompt}`
    if (!memory && !instructions && !requestContext) return framedCurrentRequest

    return [
      memory ? 'Persistent memory context:' : '',
      memory,
      instructions ? 'Persistent memory write protocol:' : '',
      instructions,
      requestContext,
      '',
      framedCurrentRequest,
    ].filter(part => part !== '').join('\n')
  }

  private async loadMemoryContext(model?: string): Promise<string> {
    return buildMemoryContextSection({
      memoryEnabled: this.config.memory.enabled,
      userProfileEnabled: this.config.memory.userProfileEnabled,
      writeApproval: this.config.memory.writeApproval,
      maxChars: getMemoryContextMaxChars(model),
    }).catch(() => '')
  }

  private async prepareAgentResponseText(
    text: string,
    source: 'api' | 'run',
  ): Promise<string> {
    const normalized = normalizeAgentResponseText(text)
    const parsed = extractCuratedMemoryDirectives(normalized)
    if (parsed.directives.length === 0) return normalized

    try {
      const applied = await applyCuratedMemoryDirectives(normalized, {
        source: `${source}-agent`,
        requireApproval: this.config.memory.writeApproval,
        memoryEnabled: this.config.memory.enabled,
        userProfileEnabled: this.config.memory.userProfileEnabled,
      })
      return applied.text
    } catch (error) {
      recordApiChatLog({
        direction: 'memory-error',
        source,
        endpoint: 'memory.directive',
        text: error instanceof Error ? error.message : String(error),
      })
      return parsed.text || normalized
    }
  }

  private storeChatSession(
    sessionId: string,
    history: ConversationMessage[],
  ): void {
    if (!this.chatSessions.has(sessionId)) {
      this.chatSessionOrder.push(sessionId)
    }
    this.chatSessions.set(sessionId, normalizeConversationHistory(history))

    while (this.chatSessionOrder.length > 100) {
      const oldest = this.chatSessionOrder.shift()
      if (!oldest) break
      this.chatSessions.delete(oldest)
    }
  }

  private async resolvePreviousResponseId(
    body: Record<string, any>,
  ): Promise<string> {
    const explicit =
      typeof body.previous_response_id === 'string'
        ? body.previous_response_id.trim()
        : ''
    if (explicit) return explicit

    const conversation =
      typeof body.conversation === 'string' ? body.conversation.trim() : ''
    if (!conversation) return ''
    return this.conversationLatest.get(conversation)
      || await loadLatestConversationResponseId(conversation)
  }

  private async getStoredResponse(
    responseId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const cached = this.responseStore.get(responseId)
    if (cached) return cached

    const stored = await loadStoredApiResponse(responseId)
    if (stored) this.cacheResponse(responseId, stored)
    return stored
  }

  private cacheResponse(
    responseId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.responseStore.has(responseId)) {
      this.responseOrder.push(responseId)
    }
    this.responseStore.set(responseId, payload)

    const conversation = String(payload.conversation || '').trim()
    if (conversation) this.conversationLatest.set(conversation, responseId)

    while (this.responseOrder.length > 100) {
      const oldest = this.responseOrder.shift()
      if (!oldest) break
      this.responseStore.delete(oldest)
    }
  }

  private async storeResponse(
    responseId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.cacheResponse(responseId, payload)
    await saveStoredApiResponse(responseId, payload)
  }

  private async loadSkillStore(): Promise<typeof import('./skillStore.js')> {
    return import('./skillStore.js')
  }

  private forgetStoredResponse(responseId: string): void {
    this.responseStore.delete(responseId)
    const index = this.responseOrder.indexOf(responseId)
    if (index !== -1) this.responseOrder.splice(index, 1)
    for (const [conversation, latestId] of this.conversationLatest) {
      if (latestId === responseId) {
        this.conversationLatest.delete(conversation)
      }
    }
  }

  private enqueueAgentExecution<T>(
    label: string,
    run: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): QueuedApiAgentExecution<T> {
    const item: ApiAgentQueueItem = {
      id: `apiq_${++this.apiAgentQueueSequence}`,
      label,
      enqueuedAt: Date.now(),
    }
    const position = getApiAgentQueuePosition({
      active: Boolean(this.apiAgentQueueActive),
      waiting: this.apiAgentQueueWaiting,
    })
    this.apiAgentQueueWaiting += 1

    const controller = new AbortController()
    const sourceSignals = [
      this.apiQueueShutdownController.signal,
      externalSignal,
    ].filter((signal): signal is AbortSignal => signal !== undefined)
    let countedAsWaiting = true
    let cancellationCounted = false
    const leaveWaiting = () => {
      if (!countedAsWaiting) return
      countedAsWaiting = false
      this.apiAgentQueueWaiting = Math.max(0, this.apiAgentQueueWaiting - 1)
    }
    const abort = () => {
      controller.abort()
      if (item.startedAt === undefined) {
        leaveWaiting()
        if (!cancellationCounted) {
          cancellationCounted = true
          this.apiAgentQueueCancelled += 1
        }
      }
    }
    for (const signal of sourceSignals) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }

    const previous = this.apiAgentQueueTail.catch(() => {})
    const promise = previous.then(async () => {
      leaveWaiting()
      if (controller.signal.aborted) {
        throw createAbortError('API agent execution was cancelled before it started.')
      }
      item.startedAt = Date.now()
      this.apiAgentQueueActive = item
      try {
        return await run(controller.signal)
      } finally {
        if (this.apiAgentQueueActive?.id === item.id) {
          this.apiAgentQueueActive = undefined
        }
        if (controller.signal.aborted) {
          if (!cancellationCounted) {
            cancellationCounted = true
            this.apiAgentQueueCancelled += 1
          }
        } else {
          this.apiAgentQueueCompleted += 1
        }
      }
    }).finally(() => {
      for (const signal of sourceSignals) {
        signal.removeEventListener('abort', abort)
      }
    })

    this.apiAgentQueueTail = promise.then(
      () => undefined,
      () => undefined,
    )

    return { id: item.id, position, promise }
  }

  private apiQueueHeaders(
    execution: Pick<QueuedApiAgentExecution<unknown>, 'id' | 'position'>,
  ): Record<string, string> {
    return {
      'X-Hermes-Queue-Id': execution.id,
      'X-Hermes-Queue-Position': String(execution.position),
    }
  }

  private getApiQueueStatusPayload(): Record<string, unknown> {
    const active = this.apiAgentQueueActive
      ? {
          id: this.apiAgentQueueActive.id,
          label: this.apiAgentQueueActive.label,
          enqueued_at: this.apiAgentQueueActive.enqueuedAt / 1000,
          started_at: (this.apiAgentQueueActive.startedAt || Date.now()) / 1000,
          running_ms: this.apiAgentQueueActive.startedAt
            ? Date.now() - this.apiAgentQueueActive.startedAt
            : 0,
        }
      : null
    return {
      active,
      waiting: this.apiAgentQueueWaiting,
      completed: this.apiAgentQueueCompleted,
      cancelled: this.apiAgentQueueCancelled,
    }
  }

  private checkAuth(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): boolean {
    const adminApiKey = this.config.api.apiKey
    const inferenceApiKey = this.config.api.inferenceApiKey
    if (!adminApiKey && (!inferenceApiKey || !isInferenceApiPath(pathname))) {
      return true
    }

    const auth = request.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (
      (adminApiKey && token === adminApiKey) ||
      (inferenceApiKey && isInferenceApiPath(pathname) && token === inferenceApiKey)
    ) {
      return true
    }

    if (adminApiKey && pathname.startsWith('/api/')) {
      const session = webSessionFromRequest(request, adminApiKey)
      if (session) {
        const error = validateWebSessionMutation(request, session)
        if (!error) return true
        this.writeJson(response, 403, openAiError(error))
        return false
      }
    }

    this.writeJson(response, 401, openAiError('Invalid API key'))
    return false
  }

  private async handleWebSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = String(request.method || 'GET').toUpperCase()
    const apiKey = this.config.api.apiKey
    const secure = isSecureWebRequest(request)
    if (method === 'DELETE') {
      this.writeJson(response, 200, { authenticated: false }, {
        'Set-Cookie': clearWebSessionCookie({ secure }),
      })
      return
    }

    if (!apiKey) {
      this.writeJson(response, 200, { authenticated: true, csrfToken: '' })
      return
    }

    if (method === 'GET') {
      const session = webSessionFromRequest(request, apiKey)
      if (!session) {
        this.writeJson(response, 401, openAiError('UI session is not authenticated'))
        return
      }
      this.writeJson(response, 200, {
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      })
      return
    }

    if (method !== 'POST') {
      this.writeJson(response, 405, openAiError('Method not allowed'))
      return
    }

    const body = await this.readJson(request)
    if (!constantTimeSecretEqual(String(body.apiKey || ''), apiKey)) {
      this.writeJson(response, 401, openAiError('Invalid API key'))
      return
    }

    const ttlMs = getWebSessionTtlMs()
    const session = issueWebSession(apiKey, { ttlMs })
    this.writeJson(response, 200, {
      authenticated: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    }, {
      'Set-Cookie': buildWebSessionCookie(session.token, { secure, ttlMs }),
    })
  }

  private webSessionPageHeaders(request: IncomingMessage): Record<string, string> {
    const apiKey = this.config.api.apiKey
    if (
      !apiKey ||
      !isWebSessionAutoAuthEnabled() ||
      !isLoopbackWebRequest(request)
    ) {
      return {}
    }
    if (webSessionFromRequest(request, apiKey)) return {}
    const ttlMs = getWebSessionTtlMs()
    const session = issueWebSession(apiKey, { ttlMs })
    return {
      'Set-Cookie': buildWebSessionCookie(session.token, {
        secure: isSecureWebRequest(request),
        ttlMs,
      }),
    }
  }

  private trackRequestAbort(
    request: IncomingMessage,
    response: ServerResponse,
  ): { signal: AbortSignal; complete: () => void } {
    const controller = new AbortController()
    let completed = false
    const abort = () => {
      if (!completed) controller.abort()
    }
    const requestClosed = () => {
      if (!request.complete || request.socket.destroyed || response.destroyed) {
        abort()
      }
    }
    request.on('aborted', abort)
    request.on('close', requestClosed)
    request.on('error', abort)
    response.on('close', abort)
    response.on('error', abort)
    request.socket.on('end', abort)
    request.socket.on('close', abort)
    request.socket.on('error', abort)
    const disconnectPoll = setInterval(() => {
      // IncomingMessage.destroyed can become true after the request body has
      // been consumed even while the response socket remains connected.
      if (request.aborted || response.destroyed || request.socket.destroyed) {
        abort()
      }
    }, 100)
    disconnectPoll.unref?.()
    const complete = () => {
      if (completed) return
      completed = true
      clearInterval(disconnectPoll)
      request.off('aborted', abort)
      request.off('close', requestClosed)
      request.off('error', abort)
      response.off('close', abort)
      response.off('error', abort)
      response.off('finish', complete)
      request.socket.off('end', abort)
      request.socket.off('close', abort)
      request.socket.off('error', abort)
    }
    response.once('finish', complete)
    return {
      signal: controller.signal,
      complete,
    }
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, any>> {
    const chunks: Buffer[] = []
    const maxBodyBytes = getApiRequestBodyMaxBytes()
    let total = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > maxBodyBytes) {
        throw new AgentApiHttpError(413, 'Request body too large')
      }
      chunks.push(buffer)
    }
    if (!chunks.length) return {}
    const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
    try {
      return JSON.parse(raw)
    } catch {
      throw new AgentApiHttpError(400, 'Invalid JSON request body')
    }
  }

  private writeCors(response: ServerResponse, status: number): void {
    response.writeHead(status, this.corsHeaders())
    response.end()
  }

  private writeJson(
    response: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void {
    response.writeHead(status, {
      ...this.corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    response.end(JSON.stringify(payload))
  }

  private writeHtml(
    response: ServerResponse,
    status: number,
    html: string,
    headers: Record<string, string> = {},
  ): void {
    response.writeHead(status, {
      ...this.corsHeaders(),
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    response.end(html)
  }

  private startJsonKeepaliveResponse(
    response: ServerResponse,
    headers: Record<string, string> = {},
  ): { end: (payload: unknown) => void } {
    let ended = false
    response.writeHead(200, {
      ...this.corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Hermes-Keepalive-Json': '1',
      ...headers,
    })
    response.flushHeaders()

    const writeHeartbeat = () => {
      if (!ended && !response.destroyed) {
        response.write('\n')
      }
    }
    writeHeartbeat()
    const timer = setInterval(writeHeartbeat, 15_000)
    timer.unref?.()

    return {
      end: payload => {
        if (ended) return
        ended = true
        clearInterval(timer)
        if (!response.destroyed) {
          response.end(`${JSON.stringify(payload)}\n`)
        }
      },
    }
  }

  private corsHeaders(): Record<string, string> {
    const origins = this.config.api.corsOrigins
    const allowOrigin = origins.includes('*') ? '*' : origins[0]
    if (!allowOrigin) return {}
    return {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-CSRF-Token, X-Hermes-Session-Id',
      'Access-Control-Expose-Headers': 'X-Hermes-Session-Id, X-Hermes-Queue-Id, X-Hermes-Queue-Position',
    }
  }
}

export function getApiAgentQueuePosition(input: {
  active: boolean
  waiting: number
}): number {
  return (input.active ? 1 : 0) + Math.max(0, input.waiting) + 1
}

function openAiError(
  message: string,
  type = 'invalid_request_error',
): { error: { message: string; type: string } } {
  return { error: { message, type } }
}

async function updateProjectEnvFile(
  projectRoot: string,
  updates: Record<string, string>,
): Promise<void> {
  const file = join(projectRoot, '.env')
  let raw = ''
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    // A project without a .env file can still persist a router preference.
  }
  const lines = raw ? raw.split(/\r?\n/u) : []
  const seen = new Set<string>()
  const next = lines.map(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u)
    if (!match) return line
    const key = match[1]!
    if (!(key in updates)) return line
    seen.add(key)
    return `${key}=${quoteProjectEnv(updates[key])}`
  })
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${quoteProjectEnv(value)}`)
  }
  await writeFile(file, `${next.join('\n').replace(/\n+$/u, '')}\n`, 'utf8')
}

function applyRuntimeEnvUpdates(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === '') delete process.env[key]
    else process.env[key] = value
  }
}

function quoteProjectEnv(value: string | undefined): string {
  const text = String(value ?? '')
  if (!text) return ''
  if (/[\s#"'`$]/u.test(text)) {
    return JSON.stringify(text)
  }
  return text
}

function getRouterAutoAuthKey(config: AgentGatewayConfig): string | undefined {
  const enabled = process.env.OPENCLAUDE_ROUTER_AUTO_AUTH
    ?.trim()
    .toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(enabled || '')) return undefined
  return config.api.apiKey || undefined
}

function getApiRunRetentionMs(): number {
  const parsed = Number.parseInt(
    String(process.env.OPENCLAUDE_API_RUN_RETENTION_MS || ''),
    10,
  )
  if (!Number.isFinite(parsed)) return 15 * 60 * 1000
  return Math.min(24 * 60 * 60 * 1000, Math.max(10_000, parsed))
}

function getApiRunMaxBufferedEvents(): number {
  const parsed = Number.parseInt(
    String(process.env.OPENCLAUDE_API_RUN_MAX_BUFFERED_EVENTS || ''),
    10,
  )
  if (!Number.isFinite(parsed)) return 4_096
  return Math.min(100_000, Math.max(100, parsed))
}

function formatAgentFailureForApi(result: AgentRunResult): string {
  const lines = ['Agent run failed.']
  if (result.failureKind) {
    lines.push(`Failure kind: ${result.failureKind}`)
  }
  if (result.timedOut) {
    lines.push(`Timed out after ${formatDuration(result.durationMs || 0)}.`)
  } else {
    lines.push(`Exit code: ${result.exitCode}.`)
  }
  if (result.diagnostic) {
    lines.push('', result.diagnostic)
  }
  if (result.stderr) {
    lines.push('', 'Stderr:', result.stderr.slice(0, 2500))
  }
  const activity = result.activity?.slice(-8) || []
  if (activity.length > 0 && !result.diagnostic?.includes('Recent activity:')) {
    lines.push('', 'Recent activity:')
    for (const event of activity) {
      lines.push(`- ${event}`)
    }
  }
  return lines.join('\n').slice(0, 4000)
}

function buildClientDisconnectedAgentResult(stderr: string): AgentRunResult {
  return {
    text: '',
    stderr,
    exitCode: 1,
    timedOut: false,
    durationMs: 0,
    failureKind: 'execution',
    diagnostic: 'The API client disconnected before the queued agent run could complete.',
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function emptyUsage(): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }
}

type ConversationMessage = {
  role: string
  content: string
}

function normalizeOpenAiPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/v1' || path === '/api/v1') return '/'
  if (path.startsWith('/v1/')) return path.slice(3)
  if (path.startsWith('/api/v1/')) return path.slice(7)
  return path
}

function isProtectedApiPath(pathname: string): boolean {
  if (pathname.startsWith('/api/')) return true
  const path = normalizeOpenAiPath(pathname)
  return (
    path === '/models' ||
    path.startsWith('/models/') ||
    path === '/chat/completions' ||
    path === '/responses' ||
    path.startsWith('/responses/') ||
    path === '/runs' ||
    path.startsWith('/runs/')
  )
}

function isInferenceApiPath(pathname: string): boolean {
  const path = normalizeOpenAiPath(pathname)
  return (
    path === '/models' ||
    path.startsWith('/models/') ||
    path === '/chat/completions' ||
    path === '/responses' ||
    path.startsWith('/responses/') ||
    path === '/runs' ||
    path.startsWith('/runs/')
  )
}

function recordApiChatLog(entry: Record<string, unknown>): void {
  void appendChatLog(entry).catch(() => {})
}

function parseMemoryKind(value: unknown): CuratedMemoryKind | undefined {
  return value === 'user' || value === 'memory' ? value : undefined
}

function splitMemoryTags(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[,\s]+/u)
    .map(tag => tag.trim())
    .filter(Boolean)
}

function parseLimit(value: string | null, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, 100)
}

function getHeaderValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  if (Array.isArray(value)) return String(value[0] || '').trim()
  return String(value || '').trim()
}

function shouldIncludeStreamUsage(body: Record<string, any>): boolean {
  const streamOptions = body.stream_options
  return Boolean(
    streamOptions &&
      typeof streamOptions === 'object' &&
      streamOptions.include_usage,
  )
}

function resolveApiChatSessionId(
  request: IncomingMessage,
  body: Record<string, any>,
): string {
  const headerSession = [
    'x-hermes-session-id',
    'x-openwebui-chat-id',
    'x-openwebui-conversation-id',
    'x-openwebui-session-id',
    'x-conversation-id',
    'x-chat-id',
    'x-session-id',
    'x-thread-id',
  ]
    .map(name => getHeaderValue(request, name))
    .find(Boolean)
  if (headerSession) return headerSession

  const bodySession = firstStringValue(
    body,
    ['conversation_id', 'conversation', 'chat_id', 'session_id', 'thread_id'],
  )
  if (bodySession) return bodySession

  const metadata = body.metadata && typeof body.metadata === 'object'
    ? body.metadata as Record<string, unknown>
    : undefined
  const metadataSession = metadata
    ? firstStringValue(metadata, ['chat_id', 'conversation_id', 'session_id', 'thread_id'])
    : ''
  if (metadataSession) return metadataSession

  const user = typeof body.user === 'string' ? body.user.trim() : ''
  return user ? `user:${user}` : ''
}

function resolveApiContextModel(
  requestedModel: string,
  config: AgentGatewayConfig,
): string {
  const model = requestedModel.trim()
  if (model && model !== config.api.modelName) return model
  return (
    process.env.OPENCLAUDE_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    process.env.GEMINI_MODEL ||
    process.env.MISTRAL_MODEL ||
    model ||
    config.api.modelName
  )
}

function firstStringValue(
  record: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

async function loadApiSessionTranscript(
  sessionId: string,
  maxChars: number,
): Promise<ConversationMessage[]> {
  const entries = await loadChatLogTranscript({
    sessionId,
    limit: getApiConversationTurnLimit(),
    maxChars,
  })
  return chatLogEntriesToConversationMessages(entries)
}

async function loadApiConversationTranscript(
  conversation: string,
  maxChars: number,
): Promise<ConversationMessage[]> {
  const entries = await loadChatLogTranscript({
    conversation,
    limit: getApiConversationTurnLimit(),
    maxChars,
  })
  return chatLogEntriesToConversationMessages(entries)
}

function chatLogEntriesToConversationMessages(
  entries: Record<string, unknown>[],
): ConversationMessage[] {
  return entries
    .map(entry => {
      const direction = String(entry.direction || '')
      const text = String(entry.text || '').trim()
      if (!text || (direction !== 'in' && direction !== 'out')) return undefined
      return {
        role: direction === 'out' ? 'assistant' : 'user',
        content: text,
      }
    })
    .filter((message): message is ConversationMessage => Boolean(message))
}

function getApiRequestBodyMaxBytes(): number {
  return parseHumanLimit(process.env.OPENCLAUDE_API_MAX_BODY_BYTES, {
    unlimitedValue: Number.MAX_SAFE_INTEGER,
    zeroValue: Number.MAX_SAFE_INTEGER,
  }) ?? 256 * 1024 * 1024
}

function getApiConversationTurnLimit(): number {
  return getConversationContextTurnLimit([
    'OPENCLAUDE_API_CONTEXT_TURNS',
    'OPENCLAUDE_API_RECENT_HISTORY_LIMIT',
  ])
}

function getApiConversationMaxChars(model?: string): number {
  return getConversationContextMaxChars({
    model,
    envNames: [
      'OPENCLAUDE_API_CONTEXT_CHARS',
      'OPENCLAUDE_API_RECENT_HISTORY_MAX_CHARS',
    ],
  })
}

function buildChatCompletionInput(messages: unknown[]): {
  systemMessages: string[]
  history: ConversationMessage[]
  currentUser: ConversationMessage
} {
  const systemMessages: string[] = []
  const conversation: ConversationMessage[] = []

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as Record<string, unknown>
    const role = String(message.role || '').trim()
    const content = normalizeMessageContent(message.content).trim()
    if (!content) continue

    if (role === 'system') {
      systemMessages.push(content)
    } else if (role === 'assistant' || role === 'user') {
      conversation.push({ role, content })
    }
  }

  const currentUserIndex = findLastIndex(
    conversation,
    message => message.role === 'user',
  )
  if (currentUserIndex === -1) {
    return {
      systemMessages,
      history: conversation,
      currentUser: { role: 'user', content: '' },
    }
  }

  return {
    systemMessages,
    history: conversation.slice(0, currentUserIndex),
    currentUser: conversation[currentUserIndex]!,
  }
}

function buildChatPromptMessages(input: {
  systemMessages: string[]
  history: ConversationMessage[]
  currentUser: ConversationMessage
}): Array<Record<string, string>> {
  return [
    ...input.systemMessages.map(content => ({ role: 'system', content })),
    ...input.history.map(message => ({
      role: message.role,
      content: message.content,
    })),
    { role: input.currentUser.role, content: input.currentUser.content },
  ]
}

function isAgentGatewayHarnessMode(
  value: unknown,
): value is AgentGatewayHarnessMode {
  return value === 'ouroboros'
}

function findLastIndex<T>(
  items: T[],
  predicate: (item: T) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index
  }
  return -1
}

function normalizeConversationHistory(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      if (!item || typeof item !== 'object') return undefined
      const record = item as Record<string, unknown>
      const role = String(record.role || '').trim()
      const content = String(record.content || '').trim()
      if (!role || !content) return undefined
      return { role, content }
    })
    .filter((item): item is ConversationMessage => Boolean(item))
}

function buildResponsesRunnerPrompt(input: {
  instructions: string
  previousHistory: ConversationMessage[]
  prompt: string
}): string {
  const parts: string[] = []
  if (input.instructions) parts.push(input.instructions)
  if (input.previousHistory.length > 0) {
    parts.push(
      [
        'Previous response conversation context:',
        ...input.previousHistory.map(
          message => `${message.role}: ${message.content}`,
        ),
      ].join('\n'),
    )
  }
  parts.push(input.prompt)
  return parts.join('\n\n')
}

function normalizeResponsesInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return String(input ?? '')

  return input
    .map(item => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      if (record.role) {
        return `${String(record.role)}: ${normalizeMessageContent(record.content)}`
      }
      return normalizeMessageContent([record])
    })
    .filter(Boolean)
    .join('\n\n')
}

function normalizeAgentResponseText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('---')) {
    return trimmed
  }

  const stripped = trimmed.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)*/u, '')
  return stripped.trim() || trimmed
}

function createFrontmatterStreamStripper(): FrontmatterStreamStripper {
  let buffer = ''
  let decided = false

  return {
    push(chunk: string): string {
      if (decided) {
        return chunk
      }

      buffer += chunk
      if ('---'.startsWith(buffer)) {
        return ''
      }
      if (!buffer.startsWith('---')) {
        decided = true
        const visible = buffer
        buffer = ''
        return visible
      }

      const match = buffer.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)*/u)
      if (match) {
        decided = true
        buffer = buffer.slice(match[0].length)
        const visible = buffer
        buffer = ''
        return visible
      }

      if (buffer.length > 16_384) {
        decided = true
        const visible = buffer
        buffer = ''
        return visible
      }

      return ''
    },
    flush(): string {
      if (!buffer) {
        return ''
      }

      const visible = decided ? buffer : normalizeAgentResponseText(buffer)
      buffer = ''
      decided = true
      return visible
    },
  }
}

function createMemoryDirectiveStreamStripper(): LineStreamStripper {
  let pending = ''

  const flushCompleteLines = (includeTrailing: boolean): string => {
    const lines = pending.split(/(\r?\n)/u)
    pending = ''
    let output = ''

    for (let index = 0; index < lines.length; index += 2) {
      const line = lines[index] || ''
      const separator = lines[index + 1] || ''
      const isLastUnterminated = !separator && index >= lines.length - 1
      if (isLastUnterminated && !includeTrailing) {
        pending = line
        continue
      }
      const parsed = extractCuratedMemoryDirectives(line)
      if (!parsed.text && (parsed.directives.length > 0 || /^\s*\[MEMORY(?:\s|\]|$)/iu.test(line))) continue
      output += line + separator
    }

    return output
  }

  return {
    push(chunk: string): string {
      if (!chunk) return ''
      pending += chunk
      return flushCompleteLines(false)
    },
    flush(): string {
      return flushCompleteLines(true)
    },
  }
}
