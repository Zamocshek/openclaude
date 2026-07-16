import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultAgentGatewayConfig } from './config.js'
import {
  loadEvolutionState,
  runEvolutionCycle,
  toggleEvolution,
} from './evolution.js'

async function withTempGatewayState<T>(fn: () => Promise<T>): Promise<T> {
  const previousStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-evolution-'))
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
  try {
    return await fn()
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
    else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = previousStateDir
    await rm(stateDir, { recursive: true, force: true })
  }
}

describe('agent gateway evolution', () => {
  test('runs one-off cycles without silently enabling autonomous evolution', async () => {
    await withTempGatewayState(async () => {
      await toggleEvolution(false)
      const result = await runEvolutionCycle(
        getDefaultAgentGatewayConfig(),
        'prompt_evolution',
        {
          allowWhenDisabled: true,
          runAgent: async () => ({
            text: '[INSIGHT] Keep runtime controls explicit.',
            stderr: '',
            exitCode: 0,
            timedOut: false,
          }),
        },
      )
      const state = await loadEvolutionState()

      expect(result?.type).toBe('prompt_evolution')
      expect(state.enabled).toBe(false)
      expect(state.totalCyclesCompleted).toBe(1)
      expect(state.totalCyclesFailed).toBe(0)
      expect(state.insightsGenerated).toBe(1)
    })
  })

  test('records failed cycles without counting them as completed', async () => {
    await withTempGatewayState(async () => {
      await expect(runEvolutionCycle(
        getDefaultAgentGatewayConfig(),
        'tool_analysis',
        {
          allowWhenDisabled: true,
          runAgent: async () => ({
            text: '',
            stderr: 'provider unavailable',
            exitCode: 1,
            timedOut: false,
            failureKind: 'provider_request',
          }),
        },
      )).rejects.toThrow('Tool analysis failed')

      const state = await loadEvolutionState()
      expect(state.totalCyclesCompleted).toBe(0)
      expect(state.totalCyclesFailed).toBe(1)
      expect(state.lastFailureType).toBe('tool_analysis')
      expect(state.lastFailureError).toContain('provider unavailable')
    })
  })

  test('serializes parallel cycles so state updates are not lost', async () => {
    await withTempGatewayState(async () => {
      let active = 0
      let maxActive = 0
      const runAgent = async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return {
          text: '[INSIGHT] Serialized cycle.',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        }
      }

      await Promise.all([
        runEvolutionCycle(getDefaultAgentGatewayConfig(), 'prompt_evolution', {
          allowWhenDisabled: true,
          runAgent,
        }),
        runEvolutionCycle(getDefaultAgentGatewayConfig(), 'tool_analysis', {
          allowWhenDisabled: true,
          runAgent,
        }),
      ])

      const state = await loadEvolutionState()
      expect(maxActive).toBe(1)
      expect(state.totalCyclesCompleted).toBe(2)
      expect(state.totalCyclesFailed).toBe(0)
    })
  })
})
