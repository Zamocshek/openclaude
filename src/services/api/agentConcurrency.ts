import { AbortError } from '../../utils/errors.js'

type Waiter = {
  limit: number
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  onAbort?: () => void
}

/**
 * FIFO process-wide limiter for model-running subagents. Each gateway child
 * process owns one limiter, so all Agent calls in the same top-level run share
 * the configured capacity without external coordination.
 */
export class AgentConcurrencyLimiter {
  private active = 0
  private readonly queue: Waiter[] = []

  acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
    const normalizedLimit = normalizeLimit(limit)
    if (signal?.aborted) {
      return Promise.reject(new AbortError('Subagent aborted while waiting for an execution slot'))
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { limit: normalizedLimit, signal, resolve, reject }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(new AbortError('Subagent aborted while waiting for an execution slot'))
          this.pump()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
      this.pump()
    })
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length }
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const waiter = this.queue[0]
      if (this.active >= waiter.limit) return
      this.queue.shift()
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      if (waiter.signal?.aborted) {
        waiter.reject(new AbortError('Subagent aborted while waiting for an execution slot'))
        continue
      }

      this.active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.pump()
      })
    }
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER
  return Math.max(1, Math.floor(limit))
}

const processLimiter = new AgentConcurrencyLimiter()

export function acquireAgentExecutionSlot(
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<() => void> {
  return processLimiter.acquire(limit ?? Number.MAX_SAFE_INTEGER, signal)
}

export function getAgentConcurrencySnapshot(): { active: number; queued: number } {
  return processLimiter.snapshot()
}
