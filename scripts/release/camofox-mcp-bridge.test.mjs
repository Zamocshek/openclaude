import { afterEach, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const bridge = require('./camofox-mcp-bridge.cjs')
const previousAuthDir = process.env.OPENCLAUDE_CAMOFOX_AUTH_DIR
const temporaryDirectories = []

afterEach(() => {
  bridge.tabIdentityById.clear()
  if (previousAuthDir === undefined) {
    delete process.env.OPENCLAUDE_CAMOFOX_AUTH_DIR
  } else {
    process.env.OPENCLAUDE_CAMOFOX_AUTH_DIR = previousAuthDir
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Camofox MCP browser model tools', () => {
  test('registers profile management without starting the MCP server', () => {
    expect(bridge.tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining([
        'camofox_list_model_profiles',
        'camofox_set_model_profile',
        'camofox_remove_model_profile',
        'camofox_open_model_profile',
        'camofox_checkpoint_model_profile',
      ]),
    )
  })

  test('can add and list custom profiles without secrets', () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'openclaude-camofox-bridge-'),
    )
    temporaryDirectories.push(root)
    process.env.OPENCLAUDE_CAMOFOX_AUTH_DIR = root
    const created = JSON.parse(
      bridge.setModelProfile({
        id: 'custom-ai',
        label: 'Custom AI',
        url: 'https://models.example.com/chat',
        defaultModel: 'Frontier Preview',
      }),
    )
    expect(created.id).toBe('custom-ai')
    const listed = bridge.listModelProfiles()
    expect(listed).toContain('custom-ai')
    expect(listed).toContain(
      'bun run release:camofox:auth -- login custom-ai',
    )
    expect(listed).not.toContain('password')
    expect(listed).not.toContain('never-return-this')
    expect(listed).not.toContain('"token"')
  })

  test('routes known browser-model URLs through their persistent identity', () => {
    const profile = bridge.browserModelProfileForUrl(
      'https://chat.qwen.ai/c/existing-conversation',
    )
    const payload = bridge.tabPayload({
      url: 'https://chat.qwen.ai/c/existing-conversation',
    })

    expect(profile?.id).toBe('qwen')
    expect(payload).toEqual({
      userId: 'nova-qwen-max',
      sessionKey: 'qwen-collaboration',
    })
  })

  test('reuses the remembered identity for subsequent tab operations', () => {
    bridge.tabIdentityById.set('qwen-tab', {
      userId: 'nova-qwen-max',
      sessionKey: 'qwen-collaboration',
    })

    expect(bridge.tabPayload({}, 'qwen-tab')).toEqual({
      userId: 'nova-qwen-max',
      sessionKey: 'qwen-collaboration',
    })
  })
})
