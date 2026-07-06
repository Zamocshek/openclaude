export const UNLIMITED_LIMIT = Number.MAX_SAFE_INTEGER

export type ParseHumanLimitOptions = {
  unlimitedValue?: number
  zeroValue?: number
}

export function parseHumanLimit(
  value: string | number | undefined | null,
  options: ParseHumanLimitOptions = {},
): number | undefined {
  if (typeof value === 'number') {
    return normalizeParsedLimit(value, options)
  }

  const raw = String(value ?? '').trim()
  if (!raw) return undefined

  const normalized = raw.toLowerCase()
  if (['auto', 'default', 'model', 'inherit'].includes(normalized)) {
    return undefined
  }
  if (
    [
      'unlimited',
      'none',
      'no-limit',
      'nolimit',
      'inf',
      'infinite',
      'infinity',
      'max',
    ].includes(normalized)
  ) {
    return options.unlimitedValue ?? UNLIMITED_LIMIT
  }

  const match = raw
    .replace(/,/gu, '')
    .replace(/_/gu, '')
    .match(/^\s*(\d+(?:\.\d+)?)\s*([kmgt])?\s*(?:tokens?|chars?|characters?)?\s*$/iu)
  if (!match) return undefined

  const amount = Number(match[1])
  const suffix = (match[2] || '').toLowerCase()
  const multiplier =
    suffix === 'k'
      ? 1_000
      : suffix === 'm'
        ? 1_000_000
        : suffix === 'g'
          ? 1_000_000_000
          : suffix === 't'
            ? 1_000_000_000_000
            : 1

  return normalizeParsedLimit(amount * multiplier, options)
}

function normalizeParsedLimit(
  value: number,
  options: ParseHumanLimitOptions,
): number | undefined {
  if (!Number.isFinite(value)) return undefined
  if (value === 0 && options.zeroValue !== undefined) return options.zeroValue
  if (value <= 0) return undefined
  return Math.floor(value)
}
