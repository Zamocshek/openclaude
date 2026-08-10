import { describe, expect, test } from 'bun:test'

import {
  buildCodingVerificationPrompt,
  extractCodingCompletionDisposition,
  getCodingCompletionGap,
  getCodingVerificationAttemptLimit,
  isMaskedVerifierEvent,
  isCodingCompletionGateEnabled,
  mergeAgentRunResults,
  runOpenClaudeAgentWithCompletionGate,
  stripCodingCompletionDisposition,
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

  test('skips the gate when coding words appear only inside quoted dialogue', () => {
    const gap = getCodingCompletionGap(
      [
        'User message:',
        'Объясни спор текстом, ничего делать не надо.',
        '',
        'Nikita, [1 авг. 2026 в 11:56]',
        'сделай Python скрипт и исправь баг',
      ].join('\n'),
      {
        text: 'Вот объяснение спора.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['assistant response', 'result: success'],
      },
    )

    expect(gap).toBeUndefined()
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

  test('does not mistake file inspection or echoed words for verification', () => {
    for (const command of ['echo test', 'cat test.log', 'rg test']) {
      const gap = getCodingCompletionGap(
        'Fix the TypeScript endpoint',
        {
          text: 'Implemented.',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          activity: [
            'tool result success (Edit: "/workspace/api.ts")',
            `tool result success (Bash: "${command}")`,
          ],
        },
      )
      expect(gap).toContain('without a successful post-edit verifier')
    }
  })

  test('accepts git diff --check as a static post-edit verifier', () => {
    expect(getCodingCompletionGap(
      'Update the documentation',
      {
        text: 'Updated.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Edit: "docs/guide.md")',
          'tool result success (Bash: "git diff --check -- docs/guide.md")',
        ],
      },
    )).toBeUndefined()
  })

  test('requires an operational verifier after a runtime mutation', () => {
    expect(getCodingCompletionGap(
      'Deploy and restart the service',
      {
        text: 'Restarted.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        taskRoute: {
          mode: 'auto',
          servers: new Set(),
          reasons: [],
          codingIntent: true,
          codingMutationIntent: true,
        },
        activity: [
          'tool result success (Bash: "systemctl restart nova")',
        ],
      },
    )).toContain('without a successful post-edit verifier')
  })

  test('accepts an operational verifier after a runtime mutation', () => {
    expect(getCodingCompletionGap(
      'Deploy and restart the service',
      {
        text: 'Restarted and healthy.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        taskRoute: {
          mode: 'auto',
          servers: new Set(),
          reasons: [],
          codingIntent: true,
          codingMutationIntent: true,
        },
        activity: [
          'tool result success (Bash: "systemctl restart nova")',
          'tool result success (Bash: "systemctl is-active nova")',
        ],
      },
    )).toBeUndefined()
  })

  test('does not let unrelated runtime health verify a workspace edit', () => {
    expect(getCodingCompletionGap(
      'Fix the TypeScript endpoint',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        evidence: [
          {
            kind: 'mutation',
            scope: 'workspace',
            target: 'file:/workspace/src/api.ts',
            sequence: 0,
            success: true,
            source: 'Edit',
          },
          {
            kind: 'verification',
            scope: 'runtime',
            target: 'host:unrelated.example/service:web',
            sequence: 1,
            success: true,
            source: 'Bash',
          },
        ],
      },
    )).toContain('workspace target')
  })

  test('accepts exact post-write read-back evidence for a Markdown memory file', () => {
    expect(getCodingCompletionGap(
      'Update persistent memory and verify it.',
      {
        text: 'Memory updated and read back.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        taskRoute: {
          mode: 'auto',
          servers: new Set(),
          reasons: [],
          codingIntent: true,
          codingMutationIntent: true,
        },
        evidence: [
          {
            kind: 'mutation',
            scope: 'workspace',
            target: 'file:/workspace/memory/memory.md',
            sequence: 0,
            success: true,
            source: 'Edit',
          },
          {
            kind: 'verification',
            scope: 'workspace',
            target: 'file:/workspace/memory/memory.md',
            sequence: 1,
            success: true,
            source: 'Read',
          },
        ],
      },
    )).toBeUndefined()
  })

  test('requires runtime verification to match the mutated service target', () => {
    const base: AgentRunResult = {
      text: 'Done.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      taskRoute: {
        mode: 'auto',
        servers: new Set(),
        reasons: [],
        codingIntent: true,
        codingMutationIntent: true,
      },
      evidence: [
        {
          kind: 'mutation',
          scope: 'runtime',
          target: 'host:prod.example/service:nova',
          sequence: 0,
          success: true,
          source: 'Bash',
        },
      ],
    }
    expect(getCodingCompletionGap('Deploy nova.', {
      ...base,
      evidence: [
        ...base.evidence!,
        {
          kind: 'verification',
          scope: 'runtime',
          target: 'host:prod.example/service:other',
          sequence: 1,
          success: true,
          source: 'Bash',
        },
      ],
    })).toContain('runtime target')
    expect(getCodingCompletionGap('Deploy nova.', {
      ...base,
      evidence: [
        ...base.evidence!,
        {
          kind: 'verification',
          scope: 'runtime',
          target: 'host:prod.example/service:nova',
          sequence: 1,
          success: true,
          source: 'Bash',
        },
      ],
    })).toBeUndefined()
  })

  test('accepts a matching post-change verifier for a remote filesystem target', () => {
    expect(getCodingCompletionGap('Repair files on the SSH server.', {
      text: 'Remote repair verified.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      taskRoute: {
        mode: 'auto',
        servers: new Set(),
        reasons: [],
        codingIntent: true,
        codingMutationIntent: true,
      },
      evidence: [
        {
          kind: 'mutation',
          scope: 'runtime',
          target: 'host:nova-ssh-e2e/filesystem',
          sequence: 0,
          success: true,
          source: 'Bash: ssh',
        },
        {
          kind: 'verification',
          scope: 'runtime',
          target: 'host:nova-ssh-e2e/filesystem',
          sequence: 1,
          success: true,
          source: 'Bash: ssh python3 -m unittest',
        },
      ],
    })).toBeUndefined()
  })

  test('requires matching verification for every structured mutation target', () => {
    expect(getCodingCompletionGap('Update both services.', {
      text: 'Done.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      taskRoute: {
        mode: 'auto',
        servers: new Set(),
        reasons: [],
        codingIntent: true,
        codingMutationIntent: true,
      },
      evidence: [
        { kind: 'mutation', scope: 'runtime', target: 'host:prod/service:api', sequence: 0, success: true, source: 'Bash' },
        { kind: 'mutation', scope: 'runtime', target: 'host:prod/service:worker', sequence: 1, success: true, source: 'Bash' },
        { kind: 'verification', scope: 'runtime', target: 'host:prod/service:worker', sequence: 2, success: true, source: 'Bash' },
      ],
    })).toContain('service:api')
  })

  test('preserves structured evidence beyond the activity display cap', () => {
    const merged = mergeAgentRunResults([
      {
        text: 'first',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: Array.from({ length: 300 }, (_, index) => `event ${index}`),
        evidence: [{
          kind: 'mutation',
          scope: 'workspace',
          target: 'workspace:*',
          sequence: 0,
          success: true,
          source: 'Edit',
        }],
      },
      {
        text: 'verified',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['test complete'],
        evidence: [{
          kind: 'verification',
          scope: 'workspace',
          target: 'workspace:*',
          sequence: 0,
          success: true,
          source: 'Bash',
        }],
      },
    ])
    expect(merged.activity).toHaveLength(240)
    expect(merged.evidence).toHaveLength(2)
    expect(merged.evidence?.map(item => item.sequence)).toEqual([0, 1])
  })

  test('rejects an operational verifier whose pipeline masks failure', () => {
    const event = 'tool result success (Bash: "systemctl is-active nova | tail -1")'
    expect(isMaskedVerifierEvent(event)).toBe(true)
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

  test('rejects a post-edit verifier whose pipeline masks the real exit status', () => {
    const event = 'tool result success (Bash: "bun test | tail -20")'
    expect(isMaskedVerifierEvent(event)).toBe(true)
    expect(getCodingCompletionGap(
      'Fix the TypeScript implementation',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Edit: "src/index.ts")',
          event,
        ],
      },
    )).toContain('masks its real exit status')
  })

  test('accepts a piped verifier only when pipefail preserves failure', () => {
    const event = 'tool result success (Bash: "set -o pipefail; bun test | tee test.log")'
    expect(isMaskedVerifierEvent(event)).toBe(false)
    expect(getCodingCompletionGap(
      'Fix the TypeScript implementation',
      {
        text: 'Done.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Edit: "src/index.ts")',
          event,
        ],
      },
    )).toBeUndefined()
  })

  test('rejects success-forcing verifier fallbacks', () => {
    expect(isMaskedVerifierEvent(
      'tool result success (Bash: "pytest -q || echo failed")',
    )).toBe(true)
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

  test('does not gate read-only coding questions and keeps one verifier attempt', () => {
    const result: AgentRunResult = {
      text: 'Explanation only.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      activity: ['assistant response'],
    }
    expect(getCodingCompletionGap('Explain this TypeScript code', result)).toBeUndefined()
    expect(getCodingVerificationAttemptLimit()).toBe(1)
  })

  test('does not treat null-device redirects as file mutations', () => {
    const gap = getCodingCompletionGap(
      'Fix the TypeScript endpoint',
      {
        text: 'Implemented and verified.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: [
          'tool result success (Edit: "src/api.ts")',
          'tool result success (Bash: "bun test api.test.ts")',
          'tool result success (Bash: "git status 2>/dev/null")',
          'tool result success (PowerShell: "git status 2>$null")',
        ],
      },
    )
    expect(gap).toBeUndefined()
  })

  test('uses the semantic mutation decision instead of reclassifying words', () => {
    const gap = getCodingCompletionGap(
      'Исправь и запиши результат.',
      {
        text: 'Conversation response.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['assistant response'],
        taskRoute: {
          mode: 'auto',
          servers: new Set(),
          reasons: [],
          source: 'semantic',
          codingIntent: false,
          codingMutationIntent: false,
          confidence: 0.95,
        },
      },
    )
    expect(gap).toBeUndefined()
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
    expect(prompt).toContain('<openclaude_quality>')
  })

  test('keeps a runtime verification pass on the live target', () => {
    const prompt = buildCodingVerificationPrompt({
      originalPrompt: 'Deploy the service.',
      gap: 'Missing runtime verification',
      previousResult: {
        text: 'Deployed.',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity: ['tool result success (Bash: "docker compose up -d api")'],
        evidence: [{
          kind: 'mutation',
          scope: 'runtime',
          target: 'host:local/docker:*',
          sequence: 0,
          success: true,
          source: 'Bash',
        }],
      },
    })

    expect(prompt).toContain('runtime/deployment verification pass')
    expect(prompt).toContain('do not substitute an unrelated git diff')
    expect(prompt).not.toContain('Inspect git status')
  })

  test('parses and strips a typed evaluator disposition', () => {
    const text = [
      'SSH credentials are required before deployment can continue.',
      '<openclaude_quality>{"status":"blocked","scope":"runtime","reason":"SSH authentication is unavailable"}</openclaude_quality>',
    ].join('\n')
    expect(extractCodingCompletionDisposition(text)).toEqual({
      status: 'blocked',
      scope: 'runtime',
      reason: 'SSH authentication is unavailable',
    })
    expect(stripCodingCompletionDisposition(text)).toBe(
      'SSH credentials are required before deployment can continue.',
    )
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

  test('runs an independent acceptance pass after implementation tests pass', async () => {
    let callCount = 0
    const runner = async (): Promise<AgentRunResult> => {
      callCount += 1
      return callCount === 1
        ? {
            text: 'Implemented and tested.',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            evidence: [
              {
                kind: 'mutation',
                scope: 'workspace',
                target: 'file:/workspace/output/calculator.js',
                sequence: 0,
                success: true,
                source: 'Write',
              },
              {
                kind: 'verification',
                scope: 'workspace',
                target: 'workspace:*',
                sequence: 1,
                success: true,
                source: 'Bash: node calculator.test.js',
              },
            ],
          }
        : {
            text: [
              'All literal outputs and tests match.',
              '<openclaude_quality>{"status":"verified","scope":"workspace","reason":"Requested files exist and node test passed"}</openclaude_quality>',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
            timedOut: false,
            evidence: [{
              kind: 'verification',
              scope: 'workspace',
              target: 'workspace:*',
              sequence: 0,
              success: true,
              source: 'Bash: node calculator.test.js',
            }],
          }
    }

    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Create /workspace/output/calculator.js and test it.',
      config: getDefaultAgentGatewayConfig(),
    }, runner)

    expect(callCount).toBe(2)
    expect(result.exitCode).toBe(0)
    expect(result.completionGate?.status).toBe('verified')
    expect(result.completionStatus).toBe('completed')
  })

  test('fails closed when the single verifier mutates code after running tests', async () => {
    let callCount = 0
    const runner = async (): Promise<AgentRunResult> => {
      callCount += 1
      const activity = callCount === 1
        ? ['tool result success (Edit: "src/index.ts")']
        : [
            'tool result success (Bash: "bun test")',
            'tool result success (Edit: "src/index.ts")',
          ]
      return {
        text: `Pass ${callCount}`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        activity,
      }
    }
    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Fix the TypeScript implementation.',
      config: getDefaultAgentGatewayConfig(),
    }, runner)

    expect(callCount).toBe(2)
    expect(result.exitCode).toBe(1)
    expect(result.failureKind).toBe('quality_gate')
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
    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Fix the TypeScript implementation.',
      config: getDefaultAgentGatewayConfig(),
    }, runner)

    expect(callCount).toBe(2)
    expect(result.exitCode).toBe(1)
    expect(result.failureKind).toBe('quality_gate')
    expect(result.diagnostic).toContain('bounded evaluator loop')
  })

  test('returns a blocked deployment without converting it to agent failure', async () => {
    let callCount = 0
    const runner = async (): Promise<AgentRunResult> => {
      callCount += 1
      return callCount === 1
        ? {
            text: 'I need SSH access.',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            activity: ['assistant response'],
            taskRoute: {
              mode: 'auto',
              servers: new Set(),
              reasons: [],
              codingIntent: true,
              codingMutationIntent: true,
            },
          }
        : {
            text: [
              'Deployment is blocked because SSH authentication is unavailable.',
              '<openclaude_quality>{"status":"blocked","scope":"runtime","reason":"SSH authentication is unavailable"}</openclaude_quality>',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
            timedOut: false,
            activity: [
              'tool result success (Bash: "git diff -- src/runtime.ts")',
            ],
          }
    }
    const result = await runOpenClaudeAgentWithCompletionGate({
      prompt: 'Deploy and install the service.',
      config: getDefaultAgentGatewayConfig(),
    }, runner)

    expect(callCount).toBe(2)
    expect(result.exitCode).toBe(0)
    expect(result.failureKind).toBeUndefined()
    expect(result.completionGate?.status).toBe('blocked')
    expect(result.completionStatus).toBe('blocked')
    expect(result.text).toContain('SSH authentication is unavailable')
    expect(result.text).not.toContain('<openclaude_quality>')
  })
})
