import {
  hasCodingMutationIntent,
  runOpenClaudeAgent,
  type AgentRunCompletionGateDisposition,
  type AgentRunEvidence,
  type AgentRunOptions,
  type AgentRunResult,
} from './agentRunner.js'
import { getAgentInteractionKey } from './agentInteractions.js'
import { extractCurrentUserRequest } from './capabilityRouting.js'

const SUCCESSFUL_NATIVE_MUTATION_RE =
  /^tool result success \((?:Edit|Write|NotebookEdit|ApplyPatch|apply_patch|mcp[^:)]*(?:write|edit|patch|create[_-]?file|delete[_-]?file|move[_-]?file|rename[_-]?file))\b/iu
const SUCCESSFUL_SHELL_MUTATION_RE =
  /^tool result success \((?:Bash|PowerShell):[\s\S]*(?:\b(?:sed|perl)\s+-[^\s]*i\b|\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|git\s+apply|patch|cp|mv)\b|(?:write_text|writeFileSync|writeFile|appendFileSync|appendFile)\s*\(|open\s*\([^)]*,\s*["'][wa]|(?:^|[\s"'`])(?:>>?|2>)\s*[^\s&|])/iu
const SUCCESSFUL_TEE_MUTATION_RE =
  /^tool result success \((?:Bash|PowerShell):[\s\S]*\btee\b/iu
const BENIGN_SHELL_REDIRECT_RE =
  /(?:\d*>\s*(?:\/dev\/null\b|NUL\b|\$null\b)|\d*>&\d+)/giu
const SUCCESSFUL_SHELL_TOOL_EVENT_RE =
  /^tool result success \((?:Bash|PowerShell):\s*([\s\S]+)\)$/iu
const VERIFIER_COMMAND_RE = new RegExp([
  '(?:^|(?:&&|;|\\n)\\s*)',
  '(?:',
  'git\\s+diff\\s+--check\\b',
  '|docker(?:\\s+compose)?\\s+config\\b',
  '|bash\\s+-n\\b',
  '|node\\s+--check\\b',
  '|(?:bun|npm|pnpm|yarn)(?:\\s+run)?\\s+(?:test|typecheck|lint|build|check|verify|smoke)(?=\\s|$)',
  '|(?:npx\\s+)?(?:vitest|jest|eslint|tsc|playwright)(?=\\s|$)',
  '|(?:python\\d*(?:\\.\\d+)?|py)\\s+-m\\s+(?:pytest|unittest|compileall|py_compile)(?=\\s|$)',
  '|pytest(?=\\s|$)',
  '|cargo\\s+(?:test|check|clippy|build)(?=\\s|$)',
  '|go\\s+(?:test|vet|build)(?=\\s|$)',
  '|dotnet\\s+(?:test|build)(?=\\s|$)',
  '|(?:mvn|gradle)\\s+(?:test|check|build)(?=\\s|$)',
  '|ruff\\s+(?:check|format\\s+--check)(?=\\s|$)',
  '|mypy(?=\\s|$)',
  ')',
].join(''), 'iu')
const SUCCESSFUL_RUNTIME_MUTATION_RE =
  /^tool result success \((?:Bash|PowerShell):[\s\S]*(?:\b(?:apt(?:-get)?|apk|dnf|yum|pip\d*|npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|update|upgrade)\b|\b(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable)\b|\bpm2\s+(?:start|stop|restart|reload|delete|save)\b|\bdocker(?:\s+compose)?\s+(?:up|start|stop|restart|rm)\b|\bkubectl\s+(?:apply|delete|patch|rollout\s+restart)\b|\bsetWebhook\b)/iu
const SUCCESSFUL_RUNTIME_VERIFIER_RE =
  /^tool result success \((?:Bash|PowerShell|TaskOutput|Agent):[\s\S]*(?:\b(?:systemctl\s+(?:status|is-active|is-enabled)|service\s+\S+\s+status|pm2\s+(?:status|list|show)|docker(?:\s+compose)?\s+ps|kubectl\s+(?:get|describe|rollout\s+status)|getWebhookInfo|getMe)\b|\bcurl\b[\s\S]*(?:\/health|\/ready|\/readiness|\/live|\/status|\/webhook)|\bsmoke(?:\s+test)?\b)/iu
const COMPLETION_GATE_ENVELOPE_RE =
  /<openclaude_quality>([\s\S]{1,4000}?)<\/openclaude_quality>/iu
const EXPLICIT_EXIT_MASK_RE =
  /(?:\|\|\s*(?:true|:|echo\b|printf\b|Write-Output\b)|;\s*(?:true\b|exit\s+0\b)|\b(?:exit|return)\s+0\s*(?:[;)]|$))/iu
const SHELL_PIPE_RE = /(^|[^|])\|([^|]|$)/u
const PIPE_STATUS_PRESERVED_RE =
  /(?:\bpipefail\b|\bPIPESTATUS\b|\bSTATUS\s*=\s*\$\?\b[\s\S]*\bexit\s+\$STATUS\b)/u

function isSuccessfulMutation(event: string): boolean {
  const mutationEvent = event.replace(BENIGN_SHELL_REDIRECT_RE, '')
  return SUCCESSFUL_NATIVE_MUTATION_RE.test(event)
    || SUCCESSFUL_SHELL_MUTATION_RE.test(mutationEvent)
    || SUCCESSFUL_RUNTIME_MUTATION_RE.test(mutationEvent)
    || (
      SUCCESSFUL_TEE_MUTATION_RE.test(mutationEvent)
      && !isReliableVerifierEvent(event)
    )
}

export function isMaskedVerifierEvent(event: string): boolean {
  if (
    !isSuccessfulVerifierCommandEvent(event)
    && !SUCCESSFUL_RUNTIME_VERIFIER_RE.test(event)
  ) return false
  if (EXPLICIT_EXIT_MASK_RE.test(event)) return true
  return SHELL_PIPE_RE.test(event) && !PIPE_STATUS_PRESERVED_RE.test(event)
}

function isReliableVerifierEvent(event: string): boolean {
  return (
    isSuccessfulVerifierCommandEvent(event)
    || SUCCESSFUL_RUNTIME_VERIFIER_RE.test(event)
  ) && !isMaskedVerifierEvent(event)
}

function isSuccessfulVerifierCommandEvent(event: string): boolean {
  const raw = SUCCESSFUL_SHELL_TOOL_EVENT_RE.exec(event)?.[1]?.trim()
  if (!raw) return false
  const command = raw.length >= 2 && (
    (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))
  )
    ? raw.slice(1, -1)
    : raw
  return VERIFIER_COMMAND_RE.test(command)
}

export function extractCodingCompletionDisposition(
  text: string,
): AgentRunCompletionGateDisposition | undefined {
  const raw = COMPLETION_GATE_ENVELOPE_RE.exec(text)?.[1]?.trim()
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const status = String(value.status || '')
    const scope = String(value.scope || '')
    const reason = String(value.reason || '').trim().slice(0, 1000)
    if (!['verified', 'blocked', 'failed'].includes(status)) return undefined
    if (!['workspace', 'runtime', 'none'].includes(scope)) return undefined
    if (!reason) return undefined
    return {
      status: status as AgentRunCompletionGateDisposition['status'],
      scope: scope as AgentRunCompletionGateDisposition['scope'],
      reason,
    }
  } catch {
    return undefined
  }
}

export function stripCodingCompletionDisposition(text: string): string {
  return text.replace(COMPLETION_GATE_ENVELOPE_RE, '').trim()
}

export function attachCodingCompletionDisposition(
  result: AgentRunResult,
): AgentRunResult {
  const completionGate = extractCodingCompletionDisposition(result.text)
  if (!completionGate) return result
  return {
    ...result,
    text: stripCodingCompletionDisposition(result.text),
    completionGate,
    completionStatus: completionGate.status === 'blocked'
      ? 'blocked'
      : completionGate.status === 'verified'
        ? 'completed'
        : result.completionStatus,
  }
}

export function isCodingCompletionGateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENCLAUDE_AGENT_CODING_COMPLETION_GATE
  if (raw === undefined || raw.trim() === '') return true
  return !/^(?:0|false|no|off)$/iu.test(raw.trim())
}

export function getCodingCompletionGap(
  prompt: string,
  result: AgentRunResult,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const codingMutationIntent = result.taskRoute?.codingMutationIntent
    ?? hasCodingMutationIntent(prompt)
  if (
    result.exitCode !== 0
    || !isCodingCompletionGateEnabled(env)
    || !codingMutationIntent
  ) {
    return undefined
  }

  if (result.pendingInteractions?.length) return undefined
  if (result.completionGate?.status === 'blocked') return undefined
  if (result.completionGate?.status === 'failed') {
    return `The evaluator reported an incomplete task: ${result.completionGate.reason}`
  }

  const evidence = result.evidence || []
  const evidenceMutations = evidence.filter(item => (
    item.kind === 'mutation' && item.success
  ))
  for (const mutation of evidenceMutations) {
    const verified = evidence.some(item => (
      item.kind === 'verification'
      && item.success
      && item.sequence > mutation.sequence
      && isMatchingEvidenceTarget(mutation, item)
    ))
    if (!verified) {
      return `The ${mutation.scope} target ${mutation.target} changed without a successful matching post-change verifier.`
    }
  }
  if (evidenceMutations.length > 0) return undefined

  const activity = result.activity || []
  const hasSuccessfulVerifier = activity.some(isReliableVerifierEvent)
  const hasMaskedVerifier = activity.some(isMaskedVerifierEvent)
  let lastMutation = -1
  for (let index = 0; index < activity.length; index += 1) {
    if (isSuccessfulMutation(activity[index]!)) lastMutation = index
  }
  if (lastMutation < 0) {
    if (
      result.completionGate?.status === 'verified'
      && result.completionGate.scope === 'none'
    ) {
      return undefined
    }
    if (hasMaskedVerifier) {
      return 'The only apparent verifier masks its real exit status, so it cannot prove completion.'
    }
    return !hasSuccessfulVerifier
      ? 'The coding task reported success without an observable file mutation or a successful verifier.'
      : undefined
  }

  const postMutationActivity = activity.slice(lastMutation + 1)
  const verifiedAfterMutation = postMutationActivity.some(isReliableVerifierEvent)
  if (verifiedAfterMutation) return undefined

  if (postMutationActivity.some(isMaskedVerifierEvent)) {
    return 'The post-edit verifier masks its real exit status. Re-run it without a pipeline, `|| true`, or another success-forcing wrapper.'
  }

  return 'Code or configuration changed without a successful post-edit verifier.'
}

function isMatchingEvidenceTarget(
  mutation: AgentRunEvidence,
  verification: AgentRunEvidence,
): boolean {
  if (mutation.scope !== verification.scope) return false
  if (mutation.target === verification.target) return true
  if (mutation.scope === 'workspace') {
    return mutation.target === 'workspace:*'
      || verification.target === 'workspace:*'
  }
  const [mutationPrefix, mutationName] = mutation.target.split(/(?=\/(?:service|pm2|filesystem|packages):?)/u)
  const [verificationPrefix, verificationName] = verification.target.split(/(?=\/(?:service|pm2|filesystem|packages):?)/u)
  if (!mutationPrefix || mutationPrefix !== verificationPrefix) return false
  return mutationName?.endsWith('*') === true
    || verificationName?.endsWith('*') === true
}

export function getCodingVerificationAttemptLimit(): number {
  return 1
}

function needsIndependentAcceptanceReview(
  prompt: string,
  result: AgentRunResult,
): boolean {
  const codingMutationIntent = result.taskRoute?.codingMutationIntent
    ?? hasCodingMutationIntent(prompt)
  return codingMutationIntent
    && result.exitCode === 0
    && !result.pendingInteractions?.length
    && result.completionGate === undefined
}

export function buildCodingVerificationPrompt(input: {
  originalPrompt: string
  previousResult: AgentRunResult
  gap: string
}): string {
  const lastMutation = (input.previousResult.evidence || []).findLast(item => (
    item.kind === 'mutation' && item.success
  ))
  const verificationScope = lastMutation?.scope || (
    (input.previousResult.activity || []).some(event => (
      SUCCESSFUL_RUNTIME_MUTATION_RE.test(event.replace(BENIGN_SHELL_REDIRECT_RE, ''))
    ))
      ? 'runtime'
      : 'workspace'
  )
  const recentActivity = (input.previousResult.activity || [])
    .slice(-12)
    .map(event => `- ${event}`)
    .join('\n')
  return [
    'Run the completion gate for the coding task below.',
    'The implementation pass reported success, but mechanical verification is incomplete.',
    '',
    `Gap: ${input.gap}`,
    '',
    'Required workflow:',
    '1. Do not redo completed implementation and do not revert unrelated dirty changes.',
    verificationScope === 'runtime'
      ? '2. This is a runtime/deployment verification pass. Inspect only the exact live target and required access; do not substitute an unrelated git diff or local repository check.'
      : '2. This is a workspace verification pass. Inspect git status, the current diff, and the exact files changed by the previous pass.',
    '3. Run the narrowest relevant tests or executable checks after the last edit. Preserve the real verifier exit status; do not use a masking pipeline, `|| true`, or a success-forcing wrapper.',
    '4. For deployment or runtime changes, verify the live target after the last mutation with health/readiness, service status, and the relevant remote API status. A local repository test does not prove a deployment.',
    '5. If a check fails, diagnose and fix the implementation, then rerun the check.',
    '6. Inspect only the files touched by this task for secrets, debug output, and scope drift. Do not audit an unrelated dirty worktree.',
    '7. Re-read the literal original requirements and match each one to evidence from the final state. Explicit filenames, paths, extensions, formats, and requested outputs are requirements, not suggestions; do not silently substitute alternatives.',
    '8. If required access or user input is unavailable, stop unrelated exploration and report the exact blocker as blocked. Do not claim success and do not turn the blocker into a code failure.',
    '9. End the response with exactly one machine-readable envelope:',
    '<openclaude_quality>{"status":"verified|blocked|failed","scope":"workspace|runtime|none","reason":"concise evidence or blocker"}</openclaude_quality>',
    'Use status=verified with scope=none only when the task legitimately required no mutation. A workspace or runtime mutation still requires a successful post-mutation mechanical verifier event.',
    '',
    'Previous pass activity:',
    recentActivity || '- no structured activity captured',
    '',
    'Previous pass response:',
    input.previousResult.text.slice(0, 2_000) || '(empty)',
    '',
    'Original task:',
    extractCurrentUserRequest(input.originalPrompt).slice(0, 24_000),
  ].join('\n')
}

export async function runOpenClaudeAgentWithCompletionGate(
  options: AgentRunOptions,
  runner: (options: AgentRunOptions) => Promise<AgentRunResult> = runOpenClaudeAgent,
): Promise<AgentRunResult> {
  const onStdout = options.onStdout
  const firstResult = attachCodingCompletionDisposition(await runner({
    ...options,
    onStdout: undefined,
    streamEvents: true,
  }))
  const passes = [firstResult]
  let combined = mergeAgentRunResults(passes)
  const maxAttempts = getCodingVerificationAttemptLimit()
  let gap = getCodingCompletionGap(
    options.prompt,
    combined,
    process.env,
  )
  if (!gap && needsIndependentAcceptanceReview(options.prompt, combined)) {
    gap = 'Mechanical checks passed, but an independent acceptance review has not yet compared the final state with every literal requirement.'
  }

  for (
    let attempt = 1;
    gap && !options.signal?.aborted && attempt <= maxAttempts;
    attempt += 1
  ) {
    options.onProgress?.(
      `coding completion gate: verifier pass ${attempt}/${maxAttempts}`,
    )
    const verificationResult = attachCodingCompletionDisposition(await runner({
      ...options,
      onStdout: undefined,
      taskRoute: combined.taskRoute || options.taskRoute,
      prompt: buildCodingVerificationPrompt({
        originalPrompt: options.prompt,
        previousResult: combined,
        gap,
      }),
      streamEvents: true,
    }))
    passes.push(verificationResult)
    combined = mergeAgentRunResults(passes)
    if (verificationResult.exitCode !== 0) break
    gap = getCodingCompletionGap(
      options.prompt,
      combined,
      process.env,
    )
  }

  if (gap && combined.exitCode === 0 && !options.signal?.aborted) {
    combined = buildCodingCompletionFailure(combined, gap)
  }
  if (combined.text) onStdout?.(combined.text)
  return combined
}

export function mergeAgentRunResults(
  results: AgentRunResult[],
): AgentRunResult {
  const final = results.at(-1)
  if (!final) {
    throw new Error('Cannot merge an empty agent result list')
  }
  const artifacts = new Map<string, NonNullable<AgentRunResult['artifacts']>[number]>()
  const pendingInteractions = new Map<
    string,
    NonNullable<AgentRunResult['pendingInteractions']>[number]
  >()
  const evidence: AgentRunEvidence[] = []
  for (const result of results) {
    for (const artifact of result.artifacts || []) {
      artifacts.set(`${artifact.kind}:${artifact.path}`, artifact)
    }
    for (const interaction of result.pendingInteractions || []) {
      pendingInteractions.set(
        getAgentInteractionKey(interaction),
        interaction,
      )
    }
    for (const item of result.evidence || []) {
      evidence.push({ ...item, sequence: evidence.length })
    }
  }
  const durationValues = results
    .map(result => result.durationMs)
    .filter((value): value is number => value !== undefined)
  const costValues = results
    .map(result => result.costUsd)
    .filter((value): value is number => value !== undefined)
  return {
    ...final,
    ...(durationValues.length > 0
      ? { durationMs: durationValues.reduce((sum, value) => sum + value, 0) }
      : {}),
    ...(costValues.length > 0
      ? { costUsd: costValues.reduce((sum, value) => sum + value, 0) }
      : {}),
    activity: results.flatMap(result => result.activity || []).slice(-240),
    ...(artifacts.size > 0 ? { artifacts: [...artifacts.values()] } : {}),
    ...(pendingInteractions.size > 0
      ? { pendingInteractions: [...pendingInteractions.values()] }
      : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(results.some(result => result.stalled) ? { stalled: true } : {}),
  }
}

export function buildCodingCompletionFailure(
  result: AgentRunResult,
  gap: string,
): AgentRunResult {
  const diagnostic = [
    'Failure kind: quality_gate',
    gap,
    'The bounded evaluator loop did not produce a successful post-edit verifier.',
  ].join('\n')
  return {
    ...result,
    exitCode: 1,
    failureKind: 'quality_gate',
    stderr: [result.stderr, diagnostic].filter(Boolean).join('\n'),
    diagnostic,
  }
}
