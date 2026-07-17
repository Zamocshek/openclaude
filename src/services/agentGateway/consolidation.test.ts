import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDefaultAgentGatewayConfig } from './config.js'

const runOpenClaudeAgent = mock(async () => ({
  text: 'consolidated summary',
  stderr: '',
  exitCode: 0,
  timedOut: false,
}))

async function withState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-consolidation-'))
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
  try {
    return await run(stateDir)
  } finally {
    if (previous === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previous
    await rm(stateDir, { recursive: true, force: true })
  }
}

describe('agent gateway memory consolidation', () => {
  beforeEach(() => {
    runOpenClaudeAgent.mockClear()
    runOpenClaudeAgent.mockImplementation(async () => ({
      text: 'consolidated summary',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
  })

  test('continues dialogue consolidation beyond 10000 chat-log lines', async () => {
    await withState(async stateDir => {
      const logDir = join(stateDir, 'logs')
      await mkdir(logDir, { recursive: true })
      const lines = Array.from({ length: 10_100 }, (_, index) => JSON.stringify({
        ts: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        direction: index % 2 ? 'out' : 'in',
        text: `message ${index}`,
      })).join('\n') + '\n'
      await writeFile(join(logDir, 'chat.jsonl'), lines)

      const { saveDialogueMeta, loadDialogueMeta, loadDialogueBlocks } =
        await import('./memory.js')
      const { consolidateDialogue } = await import('./consolidation.js')
      await saveDialogueMeta({ lastConsolidatedOffset: 10_000 })

      const result = await consolidateDialogue(
        getDefaultAgentGatewayConfig(),
        { runAgent: runOpenClaudeAgent as never },
      )
      expect(result.blocksCreated).toBe(1)
      expect((await loadDialogueMeta()).lastConsolidatedOffset).toBe(10_100)
      expect((await loadDialogueBlocks()).at(-1)?.messageCount).toBe(100)
      expect(runOpenClaudeAgent).toHaveBeenCalledTimes(1)
    })
  })

  test('does not skip failed dialogue chunks or advance a noncontiguous offset', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async () => ({
      text: '',
      stderr: 'provider unavailable',
      exitCode: 1,
      timedOut: false,
    }))

    await withState(async stateDir => {
      const logDir = join(stateDir, 'logs')
      await mkdir(logDir, { recursive: true })
      const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({
        ts: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        direction: 'in',
        text: `message ${index}`,
      })).join('\n') + '\n'
      await writeFile(join(logDir, 'chat.jsonl'), lines)

      const { loadDialogueMeta } = await import('./memory.js')
      const { consolidateDialogue } = await import('./consolidation.js')
      const result = await consolidateDialogue(
        getDefaultAgentGatewayConfig(),
        { runAgent: runOpenClaudeAgent as never },
      )

      expect(result.blocksCreated).toBe(0)
      expect((await loadDialogueMeta()).lastConsolidatedOffset).toBe(0)
      expect(runOpenClaudeAgent).toHaveBeenCalledTimes(1)
    })
  })

  test('retains extracted knowledge, refreshes markdown, and archives old scratchpad blocks', async () => {
    runOpenClaudeAgent.mockImplementationOnce(async () => ({
      text: JSON.stringify({
        knowledge_entries: [{ topic: 'durability', content: 'Never drop extracted knowledge.' }],
        compressed_block: 'Compressed old working memory.',
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))

    await withState(async stateDir => {
      const { saveScratchpadBlocks, loadScratchpadBlocks } =
        await import('./memory.js')
      const { consolidateScratchpad } = await import('./consolidation.js')
      const blocks = Array.from({ length: 4 }, (_, index) => ({
        ts: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        source: 'test',
        content: `block-${index} ${'x'.repeat(8_000)}`,
      }))
      await saveScratchpadBlocks(blocks)

      const result = await consolidateScratchpad(
        getDefaultAgentGatewayConfig(),
        { runAgent: runOpenClaudeAgent as never },
      )
      const active = await loadScratchpadBlocks()
      const markdown = await readFile(join(stateDir, 'memory', 'scratchpad.md'), 'utf8')
      const archive = await readFile(
        join(stateDir, 'memory', 'scratchpad_archive.jsonl'),
        'utf8',
      )

      expect(result.entriesExtracted).toBe(1)
      expect(active.some(block => block.content.includes('Compressed old'))).toBe(true)
      expect(active.some(block => block.content.includes('Never drop extracted'))).toBe(true)
      expect(active.some(block => block.content.includes('block-3'))).toBe(true)
      expect(markdown).toContain('Never drop extracted knowledge')
      expect(archive).toContain('block-0')
      expect(archive).toContain('"reason":"consolidation"')
    })
  })
})
