import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getAgentGatewayStateDir } from './config.js'

const ROUTER_AUDIT_FILE = 'tool-router-audit.json'
const MAX_ROUTER_AUDIT_ENTRIES = 100

export type ToolRouterAuditEntry = {
  id: string
  timestamp: string
  action: string
  target: string
  detail?: string
}

let pendingWrite = Promise.resolve()

export async function listToolRouterAudit(
  limit = 50,
): Promise<ToolRouterAuditEntry[]> {
  await pendingWrite
  const entries = await readAuditFile()
  return entries.slice(0, clampLimit(limit))
}

export async function recordToolRouterAudit(input: {
  action: string
  target: string
  detail?: string
}): Promise<void> {
  const entry: ToolRouterAuditEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    action: input.action,
    target: input.target,
    ...(input.detail ? { detail: input.detail } : {}),
  }
  pendingWrite = pendingWrite
    .catch(() => undefined)
    .then(async () => {
      const entries = await readAuditFile()
      entries.unshift(entry)
      await mkdir(getAgentGatewayStateDir(), { recursive: true })
      await writeFile(
        join(getAgentGatewayStateDir(), ROUTER_AUDIT_FILE),
        `${JSON.stringify(entries.slice(0, MAX_ROUTER_AUDIT_ENTRIES), null, 2)}\n`,
        'utf8',
      )
    })
  await pendingWrite
}

async function readAuditFile(): Promise<ToolRouterAuditEntry[]> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(getAgentGatewayStateDir(), ROUTER_AUDIT_FILE), 'utf8'),
    )
    if (!Array.isArray(value)) return []
    return value.filter(isAuditEntry)
  } catch {
    return []
  }
}

function isAuditEntry(value: unknown): value is ToolRouterAuditEntry {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ToolRouterAuditEntry>
  return (
    typeof item.id === 'string' &&
    typeof item.timestamp === 'string' &&
    typeof item.action === 'string' &&
    typeof item.target === 'string' &&
    (item.detail === undefined || typeof item.detail === 'string')
  )
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.max(1, Math.min(MAX_ROUTER_AUDIT_ENTRIES, Math.floor(value)))
}
