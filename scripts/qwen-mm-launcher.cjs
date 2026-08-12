#!/usr/bin/env node

const { existsSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { resolve } = require('node:path')

const REVISION = '8d6ea5a1f658260743307c52c2024ec87599fa48'
const SPEC = `qwen-mm-plugins[core,api] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@${REVISION}`
const mode = String(process.argv[2] || 'api').toLowerCase()
const passthrough = process.argv.slice(3)

if (!['api', 'core'].includes(mode)) {
  console.error('usage: qwen-mm-launcher.cjs [api|core]')
  process.exit(2)
}

const workspace = process.env.CAPABILITY_ROUTER_WORKSPACE_ROOT || process.cwd()
const script = resolve(workspace, 'integrations/qwen-mm/local_server.py')
const installedPython = process.env.QWEN_MM_PYTHON || '/opt/uv/tools/qwen-mm-plugins/bin/python'
const command = existsSync(installedPython) ? installedPython : (process.env.UV_BIN || 'uv')
const args = existsSync(installedPython)
  ? [script, mode, ...passthrough]
  : ['run', '--quiet', '--with', SPEC, 'python', script, mode, ...passthrough]

const child = spawn(command, args, {
  cwd: workspace,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', error => {
  console.error(`Unable to launch Qwen-MM ${mode}: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
