import { describe, expect, test } from 'bun:test'
import {
  getConversationContextBudgets,
  getConversationContextMaxChars,
  getConversationContextTurnLimit,
  getMemoryContextMaxChars,
  trimConversationMessagesWithinCharBudget,
} from './conversationContext.js'

async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

describe('agent gateway conversation context budgets', () => {
  test('uses real model windows while leaving durable storage unlimited', async () => {
    await withEnv('OPENCLAUDE_TEST_CONTEXT_CHARS', undefined, () => {
      const deepseek = getConversationContextBudgets('deepseek-v4-flash')
      const gemma = getConversationContextBudgets('gemma-4-12b-obliterated')
      const gpt = getConversationContextBudgets('gpt-5.6-codex')

      expect(deepseek?.contextTokens).toBe(128_000)
      expect(gemma?.contextTokens).toBe(8_192)
      expect(gpt?.contextTokens).toBe(372_000)
      expect(gemma!.conversationChars).toBeLessThan(deepseek!.conversationChars)
      expect(deepseek!.conversationChars).toBeLessThan(gpt!.conversationChars)
      expect(getMemoryContextMaxChars('deepseek-v4-flash')).toBe(
        deepseek!.memoryChars,
      )
    })
  })

  test('treats unlimited and zero env values as no artificial cap', async () => {
    await withEnv('OPENCLAUDE_TEST_CONTEXT_CHARS', 'unlimited', () => {
      expect(getConversationContextMaxChars({
        model: 'deepseek-v4-flash',
        envNames: ['OPENCLAUDE_TEST_CONTEXT_CHARS'],
      })).toBe(Number.MAX_SAFE_INTEGER)
    })
    await withEnv('OPENCLAUDE_TEST_CONTEXT_CHARS', '0', () => {
      expect(getConversationContextMaxChars({
        model: 'deepseek-v4-flash',
        envNames: ['OPENCLAUDE_TEST_CONTEXT_CHARS'],
      })).toBe(Number.MAX_SAFE_INTEGER)
      expect(getConversationContextTurnLimit([
        'OPENCLAUDE_TEST_CONTEXT_CHARS',
      ])).toBe(Number.MAX_SAFE_INTEGER)
    })
  })

  test('lets explicit context and memory prompt overrides exceed auto model budgets', async () => {
    await withEnv('OPENCLAUDE_TEST_CONTEXT_CHARS', '1m', () => {
      expect(getConversationContextMaxChars({
        model: 'gemma-4-12b-obliterated',
        envNames: ['OPENCLAUDE_TEST_CONTEXT_CHARS'],
      })).toBe(1_000_000)
    })

    await withEnv('OPENCLAUDE_MEMORY_CONTEXT_CHARS', '1m', () => {
      expect(getMemoryContextMaxChars('gemma-4-12b-obliterated')).toBe(1_000_000)
    })
  })

  test('keeps an explicit smaller operational cap and newest dialogue', async () => {
    await withEnv('OPENCLAUDE_TEST_CONTEXT_CHARS', '2000', () => {
      expect(getConversationContextMaxChars({
        model: 'gpt-5.6-codex',
        envNames: ['OPENCLAUDE_TEST_CONTEXT_CHARS'],
      })).toBe(2000)
    })

    const history = [
      { role: 'user', content: 'old-' + 'x'.repeat(700) },
      { role: 'assistant', content: 'middle-' + 'y'.repeat(700) },
      { role: 'user', content: 'newest-' + 'z'.repeat(700) },
    ]
    const selected = trimConversationMessagesWithinCharBudget(history, 900)
    expect(selected.at(-1)?.content).toContain('newest-')
    expect(selected[0]?.content).not.toContain('old-')
  })
})
