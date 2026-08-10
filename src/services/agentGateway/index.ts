import { logForDebugging } from '../../utils/debug.js'
import { addAgentRunObserver } from './agentRunner.js'
import { AgentApiServer } from './apiServer.js'
import {
  type AgentGatewayConfig,
  isAgentGatewayEnabled,
  loadAgentGatewayConfig,
} from './config.js'
import {
  startCronScheduler,
  type CronJob,
  type CronSchedulerHandle,
} from './cron.js'
import { TelegramAgentBridge } from './telegram.js'
import {
  createBackgroundConsciousness,
  type ConsciousnessHandle,
} from './consciousness.js'
import { ensureMemoryFiles } from './memory.js'
import { shouldConsolidateDialogue, consolidateDialogue, shouldConsolidateScratchpad, consolidateScratchpad } from './consolidation.js'
import {
  buildTaskTraceFromAgentRun,
  processTaskReflection,
} from './reflection.js'

export type AgentGatewayRuntime = {
  config: AgentGatewayConfig
  api?: AgentApiServer
  telegram?: TelegramAgentBridge
  cron?: CronSchedulerHandle
  consciousness?: ConsciousnessHandle
  stopAgentRunObserver?: () => void
  startedAt: number
}

let runtime: AgentGatewayRuntime | null = null
let startPromise: Promise<AgentGatewayRuntime | null> | null = null

export function getAgentGatewayRuntime(): AgentGatewayRuntime | null {
  return runtime
}

export function resolveCronTelegramTarget(
  config: AgentGatewayConfig,
  job: CronJob,
): string | undefined {
  if (job.deliver === 'origin') {
    return job.origin?.platform === 'telegram' ? job.origin.chatId : undefined
  }
  if (job.deliver === 'telegram') {
    return (
      config.telegram.homeChatId ||
      (job.origin?.platform === 'telegram' ? job.origin.chatId : undefined)
    )
  }
  return undefined
}

export async function startAgentGatewayFromConfig(): Promise<AgentGatewayRuntime | null> {
  if (process.env.OPENCLAUDE_AGENT_GATEWAY_CHILD === '1') {
    return null
  }
  if (runtime) return runtime
  if (startPromise) return startPromise

  startPromise = startAgentGatewayRuntime()
  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

async function startAgentGatewayRuntime(): Promise<AgentGatewayRuntime | null> {
  const config = await loadAgentGatewayConfig()
  if (!isAgentGatewayEnabled(config)) {
    return null
  }

  const nextRuntime: AgentGatewayRuntime = {
    config,
    startedAt: Date.now(),
  }

  try {
    // Ensure memory files exist (scratchpad, identity, patterns, etc.)
    await ensureMemoryFiles()

    if (config.telegram.enabled && config.telegram.botToken) {
      nextRuntime.telegram = new TelegramAgentBridge(config)
      nextRuntime.telegram.start()
    }

    if (config.api.enabled) {
      nextRuntime.api = new AgentApiServer({
        config,
        getRuntimeStatus: () => ({
          telegram: nextRuntime.telegram?.getStatus(),
          consciousness: nextRuntime.consciousness?.getStatus(),
        }),
        onAgentResponse: async text => {
          if (
            config.telegram.enabled &&
            config.telegram.mirrorAgentApiResponses &&
            nextRuntime.telegram
          ) {
            await nextRuntime.telegram.sendHomeMessage(text)
          }
        },
      })
      await nextRuntime.api.start()
    }

    if (config.cron.enabled) {
      nextRuntime.cron = startCronScheduler(config, async (content, job) => {
        if (!nextRuntime.telegram) return
        const target = resolveCronTelegramTarget(config, job)
        if (!target) return
        await nextRuntime.telegram.sendMessage(
          target,
          `Cronjob Response: ${job.name}\n-----------\n\n${content}`,
        )
      })
    }

    if (config.ouroboros.enabled && config.ouroboros.consciousnessEnabled) {
      let activeAgentRuns = 0
      let consolidationRunning = false
      nextRuntime.consciousness = createBackgroundConsciousness({
        config,
        wakeupMin: config.ouroboros.wakeupMinSeconds,
        wakeupMax: config.ouroboros.wakeupMaxSeconds,
        maxRounds: config.ouroboros.maxRounds,
        budgetFraction: config.ouroboros.budgetFraction,
        evolutionIntervalSeconds: config.ouroboros.evolutionIntervalSeconds,
        onProactiveMessage: async text => {
          const target = config.telegram.homeChatId
          if (target && nextRuntime.telegram) {
            await nextRuntime.telegram.sendMessage(
              target,
              `Ouroboros Report\n-----------\n\n${text}`,
            )
          }
        },
        isTaskRunning: () => activeAgentRuns > 0,
      })

      nextRuntime.stopAgentRunObserver = addAgentRunObserver({
        onStart: context => {
          activeAgentRuns++
          nextRuntime.consciousness?.pause()
          nextRuntime.consciousness?.injectObservation(
            `Task started in ${context.cwd}: ${context.prompt.slice(0, 300)}`,
          )
        },
        onFinish: async (context, result) => {
          try {
            nextRuntime.consciousness?.injectObservation(
              result.exitCode === 0
                ? `Task completed: ${result.text.slice(0, 300)}`
                : `Task failed: ${result.stderr.slice(0, 300)}`,
            )

            if (!consolidationRunning) {
              consolidationRunning = true
              try {
                if (await shouldConsolidateDialogue()) {
                  await consolidateDialogue(config)
                }
                if (await shouldConsolidateScratchpad()) {
                  await consolidateScratchpad(config)
                }
              } finally {
                consolidationRunning = false
              }
            }

            const trace = buildTaskTraceFromAgentRun(context, result)
            void processTaskReflection(trace, config).catch(error => {
              logForDebugging(
                `[agent-gateway] task reflection failed: ${error instanceof Error ? error.message : String(error)}`,
              )
            })
          } catch {
            // Lifecycle memory is non-critical; agent responses must not fail because of it.
          } finally {
            activeAgentRuns = Math.max(0, activeAgentRuns - 1)
            if (activeAgentRuns === 0) {
              nextRuntime.consciousness?.resume()
            }
          }
        },
      })
    }

    runtime = nextRuntime
    logForDebugging(
      `[agent-gateway] started api=${Boolean(nextRuntime.api)} cron=${Boolean(nextRuntime.cron)} telegram=${Boolean(nextRuntime.telegram)} consciousness=${Boolean(nextRuntime.consciousness)}`,
    )
    return runtime
  } catch (error) {
    await stopRuntimeComponents(nextRuntime)
    throw error
  }
}

export async function stopAgentGateway(): Promise<void> {
  const pendingStart = startPromise
  if (pendingStart) {
    try {
      await pendingStart
    } catch {
      // The transactional startup already rolled back partial components.
    }
  }
  const current = runtime
  runtime = null
  await stopRuntimeComponents(current)
}

async function stopRuntimeComponents(
  current: AgentGatewayRuntime | null,
): Promise<void> {
  current?.stopAgentRunObserver?.()
  current?.consciousness?.stop()
  current?.cron?.stop()
  await current?.telegram?.stop()
  await current?.api?.stop()
}

export async function restartAgentGateway(): Promise<AgentGatewayRuntime | null> {
  await stopAgentGateway()
  return startAgentGatewayFromConfig()
}
