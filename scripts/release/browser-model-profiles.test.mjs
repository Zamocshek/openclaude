import { afterEach, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  getBrowserModelProfile,
  listBrowserModelProfiles,
  removeBrowserModelProfile,
  resolveBrowserModelPaths,
  upsertBrowserModelProfile,
} = require('./browser-model-profiles.cjs')

const temporaryDirectories = []

function temporaryPaths() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'openclaude-browser-profiles-'),
  )
  temporaryDirectories.push(root)
  const authDir = path.join(root, 'auth')
  return {
    authDir,
    registryPath: path.join(authDir, 'profiles.json'),
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('browser model profiles', () => {
  test('ships useful built-ins and preserves the existing Qwen identity', () => {
    const paths = temporaryPaths()
    const profiles = listBrowserModelProfiles({ paths })
    expect(profiles.map(profile => profile.id)).toEqual(
      expect.arrayContaining([
        'qwen',
        'chatgpt',
        'claude',
        'gemini',
        'deepseek',
        'perplexity',
      ]),
    )
    const qwen = getBrowserModelProfile('qwen', { paths })
    expect(qwen.userId).toBe('nova-qwen-max')
    expect(qwen.sessionKey).toBe('qwen-collaboration')
    expect(qwen.defaultModel).toBe('Qwen3.8-Max-Preview')
  })

  test('persists custom routing metadata and restores builtin defaults', () => {
    const paths = temporaryPaths()
    const profile = upsertBrowserModelProfile(
      {
        id: 'qwen',
        label: 'Qwen Team',
        url: 'https://chat.qwen.ai/team',
        defaultModel: 'Team Model',
      },
      { paths },
    )
    expect(profile.label).toBe('Qwen Team')
    expect(profile.userId).toBe('nova-qwen-max')
    expect(profile.customized).toBe(true)
    expect(
      JSON.parse(readFileSync(paths.registryPath, 'utf8')).profiles,
    ).toHaveLength(1)

    expect(removeBrowserModelProfile('qwen', { paths })).toEqual({
      id: 'qwen',
      removed: true,
      restoredBuiltin: true,
    })
    expect(
      getBrowserModelProfile('qwen', { paths }).defaultModel,
    ).toBe('Qwen3.8-Max-Preview')
  })

  test('rejects credentials, unsafe external HTTP, and unsafe ids', () => {
    const paths = temporaryPaths()
    expect(() =>
      upsertBrowserModelProfile(
        {
          id: '../escape',
          label: 'Bad',
          url: 'https://example.com/',
        },
        { paths },
      ),
    ).toThrow('profile id')
    expect(() =>
      upsertBrowserModelProfile(
        {
          id: 'credentials',
          label: 'Bad',
          url: 'https://user:password@example.com/',
        },
        { paths },
      ),
    ).toThrow('must not contain credentials')
    expect(() =>
      upsertBrowserModelProfile(
        {
          id: 'plain-http',
          label: 'Bad',
          url: 'http://example.com/',
        },
        { paths },
      ),
    ).toThrow('must use HTTPS')
  })

  test('returns only sanitized authentication status', () => {
    const paths = temporaryPaths()
    mkdirSync(paths.authDir, { recursive: true })
    writeFileSync(
      path.join(paths.authDir, 'qwen-status.json'),
      JSON.stringify({
        phase: 'authenticated',
        authenticated: true,
        updatedAt: '2026-07-31T00:00:00.000Z',
        cookies: [{ name: 'secret', value: 'never-return' }],
        token: 'never-return',
      }),
    )
    const serialized = JSON.stringify(
      getBrowserModelProfile('qwen', { paths }),
    )
    expect(serialized).toContain('authenticated')
    expect(serialized).not.toContain('never-return')
    expect(serialized).not.toContain('"cookies"')
    expect(serialized).not.toContain('"token"')
  })

  test('supports a registry path override', () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'openclaude-browser-paths-'),
    )
    temporaryDirectories.push(root)
    const paths = resolveBrowserModelPaths(
      {
        OPENCLAUDE_CAMOFOX_AUTH_DIR: path.join(root, 'auth'),
        OPENCLAUDE_BROWSER_MODEL_REGISTRY: path.join(
          root,
          'config',
          'browser-models.json',
        ),
      },
      root,
    )
    expect(paths.registryPath).toBe(
      path.join(root, 'config', 'browser-models.json'),
    )
  })
})
