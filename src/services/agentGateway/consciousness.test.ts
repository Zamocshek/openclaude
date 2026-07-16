import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createBackgroundConsciousness,
  isEvolutionCycleDue,
  parseConsciousnessResponse,
} from './consciousness.js'
import { getDefaultAgentGatewayConfig } from './config.js'
import { ensureMemoryFiles } from './memory.js'

async function withTempGatewayState<T>(fn: () => Promise<T>): Promise<T> {
  const previousStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  const previousBudget = process.env.TOTAL_BUDGET
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-consciousness-'))
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
  delete process.env.TOTAL_BUDGET
  try {
    await ensureMemoryFiles()
    return await fn()
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousStateDir
    if (previousBudget === undefined) delete process.env.TOTAL_BUDGET
    else process.env.TOTAL_BUDGET = previousBudget
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('background consciousness', () => {
  test('parses bounded round, memory, wakeup, and evolution controls', () => {
    const parsed = parseConsciousnessResponse([
      '[PROACTIVE] useful update',
      '[SCRATCHPAD] This is a sufficiently detailed persistent scratchpad entry.',
      '[WAKEUP:900]',
      '[EVOLVE]',
      '[CONTINUE]',
      'private thought',
    ].join('\n'))

    expect(parsed.proactiveMessage).toBe('useful update')
    expect(parsed.scratchpadAppend).toContain('sufficiently detailed')
    expect(parsed.nextWakeupSec).toBe(900)
    expect(parsed.shouldEvolve).toBe(true)
    expect(parsed.shouldContinue).toBe(true)
    expect(parsed.thought).toBe('private thought')
  })

  test('schedules missing and stale evolution cycles but not recent ones', () => {
    expect(isEvolutionCycleDue({ enabled: false }, 3600, 10_000)).toBe(false)
    expect(isEvolutionCycleDue({ enabled: true }, 3600, 10_000)).toBe(true)
    expect(isEvolutionCycleDue({
      enabled: true,
      lastCycleAt: new Date(9_000).toISOString(),
    }, 3600, 10_000)).toBe(false)
    expect(isEvolutionCycleDue({
      enabled: true,
      lastCycleAt: new Date(0).toISOString(),
    }, 5, 70_000)).toBe(true)
  })

  test('runs only requested bounded rounds and exposes truthful status', async () => {
    await withTempGatewayState(async () => {
      const responses = [
        '[CONTINUE]\nFirst round',
        '[PROACTIVE]Useful update\n[WAKEUP:45]\nSecond round',
      ]
      const proactive: string[] = []
      let calls = 0
      const handle = createBackgroundConsciousness({
        config: getDefaultAgentGatewayConfig(),
        wakeupMin: 1,
        wakeupMax: 100,
        maxRounds: 3,
        onProactiveMessage: async text => { proactive.push(text) },
        runAgent: async () => ({
          text: responses[calls] || 'done',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          costUsd: ++calls === 1 ? 0.01 : 0.02,
        }),
      })

      try {
        expect(handle.wakeNow()).toBe(true)
        await waitFor(() => handle.getStatus().wakeupCount === 1 && !handle.getStatus().inFlight)
        const status = handle.getStatus()
        expect(calls).toBe(2)
        expect(status.lastRoundCount).toBe(2)
        expect(status.maxRounds).toBe(3)
        expect(status.nextWakeupSec).toBe(45)
        expect(status.budgetSpentUsd).toBeCloseTo(0.03)
        expect(status.budgetLimited).toBe(false)
        expect(status.lastSuccessAt).toBeTruthy()
        expect(proactive).toEqual(['Useful update'])
      } finally {
        handle.stop()
      }
    })
  })

  test('pausing aborts an in-flight background model run', async () => {
    await withTempGatewayState(async () => {
      const handle = createBackgroundConsciousness({
        config: getDefaultAgentGatewayConfig(),
        wakeupMin: 1,
        runAgent: options => new Promise(resolve => {
          options.signal?.addEventListener('abort', () => resolve({
            text: '',
            stderr: 'aborted',
            exitCode: 1,
            timedOut: false,
          }), { once: true })
        }),
      })

      try {
        expect(handle.wakeNow()).toBe(true)
        await waitFor(() => handle.getStatus().inFlight)
        handle.pause()
        await waitFor(() => !handle.getStatus().inFlight)
        expect(handle.getStatus().paused).toBe(true)
        expect(handle.getStatus().lastError).toBeUndefined()
      } finally {
        handle.stop()
      }
    })
  })
})
