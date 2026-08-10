import { describe, expect, test } from 'bun:test'
import {
  AgentInteractionRegistry,
  buildAgentInteractionRoutingContext,
  createAgentInteraction,
  extractAgentInteractionEnvelopes,
  validateAgentInteractionInput,
} from './agentInteractions.js'

describe('agent interaction protocol', () => {
  const interaction = createAgentInteraction({
    id: 'telegram-auth:account-1',
    handler: 'telegram.session.authorize',
    stage: 'code',
    prompt: 'Send the confirmation code.',
    input: {
      name: 'code',
      kind: 'otp',
      prompt: 'Send the confirmation code.',
      minLength: 5,
      maxLength: 5,
    },
    state: { sessionName: 'account-1' },
    sourceTool: 'mcp__telegram-mcp__authorize_send_code',
  })

  test('parses an extensible tool-declared continuation without tool-name heuristics', () => {
    const genericInteraction = {
      ...interaction,
      handler: 'custom.workflow.continue',
    }
    const output = [
      'Code sent.',
      '<openclaude_interaction>',
      JSON.stringify(genericInteraction),
      '</openclaude_interaction>',
    ].join('\n')

    expect(extractAgentInteractionEnvelopes('custom__tool', output)).toEqual([{
      ...genericInteraction,
      sourceTool: 'custom__tool',
    }])
  })

  test('accepts protected Telegram authorization only from its trusted MCP tool', () => {
    const output = `<openclaude_interaction>${JSON.stringify(interaction)}</openclaude_interaction>`

    expect(extractAgentInteractionEnvelopes(
      'mcp__telegram-mcp__authorize_send_code',
      output,
    )).toHaveLength(1)
    expect(extractAgentInteractionEnvelopes(
      'mcp__untrusted__authorize_send_code',
      output,
    )).toEqual([])
  })

  test('rejects secret-bearing durable state from a tool envelope', () => {
    const unsafe = {
      ...interaction,
      state: { sessionName: 'account-1', password: 'must-not-survive' },
    }
    const output = `<openclaude_interaction>${JSON.stringify(unsafe)}</openclaude_interaction>`
    expect(extractAgentInteractionEnvelopes('custom__tool', output)).toEqual([])
  })

  test('stores private continuation state only in the volatile registry', () => {
    const registry = new AgentInteractionRegistry<{ code: string }>()
    registry.set('chat-1', interaction, { code: '12345' }, 1000)

    expect(registry.get('chat-1', 2000)?.privateState).toEqual({ code: '12345' })
    expect(buildAgentInteractionRoutingContext(registry.get('chat-1', 2000)))
      .not.toContain('12345')
    expect(registry.get('chat-1', 1_000_000)).toBeUndefined()
  })

  test('validates input from the declared schema instead of phrase matching', () => {
    expect(validateAgentInteractionInput(interaction.input, '12345'))
      .toEqual({ ok: true, value: '12345' })
    expect(validateAgentInteractionInput(interaction.input, 'hello').ok).toBe(false)
  })
})
