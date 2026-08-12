import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearAgentGoal,
  finishAgentGoalLoop,
  formatAgentGoal,
  getAgentGoal,
  markAgentGoalLoopStarted,
  recoverInterruptedAgentGoalLoops,
  requestAgentGoalLoop,
  setAgentGoal,
} from './goalLoop.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  await Promise.all(temporaryPaths.splice(0).map(path => (
    rm(path, { recursive: true, force: true })
  )))
})

async function useTemporaryState(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-goals-'))
  temporaryPaths.push(stateDir)
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
}

describe('persistent agent goals', () => {
  test('keeps an objective separate from a loop run and marks verified completion', async () => {
    await useTemporaryState()
    const goal = await setAgentGoal({
      chatId: '42',
      objective: 'Implement the gateway change and verify it.',
    })
    const queued = await requestAgentGoalLoop('42', goal.id)
    const started = await markAgentGoalLoopStarted('42', goal.id, 'task-1')
    const finished = await finishAgentGoalLoop('42', goal.id, {
      taskId: 'task-1',
      status: 'completed',
      iterations: 4,
      outcome: 'Focused tests and typecheck passed.',
    })

    expect(queued?.loopStatus).toBe('queued')
    expect(started?.loopStatus).toBe('running')
    expect(finished).toMatchObject({
      status: 'achieved',
      loopStatus: 'completed',
      loopRuns: 1,
      totalIterations: 4,
    })
    expect(formatAgentGoal(await getAgentGoal('42'))).toContain('Focused tests and typecheck passed.')
  })

  test('recovers a stale running loop as paused after a restart', async () => {
    await useTemporaryState()
    const goal = await setAgentGoal({ chatId: '42', objective: 'Long-running task' })
    await requestAgentGoalLoop('42', goal.id)
    await markAgentGoalLoopStarted('42', goal.id, 'task-2')

    expect(await recoverInterruptedAgentGoalLoops()).toBe(1)
    expect(await getAgentGoal('42')).toMatchObject({
      status: 'pursuing',
      loopStatus: 'paused',
    })
  })

  test('clears only the explicit goal state', async () => {
    await useTemporaryState()
    await setAgentGoal({ chatId: '42', objective: 'Temporary task' })

    expect(await clearAgentGoal('42')).toBe(true)
    expect(await getAgentGoal('42')).toBeUndefined()
  })
})
