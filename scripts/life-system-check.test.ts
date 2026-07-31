import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  checkLifeSystem,
  REQUIRED_FILES,
} from './life-system-check.js'

describe('life system check', () => {
  test('validates the RPG operating system structure', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openclaude-life-system-'))
    try {
      for (const spec of REQUIRED_FILES) {
        const absolutePath = join(
          projectRoot,
          'Vladimir_Kuplevatskyi',
          spec.path,
        )
        await mkdir(join(absolutePath, '..'), { recursive: true })
        await writeFile(absolutePath, `${spec.mustContain.join('\n')}\n`, 'utf8')
      }

      const result = await checkLifeSystem(projectRoot)

      expect(result.ok).toBe(true)
      expect(result.issues).toEqual([])
      expect(result.checkedFiles).toBeGreaterThanOrEqual(16)
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
