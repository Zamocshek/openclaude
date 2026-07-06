import { describe, expect, test } from 'bun:test'
import { getDefaultAgentGatewayConfig } from './config.js'
import type { CronJob } from './cron.js'
import { resolveCronTelegramTarget } from './index.js'

function makeJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: 'job',
    name: 'job',
    prompt: 'prompt',
    schedule: { kind: 'interval', minutes: 60, display: 'every 60m' },
    scheduleDisplay: 'every 60m',
    repeat: { completed: 0 },
    enabled: true,
    state: 'scheduled',
    deliver: 'local',
    createdAt: '2030-01-01T00:00:00.000Z',
    nextRunAt: '2030-01-01T01:00:00.000Z',
    ...overrides,
  }
}

describe('gateway cron Telegram delivery target', () => {
  test('uses home chat for generic Telegram delivery even when stale origin exists', () => {
    const config = getDefaultAgentGatewayConfig()
    config.telegram.homeChatId = '5117562403'

    expect(
      resolveCronTelegramTarget(
        config,
        makeJob({
          deliver: 'telegram',
          origin: { platform: 'telegram', chatId: '42' },
        }),
      ),
    ).toBe('5117562403')
  })

  test('uses origin chat for origin delivery', () => {
    const config = getDefaultAgentGatewayConfig()
    config.telegram.homeChatId = 'home'

    expect(
      resolveCronTelegramTarget(
        config,
        makeJob({
          deliver: 'origin',
          origin: { platform: 'telegram', chatId: 'origin' },
        }),
      ),
    ).toBe('origin')
  })
})
