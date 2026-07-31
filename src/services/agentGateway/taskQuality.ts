import {
  hasCodingMutationIntent,
  hasCodingTaskIntent,
  runOpenClaudeAgent,
  type AgentRunOptions,
  type AgentRunResult,
} from './agentRunner.js'

const SUCCESSFUL_NATIVE_MUTATION_RE =
  /^tool result success \((?:Edit|Write|NotebookEdit|ApplyPatch|apply_patch|mcp[^:)]*(?:write|edit|patch|create[_-]?file|delete[_-]?file|move[_-]?file|rename[_-]?file))\b/iu
const SUCCESSFUL_SHELL_MUTATION_RE =
  /^tool result success \((?:Bash|PowerShell):[\s\S]*(?:\b(?:sed|perl)\s+-[^\s]*i\b|\b(?:tee|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|git\s+apply|patch|cp|mv)\b|(?:write_text|writeFileSync|writeFile|appendFileSync|appendFile)\s*\(|open\s*\([^)]*,\s*["'][wa]|(?:^|[\s"'`])(?:>>?|2>)\s*[^\s&|])/iu
const SUCCESSFUL_VERIFIER_RE =
  /^tool result success \((?:Bash|PowerShell|TaskOutput|Agent):[\s\S]*(?:\btest\b|tests|typecheck|lint|build|compile|check|pytest|vitest|jest|tsc|cargo test|go test|ruff|mypy|playwright|docker compose config|\/health)\b/iu
const MAX_CODING_VERIFICATION_ATTEMPTS = 2

function isSuccessfulMutation(event: string): boolean {
  return SUCCESSFUL_NATIVE_MUTATION_RE.test(event)
    || SUCCESSFUL_SHELL_MUTATION_RE.test(event)
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
  if (
    result.exitCode !== 0
    || !isCodingCompletionGateEnabled(env)
    || !hasCodingTaskIntent(prompt)
  ) {
    return undefined
  }

  const activity = result.activity || []
  const hasSuccessfulVerifier = activity.some(event => (
    SUCCESSFUL_VERIFIER_RE.test(event)
  ))
  let lastMutation = -1
  for (let index = 0; index < activity.length; index += 1) {
    if (isSuccessfulMutation(activity[index]!)) lastMutation = index
  }
  if (lastMutation < 0) {
    return hasCodingMutationIntent(prompt) && !hasSuccessfulVerifier
      ? 'The coding task reported success without an observable file mutation or a successful verifier.'
      : undefined
  }

  const verifiedAfterMutation = activity
    .slice(lastMutation + 1)
    .some(event => SUCCESSFUL_VERIFIER_RE.test(event))
  if (verifiedAfterMutation) return undefined

  return 'Code or configuration changed without a successful post-edit verifier.'
}

export function buildCodingVerificationPrompt(input: {
  originalPrompt: string
  previousResult: AgentRunResult
  gap: string
}): string {
  const recentActivity = (input.previousResult.activity || [])
    .slice(-20)
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
    '2. Inspect git status, the current diff, and the exact files changed by the previous pass.',
    '3. Run the narrowest relevant tests or executable checks after the last edit.',
    '4. If a check fails, diagnose and fix the implementation, then rerun the check.',
    '5. Inspect the final diff for accidental files, secrets, debug output, and scope drift.',
    '6. Return the user-facing final answer only after the checks pass. If no executable verifier exists, perform a static diff review and state the exact unverified boundary.',
    '',
    'Previous pass activity:',
    recentActivity || '- no structured activity captured',
    '',
    'Previous pass response:',
    input.previousResult.text.slice(0, 4_000) || '(empty)',
    '',
    'Original task:',
    input.originalPrompt.slice(0, 40_000),
  ].join('\n')
}

export async function runOpenClaudeAgentWithCompletionGate(
  options: AgentRunOptions,
  runner: (options: AgentRunOptions) => Promise<AgentRunResult> = runOpenClaudeAgent,
): Promise<AgentRunResult> {
  const onStdout = options.onStdout
  const firstResult = await runner({
    ...options,
    onStdout: undefined,
    streamEvents: true,
  })
  const passes = [firstResult]
  let combined = mergeAgentRunResults(passes)
  let gap = getCodingCompletionGap(options.prompt, combined)

  for (
    let attempt = 1;
    gap && !options.signal?.aborted && attempt <= MAX_CODING_VERIFICATION_ATTEMPTS;
    attempt += 1
  ) {
    options.onProgress?.(
      `coding completion gate: verifier pass ${attempt}/${MAX_CODING_VERIFICATION_ATTEMPTS}`,
    )
    const verificationResult = await runner({
      ...options,
      onStdout: undefined,
      prompt: buildCodingVerificationPrompt({
        originalPrompt: options.prompt,
        previousResult: combined,
        gap,
      }),
      streamEvents: true,
    })
    passes.push(verificationResult)
    combined = mergeAgentRunResults(passes)
    if (verificationResult.exitCode !== 0) break
    gap = getCodingCompletionGap(options.prompt, combined)
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
  for (const result of results) {
    for (const artifact of result.artifacts || []) {
      artifacts.set(`${artifact.kind}:${artifact.path}`, artifact)
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
