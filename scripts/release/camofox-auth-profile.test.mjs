import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  QWEN_PROFILE,
  isQwenChatUrl,
  resolveAuthPaths,
  snapshotShowsQwenModel,
  summarizeStorageState,
} from './camofox-auth-profile.mjs'

describe('Camofox Qwen auth profile', () => {
  test('keeps persistent profile data outside the repository', () => {
    const paths = resolveAuthPaths({}, 'C:\\Users\\tester')
    expect(paths.profileDir).toBe(
      path.join('C:\\Users\\tester', '.camofox', 'profiles'),
    )
    expect(paths.authDir).toBe(
      path.join('C:\\Users\\tester', '.openclaude', 'camofox-auth'),
    )
    expect(paths.statusPath).not.toContain('storage-state')
  })

  test('uses the pinned Qwen identity and reports only storage counts', () => {
    expect(QWEN_PROFILE.userId).toBe('nova-qwen-max')
    expect(QWEN_PROFILE.model).toBe('Qwen3.8-Max-Preview')
    expect(
      snapshotShowsQwenModel('option "Qwen3.8-Max-Preview"'),
    ).toBe(true)
    expect(isQwenChatUrl('https://chat.qwen.ai/c/123')).toBe(true)
    expect(isQwenChatUrl('https://accounts.google.com/signin')).toBe(false)
    expect(
      summarizeStorageState({
        cookies: [{ name: 'secret', value: 'never-return-this' }],
        origins: [{ origin: 'https://chat.qwen.ai' }],
      }),
    ).toEqual({ cookies: 1, origins: 1 })
  })
})
