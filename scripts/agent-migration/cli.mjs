#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { adaptBundle, TARGETS } from './adapters.mjs'
import {
  exportOpenClaudeBundle,
  inspectBundle,
  verifyBundle,
} from './core.mjs'

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = { command, positional: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      options.positional.push(token)
      continue
    }
    const [rawName, inlineValue] = token.slice(2).split('=', 2)
    const name = rawName.replace(/-([a-z])/gu, (_, char) => char.toUpperCase())
    if (name === 'force' || name === 'json') {
      options[name] = true
      continue
    }
    const value = inlineValue ?? rest[index + 1]
    if (inlineValue === undefined) index += 1
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`)
    options[name] = value
  }
  return options
}

function usage() {
  return `OpenClaude Agent Migration

Usage:
  openclaude-migrate export [--source-home PATH] [--workspace PATH]
      [--descriptor FILE] [--history none|gateway|full] --output DIR [--force]
  openclaude-migrate verify --bundle DIR
  openclaude-migrate inspect --bundle DIR
  openclaude-migrate adapt --bundle DIR --target ${TARGETS.join('|')} --output DIR
      [--exposure routed|direct|both] [--force]
  openclaude-migrate install ...  (alias for adapt)

Examples:
  openclaude-migrate export --workspace . --history full --output nova.agent-bundle
  openclaude-migrate verify --bundle nova.agent-bundle
  openclaude-migrate adapt --bundle nova.agent-bundle --target hermes --output hermes-nova

Security:
  Credentials are never exported. The bundle contains environment-variable
  placeholders plus secrets.required.env and is checksum-verified before adapt.
  Target adapters expose one lazy capability-router MCP by default. Use
  --exposure direct only when a target cannot call a routing facade.
`
}

function required(options, name, positionalIndex) {
  const value = options[name] || options.positional[positionalIndex]
  if (!value) throw new Error(`Missing required --${name.replace(/[A-Z]/gu, char => `-${char.toLowerCase()}`)}`)
  return value
}

function print(value, asJson = false) {
  if (asJson || typeof value !== 'string') console.log(JSON.stringify(value, null, 2))
  else console.log(value)
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.command === 'help' || options.command === '--help' || options.command === '-h') {
    console.log(usage())
    return
  }

  if (options.command === 'export') {
    const output = required(options, 'output', 0)
    const result = await exportOpenClaudeBundle({
      sourceHome: options.sourceHome,
      workspace: options.workspace,
      descriptor: options.descriptor,
      history: options.history || 'gateway',
      output,
      force: options.force,
      name: options.name,
    })
    print({
      ok: true,
      command: 'export',
      output: result.output,
      bundleId: result.manifest.id,
      statistics: result.manifest.statistics,
    }, true)
    return
  }

  if (options.command === 'verify') {
    const bundle = required(options, 'bundle', 0)
    const result = verifyBundle(bundle)
    print({ ok: result.ok, bundle: resolve(bundle), errors: result.errors, statistics: result.manifest?.statistics }, true)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.command === 'inspect') {
    const bundle = required(options, 'bundle', 0)
    const result = inspectBundle(bundle)
    print(result, true)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.command === 'adapt' || options.command === 'install') {
    const bundle = required(options, 'bundle', 0)
    const target = required(options, 'target', 1)
    const output = required(options, 'output', 2)
    const result = await adaptBundle({
      bundle,
      target,
      output,
      force: options.force,
      recentMessages: options.recentMessages,
      exposure: options.exposure || 'routed',
    })
    print({ ok: true, command: options.command, ...result }, true)
    return
  }

  throw new Error(`Unknown command: ${options.command}\n\n${usage()}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
