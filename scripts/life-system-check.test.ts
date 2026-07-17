import { describe, expect, test } from 'bun:test'

import { checkLifeSystem } from './life-system-check.js'

describe('life system check', () => {
  test('validates the RPG operating system structure', async () => {
    const result = await checkLifeSystem()

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.checkedFiles).toBeGreaterThanOrEqual(16)
  })
})