export const TELEGRAM_TEXT_LIMIT_UTF16 = 4096

const URL_PATTERN = /https?:\/\/\S+/gu

/**
 * Split plain Telegram text without cutting ordinary URLs, words, or grapheme
 * clusters when a natural boundary exists within Telegram's UTF-16 limit.
 */
export function chunkTelegramText(
  text: string,
  maxLength = TELEGRAM_TEXT_LIMIT_UTF16,
): string[] {
  if (!text) return ['']
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer')
  }

  const chunks: string[] = []
  let offset = 0
  while (text.length - offset > maxLength) {
    const remaining = text.slice(offset)
    const boundary = findChunkBoundary(remaining, maxLength)
    chunks.push(remaining.slice(0, boundary))
    offset += boundary
  }
  chunks.push(text.slice(offset))
  return chunks
}

function findChunkBoundary(text: string, maxLength: number): number {
  const urlStart = urlStartContaining(text, maxLength)
  const searchLimit = urlStart && urlStart > 0 ? urlStart : maxLength
  const minimumNaturalBoundary = Math.max(1, Math.floor(maxLength * 0.5))

  for (const pattern of [/\n\n/gu, /\n/gu, /\s/gu]) {
    const boundary = lastBoundaryAtOrBefore(text, pattern, searchLimit)
    if (boundary >= minimumNaturalBoundary || (urlStart && boundary > 0)) {
      return boundary
    }
  }

  if (urlStart && urlStart > 0) return urlStart
  return graphemeBoundaryAtOrBefore(text, maxLength)
}

function urlStartContaining(text: string, boundary: number): number | undefined {
  URL_PATTERN.lastIndex = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index
    const end = start + match[0].length
    if (start < boundary && boundary < end) return start
    if (start >= boundary) break
  }
  return undefined
}

function lastBoundaryAtOrBefore(
  text: string,
  pattern: RegExp,
  limit: number,
): number {
  pattern.lastIndex = 0
  let boundary = 0
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length
    if (end > limit) break
    boundary = end
  }
  return boundary
}

function graphemeBoundaryAtOrBefore(text: string, limit: number): number {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let boundary = 0
    for (const segment of segmenter.segment(text)) {
      if (segment.index >= limit) break
      const end = segment.index + segment.segment.length
      if (end > limit) break
      boundary = end
    }
    if (boundary > 0) return boundary
  }

  let boundary = Math.min(limit, text.length)
  const previous = text.charCodeAt(boundary - 1)
  const next = text.charCodeAt(boundary)
  if (
    previous >= 0xD800 && previous <= 0xDBFF &&
    next >= 0xDC00 && next <= 0xDFFF
  ) {
    boundary -= 1
  }
  return Math.max(1, boundary)
}
