export const AGENT_INTERACTION_PROTOCOL = 'openclaude.interaction/v1' as const

const MAX_INTERACTION_ENVELOPE_CHARS = 12_000
const MIN_INTERACTION_TTL_MS = 60_000
const MAX_INTERACTION_TTL_MS = 30 * 60_000
const DEFAULT_INTERACTION_TTL_MS = 10 * 60_000
const SENSITIVE_STATE_KEY_RE = /(?:code|credential|key|pass|phone|secret|token)/iu
const TRUSTED_INTERACTION_SOURCES: Readonly<Record<string, ReadonlySet<string>>> = {
  'telegram.session.authorize': new Set([
    'mcp__telegram-mcp__authorize_send_code',
  ]),
}

export type AgentInteractionInputKind =
  | 'text'
  | 'secret'
  | 'otp'
  | 'confirmation'
  | 'choice'

export type AgentInteractionInput = {
  name: string
  kind: AgentInteractionInputKind
  prompt: string
  minLength?: number
  maxLength?: number
  choices?: string[]
}

export type AgentRunPendingInteraction = {
  protocol: typeof AGENT_INTERACTION_PROTOCOL
  id: string
  handler: string
  stage: string
  prompt: string
  input: AgentInteractionInput
  /** Non-secret continuation state only. Secret values live in volatile gateway state. */
  state: Record<string, string | number | boolean>
  sourceTool: string
  expiresInMs: number
}

export type StoredAgentInteraction<TPrivate = Record<string, string>> = {
  interaction: AgentRunPendingInteraction
  expiresAt: number
  privateState?: TPrivate
}

export type AgentInteractionLookup<TPrivate = Record<string, string>> =
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'active'; stored: StoredAgentInteraction<TPrivate> }

/**
 * Tool-independent continuation storage. The scope is a transport session or
 * chat id; adapters own execution while this registry owns lifecycle only.
 */
export class AgentInteractionRegistry<TPrivate = Record<string, string>> {
  private readonly pending = new Map<string, StoredAgentInteraction<TPrivate>>()

  set(
    scope: string,
    interaction: AgentRunPendingInteraction,
    privateState?: TPrivate,
    now = Date.now(),
  ): void {
    this.pending.set(scope, {
      interaction,
      expiresAt: now + normalizeInteractionTtl(interaction.expiresInMs),
      ...(privateState === undefined ? {} : { privateState }),
    })
  }

  get(scope: string, now = Date.now()): StoredAgentInteraction<TPrivate> | undefined {
    const result = this.lookup(scope, now)
    return result.status === 'active' ? result.stored : undefined
  }

  lookup(scope: string, now = Date.now()): AgentInteractionLookup<TPrivate> {
    const stored = this.pending.get(scope)
    if (!stored) return { status: 'missing' }
    if (stored.expiresAt <= now) {
      this.pending.delete(scope)
      return { status: 'expired' }
    }
    return { status: 'active', stored }
  }

  has(scope: string, now = Date.now()): boolean {
    return this.get(scope, now) !== undefined
  }

  clear(scope?: string): void {
    if (scope === undefined) this.pending.clear()
    else this.pending.delete(scope)
  }
}

export function extractAgentInteractionEnvelopes(
  toolName: string,
  output: string,
): AgentRunPendingInteraction[] {
  const interactions: AgentRunPendingInteraction[] = []
  const pattern = /<openclaude_interaction>([\s\S]{1,12000}?)<\/openclaude_interaction>/giu
  for (const match of output.matchAll(pattern)) {
    const raw = match[1]?.trim()
    if (!raw || raw.length > MAX_INTERACTION_ENVELOPE_CHARS) continue
    try {
      const interaction = normalizeInteractionEnvelope(JSON.parse(raw), toolName)
      if (interaction && isTrustedInteractionSource(interaction.handler, toolName)) {
        interactions.push(interaction)
      }
    } catch {
      // Invalid tool metadata is ignored; it never becomes executable state.
    }
  }
  return interactions
}

function isTrustedInteractionSource(handler: string, sourceTool: string): boolean {
  const trustedSources = TRUSTED_INTERACTION_SOURCES[handler]
  return trustedSources === undefined || trustedSources.has(sourceTool.trim())
}

export function validateAgentInteractionInput(
  input: AgentInteractionInput,
  value: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const normalized = value.trim()
  if (!normalized) return { ok: false, message: input.prompt }
  if (input.minLength !== undefined && normalized.length < input.minLength) {
    return { ok: false, message: input.prompt }
  }
  if (input.maxLength !== undefined && normalized.length > input.maxLength) {
    return { ok: false, message: input.prompt }
  }
  if (input.kind === 'otp' && !/^\d+$/u.test(normalized)) {
    return { ok: false, message: input.prompt }
  }
  if (
    input.kind === 'choice'
    && input.choices?.length
    && !input.choices.some(choice => choice.toLowerCase() === normalized.toLowerCase())
  ) {
    return { ok: false, message: input.prompt }
  }
  return { ok: true, value: normalized }
}

export function buildAgentInteractionRoutingContext(
  stored: StoredAgentInteraction | undefined,
): string {
  if (!stored) return ''
  const { interaction } = stored
  return [
    'Pending tool interaction:',
    `- id: ${interaction.id}`,
    `- handler: ${interaction.handler}`,
    `- stage: ${interaction.stage}`,
    `- expected input: ${interaction.input.kind}`,
    `- prompt: ${interaction.prompt}`,
    `- source tool: ${interaction.sourceTool}`,
    'Treat a matching user reply as continuation of this interaction, not as a new task.',
  ].join('\n')
}

export function getAgentInteractionKey(interaction: AgentRunPendingInteraction): string {
  return `${interaction.handler}:${interaction.id}`
}

export function createAgentInteraction(input: {
  id: string
  handler: string
  stage: string
  prompt: string
  input: AgentInteractionInput
  state?: Record<string, string | number | boolean>
  sourceTool: string
  expiresInMs?: number
}): AgentRunPendingInteraction {
  return {
    protocol: AGENT_INTERACTION_PROTOCOL,
    id: input.id,
    handler: input.handler,
    stage: input.stage,
    prompt: input.prompt,
    input: input.input,
    state: input.state || {},
    sourceTool: input.sourceTool,
    expiresInMs: normalizeInteractionTtl(input.expiresInMs),
  }
}

function normalizeInteractionEnvelope(
  value: unknown,
  sourceTool: string,
): AgentRunPendingInteraction | undefined {
  if (!isRecord(value) || value.protocol !== AGENT_INTERACTION_PROTOCOL) return undefined
  const id = boundedIdentifier(value.id, 160)
  const handler = boundedIdentifier(value.handler, 128)
  const stage = boundedIdentifier(value.stage, 64)
  const prompt = boundedText(value.prompt, 500)
  const input = normalizeInteractionInput(value.input)
  const state = normalizeSafeState(value.state)
  if (!id || !handler || !stage || !prompt || !input || !state) return undefined
  return createAgentInteraction({
    id,
    handler,
    stage,
    prompt,
    input,
    state,
    sourceTool: String(sourceTool || '').trim().slice(0, 200),
    expiresInMs: Number(value.expiresInMs),
  })
}

function normalizeInteractionInput(value: unknown): AgentInteractionInput | undefined {
  if (!isRecord(value)) return undefined
  const name = boundedIdentifier(value.name, 64)
  const kind = String(value.kind || '') as AgentInteractionInputKind
  const prompt = boundedText(value.prompt, 500)
  if (!name || !prompt || !['text', 'secret', 'otp', 'confirmation', 'choice'].includes(kind)) {
    return undefined
  }
  const minLength = normalizeBound(value.minLength)
  const maxLength = normalizeBound(value.maxLength)
  const choices = Array.isArray(value.choices)
    ? value.choices
        .filter((choice): choice is string => typeof choice === 'string')
        .map(choice => choice.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 32)
    : undefined
  return {
    name,
    kind,
    prompt,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(choices?.length ? { choices } : {}),
  }
}

function normalizeSafeState(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).slice(0, 32)
  const state: Record<string, string | number | boolean> = {}
  for (const [rawKey, rawValue] of entries) {
    const key = boundedIdentifier(rawKey, 64)
    if (!key || SENSITIVE_STATE_KEY_RE.test(key)) return undefined
    if (typeof rawValue === 'string') state[key] = rawValue.slice(0, 500)
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) state[key] = rawValue
    else if (typeof rawValue === 'boolean') state[key] = rawValue
    else return undefined
  }
  return state
}

function normalizeInteractionTtl(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_INTERACTION_TTL_MS
  return Math.max(MIN_INTERACTION_TTL_MS, Math.min(MAX_INTERACTION_TTL_MS, Math.floor(parsed)))
}

function normalizeBound(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.min(10_000, Math.floor(parsed))
}

function boundedIdentifier(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)
    ? normalized.slice(0, max)
    : ''
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
