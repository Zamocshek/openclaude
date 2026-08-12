import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  applyTelegramCronDirectivesForChat,
  buildTelegramAgentPrompt,
  buildTelegramCronContext,
  buildTelegramAgentRecoveryPrompt,
  buildTelegramBotCommands,
  buildTelegramDownloadFileName,
  buildTelegramHelpText,
  buildTelegramControlKeyboard,
  buildTelegramAndroidKeyboard,
  buildTelegramAudioAgentText,
  buildTelegramMcpKeyboard,
  buildTelegramQwenMmKeyboard,
  buildTelegramModelKeyboard,
  buildTelegramProviderKeyboard,
  buildTelegramProviderProfileUpdate,
  buildTelegramReasoningKeyboard,
  buildTelegramRuntimeKeyboard,
  buildTelegramSkillDetailsKeyboard,
  buildTelegramSkillStoreKeyboard,
  buildTelegramReplyContext,
  buildTelegramSemanticRoutingContext,
  canMergeTelegramTextSplit,
  extractTelegramCronDirectives,
  extractTelegramSendDirectives,
  formatTelegramReplyContext,
  formatTelegramProgressText,
  formatTelegramQueueNotice,
  formatTelegramAndroidMenu,
  formatTelegramMcpMenu,
  formatTelegramQwenMmMenu,
  getTelegramMessageText,
  formatTelegramSkillDetails,
  formatTelegramSkillStoreMenu,
  formatTelegramConversationTranscript,
  formatTelegramAgentFailureForRecovery,
  getAgentRecoveryFailureSignature,
  getAgentRecoveryProgressFingerprints,
  getAudioTranscriptionCandidate,
  getAttachmentCandidates,
  getTelegramAgentFailureKindLimit,
  getTelegramRecoveryBackoffMs,
  getTelegramAgentRepeatedFailureLimit,
  getTelegramAgentRecoveryAttemptLimit,
  getTelegramAuthContinuationTtlMs,
  getTelegramQueueLimits,
  getTelegramRetryDelayMs,
  getTelegramTextSplitCoalesceMs,
  mergeAgentArtifactsWithTelegramDirectives,
  mergeTelegramTextSplit,
  getTelegramQueuePosition,
  getTelegramProviderShortcut,
  isTelegramActorAllowed,
  hasTelegramMemoryIntent,
  isLikelyTelegramTextSplitStart,
  isCronRemovalFeedback,
  applyTelegramResearchMode,
  repairLikelyMojibakeText,
  parseTelegramSkillCreateInput,
  parseTelegramPentestAuthorization,
  parseTelegramErrorLog,
  summarizeAgentProgressChunk,
  safeTelegramFileName,
  selectLargestPhoto,
  shouldRetryTelegramAgentFailure,
  TelegramAgentBridge,
  type TelegramAttachment,
} from './telegram.js'
import { listCronJobs } from './cron.js'
import { getDefaultAgentGatewayConfig } from './config.js'

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

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
    expect(help.length).toBeLessThanOrEqual(4096)
    expect(help).toContain('/provider set <provider> <model> [base_url] [api_key]')
    expect(help).toContain('/panel|control - button control panel')
    expect(help).toContain('/newchat - reset chat context; keep durable memory')
    expect(help).toContain('/mcp add <json> - import mcpServers JSON')
    expect(help).toContain('/qwenmm [on|off|status] - control local Qwen-MM vision')
    expect(help).toContain('/android - manage Android devices')
    expect(help).toContain('/skills - browse the Skill Store')
    expect(help).toContain('/skill create <json> - create a persistent SKILL.md')
    expect(help).toContain(
      '/tools [on|off|list|enable NAME|disable NAME] - toggle model tools',
    )
    expect(help).not.toContain('/harness')
    expect(help).toContain('/bg [start|stop|now|status] - control background consciousness')
    expect(help).toContain('/consciousness [start|stop|now|status] - alias for /bg')
    expect(help).toContain('/evolve [on|off|now|status] - control evolution or run one cycle')
    expect(help).toContain('/dsflash - switch to DeepSeek V4 Flash')
    expect(help).toContain('/gemmacoder - switch to LM Studio Huihui Gemma Coder')
    expect(help).toContain(
      '/omni* - OmniRoute modes: auto,code,fast,cheap,smart,offline',
    )
    expect(help).toContain('/context auto|1m|<tokens> - set context window or auto mode')
    expect(help).toContain('/delegate <role> <task> - delegate a task')
    expect(help).toContain('/bio [prompt] - biology scientist mode for research tasks')
    expect(help).toContain('/pentest [prompt|auth id|targets|proof] - pentest mode')
    expect(help).toContain('/browser - browser AI')
    expect(help).toContain('/qwen - Qwen')
    expect(help).toContain('/mode off - clear the active research mode for this chat')
    expect(help).toContain('/stop - abort the current running task')
    expect(help).toContain('/git commit <msg> - stage and commit all changes')
    expect(help).toContain('Web consoles:')
    expect(help).toContain(
      `Tool Router: http://127.0.0.1:${process.env.OPENCLAUDE_AGENT_API_HOST_PORT || '8642'}/router`,
    )
    expect(help).toContain(
      `Open WebUI: http://localhost:${process.env.OPENCLAUDE_OPEN_WEBUI_HOST_PORT || '8080'}`,
    )
    expect(help).toContain('Hindsight: http://localhost:8888')
    expect(help).toContain('OpenRAG: http://localhost:3000')
    expect(help).toContain('Telegram MCP: http://localhost:19765')
    expect(help).toContain('OmniRoute: http://localhost:20128')
    expect(help).toEndWith('OmniRoute: http://localhost:20128')
    expect(help).toContain(
      `File Manager: http://127.0.0.1:${process.env.OPENCLAUDE_AGENT_API_HOST_PORT || '8642'}/files`,
    )
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
      command: 'newchat',
      description: 'Start a new chat context',
    })
    expect(commands).toContainEqual({
      command: 'mcp',
      description: 'Manage MCP servers',
    })
    expect(commands).toContainEqual({
      command: 'android',
      description: 'Manage Android MCP devices',
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
    expect(commands).toContainEqual({
      command: 'pentest',
      description: 'Authorized pentest mode',
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
    expect(controlActions).toContain('menu:android')
    expect(controlActions).toContain('menu:qwenmm')
    expect(controlActions).toContain('menu:skills')
    expect(controlActions).toContain('menu:runtime')
    expect(controlActions).toContain('menu:schedule')
    expect(controlActions).toContain('menu:memory')
    expect(controlActions).toContain('conversation:new')

    const mcpActions = buildTelegramMcpKeyboard(servers).flat().map(button => button.callback_data)
    expect(mcpActions).toContain('mcp:view:searxng')
    expect(mcpActions).toContain('mcp:add')

    const runtimeActions = buildTelegramRuntimeKeyboard({
      harnessMode: 'ouroboros',
      toolsEnabled: true,
      cronEnabled: true,
      consciousnessEnabled: false,
      evolutionEnabled: false,
    }).flat().map(button => button.callback_data)
    expect(runtimeActions).toContain('runtime:tools')
    expect(runtimeActions).not.toContain('runtime:harness')
    expect(runtimeActions).toContain('runtime:cron')
    expect(runtimeActions).toContain('runtime:evolution')
    expect(runtimeActions).toContain('runtime:wake')
    expect(runtimeActions).toContain('runtime:restart')

    const qwenServers = [
      { ...servers[0]!, name: 'qwen-mm-core', origin: 'base' as const },
      { ...servers[0]!, name: 'qwen-mm-local', origin: 'base' as const },
    ]
    expect(formatTelegramQwenMmMenu(qwenServers)).toContain('State: ON')
    expect(formatTelegramQwenMmMenu(qwenServers)).toContain('Cloud API cost: none')
    expect(buildTelegramQwenMmKeyboard(qwenServers).flat()
      .map(button => button.callback_data)).toContain('qwenmm:off')
  })

  test('builds Android device menus with active and discovered devices', () => {
    const registry = {
      version: 1 as const,
      activeAlias: 'personal',
      profiles: {
        personal: {
          alias: 'personal',
          serial: 'RFCN2013V8D',
          connection: 'usb' as const,
          enabled: true,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        lab: {
          alias: 'lab',
          serial: '192.168.1.8:5555',
          connection: 'wifi' as const,
          enabled: false,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
    }
    const text = formatTelegramAndroidMenu(registry, [{
      serial: 'emulator-5554',
      state: 'device',
      connection: 'emulator',
      details: { model: 'sdk_gphone64_x86_64' },
    }])
    const actions = buildTelegramAndroidKeyboard(registry)
      .flat()
      .map(button => button.callback_data)

    expect(text).toContain('ACTIVE personal')
    expect(text).toContain('OFF lab')
    expect(text).toContain('DEVICE emulator-5554 [emulator]')
    expect(actions).toContain('android:view:personal')
    expect(actions).toContain('android:discover')
  })

  test('builds a paged Skill Store and validates compact or JSON creation', () => {
    const skills = Array.from({ length: 9 }, (_, index) => ({
      id: String(index).padStart(12, '0'),
      name: `skill-${index}`,
      label: `Skill ${index}`,
      description: `Description ${index}`,
      origin: index === 0 ? 'skills' : 'bundled',
      managed: index === 0,
      enabled: true,
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
    expect(prompt).not.toContain('prompt_reference: @C:\\tmp\\screen.png')
    expect(prompt).toContain('gateway will inspect each local image with Qwen-MM')
    expect(prompt).toContain('[TELEGRAM_SEND_FILE path="C:\\path\\to\\file.png"')
    expect(prompt).toContain('[[image:C:\\path\\to\\image.png]]')
  })

  test('keeps a Telegram photo caption paired with local Qwen-MM image evidence', () => {
    const message = {
      message_id: 17,
      caption: 'Прочитай текст на картинке и объясни, что важно.',
      photo: [{ file_id: 'photo-large', width: 1920, height: 1080 }],
    }
    const caption = getTelegramMessageText(message)
    const candidate = getAttachmentCandidates(message)[0]!
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: message.message_id,
      text: caption,
      attachments: [{
        type: candidate.type,
        fileId: candidate.file.file_id,
        fileName: candidate.file.file_name,
        localPath: '/workspace/telegram-files/42/17/photo-large.jpg',
        width: candidate.width,
        height: candidate.height,
      }],
    })

    expect(caption).toBe('Прочитай текст на картинке и объясни, что важно.')
    expect(prompt).toContain('User message:\nПрочитай текст на картинке и объясни, что важно.')
    expect(prompt).toContain('local_path: /workspace/telegram-files/42/17/photo-large.jpg')
    expect(prompt).toContain('gateway will inspect each local image with Qwen-MM')
  })

  test('describes a video and a regular file as actionable local attachments', () => {
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 18,
      text: 'Проверь вложения.',
      attachments: [
        {
          type: 'video',
          fileId: 'clip',
          fileName: 'clip.webm',
          mimeType: 'video/webm',
          localPath: '/workspace/telegram-files/42/18/clip.webm',
        },
        {
          type: 'document',
          fileId: 'report',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          localPath: '/workspace/telegram-files/42/18/report.pdf',
        },
      ],
    })

    expect(prompt).toContain('Qwen-MM core read_video/frame tools')
    expect(prompt).toContain('Other attached files are available at their local_path values.')
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

  test('preserves full logged text and reply relationships in the transcript', () => {
    const longTail = 'z'.repeat(4_000)
    const transcript = formatTelegramConversationTranscript([{
      direction: 'in',
      chatId: '42',
      messageId: 9,
      text: `question ${longTail}`,
      replyToMessageId: 7,
      replyToText: 'the exact earlier message',
      replyToAttachmentSummary: 'document: plan.md',
    }])

    expect(transcript).toContain(longTail)
    expect(transcript).toContain('Reply target #7')
    expect(transcript).toContain('the exact earlier message')
    expect(transcript).toContain('document: plan.md')
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

  test('builds compact semantic routing context for short dialogue continuations', () => {
    const context = buildTelegramSemanticRoutingContext(
      formatTelegramConversationTranscript([{
        direction: 'out',
        chatId: '42',
        text: 'The Telegram login code was sent. Send the confirmation code.',
      }]),
      {
        messageId: 88,
        text: 'The Telegram login code was sent. Send the confirmation code.',
      },
    )

    expect(context).toContain('Telegram replied-to message context')
    expect(context).toContain('Telegram conversation transcript')
    expect(context.length).toBeLessThanOrEqual(6_000)
  })

  test('injects a pending tool interaction as semantic context, not user text', () => {
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 101,
      text: 'beta',
      attachments: [],
      interactionContext: [
        'Pending tool interaction:',
        '- handler: future.choose-target',
        '- expected input: choice',
      ].join('\n'),
    })

    expect(prompt).toContain('## Active tool interaction')
    expect(prompt).toContain('future.choose-target')
    expect(prompt).toContain('semantically answers the pending prompt')
    expect(prompt).toContain('User message:\nbeta')
  })

  test('bounds Telegram authorization continuation lifetime', () => {
    expect(getTelegramAuthContinuationTtlMs({
      OPENCLAUDE_TELEGRAM_AUTH_CONTINUATION_TTL_MS: '1000',
    })).toBe(60_000)
    expect(getTelegramAuthContinuationTtlMs({
      OPENCLAUDE_TELEGRAM_AUTH_CONTINUATION_TTL_MS: '99999999',
    })).toBe(30 * 60_000)
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

  test('keeps valid Telegram errors when one line is corrupt and redacts old secrets', () => {
    const telegramToken = `1234567890:AA${'a'.repeat(24)}`
    const raw = [
      JSON.stringify({
        ts: '2026-07-31T00:00:00.000Z',
        chatId: '42',
        source: 'agent-run',
        message: "sshpass -p 'old-password' ssh root@example.test",
        activity: [`curl https://api.telegram.org/bot${telegramToken}/sendMessage`],
      }),
      '{"interrupted":',
      JSON.stringify({
        ts: '2026-07-31T00:01:00.000Z',
        chatId: 'other',
        source: 'agent-run',
        message: 'not for this chat',
      }),
    ].join('\n')

    const entries = parseTelegramErrorLog(raw, '42', 10)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toContain('[REDACTED_PASSWORD]')
    expect(entries[0]?.message).not.toContain('old-password')
    expect(entries[0]?.activity?.[0]).toContain('[REDACTED_TELEGRAM_TOKEN]')
    expect(entries[0]?.activity?.[0]).not.toContain(telegramToken)
    expect(parseTelegramErrorLog(raw, '42', 0)).toEqual([])
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
    expect(prompt).toContain('[TELEGRAM_CRON_DELETE')
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

  test('forbids inferred personal history from being written as fact', () => {
    const prompt = buildTelegramAgentPrompt({
      chatId: '42',
      messageId: 7,
      text: 'Update the RPG system.',
      attachments: [],
    })

    expect(prompt).toContain('## Personal record integrity')
    expect(prompt).toContain('Personal history is factual data, not a place for inference')
    expect(prompt).toContain('ask a concise clarifying question instead')
    expect(prompt).toContain('user request to correct or delete a record is authoritative')
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

  test('extracts Telegram cron delete directives with only a job name', () => {
    const parsed = extractTelegramCronDirectives([
      'Удаляю задачу.',
      '[TELEGRAM_CRON_DELETE name="programming-nova-2037"]',
    ].join('\n'))

    expect(parsed.text).toBe('Удаляю задачу.')
    expect(parsed.directives).toEqual([{
      action: 'delete',
      name: 'programming-nova-2037',
    }])
  })

  test('recognizes explicit cron removal feedback without matching negation', () => {
    expect(isCronRemovalFeedback('сделано убирай')).toBe(true)
    expect(isCronRemovalFeedback('удали эту задачу')).toBe(true)
    expect(isCronRemovalFeedback('не удаляй эту задачу')).toBe(false)
    expect(isCronRemovalFeedback('сделано')).toBe(false)
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

  test('deletes an existing Telegram cron job through the bridge directive', async () => {
    await withTempGatewayState(async stateDir => {
      await writeFile(join(stateDir, 'cron-jobs.json'), `${JSON.stringify({
        jobs: [{
          id: 'programming-nova-2037',
          name: 'programming-nova-2037',
          prompt: 'NOVA development.',
          schedule: { kind: 'cron', expr: '37 20 * * *', display: '37 20 * * *' },
          scheduleDisplay: '37 20 * * *',
          timezone: 'Europe/Amsterdam',
          repeat: { completed: 10 },
          enabled: true,
          state: 'scheduled',
          deliver: 'origin',
          origin: { platform: 'telegram', chatId: '42' },
          createdAt: '2026-07-01T00:00:00.000Z',
          nextRunAt: '2099-01-01T00:00:00.000Z',
          mode: 'message',
        }],
        updatedAt: '2026-07-01T00:00:00.000Z',
      }, null, 2)}\n`, 'utf8')

      const result = await applyTelegramCronDirectivesForChat(
        '42',
        '[TELEGRAM_CRON_DELETE name="programming-nova-2037"]',
      )

      expect(result.messages.join('\n')).toContain('Telegram cron deleted:')
      expect(result.messages.join('\n')).toContain('programming-nova-2037')
      expect(await listCronJobs(true)).toHaveLength(0)
    })
  })

  test('includes Telegram cron jobs beyond the former twenty-job cutoff', async () => {
    await withTempGatewayState(async stateDir => {
      const jobs = Array.from({ length: 25 }, (_, index) => ({
        id: `job-${index}`,
        name: `job-${index}`,
        prompt: `Reminder ${index}`,
        schedule: { kind: 'cron', expr: '0 12 * * *', display: '0 12 * * *' },
        scheduleDisplay: '0 12 * * *',
        timezone: 'Europe/Amsterdam',
        repeat: { completed: 0 },
        enabled: true,
        state: 'scheduled',
        deliver: 'origin',
        origin: { platform: 'telegram', chatId: '42' },
        createdAt: '2026-07-01T00:00:00.000Z',
        nextRunAt: '2099-01-01T00:00:00.000Z',
        mode: 'message',
      }))
      await writeFile(join(stateDir, 'cron-jobs.json'), `${JSON.stringify({
        jobs,
        updatedAt: '2026-07-01T00:00:00.000Z',
      }, null, 2)}\n`, 'utf8')

      const context = await buildTelegramCronContext('42')

      expect(context).toContain('name: job-0')
      expect(context).toContain('name: job-24')
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
      failureKind: 'loop_detected',
    })).toBe(true)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'timeout',
    })).toBe(true)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'max_turns',
    })).toBe(true)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'transient_network',
    })).toBe(true)
    expect(shouldRetryTelegramAgentFailure({
      ...base,
      failureKind: 'quality_gate',
    })).toBe(false)
  })

  test('uses bounded exponential backoff for transient network recovery', () => {
    const result = {
      text: '',
      stderr: 'API Error: fetch failed',
      exitCode: 1,
      timedOut: false,
      failureKind: 'transient_network' as const,
    }
    const env = {
      OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MS: '250',
      OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MAX_MS: '1000',
    } as NodeJS.ProcessEnv

    expect(getTelegramRecoveryBackoffMs(result, 1, env)).toBe(250)
    expect(getTelegramRecoveryBackoffMs(result, 3, env)).toBe(1000)
    expect(getTelegramRecoveryBackoffMs({
      ...result,
      failureKind: 'tool_error',
    }, 1, env)).toBe(0)
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
        artifacts: [{
          path: '/workspace/output/voice.mp3',
          kind: 'audio',
          source: 'Bash',
        }],
      },
    })

    expect(prompt).toContain('Continue the same task')
    expect(prompt).toContain('not as a reason to stop')
    expect(prompt).toContain('Do not repeat the same failing command')
    expect(prompt).toContain('sensitive-file/tool error')
    expect(prompt).toContain('gateway API')
    expect(prompt).toContain('Reuse every verified artifact')
    expect(prompt).toContain('audio: /workspace/output/voice.mp3')
    expect(prompt).toContain('Recovery attempt: 2 / unlimited until Telegram Stop')
    expect(prompt).toContain('Failure kind: tool_error.')
    expect(prompt).toContain('Original Telegram task body')
  })

  test('requests one independent reviewer after the live loop watchdog fires', () => {
    const prompt = buildTelegramAgentRecoveryPrompt({
      originalPrompt: 'Complete the original task.',
      recoveryAttempt: 1,
      maxRecoveryAttempts: 2,
      previousResult: {
        text: '',
        stderr: 'Agent loop watchdog detected repeated calls.',
        exitCode: 1,
        timedOut: false,
        failureKind: 'loop_detected',
        diagnostic: 'The live watchdog stopped a repeated tool route.',
      },
    })

    expect(prompt).toContain('exactly one independent review subagent')
    expect(prompt).toContain('materially different route')
    expect(prompt).toContain('reuse completed state')

    const laterPrompt = buildTelegramAgentRecoveryPrompt({
      originalPrompt: 'Complete the original task.',
      recoveryAttempt: 2,
      maxRecoveryAttempts: 2,
      requestLoopReviewer: false,
      previousResult: {
        text: '',
        stderr: 'Agent loop watchdog detected repeated calls again.',
        exitCode: 1,
        timedOut: false,
        failureKind: 'loop_detected',
      },
    })
    expect(laterPrompt).not.toContain('independent review subagent')
  })

  test('tracks only durable new progress across recovery attempts', () => {
    const mutationTargets = new Set<string>()
    const progress = getAgentRecoveryProgressFingerprints({
      text: '',
      stderr: 'later provider failure',
      exitCode: 1,
      timedOut: false,
      evidence: [
        {
          kind: 'mutation',
          scope: 'workspace',
          target: 'file:/workspace/app.ts',
          sequence: 0,
          success: true,
          source: 'Edit',
          fingerprint: 'edit-v2',
        },
        {
          kind: 'verification',
          scope: 'workspace',
          target: 'file:/workspace/app.ts',
          sequence: 1,
          success: true,
          source: 'Read',
          fingerprint: 'read-v2',
        },
        {
          kind: 'verification',
          scope: 'workspace',
          target: 'file:/workspace/unrelated.md',
          sequence: 2,
          success: true,
          source: 'Read',
          fingerprint: 'unrelated-read',
        },
      ],
      artifacts: [{
        path: '/workspace/output/voice.wav',
        kind: 'audio',
        source: 'Bash',
      }],
    }, mutationTargets)

    expect(progress).toEqual([
      'mutation:edit-v2',
      'verification:read-v2',
      'artifact:audio:/workspace/output/voice.wav',
    ])
    expect(mutationTargets).toContain('file:/workspace/app.ts')
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

  test('reassembles Telegram text split at the 4096 character boundary', async () => {
    const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
    const handled: any[] = []
    ;(bridge as any).handleUpdate = async (update: unknown) => {
      handled.push(update)
    }
    const first = {
      message_id: 10,
      date: 100,
      chat: { id: 42 },
      from: { id: 7 },
      text: 'A'.repeat(4_095),
    }
    const second = {
      message_id: 11,
      date: 101,
      chat: { id: 42 },
      from: { id: 7 },
      text: 'continued',
    }

    expect(isLikelyTelegramTextSplitStart(first)).toBe(true)
    expect(canMergeTelegramTextSplit(first, second)).toBe(true)
    expect(mergeTelegramTextSplit(first, second).text).toBe(
      `${first.text}${second.text}`,
    )

    ;(bridge as any).handleMessageUpdateInBackground({ update_id: 20, message: first })
    ;(bridge as any).handleMessageUpdateInBackground({ update_id: 21, message: second })
    await waitFor(() => handled.length === 1)

    expect(handled[0].message.message_id).toBe(10)
    expect(handled[0].message.text).toBe(`${first.text}${second.text}`)
  })

  test('keeps ordinary consecutive Telegram messages as separate queued turns', async () => {
    const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
    const handled: any[] = []
    ;(bridge as any).handleUpdate = async (update: unknown) => {
      handled.push(update)
    }

    ;(bridge as any).handleMessageUpdateInBackground({
      update_id: 30,
      message: { message_id: 20, date: 100, chat: { id: 42 }, from: { id: 7 }, text: 'first' },
    })
    ;(bridge as any).handleMessageUpdateInBackground({
      update_id: 31,
      message: { message_id: 21, date: 101, chat: { id: 42 }, from: { id: 7 }, text: 'second' },
    })
    await waitFor(() => handled.length === 2)

    expect(handled.map(update => update.message.text)).toEqual(['first', 'second'])
  })

  test('bounds the long-message coalescing delay', () => {
    expect(getTelegramTextSplitCoalesceMs({})).toBe(750)
    expect(getTelegramTextSplitCoalesceMs({
      OPENCLAUDE_TELEGRAM_TEXT_SPLIT_COALESCE_MS: '20',
    })).toBe(100)
    expect(getTelegramTextSplitCoalesceMs({
      OPENCLAUDE_TELEGRAM_TEXT_SPLIT_COALESCE_MS: '10000',
    })).toBe(3_000)
  })

  test('uses bounded exponential Telegram request backoff', () => {
    expect(getTelegramRetryDelayMs(1)).toBe(500)
    expect(getTelegramRetryDelayMs(3)).toBe(2_000)
    expect(getTelegramRetryDelayMs(1, 4)).toBe(4_000)
    expect(getTelegramRetryDelayMs(1, 120)).toBe(60_000)
  })

  test('bounds Telegram queue backpressure settings', () => {
    expect(getTelegramQueueLimits({
      OPENCLAUDE_TELEGRAM_MAX_QUEUED_PER_CHAT: '75',
      OPENCLAUDE_TELEGRAM_MAX_QUEUED_TOTAL: '900',
    })).toEqual({ perChat: 75, global: 900 })
    expect(getTelegramQueueLimits({
      OPENCLAUDE_TELEGRAM_MAX_QUEUED_PER_CHAT: '0',
      OPENCLAUDE_TELEGRAM_MAX_QUEUED_TOTAL: '999999',
    })).toEqual({ perChat: 1, global: 10_000 })
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
        taskId: 'a'.repeat(32),
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

  test('registers FIFO order before slow queue notices resolve', async () => {
    const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let releaseSecondNotice!: () => void
    const secondNotice = new Promise<void>(resolve => {
      releaseSecondNotice = resolve
    })
    const order: string[] = []
    ;(bridge as any).sendMessage = async (_chatId: string, text: string) => {
      if (text.includes('Queued #1') && text.includes('second')) {
        await secondNotice
      }
    }

    const first = (bridge as any).enqueueChatTask('42', 'first', async () => {
      const controller = new AbortController()
      ;(bridge as any).activeTasks.set('42', {
        taskId: '1'.repeat(32),
        controller,
        messageId: 1,
      })
      order.push('first')
      await firstGate
      ;(bridge as any).activeTasks.delete('42')
    })
    await waitFor(() => order.length === 1)
    const second = (bridge as any).enqueueChatTask('42', 'second', async () => {
      order.push('second')
    })
    const third = (bridge as any).enqueueChatTask('42', 'third', async () => {
      order.push('third')
    })

    releaseFirst()
    releaseSecondNotice()
    await Promise.all([first, second, third])
    expect(order).toEqual(['first', 'second', 'third'])
  })

  test('does not let an old Stop button abort the current task', async () => {
    const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
    const controller = new AbortController()
    const sent: string[] = []
    ;(bridge as any).sendMessage = async (_chatId: string, text: string) => {
      sent.push(text)
    }
    ;(bridge as any).activeTasks.set('42', {
      taskId: 'b'.repeat(32),
      controller,
      messageId: 2,
    })

    await (bridge as any).stopTask('42', 'a'.repeat(32))

    expect(controller.signal.aborted).toBe(false)
    expect(sent.join('\n')).toContain('current task was not stopped')
  })

  test('removes the Stop keyboard when progress reaches a terminal state', async () => {
    const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    ;(bridge as any).callTelegram = async (
      method: string,
      payload: Record<string, unknown>,
    ) => {
      calls.push({ method, payload })
      return method === 'sendMessage' ? { message_id: 9 } : {}
    }

    const progress = await (bridge as any).createTaskProgress(
      '42',
      'testing',
      'a'.repeat(32),
    )
    await progress.finish('completed', 'done')
    const edit = calls.findLast(call => call.method === 'editMessageText')
    expect(edit?.payload.reply_markup).toEqual({ inline_keyboard: [] })
  })

  test('retries a transient Telegram API request within a bounded attempt count', async () => {
    const config = getDefaultAgentGatewayConfig()
    config.telegram.botToken = 'test-token'
    const bridge = new TelegramAgentBridge(config)
    const originalFetch = globalThis.fetch
    const previousAttempts = process.env.OPENCLAUDE_TELEGRAM_HTTP_ATTEMPTS
    let attempts = 0
    process.env.OPENCLAUDE_TELEGRAM_HTTP_ATTEMPTS = '2'
    globalThis.fetch = (async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    try {
      await (bridge as any).callTelegram('sendMessage', {
        chat_id: '42',
        text: 'hello',
      })
      expect(attempts).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      if (previousAttempts === undefined) {
        delete process.env.OPENCLAUDE_TELEGRAM_HTTP_ATTEMPTS
      } else {
        process.env.OPENCLAUDE_TELEGRAM_HTTP_ATTEMPTS = previousAttempts
      }
    }
  })

  test('new chat creates a persistent transcript boundary without touching durable memory', async () => {
    await withTempGatewayState(async stateDir => {
      const bridge = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
      const sent: string[] = []
      ;(bridge as any).sendMessage = async (_chatId: string, text: string) => {
        sent.push(text)
      }

      await (bridge as any).handleNewChatCommand('42')

      const sessionId = await (bridge as any).getChatSessionId('42')
      expect(sessionId).toBeTruthy()
      const persisted = JSON.parse(await readFile(
        join(stateDir, 'telegram-conversation-sessions.json'),
        'utf8',
      ))
      expect(persisted['42']).toBe(sessionId)
      expect(sent.join('\n')).toContain('durable memory, files, cron jobs')
    })
  })

  test('persists Telegram research mode across gateway instances', async () => {
    await withTempGatewayState(async stateDir => {
      const first = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
      await (first as any).setChatMode('42', 'pentest')

      const second = new TelegramAgentBridge(getDefaultAgentGatewayConfig())
      expect(await (second as any).getChatMode('42')).toBe('pentest')

      const persisted = JSON.parse(await readFile(
        join(stateDir, 'telegram-research-modes.json'),
        'utf8',
      ))
      expect(persisted).toEqual({ 42: 'pentest' })

      await (second as any).setChatMode('42', undefined)
      const cleared = JSON.parse(await readFile(
        join(stateDir, 'telegram-research-modes.json'),
        'utf8',
      ))
      expect(cleared).toEqual({})
    })
  })

  test('parses trusted Telegram pentest authorization without model inference', () => {
    expect(parseTelegramPentestAuthorization(
      'auth lab-1 | 10.10.10.0/24, app.lab.example | I own this isolated lab | 10.10.10.250 | passive_recon, active_scan',
    )).toMatchObject({
      engagement_id: 'lab-1',
      authorized: true,
      targets: ['10.10.10.0/24', 'app.lab.example'],
      exclusions: ['10.10.10.250'],
      allowed_actions: ['passive_recon', 'active_scan'],
      mode: 'guided',
    })
    expect(() => parseTelegramPentestAuthorization(
      'auth BAD ID | 10.10.10.5 | I own this lab',
    )).toThrow('engagement-id')
  })

  test('applies safe Telegram research mode prompts', () => {
    const bio = applyTelegramResearchMode('bio', 'analyze cells')
    expect(bio).toContain('Active Telegram research mode: /bio')
    expect(bio).toContain('biology research assistant')
    expect(bio).toContain('analyze cells')

    const social = applyTelegramResearchMode('social', 'review phishing')
    expect(social).toContain('defensive social-engineering research analyst')
    expect(social).toContain('Do not provide instructions for deception')

    const pentest = applyTelegramResearchMode('pentest', 'assess my lab')
    expect(pentest).toContain('Active Telegram research mode: /pentest')
    expect(pentest).toContain('Invoke the pentest Skill')
    expect(pentest).toContain('pentest_scope_check')
    expect(pentest).toContain('pentest_nmap_run')
    expect(pentest).toContain('Never bypass scope')

    const qwen = applyTelegramResearchMode('qwen', 'review architecture')
    expect(qwen).toContain('Active Telegram research mode: /qwen')
    expect(qwen).toContain('Invoke the qwen-collab Skill')
    expect(qwen).toContain('Qwen3.8-Max-Preview')
    const browser = applyTelegramResearchMode(
      'browser',
      'Use Claude Opus to review architecture',
    )
    expect(browser).toContain(
      'Active Telegram research mode: /browser',
    )
    expect(browser).toContain('persistent Camofox profile tools')
    expect(browser).toContain('leave the session open')
    expect(qwen).toContain('review architecture')
  })

  test('extracts Telegram file upload directives and strips them from visible text', () => {
    const parsed = extractTelegramSendDirectives([
      'Готово.',
      '[TELEGRAM_SEND_FILE path="C:\\tmp\\out.png" caption="скрин"]',
      '[TELEGRAM_SEND_FILE path=\'C:\\tmp\\report.pdf\']',
      '[TELEGRAM_SEND_FILE path="C:\\tmp\\voice.mp3" kind="audio"]',
    ].join('\n'))

    expect(parsed.text).toBe('Готово.')
    expect(parsed.directives).toEqual([
      { path: 'C:\\tmp\\out.png', caption: 'скрин' },
      { path: 'C:\\tmp\\report.pdf' },
      { path: 'C:\\tmp\\voice.mp3', kind: 'audio' },
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

  test('adds runner artifacts once even when the model emitted a duplicate directive', () => {
    expect(mergeAgentArtifactsWithTelegramDirectives(
      [{ path: '/workspace/output/browser.png', kind: 'image' }],
      [
        {
          path: '/workspace/output/browser.png',
          kind: 'image',
          source: 'mcp__camofox__camofox_screenshot',
        },
        {
          path: '/workspace/output/second.png',
          kind: 'image',
          source: 'mcp__camofox__camofox_screenshot',
        },
        {
          path: '/workspace/output/voice.mp3',
          kind: 'audio',
          source: 'Bash',
          caption: 'Russian voice sample',
        },
      ],
    )).toEqual([
      { path: '/workspace/output/browser.png', kind: 'image' },
      {
        path: '/workspace/output/second.png',
        kind: 'image',
        caption: 'Camofox browser result',
      },
      {
        path: '/workspace/output/voice.mp3',
        kind: 'audio',
        caption: 'Russian voice sample',
      },
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

  test('uses a voice transcript as the command when STT succeeds', () => {
    expect(buildTelegramAudioAgentText({
      caption: 'Use this command',
      type: 'voice',
      transcript: 'inspect the repository',
      localPath: '/workspace/voice.ogg',
    })).toBe([
      'Use this command',
      'Transcribed voice message:',
      'inspect the repository',
    ].join('\n'))
  })

  test('keeps the audio file actionable when transcription is unavailable', () => {
    const prompt = buildTelegramAudioAgentText({
      type: 'audio',
      localPath: '/workspace/audio.mp3',
      transcriptionError: 'local adapter unavailable',
    })
    expect(prompt).toContain('/workspace/audio.mp3')
    expect(prompt).toContain('Inspect or process the attached local_path')
    expect(prompt).toContain('Non-fatal transcription detail')
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

  test('formats a blocked task as waiting for access instead of failed', () => {
    const text = formatTelegramProgressText({
      status: 'blocked',
      phase: 'Waiting for required input or access.',
      startedAt: Date.now() - 2_000,
      events: [],
    })

    expect(text).toContain('OpenClaude task: blocked')
    expect(text).toContain('Waiting for required input or access.')
    expect(text).not.toContain('Agent run failed')
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
    expect(getTelegramProviderShortcut('/zenflash')).toMatchObject({
      provider: 'opencode-zen',
      model: 'deepseek-v4-flash-free',
    })
    expect(getTelegramProviderShortcut('/gpt55')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5?reasoning=xhigh',
    })
    expect(getTelegramProviderShortcut('/sol')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol?reasoning=ultra',
    })
    expect(getTelegramProviderShortcut('/terra')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-terra?reasoning=ultra',
    })
    expect(getTelegramProviderShortcut('/gemmacoder')).toMatchObject({
      provider: 'lmstudio-lan',
      model: 'huihui-gemma-4-12b-coder-fable5-composer2.5-v1-abliterated',
    })
    expect(getTelegramProviderShortcut('/omni')).toMatchObject({
      provider: 'omniroute',
      model: 'auto',
    })
    expect(getTelegramProviderShortcut('/omnicode@openclaude_bot')).toMatchObject({
      provider: 'omniroute',
      model: 'auto/coding',
    })
    expect(getTelegramProviderShortcut('/omnifast')).toMatchObject({
      provider: 'omniroute',
      model: 'auto/fast',
    })
    expect(getTelegramProviderShortcut('/unknown')).toBeUndefined()
  })

  test('builds Telegram provider, model, and reasoning button menus', () => {
    const providers = buildTelegramProviderKeyboard('codex').flat()
    expect(providers).toContainEqual({
      text: '* Codex / ChatGPT',
      callback_data: 'provider:codex',
    })
    expect(providers).toContainEqual({
      text: 'OmniRoute',
      callback_data: 'provider:omniroute',
    })
    expect(providers).toContainEqual({
      text: 'OpenCode Zen',
      callback_data: 'provider:opencode-zen',
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

  test('switches Telegram provider profile to OpenCode Zen defaults', () => {
    const profile = buildTelegramProviderProfileUpdate(
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'deepseek-key',
      },
      {
        provider: 'opencode-zen',
        model: 'deepseek-v4-flash-free',
      },
    )

    expect(profile.provider).toBe('opencode-zen')
    expect(profile.model).toBe('deepseek-v4-flash-free')
    expect(profile.baseUrl).toBe('https://opencode.ai/zen/v1')
    expect(profile.apiKey).toBe('')
  })

  test('switches Telegram provider profile without persisting a placeholder OmniRoute key', () => {
    const profile = buildTelegramProviderProfileUpdate(
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'deepseek-key',
      },
      {
        provider: 'omniroute',
        model: 'auto/coding',
      },
    )

    expect(profile.provider).toBe('omniroute')
    expect(profile.model).toBe('auto/coding')
    expect(profile.baseUrl).toBe('http://omniroute:20128/v1')
    expect(profile.apiKey).toBe('')
  })
})
