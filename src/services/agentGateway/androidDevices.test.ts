import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  listAndroidDeviceProfiles,
  androidMcpServerName,
  buildAndroidProfileMcpConfig,
  normalizeAndroidAlias,
  normalizeAndroidTarget,
  parseAdbDevicesOutput,
  registerAndroidDeviceProfile,
  removeAndroidDeviceProfile,
  setActiveAndroidDeviceProfile,
  setAndroidDeviceProfileEnabled,
} from './androidDevices.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  await Promise.all(
    temporaryPaths.splice(0).map(path =>
      rm(path, { recursive: true, force: true })
    ),
  )
})

async function useTemporaryState(): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), 'openclaude-android-state-'))
  const project = await mkdtemp(join(tmpdir(), 'openclaude-android-project-'))
  temporaryPaths.push(state, project)
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
  await writeFile(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: {} }),
  )
  return project
}

describe('Android device registry', () => {
  test('parses physical, WiFi, emulator, and unauthorized ADB devices', () => {
    expect(parseAdbDevicesOutput(`
List of devices attached
RFCN2013V8D device product:beyond model:Galaxy_S10 transport_id:1
192.168.1.8:5555 device product:pixel model:Pixel_8 transport_id:2
emulator-5554 device product:sdk model:sdk_gphone transport_id:3
ABC123 unauthorized usb:1-2 transport_id:4
    `)).toEqual([
      {
        serial: 'RFCN2013V8D',
        state: 'device',
        connection: 'usb',
        details: {
          product: 'beyond',
          model: 'Galaxy_S10',
          transport_id: '1',
        },
      },
      {
        serial: '192.168.1.8:5555',
        state: 'device',
        connection: 'wifi',
        details: {
          product: 'pixel',
          model: 'Pixel_8',
          transport_id: '2',
        },
      },
      {
        serial: 'emulator-5554',
        state: 'device',
        connection: 'emulator',
        details: {
          product: 'sdk',
          model: 'sdk_gphone',
          transport_id: '3',
        },
      },
      {
        serial: 'ABC123',
        state: 'unauthorized',
        connection: 'usb',
        details: { usb: '1-2', transport_id: '4' },
      },
    ])
  })

  test('normalizes aliases and WiFi targets without accepting command syntax', () => {
    expect(normalizeAndroidAlias(' Work-Phone ')).toBe('work-phone')
    expect(normalizeAndroidTarget('192.168.1.8', 'wifi'))
      .toBe('192.168.1.8:5555')
    expect(normalizeAndroidTarget('RFCN2013V8D', 'usb'))
      .toBe('RFCN2013V8D')
    expect(() => normalizeAndroidAlias('../phone')).toThrow()
    expect(() => normalizeAndroidTarget('--help', 'auto')).toThrow()
    expect(() => normalizeAndroidTarget('host;whoami', 'wifi')).toThrow()
  })

  test('persists multiple profiles, active selection, enable state, and removal', async () => {
    const projectRoot = await useTemporaryState()
    let registry = await registerAndroidDeviceProfile({
      projectRoot,
      alias: 'personal',
      serial: 'RFCN2013V8D',
      connection: 'usb',
    })
    expect(registry.activeAlias).toBe('personal')

    registry = await registerAndroidDeviceProfile({
      projectRoot,
      alias: 'lab-phone',
      serial: '192.168.1.8',
      connection: 'wifi',
    })
    expect(registry.profiles['lab-phone']?.serial).toBe('192.168.1.8:5555')

    registry = await setActiveAndroidDeviceProfile('lab-phone')
    expect(registry.activeAlias).toBe('lab-phone')

    registry = await setAndroidDeviceProfileEnabled(
      projectRoot,
      'lab-phone',
      false,
    )
    expect(registry.activeAlias).toBe('personal')
    expect(registry.profiles['lab-phone']?.enabled).toBe(false)

    registry = await removeAndroidDeviceProfile(projectRoot, 'personal')
    expect(registry.profiles.personal).toBeUndefined()
    expect((await listAndroidDeviceProfiles()).profiles['lab-phone'])
      .toBeDefined()
  })

  test('creates one pinned MCP server definition per profile', () => {
    const profile = {
      alias: 'lab-phone',
      serial: '192.168.1.8:5555',
      connection: 'wifi' as const,
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    expect(androidMcpServerName(profile.alias)).toBe('android-lab-phone')
    expect(buildAndroidProfileMcpConfig(profile)).toMatchObject({
      command: 'node',
      args: ['scripts/android-mcp-launcher.cjs'],
      env: {
        ANDROID_MCP_DEVICE: '192.168.1.8:5555',
        ANDROID_MCP_CONNECTION: 'wifi',
      },
    })
  })
})
