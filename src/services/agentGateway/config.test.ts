import { describe, expect, test } from 'bun:test'
import {
  applyAgentGatewayEnvOverrides,
  getDefaultAgentGatewayConfig,
  normalizeAgentGatewayConfig,
} from './config.js'

describe('agent gateway config normalization', () => {
  test('ships a Codex-backed multimodal route for text-only coordinators', () => {
    expect(
      getDefaultAgentGatewayConfig().subagents.routes['gateway-vision'],
    ).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol?reasoning=medium',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKeyEnv: 'CODEX_API_KEY',
    })
  })

  test('falls back from invalid runner numeric values', () => {
    const defaults = getDefaultAgentGatewayConfig()
    const config = normalizeAgentGatewayConfig({
      runner: {
        maxTurns: 'NaN',
        timeoutMs: 'Infinity',
      },
    })

    expect(config.runner.maxTurns).toBe(defaults.runner.maxTurns)
    expect(config.runner.timeoutMs).toBe(defaults.runner.timeoutMs)
  })

  test('clamps runner numeric values to bounded process-safe ranges', () => {
    const config = normalizeAgentGatewayConfig({
      runner: {
        maxTurns: '999999',
        timeoutMs: String(99 * 60 * 60 * 1000),
      },
    })

    expect(config.runner.maxTurns).toBe(2000)
    expect(config.runner.timeoutMs).toBe(4 * 60 * 60 * 1000)
  })

  test('allows env to disable Telegram mirroring for API responses', () => {
    const config = normalizeAgentGatewayConfig({
      telegram: {
        mirrorAgentApiResponses: true,
      },
    })

    const next = applyAgentGatewayEnvOverrides(config, {
      OPENCLAUDE_TELEGRAM_MIRROR_API_RESPONSES: '0',
    } as NodeJS.ProcessEnv)

    expect(next.telegram.mirrorAgentApiResponses).toBe(false)
  })

  test('normalizes bounded subagent routing without requiring stored API keys', () => {
    const config = normalizeAgentGatewayConfig({
      subagents: {
        enabled: true,
        maxParallel: 999,
        routes: {
          'gateway-review': {
            provider: 'DeepSeek',
            model: 'deepseek-v4-pro',
            base_url: 'https://api.deepseek.com/v1/',
            api_key_env: 'DEEPSEEK_API_KEY',
          },
          malformed: { provider: 'deepseek' },
        },
      },
    })

    expect(config.subagents.maxParallel).toBe(8)
    expect(config.subagents.routes).toEqual({
      'gateway-review': {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
    })
  })
})
