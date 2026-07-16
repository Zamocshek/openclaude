import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildAgentArgs,
  buildAgentChildEnv,
  buildPromptFromChatMessages,
  classifyAgentRunFailure,
  extractStreamJsonResult,
  isIgnorablePostSuccessStderr,
  normalizeMessageContent,
  summarizeStreamJsonProgress,
  type StreamProgressContext,
} from './agentRunner.js'
import { getDefaultAgentGatewayConfig } from './config.js'

describe('agent gateway prompt builder', () => {
  test('folds OpenAI chat messages into a headless OpenClaude prompt', () => {
    const { prompt, systemPrompt } = buildPromptFromChatMessages([
      { role: 'system', content: 'Stay concise.' },
      { role: 'user', content: 'Inspect package.json.' },
      { role: 'assistant', content: 'I can do that.' },
      { role: 'user', content: 'Now summarize the project.' },
    ])

    expect(systemPrompt).toBe('Stay concise.')
    expect(prompt).toContain('System instructions:\nStay concise.')
    expect(prompt).toContain('Conversation so far:')
    expect(prompt).toContain('User: Inspect package.json.')
    expect(prompt).toContain('Assistant: I can do that.')
    expect(prompt).toEndWith('Now summarize the project.')
  })

  test('normalizes array message content', () => {
    expect(
      normalizeMessageContent([
        { type: 'text', text: 'first' },
        { type: 'input_text', content: 'second' },
        { type: 'image_url', image_url: { url: 'ignored' } },
      ]),
    ).toBe('first\nsecond')
  })

  test('keeps prompts out of CLI argv so variadic options cannot swallow them', () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.availableTools = ['Bash', 'Read', 'Write']
    config.runner.disallowedTools = ['WebSearch']

    const args = buildAgentArgs(config)

    expect(args).toContain('--print')
    expect(args).not.toContain('--bare')
    expect(args).toContain('--tools')
    expect(args).toContain('Bash,Read,Write')
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('WebSearch')
    expect(args).not.toContain('hello from api')
  })

  test('can disable model tool calls for local providers that reject tool schemas', () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.disableTools = true
    config.runner.availableTools = ['Bash']

    const args = buildAgentArgs(config)

    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
  })

  test('can request verbose stream-json for gateway progress observers', () => {
    const config = getDefaultAgentGatewayConfig()
    const args = buildAgentArgs(config, { streamEvents: true })

    expect(args).toContain('--print')
    expect(args).toContain('--verbose')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
  })

  test('enables non-interactive full access for bypass permission mode', () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.permissionMode = 'bypassPermissions'
    config.runner.cwd = 'C:\\workspace'

    const args = buildAgentArgs(config)

    expect(args).toContain('--allow-dangerously-skip-permissions')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--add-dir')
    expect(args).toContain('C:\\workspace')
  })

  test('adds OpenRAG usage guidance when RAG integration is configured', () => {
    const config = getDefaultAgentGatewayConfig()
    config.openRAG.enabled = true
    config.openRAG.apiKey = 'orag_test'
    config.openRAG.mcpEnabled = true

    const args = buildAgentArgs(config)
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('OpenRAG RAG may be available')
    expect(systemPrompt).toContain('openrag_search')
    expect(systemPrompt).toContain('openrag_ingest_file')
    expect(systemPrompt).toContain('openrag_chat')
  })

  test('adds CodeGraph guidance for code exploration and impact analysis', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('codegraph_explore')
    expect(systemPrompt).toContain('change impact')
    expect(systemPrompt).toContain('watcher updates the index automatically')
  })

  test('adds default SearXNG research guidance with a built-in fallback', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('searxng_web_search')
    expect(systemPrompt).toContain('searxng_instance_info')
    expect(systemPrompt).toContain('built-in WebSearch or WebFetch')
  })

  test('requires Context7 for current library and API documentation', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('resolve-library-id')
    expect(systemPrompt).toContain('query-docs')
    expect(systemPrompt).toContain('without waiting for an explicit user request')
  })

  test('requires a private skill, MCP, and tool routing pass before every task', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('Before executing every user request')
    expect(systemPrompt).toContain('available Skill descriptions')
    expect(systemPrompt).toContain('connected MCP servers')
    expect(systemPrompt).toContain('invoke the most specific Skill tool')
    expect(systemPrompt).toContain('privately select none')
    expect(systemPrompt).toContain('Do not reveal chain-of-thought')
  })

  test('turns Codex Ultra into xhigh reasoning with automatic delegation guidance', () => {
    const previousOpenClaudeModel = process.env.OPENCLAUDE_MODEL
    process.env.OPENCLAUDE_MODEL = 'gpt-5.6-sol?reasoning=ultra'
    try {
      const args = buildAgentArgs(getDefaultAgentGatewayConfig())
      const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

      expect(systemPrompt).toContain('Codex Ultra mode is active.')
      expect(systemPrompt).toContain('automatically delegate')
      expect(systemPrompt).toContain('Agent tool')
    } finally {
      if (previousOpenClaudeModel === undefined) {
        delete process.env.OPENCLAUDE_MODEL
      } else {
        process.env.OPENCLAUDE_MODEL = previousOpenClaudeModel
      }
    }
  })

  test('summarizes stream-json tool and thinking events without exposing reasoning text', () => {
    const events = summarizeStreamJsonProgress({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private chain of thought' },
          {
            type: 'tool_use',
            name: 'mcp_mcp_router_PowerShell',
            input: { command: 'Get-ChildItem C:\\Users\\test\\Desktop' },
          },
          {
            type: 'tool_use',
            name: 'skill_view',
            input: { name: 'playwright' },
          },
        ],
      },
    })

    expect(events).toContain('thinking')
    expect(events).toContain('mcp_mcp_router_PowerShell: "Get-ChildItem C:\\Users\\test\\Desktop"')
    expect(events).toContain('skill: "playwright"')
    expect(events.join('\n')).not.toContain('private chain of thought')
  })

  test('extracts measured cost from a successful stream-json result', () => {
    expect(extractStreamJsonResult({
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.0123,
    })).toEqual({
      text: 'done',
      error: '',
      costUsd: 0.0123,
    })
  })

  test('links stream-json tool result errors to the original tool call', () => {
    const context: StreamProgressContext = { toolUseById: new Map() }
    const toolEvents = summarizeStreamJsonProgress({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp_mcp_router_PowerShell',
            input: { command: 'Get-Process RustDesk' },
          },
        ],
      },
    }, context)
    const resultEvents = summarizeStreamJsonProgress({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: [{ type: 'text', text: 'window not found' }],
          },
        ],
      },
    }, context)

    expect(toolEvents).toContain('mcp_mcp_router_PowerShell: "Get-Process RustDesk"')
    expect(resultEvents).toContain('tool result error (mcp_mcp_router_PowerShell: "Get-Process RustDesk"): window not found')
  })

  test('classifies provider rate limits from activity and redacts Abacus-style keys', () => {
    const failure = classifyAgentRunFailure({
      text: '',
      stderr: 'Agent timed out after 2m 0s.',
      exitCode: 1,
      timedOut: true,
      activity: [
        'runtime init: 65 tools, 2 skills, MCP mcp-router:connected',
        'api retry: attempt 1/10 status 429',
      ],
    })

    expect(failure.kind).toBe('rate_limit')
    expect(failure.diagnostic).toContain('Provider rate limit')
    expect(
      summarizeStreamJsonProgress({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'echo s2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
            },
          ],
        },
      }).join('\n'),
    ).toContain('[REDACTED_API_KEY]')
  })

  test('classifies zero-exit failed tool completions as tool errors', () => {
    const failure = classifyAgentRunFailure({
      text: 'Не удалось создать файл: missing required parameter content.',
      stderr: 'Agent completed with an unsuccessful final answer after one or more tool errors.',
      exitCode: 1,
      timedOut: false,
      activity: [
        'Write: "{}"',
        'tool result error (Write: "{}"): missing required parameter content',
      ],
    })

    expect(failure.kind).toBe('tool_error')
    expect(failure.diagnostic).toContain('Recent activity')
  })

  test('ignores late transient fetch stderr after stream-json success', () => {
    expect(isIgnorablePostSuccessStderr({
      text: 'Saved.',
      streamResultText: 'Saved.',
      stderr: 'API Error: fetch failed',
      timedOut: false,
      activity: ['assistant response', 'result: success'],
    })).toBe(true)

    expect(isIgnorablePostSuccessStderr({
      text: '',
      streamResultText: '',
      stderr: 'API Error: fetch failed',
      timedOut: false,
      activity: ['result: success'],
    })).toBe(false)

    expect(isIgnorablePostSuccessStderr({
      text: 'Saved.',
      streamResultText: 'Saved.',
      stderr: 'API Error: fetch failed',
      timedOut: true,
      activity: ['result: success'],
    })).toBe(false)
  })

  test('does not recurse into gateway-server mode for child agent runs', () => {
    const cwd = join(tmpdir(), 'openclaude-agent-env-empty')
    const env = buildAgentChildEnv({
      OPENCLAUDE_AGENT_GATEWAY_SERVER: '1',
      OPENCLAUDE_AGENT_API_ENABLED: '1',
      OPENAI_API_KEY: 'provider-key',
    }, cwd)

    expect(env.OPENCLAUDE_AGENT_GATEWAY_CHILD).toBe('1')
    expect(env.OPENCLAUDE_AGENT_API_ENABLED).toBe('1')
    expect(env.OPENAI_API_KEY).toBe('provider-key')
    expect(env.OPENCLAUDE_AGENT_GATEWAY_SERVER).toBeUndefined()
  })

  test('hydrates child agent env from project dotenv without overriding explicit env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-env-'))
    await writeFile(
      join(cwd, '.env'),
      [
        'MCPR_TOKEN=file-token',
        'OPENAI_API_KEY="file-provider-key"',
      ].join('\n'),
      'utf8',
    )

    const env = buildAgentChildEnv(
      {
        OPENAI_API_KEY: 'explicit-provider-key',
      },
      cwd,
    )

    expect(env.MCPR_TOKEN).toBe('file-token')
    expect(env.MCPR_HOST).toBe('127.0.0.1')
    expect(env.MCPR_PORT).toBe('3282')
    expect(env.OPENAI_API_KEY).toBe('explicit-provider-key')
  })

  test('prefers dotenv MCP Router credentials over stale parent env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-mcpr-env-'))
    await writeFile(
      join(cwd, '.env'),
      [
        'MCPR_TOKEN=fresh-token',
        'MCPR_HOST=127.0.0.1',
        'MCPR_PORT=3282',
      ].join('\n'),
      'utf8',
    )

    const env = buildAgentChildEnv(
      {
        MCPR_TOKEN: 'stale-token',
        MCPR_HOST: 'old-host',
        MCPR_PORT: '9999',
      },
      cwd,
    )

    expect(env.MCPR_TOKEN).toBe('fresh-token')
    expect(env.MCPR_HOST).toBe('127.0.0.1')
    expect(env.MCPR_PORT).toBe('3282')
  })

  test('keeps Docker MCP endpoints over host dotenv localhost values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-docker-mcp-env-'))
    await writeFile(
      join(cwd, '.env'),
      [
        'MCPR_TOKEN=file-token',
        'MCPR_HOST=127.0.0.1',
        'MCPR_PORT=3282',
        'OPENRAG_URL=http://localhost:3000',
        'CAMOFOX_URL=http://localhost:9377',
        'HINDSIGHT_URL=http://localhost:8888',
      ].join('\n'),
      'utf8',
    )

    const env = buildAgentChildEnv(
      {
        OPENCLAUDE_DOCKER_RUN_AS_ROOT: '1',
        MCPR_TOKEN: 'runtime-token',
        MCPR_HOST: 'host.docker.internal',
        MCPR_PORT: '3282',
        OPENRAG_URL: 'http://host.docker.internal:3000',
        CAMOFOX_URL: 'http://host.docker.internal:9377',
        HINDSIGHT_URL: 'http://host.docker.internal:8888',
      },
      cwd,
    )

    expect(env.MCPR_TOKEN).toBe('runtime-token')
    expect(env.MCPR_HOST).toBe('host.docker.internal')
    expect(env.OPENRAG_URL).toBe('http://host.docker.internal:3000')
    expect(env.CAMOFOX_URL).toBe('http://host.docker.internal:9377')
    expect(env.HINDSIGHT_URL).toBe('http://host.docker.internal:8888')
    expect(env.MCP_TIMEOUT).toBe('5000')
  })

  test('can prefer dotenv provider profile for long-running gateway children', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-provider-env-'))
    await writeFile(
      join(cwd, '.env'),
      [
        'OPENCLAUDE_RESPECT_PROVIDER_ENV=1',
        'CLAUDE_CODE_USE_OPENAI=1',
        'OPENAI_BASE_URL=https://example.test/v1',
        'OPENAI_MODEL=file-model',
        'OPENAI_API_KEY=file-provider-key',
      ].join('\n'),
      'utf8',
    )

    const env = buildAgentChildEnv(
      {
        OPENCLAUDE_RESPECT_PROVIDER_ENV: '1',
        OPENAI_BASE_URL: 'https://stale.example/v1',
        OPENAI_MODEL: 'stale-model',
        OPENAI_API_KEY: 'stale-key',
      },
      cwd,
    )

    expect(env.OPENAI_BASE_URL).toBe('https://example.test/v1')
    expect(env.OPENAI_MODEL).toBe('file-model')
    expect(env.OPENAI_API_KEY).toBe('file-provider-key')
  })
})
