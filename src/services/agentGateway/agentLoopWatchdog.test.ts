import { describe, expect, test } from 'bun:test'
import {
  AgentLoopWatchdog,
  getAgentLoopRepeatLimit,
} from './agentLoopWatchdog.js'

const emptyProgress = {
  evidence: [],
  artifacts: [],
  pendingInteractions: [],
}

describe('agent loop watchdog', () => {
  test('detects a repeated failed tool route without progress', () => {
    const watchdog = new AgentLoopWatchdog(3)
    watchdog.syncProgress(emptyProgress)
    const observation = {
      toolName: 'Read',
      toolInput: { file_path: '/workspace/missing.wav' },
      success: false,
      output: 'binary files cannot be read as text',
      turn: 1,
    }

    expect(watchdog.observeToolCompletion(observation)).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...observation, turn: 2 })).toBeUndefined()
    const detection = watchdog.observeToolCompletion({ ...observation, turn: 3 })

    expect(detection?.count).toBe(3)
    expect(detection?.diagnostic).toContain('without new mutation')
    expect(detection?.diagnostic).toContain('/workspace/missing.wav')
  })

  test('resets repetition state after new verified progress', () => {
    const watchdog = new AgentLoopWatchdog(3)
    const observation = {
      toolName: 'Edit',
      toolInput: { file_path: '/workspace/app.ts', old_string: 'a', new_string: 'b' },
      success: false,
      output: 'old_string not found',
      turn: 1,
    }

    watchdog.observeToolCompletion(observation)
    watchdog.observeToolCompletion({ ...observation, turn: 2 })
    watchdog.syncProgress({
      evidence: ['verification:workspace:file:/workspace/app.ts:Read'],
      artifacts: [],
      pendingInteractions: [],
    })

    expect(watchdog.observeToolCompletion({ ...observation, turn: 3 })).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...observation, turn: 4 })).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...observation, turn: 5 })?.count).toBe(3)
  })

  test('does not treat changing tool output as a repeated route', () => {
    const watchdog = new AgentLoopWatchdog(3)
    for (let index = 1; index <= 20; index += 1) {
      expect(watchdog.observeToolCompletion({
        toolName: 'mcp__custom__job_status',
        toolInput: { id: 'download-1' },
        success: true,
        output: `downloaded ${index * 5}%`,
        turn: index,
      })).toBeUndefined()
    }
  })

  test('counts repeated calls only across assistant turns', () => {
    const watchdog = new AgentLoopWatchdog(3)
    const observation = {
      toolName: 'Read',
      toolInput: { file_path: '/workspace/missing.wav' },
      success: false,
      output: 'not found',
      turn: 1,
    }

    expect(watchdog.observeToolCompletion(observation)).toBeUndefined()
    expect(watchdog.observeToolCompletion(observation)).toBeUndefined()
    expect(watchdog.observeToolCompletion(observation)).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...observation, turn: 2 })).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...observation, turn: 3 })?.count).toBe(3)
  })

  test('detects an alternating repeated route without progress', () => {
    const watchdog = new AgentLoopWatchdog(3)
    const callA = {
      toolName: 'Read',
      toolInput: { file_path: '/workspace/a.txt' },
      success: false,
      output: 'not found',
    }
    const callB = {
      toolName: 'Read',
      toolInput: { file_path: '/workspace/b.txt' },
      success: false,
      output: 'not found',
    }

    expect(watchdog.observeToolCompletion({ ...callA, turn: 1 })).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...callB, turn: 2 })).toBeUndefined()
    expect(watchdog.observeToolCompletion({ ...callA, turn: 3 })).toBeUndefined()
    const detection = watchdog.observeToolCompletion({ ...callB, turn: 4 })
    expect(detection?.count).toBe(4)
    expect(detection?.diagnostic).toContain('route family')
  })

  test('detects the same failed route family with changing inputs', () => {
    const watchdog = new AgentLoopWatchdog(3)
    for (let turn = 1; turn <= 3; turn += 1) {
      expect(watchdog.observeToolCompletion({
        toolName: 'Glob',
        toolInput: { path: `/workspace/search-${turn}` },
        success: false,
        output: `Ripgrep search timed out after ${turn * 10} seconds`,
        turn,
      })).toBeUndefined()
    }
    const detection = watchdog.observeToolCompletion({
      toolName: 'Glob',
      toolInput: { path: '/home/node/.openclaude' },
      success: false,
      output: 'Ripgrep search timed out after 60 seconds',
      turn: 4,
    })

    expect(detection?.count).toBe(4)
    expect(detection?.diagnostic).toContain('route family')
    expect(detection?.diagnostic).toContain('Glob (timeout)')
  })

  test('detects broad error churn even when tools and failures differ', () => {
    const watchdog = new AgentLoopWatchdog(3)
    const failures = [
      ['Read', 'no such file'],
      ['Edit', 'old_string validation error'],
      ['Bash', 'exit code 1'],
      ['Glob', 'search timed out'],
      ['MCP', 'connection refused'],
      ['Write', 'no such tool available'],
      ['Read', 'permission denied'],
      ['Bash', 'command failed'],
    ] as const

    failures.slice(0, -1).forEach(([toolName, output], index) => {
      expect(watchdog.observeToolCompletion({
        toolName,
        toolInput: { index },
        success: false,
        output,
        turn: index + 1,
      })).toBeUndefined()
    })
    const [toolName, output] = failures.at(-1)!
    const detection = watchdog.observeToolCompletion({
      toolName,
      toolInput: { index: failures.length - 1 },
      success: false,
      output,
      turn: failures.length,
    })

    expect(detection?.count).toBe(8)
    expect(detection?.diagnostic).toContain('Different failing routes')
  })

  test('new durable progress resets route-family and error-churn state', () => {
    const watchdog = new AgentLoopWatchdog(3)
    for (let turn = 1; turn <= 3; turn += 1) {
      watchdog.observeToolCompletion({
        toolName: 'Glob',
        toolInput: { path: `/missing-${turn}` },
        success: false,
        output: 'search timed out',
        turn,
      })
    }
    watchdog.syncProgress({
      evidence: ['mutation:workspace:file:/workspace/app.ts'],
      artifacts: [],
      pendingInteractions: [],
    })

    expect(watchdog.observeToolCompletion({
      toolName: 'Glob',
      toolInput: { path: '/missing-4' },
      success: false,
      output: 'search timed out',
      turn: 4,
    })).toBeUndefined()
  })

  test('requires sustained time before stopping repeated successful calls', () => {
    let now = 0
    const watchdog = new AgentLoopWatchdog(3, () => now)
    const observation = {
      toolName: 'mcp__custom__status',
      toolInput: { id: 'job-1' },
      success: true,
      output: 'pending',
      turn: 1,
    }
    for (let turn = 1; turn <= 5; turn += 1) {
      now = turn * 5_000
      expect(watchdog.observeToolCompletion({ ...observation, turn })).toBeUndefined()
    }
    now = 70_000
    expect(watchdog.observeToolCompletion({ ...observation, turn: 6 })?.count).toBe(6)
  })

  test('bounds the configurable repeat threshold', () => {
    expect(getAgentLoopRepeatLimit({ OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT: '1' })).toBe(2)
    expect(getAgentLoopRepeatLimit({ OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT: '50' })).toBe(20)
    expect(getAgentLoopRepeatLimit({ OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT: 'bad' })).toBe(3)
  })
})
