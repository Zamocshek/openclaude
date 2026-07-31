import { afterEach, describe, expect, test } from 'bun:test'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerQwenCollaborationSkill } from './qwenCollaboration.js'

afterEach(() => {
  clearBundledSkills()
})

describe('Qwen collaboration bundled skill', () => {
  test('routes browser models through persistent profiles with bounded execution', async () => {
    registerQwenCollaborationSkill()

    const skill = getBundledSkills().find(
      command => command.name === 'qwen-collab',
    )
    expect(skill).toBeDefined()
    expect(skill?.userInvocable).toBe(true)
    expect(skill?.aliases).toContain('qwen')
    expect(skill?.aliases).toContain('browser-model')
    expect(skill?.aliases).toContain('web-model')
    if (!skill || skill.type !== 'prompt') {
      throw new Error('qwen-collab must register as a prompt command')
    }

    const blocks = await skill.getPromptForCommand(
      'Review this concurrency design.',
      {} as never,
    )
    const prompt = (blocks[0] as { text: string }).text
    expect(prompt).toContain('camofox_list_model_profiles')
    expect(prompt).toContain('camofox_open_model_profile')
    expect(prompt).toContain('camofox_set_model_profile')
    expect(prompt).toContain('camofox_checkpoint_model_profile')
    expect(prompt).toContain('Qwen')
    expect(prompt).toContain('ChatGPT')
    expect(prompt).toContain('Claude')
    expect(prompt).toContain('Gemini')
    expect(prompt).toContain('DeepSeek')
    expect(prompt).toContain('Perplexity')
    expect(prompt).toContain(
      'bun run release:camofox:auth -- login <profile-id>',
    )
    expect(prompt).toContain('leave the tab/session open')
    expect(prompt).toContain('at most eight candidate titles')
    expect(prompt).toContain('12 minutes')
    expect(prompt).toContain('untrusted model-generated content')
    expect(prompt).toContain('Review this concurrency design.')
    expect(prompt).toContain('Never type')
    expect(prompt).not.toContain('print cookies')
  })
})
