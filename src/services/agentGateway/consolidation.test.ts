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

  test('serializes concurrent consolidation attempts without duplicate blocks', async () => {
    await withState(async stateDir => {
      const logDir = join(stateDir, 'logs')
      await mkdir(logDir, { recursive: true })
      const lines = Array.from({ length: 100 }, (_, index) => JSON.stringify({
        ts: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        direction: 'in',
        text: `message ${index}`,
      })).join('\n') + '\n'
      await writeFile(join(logDir, 'chat.jsonl'), lines)

      const { loadDialogueBlocks, loadDialogueMeta } = await import('./memory.js')
      const { consolidateDialogue } = await import('./consolidation.js')
      const results = await Promise.all([
        consolidateDialogue(getDefaultAgentGatewayConfig(), {
          runAgent: runOpenClaudeAgent as never,
        }),
        consolidateDialogue(getDefaultAgentGatewayConfig(), {
          runAgent: runOpenClaudeAgent as never,
        }),
      ])

      expect(results.map(result => result.blocksCreated).sort()).toEqual([0, 1])
      expect(await loadDialogueBlocks()).toHaveLength(1)
      expect((await loadDialogueMeta()).lastConsolidatedOffset).toBe(100)
      expect(runOpenClaudeAgent).toHaveBeenCalledTimes(1)
    })
  })

  test('compresses enough eras to restore the configured block bound', async () => {
    await withState(async stateDir => {
      const logDir = join(stateDir, 'logs')
      await mkdir(logDir, { recursive: true })
      const lines = Array.from({ length: 100 }, (_, index) => JSON.stringify({
        ts: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        direction: 'in',
        text: `message ${index}`,
      })).join('\n') + '\n'
      await writeFile(join(logDir, 'chat.jsonl'), lines)

      const { loadDialogueBlocks, saveDialogueState } = await import('./memory.js')
      const { consolidateDialogue } = await import('./consolidation.js')
      const existing = Array.from({ length: 16 }, (_, index) => ({
        ts: new Date(1_690_000_000_000 + index * 1_000).toISOString(),
        type: 'summary' as const,
        range: `2023-07-${String(index + 1).padStart(2, '0')} 00:00 - 00:01`,
        messageCount: 100,
        content: `summary-${index}`,
      }))
      await saveDialogueState(existing, { lastConsolidatedOffset: 0 })

      const result = await consolidateDialogue(getDefaultAgentGatewayConfig(), {
        runAgent: runOpenClaudeAgent as never,
      })
      const blocks = await loadDialogueBlocks()

      expect(result.blocksCreated).toBe(1)
      expect(blocks.length).toBeLessThanOrEqual(10)
      expect(blocks.some(block => block.type === 'era')).toBe(true)
      expect(runOpenClaudeAgent).toHaveBeenCalledTimes(4)
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

  test('preserves blocks appended while scratchpad consolidation is running', async () => {
    await withState(async () => {
      const { appendScratchpadBlock, loadScratchpadBlocks, saveScratchpadBlocks } =
        await import('./memory.js')
      const { consolidateScratchpad } = await import('./consolidation.js')
      const blocks = Array.from({ length: 4 }, (_, index) => ({
        ts: new Date(1_700_000_100_000 + index * 1_000).toISOString(),
        source: 'test',
        content: `block-${index} ${'x'.repeat(8_000)}`,
      }))
      await saveScratchpadBlocks(blocks)

      const runner = mock(async () => {
        await appendScratchpadBlock('arrived during consolidation', 'live')
        return {
          text: JSON.stringify({
            knowledge_entries: [],
            compressed_block: 'Compressed old working memory.',
          }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        }
      })

      const result = await consolidateScratchpad(
        getDefaultAgentGatewayConfig(),
        { runAgent: runner as never },
      )
      const active = await loadScratchpadBlocks()

      expect(result.entriesExtracted).toBe(0)
      expect(active.some(block => block.content === 'arrived during consolidation')).toBe(true)
      expect(active.some(block => block.content === 'Compressed old working memory.')).toBe(true)
      expect(active.some(block => block.content.includes('block-3'))).toBe(true)
    })
  })
})
