import { describe, expect, test } from 'bun:test'
import {
  applyAgentGatewayEnvOverrides,
  getDefaultAgentGatewayConfig,
  normalizeAgentGatewayConfig,
} from './config.js'

describe('agent gateway config normalization', () => {
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
})
