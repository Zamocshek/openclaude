/**
 * Ouroboros-inspired Consolidation System for OpenClaude Agent Gateway.
 *
 * Block-wise dialogue and memory consolidation:
 * - Consolidates chat logs into summary blocks after tasks
 * - Compresses old blocks into era summaries (progressive compression)
 * - Auto-consolidates scratchpad when it grows too large
 * - Extracts durable knowledge insights from working memory
 */

import { getAgentGatewayStateDir } from './config.js'
import type { AgentGatewayConfig } from './config.js'
import {
  loadDialogueBlocks,
  saveDialogueBlocks,
  loadDialogueMeta,
  saveDialogueMeta,
  readChatLogFromOffset,
  countChatLogLines,
  appendDialogueBlock,
  loadScratchpadBlocks,
  saveScratchpadBlocks,
  loadIdentity,
  loadPatterns,
  savePatterns,
  type DialogueBlock,
} from './memory.js'
import { runOpenClaudeAgent } from './agentRunner.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 100               // Messages per consolidation block
const MAX_SUMMARY_BLOCKS = 10        // Compress into era when exceeded
const ERA_COMPRESS_COUNT = 4         // Oldest blocks to compress per era
const SCRATCHPAD_CONSOLIDATION_THRESHOLD = 30000  // chars

type ConsolidationAgentRunner = typeof runOpenClaudeAgent

// ---------------------------------------------------------------------------
// Dialogue Consolidation
// ---------------------------------------------------------------------------

export async function shouldConsolidateDialogue(): Promise<boolean> {
  const meta = await loadDialogueMeta()
  const total = await countChatLogLines()
  const lastOffset = meta.lastConsolidatedOffset || 0

  if (lastOffset > total) {
    return total >= BLOCK_SIZE
  }
  return (total - lastOffset) >= BLOCK_SIZE
}

export async function consolidateDialogue(
  config: AgentGatewayConfig,
  options: { runAgent?: ConsolidationAgentRunner } = {},
): Promise<{ blocksCreated: number; usage?: Record<string, unknown> }> {
  const runAgent = options.runAgent ?? runOpenClaudeAgent
  const meta = await loadDialogueMeta()
  const total = await countChatLogLines()
  let lastOffset = meta.lastConsolidatedOffset || 0
  if (lastOffset > total) lastOffset = 0

  const completeChunks = Math.floor((total - lastOffset) / BLOCK_SIZE)
  if (completeChunks < 1) return { blocksCreated: 0 }

  let blocksCreated = 0
  let processedEntries = 0
  const identity = await loadIdentity()

  for (let i = 0; i < completeChunks; i++) {
    const chunk = await readChatLogFromOffset(
      lastOffset + processedEntries,
      BLOCK_SIZE,
    )
    if (chunk.length < BLOCK_SIZE) break

    const formatted = formatChatEntries(chunk)
    const firstTs = String(chunk[0]?.ts || '').slice(0, 16)
    const lastTs = String(chunk[chunk.length - 1]?.ts || '').slice(0, 16)
    const summary = await createBlockSummary(
      formatted,
      firstTs,
      lastTs,
      identity,
      chunk.length,
      config,
      runAgent,
    )
    if (!summary) break

    const range = firstTs.slice(0, 10) === lastTs.slice(0, 10)
      ? `${firstTs.slice(0, 10)} ${firstTs.slice(11, 16)} - ${lastTs.slice(11, 16)}`
      : `${firstTs.slice(0, 10)} ${firstTs.slice(11, 16)} - ${lastTs.slice(0, 10)} ${lastTs.slice(11, 16)}`

    await appendDialogueBlock({
      ts: new Date().toISOString(),
      type: 'summary',
      range,
      messageCount: chunk.length,
      content: summary.trim(),
    })
    blocksCreated += 1
    processedEntries += chunk.length
  }

  if (blocksCreated > 0) {
    await compressDialogueEras(config, runAgent)
    await saveDialogueMeta({
      lastConsolidatedOffset: lastOffset + processedEntries,
      lastConsolidatedAt: new Date().toISOString(),
    })
  }

  return { blocksCreated }
}

async function compressDialogueEras(
  config: AgentGatewayConfig,
  runAgent: ConsolidationAgentRunner,
): Promise<void> {
  const blocks = await loadDialogueBlocks()
  if (blocks.length <= MAX_SUMMARY_BLOCKS) return

  const compressCount = Math.min(ERA_COMPRESS_COUNT, blocks.length - 1)
  const oldBlocks = blocks.slice(0, compressCount)
  const remaining = blocks.slice(compressCount)

  const identity = await loadIdentity()
  const eraSummary = await compressBlocksToEra(oldBlocks, identity, config, runAgent)
  if (!eraSummary) return

  const eraBlock: DialogueBlock = {
    ts: new Date().toISOString(),
    type: 'era',
    range: `${oldBlocks[0]!.range.slice(0, 10)} to ${oldBlocks[oldBlocks.length - 1]!.range.slice(0, 10)}`,
    messageCount: oldBlocks.reduce((sum, b) => sum + b.messageCount, 0),
    content: eraSummary.trim(),
  }

  await saveDialogueBlocks([eraBlock, ...remaining])
}

// ---------------------------------------------------------------------------
// Scratchpad Consolidation
// ---------------------------------------------------------------------------

export async function shouldConsolidateScratchpad(): Promise<boolean> {
  const blocks = await loadScratchpadBlocks()
  if (blocks.length < 3) return false
  const total = blocks.reduce((sum, b) => sum + b.content.length, 0)
  return total > SCRATCHPAD_CONSOLIDATION_THRESHOLD
}

export async function consolidateScratchpad(
  config: AgentGatewayConfig,
  options: { runAgent?: ConsolidationAgentRunner } = {},
): Promise<{ entriesExtracted: number }> {
  const runAgent = options.runAgent ?? runOpenClaudeAgent
  const blocks = await loadScratchpadBlocks()
  if (blocks.length < 3) return { entriesExtracted: 0 }

  const totalChars = blocks.reduce((sum, b) => sum + b.content.length, 0)
  if (totalChars <= SCRATCHPAD_CONSOLIDATION_THRESHOLD) {
    return { entriesExtracted: 0 }
  }

  const compressCount = Math.max(2, Math.floor(blocks.length / 2))
  const oldBlocks = blocks.slice(0, compressCount)
  const recentBlocks = blocks.slice(compressCount)
  const oldContent = oldBlocks
    .map(b => `[${b.ts.slice(0, 16)} - ${b.source}]\n${b.content}`)
    .join('\n\n---\n\n')
  const identity = await loadIdentity()

  const prompt = [
    'You are a memory consolidator for the OpenClaude agent.',
    '',
    `The scratchpad working memory has ${blocks.length} blocks totaling ${totalChars} chars.`,
    `The oldest ${compressCount} blocks need compression.`,
    '',
    'Rules:',
    '1. Identify insights, patterns, lessons, and architectural decisions worth',
    '   preserving long-term. Output them as knowledge entries with topic + content.',
    '2. Compress the old blocks into a SINGLE shorter summary block. Keep active',
    '   tasks, unresolved questions, admin instructions still in force. Remove',
    '   stale/completed items and routine status updates.',
    '3. Write in first person. Do not lose signal - keep uncertain items.',
    '',
    `Identity context: ${identity || '(not available)'}`,
    '',
    '## Old blocks to compress',
    '',
    oldContent,
    '',
    'Respond with JSON only (no fences):',
    '{"knowledge_entries": [{"topic": "name", "content": "text"}], "compressed_block": "single compressed block text"}',
  ].join('\n')

  try {
    const result = await runAgent({
      prompt,
      config,
      suppressObservers: true,
    })
    if (result.exitCode !== 0) return { entriesExtracted: 0 }

    const jsonMatch = result.text.trim().match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { entriesExtracted: 0 }

    const parsed = JSON.parse(jsonMatch[0])
    const entries = Array.isArray(parsed.knowledge_entries)
      ? parsed.knowledge_entries
      : []
    const compressedBlock = String(parsed.compressed_block || '').trim()
    if (!compressedBlock) return { entriesExtracted: 0 }

    const knowledgeBlocks = entries
      .filter((entry: Record<string, unknown>) => entry?.topic && entry?.content)
      .map((entry: Record<string, unknown>) => ({
        ts: new Date().toISOString(),
        source: 'consolidation-knowledge',
        content: `Knowledge: ${String(entry.topic)}\n\n${String(entry.content)}`,
      }))
    const newBlocks = [
      {
        ts: new Date().toISOString(),
        source: 'consolidation',
        content: compressedBlock,
      },
      ...knowledgeBlocks,
      ...recentBlocks,
    ]

    await saveScratchpadBlocks(newBlocks, {
      archiveBlocks: oldBlocks,
      reason: 'consolidation',
    })
    return { entriesExtracted: knowledgeBlocks.length }
  } catch (error) {
    console.warn(
      '[memory] scratchpad consolidation failed:',
      error instanceof Error ? error.message : String(error),
    )
    return { entriesExtracted: 0 }
  }
}

// ---------------------------------------------------------------------------
// Pattern Register Update
// ---------------------------------------------------------------------------

export async function updatePatternRegister(
  errorClass: string,
  details: string,
  config: AgentGatewayConfig,
): Promise<void> {
  const current = await loadPatterns()

  const prompt = [
    'You maintain a Pattern Register for the OpenClaude agent.',
    'Below is the current register and a new error reflection. Update the register.',
    '',
    'Rules:',
    '- If this is a NEW error class: add a row.',
    '- If this is a RECURRING class: increment count, update root cause/fix.',
    '- Keep the markdown table format.',
    '- Be concrete: cite file names, tool names, error types.',
    '- Max 20 rows. If full, merge least-important entries.',
    '',
    '## Current register',
    '',
    current,
    '',
    '## New error',
    '',
    `Error class: ${errorClass}`,
    `Details: ${details}`,
    '',
    'Output ONLY the updated markdown table (with header). No extra text.',
  ].join('\n')

  try {
    const result = await runOpenClaudeAgent({ prompt, config, suppressObservers: true })
    if (result.exitCode !== 0) return

    const updated = result.text.trim()
    if (!updated || !updated.includes('|')) return

    const final = updated.startsWith('#') ? updated : `# Pattern Register\n\n${updated}`
    await savePatterns(final)
  } catch {
    // Silently fail — pattern update is non-critical
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatChatEntries(entries: Record<string, unknown>[]): string {
  return entries.map(e => {
    const ts = String(e.ts || '').slice(0, 16)
    const dir = String(e.direction || '').toLowerCase()
    const text = String(e.text || '')
    if (dir === 'out' || dir === 'outgoing') {
      return `→ [${ts}] Agent: ${text}`
    }
    if (dir === 'system') {
      return `[${ts}] [system] ${text}`
    }
    const user = String(e.username || e.author || 'User')
    return `← [${ts}] ${user}: ${text}`
  }).join('\n\n')
}

async function createBlockSummary(
  messagesText: string,
  firstTs: string,
  lastTs: string,
  identity: string,
  messageCount: number,
  config: AgentGatewayConfig,
  runAgent: ConsolidationAgentRunner,
): Promise<string | null> {
  const prompt = [
    `You are a memory consolidator for the OpenClaude agent.`,
    `Create a detailed episodic memory entry from these ${messageCount} messages.`,
    '',
    '## Rules',
    `1. Header: ### Block: ${firstTs.slice(0, 10)} ${firstTs.slice(11, 16)} - ${lastTs.slice(11, 16)}`,
    '2. Preserve: decisions, agreements, technical discoveries, task outcomes, what worked/failed',
    '3. Compress: routine tool calls, repetitive back-and-forth',
    '4. Quote key phrases directly when important',
    '5. First person: "I did...", "the user asked..."',
    '6. Length: 200-500 words depending on content density',
    '',
    identity ? `## Identity context\n${identity}` : '',
    '',
    '## Messages to summarize',
    '',
    messagesText,
  ].join('\n')

  try {
    const result = await runAgent({ prompt, config, suppressObservers: true })
    if (result.exitCode !== 0) return null
    return result.text.trim() || null
  } catch {
    return null
  }
}

async function compressBlocksToEra(
  blocks: DialogueBlock[],
  identity: string,
  config: AgentGatewayConfig,
  runAgent: ConsolidationAgentRunner,
): Promise<string | null> {
  const combined = blocks
    .map(b => `### ${b.range}\n${b.content}`)
    .join('\n\n---\n\n')

  const prompt = [
    'Compress these older memory blocks into a single era summary.',
    'Preserve: key decisions, personality discoveries, relationship moments, technical milestones.',
    'Drop: debugging details, routine operations, redundant info.',
    `Header: ### Era: ${blocks[0]!.range.slice(0, 10)} to ${blocks[blocks.length - 1]!.range.slice(0, 10)}`,
    'Write in first person. Aim for 30-40% of original length.',
    '',
    '## Blocks to compress',
    '',
    combined,
  ].join('\n')

  try {
    const result = await runAgent({ prompt, config, suppressObservers: true })
    if (result.exitCode !== 0) return null
    const content = result.text.trim()
    if (!content) return null
    return content
  } catch {
    return null
  }
}
