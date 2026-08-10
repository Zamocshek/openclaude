import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDefaultAgentGatewayConfig, type AgentGatewayConfig } from './config.js'

type MockAgentRunOptions = {
  prompt: string
  onStdout?: (chunk: string) => void
  signal?: AbortSignal
}

function successfulAgentResult(text: string) {
  return {
    text,
    stderr: '',
    exitCode: 0,
    timedOut: false,
  }
}

const defaultRunOpenClaudeAgent = async (options: MockAgentRunOptions) => {
  options.onStdout?.(`mock response: ${options.prompt}`)
  return successfulAgentResult(`mock response: ${options.prompt}`)
}

const runOpenClaudeAgent = mock(defaultRunOpenClaudeAgent)

function mockCurrentRequest(prompt: string): string {
  const framedMarkers = [
    ...prompt.matchAll(/(?:^|\n)Current request \[chars=(\d+)\]:\n/gu),
  ]
  for (const framed of framedMarkers) {
    if (framed.index === undefined) continue
    const start = framed.index + framed[0].length
    const length = Number.parseInt(framed[1] || '', 10)
    if (Number.isFinite(length) && prompt.length - start === length) {
      return prompt.slice(start)
    }
  }
  const markers = [
    ...prompt.matchAll(/(?:^|\n)(?:User|Current) request:\s*/giu),
  ]
  const marker = markers.at(-1)
  return marker?.index === undefined
    ? prompt
    : prompt.slice(marker.index + marker[0].length)
}

mock.module('./agentRunner.js', () => ({
  runOpenClaudeAgent,
  addAgentRunObserver: () => () => {},
  hasCodingMutationIntent: (prompt: string) =>
    /\b(?:add|change|create|delete|edit|fix|implement|modify|patch|refactor|remove|update|write)\b/iu
      .test(mockCurrentRequest(prompt)),
  hasCodingTaskIntent: (prompt: string) =>
    /\b(?:code|coding|bug|debug|implement|refactor|script|test|typecheck|lint|build|function|class|endpoint|typescript)\b/iu
      .test(mockCurrentRequest(prompt)),
  normalizeMessageContent: (content: unknown) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return String(content ?? '')
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        const record = part as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        if (typeof record.content === 'string') return record.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  },
  buildPromptFromChatMessages: (messages: Array<Record<string, unknown>>) => {
    const system = messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content ?? ''))
    const conversation = messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({
        role: String(message.role),
        content: String(message.content ?? ''),
      }))
    const lastUserIndex = conversation
      .map(message => message.role)
      .lastIndexOf('user')
    const lastUser = lastUserIndex === -1 ? undefined : conversation[lastUserIndex]
    const history = lastUserIndex <= 0 ? [] : conversation.slice(0, lastUserIndex)
    const parts = []
    if (system.length) parts.push(`System instructions:\n${system.join('\n\n')}`)
    if (history.length) {
      parts.push(
        `Conversation so far:\n${history
          .map(message => `${message.role}: ${message.content}`)
          .join('\n\n')}`,
      )
    }
    if (lastUser) parts.push(lastUser.content)
    return {
      prompt: parts.join('\n\n'),
      systemPrompt: undefined,
    }
  },
}))

function testConfig(overrides?: Partial<AgentGatewayConfig>): AgentGatewayConfig {
  const defaults = getDefaultAgentGatewayConfig()
  return {
    ...defaults,
    ...overrides,
    api: {
      ...defaults.api,
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      ...overrides?.api,
    },
    telegram: {
      ...defaults.telegram,
      ...overrides?.telegram,
    },
    cron: {
      ...defaults.cron,
      ...overrides?.cron,
    },
    memory: {
      ...defaults.memory,
      ...overrides?.memory,
    },
    runner: {
      ...defaults.runner,
      ...overrides?.runner,
    },
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

describe('AgentApiServer', () => {
  let server: import('./apiServer.js').AgentApiServer | undefined
  let previousGatewayStateDir: string | undefined
  let previousClaudeConfigDir: string | undefined
  let previousRunnerDisableTools: string | undefined
  let previousRouterAutoAuth: string | undefined
  let previousDisabledSkills: string | undefined
  let tempGatewayStateDir: string | undefined

  beforeEach(async () => {
    runOpenClaudeAgent.mockClear()
    runOpenClaudeAgent.mockImplementation(defaultRunOpenClaudeAgent)
    previousGatewayStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousRunnerDisableTools = process.env.OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS
    previousRouterAutoAuth = process.env.OPENCLAUDE_ROUTER_AUTO_AUTH
    previousDisabledSkills = process.env.OPENCLAUDE_DISABLED_SKILLS
    delete process.env.OPENCLAUDE_ROUTER_AUTO_AUTH
    delete process.env.OPENCLAUDE_DISABLED_SKILLS
    tempGatewayStateDir = await mkdtemp(join(tmpdir(), 'openclaude-api-server-'))
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = tempGatewayStateDir
    process.env.CLAUDE_CONFIG_DIR = join(tempGatewayStateDir, 'config')
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    if (previousGatewayStateDir === undefined) {
      delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    } else {
      process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousGatewayStateDir
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
    if (previousRunnerDisableTools === undefined) {
      delete process.env.OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS
    } else {
      process.env.OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS = previousRunnerDisableTools
    }
    if (previousRouterAutoAuth === undefined) {
      delete process.env.OPENCLAUDE_ROUTER_AUTO_AUTH
    } else {
      process.env.OPENCLAUDE_ROUTER_AUTO_AUTH = previousRouterAutoAuth
    }
    if (previousDisabledSkills === undefined) {
      delete process.env.OPENCLAUDE_DISABLED_SKILLS
    } else {
      process.env.OPENCLAUDE_DISABLED_SKILLS = previousDisabledSkills
    }
    if (tempGatewayStateDir) {
      await rm(tempGatewayStateDir, { recursive: true, force: true })
    }
    tempGatewayStateDir = undefined
  })

  test('serves OpenAI-compatible chat completions through the agent runner', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'hello from api' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type'))
      .toBe('application/json; charset=utf-8')
    const body = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toContain('hello from api')
    expect(runOpenClaudeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('hello from api'),
      }),
    )
    expect(runOpenClaudeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Persistent memory tool protocol'),
      }),
    )
  })

  test('retries bounded transient failures for non-stream API tasks', async () => {
    const previousBackoff = process.env.OPENCLAUDE_API_AGENT_RECOVERY_BACKOFF_MS
    process.env.OPENCLAUDE_API_AGENT_RECOVERY_BACKOFF_MS = '0'
    let invocation = 0
    runOpenClaudeAgent.mockImplementation(async options => {
      invocation += 1
      if (invocation === 1) {
        return {
          text: '',
          stderr: 'API Error: fetch failed',
          exitCode: 1,
          timedOut: false,
          failureKind: 'transient_network' as const,
          diagnostic: 'Transient provider failure.',
          activity: ['mcp__telegram-mcp__get_pinned_messages: success'],
        }
      }
      return successfulAgentResult('recovered response')
    })

    try {
      const { AgentApiServer } = await import('./apiServer.js')
      server = new AgentApiServer({ config: testConfig() })
      await server.start()

      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openclaude-agent',
          messages: [{ role: 'user', content: 'prepare a Telegram campaign' }],
        }),
      })

      expect(response.status).toBe(200)
      const body = await response.json() as {
        choices: Array<{ message: { content: string } }>
      }
      expect(body.choices[0]?.message.content).toContain('recovered response')
      expect(invocation).toBe(2)
      expect(runOpenClaudeAgent.mock.calls[1]?.[0]?.prompt).toContain(
        'Before any external write, inspect pending/action status',
      )
    } finally {
      if (previousBackoff === undefined) {
        delete process.env.OPENCLAUDE_API_AGENT_RECOVERY_BACKOFF_MS
      } else {
        process.env.OPENCLAUDE_API_AGENT_RECOVERY_BACKOFF_MS = previousBackoff
      }
    }
  })

  test('exposes blocked completion state without returning a server error', async () => {
    runOpenClaudeAgent.mockImplementation(async () => ({
      ...successfulAgentResult('SSH access is required.'),
      completionStatus: 'blocked' as const,
    }))
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const chatResponse = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'check access' }],
      }),
    })
    expect(chatResponse.status).toBe(200)
    const chatBody = await chatResponse.json() as {
      openclaude_status: string
      choices: Array<{ message: { content: string } }>
    }
    expect(chatBody.openclaude_status).toBe('blocked')
    expect(chatBody.choices[0]?.message.content).toContain('SSH access is required')

    const responsesResponse = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'check access' }),
    })
    expect(responsesResponse.status).toBe(200)
    const responsesBody = await responsesResponse.json() as {
      status: string
      openclaude_status: string
      incomplete_details?: { reason: string }
    }
    expect(responsesBody.status).toBe('incomplete')
    expect(responsesBody.openclaude_status).toBe('blocked')
    expect(responsesBody.incomplete_details?.reason).toBe('required_input_or_access')
  })

  test('reports streaming runner failures and never stores a partial assistant turn', async () => {
    let invocation = 0
    runOpenClaudeAgent.mockImplementation(async options => {
      invocation += 1
      if (invocation === 1) {
        options.onStdout?.('partial answer')
        return {
          text: 'partial answer',
          stderr: 'provider disconnected',
          exitCode: 1,
          timedOut: false,
        }
      }
      options.onStdout?.('recovered')
      return successfulAgentResult('recovered')
    })
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()
    const headers = {
      'Content-Type': 'application/json',
      'X-Hermes-Session-Id': 'stream-failure-session',
    }

    const failed = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'first turn' }],
      }),
    })
    const failedBody = await failed.text()
    expect(failedBody).toContain('event: error')
    expect(failedBody).not.toContain('"finish_reason":"stop"')

    const recovered = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'second turn' }],
      }),
    })
    expect(recovered.status).toBe(200)
    const secondPrompt = runOpenClaudeAgent.mock.calls[1]?.[0]?.prompt || ''
    expect(secondPrompt).not.toContain('Assistant: partial answer')
  })

  test('persists a successful streaming turn before sending DONE', async () => {
    runOpenClaudeAgent.mockImplementation(async options => {
      const answer = options.prompt.includes('second turn')
        ? 'second response'
        : 'first response'
      options.onStdout?.(answer)
      return successfulAgentResult(answer)
    })
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig(),
      onAgentResponse: async () => {
        await new Promise(resolve => setTimeout(resolve, 75))
      },
    })
    await server.start()
    const headers = {
      'Content-Type': 'application/json',
      'X-Hermes-Session-Id': 'stream-order-session',
    }
    const startedAt = Date.now()

    const first = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'first turn' }],
      }),
    })
    expect(await first.text()).toContain('data: [DONE]')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60)

    await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'second turn' }],
      }),
    })
    const secondPrompt = runOpenClaudeAgent.mock.calls[1]?.[0]?.prompt || ''
    expect(secondPrompt).toContain('assistant: first response')
  })

  test('holds a split frontmatter prefix until it can be removed', async () => {
    runOpenClaudeAgent.mockImplementation(async options => {
      options.onStdout?.('-')
      options.onStdout?.('--\nsecret: value\n---\nvisible')
      return successfulAgentResult('---\nsecret: value\n---\nvisible')
    })
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'show the result' }],
      }),
    })
    const body = await response.text()
    expect(body).toContain('visible')
    expect(body).not.toContain('secret: value')
  })

  test('rejects unsupported Responses API streaming explicitly', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        input: 'hello',
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Streaming is not supported')
    expect(runOpenClaudeAgent).not.toHaveBeenCalled()
  })

  test('materializes Chat Completions image_url input for vision routing', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              },
            },
          ],
        }],
      }),
    })

    expect(response.status).toBe(200)
    const options = runOpenClaudeAgent.mock.calls.at(-1)?.[0] as MockAgentRunOptions
    const currentRequest = mockCurrentRequest(options.prompt)
    expect(currentRequest).toContain('[Vision input]')
    expect(currentRequest).toContain('gateway-vision')
    expect(currentRequest).not.toContain('image_url')
    expect(currentRequest).not.toMatch(/@[^\s]+\.png/u)
    const imagePath = currentRequest.match(/local_path:\s*(.+\.png)/u)?.[1]
    expect(imagePath).toBeTruthy()
    expect(await readFile(imagePath!)).toHaveLength(68)
  })

  test('materializes Responses input_image instead of dropping it', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        input: [
          { type: 'input_text', text: 'Read this image.' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const options = runOpenClaudeAgent.mock.calls.at(-1)?.[0] as MockAgentRunOptions
    const currentRequest = mockCurrentRequest(options.prompt)
    expect(currentRequest).toContain('[Vision input]')
    expect(currentRequest).not.toContain('prompt_reference:')
    expect(currentRequest).not.toContain('input_image')
  })

  test('can keep long non-stream chat completions alive until the agent finishes', async () => {
    const deferred = createDeferred<void>()
    runOpenClaudeAgent.mockImplementation(async () => {
      await deferred.promise
      return successfulAgentResult('delayed response')
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Keepalive-Json': '1',
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        hermes_keepalive: true,
        messages: [{ role: 'user', content: 'slow task' }],
      }),
    })
    const earlyResponse = await Promise.race([
      responsePromise,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500)),
    ])

    expect(earlyResponse).not.toBe('timeout')
    if (earlyResponse === 'timeout') return
    expect(earlyResponse.status).toBe(200)
    expect(earlyResponse.headers.get('x-hermes-keepalive-json')).toBe('1')
    expect(earlyResponse.headers.get('content-type'))
      .toBe('application/json; charset=utf-8')

    let bodyFinished = false
    const bodyPromise = earlyResponse.text().then(text => {
      bodyFinished = true
      return text
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(bodyFinished).toBe(false)

    deferred.resolve()
    const raw = await bodyPromise
    expect(raw.startsWith('\n')).toBe(true)
    const body = JSON.parse(raw) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe('delayed response')
  })

  test('returns a client error for malformed JSON bodies', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '\uFEFF{not-json',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { message: string; type: string }
    }
    expect(body.error.message).toBe('Invalid JSON request body')
    expect(body.error.type).toBe('invalid_request_error')
  })

  test('requires bearer auth when API key is configured', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({ api: { apiKey: 'secret' } as never }),
    })
    await server.start()

    const response = await fetch(`${server.url}/v1/models`)
    expect(response.status).toBe(401)

    const authorized = await fetch(`${server.url}/v1/models`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(authorized.status).toBe(200)
  })

  test('accepts the inference key for agent runs but not admin APIs', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({
        api: {
          apiKey: 'admin-secret',
          inferenceApiKey: 'inference-secret',
        } as never,
      }),
    })
    await server.start()

    const completion = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer inference-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'Use an agent tool' }],
      }),
    })
    expect(completion.status).toBe(200)
    expect(runOpenClaudeAgent).toHaveBeenCalledTimes(1)

    const admin = await fetch(`${server.url}/api/mcp/servers`, {
      headers: { Authorization: 'Bearer inference-secret' },
    })
    expect(admin.status).toBe(401)

    const authorizedAdmin = await fetch(`${server.url}/api/mcp/servers`, {
      headers: { Authorization: 'Bearer admin-secret' },
    })
    expect(authorizedAdmin.status).not.toBe(401)
  })

  test('manages redacted runtime MCP servers through the protected API', async () => {
    const projectRoot = join(tempGatewayStateDir!, 'project')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, '.mcp.json'), JSON.stringify({
      mcpServers: {
        core: { command: 'node', args: ['core-server.js'] },
      },
    }))

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({
        api: { apiKey: 'secret' } as never,
        runner: { cwd: projectRoot } as never,
      }),
    })
    await server.start()

    const unauthorized = await fetch(`${server.url}/api/mcp/servers`)
    expect(unauthorized.status).toBe(401)

    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }
    const imported = await fetch(`${server.url}/api/mcp/servers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mcpServers: {
          search: {
            command: 'npx',
            args: ['-y', 'mcp-searxng'],
            env: {
              SEARXNG_URL: 'http://searxng:8080',
              PRIVATE_API_KEY: 'must-not-be-returned',
            },
          },
        },
      }),
    })
    expect(imported.status).toBe(201)
    const importedText = await imported.text()
    expect(importedText).not.toContain('must-not-be-returned')
    const importedBody = JSON.parse(importedText) as {
      imported: string[]
      normalized_npx: string[]
      data: Array<{ name: string; enabled: boolean; envKeys: string[] }>
    }
    expect(importedBody.imported).toEqual(['search'])
    expect(importedBody.normalized_npx).toEqual(['search'])
    expect(importedBody.data.find(item => item.name === 'search')).toMatchObject({
      enabled: true,
      envKeys: ['PRIVATE_API_KEY', 'SEARXNG_URL'],
    })

    const disabled = await fetch(`${server.url}/api/mcp/servers/search`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)
    const disabledBody = await disabled.json() as {
      data: Array<{ name: string; enabled: boolean }>
    }
    expect(disabledBody.data.find(item => item.name === 'search')?.enabled).toBe(false)

    const removed = await fetch(`${server.url}/api/mcp/servers/search`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(removed.status).toBe(200)
    const removedBody = await removed.json() as {
      deleted: string
      data: Array<{ name: string }>
    }
    expect(removedBody.deleted).toBe('search')
    expect(removedBody.data.map(item => item.name)).toEqual(['core'])
  })

  test('manages isolated Android device profiles through the protected API', async () => {
    const projectRoot = join(tempGatewayStateDir!, 'project')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: {} }),
    )

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({
        api: { apiKey: 'secret' } as never,
        runner: { cwd: projectRoot } as never,
      }),
    })
    await server.start()

    expect((await fetch(`${server.url}/api/android/devices`)).status).toBe(401)

    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }
    const created = await fetch(`${server.url}/api/android/devices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alias: 'lab-phone',
        serial: '192.168.1.8',
        connection: 'wifi',
        make_active: true,
      }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      data: {
        active_alias: 'lab-phone',
        profiles: [{
          alias: 'lab-phone',
          serial: '192.168.1.8:5555',
          connection: 'wifi',
          enabled: true,
        }],
      },
    })

    const listed = await fetch(`${server.url}/api/android/devices`, { headers })
    expect(await listed.json()).toMatchObject({
      data: {
        active_alias: 'lab-phone',
        profiles: [{ alias: 'lab-phone' }],
      },
    })

    const disabled = await fetch(
      `${server.url}/api/android/devices/lab-phone`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      },
    )
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({
      data: {
        active_alias: null,
        profiles: [{ alias: 'lab-phone', enabled: false }],
      },
    })

    const removed = await fetch(
      `${server.url}/api/android/devices/lab-phone`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer secret' },
      },
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({
      deleted: 'lab-phone',
      data: { active_alias: null, profiles: [] },
    })
  })

  test('serves the Tool Router shell and persists protected runtime controls', async () => {
    const projectRoot = join(tempGatewayStateDir!, 'project')
    await mkdir(projectRoot, { recursive: true })
    const config = testConfig({
      api: { apiKey: 'secret' } as never,
      runner: { cwd: projectRoot } as never,
    })
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config,
      skillStoreRoot: join(tempGatewayStateDir!, 'skills'),
    })
    await server.start()

    const page = await fetch(`${server.url}/router`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const pageText = await page.text()
    expect(pageText).toContain('OpenClaude Tool Router')
    expect(pageText).not.toContain('const embeddedApiKey = "secret"')

    process.env.OPENCLAUDE_ROUTER_AUTO_AUTH = '1'
    const locallyAuthenticatedPage = await fetch(`${server.url}/router`)
    expect(await locallyAuthenticatedPage.text()).toContain(
      'const embeddedApiKey = "secret"',
    )

    expect((await fetch(`${server.url}/api/router/overview`)).status).toBe(401)
    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }
    const overview = await fetch(`${server.url}/api/router/overview`, { headers })
    expect(overview.status).toBe(200)
    const overviewBody = await overview.json() as {
      data: {
        tools: {
          enabled: boolean
          catalog: Array<{ name: string; group: string; enabled: boolean }>
        }
        harness: { mode: string }
      }
    }
    expect(overviewBody.data.tools.enabled).toBe(true)
    expect(overviewBody.data.harness.mode).toBe('ouroboros')
    expect(overviewBody.data.tools.catalog).toContainEqual({
      name: 'WebSearch',
      group: 'Research',
      enabled: true,
    })

    const webSearchDisabled = await fetch(`${server.url}/api/router/tools`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ tool: 'WebSearch', enabled: false }),
    })
    expect(webSearchDisabled.status).toBe(200)
    expect(config.runner.disallowedTools).toContain('WebSearch')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain(
      'OPENCLAUDE_AGENT_RUNNER_DISALLOWED_TOOLS=WebSearch',
    )

    const disabled = await fetch(`${server.url}/api/router/tools`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)
    expect(config.runner.disableTools).toBe(true)
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain(
      'OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS=1',
    )

    const harness = await fetch(`${server.url}/api/router/harness`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ mode: 'ouroboros' }),
    })
    expect(harness.status).toBe(200)
    expect(config.runner.harnessMode).toBe('ouroboros')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain(
      'OPENCLAUDE_AGENT_HARNESS_MODE=ouroboros',
    )
    expect((await fetch(`${server.url}/api/router/harness`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ mode: 'adaptive' }),
    })).status).toBe(400)

    const activity = await fetch(`${server.url}/api/router/activity`, { headers })
    expect(activity.status).toBe(200)
    expect((await activity.json() as {
      data: Array<{
        id: string
        timestamp: string
        action: string
        target: string
      }>
    }).data).toContainEqual({
      action: 'tools.disabled',
      target: 'model-tool-calls',
      id: expect.any(String),
      timestamp: expect.any(String),
    })
    expect((await fetch(`${server.url}/api/router/activity`, { headers }).then(
      response => response.json(),
    ) as {
      data: Array<{ action: string; target: string }>
    }).data).toContainEqual(expect.objectContaining({
      action: 'tool.disabled',
      target: 'WebSearch',
    }))
    expect((await fetch(`${server.url}/api/router/activity`, { headers }).then(
      response => response.json(),
    ) as {
      data: Array<{ action: string; target: string }>
    }).data).toContainEqual(expect.objectContaining({
      action: 'harness.updated',
      target: 'ouroboros',
    }))
  })

  test('manages subagent provider routes without returning API keys', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({ api: { apiKey: 'secret' } as never }),
    })
    await server.start()
    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }

    expect((await fetch(`${server.url}/api/subagents`)).status).toBe(401)
    const updated = await fetch(`${server.url}/api/subagents`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        enabled: true,
        maxParallel: 2,
        routes: {
          'gateway-review': {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'do-not-return-this',
          },
        },
      }),
    })
    expect(updated.status).toBe(200)
    const body = await updated.json() as {
      data: { enabled: boolean; maxParallel: number; routes: Array<Record<string, unknown>> }
    }
    expect(body.data.enabled).toBe(true)
    expect(body.data.maxParallel).toBe(2)
    expect(body.data.routes).toEqual([expect.objectContaining({
      name: 'gateway-review',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      apiKeyConfigured: true,
    })])
    expect(JSON.stringify(body)).not.toContain('do-not-return-this')
  })

  test('serves a protected streaming workspace file manager', async () => {
    const projectRoot = join(tempGatewayStateDir!, 'project')
    await mkdir(join(projectRoot, 'existing'), { recursive: true })
    await writeFile(join(projectRoot, 'existing', 'note.txt'), 'initial', 'utf8')
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({
        api: { apiKey: 'secret' } as never,
        runner: { cwd: projectRoot } as never,
      }),
    })
    await server.start()

    const page = await fetch(`${server.url}/files`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('OpenClaude Files')

    const headers = { Authorization: 'Bearer secret' }
    expect((await fetch(`${server.url}/api/files`)).status).toBe(401)
    const listed = await fetch(`${server.url}/api/files?path=existing`, { headers })
    expect(listed.status).toBe(200)
    expect((await listed.json() as {
      data: { path: string; entries: Array<{ name: string; kind: string }> }
    }).data).toMatchObject({
      path: 'existing',
      entries: [expect.objectContaining({ name: 'note.txt', kind: 'file' })],
    })

    const outside = await fetch(`${server.url}/api/files?path=..`, { headers })
    expect(outside.status).toBe(403)

    const created = await fetch(`${server.url}/api/files/folder`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'uploads' }),
    })
    expect(created.status).toBe(201)

    const content = new Uint8Array(1024 * 1024 + 3).fill(65)
    const uploaded = await fetch(
      `${server.url}/api/files/upload?path=uploads&name=payload.bin`,
      { method: 'POST', headers, body: content },
    )
    expect(uploaded.status).toBe(201)
    expect(await readFile(join(projectRoot, 'uploads', 'payload.bin'))).toEqual(Buffer.from(content))

    const downloaded = await fetch(
      `${server.url}/api/files/download?path=uploads%2Fpayload.bin`,
      { headers },
    )
    expect(downloaded.status).toBe(200)
    expect(Number(downloaded.headers.get('content-length'))).toBe(content.length)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(content)

    const renamed = await fetch(`${server.url}/api/files/rename`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'uploads/payload.bin', to: 'uploads/renamed.bin' }),
    })
    expect(renamed.status).toBe(200)

    const deleted = await fetch(`${server.url}/api/files?path=uploads%2Frenamed.bin`, {
      method: 'DELETE',
      headers,
    })
    expect(deleted.status).toBe(200)
  })

  test('browses and creates native skills through the protected Skill Store API', async () => {
    const projectRoot = join(tempGatewayStateDir!, 'project')
    await mkdir(projectRoot, { recursive: true })
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({
        api: { apiKey: 'secret' } as never,
        runner: { cwd: projectRoot } as never,
      }),
      skillStoreRoot: join(tempGatewayStateDir!, 'skills'),
    })
    await server.start()

    expect((await fetch(`${server.url}/api/skills`)).status).toBe(401)
    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }
    const created = await fetch(`${server.url}/api/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skill: {
          name: 'api-verifier',
          description: 'Use when an API task needs explicit verification.',
          instructions: 'Run a focused API check and report the observed result.',
        },
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = await created.json() as {
      data: {
        id: string
        name: string
        managed: boolean
        enabled: boolean
        instructions: string
      }
    }
    expect(createdBody.data).toMatchObject({
      name: 'api-verifier',
      managed: true,
    })
    expect(createdBody.data.instructions).toContain('focused API check')
    expect(createdBody.data.enabled).toBe(true)

    const listed = await fetch(`${server.url}/api/skills`, { headers })
    expect(listed.status).toBe(200)
    const listedBody = await listed.json() as {
      data: Array<{ name: string; managed: boolean }>
    }
    expect(listedBody.data).toContainEqual(
      expect.objectContaining({ name: 'api-verifier', managed: true }),
    )

    const viewed = await fetch(
      `${server.url}/api/skills/${createdBody.data.id}`,
      { headers },
    )
    expect(viewed.status).toBe(200)

    const disabled = await fetch(
      `${server.url}/api/skills/${createdBody.data.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) },
    )
    expect(disabled.status).toBe(200)
    const disabledBody = await disabled.json() as {
      data: Array<{ name: string; enabled: boolean }>
    }
    expect(disabledBody.data.find(skill => skill.name === 'api-verifier')?.enabled).toBe(false)
    expect(process.env.OPENCLAUDE_DISABLED_SKILLS).toBe('api-verifier')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain(
      'OPENCLAUDE_DISABLED_SKILLS=api-verifier',
    )

    const enabled = await fetch(
      `${server.url}/api/skills/${createdBody.data.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) },
    )
    expect(enabled.status).toBe(200)
    expect(process.env.OPENCLAUDE_DISABLED_SKILLS).toBeUndefined()

    const duplicate = await fetch(`${server.url}/api/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'api-verifier',
        description: 'Duplicate',
        instructions: 'Must be rejected.',
      }),
    })
    expect(duplicate.status).toBe(409)

    const removed = await fetch(
      `${server.url}/api/skills/${createdBody.data.id}`,
      { method: 'DELETE', headers },
    )
    expect(removed.status).toBe(200)
    const removedBody = await removed.json() as {
      data: Array<{ name: string }>
    }
    expect(
      removedBody.data.filter(skill => skill.name === 'api-verifier'),
    ).toEqual([])
  })

  test('serves bearer-protected Hermes-style memory endpoints', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({ api: { apiKey: 'secret' } as never }),
    })
    await server.start()

    const unauthorized = await fetch(`${server.url}/api/memory`)
    expect(unauthorized.status).toBe(401)

    const created = await fetch(`${server.url}/api/memory`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'memory',
        content: 'Gateway memory endpoints are bearer-protected.',
        tags: ['security'],
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = await created.json() as {
      entry: { id: string; content: string }
    }
    expect(createdBody.entry.content).toContain('bearer-protected')

    const search = await fetch(`${server.url}/api/memory/search?q=bearer`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(search.status).toBe(200)
    const searchBody = await search.json() as {
      data: Array<{ id: string }>
    }
    expect(searchBody.data[0]?.id).toBe(createdBody.entry.id)
  })

  test('stages memory tool writes when approval is enabled', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({
      config: testConfig({
        memory: { writeApproval: true } as never,
      }),
    })
    await server.start()

    const staged = await fetch(`${server.url}/api/memory/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        target: 'memory',
        content: 'Memory tool writes can be staged for approval.',
      }),
    })
    expect(staged.status).toBe(202)
    const stagedBody = await staged.json() as {
      pending: boolean
      staged: { id: string }
    }
    expect(stagedBody.pending).toBe(true)

    const pending = await fetch(`${server.url}/api/memory/pending`)
    const pendingBody = await pending.json() as { data: unknown[] }
    expect(pendingBody.data).toHaveLength(1)

    const approved = await fetch(`${server.url}/api/memory/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: stagedBody.staged.id }),
    })
    expect(approved.status).toBe(200)

    const search = await fetch(`${server.url}/api/memory/search?q=staged`)
    const searchBody = await search.json() as {
      data: Array<{ content: string }>
    }
    expect(searchBody.data[0]?.content).toContain('staged for approval')
  })

  test('strips and applies hidden memory directives from agent responses', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async () => ({
      text: [
        'Visible answer.',
        '[MEMORY action="add" target="memory" content="Agent responses may request durable memory writes."]',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'remember this' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      output: Array<{ content?: Array<{ text?: string }> }>
    }
    expect(body.output[0]?.content?.[0]?.text).toBe('Visible answer.')

    const search = await fetch(`${server.url}/api/memory/search?q=durable`)
    const searchBody = await search.json() as {
      data: Array<{ content: string }>
    }
    expect(searchBody.data[0]?.content).toContain('durable memory writes')
  })

  test('serves OpenWebUI-friendly model aliases', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const bare = await fetch(`${server.url}/models`)
    expect(bare.status).toBe(200)
    const bareBody = await bare.json() as { data: Array<{ id: string }> }
    expect(bareBody.data[0]?.id).toBe('openclaude-agent')

    const apiV1 = await fetch(`${server.url}/api/v1/models/openclaude-agent`)
    expect(apiV1.status).toBe(200)
    const model = await apiV1.json() as { id: string }
    expect(model.id).toBe('openclaude-agent')
  })

  test('chains chat completions with X-Hermes-Session-Id', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const first = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'remember alpha' }],
      }),
    })
    expect(first.status).toBe(200)
    const sessionId = first.headers.get('x-hermes-session-id')
    expect(sessionId).toBeTruthy()

    const second = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': sessionId!,
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'now beta' }],
      }),
    })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(secondBody.choices[0]?.message.content).toContain('remember alpha')
    expect(secondBody.choices[0]?.message.content).toContain('now beta')
  })

  test('restores OpenWebUI-style chat history from persistent chat log', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const first = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenWebUI-Chat-Id': 'owui-chat-a',
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'where is odessa' }],
      }),
    })
    expect(first.status).toBe(200)

    await server.stop()
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const second = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenWebUI-Chat-Id': 'owui-chat-a',
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'what did I ask before?' }],
      }),
    })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(secondBody.choices[0]?.message.content).toContain('where is odessa')
    expect(secondBody.choices[0]?.message.content).toContain('what did I ask before?')
    const lastRun = runOpenClaudeAgent.mock.calls.at(-1)?.[0]
    expect(lastRun?.prompt).toContain('where is odessa')
  })

  test('restores OpenWebUI transcript older than a short recent slice', async () => {
    const { appendChatLog } = await import('./memory.js')
    for (let index = 1; index <= 40; index++) {
      await appendChatLog({
        direction: index % 2 === 0 ? 'out' : 'in',
        source: 'api',
        endpoint: 'chat.completions',
        sessionId: 'owui-long-chat',
        text: `historic turn ${index}`,
      })
    }

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenWebUI-Chat-Id': 'owui-long-chat',
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'use the full transcript' }],
      }),
    })

    expect(response.status).toBe(200)
    const lastRun = runOpenClaudeAgent.mock.calls.at(-1)?.[0]
    expect(lastRun?.prompt).toContain('historic turn 1')
    expect(lastRun?.prompt).toContain('historic turn 40')
  })

  test('chains Responses API calls with previous_response_id and named conversations', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const first = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'first turn',
        conversation: 'chat-a',
      }),
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { id: string }

    const second = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'second turn',
        previous_response_id: firstBody.id,
      }),
    })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as {
      previous_response_id: string
      output: Array<{ content?: Array<{ text?: string }> }>
    }
    expect(secondBody.previous_response_id).toBe(firstBody.id)
    expect(secondBody.output[0]?.content?.[0]?.text).toContain('first turn')
    expect(secondBody.output[0]?.content?.[0]?.text).toContain('second turn')

    const third = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'third turn',
        conversation: 'chat-a',
      }),
    })
    expect(third.status).toBe(200)
    const thirdBody = await third.json() as { previous_response_id: string }
    expect(thirdBody.previous_response_id).toBe(firstBody.id)
  })

  test('queues concurrent chat completions and preserves session history', async () => {
    const pending: Array<{
      prompt: string
      resolve: (value: ReturnType<typeof successfulAgentResult>) => void
    }> = []
    runOpenClaudeAgent.mockImplementation(async (options: MockAgentRunOptions) => {
      const deferred = createDeferred<ReturnType<typeof successfulAgentResult>>()
      pending.push({ prompt: options.prompt, resolve: deferred.resolve })
      return deferred.promise
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const sessionId = 'api-queue-session'
    const first = fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': sessionId,
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'first queued turn' }],
      }),
    })
    await waitFor(() => pending.length === 1)

    const second = fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': sessionId,
      },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'second queued turn' }],
      }),
    })
    let queuedStatusBody: {
      active: { label: string } | null
      waiting: number
    } = { active: null, waiting: 0 }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const queuedStatus = await fetch(`${server.url}/api/queue/status`)
      expect(queuedStatus.status).toBe(200)
      queuedStatusBody = await queuedStatus.json() as typeof queuedStatusBody
      if (queuedStatusBody.waiting === 1) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(queuedStatusBody.active?.label).toBe(`chat.completions:${sessionId}`)
    expect(queuedStatusBody.waiting).toBe(1)

    pending[0]!.resolve(successfulAgentResult('first queued answer'))
    const firstResponse = await first
    expect(firstResponse.status).toBe(200)
    expect(firstResponse.headers.get('x-hermes-queue-position')).toBe('1')

    await waitFor(() => pending.length === 2)
    expect(pending[1]!.prompt).toContain('first queued turn')
    expect(pending[1]!.prompt).toContain('first queued answer')
    expect(pending[1]!.prompt).toContain('second queued turn')

    pending[1]!.resolve(successfulAgentResult('second queued answer'))
    const secondResponse = await second
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-hermes-queue-position')).toBe('2')
    const secondBody = await secondResponse.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(secondBody.choices[0]?.message.content).toBe('second queued answer')
  })

  test('accepts async runs while another API task is active and starts them from the queue', async () => {
    const pending: Array<{
      prompt: string
      resolve: (value: ReturnType<typeof successfulAgentResult>) => void
    }> = []
    runOpenClaudeAgent.mockImplementation(async (options: MockAgentRunOptions) => {
      const deferred = createDeferred<ReturnType<typeof successfulAgentResult>>()
      pending.push({ prompt: options.prompt, resolve: deferred.resolve })
      return deferred.promise
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const active = fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'active api task' }],
      }),
    })
    await waitFor(() => pending.length === 1)

    const runResponse = await fetch(`${server.url}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'queued async run' }),
    })
    expect(runResponse.status).toBe(202)
    const runBody = await runResponse.json() as {
      status: string
      queue_position: number
    }
    expect(runBody.status).toBe('queued')
    expect(runBody.queue_position).toBe(2)
    expect(pending).toHaveLength(1)

    pending[0]!.resolve(successfulAgentResult('active task done'))
    expect((await active).status).toBe(200)

    await waitFor(() => pending.length === 2)
    expect(pending[1]!.prompt).toContain('queued async run')
    pending[1]!.resolve(successfulAgentResult('queued run done'))
    await waitFor(() => pending.length === 2)
  })

  test('keeps an async run available after an SSE observer disconnects', async () => {
    const deferred = createDeferred<ReturnType<typeof successfulAgentResult>>()
    runOpenClaudeAgent.mockImplementationOnce(async () => deferred.promise)

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const runResponse = await fetch(`${server.url}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'survive observer disconnect' }),
    })
    const runBody = await runResponse.json() as { run_id: string }

    const observerAbort = new AbortController()
    const observer = await fetch(
      `${server.url}/v1/runs/${runBody.run_id}/events`,
      { signal: observerAbort.signal },
    )
    const reader = observer.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('run.started')
    observerAbort.abort()

    deferred.resolve(successfulAgentResult('completed after disconnect'))
    await waitFor(async () => {
      const queue = await fetch(`${server.url}/api/queue/status`).then(response => response.json()) as {
        completed: number
      }
      return queue.completed === 1
    })

    const resumed = await fetch(
      `${server.url}/v1/runs/${runBody.run_id}/events`,
    )
    expect(resumed.status).toBe(200)
    const events = await resumed.text()
    expect(events).toContain('run.completed')
    expect(events).toContain('completed after disconnect')
  })

  test('broadcasts the same async run history to every SSE observer', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async (options: MockAgentRunOptions) => {
      options.onStdout?.('shared stream delta')
      return successfulAgentResult('shared terminal output')
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const runResponse = await fetch(`${server.url}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'broadcast async run' }),
    })
    const { run_id: runId } = await runResponse.json() as { run_id: string }
    await waitFor(async () => {
      const status = await fetch(`${server.url}/api/queue/status`).then(response => response.json()) as {
        completed: number
      }
      return status.completed === 1
    })

    const [first, second] = await Promise.all([
      fetch(`${server.url}/v1/runs/${runId}/events`).then(response => response.text()),
      fetch(`${server.url}/v1/runs/${runId}/events`).then(response => response.text()),
    ])
    for (const events of [first, second]) {
      expect(events).toContain('shared stream delta')
      expect(events).toContain('run.completed')
      expect(events).toContain('shared terminal output')
      expect(events).toMatch(/id: \d+/u)
    }
  })

  test('allows public or tunnel bind only when an API key is set', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    const withoutKey = new AgentApiServer({
      config: testConfig({
        api: { host: '0.0.0.0' } as never,
      }),
    })
    await expect(withoutKey.start()).rejects.toThrow(
      'without an API key',
    )

    server = new AgentApiServer({
      config: testConfig({
        api: { host: '0.0.0.0', apiKey: 'secret' } as never,
      }),
    })
    await server.start()

    const response = await fetch(`${server.url}/v1/models`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(response.status).toBe(200)
  })

  test('strips leading frontmatter from agent responses before returning them to API clients', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async () => ({
      text: [
        '---',
        'name: odessa-file-created',
        'description: created a file',
        'type: project',
        '---',
        '',
        'Создал файл Одесса2.txt на рабочем столе.',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      activity: [
        'tool result success (Write: "Odessa2.txt")',
        'tool result success (Bash: "test -f Odessa2.txt")',
      ],
    }))

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'show odessa file result' }],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe(
      'Создал файл Одесса2.txt на рабочем столе.',
    )
  })
  test('accepts OpenWebUI request bodies larger than the former 1MB cap', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async () =>
      successfulAgentResult('large body accepted'),
    )
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }],
      }),
    })

    expect(response.status).toBe(200)
    expect(runOpenClaudeAgent.mock.calls.at(-1)?.[0]?.prompt.length)
      .toBeGreaterThan(1_000_000)
  })

  test('passes abort signals to non-streaming API agent runs', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async options => {
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return successfulAgentResult('chat signal ok')
    }).mockImplementationOnce(async options => {
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return successfulAgentResult('responses signal ok')
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const chat = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'signal chat' }],
      }),
    })
    expect(chat.status).toBe(200)

    const responses = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        input: 'signal responses',
      }),
    })
    expect(responses.status).toBe(200)
  })

  test('does not abort a completed request body while its response is pending', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async options => {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(options.signal?.aborted).toBe(false)
      return successfulAgentResult('connection-close request completed')
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const url = new URL(`${server.url}/v1/chat/completions`)
    const body = JSON.stringify({
      model: 'openclaude-agent',
      messages: [{ role: 'user', content: 'keep working after request EOF' }],
    })
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
        },
      }, response => {
        let responseBody = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          responseBody += chunk
        })
        response.on('end', () => resolve({
          status: response.statusCode || 0,
          body: responseBody,
        }))
      })
      request.on('error', reject)
      request.end(body)
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain('connection-close request completed')
  })

  test('aborts an active API agent run when the server stops', async () => {
    const started = createDeferred<AbortSignal>()
    runOpenClaudeAgent.mockImplementationOnce(async options => {
      const signal = options.signal!
      started.resolve(signal)
      if (!signal.aborted) {
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return {
        text: '',
        stderr: 'Gateway stopped.',
        exitCode: 1,
        timedOut: false,
        failureKind: 'aborted' as const,
      }
    })

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const request = fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'wait until shutdown' }],
      }),
    }).catch(() => undefined)
    const signal = await started.promise

    const stopping = server.stop()
    await waitFor(() => signal.aborted)
    await stopping
    server = undefined
    await request
  })

  test('restores response chains by conversation after restart when the index is missing', async () => {
    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const first = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'persist this response chain',
        conversation: 'durable-response-chat',
      }),
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { id: string }

    await rm(join(tempGatewayStateDir!, 'api-responses', 'conversations.json'), {
      force: true,
    })

    await server.stop()
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const restored = await fetch(
      `${server.url}/v1/responses/${firstBody.id}`,
    )
    expect(restored.status).toBe(200)

    const second = await fetch(`${server.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'continue after restart',
        conversation: 'durable-response-chat',
      }),
    })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as {
      output: Array<{ content: Array<{ text: string }> }>
    }
    expect(secondBody.output[0]?.content[0]?.text)
      .toContain('persist this response chain')
    expect(secondBody.output[0]?.content[0]?.text)
      .toContain('continue after restart')
  })

})
