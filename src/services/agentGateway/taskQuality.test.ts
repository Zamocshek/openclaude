import { describe, expect, test } from 'bun:test'

import {
  buildCodingVerificationPrompt,
  getCodingCompletionGap,
  getCodingVerificationAttemptLimit,
  isCodingCompletionGateEnabled,
  runOpenClaudeAgentWithCompletionGate,
} from './taskQuality.js'
import {
  type AgentRunOptions,
  type AgentRunResult,
} from './agentRunner.js'
import { getDefaultAgentGatewayConfig } from './config.js'

describe('coding completion gate', () => {
  test('requests a verifier after a successful edit without checks', () => {
    const gap = getCodingCompletionGap(
      'Fix the TypeScript endpoint',
      {
        text: 'Implemented.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'Edit: "/workspace/api.ts"',
          'tool result success (Edit: "/workspace/api.ts")',
          'assistant response',
        ],
      },
    )

    expect(gap).toContain('without a successful post-edit verifier')
  })

  test('accepts a successful verifier run after the last edit', () => {
    const gap = getCodingCompletionGap(
      'Fix the TypeScript endpoint',
      {
        text: 'Implemented and tested.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Edit: "/workspace/api.ts")',
          'Bash: "bun test api.test.ts"',
          'tool result success (Bash: "bun test api.test.ts")',
        ],
      },
    )

    expect(gap).toBeUndefined()
  })

  test('requires verification again when code changed after an earlier test', () => {
    const gap = getCodingCompletionGap(
      'Refactor code',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Bash: "bun test")',
          'tool result success (Edit: "/workspace/api.ts")',
        ],
      },
    )

    expect(gap).toBeTruthy()
  })

  test('does not mistake a final diff inspection for executable verification', () => {
    const gap = getCodingCompletionGap(
      'Fix the TypeScript implementation',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Edit: "src/index.ts")',
          'tool result success (Bash: "git diff -- src/index.ts")',
        ],
      },
    )

    expect(gap).toBeTruthy()
  })

  test('detects shell-based file mutation fallbacks', () => {
    const gap = getCodingCompletionGap(
      'Fix the TypeScript implementation',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Bash: "cat > src/index.ts << EOF")',
        ],
      },
    )

    expect(gap).toBeTruthy()
  })

  test('does not accept a mutating coding task with no action or verifier', () => {
    const gap = getCodingCompletionGap(
      'Update the TypeScript endpoint',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['assistant response'],
      },
    )

    expect(gap).toContain('without an observable file mutation')
  })

  test('does not add a verifier pass to conversational tasks', () => {
    expect(getCodingCompletionGap(
      'Какая сегодня погода?',
      {
        text: 'Солнечно.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['assistant response'],
      },
    )).toBeUndefined()
  })

  test('does not gate read-only coding questions or minimal harness runs', () => {
    const result: AgentRunResult = {
      text: 'Explanation only.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      activity: ['assistant response'],
    }
    expect(getCodingCompletionGap('Explain this TypeScript code', result)).toBeUndefined()
    expect(getCodingCompletionGap(
      'Fix this TypeScript code',
      result,
      process.env,
      'minimal',
    )).toBeUndefined()
    expect(getCodingVerificationAttemptLimit('adaptive')).toBe(1)
    expect(getCodingVerificationAttemptLimit('strict')).toBe(2)
  })

  test('can be disabled and builds a bounded continuation prompt', () => {
    expect(isCodingCompletionGateEnabled({
      OPENCLAUDE_AGENT_CODING_COMPLETION_GATE: '0',
    })).toBe(false)
    const prompt = buildCodingVerificationPrompt({
      originalPrompt: 'Fix code',
      gap: 'Missing checks',
      previousResult: {
        text: 'Changed the implementation.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['tool result success (Edit: "api.ts")'],
      },
    })
    expect(prompt).toContain('Inspect git status')
    expect(prompt).toContain('Original task:')
  })

  test('runs one isolated verifier pass after an unverified implementation', async () => {
    let callCount = 0
    const runner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      callCount += 1
      const activity = callCount === 1
        ? [
            'tool result success (Edit: "src/index.ts")',
            'tool result success (Edit: "src/index.ts")',
          ]
        : ['tool result success (Bash: "bun test")']
      for (const event of activity) options.onProgress?.(event)
      return {
        text: callCount === 1 ? 'Implemented.' : 'Verified.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: callCount,
        costUsd: callCount,
        activity,
        artifacts: callCount === 1
          ? [{ path: 'result.txt', kind: 'document', source: 'test' }]
          : [],
      }
    }
    const progress: string[] = []
    const stdout: string[] = []
    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Fix the TypeScript implementation and test it.',
      config: getDefaultAgentGatewayConfig(),
      suppressObservers: true,
      onProgress: event => progress.push(event),
      onStdout: chunk => stdout.push(chunk),
    }, runner)

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Verified.')
    expect(callCount).toBe(2)
    expect(progress).toContain('coding completion gate: verifier pass 1/1')
    expect(progress.filter(event => (
      event === 'tool result success (Edit: "src/index.ts")'
    ))).toHaveLength(2)
    expect(stdout).toEqual(['Verified.'])
    expect(result.durationMs).toBe(3)
    expect(result.costUsd).toBe(3)
    expect(result.artifacts).toHaveLength(1)
  })

  test('rechecks when the verifier mutates code after running tests', async () => {
    let callCount = 0
    const runner = async (): Promise<AgentRunResult> => {
      callCount += 1
      const activity = callCount === 1
        ? ['tool result success (Edit: "src/index.ts")']
        : callCount === 2
          ? [
              'tool result success (Bash: "bun test")',
              'tool result success (Edit: "src/index.ts")',
            ]
          : ['tool result success (Bash: "bun test")']
      return {
        text: `Pass ${callCount}`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity,
      }
    }
    const config = getDefaultAgentGatewayConfig()
    config.runner.harnessMode = 'strict'
    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Fix the TypeScript implementation.',
      config,
    }, runner)

    expect(callCount).toBe(3)
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Pass 3')
  })

  test('fails closed after the bounded verifier loop does no verification', async () => {
    let callCount = 0
    const runner = async (): Promise<AgentRunResult> => {
      callCount += 1
      return {
        text: `Pass ${callCount}`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: callCount === 1
          ? ['tool result success (Edit: "src/index.ts")']
          : ['assistant response'],
      }
    }
    const config = getDefaultAgentGatewayConfig()
    config.runner.harnessMode = 'strict'
    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Fix the TypeScript implementation.',
      config,
    }, runner)

    expect(callCount).toBe(3)
    expect(result.exitCode).toBe(1)
    expect(result.failureKind).toBe('quality_gate')
    expect(result.diagnostic).toContain('bounded evaluator loop')
  })
})
