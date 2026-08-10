import { describe, expect, test } from 'bun:test'
import {
  buildSemanticTaskRouterPrompt,
  resolveSemanticTaskRoute,
} from './semanticTaskRouter.js'

describe('semantic task router', () => {
  const fallback = {
    mode: 'auto' as const,
    servers: new Set(['context7']),
    reasons: ['library-docs'],
    source: 'heuristic' as const,
    codingIntent: false,
    codingMutationIntent: false,
  }

  test('uses semantic meaning and maps capabilities to eligible servers', async () => {
    const route = await resolveSemanticTaskRoute({
      prompt: 'Проверь мои открытые pull requests и статусы Actions.',
      eligibleServerNames: ['github', 'context7'],
      fallback,
      infer: async () => JSON.stringify({
        mode: 'auto',
        task_kind: 'github-review',
        capabilities: ['github'],
        servers: [],
        coding_intent: false,
        coding_mutation: false,
        confidence: 0.97,
      }),
    })

    expect(route.source).toBe('semantic')
    expect([...route.servers]).toEqual(['github'])
    expect(route.capabilities).toEqual(['github'])
    expect(route.codingMutationIntent).toBe(false)
  })

  test('keeps only eligible servers and explicit deterministic selections', async () => {
    const route = await resolveSemanticTaskRoute({
      prompt: 'Use my custom server for this task.',
      eligibleServerNames: ['custom-mcp', 'github'],
      fallback: {
        ...fallback,
        servers: new Set(['custom-mcp']),
        reasons: ['explicit-server:custom-mcp'],
      },
      infer: async () => '```json\n{"mode":"auto","task_kind":"integration","capabilities":[],"servers":["unknown"],"coding_intent":false,"coding_mutation":false,"confidence":0.9}\n```',
    })

    expect([...route.servers]).toEqual(['custom-mcp'])
  })

  test('does not let semantic output widen all-tools or coding authority', async () => {
    const route = await resolveSemanticTaskRoute({
      prompt: 'Just say hello.',
      eligibleServerNames: ['telegram-mcp', 'github'],
      fallback: {
        ...fallback,
        servers: new Set(),
        reasons: [],
      },
      infer: async () => JSON.stringify({
        mode: 'all',
        task_kind: 'coding',
        capabilities: ['telegram'],
        servers: ['telegram-mcp'],
        coding_intent: true,
        coding_mutation: true,
        confidence: 0.99,
      }),
    })

    expect(route.mode).toBe('auto')
    expect(route.codingIntent).toBe(false)
    expect(route.codingMutationIntent).toBe(false)
  })

  test('falls back without throwing on invalid or low-confidence output', async () => {
    const invalid = await resolveSemanticTaskRoute({
      prompt: 'Anything',
      eligibleServerNames: ['context7'],
      fallback,
      infer: async () => 'not json',
    })
    const uncertain = await resolveSemanticTaskRoute({
      prompt: 'Anything',
      eligibleServerNames: ['context7'],
      fallback,
      infer: async () => '{"confidence":0.2}',
    })

    expect(invalid.source).toBe('heuristic')
    expect(uncertain.source).toBe('heuristic')
    expect([...invalid.servers]).toEqual(['context7'])
  })

  test('provides immediate dialogue context for short continuation messages', () => {
    const prompt = buildSemanticTaskRouterPrompt(
      'Current request:\nUser message:\n14421',
      ['telegram-mcp'],
      'The assistant sent a Telegram login code and is waiting for the confirmation code.',
    )

    expect(prompt).toContain('Immediate dialogue context')
    expect(prompt).toContain('waiting for the confirmation code')
    expect(prompt).toContain('Current request:\n14421')
  })

  test('keeps classification compact and explicitly suppresses reasoning', () => {
    const prompt = buildSemanticTaskRouterPrompt(
      `Publish to Telegram. ${'x'.repeat(10_000)}`,
      ['telegram-mcp'],
      `Previous context ${'y'.repeat(10_000)}`,
    )

    expect(prompt).toContain('Do not think aloud')
    expect(prompt).toContain('Output the JSON object immediately')
    expect(prompt.length).toBeLessThan(9_000)
  })
})
