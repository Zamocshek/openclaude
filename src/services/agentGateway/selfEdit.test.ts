import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { selfWrite } from './selfEdit.js'

describe('agent gateway self edit path containment', () => {
  test('rejects writes outside the project root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'openclaude-self-edit-outside-'))
    const outsidePath = resolve(outsideDir, 'escape.txt')
    try {
      await expect(selfWrite(outsidePath, 'escape')).rejects.toThrow(
        /must stay inside project root/,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
