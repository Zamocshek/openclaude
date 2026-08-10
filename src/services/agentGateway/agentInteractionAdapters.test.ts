import { describe, expect, test } from 'bun:test'
import {
  continueAgentInteraction,
  registerAgentInteractionAdapter,
} from './agentInteractionAdapters.js'
import { createAgentInteraction } from './agentInteractions.js'

describe('agent interaction adapters', () => {
  test('dispatches a continuation by declared handler rather than user wording', async () => {
    registerAgentInteractionAdapter({
      handler: 'test.choose-target',
      continue: async (_stored, value) => ({
        status: 'completed',
        message: `selected:${value}`,
      }),
    })
    const interaction = createAgentInteraction({
      id: 'choice-1',
      handler: 'test.choose-target',
      stage: 'select',
      prompt: 'Choose a target.',
      input: {
        name: 'target',
        kind: 'choice',
        prompt: 'Choose a target.',
        choices: ['alpha', 'beta'],
      },
      sourceTool: 'mcp__test__prepare',
    })

    expect(await continueAgentInteraction({
      interaction,
      expiresAt: Date.now() + 60_000,
    }, 'beta')).toEqual({
      status: 'completed',
      message: 'selected:beta',
    })
  })

  test('does not execute an unregistered protected interaction', async () => {
    const interaction = createAgentInteraction({
      id: 'secret-1',
      handler: 'unknown.secret-handler',
      stage: 'secret',
      prompt: 'Enter a secret.',
      input: { name: 'secret', kind: 'secret', prompt: 'Enter a secret.' },
      sourceTool: 'mcp__unknown__prepare',
    })
    expect(await continueAgentInteraction({
      interaction,
      expiresAt: Date.now() + 60_000,
    }, 'value')).toEqual({ status: 'unsupported' })
  })
})
