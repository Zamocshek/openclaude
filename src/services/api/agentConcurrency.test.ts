import { describe, expect, test } from 'bun:test'

import { AgentConcurrencyLimiter } from './agentConcurrency.js'

describe('AgentConcurrencyLimiter', () => {
  test('enforces the configured maximum and wakes waiters in FIFO order', async () => {
    const limiter = new AgentConcurrencyLimiter()
    const releaseFirst = await limiter.acquire(2)
    const releaseSecond = await limiter.acquire(2)
    const order: string[] = []

    const third = limiter.acquire(2).then(release => {
      order.push('third')
      return release
    })
    const fourth = limiter.acquire(2).then(release => {
      order.push('fourth')
      return release
    })

    expect(limiter.snapshot()).toEqual({ active: 2, queued: 2 })
    releaseFirst()
    const releaseThird = await third
    expect(order).toEqual(['third'])
    expect(limiter.snapshot()).toEqual({ active: 2, queued: 1 })

    releaseSecond()
    const releaseFourth = await fourth
    expect(order).toEqual(['third', 'fourth'])

    releaseThird()
    releaseFourth()
    releaseFourth()
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 })
  })

  test('removes an aborted waiter without leaking capacity', async () => {
    const limiter = new AgentConcurrencyLimiter()
    const release = await limiter.acquire(1)
    const controller = new AbortController()
    const waiting = limiter.acquire(1, controller.signal)

    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(limiter.snapshot()).toEqual({ active: 1, queued: 0 })

    release()
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 })
  })
})
