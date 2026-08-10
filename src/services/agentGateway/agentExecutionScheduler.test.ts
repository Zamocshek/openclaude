import { describe, expect, test } from 'bun:test'
import { AgentExecutionScheduler } from './agentExecutionScheduler.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}

describe('AgentExecutionScheduler', () => {
  test('does not enqueue work whose external signal is already aborted', async () => {
    const scheduler = new AgentExecutionScheduler()
    const controller = new AbortController()
    controller.abort(new Error('request disconnected'))
    let executed = false

    const scheduled = scheduler.schedule('foreground', controller.signal, async () => {
      executed = true
      return 'unexpected'
    })

    await expect(scheduled).rejects.toThrow('request disconnected')
    expect(executed).toBe(false)
    expect(scheduler.getStatus()).toEqual({
      queuedForeground: 0,
      queuedMaintenance: 0,
    })
  })

  test('removes externally aborted work while it is waiting in the queue', async () => {
    const scheduler = new AgentExecutionScheduler()
    const active = deferred<string>()
    const order: string[] = []
    const first = scheduler.schedule('foreground', undefined, async () => {
      order.push('active')
      return active.promise
    })
    await waitFor(() => order.includes('active'))

    const controller = new AbortController()
    const queued = scheduler.schedule('foreground', controller.signal, async () => {
      order.push('cancelled')
      return 'unexpected'
    })
    controller.abort(new Error('client disconnected'))

    await expect(queued).rejects.toThrow('client disconnected')
    expect(scheduler.getStatus()).toEqual({
      active: 'foreground',
      queuedForeground: 0,
      queuedMaintenance: 0,
    })
    active.resolve('done')
    expect(await first).toBe('done')
    expect(order).toEqual(['active'])
  })

  test('serializes runtimes and admits queued foreground work before maintenance', async () => {
    const scheduler = new AgentExecutionScheduler()
    const first = deferred<string>()
    const second = deferred<string>()
    const order: string[] = []

    const active = scheduler.schedule('foreground', undefined, async () => {
      order.push('active')
      return first.promise
    })
    await waitFor(() => order.includes('active'))

    const maintenance = scheduler.schedule('maintenance', undefined, async () => {
      order.push('maintenance')
      return 'maintenance'
    })
    const foreground = scheduler.schedule('foreground', undefined, async () => {
      order.push('foreground')
      return second.promise
    })

    first.resolve('active')
    await waitFor(() => order.includes('foreground'))
    expect(order).toEqual(['active', 'foreground'])
    second.resolve('foreground')

    expect(await active).toBe('active')
    expect(await foreground).toBe('foreground')
    expect(await maintenance).toBe('maintenance')
    expect(order).toEqual(['active', 'foreground', 'maintenance'])
  })

  test('preempts an active maintenance runtime when foreground work arrives', async () => {
    const scheduler = new AgentExecutionScheduler()
    let maintenanceSignal: AbortSignal | undefined

    const maintenance = scheduler.schedule('maintenance', undefined, signal => {
      maintenanceSignal = signal
      return new Promise<string>(resolve => {
        signal.addEventListener('abort', () => resolve('preempted'), {
          once: true,
        })
      })
    })
    await waitFor(() => Boolean(maintenanceSignal))

    const foreground = scheduler.schedule(
      'foreground',
      undefined,
      async () => 'foreground',
    )

    expect(await maintenance).toBe('preempted')
    expect(maintenanceSignal?.aborted).toBe(true)
    expect(await foreground).toBe('foreground')
    await waitFor(() => scheduler.getStatus().active === undefined)
    expect(scheduler.getStatus()).toEqual({
      queuedForeground: 0,
      queuedMaintenance: 0,
    })
  })
})
