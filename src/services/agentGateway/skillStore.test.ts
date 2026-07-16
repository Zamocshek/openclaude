import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearSkillCaches } from '../../skills/loadSkillsDir.js'
import {
  createManagedSkill,
  deleteManagedSkill,
  getManagedSkillsRoot,
  getSkillStoreItemDetails,
  listSkillStore,
  parseSkillStoreImport,
  SkillStoreError,
} from './skillStore.js'

describe('agent gateway Skill Store', () => {
  test('parses, creates, loads, views, and removes a managed skill', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'openclaude-skill-store-'))
    const options = { skillsRoot: join(configDir, 'skills') }

    try {
      const parsed = parseSkillStoreImport(JSON.stringify({
        skill: {
          name: 'verify-output',
          description: 'Use when a task needs deterministic output verification.',
          instructions: 'Run the narrowest relevant check before reporting success.',
        },
      }))
      expect(parsed).toEqual({
        ok: true,
        input: {
          name: 'verify-output',
          description: 'Use when a task needs deterministic output verification.',
          instructions: 'Run the narrowest relevant check before reporting success.',
        },
      })
      if (!parsed || parsed.ok === false) throw new Error('Expected parsed skill')

      const created = await createManagedSkill(configDir, parsed.input, options)
      expect(created).toMatchObject({
        name: 'verify-output',
        managed: true,
        origin: 'skills',
      })
      expect(created.instructions).toContain('narrowest relevant check')

      const skillFile = await readFile(
        join(getManagedSkillsRoot(options), 'verify-output', 'SKILL.md'),
        'utf8',
      )
      expect(skillFile).toContain('name: verify-output')
      expect(skillFile).toContain('description: "Use when a task needs deterministic output verification."')

      const listed = await listSkillStore(configDir, options)
      expect(listed.some(skill => skill.name === 'verify-output')).toBe(true)
      expect(
        (await getSkillStoreItemDetails(configDir, created.id, options))?.name,
      ).toBe('verify-output')

      await expect(createManagedSkill(configDir, parsed.input, options)).rejects.toMatchObject({
        code: 'conflict',
      } satisfies Partial<SkillStoreError>)

      const remaining = await deleteManagedSkill(configDir, created.id, options)
      expect(remaining.some(skill => skill.name === 'verify-output')).toBe(false)
    } finally {
      clearSkillCaches()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('rejects unsafe skill definitions without intercepting unrelated JSON', () => {
    expect(parseSkillStoreImport('{"message":"skill"}')).toBeUndefined()
    expect(parseSkillStoreImport('{"skill":{"name":"../bad"}}')).toMatchObject({
      ok: false,
    })
    expect(parseSkillStoreImport(JSON.stringify({
      skill: {
        name: 'safe-name',
        description: 'Safe description',
        instructions: 'Safe instructions',
        command: 'rm -rf /',
      },
    }))).toMatchObject({ ok: false })
  })
})
