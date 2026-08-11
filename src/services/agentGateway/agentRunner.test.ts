import { describe, expect, test } from 'bun:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildAgentArgs,
  buildAgentChildEnv,
  buildSemanticRouterEnvOverrides,
  buildPromptFromChatMessages,
  classifyAgentRunFailure,
  classifyAgentToolEvidence,
  extractAgentArtifacts,
  extractVisualLocalPaths,
  extractCamofoxScreenshotArtifacts,
  extractStreamJsonAssistantText,
  extractStreamJsonResult,
  getAgentStallTimeoutMs,
  getAgentTerminalResultGraceMs,
  hasStreamJsonToolUse,
  hasCodingMutationIntent,
  hasCodingTaskIntent,
  injectGatewayVisionEvidence,
  isIgnorablePostSuccessStderr,
  normalizeMessageContent,
  restrictMcpTaskRouteForExecution,
  runOpenClaudeAgent,
  shouldUseGatewaySubagents,
  summarizeStreamJsonProgress,
  type StreamProgressContext,
} from './agentRunner.js'
import { getDefaultAgentGatewayConfig } from './config.js'
import { setManagedMcpServerEnabled } from './mcpRegistry.js'
import { redactAgentText } from './redaction.js'

describe('agent gateway prompt builder', () => {
  test('runs semantic routing without project memory or model reasoning', () => {
    const env = buildSemanticRouterEnvOverrides({
      OPENAI_MODEL: 'router-model',
      OPENAI_API_KEY: 'router-key',
      MAX_THINKING_TOKENS: '64000',
    })

    expect(env.OPENAI_MODEL).toBe('router-model')
    expect(env.OPENAI_API_KEY).toBe('router-key')
    expect(env.MAX_THINKING_TOKENS).toBe('0')
    expect(env.CLAUDE_CODE_DISABLE_THINKING).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
  })

  test('removes Telegram MCP from scheduled deliveries without dropping read tools', () => {
    const restricted = restrictMcpTaskRouteForExecution(
      {
        mode: 'auto',
        servers: new Set([
          'telegram-mcp',
          'mcp-router',
          'capability-router',
          'gateway-control',
          'hindsight',
          'searxng',
        ]),
        reasons: ['telegram-account', 'explicit-memory', 'research'],
      },
      'scheduled-delivery',
    )

    expect([...restricted.servers].sort()).toEqual(['hindsight', 'searxng'])
    expect(restricted.reasons)
      .toContain('execution-context:scheduled-delivery')
  })

  test('turns all-tools routes into an explicit scheduled-delivery allowlist', () => {
    const restricted = restrictMcpTaskRouteForExecution(
      {
        mode: 'all',
        servers: new Set(),
        reasons: ['explicit all-tools request'],
      },
      'scheduled-delivery',
      [
        'telegram-mcp',
        'mcp-router',
        'capability-router',
        'gateway-control',
        'hindsight',
        'context7',
      ],
    )

    expect(restricted.mode).toBe('auto')
    expect([...restricted.servers].sort()).toEqual(['context7', 'hindsight'])
  })

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

  test('detects coding and mutation intent from the current API request only', () => {
    const prompt = [
      'Old dialogue: fix the TypeScript implementation.',
      'Current request:',
      'Объясни результат без изменений.',
    ].join('\n')
    expect(hasCodingTaskIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(
      'Current request:\nИсправь TypeScript endpoint',
    )).toBe(true)
  })

  test('does not mistake Russian zapisat for an API coding request', () => {
    const prompt = 'Запомни и запиши мою Telegram-сетку в MONEY и память.'
    expect(hasCodingTaskIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(prompt)).toBe(false)
  })

  test('does not route prose about programming or deployment through coding mutation', () => {
    expect(hasCodingMutationIntent('Write a blog post about Python.')).toBe(false)
    expect(hasCodingMutationIntent('Create a status message about deploy.')).toBe(false)
    expect(hasCodingMutationIntent('Напиши пост про Python.')).toBe(false)
    expect(hasCodingMutationIntent('Напиши Python script scraper.py.')).toBe(true)
  })

  test('still recognizes a standalone Russian API request', () => {
    const prompt = 'Исправь АПИ интеграцию.'
    expect(hasCodingTaskIntent(prompt)).toBe(true)
    expect(hasCodingMutationIntent(prompt)).toBe(true)
  })

  test('does not infer coding intent from Telegram bridge instructions', () => {
    const prompt = [
      'Use code tools to write files when the task requires it.',
      'A successful camofox_screenshot tool result is uploaded automatically.',
      'User message:',
      'какие ощущения от употребления мемантина',
    ].join('\n')

    expect(hasCodingTaskIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(prompt)).toBe(false)
  })

  test('does not execute coding workflows quoted inside a dialogue-analysis request', () => {
    const prompt = [
      'User message:',
      'Объясни Никите в чем он ошибается в диалоге, пока ничего делать не надо!',
      '',
      'Alien Founder, [1 авг. 2026 в 11:56]',
      'сделай скрипт который старты в бота делает',
      'я запущу',
    ].join('\n')

    expect(hasCodingTaskIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(prompt)).toBe(false)

    const args = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt,
      preparedMcpConfigPath: '.mcp.json',
      preparedMcpServerNames: new Set(),
    })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(systemPrompt).toContain('pasted dialogue, logs, or quoted source material')
    expect(systemPrompt).toContain('conversational explanation or analysis')
    expect(systemPrompt).not.toContain('This request changes code or configuration')
  })

  test('keeps real coding intent when the directive asks to fix attached evidence', () => {
    const prompt = [
      'User message:',
      'Исправь эту ошибку и запусти тесты:',
      '',
      'Build log, [1 авг. 2026 в 11:56]',
      'TypeError: value is not a function at service.ts:42',
    ].join('\n')

    expect(hasCodingTaskIntent(prompt)).toBe(true)
    expect(hasCodingMutationIntent(prompt)).toBe(true)
  })

  test('does not let a scoped negative instruction cancel a real code change', () => {
    const prompt = 'Не меняй API-контракт, но исправь баг в TypeScript endpoint и запусти тесты.'
    expect(hasCodingTaskIntent(prompt)).toBe(true)
    expect(hasCodingMutationIntent(prompt)).toBe(true)
  })

  test('does not treat a negated mutation verb as a coding change request', () => {
    const prompt = [
      'Ничего не отправляй и не изменяй в Telegram.',
      'Файлы PREFLIGHT.md уже готовы. Используй только Hindsight recall.',
    ].join(' ')
    expect(hasCodingTaskIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(prompt)).toBe(false)
    expect(hasCodingMutationIntent(
      'Do not edit PREFLIGHT.md; only verify it with OpenRAG search.',
    )).toBe(false)
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
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('WebSearch')
    expect(args).not.toContain('hello from api')
  })

  test('confines semantically routed Telegram operations to typed MCP tools', () => {
    const config = getDefaultAgentGatewayConfig()
    const telegramRoute = {
      mode: 'auto' as const,
      servers: new Set(['telegram-mcp']),
      reasons: ['semantic telegram operation'],
      source: 'semantic' as const,
      capabilities: ['telegram'],
      taskKind: 'telegram-content-publishing',
      codingIntent: false,
      codingMutationIntent: false,
    }

    const args = buildAgentArgs(config, {
      prompt: 'Publish one approved post to every configured Telegram channel.',
      taskRoute: telegramRoute,
      preparedMcpConfigPath: '.mcp.json',
      preparedMcpServerNames: new Set(['telegram-mcp']),
    })
    const denied = args[args.indexOf('--disallowedTools') + 1].split(',')
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(denied).toContain('Bash')
    expect(denied).toContain('Read')
    expect(denied).toContain('Glob')
    expect(denied).toContain('Agent')
    expect(systemPrompt).toContain('typed Telegram MCP tools as the source of truth')

    const codingArgs = buildAgentArgs(config, {
      prompt: 'Fix the Telegram MCP TypeScript adapter.',
      taskRoute: { ...telegramRoute, codingIntent: true, codingMutationIntent: true },
      preparedMcpConfigPath: '.mcp.json',
      preparedMcpServerNames: new Set(['telegram-mcp']),
    })
    expect(codingArgs).not.toContain('--disallowedTools')
  })

  test('adds Agent to an explicit tool allowlist only for configured subagents', () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.availableTools = ['Bash', 'Read']

    const args = buildAgentArgs(config, {
      subagentRuntime: {
        settingsPath: '/tmp/subagent-routing.settings.json',
        agentsJson: '{}',
        roles: [{ name: 'gateway-explore', provider: 'deepseek', model: 'deepseek-v4-flash' }],
        cleanup: () => {},
      },
    })

    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read,Agent')
  })

  test('routes visual inputs through the dedicated multimodal subagent', () => {
    const config = getDefaultAgentGatewayConfig()
    const subagentRuntime = {
      settingsPath: '/tmp/subagent-routing.settings.json',
      agentsJson: '{}',
      roles: [{
        name: 'gateway-vision',
        provider: 'codex',
        model: 'gpt-5.6-sol?reasoning=ultra',
      }],
      cleanup: () => {},
    }
    const args = buildAgentArgs(config, {
      prompt: '[Vision input]\nlocal_path: /workspace/image.png',
      subagentRuntime,
    })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('Delegate the visual inspection exactly once')
    expect(systemPrompt).toContain('Do not call Read on image files in the parent run')
    expect(systemPrompt).toContain('gateway-vision')

    const textArgs = buildAgentArgs(config, {
      prompt: 'Answer a text-only question.',
      subagentRuntime,
    })
    const textSystemPrompt =
      textArgs[textArgs.indexOf('--append-system-prompt') + 1]
    expect(textSystemPrompt).not.toContain('Delegate the visual inspection exactly once')
  })

  test('replaces image paths with gateway-managed visual evidence before the text parent runs', () => {
    const prompt = [
      'Current request:',
      'Read the screenshot.',
      '[Vision input]',
      'local_path: /workspace/vision-inputs/example.png',
      'prompt_reference: @/workspace/vision-inputs/example.png',
      'mime_type: image/png',
      '- type: photo',
    ].join('\n')

    expect(extractVisualLocalPaths(prompt)).toEqual([
      '/workspace/vision-inputs/example.png',
    ])
    const injected = injectGatewayVisionEvidence(
      prompt,
      'Heading: MCP Servers. Sidebar: MCP Servers, Skills, Tools & Runtime, Request Log.',
    )

    expect(injected).toContain('[Gateway vision evidence]')
    expect(injected).toContain('Heading: MCP Servers')
    expect(injected).not.toContain('/workspace/vision-inputs/example.png')
    expect(injected).not.toContain('[Vision input]')
    expect(injected).not.toContain('mime_type: image/')
    expect(injected).not.toMatch(/-\s*type:\s*photo/iu)

    const config = getDefaultAgentGatewayConfig()
    const args = buildAgentArgs(config, { prompt: injected })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(systemPrompt).not.toContain('Delegate the visual inspection exactly once')
  })

  test('can disable model tool calls and all MCP process startup', async () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.disableTools = true
    config.runner.availableTools = ['Bash']

    const args = buildAgentArgs(config)

    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    const mcpConfigPath = args[args.indexOf('--mcp-config') + 1]
    expect(JSON.parse(await readFile(mcpConfigPath, 'utf8')).mcpServers).toEqual({})
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(systemPrompt).not.toContain('codegraph_explore')
    expect(systemPrompt).not.toContain('available Skill descriptions')
  })

  test('keeps disabled MCP servers out of strict config and capability guidance', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-agent-router-project-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-agent-router-state-'))
    const previousStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    try {
      process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
      await writeFile(join(project, '.mcp.json'), JSON.stringify({
        mcpServers: {
          codegraph: { command: 'node', args: ['codegraph.mjs'] },
          context7: { command: 'node', args: ['context7.mjs'] },
        },
      }))
      await setManagedMcpServerEnabled(project, 'context7', false)

      const config = getDefaultAgentGatewayConfig()
      config.runner.cwd = project
      const args = buildAgentArgs(config)
      const mcpConfigPath = args[args.indexOf('--mcp-config') + 1]
      const prepared = JSON.parse(await readFile(mcpConfigPath, 'utf8'))
      const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

      expect(args).toContain('--strict-mcp-config')
      expect(prepared.mcpServers.codegraph).toBeTruthy()
      expect(prepared.mcpServers.context7).toBeUndefined()
      expect(systemPrompt).toContain('Use CodeGraph')
      expect(systemPrompt).not.toContain('resolve-library-id')
      expect(systemPrompt).not.toContain('query-docs')
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      } else {
        process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousStateDir
      }
      await Promise.all([
        rm(project, { recursive: true, force: true }),
        rm(state, { recursive: true, force: true }),
      ])
    }
  })

  test('injects only the relevant compact capability map into an agent run', () => {
    const config = getDefaultAgentGatewayConfig()
    const args = buildAgentArgs(config, {
      prompt: 'Fix the TypeScript endpoint and run the tests.',
      preparedMcpConfigPath: '.mcp.json',
      preparedMcpServerNames: new Set([
        'codegraph',
        'context7',
        'hindsight',
        'searxng',
      ]),
    })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('Compact Nova capability map')
    expect(systemPrompt).toContain('codegraph_explore')
    expect(systemPrompt).toContain('resolve-library-id')
    expect(systemPrompt).not.toContain('hindsight_recall')
    expect(systemPrompt).not.toContain('searxng_web_search')
  })

  test('keeps disabled skills out of capability guidance', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-agent-router-skills-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-agent-router-skill-state-'))
    const previousStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    try {
      process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
      await writeFile(join(project, '.mcp.json'), '{"mcpServers":{}}\n')
      await writeFile(
        join(project, '.env'),
        'OPENCLAUDE_DISABLED_SKILLS=code,qwen-collab\n',
      )
      const config = getDefaultAgentGatewayConfig()
      config.runner.cwd = project
      const args = buildAgentArgs(config, {
        prompt: 'Fix the TypeScript code and run tests.',
      })
      const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

      expect(systemPrompt).not.toContain('# Production Coding Workflow')
      expect(systemPrompt).not.toContain('bundled qwen-collab Skill')
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      } else {
        process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousStateDir
      }
      await Promise.all([
        rm(project, { recursive: true, force: true }),
        rm(state, { recursive: true, force: true }),
      ])
    }
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

  test('uses a strict read-only runtime for pentest mode', () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.permissionMode = 'bypassPermissions'
    config.runner.disableTools = true

    const args = buildAgentArgs(config, { toolPolicy: 'pentest' })

    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args[args.indexOf('--tools') + 1]).toBe(
      'Skill,TodoWrite,Agent',
    )
    const allowed = args[args.indexOf('--allowedTools') + 1]
    expect(allowed).toContain('mcp__pentest__pentest_nmap_run')
    expect(allowed).toContain('mcp__codegraph__codegraph_explore')
    expect(allowed).not.toContain('context7')
    const denied = args[args.indexOf('--disallowedTools') + 1]
    expect(denied).toContain('Bash')
    expect(denied).toContain('PowerShell')
    expect(denied).toContain('WebFetch')
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(systemPrompt).toContain('Privately choose only the skills')
  })

  test('adds OpenRAG usage guidance when RAG integration is configured', () => {
    const config = getDefaultAgentGatewayConfig()
    config.openRAG.enabled = true
    config.openRAG.apiKey = 'orag_test'
    config.openRAG.mcpEnabled = true

    const args = buildAgentArgs(config)
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('For this document or knowledge-base request')
    expect(systemPrompt).toContain('openrag_search')
    expect(systemPrompt).toContain('openrag_ingest_file')
  })

  test('adds CodeGraph guidance for code exploration and impact analysis', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('Use CodeGraph')
    expect(systemPrompt).toContain('change impact')
  })

  test('adds default SearXNG research guidance with a built-in fallback', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('use SearXNG for discovery')
    expect(systemPrompt).toContain('fall back to available web tools')
  })

  test('requires Context7 for current library and API documentation', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('Use Context7')
    expect(systemPrompt).toContain('resolve the library ID')
    expect(systemPrompt).toContain('query the relevant docs')
  })

  test('requires live account discovery before Telegram MCP account actions', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig())
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('call list_accounts')
    expect(systemPrompt).toContain('If no session exists')
    expect(systemPrompt).toContain('confirm=true')
    expect(systemPrompt).toContain('not a transport for your gateway reply')
    expect(systemPrompt).toContain('is not permission to send anything')
    expect(systemPrompt).toContain('invoke the maton-api-gateway Skill')
    expect(systemPrompt).toContain('maton_telegram_*')
  })

  test('enables verifier-first terminal execution only when requested', () => {
    const previous = process.env.OPENCLAUDE_TERMINAL_BENCH
    try {
      delete process.env.OPENCLAUDE_TERMINAL_BENCH
      const normalArgs = buildAgentArgs(getDefaultAgentGatewayConfig())
      const normalPrompt = normalArgs[normalArgs.indexOf('--append-system-prompt') + 1]
      expect(normalPrompt).not.toContain('Terminal-Bench execution profile is active')

      process.env.OPENCLAUDE_TERMINAL_BENCH = '1'
      const benchArgs = buildAgentArgs(getDefaultAgentGatewayConfig())
      const benchPrompt = benchArgs[benchArgs.indexOf('--append-system-prompt') + 1]
      expect(benchPrompt).toContain('Terminal-Bench execution profile is active')
      expect(benchPrompt).toContain('explicit bounded timeouts')
      expect(benchPrompt).toContain('never repeat an identical failed command')
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAUDE_TERMINAL_BENCH
      } else {
        process.env.OPENCLAUDE_TERMINAL_BENCH = previous
      }
    }
  })

  test('routes personal RPG and life-management requests through the system index', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt: 'Update my life RPG habit tracker and planner.',
    })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('Vladimir_Kuplevatskyi/SYSTEM_INDEX.md')
    expect(systemPrompt).toContain('Vladimir_Kuplevatskyi/AGENT_OPERATIONS.md')
    expect(systemPrompt).toContain('Do not rewrite or erase existing memories')
    expect(systemPrompt).toContain('Never claim that a life/RPG update was saved')
  })

  test('skips personal RPG routing when the runner cwd has no life system', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-no-life-system-'))
    const config = getDefaultAgentGatewayConfig()
    config.runner.cwd = cwd

    const missingArgs = buildAgentArgs(config)
    const missingPrompt = missingArgs[missingArgs.indexOf('--append-system-prompt') + 1]
    expect(missingPrompt).not.toContain('Vladimir_Kuplevatskyi/SYSTEM_INDEX.md')

    await mkdir(join(cwd, 'Vladimir_Kuplevatskyi'), { recursive: true })
    await writeFile(
      join(cwd, 'Vladimir_Kuplevatskyi', 'SYSTEM_INDEX.md'),
      '# SYSTEM INDEX\n',
    )
    const presentArgs = buildAgentArgs(config, {
      prompt: 'Update my RPG habit tracker.',
    })
    const presentPrompt = presentArgs[presentArgs.indexOf('--append-system-prompt') + 1]
    expect(presentPrompt).toContain('Vladimir_Kuplevatskyi/SYSTEM_INDEX.md')
  })

  test('keeps ordinary dialogue lean and routes substantial tasks adaptively', () => {
    const simpleArgs = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt: 'Hello, how are you?',
      preparedMcpConfigPath: '.mcp.json',
      preparedMcpServerNames: new Set(),
    })
    const simplePrompt = simpleArgs[simpleArgs.indexOf('--append-system-prompt') + 1]
    expect(simplePrompt.length).toBeLessThan(1_000)
    expect(simplePrompt).not.toContain('capability-routing')
    expect(simplePrompt).toContain('highest reasoning effort supported')
    expect(shouldUseGatewaySubagents('Hello, how are you?')).toBe(false)
    expect(shouldUseGatewaySubagents('Fix the TypeScript service.')).toBe(true)
  })

  test('uses the production coding workflow in the unified harness', () => {
    const args = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt: 'Fix the bug in calculator.py and run its test.',
    })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('# Production Coding Workflow')
    expect(systemPrompt).toContain('## 4. Definition of done')
    expect(systemPrompt).toContain('TodoWrite')
    expect(systemPrompt).toContain('after the final mutation')
    expect(hasCodingTaskIntent('Исправь баг в TypeScript проекте')).toBe(true)
    expect(hasCodingTaskIntent('Какая сегодня погода?')).toBe(false)
  })

  test('adds staged SSH diagnostics only for remote administration tasks', () => {
    const remoteArgs = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt: 'Deploy the service to my VPS over SSH and verify the firewall.',
    })
    const remotePrompt = remoteArgs[remoteArgs.indexOf('--append-system-prompt') + 1]

    expect(remotePrompt).toContain('openclaude-ssh-doctor')
    expect(remotePrompt).toContain('TCP timeout proves only')
    expect(remotePrompt).toContain('sshpass -e')

    const russianArgs = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt: '\u041e\u0442\u043a\u0440\u043e\u0439 \u043f\u043e\u0440\u0442\u044b \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435 \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u044c firewall.',
    })
    const russianPrompt = russianArgs[russianArgs.indexOf('--append-system-prompt') + 1]
    expect(russianPrompt).toContain('openclaude-ssh-doctor')

    const ordinaryArgs = buildAgentArgs(getDefaultAgentGatewayConfig(), {
      prompt: 'Explain how this calculator works.',
    })
    const ordinaryPrompt = ordinaryArgs[ordinaryArgs.indexOf('--append-system-prompt') + 1]
    expect(ordinaryPrompt).not.toContain('openclaude-ssh-doctor')
  })

  test('adds the evidence-driven acceptance loop in ouroboros mode', () => {
    const config = getDefaultAgentGatewayConfig()
    config.runner.harnessMode = 'ouroboros'
    const args = buildAgentArgs(config, {
      prompt: 'Fix the bug in calculator.py and run its test.',
      preparedMcpConfigPath: '.mcp.json',
      preparedMcpServerNames: new Set(),
    })
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]

    expect(systemPrompt).toContain('# Production Coding Workflow')
    expect(systemPrompt).toContain('Ouroboros evidence loop is active')
    expect(systemPrompt).toContain('compact task contract')
    expect(systemPrompt).toContain('unmasked verifier')
    expect(systemPrompt).toContain('root-level acceptance checks')
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

  test('rejects a transport error disguised as a successful stream result', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      result: 'API Error: fetch failed',
    }
    expect(extractStreamJsonResult(message)).toEqual({
      text: '',
      error: 'API Error: fetch failed',
    })
    expect(summarizeStreamJsonProgress(message)).toEqual(['result: error'])
  })

  test('extracts the latest assistant text when a success result is empty', () => {
    expect(extractStreamJsonAssistantText({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'Final DeepSeek response.' },
        ],
      },
    })).toBe('Final DeepSeek response.')

    expect(extractStreamJsonResult({
      type: 'result',
      subtype: 'success',
      result: '',
    })).toEqual({
      text: '',
      error: '',
    })

    const intermediate = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will inspect the file.' },
          { type: 'tool_use', name: 'Read', input: { path: 'file.ts' } },
        ],
      },
    }
    expect(extractStreamJsonAssistantText(intermediate))
      .toBe('I will inspect the file.')
    expect(hasStreamJsonToolUse(intermediate)).toBe(true)
    expect(hasStreamJsonToolUse({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Final answer.' }] },
    })).toBe(false)
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

  test('records successful tool results with the original call summary', () => {
    const context: StreamProgressContext = {
      toolUseById: new Map(),
      toolNameById: new Map(),
    }
    summarizeStreamJsonProgress({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_success',
          name: 'Bash',
          input: { command: 'bun test agentRunner.test.ts' },
        }],
      },
    }, context)
    const events = summarizeStreamJsonProgress({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_success',
          is_error: false,
          content: '201 pass',
        }],
      },
    }, context)

    expect(events).toEqual([
      'tool result success (Bash: "bun test agentRunner.test.ts")',
    ])
  })

  test('records structured workspace evidence without accepting unrelated runtime health', () => {
    expect(classifyAgentToolEvidence({
      toolName: 'Edit',
      toolInput: { file_path: '/workspace/src/api.ts' },
      output: 'updated',
      success: true,
    })).toEqual([{
      kind: 'mutation',
      scope: 'workspace',
      target: 'file:/workspace/src/api.ts',
      success: true,
      source: 'Edit',
    }])
    expect(classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'curl -fsS http://unrelated.example/health' },
      output: 'ok',
      success: true,
    })).toEqual([])
  })

  test('treats document read-back as verification without weakening code checks', () => {
    expect(classifyAgentToolEvidence({
      toolName: 'Read',
      toolInput: { file_path: '/workspace/memory/MEMORY.md' },
      output: '# Memory',
      success: true,
    })).toEqual([{
      kind: 'verification',
      scope: 'workspace',
      target: 'file:/workspace/memory/memory.md',
      success: true,
      source: 'Read',
    }])
    expect(classifyAgentToolEvidence({
      toolName: 'Read',
      toolInput: { file_path: '/workspace/src/runtime.ts' },
      output: 'export const runtime = true',
      success: true,
    })).toEqual([])
  })

  test('records target-scoped runtime mutation and verification evidence', () => {
    const mutation = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'ssh root@host.example "systemctl restart nova"' },
      output: '',
      success: true,
    })
    const verification = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'ssh root@host.example "systemctl is-active nova"' },
      output: 'active',
      success: true,
    })
    expect(mutation).toContainEqual(expect.objectContaining({
      kind: 'mutation',
      scope: 'runtime',
      target: 'host:host.example/service:nova',
    }))
    expect(verification).toContainEqual(expect.objectContaining({
      kind: 'verification',
      scope: 'runtime',
      target: 'host:host.example/service:nova',
    }))
  })

  test('scopes generic SSH mutations and verifiers to short remote hostnames', () => {
    const mutation = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: {
        command: 'ssh -i /tmp/key -o BatchMode=yes root@nova-ssh-e2e "sed -i s/old/new/ /opt/app.py"',
      },
      output: '',
      success: true,
    })
    const verification = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: {
        command: 'ssh -i /tmp/key -o BatchMode=yes root@nova-ssh-e2e "python3 -m unittest -v /opt/test_app.py"',
      },
      output: 'Ran 1 test in 0.01s\nOK',
      success: true,
    })

    expect(mutation).toContainEqual(expect.objectContaining({
      kind: 'mutation',
      scope: 'runtime',
      target: 'host:nova-ssh-e2e/filesystem',
    }))
    expect(verification).toContainEqual(expect.objectContaining({
      kind: 'verification',
      scope: 'runtime',
      target: 'host:nova-ssh-e2e/filesystem',
    }))
    expect([...mutation, ...verification]).not.toContainEqual(
      expect.objectContaining({ scope: 'workspace' }),
    )
  })

  test('records only uploads as remote scp mutations', () => {
    const upload = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'scp -i /tmp/key ./app.py root@nova-ssh-e2e:/opt/app.py' },
      output: '',
      success: true,
    })
    const download = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'scp -i /tmp/key root@nova-ssh-e2e:/opt/app.py /tmp/app.py' },
      output: '',
      success: true,
    })

    expect(upload).toContainEqual(expect.objectContaining({
      kind: 'mutation',
      scope: 'runtime',
      target: 'host:nova-ssh-e2e/filesystem',
    }))
    expect(download).not.toContainEqual(expect.objectContaining({
      kind: 'mutation',
      target: 'host:nova-ssh-e2e/filesystem',
    }))

    const legacyProtocolUpload = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'scp -O ./app.py root@legacy-host:/opt/app.py' },
      output: '',
      success: true,
    })
    expect(legacyProtocolUpload).toContainEqual(expect.objectContaining({
      target: 'host:legacy-host/filesystem',
    }))

    const x11SshVerification = classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'ssh -X root@x11-host "test -f /opt/app.py"' },
      output: '',
      success: true,
    })
    expect(x11SshVerification).toContainEqual(expect.objectContaining({
      kind: 'verification',
      target: 'host:x11-host/filesystem',
    }))
  })

  test('records MCP file writes and Docker lifecycle evidence', () => {
    expect(classifyAgentToolEvidence({
      toolName: 'mcp__filesystem__write_file',
      toolInput: { path: '/workspace/src/generated.ts' },
      output: 'written',
      success: true,
    })).toEqual([{
      kind: 'mutation',
      scope: 'workspace',
      target: 'file:/workspace/src/generated.ts',
      success: true,
      source: 'mcp__filesystem__write_file',
    }])

    expect(classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'docker compose up -d api' },
      output: 'started',
      success: true,
    })).toContainEqual(expect.objectContaining({
      kind: 'mutation',
      scope: 'runtime',
      target: 'host:local/docker:*',
    }))
    expect(classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'docker compose ps api' },
      output: 'running',
      success: true,
    })).toContainEqual(expect.objectContaining({
      kind: 'verification',
      scope: 'runtime',
      target: 'host:local/docker:*',
    }))
  })

  test('does not record a masked runtime verifier as evidence', () => {
    expect(classifyAgentToolEvidence({
      toolName: 'Bash',
      toolInput: { command: 'systemctl is-active nova | tail -1' },
      output: 'active',
      success: true,
    }).some(item => item.kind === 'verification')).toBe(false)
  })

  test('bounds remembered tool calls for multi-hour stream sessions', () => {
    const context: StreamProgressContext = { toolUseById: new Map() }
    for (let index = 0; index < 700; index += 1) {
      summarizeStreamJsonProgress({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: `toolu_${index}`,
            name: 'Read',
            input: { file_path: `/workspace/file-${index}.ts` },
          }],
        },
      }, context)
    }

    expect(context.toolUseById.size).toBeLessThanOrEqual(512)
    expect(context.toolUseById.has('toolu_0')).toBe(false)
    expect(context.toolUseById.has('toolu_699')).toBe(true)
  })

  test('captures successful Camofox screenshots as Telegram-ready artifacts', () => {
    const context: StreamProgressContext = {
      toolUseById: new Map(),
      toolNameById: new Map(),
      artifacts: new Map(),
    }
    summarizeStreamJsonProgress({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_camofox',
          name: 'mcp__camofox__camofox_screenshot',
          input: { tabId: 'tab-1' },
        }],
      },
    }, context)
    summarizeStreamJsonProgress({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_camofox',
          content: [{
            type: 'text',
            text: 'Saved Camofox screenshot: /workspace/output/camofox/result.png',
          }],
        }],
      },
    }, context)

    expect([...context.artifacts!.values()]).toEqual([{
      path: '/workspace/output/camofox/result.png',
      kind: 'image',
      source: 'mcp__camofox__camofox_screenshot',
    }])
    expect(
      extractCamofoxScreenshotArtifacts(
        'Read',
        'Saved Camofox screenshot: /workspace/not-from-camofox.png',
      ),
    ).toEqual([])
  })

  test('captures tool-declared binary artifacts without reading their bytes', () => {
    expect(extractAgentArtifacts(
      'Bash',
      'OPENCLAUDE_ARTIFACT {"path":"/workspace/output/voice.mp3","kind":"audio","caption":"Russian sample","bytes":42}',
    )).toEqual([{
      path: '/workspace/output/voice.mp3',
      kind: 'audio',
      caption: 'Russian sample',
      source: 'Bash',
    }])

    expect(extractAgentArtifacts(
      'Bash',
      'OPENCLAUDE_ARTIFACT {not-json}',
    )).toEqual([])
  })

  test('captures a successful Telegram session authorization continuation without secrets', () => {
    const context: StreamProgressContext = {
      toolUseById: new Map(),
      toolNameById: new Map(),
      interactionCandidateByToolUseId: new Map(),
      pendingInteractions: new Map(),
    }
    summarizeStreamJsonProgress({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_auth',
          name: 'mcp__telegram-mcp__authorize_send_code',
          input: { phone: '+1 854 442 1149' },
        }],
      },
    }, context)
    summarizeStreamJsonProgress({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_auth',
          content: [{
            type: 'text',
            text: "Code sent to the account. Now call authorize_complete(session_name='18544421149', code=<received code>).",
          }],
        }],
      },
    }, context)

    expect([...context.pendingInteractions!.values()]).toEqual([{
      protocol: 'openclaude.interaction/v1' as const,
      id: 'telegram-auth:18544421149',
      handler: 'telegram.session.authorize',
      stage: 'code',
      prompt: 'Send the Telegram confirmation code.',
      input: {
        name: 'code',
        kind: 'otp',
        prompt: 'Send the Telegram confirmation code.',
        minLength: 5,
        maxLength: 5,
      },
      state: { sessionName: '18544421149' },
      sourceTool: 'mcp__telegram-mcp__authorize_send_code',
      expiresInMs: 10 * 60_000,
    }])
    expect(JSON.stringify([...context.pendingInteractions!.values()]))
      .not.toContain('+1 854 442 1149')
  })

  test('captures a generic tool-declared interaction without knowing the tool name', () => {
    const context: StreamProgressContext = {
      toolUseById: new Map(),
      toolNameById: new Map(),
      interactionCandidateByToolUseId: new Map(),
      pendingInteractions: new Map(),
    }
    summarizeStreamJsonProgress({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_prepare',
          name: 'mcp__future-service__prepare_operation',
          input: {},
        }],
      },
    }, context)
    const envelope = {
      protocol: 'openclaude.interaction/v1' as const,
      id: 'future:choice-1',
      handler: 'future.choose-target',
      stage: 'target',
      prompt: 'Choose a target.',
      input: {
        name: 'target',
        kind: 'choice' as const,
        prompt: 'Choose a target.',
        choices: ['alpha', 'beta'],
      },
      state: { operationId: 'op-1' },
      expiresInMs: 600000,
    }
    summarizeStreamJsonProgress({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_prepare',
          content: [{
            type: 'text',
            text: `<openclaude_interaction>${JSON.stringify(envelope)}</openclaude_interaction>`,
          }],
        }],
      },
    }, context)

    expect([...context.pendingInteractions!.values()]).toEqual([{
      ...envelope,
      sourceTool: 'mcp__future-service__prepare_operation',
    }])
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

  test('redacts command-line, environment, URL, and private-key credentials', () => {
    const secrets = [
      'ssh-password-value',
      'basic-auth-password',
      'environment-secret-value',
      'url-password-value',
      'private-key-material',
      'bearer-token-value',
      'sshpass-environment-value',
    ]
    const redacted = redactAgentText([
      `sshpass -p '${secrets[0]}' ssh root@example.test`,
      `curl -u 'root:${secrets[1]}' https://example.test`,
      `DEPLOY_PASSWORD='${secrets[2]}' deploy`,
      `https://root:${secrets[3]}@example.test/path`,
      `-----BEGIN PRIVATE KEY-----\n${secrets[4]}\n-----END PRIVATE KEY-----`,
      `AUTHORIZATION=Bearer ${secrets[5]}`,
      `SSHPASS='${secrets[6]}' sshpass -e ssh root@example.test`,
      `https://api.telegram.org/bot1234567890:AA${'a'.repeat(24)}/sendMessage`,
    ].join('\n'))

    for (const secret of secrets) expect(redacted).not.toContain(secret)
    expect(redacted).toContain('[REDACTED_PASSWORD]')
    expect(redacted).toContain('[REDACTED_CREDENTIALS]')
    expect(redacted).toContain('DEPLOY_PASSWORD=[REDACTED]')
    expect(redacted).toContain('https://[REDACTED]@example.test/path')
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]')
    expect(redacted).toContain('bot[REDACTED_TELEGRAM_TOKEN]/sendMessage')
  })

  test('does not misclassify tool 404 or forbidden errors as provider state', () => {
    const missingFile = classifyAgentRunFailure({
      text: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      activity: [
        'Read: "/workspace/missing.ts"',
        'tool result error (Read): 404 not_found',
      ],
    })
    const forbiddenFile = classifyAgentRunFailure({
      text: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      activity: [
        'Edit: "/workspace/config.json"',
        'tool result error (Edit): forbidden by file permissions',
      ],
    })
    const missingModel = classifyAgentRunFailure({
      text: '',
      stderr: 'Provider returned 404: model deepseek-missing was not found',
      exitCode: 1,
      timedOut: false,
    })

    expect(missingFile.kind).toBe('tool_error')
    expect(forbiddenFile.kind).toBe('tool_error')
    expect(missingModel.kind).toBe('model_not_found')
  })

  test('classifies provider content-policy blocks as non-tool provider state', () => {
    const failure = classifyAgentRunFailure({
      text: '',
      stderr: 'API Error: 500 This content was flagged for possible cybersecurity risk.',
      exitCode: 1,
      timedOut: false,
      activity: [
        'api retry: attempt 10/10 status 500, server_error',
      ],
    })

    expect(failure.kind).toBe('content_policy')
    expect(failure.diagnostic).toContain('safety/content policy')
  })

  test('classifies child runtime configuration errors as non-retryable setup state', () => {
    const failure = classifyAgentRunFailure({
      text: '',
      stderr: '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons',
      exitCode: 1,
      timedOut: false,
      activity: ['runtime starting'],
    })

    expect(failure.kind).toBe('runtime_configuration')
    expect(failure.diagnostic).toContain('rejected its own configuration')
  })

  test('classifies missing tool calls as tool errors instead of generic execution', () => {
    const failure = classifyAgentRunFailure({
      text: '',
      stderr: '<tool_use_error>Error: No such tool available: Write</tool_use_error>',
      exitCode: 1,
      timedOut: false,
      activity: ['Write: "/workspace/file.ts"'],
    })

    expect(failure.kind).toBe('tool_error')
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

  test('keeps zero-exit diagnostic answers deliverable after tool errors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-fake-cli-'))
    const fakeCli = join(cwd, 'fake-cli.cjs')
    await writeFile(fakeCli, [
      'const events = [',
      '  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/workspace/file.ts" } }] } },',
      '  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: [{ type: "text", text: "No such tool available: Write" }] }] } },',
      '  { type: "result", subtype: "success", is_error: false, result: "Fixed part of the task, but tests failed." }',
      ']',
      'for (const event of events) console.log(JSON.stringify(event))',
    ].join('\n'))
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = `"${process.execPath}" "${fakeCli}"`
    try {
      const config = getDefaultAgentGatewayConfig()
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Fix code and run tests.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(0)
      expect(result.text).toContain('tests failed')
      expect(result.failureKind).toBeUndefined()
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
    }
  })

  test('preserves UTF-8 when a stream-json line is split inside a code point', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-utf8-cli-'))
    const fakeCli = join(cwd, 'fake-utf8-cli.cjs')
    await writeFile(fakeCli, [
      'const line = Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Привет" }) + "\\n")',
      'const marker = line.indexOf(Buffer.from("П"))',
      'process.stdout.write(line.subarray(0, marker + 1))',
      'setTimeout(() => process.stdout.end(line.subarray(marker + 1)), 10)',
    ].join('\n'))
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    try {
      const config = getDefaultAgentGatewayConfig()
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Reply in Russian.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(0)
      expect(result.text).toBe('Привет')
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('rejects a stream-json run that exits without a terminal result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-truncated-cli-'))
    const fakeCli = join(cwd, 'fake-truncated-cli.cjs')
    await writeFile(
      fakeCli,
      'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "unfinished" }] } }))\n',
    )
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    try {
      const config = getDefaultAgentGatewayConfig()
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Complete the task.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(1)
      expect(result.text).toBe('')
      expect(result.stderr).toContain('without a terminal result')
      expect(result.failureKind).toBe('execution')
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('contains stdin EPIPE failures inside the current agent run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-epipe-cli-'))
    const fakeCli = join(cwd, 'fake-epipe-cli.cjs')
    await writeFile(fakeCli, 'process.stdin.destroy(); process.exit(0)\n')
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    try {
      const config = getDefaultAgentGatewayConfig()
      config.runner.timeoutMs = 5_000
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'x'.repeat(8 * 1024 * 1024),
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/terminal result|send the prompt/iu)
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('finishes after a terminal success event even when the child process lingers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-terminal-result-cli-'))
    const fakeCli = join(cwd, 'fake-terminal-result-cli.cjs')
    await writeFile(fakeCli, [
      'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Generated." }))',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    const previousGrace = process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS
    const previousState = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS = '25'
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = join(cwd, 'state')
    try {
      const config = getDefaultAgentGatewayConfig()
      config.runner.timeoutMs = 5_000
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Generate one artifact.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(0)
      expect(result.text).toBe('Generated.')
      expect(result.timedOut).toBe(false)
      expect(result.durationMs).toBeLessThan(2_000)
      expect(result.activity).toContain('result: success')
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      if (previousGrace === undefined) delete process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS
      else process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS = previousGrace
      if (previousState === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousState
      await new Promise(resolve => setTimeout(resolve, 250))
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('does not misclassify tool auth and rate-limit failures as provider state', () => {
    const toolUnauthorized = classifyAgentRunFailure({
      text: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      activity: [
        'mcp_github_get_issue: "{}"',
        'tool result error (mcp_github_get_issue): 401 unauthorized',
      ],
    })
    const toolRateLimit = classifyAgentRunFailure({
      text: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      activity: [
        'web_url_read: "https://example.test"',
        'tool result error (web_url_read): 429 rate limited',
      ],
    })
    const providerUnauthorized = classifyAgentRunFailure({
      text: '',
      stderr: 'API Error: 401 unauthorized: invalid api key',
      exitCode: 1,
      timedOut: false,
    })

    expect(toolUnauthorized.kind).toBe('tool_error')
    expect(toolRateLimit.kind).toBe('tool_error')
    expect(providerUnauthorized.kind).toBe('auth')
  })

  test('delivers a completed stream result despite plain late fetch stderr', () => {
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

    expect(isIgnorablePostSuccessStderr({
      text: 'Saved.',
      streamResultText: 'Saved.',
      stderr: 'API Error: fetch failed\ncause: ECONNRESET',
      timedOut: false,
      activity: ['result: success'],
    })).toBe(false)
  })

  test('classifies provider fetch failures as transient network state', () => {
    const failure = classifyAgentRunFailure({
      text: '',
      stderr: 'API Error: fetch failed\ncause: ECONNRESET',
      exitCode: 1,
      timedOut: false,
      activity: ['api retry: attempt 3/3 status network'],
    })

    expect(failure.kind).toBe('transient_network')
    expect(failure.diagnostic).toContain('bounded backoff')
  })

  test('keeps a terminal provider fetch failure above recovered tool history', () => {
    const failure = classifyAgentRunFailure({
      text: '',
      stderr: 'API Error: fetch failed\ncause: ECONNRESET',
      exitCode: 1,
      timedOut: false,
      activity: [
        'tool result error (Edit: "src/index.ts"): stale old_string',
        'tool result success (Edit: "src/index.ts")',
      ],
    })

    expect(failure.kind).toBe('transient_network')
  })

  test('bounds the idle watchdog by the total runner timeout', () => {
    expect(getAgentStallTimeoutMs(60_000, {
      OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS: '5000',
    })).toBe(5_000)
    expect(getAgentStallTimeoutMs(2_000, {
      OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS: '5000',
    })).toBe(2_000)
    expect(getAgentStallTimeoutMs(60_000, {
      OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS: '0',
    })).toBe(0)
    expect(getAgentTerminalResultGraceMs({
      OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS: '750',
    })).toBe(750)
  })

  test('stops a child whose stderr heartbeat does not represent agent progress', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-stall-cli-'))
    const fakeCli = join(cwd, 'fake-stall-cli.cjs')
    await writeFile(
      fakeCli,
      'setInterval(() => process.stderr.write("heartbeat\\n"), 20)\n',
    )
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    const previousStall = process.env.OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS
    const previousState = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    process.env.OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS = '100'
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = join(cwd, 'state')
    try {
      const config = getDefaultAgentGatewayConfig()
      config.runner.timeoutMs = 5_000
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Wait forever.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(1)
      expect(result.timedOut).toBe(true)
      expect(result.stalled).toBe(true)
      expect(result.failureKind).toBe('timeout')
      expect(result.diagnostic).toContain('stall watchdog')
      expect(result.durationMs).toBeLessThan(3_000)
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      if (previousStall === undefined) delete process.env.OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS
      else process.env.OPENCLAUDE_AGENT_RUNNER_STALL_TIMEOUT_MS = previousStall
      if (previousState === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousState
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('stops a repeated failed tool route before the global timeout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-loop-cli-'))
    const fakeCli = join(cwd, 'fake-loop-cli.cjs')
    await writeFile(fakeCli, [
      'for (let index = 0; index < 3; index += 1) {',
      '  const id = `toolu_${index}`',
      '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/workspace/missing.wav" } }] } }))',
      '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: "binary files cannot be read as text" }] }] } }))',
      '}',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    const previousLoopLimit = process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT
    const previousState = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT = '3'
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = join(cwd, 'state')
    try {
      const config = getDefaultAgentGatewayConfig()
      config.runner.timeoutMs = 5_000
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Finish the artifact task.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(1)
      expect(result.timedOut).toBe(false)
      expect(result.failureKind).toBe('loop_detected')
      expect(result.diagnostic).toContain('live watchdog')
      expect(result.durationMs).toBeLessThan(3_000)
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      if (previousLoopLimit === undefined) delete process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT
      else process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT = previousLoopLimit
      if (previousState === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousState
      await new Promise(resolve => setTimeout(resolve, 250))
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('lets a terminal success in the same stream chunk win over loop abort', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-loop-success-cli-'))
    const fakeCli = join(cwd, 'fake-loop-success-cli.cjs')
    await writeFile(fakeCli, [
      'const events = []',
      'for (let index = 0; index < 3; index += 1) {',
      '  const id = `toolu_${index}`',
      '  events.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/workspace/missing.wav" } }] } })',
      '  events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: "binary files cannot be read as text" }] }] } })',
      '}',
      'events.push({ type: "result", subtype: "success", is_error: false, result: "Recovered inside the turn." })',
      'process.stdout.write(events.map(event => JSON.stringify(event)).join("\\n") + "\\n")',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    const previousLoopLimit = process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT
    const previousGrace = process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS
    const previousState = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = `"${process.execPath}" "${fakeCli}"`
    process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT = '3'
    process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS = '25'
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = join(cwd, 'state')
    try {
      const config = getDefaultAgentGatewayConfig()
      config.runner.timeoutMs = 5_000
      config.subagents.enabled = false
      const result = await runOpenClaudeAgent({
        prompt: 'Finish the task.',
        config,
        cwd,
        streamEvents: true,
        suppressObservers: true,
      })

      expect(result.exitCode).toBe(0)
      expect(result.text).toBe('Recovered inside the turn.')
      expect(result.failureKind).toBeUndefined()
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      if (previousLoopLimit === undefined) delete process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT
      else process.env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT = previousLoopLimit
      if (previousGrace === undefined) delete process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS
      else process.env.OPENCLAUDE_AGENT_TERMINAL_RESULT_GRACE_MS = previousGrace
      if (previousState === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousState
      await new Promise(resolve => setTimeout(resolve, 250))
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('isolates task-scoped MCP profiles across concurrent runs and cleans them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-routed-mcp-'))
    const fakeCli = join(cwd, 'fake-mcp-cli.cjs')
    await writeFile(fakeCli, [
      'const fs = require("fs")',
      'const index = process.argv.indexOf("--mcp-config")',
      'const configPath = process.argv[index + 1]',
      'const config = JSON.parse(fs.readFileSync(configPath, "utf8"))',
      'const result = JSON.stringify({ configPath, servers: Object.keys(config.mcpServers || {}).sort() })',
      'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }))',
    ].join('\n'))
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: {
        hindsight: { command: 'node', args: ['hindsight.mjs'] },
        codegraph: { command: 'node', args: ['codegraph.mjs'] },
        context7: { command: 'node', args: ['context7.mjs'] },
        camofox: { command: 'node', args: ['camofox.mjs'] },
        searxng: { command: 'node', args: ['searxng.mjs'] },
      },
    }))
    const previousCommand = process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
    const previousState = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    const stateDir = join(cwd, 'state')
    const staleConfig = join(stateDir, 'run-mcp', 'stale.mcp.json')
    await mkdir(join(stateDir, 'run-mcp'), { recursive: true })
    await writeFile(staleConfig, '{"mcpServers":{}}')
    const staleTime = new Date(Date.now() - (25 * 60 * 60_000))
    await utimes(staleConfig, staleTime, staleTime)
    process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND =
      `"${process.execPath}" "${fakeCli}"`
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
    try {
      const config = getDefaultAgentGatewayConfig()
      config.runner.cwd = cwd
      config.subagents.enabled = false
      const [codingResult, browserResult, allResult] = await Promise.all([
        runOpenClaudeAgent({
          prompt: 'Fix the TypeScript implementation.',
          config,
          cwd,
          streamEvents: true,
          suppressObservers: true,
        }),
        runOpenClaudeAgent({
          prompt: 'Open the website in Camofox and take a screenshot.',
          config,
          cwd,
          streamEvents: true,
          suppressObservers: true,
        }),
        runOpenClaudeAgent({
          prompt: 'Use all MCP tools for this task.',
          config,
          cwd,
          streamEvents: true,
          suppressObservers: true,
        }),
      ])
      const coding = JSON.parse(codingResult.text) as {
        configPath: string
        servers: string[]
      }
      const browser = JSON.parse(browserResult.text) as {
        configPath: string
        servers: string[]
      }
      const all = JSON.parse(allResult.text) as {
        configPath: string
        servers: string[]
      }

      expect(coding.servers).toEqual(['codegraph', 'context7'])
      expect(browser.servers).toEqual(['camofox'])
      expect(all.servers).toEqual([
        'camofox',
        'codegraph',
        'context7',
        'gateway-control',
        'hindsight',
        'searxng',
      ])
      expect(coding.configPath).not.toBe(browser.configPath)
      expect(all.configPath).not.toBe(coding.configPath)
      expect(await access(coding.configPath).then(() => true, () => false)).toBe(false)
      expect(await access(browser.configPath).then(() => true, () => false)).toBe(false)
      expect(await access(all.configPath).then(() => true, () => false)).toBe(false)
      expect(await access(staleConfig).then(() => true, () => false)).toBe(false)
    } finally {
      if (previousCommand === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND
      else process.env.OPENCLAUDE_AGENT_GATEWAY_COMMAND = previousCommand
      if (previousState === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
      else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousState
      await rm(cwd, { recursive: true, force: true })
    }
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
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('3')
    expect(env.API_TIMEOUT_MS).toBe('60000')
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

  test('restores Tool Router skill state from dotenv over an empty Docker default', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-skill-env-'))
    await writeFile(
      join(cwd, '.env'),
      'OPENCLAUDE_DISABLED_SKILLS=batch,debug\n',
      'utf8',
    )

    const env = buildAgentChildEnv(
      { OPENCLAUDE_DISABLED_SKILLS: '' },
      cwd,
    )

    expect(env.OPENCLAUDE_DISABLED_SKILLS).toBe('batch,debug')
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

  test('keeps OpenCode Zen adapter env aligned with the canonical gateway profile', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openclaude-agent-opencode-env-'))
    await writeFile(
      join(cwd, '.env'),
      [
        'OPENCLAUDE_RESPECT_PROVIDER_ENV=1',
        'OPENCLAUDE_PROVIDER=opencode-zen',
        'OPENCLAUDE_BASE_URL=https://opencode.ai/zen/v1',
        'OPENCLAUDE_MODEL=deepseek-v4-flash-free',
        'CLAUDE_CODE_USE_OPENAI=1',
        'OPENAI_BASE_URL=https://stale.example/v1',
        'OPENAI_MODEL=stale-model',
        'OPENAI_API_KEY=stale-key',
        'OPENCODE_ZEN_API_KEY=zen-key',
      ].join('\n'),
      'utf8',
    )

    const env = buildAgentChildEnv({}, cwd)

    expect(env.OPENAI_BASE_URL).toBe('https://opencode.ai/zen/v1')
    expect(env.OPENAI_MODEL).toBe('deepseek-v4-flash-free')
    expect(env.OPENAI_API_KEY).toBe('zen-key')
  })
})
