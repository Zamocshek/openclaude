import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { getAgentGatewayStateDir } from './config.js'
import {
  importManagedMcpServers,
  removeManagedMcpServer,
  setManagedMcpServerEnabled,
} from './mcpRegistry.js'

const ANDROID_ALIAS = /^[a-z][a-z0-9-]{0,31}$/u
const ANDROID_TARGET = /^[A-Za-z0-9._:[\]-]{1,255}$/u
const ANDROID_PAIRING_CODE = /^[0-9]{4,12}$/u
const ADB_TIMEOUT_MS = 15_000
const ADB_OUTPUT_LIMIT = 256 * 1024

export type AndroidConnectionType = 'auto' | 'usb' | 'wifi'

export type AndroidDeviceProfile = {
  alias: string
  serial: string
  connection: AndroidConnectionType
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type AndroidDeviceRegistry = {
  version: 1
  activeAlias?: string
  profiles: Record<string, AndroidDeviceProfile>
}

export type AndroidDiscoveredDevice = {
  serial: string
  state: string
  connection: 'usb' | 'wifi' | 'emulator'
  details: Record<string, string>
}

export type AndroidDeviceCheck = {
  alias?: string
  serial: string
  connection: AndroidConnectionType
  state: string
  model?: string
  manufacturer?: string
  androidVersion?: string
  sdk?: string
}

export class AndroidDeviceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AndroidDeviceError'
  }
}

let registryMutationTail: Promise<void> = Promise.resolve()

export function getAndroidDeviceRegistryPath(): string {
  return join(getAgentGatewayStateDir(), 'android', 'devices.json')
}

export function normalizeAndroidAlias(value: string): string {
  const alias = String(value || '').trim().toLowerCase()
  if (!ANDROID_ALIAS.test(alias)) {
    throw new AndroidDeviceError(
      'Android alias must use 1-32 lowercase letters, digits, or dashes and start with a letter.',
    )
  }
  return alias
}

export function normalizeAndroidTarget(
  value: string,
  connection: AndroidConnectionType = 'auto',
): string {
  let target = String(value || '').trim()
  if (!target || !ANDROID_TARGET.test(target) || target.startsWith('-')) {
    throw new AndroidDeviceError(
      'Android target must be an ADB serial or host[:port] without spaces.',
    )
  }
  if (
    connection === 'wifi'
    && !target.startsWith('[')
    && !target.includes(':')
  ) {
    target = `${target}:5555`
  }
  return target
}

export function normalizeAndroidConnection(
  value: unknown,
): AndroidConnectionType {
  const connection = String(value || 'auto').trim().toLowerCase()
  if (connection === 'auto' || connection === 'usb' || connection === 'wifi') {
    return connection
  }
  throw new AndroidDeviceError('Android connection must be auto, usb, or wifi.')
}

export function parseAdbDevicesOutput(
  output: string,
): AndroidDiscoveredDevice[] {
  const devices: AndroidDiscoveredDevice[] = []
  for (const rawLine of String(output || '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (
      !line
      || line.startsWith('*')
      || /^list of devices attached$/iu.test(line)
    ) {
      continue
    }
    const parts = line.split(/\s+/u)
    if (parts.length < 2) continue
    const serial = parts.shift()!
    const state = parts.shift()!
    const details: Record<string, string> = {}
    for (const part of parts) {
      const separator = part.indexOf(':')
      if (separator > 0) {
        details[part.slice(0, separator)] = part.slice(separator + 1)
      }
    }
    devices.push({
      serial,
      state,
      connection: serial.startsWith('emulator-')
        ? 'emulator'
        : serial.includes(':')
          ? 'wifi'
          : 'usb',
      details,
    })
  }
  return devices
}

export async function listAndroidDeviceProfiles(): Promise<AndroidDeviceRegistry> {
  return readRegistry()
}

export async function registerAndroidDeviceProfile(input: {
  projectRoot: string
  alias: string
  serial: string
  connection?: AndroidConnectionType | string
  enabled?: boolean
  makeActive?: boolean
}): Promise<AndroidDeviceRegistry> {
  return withRegistryLock(async () => {
    const registry = await readRegistry()
    const alias = normalizeAndroidAlias(input.alias)
    const connection = normalizeAndroidConnection(input.connection)
    const serial = normalizeAndroidTarget(input.serial, connection)
    const now = new Date().toISOString()
    const previous = registry.profiles[alias]
    registry.profiles[alias] = {
      alias,
      serial,
      connection,
      enabled: input.enabled !== false,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    }
    if (
      input.makeActive === true
      || !registry.activeAlias
      || !registry.profiles[registry.activeAlias]?.enabled
    ) {
      registry.activeAlias = alias
    }
    await syncAndroidProfileMcp(input.projectRoot, registry.profiles[alias]!)
    await writeRegistry(registry)
    return registry
  })
}

export async function setActiveAndroidDeviceProfile(
  aliasInput: string,
): Promise<AndroidDeviceRegistry> {
  return withRegistryLock(async () => {
    const registry = await readRegistry()
    const alias = normalizeAndroidAlias(aliasInput)
    const profile = registry.profiles[alias]
    if (!profile) throw new AndroidDeviceError(`Android profile not found: ${alias}`)
    if (!profile.enabled) {
      throw new AndroidDeviceError(`Android profile is disabled: ${alias}`)
    }
    registry.activeAlias = alias
    profile.updatedAt = new Date().toISOString()
    await writeRegistry(registry)
    return registry
  })
}

export async function setAndroidDeviceProfileEnabled(
  projectRoot: string,
  aliasInput: string,
  enabled: boolean,
): Promise<AndroidDeviceRegistry> {
  return withRegistryLock(async () => {
    const registry = await readRegistry()
    const alias = normalizeAndroidAlias(aliasInput)
    const profile = registry.profiles[alias]
    if (!profile) throw new AndroidDeviceError(`Android profile not found: ${alias}`)
    profile.enabled = enabled
    profile.updatedAt = new Date().toISOString()
    if (!enabled && registry.activeAlias === alias) {
      registry.activeAlias = Object.values(registry.profiles)
        .find(candidate => candidate.enabled && candidate.alias !== alias)
        ?.alias
    } else if (enabled && !registry.activeAlias) {
      registry.activeAlias = alias
    }
    await setManagedMcpServerEnabled(
      projectRoot,
      androidMcpServerName(alias),
      enabled,
    )
    await writeRegistry(registry)
    return registry
  })
}

export async function removeAndroidDeviceProfile(
  projectRoot: string,
  aliasInput: string,
): Promise<AndroidDeviceRegistry> {
  return withRegistryLock(async () => {
    const registry = await readRegistry()
    const alias = normalizeAndroidAlias(aliasInput)
    if (!registry.profiles[alias]) {
      throw new AndroidDeviceError(`Android profile not found: ${alias}`)
    }
    await removeManagedMcpServer(projectRoot, androidMcpServerName(alias))
    delete registry.profiles[alias]
    if (registry.activeAlias === alias) {
      registry.activeAlias = Object.values(registry.profiles)
        .find(profile => profile.enabled)
        ?.alias
    }
    await writeRegistry(registry)
    return registry
  })
}

export function androidMcpServerName(aliasInput: string): string {
  return `android-${normalizeAndroidAlias(aliasInput)}`
}

export function buildAndroidProfileMcpConfig(
  profile: AndroidDeviceProfile,
): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  return {
    command: 'node',
    args: ['scripts/android-mcp-launcher.cjs'],
    env: {
      OPENCLAUDE_AGENT_GATEWAY_STATE_DIR:
        '${OPENCLAUDE_AGENT_GATEWAY_STATE_DIR}',
      ANDROID_MCP_DEVICE: profile.serial,
      ANDROID_MCP_CONNECTION: profile.connection,
      ANDROID_MCP_BIN: '${ANDROID_MCP_BIN}',
      ADB_SERVER_SOCKET: '${ADB_SERVER_SOCKET}',
      SCREENSHOT_QUANTIZED: '${ANDROID_MCP_SCREENSHOT_QUANTIZED}',
    },
  }
}

export async function discoverAndroidDevices(): Promise<AndroidDiscoveredDevice[]> {
  const result = await runAdb(['devices', '-l'])
  return parseAdbDevicesOutput(result.stdout)
}

export async function pairAndroidDevice(
  targetInput: string,
  pairingCodeInput: string,
): Promise<{ target: string; message: string }> {
  const target = normalizeAndroidTarget(targetInput, 'wifi')
  const pairingCode = String(pairingCodeInput || '').trim()
  if (!ANDROID_PAIRING_CODE.test(pairingCode)) {
    throw new AndroidDeviceError('ADB pairing code must contain 4-12 digits.')
  }
  const result = await runAdb(['pair', target, pairingCode])
  return {
    target,
    message: sanitizeAdbMessage(result.stdout || result.stderr),
  }
}

export async function connectAndroidDevice(
  identifier: string,
): Promise<AndroidDeviceCheck> {
  const registry = await readRegistry()
  const profile = resolveProfile(registry, identifier)
  const serial = profile
    ? profile.serial
    : normalizeAndroidTarget(identifier, identifier.includes(':') ? 'wifi' : 'auto')
  const connection = profile?.connection
    || (serial.includes(':') ? 'wifi' : 'auto')
  if (connection === 'wifi' || serial.includes(':')) {
    await runAdb(['connect', serial])
  }
  return checkAndroidDevice(profile?.alias || serial)
}

export async function disconnectAndroidDevice(
  identifier: string,
): Promise<{ serial: string; message: string }> {
  const registry = await readRegistry()
  const profile = resolveProfile(registry, identifier)
  const serial = profile
    ? profile.serial
    : normalizeAndroidTarget(identifier, identifier.includes(':') ? 'wifi' : 'auto')
  if (!serial.includes(':') && profile?.connection !== 'wifi') {
    throw new AndroidDeviceError(
      'ADB disconnect is only supported for WiFi targets; unplug or revoke USB debugging for USB devices.',
    )
  }
  const result = await runAdb(['disconnect', serial])
  return {
    serial,
    message: sanitizeAdbMessage(result.stdout || result.stderr),
  }
}

export async function checkAndroidDevice(
  identifier?: string,
): Promise<AndroidDeviceCheck> {
  const registry = await readRegistry()
  const profile = resolveProfile(
    registry,
    identifier || registry.activeAlias || '',
  )
  if (!profile && !identifier) {
    throw new AndroidDeviceError(
      'No active Android profile. Register one or pass an ADB serial.',
    )
  }
  const serial = profile
    ? profile.serial
    : normalizeAndroidTarget(String(identifier), 'auto')
  const connection = profile?.connection
    || (serial.includes(':') ? 'wifi' : 'auto')
  const state = (await runAdb(['-s', serial, 'get-state'])).stdout.trim()
  const properties = await Promise.all([
    readAndroidProperty(serial, 'ro.product.model'),
    readAndroidProperty(serial, 'ro.product.manufacturer'),
    readAndroidProperty(serial, 'ro.build.version.release'),
    readAndroidProperty(serial, 'ro.build.version.sdk'),
  ])
  return {
    ...(profile ? { alias: profile.alias } : {}),
    serial,
    connection,
    state: state || 'unknown',
    ...(properties[0] ? { model: properties[0] } : {}),
    ...(properties[1] ? { manufacturer: properties[1] } : {}),
    ...(properties[2] ? { androidVersion: properties[2] } : {}),
    ...(properties[3] ? { sdk: properties[3] } : {}),
  }
}

async function readAndroidProperty(
  serial: string,
  property: string,
): Promise<string> {
  try {
    return (await runAdb(['-s', serial, 'shell', 'getprop', property]))
      .stdout
      .trim()
      .slice(0, 256)
  } catch {
    return ''
  }
}

function resolveProfile(
  registry: AndroidDeviceRegistry,
  identifierInput: string,
): AndroidDeviceProfile | undefined {
  const identifier = String(identifierInput || '').trim()
  if (!identifier) return undefined
  const byAlias = registry.profiles[identifier.toLowerCase()]
  if (byAlias) return byAlias
  return Object.values(registry.profiles)
    .find(profile => profile.serial === identifier)
}

function emptyRegistry(): AndroidDeviceRegistry {
  return { version: 1, profiles: {} }
}

async function syncAndroidProfileMcp(
  projectRoot: string,
  profile: AndroidDeviceProfile,
): Promise<void> {
  await importManagedMcpServers(projectRoot, {
    mcpServers: {
      [androidMcpServerName(profile.alias)]:
        buildAndroidProfileMcpConfig(profile),
    },
  })
  if (!profile.enabled) {
    await setManagedMcpServerEnabled(
      projectRoot,
      androidMcpServerName(profile.alias),
      false,
    )
  }
}

async function readRegistry(): Promise<AndroidDeviceRegistry> {
  try {
    const parsed = JSON.parse(
      await readFile(getAndroidDeviceRegistryPath(), 'utf8'),
    ) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyRegistry()
    }
    const raw = parsed as Record<string, unknown>
    const rawProfiles = raw.profiles
    if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) {
      return emptyRegistry()
    }
    const profiles: Record<string, AndroidDeviceProfile> = {}
    for (const [rawAlias, rawProfile] of Object.entries(rawProfiles)) {
      if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue
      try {
        const profile = rawProfile as Record<string, unknown>
        const alias = normalizeAndroidAlias(rawAlias)
        const connection = normalizeAndroidConnection(profile.connection)
        profiles[alias] = {
          alias,
          serial: normalizeAndroidTarget(String(profile.serial || ''), connection),
          connection,
          enabled: profile.enabled !== false,
          createdAt: normalizeTimestamp(profile.createdAt),
          updatedAt: normalizeTimestamp(profile.updatedAt),
        }
      } catch {
        // Ignore malformed entries instead of breaking the complete registry.
      }
    }
    const requestedActive = String(raw.activeAlias || '').trim().toLowerCase()
    const activeAlias = profiles[requestedActive]?.enabled
      ? requestedActive
      : Object.values(profiles).find(profile => profile.enabled)?.alias
    return {
      version: 1,
      ...(activeAlias ? { activeAlias } : {}),
      profiles,
    }
  } catch {
    return emptyRegistry()
  }
}

function normalizeTimestamp(value: unknown): string {
  const text = String(value || '')
  return Number.isFinite(Date.parse(text)) ? text : new Date(0).toISOString()
}

async function writeRegistry(registry: AndroidDeviceRegistry): Promise<void> {
  const path = getAndroidDeviceRegistryPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = registryMutationTail
  let release!: () => void
  registryMutationTail = new Promise<void>(resolve => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
  }
}

async function runAdb(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const command = String(process.env.ANDROID_ADB_COMMAND || 'adb').trim()
  if (!command) throw new AndroidDeviceError('ANDROID_ADB_COMMAND cannot be empty.')
  const env = { ...process.env }
  if (!String(env.ADB_SERVER_SOCKET || '').trim()) {
    delete env.ADB_SERVER_SOCKET
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(new AndroidDeviceError(`ADB timed out after ${ADB_TIMEOUT_MS / 1000}s.`))
    }, ADB_TIMEOUT_MS)
    timer.unref?.()

    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-ADB_OUTPUT_LIMIT)
    child.stdout?.on('data', chunk => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr = append(stderr, chunk)
    })
    child.once('error', error => {
      finish(new AndroidDeviceError(
        error && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'ADB is not installed or is not available on PATH.'
          : `ADB failed to start: ${error.message}`,
      ))
    })
    child.once('close', code => {
      if (code === 0) {
        finish(undefined, { stdout, stderr })
        return
      }
      finish(new AndroidDeviceError(
        sanitizeAdbMessage(stderr || stdout)
          || `ADB exited with code ${code ?? 'unknown'}.`,
      ))
    })

    function finish(
      error?: Error,
      result?: { stdout: string; stderr: string },
    ): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result!)
    }
  })
}

function sanitizeAdbMessage(value: string): string {
  return String(value || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000)
}
