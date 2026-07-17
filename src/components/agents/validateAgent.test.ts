import { describe, expect, test } from 'bun:test'

describe('agent validation helpers', () => {
  test('validateAgentType can be imported without initializing AgentTool runtime', async () => {
    const { validateAgentType } = await import('./validateAgent.js')

    expect(validateAgentType('code-reviewer')).toBeNull()
    expect(validateAgentType('bad_type')).toContain('hyphens')
  })
})
