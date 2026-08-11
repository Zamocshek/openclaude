import { describe, expect, test } from 'bun:test'
import {
  chunkTelegramText,
  TELEGRAM_TEXT_LIMIT_UTF16,
} from './telegramChunks.js'

describe('chunkTelegramText', () => {
  test('keeps web-console URLs intact at the production help boundary', () => {
    const prefix = `${'command - description\n'.repeat(180)}Web consoles:\n`
    const links = [
      'Tool Router: http://localhost:19868',
      'Open WebUI: http://localhost:28080',
      'File Manager: http://localhost:19642/files',
      'OmniRoute: http://localhost:20128',
    ]
    const text = `${prefix}${links.join('\n')}`
    const chunks = chunkTelegramText(text)

    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => chunk.length <= TELEGRAM_TEXT_LIMIT_UTF16)).toBe(true)
    for (const line of links) {
      expect(chunks.some(chunk => chunk.includes(line))).toBe(true)
    }
  })

  test('uses the full Telegram limit and preserves all text', () => {
    const text = `${'a'.repeat(4095)}\nsecond`
    const chunks = chunkTelegramText(text)

    expect(chunks).toHaveLength(2)
    expect(chunks.join('')).toBe(text)
    expect(chunks[0]?.length).toBe(4096)
  })

  test('does not split a surrogate pair at a hard boundary', () => {
    const text = `${'a'.repeat(15)}😀tail`
    const chunks = chunkTelegramText(text, 16)

    expect(chunks.join('')).toBe(text)
    expect(chunks[0]).toBe('a'.repeat(15))
    expect(chunks[1]?.startsWith('😀')).toBe(true)
  })

  test('rejects invalid limits instead of looping forever', () => {
    expect(() => chunkTelegramText('text', 0)).toThrow(RangeError)
  })
})
