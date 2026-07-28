#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const name = String(process.argv[2] || '').trim()
if (!/^[a-z0-9-]+$/iu.test(name)) {
  console.error('Usage: run-platform-script.mjs <script-name-without-extension>')
  process.exit(2)
}

const extension = process.platform === 'win32' ? '.bat' : '.sh'
const scriptPath = resolve(import.meta.dirname, `${name}${extension}`)
const command = process.platform === 'win32' ? 'cmd.exe' : 'bash'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', scriptPath]
  : [scriptPath]
const result = spawnSync(command, args, {
  cwd: resolve(import.meta.dirname, '..', '..'),
  stdio: 'inherit',
  windowsHide: true,
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
