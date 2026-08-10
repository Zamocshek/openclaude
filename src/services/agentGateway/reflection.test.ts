import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  appendReflection,
  buildTaskTraceFromAgentRun,
  loadRecentReflections,
  shouldGenerateReflection,
  type TaskReflection,
} from './reflection.js'

async function withState<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-reflection-'))
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previous
    await rm(stateDir, { recursive: true, force: true })
  }
}

describe('agent task reflection', () => {
  test('builds a redacted trace from failed runtime activity', () => {
    const trace = buildTaskTraceFromAgentRun(
      {
        prompt: 'deploy with token=secret-value-123456 and sk-abcdefghijklmnop',
        cwd: '/workspace',
        startedAt: 1_700_000_000_000,
      },
      {
        text: 'failed',
        stderr: 'authorization=secret-value-123456',
        exitCode: 1,
        timedOut: false,
        durationMs: 25,
        failureKind: 'tool_error',
        activity: [
          'thinking',
          'tool result error (Bash: "deploy"): token=secret-value-123456',
        ],
      },
    )

    expect(shouldGenerateReflection(trace)).toBe(true)
    expect(trace.taskType).toBe('tool_error')
    expect(JSON.stringify(trace)).not.toContain('secret-value-123456')
    expect(JSON.stringify(trace)).not.toContain('sk-abcdefghijklmnop')
  })

  test('serializes concurrent reflection appends', async () => {
    await withState(async () => {
      const reflections: TaskReflection[] = Array.from({ length: 30 }, (_, index) => ({
        ts: new Date(1_700_000_000_000 + index).toISOString(),
        taskId: `task-${index}`,
        taskType: 'test',
        goal: `goal-${index}`,
        rounds: 1,
        costUsd: 0,
        errorCount: 1,
        keyMarkers: ['TOOL_ERROR'],
        reflection: `reflection-${index}`,
      }))

      await Promise.all(reflections.map(appendReflection))
      const loaded = await loadRecentReflections(30)
      expect(loaded).toHaveLength(30)
      expect(new Set(loaded.map(item => item.taskId)).size).toBe(30)
    })
  })
})
