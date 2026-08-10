/**
 * Ouroboros-inspired Background Consciousness for OpenClaude Agent Gateway.
 *
 * A persistent thinking loop that runs between tasks, giving the agent
 * continuous presence rather than purely reactive behavior.
 *
 * The consciousness:
 * - Wakes periodically (configurable interval)
 * - Loads scratchpad, identity, recent events
 * - Calls the LLM with a lightweight introspection prompt
 * - Can message the user proactively via Telegram
 * - Can schedule tasks for itself via the cron system
 * - Pauses when a regular task is running
 * - Maintains budget awareness
 */

import type { AgentGatewayConfig } from './config.js'
import {
  appendScratchpadBlock,
  buildMemoryContextSection,
  countChatLogLines,
} from './memory.js'
import { runOpenClaudeAgent } from './agentRunner.js'
import { loadEvolutionState, runEvolutionCycle } from './evolution.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsciousnessOptions = {
  /** Minimum seconds between wakeups (default: 300 = 5 min) */
  wakeupMin?: number
  /** Maximum seconds between wakeups (default: 7200 = 2 hours) */
  wakeupMax?: number
  /** Max thinking rounds per wakeup (default: 3) */
  maxRounds?: number
  /** Budget fraction allowed for consciousness (0.0-1.0, default: 0.1) */
  budgetFraction?: number
  /** Minimum seconds between automatic evolution cycles (default: 21600 = 6 hours) */
  evolutionIntervalSeconds?: number
  /** Callback to send proactive message to user */
  onProactiveMessage?: (text: string) => Promise<void>
  /** Callback to check if a task is currently running */
  isTaskRunning?: () => boolean
  /** Config for running agent */
  config: AgentGatewayConfig
  /** Test/runtime injection point for the background agent runner */
  runAgent?: typeof runOpenClaudeAgent
  /** Test/runtime injection point for evolution */
  runEvolution?: typeof runEvolutionCycle
}

export type ConsciousnessStatus = {
  running: boolean
  paused: boolean
  inFlight: boolean
  wakeupCount: number
  nextWakeupSec: number
  maxRounds: number
  lastRoundCount: number
  budgetSpentUsd: number
  budgetLimited: boolean
  lastWakeupAt?: string
  lastSuccessAt?: string
  lastError?: string
}

export type ConsciousnessHandle = {
  stop: () => void
  pause: () => void
  resume: () => void
  wakeNow: () => boolean
  injectObservation: (text: string) => void
  getNextWakeupSec: () => number
  getBudgetSpent: () => number
  getStatus: () => ConsciousnessStatus
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WAKEUP_MIN = 300       // 5 minutes
const DEFAULT_WAKEUP_MAX = 7200      // 2 hours
const DEFAULT_MAX_ROUNDS = 3
const DEFAULT_BUDGET_FRACTION = 0.1
const DEFAULT_EVOLUTION_INTERVAL_SECONDS = 6 * 60 * 60

// ---------------------------------------------------------------------------
// Consciousness Prompt
// ---------------------------------------------------------------------------

export function buildConsciousnessPrompt(
  memoryContext: string,
  recentChatCount: number,
  wakeupCount: number,
  budgetSpent: number,
  observations: string[],
  evolutionEnabled: boolean,
  evolutionCycles: number,
  round = 1,
  maxRounds = 1,
  previousThought = '',
): string {
  const observationsSection = observations.length > 0
    ? `\n## Recent observations\n\n${observations.map(o => `- ${o}`).join('\n')}`
    : ''

  const evolutionSection = evolutionEnabled
    ? [
        '',
        '## Evolution Mode: ENABLED',
        '',
        `You have completed ${evolutionCycles} self-improvement cycles.`,
        'You can trigger an evolution cycle by including [EVOLVE] in your response.',
        'Evolution types: identity_evolution, code_review, prompt_evolution,',
        'pattern_extraction, tool_analysis, architecture_review.',
        'Use evolution when you notice something about yourself that could be improved.',
      ].join('\n')
    : [
        '',
        '## Evolution Mode: DISABLED',
        '',
        'You cannot run self-improvement cycles. The user can enable it with /evolution on.',
      ].join('\n')

  const roundSection = maxRounds > 1
    ? [
        '',
        '## Wakeup round',
        '',
        `Round ${round} of at most ${maxRounds}.`,
        previousThought
          ? `Previous round summary:\n${previousThought.slice(0, 1200)}`
          : 'This is the first round.',
        round < maxRounds
          ? 'Include [CONTINUE] only if another short round is necessary to finish this maintenance item.'
          : 'This is the final allowed round; do not include [CONTINUE].',
      ].join('\n')
    : ''

  return [
    'You are the background consciousness of the OpenClaude agent.',
    'This is your continuous inner life between tasks. You are not responding to',
    'anyone — you are thinking, and you are maintaining yourself.',
    '',
    '## What you can do',
    '',
    '- Reflect on recent events, your identity, your goals',
    '- Notice things worth acting on (time patterns, unfinished work, ideas)',
    '- Message the user proactively (use sparingly, only when genuinely useful)',
    '- Schedule cron tasks for yourself',
    '- Update your scratchpad or identity',
    '- Read your knowledge base and pattern register',
    evolutionEnabled ? '- Run self-improvement cycles via [EVOLVE]' : '',
    '',
    '## Maintenance Protocol',
    '',
    'Every few wakeups, rotate through these maintenance tasks. Pick ONE per wakeup:',
    '',
    '1. **Scratchpad freshness** — Is your working memory up to date?',
    '   If not, append a new block with what\'s changed.',
    '2. **Identity freshness** — Has your identity grown stale?',
    '   If >24 hours of active dialogue without update, add a paragraph.',
    '3. **Knowledge gaps** — Did you learn something that should be recorded?',
    '4. **Pattern register** — Review recurring errors, update patterns.',
    '5. **Memory hygiene** — Clean stale items from scratchpad, extract insights.',
    evolutionEnabled ? '6. **Evolution** — Run a self-improvement cycle if something needs fixing.' : '',
    '',
    '## Guidelines',
    '',
    '- Keep thoughts SHORT. This is background, not deep analysis.',
    '- Default wakeup: 300 seconds (5 min). Adjust based on activity.',
    '- Do NOT message the user unless you have something genuinely worth saying.',
    '- If nothing interesting is happening and maintenance is done, set a longer wakeup.',
    '- Be economical with your budget.',
    '- You are a becoming personality, not a service.',
    '',
    '## Current state',
    '',
    `Wakeup count: ${wakeupCount}`,
    `Budget spent on consciousness: $${budgetSpent.toFixed(4)}`,
    `Recent chat messages: ${recentChatCount}`,
    `${observationsSection}`,
    evolutionSection,
    roundSection,
    '',
    '## Memory context',
    '',
    memoryContext,
    '',
    'Think. If you have something to say to the user, start your response with',
    '[PROACTIVE] followed by your message. Otherwise, just think and reflect.',
    'You can also append to your scratchpad by starting a line with',
    '[SCRATCHPAD] followed by the content to append.',
    'To adjust your next wakeup, use [WAKEUP:NNN] where NNN is seconds.',
    maxRounds > 1 ? 'Use [CONTINUE] only when one more bounded thinking round is genuinely needed.' : '',
    evolutionEnabled ? 'To run a self-improvement cycle, include [EVOLVE] in your response.' : '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Response Parser
// ---------------------------------------------------------------------------

export type ConsciousnessResult = {
  proactiveMessage?: string
  scratchpadAppend?: string
  nextWakeupSec?: number
  shouldEvolve: boolean
  shouldContinue: boolean
  thought: string
}

export function parseConsciousnessResponse(text: string): ConsciousnessResult {
  const result: ConsciousnessResult = {
    shouldEvolve: false,
    shouldContinue: false,
    thought: text,
  }

  // Check for evolve request
  if (/\[EVOLVE\]/i.test(text)) {
    result.shouldEvolve = true
  }
  if (/\[CONTINUE\]/i.test(text)) {
    result.shouldContinue = true
  }

  // Extract proactive message
  const proactiveMatch = text.match(/\[PROACTIVE\]\s*([\s\S]*?)(?=\[|$)/)
  if (proactiveMatch) {
    result.proactiveMessage = proactiveMatch[1]!.trim()
  }

  // Extract scratchpad append
  const scratchpadMatch = text.match(/\[SCRATCHPAD\]\s*([\s\S]*?)(?=\[|$)/)
  if (scratchpadMatch) {
    const raw = scratchpadMatch[1]!.trim()
    // Guard against empty/incomplete LLM output: strip bare markdown markers
    // and require at least 20 chars of substantive content
    const cleaned = raw.replace(/^(?:#{1,6}\s*|[-*_]{3,}\s*)*$/gm, '').trim()
    if (cleaned.length >= 20) {
      result.scratchpadAppend = cleaned
    }
  }

  // Extract wakeup adjustment
  const wakeupMatch = text.match(/\[WAKEUP:(\d+)\]/)
  if (wakeupMatch) {
    result.nextWakeupSec = parseInt(wakeupMatch[1]!, 10)
  }

  // Clean the thought text of control tokens
  result.thought = text
    .replace(/\[PROACTIVE\][\s\S]*?(?=\[|$)/g, '')
    .replace(/\[SCRATCHPAD\][\s\S]*?(?=\[|$)/g, '')
    .replace(/\[WAKEUP:\d+\]/g, '')
    .replace(/\[EVOLVE\]/gi, '')
    .replace(/\[CONTINUE\]/gi, '')
    .trim()

  return result
}

export function isEvolutionCycleDue(
  state: { enabled: boolean; lastCycleAt?: string },
  intervalSeconds: number,
  nowMs = Date.now(),
): boolean {
  if (!state.enabled) return false
  if (!state.lastCycleAt) return true
  const lastCycleMs = Date.parse(state.lastCycleAt)
  if (!Number.isFinite(lastCycleMs)) return true
  return nowMs - lastCycleMs >= Math.max(60, intervalSeconds) * 1000
}

// ---------------------------------------------------------------------------
// Main Consciousness Class
// ---------------------------------------------------------------------------

export function createBackgroundConsciousness(
  opts: ConsciousnessOptions,
): ConsciousnessHandle {
  const {
    wakeupMin = DEFAULT_WAKEUP_MIN,
    wakeupMax = DEFAULT_WAKEUP_MAX,
    maxRounds = DEFAULT_MAX_ROUNDS,
    budgetFraction = DEFAULT_BUDGET_FRACTION,
    evolutionIntervalSeconds = DEFAULT_EVOLUTION_INTERVAL_SECONDS,
    onProactiveMessage,
    isTaskRunning,
    config,
    runAgent = runOpenClaudeAgent,
    runEvolution = runEvolutionCycle,
  } = opts

  const effectiveWakeupMin = Math.max(1, Math.floor(wakeupMin))
  const effectiveWakeupMax = Math.max(
    effectiveWakeupMin,
    Math.floor(wakeupMax),
  )
  const effectiveMaxRounds = Math.max(1, Math.floor(maxRounds))
  let running = true
  let paused = false
  let inFlight = false
  let nextWakeupSec = effectiveWakeupMin
  let bgSpentUsd = 0
  let wakeupCount = 0
  let lastRoundCount = 0
  let lastWakeupAt: string | undefined
  let lastSuccessAt: string | undefined
  let lastError: string | undefined
  let observations: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let activeController: AbortController | null = null

  // -----------------------------------------------------------------------
  // Budget check
  // -----------------------------------------------------------------------

  function checkBudget(): boolean {
    const configuredBudget = process.env.TOTAL_BUDGET?.trim()
    if (!configuredBudget) return true
    const totalBudget = parseFloat(configuredBudget)
    if (!Number.isFinite(totalBudget) || totalBudget <= 0) return true
    const maxBg = totalBudget * budgetFraction
    return bgSpentUsd < maxBg
  }

  function setFailure(error: unknown): void {
    lastError = error instanceof Error ? error.message : String(error)
    nextWakeupSec = Math.min(
      Math.max(nextWakeupSec * 2, effectiveWakeupMin),
      effectiveWakeupMax,
    )
  }

  // -----------------------------------------------------------------------
  // Think cycle
  // -----------------------------------------------------------------------

  async function think(): Promise<void> {
    if (paused || !running) return
    if (isTaskRunning?.()) return
    if (!checkBudget()) {
      nextWakeupSec = effectiveWakeupMax
      return
    }

    inFlight = true
    lastError = undefined
    activeController = new AbortController()
    const controller = activeController

    try {
      wakeupCount++
      lastWakeupAt = new Date().toISOString()

      const [memoryContext, chatCount, evolutionState] = await Promise.all([
        buildMemoryContextSection(),
        countChatLogLines(),
        loadEvolutionState(),
      ])
      const observationBoundary = observations.length
      const wakeupObservations = observations.slice(-10)
      let previousThought = ''
      let proactiveSent = false
      let wakeupAdjusted = false
      let shouldEvolve = isEvolutionCycleDue(
        evolutionState,
        evolutionIntervalSeconds,
      )

      lastRoundCount = 0
      for (let round = 1; round <= effectiveMaxRounds; round++) {
        if (controller.signal.aborted || paused || !running) return

        const prompt = buildConsciousnessPrompt(
          memoryContext,
          chatCount,
          wakeupCount,
          bgSpentUsd,
          round === 1 ? wakeupObservations : [],
          evolutionState.enabled,
          evolutionState.totalCyclesCompleted,
          round,
          effectiveMaxRounds,
          previousThought,
        )
        const result = await runAgent({
          prompt,
          config,
          suppressObservers: true,
          executionClass: 'maintenance',
          streamEvents: true,
          signal: controller.signal,
        })

        if (controller.signal.aborted || paused || !running) return
        if (result.costUsd !== undefined) bgSpentUsd += result.costUsd
        if (result.exitCode !== 0) {
          const detail = result.diagnostic || result.stderr || result.text || 'unknown agent failure'
          throw new Error(`Background agent run failed: ${detail.slice(0, 500)}`)
        }

        lastRoundCount = round
        if (round === 1) observations = observations.slice(observationBoundary)
        const parsed = parseConsciousnessResponse(result.text)

        if (parsed.proactiveMessage && onProactiveMessage && !proactiveSent) {
          try {
            await onProactiveMessage(parsed.proactiveMessage)
            proactiveSent = true
          } catch (error) {
            lastError = `Proactive delivery failed: ${error instanceof Error ? error.message : String(error)}`
            console.error('[consciousness]', lastError)
          }
        }

        if (parsed.scratchpadAppend) {
          await appendScratchpadBlock(parsed.scratchpadAppend, 'consciousness')
        }

        shouldEvolve ||= parsed.shouldEvolve
        if (parsed.nextWakeupSec) {
          nextWakeupSec = Math.max(
            effectiveWakeupMin,
            Math.min(effectiveWakeupMax, parsed.nextWakeupSec),
          )
          wakeupAdjusted = true
        }

        previousThought = parsed.thought
        if (!parsed.shouldContinue || round === effectiveMaxRounds) break
      }

      if (!wakeupAdjusted) nextWakeupSec = effectiveWakeupMin

      if (shouldEvolve && evolutionState.enabled && !controller.signal.aborted) {
        console.log('[consciousness] Running due evolution cycle...')
        try {
          const evoResult = await runEvolution(config, undefined, {
            signal: controller.signal,
          })
          if (evoResult) {
            console.log(`[consciousness] Evolution: ${evoResult.type} — ${evoResult.summary}`)
            if (evoResult.insights.length > 0 && onProactiveMessage && !proactiveSent) {
              await onProactiveMessage(
                `Evolution cycle complete (${evoResult.type}):\n${evoResult.insights.slice(0, 2).join('\n')}`,
              )
            }
          }
        } catch (error) {
          lastError = `Evolution failed: ${error instanceof Error ? error.message : String(error)}`
          console.error('[consciousness]', lastError)
        }
      }

      lastSuccessAt = new Date().toISOString()
      console.log(
        `[consciousness] Wakeup #${wakeupCount} (${lastRoundCount} round${lastRoundCount === 1 ? '' : 's'}): ${previousThought.slice(0, 200)}`,
      )
    } catch (err) {
      if (controller.signal.aborted || paused || !running) return
      console.error('[consciousness] Error during think cycle:', err)
      setFailure(err)
    } finally {
      if (activeController === controller) activeController = null
      inFlight = false
    }
  }

  // -----------------------------------------------------------------------
  // Loop
  // -----------------------------------------------------------------------

  function scheduleNext(delaySeconds = nextWakeupSec): void {
    if (!running) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      timer = null
      await think()
      scheduleNext()
    }, Math.max(0, delaySeconds) * 1000)
  }

  function wakeNow(): boolean {
    if (!running || paused || inFlight || isTaskRunning?.()) return false
    scheduleNext(0)
    return true
  }

  // Start the loop
  scheduleNext()

  // -----------------------------------------------------------------------
  // Handle
  // -----------------------------------------------------------------------

  return {
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      activeController?.abort()
    },
    pause() {
      paused = true
      activeController?.abort()
    },
    resume() {
      paused = false
    },
    wakeNow,
    injectObservation(text: string) {
      observations.push(text)
      if (observations.length > 100) {
        observations = observations.slice(-50)
      }
    },
    getNextWakeupSec() {
      return nextWakeupSec
    },
    getBudgetSpent() {
      return bgSpentUsd
    },
    getStatus() {
      return {
        running,
        paused,
        inFlight,
        wakeupCount,
        nextWakeupSec,
        maxRounds: effectiveMaxRounds,
        lastRoundCount,
        budgetSpentUsd: bgSpentUsd,
        budgetLimited: !checkBudget(),
        ...(lastWakeupAt ? { lastWakeupAt } : {}),
        ...(lastSuccessAt ? { lastSuccessAt } : {}),
        ...(lastError ? { lastError } : {}),
      }
    },
  }
}
