import { parseHumanLimit } from '../../utils/limitParsing.js'

const UNLIMITED_SAFE_LIMIT = Number.MAX_SAFE_INTEGER

export type TextConversationMessage = {
  role: string
  content: string
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
    })
    if (parsed !== undefined) return Math.min(Math.max(1, parsed), maxLimit)
  }
  return defaultLimit
}

export function getConversationContextMaxChars(input: {
  model?: string
  envNames: string[]
}): number {
  for (const envName of input.envNames) {
    const parsed = parseHumanLimit(process.env[envName], {
      unlimitedValue: UNLIMITED_SAFE_LIMIT,
    })
    if (parsed !== undefined) return Math.max(1_000, parsed)
  }

  return UNLIMITED_SAFE_LIMIT
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
  const selected: T[] = []
  let used = 0

  for (const message of [...messages].reverse()) {
    const cost = message.role.length + message.content.length + 2
    if (used + cost > budget && selected.length > 0) break
    if (used + cost > budget) {
      selected.push({
        ...message,
        content: truncateTextFromStart(message.content, budget),
      })
      break
    }
    selected.push(message)
    used += cost
  }

  return selected.reverse()
}

function truncateTextFromStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 20) return text.slice(-maxChars)
  return `[truncated]\n${text.slice(-(maxChars - 12))}`
}
