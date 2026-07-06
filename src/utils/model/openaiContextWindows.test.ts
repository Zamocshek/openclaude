import { describe, expect, test } from 'bun:test'
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from './openaiContextWindows.js'

describe('OpenAI-compatible model context windows', () => {
  test('knows Telegram shortcut and Codex provider models', () => {
    const expectedLimits = [
      ['gpt-5.5', 400_000, 128_000],
      ['codexplan', 1_050_000, 128_000],
      ['codexspark', 400_000, 32_768],
      ['gpt-5.4', 1_050_000, 128_000],
      ['gpt-5.3-codex', 400_000, 32_768],
      ['gpt-5.3-codex-spark', 400_000, 32_768],
      ['gpt-5.2-codex', 400_000, 32_768],
      ['gpt-5.2', 264_000, 32_768],
      ['gpt-5.1-codex', 400_000, 32_768],
      ['gpt-5.1-codex-max', 400_000, 32_768],
      ['gpt-5.1-codex-mini', 400_000, 32_768],
      ['deepseek-v4-flash', 128_000, 8_192],
      ['deepseek-v4-pro', 128_000, 32_768],
      ['gemma-4-12b-obliterated', 8_192, 4_096],
      ['huihui-gemma-4-12b-coder-fable5-composer2.5-v1-abliterated', 8_192, 4_096],
    ] as const

    for (const [model, contextWindow, maxOutputTokens] of expectedLimits) {
      expect(getOpenAIContextWindow(model)).toBe(contextWindow)
      expect(getOpenAIMaxOutputTokens(model)).toBe(maxOutputTokens)
    }
  })

  test('uses conservative family fallbacks for new known-provider aliases', () => {
    expect(getOpenAIContextWindow('gpt-5.6-codex-experimental')).toBe(400_000)
    expect(getOpenAIMaxOutputTokens('gpt-5.6-codex-experimental')).toBe(32_768)
    expect(getOpenAIContextWindow('deepseek-v4-ultra')).toBe(128_000)
    expect(getOpenAIMaxOutputTokens('deepseek-v4-ultra')).toBe(8_192)
    expect(getOpenAIContextWindow('huihui-gemma-4-new-local')).toBe(8_192)
    expect(getOpenAIMaxOutputTokens('huihui-gemma-4-new-local')).toBe(4_096)
  })
})
