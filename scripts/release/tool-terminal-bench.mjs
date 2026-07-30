import { spawn } from 'node:child_process'

const FORCE_KILL_GRACE_MS = 500

function runProcessCase(name, args, timeoutMs) {
  return new Promise(resolve => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKill
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKill = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_GRACE_MS)
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (forceKill) clearTimeout(forceKill)
      resolve({
        name,
        code,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      })
    })
  })
}

const results = []
results.push(await runProcessCase(
  'utf8-stdout',
  ['-e', 'process.stdout.write("terminal-\\u2713")'],
  2_000,
))
results.push(await runProcessCase(
  'stderr-exit-code',
  ['-e', 'process.stderr.write("expected failure"); process.exit(7)'],
  2_000,
))
results.push(await runProcessCase(
  'timeout-kill',
  ['-e', 'setTimeout(() => {}, 10_000)'],
  250,
))

const checks = [
  results[0].code === 0 && results[0].stdout === 'terminal-\u2713',
  results[1].code === 7 && results[1].stderr === 'expected failure',
  results[2].timedOut && results[2].durationMs < 2_000,
]
const report = {
  kind: 'OpenClaude terminal/tool smoke (not an official Terminal-Bench score)',
  passed: checks.every(Boolean),
  cases: results.map(result => ({
    name: result.name,
    code: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  })),
}

console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
