import { describe, expect, test } from 'bun:test'
import {
  buildTelegramAgentPrompt,
  buildTelegramBotCommands,
  buildTelegramDownloadFileName,
  buildTelegramHelpText,
  buildTelegramProviderProfileUpdate,
  extractTelegramSendDirectives,
  formatTelegramProgressText,
  getAudioTranscriptionCandidate,
  getAttachmentCandidates,
  summarizeAgentProgressChunk,
  safeTelegramFileName,
  selectLargestPhoto,
  type TelegramAttachment,
} from './telegram.js'

describe('agent gateway Telegram bridge helpers', () => {
  test('builds Telegram help text and bot command menu from one command list', () => {
    const help = buildTelegramHelpText()
    const commands = buildTelegramBotCommands()

    expect(help).toContain('OpenClaude Telegram inference is online.')
    expect(help).toContain('/provider set <provider> <model> [base_url] [api_key]')
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
    expect(commands.every(item => !item.command.startsWith('/'))).toBe(true)
    expect(commands.every(item => item.command.length <= 32)).toBe(true)
    expect(commands.every(item => item.description.length <= 256)).toBe(true)
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
