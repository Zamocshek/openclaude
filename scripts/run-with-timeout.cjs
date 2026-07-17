#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process')

const timeoutSeconds = Number(process.argv[2])
const command = process.argv[3]
const args = process.argv.slice(4)

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !command) {
  console.error('Usage: node scripts/run-with-timeout.cjs <seconds> <command> [...args]')
  process.exit(2)
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: false,
  detached: process.platform !== 'win32',
})

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  console.error(`Command timed out after ${timeoutSeconds}s: ${command} ${args.join(' ')}`)
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 2_000).unref()
  }
}, timeoutSeconds * 1_000)

child.once('error', error => {
  clearTimeout(timer)
  console.error(error.message)
  process.exit(127)
})

child.once('exit', (code, signal) => {
  clearTimeout(timer)
  if (timedOut) process.exit(124)
  if (signal) {
    console.error(`Command terminated by signal ${signal}`)
    process.exit(128)
  }
  process.exit(code ?? 1)
})
