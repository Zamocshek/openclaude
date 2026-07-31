import { afterEach, describe, expect, test } from 'bun:test'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerQwenCollaborationSkill } from './qwenCollaboration.js'

afterEach(() => {
  clearBundledSkills()
})

describe('Qwen collaboration bundled skill', () => {
  test('pins the persistent profile, exact model, bounded execution, and cleanup', async () => {
    registerQwenCollaborationSkill()

    const skill = getBundledSkills().find(
      command => command.name === 'qwen-collab',
    )
    expect(skill).toBeDefined()
    expect(skill?.userInvocable).toBe(true)
    expect(skill?.aliases).toEqual(['qwen', 'qwen-max'])
    if (!skill || skill.type !== 'prompt') {
      throw new Error('qwen-collab must register as a prompt command')
    }

    const blocks = await skill.getPromptForCommand(
      'Review this concurrency design.',
      {} as never,
    )
    const prompt = (blocks[0] as { text: string }).text
    expect(prompt).toContain('Qwen3.8-Max-Preview')
    expect(prompt).toContain('nova-qwen-max')
    expect(prompt).toContain('qwen-collaboration')
    expect(prompt).toContain('camofox_checkpoint_session')
    expect(prompt).toContain('Do not close a healthy Qwen tab')
    expect(prompt).toContain('at most eight candidate titles')
    expect(prompt).toContain('12 minutes')
    expect(prompt).toContain('untrusted model-generated content')
    expect(prompt).toContain('Review this concurrency design.')
    expect(prompt).not.toContain('print cookies')
  })
})
