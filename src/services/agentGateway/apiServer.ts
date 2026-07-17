import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { parseHumanLimit } from '../../utils/limitParsing.js'
import type { AgentGatewayConfig } from './config.js'
import {
  buildPromptFromChatMessages,
  normalizeMessageContent,
  runOpenClaudeAgent,
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

class SseQueue {
  private readonly events: SseEvent[] = []
  private waiters: Array<(event: SseEvent) => void> = []

  push(event: SseEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    this.events.push(event)
  }

  next(timeoutMs: number): Promise<SseEvent | 'timeout'> {
    const event = this.events.shift()
    if (event !== undefined) return Promise.resolve(event)

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        resolve('timeout')
      }, timeoutMs)
      const waiter = (nextEvent: SseEvent) => {
        clearTimeout(timer)
        resolve(nextEvent)
      }
      this.waiters.push(waiter)
    })
  }
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
  private readonly runs = new Map<string, SseQueue>()
  private apiAgentQueueTail: Promise<unknown> = Promise.resolve()
  private apiAgentQueueActive: ApiAgentQueueItem | undefined
  private apiAgentQueueWaiting = 0
  private apiAgentQueueSequence = 0
  private apiAgentQueueCompleted = 0

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

    if (isProtectedApiPath(url.pathname)) {
      if (!this.checkAuth(request, response)) return
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
      await this.handleRunEvents(runMatch[1]!, response)
      return
    }

    if (url.pathname === '/api/queue/status' && method === 'GET') {
      this.writeJson(response, 200, this.getApiQueueStatusPayload())
      return
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
        if (method === 'DELETE') {
          const skills = await skillStore.deleteManagedSkill(
            projectRoot,
            selector,
            this.skillStoreOptions,
          )
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
    const body = await this.readJson(request)
    const messages = Array.isArray(body.messages) ? body.messages : null
    if (!messages) {
      this.writeJson(response, 400, openAiError("Missing or invalid 'messages'"))
      return
    }

    const chatInput = buildChatCompletionInput(messages)
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

    const requestAbort = this.trackRequestAbort(request, response)
    const queued = this.enqueueAgentExecution(
      `chat.completions:${sessionId}`,
      async () => {
        if (requestAbort.signal.aborted) {
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
        const result = await runOpenClaudeAgent({
          prompt: runnerPrompt,
          config: this.config,
          signal: requestAbort.signal,
        })
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
    const queued = this.enqueueAgentExecution(
      `chat.completions.stream:${options.sessionId || id}`,
      async () => {
        if (abortController.signal.aborted) {
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
          recordApiChatLog({
            direction: 'in',
            source: 'api',
            endpoint: 'chat.completions',
            sessionId: options.sessionId,
            text: options.currentUser.content,
          })
        }
        return runOpenClaudeAgent({
          prompt: run.runnerPrompt,
          config: this.config,
          signal: abortController.signal,
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
        }).then(result => ({ ...result, history: run.history }))
      },
    )

    response.writeHead(200, {
      ...this.corsHeaders(),
      ...(options.sessionId ? { 'X-Hermes-Session-Id': options.sessionId } : {}),
      ...this.apiQueueHeaders(queued),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
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

    if (queued.position > 1) {
      response.write(`: queued position ${queued.position}\n\n`)
    }
    writeChunk({ role: 'assistant' })
    let fullText = ''
    const frontmatterStripper = createFrontmatterStreamStripper()
    const memoryDirectiveStripper = createMemoryDirectiveStreamStripper()
    const result = await queued.promise

    if (response.destroyed) return

    if (result.exitCode !== 0 && !fullText) {
      writeChunk({ content: formatAgentFailureForApi(result) })
    }

    const trailingVisibleChunk = [
      memoryDirectiveStripper.push(frontmatterStripper.flush()),
      memoryDirectiveStripper.flush(),
    ].join('')
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
    const normalizedFullText = await this.prepareAgentResponseText(fullText, 'api')
    if (normalizedFullText) {
      recordApiChatLog({
        direction: 'out',
        source: 'api',
        endpoint: 'chat.completions',
        sessionId: options.sessionId,
        text: normalizedFullText,
      })
      if (options.sessionId && options.currentUser) {
        const history = 'history' in result && Array.isArray(result.history)
          ? result.history
          : []
        this.storeChatSession(options.sessionId, [
          ...history,
          options.currentUser,
          { role: 'assistant', content: normalizedFullText },
        ])
      }
      await this.onAgentResponse?.(normalizedFullText, 'api')
    }
  }

  private async handleResponses(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readJson(request)
    const input = body.input
    if (input === undefined || input === null) {
      this.writeJson(response, 400, openAiError("Missing 'input'"))
      return
    }

    const prompt = normalizeResponsesInput(input)
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
    const requestAbort = this.trackRequestAbort(request, response)
    const queued = this.enqueueAgentExecution(
      `responses:${conversation || 'default'}`,
      async () => {
        if (requestAbort.signal.aborted) {
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
        )
        recordApiChatLog({
          direction: 'in',
          source: 'api',
          endpoint: 'responses',
          conversation,
          previousResponseId: previousResponseId || undefined,
          text: prompt,
        })
        const result = await runOpenClaudeAgent({
          prompt: runnerPrompt,
          config: this.config,
          signal: requestAbort.signal,
        })
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
        const data = {
          id: responseId,
          object: 'response',
          status: 'completed',
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
    const queue = new SseQueue()
    this.runs.set(runId, queue)
    const prompt = normalizeResponsesInput(input)
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

    const queued = this.enqueueAgentExecution(`runs:${runId}`, async () => {
      queue.push({
        event: 'run.started',
        run_id: runId,
        timestamp: Date.now() / 1000,
        queue_id: queued.id,
        queue_position: queued.position,
      })
      return runOpenClaudeAgent({
        prompt: runnerPrompt,
        config: this.config,
        onStdout: chunk => {
          queue.push({
            event: 'message.delta',
            run_id: runId,
            timestamp: Date.now() / 1000,
            delta: chunk,
          })
        },
      })
    })
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

    void queued.promise.then(
      async result => {
        if (result.exitCode === 0) {
          const responseText = await this.prepareAgentResponseText(result.text, 'run')
          recordApiChatLog({
            direction: 'out',
            source: 'api',
            endpoint: 'runs',
            runId,
            text: responseText,
          })
          queue.push({
            event: 'run.completed',
            run_id: runId,
            timestamp: Date.now() / 1000,
            output: responseText,
            usage: emptyUsage(),
          })
          await this.onAgentResponse?.(responseText, 'run')
        } else {
          queue.push({
            event: 'run.failed',
            run_id: runId,
            timestamp: Date.now() / 1000,
            error: formatAgentFailureForApi(result),
          })
        }
        queue.push(null)
      },
      error => {
        queue.push({
          event: 'run.failed',
          run_id: runId,
          timestamp: Date.now() / 1000,
          error: String(error),
        })
        queue.push(null)
      },
    )

    this.writeJson(response, 202, {
      run_id: runId,
      status: queued.position > 1 ? 'queued' : 'started',
      queue_id: queued.id,
      queue_position: queued.position,
    })
  }

  private async handleRunEvents(
    runId: string,
    response: ServerResponse,
  ): Promise<void> {
    const queue = this.runs.get(runId)
    if (!queue) {
      this.writeJson(response, 404, openAiError('Run not found'))
      return
    }

    response.writeHead(200, {
      ...this.corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    while (!response.destroyed) {
      const event = await queue.next(30_000)
      if (event === 'timeout') {
        response.write(': keepalive\n\n')
        continue
      }
      if (event === null) {
        response.write(': stream closed\n\n')
        break
      }
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    this.runs.delete(runId)
    response.end()
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
  ): Promise<string> {
    const memory = await this.loadMemoryContext(model)
    const instructions = buildCuratedMemorySystemInstructions({
      memoryEnabled: this.config.memory.enabled,
      userProfileEnabled: this.config.memory.userProfileEnabled,
      writeApproval: this.config.memory.writeApproval,
    })
    if (!memory && !instructions) return prompt

    return [
      memory ? 'Persistent memory context:' : '',
      memory,
      instructions ? 'Persistent memory write protocol:' : '',
      instructions,
      '',
      'Current request:',
      prompt,
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
    run: () => Promise<T>,
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

    const previous = this.apiAgentQueueTail.catch(() => {})
    const promise = previous.then(async () => {
      this.apiAgentQueueWaiting = Math.max(0, this.apiAgentQueueWaiting - 1)
      item.startedAt = Date.now()
      this.apiAgentQueueActive = item
      try {
        return await run()
      } finally {
        if (this.apiAgentQueueActive?.id === item.id) {
          this.apiAgentQueueActive = undefined
        }
        this.apiAgentQueueCompleted += 1
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
    }
  }

  private checkAuth(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const apiKey = this.config.api.apiKey
    if (!apiKey) return true

    const auth = request.headers.authorization || ''
    if (auth.startsWith('Bearer ') && auth.slice(7).trim() === apiKey) {
      return true
    }

    this.writeJson(response, 401, openAiError('Invalid API key'))
    return false
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
    request.on('aborted', abort)
    response.on('close', abort)
    return {
      signal: controller.signal,
      complete: () => {
        completed = true
        request.off('aborted', abort)
        response.off('close', abort)
      },
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
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    response.end(JSON.stringify(payload))
  }

  private startJsonKeepaliveResponse(
    response: ServerResponse,
    headers: Record<string, string> = {},
  ): { end: (payload: unknown) => void } {
    let ended = false
    response.writeHead(200, {
      ...this.corsHeaders(),
      'Content-Type': 'application/json',
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
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Hermes-Session-Id',
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
      const role = String(record.role || 'user')
      return `${role}: ${normalizeMessageContent(record.content)}`
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
