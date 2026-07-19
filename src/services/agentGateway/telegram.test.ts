import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  applyTelegramCronDirectivesForChat,
  buildTelegramAgentPrompt,
  buildTelegramAgentRecoveryPrompt,
  buildTelegramBotCommands,
  buildTelegramDownloadFileName,
  buildTelegramHelpText,
  buildTelegramControlKeyboard,
  buildTelegramMcpKeyboard,
  buildTelegramModelKeyboard,
  buildTelegramProviderKeyboard,
  buildTelegramProviderProfileUpdate,
  buildTelegramReasoningKeyboard,
  buildTelegramRuntimeKeyboard,
  buildTelegramSkillDetailsKeyboard,
  buildTelegramSkillStoreKeyboard,
  buildTelegramReplyContext,
  extractTelegramCronDirectives,
  extractTelegramSendDirectives,
  formatTelegramReplyContext,
  formatTelegramProgressText,
  formatTelegramQueueNotice,
  formatTelegramMcpMenu,
  formatTelegramSkillDetails,
  formatTelegramSkillStoreMenu,
  formatTelegramConversationTranscript,
  formatTelegramAgentFailureForRecovery,
  getAgentRecoveryFailureSignature,
  getAudioTranscriptionCandidate,
  getAttachmentCandidates,
  getTelegramAgentFailureKindLimit,
  getTelegramAgentRepeatedFailureLimit,
  getTelegramAgentRecoveryAttemptLimit,
  getTelegramQueuePosition,
  getTelegramProviderShortcut,
  isTelegramActorAllowed,
  hasTelegramMemoryIntent,
  applyTelegramResearchMode,
  repairLikelyMojibakeText,
  parseTelegramSkillCreateInput,
  summarizeAgentProgressChunk,
  safeTelegramFileName,
  selectLargestPhoto,
  shouldRetryTelegramAgentFailure,
  TelegramAgentBridge,
  type TelegramAttachment,
} from './telegram.js'
import { listCronJobs } from './cron.js'
import { getDefaultAgentGatewayConfig } from './config.js'

async function withTempGatewayState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const previousStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-agent-gateway-telegram-'))
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
  try {
    return await fn(stateDir)
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    } else {
      process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousStateDir
    }
    await rm(stateDir, { recursive: true, force: true })
  }
}

describe('agent gateway Telegram bridge helpers', () => {
  test('applies the same allowlist to messages and inline button callbacks', () => {
    const policy = {
      allowedChatIds: ['100'],
      allowedUserIds: ['5117562403'],
      homeChatId: '200',
    }

    expect(isTelegramActorAllowed({ ...policy, chatId: '100', userId: '7' })).toBe(true)
    expect(isTelegramActorAllowed({ ...policy, chatId: '300', userId: '5117562403' })).toBe(true)
    expect(isTelegramActorAllowed({ ...policy, chatId: '300', userId: '7' })).toBe(false)
  })

  test('builds Telegram help text and bot command menu from one command list', () => {
    const help = buildTelegramHelpText()
    const commands = buildTelegramBotCommands()

    expect(help).toContain('OpenClaude Telegram inference is online.')
    expect(help).toContain('/provider set <provider> <model> [base_url] [api_key]')
    expect(help).toContain('/panel - open the button control panel')
    expect(help).toContain('/mcp add <json> - import one or more mcpServers definitions')
    expect(help).toContain('/skills - browse the Skill Store with inline buttons')
    expect(help).toContain('/skill create <json> - create a persistent native SKILL.md')
    expect(help).toContain('/tools [on|off] - show, enable, or disable model tool calls')
    expect(help).toContain('/bg [start|stop|now|status] - persist, wake, or inspect background consciousness')
    expect(help).toContain('/consciousness [start|stop|now|status] - alias for /bg')
    expect(help).toContain('/evolve [on|off|now|status] - control evolution or run one cycle immediately')
    expect(help).toContain('/dsflash - switch to DeepSeek V4 Flash')
    expect(help).toContain('/gemmacoder - switch to LM Studio Huihui Gemma Coder')
    expect(help).toContain('/context auto|1m|<tokens> - set manual context window or return to model auto mode')
    expect(help).toContain('/bio [prompt] - biology scientist mode for research tasks')
    expect(help).toContain('/mode off - clear the active research mode for this chat')
    expect(help).toContain('/stop - abort the current running task')
    expect(help).toContain('/git commit <msg> - stage and commit all changes')
    expect(commands).toContainEqual({
      command: 'help',
      description: 'Show Telegram control help',
    })
    expect(commands).toContainEqual({
      command: 'provider',
      description: 'Show or switch provider/model',
    })
    expect(commands).toContainEqual({
      command: 'panel',
      description: 'Open agent control panel',
    })
    expect(commands).toContainEqual({
      command: 'mcp',
      description: 'Manage MCP servers',
    })
    expect(commands).toContainEqual({
      command: 'skills',
      description: 'Browse and create agent skills',
    })
    expect(commands).toContainEqual({
      command: 'tools',
      description: 'Control model tools',
    })
    expect(commands).toContainEqual({
      command: 'dsflash',
      description: 'switch to DeepSeek V4 Flash',
    })
    expect(commands).toContainEqual({
      command: 'gemmacoder',
      description: 'switch to LM Studio Huihui Gemma Coder',
    })
    expect(commands).toContainEqual({
      command: 'context',
      description: 'Show or set context window',
    })
    expect(commands).toContainEqual({
      command: 'bio',
      description: 'Biology research mode',
    })
    expect(commands.every(item => !item.command.startsWith('/'))).toBe(true)
    expect(commands.every(item => item.command.length <= 32)).toBe(true)
    expect(commands.every(item => item.description.length <= 256)).toBe(true)
  })

  test('builds button panels for MCP and runtime controls without exposing secrets', () => {
    const servers = [{
      name: 'searxng',
      enabled: true,
      origin: 'custom' as const,
      managed: true,
      config: {
        command: 'node',
        args: ['scripts/run-npx-mcp.cjs', '-y', 'mcp-searxng'],
        env: {
          SEARXNG_URL: 'http://searxng:8080',
          PRIVATE_API_KEY: 'must-not-be-rendered',
        },
      },
    }]

    const menu = formatTelegramMcpMenu(servers)
    expect(menu).toContain('ON searxng [custom]')
    expect(menu).toContain('env: PRIVATE_API_KEY, SEARXNG_URL')
    expect(menu).not.toContain('must-not-be-rendered')

    const controlActions = buildTelegramControlKeyboard().flat().map(button => button.callback_data)
    expect(controlActions).toContain('menu:providers')
    expect(controlActions).toContain('menu:mcp')
    expect(controlActions).toContain('menu:skills')
    expect(controlActions).toContain('menu:runtime')
    expect(controlActions).toContain('menu:schedule')
    expect(controlActions).toContain('menu:memory')

    const mcpActions = buildTelegramMcpKeyboard(servers).flat().map(button => button.callback_data)
    expect(mcpActions).toContain('mcp:view:searxng')
    expect(mcpActions).toContain('mcp:add')

    const runtimeActions = buildTelegramRuntimeKeyboard({
      toolsEnabled: true,
      cronEnabled: true,
      consciousnessEnabled: false,
      evolutionEnabled: false,
    }).flat().map(button => button.callback_data)
    expect(runtimeActions).toContain('runtime:tools')
    expect(runtimeActions).toContain('runtime:cron')
    expect(runtimeActions).toContain('runtime:evolution')
    expect(runtimeActions).toContain('runtime:wake')
    expect(runtimeActions).toContain('runtime:restart')
  })

  test('builds a paged Skill Store and validates compact or JSON creation', () => {
    const skills = Array.from({ length: 9 }, (_, index) => ({
      id: String(index).padStart(12, '0'),
      name: `skill-${index}`,
      label: `Skill ${index}`,
      description: `Description ${index}`,
      origin: index === 0 ? 'skills' : 'bundled',
      managed: index === 0,
    }))

    const menu = formatTelegramSkillStoreMenu(skills, 0)
    expect(menu).toContain('9 available, 1 Store-created')
    expect(menu).toContain('Page 1/2')
    expect(menu).toContain('CUSTOM skill-0')

    const actions = buildTelegramSkillStoreKeyboard(skills, 0)
      .flat()
      .map(button => button.callback_data)
    expect(actions).toContain('skill:view:000000000000')
    expect(actions).toContain('skills:page:1')
    expect(actions).toContain('skills:create')

    const details = formatTelegramSkillDetails({
      ...skills[0]!,
      instructions: 'Always verify the observed output.',
    })
    expect(details).toContain('Always verify the observed output.')
    expect(
      buildTelegramSkillDetailsKeyboard(skills[0]!)
        .flat()
        .map(button => button.callback_data),
    ).toContain('skill:delete:000000000000')

    expect(parseTelegramSkillCreateInput(
      'verify-output | Use for verification | Run the narrowest check.',
    )).toEqual({
      ok: true,
      input: {
        name: 'verify-output',
        description: 'Use for verification',
        instructions: 'Run the narrowest check.',
      },
    })
    expect(parseTelegramSkillCreateInput(JSON.stringify({
      skill: {
        name: 'research-first',
        description: 'Use for current research.',
        instructions: 'Search primary sources before answering.',
      },
    }))).toMatchObject({ ok: true })
    expect(parseTelegramSkillCreateInput('../bad | Bad | Bad')).toMatchObject({
      ok: false,
    })
  })

  test('selects the highest resolution photo Telegram sends', () => {
    const photo = selectLargestPhoto([
      { file_id: 'small', width: 90, height: 90, file_size: 1_000 },
      { file_id: 'large', width: 1280, height: 720, file_size: 200_000 },
      { file_id: 'medium', width: 640, height: 480, file_size: 100_000 },
    ])

    expect(photo?.file_id).toBe('large')
  })

  test('extracts photo and document attachment candidates', () => {
    const attachments = getAttachmentCandidates({
      message_id: 1,
      photo: [
        { file_id: 'p1', width: 100, height: 100 },
        { file_id: 'p2', width: 200, height: 200 },
      ],
      document: {
        file_id: 'doc1',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
      },
      voice: {
        file_id: 'voice1',
        mime_type: 'audio/ogg',
        duration: 8,
      },
    })

    expect(attachments.map(attachment => attachment.type)).toEqual([
      'photo',
      'document',
      'voice',
    ])
    expect(attachments[0]?.file.file_id).toBe('p2')
    expect(attachments[1]?.file.file_name).toBe('report.pdf')
    expect(attachments[2]?.duration).toBe(8)
  })

  test('builds an agent prompt with attachment paths and Telegram upload protocol', () => {
    const attachments: TelegramAttachment[] = [
      {
        type: 'photo',
        fileId: 'photo-file',
        fileName: 'screen.png',
        localPath: 'C:\\tmp\\screen.png',
        width: 1200,
        height: 800,
      },
    ]

    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 7,
      from: { id: 99, username: 'tester' },
      text: 'Что на скрине?',
      attachments,
    })

    expect(prompt).toContain('Chat ID: 42')
    expect(prompt).toContain('From: @tester')
    expect(prompt).toContain('Что на скрине?')
    expect(prompt).toContain('local_path: C:\\tmp\\screen.png')
    expect(prompt).toContain('prompt_reference: @C:\\tmp\\screen.png')
    expect(prompt).toContain('[TELEGRAM_SEND_FILE path="C:\\path\\to\\file.png"')
    expect(prompt).toContain('[[image:C:\\path\\to\\image.png]]')
  })

  test('injects Telegram conversation transcript before the current message', () => {
    const conversationTranscript = formatTelegramConversationTranscript([
      {
        direction: 'in',
        chatId: '42',
        messageId: 10,
        username: 'tester',
        text: 'Где находиться Одесса?',
      },
      {
        direction: 'out',
        chatId: '42',
        text: 'Одесса находится на юге Украины.',
        exitCode: 0,
      },
    ])
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 11,
      text: 'Что я спросил в прошлом сообщении?',
      attachments: [],
      conversationTranscript,
    })

    expect(prompt).toContain('## Telegram conversation transcript')
    expect(prompt).toContain('User #10 @tester:\nГде находиться Одесса?')
    expect(prompt).toContain('Assistant:\nОдесса находится на юге Украины.')
    expect(prompt).toContain('answer from that transcript')
    expect(prompt).toContain('User message:\nЧто я спросил в прошлом сообщении?')
  })

  test('keeps long Telegram transcript by default instead of a short recent slice', () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      direction: index % 2 === 0 ? 'in' : 'out',
      chatId: '42',
      messageId: index + 1,
      text: `turn ${index + 1}`,
    }))

    const transcript = formatTelegramConversationTranscript(entries)

    expect(transcript).toContain('turn 1')
    expect(transcript).toContain('turn 40')
  })

  test('adds replied-to Telegram message context without replacing the transcript', () => {
    const replyContext = buildTelegramReplyContext({
      message_id: 101,
      text: 'What should I do with this cron result?',
      reply_to_message: {
        message_id: 88,
        text: 'Cronjob Response: weekly check\n-----------\n\nDisk is almost full.',
        from: { id: 1, username: 'openclaude_bot' },
      },
    })

    expect(replyContext).toMatchObject({
      messageId: 88,
      text: 'Cronjob Response: weekly check\n-----------\n\nDisk is almost full.',
    })

    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 101,
      text: 'What should I do with this cron result?',
      attachments: [],
      conversationTranscript: formatTelegramConversationTranscript([
        {
          direction: 'in',
          chatId: '42',
          messageId: 77,
          text: 'normal dialogue still here',
        },
      ]),
      replyContext,
    })

    expect(prompt).toContain('## Telegram conversation transcript')
    expect(prompt).toContain('normal dialogue still here')
    expect(prompt).toContain('## Telegram replied-to message context')
    expect(prompt).toContain('Replied-to message ID: 88')
    expect(prompt).toContain('Replied-to from: @openclaude_bot')
    expect(prompt).toContain('Disk is almost full.')
    expect(prompt).toContain('primary target of the user request')
  })

  test('does not add replied-to context when Telegram message is not a reply', () => {
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 102,
      text: 'continue normal chat',
      attachments: [],
      replyContext: buildTelegramReplyContext({
        message_id: 102,
        text: 'continue normal chat',
      }),
    })

    expect(prompt).not.toContain('## Telegram replied-to message context')
    expect(prompt).toContain('User message:\ncontinue normal chat')
  })

  test('formats replied-to attachment-only messages', () => {
    const replyContext = buildTelegramReplyContext({
      message_id: 102,
      text: 'look at that file',
      reply_to_message: {
        message_id: 55,
        document: {
          file_id: 'doc1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
        },
      },
    })

    expect(formatTelegramReplyContext(replyContext!)).toContain(
      'Replied-to attachments: document:report.pdf',
    )
  })

  test('repairs common UTF-8 text decoded as Windows-1251 mojibake', () => {
    expect(repairLikelyMojibakeText('РџСЂРёРІРµС‚')).toBe('Привет')
    expect(repairLikelyMojibakeText('РўРѕ РµСЃС‚СЊ')).toBe('То есть')
    expect(repairLikelyMojibakeText('Р¦РёС„СЂРѕРІР°СЏ СЃРёРјСѓР»СЏС†РёСЏ')).toBe('Цифровая симуляция')
    expect(repairLikelyMojibakeText('Привет')).toBe('Привет')
  })

  test('instructs Telegram agents to use the memory protocol instead of direct memory file edits', () => {
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 7,
      text: 'remember this',
      attachments: [],
      memoryWriteProtocol: 'Persistent memory tool protocol:',
    })

    expect(prompt).toContain('Persistent memory tool protocol:')
    expect(prompt).toContain('use the [MEMORY ...] protocol')
    expect(prompt).toContain('Do not read, edit, write')
    expect(prompt).toContain('Never say you need direct access to identity.md')
    expect(prompt).toContain('any /agent-gateway/memory/ path')
    expect(prompt).toContain('Never claim a memory write succeeded')
  })

  test('adds mandatory memory instructions for explicit Russian memory requests', () => {
    const text = '\u0417\u0430\u043f\u043e\u043c\u043d\u0438: \u044f \u0442\u0440\u0435\u043d\u0438\u0440\u0443\u044e\u0441\u044c \u043a\u0430\u0436\u0434\u044b\u0439 \u0434\u0435\u043d\u044c'
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 7,
      text,
      attachments: [],
      memoryWriteProtocol: 'Persistent memory tool protocol:',
    })

    expect(hasTelegramMemoryIntent(text)).toBe(true)
    expect(prompt).toContain('Explicit memory intent detected')
    expect(prompt).toContain('A [MEMORY ...] control line is mandatory')
    expect(prompt).toContain('hindsight_retain')
  })

  test('instructs Telegram agents to schedule reminders through the bridge protocol', () => {
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 7,
      text: 'создай ежедневную напоминалку на 22:00',
      attachments: [],
    })

    expect(prompt).toContain('[TELEGRAM_CRON_CREATE')
    expect(prompt).toContain('[TELEGRAM_CRON_UPDATE')
    expect(prompt).toContain('mode="message"')
    expect(prompt).toContain('without running an LLM or tools')
    expect(prompt).toContain('timezone="')
    expect(prompt).toContain('Use the exact minute/hour the user requested')
    expect(prompt).toContain('TELEGRAM_CRON_CREATE is idempotent')
    expect(prompt).toContain('If you are unsure the job exists')
    expect(prompt).toContain('Do not call the built-in CronCreate tool')
    expect(prompt).toContain('Do not read, edit, write')
    expect(prompt).toContain('/agent-gateway/cron-jobs.json')
    expect(prompt).toContain('Never claim a Telegram reminder was created')
  })

  test('extracts Telegram cron create directives and strips them from visible text', () => {
    const parsed = extractTelegramCronDirectives([
      'Готово.',
      '[TELEGRAM_CRON_CREATE name="workout-daily-2200" schedule="0 22 * * *" timezone="Europe/Simferopol" mode="message" prompt="Send a short workout reminder."]',
    ].join('\n'))

    expect(parsed.text).toBe('Готово.')
    expect(parsed.directives).toEqual([
      {
        action: 'create',
        name: 'workout-daily-2200',
        schedule: '0 22 * * *',
        timezone: 'Europe/Simferopol',
        mode: 'message',
        prompt: 'Send a short workout reminder.',
      },
    ])
  })

  test('extracts Telegram cron update directives without requiring a schedule', () => {
    const parsed = extractTelegramCronDirectives([
      '[TELEGRAM_CRON_UPDATE name="workout-daily-2200" mode="message" prompt="22:00 - время ежедневной тренировки. Не пропускай."]',
    ].join('\n'))

    expect(parsed.text).toBe('')
    expect(parsed.directives).toEqual([
      {
        action: 'update',
        name: 'workout-daily-2200',
        mode: 'message',
        prompt: '22:00 - время ежедневной тренировки. Не пропускай.',
      },
    ])
  })

  test('skips missing Telegram cron updates without failing the agent response', async () => {
    await withTempGatewayState(async () => {
      const result = await applyTelegramCronDirectivesForChat(
        '42',
        '[TELEGRAM_CRON_UPDATE name="pharma-mon-0907" mode="message" prompt="09:00 - pharma protocol."]',
      )

      expect(result.text).toBe('')
      expect(result.messages.join('\n')).toContain('Telegram cron update skipped:')
      expect(result.messages.join('\n')).toContain('pharma-mon-0907 was not found')
      expect(result.messages.join('\n')).not.toContain('failed')
      expect(await listCronJobs(true)).toHaveLength(0)
    })
  })

  test('updates existing Telegram cron jobs when the directive uses the job id as its name key', async () => {
    await withTempGatewayState(async stateDir => {
      await writeFile(join(stateDir, 'cron-jobs.json'), `${JSON.stringify({
        jobs: [
          {
            id: 'pharma-mon-0907',
            name: 'pharma reminder monday morning',
            prompt: 'old text',
            schedule: { kind: 'cron', expr: '7 9 * * 1', display: '7 9 * * 1' },
            scheduleDisplay: '7 9 * * 1',
            timezone: 'Europe/Simferopol',
            repeat: { completed: 1 },
            enabled: true,
            state: 'scheduled',
            deliver: 'origin',
            origin: { platform: 'telegram', chatId: '42' },
            createdAt: '2026-07-01T00:00:00.000Z',
            nextRunAt: '2099-01-01T00:00:00.000Z',
            mode: 'message',
          },
        ],
        updatedAt: '2026-07-01T00:00:00.000Z',
      }, null, 2)}\n`, 'utf8')

      const result = await applyTelegramCronDirectivesForChat(
        '42',
        '[TELEGRAM_CRON_UPDATE name="pharma-mon-0907" mode="message" prompt="09:00 - updated pharma protocol."]',
      )

      const jobs = await listCronJobs(true)
      expect(result.messages.join('\n')).toContain('Telegram cron updated:')
      expect(result.messages.join('\n')).not.toContain('not found')
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.id).toBe('pharma-mon-0907')
      expect(jobs[0]?.name).toBe('pharma reminder monday morning')
      expect(jobs[0]?.prompt).toBe('09:00 - updated pharma protocol.')
    })
  })

  test('creates missing Telegram cron updates when the directive includes a full schedule', async () => {
    await withTempGatewayState(async () => {
      const result = await applyTelegramCronDirectivesForChat(
        '42',
        '[TELEGRAM_CRON_UPDATE name="pharma-mon-0907" schedule="2099-01-01T00:00:00.000Z" timezone="Europe/Amsterdam" mode="message" prompt="09:00 - pharma protocol."]',
      )

      const jobs = await listCronJobs(true)
      expect(result.messages.join('\n')).toContain('Telegram cron scheduled:')
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        name: 'pharma-mon-0907',
        scheduleDisplay: 'once at 2099-01-01T00:00:00.000Z',
        timezone: 'Europe/Amsterdam',
        mode: 'message',
        origin: { platform: 'telegram', chatId: '42' },
      })
    })
  })

  test('parses Telegram agent recovery retry limits', () => {
    expect(getTelegramAgentRecoveryAttemptLimit({
      OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_ATTEMPTS: '0',
    } as NodeJS.ProcessEnv).maxRecoveryAttempts).toBe(0)
    expect(getTelegramAgentRecoveryAttemptLimit({
      OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_ATTEMPTS: 'unlimited',
    } as NodeJS.ProcessEnv).maxRecoveryAttempts).toBeNull()
    expect(getTelegramAgentRecoveryAttemptLimit({
      OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_ATTEMPTS: '3',
    } as NodeJS.ProcessEnv).maxRecoveryAttempts).toBe(3)
    expect(getTelegramAgentRecoveryAttemptLimit({} as NodeJS.ProcessEnv).maxRecoveryAttempts).toBe(2)
  })

  test('parses Telegram repeated failure loop-break limits', () => {
    expect(getTelegramAgentRepeatedFailureLimit({
      OPENCLAUDE_TELEGRAM_AGENT_REPEATED_FAILURE_LIMIT: '2',
    } as NodeJS.ProcessEnv)).toBe(2)
    expect(getTelegramAgentRepeatedFailureLimit({} as NodeJS.ProcessEnv)).toBe(3)
    expect(getTelegramAgentFailureKindLimit({
      OPENCLAUDE_TELEGRAM_AGENT_FAILURE_KIND_LIMIT: '4',
    } as NodeJS.ProcessEnv)).toBe(4)
    expect(getTelegramAgentFailureKindLimit({} as NodeJS.ProcessEnv)).toBe(2)
  })

  test('does not blindly retry provider state that the child cannot repair', () => {
    const base = {
      text: '',
      stderr: 'failure',
      exitCode: 1,
      timedOut: false,
    }
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'auth',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'model_not_found',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'content_policy',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'runtime_configuration',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'rate_limit',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'provider_request',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'execution',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'unknown',
    })).toBe(false)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'tool_error',
    })).toBe(true)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'timeout',
    })).toBe(true)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'max_turns',
    })).toBe(true)
  })

  test('builds stable recovery failure signatures for repeated infrastructure errors', () => {
    const first = getAgentRecoveryFailureSignature({
      text: '',
      stderr: '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons',
      exitCode: 1,
      timedOut: false,
      failureKind: 'execution',
      diagnostic: 'The agent process exited unsuccessfully at 2026-07-05T20:01:01Z after 120ms.',
    })
    const second = getAgentRecoveryFailureSignature({
      text: '',
      stderr: '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons',
      exitCode: 1,
      timedOut: false,
      failureKind: 'execution',
      diagnostic: 'The agent process exited unsuccessfully at 2026-07-05T20:02:02Z after 240ms.',
    })

    expect(first).toBe(second)
    expect(first).toContain('root/sudo privileges')
  })

  test('builds a recovery prompt that continues after tool failures', () => {
    const prompt = buildTelegramAgentRecoveryPrompt({
      originalPrompt: 'Original Telegram task body',
      recoveryAttempt: 2,
      maxRecoveryAttempts: null,
      previousResult: {
        text: 'partial answer',
        stderr: 'Edit failed with sensitive file permission error',
        exitCode: 1,
        timedOut: false,
        failureKind: 'tool_error',
        diagnostic: 'A tool/MCP call returned an error.',
        activity: [
          'Read: "/home/node/.openclaude/agent-gateway/cron-jobs.json"',
          'tool result error (Edit): requested permissions to edit a sensitive file',
        ],
      },
    })

    expect(prompt).toContain('Continue the same task')
    expect(prompt).toContain('not as a reason to stop')
    expect(prompt).toContain('Do not repeat the same failing command')
    expect(prompt).toContain('sensitive-file/tool error')
    expect(prompt).toContain('gateway API')
    expect(prompt).toContain('Recovery attempt: 2 / unlimited until Telegram Stop')
    expect(prompt).toContain('Failure kind: tool_error.')
    expect(prompt).toContain('Original Telegram task body')
  })

  test('formats failed agent diagnostics for recovery prompts', () => {
    const diagnostic = formatTelegramAgentFailureForRecovery({
      text: '[MEMORY]\nvisible partial',
      stderr: 'stderr details',
      exitCode: 1,
      timedOut: false,
      failureKind: 'execution',
      diagnostic: 'runner failed',
      activity: ['Bash: "cat missing"', 'tool result error: Exit code 1'],
    })

    expect(diagnostic).toContain('Exit code: 1.')
    expect(diagnostic).toContain('Failure kind: execution.')
    expect(diagnostic).toContain('runner failed')
    expect(diagnostic).toContain('tool result error: Exit code 1')
    expect(diagnostic).toContain('visible partial')
  })

  test('formats Telegram queue notices and positions', () => {
    expect(getTelegramQueuePosition({ active: false, waiting: 0 })).toBe(0)
    expect(getTelegramQueuePosition({ active: true, waiting: 0 })).toBe(1)
    expect(getTelegramQueuePosition({ active: true, waiting: 2 })).toBe(3)
    expect(formatTelegramQueueNotice(2, 'second task')).toContain('Queued #2')
  })

  test('stop clears queued Telegram tasks for the same chat', async () => {
    const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
    const sent: string[] = []
    ;(bridge as any).sendMessage = async (_chatId: string, text: string) => {
      sent.push(text)
    }
    ;(bridge as any).callTelegram = async () => ({ ok: true })

    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      resolveFirstStarted = resolve
    })
    let secondRan = false

    const first = (bridge as any).enqueueChatTask('42', 'first task', async () => {
      const controller = new AbortController()
      ;(bridge as any).activeTasks.set('42', {
        controller,
        messageId: 1,
        progress: { dispose: () => {} },
      })
      resolveFirstStarted()
      await new Promise<void>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      ;(bridge as any).activeTasks.delete('42')
    })
    await firstStarted

    const second = (bridge as any).enqueueChatTask('42', 'second task', async () => {
      secondRan = true
    })
    await (bridge as any).stopTask('42')
    await Promise.all([first, second])

    expect(secondRan).toBe(false)
    expect(sent.join('\n')).toContain('Queued tasks for this chat were cleared')
  })

  test('applies safe Telegram research mode prompts', () => {
    const bio = applyTelegramResearchMode('bio', 'analyze cells')
    expect(bio).toContain('Active Telegram research mode: /bio')
    expect(bio).toContain('biology research assistant')
    expect(bio).toContain('analyze cells')

    const social = applyTelegramResearchMode('social', 'review phishing')
    expect(social).toContain('defensive social-engineering research analyst')
    expect(social).toContain('Do not provide instructions for deception')
  })

  test('extracts Telegram file upload directives and strips them from visible text', () => {
    const parsed = extractTelegramSendDirectives([
      'Готово.',
      '[TELEGRAM_SEND_FILE path="C:\\tmp\\out.png" caption="скрин"]',
      '[TELEGRAM_SEND_FILE path=\'C:\\tmp\\report.pdf\']',
    ].join('\n'))

    expect(parsed.text).toBe('Готово.')
    expect(parsed.directives).toEqual([
      { path: 'C:\\tmp\\out.png', caption: 'скрин' },
      { path: 'C:\\tmp\\report.pdf' },
    ])
  })

  test('extracts aipal-style image and document output tokens', () => {
    const parsed = extractTelegramSendDirectives([
      'Generated files:',
      '[[image:C:\\tmp\\chart.png]]',
      '[[document:C:\\tmp\\report.docx]]',
    ].join('\n'))

    expect(parsed.text).toBe('Generated files:')
    expect(parsed.directives).toEqual([
      { path: 'C:\\tmp\\chart.png', kind: 'image' },
      { path: 'C:\\tmp\\report.docx', kind: 'document' },
    ])
  })

  test('builds stable local names for downloaded voice files', () => {
    expect(
      buildTelegramDownloadFileName(
        {
          type: 'voice',
          file: { file_id: 'voice1', mime_type: 'audio/ogg' },
        },
        {
          file_id: 'voice1',
          file_path: 'voice/file_12',
        },
      ),
    ).toBe('voice-voice1.ogg')
  })

  test('detects transcribable Telegram audio payloads', () => {
    expect(
      getAudioTranscriptionCandidate({
        message_id: 1,
        audio: {
          file_id: 'audio1',
          file_name: 'song.mp3',
          mime_type: 'audio/mpeg',
        },
      }),
    ).toMatchObject({
      type: 'audio',
      file: { file_id: 'audio1' },
    })

    expect(
      getAudioTranscriptionCandidate({
        message_id: 2,
        document: {
          file_id: 'doc-audio',
          file_name: 'memo.ogg',
          mime_type: 'audio/ogg',
        },
      }),
    ).toMatchObject({
      type: 'audio_document',
      file: { file_id: 'doc-audio' },
    })

    expect(
      getAudioTranscriptionCandidate({
        message_id: 3,
        document: {
          file_id: 'doc-pdf',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
        },
      }),
    ).toBeUndefined()
  })

  test('sanitizes Telegram file names for Windows paths', () => {
    expect(safeTelegramFileName('bad:name?.png')).toBe('bad_name_.png')
    expect(safeTelegramFileName('   ')).toBe('telegram-file')
  })

  test('summarizes agent stdout tool activity for Telegram progress', () => {
    const events = summarizeAgentProgressChunk([
      'mcp_mcp_router_PowerShell: "Get-Content C:\\Users\\bablo_sell\\Desktop\\x.ts"',
      'FileSystem: "C:\\tmp\\report.txt"',
      'regular final answer line',
    ].join('\n'))

    expect(events).toContain('mcp_mcp_router_PowerShell: "Get-Content C:\\Users\\bablo_sell\\Desktop\\x.ts"')
    expect(events).toContain('FileSystem: "C:\\tmp\\report.txt"')
    expect(events).not.toContain('regular final answer line')
  })

  test('redacts inline credentials from Telegram progress activity', () => {
    const events = summarizeAgentProgressChunk(
      "Bash: \"sshpass -p 'progress-secret-value' ssh root@example.test\"",
    )

    expect(events.join('\n')).not.toContain('progress-secret-value')
    expect(events.join('\n')).toContain('[REDACTED_PASSWORD]')
  })

  test('formats Telegram progress with repeated activity counts', () => {
    const text = formatTelegramProgressText({
      status: 'running',
      phase: 'Running Telegram request',
      startedAt: Date.now() - 2_000,
      providerProfile: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      events: [
        { label: 'PowerShell: "Get-Content file"', count: 2 },
      ],
    })

    expect(text).toContain('OpenClaude task: running')
    expect(text).toContain('Phase: Running Telegram request')
    expect(text).toContain('Provider: deepseek')
    expect(text).toContain('Model: deepseek-v4-pro')
    expect(text).toContain('PowerShell: "Get-Content file" (x2)')
  })

  test('completed Telegram progress does not claim it is still waiting', () => {
    const text = formatTelegramProgressText({
      status: 'completed',
      phase: 'Done. Sending response.',
      startedAt: Date.now() - 2_000,
      events: [],
    })

    expect(text).toContain('OpenClaude task: completed')
    expect(text).toContain('no streamed model/tool activity captured')
    expect(text).not.toContain('waiting for model/tool output')
  })

  test('hides recovered edit validation errors after a successful run', () => {
    const event = {
      label: 'tool result error (Write): Read the file first',
      count: 1,
    }
    const completed = formatTelegramProgressText({
      status: 'completed',
      phase: 'Done. Sending response.',
      startedAt: Date.now() - 2_000,
      events: [event],
    })
    const failed = formatTelegramProgressText({
      status: 'failed',
      phase: 'Agent run failed.',
      startedAt: Date.now() - 2_000,
      events: [event],
    })

    expect(completed).not.toContain('recovered tool warning (Write)')
    expect(completed).not.toContain('tool result error')
    expect(failed).toContain('tool result error (Write)')
  })

  test('keeps meaningful recovered tool warnings visible after a successful run', () => {
    const completed = formatTelegramProgressText({
      status: 'completed',
      phase: 'Done. Sending response.',
      startedAt: Date.now() - 2_000,
      events: [{ label: 'tool result error (Bash): Exit code 1', count: 1 }],
    })

    expect(completed).toContain('recovered tool warning (Bash): Exit code 1')
  })

  test('switches provider profile without carrying old endpoint into codex', () => {
    const profile = buildTelegramProviderProfileUpdate(
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'deepseek-key',
      },
      {
        provider: 'codex',
        model: 'gpt-5.5',
      },
    )

    expect(profile.provider).toBe('codex')
    expect(profile.model).toBe('gpt-5.5')
    expect(profile.baseUrl).toBe('')
    expect(profile.apiKey).toBe('')
  })

  test('resolves short Telegram provider/model switches', () => {
    expect(getTelegramProviderShortcut('/dsflash')).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(getTelegramProviderShortcut('/dspro@openclaude_bot')).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    expect(getTelegramProviderShortcut('/gpt55')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5?reasoning=medium',
    })
    expect(getTelegramProviderShortcut('/sol')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol?reasoning=medium',
    })
    expect(getTelegramProviderShortcut('/terra')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-terra?reasoning=medium',
    })
    expect(getTelegramProviderShortcut('/gemmacoder')).toMatchObject({
      provider: 'lmstudio-lan',
      model: 'huihui-gemma-4-12b-coder-fable5-composer2.5-v1-abliterated',
    })
    expect(getTelegramProviderShortcut('/unknown')).toBeUndefined()
  })

  test('builds Telegram provider, model, and reasoning button menus', () => {
    const providers = buildTelegramProviderKeyboard('codex').flat()
    expect(providers).toContainEqual({
      text: '* Codex / ChatGPT',
      callback_data: 'provider:codex',
    })

    const models = buildTelegramModelKeyboard(
      'codex',
      Array.from({ length: 10 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
        reasoningLevels: [],
      })),
      'model-0',
      1,
    ).flat()
    expect(models).toContainEqual({ text: 'Model 8', callback_data: 'model:codex:8' })
    expect(models).toContainEqual({ text: '<', callback_data: 'models:codex:0' })

    const reasoning = buildTelegramReasoningKeyboard(
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        defaultReasoning: 'medium',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        provider: 'codex',
        model: 'gpt-5.6-sol?reasoning=xhigh',
        baseUrl: '',
        apiKey: '',
      },
    ).flat()
    expect(reasoning).toContainEqual({
      text: '* Extra high',
      callback_data: 'reason:xhigh',
    })
    expect(reasoning).toContainEqual({ text: 'Ultra', callback_data: 'reason:ultra' })
  })

  test('switches Telegram provider profile to LM Studio LAN defaults', () => {
    const profile = buildTelegramProviderProfileUpdate(
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'deepseek-key',
      },
      {
        provider: 'lmstudio-lan',
        model: 'gemma-4-12b-obliterated',
      },
    )

    expect(profile.provider).toBe('lmstudio-lan')
    expect(profile.model).toBe('gemma-4-12b-obliterated')
    expect(profile.baseUrl).toBe('http://192.168.187.1:1234/v1')
    expect(profile.apiKey).toBe('lm-studio')
  })
})
