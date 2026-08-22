import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

const STATE_AUTHORITY = 'capability-router'
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

type CapabilityRouterState = Record<string, unknown> & {
  schemaVersion?: number
  revision?: number
  disabledServers?: unknown
  mcpEnablementAuthority?: unknown
}

export type CapabilityRouterMcpState = {
  authoritative: boolean
  disabledServers: Set<string>
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map(item => String(item || '').trim())
    .filter(Boolean))]
    .sort()
}

export function resolveCapabilityRouterStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    env.CAPABILITY_ROUTER_STATE?.trim()
      || join(homedir(), '.capability-router', 'state.json'),
  )
}

function readState(path: string): CapabilityRouterState {
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed)) throw new Error(`Capability Router state must be an object: ${path}`)
  return parsed
}

function replaceFileAtomic(temporary: string, target: string): void {
  try {
    renameSync(temporary, target)
  } catch (error) {
    if (process.platform !== 'win32' || !existsSync(target)) {
      rmSync(temporary, { force: true })
      throw error
    }
    rmSync(target, { force: true })
    renameSync(temporary, target)
  }
}

function writeStateAtomic(path: string, state: CapabilityRouterState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  replaceFileAtomic(temporary, path)
}

function withStateLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock: ${lockPath}`)
      }
      Atomics.wait(lockWaitBuffer, 0, 0, 15)
    }
  }

  try {
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8')
    return operation()
  } finally {
    closeSync(descriptor)
    rmSync(lockPath, { force: true })
  }
}

export function readCapabilityRouterMcpState(
  env: NodeJS.ProcessEnv = process.env,
): CapabilityRouterMcpState {
  const path = resolveCapabilityRouterStatePath(env)
  const state = readState(path)
  return {
    authoritative: state.mcpEnablementAuthority === STATE_AUTHORITY,
    disabledServers: new Set(normalizeNames(state.disabledServers)),
    path,
  }
}

export function updateCapabilityRouterServerEnablement(
  names: readonly string[],
  enabled: boolean,
  legacyDisabledServers: Iterable<string> = [],
  env: NodeJS.ProcessEnv = process.env,
): CapabilityRouterMcpState {
  const path = resolveCapabilityRouterStatePath(env)
  return withStateLock(path, () => {
    const state = readState(path)
    const disabled = new Set(normalizeNames(state.disabledServers))
    if (state.mcpEnablementAuthority !== STATE_AUTHORITY) {
      for (const name of legacyDisabledServers) {
        const normalized = String(name || '').trim()
        if (normalized) disabled.add(normalized)
      }
    }
    for (const name of names) {
      const normalized = String(name || '').trim()
      if (!normalized) continue
      if (enabled) disabled.delete(normalized)
      else disabled.add(normalized)
    }
    state.schemaVersion = Number.isFinite(Number(state.schemaVersion))
      ? Number(state.schemaVersion)
      : 2
    state.revision = (Number.isFinite(Number(state.revision))
      ? Number(state.revision)
      : 0) + 1
    state.updatedAt = new Date().toISOString()
    state.disabledServers = [...disabled].sort()
    state.mcpEnablementAuthority = STATE_AUTHORITY
    writeStateAtomic(path, state)
    return {
      authoritative: true,
      disabledServers: disabled,
      path,
    }
  })
}
