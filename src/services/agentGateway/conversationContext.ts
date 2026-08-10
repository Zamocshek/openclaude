import { parseHumanLimit } from '../../utils/limitParsing.js'
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from '../../utils/model/openaiContextWindows.js'

const UNLIMITED_SAFE_LIMIT = Number.MAX_SAFE_INTEGER
const DEFAULT_MODEL_CONTEXT_TOKENS = 128_000
const DEFAULT_MODEL_OUTPUT_TOKENS = 8_192
const CHARS_PER_TOKEN = 3

export type TextConversationMessage = {
  role: string
  content: string
}

export type ConversationContextBudgets = {
  contextTokens: number
  outputReserveTokens: number
  conversationChars: number
  memoryChars: number
}

export function getConversationContextBudgets(
  model?: string,
): ConversationContextBudgets | undefined {
  const normalizedModel = model?.trim()
  if (!normalizedModel) return undefined

  const contextTokens =
    getOpenAIContextWindow(normalizedModel) ?? DEFAULT_MODEL_CONTEXT_TOKENS
  const knownOutput = getOpenAIMaxOutputTokens(normalizedModel)
    ?? DEFAULT_MODEL_OUTPUT_TOKENS
  const outputReserveTokens = Math.min(
    knownOutput,
    Math.max(1_024, Math.floor(contextTokens / 2)),
  )
  const usableInputTokens = Math.max(1_024, contextTokens - outputReserveTokens)
  const usableChars = usableInputTokens * CHARS_PER_TOKEN

  const allocation = contextTokens <= 16_384
    ? { conversation: 0.30, memory: 0.12 }
    : contextTokens <= 65_536
      ? { conversation: 0.50, memory: 0.20 }
      : { conversation: 0.60, memory: 0.25 }

  return {
    contextTokens,
    outputReserveTokens,
    conversationChars: Math.max(1_000, Math.floor(usableChars * allocation.conversation)),
    memoryChars: Math.max(1_000, Math.floor(usableChars * allocation.memory)),
  }
}

export function getConversationContextTurnLimit(
  envNames: string[],
  options: { defaultLimit?: number; maxLimit?: number } = {},
): number {
  const defaultLimit = options.defaultLimit ?? UNLIMITED_SAFE_LIMIT
  const maxLimit = options.maxLimit ?? UNLIMITED_SAFE_LIMIT
  for (const envName of envNames) {
    const parsed = parseHumanLimit(process.env[envName], {
      unlimitedValue: maxLimit,
      zeroValue: maxLimit,
    })
    if (parsed !== undefined) return Math.min(Math.max(1, parsed), maxLimit)
  }
  return defaultLimit
}

export function getConversationContextMaxChars(input: {
  model?: string
  envNames: string[]
}): number {
  const configuredLimit = getConfiguredContextChars(input.envNames)

  const modelLimit = getConversationContextBudgets(input.model)?.conversationChars
  return configuredLimit ?? modelLimit ?? UNLIMITED_SAFE_LIMIT
}

export function getMemoryContextMaxChars(
  model?: string,
  envNames = [
    'OPENCLAUDE_MEMORY_CONTEXT_CHARS',
    'OPENCLAUDE_MEMORY_CONTEXT_MAX_CHARS',
  ],
): number {
  const configuredLimit = getConfiguredContextChars(envNames)
  if (configuredLimit !== undefined) return configuredLimit

  return getConversationContextBudgets(model)?.memoryChars
    ?? UNLIMITED_SAFE_LIMIT
}

function getConfiguredContextChars(envNames: string[]): number | undefined {
  for (const envName of envNames) {
    const parsed = parseHumanLimit(process.env[envName], {
      unlimitedValue: UNLIMITED_SAFE_LIMIT,
      zeroValue: UNLIMITED_SAFE_LIMIT,
    })
    if (parsed !== undefined) {
      return Math.max(1_000, parsed)
    }
  }
  return undefined
}

export function selectTextBlocksWithinCharBudget(
  blocks: string[],
  maxChars: number,
): string[] {
  const budget = Math.max(1, maxChars)
  const selected: string[] = []
  let used = 0

  for (const block of [...blocks].reverse()) {
    const separator = selected.length > 0 ? 1 : 0
    const nextUsed = used + separator + block.length
    if (nextUsed <= budget) {
      selected.push(block)
      used = nextUsed
      continue
    }

    const remaining = budget - used - separator
    if (remaining > 200) {
      selected.push(truncateTextFromStart(block, remaining))
    } else if (selected.length === 0) {
      selected.push(truncateTextFromStart(block, budget))
    }
    break
  }

  return selected.reverse()
}

export function trimConversationMessagesWithinCharBudget<
  T extends TextConversationMessage,
>(messages: T[], maxChars: number): T[] {
  const budget = Math.max(1, maxChars)
  const groups = groupConversationTurns(messages)
  const selectedGroups: T[][] = []
  let used = 0

  for (const group of [...groups].reverse()) {
    const cost = group.reduce(
      (sum, message) => sum + message.role.length + message.content.length + 2,
      0,
    )
    if (used + cost > budget && selectedGroups.length > 0) break
    if (used + cost > budget) {
      const retained = [...group]
      const overhead = retained.reduce(
        (sum, message) => sum + message.role.length + 2,
        0,
      )
      let remaining = Math.max(retained.length, budget - overhead)
      const resized = new Array<T>(retained.length)
      for (let index = retained.length - 1; index >= 0; index -= 1) {
        const message = retained[index]!
        const reservedForEarlier = index
        const available = Math.max(1, remaining - reservedForEarlier)
        const content = truncateTextFromStart(message.content, available)
        resized[index] = { ...message, content }
        remaining -= content.length
      }
      selectedGroups.push(resized)
      break
    }
    selectedGroups.push(group)
    used += cost
  }

  return selectedGroups.reverse().flat()
}

function groupConversationTurns<T extends TextConversationMessage>(messages: T[]): T[][] {
  const groups: T[][] = []
  for (const message of messages) {
    const current = groups.at(-1)
    if (!current || message.role === 'user' || message.role === 'system') {
      groups.push([message])
    } else {
      current.push(message)
    }
  }
  return groups
}

function truncateTextFromStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 20) return text.slice(-maxChars)
  return `[truncated]
${text.slice(-(maxChars - 12))}`
}
