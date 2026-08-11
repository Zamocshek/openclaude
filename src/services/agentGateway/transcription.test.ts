import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  detectTranscriptionTool,
  transcribeAudio,
} from './transcription.js'

describe('portable local transcription', () => {
  let root = ''
  let previousStateDir: string | undefined
  let previousCommand: string | undefined
  let previousCommandArgs: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openclaude-transcription-'))
    previousStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    previousCommand = process.env.OPENCLAUDE_TRANSCRIBE_COMMAND
    previousCommandArgs = process.env.OPENCLAUDE_TRANSCRIBE_COMMAND_ARGS
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = join(root, 'state')
  })

  afterEach(async () => {
    restoreEnv('OPENCLAUDE_AGENT_GATEWAY_STATE_DIR', previousStateDir)
    restoreEnv('OPENCLAUDE_TRANSCRIBE_COMMAND', previousCommand)
    restoreEnv('OPENCLAUDE_TRANSCRIBE_COMMAND_ARGS', previousCommandArgs)
    await rm(root, { recursive: true, force: true })
  })

  test('prefers the portable adapter in auto mode', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const detected = await detectTranscriptionTool(
      'auto',
      async (command, args = []) => {
        calls.push({ command, args })
        return command === 'openclaude-transcribe'
      },
    )

    expect(detected).toBe('local')
    expect(calls[0]).toEqual({
      command: 'openclaude-transcribe',
      args: ['--health'],
    })
  })

  test('uses an agent-neutral executable contract and reads UTF-8 output', async () => {
    const script = join(root, 'fake-transcriber.mjs')
    const audio = join(root, 'voice.ogg')
    await mkdir(root, { recursive: true })
    await writeFile(audio, 'not-real-audio', 'utf8')
    await writeFile(script, [
      "import { writeFileSync } from 'node:fs'",
      "const args = process.argv.slice(2)",
      "if (args.includes('--health')) process.exit(0)",
      "const output = args[args.indexOf('--output') + 1]",
      "writeFileSync(output, '[00:00.000 --> 00:01.000] portable transcript', 'utf8')",
    ].join('\n'), 'utf8')
    process.env.OPENCLAUDE_TRANSCRIBE_COMMAND = process.execPath
    process.env.OPENCLAUDE_TRANSCRIBE_COMMAND_ARGS = JSON.stringify([script])

    const result = await transcribeAudio(audio, {
      provider: 'local',
      whisperModel: 'base',
      timeoutMs: 10_000,
    })

    expect(result.provider).toBe('local')
    expect(result.text).toBe('portable transcript')
    expect(result.outputPath).toEndWith('.local.txt')
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
