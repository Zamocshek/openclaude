import { describe, expect, test } from 'bun:test'

import {
  getBuiltInProviderModels,
  getModelBaseId,
  parseCodexModelRecords,
  withModelReasoning,
} from './providerModels.js'

describe('agent gateway provider model catalog', () => {
  test('ships current Codex, DeepSeek, OpenRouter, and OmniRoute quick models', () => {
    const codexModels = getBuiltInProviderModels('codex')
    expect(codexModels.map(model => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ])
    expect(codexModels.find(model => model.id === 'gpt-5.6-sol')?.defaultReasoning).toBe('ultra')
    expect(codexModels.find(model => model.id === 'gpt-5.6-luna')?.defaultReasoning).toBe('max')
    expect(codexModels.find(model => model.id === 'gpt-5.5')?.defaultReasoning).toBe('xhigh')
    expect(codexModels.find(model => model.id === 'gpt-5.3-codex-spark')?.defaultReasoning).toBeUndefined()
    expect(getBuiltInProviderModels('deepseek').map(model => model.id)).toEqual([
      'deepseek-v4.1-flash-expires-on-0910',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ])
    expect(
      getBuiltInProviderModels('deepseek').find(
        model => model.id === 'deepseek-v4.1-flash-expires-on-0910',
      )?.contextWindow,
    ).toBe(1_000_000)
    expect(getBuiltInProviderModels('opencode-zen').map(model => model.id)).toEqual([
      'x-preview-f-free',
      'deepseek-v4-flash-free',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
    expect(getBuiltInProviderModels('openrouter').map(model => model.id)).toContain(
      'openai/gpt-5.6-sol',
    )
    expect(getBuiltInProviderModels('openrouter').map(model => model.id)).toContain(
      'openai/gpt-5.5-pro',
    )
    expect(getBuiltInProviderModels('omniroute').map(model => model.id)).toEqual([
      'auto',
      'auto/coding',
      'auto/fast',
      'auto/cheap',
      'auto/smart',
      'auto/offline',
    ])
  })

  test('uses the highest supported Codex reasoning level from the live catalog', () => {
    const models = parseCodexModelRecords([
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low' },
          { effort: 'xhigh' },
          { effort: 'max' },
          { effort: 'ultra' },
          { effort: 'invalid' },
        ],
        context_window: 372_000,
        visibility: 'list',
        priority: 1,
      },
      { slug: 'hidden', visibility: 'hide', priority: 0 },
    ])

    expect(models).toEqual([{
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      defaultReasoning: 'ultra',
      reasoningLevels: ['low', 'xhigh', 'max', 'ultra'],
      contextWindow: 372_000,
    }])
  })

  test('sets reasoning without duplicating model query parameters', () => {
    expect(withModelReasoning('gpt-5.6-sol', 'xhigh')).toBe(
      'gpt-5.6-sol?reasoning=xhigh',
    )
    expect(withModelReasoning('gpt-5.6-sol?reasoning=low', 'ultra')).toBe(
      'gpt-5.6-sol?reasoning=ultra',
    )
    expect(getModelBaseId('gpt-5.6-sol?reasoning=ultra')).toBe('gpt-5.6-sol')
  })
})
