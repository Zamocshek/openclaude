import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDefaultAgentGatewayConfig, type AgentGatewayConfig } from './config.js'

type MockAgentRunOptions = {
  prompt: string
  onStdout?: (chunk: string) => void
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

mock.module('./agentRunner.js', () => ({
  runOpenClaudeAgent,
  addAgentRunObserver: () => () => {},
  redactAgentText: (text: string) => text,
  normalizeMessageContent: (content: unknown) =>
    typeof content === 'string' ? content : String(content ?? ''),
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
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

describe('AgentApiServer', () => {
  let server: import('./apiServer.js').AgentApiServer | undefined
  let previousGatewayStateDir: string | undefined
  let tempGatewayStateDir: string | undefined

  beforeEach(async () => {
    runOpenClaudeAgent.mockClear()
    runOpenClaudeAgent.mockImplementation(defaultRunOpenClaudeAgent)
    previousGatewayStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    tempGatewayStateDir = await mkdtemp(join(tmpdir(), 'openclaude-api-server-'))
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = tempGatewayStateDir
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    if (previousGatewayStateDir === undefined) {
      delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    } else {
      process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousGatewayStateDir
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
      data: { id: string; name: string; managed: boolean; instructions: string }
    }
    expect(createdBody.data).toMatchObject({
      name: 'api-verifier',
      managed: true,
    })
    expect(createdBody.data.instructions).toContain('focused API check')

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
    await waitFor(() => pending.length === 1)

    const queuedStatus = await fetch(`${server.url}/api/queue/status`)
    expect(queuedStatus.status).toBe(200)
    const queuedStatusBody = await queuedStatus.json() as {
      active: { label: string } | null
      waiting: number
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
    }))

    const { AgentApiServer } = await import('./apiServer.js')
    server = new AgentApiServer({ config: testConfig() })
    await server.start()

    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openclaude-agent',
        messages: [{ role: 'user', content: 'create odessa file' }],
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
})
