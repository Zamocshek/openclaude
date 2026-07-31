import { afterEach, describe, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerAndroidDeviceSkill } from './androidDevice.js'

afterEach(() => {
  clearBundledSkills()
})

describe('Android device bundled skill', () => {
  test('routes aliases to pinned MCP servers with bounded and private operation', async () => {
    registerAndroidDeviceSkill()
    const skill = getBundledSkills()
      .find(command => command.name === 'android-device')
    expect(skill).toBeDefined()
    expect(skill?.aliases).toEqual(['android-agent', 'mobile-android'])
    if (!skill || skill.type !== 'prompt') {
      throw new Error('android-device must be a prompt skill')
    }
    const blocks = await skill.getPromptForCommand(
      'Open the settings app on lab-phone.',
      {} as never,
    )
    const prompt = (blocks[0] as { text: string }).text
    expect(prompt).toContain('android_list_devices')
    expect(prompt).toContain('android-<alias>')
    expect(prompt).toContain('ClickBySelector')
    expect(prompt).toContain('Snapshot')
    expect(prompt.replace(/\s+/gu, ' ')).toContain(
      'two identical connection or selector failures',
    )
    expect(prompt).toContain('Pairing codes')
    expect(prompt).toContain('Open the settings app on lab-phone.')
  })
})
