import { describe, expect, test } from 'bun:test'
import { DEFAULT_CRON_JITTER_CONFIG, type CronTask } from './cronTasks.js'
import { isRecurringTaskAged } from './cronScheduler.js'

describe('cron scheduler recurring age limit', () => {
  test('does not auto-expire recurring tasks by default', () => {
    const createdAt = Date.UTC(2030, 0, 1)
    const task: CronTask = {
      id: 'abcd1234',
      cron: '0 9 * * 1',
      prompt: 'persistent reminder',
      createdAt,
      recurring: true,
    }

    expect(DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs).toBe(0)
    expect(
      isRecurringTaskAged(
        task,
        createdAt + 365 * 24 * 60 * 60 * 1000,
        DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs,
      ),
    ).toBe(false)
  })

  test('still supports an operator-configured positive age cap', () => {
    const task: CronTask = {
      id: 'abcd1234',
      cron: '0 9 * * 1',
      prompt: 'temporary reminder',
      createdAt: 1000,
      recurring: true,
    }

    expect(isRecurringTaskAged(task, 3000, 1000)).toBe(true)
  })
})
