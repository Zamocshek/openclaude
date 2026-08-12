import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultAgentGatewayConfig } from './config.js'
import {
  getInfiniteTaskBudgetLimit,
  getInfiniteTaskMaxIterations,
  runInfiniteTask,
} from './infiniteTask.js'
import type { AgentRunResult } from './agentRunner.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  await Promise.all(temporaryPaths.splice(0).map(path => (
    rm(path, { recursive: true, force: true })
  )))
})

async function useTemporaryState(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-infinite-task-'))
  temporaryPaths.push(stateDir)
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
}

function failedResult(stderr = 'network request failed'): AgentRunResult {
  return {
    text: '',
    stderr,
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    failureKind: 'transient_network',
  }
}

describe('adaptive goal loop', () => {
  test('uses unlimited iterations and budget unless explicitly configured', () => {
    expect(getInfiniteTaskMaxIterations({})).toBeNull()
    expect(getInfiniteTaskBudgetLimit({})).toBeNull()
    expect(getInfiniteTaskMaxIterations({ OPENCLAUDE_OUROBOROS_LOOP_MAX_ITERATIONS: '12' })).toBe(12)
    expect(getInfiniteTaskBudgetLimit({ OPENCLAUDE_OUROBOROS_LOOP_BUDGET_USD: '7.5' })).toBe(7.5)
  })

  test('turns a repeated identical failure into a resumable blocker', async () => {
    await useTemporaryState()
    let failureAnalyses = 0
    const state = await runInfiniteTask(
      'task-repeat',
      'Finish the task',
      getDefaultAgentGatewayConfig(),
      {
        maxIterations: null,
        runAgent: async () => failedResult('provider fetch failed'),
        analyzeFailure: async () => {
          failureAnalyses += 1
          return { lesson: 'The provider is unavailable.', nextStrategy: 'Retry after checking provider health.' }
        },
      },
    )

    expect(state.status).toBe('blocked')
    expect(state.iterations).toBe(3)
    expect(failureAnalyses).toBe(2)
    expect(state.currentStrategy).toContain('same failure repeated')
  })

  test('does not mark a completion-gate blocker as task success', async () => {
    await useTemporaryState()
    const state = await runInfiniteTask(
      'task-gate',
      'Verify the deployment',
      getDefaultAgentGatewayConfig(),
      {
        maxIterations: null,
        runAgent: async () => ({
          text: 'Waiting for access.',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          completionStatus: 'blocked',
          completionGate: {
            status: 'blocked',
            scope: 'runtime',
            reason: 'SSH access is unavailable.',
          },
        }),
      },
    )

    expect(state.status).toBe('blocked')
    expect(state.iterations).toBe(1)
    expect(state.currentStrategy).toBe('SSH access is unavailable.')
  })

  test('accounts for measured provider cost when a budget is configured', async () => {
    await useTemporaryState()
    const state = await runInfiniteTask(
      'task-cost',
      'Finish the task',
      getDefaultAgentGatewayConfig(),
      {
        maxIterations: 1,
        budgetLimit: 1,
        runAgent: async () => ({
          ...failedResult('temporary failure'),
          costUsd: 0.125,
        }),
        analyzeFailure: async () => ({ lesson: 'Retry.', nextStrategy: 'Retry.' }),
      },
    )

    expect(state.budgetSpent).toBe(0.125)
    expect(state.status).toBe('blocked')
  })
})
