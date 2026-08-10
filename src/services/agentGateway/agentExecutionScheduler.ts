export type AgentExecutionClass = 'foreground' | 'maintenance'

type ScheduledRun<T> = {
  id: number
  executionClass: AgentExecutionClass
  controller: AbortController
  cleanupExternalAbort?: () => void
  execute: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/**
 * Serializes heavyweight agent runtimes across Telegram, API, cron, and
 * maintenance sources. Foreground work can cancel an active maintenance run;
 * delegates spawned by one admitted runtime remain managed by that runtime.
 */
export class AgentExecutionScheduler {
  private active?: ScheduledRun<unknown>
  private queue: ScheduledRun<unknown>[] = []
  private nextId = 1
  private drainTimer?: ReturnType<typeof setTimeout>

  schedule<T>(
    executionClass: AgentExecutionClass,
    externalSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (externalSignal?.aborted) {
        reject(agentExecutionAbortError(externalSignal.reason))
        return
      }

      const controller = new AbortController()
      let cleanupExternalAbort: (() => void) | undefined

      const run: ScheduledRun<T> = {
        id: this.nextId++,
        executionClass,
        controller,
        ...(cleanupExternalAbort ? { cleanupExternalAbort } : {}),
        execute,
        resolve,
        reject,
      }

      if (externalSignal) {
        const forwardAbort = () => {
          controller.abort(externalSignal.reason)
          const queuedIndex = this.queue.findIndex(item => item.id === run.id)
          if (queuedIndex === -1) return
          this.queue.splice(queuedIndex, 1)
          run.cleanupExternalAbort?.()
          reject(agentExecutionAbortError(externalSignal.reason))
        }
        externalSignal.addEventListener('abort', forwardAbort, { once: true })
        cleanupExternalAbort = () => {
          externalSignal.removeEventListener('abort', forwardAbort)
        }
        run.cleanupExternalAbort = cleanupExternalAbort
      }

      this.queue.push(run as ScheduledRun<unknown>)

      if (
        executionClass === 'foreground'
        && this.active?.executionClass === 'maintenance'
        && !this.active.controller.signal.aborted
      ) {
        this.active.controller.abort(
          new Error('Maintenance run preempted by foreground agent work.'),
        )
      }

      this.requestDrain()
    })
  }

  getStatus(): {
    active?: AgentExecutionClass
    queuedForeground: number
    queuedMaintenance: number
  } {
    return {
      ...(this.active ? { active: this.active.executionClass } : {}),
      queuedForeground: this.queue.filter(
        run => run.executionClass === 'foreground',
      ).length,
      queuedMaintenance: this.queue.filter(
        run => run.executionClass === 'maintenance',
      ).length,
    }
  }

  private requestDrain(): void {
    if (this.active || this.drainTimer) return
    // Let source-local promise queues enqueue their next foreground item before
    // selecting deferred maintenance from a just-completed run.
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined
      this.drain()
    }, 0)
  }

  private drain(): void {
    if (this.active) return

    let run: ScheduledRun<unknown> | undefined
    while (this.queue.length > 0) {
      const foregroundIndex = this.queue.findIndex(
        candidate => candidate.executionClass === 'foreground',
      )
      const index = foregroundIndex >= 0 ? foregroundIndex : 0
      const candidate = this.queue.splice(index, 1)[0]!
      if (candidate.controller.signal.aborted) {
        candidate.cleanupExternalAbort?.()
        candidate.reject(agentExecutionAbortError(candidate.controller.signal.reason))
        continue
      }
      run = candidate
      break
    }
    if (!run) return
    this.active = run

    void run.execute(run.controller.signal).then(
      value => run.resolve(value),
      error => run.reject(error),
    ).finally(() => {
      run.cleanupExternalAbort?.()
      if (this.active?.id === run.id) this.active = undefined
      this.requestDrain()
    })
  }
}

function agentExecutionAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('Agent execution was aborted before it started.')
  error.name = 'AbortError'
  return error
}

export const gatewayAgentExecutionScheduler = new AgentExecutionScheduler()
