import { createHash } from 'crypto'
import { redactAgentText } from './redaction.js'

const DEFAULT_AGENT_LOOP_REPEAT_LIMIT = 3
const MAX_AGENT_LOOP_SIGNATURES = 256
const SUCCESSFUL_LOOP_MIN_DURATION_MS = 60_000

export type AgentLoopProgressSnapshot = {
  evidence: string[]
  artifacts: string[]
  pendingInteractions: string[]
}

export type AgentToolCompletionObservation = {
  toolName: string
  toolInput: Record<string, unknown>
  success: boolean
  output: string
  turn: number
}

export type AgentLoopDetection = {
  count: number
  diagnostic: string
  signature: string
}

type RepetitionState = {
  count: number
  firstSeenAt: number
  lastTurn: number
  label: string
}

export class AgentLoopWatchdog {
  private readonly repeatLimit: number
  private readonly now: () => number
  private readonly seenProgress = new Set<string>()
  private readonly repetitions = new Map<string, RepetitionState>()
  private readonly routeRepetitions = new Map<string, RepetitionState>()
  private readonly failedTurns: Array<{ turn: number; label: string }> = []
  private detected = false

  constructor(
    repeatLimit = getAgentLoopRepeatLimit(),
    now: () => number = Date.now,
  ) {
    this.repeatLimit = Math.max(2, repeatLimit)
    this.now = now
  }

  syncProgress(snapshot: AgentLoopProgressSnapshot): void {
    const progress = [
      ...snapshot.evidence.map(value => `evidence:${value}`),
      ...snapshot.artifacts.map(value => `artifact:${value}`),
      ...snapshot.pendingInteractions.map(value => `interaction:${value}`),
    ]
    let changed = false
    for (const value of progress) {
      const fingerprint = hashValue(value)
      if (this.seenProgress.has(fingerprint)) continue
      this.seenProgress.add(fingerprint)
      changed = true
    }
    if (changed) {
      this.repetitions.clear()
      this.routeRepetitions.clear()
      this.failedTurns.length = 0
    }
  }

  observeToolCompletion(
    observation: AgentToolCompletionObservation,
  ): AgentLoopDetection | undefined {
    if (this.detected) return undefined
    const label = formatToolObservation(observation)
    const signature = getAgentToolCompletionSignature(observation)
    const previous = this.repetitions.get(signature)
    if (previous?.lastTurn === observation.turn) return undefined
    const now = this.now()
    const next: RepetitionState = {
      count: (previous?.count ?? 0) + 1,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastTurn: observation.turn,
      label,
    }
    this.repetitions.delete(signature)
    this.repetitions.set(signature, next)
    while (this.repetitions.size > MAX_AGENT_LOOP_SIGNATURES) {
      const oldest = this.repetitions.keys().next().value
      if (oldest === undefined) break
      this.repetitions.delete(oldest)
    }

    const threshold = observation.success
      ? Math.max(5, this.repeatLimit + 2)
      : this.repeatLimit
    if (next.count >= threshold && (
      !observation.success
      || now - next.firstSeenAt >= SUCCESSFUL_LOOP_MIN_DURATION_MS
    )) {
      return this.detect({
        count: next.count,
        signature,
        reason: `Repeated ${observation.success ? 'successful' : 'failed'} tool call: ${label}`,
      })
    }

    if (observation.success) return undefined

    const routeSignature = getFailedRouteSignature(observation)
    const routePrevious = this.routeRepetitions.get(routeSignature)
    if (routePrevious?.lastTurn !== observation.turn) {
      const routeNext: RepetitionState = {
        count: (routePrevious?.count ?? 0) + 1,
        firstSeenAt: routePrevious?.firstSeenAt ?? now,
        lastTurn: observation.turn,
        label: formatFailedRoute(observation),
      }
      setBoundedRepetition(
        this.routeRepetitions,
        routeSignature,
        routeNext,
      )
      const routeThreshold = Math.max(4, this.repeatLimit + 1)
      if (routeNext.count >= routeThreshold) {
        return this.detect({
          count: routeNext.count,
          signature: routeSignature,
          reason: `Repeated failing route family: ${routeNext.label}`,
        })
      }
    }

    const lastFailedTurn = this.failedTurns.at(-1)?.turn
    if (lastFailedTurn !== observation.turn) {
      this.failedTurns.push({ turn: observation.turn, label })
    }
    const churnThreshold = Math.max(8, this.repeatLimit * 2 + 2)
    if (this.failedTurns.length >= churnThreshold) {
      const recent = this.failedTurns
        .slice(-3)
        .map(item => item.label)
        .join(' | ')
      return this.detect({
        count: this.failedTurns.length,
        signature: hashValue(`error-churn:${recent}`),
        reason: `Different failing routes kept accumulating (${recent})`,
      })
    }

    return undefined
  }

  private detect(input: {
    count: number
    signature: string
    reason: string
  }): AgentLoopDetection {
    this.detected = true
    return {
      count: input.count,
      signature: input.signature,
      diagnostic: [
        `Agent loop watchdog detected ${input.count} no-progress failures or repetitions without new mutation, verification, interaction, or artifact evidence.`,
        input.reason,
        'The current child branch was stopped so recovery can inspect the trace and choose a materially different route.',
      ].join(' '),
    }
  }
}

export function getAgentLoopRepeatLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.OPENCLAUDE_AGENT_LOOP_REPEAT_LIMIT?.trim()
  if (!raw) return DEFAULT_AGENT_LOOP_REPEAT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_LOOP_REPEAT_LIMIT
  return Math.min(20, Math.max(2, parsed))
}

export function getAgentToolCompletionSignature(
  observation: AgentToolCompletionObservation,
): string {
  return hashValue([
    observation.toolName.trim(),
    stableSerialize(observation.toolInput),
    observation.success ? 'success' : 'error',
    normalizeToolResult(observation.output),
  ].join('\n'))
}

function formatToolObservation(observation: AgentToolCompletionObservation): string {
  const input = redactAgentText(stableSerialize(observation.toolInput))
    .replace(/\s+/gu, ' ')
    .trim()
  const label = input && input !== '{}'
    ? `${observation.toolName}: ${input}`
    : observation.toolName
  return label.length > 420 ? `${label.slice(0, 417)}...` : label
}

function normalizeToolResult(output: string): string {
  return redactAgentText(output)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, '<iso-date>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/giu, '<duration>')
    .replace(/\s+/gu, ' ')
    .trim()
}

function getFailedRouteSignature(
  observation: AgentToolCompletionObservation,
): string {
  return hashValue([
    observation.toolName.trim().toLowerCase(),
    classifyFailureResult(observation.output),
  ].join(':'))
}

function formatFailedRoute(observation: AgentToolCompletionObservation): string {
  return `${observation.toolName} (${classifyFailureResult(observation.output)})`
}

function classifyFailureResult(output: string): string {
  const normalized = redactAgentText(output).toLowerCase()
  if (/timed?\s*out|timeout/u.test(normalized)) return 'timeout'
  if (/permission|sensitive file|access denied|eacces/u.test(normalized)) return 'permission'
  if (/not found|no such file|enoent|does not exist/u.test(normalized)) return 'not-found'
  if (/validation|invalid (?:argument|request|input)|schema/u.test(normalized)) return 'validation'
  if (/no such tool|tool unavailable|unknown tool/u.test(normalized)) return 'missing-tool'
  if (/fetch failed|connection|network|dns|socket|econn/u.test(normalized)) return 'network'
  if (/api error|provider|rate.?limit|quota|model/u.test(normalized)) return 'provider'
  if (/exit code|command failed|syntax error/u.test(normalized)) return 'command'
  return 'other'
}

function setBoundedRepetition(
  target: Map<string, RepetitionState>,
  signature: string,
  state: RepetitionState,
): void {
  target.delete(signature)
  target.set(signature, state)
  while (target.size > MAX_AGENT_LOOP_SIGNATURES) {
    const oldest = target.keys().next().value
    if (oldest === undefined) break
    target.delete(oldest)
  }
}

function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return '[Circular]'
    seen.add(current)
    if (Array.isArray(current)) return current.map(normalize)
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    )
  }
  try {
    return JSON.stringify(normalize(value))
  } catch {
    return String(value)
  }
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
