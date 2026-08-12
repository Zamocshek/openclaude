/**
 * Durable goals for the agent execution loop.
 *
 * A goal is deliberately separate from conversation memory and an individual
 * agent process. A process may be stopped or the gateway restarted without
 * losing the objective, while a new explicit /loop start can resume it.
 */

import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getAgentGatewayStateDir } from './config.js'

export type AgentGoalStatus = 'pursuing' | 'achieved' | 'blocked' | 'cancelled'

export type AgentGoalLoopStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'failed'

export type AgentGoal = {
  id: string
  chatId: string
  objective: string
  status: AgentGoalStatus
  loopStatus: AgentGoalLoopStatus
  createdAt: string
  updatedAt: string
  loopRuns: number
  totalIterations: number
  lastLoopAt?: string
  lastTaskId?: string
  lastOutcome?: string
  lastError?: string
}

type AgentGoalStore = {
  version: 1
  goals: Record<string, AgentGoal>
}

export type GoalLoopResult = {
  taskId: string
  status: 'completed' | 'blocked' | 'failed' | 'cancelled'
  iterations: number
  outcome?: string
  error?: string
}

const MAX_OBJECTIVE_CHARS = 12_000
const MAX_OUTCOME_CHARS = 4_000
const MAX_ERROR_CHARS = 2_000

let mutationTail: Promise<void> = Promise.resolve()

export function getAgentGoalStorePath(): string {
  return join(getAgentGatewayStateDir(), 'goals', 'telegram-goals.json')
}

export async function getAgentGoal(chatId: string): Promise<AgentGoal | undefined> {
  const store = await loadGoalStore()
  const goal = store.goals[chatId]
  return goal ? { ...goal } : undefined
}

export async function setAgentGoal(input: {
  chatId: string
  objective: string
}): Promise<AgentGoal> {
  const chatId = String(input.chatId || '').trim()
  const objective = normalizeObjective(input.objective)
  if (!chatId) throw new Error('A chat id is required for a persistent goal.')
  if (!objective) throw new Error('A goal needs a non-empty objective.')

  return mutateGoalStore(store => {
    const now = new Date().toISOString()
    const goal: AgentGoal = {
      id: `goal_${randomUUID().replace(/-/g, '')}`,
      chatId,
      objective,
      status: 'pursuing',
      loopStatus: 'idle',
      createdAt: now,
      updatedAt: now,
      loopRuns: 0,
      totalIterations: 0,
    }
    store.goals[chatId] = goal
    return { store, result: { ...goal } }
  })
}

export async function clearAgentGoal(chatId: string): Promise<boolean> {
  return mutateGoalStore(store => {
    if (!store.goals[chatId]) return { store, result: false }
    delete store.goals[chatId]
    return { store, result: true }
  })
}

export async function requestAgentGoalLoop(
  chatId: string,
  goalId: string,
): Promise<AgentGoal | undefined> {
  return mutateGoalForChat(chatId, goalId, goal => {
    if (goal.status === 'achieved' || goal.status === 'cancelled') return undefined
    goal.status = 'pursuing'
    goal.loopStatus = 'queued'
    goal.updatedAt = new Date().toISOString()
    return goal
  })
}

export async function markAgentGoalLoopStarted(
  chatId: string,
  goalId: string,
  taskId: string,
): Promise<AgentGoal | undefined> {
  return mutateGoalForChat(chatId, goalId, goal => {
    if (goal.loopStatus !== 'queued' || goal.status !== 'pursuing') return undefined
    goal.loopStatus = 'running'
    goal.loopRuns += 1
    goal.lastLoopAt = new Date().toISOString()
    goal.lastTaskId = taskId
    goal.updatedAt = goal.lastLoopAt
    return goal
  })
}

export async function pauseAgentGoalLoop(
  chatId: string,
  goalId?: string,
): Promise<AgentGoal | undefined> {
  return mutateGoalForChat(chatId, goalId, goal => {
    if (goal.status !== 'pursuing') return goal
    goal.loopStatus = 'paused'
    goal.updatedAt = new Date().toISOString()
    return goal
  })
}

export async function finishAgentGoalLoop(
  chatId: string,
  goalId: string,
  result: GoalLoopResult,
): Promise<AgentGoal | undefined> {
  return mutateGoalForChat(chatId, goalId, goal => {
    // A new goal may have replaced this loop while it was finishing.
    if (goal.id !== goalId) return undefined

    goal.totalIterations += Math.max(0, Math.floor(result.iterations || 0))
    goal.lastTaskId = result.taskId
    goal.updatedAt = new Date().toISOString()
    if (result.outcome?.trim()) {
      goal.lastOutcome = result.outcome.trim().slice(0, MAX_OUTCOME_CHARS)
    }
    if (result.error?.trim()) {
      goal.lastError = result.error.trim().slice(0, MAX_ERROR_CHARS)
    } else {
      delete goal.lastError
    }

    switch (result.status) {
      case 'completed':
        goal.status = 'achieved'
        goal.loopStatus = 'completed'
        break
      case 'blocked':
      case 'failed':
        goal.status = 'blocked'
        goal.loopStatus = result.status === 'blocked' ? 'blocked' : 'failed'
        break
      case 'cancelled':
        // /stop halts the execution, not the durable goal. It can be resumed.
        if (goal.status === 'pursuing') goal.loopStatus = 'paused'
        break
    }
    return goal
  })
}

/**
 * A worker process cannot survive a gateway restart. Demote stale loop leases
 * so the owner can explicitly resume rather than creating a ghost execution.
 */
export async function recoverInterruptedAgentGoalLoops(): Promise<number> {
  return mutateGoalStore(store => {
    let recovered = 0
    const now = new Date().toISOString()
    for (const goal of Object.values(store.goals)) {
      if (goal.status !== 'pursuing') continue
      if (goal.loopStatus !== 'queued' && goal.loopStatus !== 'running') continue
      goal.loopStatus = 'paused'
      goal.updatedAt = now
      goal.lastError = 'Loop was interrupted by a gateway restart; resume explicitly with /loop start.'
      recovered += 1
    }
    return { store, result: recovered }
  })
}

export function formatAgentGoal(goal: AgentGoal | undefined): string {
  if (!goal) {
    return [
      'No active goal for this chat.',
      'Set one with: /goal <objective>',
    ].join('\n')
  }

  const lines = [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Loop: ${goal.loopStatus}`,
    `Runs: ${goal.loopRuns}; iterations: ${goal.totalIterations}`,
    `Created: ${goal.createdAt.slice(0, 19)}`,
  ]
  if (goal.lastLoopAt) lines.push(`Last loop: ${goal.lastLoopAt.slice(0, 19)}`)
  if (goal.lastOutcome) lines.push(`Last outcome: ${goal.lastOutcome.slice(0, 700)}`)
  if (goal.lastError) lines.push(`Last blocker: ${goal.lastError.slice(0, 700)}`)
  lines.push('', 'Commands: /loop start | /loop stop | /goal clear')
  return lines.join('\n')
}

async function loadGoalStore(): Promise<AgentGoalStore> {
  try {
    const raw = await readFile(getAgentGoalStorePath(), 'utf8')
    return normalizeGoalStore(JSON.parse(raw))
  } catch {
    return { version: 1, goals: {} }
  }
}

function normalizeGoalStore(value: unknown): AgentGoalStore {
  const rawGoals = value && typeof value === 'object'
    ? (value as { goals?: unknown }).goals
    : undefined
  const goals: Record<string, AgentGoal> = {}
  if (rawGoals && typeof rawGoals === 'object') {
    for (const [chatId, rawGoal] of Object.entries(rawGoals)) {
      const goal = normalizeGoal(chatId, rawGoal)
      if (goal) goals[chatId] = goal
    }
  }
  return { version: 1, goals }
}

function normalizeGoal(chatId: string, value: unknown): AgentGoal | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<AgentGoal>
  const objective = normalizeObjective(raw.objective || '')
  if (!objective) return undefined
  const status: AgentGoalStatus = ['pursuing', 'achieved', 'blocked', 'cancelled']
    .includes(String(raw.status))
    ? raw.status as AgentGoalStatus
    : 'pursuing'
  const loopStatus: AgentGoalLoopStatus = [
    'idle', 'queued', 'running', 'paused', 'completed', 'blocked', 'failed',
  ].includes(String(raw.loopStatus))
    ? raw.loopStatus as AgentGoalLoopStatus
    : 'idle'
  const now = new Date().toISOString()
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `goal_${randomUUID().replace(/-/g, '')}`,
    chatId,
    objective,
    status,
    loopStatus,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    loopRuns: normalizeCount(raw.loopRuns),
    totalIterations: normalizeCount(raw.totalIterations),
    ...(typeof raw.lastLoopAt === 'string' ? { lastLoopAt: raw.lastLoopAt } : {}),
    ...(typeof raw.lastTaskId === 'string' ? { lastTaskId: raw.lastTaskId } : {}),
    ...(typeof raw.lastOutcome === 'string'
      ? { lastOutcome: raw.lastOutcome.slice(0, MAX_OUTCOME_CHARS) }
      : {}),
    ...(typeof raw.lastError === 'string'
      ? { lastError: raw.lastError.slice(0, MAX_ERROR_CHARS) }
      : {}),
  }
}

function normalizeObjective(value: string): string {
  return String(value || '').trim().slice(0, MAX_OBJECTIVE_CHARS)
}

function normalizeCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

async function mutateGoalForChat(
  chatId: string,
  expectedGoalId: string | undefined,
  update: (goal: AgentGoal) => AgentGoal | undefined,
): Promise<AgentGoal | undefined> {
  return mutateGoalStore(store => {
    const goal = store.goals[chatId]
    if (!goal || (expectedGoalId && goal.id !== expectedGoalId)) {
      return { store, result: undefined }
    }
    const next = update(goal)
    if (!next) return { store, result: undefined }
    store.goals[chatId] = next
    return { store, result: { ...next } }
  })
}

function mutateGoalStore<T>(
  mutation: (store: AgentGoalStore) => { store: AgentGoalStore; result: T },
): Promise<T> {
  const run = mutationTail.then(async () => {
    const current = await loadGoalStore()
    const next = mutation(current)
    await saveGoalStore(next.store)
    return next.result
  })
  mutationTail = run.then(() => undefined, () => undefined)
  return run
}

async function saveGoalStore(store: AgentGoalStore): Promise<void> {
  const path = getAgentGoalStorePath()
  await mkdir(join(getAgentGatewayStateDir(), 'goals'), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalizeGoalStore(store), null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
